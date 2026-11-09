import { randomBytes } from 'node:crypto';
import { FlyClient } from './fly-client.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';
import type { OrgWireGuardService } from './org-wireguard.js';

/**
 * Per-workplace messaging hosts (note #608): direct messages between people
 * live on ONE machine that exists for nothing else — one app, one machine, one
 * volume — in the cloud account the workplace's machines live in: its own
 * when it connected one, otherwise the account that hosts it (ours on the
 * hosted service, the company's own in a private copy; 29 Oct 2026). The
 * platform database holds no message text; this service is only the address
 * book and the door.
 *
 * Who can reach that machine: the backend. Not an agent, not the Workspace
 * Agent, not a member's browser.
 *
 * - No public address, no SSH, and NO Fly proxy service (so no flycast): a
 *   proxied port would be dialable by every machine in the workplace's
 *   private network, and would hide the caller's address from the firewall.
 *   The backend dials the machine's own private address over the workplace's
 *   WireGuard peer, and the image drops every private-network caller but that
 *   peer (infra/msg-host-image/entrypoint.sh — it refuses to boot without one).
 * - Every request carries a per-workplace secret kept in the ORG secret
 *   store, which no agent turn's environment is ever built from
 *   (org-secrets.ts).
 *
 * With no proxy there is nothing to stop or start an idle machine, so the
 * server stops itself after a quiet spell and {@link OrgMsgHostService.call}
 * starts it through the Fly API when somebody opens Messages. Home's unread
 * badge never comes here — see RemoteDirectMessageStorage.
 *
 * PROVISIONING is lazy, idempotent and resumable, in the git host's order
 * (org-git-host.ts): app → volume → secret → machine → healthy → pointer.
 */

export const ORG_MSG_HOST_SECRET_NAME = 'MSG_HOST_SECRET';
export const ORG_MSG_VOLUME_GB = Number(process.env.ORG_MSG_VOLUME_GB || 1);
/** How long the server waits without a request before stopping itself. */
/**
 * ZERO since note #1109 (Adam, 9 Nov 2026 18:40 UTC: "yes let's make it
 * always on"): the server never stops itself (msg-host.mjs skips its idle
 * timer at 0), and the machine's restart policy is `always`, so a crash or a
 * host event brings it back by itself. A read that still finds it down wakes
 * it as before. Thirty quiet minutes from note #1104 (Adam, 9 Nov 2026: "Yes agree with
 * recommendation"): ten, before, meant almost every return to Messages paid
 * a wake. A machine built with another value is moved onto this one the
 * next time it is woken from stopped (see `ensureOrgMsgHost`).
 */
export const ORG_MSG_IDLE_MS = Number(process.env.ORG_MSG_IDLE_MS ?? 0);
/** What a machine whose own idle cannot be read is assumed to keep: the old ten minutes. */
const ASSUMED_IDLE_MS = 10 * 60_000;
/** One background wake from Home per workplace in this window (note #1104). */
export const ORG_MSG_WAKE_WINDOW_MS = 60_000;
/**
 * How long after an answer the backend dials straight in without asking Fly
 * whether the machine is up. Well inside {@link ORG_MSG_IDLE_MS}; a machine
 * that stopped anyway just costs the one failed dial that precedes a wake.
 */
// An always-on machine (idle 0) is trusted for ten minutes past each answer;
// past that a read asks Fly once (~55 ms) rather than dialling blind.
const warmFor = (idleMs: number) => (idleMs <= 0 ? 10 * 60_000 : Math.max(0, idleMs - 3 * 60_000));
/** The restart policy every messaging machine carries since note #1109. */
const RESTART_POLICY = 'always';
/**
 * The health wait's rhythm (note #1102). A machine that has just started
 * drops packets until its server listens, so a probe of it does not fail —
 * it hangs for its whole timeout. Measured on production, 9 Nov 2026: start
 * call to first healthy answer 2.86 s every time, but the old 3 s probe and
 * 1 s gap meant the first probe hung 3 s and the second came a second later,
 * so a wake cost the reader about 5 s. Short probes close together answer
 * within a quarter second of the machine being ready.
 */
const HEALTH_PROBE_MS = 750;
const HEALTH_PROBE_GAP_MS = 250;
/** How long a request waits for a wake or a first build before it says "opening". */
const OPENING_WAIT_MS = 8_000;

