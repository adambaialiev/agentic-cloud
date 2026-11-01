import type { FlyClient, FlyMachine, FlyMachineConfig } from './fly-client.js';
import { parseFlySandboxId } from './fly-sandbox-id.js';
import { machineCpuKindEnv } from '../config/agent-machine-sizes.js';

export interface MachineImageUpdaterDeps {
  flyClient: Pick<FlyClient, 'getMachine' | 'updateMachine' | 'stopMachine'>;
  /**
   * Per-app client override (byo-fly-design): a client-org machine's config
   * writes must ride that org's token. When supplied, null or an error fails
   * closed; the default client is only for callers that install no resolver.
   */
  resolveFlyClientForApp?: (
    appName: string,
  ) => Promise<Pick<FlyClient, 'getMachine' | 'updateMachine' | 'stopMachine'> | null>;
  /**
   * The backend's address in this app's network — what a NEW machine there
   * is given as `BACKEND_PEER_IP` (fly-app-org-context.ts). A machine whose
   * env lacks one is given it on its next roll; see the roll's env below.
   */
  resolveBackendPeerForApp?: (appName: string) => Promise<string | undefined>;
  /** Poll interval while waiting for a machine to finish stopping (tests: 0). */
  settleDelayMs?: number;
  /** How long to wait for that before giving up and leaving it to the backstop. */
  settleTimeoutMs?: number;
  /**
   * Stamp the image the machine actually ended up on, so a user can be told
   * where their machine stands without waking it to ask. Mirrors the CLI
   * updater's `persistObservedVersion` — display only, never a source of truth
   * for what to install.
   */
  persistObservedImage?: (args: {
    userId: string;
    agentId: string;
    image: string;
    checkedAt: string;
  }) => Promise<void>;
  now?: () => number;
  /**
   * The fleet's current machine image (`FLY_MACHINE_IMAGE`). A function, not a
   * value, so an operator repointing the fleet takes effect for whatever holds
   * this — the same env the sandbox client stamps onto NEW machines, which is
   * what makes "current" mean one thing across the fleet.
   */
  getTargetImage: () => string | undefined;
}

export interface MachineImageUpdateResult {
  outcome:
    | 'no-target'
    | 'unaddressable'
    | 'not-stopped'
    | 'current'
    | 'rolled'
    | 'failed';
  fromImage?: string;
  toImage?: string;
}

export interface MachineImageStatus {
  /** The fleet's current image. */
  target: string;
  /** What this machine is on, when known. */
  observed?: string;
  /** True only when a roll would do nothing — image AND rootfs both settled. */
  current: boolean;
}

/** Fly's default when a machine predates `rootfs.persist` — wipes on every start. */
const ROOTFS_PERSIST_TARGET = 'restart';
/** Failed rolls of one machine before this process stops retrying it. */
const MAX_ROLL_ATTEMPTS = 3;
/** Re-reads allowed for the write to become visible before calling it failed. */
const CONFIRM_READS = 3;

/**
 * A machine that is RUNNING, or on its way to it — the only thing the guard
 * after an image write is looking for.
 */
const RUNNING_STATES = new Set(['started', 'starting']);

/**
 * Mid-change, and NOT running: `created` is "made, not yet started" and
 * `replacing` is "a config change in progress" (fly.io/docs/machines/machine-states).
 * A skip_launch write passes through both on its way back to `stopped`.
 */
const SETTLING_STATES = new Set(['created', 'replacing']);

/** How many reads to give the replacement before giving up on a verdict. */
const SETTLE_READS = 5;

