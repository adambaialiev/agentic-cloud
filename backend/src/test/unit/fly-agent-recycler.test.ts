import { describe, expect, it, vi } from 'vitest';
import { FlyAgentRecycler } from '../../services/fly-agent-recycler.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import type { AgentRecord } from '../../types/user.js';

const NOW = Date.parse('2026-07-24T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const APP = 'ia-9f0a1b2c3d4e5f60';
const MACHINE = 'e8272d7ce452e8';
const SERVER_ID = `fly_${APP}.${MACHINE}`;
const SANDBOX_ID = `fly-sandbox-${APP}.${MACHINE}`;

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-a',
    name: 'Ada',
    cli: 'claude',
    serverId: SERVER_ID,
    connectedAt: '2026-07-01T00:00:00.000Z',
    botId: '8988',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function userWithAgent(
  userStorage: InMemoryUserStorage,
  userId: string,
  agent: AgentRecord,
  telegram: Record<string, unknown> = {},
) {
  await userStorage.createProfile(userId, {
    email: `${userId}@x.io`,
    telegram: { chatId: '123456', agents: { [agent.id]: agent }, ...telegram } as never,
  });
}

function makeRecycler(args: {
  userStorage: InMemoryUserStorage;
  destroySandbox?: ReturnType<typeof vi.fn>;
  warnOwner?: ReturnType<typeof vi.fn>;
  turnRunning?: boolean;
  /** userIds the fake org layer counts as members. */
  members?: string[];
  idleMs?: number;
  warnLeadMs?: number;
  intervalMs?: number;
  startupDelayMs?: number;
}) {
  const destroySandbox = args.destroySandbox ?? vi.fn().mockResolvedValue(undefined);
  const warnOwner = args.warnOwner ?? vi.fn().mockResolvedValue(true);
  const recycler = new FlyAgentRecycler({
    sandboxClient: { destroySandbox },
    userStorage: args.userStorage,
    isTurnRunningForUser: () => args.turnRunning ?? false,
    isOrgMember: async (userId) => (args.members ?? []).includes(userId),
    warnOwner,
    idleMs: args.idleMs ?? 3 * DAY,
    warnLeadMs: args.warnLeadMs ?? DAY,
    intervalMs: args.intervalMs,
    startupDelayMs: args.startupDelayMs,
    now: () => NOW,
  });
  return { recycler, destroySandbox, warnOwner };
}

/** ISO string for a timestamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

describe('FlyAgentRecycler.decideRecycle', () => {
  const { recycler } = makeRecycler({ userStorage: new InMemoryUserStorage() });
  const decide = (
    agent: Partial<AgentRecord>,
    lastActivityAt: number | undefined,
    turnRunning = false,
  ) => recycler.decideRecycle({ agent: agentRecord(agent), lastActivityAt, turnRunning, now: NOW });

  it('recycles a machine idle past the deadline', () => {
    expect(decide({}, NOW - 4 * DAY)).toEqual({ action: 'destroy', reason: 'idle' });
  });

  it('warns inside the lead window, once', () => {
    expect(decide({}, NOW - 2.5 * DAY)).toEqual({ action: 'warn', reason: 'warning' });
    expect(decide({ recycleWarnedAt: daysAgo(0.5) }, NOW - 2.5 * DAY))
      .toEqual({ action: 'keep', reason: 'already-warned' });
  });

  it('leaves a recently active owner alone', () => {
    expect(decide({}, NOW - 1 * DAY)).toEqual({ action: 'keep', reason: 'recently-active' });
  });

  it('never touches an agent with a turn in flight', () => {
    expect(decide({}, NOW - 10 * DAY, true)).toEqual({ action: 'keep', reason: 'in-flight-turn' });
  });

  it('ignores agents with no machine and non-Fly machines', () => {
    expect(decide({ serverId: undefined }, NOW - 10 * DAY))
      .toEqual({ action: 'keep', reason: 'no-machine' });
    expect(decide({ serverId: 'hcloud_123' }, NOW - 10 * DAY))
      .toEqual({ action: 'keep', reason: 'not-fly' });
  });

  it('never recycles a kept (member) agent, no matter how idle', () => {
    const d = recycler.decideRecycle({
      agent: agentRecord({}),
      lastActivityAt: NOW - 30 * DAY,
      turnRunning: false,
      keptMachines: true,
      now: NOW,
    });
    expect(d).toEqual({ action: 'keep', reason: 'kept-plan' });
  });

  it('will not recycle a freshly built agent whose owner has a stale activity stamp', () => {
    // createdAt is a FLOOR on idleness. Without it, an agent built minutes ago
    // for a user whose telegram stamp is old would be destroyed immediately —
    // the failure mode is a machine deleted right after it was provisioned.
    expect(decide({ createdAt: daysAgo(0.1) }, NOW - 30 * DAY))
      .toEqual({ action: 'keep', reason: 'recently-active' });
  });

  it('judges an agent on its OWN traffic, not its owner\'s', () => {
    // The point of the per-agent stamp: an abandoned second agent is
    // collectable even while its owner is busy in another chat.
    expect(decide({ lastActivityAt: daysAgo(5) }, NOW - 1 * 60_000))
      .toEqual({ action: 'destroy', reason: 'idle' });
    // And the converse — a busy agent survives an owner who is quiet elsewhere.
    expect(decide({ lastActivityAt: daysAgo(0.1) }, NOW - 30 * DAY))
      .toEqual({ action: 'keep', reason: 'recently-active' });
  });

  it('falls back to account-level activity for agents predating the stamp', () => {
    // Existing records have no lastActivityAt; they must keep behaving exactly
    // as they did before the field existed rather than all recycling at once.
    expect(decide({ lastActivityAt: undefined }, NOW - 1 * DAY))
      .toEqual({ action: 'keep', reason: 'recently-active' });
    expect(decide({ lastActivityAt: undefined }, NOW - 5 * DAY))
      .toEqual({ action: 'destroy', reason: 'idle' });
  });

  it('keeps an agent it cannot date at all', () => {
    // Destroying is unrecoverable, so no timestamp means no action, ever.
    expect(decide({ createdAt: 'not-a-date' }, undefined))
      .toEqual({ action: 'keep', reason: 'unknown-activity' });
  });
});

describe('FlyAgentRecycler.runOnce', () => {
  it('destroys the machine and clears every field describing it', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(
      userStorage,
      'user-1',
      agentRecord({
        identityVersion: 4,
        exposedUrl: `https://${APP}.fly.dev`,
        exposedPorts: [3000],
        recycleWarnedAt: daysAgo(1),
      }),
      { lastActivityAt: daysAgo(5) },
    );
    const { recycler, destroySandbox } = makeRecycler({ userStorage });

    const result = await recycler.runOnce();

    expect(result).toMatchObject({ destroyed: 1, warned: 0 });
    expect(destroySandbox).toHaveBeenCalledWith(SANDBOX_ID);
    const agent = (await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a'];
    // Clearing serverId is what makes the next message rebuild the machine.
    expect(agent?.serverId).toBeUndefined();
    expect(agent?.identityVersion).toBeUndefined();
    expect(agent?.exposedUrl).toBeUndefined();
    expect(agent?.exposedPorts).toBeUndefined();
    expect(agent?.recycleWarnedAt).toBeUndefined();
    // The agent itself survives, signed in, with its bot intact.
    expect(agent?.connectedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(agent?.botId).toBe('8988');
    expect(agent?.name).toBe('Ada');
  });

  it('keeps the record pointing at the machine when the teardown fails', async () => {
    // Clearing serverId after a failed destroy would strand a billed machine
    // that nothing references — invisible, and never collected.
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(5) });
    const destroySandbox = vi.fn().mockRejectedValue(new Error('Fly API error (500): internal'));
    const { recycler } = makeRecycler({ userStorage, destroySandbox });

    const result = await recycler.runOnce();

    expect(result).toMatchObject({ destroyed: 0, kept: 1 });
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.serverId)
      .toBe(SERVER_ID);
  });

  it('warns before the deadline and does not warn twice', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(2.5) });
    const { recycler, warnOwner, destroySandbox } = makeRecycler({ userStorage });

    const first = await recycler.runOnce();
    const second = await recycler.runOnce();

    expect(first).toMatchObject({ warned: 1, destroyed: 0 });
    expect(second).toMatchObject({ warned: 0, destroyed: 0 });
    expect(warnOwner).toHaveBeenCalledTimes(1);
    expect(warnOwner.mock.calls[0][0]).toMatchObject({ userId: 'user-1', daysLeft: 1 });
    expect(destroySandbox).not.toHaveBeenCalled();
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.recycleWarnedAt)
      .toBeTruthy();
  });

  it('retries a warning that could not be delivered', async () => {
    // An undelivered warning must not buy the agent a silent recycle: leaving
    // it unstamped is what makes the next sweep try again.
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(2.5) });
    const warnOwner = vi.fn().mockResolvedValue(false);
    const { recycler } = makeRecycler({ userStorage, warnOwner });

    await recycler.runOnce();
    await recycler.runOnce();

    expect(warnOwner).toHaveBeenCalledTimes(2);
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.recycleWarnedAt)
      .toBeUndefined();
  });

  it('survives a warning that throws', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(2.5) });
    const warnOwner = vi.fn().mockRejectedValue(new Error('telegram down'));
    const { recycler } = makeRecycler({ userStorage, warnOwner });

    await expect(recycler.runOnce()).resolves.toMatchObject({ warned: 0, kept: 1 });
  });

  it('leaves an active user\'s whole fleet alone', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(0.2) });
    const { recycler, destroySandbox, warnOwner } = makeRecycler({ userStorage });

    await recycler.runOnce();

    expect(destroySandbox).not.toHaveBeenCalled();
    expect(warnOwner).not.toHaveBeenCalled();
  });

  it('spares an org member\'s idle fleet (kept machines are the membership promise)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(10) });
    const { recycler, destroySandbox, warnOwner } = makeRecycler({ userStorage, members: ['user-1'] });

    await recycler.runOnce();

    expect(destroySandbox).not.toHaveBeenCalled();
    expect(warnOwner).not.toHaveBeenCalled();
  });

  it('spares an admin\'s idle fleet even outside an org', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(10) });
    await userStorage.updateProfile('user-1', { roles: { admin: true } });
    const { recycler, destroySandbox, warnOwner } = makeRecycler({ userStorage });

    await recycler.runOnce();

    expect(destroySandbox).not.toHaveBeenCalled();
    expect(warnOwner).not.toHaveBeenCalled();
  });

  it('recycles again once the membership has ended', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(10) });
    const { recycler, destroySandbox } = makeRecycler({ userStorage, members: [] });

    await recycler.runOnce();

    expect(destroySandbox).toHaveBeenCalledTimes(1);
  });

  it('clears a stale serverId for an agent whose machine is already gone', async () => {
    // destroySandbox is idempotent for a machine Fly has forgotten, so an
    // orphaned record gets tidied by the same pass rather than lingering.
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(5) });
    const { recycler } = makeRecycler({ userStorage });

    await recycler.runOnce();

    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.serverId)
      .toBeUndefined();
  });

  it('counts every agent it walks, so a quiet sweep is not an empty one', async () => {
    // The two cases the boot log must never conflate: a fleet that was walked
    // and had nothing due, versus a sweep that saw no agents at all.
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(0) });
    const { recycler } = makeRecycler({ userStorage });

    await expect(recycler.runOnce()).resolves.toEqual({
      examined: 1,
      considered: 0,
      destroyed: 0,
      warned: 0,
      kept: 0,
    });

    const empty = makeRecycler({ userStorage: new InMemoryUserStorage() }).recycler;
    await expect(empty.runOnce()).resolves.toMatchObject({ examined: 0 });
  });

  it('does not overlap sweeps', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(5) });
    let release!: () => void;
    const destroySandbox = vi.fn().mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const { recycler } = makeRecycler({ userStorage, destroySandbox });

    const first = recycler.runOnce();
    const second = await recycler.runOnce();
    release();
    await first;

    expect(second).toEqual({ examined: 0, considered: 0, destroyed: 0, warned: 0, kept: 0 });
    expect(destroySandbox).toHaveBeenCalledTimes(1);
  });
});

describe('FlyAgentRecycler.start', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  /** Storage holding one agent idle well past the deadline. Built on real timers. */
  async function idleFleet() {
    const userStorage = new InMemoryUserStorage();
    await userWithAgent(userStorage, 'user-1', agentRecord(), { lastActivityAt: daysAgo(5) });
    return userStorage;
  }

  it('sweeps shortly after start, not only once an hour has passed', async () => {
    // The bug this pins: with an interval alone, a backend restarted more often
    // than hourly — which a day of deploys does — never swept at all.
    const userStorage = await idleFleet();
    vi.useFakeTimers();
    try {
      const { recycler, destroySandbox } = makeRecycler({
        userStorage,
        startupDelayMs: 2 * MINUTE,
        intervalMs: HOUR,
      });
      recycler.start();

      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(destroySandbox).not.toHaveBeenCalled(); // boot still settling

      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(destroySandbox).toHaveBeenCalledTimes(1);
      recycler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sweeping on the interval after the startup sweep', async () => {
    const userStorage = await idleFleet();
    const sweeps = vi.spyOn(userStorage, 'getAllUsers');
    vi.useFakeTimers();
    try {
      const { recycler } = makeRecycler({ userStorage, startupDelayMs: 2 * MINUTE, intervalMs: HOUR });
      recycler.start();

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(sweeps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(HOUR);
      expect(sweeps).toHaveBeenCalledTimes(2);
      recycler.stop();
    } finally {
      vi.useRealTimers();
      sweeps.mockRestore();
    }
  });

  it('cancels a startup sweep that has not fired yet when stopped', async () => {
    const userStorage = await idleFleet();
    const sweeps = vi.spyOn(userStorage, 'getAllUsers');
    vi.useFakeTimers();
    try {
      const { recycler } = makeRecycler({ userStorage, startupDelayMs: 2 * MINUTE, intervalMs: HOUR });
      recycler.start();
      recycler.stop();

      await vi.advanceTimersByTimeAsync(HOUR);
      expect(sweeps).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      sweeps.mockRestore();
    }
  });
});