/** A refusal the messaging host itself gave (its status, its words). */
export class OrgMsgHostRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** The machine is being built or woken; the same request succeeds shortly. */
export class OrgMsgHostOpening extends Error {
  constructor() { super('The messaging machine is starting.'); }
}
/** This workplace cannot have a messaging machine (yet), and why. */
export class OrgMsgHostUnavailable extends Error {}

export interface OrgMsgHostPointer {
  app: string;
  machineId: string;
  /** The machine's own private-network address — what the backend dials. */
  privateIp: string;
  volumeId: string;
  secretName?: string;
}

export interface OrgMsgHostServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveHostingContext'>;
  orgWireGuard?: Pick<OrgWireGuardService, 'ensureUpIfMissing'>;
  /** The public image every workplace pulls (ghcr…:msg-host-sha-…). */
  msgHostImage?: string;
  region: string;
  /**
   * The backend's address on the hosting account's own private network — the
   * peer a workplace without a cloud of its own is reached through: our Fly
   * org on the hosted service, the company's org in a private copy (where it
   * is the backend machine's own address). Used only when the workplace has no
   * WireGuard peer of its own recorded.
   */
  platformBackendPeerIp?: string;
  makeFlyClient?: (apiToken: string) => Pick<FlyClient,
    'createApp' | 'listVolumes' | 'createVolume' | 'listMachines' | 'createMachine'
    | 'getMachine' | 'startMachine' | 'waitForMachineState' | 'updateMachine'
    | 'deleteMachine' | 'deleteVolume' | 'deleteApp'>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test overrides for the two waits. */
  healthTimeoutMs?: number;
  openingWaitMs?: number;
}

/** `iamsg-` + the orgId's hex, the same shape every org-scoped app uses. */
export function orgMsgAppName(orgId: string): string {
  return `iamsg-${orgId.replace(/-/g, '').slice(0, 12)}`;
}

export function isOrgMsgAppName(appName: string): boolean {
  return /^iamsg-[0-9a-f]{12}$/.test(appName);
}

export class OrgMsgHostService {
  /** One build or wake per workplace at a time; every caller shares it. */
  private readonly opening = new Map<string, Promise<OrgMsgHostPointer>>();
  private readonly warmUntil = new Map<string, number>();
  /** Each machine's own idle, as its config last said (a machine from before
   *  note #1104 keeps ten minutes until it is next woken from stopped). */
  private readonly idleOf = new Map<string, number>();
  /** When Home last asked for a wake, per workplace (note #1104). */
  private readonly wokenFromHome = new Map<string, number>();
  private warm(orgId: string): void {
    this.warmUntil.set(orgId, this.now() + warmFor(this.idleOf.get(orgId) ?? ASSUMED_IDLE_MS));
  }

