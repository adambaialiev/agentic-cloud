import { randomBytes } from 'node:crypto';
import { FlyClient } from './fly-client.js';
import { GitHostClient } from './git-host-client.js';
import { GIT_USER_MAX_BYTES, gitUserMaxBytesForVolume } from '../types/git-repo.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';
import type { OrgGitService } from './org-git.js';

/**
 * Per-org git hosts (byo-git-design slice 2b): a client org's repos live on a
 * git host IN THAT ORG'S OWN FLY ACCOUNT — one small app, one machine, one
 * volume, no public address. The backend reaches it over the org's WireGuard
 * peer; agent machines reach it over the org's private network; flycast wakes
 * it on a push, so a quiet org's git host costs roughly its storage.
 *
 * RESOLUTION is layered exactly like the Fly context (org-fly.ts):
 *
 * - An org whose document carries `git.host` → its own host, its own per-org
 *   secret. The namespace is the orgId (stamped at provision).
 * - Anything else → the platform's env-configured central host (the seed).
 *   Org #0 lives here FOREVER by construction: its `git` stamp exists (the
 *   admin's userId, written by the slice-1 script) and `ensureOrgGitHost`
 *   refuses to touch an org that is already stamped — so the one org that
 *   must never migrate cannot be migrated by accident.
 *
 * PROVISIONING is lazy and idempotent: the first `repo create` in an
 * unstamped org with its own Fly connection builds the host, waits for it to
 * answer, stamps the org (namespace = orgId), and writes the pointer. Every
 * later call health-checks and returns.
 */

/** Volume + machine defaults; env-overridable where operations will want it. */
export const ORG_GIT_VOLUME_GB = Number(process.env.ORG_GIT_VOLUME_GB || 10);
export const ORG_GIT_SNAPSHOT_RETENTION_DAYS = Number(process.env.ORG_GIT_SNAPSHOT_RETENTION_DAYS || 14);
export const ORG_GIT_HOST_SECRET_NAME = 'GIT_HOST_SECRET';
/** One admin tap grows the volume by this much… */
export const ORG_GIT_VOLUME_GROW_GB = Number(process.env.ORG_GIT_VOLUME_GROW_GB || 10);
/** …up to this ceiling, past which growing is an operator conversation. */
export const ORG_GIT_VOLUME_MAX_GB = Number(process.env.ORG_GIT_VOLUME_MAX_GB || 100);

export interface OrgGitHostContext {
  source: 'org' | 'platform-env';
  baseUrl: string;
  controlUrl: string;
  secret: string;
}

/** What the Workspace's git block shows about an org's OWN host. */
export interface OrgGitHostFacts {
  app: string;
  /**
   * One short health probe, not a wait: 'waking' means the probe timed out —
   * which on a flycast address is the probe itself starting a stopped
   * machine, so the next look answers 'ok'.
   */
  health: 'ok' | 'waking' | 'unreachable';
  diskUsedPercent?: number;
  volumeSizeGb?: number;
  /** Fly's automatic daily volume snapshots — read live, never assumed. */
  snapshotRetentionDays?: number;
}

export class OrgGitHostError extends Error {}

export interface OrgGitHostServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext'>;
  orgGit: Pick<OrgGitService, 'stampOrgGitNamespace'>;
  /** The public image every client org pulls (ghcr…:git-host-sha-…). */
  gitHostImage?: string;
  /** The public API origin the host's verify callbacks dial. */
  backendUrl?: string;
  region: string;
  /** The platform seed — the central host. Absent only on backends without git. */
  platformEnv?: { baseUrl: string; controlUrl: string; secret: string };
  makeFlyClient?: (apiToken: string) => Pick<FlyClient,
    'createApp' | 'ensureFlycastIpv6' | 'listVolumes' | 'createVolume'
    | 'listMachines' | 'createMachine' | 'waitForMachineState'
    | 'getVolume' | 'extendVolume' | 'stopMachine'>;
  fetchImpl?: typeof fetch;
  /** Injectable clock for health polling in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Health-poll budget override (tests shrink it; the default eats a cold boot). */
  healthTimeoutMs?: number;
}

/** `iagit-` + the orgId's hex, the same shape every org-scoped app uses. */
export function orgGitAppName(orgId: string): string {
  return `iagit-${orgId.replace(/-/g, '').slice(0, 12)}`;
}

export class OrgGitHostService {
  private clients = new Map<string, { secret: string; baseUrl: string; client: GitHostClient }>();

