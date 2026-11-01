import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FlyClient, FlyMachineService } from './fly-client.js';
import type { FlyAppOrgContext } from './fly-app-org-context.js';
import type { FlySandboxClient } from './fly-sandbox-client.js';
import { buildFlySandboxId } from './fly-sandbox-id.js';
import type { DeploymentStorage } from './deployment-storage.js';
import { nameIsTaken } from './deployment-storage.js';
import type { DeploymentDocument, DeploymentPreset } from '../types/deployment.js';
import { validateDeploymentName } from '../types/deployment.js';

/**
 * Provisioning + management of PRODUCTION deployment machines
 * (docs/deployments-phase1.md). One paid Fly machine per deployment, at
 * `https://<name>.<apps-domain>`, booted from the app-runtime image
 * (infra/app-runtime-image/). Payment-bound lifecycle: the idle reaper and
 * recycler never touch `iapp-` apps; this service is the ONLY thing that
 * stops or destroys them.
 *
 * THE ADDRESS IS NOT IN DNS (2026-10-16, note #766). A site's name reaches
 * its machine the way an agent's preview link does: the zone's one proxied
 * wildcard record sends every `*.<apps-domain>` name to the preview-router
 * Worker, which asks the backend (`GET /api/preview-map/<name>`, answered
 * from the deployment records by PreviewDomainService) and forwards to
 * `<flyApp>.fly.dev`. So a deploy, a rename and a delete write no DNS record
 * and issue no certificate: the record IS the address, and `onNamesChanged`
 * tells the name map to re-read it. Until then every site had a grey-cloud
 * CNAME and a Fly certificate of its own, which cost one of the zone's 200
 * records (Cloudflare Free) per site and made the address trail the machine
 * by minutes. The `dns` client is kept only to clear what that era left
 * behind when such a site is destroyed or released. A customer's OWN domain
 * (addCustomDomain) is unchanged: their CNAME points at the Fly app directly
 * and Fly issues its certificate, exactly as before.
 */

/** Deployment app slugs. Distinct prefix from agent apps (`ia-<hex16>`). */
export const DEPLOYMENT_APP_PREFIX = 'iapp-';

/**
 * A custom hostname the owner may point at their site: a lowercase FQDN with
 * at least two labels. Our own zones are refused — `<name>.<apps-domain>` is
 * managed by rename/deploy, and *.fly.dev belongs to Fly.
 */
export function validateCustomHostname(hostname: string, appsDomain: string): string {
  const cleaned = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(cleaned)) {
    throw new Error(`"${hostname}" is not a valid hostname (something like app.example.com).`);
  }
  if (cleaned === appsDomain || cleaned.endsWith(`.${appsDomain}`)) {
    throw new Error(`"${cleaned}" is on ${appsDomain} — use \`agentbuilt rename\` for platform addresses.`);
  }
  if (cleaned.endsWith('.fly.dev')) {
    throw new Error(`"${cleaned}" is a Fly-managed address, not a domain you can point.`);
  }
  return cleaned;
}

export function isDeploymentAppName(appName: string | null | undefined): boolean {
  return typeof appName === 'string' && appName.startsWith(DEPLOYMENT_APP_PREFIX);
}

const PRESET_SPECS: Record<DeploymentPreset, {
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  volumeGb: number;
  /** The volume dir the sync writes and the entrypoint serves. */
  syncDir: string;
}> = {
  // 512 MB is a price-margin decision, not a tuning knob — a 1 GB machine
  // costs $5.92/mo and halves the $10 tier's margin (design doc, unit
  // economics). Do not bump without a new price; the answer to "more RAM"
  // is the service-pro rung.
  static: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 }, volumeGb: 1, syncDir: 'site' },
  service: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, volumeGb: 3, syncDir: 'app' },
  // Same volume as service ON PURPOSE: Fly volumes can grow but never
  // shrink, so keeping disk equal makes service→service-pro a pure guest
  // resize (and would keep a future downgrade possible at all).
  'service-pro': { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }, volumeGb: 3, syncDir: 'app' },
};

const DEPLOY_VOLUME_NAME = 'iaapp';
const DEPLOY_MOUNT_PATH = '/data';
const PUBLIC_PORT = 8080;

/**
 * Minimal Cloudflare DNS client for the apps zone (agentbuilt.app): reads and
 * deletes only. Nothing on the platform writes a record per name any more —
 * the wildcard record and the preview-router Worker carry every agent and
 * every site — so what is left is checking that a minted preview name is not
 * one of the zone's few remaining fixed records, and removing the record a
 * site from before 2026-10-16 still has when it goes.
 */
