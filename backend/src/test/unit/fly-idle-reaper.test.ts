import { describe, expect, it, vi } from 'vitest';
import {
  FlyIdleReaper,
  InMemoryFlyIdleReaperAlertStore,
  MANAGED_JOB_TMUX_PROBE_COMMAND,
  type FlyIdleReaperAlertStore,
} from '../../services/fly-idle-reaper.js';
import { FlyApiError } from '../../services/fly-client.js';
import { CONTROL_PLANE_ROLES, controlPlaneFamily, platformAppNames } from '../../services/platform-apps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const APP = 'ia-app1';
const MACHINE = 'aa11bb22';
const HOST = 'fdaa:0:1:a7b::2';
const SANDBOX_ID = `fly-sandbox-${APP}.${MACHINE}`;

function managedJobProbeResult(
  state: 'active' | 'inactive',
  overrides: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> = {},
) {
  return {
    stdout: `agentbuilt-managed-jobs-v1:${state}\n`,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

function startedMachine(overrides: Record<string, unknown> = {}) {
  return { id: MACHINE, state: 'started', private_ip: HOST, ...overrides };
}

function startedEvent(at: number) {
  return { type: 'start', status: 'started', source: 'flyd', timestamp: at };
}

async function userWithFlyAgent(
  userStorage: InMemoryUserStorage,
  userId: string,
  telegramOverrides: Record<string, unknown> = {},
) {
  await userStorage.createProfile(userId, {
    email: `${userId}@x.io`,
    telegram: {
      agents: {
        a1: { id: 'a1', cli: 'claude', name: 'Main', createdAt: 't', serverId: `fly_${APP}.${MACHINE}`, connectedAt: 't' },
      },
      ...telegramOverrides,
    } as never,
  });
}

function makeFlyClient(overrides: Record<string, unknown> = {}) {
  return {
    listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: 'ia-machine-images' }]),
    listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine()] : [])),
    stopMachine: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeReaper(args: {
  flyClient: ReturnType<typeof makeFlyClient>;
  userStorage: InMemoryUserStorage;
  isTurnRunningForAgent?: (userId: string, agentId: string) => boolean;
  intervalMs?: number;
  getAgentLastActiveAt?: (userId: string, agentId: string) => number | undefined;
  recordRuntimeSamples?: (samples: Array<{ userId: string; agentId: string; ms: number }>) => Promise<unknown>;
  recordMachineShapes?: (
    observations: Array<{ userId: string; agentId: string; cpuKind: string; cpus: number; memoryMb: number }>,
  ) => Promise<unknown>;
  liveHosts?: Set<string>;
  recordNoManagedJobs?: (owner: { userId: string; agentId: string }) => Promise<unknown>;
  execManagedJobProbe?: (args: { sandboxId: string; command: string }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }>;
  bootGraceMs?: number;
  orphanGraceMs?: number;
  orphanConfirmSweeps?: number;
  listDeploymentAppNames?: () => Promise<string[]>;
  listAdditionalOrgContexts?: () => Promise<Array<{
    orgSlug: string;
    connectionRevision: string;
    flyClient: ReturnType<typeof makeFlyClient>;
  }>>;
  notifyUnrecordedApps?: (text: string) => Promise<unknown>;
  unrecordedAppAlertStore?: FlyIdleReaperAlertStore;
  unrecordedAppAlertAfterMs?: number;
  unrecordedAppAlertRepeatMs?: number;
  retiredAppRetentionMs?: number;
  now?: () => number;
  updateClisBeforeStop?: (args: {
    sandboxId: string;
    userId: string;
    agentId: string;
    cli: 'claude' | 'codex';
  }) => Promise<unknown>;
  rollImageWhileStopped?: (args: {
    sandboxId: string;
    userId: string;
    agentId: string;
  }) => Promise<unknown>;
  cliInstallInFlight?: (sandboxId: string) => boolean;
  scheduleHoldsAwake?: (userId: string, agentId: string) => boolean;
  recoveryReady?: Promise<unknown>;
  platformAppNames?: Iterable<string>;
}) {
  return new FlyIdleReaper({
    flyClient: args.flyClient as never,
    orgSlug: 'infinite-agents',
    userStorage: args.userStorage,
    isTurnRunningForAgent: args.isTurnRunningForAgent ?? (() => false),
    getAgentLastActiveAt: args.getAgentLastActiveAt ?? (() => undefined),
    getActiveSessionHosts: () => args.liveHosts ?? new Set(),
    execManagedJobProbe: args.execManagedJobProbe
      ?? vi.fn().mockResolvedValue(managedJobProbeResult('inactive')),
    skipAppNames: ['ia-machine-images'],
    idleMs: 15 * 60_000,
    ...(args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}),
    // Grace off by default so tests exercise the idle logic directly.
    bootGraceMs: args.bootGraceMs ?? 0,
    ...(args.orphanGraceMs !== undefined ? { orphanGraceMs: args.orphanGraceMs } : {}),
    ...(args.orphanConfirmSweeps !== undefined ? { orphanConfirmSweeps: args.orphanConfirmSweeps } : {}),
    ...(args.listDeploymentAppNames ? { listDeploymentAppNames: args.listDeploymentAppNames } : {}),
    ...(args.listAdditionalOrgContexts ? { listAdditionalOrgContexts: args.listAdditionalOrgContexts as never } : {}),
    ...(args.notifyUnrecordedApps ? { notifyUnrecordedApps: args.notifyUnrecordedApps } : {}),
    ...(args.unrecordedAppAlertStore ? { unrecordedAppAlertStore: args.unrecordedAppAlertStore } : {}),
    ...(args.unrecordedAppAlertAfterMs !== undefined
      ? { unrecordedAppAlertAfterMs: args.unrecordedAppAlertAfterMs }
      : {}),
    ...(args.unrecordedAppAlertRepeatMs !== undefined
      ? { unrecordedAppAlertRepeatMs: args.unrecordedAppAlertRepeatMs }
      : {}),
    ...(args.retiredAppRetentionMs !== undefined ? { retiredAppRetentionMs: args.retiredAppRetentionMs } : {}),
    now: args.now ?? (() => NOW),
    ...(args.recordRuntimeSamples ? { recordRuntimeSamples: args.recordRuntimeSamples } : {}),
    ...(args.recordMachineShapes ? { recordMachineShapes: args.recordMachineShapes } : {}),
    ...(args.recordNoManagedJobs ? { recordNoManagedJobs: args.recordNoManagedJobs } : {}),
    ...(args.updateClisBeforeStop ? { updateClisBeforeStop: args.updateClisBeforeStop } : {}),
    ...(args.rollImageWhileStopped ? { rollImageWhileStopped: args.rollImageWhileStopped } : {}),
    ...(args.cliInstallInFlight ? { cliInstallInFlight: args.cliInstallInFlight } : {}),
    ...(args.scheduleHoldsAwake ? { scheduleHoldsAwake: args.scheduleHoldsAwake } : {}),
    ...(args.recoveryReady ? { recoveryReady: args.recoveryReady } : {}),
    ...(args.platformAppNames ? { platformAppNames: args.platformAppNames } : {}),
  });
}

