import { describe, expect, it } from 'vitest';
import { recordAgentRuntimeSamples, runtimeMonthKey } from '../../services/machine-runtime-meter.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

const AT = new Date('2026-07-26T12:00:00.000Z');

async function userWithAgents(userStorage: InMemoryUserStorage, userId: string, agentIds: string[]) {
  await userStorage.createProfile(userId, {
    email: `${userId}@x.io`,
    telegram: {
      agents: Object.fromEntries(agentIds.map((id) => [
        id,
        { id, cli: 'claude', name: 'Main', createdAt: 't', serverId: `fly_ia-${id}.aa11bb22`, connectedAt: 't' },
      ])),
    } as never,
  });
}

describe('runtimeMonthKey', () => {
  it('buckets by UTC month with a zero-padded month', () => {
    expect(runtimeMonthKey(AT)).toBe('2026-07');
    expect(runtimeMonthKey(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
    // Late-evening local times must not leak into the neighboring month.
    expect(runtimeMonthKey(new Date('2026-07-31T23:59:59.000Z'))).toBe('2026-07');
  });
});

describe('recordAgentRuntimeSamples', () => {
  it('accumulates into the month bucket across sweeps', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);

    await recordAgentRuntimeSamples(userStorage, [{ userId: 'u1', agentId: 'a1', ms: 300_000 }], AT);
    await recordAgentRuntimeSamples(userStorage, [{ userId: 'u1', agentId: 'a1', ms: 120_000 }], AT);

    const agent = (await userStorage.getProfile('u1'))?.telegram?.agents?.a1;
    expect(agent?.machineRuntimeMs).toEqual({ '2026-07': 420_000 });
  });

  it('keeps months separate and sibling agents independent', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1', 'a2']);

    await recordAgentRuntimeSamples(userStorage, [
      { userId: 'u1', agentId: 'a1', ms: 60_000 },
      { userId: 'u1', agentId: 'a2', ms: 30_000 },
    ], AT);
    await recordAgentRuntimeSamples(
      userStorage,
      [{ userId: 'u1', agentId: 'a1', ms: 45_000 }],
      new Date('2026-08-01T00:05:00.000Z'),
    );

    const agents = (await userStorage.getProfile('u1'))?.telegram?.agents;
    expect(agents?.a1?.machineRuntimeMs).toEqual({ '2026-07': 60_000, '2026-08': 45_000 });
    expect(agents?.a2?.machineRuntimeMs).toEqual({ '2026-07': 30_000 });
  });

  it('drops zero samples and samples for vanished agents without failing the batch', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);

    await recordAgentRuntimeSamples(userStorage, [
      { userId: 'u1', agentId: 'a1', ms: 0 },
      { userId: 'u1', agentId: 'deleted-agent', ms: 60_000 },
      { userId: 'missing-user', agentId: 'a9', ms: 60_000 },
      { userId: 'u1', agentId: 'a1', ms: 90_000 },
    ], AT);

    const agent = (await userStorage.getProfile('u1'))?.telegram?.agents?.a1;
    expect(agent?.machineRuntimeMs).toEqual({ '2026-07': 90_000 });
  });
});