export class CloudflareAppsDns {
  constructor(
    private readonly token: string,
    private readonly zoneId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`https://api.cloudflare.com/client/v4/zones/${this.zoneId}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) {
      throw new Error(`Cloudflare DNS ${init.method} ${path} failed (${res.status}): ${JSON.stringify(body?.errors ?? body)}`);
    }
    return body;
  }

  async deleteTxt(name: string): Promise<void> {
    const existing = await this.request(`/dns_records?type=TXT&name.startsWith=${encodeURIComponent(name)}.`, { method: 'GET' });
    for (const record of existing?.result ?? []) {
      if (!record?.name?.startsWith(`${name}.`)) continue;
      await this.request(`/dns_records/${record.id}`, { method: 'DELETE' });
    }
  }

  async recordExists(name: string): Promise<boolean> {
    const existing = await this.request(`/dns_records?type=CNAME&name.startsWith=${encodeURIComponent(name)}.`, { method: 'GET' });
    return (existing?.result ?? []).some((r: any) => r?.name?.startsWith(`${name}.`));
  }

  async deleteCname(name: string): Promise<void> {
    const existing = await this.request(`/dns_records?type=CNAME&name.startsWith=${encodeURIComponent(name)}.`, { method: 'GET' });
    for (const record of existing?.result ?? []) {
      if (!record?.name?.startsWith(`${name}.`)) continue;
      await this.request(`/dns_records/${record.id}`, { method: 'DELETE' });
    }
  }
}

export interface DeploymentServiceOptions {
  fly: FlyClient;
  /**
   * App-level org resolution (byo-fly-design slice 5): which org's token,
   * slug, and peer this deployment's Fly resources use. The record's
   * `flyApp` is persisted BEFORE the app exists on Fly, so even the first
   * createApp resolves. When supplied, it must resolve every app; a null answer
   * or error fails closed. The static context is only for callers that do not
   * install organization routing (tests and standalone deployments).
   */
  resolveAppContext?: (appName: string) => Promise<FlyAppOrgContext | null>;
  /** Exec/upload transport — deployment machines speak the same sandbox-id protocol. */
  sandboxClient: FlySandboxClient;
  storage: DeploymentStorage;
  /**
   * Only for clearing the CNAME a site from before 2026-10-16 still has
   * when it is destroyed or released. Nothing is ever written.
   */
  dns: CloudflareAppsDns | null;
  orgSlug: string;
  region: string;
  /** The app-runtime image ref (FLY_APP_RUNTIME_IMAGE). */
  image: string;
  appsDomain: string;
  /**
   * Called whenever a site's name or where it routes changes — it went live,
   * was renamed, paused, resumed, destroyed or released — so the name map the
   * preview-router Worker reads (PreviewDomainService.invalidate) answers for
   * the new state at once instead of at its next scheduled rebuild.
   */
  onNamesChanged?: () => void;
  authorizedKeys?: string;
  backendPeerIp?: string;
  /**
   * Where first-deploy tarballs wait for payment (`<dir>/<deploymentId>.tgz`).
   * A `pending-payment` deploy stages its content here so fulfilment brings
   * the site up populated instead of empty. Unset → staging disabled (tests).
   */
  stagingDir?: string;
  /**
   * The values of a new site's `secretNames` (note #661), read for the agent
   * that deployed it — the same keys that agent's own turns are handed. Unset
   * means a site is provisioned without them (tests, dev).
   */
  resolveSecrets?: (deployment: DeploymentDocument) => Promise<Record<string, string>>;
  logger?: (message: string) => void;
}

export interface ProvisionResult {
  deployment: DeploymentDocument;
  url: string;
}

export class DeploymentService {
  /**
   * The Fly context this app's operations run in. With organization routing
   * installed, resolution must succeed: the platform token is never a valid
   * substitute because it can create a perfectly working app on the wrong
   * account and bill.
   */
  private async contextFor(appName: string): Promise<{
    client: FlyClient;
    orgSlug: string;
    backendPeerIp?: string;
  }> {
    if (this.opts.resolveAppContext) {
      const resolved = await this.opts.resolveAppContext(appName);
      if (!resolved) {
        throw new Error(`Fly app ${appName} has no organization context — refusing to use the platform Fly token`);
      }
      return resolved;
    }
    return {
      client: this.opts.fly,
      orgSlug: this.opts.orgSlug,
      ...(this.opts.backendPeerIp ? { backendPeerIp: this.opts.backendPeerIp } : {}),
    };
  }

  private readonly log: (message: string) => void;
  /**
   * In-flight provisions by deployment id. Paddle fires `subscription.created`
   * and `.activated` near-simultaneously after a checkout; without this, both
   * events read `pending-payment` and each builds a machine — one of them a
   * billed, unreferenced orphan.
   */
  private readonly provisionsInFlight = new Map<string, Promise<ProvisionResult>>();

  constructor(private readonly opts: DeploymentServiceOptions) {
    this.log = opts.logger ?? ((m) => console.log(`[deployments] ${m}`));
  }

  url(deployment: DeploymentDocument): string {
    return `https://${deployment.name}.${this.opts.appsDomain}`;
  }