describe('FlyIdleReaper.decideStop', () => {
  const reaper = makeReaper({ flyClient: makeFlyClient(), userStorage: new InMemoryUserStorage() });
  const owner = {
    userId: 'u1', agentId: 'a1', cli: 'claude' as const,
    turnRunning: false, lastActivityAt: NOW - 60 * 60_000,
  };

  it('stops an idle machine with a known, quiet owner', () => {
    expect(reaper.decideStop({ owner, host: HOST, liveHosts: new Set(), now: NOW }).stop).toBe(true);
  });

  it('never stops a machine with no known owner', () => {
    const d = reaper.decideStop({ owner: undefined, host: HOST, liveHosts: new Set(), now: NOW });
    expect(d).toEqual({ stop: false, reason: 'no-owner' });
  });

  it('does not stop while the owner has an in-flight turn', () => {
    const d = reaper.decideStop({ owner: { ...owner, turnRunning: true }, host: HOST, liveHosts: new Set(), now: NOW });
    expect(d.reason).toBe('in-flight-turn');
  });

  it('does not stop while a live terminal session targets the host', () => {
    const d = reaper.decideStop({ owner, host: HOST, liveHosts: new Set([HOST]), now: NOW });
    expect(d.reason).toBe('live-terminal-session');
  });

  it('does not stop when the agent was recently active', () => {
    const d = reaper.decideStop({
      owner: { ...owner, lastActivityAt: NOW - 60_000 },
      host: HOST,
      liveHosts: new Set(),
      now: NOW,
    });
    expect(d.reason).toBe('recently-active');
  });

  it('stops nothing during the post-boot grace floor', () => {
    const graced = makeReaper({
      flyClient: makeFlyClient(),
      userStorage: new InMemoryUserStorage(),
      bootGraceMs: 60_000,
    });
    const d = graced.decideStop({ owner, host: HOST, liveHosts: new Set(), now: NOW });
    expect(d).toEqual({ stop: false, reason: 'boot-grace' });
  });

  describe('turn recovery gate', () => {
    // The 2026-09-03 finding: the reaper's only post-deploy protection for a
    // detached turn was a 15-minute timer, and deploys landed more often than
    // that, so the windows chained and nothing slept all working day. The
    // gate is now the recovery promise itself: until resumePendingTurns has
    // re-registered the previous process's turns, an empty registry proves
    // nothing and stopping on it would halt a VM with a live CLI on it.
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('stops nothing — owned or unowned — until recovery has settled', async () => {
      let resolveRecovery!: () => void;
      const recoveryReady = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const gated = makeReaper({
        flyClient: makeFlyClient(),
        userStorage: new InMemoryUserStorage(),
        recoveryReady,
        orphanGraceMs: 0,
        orphanConfirmSweeps: 0,
      });
      expect(gated.decideStop({ owner, host: HOST, liveHosts: new Set(), now: NOW }))
        .toEqual({ stop: false, reason: 'awaiting-recovery' });
      expect(gated.decideStop({
        owner: undefined, host: HOST, liveHosts: new Set(), now: NOW, ownersLoaded: true, createdAt: 0,
      })).toEqual({ stop: false, reason: 'awaiting-recovery' });

      resolveRecovery();
      await flush();
      expect(gated.decideStop({ owner, host: HOST, liveHosts: new Set(), now: NOW }))
        .toEqual({ stop: true, reason: 'idle' });
    });

    it('stays closed for the life of the process when recovery failed', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gated = makeReaper({
        flyClient: makeFlyClient(),
        userStorage: new InMemoryUserStorage(),
        recoveryReady: Promise.reject(new Error('resume blew up')),
      });
      await flush();
      expect(gated.decideStop({ owner, host: HOST, liveHosts: new Set(), now: NOW + 24 * 60 * 60_000 }))
        .toEqual({ stop: false, reason: 'awaiting-recovery' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('turn recovery failed'), expect.any(Error));
      error.mockRestore();
    });

    it('a sweep before recovery keeps every running machine and says why', async () => {
      const flyClient = makeFlyClient();
      const userStorage = new InMemoryUserStorage();
      await userWithFlyAgent(userStorage, 'u1');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const gated = makeReaper({ flyClient, userStorage, recoveryReady: new Promise(() => {}) });
      const result = await gated.runOnce();
      expect(flyClient.stopMachine).not.toHaveBeenCalled();
      expect(result).toMatchObject({ consideredStarted: 1, stopped: 0, kept: 1 });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('awaiting-recovery=1'));
      log.mockRestore();
    });
  });

  describe('unattributed machines', () => {
    const OLD = NOW - 48 * 60 * 60_000;
    const orphanArgs = {
      owner: undefined,
      host: HOST,
      liveHosts: new Set<string>(),
      now: NOW,
      ownersLoaded: true,
      unownedSweeps: 3,
      createdAt: OLD,
    };

    it('stops a machine that is old, unclaimed, and confirmed across sweeps', () => {
      expect(reaper.decideStop(orphanArgs)).toEqual({ stop: true, reason: 'orphan' });
    });

    it('keeps it when the owner index could not be read', () => {
      // The failure mode this guards: getAllUsers throws, every machine looks
      // unowned, and a fleet-wide stop lands on users mid-turn.
      const d = reaper.decideStop({ ...orphanArgs, ownersLoaded: false });
      expect(d).toEqual({ stop: false, reason: 'no-owner' });
    });

    it('keeps a machine young enough to still be provisioning', () => {
      // createAgentSandbox writes the machine, THEN the agent's serverId.
      const d = reaper.decideStop({ ...orphanArgs, createdAt: NOW - 30_000 });
      expect(d).toEqual({ stop: false, reason: 'no-owner' });
    });

    it('keeps a machine whose age Fly did not report', () => {
      const { createdAt: _drop, ...noAge } = orphanArgs;
      expect(reaper.decideStop(noAge)).toEqual({ stop: false, reason: 'no-owner' });
    });

    it('keeps it until enough consecutive sweeps agree', () => {
      const d = reaper.decideStop({ ...orphanArgs, unownedSweeps: 2 });
      expect(d).toEqual({ stop: false, reason: 'no-owner' });
    });
  });
});

