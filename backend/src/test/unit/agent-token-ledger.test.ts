import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryAgentTokenLedger,
  tokenWeeks,
  tokenWeeksByAgent,
  tokenWeekStart,
  tokenWeeksSince,
  type AgentTokenCredit,
  type AgentTokenLedger,
} from '../../services/agent-token-ledger.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteAgentTokenLedger } from '../../services/sqlite/sqlite-agent-token-ledger.js';

function credit(overrides: Partial<AgentTokenCredit> = {}): AgentTokenCredit {
  return {
    userId: 'dana', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', day: '2026-10-07',
    provider: 'claude', model: 'claude-opus-5-5',
    input: 100, output: 20, cacheRead: 5_000, cacheWrite: 300, reasoning: 0,
    ...overrides,
  };
}

let db: SqliteDb | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe.each([
  ['in-memory', (): AgentTokenLedger => new InMemoryAgentTokenLedger()],
  ['sqlite', (): AgentTokenLedger => { db = openSqliteDb(':memory:'); return new SqliteAgentTokenLedger(db); }],
])('the token ledger (%s)', (_name, make) => {
  it('adds every turn of a day into one row and sums one owner across agents', () => {
    const ledger = make();
    ledger.credit(credit());
    ledger.credit(credit({ output: 30, cacheRead: 1_000 }));
    ledger.credit(credit({ agentId: 'agent-2', agentName: 'Theo', output: 50 }));
    // Another owner, and a day before the window: neither is Dana's answer.
    ledger.credit(credit({ userId: 'sam', output: 999 }));
    ledger.credit(credit({ day: '2026-09-01', output: 777 }));

    expect(ledger.userDays('dana', '2026-10-01')).toEqual([{
      day: '2026-10-07', provider: 'claude', model: 'claude-opus-5-5',
      input: 300, output: 100, cacheRead: 11_000, cacheWrite: 900, reasoning: 0,
    }]);
  });

  it('keeps the agents apart for the read that names them (note #719), kept past deletion', () => {
    const ledger = make();
    ledger.credit(credit());
    ledger.credit(credit({ output: 30 }));
    ledger.credit(credit({ agentId: 'agent-2', agentName: 'Theo', output: 50, orgId: null }));
    ledger.credit(credit({ userId: 'sam', output: 999 }));
    ledger.credit(credit({ day: '2026-09-01', output: 777 }));

    const rows = ledger.userAgentDays('dana', '2026-10-01').sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(rows).toEqual([
      {
        day: '2026-10-07', provider: 'claude', model: 'claude-opus-5-5', agentId: 'agent-1', agentName: 'Ruby', orgId: 'org-1',
        input: 200, output: 50, cacheRead: 10_000, cacheWrite: 600, reasoning: 0,
      },
      {
        day: '2026-10-07', provider: 'claude', model: 'claude-opus-5-5', agentId: 'agent-2', agentName: 'Theo', orgId: null,
        input: 100, output: 50, cacheRead: 5_000, cacheWrite: 300, reasoning: 0,
      },
    ]);
  });

  it('keeps providers and models apart, and records nothing for a turn that spent nothing', () => {
    const ledger = make();
    ledger.credit(credit({ provider: 'codex', model: 'gpt-6-sol', cacheWrite: 0, reasoning: 12 }));
    ledger.credit(credit({ model: 'claude-haiku-4-5' }));
    ledger.credit(credit({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: 'empty' }));
    const days = ledger.userDays('dana', '2026-10-01');
    expect(days.map((row) => `${row.provider}/${row.model}`).sort())
      .toEqual(['claude/claude-haiku-4-5', 'codex/gpt-6-sol']);
  });

  it('gives the Leaderboard every owner’s output per day and provider, agents and models summed (note #208)', () => {
    const ledger = make();
    ledger.credit(credit());
    ledger.credit(credit({ agentId: 'agent-2', agentName: 'Theo', model: 'claude-sonnet-5-5', output: 50 }));
    ledger.credit(credit({ provider: 'codex', model: 'gpt-6-sol', output: 7 }));
    ledger.credit(credit({ day: '2026-10-08', output: 3 }));
    ledger.credit(credit({ userId: 'sam', output: 999 }));
    // Before the window, and a day that wrote nothing: neither is a row.
    ledger.credit(credit({ day: '2026-09-01', output: 777 }));
    ledger.credit(credit({ day: '2026-10-09', output: 0 }));

    const rows = ledger.outputDaysSince('2026-10-01')
      .sort((a, b) => `${a.userId}/${a.day}/${a.provider}`.localeCompare(`${b.userId}/${b.day}/${b.provider}`));
    expect(rows).toEqual([
      { userId: 'dana', day: '2026-10-07', provider: 'claude', output: 70 },
      { userId: 'dana', day: '2026-10-07', provider: 'codex', output: 7 },
      { userId: 'dana', day: '2026-10-08', provider: 'claude', output: 3 },
      { userId: 'sam', day: '2026-10-07', provider: 'claude', output: 999 },
    ]);
  });

  it('gives a workplace its people’s output per agent and provider, for life and since a day (note #925)', () => {
    const ledger = make();
    ledger.credit(credit({ day: '2026-10-20', output: 100 }));
    ledger.credit(credit({ day: '2026-10-27', output: 30 }));
    ledger.credit(credit({ day: '2026-10-27', model: 'claude-sonnet-5-5', output: 5 }));
    ledger.credit(credit({ day: '2026-10-27', provider: 'codex', model: 'gpt-6-sol', output: 7 }));
    ledger.credit(credit({ agentId: 'agent-2', orgId: null, day: '2026-10-27', output: 2 }));
    ledger.credit(credit({ userId: 'sam', output: 999 })); // not asked about
    ledger.credit(credit({ agentId: 'agent-3', day: '2026-10-27', output: 0 })); // read, never wrote
    const rows = ledger.agentOutput(['dana'], '2026-10-26')
      .sort((a, b) => `${a.agentId}/${a.provider}`.localeCompare(`${b.agentId}/${b.provider}`));
    expect(rows).toEqual([
      { userId: 'dana', agentId: 'agent-1', orgId: 'org-1', provider: 'claude', total: 135, since: 35 },
      { userId: 'dana', agentId: 'agent-1', orgId: 'org-1', provider: 'codex', total: 7, since: 7 },
      { userId: 'dana', agentId: 'agent-2', orgId: null, provider: 'claude', total: 2, since: 2 },
    ]);
    expect(ledger.agentOutput([], '2026-10-26')).toEqual([]);
  });
});

