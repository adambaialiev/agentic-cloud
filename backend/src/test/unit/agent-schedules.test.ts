import { describe, expect, it } from 'vitest';
import { AgentScheduleService, FAILED_TURN_ROW_PREFIX, type AgentScheduleServiceDeps } from '../../services/agent-schedules.js';
import { InMemoryAgentScheduleStorage } from '../../services/agent-schedule-storage.js';
import {
  buildScheduledTickPrompt, localToUtc, nextLocalMidnight, nextTickFrom, parseEvery, parseWindow, emptyScheduleDay,
} from '../../types/agent-schedule.js';
import type { AgentRecord } from '../../types/user.js';
import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-proactive.js';

/**
 * Schedules (note #779): every guard the note names, on a clock the test
 * holds. The service is pure over its deps, so the world is a few maps.
 */
function world(opts: { now?: string } = {}) {
  const clock = { now: new Date(opts.now ?? '2026-10-19T15:00:00Z') };
  const agents = new Map<string, AgentRecord>();
  const add = (id: string, patch: Partial<AgentRecord> = {}): AgentRecord => {
    const record = { id, name: id[0]!.toUpperCase() + id.slice(1), cli: 'claude', orgId: 'o1', createdAt: '2026-10-01T00:00:00Z', connectedAt: '2026-10-01T00:00:00Z', ...patch } as AgentRecord;
    agents.set(id, record);
    return record;
  };
  add('producer');
  add('truman');
  add('cos', { purpose: 'workspace-recap' });
  const working = new Set<string>();
  const started: Array<{ agentId: string; content: string; task: string }> = [];
  const rows: Array<{ agentId: string; text: string }> = [];
  const told: Array<{ agentId: string; text: string; event: WorkspaceAgentEvent }> = [];
  const woken: Array<{ agentId: string; text: string }> = [];
  const resets: string[] = [];
  const latest = new Map<string, { role: string; text: string; at: string }>();
  const state = { startOutcome: 'delivered' as 'delivered' | 'busy' | 'no-machine' | 'failed', room: null as boolean | null, tokens: 0 };
  const deps: AgentScheduleServiceDeps = {
    storage: new InMemoryAgentScheduleStorage(),
    now: () => clock.now,
    random: () => 0,
    getAgent: async (_u, id) => agents.get(id) ?? null,
    listAgents: async () => [...agents.values()],
    isAgentWorking: (_u, id) => working.has(id),
    contextPercent: (agent) => (agent.contextUsage ? Math.round((agent.contextUsage.tokens / (agent.contextUsage.window ?? 200_000)) * 100) : null),
    startScheduledTurn: async (args) => { if (state.startOutcome === 'delivered') started.push(args); return state.startOutcome; },
    resetChat: async ({ agentId }) => { resets.push(agentId); return { ok: true }; },
    subscriptionHasRoom: async () => state.room,
    tokensSpent: () => state.tokens,
    latestChatRow: async (_u, id) => latest.get(id) ?? null,
    tellOwner: async ({ agentId, text, event }) => { told.push({ agentId, text, event }); },
    recordRow: async ({ agentId, text }) => { rows.push({ agentId, text }); },
    notifyAgent: async ({ agentId, text }) => { woken.push({ agentId, text }); },
    log: () => undefined,
  };
  const service = new AgentScheduleService(deps);
  const tick = async (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); await service.sweep(); };
  return { clock, agents, add, working, started, rows, told, woken, resets, latest, state, service, tick };
}

const propose = (w: ReturnType<typeof world>, patch: Partial<Parameters<AgentScheduleService['propose']>[0]> = {}) => w.service.propose({
  userId: 'adam', orgId: 'o1', byAgentId: 'producer', message: 'Take the next beat.', every: '8m', window: '07:00-23:00', timeZone: 'America/Los_Angeles', capTurns: 3, ...patch,
});