describe('FlyIdleReaper.runOnce', () => {
  it('stops an idle Fly machine and skips the image app', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 1, kept: 0, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    // The registry app is never listed for machines.
    expect(flyClient.listMachines).not.toHaveBeenCalledWith('ia-machine-images');
  });

  it('keeps a machine whose agent an approved schedule holds awake inside its window (note #779)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const held = await makeReaper({ flyClient, userStorage, scheduleHoldsAwake: () => true }).runOnce();
    expect(held).toMatchObject({ stopped: 0, kept: 1 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
    const released = await makeReaper({ flyClient, userStorage, scheduleHoldsAwake: () => false }).runOnce();
    expect(released).toMatchObject({ stopped: 1, kept: 0 });
  });

  it('judges activity per agent: the quiet sibling stops while the busy one stays', async () => {
    // One user, two agents. Only a1 was touched recently — under the old
    // account-level signal that single message would have kept BOTH machines
    // burning for the full idle window.
    const APP2 = 'ia-app2';
    const MACHINE2 = 'cc33dd44';
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('u1', {
      email: 'u1@x.io',
      telegram: {
        agents: {
          a1: { id: 'a1', cli: 'claude', name: 'Main', createdAt: 't', serverId: `fly_${APP}.${MACHINE}`, connectedAt: 't' },
          a2: { id: 'a2', cli: 'claude', name: 'Side', createdAt: 't', serverId: `fly_${APP2}.${MACHINE2}`, connectedAt: 't' },
        },
      } as never,
    });
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: APP2 }]),
      listMachines: vi.fn(async (app: string) => {
        if (app === APP) return [startedMachine()];
        if (app === APP2) return [{ id: MACHINE2, state: 'started', private_ip: 'fdaa:0:1:a7b::3' }];
        return [];
      }),
    });
    const result = await makeReaper({
      flyClient,
      userStorage,
      getAgentLastActiveAt: (_userId, agentId) => (agentId === 'a1' ? NOW - 60_000 : undefined),
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 2, stopped: 1, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP2, MACHINE2);
  });

  it('stops idle machines even when the agent has a published live site (workbench, not hosting)', async () => {
    const userStorage = new InMemoryUserStorage();
    // u1's agent has a published live site — deliberately NOT an exemption:
    // the public URL is a preview, and idle machines sleep regardless.
    await userWithFlyAgent(userStorage, 'u1');
    const u1 = await userStorage.getProfile('u1');
    (u1!.telegram!.agents as any).a1.exposedUrl = `https://${APP}.fly.dev`;
    await userStorage.updateProfile('u1', { telegram: u1!.telegram });

    const APP2 = 'ia-app2';
    const MACHINE2 = 'cc33dd44';
    await userStorage.createProfile('u2', {
      email: 'u2@x.io',
      telegram: {
        agents: { a2: { id: 'a2', cli: 'claude', name: 'Main', createdAt: 't', serverId: `fly_${APP2}.${MACHINE2}`, connectedAt: 't' } },
      } as never,
    });

    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: APP2 }, { name: 'ia-machine-images' }]),
      listMachines: vi.fn(async (app: string) => {
        if (app === APP) return [startedMachine()];
        if (app === APP2) return [{ id: MACHINE2, state: 'started', private_ip: 'fdaa:0:1:a7b::3' }];
        return [];
      }),
    });
    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(result).toEqual({ consideredStarted: 2, stopped: 2, kept: 0, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP2, MACHINE2);
  });

  it('keeps a machine whose owner has an in-flight turn', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const result = await makeReaper({ flyClient, userStorage, isTurnRunningForAgent: () => true }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('stops an idle agent whose SIBLING is mid-turn', async () => {
    // The regression this rename exists for. The predicate used to be
    // account-wide (`hasSessionRuns`), so one working agent kept every machine
    // its owner had awake and no idle timeout could fire on a busy fleet.
    const userStorage = new InMemoryUserStorage();
    const APP2 = 'ia-app2';
    const MACHINE2 = 'cc33dd44';
    await userStorage.createProfile('u1', {
      email: 'u1@x.io',
      telegram: {
        agents: {
          a1: { id: 'a1', cli: 'claude', name: 'Busy', createdAt: 't', serverId: `fly_${APP}.${MACHINE}`, connectedAt: 't' },
          a2: { id: 'a2', cli: 'claude', name: 'Idle', createdAt: 't', serverId: `fly_${APP2}.${MACHINE2}`, connectedAt: 't' },
        },
      } as never,
    });
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: APP2 }]),
      listMachines: vi.fn(async (app: string) => (
        app === APP ? [startedMachine()] : [startedMachine({ id: MACHINE2 })]
      )),
    });

    const result = await makeReaper({
      flyClient,
      userStorage,
      isTurnRunningForAgent: (_userId, agentId) => agentId === 'a1',
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 2, stopped: 1, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP2, MACHINE2);
  });

  it('asks the turn predicate about the agent being decided, not just its owner', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const isTurnRunningForAgent = vi.fn().mockReturnValue(false);

    await makeReaper({ flyClient, userStorage, isTurnRunningForAgent }).runOnce();

    expect(isTurnRunningForAgent).toHaveBeenCalledWith('u1', 'a1');
  });

  it('keeps a machine with a live terminal session on its host', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const result = await makeReaper({ flyClient, userStorage, liveHosts: new Set([HOST]) }).runOnce();

    expect(result.stopped).toBe(0);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('does not stop a machine with a CLI install still in flight', async () => {
    // The install may have been started somewhere else entirely — the Mini
    // App's Update button — so awaiting this sweep's own update proves
    // nothing. On 2026-09-11 the halt landed one second after such an install
    // failed, and the half-written package it left could not run at all.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const result = await makeReaper({
      flyClient,
      userStorage,
      updateClisBeforeStop: vi.fn(async () => {}),
      cliInstallInFlight: (sandboxId) => sandboxId === SANDBOX_ID,
    }).runOnce();

    expect(result.stopped).toBe(0);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();

    // And the same machine with nothing installing is stopped as before — the
    // guard is the install, not a new reason to keep machines awake.
    const quiet = makeFlyClient();
    expect((await makeReaper({
      flyClient: quiet,
      userStorage,
      updateClisBeforeStop: vi.fn(async () => {}),
      cliInstallInFlight: () => false,
    }).runOnce()).stopped).toBe(1);
  });

  it('sweeps one Fly org once, however many client orgs share it', async () => {
    // Client orgs may point at the same Fly account. A second pass over the
    // same apps decides every machine twice and credits its runtime twice.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    // Same Fly account, so it lists the same apps the default sweep just did.
    const shared = makeFlyClient();
    await makeReaper({
      flyClient: makeFlyClient(),
      userStorage,
      listAdditionalOrgContexts: async () => [
        { orgSlug: 'client-fly', connectionRevision: 'client-1', flyClient: shared },
        { orgSlug: 'client-fly', connectionRevision: 'client-2', flyClient: shared },
      ],
    }).runOnce();

    expect(shared.listApps).toHaveBeenCalledTimes(1);
    expect(shared.listMachines).toHaveBeenCalledTimes(1);
  });

  it('never stops a stopped machine', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine({ state: 'stopped' })] : [])),
    });
    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(result.consideredStarted).toBe(0);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('clears the plate\'s job count only when the final probe found none (note #564)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const recordNoManagedJobs = vi.fn().mockRejectedValue(new Error('storage down'));

    // Busy machine: kept awake, and the count is not touched.
    const busy = makeFlyClient();
    await makeReaper({
      flyClient: busy, userStorage, recordNoManagedJobs,
      execManagedJobProbe: vi.fn().mockResolvedValue(managedJobProbeResult('active')),
    }).runOnce();
    expect(recordNoManagedJobs).not.toHaveBeenCalled();

    // Idle machine: cleared for its owner — and a failed write never costs the stop.
    const idle = makeFlyClient();
    const result = await makeReaper({ flyClient: idle, userStorage, recordNoManagedJobs }).runOnce();
    expect(recordNoManagedJobs).toHaveBeenCalledTimes(1);
    expect(recordNoManagedJobs).toHaveBeenCalledWith({ userId: 'u1', agentId: expect.any(String) });
    expect(result.stopped).toBe(1);
    expect(idle.stopMachine).toHaveBeenCalledTimes(1);
  });

  it('a fresh reaper instance remotely rediscovers an active managed job', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const execManagedJobProbe = vi.fn().mockResolvedValue(managedJobProbeResult('active'));
    const updateClisBeforeStop = vi.fn();

    // There is intentionally no prior sweep or process-memory registration:
    // the already-running job is discovered solely from the remote tmux probe.
    const freshReaper = makeReaper({
      flyClient, userStorage, execManagedJobProbe, updateClisBeforeStop,
    });
    const result = await freshReaper.runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
    expect(updateClisBeforeStop).not.toHaveBeenCalled();
    expect(execManagedJobProbe).toHaveBeenCalledTimes(1);
    expect(execManagedJobProbe).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID,
      command: MANAGED_JOB_TMUX_PROBE_COMMAND,
    });
    // The exact named socket and exact managed session shape are load-bearing:
    // default-server or merely similar tmux sessions must not keep a VM hot.
    expect(MANAGED_JOB_TMUX_PROBE_COMMAND).toContain('unset TMUX TMUX_PANE TMUX_TMPDIR');
    expect(MANAGED_JOB_TMUX_PROBE_COMMAND).toContain(
      "/usr/bin/tmux -f /dev/null -L agentbuilt-jobs-v1 list-sessions -F '#{session_name}'",
    );
    expect(MANAGED_JOB_TMUX_PROBE_COMMAND).toContain(
      "grep -Eq '^agentbuilt-job-v1-j_[a-f0-9]{24}$'",
    );
  });

  it('probes before the CLI updater and again immediately before stopping', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const calls: string[] = [];
    const execManagedJobProbe = vi.fn(async () => {
      calls.push('probe');
      return managedJobProbeResult('inactive');
    });
    const updateClisBeforeStop = vi.fn(async () => { calls.push('update'); });
    flyClient.stopMachine.mockImplementation(async () => { calls.push('stop'); });

    const result = await makeReaper({
      flyClient, userStorage, execManagedJobProbe, updateClisBeforeStop,
    }).runOnce();

    expect(result.stopped).toBe(1);
    expect(updateClisBeforeStop).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1', cli: 'claude',
    });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    // Both remote observations bracket the slow updater; the second has no
    // asynchronous work between it and Fly's stop call.
    expect(calls).toEqual(['probe', 'update', 'probe', 'stop']);
  });

  it('still stops when the pre-stop update rejects (never blocks sleep)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const result = await makeReaper({
      flyClient,
      userStorage,
      updateClisBeforeStop: vi.fn().mockRejectedValue(new Error('registry down')),
    }).runOnce();

    expect(result.stopped).toBe(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
  });

  it('keeps the machine when a managed job starts during the CLI update', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const execManagedJobProbe = vi.fn()
      .mockResolvedValueOnce(managedJobProbeResult('inactive'))
      .mockResolvedValueOnce(managedJobProbeResult('active'));
    const updateClisBeforeStop = vi.fn().mockResolvedValue({ outcome: 'updated' });

    const result = await makeReaper({
      flyClient, userStorage, execManagedJobProbe, updateClisBeforeStop,
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    expect(updateClisBeforeStop).toHaveBeenCalledTimes(1);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('fails closed when the remote managed-job probe throws', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const execManagedJobProbe = vi.fn().mockRejectedValue(new Error('ssh unavailable'));

    const result = await makeReaper({ flyClient, userStorage, execManagedJobProbe }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown protocol output', managedJobProbeResult('inactive', { stdout: 'maybe\n' })],
    ['non-zero exit', managedJobProbeResult('inactive', { exitCode: 70 })],
    ['timeout', managedJobProbeResult('inactive', { timedOut: true })],
    ['unexpected stderr', managedJobProbeResult('inactive', { stderr: 'tmux warning\n' })],
    ['malformed adapter result', null],
  ])('fails closed on %s from the managed-job probe', async (_case, probeResult) => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const execManagedJobProbe = vi.fn().mockResolvedValue(probeResult) as never;

    const result = await makeReaper({ flyClient, userStorage, execManagedJobProbe }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('fails closed when the second, race-closing probe errors', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const execManagedJobProbe = vi.fn()
      .mockResolvedValueOnce(managedJobProbeResult('inactive'))
      .mockRejectedValueOnce(new Error('ssh dropped'));
    const updateClisBeforeStop = vi.fn().mockResolvedValue({ outcome: 'current' });

    const result = await makeReaper({
      flyClient, userStorage, execManagedJobProbe, updateClisBeforeStop,
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('keeps the machine when a turn starts during the final managed-job probe', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    let turnRunning = false;
    const execManagedJobProbe = vi.fn()
      .mockResolvedValueOnce(managedJobProbeResult('inactive'))
      .mockImplementationOnce(async () => {
        turnRunning = true;
        return managedJobProbeResult('inactive');
      });

    const result = await makeReaper({
      flyClient,
      userStorage,
      execManagedJobProbe,
      isTurnRunningForAgent: () => turnRunning,
      updateClisBeforeStop: vi.fn().mockResolvedValue({ outcome: 'current' }),
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('keeps the machine when a terminal appears during the final managed-job probe', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const liveHosts = new Set<string>();
    const execManagedJobProbe = vi.fn()
      .mockResolvedValueOnce(managedJobProbeResult('inactive'))
      .mockImplementationOnce(async () => {
        liveHosts.add(HOST);
        return managedJobProbeResult('inactive');
      });

    const result = await makeReaper({
      flyClient,
      userStorage,
      liveHosts,
      execManagedJobProbe,
      updateClisBeforeStop: vi.fn().mockResolvedValue({ outcome: 'current' }),
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('keeps the machine when an interaction completes during the final managed-job probe', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    let lastActiveAt: number | undefined;
    const execManagedJobProbe = vi.fn()
      .mockResolvedValueOnce(managedJobProbeResult('inactive'))
      .mockImplementationOnce(async () => {
        lastActiveAt = NOW;
        return managedJobProbeResult('inactive');
      });

    const result = await makeReaper({
      flyClient,
      userStorage,
      execManagedJobProbe,
      getAgentLastActiveAt: () => lastActiveAt,
      updateClisBeforeStop: vi.fn().mockResolvedValue({ outcome: 'current' }),
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(execManagedJobProbe).toHaveBeenCalledTimes(2);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('keeps the machine when a turn starts during the update', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    // Quiet at decision time (owner index build), busy on the post-update
    // re-check — a message arrived during the ~1-minute npm install.
    const isTurnRunningForAgent = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const result = await makeReaper({
      flyClient,
      userStorage,
      isTurnRunningForAgent,
      updateClisBeforeStop: vi.fn().mockResolvedValue({ outcome: 'updated' }),
    }).runOnce();

    expect(result).toEqual({ consideredStarted: 1, stopped: 0, kept: 1, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('credits running machines with the elapsed interval, capped at the sweep interval', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const recordRuntimeSamples = vi.fn().mockResolvedValue(undefined);
    // Boot at NOW, sweep 7 minutes later: the credit is capped at the 5-minute
    // sweep interval — a delayed sweep under-counts, never invents runtime.
    let t = NOW;
    const reaper = makeReaper({ flyClient, userStorage, recordRuntimeSamples, now: () => t });
    t = NOW + 7 * 60_000;

    const result = await reaper.runOnce();

    // The machine is stopped as idle AND still metered — it ran until this pass.
    expect(result.stopped).toBe(1);
    expect(recordRuntimeSamples).toHaveBeenCalledTimes(1);
    expect(recordRuntimeSamples).toHaveBeenCalledWith([
      { userId: 'u1', agentId: 'a1', ms: 5 * 60_000 },
    ]);
  });

  it('does not shrink the metering cap when the sweep interval is shortened', async () => {
    // Sweeping more often must not book less runtime. A sweep that overruns
    // its tick is skipped by the re-entrancy guard, so the next one legitimately
    // sees more than one interval of real runtime; capping at a 60s interval
    // would silently under-report what the machine actually cost.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const recordRuntimeSamples = vi.fn().mockResolvedValue(undefined);
    let t = NOW;
    const reaper = makeReaper({
      flyClient, userStorage, recordRuntimeSamples, intervalMs: 60_000, now: () => t,
    });
    t = NOW + 3 * 60_000;

    await reaper.runOnce();

    expect(recordRuntimeSamples).toHaveBeenCalledWith([
      { userId: 'u1', agentId: 'a1', ms: 3 * 60_000 },
    ]);
  });

  it('meters nothing when no machine is running and never lets metering block the sweep', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const stoppedFly = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine({ state: 'stopped' })] : [])),
    });
    const noSamples = vi.fn().mockResolvedValue(undefined);
    let t = NOW;
    const idleReaper = makeReaper({ flyClient: stoppedFly, userStorage, recordRuntimeSamples: noSamples, now: () => t });
    t = NOW + 5 * 60_000;
    await idleReaper.runOnce();
    expect(noSamples).not.toHaveBeenCalled();

    // A rejecting meter must not break the sweep result.
    const flyClient = makeFlyClient();
    const rejecting = vi.fn().mockRejectedValue(new Error('storage down'));
    let t2 = NOW;
    const reaper = makeReaper({ flyClient, userStorage, recordRuntimeSamples: rejecting, now: () => t2 });
    t2 = NOW + 5 * 60_000;
    const result = await reaper.runOnce();
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(1);
  });

  it('hands over what each machine is MADE OF, awake or asleep, from the listing it already fetched', async () => {
    // Note #356: the fleet list names every agent's machine, and this is the
    // one walk that sees the whole fleet without paying for a second one.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine({ config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } } })]
        : [])),
    });
    const recordMachineShapes = vi.fn().mockResolvedValue(undefined);

    await makeReaper({ flyClient, userStorage, recordMachineShapes }).runOnce();

    expect(recordMachineShapes).toHaveBeenCalledTimes(1);
    expect(recordMachineShapes).toHaveBeenCalledWith([
      { userId: 'u1', agentId: 'a1', cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    ]);

    // A SLEEPING machine leaves the per-machine loop two lines in, and is
    // exactly the one whose row a reader is most likely to be looking at.
    const asleep = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine({ state: 'stopped', config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 2048 } } })]
        : [])),
    });
    const shapesWhileAsleep = vi.fn().mockResolvedValue(undefined);
    await makeReaper({ flyClient: asleep, userStorage, recordMachineShapes: shapesWhileAsleep }).runOnce();
    expect(shapesWhileAsleep).toHaveBeenCalledWith([
      { userId: 'u1', agentId: 'a1', cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
    ]);
  });

  it('says nothing about a machine with no owner or no guest, and never lets the recording break the sweep', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    // No guest in the listing: there is no shape to record, and a partial one
    // would be worse on a row than none.
    const noGuest = vi.fn().mockResolvedValue(undefined);
    await makeReaper({ flyClient: makeFlyClient(), userStorage, recordMachineShapes: noGuest }).runOnce();
    expect(noGuest).not.toHaveBeenCalled();

    // An unowned machine inside a claimed app (a provision retry's extra) has
    // no record to write to.
    const unowned = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine({ id: 'ffff9999', config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } } })]
        : [])),
    });
    const noOwner = vi.fn().mockResolvedValue(undefined);
    await makeReaper({ flyClient: unowned, userStorage, recordMachineShapes: noOwner }).runOnce();
    expect(noOwner).not.toHaveBeenCalled();

    // And a machine attributed only by the app-wide PROVISIONING marker is
    // not written down either: that marker says "some machine in this app is
    // probably this agent's", which is enough to refuse to stop it and not
    // enough to name its shape. Two machines in one app would otherwise both
    // claim the same row.
    const provisioning = new InMemoryUserStorage();
    await provisioning.createProfile('u1', {
      email: 'u1@x.io',
      telegram: {
        agents: {
          a1: { id: 'a1', cli: 'claude', name: 'Main', createdAt: 't', provisioningAppName: APP },
        },
      } as never,
    });
    const twoMachines = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [
            startedMachine({ id: 'aaaa1111', config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } } }),
            startedMachine({ id: 'bbbb2222', config: { guest: { cpu_kind: 'performance', cpus: 8, memory_mb: 16384 } } }),
          ]
        : [])),
    });
    const midProvision = vi.fn().mockResolvedValue(undefined);
    await makeReaper({
      flyClient: twoMachines, userStorage: provisioning, recordMachineShapes: midProvision,
    }).runOnce();
    expect(midProvision).not.toHaveBeenCalled();

    // And a rejecting writer must leave the sweep's real work standing.
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine({ config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } } })]
        : [])),
    });
    const rejecting = vi.fn().mockRejectedValue(new Error('storage down'));
    let t = NOW;
    const reaper = makeReaper({ flyClient, userStorage, recordMachineShapes: rejecting, now: () => t });
    t = NOW + 5 * 60_000;
    const result = await reaper.runOnce();
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(1);
  });

  it('offers an already-sleeping machine to the image updater', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine({
            state: 'stopped',
            config: {
              image: 'registry.fly.io/ia-machine-images:old',
              rootfs: { persist: 'restart' },
              env: { AUTHORIZED_KEYS: 'ssh-ed25519 AAAAold backend' },
            },
          })]
        : [])),
    });
    const rollImageWhileStopped = vi.fn().mockResolvedValue({ outcome: 'rolled' });

    const result = await makeReaper({ flyClient, userStorage, rollImageWhileStopped }).runOnce();

    // The listing's own image/rootfs/keys travel with the offer, so a
    // converged machine needs no extra Fly read to confirm (note #1074).
    expect(rollImageWhileStopped).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID,
      userId: 'u1',
      agentId: 'a1',
      listedImage: 'registry.fly.io/ia-machine-images:old',
      listedRootfsPersist: 'restart',
      listedAuthorizedKeys: 'ssh-ed25519 AAAAold backend',
    });
    // A stopped machine is neither considered for stopping nor metered.
    expect(result).toEqual({ consideredStarted: 0, stopped: 0, kept: 0, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('rolls the machine it just put to sleep, on that transition', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const calls: string[] = [];
    flyClient.stopMachine.mockImplementation(async () => { calls.push('stop'); });
    const rollImageWhileStopped = vi.fn(async () => { calls.push('roll'); });

    const result = await makeReaper({ flyClient, userStorage, rollImageWhileStopped }).runOnce();

    expect(result.stopped).toBe(1);
    // The event, not a later scan: stop then roll, in that order, same sweep.
    expect(calls).toEqual(['stop', 'roll']);
    expect(rollImageWhileStopped).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: SANDBOX_ID,
      userId: 'u1',
      agentId: 'a1',
      // The machine is still settling out of `started`, so the roll must wait
      // for the stop it was told about instead of racing it.
      waitForStopped: true,
    }));
  });

  it('does not roll a machine it decided to keep running', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const rollImageWhileStopped = vi.fn();

    const result = await makeReaper({
      flyClient, userStorage, isTurnRunningForAgent: () => true, rollImageWhileStopped,
    }).runOnce();

    expect(result.kept).toBe(1);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
    expect(rollImageWhileStopped).not.toHaveBeenCalled();
  });

  it('does not roll when the stop itself fails', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({ stopMachine: vi.fn().mockRejectedValue(new Error('fly 500')) });
    const rollImageWhileStopped = vi.fn();

    await makeReaper({ flyClient, userStorage, rollImageWhileStopped }).runOnce();

    // Still awake — writing its config would reboot it under the user.
    expect(rollImageWhileStopped).not.toHaveBeenCalled();
  });

  it('never rolls a sleeping machine whose owner has an in-flight turn', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine({ state: 'stopped' })] : [])),
    });
    // Quiet when the owner index was built, busy by the time the sweep reaches
    // this machine — the turn is waking it, and rolling now would kill it.
    const isTurnRunningForAgent = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const rollImageWhileStopped = vi.fn();

    await makeReaper({ flyClient, userStorage, isTurnRunningForAgent, rollImageWhileStopped }).runOnce();

    expect(rollImageWhileStopped).not.toHaveBeenCalled();
  });

  it('never rolls a sleeping machine whose agent was recently active', async () => {
    // The wake race: a message marks the agent active before the machine leaves
    // `stopped`, so recency — not the machine state — is what catches it.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine({ state: 'stopped' })] : [])),
    });
    const rollImageWhileStopped = vi.fn();

    await makeReaper({
      flyClient,
      userStorage,
      getAgentLastActiveAt: () => NOW - 60_000,
      rollImageWhileStopped,
    }).runOnce();

    expect(rollImageWhileStopped).not.toHaveBeenCalled();
  });

  it('never rolls a sleeping machine with no known owner, or during the boot grace', async () => {
    const flyClient = makeFlyClient({
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine({ state: 'stopped' })] : [])),
    });
    const unowned = vi.fn();
    await makeReaper({ flyClient, userStorage: new InMemoryUserStorage(), rollImageWhileStopped: unowned }).runOnce();
    expect(unowned).not.toHaveBeenCalled();

    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const graced = vi.fn();
    await makeReaper({
      flyClient, userStorage, bootGraceMs: 15 * 60_000, rollImageWhileStopped: graced,
    }).runOnce();
    expect(graced).not.toHaveBeenCalled();
  });

  it('survives a rejecting image roll', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const APP2 = 'ia-app2';
    const MACHINE2 = 'cc33dd44';
    await userStorage.createProfile('u2', {
      email: 'u2@x.io',
      telegram: {
        agents: { a2: { id: 'a2', cli: 'claude', name: 'Main', createdAt: 't', serverId: `fly_${APP2}.${MACHINE2}`, connectedAt: 't' } },
      } as never,
    });
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: APP2 }]),
      listMachines: vi.fn(async (app: string) => {
        if (app === APP) return [startedMachine({ state: 'stopped' })];
        if (app === APP2) return [{ id: MACHINE2, state: 'started', private_ip: 'fdaa:0:1:a7b::3' }];
        return [];
      }),
    });

    const result = await makeReaper({
      flyClient,
      userStorage,
      rollImageWhileStopped: vi.fn().mockRejectedValue(new Error('fly 500')),
    }).runOnce();

    // The failed roll neither aborts the sweep nor blocks the unrelated stop.
    expect(result).toEqual({ consideredStarted: 1, stopped: 1, kept: 0, orphansStopped: 0, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP2, MACHINE2);
  });

  it('keeps the machine when a terminal session appears during the update', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const liveHosts = new Set<string>();
    const result = await makeReaper({
      flyClient,
      userStorage,
      liveHosts,
      updateClisBeforeStop: vi.fn(async () => { liveHosts.add(HOST); }),
    }).runOnce();

    expect(result.stopped).toBe(0);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });
});

