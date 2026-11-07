/**
 * A private copy re-pins its machines when its own address changes (note #815).
 *
 * Every agent and site machine lets SSH in from ONE address, the backend's:
 * `BACKEND_PEER_IP`, written into the machine's env when it is made and read
 * by the image's firewall at boot. A copy's backend is one Fly machine, and
 * that address is the machine's. If Fly moves it to another host, or it is
 * restored onto a new machine, the address changes and every machine refuses
 * the backend: no turn, no deploy, until each is told the new one.
 *
 * So once per boot a copy walks every machine a record claims in its own
 * account, and moves over any that still names another address:
 *
 *  - asleep, the env is rewritten with skip_launch: it stays asleep and comes
 *    up pinned to the new address at its next wake, like an image roll;
 *  - awake, the same write restarts it. The backend cannot reach it anyway,
 *    so the restart costs nothing that was still working, and a site is back
 *    in seconds;
 *  - anything between the two (starting, stopping, replacing) is left for
 *    the next pass.
 *
 * A pass that leaves nothing behind is the last until the next boot, since
 * the address cannot change under a running process. One that does tries
 * again a little later, a bounded number of times.
 *
 * A machine with no pin at all is not this pass's: that is a firewall that
 * never came up, which the reaper's pin audit reports. Neither is a machine
 * in a cloud a workplace connected itself (byo-fly): it pins a different
 * address, and the caller lists only the copy's own account.
 */

import { FlyApiError, type FlyClient, type FlyMachine } from './fly-client.js';

export interface CopyPeerRepinDeps {
  /** The backend's address now: `FLY_PRIVATE_IP` in a copy. */
  peerIp: string;
  /** The copy's own Fly account. */
  flyClient: Pick<FlyClient, 'listMachines' | 'getMachine' | 'updateMachine'>;
  /** Every app a record claims in that account: agent machines and sites. */
  listApps: () => Promise<string[]>;
  /** Wait before another pass when one left something behind. */
  retryMs?: number;
  /** Passes per boot, the first included. */
  maxPasses?: number;
  /**
   * Leave an awake machine alone and move it once it sleeps, instead of
   * restarting it. Our own platform's backend on Fly (note #1032, stage 4):
   * its fleet runs real turns, so a machine awake at the move gets the new
   * address added to its live firewall by hand and is never restarted under
   * a turn. A copy keeps the restart: its machines cannot be reached anyway.
   */
  leaveAwake?: boolean;
  log?: (line: string) => void;
}

export interface CopyPeerRepinPass {
  /** Machines already pinned to the address now. */
  current: number;
  /** Moved over while asleep, and still asleep. */
  repinnedAsleep: number;
  /** Moved over while awake, and restarted by it. */
  repinnedAwake: number;
  /** Mid-change, or a read or a write that failed: the next pass's. */
  left: number;
}

const DEFAULT_RETRY_MS = 10 * 60_000;
const DEFAULT_MAX_PASSES = 12;

export class CopyPeerRepin {
  private timer: NodeJS.Timeout | null = null;
  private passes = 0;

  constructor(private readonly deps: CopyPeerRepinDeps) {}

  private log(line: string): void {
    (this.deps.log ?? console.log)(`[copy-peer-repin] ${line}`);
  }

  /** The first pass after `delayMs`; later ones only while something is left. */
  start(delayMs: number): void {
    this.schedule(delayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runPass().then((pass) => {
        if (pass.left === 0) return;
        if (this.passes >= (this.deps.maxPasses ?? DEFAULT_MAX_PASSES)) {
          this.log(`${pass.left} machine(s) still left after ${this.passes} passes; the next boot tries again`);
          return;
        }
        this.schedule(this.deps.retryMs ?? DEFAULT_RETRY_MS);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  /** One walk over every claimed machine. Never throws. */
  async runPass(): Promise<CopyPeerRepinPass> {
    this.passes += 1;
    const pass: CopyPeerRepinPass = { current: 0, repinnedAsleep: 0, repinnedAwake: 0, left: 0 };
    const peer = this.deps.peerIp.trim();
    if (!peer) return pass;
    let apps: string[];
    try {
      apps = await this.deps.listApps();
    } catch (error) {
      this.log(`could not list the machines' apps: ${error instanceof Error ? error.message : String(error)}`);
      return { ...pass, left: 1 };
    }
    for (const appName of apps) {
      let machines: FlyMachine[];
      try {
        machines = await this.deps.flyClient.listMachines(appName);
      } catch (error) {
        // An app a record still names but Fly no longer has holds nothing to re-pin.
        if (error instanceof FlyApiError && error.status === 404) continue;
        this.log(`${appName}: could not list machines: ${error instanceof Error ? error.message : String(error)}`);
        pass.left += 1;
        continue;
      }
      for (const listed of machines) {
        const pinned = listed.config?.env?.BACKEND_PEER_IP?.trim();
        if (!pinned) continue;
        if (pinned === peer) {
          pass.current += 1;
          continue;
        }
        const outcome = await this.repin(appName, listed.id, peer);
        if (outcome === 'asleep') pass.repinnedAsleep += 1;
        else if (outcome === 'awake') pass.repinnedAwake += 1;
        else if (outcome === 'current') pass.current += 1;
        else pass.left += 1;
      }
    }
    const moved = pass.repinnedAsleep + pass.repinnedAwake;
    if (moved > 0 || pass.left > 0) {
      this.log(
        `pass ${this.passes}: ${moved} machine(s) moved to ${peer} `
        + `(${pass.repinnedAsleep} asleep, ${pass.repinnedAwake} awake, restarted), `
        + `${pass.current} already on it, ${pass.left} left for the next pass`,
      );
    }
    return pass;
  }

  /** Re-read the machine and write the new pin, keeping everything else. */
  private async repin(appName: string, machineId: string, peer: string): Promise<'asleep' | 'awake' | 'current' | 'left'> {
    const id = `${appName}/${machineId}`;
    try {
      // The write is the WHOLE config, so it is built from a fresh read and
      // only from one that names its image: a read without one is not this
      // machine's config, and writing it back would wipe the rest of it
      // (machine-image-updater.ts, 2026-09-21).
      const machine = await this.deps.flyClient.getMachine(appName, machineId);
      const config = machine.config;
      if (!config?.image || !config.env) {
        this.log(`${id}: Fly returned an incomplete config; leaving it`);
        return 'left';
      }
      const from = config.env.BACKEND_PEER_IP?.trim();
      if (!from) return 'left';
      if (from === peer) return 'current';
      const asleep = machine.state === 'stopped';
      if (!asleep && machine.state !== 'started') return 'left';
      if (!asleep && this.deps.leaveAwake) return 'left';
      await this.deps.flyClient.updateMachine(
        appName,
        machineId,
        { ...config, env: { ...config.env, BACKEND_PEER_IP: peer } },
        // Asleep stays asleep. Awake, Fly restarts it to apply the change.
        asleep ? { skipLaunch: true } : {},
      );
      this.log(`${id}: ${from} → ${peer} (${asleep ? 'asleep, left asleep' : 'awake, restarted'})`);
      return asleep ? 'asleep' : 'awake';
    } catch (error) {
      this.log(`${id}: could not re-pin: ${error instanceof Error ? error.message : String(error)}`);
      return 'left';
    }
  }
}