  constructor(private readonly deps: OrgGitHostServiceDeps) {}

  /**
   * The git context an org acts in. Never provisions — resolution must be
   * cheap and safe to call from every repo route.
   */
  async resolveContext(orgId: string | null | undefined): Promise<OrgGitHostContext> {
    if (orgId) {
      const org = await this.deps.orgStorage.getOrg(orgId);
      const host = org?.git?.host;
      if (host) {
        const secret = await this.deps.orgSecrets.getOrgSecret(orgId, host.secretName ?? ORG_GIT_HOST_SECRET_NAME);
        if (!secret) {
          // No platform fallback for a pointed org — the org-fly.ts rule, for
          // the same reason: acting on the wrong host is the disaster class.
          throw new OrgGitHostError(
            `org ${orgId} points at git host ${host.app} but its secret is missing — re-provision to restore it`,
          );
        }
        const baseUrl = `http://[${host.flycastIp}]:8080`;
        return { source: 'org', baseUrl, controlUrl: baseUrl, secret };
      }
    }
    if (this.deps.platformEnv) {
      return { source: 'platform-env', ...this.deps.platformEnv };
    }
    throw new OrgGitHostError('no git host is configured on this backend');
  }

  /**
   * How many bytes this org's namespace may hold (note #62). On its OWN
   * volume the ceiling follows the disk it pays for, so growing the volume
   * grows what fits on it; on the shared box it stays the fair share, because
   * that disk is still shared and a fair share is still what is fair.
   *
   * Reads the org record straight rather than going through `resolveContext`,
   * on purpose: this is answered on the PUSH path, and a quota must not be
   * the thing that needs the host's secret to exist. A pointed org whose
   * backend-side secret has gone still gets an honest ceiling here, and the
   * missing secret surfaces where it actually matters — `clientFor`.
   */
  async userMaxBytesFor(orgId: string | null | undefined): Promise<number> {
    if (!orgId) return GIT_USER_MAX_BYTES;
    const org = await this.deps.orgStorage.getOrg(orgId);
    const host = org?.git?.host;
    if (!host) return GIT_USER_MAX_BYTES;
    return gitUserMaxBytesForVolume(host.volumeGb ?? ORG_GIT_VOLUME_GB);
  }

