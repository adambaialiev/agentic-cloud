import { describe, expect, it } from 'vitest';
import { availableRecapModels, recapModelCatalog, resolveRecapSettings, validRecapSettings } from '../../services/workspace-recap-settings.js';
import { buildClaudeRecapCommand, buildCodexRecapCommand } from '../../services/agent-recap.js';
const agents = [{ id: 'one', cli: 'codex', connectedAt: 't', serverId: 'fly_one.machine' }] as never;
describe('overview model settings', () => {
  it('offers the existing model-specific efforts and keeps the original defaults', () => {
    expect(resolveRecapSettings(agents)).toEqual({ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(availableRecapModels(agents, null).every((m) => m.cli === 'codex')).toBe(true);
    expect(validRecapSettings({ cli: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toBe(false);
    expect(validRecapSettings({ cli: 'codex', model: 'gpt-6-astra', effort: 'ultra' })).toBe(true);
    expect(validRecapSettings({ cli: 'claude', model: 'sonnet', effort: 'high' })).toBe(true);
    expect(validRecapSettings({ cli: 'claude', model: 'gpt-6-astra', effort: 'high' })).toBe(false);
    expect(validRecapSettings({ cli: 'codex', model: 'gpt-6-astra; echo nope', effort: 'high' })).toBe(false);
  });
  it('starts on Opus at high before anything is connected, and shows every model, none pickable yet (note #747)', () => {
    expect(resolveRecapSettings([])).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    const shown = availableRecapModels([], resolveRecapSettings([]));
    expect(shown.map((m) => `${m.cli}/${m.value}`)).toEqual(recapModelCatalog().map((m) => `${m.cli}/${m.value}`));
    expect(shown.every((m) => !m.available && m.efforts.length > 0)).toBe(true);
    expect(shown.find((m) => m.value === 'opus')?.efforts.map((e) => e.value)).toEqual(['medium', 'high', 'xhigh', 'max']);
  });
  it('is Opus at high on a Claude plan and GPT-6.1 Sol at high only on a ChatGPT plan alone', () => {
    expect(resolveRecapSettings([], undefined, ['claude'])).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    expect(resolveRecapSettings([], undefined, ['codex', 'claude'])).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    expect(resolveRecapSettings([], undefined, ['codex'])).toEqual({ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    // Once something is connected, the picker is that harness, pickable.
    const claude = availableRecapModels([], null, ['claude']);
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((m) => m.cli === 'claude' && m.available)).toBe(true);
  });
  it('preserves an unavailable saved choice instead of silently changing providers', () => {
    const stored = { cli: 'claude' as const, model: 'opus', effort: 'max' };
    expect(resolveRecapSettings(agents, stored)).toEqual(stored);
    expect(availableRecapModels(agents, stored).find((m) => m.value === 'opus')?.available).toBe(false);
  });
  it('passes the selected model and effort into each CLI command without changing defaults', () => {
    const codex = buildCodexRecapCommand('Summary', { model: 'gpt-6-astra', effort: 'ultra' });
    expect(codex).toContain("--model 'gpt-6-astra'");
    expect(codex).toContain("model_reasoning_effort=ultra");
    const claude = buildClaudeRecapCommand('Summary', undefined, { model: 'opus', effort: 'max' });
    expect(claude).toContain("--model 'opus' --effort 'max'");
    expect(buildCodexRecapCommand('Summary')).toContain('gpt-5.6-terra');
    expect(buildClaudeRecapCommand('Summary')).toContain("--model 'sonnet' --effort 'xhigh'");
  });
});