/**
 * Moves a SLEEPING agent machine onto the fleet's current image.
 *
 * Without this a machine keeps its creation-time image for life: an image fix
 * reaches new signups and nobody else. The fleet drifts a little further apart
 * with every release, and the machines most in need of the fix — the oldest —
 * are exactly the ones that never get it.
 *
 * **Why only while stopped.** Writing a machine config restarts a RUNNING
 * machine: tmux dies, servers die, a turn in flight dies mid-answer. A stopped
 * machine just boots the new rootfs on its next wake, which it was going to do
 * anyway — so the user-visible cost of rolling a sleeping machine is zero. The
 * rootfs is ephemeral by design and `/data` (the agent's home) survives the
 * swap; that is the same contract every wake already honours.
 *
 * **And only with `skipLaunch`.** Fly's default is to leave a machine RUNNING
 * after a config update, whatever state it was in before — so an update without
 * it does not preserve sleep, it ends it. Missing that flag turns a free
 * background convergence into the whole fleet booting at once for an image none
 * of them will use until their next real wake.
 *
 * The state check is deliberately made against a FRESH `getMachine` rather than
 * a caller's listing, which may be minutes old by the time it gets here. A
 * machine can still be woken in the instant between that read and the write —
 * the window is milliseconds, and the caller's turn gate closes the rest — so
 * losing that race costs one extra restart during a wake the user was already
 * waiting on, never a killed turn.
 *
 * NEVER throws. A machine that misses one pass is picked up by the next.
 */
export class MachineImageUpdater {
  /** The client whose token can touch this app — see deps.resolveFlyClientForApp. */
  private async clientFor(appName: string): Promise<Pick<FlyClient, 'getMachine' | 'updateMachine' | 'stopMachine'>> {
    if (this.deps.resolveFlyClientForApp) {
      const resolved = await this.deps.resolveFlyClientForApp(appName);
      if (!resolved) {
        throw new Error(`Fly app ${appName} has no organization context — refusing to use the platform Fly token`);
      }
      return resolved;
    }
    return this.deps.flyClient;
  }

  /**
   * Failed roll attempts per machine, so a ref the API reports back in a form
   * we can't match (a digest, a normalisation) cannot become an endless
   * roll-every-sweep loop against the whole fleet.
   *
   * COUNTED, not latched on the first failure. Latching immediately was a real
   * outage of this mechanism: Fly keeps serving the pre-update config for a few
   * seconds after a successful write, so the first fleet-wide pass "failed" on
   * all nine machines it had in fact just rolled correctly, and disabled its
   * own retry for every one of them. One bad read should never be able to do
   * that. Process-lifetime, so a deploy clears the count.
   */
  private readonly rollAttempts = new Map<string, number>();

  constructor(private readonly deps: MachineImageUpdaterDeps) {}