  /** A GitHostClient for the org's context, cached per resolved target. */
  async clientFor(orgId: string | null | undefined): Promise<GitHostClient> {
    const context = await this.resolveContext(orgId);
    const key = `${orgId ?? 'platform'}`;
    const cached = this.clients.get(key);
    if (cached && cached.secret === context.secret && cached.baseUrl === context.baseUrl) {
      return cached.client;
    }
    const client = new GitHostClient({
      baseUrl: context.baseUrl,
      controlUrl: context.controlUrl,
      secret: context.secret,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.clients.set(key, { secret: context.secret, baseUrl: context.baseUrl, client });
    return client;
  }

  /**
   * The facts the Workspace's git block shows — null for any org on the
   * central host (org #0, everyone unprovisioned). ONE short probe, never a
   * wait: this is a screen-open read, and a stopped host is not a fault (it
   * sleeps between pushes by design — the probe's own poke wakes it).
   */
  async describeHost(orgId: string): Promise<OrgGitHostFacts | null> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    const host = org?.git?.host;
    if (!host) return null;
    const facts: OrgGitHostFacts = { app: host.app, health: 'unreachable' };
    try {
      const context = await this.resolveContext(orgId);
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      const res = await fetchImpl(`${context.controlUrl}/health`, { signal: AbortSignal.timeout(2_500) });
      const body = res.ok ? await res.json().catch(() => null) as { ok?: boolean; diskUsedPercent?: number } | null : null;
      if (body?.ok) {
        facts.health = 'ok';
        if (typeof body.diskUsedPercent === 'number') facts.diskUsedPercent = body.diskUsedPercent;
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      facts.health = name === 'TimeoutError' || name === 'AbortError' ? 'waking' : 'unreachable';
    }
    // Volume size comes from the Fly API — always up, independent of whether
    // the machine sleeps. A nicety: the probe's answer stands without it.
    try {
      const fly = await this.deps.orgFly.resolveOrgFlyContext(orgId);
      if (fly.source === 'org') {
        const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
        const volume = await client.getVolume(host.app, host.volumeId);
        if (typeof volume.size_gb === 'number') facts.volumeSizeGb = volume.size_gb;
        if (typeof volume.snapshot_retention === 'number') facts.snapshotRetentionDays = volume.snapshot_retention;
      }
    } catch { /* size missing renders as just the health line */ }
    return facts;
  }

  /**
   * The grow-the-volume card's verb (byo-git-design "Cost, guardrails,
   * growth"): one admin tap grows the org host's volume by a step, on the
   * org's own bill. Volumes never shrink, so the step is modest and the
   * ceiling env-tunable.
   */
  async growVolume(orgId: string): Promise<{ sizeGb: number }> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    const host = org?.git?.host;
    if (!host) throw new OrgGitHostError('this workplace has no git host of its own — nothing to grow');
    const fly = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    if (fly.source !== 'org') {
      throw new OrgGitHostError('the workplace\'s own cloud account is not connected — its volume cannot be grown from here');
    }
    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
    const volume = await client.getVolume(host.app, host.volumeId);
    const current = typeof volume.size_gb === 'number' ? volume.size_gb : ORG_GIT_VOLUME_GB;
    const next = current + ORG_GIT_VOLUME_GROW_GB;
    if (next > ORG_GIT_VOLUME_MAX_GB) {
      throw new OrgGitHostError(
        `the volume is already ${current} GB — growing past ${ORG_GIT_VOLUME_MAX_GB} GB is a conversation with the platform, not a tap`,
      );
    }
    const { needsRestart } = await client.extendVolume(host.app, host.volumeId, next);
    if (needsRestart) {
      // The filesystem sees the new size after a restart. For an autostop
      // host a STOP is the whole move: the next request (a push, the next
      // screen open) starts it fresh on the grown disk. Best-effort — the
      // extend is already done, and the next natural sleep converges it.
      try {
        for (const machine of await client.listMachines(host.app)) {
          if (machine.state === 'started') await client.stopMachine(host.app, machine.id);
        }
      } catch { /* converges at the next autostop cycle */ }
    }
    // The grown size goes on the record, which is what moves the PUSH CEILING
    // with it (note #62). Before this, growing the volume bought disk the
    // quota would not let anyone use: 100 GB of volume, still 1 GB of repos.
    // Written after the extend Fly confirmed, never before it.
    await this.deps.orgStorage.updateOrg(orgId, {
      git: { ...org.git!, host: { ...host, volumeGb: next } },
    });
    return { sizeGb: next };
  }

  /**
   * The lazy trigger `repo create` calls: provision a git host for an org
   * that has NO git ground yet and its own Fly org to build in. Answers
   * whether anything changed, so the caller knows to re-resolve the
   * namespace. Stamped orgs (org #0, every org already provisioned) and orgs
   * without their own cloud are a quiet no — the central host serves them
   * exactly as before.
   */
  async maybeProvisionForOrg(orgId: string): Promise<boolean> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org || org.git) return false;
    try {
      await this.ensureOrgGitHost(orgId);
      return true;
    } catch (error) {
      if (error instanceof OrgGitHostError && /no Fly org of its own/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Build (or find healthy) the org's own git host. Refuses an org that is
   * already git-stamped — that stamp says its repos live somewhere, and
   * moving a namespace is not a thing a provisioning call may improvise.
   */
  async ensureOrgGitHost(orgId: string): Promise<OrgGitHostContext> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) throw new OrgGitHostError(`org ${orgId} does not exist`);
    if (org.git?.host) {
      const context = await this.resolveContext(orgId);
      await this.waitHealthy(context, this.deps.healthTimeoutMs ?? 30_000);
      return context;
    }
    if (org.git?.namespaceId) {
      throw new OrgGitHostError(
        `org ${orgId} already has git namespace "${org.git.namespaceId}" on the central host — refusing to provision a second home for it`,
      );
    }
    const fly = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    if (fly.source !== 'org') {
      throw new OrgGitHostError(
        `org ${orgId} has no Fly org of its own connected — a client git host lands only in the client's own cloud account`,
      );
    }
    if (!this.deps.gitHostImage) {
      throw new OrgGitHostError('FLY_GIT_HOST_IMAGE is not configured — cannot provision an org git host');
    }
    if (!this.deps.backendUrl) {
      throw new OrgGitHostError('the public backend URL is not configured — the host could never verify a token');
    }

    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
    const appName = orgGitAppName(orgId);

    try {
      await client.createApp({ appName, orgSlug: fly.orgSlug });
    } catch (error) {
      // An app that already exists is a resumed provision, not a failure.
      if (!/already|taken|exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    const flycastIp = await client.ensureFlycastIpv6(appName);
    if (!flycastIp) {
      throw new OrgGitHostError(`could not allocate a flycast address for ${appName}`);
    }

    const volumes = await client.listVolumes(appName);
    const volume = volumes.find((candidate) => candidate.name === 'gitdata')
      ?? await client.createVolume(appName, {
        name: 'gitdata',
        region: this.deps.region,
        sizeGb: ORG_GIT_VOLUME_GB,
        snapshotRetentionDays: ORG_GIT_SNAPSHOT_RETENTION_DAYS,
      });

    // Secret before machine: a machine booted with a secret nobody stored
    // could never be talked to; this order can crash midway and only ever
    // leave a secret with no machine, which the next call reuses.
    let secret = await this.deps.orgSecrets.getOrgSecret(orgId, ORG_GIT_HOST_SECRET_NAME);
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      await this.deps.orgSecrets.setOrgSecret(
        orgId,
        ORG_GIT_HOST_SECRET_NAME,
        secret,
        `Shared secret between the backend and this workplace's own git host (${appName})`,
      );
    }

    const machines = await client.listMachines(appName);
    let machine = machines[0];
    if (!machine) {
      machine = await client.createMachine(appName, {
        name: 'git-host',
        region: volume.region ?? this.deps.region,
        image: this.deps.gitHostImage,
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        env: {
          GIT_HOST_SECRET: secret,
          BACKEND_URL: this.deps.backendUrl,
          GIT_HOST_ORG: orgId,
          // The push webhook (slice 5): the hook signs with the same per-org
          // secret, and the backend picks which secret to check by the
          // payload's owner. Present from birth, so `repo ci enable` works
          // the day the org exists.
          CI_WEBHOOK_URL: `${this.deps.backendUrl.replace(/\/+$/, '')}/api/agent-cli/git/ci-webhook`,
          CI_WEBHOOK_SECRET: secret,
        },
        mounts: [{ volume: volume.id, path: '/data' }],
        // The proxy sees EVERY byte this machine serves, so autostop is
        // honest here (unlike agent machines — see FlyMachineService). The
        // port binding is what makes the flycast address answer at all — an
        // empty ports list leaves the proxy with nothing to listen on, which
        // the first live provision proved the hard way (2026-08-23).
        services: [{
          protocol: 'tcp',
          internal_port: 8080,
          ports: [{ port: 8080 }],
          autostart: true,
          autostop: 'stop',
        }],
      });
      await client.waitForMachineState(appName, machine.id, { state: 'started', timeoutSeconds: 60 });
    }

    const context: OrgGitHostContext = {
      source: 'org',
      baseUrl: `http://[${flycastIp}]:8080`,
      controlUrl: `http://[${flycastIp}]:8080`,
      secret,
    };
    await this.waitHealthy(context, this.deps.healthTimeoutMs ?? 90_000);

    // Stamp BEFORE the pointer: the namespace is what routes repos, and a
    // pointer without a stamp would send org-userId-namespaced lookups at a
    // host whose disk is orgId-namespaced.
    await this.deps.orgGit.stampOrgGitNamespace(orgId, orgId);
    await this.deps.orgStorage.updateOrg(orgId, {
      git: {
        namespaceId: orgId,
        host: {
          app: appName,
          flycastIp,
          volumeId: volume.id,
          // What the push ceiling is sized from (note #62). Fly's answer when
          // it gave one, the size we asked for otherwise — never left absent
          // on a host built after this shipped.
          volumeGb: typeof volume.size_gb === 'number' ? volume.size_gb : ORG_GIT_VOLUME_GB,
          secretName: ORG_GIT_HOST_SECRET_NAME,
        },
      },
    });
    return context;
  }

  /** Poll /health until it answers ok — flycast wakes the machine on the
   *  first request, so the first poll can eat a cold start. */
  private async waitHealthy(context: OrgGitHostContext, timeoutMs: number): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => { setTimeout(r, ms); }));
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no answer';
    for (;;) {
      try {
        const res = await fetchImpl(`${context.controlUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          const body = await res.json().catch(() => null) as { ok?: boolean } | null;
          if (body?.ok) return;
          lastError = `health answered ${JSON.stringify(body)}`;
        } else {
          lastError = `health answered ${res.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) {
        throw new OrgGitHostError(`the org git host did not become healthy: ${lastError}`);
      }
      await sleep(2_000);
    }
  }
}