  private namesChanged(): void {
    try {
      this.opts.onNamesChanged?.();
    } catch (error) {
      this.log(`name map not told of a change: ${(error as Error).message}`);
    }
  }

  private sandboxId(deployment: DeploymentDocument): string {
    if (!deployment.flyApp || !deployment.machineId) {
      throw new Error(`deployment ${deployment.name} has no machine`);
    }
    return buildFlySandboxId(deployment.flyApp, deployment.machineId);
  }

  /**
   * Create a record with no infrastructure. The billing layer (slice 3) moves
   * it to `provisioning` on payment; the operator script can force it on dev.
   */
  async createPending(args: {
    userId: string;
    orgId?: string;
    /** The deploying agent's explicit room (note #88); absent only on legacy callers. */
    roomId?: string;
    agentId: string;
    /** Who is deploying, remembered on the site (note #566). */
    lastDeployBy?: DeploymentDocument['lastDeployBy'];
    name: string;
    preset: DeploymentPreset;
    /** Saved secrets the site runs with (note #661) — names only. */
    secretNames?: string[];
  }): Promise<DeploymentDocument> {
    const nameError = validateDeploymentName(args.name);
    if (nameError) throw new Error(nameError);
    const existing = await this.opts.storage.getByName(args.name);
    if (nameIsTaken(existing)) throw new Error(`"${args.name}" is already taken.`);
    return this.opts.storage.create({ ...args, status: 'pending-payment' });
  }

  /**
   * Move a site to a new address. One record update, no infrastructure: the
   * name map answers the new name with the site's app and the old name with a
   * redirect to the new one, which the preview-router Worker serves as a 301
   * keeping the path and query (a visitor arriving mid-change, before the
   * edge has re-read the map, still lands on the site: the edge keeps an
   * answer for at most five minutes).
   *
   * The old address deliberately keeps working, forever. These links get
   * forwarded — into group chats, onto printed handouts — and a rename that
   * broke them would make "move this site" a destructive act disguised as a
   * cosmetic one. Releasing the old name back into a first-come namespace
   * would be worse than breaking it: someone else could claim it, and links
   * the owner handed out would then open a stranger's site. So the old name
   * follows the record (`formerNames`) and stays taken.
   *
   * A site from before 2026-10-16 still has a CNAME at its old name; it keeps
   * serving the site directly (two live addresses, never a broken link) until
   * the record is removed, which is an operator step, never a write here.
   */
  async rename(deploymentId: string, newName: string): Promise<{ deployment: DeploymentDocument; url: string; previousUrl: string }> {
    const doc = await this.opts.storage.get(deploymentId);
    if (!doc) throw new Error('no such deployment');
    if (doc.status === 'destroyed') throw new Error(`"${doc.name}" is gone — a destroyed site cannot be renamed.`);
    if (newName === doc.name) throw new Error(`"${doc.name}" is already its name.`);

    const nameError = validateDeploymentName(newName);
    if (nameError) throw new Error(nameError);
    const existing = await this.opts.storage.getByName(newName);
    // Its own former name is not a collision — that is this same site moving
    // back to an address it still answers on.
    if (nameIsTaken(existing) && existing!.id !== doc.id) throw new Error(`"${newName}" is already taken.`);

    const previousUrl = this.url(doc);
    const formerNames = [...(doc.formerNames ?? [])];
    // A site renamed A → B → A keeps one entry per address it answers on, and
    // the name it is called RIGHT NOW is never in the list.
    if (!formerNames.includes(doc.name)) formerNames.push(doc.name);
    await this.opts.storage.update(doc.id, {
      name: newName,
      formerNames: formerNames.filter((name) => name !== newName),
    });
    const updated = (await this.opts.storage.get(doc.id))!;
    this.namesChanged();
    this.log(`renamed ${doc.name} → ${newName} (${previousUrl} redirects)`);
    return { deployment: updated, url: this.url(updated), previousUrl };
  }

