import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_CLAUDE_MODEL_CATALOG,
  TELEGRAM_CODEX_MODEL_CATALOG,
  TELEGRAM_OPENCODE_MODEL_CATALOG,
  buildRuntimeChangeNote,
  catalogInWords,
  checkCreationRuntime,
  opencodeModelRef,
  effortsForModel,
  modelCatalogForCli,
  planRuntimeChange,
  resolveEffectiveEffort,
  resolveEffectiveModel,
} from '../../agent/harness-models.js';
import { HARNESS_CLIS } from '../../shared/harness-clis.js';

describe('curated harness model catalogs', () => {
  it('offers exactly the curated Codex models with their per-model efforts, none with low', () => {
    expect(TELEGRAM_CODEX_MODEL_CATALOG.map((entry) => entry.value)).toEqual([
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    ]);
    expect(effortsForModel('codex', 'gpt-6-astra').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsForModel('codex', 'gpt-6-sol').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsForModel('codex', 'gpt-6-luna').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max']);
    expect(effortsForModel('codex', 'gpt-5.6-sol').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsForModel('codex', 'gpt-5.6-terra').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsForModel('codex', 'gpt-5.6-luna').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max']);
    expect(effortsForModel('codex', 'gpt-5.5').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh']);
    // Withdrawn from every Codex model on 2026-10-12 (the owner), as Claude's went on 2026-09-29.
    expect(TELEGRAM_CODEX_MODEL_CATALOG.some((entry) => entry.efforts.some((option) => option.value === 'low'))).toBe(false);
    expect(effortsForModel('codex', 'gpt-6.1-sol').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    // GPT-6.1 Terra (note #930): codex-cli 0.166.0 lists low → ultra for it, so the picker offers medium → ultra.
    expect(effortsForModel('codex', 'gpt-6.1-terra').map((option) => option.value))
      .toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('offers Fable, Opus and Sonnet (no Haiku), sharing one effort list without low', () => {
    expect(TELEGRAM_CLAUDE_MODEL_CATALOG.map((entry) => entry.value)).toEqual([
      'fable', 'opus', 'sonnet',
    ]);
    for (const entry of TELEGRAM_CLAUDE_MODEL_CATALOG) {
      expect(effortsForModel('claude', entry.value).map((option) => option.value))
        .toEqual(['medium', 'high', 'xhigh', 'max']);
    }
  });

  it('returns no efforts for an absent or unknown model (Default stays Default)', () => {
    expect(effortsForModel('codex', undefined)).toEqual([]);
    expect(effortsForModel('codex', 'gpt-5.4-mini')).toEqual([]);
    expect(effortsForModel('claude', 'haiku')).toEqual([]);
  });

  it('marks every level from xhigh up as heavy, on both catalogs (note #482)', () => {
    // The picker's caution is drawn from this flag, never from the level's
    // name — so the flag, not the spelling, is what a test pins.
    const heavy = ['xhigh', 'max', 'ultra'];
    for (const cli of HARNESS_CLIS) {
      for (const entry of modelCatalogForCli(cli)) {
        for (const effort of entry.efforts) {
          expect([entry.value, effort.value, effort.heavy === true])
            .toEqual([entry.value, effort.value, heavy.includes(effort.value)]);
        }
      }
    }
  });

  it('modelCatalogForCli routes to the right catalog', () => {
    expect(modelCatalogForCli('claude')).toBe(TELEGRAM_CLAUDE_MODEL_CATALOG);
    expect(modelCatalogForCli('codex')).toBe(TELEGRAM_CODEX_MODEL_CATALOG);
    expect(modelCatalogForCli('opencode')).toBe(TELEGRAM_OPENCODE_MODEL_CATALOG);
  });

  it('offers the OpenCode Go models with OpenCode\'s own variants, none below medium (note #780)', () => {
    expect(TELEGRAM_OPENCODE_MODEL_CATALOG.map((entry) => entry.value)).toEqual([
      'glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'qwen3.8-max', 'mimo-v2.6-pro', 'glm-5.3-flash', 'deepseek-v4.1-flash',
    ]);
    expect(effortsForModel('opencode', 'glm-5.3').map((option) => option.value)).toEqual(['high', 'max']);
    expect(effortsForModel('opencode', 'qwen3.8-max').map((option) => option.value)).toEqual(['medium', 'xhigh']);
    // Kimi K3's one variant is `max`, MiMo has none: no effort setting at all.
    expect(effortsForModel('opencode', 'kimi-k3')).toEqual([]);
    expect(effortsForModel('opencode', 'mimo-v2.6-pro')).toEqual([]);
    const lowest = ['low', 'none', 'minimal'];
    expect(TELEGRAM_OPENCODE_MODEL_CATALOG.some((entry) => entry.efforts.some((option) => lowest.includes(option.value)))).toBe(false);
    // Every model names its own window, because OpenCode's stream never does.
    expect(TELEGRAM_OPENCODE_MODEL_CATALOG.every((entry) => (entry.contextWindow ?? 0) >= 1_000_000)).toBe(true);
    expect(opencodeModelRef('glm-5.3')).toBe('opencode-go/glm-5.3');
    expect(opencodeModelRef('opencode/gpt-5.5')).toBe('opencode/gpt-5.5');
  });

  it('runs an OpenCode model with no effort setting on none, and says so in words', () => {
    expect(resolveEffectiveModel('opencode', undefined)).toBe('glm-5.3');
    expect(resolveEffectiveEffort('opencode', undefined, undefined)).toBe('high');
    expect(resolveEffectiveEffort('opencode', 'kimi-k3', undefined)).toBe('');
    expect(resolveEffectiveEffort('opencode', 'kimi-k3', 'max')).toBe('');
    expect(resolveEffectiveEffort('opencode', 'qwen3.8-max', undefined)).toBe('medium');
    expect(catalogInWords('opencode')).toContain('kimi-k3, mimo-v2.6-pro (no effort setting)');
    expect(checkCreationRuntime('opencode', 'kimi-k3', 'max')).toEqual({ ok: false, field: 'effort', model: 'kimi-k3', allowed: [] });
    // A model of another harness says which one.
    expect(checkCreationRuntime('opencode', 'opus', undefined)).toMatchObject({ ok: false, field: 'model', otherCli: 'claude' });
    expect(checkCreationRuntime('claude', 'glm-5.3', undefined)).toMatchObject({ ok: false, field: 'model', otherCli: 'opencode' });
    expect(checkCreationRuntime('opencode', 'GLM-5.3', 'MAX')).toEqual({ ok: true, model: 'glm-5.3', effort: 'max' });
  });
});

describe('effective model/effort defaults (no "Default" state)', () => {
  it('resolves unset model to the CLI default', () => {
    expect(resolveEffectiveModel('codex', undefined)).toBe('gpt-6.1-sol');
    expect(resolveEffectiveModel('claude', undefined)).toBe('opus');
    // The former default is not retired: an agent that chose it keeps it.
    expect(resolveEffectiveModel('codex', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveEffectiveModel('codex', 'gpt-6-astra')).toBe('gpt-6-astra');
    expect(resolveEffectiveModel('codex', 'gpt-5.5')).toBe('gpt-5.5');
  });

  it('runs Sonnet again for an agent stored on it, now it is offered again', () => {
    // Sonnet was retired (resolved to opus) until 2026-09-29.
    expect(resolveEffectiveModel('claude', 'sonnet')).toBe('sonnet');
    expect(resolveEffectiveEffort('claude', 'sonnet', 'max')).toBe('max');
    // Out-of-catalog but NOT retired: still trusted as-is, so a legacy
    // override an agent already runs on is never silently swapped.
    expect(resolveEffectiveModel('claude', 'haiku')).toBe('haiku');
  });

  it('resolves unset effort to high for BOTH CLIs, model-aware otherwise', () => {
    expect(resolveEffectiveEffort('codex', undefined, undefined)).toBe('high'); // sol
    expect(resolveEffectiveEffort('codex', 'gpt-6-astra', undefined)).toBe('high');
    expect(resolveEffectiveEffort('codex', 'gpt-6-luna', undefined)).toBe('high');
    expect(resolveEffectiveEffort('codex', 'gpt-5.6-terra', undefined)).toBe('high');
    expect(resolveEffectiveEffort('codex', 'gpt-5.5', undefined)).toBe('high');
    expect(resolveEffectiveEffort('claude', undefined, undefined)).toBe('high'); // opus
    expect(resolveEffectiveEffort('claude', 'fable', undefined)).toBe('high');
    // 5.6-luna gained a `high` rung (codex-cli 0.155.0+), so it lands there
    // like everything else now.
    expect(resolveEffectiveEffort('codex', 'gpt-5.6-luna', undefined)).toBe('high');
    // The ladder still walks DOWN for a model without `high`: medium, never
    // back into the heavy band.
    expect(resolveEffectiveEffort('codex', 'gpt-5.6-luna', 'xhigh')).toBe('xhigh');
    // Out of catalog (legacy override), levels unknowable: the safe rung.
    expect(resolveEffectiveEffort('claude', 'haiku', undefined)).toBe('high');
    // A stored effort the model supports is kept…
    expect(resolveEffectiveEffort('codex', 'gpt-6-sol', 'ultra')).toBe('ultra');
    expect(resolveEffectiveEffort('codex', 'gpt-6-luna', 'ultra')).toBe('high');
    // …but an unsupported one falls back to the model default.
    expect(resolveEffectiveEffort('codex', 'gpt-5.5', 'ultra')).toBe('high');
    // A stored level below everything the model offers — the withdrawn
    // `low`, Claude's since 2026-09-29 and Codex's since 2026-10-12 — runs on
    // the lowest offered level, not up at the default.
    expect(resolveEffectiveEffort('claude', 'opus', 'low')).toBe('medium');
    expect(resolveEffectiveEffort('claude', 'sonnet', 'low')).toBe('medium');
    expect(resolveEffectiveEffort('claude', undefined, 'low')).toBe('medium');
    expect(resolveEffectiveEffort('codex', 'gpt-6-sol', 'low')).toBe('medium');
    expect(resolveEffectiveEffort('codex', 'gpt-5.5', 'low')).toBe('medium');
    expect(resolveEffectiveEffort('codex', undefined, 'low')).toBe('medium');
  });

  it('starts a brand-new agent of EITHER CLI outside the heavy band', () => {
    // The defaults were lowered on 2026-09-11 so that an agent nobody has
    // configured does not begin life spending the usage window at its fastest
    // rate. Read off the catalog's own `heavy` flag rather than the spelling
    // of the level, for the same reason note #482 does.
    for (const cli of HARNESS_CLIS) {
      const model = resolveEffectiveModel(cli, undefined);
      const effort = resolveEffectiveEffort(cli, model, undefined);
      expect(effortsForModel(cli, model).find((option) => option.value === effort)?.heavy)
        .toBeFalsy();
    }
    // And no model in either catalog defaults into the band, luna included.
    for (const cli of HARNESS_CLIS) {
      for (const entry of modelCatalogForCli(cli)) {
        const effort = resolveEffectiveEffort(cli, entry.value, undefined);
        expect(entry.efforts.find((option) => option.value === effort)?.heavy).toBeFalsy();
      }
    }
  });
});

describe('planRuntimeChange: the picker\'s rule, shared with the Chief of Staff (note #776)', () => {
  it('judges an effort against the model it will run with, and keeps a stored effort across a model change only when offered', () => {
    // Effort alone: against the current model (an unset one is the default).
    expect(planRuntimeChange('codex', {}, { effort: 'ultra' })).toEqual({ ok: true, updates: { effort: 'ultra' } });
    expect(planRuntimeChange('codex', { model: 'gpt-5.5' }, { effort: 'ultra' }))
      .toEqual({ ok: false, field: 'effort', model: 'gpt-5.5', allowed: ['medium', 'high', 'xhigh'] });
    // Model alone: ultra is not Luna's, so it is cleared to Luna's default; max is, so it stays.
    expect(planRuntimeChange('codex', { model: 'gpt-6-sol', effort: 'ultra' }, { model: 'gpt-6-luna' }))
      .toEqual({ ok: true, updates: { model: 'gpt-6-luna', effort: null } });
    expect(planRuntimeChange('codex', { model: 'gpt-6-sol', effort: 'max' }, { model: 'gpt-6-luna' }))
      .toEqual({ ok: true, updates: { model: 'gpt-6-luna', effort: 'max' } });
    // Both: the effort is judged against the NEW model.
    expect(planRuntimeChange('claude', { model: 'opus' }, { model: 'sonnet', effort: 'max' }))
      .toEqual({ ok: true, updates: { model: 'sonnet', effort: 'max' } });
    expect(planRuntimeChange('claude', {}, { model: 'opus', effort: 'low' }))
      .toEqual({ ok: false, field: 'effort', model: 'opus', allowed: ['medium', 'high', 'xhigh', 'max'] });
    // A model of the other harness, or none at all, is refused with this harness's list.
    expect(planRuntimeChange('claude', {}, { model: 'gpt-6-sol' }))
      .toEqual({ ok: false, field: 'model', allowed: ['fable', 'opus', 'sonnet'] });
    expect(planRuntimeChange('claude', {}, { model: 'haiku' })).toMatchObject({ ok: false, field: 'model' });
  });
  it('says the change to the agent only when the Workspace Agent made one, naming the pair its turn runs with', () => {
    expect(buildRuntimeChangeNote(undefined, 'opus', 'high')).toBeNull();
    expect(buildRuntimeChangeNote({ by: 'workspace-agent', at: 't' }, 'opus', 'max'))
      .toBe('[Platform] Since your last turn the Workspace Agent changed what you run on, at your user\'s request: this turn runs on opus at max effort. Nothing else about your work changed.');
  });
});
