import { describe, expect, it, vi } from 'vitest';
import { MachineImageUpdater } from '../../services/machine-image-updater.js';
import { machineImageTag } from '../../services/machine-image-tag.js';

const APP = 'ia-app1';
const MACHINE = 'aa11bb22';
const SANDBOX_ID = `fly-sandbox-${APP}.${MACHINE}`;
const TARGET = 'registry.fly.io/ia-machine-images:cli-2.1.223-fb2';
const OLD = 'registry.fly.io/ia-machine-images:cli-2.1.220-fb1';

/** A machine as Fly reports it, with the bits the roll must preserve. */
function machine(overrides: Record<string, unknown> = {}) {
  const { config, ...rest } = overrides as { config?: Record<string, unknown> };
  return {
    id: MACHINE,
    state: 'stopped',
    config: {
      image: OLD,
      rootfs: { persist: 'restart' },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
      mounts: [{ volume: 'vol_123', path: '/data' }],
      env: { AGENT_ID: 'a1' },
      ...config,
    },
    ...rest,
  };
}

function makeUpdater(args: {
  /** Machines returned by successive getMachine calls (last one repeats). */
  reads?: Array<Record<string, unknown>>;
  targetImage?: string | undefined;
  updateMachine?: ReturnType<typeof vi.fn>;
  /** The backend's address in the machine's network, when a resolver is wired. */
  peer?: string;
} = {}) {
  const reads = args.reads ?? [machine(), machine({ config: { image: TARGET } })];
  let call = 0;
  const getMachine = vi.fn(async () => reads[Math.min(call++, reads.length - 1)] as never);
  const updateMachine = args.updateMachine ?? vi.fn().mockResolvedValue({ id: MACHINE });
  const stopMachine = vi.fn().mockResolvedValue(undefined);
  const persistObservedImage = vi.fn().mockResolvedValue(undefined);
  const updater = new MachineImageUpdater({
    flyClient: { getMachine, updateMachine, stopMachine } as never,
    getTargetImage: () => ('targetImage' in args ? args.targetImage : TARGET),
    persistObservedImage,
    ...('peer' in args ? { resolveBackendPeerForApp: async () => args.peer } : {}),
    // No real waiting in tests.
    settleDelayMs: 0,
    settleTimeoutMs: 10,
  });
  return { updater, getMachine, updateMachine, stopMachine, persistObservedImage };
}

