import { describe, expect, it, vi } from 'vitest';
import {
  agentMachineShapeMatches,
  agentMachineShapeOf,
  recordAgentMachineShapes,
} from '../../services/agent-machine-observer.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

const AT = new Date('2026-09-06T12:00:00.000Z');
const LATER = new Date('2026-09-06T13:00:00.000Z');

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

const agentOf = async (userStorage: InMemoryUserStorage, userId: string, agentId: string) => (
  (await userStorage.getProfile(userId))?.telegram?.agents?.[agentId]
);

describe('agentMachineShapeOf', () => {
  it('takes a whole shape from Fly’s own field names', () => {
    expect(agentMachineShapeOf({ cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }))
      .toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 4096 });
  });

  it('takes all three or none — half a size is worse on a row than no size', () => {
    // A reader cannot tell a small machine from a partly-read one, so the
    // row must be able to say nothing rather than something incomplete.
    expect(agentMachineShapeOf({ cpu_kind: 'performance', cpus: 2 })).toBeUndefined();
    expect(agentMachineShapeOf({ cpus: 2, memory_mb: 4096 })).toBeUndefined();
    expect(agentMachineShapeOf({ cpu_kind: 'performance', memory_mb: 4096 })).toBeUndefined();
    expect(agentMachineShapeOf({ cpu_kind: '  ', cpus: 2, memory_mb: 4096 })).toBeUndefined();
    expect(agentMachineShapeOf({ cpu_kind: 'shared', cpus: 0, memory_mb: 4096 })).toBeUndefined();
    expect(agentMachineShapeOf(undefined)).toBeUndefined();
  });

  it('bounds the kind, which arrives from somebody else’s API', () => {
    const shape = agentMachineShapeOf({ cpu_kind: 'x'.repeat(200), cpus: 1, memory_mb: 2048 });
    expect(shape?.cpuKind.length).toBe(32);
  });
});

describe('agentMachineShapeMatches', () => {
  it('is true only on all three, and false on nothing recorded', () => {
    const observed = { cpuKind: 'performance', cpus: 2, memoryMb: 4096 };
    expect(agentMachineShapeMatches(observed, observed)).toBe(true);
    expect(agentMachineShapeMatches(undefined, observed)).toBe(false);
    expect(agentMachineShapeMatches({ ...observed, cpus: 4 }, observed)).toBe(false);
    expect(agentMachineShapeMatches({ ...observed, memoryMb: 8192 }, observed)).toBe(false);
    expect(agentMachineShapeMatches({ ...observed, cpuKind: 'shared' }, observed)).toBe(false);
  });
});

describe('recordAgentMachineShapes', () => {
  it('writes the shape and the moment it landed', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);

    await recordAgentMachineShapes(
      userStorage,
      [{ userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 }],
      AT,
    );

    const agent = await agentOf(userStorage, 'u1', 'a1');
    expect(agent?.machineSize).toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 4096 });
    expect(agent?.machineSizeAt).toBe(AT.toISOString());
  });

  it('writes NOTHING when the record already says exactly this', async () => {
    // The whole arrangement rests on this: the sweep sees every machine every
    // few minutes and a shape changes about once in a machine's life, so a
    // write per sighting would be the fleet's profile store rewritten all day
    // to change nothing.
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);
    const shape = { userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 };
    await recordAgentMachineShapes(userStorage, [shape], AT);

    const write = vi.spyOn(userStorage, 'updateAgentFields');
    await recordAgentMachineShapes(userStorage, [shape], LATER);
    expect(write).not.toHaveBeenCalled();
    // And the stamp still means when this CHANGED, not when a sweep last ran.
    expect((await agentOf(userStorage, 'u1', 'a1'))?.machineSizeAt).toBe(AT.toISOString());
  });

  it('follows a machine that actually moved', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);
    await recordAgentMachineShapes(
      userStorage,
      [{ userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 4, memoryMb: 8192 }],
      AT,
    );
    await recordAgentMachineShapes(
      userStorage,
      [{ userId: 'u1', agentId: 'a1', cpuKind: 'shared', cpus: 2, memoryMb: 4096 }],
      LATER,
    );

    const agent = await agentOf(userStorage, 'u1', 'a1');
    expect(agent?.machineSize).toEqual({ cpuKind: 'shared', cpus: 2, memoryMb: 4096 });
    expect(agent?.machineSizeAt).toBe(LATER.toISOString());
  });

  it('reads each owner once however many machines they run', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1', 'a2', 'a3']);
    await userWithAgents(userStorage, 'u2', ['b1']);
    const read = vi.spyOn(userStorage, 'getProfile');

    await recordAgentMachineShapes(userStorage, [
      { userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
      { userId: 'u2', agentId: 'b1', cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
      { userId: 'u1', agentId: 'a2', cpuKind: 'performance', cpus: 4, memoryMb: 8192 },
      { userId: 'u1', agentId: 'a3', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    ], AT);

    expect(read).toHaveBeenCalledTimes(2);
    expect((await agentOf(userStorage, 'u1', 'a2'))?.machineSize)
      .toEqual({ cpuKind: 'performance', cpus: 4, memoryMb: 8192 });
    expect((await agentOf(userStorage, 'u2', 'b1'))?.machineSize)
      .toEqual({ cpuKind: 'shared', cpus: 1, memoryMb: 2048 });
  });

  it('drops an agent whose record vanished mid-sweep, and keeps its siblings', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);
    await recordAgentMachineShapes(userStorage, [
      { userId: 'u1', agentId: 'gone', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
      { userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    ], AT);
    expect((await agentOf(userStorage, 'u1', 'a1'))?.machineSize)
      .toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 4096 });
    expect(await agentOf(userStorage, 'u1', 'gone')).toBeUndefined();
  });

  it('contains a failure to the owner it happened to', async () => {
    // This is bookkeeping riding a sweep whose real job is stopping idle
    // machines. It must never be the thing that breaks it.
    const userStorage = new InMemoryUserStorage();
    await userWithAgents(userStorage, 'u1', ['a1']);
    await userWithAgents(userStorage, 'u2', ['b1']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(userStorage, 'getProfile').mockImplementation(async (userId: string) => {
      if (userId === 'u1') throw new Error('profile store unreachable');
      return InMemoryUserStorage.prototype.getProfile.call(userStorage, userId);
    });

    await expect(recordAgentMachineShapes(userStorage, [
      { userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
      { userId: 'u2', agentId: 'b1', cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
    ], AT)).resolves.toBeUndefined();

    vi.restoreAllMocks();
    expect((await agentOf(userStorage, 'u2', 'b1'))?.machineSize)
      .toEqual({ cpuKind: 'shared', cpus: 1, memoryMb: 2048 });
    expect(warn).toHaveBeenCalled();
  });
});