describe('FlyIdleReaper.runOnce — apps and machines no record claims', () => {
  // Found in production 2026-08-14: a machine created 46s before its agent
  // record, whose serverId never got saved. It ran for 16 days — the reaper
  // refused to stop what it could not attribute, and metering skipped it for
  // the same reason. Since the record-allowlist (byo-fly-design), a whole
  // unclaimed APP is an operator report and never touched — the automated
  // stop survives only for a rogue extra machine INSIDE a claimed app, where
  // the app itself is provably ours.
  const ORPHAN_APP = 'ia-orphan01';
  const ORPHAN_MACHINE = 'ee55ff66';
  const ORPHAN_HOST = 'fdaa:0:1:a7b::9';

  function orphanMachine(overrides: Record<string, unknown> = {}) {
    return {
      id: ORPHAN_MACHINE,
      state: 'started',
      private_ip: ORPHAN_HOST,
      created_at: new Date(NOW - 48 * 60 * 60_000).toISOString(),
      ...overrides,
    };
  }

  it('never walks an app no record claims — it is reported instead', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1'); // claims APP, not ORPHAN_APP
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: ORPHAN_APP }]),
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine()] : [orphanMachine()])),
    });
    const reaper = makeReaper({
      flyClient,
      userStorage,
      // The claimed machine stays busy so the sweep's only candidate is the
      // unclaimed app — which must never become one.
      getAgentLastActiveAt: () => NOW - 60_000,
    });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      const result = await reaper.runOnce();
      expect(result.unrecordedApps).toBe(1);
      expect(result.orphansStopped).toBe(0);
    }
    // Invisible to every actuator: no machine listing, no probe, no stop. The
    // 16-day orphan is an operator's report now, not an automated stop — the
    // trade that makes this loop safe to point at a client's Fly org.
    expect(flyClient.listMachines).not.toHaveBeenCalledWith(ORPHAN_APP);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('watches for machines running without their firewall pin: hourly, agents and sites, once a day each (note #664)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    let now = NOW;
    const notifyUnrecordedApps = vi.fn().mockResolvedValue(undefined);
    const unrecordedAppAlertStore = new InMemoryFlyIdleReaperAlertStore();
    const SITE = 'iapp-site00001';
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: SITE }, { name: 'iapp-pinned0001' }]),
      listMachines: vi.fn(async (app: string) => {
        // The agent machine: env, and no pin — the image skips its firewall.
        if (app === APP) return [startedMachine({ config: { env: { AUTHORIZED_KEYS: 'k' } } })];
        if (app === SITE) return [{ id: 'site-m1', state: 'started', config: { env: { AUTHORIZED_KEYS: 'k' } } }];
        if (app === 'iapp-pinned0001') {
          return [{ id: 'site-m2', state: 'started', config: { env: { AUTHORIZED_KEYS: 'k', BACKEND_PEER_IP: 'fdaa:99::2' } } }];
        }
        return [];
      }),
    });
    const makeWatchingReaper = () => makeReaper({
      flyClient,
      userStorage,
      now: () => now,
      getAgentLastActiveAt: () => now - 60_000,
      listDeploymentAppNames: async () => [SITE, 'iapp-pinned0001'],
      notifyUnrecordedApps,
      unrecordedAppAlertStore,
    });

    const reaper = makeWatchingReaper();
    await reaper.runOnce();
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(1);
    const alert = notifyUnrecordedApps.mock.calls[0][0] as string;
    expect(alert).toContain('2 MACHINES ARE RUNNING WITHOUT ITS FIREWALL');
    expect(alert).toContain(`${APP} / ${MACHINE}`);
    expect(alert).toContain(`${SITE} / site-m1`);
    expect(alert).not.toContain('site-m2');
    // Read-only: a site is listed for the audit and never stopped.
    expect(flyClient.stopMachine).not.toHaveBeenCalled();

    // Within the hour no audit runs at all, so sites are not even listed.
    const siteReads = () => flyClient.listMachines.mock.calls.filter(([app]) => app === SITE).length;
    const readsBefore = siteReads();
    now += 5 * 60_000;
    await reaper.runOnce();
    expect(siteReads()).toBe(readsBefore);

    // An hour on it audits again, but the same machines are not re-announced
    // within a day — and the stamp survives a new process (a deploy).
    now += 60 * 60_000;
    await makeWatchingReaper().runOnce();
    expect(siteReads()).toBe(readsBefore + 1);
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(1);

    now += 24 * 60 * 60_000;
    await makeWatchingReaper().runOnce();
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(2);
  });

  it('alerts after one running hour and durably limits the same app to once a day', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    let now = NOW;
    const notifyUnrecordedApps = vi.fn().mockResolvedValue(undefined);
    const unrecordedAppAlertStore = new InMemoryFlyIdleReaperAlertStore();
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: ORPHAN_APP }]),
      listMachines: vi.fn(async (app: string) => {
        if (app === APP) return [startedMachine()];
        if (app === ORPHAN_APP) {
          return [orphanMachine({ events: [startedEvent(NOW - 59 * 60_000)] })];
        }
        return [];
      }),
    });
    const makeAlertingReaper = () => makeReaper({
      flyClient,
      userStorage,
      now: () => now,
      getAgentLastActiveAt: () => now - 60_000,
      notifyUnrecordedApps,
      unrecordedAppAlertStore,
    });

    const firstProcess = makeAlertingReaper();
    await firstProcess.runOnce();
    expect(notifyUnrecordedApps).not.toHaveBeenCalled();

    // The app set did not change, but its running age crossed the threshold.
    now += 2 * 60_000;
    await firstProcess.runOnce();
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(1);
    expect(notifyUnrecordedApps).toHaveBeenCalledWith(expect.stringContaining(ORPHAN_APP));
    expect(notifyUnrecordedApps).toHaveBeenCalledWith(expect.stringContaining('oldest 1h 1m'));
    expect(notifyUnrecordedApps).toHaveBeenCalledWith(expect.stringContaining('left them untouched'));

    // A deploy creates a new reaper, but the durable store retains the stamp.
    now += 23 * 60 * 60_000;
    await makeAlertingReaper().runOnce();
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(1);

    now += 60 * 60_000;
    await makeAlertingReaper().runOnce();
    expect(notifyUnrecordedApps).toHaveBeenCalledTimes(2);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('does not notify from creation age when Fly supplies no successful start event', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const notifyUnrecordedApps = vi.fn().mockResolvedValue(undefined);
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: ORPHAN_APP }]),
      listMachines: vi.fn(async (app: string) => (app === ORPHAN_APP ? [orphanMachine()] : [startedMachine()])),
    });

    await makeReaper({
      flyClient,
      userStorage,
      getAgentLastActiveAt: () => NOW - 60_000,
      notifyUnrecordedApps,
    }).runOnce();

    expect(flyClient.listMachines).toHaveBeenCalledWith(ORPHAN_APP);
    expect(notifyUnrecordedApps).not.toHaveBeenCalled();
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('reports an iapp-shaped app no deployment record claims, and still never walks it', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: 'iapp-known0001' }, { name: 'iapp-stray0002' }]),
    });
    const result = await makeReaper({
      flyClient,
      userStorage,
      listDeploymentAppNames: async () => ['iapp-known0001'],
    }).runOnce();

    expect(result.unrecordedApps).toBe(1);
    // Deployment machines are payment-bound: recorded or not, never walked.
    // A RECORDED site is listed read-only for the hourly firewall-pin audit
    // (note #664) — once, and nothing on it is probed or stopped; a stray one
    // is not even listed.
    expect(flyClient.listMachines.mock.calls.filter(([app]) => app === 'iapp-known0001')).toHaveLength(1);
    expect(flyClient.listMachines).not.toHaveBeenCalledWith('iapp-stray0002');
    expect(flyClient.stopMachine).not.toHaveBeenCalledWith('iapp-known0001', expect.anything());
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
  });

  it('with no deployment listing, iapp apps are skipped silently rather than misreported', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: 'iapp-unknown003' }]),
    });
    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(result.unrecordedApps).toBe(0);
    expect(flyClient.listMachines).not.toHaveBeenCalledWith('iapp-unknown003');
  });

  it('stops a rogue extra machine in a claimed app, but only once several sweeps agree', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1'); // a1 claims APP via fly_APP.MACHINE
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }]),
      // A provision retry's leftovers: the recorded machine plus one no record
      // ever got — same app, so the allowlist admits it to the orphan gate.
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine(), orphanMachine()] : [])),
    });
    const reaper = makeReaper({
      flyClient,
      userStorage,
      // The recorded machine is busy; only the rogue one is stoppable.
      getAgentLastActiveAt: () => NOW - 60_000,
    });

    const first = await reaper.runOnce();
    expect(first).toEqual({ consideredStarted: 2, stopped: 0, kept: 2, orphansStopped: 0, unrecordedApps: 0 });
    await reaper.runOnce();
    expect(flyClient.stopMachine).not.toHaveBeenCalled();

    const third = await reaper.runOnce();
    expect(third).toEqual({ consideredStarted: 2, stopped: 1, kept: 1, orphansStopped: 1, unrecordedApps: 0 });
    expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, ORPHAN_MACHINE);
  });

  it('skips the whole sweep while the user store is unreadable', async () => {
    // Every app looks unclaimed when the read fails — walking on that reading
    // would report the entire fleet as unrecorded and stop nothing safely.
    const userStorage = { getAllUsers: vi.fn().mockRejectedValue(new Error('storage down')) };
    const flyClient = makeFlyClient();
    const reaper = makeReaper({ flyClient, userStorage: userStorage as never });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      const result = await reaper.runOnce();
      expect(result).toEqual({ consideredStarted: 0, stopped: 0, kept: 0, orphansStopped: 0, unrecordedApps: 0 });
    }
    expect(flyClient.listApps).not.toHaveBeenCalled();
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('walks nothing when the store holds no Fly agents at all', async () => {
    // Healthy-but-empty is NOT unreadable: the sweep runs, but with an empty
    // claim set every app is report-only and no machine is ever listed.
    const flyClient = makeFlyClient();
    const reaper = makeReaper({ flyClient, userStorage: new InMemoryUserStorage() });

    const result = await reaper.runOnce();
    expect(result).toEqual({ consideredStarted: 0, stopped: 0, kept: 0, orphansStopped: 0, unrecordedApps: 1 });
    expect(flyClient.listMachines).not.toHaveBeenCalled();
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('leaves a rogue machine young enough to still be provisioning alone', async () => {
    // createAgentSandbox writes the machine, THEN the agent's serverId.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }]),
      listMachines: vi.fn(async (app: string) => (app === APP
        ? [startedMachine(), orphanMachine({ created_at: new Date(NOW - 60_000).toISOString() })]
        : [])),
    });
    const reaper = makeReaper({ flyClient, userStorage, getAgentLastActiveAt: () => NOW - 60_000 });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      await reaper.runOnce();
    }
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('never counts a machine still being provisioned as an orphan', async () => {
    // Between minting the app and saving the machine there is no serverId to
    // match on — the record names the APP, and that has to be enough, or the
    // sweeper reclaims a machine while its owner is still being set up. The
    // provisioning marker is also what admits the app to the allowlist.
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const u1 = await userStorage.getProfile('u1');
    (u1!.telegram!.agents as any).a2 = {
      id: 'a2', cli: 'claude', name: 'Newborn', createdAt: 't', provisioningAppName: ORPHAN_APP,
    };
    await userStorage.updateProfile('u1', { telegram: u1!.telegram });

    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: ORPHAN_APP }]),
      listMachines: vi.fn(async (app: string) => (app === ORPHAN_APP ? [orphanMachine()] : [])),
    });
    const reaper = makeReaper({
      flyClient,
      userStorage,
      // Provisioning stamps activity, exactly as the service does.
      getAgentLastActiveAt: (_userId, agentId) => (agentId === 'a2' ? NOW - 60_000 : undefined),
    });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      const result = await reaper.runOnce();
      expect(result.orphansStopped).toBe(0);
      expect(result.unrecordedApps).toBe(0);
    }
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('forgets the tally the moment a record claims the machine', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1'); // a1 claims APP
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }]),
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine(), orphanMachine()] : [])),
    });
    const reaper = makeReaper({
      flyClient,
      userStorage,
      // Both machines' agents are busy: proves the late-claimed machine
      // survived on its own merits, not because the stop moved to idle.
      getAgentLastActiveAt: () => NOW - 60_000,
    });

    await reaper.runOnce();
    await reaper.runOnce();

    // Provisioning finally writes the serverId it owed us two sweeps ago.
    const u1 = await userStorage.getProfile('u1');
    (u1!.telegram!.agents as any).a2 = {
      id: 'a2', cli: 'claude', name: 'Late', createdAt: 't',
      serverId: `fly_${APP}.${ORPHAN_MACHINE}`, connectedAt: 't',
    };
    await userStorage.updateProfile('u1', { telegram: u1!.telegram });

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await reaper.runOnce();
    }
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });
});