  /**
   * Note #1104: Home drew the Messages card, so somebody may be about to open
   * a conversation. Start the machine in the background — nothing is read,
   * nothing waits, and at most once per workplace per
   * {@link ORG_MSG_WAKE_WINDOW_MS}. A workplace that never had a machine is
   * left alone: building one is the first open's job. A failure is logged
   * and changes nothing anyone sees; the next read wakes it as before.
   */
  async wake(orgId: string): Promise<'warm' | 'recent' | 'none' | 'waking'> {
    if ((this.warmUntil.get(orgId) ?? 0) > this.now()) return 'warm';
    const last = this.wokenFromHome.get(orgId) ?? -Infinity;
    if (this.now() - last < ORG_MSG_WAKE_WINDOW_MS) return 'recent';
    this.wokenFromHome.set(orgId, this.now());
    const org = await this.deps.orgStorage.getOrg(orgId).catch(() => null);
    if (!org?.messages?.host) return 'none';
    if (!this.opening.has(orgId)) {
      const started = this.now();
      const opening = this.ensureOrgMsgHost(orgId).finally(() => { this.opening.delete(orgId); });
      this.opening.set(orgId, opening);
      opening.then(
        (pointer) => console.log(`[org-msg-host] ${pointer.app} woken from Home in ${this.now() - started} ms`),
        (error) => console.warn(`[org-msg-host] ${orgId} wake from Home failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return 'waking';
  }

  constructor(private readonly deps: OrgMsgHostServiceDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private fly(apiToken: string) {
    return (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(apiToken);
  }

  /**
   * One operation on the workplace's messaging host. Every operation is
   * idempotent (a send carries its client identifier), so a dial that fails
   * on a machine that had just stopped is safely repeated after the wake.
   */
  async call<T>(orgId: string, operation: string, body: Record<string, unknown>): Promise<T> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    const pointer = org?.messages?.host;
    if (pointer && (this.warmUntil.get(orgId) ?? 0) > this.now()) {
      try {
        return await this.post<T>(orgId, pointer, operation, body);
      } catch (error) {
        if (error instanceof OrgMsgHostRefusal) throw error;
        this.warmUntil.delete(orgId);
      }
    }
    // The measure note #1104 asked for, and nothing of the read: whether a
    // read that was not known warm had to wait, and how long after Home's wake.
    const asked = this.now(), home = this.wokenFromHome.get(orgId);
    const ready = await this.ready(orgId);
    const since = home === undefined ? 'no wake from Home' : `Home woke it ${Math.round((asked - home) / 100) / 10} s before`;
    console.log(`[org-msg-host] ${ready.app} ${operation}: waited ${this.now() - asked} ms for the machine (${since})`);
    return this.post<T>(orgId, ready, operation, body);
  }

  /** Wait a moment for the machine; past that the caller is told it is opening. */
  private async ready(orgId: string): Promise<OrgMsgHostPointer> {
    let opening = this.opening.get(orgId);
    if (!opening) {
      opening = this.ensureOrgMsgHost(orgId).finally(() => { this.opening.delete(orgId); });
      this.opening.set(orgId, opening);
      // The build outlives the request that started it; its failure is
      // reported to whoever asks next, never as an unhandled rejection.
      opening.catch((error) => {
        if (!(error instanceof OrgMsgHostUnavailable)) {
          console.warn(`[org-msg-host] ${orgId} did not open: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const late = Symbol('late');
    const winner = await Promise.race([opening, sleep(this.deps.openingWaitMs ?? OPENING_WAIT_MS).then(() => late)]);
    if (winner === late) throw new OrgMsgHostOpening();
    return winner as OrgMsgHostPointer;
  }

  /** Build (or find, and wake) the workplace's messaging host. */
  async ensureOrgMsgHost(orgId: string): Promise<OrgMsgHostPointer> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) throw new OrgMsgHostUnavailable('This workplace no longer exists.');
    // Where its machines live: its own account, else the one hosting it. Only
    // a backend with neither has nowhere to put the conversations.
    const fly = await this.deps.orgFly.resolveHostingContext(orgId).catch(() => {
      throw new OrgMsgHostUnavailable('Messages need a cloud account to live in, and this workplace has none yet.');
    });
    const client = this.fly(fly.apiToken);
    // A tunnel is the workplace's own account's (its WireGuard peer); a
    // hosted workplace is reached over the hosting account's network.
    if (org.fly && this.deps.orgWireGuard) {
      await this.deps.orgWireGuard.ensureUpIfMissing(orgId).catch((error) => {
        console.warn(`[org-msg-host] ${orgId} tunnel converge failed, continuing:`, error instanceof Error ? error.message : error);
      });
    }

    const existing = org.messages?.host;
    if (existing) {
      const machine = await client.getMachine(existing.app, existing.machineId);
      const kept = Number(machine.config?.env?.MSG_HOST_IDLE_MS);
      const keptIdle = Number.isFinite(kept) && machine.config?.env?.MSG_HOST_IDLE_MS !== undefined ? kept : ASSUMED_IDLE_MS;
      // A machine built under an older rule (an idle stop, restart "no") is
      // moved onto the current one: always on since note #1109. A config
      // update reboots a running machine (a few seconds, once) and, measured
      // on production 9 Nov 2026 18:36 UTC, leaves a STOPPED one stopped —
      // so it is started explicitly afterwards (PR #140).
      const current = machine.config && keptIdle === ORG_MSG_IDLE_MS && (machine.config.restart as { policy?: string } | undefined)?.policy === RESTART_POLICY;
      if (machine.state === 'stopping') {
        await client.waitForMachineState(existing.app, existing.machineId, { state: 'stopped', timeoutSeconds: 30 });
      }
      if (machine.config && !current && client.updateMachine) {
        await client.updateMachine(existing.app, existing.machineId, {
          ...machine.config,
          env: { ...(machine.config.env ?? {}), MSG_HOST_IDLE_MS: String(ORG_MSG_IDLE_MS) },
          restart: { policy: RESTART_POLICY },
        });
        // Production, 9 Nov 2026 19:25 UTC: right after the update Fly is
        // still REPLACING the machine and refuses a start (412). Let the
        // update settle — a running machine comes back started by itself —
        // and start it only if it settled stopped.
        const settled = await client.waitForMachineState(existing.app, existing.machineId, { state: 'started', timeoutSeconds: 20 })
          .then(() => true, () => false);
        if (!settled) {
          const after = await client.getMachine(existing.app, existing.machineId);
          if (after.state !== 'started') {
            if (after.state !== 'stopped') await client.waitForMachineState(existing.app, existing.machineId, { state: 'stopped', timeoutSeconds: 30 }).catch(() => {});
            await client.startMachine(existing.app, existing.machineId);
          }
          await client.waitForMachineState(existing.app, existing.machineId, { state: 'started', timeoutSeconds: 60 });
        }
        this.idleOf.set(orgId, ORG_MSG_IDLE_MS);
      } else {
        if (machine.state !== 'started') {
          await client.startMachine(existing.app, existing.machineId);
          await client.waitForMachineState(existing.app, existing.machineId, { state: 'started', timeoutSeconds: 60 });
        }
        this.idleOf.set(orgId, keptIdle);
      }
      await this.waitHealthy(existing, this.deps.healthTimeoutMs ?? 45_000);
      this.warm(orgId);
      return existing;
    }

    if (!this.deps.msgHostImage) {
      throw new OrgMsgHostUnavailable('Messages are not switched on for this platform yet.');
    }
    // The firewall's one allowed caller. Re-read: the tunnel converge above
    // may have just registered the peer.
    const peerIp = (await this.deps.orgStorage.getOrg(orgId))?.fly?.wireguard?.peerIp || this.deps.platformBackendPeerIp;
    if (!peerIp) {
      throw new OrgMsgHostUnavailable('This workplace’s private link to the platform is not up yet. Try again in a minute.');
    }

    const appName = orgMsgAppName(orgId);
    try {
      await client.createApp({ appName, orgSlug: fly.orgSlug });
    } catch (error) {
      // An app that already exists is a resumed provision, not a failure.
      if (!/already|taken|exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    const volumes = await client.listVolumes(appName);
    const volume = volumes.find((candidate) => candidate.name === 'msgdata')
      ?? await client.createVolume(appName, { name: 'msgdata', region: this.deps.region, sizeGb: ORG_MSG_VOLUME_GB });

    // Secret before machine (the git host's rule): this order can crash
    // midway and only ever leave a secret with no machine, which is reused.
    let secret = await this.deps.orgSecrets.getOrgSecret(orgId, ORG_MSG_HOST_SECRET_NAME);
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      await this.deps.orgSecrets.setOrgSecret(orgId, ORG_MSG_HOST_SECRET_NAME, secret,
        `Shared secret between the backend and this workplace's messaging machine (${appName})`);
    }

    let machine = (await client.listMachines(appName))[0];
    if (!machine) {
      machine = await client.createMachine(appName, {
        name: 'msg-host',
        region: volume.region ?? this.deps.region,
        image: this.deps.msgHostImage,
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
        env: {
          MSG_HOST_SECRET: secret,
          MSG_HOST_ORG: orgId,
          MSG_HOST_IDLE_MS: String(ORG_MSG_IDLE_MS),
          BACKEND_PEER_IP: peerIp,
        },
        mounts: [{ volume: volume.id, path: '/data' }],
        // NO services: nothing is published, not even privately (see the
        // module doc). And `no` restart: the server's clean exit after an
        // idle spell is how this machine sleeps.
        restart: { policy: RESTART_POLICY },
      });
    } else if (machine.state !== 'started') {
      await client.startMachine(appName, machine.id);
    }
    await client.waitForMachineState(appName, machine.id, { state: 'started', timeoutSeconds: 90 });
    const privateIp = machine.private_ip ?? (await client.getMachine(appName, machine.id)).private_ip;
    if (!privateIp) throw new Error(`${appName} has no private address`);

    const pointer: OrgMsgHostPointer = {
      app: appName, machineId: machine.id, privateIp, volumeId: volume.id, secretName: ORG_MSG_HOST_SECRET_NAME,
    };
    await this.waitHealthy(pointer, this.deps.healthTimeoutMs ?? 90_000);
    // Pointer last: a workplace is only ever pointed at a host that answered.
    await this.deps.orgStorage.updateOrg(orgId, { messages: { host: pointer } });
    this.idleOf.set(orgId, ORG_MSG_IDLE_MS);
    this.warm(orgId);
    return pointer;
  }

  /**
   * Note #1109, at the backend's start: every workplace that has a messaging
   * machine is brought onto the current rule — always on — and started if it
   * is down. One workplace at a time; a failure is logged and the next read
   * or wake from Home tries again.
   */
  async convergeAll(orgIds: string[]): Promise<void> {
    for (const orgId of orgIds) {
      const org = await this.deps.orgStorage.getOrg(orgId).catch(() => null);
      if (!org?.messages?.host) continue;
      if (this.opening.has(orgId)) continue;
      const opening = this.ensureOrgMsgHost(orgId).finally(() => { this.opening.delete(orgId); });
      this.opening.set(orgId, opening);
      await opening.then(
        (pointer) => console.log(`[org-msg-host] ${pointer.app} kept on (always on, note #1109)`),
        (error) => console.warn(`[org-msg-host] ${orgId} could not be kept on: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  /**
   * Workplace deletion (note #664's rule for machines on our account): a
   * messaging machine in the account that HOSTS the workplace is destroyed
   * with it — its volume is the conversations, which is the point of
   * deleting. One in the workplace's own cloud is left there with the rest of
   * its machines. Returns the app removed, or null when there was none here.
   */
  async releaseHostedMachine(orgId: string): Promise<string | null> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    const pointer = org?.messages?.host;
    if (!org || !pointer || org.fly) return null;
    const fly = await this.deps.orgFly.resolveHostingContext(orgId);
    const client = this.fly(fly.apiToken);
    for (const machine of await client.listMachines(pointer.app)) {
      await client.deleteMachine(pointer.app, machine.id, { force: true });
    }
    for (const volume of await client.listVolumes(pointer.app)) {
      await client.deleteVolume(pointer.app, volume.id);
    }
    await client.deleteApp(pointer.app);
    this.opening.delete(orgId);
    this.warmUntil.delete(orgId);
    return pointer.app;
  }

  private async post<T>(orgId: string, pointer: OrgMsgHostPointer, operation: string, body: Record<string, unknown>): Promise<T> {
    const secret = await this.deps.orgSecrets.getOrgSecret(orgId, pointer.secretName ?? ORG_MSG_HOST_SECRET_NAME);
    if (!secret) throw new Error(`org ${orgId} points at messaging host ${pointer.app} but its secret is missing`);
    const res = await (this.deps.fetchImpl ?? fetch)(`http://[${pointer.privateIp}]:8080/v1/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-msg-host-secret': secret, 'x-msg-host-org': orgId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    const answer = await res.json().catch(() => null) as (T & { error?: string }) | null;
    if (!res.ok || !answer) throw new OrgMsgHostRefusal(res.status, answer?.error ?? 'The messaging machine gave no answer.');
    this.warm(orgId);
    return answer;
  }

  private async waitHealthy(pointer: OrgMsgHostPointer, timeoutMs: number): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const deadline = this.now() + timeoutMs;
    let lastError = 'no answer';
    for (;;) {
      try {
        const res = await fetchImpl(`http://[${pointer.privateIp}]:8080/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_MS) });
        const body = res.ok ? await res.json().catch(() => null) as { ok?: boolean } | null : null;
        if (body?.ok) return;
        lastError = `health answered ${res.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (this.now() >= deadline) throw new Error(`the messaging host ${pointer.app} did not become healthy: ${lastError}`);
      await sleep(HEALTH_PROBE_GAP_MS);
    }
  }
}
