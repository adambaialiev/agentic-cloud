import { describe, expect, it } from 'vitest';
import { InMemoryAgentWorkLedger, sumByAgent, workDayKey, workMonthKey } from '../../services/agent-work-ledger.js';
import { AgentWorkMeter, type RunningAgentTurn } from '../../services/agent-work-meter.js';

/**
 * Working time (note #644) is credited a minute at a time while a turn runs
 * and topped up when it ends, so an interrupted turn keeps what it ran.
 */
describe('AgentWorkMeter', () => {
  const T0 = Date.UTC(2026, 8, 24, 10, 0, 0);
  function build(identity: { orgId: string | null; name: string } | null = { orgId: 'org-1', name: 'Ruby' }) {
    const ledger = new InMemoryAgentWorkLedger();
    let now = T0;
    const running: RunningAgentTurn[] = [];
    const describeAgent = { calls: 0 };
    const meter = new AgentWorkMeter({
      ledger,
      describeAgent: async () => { describeAgent.calls += 1; return identity; },
      listRunning: () => running,
      now: () => now,
    });
    return { ledger, meter, running, describeAgent, setNow: (at: number) => { now = at; } };
  }

  it('credits a running turn with each tick and the tail at the end', async () => {
    const { ledger, meter, running, setNow } = build();
    running.push({ userId: 'user-1', agentId: 'agent-1', startedAtMs: T0 - 30_000 });
    setNow(T0 + 60_000);
    await meter.tick();
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(90_000);
    setNow(T0 + 120_000);
    await meter.tick();
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(150_000);
    // The turn ends 20 s after the last tick: only those 20 s are new.
    running.length = 0;
    setNow(T0 + 140_000);
    await meter.finish('user-1', 'agent-1', T0 - 30_000);
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(170_000);
    // Finishing again (a hook firing twice) must not credit the turn twice.
    await meter.finish('user-1', 'agent-1', T0 - 30_000);
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(170_000);
  });

  it('a turn never ticked is credited whole when it finishes', async () => {
    const { ledger, meter, setNow } = build();
    setNow(T0 + 45_000);
    await meter.finish('user-1', 'agent-1', T0);
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(45_000);
  });

  it('splits a turn across the month boundary into both buckets', async () => {
    const { ledger, meter, setNow } = build();
    const monthEnd = Date.UTC(2026, 9, 1, 0, 0, 0);
    setNow(monthEnd + 20_000);
    await meter.finish('user-1', 'agent-1', monthEnd - 40_000);
    expect(ledger.userTotals('user-1')).toEqual([{ agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', ms: 60_000 }]);
    expect(workMonthKey(monthEnd - 1)).toBe('2026-09');
    expect(workMonthKey(monthEnd)).toBe('2026-10');
    // Both months hold exactly their own seconds.
    const rows = (ledger as unknown as { rows: Map<string, { month: string; ms: number }> }).rows;
    expect([...rows.values()].map((row) => [row.month, row.ms])).toEqual([['2026-09', 40_000], ['2026-10', 20_000]]);
  });

  it('splits a turn across midnight into both days, for the Leaderboard', async () => {
    const { ledger, meter, running, setNow } = build();
    const midnight = Date.UTC(2026, 9, 10, 0, 0, 0);
    running.push({ userId: 'user-1', agentId: 'agent-1', startedAtMs: midnight - 90_000 });
    setNow(midnight - 30_000);
    await meter.tick();
    setNow(midnight + 45_000);
    await meter.finish('user-1', 'agent-1', midnight - 90_000);
    expect(workDayKey(midnight - 1)).toBe('2026-10-09');
    expect(ledger.daysSince('2026-10-01')).toEqual([
      { userId: 'user-1', day: '2026-10-09', ms: 90_000 },
      { userId: 'user-1', day: '2026-10-10', ms: 45_000 },
    ]);
    expect(ledger.daysSince('2026-10-10')).toEqual([{ userId: 'user-1', day: '2026-10-10', ms: 45_000 }]);
    // The month still holds the whole turn.
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(135_000);
  });

  it('sums a day across every agent of one owner, and keeps owners apart', async () => {
    const { ledger, meter, setNow } = build();
    setNow(T0 + 60_000);
    await meter.finish('user-1', 'agent-1', T0);
    await meter.finish('user-1', 'agent-2', T0 + 20_000);
    await meter.finish('user-2', 'agent-3', T0 + 50_000);
    expect(ledger.daysSince('2026-09-24')).toEqual([
      { userId: 'user-1', day: '2026-09-24', ms: 100_000 },
      { userId: 'user-2', day: '2026-09-24', ms: 10_000 },
    ]);
  });

  it('keeps crediting a turn whose agent record vanished mid-turn, under the name it began with', async () => {
    const identity = { orgId: 'org-1', name: 'Ruby' };
    const ledger = new InMemoryAgentWorkLedger();
    let now = T0;
    let record: typeof identity | null = identity;
    const running: RunningAgentTurn[] = [{ userId: 'user-1', agentId: 'agent-1', startedAtMs: T0 }];
    const meter = new AgentWorkMeter({ ledger, describeAgent: async () => record, listRunning: () => running, now: () => now });
    now = T0 + 60_000;
    await meter.tick();
    record = null; // deleted while the turn's teardown runs
    now = T0 + 90_000;
    await meter.finish('user-1', 'agent-1', T0);
    expect(ledger.userTotals('user-1')).toEqual([{ agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', ms: 90_000 }]);
  });

  it('credits nothing for an agent it cannot name', async () => {
    const { ledger, meter, setNow } = build(null);
    setNow(T0 + 60_000);
    await meter.finish('user-1', 'agent-1', T0);
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(0);
  });

  it('times a turn the runner does not hold, from begin to its finish', async () => {
    const { ledger, meter, setNow } = build();
    const finish = meter.begin('user-1', 'ws-agent');
    setNow(T0 + 60_000);
    await meter.tick();
    expect(ledger.agentTotal('user-1', 'ws-agent')).toBe(60_000);
    setNow(T0 + 75_000);
    await finish();
    expect(ledger.agentTotal('user-1', 'ws-agent')).toBe(75_000);
    // Gone from the tick's view once finished.
    setNow(T0 + 135_000);
    await meter.tick();
    expect(ledger.agentTotal('user-1', 'ws-agent')).toBe(75_000);
  });

  it('forgets the checkpoint of a turn that is no longer running', async () => {
    const { ledger, meter, running, setNow } = build();
    running.push({ userId: 'user-1', agentId: 'agent-1', startedAtMs: T0 });
    setNow(T0 + 60_000);
    await meter.tick();
    running.length = 0;
    setNow(T0 + 120_000);
    await meter.tick();
    // A NEW turn of the same agent starts from its own start, not the old checkpoint.
    running.push({ userId: 'user-1', agentId: 'agent-1', startedAtMs: T0 + 150_000 });
    setNow(T0 + 180_000);
    await meter.tick();
    expect(ledger.agentTotal('user-1', 'agent-1')).toBe(90_000);
  });

  it('sums month rows per agent and names the agent by its newest month', () => {
    expect(sumByAgent([
      { userId: 'u', agentId: 'a', orgId: null, agentName: 'Old name', month: '2026-09', ms: 10 },
      { userId: 'u', agentId: 'a', orgId: 'org-1', agentName: 'New name', month: '2026-10', ms: 5 },
      { userId: 'u', agentId: 'b', orgId: 'org-1', agentName: 'Max', month: '2026-10', ms: 7 },
    ])).toEqual([
      { agentId: 'a', orgId: 'org-1', agentName: 'New name', ms: 15 },
      { agentId: 'b', orgId: 'org-1', agentName: 'Max', ms: 7 },
    ]);
  });
});