const approved = async (w: ReturnType<typeof world>, patch: Partial<Parameters<AgentScheduleService['propose']>[0]> = {}) => {
  const result = await propose(w, patch);
  if (!result.ok) throw new Error(result.reason);
  const decided = await w.service.decide({ userId: 'adam', id: result.schedule.id, decision: 'approve' });
  if (!decided.ok) throw new Error(decided.reason);
  return decided.schedule;
};

describe('the clock', () => {
  it('reads cadences and windows', () => {
    expect(parseEvery('8m')).toBe(8);
    expect(parseEvery('90s')).toBe(1.5);
    expect(parseEvery('2h')).toBe(120);
    expect(parseEvery('15')).toBe(15);
    expect(parseEvery('30s')).toBeNull();
    expect(parseEvery('25h')).toBeNull();
    expect(parseWindow('07:00-23:00')).toEqual({ from: '07:00', to: '23:00' });
    expect(parseWindow('00:00-24:00')).toEqual({ from: '00:00', to: '24:00' });
    expect(parseWindow('23:00-07:00')).toBeNull();
    expect(parseWindow('7am-11pm')).toBeNull();
  });

  it('knows local midnight and the window opening in a zone with DST', () => {
    // 2026-10-19 15:00Z is 08:00 in Los Angeles (PDT, UTC-7).
    const now = new Date('2026-10-19T15:00:00Z');
    expect(nextLocalMidnight('America/Los_Angeles', now).toISOString()).toBe('2026-10-20T07:00:00.000Z');
    expect(localToUtc('America/Los_Angeles', '2026-10-19', 7 * 60).toISOString()).toBe('2026-10-19T14:00:00.000Z');
    const window = { windowFrom: '07:00', windowTo: '23:00', timeZone: 'America/Los_Angeles' };
    expect(nextTickFrom(window, now)).toEqual(now);
    // 03:00 local: the window opens at 07:00 local the same day.
    expect(nextTickFrom(window, new Date('2026-10-19T10:00:00Z')).toISOString()).toBe('2026-10-19T14:00:00.000Z');
    // 23:30 local: tomorrow's opening.
    expect(nextTickFrom(window, new Date('2026-10-20T06:30:00Z')).toISOString()).toBe('2026-10-20T14:00:00.000Z');
    // Across the DST fall-back on 2026-11-01: local midnight is still local midnight.
    expect(nextLocalMidnight('America/Los_Angeles', new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });
});

describe('who may create a schedule', () => {
  it('an agent only proposes; nothing ticks until the owner approves', async () => {
    const w = world();
    const result = await propose(w);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.status).toBe('proposed');
    expect(w.rows[0]?.text).toMatch(/^Producer asked for a schedule: "Take the next beat\." every 8 minutes, 07:00–23:00 America\/Los_Angeles, at most 3 turns a day\. Approve or reject it under Schedule on this screen\.$/);
    await w.tick(10);
    await w.tick(10);
    expect(w.started).toHaveLength(0);
    // Only the owner decides; the proposer is woken with the answer.
    const decided = await w.service.decide({ userId: 'adam', id: result.schedule.id, decision: 'approve' });
    expect(decided.ok && decided.schedule.status).toBe('active');
    expect(w.woken[0]).toMatchObject({ agentId: 'producer' });
    expect(w.woken[0]?.text).toMatch(/^\[Platform\] Your user APPROVED the schedule/);
    expect(await w.service.decide({ userId: 'stranger', id: result.schedule.id, decision: 'approve' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses the Chief of Staff as a target and as a proposer', async () => {
    const w = world();
    expect(await propose(w, { agent: 'cos' })).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/never be the target/) });
    expect(await propose(w, { byAgentId: 'cos' })).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/cannot create one/) });
  });

  it('aims at a sibling in the workplace by name, one schedule per agent', async () => {
    const w = world();
    const result = await propose(w, { agent: 'Truman' });
    expect(result.ok && result.schedule.agentId).toBe('truman');
    expect(await propose(w, { agent: 'truman' })).toMatchObject({ ok: false, reason: expect.stringMatching(/already has a schedule/) });
    // Rooms are gone (note #843): any sibling in the workplace may be the target.
    w.add('ada');
    const ada = await propose(w, { agent: 'ada' });
    expect(ada.ok && ada.schedule).toMatchObject({ agentId: 'ada', orgId: 'o1' });
    expect(ada.ok && ada.schedule).not.toHaveProperty('roomId');
    expect(await propose(w, { agent: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' });
    // The workplace is the fence: the owner's agent in another workplace is
    // not this one's to schedule, by name or by id.
    w.add('elsewhere', { orgId: 'o2' });
    expect(await propose(w, { agent: 'elsewhere' })).toMatchObject({ ok: false, code: 'not_found', reason: expect.stringContaining('in this workplace') });
  });

  it('refuses a bad cadence, window, zone or cap with words', async () => {
    const w = world();
    expect(await propose(w, { every: 'often' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await propose(w, { window: '23:00-07:00' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await propose(w, { timeZone: 'Mars/Olympus' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await propose(w, { capTurns: 0 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await propose(w, { message: '   ' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the ticks', () => {
  it('ticks on the cadence inside the window as a quiet platform turn, and never starts the Chief of Staff', async () => {
    const w = world();
    const schedule = await approved(w);
    expect(schedule.nextTickAt).toBe(w.clock.now.toISOString());
    await w.service.sweep();
    expect(w.started).toHaveLength(1);
    expect(w.started[0]).toMatchObject({ agentId: 'producer', task: 'Scheduled: Take the next beat.' });
    expect(w.started[0]!.content).toMatch(/^\[Platform\] Scheduled tick\./);
    expect(w.started[0]!.content).toContain('Take the next beat.');
    expect(w.started[0]!.content).toContain('scheduled turn 1 of 3 today');
    // Not before the cadence has passed.
    await w.tick(5);
    expect(w.started).toHaveLength(1);
    await w.tick(4);
    expect(w.started).toHaveLength(2);
    expect(w.told).toHaveLength(0);
    expect(w.rows.filter((row) => !/^(Producer asked|Schedule approved)/.test(row.text))).toHaveLength(0);
  });

  it('sleeps outside the window and holds the machine awake inside it', async () => {
    // 03:00 Los Angeles.
    const w = world({ now: '2026-10-19T10:00:00Z' });
    const schedule = await approved(w);
    expect(schedule.nextTickAt).toBe('2026-10-19T14:00:00.000Z');
    await w.tick(60);
    expect(w.started).toHaveLength(0);
    expect(w.service.holdsAwake('adam', 'producer')).toBe(false);
    await w.tick(3 * 60);
    expect(w.started).toHaveLength(1);
    expect(w.service.holdsAwake('adam', 'producer')).toBe(true);
  });

  it('skips, never queues, while the agent is working', async () => {
    const w = world();
    const schedule = await approved(w);
    w.working.add('producer');
    await w.service.sweep();
    expect(w.started).toHaveLength(0);
    expect((await w.service.get(schedule.id))!).toMatchObject({ lastOutcome: 'skipped', day: { skipped: 1, turns: 0 } });
    w.working.delete('producer');
    await w.tick(8);
    expect(w.started).toHaveLength(1);
    // A turn that became busy between the check and the start is a skip too.
    w.state.startOutcome = 'busy';
    await w.tick(8);
    expect((await w.service.get(schedule.id))!.day.skipped).toBe(2);
  });

  it('resets a chat past the threshold instead of working in it; the next tick does the work', async () => {
    const w = world();
    const schedule = await approved(w);
    w.add('producer', { contextUsage: { tokens: 140_000, window: 200_000, at: '2026-10-19T14:00:00Z' } });
    await w.service.sweep();
    expect(w.resets).toEqual(['producer']);
    expect(w.started).toHaveLength(0);
    expect((await w.service.get(schedule.id))!).toMatchObject({ lastOutcome: 'reset', day: { resets: 1, turns: 0 } });
    w.add('producer', { contextUsage: { tokens: 1_000, window: 200_000, at: '2026-10-19T14:10:00Z' } });
    await w.tick(8);
    expect(w.started).toHaveLength(1);
  });

  it('pauses at the daily cap, tells the owner once, and starts over at local midnight', async () => {
    const w = world();
    const schedule = await approved(w, { capTurns: 2 });
    await w.service.sweep();
    await w.tick(8);
    expect(w.started).toHaveLength(2);
    await w.tick(8);
    expect(w.started).toHaveLength(2);
    const paused = (await w.service.get(schedule.id))!;
    expect(paused).toMatchObject({ status: 'paused', pause: { reason: 'cap', until: '2026-10-20T07:00:00.000Z' } });
    expect(w.told).toHaveLength(1);
    expect(w.told[0]!.event).toMatchObject({ kind: 'schedule-cap' });
    expect(w.told[0]!.text).toMatch(/reached its daily cap \(2 scheduled turns\)\. It resumes at midnight America\/Los_Angeles/);
    expect(w.service.holdsAwake('adam', 'producer')).toBe(false);
    // The agent itself is untouched: nothing here touches its record.
    // 23:50 local: still paused.
    w.clock.now = new Date('2026-10-20T06:50:00Z');
    await w.service.sweep();
    expect((await w.service.get(schedule.id))!.status).toBe('paused');
    // 00:01 local the next day: active again, the counters at zero, waiting for the window.
    w.clock.now = new Date('2026-10-20T07:01:00Z');
    await w.service.sweep();
    expect((await w.service.get(schedule.id))!).toMatchObject({ status: 'active', day: { date: '2026-10-20', turns: 0 }, nextTickAt: '2026-10-20T14:00:00.000Z' });
    expect(w.told).toHaveLength(1);
  });

  it('counts tokens against a token cap as the ticks settle', async () => {
    const w = world();
    const schedule = await approved(w, { capTurns: undefined, capTokens: 1_000 });
    await w.service.sweep();
    w.state.tokens = 700;
    w.add('producer', { lastTurnEndedAt: new Date(w.clock.now.getTime() + 60_000).toISOString() });
    await w.tick(8);
    expect((await w.service.get(schedule.id))!.day.tokens).toBe(700);
    expect(w.started).toHaveLength(2);
    w.state.tokens = 1_200;
    w.add('producer', { lastTurnEndedAt: new Date(w.clock.now.getTime() + 60_000).toISOString() });
    await w.tick(8);
    expect((await w.service.get(schedule.id))!).toMatchObject({ status: 'paused', pause: { reason: 'cap' }, day: { tokens: 1_200 } });
    expect(w.told[0]!.text).toMatch(/1,200 tokens/);
  });

  it('pauses when the chosen subscription has no room — never the next subscription — and tells the owner', async () => {
    const w = world();
    const schedule = await approved(w);
    w.state.room = false;
    await w.service.sweep();
    expect(w.started).toHaveLength(0);
    expect((await w.service.get(schedule.id))!).toMatchObject({ status: 'paused', pause: { reason: 'subscription' } });
    expect(w.told[0]!.event).toMatchObject({ kind: 'schedule-subscription' });
    expect(w.told[0]!.text).toMatch(/^Schedule paused: Producer's scheduled turn could not run: the subscription it runs on has no room right now\./);
    // An agent may resume it once the subscription has room again; the owner always may.
    w.state.room = true;
    const resumed = await w.service.resume({ id: schedule.id, userId: 'adam', by: 'agent' });
    expect(resumed.ok && resumed.schedule.status).toBe('active');
  });

  it('pauses when a tick hits the usage limit mid-turn', async () => {
    const w = world();
    const schedule = await approved(w);
    await w.service.sweep();
    w.add('producer', { lastTurnEndedAt: new Date(w.clock.now.getTime() + 60_000).toISOString(), sessionLimit: { hitAt: new Date(w.clock.now.getTime() + 30_000).toISOString(), resetAt: '2026-10-19T20:00:00Z' } });
    await w.tick(8);
    expect(w.started).toHaveLength(1);
    expect((await w.service.get(schedule.id))!).toMatchObject({ status: 'paused', pause: { reason: 'subscription' } });
  });

  it('pauses after three failed ticks in a row and tells the owner why', async () => {
    const w = world();
    const schedule = await approved(w);
    for (let i = 0; i < 3; i += 1) {
      await (i === 0 ? w.service.sweep() : w.tick(8));
      w.add('producer', { lastTurnEndedAt: new Date(w.clock.now.getTime() + 60_000).toISOString() });
      w.latest.set('producer', { role: 'agent', text: `${FAILED_TURN_ROW_PREFIX}\n\nCould not reach the machine.`, at: new Date(w.clock.now.getTime() + 60_000).toISOString() });
    }
    await w.tick(8);
    expect(w.started).toHaveLength(3);
    expect((await w.service.get(schedule.id))!).toMatchObject({ status: 'paused', pause: { reason: 'failures' }, failStreak: 3, day: { failed: 3 } });
    expect(w.told[0]!.event).toMatchObject({ kind: 'schedule-failed' });
    expect(w.told[0]!.text).toMatch(/failed 3 times in a row; the last said: Could not reach the machine\./);
  });

  it('a success resets the failure streak', async () => {
    const w = world();
    const schedule = await approved(w);
    w.state.startOutcome = 'failed';
    await w.service.sweep();
    await w.tick(8);
    expect((await w.service.get(schedule.id))!.failStreak).toBe(2);
    w.state.startOutcome = 'delivered';
    await w.tick(8);
    w.add('producer', { lastTurnEndedAt: new Date(w.clock.now.getTime() + 60_000).toISOString() });
    await w.tick(8);
    expect((await w.service.get(schedule.id))!).toMatchObject({ failStreak: 0, status: 'active' });
  });

  it('the owner pauses and resumes; the Chief of Staff pauses only; an agent cannot undo the owner', async () => {
    const w = world();
    const schedule = await approved(w);
    expect((await w.service.pause({ id: schedule.id, userId: 'adam', by: 'workspace-agent' })).ok).toBe(true);
    expect((await w.service.get(schedule.id))!.pause).toMatchObject({ reason: 'workspace-agent' });
    expect(await w.service.resume({ id: schedule.id, userId: 'adam', by: 'agent' })).toMatchObject({ ok: false, code: 'refused' });
    expect((await w.service.resume({ id: schedule.id, userId: 'adam', by: 'owner' })).ok).toBe(true);
    await w.service.sweep();
    expect(w.started).toHaveLength(1);
    expect((await w.service.pause({ id: schedule.id, userId: 'adam', by: 'owner' })).ok).toBe(true);
    await w.tick(8);
    expect(w.started).toHaveLength(1);
    expect((await w.service.remove({ id: schedule.id, userId: 'adam' })).ok).toBe(true);
    expect(await w.service.forAgent('producer')).toBeNull();
  });

  it('a schedule whose agent is gone goes with it', async () => {
    const w = world();
    const schedule = await approved(w);
    w.agents.delete('producer');
    await w.service.sweep();
    expect(await w.service.get(schedule.id)).toBeNull();
  });

  it('the tick prompt says it is quiet and where state belongs', () => {
    const text = buildScheduledTickPrompt({ schedule: { id: 'sch_1', message: 'Take the next beat.', everyMinutes: 8, windowFrom: '07:00', windowTo: '23:00', timeZone: 'UTC', capTurns: 120, day: emptyScheduleDay('2026-10-19') } });
    expect(text.split('\n').filter((line) => line.startsWith('[Platform]'))).toHaveLength(1);
    expect(text).toContain('told NOTHING');
    expect(text).toContain('never in this chat');
  });
});
