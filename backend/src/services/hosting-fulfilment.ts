import type { DeploymentStorage } from './deployment-storage.js';
import type { DeploymentService } from './deployment-service.js';
import type { DeploymentPreset } from '../types/deployment.js';
import { isFlyBillingRequired } from './fly-client.js';

/**
 * Bringing a hosted site UP, in the background, and telling the user about it.
 *
 * This used to live inside PaddleBillingService, because a site only ever got
 * built when a payment webhook said so. Hosting is included with the account
 * now (no ladder, no allowances), so the thing that starts a build is an agent
 * running `agentbuilt deploy` — and a backend with no Paddle configured (every
 * dev machine) must still be able to take a site live. Hence its own service,
 * which the deploy route and the legacy hosting webhooks both drive.
 *
 * Everything here is deliberately background-and-marked rather than awaited:
 * provisioning a machine takes about a minute (its address answers as soon
 * as the record is live — no DNS record, no certificate, since 2026-10-16),
 * which is far longer than an HTTP request should hold.
 * `fulfilmentPendingSince` on the record is what makes that safe
 * across a restart — every deploy of ours restarts the backend, and a job that
 * died with the old process is picked up by {@link resumePending} on the next
 * boot.
 */

export interface HostingFulfilmentOptions {
  storage: Pick<DeploymentStorage, 'get' | 'update' | 'listAll'>;
  service: Pick<DeploymentService, 'provision' | 'resume' | 'resize' | 'url'>;
  /**
   * Deliver a notice ("your site is live") to the user, preferably in the
   * requesting agent's own chat. Best-effort: a failed send loses a courtesy
   * message, never the site.
   */
  notify?: (args: { userId: string; agentId: string; text: string }) => Promise<unknown>;
  /**
   * How long to wait for a freshly provisioned site's PUBLIC url to actually
   * answer before announcing it. The address needs no DNS record and no
   * certificate any more, so it normally answers on the first probe; the wait
   * is the safety net for an edge that has not re-read the name map yet.
   * Tests shrink these.
   */
  readyProbe?: { timeoutMs: number; intervalMs: number };
  now?: () => number;
}

export class HostingFulfilment {
  private readonly now: () => number;