describe('FlyIdleReaper.runOnce — connected client orgs', () => {
  const CLIENT_APP = 'ia-clientdeadbeef';
  const CLIENT_MACHINE = 'dd66ee77';

  function clientOrgWorld() {
    const clientFly = {
      listApps: vi.fn().mockResolvedValue([{ name: CLIENT_APP }, { name: 'client-own-app' }]),
      listMachines: vi.fn(async (app: string) => (app === CLIENT_APP
        ? [{ id: CLIENT_MACHINE, state: 'started', private_ip: 'fdaa:77:1:a7b::9' }]
        : [])),
      stopMachine: vi.fn().mockResolvedValue(undefined),
    };
    return clientFly;
  }

  it('never suppresses a 404 from the platform org', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient({
      listApps: vi.fn().mockRejectedValue(new FlyApiError('platform organization not found', 404)),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reaper = makeReaper({ flyClient, userStorage });

    await reaper.runOnce();
    await reaper.runOnce();

    expect(flyClient.listApps).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[FlyIdleReaper] listApps failed for infinite-agents',
      expect.objectContaining({ status: 404 }),
    );
    warn.mockRestore();
  });

  it('sweeps a client org with its own client: same allowlist, same gates, same stop', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1'); // claims APP, in the default org
    // Records are global: u2's agent claims the client-org app.
    await userStorage.createProfile('u2', {
      email: 'u2@x.io',
      telegram: {
        agents: {
          a9: { id: 'a9', cli: 'claude', name: 'C', createdAt: 't', serverId: `fly_${CLIENT_APP}.${CLIENT_MACHINE}`, connectedAt: 't' },
        },
      } as never,
    });
    const flyClient = makeFlyClient();
    const clientFly = clientOrgWorld();

    const result = await makeReaper({
      flyClient,
      userStorage,
      listAdditionalOrgContexts: async () => [{
        orgSlug: 'acme-agents', connectionRevision: 'acme-v1', flyClient: clientFly as never,
      }],
    }).runOnce();

    // Both orgs swept: each idle machine stopped through ITS org's client.
    expect(result.stopped).toBe(2);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    expect(clientFly.stopMachine).toHaveBeenCalledWith(CLIENT_APP, CLIENT_MACHINE);
    // The client's own unrelated app is reported, never walked — the whole
    // point of the record-allowlist in someone else's account.
    expect(result.unrecordedApps).toBe(1);
    expect(clientFly.listMachines).not.toHaveBeenCalledWith('client-own-app');
  });

  it('a failing client-org listing never blocks the default sweep', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();
    const clientFly = {
      listApps: vi.fn().mockRejectedValue(new Error('client org 401')),
      listMachines: vi.fn(),
      stopMachine: vi.fn(),
    };

    const reaper = makeReaper({
      flyClient,
      userStorage,
      listAdditionalOrgContexts: async () => [{
        orgSlug: 'acme-agents', connectionRevision: 'acme-v1', flyClient: clientFly as never,
      }],
    });
    const result = await reaper.runOnce();
    await reaper.runOnce();

    expect(result.stopped).toBe(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    expect(clientFly.listApps).toHaveBeenCalledTimes(2);
  });

  it('reports a missing client org once and retries only after its connection changes', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    await userStorage.createProfile('u2', {
      email: 'u2@x.io',
      telegram: {
        agents: {
          a9: {
            id: 'a9', cli: 'claude', name: 'C', createdAt: 't',
            serverId: `fly_${CLIENT_APP}.${CLIENT_MACHINE}`, connectedAt: 't',
          },
        },
      } as never,
    });
    const flyClient = makeFlyClient();
    const missingFly = {
      listApps: vi.fn().mockRejectedValue(new FlyApiError('organization not found', 404)),
      listMachines: vi.fn(),
      stopMachine: vi.fn(),
    };
    const repairedFly = clientOrgWorld();
    let connectionRevision = 'acme-v1';
    let clientFly = missingFly;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unrecordedAppAlertStore = new InMemoryFlyIdleReaperAlertStore();
    const makeClientReaper = () => makeReaper({
      flyClient, userStorage, unrecordedAppAlertStore,
      listAdditionalOrgContexts: async () => [{
        orgSlug: 'acme-agents', connectionRevision, flyClient: clientFly as never,
      }],
    });

    const reaper = makeClientReaper();
    await reaper.runOnce();
    await reaper.runOnce();
    expect(missingFly.listApps).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'Fly organization acme-agents no longer exists; skipping it until its connection record changes',
    ));

    // A backend deploy constructs a fresh reaper. The durable marker keeps
    // that from becoming another alert and another useless Fly request.
    const replacement = makeClientReaper();
    await replacement.runOnce();
    expect(missingFly.listApps).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    connectionRevision = 'acme-v2';
    clientFly = repairedFly as typeof missingFly;
    await replacement.runOnce();
    expect(repairedFly.listApps).toHaveBeenCalledTimes(1);
    expect(repairedFly.stopMachine).toHaveBeenCalledWith(CLIENT_APP, CLIENT_MACHINE);
    warn.mockRestore();
  });

  it('a throwing context provider degrades to the default org alone', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = makeFlyClient();

    const result = await makeReaper({
      flyClient,
      userStorage,
      listAdditionalOrgContexts: async () => { throw new Error('org storage down'); },
    }).runOnce();

    expect(result.stopped).toBe(1);
  });
});