  /**
   * Create the machine for a record: app → IPs → volume → machine. No DNS
   * and no certificate: the name map routes the name to the app as soon as
   * the record is live. Failure rolls infra back and returns the record to
   * its prior status, so a retry starts clean.
   */
  async provision(deploymentId: string): Promise<ProvisionResult> {
    const inFlight = this.provisionsInFlight.get(deploymentId);
    if (inFlight) return inFlight;
    const run = this.provisionOnce(deploymentId).finally(() => {
      this.provisionsInFlight.delete(deploymentId);
    });
    this.provisionsInFlight.set(deploymentId, run);
    return run;
  }

  private async provisionOnce(deploymentId: string): Promise<ProvisionResult> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment) throw new Error(`no deployment ${deploymentId}`);
    if (deployment.status === 'live') return { deployment, url: this.url(deployment) };

    const priorStatus = deployment.status;
    const spec = PRESET_SPECS[deployment.preset];
    const appName = `${DEPLOYMENT_APP_PREFIX}${randomBytes(6).toString('hex')}`;
    // flyApp BEFORE any Fly resource exists (the sandbox client's onAppNamed
    // pattern): the app→org resolver reads it off this record, so even the
    // first createApp already runs in the owning org's context. On a failed
    // provision the app is destroyed and a retry overwrites this with a
    // fresh name, so a stale value never points at anything alive.
    await this.opts.storage.update(deployment.id, { status: 'provisioning', flyApp: appName });

    try {
      // Read before any Fly resource exists: a site that should run with a
      // key and cannot get one fails here, cleanly, instead of coming up
      // live and broken.
      const secretEnv = deployment.secretNames?.length && this.opts.resolveSecrets
        ? await this.opts.resolveSecrets(deployment)
        : {};
      const context = await this.contextFor(appName);
      this.log(`provisioning ${deployment.name} (${deployment.preset}) as ${appName} in ${context.orgSlug}`);
      await context.client.createApp({ appName, orgSlug: context.orgSlug });
      // The Worker reaches the app at `<app>.fly.dev`, which needs the shared
      // IPv4. The IPv6 is free, and load-bearing for a customer's own domain:
      // Fly never completes that certificate's validation without one (E2E
      // 2026-08-04).
      await context.client.ensureSharedIpv4(appName);
      await context.client.ensureDedicatedIpv6(appName);

      const volume = await context.client.createVolume(appName, {
        name: DEPLOY_VOLUME_NAME,
        region: this.opts.region,
        sizeGb: spec.volumeGb,
      });
      // Platform env last, so no saved secret can shadow it.
      const env: Record<string, string> = { ...secretEnv, PUBLIC_PORT: String(PUBLIC_PORT) };
      if (this.opts.authorizedKeys) env.AUTHORIZED_KEYS = this.opts.authorizedKeys;
      // The image firewall pins SSH to the backend's peer INTO THIS ORG.
      if (context.backendPeerIp) env.BACKEND_PEER_IP = context.backendPeerIp;
      const machine = await context.client.createMachine(appName, {
        region: this.opts.region,
        image: this.opts.image,
        guest: spec.guest,
        env,
        mounts: [{ volume: volume.id, path: DEPLOY_MOUNT_PATH }],
        services: [publicHttpsService(PUBLIC_PORT)],
      });
      await (await this.contextFor(appName)).client.waitForMachineState(appName, machine.id, { state: 'started' });
      // `live` is what puts the name in the map — and what starts every
      // check of the address (the CLI's, the announcement's), which the
      // Worker answers from the map on the first visit: a miss is never
      // cached at the edge, and the map re-reads the records for a name it
      // does not know.
      await this.opts.storage.update(deployment.id, {
        status: 'live',
        flyApp: appName,
        machineId: machine.id,
        volumeId: volume.id,
      });
      this.namesChanged();
      const updated = (await this.opts.storage.get(deployment.id))!;
      this.log(`provisioned ${deployment.name} → ${this.url(updated)}`);
      // A tarball staged before payment goes up now, so the paid-for URL never
      // serves an empty machine. Best-effort: the machine is live either way,
      // and the agent's next `agentbuilt deploy` re-syncs.
      const staged = await this.readStagedTarball(deployment.id);
      if (staged) {
        try {
          await this.syncTarball(deployment.id, staged);
          await this.clearStagedTarball(deployment.id);
          this.log(`synced staged content to ${deployment.name} (${Math.round(staged.length / 1024)} kB)`);
        } catch (error) {
          this.log(`staged sync to ${deployment.name} failed (content stays staged): ${(error as Error).message}`);
        }
      }
      return { deployment: updated, url: this.url(updated) };
    } catch (error) {
      this.log(`provision of ${deployment.name} failed: ${(error as Error).message}; rolling back ${appName}`);
      await this.destroyInfra(appName).catch((cleanupError) =>
        this.log(`rollback of ${appName} also failed: ${(cleanupError as Error).message}`));
      await this.opts.storage.update(deployment.id, { status: priorStatus });
      throw error;
    }
  }

  /**
   * Push a gzipped tarball of the app into place and bounce the workload.
   * The upload lands in /tmp (rootfs) and is unpacked next to the live dir on
   * the volume, then atomically swapped — a failed unpack never breaks the
   * running site.
   */
  async syncTarball(deploymentId: string, tarGz: Buffer): Promise<void> {
    const deployment = await this.requireLive(deploymentId);
    const spec = PRESET_SPECS[deployment.preset];
    const dir = `${DEPLOY_MOUNT_PATH}/${spec.syncDir}`;
    const sandboxId = this.sandboxId(deployment);
    // The whole upload+swap is retried once as a unit: the first SSH exchange
    // after a machine wake sometimes dies on stream teardown (observed on the
    // 2026-08-05 E2E; an immediate retry always succeeded). Both halves are
    // idempotent — the upload rewrites /tmp/deploy.tgz and the swap script
    // starts by clearing its own scratch dirs.
    const attempts = 2;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.opts.sandboxClient.uploadToSandbox(sandboxId, [
          { path: '/tmp/deploy.tgz', content: tarGz },
        ], { sshUser: 'root' });
        const result = await this.opts.sandboxClient.execSync(sandboxId, [
          `rm -rf ${dir}.new ${dir}.old`,
          `mkdir -p ${dir}.new`,
          `tar -xzf /tmp/deploy.tgz -C ${dir}.new`,
          `chown -R app:app ${dir}.new`,
          `(mv ${dir} ${dir}.old 2>/dev/null || true)`,
          `mv ${dir}.new ${dir}`,
          `rm -rf ${dir}.old /tmp/deploy.tgz`,
          `(kill "$(cat ${DEPLOY_MOUNT_PATH}/app.pid 2>/dev/null)" 2>/dev/null || true)`,
        ].join(' && '), undefined, { sshUser: 'root', timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
          throw new Error(`deploy sync failed (${result.exitCode}): ${result.stderr || result.stdout}`);
        }
        break;
      } catch (error) {
        if (attempt >= attempts) throw error;
        this.log(`sync to ${deployment.name} failed (attempt ${attempt}/${attempts}), retrying: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await this.opts.storage.update(deployment.id, { lastDeployAt: new Date().toISOString() });
  }

  /**
   * Set a live service's saved secrets as its machine env (note #661):
   * `previousNames` come off, `secrets` go on, platform env is untouched.
   * Fly applies an env change by restarting the machine — a few seconds, the
   * volume rides through — so an unchanged env is left alone and a redeploy
   * that changes no key costs no restart. Returns whether it restarted.
   */
  async setSecretEnv(
    deploymentId: string,
    secrets: Record<string, string>,
    previousNames: readonly string[],
  ): Promise<boolean> {
    const deployment = await this.requireLive(deploymentId);
    if (!deployment.flyApp || !deployment.machineId) {
      throw new Error(`deployment ${deployment.name} has no machine`);
    }
    const context = await this.contextFor(deployment.flyApp);
    const machine = await context.client.getMachine(deployment.flyApp, deployment.machineId);
    const current: Record<string, string> = { ...(machine.config?.env ?? {}) };
    const next: Record<string, string> = { ...current };
    for (const name of previousNames) delete next[name];
    Object.assign(next, secrets);
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
    if ([...keys].every((key) => current[key] === next[key])) return false;
    await context.client.updateMachine(deployment.flyApp, deployment.machineId, {
      ...machine.config,
      env: next,
    });
    await context.client.waitForMachineState(deployment.flyApp, deployment.machineId, { state: 'started' });
    this.log(`secrets on ${deployment.name} now: ${Object.keys(secrets).sort().join(', ') || '(none)'}`);
    return true;
  }

  /** Park a first-deploy tarball until payment provisions the machine. */
  async stageTarball(deploymentId: string, tarGz: Buffer): Promise<void> {
    const file = this.stagedTarballPath(deploymentId);
    if (!file) throw new Error('tarball staging is not configured (stagingDir unset)');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, tarGz, { mode: 0o600 });
  }

  async readStagedTarball(deploymentId: string): Promise<Buffer | null> {
    const file = this.stagedTarballPath(deploymentId);
    if (!file) return null;
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async clearStagedTarball(deploymentId: string): Promise<void> {
    const file = this.stagedTarballPath(deploymentId);
    if (!file) return;
    await rm(file, { force: true });
  }

  private stagedTarballPath(deploymentId: string): string | null {
    if (!this.opts.stagingDir) return null;
    // Deployment ids are UUIDs we minted, but basename() keeps a corrupted id
    // from ever escaping the staging dir.
    return path.join(this.opts.stagingDir, `${path.basename(deploymentId)}.tgz`);
  }

  /** Kill the workload pid; the machine's supervisor respawns it in ~2s. */
  async restart(deploymentId: string): Promise<void> {
    const deployment = await this.requireLive(deploymentId);
    const result = await this.opts.sandboxClient.execSync(
      this.sandboxId(deployment),
      `kill "$(cat ${DEPLOY_MOUNT_PATH}/app.pid 2>/dev/null)" 2>/dev/null || true`,
      undefined,
      { sshUser: 'root', timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`restart failed: ${result.stderr || result.stdout}`);
    }
  }

  /**
   * Move a live deployment onto another preset's machine size, in place: Fly
   * applies a guest change by rebooting the machine, the volume (and the
   * app's content on it) rides through. Disk is untouched — the preset table
   * keeps service/service-pro volumes equal precisely so this stays a pure
   * resize. Driven by the billing webhook AFTER the subscription switched.
   */
  /**
   * Serve the site on the owner's OWN hostname beside `<name>.<apps-domain>`
   * (byo-fly-design slice 5: custom domains as a first-class verb). We issue
   * the certificate on the site's Fly app — in whatever org it lives —
   * and hand back the exact CNAME the owner must create; their DNS is theirs
   * to edit, so the record is an instruction, never something we write.
   * Idempotent: re-adding refreshes the instruction for a hostname mid-setup.
   */
  async addCustomDomain(deploymentId: string, hostname: string): Promise<{ hostname: string; cnameTarget: string }> {
    const doc = await this.opts.storage.get(deploymentId);
    if (!doc) throw new Error('no such deployment');
    if (doc.status !== 'live' || !doc.flyApp) {
      throw new Error(`"${doc.name}" is not serving yet — a custom domain needs a live site.`);
    }
    const cleaned = validateCustomHostname(hostname, this.opts.appsDomain);
    const context = await this.contextFor(doc.flyApp);
    await context.client.addCertificate(doc.flyApp, cleaned);
    const cnameTarget = await this.certificateCnameTarget(doc.flyApp, cleaned);
    const customDomains = doc.customDomains ?? [];
    if (!customDomains.includes(cleaned)) {
      await this.opts.storage.update(doc.id, { customDomains: [...customDomains, cleaned] });
    }
    this.log(`custom domain ${cleaned} added to ${doc.name} (CNAME → ${cnameTarget})`);
    return { hostname: cleaned, cnameTarget };
  }

  /** Fly's live view of each custom hostname's certificate, instruction included. */
  async customDomainStatus(deploymentId: string): Promise<Array<{
    hostname: string;
    configured: boolean;
    clientStatus: string;
    cnameTarget: string;
  }>> {
    const doc = await this.opts.storage.get(deploymentId);
    if (!doc) throw new Error('no such deployment');
    if (!doc.flyApp || !doc.customDomains?.length) return [];
    const context = await this.contextFor(doc.flyApp);
    const statuses = [];
    for (const hostname of doc.customDomains) {
      const cert = await context.client.getCertificate(doc.flyApp, hostname).catch(() => null);
      statuses.push({
        hostname,
        configured: Boolean(cert?.configured),
        clientStatus: cert?.clientStatus ?? 'Unknown',
        cnameTarget: await this.certificateCnameTarget(doc.flyApp, hostname).catch(() => `${doc.flyApp}.fly.dev`),
      });
    }
    return statuses;
  }

  async removeCustomDomain(deploymentId: string, hostname: string): Promise<void> {
    const doc = await this.opts.storage.get(deploymentId);
    if (!doc) throw new Error('no such deployment');
    const cleaned = hostname.trim().toLowerCase();
    if (doc.flyApp) {
      const context = await this.contextFor(doc.flyApp);
      await context.client.deleteCertificate(doc.flyApp, cleaned);
    }
    if (doc.customDomains?.includes(cleaned)) {
      await this.opts.storage.update(doc.id, {
        customDomains: doc.customDomains.filter((existing) => existing !== cleaned),
      });
    }
    this.log(`custom domain ${cleaned} removed from ${doc.name}`);
  }

  async resize(deploymentId: string, preset: DeploymentPreset): Promise<void> {
    const deployment = await this.requireLive(deploymentId);
    if (deployment.preset === preset) return;
    if (!deployment.flyApp || !deployment.machineId) {
      throw new Error(`deployment ${deployment.name} has no machine to resize`);
    }
    const spec = PRESET_SPECS[preset];
    const context = await this.contextFor(deployment.flyApp);
    const machine = await context.client.getMachine(deployment.flyApp, deployment.machineId);
    await context.client.updateMachine(deployment.flyApp, deployment.machineId, {
      ...machine.config,
      guest: spec.guest,
    });
    await context.client.waitForMachineState(deployment.flyApp, deployment.machineId, { state: 'started' });
    await this.opts.storage.update(deployment.id, { preset });
    this.log(`resized ${deployment.name} to ${preset} (${spec.guest.memory_mb} MB)`);
  }

  async readLogs(deploymentId: string, lines = 100): Promise<string> {
    const deployment = await this.requireLive(deploymentId);
    const capped = Math.max(1, Math.min(lines, 1000));
    const result = await this.opts.sandboxClient.execSync(
      this.sandboxId(deployment),
      `tail -n ${capped} ${DEPLOY_MOUNT_PATH}/logs/app.log 2>/dev/null || true`,
      undefined,
      { sshUser: 'root', timeoutMs: 30_000 },
    );
    return result.stdout;
  }

  /** Dunning stop: machine off, data kept, record marked lapsed. */
  async stopForLapse(deploymentId: string): Promise<void> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment?.flyApp || !deployment.machineId) return;
    await (await this.contextFor(deployment.flyApp)).client.stopMachine(deployment.flyApp, deployment.machineId);
    await this.opts.storage.update(deployment.id, {
      status: 'payment-lapsed',
      lapsedAt: new Date().toISOString(),
    });
    this.namesChanged();
  }

  /** Payment recovered (or operator restore): machine back on. */
  async resume(deploymentId: string): Promise<void> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment?.flyApp || !deployment.machineId) return;
    await (await this.contextFor(deployment.flyApp)).client.startMachine(deployment.flyApp, deployment.machineId);
    await this.opts.storage.update(deployment.id, { status: 'live', lapsedAt: undefined });
    this.namesChanged();
    // A deploy made while the site was paused staged its content instead of
    // syncing (no machine to sync to) — deliver it now the machine is back.
    const staged = await this.readStagedTarball(deployment.id);
    if (staged) {
      try {
        await this.syncTarball(deployment.id, staged);
        await this.clearStagedTarball(deployment.id);
        this.log(`synced staged content to resumed ${deployment.name}`);
      } catch (error) {
        this.log(`staged sync to resumed ${deployment.name} failed (content stays staged): ${(error as Error).message}`);
      }
    }
  }

  /**
   * A deleted workplace's site (owner, 2026-09-22): every address it answered
   * on — its name and any it was renamed from — is handed back and the record
   * goes, so the names are free for anyone. Its Fly app is NOT touched: it is
   * in the workplace's own cloud account, and removing it there is the
   * customer's call. Idempotent; a missing record is already released.
   */
  async release(deploymentId: string): Promise<void> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment) return;
    const names = [...new Set([deployment.name, ...deployment.formerNames ?? []])];
    // The certificates for our hostnames come off the app first. They are
    // ours, not the customer's — a hostname on this platform's domain — and
    // left on the app they would hold the name: the next site to take it
    // would find its certificate already "added" somewhere it cannot use.
    // Only an account the platform can no longer reach at all (the token was
    // revoked or the organization is gone) is let through without it.
    if (deployment.flyApp && deployment.status !== 'destroyed') {
      const context = await this.contextFor(deployment.flyApp).catch((error) => {
        this.log(`certificates on ${deployment.flyApp} left: its account cannot be reached (${(error as Error).message})`);
        return null;
      });
      for (const name of context ? names : []) {
        await context!.client.deleteCertificate(deployment.flyApp, `${name}.${this.opts.appsDomain}`);
      }
    }
    // Then any DNS a pre-2026-10-16 site still has, strictly: a name handed
    // back while a record of its own still points at the old app would send
    // the next owner's visitors there. A failure here stops the release, and
    // the purge tries again. A newer site has no record, and these are no-ops.
    if (this.opts.dns) {
      for (const name of names) await this.opts.dns.deleteCname(name);
    }
    await this.clearStagedTarball(deployment.id).catch(() => undefined);
    await this.opts.storage.delete(deployment.id);
    this.namesChanged();
    this.log(`released ${deployment.name}${deployment.flyApp ? ` (app ${deployment.flyApp} left in its cloud account)` : ''}`);
  }

  /**
   * Full teardown: machine, volume, app, and the CNAME a pre-2026-10-16 site
   * still has. Record kept as tombstone; the name leaves the map with the
   * status, so the address answers "No such preview." from the next edge
   * lookup.
   */
  async destroy(deploymentId: string): Promise<void> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment) return;
    if (deployment.flyApp) {
      await this.destroyInfra(deployment.flyApp);
      if (this.opts.dns) {
        await this.opts.dns.deleteCname(deployment.name).catch((error) =>
          this.log(`DNS cleanup for ${deployment.name} failed: ${(error as Error).message}`));
      }
    }
    await this.opts.storage.update(deployment.id, {
      status: 'destroyed',
      destroyedAt: new Date().toISOString(),
    });
    this.namesChanged();
    await this.clearStagedTarball(deployment.id).catch(() => undefined);
    this.log(`destroyed ${deployment.name}`);
  }

  /**
   * The CNAME a customer creates for their own hostname: `<token>.<app>.fly.dev`,
   * with the token parsed out of the certificate's `dnsValidationTarget`
   * (`<hostname>.<token>.flydns.net.`). Falls back to plain `<app>.fly.dev`
   * (which still routes — TLS then needs manual attention) rather than
   * failing the request.
   */
  private async certificateCnameTarget(appName: string, hostname: string): Promise<string> {
    // Fly populates dnsValidationTarget asynchronously after addCertificate —
    // observed empty on the immediate read (E2E #2, 2026-08-05), populated a
    // few seconds later. Poll briefly before falling back.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const cert = await (await this.contextFor(appName)).client.getCertificate(appName, hostname);
        const target = cert?.dnsValidationTarget ?? '';
        const match = target.match(new RegExp(`^${hostname.replace(/\./g, '\\.')}\\.([a-z0-9]+)\\.flydns\\.net\\.?$`));
        if (match) {
          return `${match[1]}.${appName}.fly.dev`;
        }
      } catch (error) {
        this.log(`certificate lookup for ${hostname} failed (${(error as Error).message}); retrying`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    this.log(`WARNING: no validation token for ${hostname} after retries; the CNAME instruction falls back to ${appName}.fly.dev (TLS will need manual attention)`);
    return `${appName}.fly.dev`;
  }

  private async destroyInfra(appName: string): Promise<void> {
    const machines = await (await this.contextFor(appName)).client.listMachines(appName).catch(() => []);
    for (const machine of machines) {
      await (await this.contextFor(appName)).client.deleteMachine(appName, machine.id, { force: true }).catch(() => undefined);
    }
    await (await this.contextFor(appName)).client.deleteApp(appName).catch(() => undefined);
  }

  private async requireLive(deploymentId: string): Promise<DeploymentDocument> {
    const deployment = await this.opts.storage.get(deploymentId);
    if (!deployment) throw new Error(`no deployment ${deploymentId}`);
    if (deployment.status !== 'live') {
      throw new Error(`deployment ${deployment.name} is ${deployment.status}, not live`);
    }
    return deployment;
  }
}

/**
 * Same shape FlySandboxClient bakes into agent machines: 443 (tls+http) and
 * 80 (http, force_https) forwarding to the app's public port.
 */
function publicHttpsService(internalPort: number): FlyMachineService {
  return {
    protocol: 'tcp',
    internal_port: internalPort,
    // A visitor's request must boot a stopped site machine. Fly's documented
    // default when unspecified is autostart on, autostop off — and a site
    // did wake that way on 2026-10-16 — but the Machines API does not promise
    // it, so say it (Rosa's review). Autostop stays absent: a site is meant
    // to run around the clock; nothing of ours stops it.
    autostart: true,
    ports: [
      { port: 443, handlers: ['tls', 'http'] },
      { port: 80, handlers: ['http'], force_https: true },
    ],
  } as FlyMachineService;
}
