import { describe, expect, it } from 'vitest';
import { agent } from '../../test/fixtures.js';
import { agentClockMoves, agentRuntimeLine, agentStatusLine, missingSeatRefusal, NEW_AGENT_CLIS } from './agent-words.js';

/**
 * An idle agent's card says how long ago it last worked (note #574) — an
 * age that has to keep counting while the page stays open.
 */

describe('an idle agent card’s age', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says "Active 4m ago" or "Active 15h ago", not a calendar day', () => {
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada', lastActiveAt: ago(4 * 60_000) }), now)).toBe('Active 4m ago');
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada', lastActiveAt: ago(15 * 3_600_000) }), now)).toBe('Active 15h ago');
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada', lastActiveAt: ago(3 * 86_400_000) }), now)).toBe('Active 3d ago');
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada', lastActiveAt: ago(10_000) }), now)).toBe('Active just now');
  });

  it('falls back to "Ready" for a stamp it cannot read', () => {
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada', lastActiveAt: new Date(now + 60_000).toISOString() }), now)).toBe('Ready');
    expect(agentStatusLine(agent({ id: 'a', name: 'Ada' }), now)).toBe('Ready');
  });

  it('keeps the clock ticking while any card shows an age or a running turn', () => {
    expect(agentClockMoves([agent({ id: 'a', name: 'Ada' })])).toBe(false);
    expect(agentClockMoves([agent({ id: 'a', name: 'Ada', lastActiveAt: ago(60_000) })])).toBe(true);
    expect(agentClockMoves([agent({ id: 'a', name: 'Ada', working: true, activitySince: ago(1000) })])).toBe(true);
    // A running turn without a start time has no stopwatch; its line is "Now".
    expect(agentClockMoves([agent({ id: 'a', name: 'Ada', working: true, lastActiveAt: ago(60_000) })])).toBe(false);
  });
});

describe('OpenCode, the third harness (note #780)', () => {
  it('is offered by New agent, after Claude Code and Codex', () => {
    expect(NEW_AGENT_CLIS.map((option) => option.label)).toEqual(['Claude Code', 'Codex', 'OpenCode']);
    expect(NEW_AGENT_CLIS[2]).toMatchObject({ id: 'opencode', hint: 'Runs on your OpenCode Go subscription' });
  });

  it('names its runtime, and leaves out an effort its model does not have', () => {
    expect(agentRuntimeLine({ cli: 'opencode', model: 'glm-5.3', effort: 'high' })).toBe('OpenCode · glm-5.3 · high');
    expect(agentRuntimeLine({ cli: 'opencode', model: 'kimi-k3', effort: '' })).toBe('OpenCode · kimi-k3');
  });

  it('sends a person with no OpenCode key to add one', () => {
    const org = { seatProviders: ['claude'] } as never;
    expect(missingSeatRefusal('opencode', org)).toBe('An OpenCode agent runs on your OpenCode subscription — add your OpenCode key here first, then create it.');
    expect(missingSeatRefusal('opencode', { seatProviders: ['opencode'] } as never)).toBe('');
  });
});