describe('weeks', () => {
  it('starts a week on Monday, UTC', () => {
    expect(tokenWeekStart('2026-10-05')).toBe('2026-10-05'); // Monday
    expect(tokenWeekStart('2026-10-10')).toBe('2026-10-05'); // Saturday
    expect(tokenWeekStart('2026-10-11')).toBe('2026-10-05'); // Sunday
    expect(tokenWeekStart('2026-10-12')).toBe('2026-10-12');
  });

  it('reaches back eight weeks, this one included', () => {
    expect(tokenWeeksSince(Date.parse('2026-10-10T12:00:00Z'))).toBe('2026-08-17');
  });

  it('folds days into weeks, newest first, Claude before Codex, never adding the two', () => {
    const day = (dayKey: string, provider: 'claude' | 'codex', model: string, output: number) => ({
      day: dayKey, provider, model, input: 1, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    });
    const weeks = tokenWeeks([
      day('2026-09-29', 'claude', 'claude-opus-5-5', 10),
      day('2026-10-06', 'codex', 'gpt-6-sol', 7),
      day('2026-10-07', 'claude', 'claude-haiku-4-5', 5),
      day('2026-10-08', 'claude', 'claude-opus-5-5', 40),
    ]);
    expect(weeks.map((week) => week.start)).toEqual(['2026-10-05', '2026-09-28']);
    expect(weeks[0]!.providers).toEqual([
      { provider: 'claude', input: 2, output: 45, cacheRead: 0, cacheWrite: 0, reasoning: 0, models: ['claude-opus-5-5', 'claude-haiku-4-5'] },
      { provider: 'codex', input: 1, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0, models: ['gpt-6-sol'] },
    ]);
  });
});

describe('weeks by agent (agentbuilt usage, note #719)', () => {
  const row = (day: string, provider: 'claude' | 'codex', model: string, agentId: string, agentName: string, output: number) => ({
    day, provider, model, agentId, agentName, orgId: 'org-1', input: 1, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  });

  it('opens each provider into models and each model into agents, most output first, never adding providers', () => {
    const weeks = tokenWeeksByAgent([
      row('2026-09-29', 'claude', 'claude-opus-5-5', 'a1', 'Ruby', 10),
      row('2026-10-06', 'codex', 'gpt-6-sol', 'a3', 'Gus', 7),
      row('2026-10-07', 'claude', 'claude-opus-5-5', 'a2', 'Theo', 25),
      row('2026-10-08', 'claude', 'claude-opus-5-5', 'a1', 'Ruby', 15),
      row('2026-10-08', 'claude', 'claude-haiku-4-5', 'a1', 'Ruby', 5),
    ]);
    expect(weeks.map((week) => week.start)).toEqual(['2026-10-05', '2026-09-28']);
    const [thisWeek] = weeks;
    expect(thisWeek!.providers.map((p) => [p.provider, p.output])).toEqual([['claude', 45], ['codex', 7]]);
    const claude = thisWeek!.providers[0]!;
    expect(claude.models.map((m) => [m.model, m.output])).toEqual([['claude-opus-5-5', 40], ['claude-haiku-4-5', 5]]);
    expect(claude.models[0]!.agents.map((a) => [a.agentId, a.name, a.output])).toEqual([['a2', 'Theo', 25], ['a1', 'Ruby', 15]]);
    expect(claude.models[0]!.input).toBe(2);
  });

  it('takes the newest name a row carries, and drops a provider that spent nothing', () => {
    const weeks = tokenWeeksByAgent([
      row('2026-10-06', 'claude', 'claude-opus-5-5', 'a1', 'Ruby', 3),
      { ...row('2026-10-07', 'claude', 'claude-opus-5-5', 'a1', 'Ruby (renamed)', 0), input: 0 },
      { ...row('2026-10-07', 'codex', 'gpt-6-sol', 'a2', 'Gus', 0), input: 0 },
    ]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.providers.map((p) => p.provider)).toEqual(['claude']);
    expect(weeks[0]!.providers[0]!.models[0]!.agents[0]!.name).toBe('Ruby (renamed)');
  });
});