describe('MachineImageUpdater.rollWhileStopped', () => {
  it('rolls a sleeping machine onto the fleet image, preserving the rest of its config', async () => {
    const { updater, updateMachine } = makeUpdater();

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result).toEqual({ outcome: 'rolled', fromImage: OLD, toImage: TARGET });
    expect(updateMachine).toHaveBeenCalledWith(APP, MACHINE, {
      image: TARGET,
      rootfs: { persist: 'restart' },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
      mounts: [{ volume: 'vol_123', path: '/data' }],
      // The roll is also what carries CPU_KIND to machines built before note
      // #393 — derived from the guest THIS read returned, so it converges the
      // fleet without inventing a second, staler copy of the shape. Whatever
      // env the machine already had rides across untouched.
      env: { AGENT_ID: 'a1', CPU_KIND: 'shared' },
    }, { skipLaunch: true });
  });

  it('leaves the env alone when Fly reports a machine with no cpu kind', async () => {
    // A guest without cpu_kind is not a machine we can name a rung for, and a
    // guess written into its CLAUDE.md would be worse than the missing line.
    const reads = [
      machine({ config: { image: OLD, guest: { cpus: 2, memory_mb: 4096 }, env: { AGENT_ID: 'a1' } } }),
      machine({ config: { image: TARGET } }),
    ];
    const { updater, updateMachine } = makeUpdater({ reads });

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(updateMachine.mock.calls[0][2].env).toEqual({ AGENT_ID: 'a1' });
  });

  it('gives a machine built with no SSH pin its network\'s, and never rewrites one it has (note #664)', async () => {
    // Every platform-account machine built between 2026-08-23 and note #664
    // booted with no BACKEND_PEER_IP, which skips the image's whole firewall.
    const pinless = makeUpdater({ peer: 'fdaa:99:600e:a7b::4e02' });
    await pinless.updater.rollWhileStopped({ sandboxId: SANDBOX_ID });
    expect(pinless.updateMachine.mock.calls[0][2].env).toEqual({
      AGENT_ID: 'a1', CPU_KIND: 'shared', BACKEND_PEER_IP: 'fdaa:99:600e:a7b::4e02',
    });

    const pinned = makeUpdater({
      peer: 'fdaa:99:600e:a7b::4e02',
      reads: [
        machine({ config: { image: OLD, env: { AGENT_ID: 'a1', BACKEND_PEER_IP: 'fdaa:77:1:a7b::2' } } }),
        machine({ config: { image: TARGET } }),
      ],
    });
    await pinned.updater.rollWhileStopped({ sandboxId: SANDBOX_ID });
    expect(pinned.updateMachine.mock.calls[0][2].env.BACKEND_PEER_IP).toBe('fdaa:77:1:a7b::2');

    // No peer known for the network: nothing is invented.
    const unknown = makeUpdater({ peer: undefined });
    await unknown.updater.rollWhileStopped({ sandboxId: SANDBOX_ID });
    expect(unknown.updateMachine.mock.calls[0][2].env).not.toHaveProperty('BACKEND_PEER_IP');
  });

  it('never writes a config built from a read that carried no image (2026-09-21)', async () => {
    // Fly answered with a machine whose config was missing; spreading it into
    // the write stripped env, mounts and guest from a live agent machine.
    const incomplete = [
      { id: MACHINE, state: 'stopped' },
      { id: MACHINE, state: 'stopped', config: {} },
      { id: MACHINE, state: 'stopped', config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 }, restart: { policy: 'on-failure' } } },
    ];
    for (const read of incomplete) {
      const { updater, updateMachine, persistObservedImage } = makeUpdater({ reads: [read] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

      expect(result).toEqual({ outcome: 'failed' });
      expect(updateMachine).not.toHaveBeenCalled();
      expect(persistObservedImage).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  });

  it('does not count an incomplete read against the machine: the next good read still rolls', async () => {
    const reads = [{ id: MACHINE, state: 'stopped' }, machine(), machine({ config: { image: TARGET } })];
    const { updater, updateMachine } = makeUpdater({ reads });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).toEqual({ outcome: 'failed' });
    expect(await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).toEqual({ outcome: 'rolled', fromImage: OLD, toImage: TARGET });
    expect(updateMachine).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never writes without skipLaunch — the default boots the machine', async () => {
    // The failure this guards is fleet-wide and silent: without the flag every
    // sleeping machine boots to receive an image it will not use until its next
    // real wake, and nothing looks broken.
    const { updater, updateMachine } = makeUpdater();

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(updateMachine.mock.calls[0][3]).toEqual({ skipLaunch: true });
  });

  it('puts the machine back to sleep if Fly starts it anyway', async () => {
    const { updater, stopMachine } = makeUpdater({
      reads: [machine(), machine({ state: 'started', config: { image: TARGET } })],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('rolled');
    expect(stopMachine).toHaveBeenCalledWith(APP, MACHINE);
  });

  it('does not mistake Fly\'s reply for a machine that woke', async () => {
    // What Fly REALLY answers a skip_launch write with: the instance it has
    // just made, reporting `created` — "made, not yet started". Every roll in
    // the live journal (42 of them) took this for a wake and called stop into
    // a machine that was mid-replacement; four of those came back 409
    // "current state invalid, replacing". The machine never ran.
    const { updater, stopMachine } = makeUpdater({
      updateMachine: vi.fn().mockResolvedValue(machine({ state: 'created', config: { image: TARGET } })),
      reads: [machine(), machine({ state: 'stopped', config: { image: TARGET } })],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('rolled');
    expect(stopMachine).not.toHaveBeenCalled();
  });

  it('waits through the replacement before deciding anything about it', async () => {
    // Measured on a scratch machine: created → replacing → stopped, about two
    // seconds. A verdict taken during that is a verdict about nothing.
    const { updater, stopMachine, getMachine } = makeUpdater({
      updateMachine: vi.fn().mockResolvedValue(machine({ state: 'created', config: { image: TARGET } })),
      reads: [
        machine(),
        machine({ state: 'replacing', config: { image: TARGET } }),
        machine({ state: 'replacing', config: { image: TARGET } }),
        machine({ state: 'stopped', config: { image: TARGET } }),
      ],
    });

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(stopMachine).not.toHaveBeenCalled();
    // It kept reading rather than answering from the first look.
    expect(getMachine.mock.calls.length).toBeGreaterThan(2);
  });

  it('still catches the failure it exists for: a machine Fly really did start', async () => {
    const { updater, stopMachine } = makeUpdater({
      updateMachine: vi.fn().mockResolvedValue(machine({ state: 'created', config: { image: TARGET } })),
      reads: [
        machine(),
        machine({ state: 'replacing', config: { image: TARGET } }),
        machine({ state: 'started', config: { image: TARGET } }),
      ],
    });

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(stopMachine).toHaveBeenCalledWith(APP, MACHINE);
  });

  it('reports the roll even when the re-stop is refused', async () => {
    // The 409 path: the write landed, which is what the outcome is about.
    const { updater, stopMachine } = makeUpdater({
      updateMachine: vi.fn().mockResolvedValue(machine({ state: 'created', config: { image: TARGET } })),
      reads: [machine(), machine({ state: 'started', config: { image: TARGET } })],
    });
    stopMachine.mockRejectedValue(new Error('Fly API error (409): unable to stop machine, current state invalid'));

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('rolled');
    expect(stopMachine).toHaveBeenCalled();
  });

  it('leaves a machine alone when the write kept it asleep', async () => {
    const { updater, stopMachine } = makeUpdater();

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(stopMachine).not.toHaveBeenCalled();
  });

  it('never writes to a machine that is not stopped — an image write restarts it', async () => {
    for (const state of ['started', 'starting', 'stopping', 'replacing']) {
      const { updater, updateMachine } = makeUpdater({ reads: [machine({ state })] });

      const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

      expect(result.outcome).toBe('not-stopped');
      expect(updateMachine).not.toHaveBeenCalled();
    }
  });

  it('leaves a machine already on the target image alone', async () => {
    const { updater, updateMachine, getMachine } = makeUpdater({
      reads: [machine({ config: { image: TARGET } })],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result).toEqual({ outcome: 'current', fromImage: TARGET, toImage: TARGET });
    expect(updateMachine).not.toHaveBeenCalled();
    // One read, no verify pass — the common case costs a single API call.
    expect(getMachine).toHaveBeenCalledTimes(1);
  });

  it('costs no API call at all when the caller already listed the machine as converged', async () => {
    // The steady state: nearly every machine matches, every sweep. Re-reading
    // each one to confirm would be thousands of Fly calls an hour to learn
    // nothing.
    const { updater, getMachine, updateMachine } = makeUpdater();

    const result = await updater.rollWhileStopped({
      sandboxId: SANDBOX_ID, listedImage: TARGET, listedRootfsPersist: 'restart',
    });

    expect(result).toEqual({ outcome: 'current', fromImage: TARGET, toImage: TARGET });
    expect(getMachine).not.toHaveBeenCalled();
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('still reads authoritatively when the listing says the machine has drifted', async () => {
    // The listing is only ever trusted to skip work, never to do it: a stale
    // "drifted" costs one read and resolves as `current`, unwritten.
    const { updater, getMachine, updateMachine } = makeUpdater({
      reads: [machine({ config: { image: TARGET } })],
    });

    const result = await updater.rollWhileStopped({
      sandboxId: SANDBOX_ID, listedImage: OLD, listedRootfsPersist: 'restart',
    });

    expect(result.outcome).toBe('current');
    expect(getMachine).toHaveBeenCalledTimes(1);
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('does not skip on the image alone when rootfs.persist is still missing', async () => {
    const { updater, updateMachine } = makeUpdater({
      reads: [
        machine({ config: { image: TARGET, rootfs: undefined } }),
        machine({ config: { image: TARGET } }),
      ],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, listedImage: TARGET });

    expect(result.outcome).toBe('rolled');
    expect(updateMachine).toHaveBeenCalledTimes(1);
  });

  it('converges a machine on the target image but missing rootfs.persist', async () => {
    // Predates DEFAULT_FLY_ROOTFS: Fly wipes its rootfs on every start, so the
    // agent loses its apt installs at each sleep. Same write, same free moment.
    const { updater, updateMachine } = makeUpdater({
      reads: [
        machine({ config: { image: TARGET, rootfs: undefined } }),
        machine({ config: { image: TARGET } }),
      ],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('rolled');
    expect(updateMachine.mock.calls[0][2]).toMatchObject({ rootfs: { persist: 'restart' } });
  });

  it('does nothing when no fleet image is configured', async () => {
    const { updater, getMachine, updateMachine } = makeUpdater({ targetImage: undefined });

    expect(await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).toEqual({ outcome: 'no-target' });
    expect(getMachine).not.toHaveBeenCalled();
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('ignores a sandbox id that is not a Fly machine', async () => {
    const { updater, getMachine } = makeUpdater();

    expect(await updater.rollWhileStopped({ sandboxId: 'hcloud-sandbox-42' }))
      .toEqual({ outcome: 'unaddressable' });
    expect(getMachine).not.toHaveBeenCalled();
  });

  it('never throws when the Fly API fails', async () => {
    const { updater } = makeUpdater({
      updateMachine: vi.fn().mockRejectedValue(new Error('fly 500')),
    });

    await expect(updater.rollWhileStopped({ sandboxId: SANDBOX_ID }))
      .resolves.toEqual({ outcome: 'failed' });
  });

  it('waits out `stopping` rather than racing the stop it was told about', async () => {
    // Fly reports `stopping` for a moment after a stop is accepted, and the
    // roll refuses anything that is not `stopped` — so without the wait the
    // caller loses a race against its own stop, every time.
    const { updater, updateMachine } = makeUpdater({
      reads: [
        // Two polls still settling, then asleep — and only then the read the
        // roll itself makes, followed by the post-write verify.
        machine({ state: 'stopping' }),
        machine({ state: 'stopping' }),
        machine(),
        machine(),
        machine({ config: { image: TARGET } }),
      ],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, waitForStopped: true });

    expect(result.outcome).toBe('rolled');
    expect(updateMachine).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the machine comes back up instead of writing to it', async () => {
    const { updater, updateMachine } = makeUpdater({
      reads: [machine({ state: 'stopping' }), machine({ state: 'started' })],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, waitForStopped: true });

    expect(result.outcome).toBe('not-stopped');
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('sleeps a running machine first only when explicitly asked (the menu button)', async () => {
    const { updater, stopMachine, updateMachine } = makeUpdater({
      reads: [
        machine({ state: 'started' }),
        machine({ state: 'stopped' }),
        machine({ config: { image: TARGET } }),
      ],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, stopFirst: true });

    expect(result.outcome).toBe('rolled');
    expect(stopMachine).toHaveBeenCalledWith(APP, MACHINE);
    expect(updateMachine).toHaveBeenCalledTimes(1);
  });

  it('never sleeps a running machine on the automatic path', async () => {
    const { updater, stopMachine, updateMachine } = makeUpdater({ reads: [machine({ state: 'started' })] });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('not-stopped');
    expect(stopMachine).not.toHaveBeenCalled();
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('stamps the image it CONFIRMED, not the one it intended', async () => {
    const { updater, persistObservedImage } = makeUpdater();

    await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1' });

    expect(persistObservedImage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', agentId: 'a1', image: TARGET,
    }));
  });

  it('stamps a machine that was already current, so the menu can say so', async () => {
    const { updater, persistObservedImage } = makeUpdater();

    await updater.rollWhileStopped({
      sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1',
      listedImage: TARGET, listedRootfsPersist: 'restart',
    });

    expect(persistObservedImage).toHaveBeenCalledWith(expect.objectContaining({ image: TARGET }));
  });

  it('reads status live, for a machine that has never slept and without waking it', async () => {
    // The bug this closes: status used to come only from the record, which is
    // stamped at sleep — so a brand-new machine showed "checked next time it
    // sleeps" and no update button, while being awake and answering messages.
    // A machine's image is a control-plane fact; getMachine answers it for a
    // stopped machine too, so there was never anything to wait for.
    const { updater, getMachine, stopMachine, persistObservedImage } = makeUpdater({
      reads: [machine({ state: 'started' })],
    });

    const status = await updater.readStatus({ sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1' });

    expect(status).toEqual({ target: TARGET, observed: OLD, current: false });
    expect(getMachine).toHaveBeenCalledTimes(1);
    // Reading status must never move the machine.
    expect(stopMachine).not.toHaveBeenCalled();
    expect(persistObservedImage).toHaveBeenCalledWith(expect.objectContaining({ image: OLD }));
  });

  it('reports current only when a roll would genuinely do nothing', async () => {
    const settled = makeUpdater({ reads: [machine({ config: { image: TARGET } })] });
    expect((await settled.updater.readStatus({ sandboxId: SANDBOX_ID }))?.current).toBe(true);

    // Right image, but Fly still wipes its rootfs on every start — a roll has
    // work to do, so the menu must not claim it is up to date.
    const drifted = makeUpdater({ reads: [machine({ config: { image: TARGET, rootfs: undefined } })] });
    expect((await drifted.updater.readStatus({ sandboxId: SANDBOX_ID }))?.current).toBe(false);
  });

  it('reports nothing rather than guessing when Fly cannot be reached', async () => {
    const { updater } = makeUpdater({ reads: [] });
    const failing = new MachineImageUpdater({
      flyClient: { getMachine: vi.fn().mockRejectedValue(new Error('fly 500')) } as never,
      getTargetImage: () => TARGET,
    });
    expect(await failing.readStatus({ sandboxId: SANDBOX_ID })).toBeUndefined();
    expect(await updater.readStatus({ sandboxId: 'hcloud-sandbox-42' })).toBeUndefined();
  });

  it('treats the update response as proof OF THE IMAGE, and never of the state', async () => {
    // Fly telling us what it just applied is better evidence of the IMAGE than
    // a follow-up read, which can still be serving the previous config — so
    // the image is never polled for when the reply already carries it.
    //
    // Its STATE is a different question with a different answer: the reply
    // describes an instance Fly has only just made. So exactly one read
    // settles the image (the pre-write check), and the reads after it are the
    // machine being watched through its replacement.
    const { updater, getMachine } = makeUpdater({
      reads: [machine(), machine({ state: 'stopped', config: { image: TARGET } })],
      updateMachine: vi.fn().mockResolvedValue({ id: MACHINE, state: 'created', config: { image: TARGET } }),
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result.outcome).toBe('rolled');
    // One before the write, one after it settled — and no polling loop for an
    // image the reply had already proved.
    expect(getMachine).toHaveBeenCalledTimes(2);
  });

  it('waits out a stale read rather than calling a successful roll a failure', async () => {
    // Exactly what happened in production: Fly kept serving the PRE-update
    // config for a few seconds, so a single immediate read reported the old
    // image on nine machines that had in fact just rolled correctly.
    const { updater } = makeUpdater({
      reads: [
        machine(),                              // pre-write check
        machine(),                              // stale: still the old image
        machine({ config: { image: TARGET } }), // caught up
      ],
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID });

    expect(result).toEqual({ outcome: 'rolled', fromImage: OLD, toImage: TARGET });
  });

  it('gives up only after repeated failures, never on one bad read', async () => {
    // The un-counted latch was itself an outage: one stale read disabled the
    // retry for a machine that was fine. But a ref we truly cannot match must
    // still not be rewritten on every sweep forever.
    const { updater, updateMachine } = makeUpdater({ reads: [machine()] });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).outcome).toBe('failed');
    }

    expect(updateMachine).toHaveBeenCalledTimes(3);
  });

  it('forgets earlier failures once a roll succeeds', async () => {
    const { updater, updateMachine } = makeUpdater({
      reads: [machine(), machine(), machine(), machine()],
    });
    expect((await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).outcome).toBe('failed');

    // Next sweep, and this time it takes: the earlier failure must not count
    // against a machine that is now converging.
    const ok = makeUpdater({ reads: [machine(), machine({ config: { image: TARGET } })] });
    expect((await ok.updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).outcome).toBe('rolled');
    expect(updateMachine).toHaveBeenCalledTimes(1);
  });
});

describe('per-app client resolution (byo-fly)', () => {
  it('rolls a client-org machine through THAT org\'s client, not the default', async () => {
    const reads = [machine(), machine({ config: { image: TARGET } })];
    let call = 0;
    const orgGetMachine = vi.fn(async () => reads[Math.min(call++, reads.length - 1)] as never);
    const orgUpdateMachine = vi.fn().mockResolvedValue({ id: MACHINE });
    const defaultClient = {
      getMachine: vi.fn(),
      updateMachine: vi.fn(),
      stopMachine: vi.fn(),
    };
    const updater = new MachineImageUpdater({
      flyClient: defaultClient as never,
      resolveFlyClientForApp: async (appName) => (appName === APP
        ? { getMachine: orgGetMachine, updateMachine: orgUpdateMachine, stopMachine: vi.fn() } as never
        : null),
      getTargetImage: () => TARGET,
      settleDelayMs: 0,
      settleTimeoutMs: 10,
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1' });

    expect(result.outcome).toBe('rolled');
    expect(orgUpdateMachine).toHaveBeenCalled();
    expect(defaultClient.getMachine).not.toHaveBeenCalled();
    expect(defaultClient.updateMachine).not.toHaveBeenCalled();
  });

  it('a throwing resolver fails closed without touching the default client', async () => {
    const getMachine = vi.fn();
    const updateMachine = vi.fn().mockResolvedValue({ id: MACHINE });
    const updater = new MachineImageUpdater({
      flyClient: { getMachine, updateMachine, stopMachine: vi.fn() } as never,
      resolveFlyClientForApp: async () => { throw new Error('storage down'); },
      getTargetImage: () => TARGET,
      settleDelayMs: 0,
      settleTimeoutMs: 10,
    });

    const result = await updater.rollWhileStopped({ sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1' });
    expect(result.outcome).toBe('failed');
    expect(getMachine).not.toHaveBeenCalled();
    expect(updateMachine).not.toHaveBeenCalled();
  });
});

describe('the roll after a pin bump at an unchanged commit (note #1052)', () => {
  // The case trap 2 was: same commit, new pins. The tag carries both now, so
  // the roller's plain string comparison is the right one and needs no digest.
  const BEFORE = `ghcr.io/acme/ia-machine-images:${machineImageTag('0477944f1b34', {
    claude: '2.1.316', codex: '0.166.0', opencode: '1.19.5',
  })}`;
  const AFTER = `ghcr.io/acme/ia-machine-images:${machineImageTag('0477944f1b34', {
    claude: '2.1.316', codex: '0.167.0', opencode: '1.19.5',
  })}`;

  it('offers the rebuilt image to a machine on the old contents', async () => {
    const { updater, updateMachine } = makeUpdater({
      targetImage: AFTER,
      reads: [machine({ config: { image: BEFORE } }), machine({ config: { image: AFTER } })],
    });
    const result = await updater.rollWhileStopped({
      sandboxId: SANDBOX_ID, listedImage: BEFORE, listedRootfsPersist: 'restart',
    });
    expect(result).toEqual({ outcome: 'rolled', fromImage: BEFORE, toImage: AFTER });
    expect(updateMachine.mock.calls[0][2].image).toBe(AFTER);
  });

  it('moves a machine still on a tag that named only the commit', async () => {
    const legacy = 'ghcr.io/acme/ia-machine-images:sha-0477944f1b34';
    const { updater } = makeUpdater({
      targetImage: AFTER,
      reads: [machine({ config: { image: legacy } }), machine({ config: { image: AFTER } })],
    });
    expect((await updater.rollWhileStopped({ sandboxId: SANDBOX_ID })).outcome).toBe('rolled');
  });

  it('calls a machine on the same commit and the same pins current, with no write', async () => {
    const { updater, updateMachine, getMachine } = makeUpdater({ targetImage: AFTER });
    const result = await updater.rollWhileStopped({
      sandboxId: SANDBOX_ID, listedImage: AFTER, listedRootfsPersist: 'restart',
    });
    expect(result.outcome).toBe('current');
    expect(getMachine).not.toHaveBeenCalled();
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('reads status as not current until the machine is on the new tag', async () => {
    const { updater } = makeUpdater({ targetImage: AFTER, reads: [machine({ config: { image: BEFORE } })] });
    expect(await updater.readStatus({ sandboxId: SANDBOX_ID })).toEqual({
      target: AFTER, observed: BEFORE, current: false,
    });
  });
});