describe('FlyIdleReaper retired apps (note #792)', () => {
  const RETIRED = 'ia-retired1';
  const DAY = 24 * 60 * 60_000;

  async function userWithRetiredApp(userStorage: InMemoryUserStorage, retiredAt: number) {
    await userWithFlyAgent(userStorage, 'u1');
    await userStorage.updateAgentFields('u1', 'a1', {
      retiredMachineApps: [{ appName: RETIRED, retiredAt: new Date(retiredAt).toISOString() }],
    });
  }

  function clientWith(machinesInRetired: unknown[]) {
    return makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, { name: RETIRED }, { name: 'ia-stranger' }]),
      listMachines: vi.fn(async (app: string) => {
        if (app === APP) return [startedMachine({ state: 'stopped' })];
        if (app === RETIRED) return machinesInRetired;
        return [];
      }),
      deleteApp: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('deletes an app a rebuild retired once the window has passed and it holds no machine', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithRetiredApp(userStorage, NOW - 15 * DAY);
    const flyClient = clientWith([]);

    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(flyClient.deleteApp).toHaveBeenCalledTimes(1);
    expect(flyClient.deleteApp).toHaveBeenCalledWith(RETIRED);
    // Deleted, so no longer reported; the app nothing names still is, untouched.
    expect(result.unrecordedApps).toBe(1);
  });

  it('keeps a retired app inside the recovery window', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithRetiredApp(userStorage, NOW - 13 * DAY);
    const flyClient = clientWith([]);

    const result = await makeReaper({ flyClient, userStorage }).runOnce();

    expect(flyClient.deleteApp).not.toHaveBeenCalled();
    expect(result.unrecordedApps).toBe(2);
  });

  it('keeps a retired app that holds a machine again (someone is recovering it)', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithRetiredApp(userStorage, NOW - 30 * DAY);
    const flyClient = clientWith([{ id: 'cc33', state: 'stopped' }]);

    await makeReaper({ flyClient, userStorage }).runOnce();

    expect(flyClient.deleteApp).not.toHaveBeenCalled();
  });

  it('never deletes an app no record names as retired, however old', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const flyClient = clientWith([]);

    await makeReaper({ flyClient, userStorage }).runOnce();

    expect(flyClient.deleteApp).not.toHaveBeenCalled();
  });

  it('never deletes a retired app that a record claims again', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithRetiredApp(userStorage, NOW - 30 * DAY);
    await userStorage.updateAgentFields('u1', 'a1', { serverId: `fly_${RETIRED}.dd44` });
    const flyClient = clientWith([]);

    await makeReaper({ flyClient, userStorage }).runOnce();

    expect(flyClient.deleteApp).not.toHaveBeenCalled();
  });
});