  constructor(private readonly options: HostingFulfilmentOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Get a site serving, whatever state it is in: build the machine for a
   * reserved name, or start the machine of a paused one. Marks the record and
   * returns immediately — the work and the notice happen after the caller has
   * answered.
   *
   * Returns what it decided to do, so a caller can word its own reply ("being
   * set up" reads wrong for a site that was merely paused).
   */
  async startBringUp(deploymentId: string): Promise<'provisioning' | 'resuming' | 'already-live' | 'unknown'> {
    const doc = await this.options.storage.get(deploymentId);
    if (!doc) return 'unknown';
    if (doc.status === 'live') return 'already-live';
    if (doc.status !== 'pending-payment' && doc.status !== 'provisioning' && doc.status !== 'payment-lapsed') {
      // stopped (operator) or destroyed — not something a deploy may undo.
      return 'unknown';
    }
    const resuming = doc.status === 'payment-lapsed';
    // The marker goes down BEFORE the work starts, so a crash between the two
    // is a resumable job rather than a site nobody is building.
    await this.options.storage.update(doc.id, {
      fulfilmentPendingSince: new Date(this.now()).toISOString(),
    });
    void this.bringUpAndAnnounce(doc.id, doc.userId, doc.agentId, doc.name, { resuming });
    return resuming ? 'resuming' : 'provisioning';
  }

  /**
   * Move a live site onto a bigger machine. Same contract as a bring-up: the
   * record carries the target preset so a restart mid-resize can finish the
   * job, and the caller does not wait for a machine to reboot.
   */
  async startResize(deploymentId: string, preset: DeploymentPreset): Promise<boolean> {
    const doc = await this.options.storage.get(deploymentId);
    if (!doc || doc.status !== 'live' || doc.preset === preset) return false;
    await this.options.storage.update(doc.id, {
      fulfilmentPendingSince: new Date(this.now()).toISOString(),
      pendingPreset: preset,
    });
    void this.resizeAndAnnounce(doc.id, doc.userId, doc.agentId, doc.name, preset);
    return true;
  }

  /**
   * Provision (or resume), wait for the address to answer, then say so. The
   * wait is the point of announcing from here rather than from the request:
   * the machine is up long before the URL is, and an agent that hands over a
   * link which 404s has broken the one thing the user asked for (observed
   * live 2026-08-05, on the first sale).
   */
  private async bringUpAndAnnounce(
    deploymentId: string,
    userId: string,
    agentId: string,
    name: string,
    opts: { resuming: boolean; notifyFailure?: boolean },
  ): Promise<void> {
    const notifyFailure = opts.notifyFailure ?? true;
    try {
      let url: string;
      if (opts.resuming) {
        await this.options.service.resume(deploymentId);
        const doc = await this.options.storage.get(deploymentId);
        url = doc ? this.options.service.url(doc) : '';
      } else {
        ({ url } = await this.options.service.provision(deploymentId));
      }
      const answer = url ? await this.waitForUrlReady(url) : { state: 'pending' as const };
      await this.notifySafe(userId, agentId, answer.state === 'working'
        ? `🎉 ${name} is live! Your site now has its own always-on home: ${url}`
        : answer.state === 'error'
          // The address is up and the site behind it is failing: saying the
          // link "will start working on its own" would be untrue, and a
          // link that errors is exactly what the owner never wants handed
          // over (2026-09-25).
          ? `${name} is set up, but the site itself is answering with an error (HTTP ${answer.status}), so the link does not work yet. Ask your agent to look at it.`
          // No link in it: a user is only ever handed a link that works.
          : `${name} is set up, but its address is taking longer than usual to come online, so there is no working link yet. Ask your agent to check on it.`);
      await this.options.storage.update(deploymentId, { fulfilmentPendingSince: undefined });
    } catch (error) {
      // The marker stays set, so the next boot retries this.
      console.error(`[hosting] BRING-UP FAILED for ${name} (${deploymentId}) — needs operator attention:`, error);
      if (notifyFailure) {
        // Fly's billing refusal (note #801) is not "taking longer": nothing
        // happens until whoever owns the Fly account acts, so say that.
        await this.notifySafe(userId, agentId, isFlyBillingRequired(error)
          ? `${name} could not be built. ${error.message} Nothing you built is lost; deploy again once it is sorted.`
          : `${name} is taking longer than expected to come online. We're on it — you don't need to do anything, and nothing you built is lost.`);
      }
    }
  }

  private async resizeAndAnnounce(
    deploymentId: string,
    userId: string,
    agentId: string,
    name: string,
    preset: DeploymentPreset,
    opts: { notifyFailure?: boolean } = {},
  ): Promise<void> {
    try {
      await this.options.service.resize(deploymentId, preset);
      await this.notifySafe(userId, agentId,
        `⚡ ${name} now runs on a bigger machine with more memory. The switch is done.`);
      await this.options.storage.update(deploymentId, {
        fulfilmentPendingSince: undefined,
        pendingPreset: undefined,
      });
    } catch (error) {
      console.error(`[hosting] RESIZE FAILED for ${name} (${deploymentId}) — needs operator attention:`, error);
      if (opts.notifyFailure ?? true) {
        await this.notifySafe(userId, agentId, isFlyBillingRequired(error)
          ? `${name} could not move to the bigger machine. ${error.message} The site keeps running meanwhile.`
          : `The bigger machine for ${name} is taking longer than expected. We're on it — the site keeps running meanwhile.`);
      }
    }
  }

  /**
   * Re-run jobs whose process died mid-flight. Called once at boot, after
   * notice delivery is wired up. Failures here don't re-message the user: the
   * first attempt already did, and a persistently broken provision would
   * otherwise ping them on every deploy of ours.
   */
  async resumePending(): Promise<number> {
    const pending = (await this.options.storage.listAll()).filter((d) => d.fulfilmentPendingSince);
    let resumed = 0;
    for (const d of pending) {
      if (d.status === 'live' && d.pendingPreset && d.pendingPreset !== d.preset) {
        console.log(`[hosting] resuming interrupted resize for ${d.name} (${d.preset} → ${d.pendingPreset})`);
        resumed += 1;
        void this.resizeAndAnnounce(d.id, d.userId, d.agentId, d.name, d.pendingPreset, { notifyFailure: false });
      } else if (d.status === 'pending-payment' || d.status === 'provisioning' || d.status === 'live' || d.status === 'payment-lapsed') {
        // A `live` record still marked is one whose NOTICE was interrupted —
        // provision() returns straight away when live, so this re-runs the
        // probe and the announcement, not the build.
        console.log(`[hosting] resuming interrupted fulfilment for ${d.name} (status=${d.status}, pending since ${d.fulfilmentPendingSince})`);
        resumed += 1;
        void this.bringUpAndAnnounce(d.id, d.userId, d.agentId, d.name, {
          resuming: d.status === 'payment-lapsed',
          notifyFailure: false,
        });
      } else {
        // Stopped or destroyed since: the lifecycle has moved on.
        await this.options.storage.update(d.id, { fulfilmentPendingSince: undefined, pendingPreset: undefined });
      }
    }
    return resumed;
  }

  /**
   * `working` once the site itself answers below 500 — the preview router
   * found the name in the map and the answer comes from the site's hosting.
   * Bounded: readiness decides the announcement, not whether the site exists.
   */
  private async waitForUrlReady(url: string): Promise<
    { state: 'working' } | { state: 'error'; status: number } | { state: 'pending' }
  > {
    const { timeoutMs, intervalMs } = this.options.readyProbe
      // Long enough that "no working link yet" means something is wrong.
      ?? { timeoutMs: 20 * 60_000, intervalMs: 10_000 };
    const deadline = this.now() + timeoutMs;
    let failing: number | null = null;
    for (;;) {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        // Only an answer from the site's hosting counts. Every agentbuilt.app
        // name that is not set up yet answers too — the preview router's
        // "No such preview." 404 — and the CLI's same "any answer" test printed
        // "Live at" seven minutes before the site answered (hello-world-felix,
        // 2026-09-25). Fly's edge stamps every response it serves. And a 5xx
        // from there is the site failing, not working: a service still
        // starting, or one that crashed.
        if (response.headers.has('fly-request-id')) {
          if (response.status < 500) return { state: 'working' };
          failing = response.status;
        }
      } catch {
        // Not answering yet — keep waiting.
      }
      if (this.now() + intervalMs > deadline) {
        return failing === null ? { state: 'pending' } : { state: 'error', status: failing };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async notifySafe(userId: string, agentId: string, text: string): Promise<void> {
    if (!this.options.notify) return;
    await this.options.notify({ userId, agentId, text }).catch((error) => {
      console.warn(`[hosting] notify failed for ${userId}:`, error);
    });
  }
}