  async rollWhileStopped(args: {
    sandboxId: string;
    /** Owner of the machine, when known — only used to stamp the result. */
    userId?: string;
    agentId?: string;
    /** Image the caller's fleet listing already reported for this machine. */
    listedImage?: string;
    /** `rootfs.persist` from that same listing. */
    listedRootfsPersist?: string;
    /**
     * Set by a caller that has JUST stopped this machine: wait for the
     * transition to finish before reading. Fly reports `stopping` for a moment
     * after a stop is accepted, and this refuses anything that is not
     * `stopped` — correctly, since that check is what stops a running machine
     * being rebooted under its user. Without the wait, the caller would race
     * its own stop and always lose.
     */
    waitForStopped?: boolean;
    /**
     * Put the machine to sleep first if it is awake. ONLY for a user who has
     * explicitly asked for the update and been told what it costs — it stops
     * whatever they had running. Never set by the reaper, which exists to catch
     * machines at a moment when this costs nothing.
     */
    stopFirst?: boolean;
  }): Promise<MachineImageUpdateResult> {
    const { sandboxId, listedImage, listedRootfsPersist, waitForStopped, stopFirst } = args;
    try {
      const targetImage = this.deps.getTargetImage()?.trim();
      if (!targetImage) {
        return { outcome: 'no-target' };
      }
      const target = parseFlySandboxId(sandboxId);
      if (!target) {
        return { outcome: 'unaddressable' };
      }
      if ((this.rollAttempts.get(sandboxId) ?? 0) >= MAX_ROLL_ATTEMPTS) {
        return { outcome: 'failed' };
      }
      // Steady state is a fleet where nearly every machine already matches, and
      // the caller's listing carries the image for all of them — so believe it
      // when it says "converged" and make no API call at all. Re-reading every
      // sleeping machine every sweep would be thousands of Fly calls an hour to
      // learn nothing. A listing stale the other way (says drifted, isn't)
      // costs one authoritative read below and resolves as 'current': that is
      // the safe direction to be wrong in, and the only one this skips.
      if (listedImage === targetImage && listedRootfsPersist === ROOTFS_PERSIST_TARGET) {
        await this.stamp(args, listedImage);
        return { outcome: 'current', fromImage: listedImage, toImage: targetImage };
      }
      const { appName, machineId } = target;

      if (waitForStopped && !(await this.awaitStopped(appName, machineId))) {
        // Never settled, or woke again. Nothing is lost: the sweep's
        // already-asleep pass is the backstop.
        console.warn(`[MachineImageUpdater] ${sandboxId}: did not settle into sleep; leaving it`);
        return { outcome: 'not-stopped' };
      }

      const machine = await (await this.clientFor(appName)).getMachine(appName, machineId);
      const config: FlyMachineConfig = machine.config ?? {};
      const fromImage = config.image ?? '';
      // The write below is the WHOLE config: whatever this read carried, plus
      // the new image. Every real machine config names its image, so a read
      // without one is not this machine's config — and writing it back wipes
      // everything it failed to carry. On 2026-09-21 exactly that happened to
      // one Workspace Agent machine: Fly answered with no config, the roll
      // logged "unknown → …" and wrote `{ image, rootfs }`, and the machine
      // woke with no env (so no AUTHORIZED_KEYS — every SSH refused), no
      // /data mount and the default 256 MB guest. Fly will not re-add a mount
      // to an existing machine, so the repair was a rebuild on the same
      // volume. Leave it; the next sweep reads again.
      if (!fromImage) {
        console.warn(`[MachineImageUpdater] ${sandboxId}: Fly returned no config image for this machine; not writing a config built from an incomplete read`);
        return { outcome: 'failed' };
      }
      // Machines created before the rootfs.persist default (DEFAULT_FLY_ROOTFS
      // in fly-sandbox-client.ts) converge here too: without it Fly wipes the
      // rootfs on EVERY start, so those agents lose their apt installs at every
      // sleep. Same write, same free moment.
      const persist = config.rootfs?.persist ?? 'never';
      if (fromImage === targetImage && persist === ROOTFS_PERSIST_TARGET) {
        await this.stamp(args, fromImage);
        return { outcome: 'current', fromImage, toImage: targetImage };
      }
      if (machine.state !== 'stopped') {
        if (!stopFirst) {
          return { outcome: 'not-stopped', fromImage, toImage: targetImage };
        }
        // Only reachable from a user who asked for this and was told it stops
        // whatever is running. The image cannot change under a live machine,
        // so the sleep is not a side effect here — it is the request.
        console.log(`[MachineImageUpdater] ${sandboxId}: stopping on request to roll`);
        await (await this.clientFor(appName)).stopMachine(appName, machineId);
        if (!(await this.awaitStopped(appName, machineId))) {
          return { outcome: 'not-stopped', fromImage, toImage: targetImage };
        }
      }

      const peer = await this.deps.resolveBackendPeerForApp?.(appName).catch(() => undefined);
      const updated = await (await this.clientFor(appName)).updateMachine(
        appName,
        machineId,
        {
          ...config,
          image: targetImage,
          rootfs: { ...config.rootfs, persist: ROOTFS_PERSIST_TARGET },
          // Machines that existed before note #393 have no CPU_KIND in their
          // env, so their facts block cannot say whether their cores are
          // dedicated or shared. Derived from the guest THIS read returned —
          // Fly's own answer for this machine, a moment ago — so it converges
          // the fleet without introducing a second, staler copy of the shape.
          //
          // And the SSH pin, when the machine has none (note #664). Every
          // machine the platform account built between 2026-08-23 and note
          // #664 booted without one, and with neither a pin nor a readable
          // own address the image skips its whole firewall — sshd and every
          // port open to the network hosted workplaces now share. Only ADDED:
          // a pin a machine already carries is never rewritten here.
          env: {
            ...config.env,
            ...machineCpuKindEnv(config.guest?.cpu_kind),
            ...(!config.env?.BACKEND_PEER_IP && peer ? { BACKEND_PEER_IP: peer } : {}),
          },
        },
        // Without this Fly BOOTS the machine it just updated — the whole fleet
        // would wake to receive an image it will not use until its next real
        // wake. The point of doing this at sleep is that the user never notices.
        { skipLaunch: true },
      );

      // Verify — but give the write time to become visible. Fly serves the
      // PRE-update config for a few seconds after a successful update, so a
      // single immediate read is not evidence of anything.
      const after = await this.confirmImage(appName, machineId, targetImage, updated);
      const observed = after?.config?.image ?? '';
      if (observed !== targetImage) {
        const attempts = (this.rollAttempts.get(sandboxId) ?? 0) + 1;
        this.rollAttempts.set(sandboxId, attempts);
        console.warn(
          `[MachineImageUpdater] ${sandboxId}: image still reads "${observed}" after writing `
          + `"${targetImage}" (attempt ${attempts}/${MAX_ROLL_ATTEMPTS})`
          + (attempts >= MAX_ROLL_ATTEMPTS ? '; not retrying until the next deploy' : ''),
        );
        return { outcome: 'failed', fromImage, toImage: targetImage };
      }
      this.rollAttempts.delete(sandboxId);
      // `skipLaunch` is what keeps it asleep — the assumption whose silent
      // failure is fleet-wide (every sleeping machine boots to receive an image
      // it will not use until its next real wake), so check rather than trust.
      //
      // But check the MACHINE, not the reply. Fly answers a skip_launch write
      // with the instance it has just made, and that instance reports
      // `created` — "made, not yet started" — EVERY time. `confirmImage`
      // returns exactly that reply whenever it already carries the new image,
      // which it always does. Reading state off it is why 42 rolls in this
      // journal reported a machine waking that never woke, and then called
      // stop into `replacing`, which Fly refuses: 409, "current state invalid,
      // replacing". Measured on a scratch machine (2026-08-11): the write goes
      // created → replacing → stopped in about two seconds, untouched.
      const settled = await this.awaitSettledState(appName, machineId);
      if (settled && RUNNING_STATES.has(settled)) {
        console.warn(`[MachineImageUpdater] ${sandboxId}: came up "${settled}" after an image write; stopping again`);
        await (await this.clientFor(appName)).stopMachine(appName, machineId).catch((error) => {
          console.warn(`[MachineImageUpdater] ${sandboxId}: could not re-stop after the write:`, error);
        });
      }
      console.log(`[MachineImageUpdater] ${sandboxId}: ${fromImage || 'unknown'} → ${targetImage}`);
      await this.stamp(args, observed);
      return { outcome: 'rolled', fromImage, toImage: targetImage };
    } catch (error) {
      console.warn(`[MachineImageUpdater] roll failed on ${sandboxId}:`, error);
      return { outcome: 'failed' };
    }
  }