describe('FlyIdleReaper control-plane apps (note #1070)', () => {
  // The night of 7 to 8 Nov 2026: ia-git, ia-ci and ia-control — the control
  // plane the Hetzner retirement built — were reported every night as
  // "UNCLAIMED FLY APP RUNNING", because no agent or deployment record names them.
  const CONTROL_PLANE = ['ia-control', 'ia-git', 'ia-ci', 'ia-ci-builder', 'ia-ci-jobs'];
  const ORPHAN = 'ia-0123456789abcdef';
  const longRunning = (id: string) => ({
    id, state: 'started', private_ip: `fdaa:0:1:a7b::${id.length}`,
    events: [startedEvent(NOW - 25 * 60 * 60_000)],
  });

  function controlPlaneFleet(apps: string[]) {
    return makeFlyClient({
      listApps: vi.fn().mockResolvedValue([{ name: APP }, ...apps.map((name) => ({ name }))]),
      listMachines: vi.fn(async (app: string) => (app === APP ? [startedMachine()] : [longRunning(`m-${app}`)])),
      deleteApp: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('leaves the control plane out of the alert while a real orphan still alerts', async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const notifyUnrecordedApps = vi.fn().mockResolvedValue(undefined);
    const flyClient = controlPlaneFleet([...CONTROL_PLANE, ORPHAN]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await makeReaper({
        flyClient,
        userStorage,
        notifyUnrecordedApps,
        platformAppNames: platformAppNames({ ownAppName: 'ia-control', imageApp: 'ia-machine-images' }),
      }).runOnce();

      expect(result.unrecordedApps).toBe(1);
      expect(notifyUnrecordedApps).toHaveBeenCalledTimes(1);
      const text = notifyUnrecordedApps.mock.calls[0]![0] as string;
      expect(text).toContain('UNCLAIMED FLY APP RUNNING');
      expect(text).toContain(ORPHAN);
      for (const app of CONTROL_PLANE) expect(text).not.toContain(`${app} (`);
      // The journal's "claimed by no record" line names the orphan alone.
      const unclaimedLine = warn.mock.calls.map((call) => String(call[0])).find((line) => line.includes('claimed by no record'));
      expect(unclaimedLine).toContain(ORPHAN);
      for (const app of CONTROL_PLANE) expect(unclaimedLine).not.toContain(`/${app},`);
      for (const app of CONTROL_PLANE) expect(unclaimedLine?.endsWith(`/${app}`)).toBe(false);
      expect(log).toHaveBeenCalledWith(
        '[FlyIdleReaper] control-plane apps, never touched: ia-ci, ia-ci-builder, ia-ci-jobs, ia-control, ia-git',
      );
      // Never even listed: nothing about them is read, let alone changed.
      for (const app of CONTROL_PLANE) expect(flyClient.listMachines).not.toHaveBeenCalledWith(app);
      expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
      expect(flyClient.stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('never stops or deletes a control-plane app, even when a record claims or retires it', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('u1', {
      email: 'u1@x.io',
      telegram: {
        agents: {
          a1: { id: 'a1', cli: 'claude', name: 'Main', createdAt: 't', serverId: 'fly_ia-control.m-ia-control', connectedAt: 't' },
        },
      } as never,
    });
    await userStorage.updateAgentFields('u1', 'a1', {
      retiredMachineApps: [{ appName: 'ia-git', retiredAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString() }],
    });
    const flyClient = controlPlaneFleet(CONTROL_PLANE);
    flyClient.listMachines.mockImplementation(async () => []);
    const reaper = makeReaper({
      flyClient,
      userStorage,
      getAgentLastActiveAt: () => NOW - 24 * 60 * 60_000,
      retiredAppRetentionMs: 0,
      platformAppNames: platformAppNames({ ownAppName: 'ia-control' }),
    });
    for (let sweep = 0; sweep < 5; sweep += 1) await reaper.runOnce();

    expect(flyClient.stopMachine).not.toHaveBeenCalled();
    expect(flyClient.deleteApp).not.toHaveBeenCalled();
    for (const app of CONTROL_PLANE) expect(flyClient.listMachines).not.toHaveBeenCalledWith(app);
  });

  it("a client org's app of the same name is the client's, and is reported as before", async () => {
    const userStorage = new InMemoryUserStorage();
    await userWithFlyAgent(userStorage, 'u1');
    const notifyUnrecordedApps = vi.fn().mockResolvedValue(undefined);
    const clientFly = controlPlaneFleet(['ia-git']);
    clientFly.listApps.mockResolvedValue([{ name: 'ia-git' }]);
    const result = await makeReaper({
      flyClient: controlPlaneFleet([]),
      userStorage,
      notifyUnrecordedApps,
      platformAppNames: platformAppNames({ ownAppName: 'ia-control' }),
      listAdditionalOrgContexts: async () => [{ orgSlug: 'client-org', connectionRevision: 'r1', flyClient: clientFly }],
    }).runOnce();

    expect(result.unrecordedApps).toBe(1);
    expect(notifyUnrecordedApps).toHaveBeenCalledWith(expect.stringContaining('ia-git (client-org)'));
    expect(clientFly.stopMachine).not.toHaveBeenCalled();
  });
});

describe('platformAppNames (note #1070)', () => {
  it('learns production\'s control plane from the backend\'s own app name', () => {
    const names = platformAppNames({ ownAppName: 'ia-control', imageApp: 'ia-machine-images' });
    for (const app of ['ia-control', 'ia-git', 'ia-ci', 'ia-ci-builder', 'ia-ci-jobs', 'ia-machine-images']) {
      expect(names.has(app)).toBe(true);
    }
  });

  it('holds unchanged for a private copy, from <prefix>-backend', () => {
    expect(controlPlaneFamily('acme-backend')).toBe('acme');
    const names = platformAppNames({ ownAppName: 'acme-backend' });
    for (const role of ['backend', 'git', 'router', 'mx', 'media', 'backups', 'images', 'upgrader']) {
      expect(names.has(`acme-${role}`)).toBe(true);
    }
  });

  it('can never name an agent app: every role carries a letter that is not hex', () => {
    for (const role of CONTROL_PLANE_ROLES) expect(role).toMatch(/[g-z]/);
    const names = platformAppNames({ ownAppName: 'ia-control' });
    expect([...names].some((name) => /^ia-[0-9a-f]{16}$/.test(name))).toBe(false);
  });

  it('off Fly it names only what it is told, and FLY_PLATFORM_APPS adds the rest', () => {
    expect(controlPlaneFamily(undefined)).toBeUndefined();
    expect(controlPlaneFamily('ia-1838e1651f5bb726')).toBeUndefined();
    expect(controlPlaneFamily('-backend')).toBeUndefined();
    expect([...platformAppNames({ imageApp: 'ia-machine-images', extra: [' acc-updates ', ''] })].sort())
      .toEqual(['acc-updates', 'ia-machine-images']);
  });
});