  /**
   * Confirm the write landed, tolerating Fly's lag in reporting it.
   *
   * The update RESPONSE is the first and best evidence — it is the API telling
   * us what it just applied. Only if that is inconclusive do we re-read, with
   * the same backoff used for sleep, because a `getMachine` issued immediately
   * after a successful update commonly still returns the old config. Treating
   * that first stale read as failure is what made a working fleet-wide roll log
   * nine failures and switch off its own retries.
   */
  private async confirmImage(
    appName: string,
    machineId: string,
    targetImage: string,
    updated: FlyMachine | undefined,
  ): Promise<FlyMachine | undefined> {
    if (updated?.config?.image === targetImage) {
      return updated;
    }
    const delayMs = this.deps.settleDelayMs ?? 2_000;
    let latest = updated;
    for (let attempt = 0; attempt < CONFIRM_READS; attempt += 1) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const machine = await (await this.clientFor(appName)).getMachine(appName, machineId).catch(() => undefined);
      if (machine) {
        latest = machine;
        if (machine.config?.image === targetImage) {
          return machine;
        }
      }
    }
    return latest;
  }

  /**
   * What image this machine is on, read live.
   *
   * Cheap and safe from a menu tap, and that is the whole point: a machine's
   * image is a CONTROL-PLANE fact — `getMachine` answers for a stopped machine
   * without starting it — unlike the CLI version, which needs a shell and so
   * needs the machine awake. Conflating the two is what made the Version view
   * say "checked next time it sleeps" and withhold the update button from a
   * user whose machine was awake and answering: the fact was one API call away
   * the whole time.
   *
   * Stamps what it sees, so the record stays fresh even between rolls.
   */
  async readStatus(args: {
    sandboxId: string;
    userId?: string;
    agentId?: string;
  }): Promise<MachineImageStatus | undefined> {
    const targetImage = this.deps.getTargetImage()?.trim();
    const target = parseFlySandboxId(args.sandboxId);
    if (!targetImage || !target) {
      return undefined;
    }
    try {
      const machine = await (await this.clientFor(target.appName)).getMachine(target.appName, target.machineId);
      const observed = machine.config?.image?.trim() ?? '';
      const persist = machine.config?.rootfs?.persist ?? 'never';
      if (observed) {
        await this.stamp(args, observed);
      }
      return {
        target: targetImage,
        ...(observed ? { observed } : {}),
        current: observed === targetImage && persist === ROOTFS_PERSIST_TARGET,
      };
    } catch (error) {
      console.warn(`[MachineImageUpdater] could not read image for ${args.sandboxId}:`, error);
      return undefined;
    }
  }

  /**
   * Poll until the machine reports `stopped`. Fly reports `stopping` for a
   * moment after a stop is accepted, and the roll refuses anything that is not
   * `stopped` — correctly, since that check is what keeps a running machine
   * from being rebooted under its user. So a caller that has just stopped a
   * machine would otherwise race its own stop and always lose.
   *
   * A poll rather than Fly's own wait endpoint, because that endpoint needs the
   * machine's `instance_id` to wait on `stopped`, which the menu path does not
   * have. A handful of reads on a rare path is the cheaper thing to carry.
   */
  /**
   * Where a machine lands once Fly has finished making the replacement.
   *
   * Deliberately NOT `awaitStopped`: that one is asking "is it safe to write
   * to this machine", so anything but `stopped` is a no. This one is asking
   * "did the write leave it running", where `created` and `replacing` are
   * neither a yes nor a no — they are the change still happening, and the
   * whole bug being fixed here was treating the first of them as a yes.
   *
   * Bounded, and a machine still changing when the reads run out gets no
   * verdict at all: it is not running either way, and the next sweep sees it
   * with fresh eyes.
   */
  private async awaitSettledState(appName: string, machineId: string): Promise<string | undefined> {
    const delayMs = this.deps.settleDelayMs ?? 2_000;
    let state: string | undefined;
    for (let attempt = 0; attempt < SETTLE_READS; attempt += 1) {
      const machine = await (await this.clientFor(appName)).getMachine(appName, machineId).catch(() => undefined);
      state = machine?.state ?? state;
      if (state && !SETTLING_STATES.has(state)) {
        return state;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return state;
  }

  private async awaitStopped(appName: string, machineId: string): Promise<boolean> {
    const delayMs = this.deps.settleDelayMs ?? 2_000;
    const timeoutMs = this.deps.settleTimeoutMs ?? 60_000;
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(delayMs, 1)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const machine = await (await this.clientFor(appName)).getMachine(appName, machineId).catch(() => undefined);
      if (machine?.state === 'stopped') {
        return true;
      }
      // A machine that is up again is in use — stop waiting rather than write
      // to it. Ignored on the first couple of polls, where `started` is far
      // more likely to be the stop we just asked for not yet reflected.
      if (machine && machine.state !== 'stopping' && attempt >= 2) {
        return false;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  /**
   * Record what the machine is actually on. Only ever called with an image we
   * have just confirmed, never with the one we intended — the difference is
   * the whole value of showing it to a user.
   */
  private async stamp(
    args: { userId?: string; agentId?: string },
    image: string,
  ): Promise<void> {
    const { userId, agentId } = args;
    if (!this.deps.persistObservedImage || !userId || !agentId || !image) {
      return;
    }
    try {
      await this.deps.persistObservedImage({
        userId,
        agentId,
        image,
        checkedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      });
    } catch (error) {
      console.warn(`[MachineImageUpdater] could not persist image for agent ${agentId}:`, error);
    }
  }
}
