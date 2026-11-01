import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { DEFAULT_AGENT_MACHINE_SIZE, machineCpuKindEnv } from '../config/agent-machine-sizes.js';
import { DEFAULT_DEVELOPMENT_SSH_USER } from './development-root.js';
import type { FlyAppOrgContext } from './fly-app-org-context.js';
import {
  FlyApiError,
  FlyClient,
  type CreateFlyMachineArgs,
  type FlyMachine,
  type FlyMachineGuest,
  type FlyMachineRootfs,
  type FlyMachineMount,
  type FlyMachineService,
  mapFlyMachine,
} from './fly-client.js';
import { buildFlySandboxId, parseFlySandboxId } from './fly-sandbox-id.js';
import { SshClient } from './ssh-client.js';
import { quoteShellArg } from '../utils/shell-quote.js';
import type { CreatedDevelopmentServer } from './sandbox-client.js';
import type { CloudReservationQuote, CloudServer } from './cloud-provider.js';
import type { SshUploadFile } from './ssh-client.js';
import type {
  ExecSyncOptions,
  ExecSyncResult,
  SandboxInfo,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions,
} from './sandbox-types.js';

/**
 * Fly.io Machines implementation of {@link WorkspaceProvisioningClient} /
 * {@link WorkspaceRuntimeClient}. Mirrors the retired Hetzner runtime client,
 * differing only where Fly's model does:
 *
 * - **App-per-agent on the org's DEFAULT 6PN network.** Each agent gets its OWN
 *   fresh Fly app holding exactly one machine + one volume. The public URL is an
 *   app-level resource (`https://<app>.fly.dev`), so a shared app would make
 *   fly-proxy load-balance the URL across every machine in it — two agents in one
 *   app served each other's site on a coin flip. A dedicated app per agent gives
 *   each agent its own exclusive hostname. Apps are NOT placed on a per-user
 *   custom network: the backend's single WireGuard peer only routes the org
 *   default network (`AllowedIPs = fdaa:99:600e::/48`), so machines on custom
 *   networks were unreachable over 6PN (verified: SSH to :2222 black-holed).
 *   Cross-tenant isolation lives in the machine image as an nftables firewall
 *   pinning SSH ingress to the backend's peer (`BACKEND_PEER_IP`). The app slug is
 *   opaque (never embeds telegram/user ids, which would leak into `*.fly.dev`
 *   hostnames).
 * - **No bootstrap step.** The baked machine image (`FLY_MACHINE_IMAGE`) is the
 *   environment, so provisioning behaves like "already prepared" — no SSH
 *   `apt`/`npm` round-trip.
 * - **SSH over the private 6PN IPv6 on port 2222** (Fly's hallpass owns :22),
 *   as `agent` for dev/harness work and `root` for admin.
 * - **Wake-on-connect.** Stopped machines don't reserve capacity, so every exec
 *   path starts the machine and waits for `started` (with retries) before
 *   handing out a connection target.
 */

// Amsterdam, not Frankfurt: same latency class for European users, and cheaper
// per hour for the shape we run (it was ~13% on the shared-2x/4GB this fleet
// used to be). Volumes are region-bound, so this only affects machines created
// from here on — existing agents stay where they are until they are rebuilt.
const DEFAULT_FLY_REGION = 'ams';
// Small on purpose: volumes bill on PROVISIONED size whether or not the machine
// ever runs again, so the initial size is the floor under every abandoned agent.
// Auto-extend (below) covers the heavy case, so this no longer has to be a bet
// on the largest repo anyone might clone.
const DEFAULT_FLY_VOLUME_SIZE_GB = 5;
// Grow by 5GB whenever the volume passes 80% full, up to 50GB. The threshold
// leaves headroom for the write that triggered it — extending at 95% would race
// the ENOSPC it is meant to prevent.
const DEFAULT_FLY_VOLUME_EXTEND_THRESHOLD_PERCENT = 80;
const DEFAULT_FLY_VOLUME_EXTEND_INCREMENT_GB = 5;
const DEFAULT_FLY_VOLUME_SIZE_LIMIT_GB = 50;
const DEFAULT_FLY_SSH_PORT = 2222;

// Public ports fly-proxy terminates for an exposed HTTPS service.
const FLY_PUBLIC_HTTPS_PORT = 443;
const FLY_PUBLIC_HTTP_PORT = 80;
// The internal port a machine boots publish-ready on. A 443/80 → this-port
// service is baked into the INITIAL machine config at create (so publishing
// needs NO later reboot — setting services on a running machine reboots it),
// and the image firewall accepts this port by default (PUBLIC_PORT env). At
// task time the agent just listens on 0.0.0.0:${DEFAULT_FLY_PUBLIC_PORT} and its
// `https://<app>.fly.dev` is instantly live.
const DEFAULT_FLY_PUBLIC_PORT = 8080;
// One port per line; read by the image entrypoint on every boot to re-open the
// firewall for each (a runtime nft rule is lost when the machine reboots).
const FLY_EXPOSED_PORTS_FILE = '/data/exposed-ports';
// Ports the machine already owns and must never be re-published to the world:
// 22 is Fly's hallpass, 2222 is our own sshd.
const FLY_RESERVED_EXPOSE_PORTS = new Set([22, 2222]);
/**
 * DEDICATED cores, not shared (Owner's call, 2026-08-17). An agent machine
 * runs a coding harness and its test suites, which is exactly the shape shared
 * vCPUs are worst at: the burst allowance is generous until it is spent, and
 * then the machine is throttled for as long as the load lasts.
 *
 * Measured on Alex's `shared-2x` before the fleet moved: **91–94% steal** under
 * sustained load, with two busy workers between them getting 7.5% of one core —
 * LESS total CPU than one worker got. The same suite took 740s there and 156s
 * on a fresh CI machine; on an unthrottled 4x box, 39s. Every one of those
 * agents was reading the slowness as a bug in the code or a memory limit, and
 * spending its turns on it.
 *
 * Machines are stopped while idle, and Fly bills CPU/RAM only while a machine
 * runs — so what a dedicated core costs is the hours an agent is actually
 * awake, and the throttling it removes was costing whole turns.
 */
// Derived from the one ladder rather than written a second time (note #268):
// the size new machines are built at and the size the picker calls standard
// are the same fact, and a second literal here is how they would drift.
const DEFAULT_FLY_GUEST: FlyMachineGuest = {
  cpu_kind: DEFAULT_AGENT_MACHINE_SIZE.cpuKind,
  cpus: DEFAULT_AGENT_MACHINE_SIZE.cpus,
  memory_mb: DEFAULT_AGENT_MACHINE_SIZE.memoryMb,
};
// rootfs.persist "restart": apt installs survive the idle reaper's stop/start
// cycles (Fly's default wipes the rootfs on EVERY start, not just image rolls),
// while image rolls still boot a clean rootfs. /data remains the only durable
// storage — Fly may still rebuild a persisted rootfs for host maintenance.
const DEFAULT_FLY_ROOTFS: FlyMachineRootfs = { persist: 'restart' };
const FLY_VOLUME_NAME = 'iahome';
const FLY_MACHINE_MOUNT_PATH = '/data';

const DEFAULT_FLY_CREATE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FLY_WAIT_STATE_TIMEOUT_SECONDS = 60;
const DEFAULT_FLY_WAKE_TIMEOUT_MS = 90_000;
// How long a wake keeps trying while Fly answers 412 "machine still stopping,
// refusing to start" (note #763). A machine the reaper put to sleep can sit in
// that state for minutes: on 2026-10-16 one was recorded stopped at 08:54:09,
// refused every start until past 08:58:33, and started first time at
// 09:00:19 — the ordinary 90-second window gave up in the middle of it. Only
// that refusal earns the longer wait; any other failure keeps the window above.
const DEFAULT_FLY_WAKE_STOPPING_TIMEOUT_MS = 5 * 60_000;
// After this long of "still stopping" the wake asks Fly to KILL the machine
// (stop with SIGKILL, 5 s) and goes on asking for the start. Chosen by the
// owner on 2026-10-16 after a stop that outlasted the five minutes above: a
// stop that has not finished in a minute is a hung stop, and the machine was
// idle when it was asked to stop, so a kill loses nothing a stop was keeping.
const DEFAULT_FLY_WAKE_FORCE_STOP_AFTER_MS = 60_000;
const DEFAULT_FLY_WAKE_POLL_INTERVAL_MS = 2_000;

// After Fly reports a machine `started`, its init is up but OUR image entrypoint
// (volume/home setup, host keys, authorized_keys, nftables firewall) still has to
// run before sshd listens on :2222 — several seconds. Waking blindly and SSHing
// immediately races that and surfaces `ECONNREFUSED`, which the harness treats as
// non-recoverable. These bound a post-wake TCP readiness probe on :2222.
const DEFAULT_FLY_WAKE_READINESS_TIMEOUT_MS = 45_000;
const DEFAULT_FLY_WAKE_READINESS_PROBE_INTERVAL_MS = 1_000;
// Defense-in-depth for the residual race between "port accepts TCP" and "sshd is
// ready for auth": a transient connect error right after wake is retried a few
// times before surfacing. Genuinely unreachable machines still fail (bounded).
const DEFAULT_FLY_CONNECT_RETRY_ATTEMPTS = 3;
const DEFAULT_FLY_CONNECT_RETRY_BACKOFF_MS = 1_000;

/** Outcome of provisioning one machine inside a user's shared Fly app. */
export interface CreatedFlyAgentMachine {
  sandboxId: string;
  appName: string;
  machineId: string;
  region: string;
  server: CloudServer;
}

/** Outcome of exposing a machine's internal port to the public internet. */
export interface FlyPortExposureResult {
  /** Public URL fly-proxy serves the exposed service at, e.g. `https://ia-….fly.dev`. */
  url: string;
  /** The internal port that is now published. */
  port: number;
  appName: string;
}

/** Outcome of removing a machine's public exposure for a port. */
export interface FlyPortUnexposureResult {
  port: number;
  appName: string;
  /** How many services remain exposed on the machine after removal. */
  remaining: number;
}

/** SSH connection settings for reaching a specific Fly machine (post-wake). */
export interface ResolvedFlySshConnection {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
}

export interface FlySandboxClientOptions {
  apiToken: string;
  orgSlug: string;
  machineImage: string;
  /** Backend SSH *public* key injected as `AUTHORIZED_KEYS` for `agent`+`root`. */
  sshPublicKey?: string;
  /** Backend SSH *private* key `ssh-client.ts` connects with. */
  sshPrivateKey: string;
  sshPassphrase?: string;
  /**
   * The backend's own WireGuard address inside the Fly 6PN network. Injected
   * into every machine as `BACKEND_PEER_IP` so the image firewall can pin SSH
   * ingress to it. Optional: when unset (dev/e2e) the image falls back to the
   * machine's own /48 prefix so local machines stay reachable.
   */
  backendPeerIp?: string;
  /**
   * App-level org resolution (byo-fly-design): which org's token, slug and
   * peer this app's operations use. When supplied, every app must resolve;
   * a null answer or error fails closed instead of using the boot-time token.
   * The static context is used only by callers that install no resolver.
   */
  resolveAppContext?: (appName: string) => Promise<FlyAppOrgContext | null>;
  sshUsername?: string;
  sshPort?: number;
  region?: string;
  /** Regions to try (once each) when the primary region declines a machine start. Default: ['fra']. */
  fallbackRegions?: string[];
  /** Volume size at creation, in GB. Default {@link DEFAULT_FLY_VOLUME_SIZE_GB}. */
  volumeSizeGb?: number;
  /**
   * Volume auto-extend, enforced by Fly. Set the threshold to a non-positive
   * value to provision fixed-size volumes instead (the pre-auto-extend
   * behaviour). Defaults: grow by 5GB past 80% full, capped at 50GB.
   */
  volumeExtendThresholdPercent?: number;
  volumeExtendIncrementGb?: number;
  volumeSizeLimitGb?: number;
  /**
   * Internal port baked into every machine's initial config as its public
   * service (443/80 → this port) and injected as `PUBLIC_PORT` so the image
   * firewall accepts it by default. Default {@link DEFAULT_FLY_PUBLIC_PORT}.
   */
  publicPort?: number;
  guest?: FlyMachineGuest;
  createTimeoutMs?: number;
  waitStateTimeoutSeconds?: number;
  wakeTimeoutMs?: number;
  /** Budget for a wake Fly keeps refusing as "still stopping" (default 5 min; note #763). */
  wakeStoppingTimeoutMs?: number;
  /** How long "still stopping" may last before the wake kills the machine and starts it (default 60 s). Non-positive: never. */
  wakeForceStopAfterMs?: number;
  wakePollIntervalMs?: number;
  /** Budget for the post-wake TCP readiness probe on :2222 (default 45s). */
  wakeReadinessTimeoutMs?: number;
  /** Interval between readiness probe attempts (default 1s). */
  wakeReadinessProbeIntervalMs?: number;
  /** Bounded retries for transient SSH connect failures on the Fly path (default 3). */
  connectRetryAttempts?: number;
  /** Base backoff between connect retries, scaled by attempt (default 1s). */
  connectRetryBackoffMs?: number;
  flyClient?: FlyClient;
  sshClient?: SshClient;
}

function mapFlyState(state: FlyMachine['state']): SandboxInfo['status'] {
  switch (state) {
    case 'started':
      return 'running';
    case 'stopped':
    case 'suspended':
    case 'stopping':
      return 'stopped';
    case 'created':
    case 'starting':
    case 'replacing':
      return 'creating';
    case 'destroying':
    case 'destroyed':
      return 'expired';
    default:
      // Only Fly's exact `started` state proves a machine is safe to SSH
      // without changing it. An unknown transitional state must never be
      // upgraded to running and then accidentally woken by an observation.
      return 'error';
  }
}

/** Fly capacity/scheduling transients worth retrying elsewhere: start deadlines + 5xx. */
function isTransientProvisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /deadline_exceeded|failed to reach desired state|\b(408|409|500|502|503)\b|timed? ?out/i.test(message);
}

/**
 * A sleeping machine that would not come back: Fly never got it to
 * `started`, or sshd never answered after it did. Whoever tells a person
 * about it names the machine, not the model (note #714).
 */
/** Fly's 412 for a machine whose stop has not finished: a start will be accepted once it has (note #763). */
function isStillStoppingRefusal(error: unknown): boolean {
  return error instanceof FlyApiError && error.status === 412 && /still stopping/i.test(error.message);
}

export class MachineWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineWakeError';
  }
}

export class FlySandboxClient {
  private readonly client: FlyClient;
  private readonly resolveAppContext?: (appName: string) => Promise<FlyAppOrgContext | null>;
  private readonly sshClient: SshClient;
  private readonly orgSlug: string;
  private readonly machineImage: string;
  private readonly sshPublicKey?: string;
  private readonly sshPrivateKey: string;
  private readonly sshPassphrase?: string;
  private readonly backendPeerIp?: string;
  private readonly sshUsername: string;
  private readonly sshPort: number;
  private readonly region: string;
  /** Neighbor regions tried (once each) when the primary declines a machine start. */
  private readonly fallbackRegions: string[];
  private readonly volumeSizeGb: number;
  private readonly volumeExtendThresholdPercent: number;
  private readonly volumeExtendIncrementGb: number;
  private readonly volumeSizeLimitGb: number;
  private readonly publicPort: number;
  private readonly guest: FlyMachineGuest;
  private readonly createTimeoutMs: number;
  private readonly waitStateTimeoutSeconds: number;
  private readonly wakeTimeoutMs: number;
  private readonly wakeStoppingTimeoutMs: number;
  private readonly wakeForceStopAfterMs: number;
  private readonly wakePollIntervalMs: number;
  private readonly wakeReadinessTimeoutMs: number;
  private readonly wakeReadinessProbeIntervalMs: number;
  private readonly connectRetryAttempts: number;
  private readonly connectRetryBackoffMs: number;

  constructor(options: FlySandboxClientOptions) {
    this.client = options.flyClient ?? new FlyClient(options.apiToken);
    this.resolveAppContext = options.resolveAppContext;
    this.sshClient = options.sshClient ?? new SshClient();
    this.orgSlug = options.orgSlug.trim();
    this.machineImage = options.machineImage.trim();
    this.sshPublicKey = options.sshPublicKey?.trim() || undefined;
    this.sshPrivateKey = options.sshPrivateKey;
    this.sshPassphrase = options.sshPassphrase?.trim() || undefined;
    this.backendPeerIp = options.backendPeerIp?.trim() || undefined;
    this.sshUsername = options.sshUsername?.trim() || DEFAULT_DEVELOPMENT_SSH_USER;
    this.sshPort = options.sshPort ?? DEFAULT_FLY_SSH_PORT;
    this.region = options.region?.trim() || DEFAULT_FLY_REGION;
    this.fallbackRegions = (options.fallbackRegions ?? ['fra'])
      .map((region) => region.trim())
      .filter((region) => region.length > 0 && region !== this.region);
    this.volumeSizeGb = options.volumeSizeGb ?? DEFAULT_FLY_VOLUME_SIZE_GB;
    this.volumeExtendThresholdPercent = options.volumeExtendThresholdPercent
      ?? DEFAULT_FLY_VOLUME_EXTEND_THRESHOLD_PERCENT;
    this.volumeExtendIncrementGb = options.volumeExtendIncrementGb
      ?? DEFAULT_FLY_VOLUME_EXTEND_INCREMENT_GB;
    this.volumeSizeLimitGb = options.volumeSizeLimitGb ?? DEFAULT_FLY_VOLUME_SIZE_LIMIT_GB;
    this.publicPort = options.publicPort ?? DEFAULT_FLY_PUBLIC_PORT;
    this.guest = options.guest ?? DEFAULT_FLY_GUEST;
    this.createTimeoutMs = options.createTimeoutMs ?? DEFAULT_FLY_CREATE_TIMEOUT_MS;
    this.waitStateTimeoutSeconds = options.waitStateTimeoutSeconds ?? DEFAULT_FLY_WAIT_STATE_TIMEOUT_SECONDS;
    this.wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_FLY_WAKE_TIMEOUT_MS;
    this.wakeStoppingTimeoutMs = Math.max(
      this.wakeTimeoutMs,
      options.wakeStoppingTimeoutMs ?? DEFAULT_FLY_WAKE_STOPPING_TIMEOUT_MS,
    );
    this.wakeForceStopAfterMs = options.wakeForceStopAfterMs ?? DEFAULT_FLY_WAKE_FORCE_STOP_AFTER_MS;
    this.wakePollIntervalMs = options.wakePollIntervalMs ?? DEFAULT_FLY_WAKE_POLL_INTERVAL_MS;
    this.wakeReadinessTimeoutMs = options.wakeReadinessTimeoutMs ?? DEFAULT_FLY_WAKE_READINESS_TIMEOUT_MS;
    this.wakeReadinessProbeIntervalMs = options.wakeReadinessProbeIntervalMs ?? DEFAULT_FLY_WAKE_READINESS_PROBE_INTERVAL_MS;
    this.connectRetryAttempts = options.connectRetryAttempts ?? DEFAULT_FLY_CONNECT_RETRY_ATTEMPTS;
    this.connectRetryBackoffMs = options.connectRetryBackoffMs ?? DEFAULT_FLY_CONNECT_RETRY_BACKOFF_MS;
  }

  static buildSandboxId(appName: string, machineId: string): string {
    return buildFlySandboxId(appName, machineId);
  }

  static parseSandboxId(sandboxId: string): { appName: string; machineId: string } {
    const parsed = parseFlySandboxId(sandboxId);
    if (!parsed) {
      throw new Error(`Unsupported Fly sandbox id: ${sandboxId}`);
    }
    return parsed;
  }

  /**
   * Opaque, DNS-safe, per-provisioning app slug. Random (not derived from the
   * user id) so nothing user-identifying reaches the `*.fly.dev` hostname or the
   * Fly UI; the app→user mapping is persisted via the returned sandbox id.
   */
  buildAppSlug(): string {
    return `ia-${randomBytes(8).toString('hex')}`;
  }

  getDefaultSandboxSize(): string {
    return `${this.guest.cpu_kind ?? 'shared'}-${this.guest.cpus ?? 1}x-${this.guest.memory_mb ?? 0}mb`;
  }

  async getDefaultReservationQuote(): Promise<CloudReservationQuote | null> {
    // Fly free-tier machines are not billed through the platform reservation
    // flow (billing was removed); no upfront quote.
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * The Fly context this app's operations run in (byo-fly-design: whose org
   * is this). Resolution is record-driven (fly-app-org-context.ts). Once a
   * resolver is installed, missing ownership and resolver errors are fatal:
   * silently substituting the platform token can create a valid resource in
   * the wrong Fly organization and put it on the wrong bill.
   */
  private async contextFor(appName: string): Promise<FlyAppOrgContext> {
    if (this.resolveAppContext) {
      const resolved = await this.resolveAppContext(appName);
      if (!resolved) {
        throw new Error(`Fly app ${appName} has no organization context — refusing to use the platform Fly token`);
      }
      return resolved;
    }
    return this.platformContext();
  }

  private platformContext(): FlyAppOrgContext {
    return {
      client: this.client,
      orgSlug: this.orgSlug,
      ...(this.backendPeerIp ? { backendPeerIp: this.backendPeerIp } : {}),
    };
  }

  /**
   * The context a DESTROY runs in — {@link contextFor}, but falling back to
   * the platform token when the app's organization cannot be resolved.
   *
   * The refusal above is a CREATE rule, and it is the right one: a machine
   * built with the platform token in the wrong organization is a real resource
   * on the wrong bill. Destruction inverts every term of that argument. The
   * failure it guards against cannot happen — token isolation means the
   * platform token can only ever see apps in the platform's own organization,
   * so Fly answers 404/403 for a client's app rather than deleting it — while
   * the failure it CAUSES is concrete: an org whose Fly connection is missing
   * strands every machine it ever provisioned here, running and billing, with
   * the record that names it impossible to remove (`deleting-a-client-org`:
   * the app is still billing and nothing anywhere names it).
   *
   * Big Time Corp (note #246) is how this surfaced: an agent provisioned into
   * the platform organization, whose org has no Fly account, so its machine
   * could not be destroyed, so the agent could not be deleted, so the
   * organization holding it could not be deleted either.
   */
  private async destroyContextFor(appName: string): Promise<FlyAppOrgContext> {
    try {
      return await this.contextFor(appName);
    } catch (error) {
      console.warn(
        'Fly app has no resolvable organization context; destroying with the platform token. '
        + 'Fly refuses this outright unless the app is genuinely ours.',
        { appName, error },
      );
      return this.platformContext();
    }
  }

  /** Whether this machine is still there, asked in a context the caller has
   *  already resolved. The public {@link sandboxExists} answers for the repair
   *  path, which must keep failing loudly rather than reasoning about a
   *  machine through a token that may not be the app's. */
  private async machineExists(
    context: FlyAppOrgContext,
    appName: string,
    machineId: string,
  ): Promise<boolean> {
    try {
      await context.client.getMachine(appName, machineId);
      return true;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) {
        return false;
      }
      console.warn('Could not confirm whether Fly machine still exists; assuming it does', {
        appName,
        machineId,
        error,
      });
      return true;
    }
  }

  private buildMachineEnv(
    context: FlyAppOrgContext,
    guest: FlyMachineGuest,
  ): Record<string, string> | undefined {
    const env: Record<string, string> = {
      // Whether these cores are dedicated or shared — the one part of its own
      // shape the machine cannot read from inside, and the part that decides
      // whether a slow build is the agent's code or its rung (note #393).
      ...machineCpuKindEnv(guest.cpu_kind),
    };
    if (this.sshPublicKey) {
      env.AUTHORIZED_KEYS = this.sshPublicKey;
    }
    // Pin the image firewall's SSH ingress to the backend's WireGuard peer
    // INTO THIS APP'S ORG — the per-org peer for a client org, the legacy
    // peer's address for org #0. When unset (dev/e2e) the image falls back to
    // the machine's own /48 prefix, so a machine still creates and boots fine
    // without it.
    if (context.backendPeerIp) {
      env.BACKEND_PEER_IP = context.backendPeerIp;
    }
    // Tell the image firewall which port to accept by default so a service on the
    // pre-provisioned public port is reachable with no runtime expose call.
    env.PUBLIC_PORT = String(this.publicPort);
    return Object.keys(env).length > 0 ? env : undefined;
  }

  /**
   * The mount's auto-extend clause, or nothing when it is switched off.
   *
   * Fly enforces this itself, so a volume filling up at 3am grows without the
   * backend being involved. `add_size_gb` is required alongside the threshold,
   * so a misconfigured increment disables the whole clause rather than shipping
   * a mount Fly will reject at create time — a machine that fails to provision
   * is worse than one whose volume doesn't grow.
   */
  private buildVolumeAutoExtend(): Pick<
    FlyMachineMount, 'extend_threshold_percent' | 'add_size_gb' | 'size_gb_limit'
  > {
    if (this.volumeExtendThresholdPercent <= 0 || this.volumeExtendIncrementGb <= 0) {
      return {};
    }
    return {
      extend_threshold_percent: this.volumeExtendThresholdPercent,
      add_size_gb: this.volumeExtendIncrementGb,
      ...(this.volumeSizeLimitGb > 0 ? { size_gb_limit: this.volumeSizeLimitGb } : {}),
    };
  }

  /**
   * The initial machine config shared by both create paths: baked image, guest,
   * the /data volume mount, env (SSH key + backend peer + PUBLIC_PORT), and the
   * pre-provisioned public HTTPS service (443/80 → {@link publicPort}). Baking
   * the service into the INITIAL config is what makes publishing reboot-free —
   * the machine boots publish-ready, so at task time the agent only has to listen
   * on the public port. Publishing never keeps a machine warm: the idle reaper
   * stops idle machines regardless of exposure (workbench, not hosting —
   * always-on sites belong on the user's own infrastructure).
   */
  private buildInitialMachineArgs(
    context: FlyAppOrgContext,
    volumeId: string,
    region: string = this.region,
    guest: FlyMachineGuest = this.guest,
  ): CreateFlyMachineArgs {
    const machineEnv = this.buildMachineEnv(context, guest);
    return {
      region,
      image: this.machineImage,
      guest,
      rootfs: DEFAULT_FLY_ROOTFS,
      mounts: [{ volume: volumeId, path: FLY_MACHINE_MOUNT_PATH, ...this.buildVolumeAutoExtend() }],
      services: [this.buildPublicHttpsService(this.publicPort)],
      ...(machineEnv ? { env: machineEnv } : {}),
    };
  }

  /**
   * Ensure the agent's app exists on the org's DEFAULT 6PN network.
   *
   * Apps deliberately do NOT get a custom network: the backend's single
   * WireGuard peer only routes the org default network, so custom-network
   * machines are unreachable over 6PN. Cross-tenant isolation moved into the
   * machine image's nftables firewall instead.
   */
  private async ensureApp(appName: string): Promise<void> {
    const context = await this.contextFor(appName);
    try {
      await context.client.getApp(appName);
      return;
    } catch {
      // Fall through to create; a real failure re-surfaces on createApp.
    }
    await context.client.createApp({
      appName,
      orgSlug: context.orgSlug,
    });
  }

  /**
   * Ensure the app has a (free) shared IPv4 so fly-proxy can route the machine's
   * pre-provisioned public service. Idempotent (allocate-if-absent). Best-effort
   * at create time: a transient allocation hiccup must not fail provisioning —
   * `expose_port` re-runs `ensureSharedIpv4` and would recover it, and a machine
   * with no service consumer doesn't need the address yet.
   */
  private async ensurePublicAddress(appName: string): Promise<void> {
    try {
      await (await this.contextFor(appName)).client.ensureSharedIpv4(appName);
    } catch (error) {
      console.warn('Failed to pre-allocate shared IPv4 at create; expose_port will retry', { appName, error });
    }
  }

  private async waitForMachineStarted(appName: string, machineId: string): Promise<FlyMachine> {
    const deadline = Date.now() + this.createTimeoutMs;
    await (await this.contextFor(appName)).client.waitForMachineState(appName, machineId, {
      state: 'started',
      timeoutSeconds: this.waitStateTimeoutSeconds,
    });

    let machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);
    while (machine.state !== 'started' && Date.now() < deadline) {
      await this.sleep(this.wakePollIntervalMs);
      machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);
    }
    if (machine.state !== 'started') {
      throw new Error(
        `Timed out waiting for Fly machine ${machineId} in app ${appName} to reach "started" (state=${machine.state ?? 'unknown'}).`,
      );
    }
    return machine;
  }

  async createDevelopmentSandbox(args: {
    userId: string;
    name: string;
    tags?: string[];
    prepareEnvironment?: boolean;
  }): Promise<CreatedDevelopmentServer> {
    const appName = this.buildAppSlug();
    await this.ensureApp(appName);
    // Allocate the app's (free) shared IPv4 so the pre-provisioned public service
    // has an address to route from the moment the machine boots. Idempotent.
    await this.ensurePublicAddress(appName);

    let volumeId: string | undefined;
    let machineId: string | undefined;
    try {
      const context = await this.contextFor(appName);
      const volume = await context.client.createVolume(appName, {
        name: FLY_VOLUME_NAME,
        region: this.region,
        sizeGb: this.volumeSizeGb,
      });
      volumeId = volume.id;

      const created = await context.client.createMachine(appName, this.buildInitialMachineArgs(context, volume.id));
      machineId = created.id;

      const machine = await this.waitForMachineStarted(appName, created.id);
      const sandboxId = buildFlySandboxId(appName, created.id);

      // The baked image *is* the prepared environment (claude/codex/tmux/node
      // preinstalled) — no bootstrap, so preparation is "already succeeded".
      return {
        sandboxId,
        server: mapFlyMachine(machine, appName, args.tags),
        environmentPrepared: true,
        codexPrepared: true,
        claudePrepared: true,
        preparationStatus: 'succeeded',
        preparationSummary: 'Fly machine booted from the baked image; environment preinstalled.',
      };
    } catch (error) {
      // Roll back everything we created so a failed provision leaves no orphans.
      await this.cleanupProvision(appName, machineId, volumeId);
      throw error;
    }
  }

  /**
   * Create one agent machine inside its OWN **fresh per-agent app** (minted here,
   * not passed in): mirror {@link createDevelopmentSandbox} but return the richer
   * agent record the setup-agent administrator tools need. Every agent owns a
   * dedicated app so it owns `https://<app>.fly.dev` exclusively — a shared app
   * would make fly-proxy load-balance that URL across the user's other machines.
   * On failure it rolls back everything it created, INCLUDING the app (nothing
   * else lives in it).
   */
  async createAgentSandbox(args: {
    name: string;
    tags?: string[];
    /**
     * The shape to build this machine at — the organization's own choice of
     * rung (note #355). Absent means the client's default, which is the
     * platform's; a caller that cannot read the organization's record gets
     * the same machine it always got rather than a failure.
     */
    size?: { cpuKind: string; cpus: number; memoryMb: number };
    /**
     * Called with the freshly minted app slug BEFORE anything by that name
     * exists on Fly, and awaited: this is the caller's chance to record which
     * app it is about to own. Throwing aborts provisioning with nothing
     * created — deliberately, since a caller that cannot record the app is a
     * caller that could not clean up after itself either.
     *
     * Re-invoked with a new slug on each region retry; every earlier attempt
     * has been rolled back by then, so the last name it receives is the only
     * one that can still exist.
     */
    onAppNamed?: (appName: string) => Promise<void>;
  }): Promise<CreatedFlyAgentMachine> {
    // Machine starts hit transient capacity 408s (deadline_exceeded while
    // "created" → "started"); observed repeatedly in fra. Plan: primary
    // region twice, then each fallback neighbor once — the user only ever
    // sees a failure when every region declines. Each attempt provisions
    // from scratch (volumes are region-bound) and rolls back on failure.
    const regionPlan = [this.region, this.region, ...this.fallbackRegions];
    let lastError: unknown;
    for (let attempt = 0; attempt < regionPlan.length; attempt++) {
      const region = regionPlan[attempt];
      try {
        return await this.createAgentSandboxInRegion(args, region);
      } catch (error) {
        lastError = error;
        if (!isTransientProvisionError(error) || attempt === regionPlan.length - 1) {
          throw error;
        }
        console.warn(
          `[fly] agent machine provision attempt ${attempt + 1}/${regionPlan.length} failed in ${region}; `
          + `retrying in ${regionPlan[attempt + 1]}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    throw lastError;
  }

  private async createAgentSandboxInRegion(
    args: {
      name: string;
      tags?: string[];
      size?: { cpuKind: string; cpus: number; memoryMb: number };
      onAppNamed?: (appName: string) => Promise<void>;
    },
    region: string,
  ): Promise<CreatedFlyAgentMachine> {
    const appName = this.buildAppSlug();
    // Before ensureApp, not after: the whole point is that no Fly resource by
    // this name can exist until the caller has written down that it owns it.
    await args.onAppNamed?.(appName);
    await this.ensureApp(appName);

    let volumeId: string | undefined;
    let machineId: string | undefined;
    try {
      // The shared-IPv4 allocation (free; makes the pre-provisioned public
      // service routable at boot) and the volume are independent once the app
      // exists — overlap them to shave a round trip off every creation.
      const context = await this.contextFor(appName);
      const [, volume] = await Promise.all([
        this.ensurePublicAddress(appName),
        context.client.createVolume(appName, {
          name: FLY_VOLUME_NAME,
          region,
          sizeGb: this.volumeSizeGb,
        }),
      ]);
      volumeId = volume.id;

      const guest: FlyMachineGuest | undefined = args.size
        ? { cpu_kind: args.size.cpuKind, cpus: args.size.cpus, memory_mb: args.size.memoryMb }
        : undefined;
      const created = await context.client.createMachine(
        appName,
        this.buildInitialMachineArgs(context, volume.id, region, guest),
      );
      machineId = created.id;

      const machine = await this.waitForMachineStarted(appName, created.id);
      // Fly reports `started` while the image entrypoint is still bringing
      // sshd up. Wait for :2222 like the wake path does, so the identity
      // write and credential copy that follow creation connect FIRST try
      // instead of bouncing into their 6s retry sleeps (~10s of perceived
      // join time on every + New agent).
      const host = machine.private_ip?.trim();
      if (host) {
        await this.waitForSshReady(host, appName, created.id);
      }
      return {
        sandboxId: buildFlySandboxId(appName, created.id),
        appName,
        machineId: created.id,
        region,
        server: mapFlyMachine(machine, appName, args.tags),
      };
    } catch (error) {
      // Roll back everything we created — the app is this agent's alone, so it is
      // safe (and correct) to delete it along with the machine + volume.
      await this.cleanupProvision(appName, machineId, volumeId);
      throw error;
    }
  }

  private async cleanupProvision(
    appName: string,
    machineId: string | undefined,
    volumeId: string | undefined,
  ): Promise<void> {
    if (machineId) {
      try {
        await (await this.contextFor(appName)).client.deleteMachine(appName, machineId, { force: true });
      } catch (cleanupError) {
        console.warn('Failed to clean up Fly machine after provision failure', { appName, machineId, cleanupError });
      }
    }
    if (volumeId) {
      try {
        await (await this.contextFor(appName)).client.deleteVolume(appName, volumeId);
      } catch (cleanupError) {
        console.warn('Failed to clean up Fly volume after provision failure', { appName, volumeId, cleanupError });
      }
    }
    try {
      await (await this.contextFor(appName)).client.deleteApp(appName);
    } catch (cleanupError) {
      console.warn('Failed to clean up Fly app after provision failure', { appName, cleanupError });
    }
  }

  private getConnectionConfig(host: string, username?: string) {
    return {
      host,
      port: this.sshPort,
      username: username?.trim() || this.sshUsername,
      privateKey: this.sshPrivateKey,
      passphrase: this.sshPassphrase,
    };
  }

  /**
   * Wake-on-connect: resolve the machine, starting it (with retries) when it is
   * stopped, and return its private 6PN IPv6 — the SSH host. Stopped machines
   * don't reserve capacity, so a start can fail; that surfaces as a clear error.
   */
  private async resolveConnectableHost(
    sandboxId: string,
    { wake = true }: Pick<ExecSyncOptions, 'wake'> = {},
  ): Promise<string> {
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
    let machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);

    // Only a machine that was NOT already started needs the readiness wait: the
    // hot path (already running, sshd up) must not pay for a probe.
    const woke = machine.state !== 'started';
    if (woke) {
      if (!wake) {
        throw new Error(
          `Fly machine ${machineId} in app ${appName} is ${machine.state ?? 'not started'}; refusing to wake it.`,
        );
      }
      machine = await this.wakeMachine(appName, machineId);
    }

    const host = machine.private_ip?.trim();
    if (!host) {
      throw new Error(`Fly machine ${machineId} in app ${appName} has no private IPv6 address yet.`);
    }

    // Fly reports `started` the moment its init is up, but our image entrypoint
    // still has to bring sshd online. Wait until :2222 actually accepts a TCP
    // connection so the harness never SSHes into a closed port (ECONNREFUSED).
    if (woke) {
      await this.waitForSshReady(host, appName, machineId);
    }
    return host;
  }

  /** Resolve once a bare TCP connect to the SSH port succeeds; true on connect. */
  private probeSshPortOnce(host: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = net.connect({ host, port: this.sshPort });
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  /**
   * Poll the machine's `[ipv6]:2222` until sshd accepts a TCP connection, within
   * {@link wakeReadinessTimeoutMs}. This closes the wake→SSH race transparently;
   * if the budget expires it throws a clear, machine-scoped error so a genuinely
   * broken boot is diagnosable rather than silently timing out inside the harness.
   */
  private async waitForSshReady(host: string, appName: string, machineId: string): Promise<void> {
    const deadline = Date.now() + this.wakeReadinessTimeoutMs;
    while (Date.now() < deadline) {
      const perAttemptTimeout = Math.min(
        Math.max(this.wakeReadinessProbeIntervalMs, 500),
        Math.max(1, deadline - Date.now()),
      );
      if (await this.probeSshPortOnce(host, perAttemptTimeout)) {
        return;
      }
      await this.sleep(this.wakeReadinessProbeIntervalMs);
    }
    throw new MachineWakeError(
      `Fly machine ${machineId} in app ${appName} reported "started" but SSH (:${this.sshPort}) did not accept a connection within ${this.wakeReadinessTimeoutMs}ms.`,
    );
  }

  /** A connection-phase SSH failure that is worth a bounded retry after wake. */
  private isTransientConnectError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|ETIMEDOUT|ECONNRESET|SSH connection failed|SSH connection timed out/i.test(message);
  }

  /**
   * Run an SSH operation, retrying a transient connect failure a bounded number
   * of times with linear backoff. Defense-in-depth for the residual gap between
   * "port accepts TCP" (what {@link waitForSshReady} verifies) and "sshd is ready
   * for auth". Non-transient errors surface immediately; the budget is bounded so
   * a genuinely unreachable machine still fails rather than retrying forever.
   */
  private async withConnectRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.connectRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= this.connectRetryAttempts || !this.isTransientConnectError(error)) {
          throw error;
        }
        await this.sleep(this.connectRetryBackoffMs * attempt);
      }
    }
    throw lastError;
  }

  private async wakeMachine(appName: string, machineId: string): Promise<FlyMachine> {
    const startedAt = Date.now();
    const deadline = startedAt + this.wakeTimeoutMs;
    // The longer window (note #763) applies only while the LATEST refusal is
    // Fly's "still stopping": the machine is on its way to stopped and a start
    // will be accepted once it gets there. Any other answer — capacity, a
    // 5xx, a timeout — ends the wait at the ordinary deadline, as before.
    const stoppingDeadline = startedAt + this.wakeStoppingTimeoutMs;
    let lastError: unknown;
    let stillStopping = false;
    let stillStoppingSince: number | undefined;
    let forcedStop = false;

    while (Date.now() < (stillStopping ? stoppingDeadline : deadline)) {
      try {
        await (await this.contextFor(appName)).client.startMachine(appName, machineId);
        return await this.waitForMachineStarted(appName, machineId);
      } catch (error) {
        lastError = error;
        const machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId).catch(() => undefined);
        if (machine?.state === 'started') {
          return machine;
        }
        stillStopping = isStillStoppingRefusal(error);
        if (stillStopping && stillStoppingSince === undefined) {
          stillStoppingSince = Date.now();
          console.info(
            `[fly-sandbox] machine ${machineId} in app ${appName} is still stopping; `
            + `waiting up to ${Math.round(this.wakeStoppingTimeoutMs / 1000)}s for Fly to accept the start`,
          );
        }
        // A stop that has not finished in a minute is a hung stop: kill the
        // machine (once) and keep asking for the start. The owner's call,
        // 2026-10-16, after a stop outlasted the whole five-minute wait.
        if (
          stillStopping
          && !forcedStop
          && stillStoppingSince !== undefined
          && this.wakeForceStopAfterMs > 0
          && Date.now() - stillStoppingSince >= this.wakeForceStopAfterMs
        ) {
          forcedStop = true;
          console.warn(
            `[fly-sandbox] machine ${machineId} in app ${appName} has been "still stopping" for `
            + `${Math.round((Date.now() - stillStoppingSince) / 1000)}s; asking Fly to kill it so it can start`,
          );
          await (await this.contextFor(appName)).client
            .stopMachine(appName, machineId, { signal: 'SIGKILL', timeout: '5s' })
            .catch((stopError) => {
              console.warn(`[fly-sandbox] the kill of machine ${machineId} in app ${appName} was refused; still waiting for the stop to finish:`, stopError);
            });
        }
        await this.sleep(this.wakePollIntervalMs);
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'timed out');
    // Only a refusal that IS about capacity is explained as one (note #714):
    // Fly's 412 "machine still stopping, refusing to start" — a host that
    // never finished stopping the machine — used to read as a full host.
    const capacity = /capacity|insufficient (?:resources|memory|cpu)|could not reserve/i.test(reason);
    const waitedOut = stillStopping && stillStoppingSince !== undefined
      ? `, which Fly kept calling "still stopping" for ${Math.round((Date.now() - stillStoppingSince) / 1000)}s${forcedStop ? ' (even after a kill was asked for)' : ''}`
      : '';
    throw new MachineWakeError(
      `Failed to wake Fly machine ${machineId} in app ${appName}${waitedOut}${capacity ? ". Stopped machines don't reserve host capacity, so the start could not be scheduled" : ''}: ${reason}`,
    );
  }

  /** Explicitly start a stopped machine and wait until it is reachable. */
  async wakeSandbox(sandboxId: string): Promise<void> {
    await this.resolveConnectableHost(sandboxId);
  }

  /**
   * Whether this sandbox's app + machine still exist on Fly.
   *
   * Deliberately asymmetric: ONLY a definite 404 counts as gone. Any other
   * failure — a 500, a timeout, a token problem, an unparseable sandbox id —
   * answers `true`, because the caller's response to `false` is to re-provision,
   * and re-provisioning a machine that was merely unreachable for a moment
   * throws away the user's repos and running work. A stale `true` costs one
   * failed turn the user can retry; a wrong `false` is unrecoverable.
   */
  async sandboxExists(sandboxId: string): Promise<boolean> {
    let target: { appName: string; machineId: string };
    try {
      target = FlySandboxClient.parseSandboxId(sandboxId);
    } catch {
      return true;
    }
    try {
      const machine = await (await this.contextFor(target.appName)).client.getMachine(target.appName, target.machineId);
      // Fly keeps answering for a machine after it is destroyed — the record
      // lingers with state 'destroyed' — so a 200 alone is not existence. A
      // user who removed the machine from their own Fly dashboard (owner,
      // 2026-09-23) otherwise gets "Couldn't start your workspace" on every
      // message for as long as Fly remembers the corpse, and the repair that
      // was written for exactly this never runs.
      if (machine.state === 'destroyed' || machine.state === 'destroying') {
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) {
        return false;
      }
      // 403 is Fly's "not yours": the token is good (a bad one is 401) but
      // the app lives in an organization it cannot see. That is the shape of
      // a workplace that MOVED its cloud — the old account's machines are out
      // of reach by design (org-fly.ts), so the honest answer is gone, and
      // the replacement is built in the account now connected.
      if (error instanceof FlyApiError && error.status === 403) {
        return false;
      }
      console.warn('Could not confirm whether Fly machine still exists; assuming it does', {
        sandboxId,
        error,
      });
      return true;
    }
  }

  /**
   * Wake the machine and return the SSH settings for reaching it directly. Used
   * by the tool-executor's terminal/exec path (the setup agent driving a sign-in
   * on a Fly machine) so it can build a durable tmux session against the machine's
   * private 6PN IPv6 on port 2222 as `agent`/`root` — the same connection shape
   * the Hetzner path resolves, minus the public-IP assumption.
   */
  async resolveSshConnection(sandboxId: string, sshUser?: string): Promise<ResolvedFlySshConnection> {
    const host = await this.resolveConnectableHost(sandboxId);
    return {
      host,
      port: this.sshPort,
      username: sshUser?.trim() || this.sshUsername,
      privateKey: this.sshPrivateKey,
      ...(this.sshPassphrase ? { passphrase: this.sshPassphrase } : {}),
    };
  }

  /** Stop a running machine (frees CPU/RAM; the volume and data persist). */
  async stopSandbox(sandboxId: string): Promise<void> {
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
    await (await this.contextFor(appName)).client.stopMachine(appName, machineId);
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
    const machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);
    return {
      id: sandboxId,
      status: mapFlyState(machine.state),
      ...(machine.region ? { region: machine.region } : {}),
      ...(machine.config?.guest?.memory_mb ? { memoryMb: machine.config.guest.memory_mb } : {}),
      ...(machine.config?.guest?.cpu_kind ? { cpuKind: machine.config.guest.cpu_kind } : {}),
      ...(machine.config?.guest?.cpus ? { cpus: machine.config.guest.cpus } : {}),
    };
  }

  /**
   * Move a machine onto another shape (note #268). One whole-config update
   * with a new `guest` — the volume, the home on it, the image and every
   * other config field are carried across untouched.
   *
   * Two rules, both of which cost a user something when broken:
   *
   *  - A NO-OP IS NOT SENT. Fly reboots a running machine on any successful
   *    config change, so re-choosing the size a machine already has would
   *    kill whatever it is running to change nothing. Same reason
   *    {@link exposePort} skips its no-op merge.
   *  - A SLEEPING MACHINE STAYS ASLEEP. A config update BOOTS a stopped
   *    machine unless `skip_launch` is set (see {@link FlyClient.updateMachine}),
   *    and most of the fleet is asleep most of the time — resizing them all
   *    awake would bill every one of them for an hour to change a number.
   *    Asleep is also the free case for the owner: nothing is interrupted and
   *    the new shape is simply what the machine wakes up as.
   *
   * Answers whether it changed anything and whether the machine was awake, so
   * the caller can say which of those two things just happened.
   */
  async resizeSandbox(
    sandboxId: string,
    size: { cpuKind: string; cpus: number; memoryMb: number },
  ): Promise<{ changed: boolean; awake: boolean }> {
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
    const context = await this.contextFor(appName);
    const machine = await context.client.getMachine(appName, machineId);
    const config = machine.config ?? {};
    const current = config.guest;
    const awake = machine.state === 'started';
    if (current
      && current.cpu_kind === size.cpuKind
      && current.cpus === size.cpus
      && current.memory_mb === size.memoryMb) {
      return { changed: false, awake };
    }
    const guest: FlyMachineGuest = {
      ...current,
      cpu_kind: size.cpuKind,
      cpus: size.cpus,
      memory_mb: size.memoryMb,
    };
    // The machine's own CLAUDE.md says which half of the ladder it is on, and
    // the guest is the only place that changes — so the word rides the same
    // write, and the facts block is right on the boot this resize causes.
    const env = { ...config.env, ...machineCpuKindEnv(guest.cpu_kind) };
    await context.client.updateMachine(appName, machineId, { ...config, guest, env }, { skipLaunch: !awake });
    return { changed: true, awake };
  }

  /**
   * How big this machine's durable volume is, in GB — the agent's `/data`
   * home, the one thing on the machine a resize does not touch.
   *
   * Its own read on purpose: {@link getSandbox} is on the hot path (every
   * version card, every sleep sweep) and this costs a second control-plane
   * call. Only the screen that shows the whole machine pays for it, and it
   * answers `undefined` rather than throwing — a missing disk figure is one
   * absent line, not a screen that will not open.
   */
  async getSandboxStorageGb(sandboxId: string): Promise<number | undefined> {
    try {
      const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
      const volumes = await (await this.contextFor(appName)).client.listVolumes(appName);
      const attached = volumes.find((volume) => volume.attached_machine_id === machineId) ?? volumes[0];
      return attached?.size_gb;
    } catch {
      return undefined;
    }
  }

  async execSync(
    sandboxId: string,
    command: string,
    cwd?: string,
    options: ExecSyncOptions = {},
  ): Promise<ExecSyncResult> {
    const host = await this.resolveConnectableHost(sandboxId, options);
    const effectiveCwd = cwd?.trim() ? cwd.trim() : undefined;
    const effectiveCommand = command.trim();
    const wrappedCommand = effectiveCwd
      ? `cd ${quoteShellArg(effectiveCwd)} && ${effectiveCommand}`
      : effectiveCommand;
    return this.withConnectRetry(() => this.sshClient.execCommand(
      this.getConnectionConfig(host, options.sshUser),
      `bash -lc ${quoteShellArg(wrappedCommand)}`,
      { timeoutMs: options.timeoutMs },
    ));
  }

  /**
   * SFTP-write files onto the machine, waking it first like every exec path.
   * Added for deployment machines (deployment-service.ts) — they speak the
   * same sandbox-id protocol — but works on any Fly sandbox.
   */
  async uploadToSandbox(
    sandboxId: string,
    files: SshUploadFile[],
    options: { sshUser?: string } = {},
  ): Promise<void> {
    const host = await this.resolveConnectableHost(sandboxId);
    return this.withConnectRetry(() => this.sshClient.uploadFiles(
      this.getConnectionConfig(host, options.sshUser),
      files,
    ));
  }

  async execTerminalStart(
    sandboxId: string,
    command: string,
    cwd?: string,
    options: TerminalSessionStartOptions = {},
  ): Promise<TerminalSessionResult> {
    const host = await this.resolveConnectableHost(sandboxId);
    const sessionOptions: TerminalSessionStartOptions & { cwd?: string; command?: string } = {
      cwd: cwd?.trim() ? cwd.trim() : undefined,
      command: command.trim(),
    };
    if (options.cols !== undefined) sessionOptions.cols = options.cols;
    if (options.rows !== undefined) sessionOptions.rows = options.rows;
    if (options.outputMode !== undefined) sessionOptions.outputMode = options.outputMode;
    if (options.readMode !== undefined) sessionOptions.readMode = options.readMode;
    if (options.quietForMs !== undefined) sessionOptions.quietForMs = options.quietForMs;
    if (options.timeoutMs !== undefined) sessionOptions.timeoutMs = options.timeoutMs;

    return this.withConnectRetry(() => this.sshClient.startSession(
      this.getConnectionConfig(host, options.sshUser),
      sessionOptions,
    ));
  }

  async execTerminalInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.sendInput(sessionId, events, options);
  }

  async execTerminalRead(
    sessionId: string,
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.readSession(sessionId, options);
  }

  async execTerminalClose(
    sessionId: string,
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.closeSession(sessionId, options);
  }

  async enablePersistence(_sandboxId: string): Promise<{ persistent: boolean }> {
    return { persistent: true };
  }

  async disablePersistence(_sandboxId: string): Promise<{ persistent: boolean }> {
    return { persistent: true };
  }

  // ── Public port exposure (Option A: the administrator owns exposure) ──

  private assertExposablePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Port must be an integer between 1 and 65535 (got ${port}).`);
    }
    if (FLY_RESERVED_EXPOSE_PORTS.has(port)) {
      throw new Error(`Port ${port} is reserved for machine SSH (22 hallpass / 2222 sshd) and cannot be exposed.`);
    }
  }

  /** Order-sensitive deep equality of two service lists (skip a no-op reboot). */
  private servicesEqual(a: FlyMachineService[], b: FlyMachineService[]): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * The edge-proxy service that maps public 443 (+80→443 redirect) to `port`.
   *
   * `autostart` makes a visitor's request BOOT a stopped machine (the idle
   * reaper stops them about three quiet minutes after their last turn), so a
   * shared preview link is a ~10-second stall instead of a dead page. The
   * served content still depends on the agent's ~/.boot.d script restarting
   * its server on wake. `autostop` is deliberately absent — see the field's
   * doc in fly-client.ts.
   */
  private buildPublicHttpsService(internalPort: number): FlyMachineService {
    return {
      protocol: 'tcp',
      internal_port: internalPort,
      autostart: true,
      ports: [
        { port: FLY_PUBLIC_HTTPS_PORT, handlers: ['tls', 'http'] },
        { port: FLY_PUBLIC_HTTP_PORT, handlers: ['http'], force_https: true },
      ],
    };
  }

  /**
   * Publish `port` on the machine to the public internet and return its
   * `https://<app>.fly.dev` URL. Four idempotent steps:
   *   1. ensure the app's (free) shared IPv4 so fly-proxy has a public address;
   *   2. merge a 443/80 → `port` service into the machine config (whole-config
   *      update — reboots a running machine; the /data volume + home persist);
   *   3. open the machine firewall for `port` at runtime (nft accept inserted
   *      ahead of the `fdaa::/16 drop` — fly-proxy forwards public traffic over
   *      6PN, which the drop would otherwise catch);
   *   4. persist the port to {@link FLY_EXPOSED_PORTS_FILE} on the volume so the
   *      entrypoint re-opens it on every future boot.
   *
   * The fly.dev hostname routes to a single 443 service, so services are keyed
   * by `internal_port`: re-exposing the same port is a no-op merge, and exposing
   * a different port replaces which internal port owns 443/80.
   */
  async exposePort(sandboxId: string, port: number): Promise<FlyPortExposureResult> {
    this.assertExposablePort(port);
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);

    // 1. Public address for fly-proxy (free shared v4; idempotent).
    await (await this.contextFor(appName)).client.ensureSharedIpv4(appName);

    // 2. Merge the service into the FULL machine config and update it — UNLESS
    // the config already has exactly this service (the pre-provisioned public
    // port: baked in at create). A machine config update reboots the machine, so
    // skipping the no-op update is what keeps publishing the pre-wired port
    // reboot-free — the agent's live server on it is never killed.
    const machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);
    const config = machine.config ?? {};
    const services = Array.isArray(config.services) ? config.services : [];
    const mergedServices = [
      ...services.filter((service) => service.internal_port !== port),
      this.buildPublicHttpsService(port),
    ];
    if (!this.servicesEqual(services, mergedServices)) {
      await (await this.contextFor(appName)).client.updateMachine(appName, machineId, { ...config, services: mergedServices });
    }

    // 3 + 4. Firewall accept now + persist across reboot (SSH; wake-on-connect
    // handles the post-update reboot).
    await this.applyExposeOnMachine(sandboxId, port);

    return { url: `https://${appName}.fly.dev`, port, appName };
  }

  /**
   * Reverse {@link exposePort}: drop the port's service from the machine config,
   * remove it from the persist file, and delete the runtime firewall accept. The
   * allocated shared IPv4 is left in place (free and harmless).
   */
  async unexposePort(sandboxId: string, port: number): Promise<FlyPortUnexposureResult> {
    this.assertExposablePort(port);
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);

    const machine = await (await this.contextFor(appName)).client.getMachine(appName, machineId);
    const config = machine.config ?? {};
    const services = Array.isArray(config.services) ? config.services : [];
    const remaining = services.filter((service) => service.internal_port !== port);
    await (await this.contextFor(appName)).client.updateMachine(appName, machineId, { ...config, services: remaining });

    await this.removeExposeOnMachine(sandboxId, port);

    return { port, appName, remaining: remaining.length };
  }

  /**
   * Open the firewall for `port` and persist it. Runs as `agent` with
   * passwordless sudo. Both halves are idempotent and tolerant of the firewall
   * table being absent (a local/dev machine with no 6PN has no `fly_fw` table —
   * and no drop to get past — so the accept is simply skipped).
   */
  private async applyExposeOnMachine(sandboxId: string, port: number): Promise<void> {
    const command = [
      // Persist first so a reboot mid-sequence still re-opens the port.
      `sudo touch ${FLY_EXPOSED_PORTS_FILE}`,
      `grep -qxF ${port} ${FLY_EXPOSED_PORTS_FILE} || echo ${port} | sudo tee -a ${FLY_EXPOSED_PORTS_FILE} >/dev/null`,
      // Insert (prepend) the accept so it lands ahead of the fdaa::/16 drop.
      `if sudo nft list chain ip6 fly_fw input >/dev/null 2>&1; then `
        + `sudo nft list chain ip6 fly_fw input | grep -qE "tcp dport ${port} accept" `
        + `|| sudo nft insert rule ip6 fly_fw input tcp dport ${port} accept; fi`,
    ].join('\n');
    const result = await this.execSync(sandboxId, command, undefined, { timeoutMs: 30_000, sshUser: this.sshUsername });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to open the firewall / persist port ${port} on the machine: ${result.stderr?.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }

  /** Reverse {@link applyExposeOnMachine}: drop the persisted port + runtime rule. */
  private async removeExposeOnMachine(sandboxId: string, port: number): Promise<void> {
    const command = [
      `if [ -f ${FLY_EXPOSED_PORTS_FILE} ]; then sudo sed -i "/^${port}$/d" ${FLY_EXPOSED_PORTS_FILE}; fi`,
      `if sudo nft list chain ip6 fly_fw input >/dev/null 2>&1; then `
        + `handle=$(sudo nft -a list chain ip6 fly_fw input | awk '/tcp dport ${port} accept/ {print $NF; exit}'); `
        + `if [ -n "$handle" ]; then sudo nft delete rule ip6 fly_fw input handle "$handle"; fi; fi`,
    ].join('\n');
    const result = await this.execSync(sandboxId, command, undefined, { timeoutMs: 30_000, sshUser: this.sshUsername });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to close the firewall / clear persisted port ${port} on the machine: ${result.stderr?.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }

  /**
   * Destroy the machine and its volume, then the app itself. Under app-per-agent
   * each app owns exactly one machine, so destroying an agent tears down its whole
   * app (machine + volume + app). The last-machine guard is retained for safety
   * (and for the legacy app-per-user data still on disk): the app is only deleted
   * once no machines remain in it, so a shared legacy app survives until empty.
   * `appName` is derived from this agent's own sandbox id, so only that agent's
   * app is ever touched.
   *
   * Idempotent: a machine Fly has already forgotten (destroyed by hand, or a
   * retried teardown) resolves successfully rather than throwing, so callers
   * whose next step is to clear the record — the recycler, the admin tools —
   * aren't blocked from finishing by a machine that is already in the state
   * they wanted.
   */
  async destroySandbox(sandboxId: string): Promise<void> {
    const { appName, machineId } = FlySandboxClient.parseSandboxId(sandboxId);
    // Resolved ONCE and threaded through the whole teardown: every step below
    // has to act on the same organization, and re-resolving between them is
    // how half a machine ends up destroyed and half of it billing.
    const context = await this.destroyContextFor(appName);

    if (!await this.machineExists(context, appName, machineId)) {
      console.log('Fly machine already gone; nothing to destroy', { sandboxId });
      // The app may still be there with its volume when only the machine was
      // removed, so fall through to the volume/app sweep below.
      await this.destroyRemainingAppResources(appName, context);
      return;
    }

    const mountedVolumeIds = await context.client.getMachine(appName, machineId)
      .then((machine) => (machine.config?.mounts ?? [])
        .map((mount) => mount.volume)
        .filter((volume): volume is string => typeof volume === 'string' && volume.length > 0))
      .catch(() => [] as string[]);

    await context.client.deleteMachine(appName, machineId, { force: true });

    const volumeIds = mountedVolumeIds.length > 0
      ? mountedVolumeIds
      : await context.client.listVolumes(appName).then((volumes) => volumes.map((volume) => volume.id)).catch(() => []);
    await this.deleteVolumes(appName, volumeIds, context);
    await this.destroyRemainingAppResources(appName, context);
  }

  /**
   * The machine a provision built but never reported back: the single machine
   * inside an app that a record still claims through its provisioning marker.
   *
   * The counterpart to {@link destroyAbandonedApp} — same situation, opposite
   * conclusion. When the interrupted provision got as far as a machine, that
   * machine is the one the owner is already paying for and the one the idle
   * reaper has been attributing to this agent all along, so adopting it beats
   * destroying it and building a second.
   *
   * `null` for every case where adopting would be a guess rather than a fact:
   * the app is gone, holds nothing, holds more than one machine, or cannot be
   * read. The caller discards the app and provisions again on `null`.
   */
  async findAdoptableMachine(appName: string): Promise<string | null> {
    const context = await this.contextFor(appName).catch(() => null);
    if (!context) return null;
    const machines = await context.client.listMachines(appName).catch(() => [] as FlyMachine[]);
    const alive = machines.filter(
      (machine) => machine.state !== 'destroying' && machine.state !== 'destroyed',
    );
    return alive.length === 1 ? alive[0]!.id : null;
  }

  /**
   * Tear down an app abandoned mid-provision — one whose name a record claims
   * but which never became that agent's machine.
   *
   * Unlike {@link destroySandbox} the caller has no machine id here: that is
   * exactly the situation this exists for, where provisioning died between
   * creating the app and saving the machine on the record. Idempotent, and
   * safe on an app that was never created.
   */
  async destroyAbandonedApp(appName: string): Promise<void> {
    const context = await this.destroyContextFor(appName);
    const machines = await context.client.listMachines(appName).catch(() => [] as FlyMachine[]);
    for (const machine of machines) {
      await this.destroySandbox(buildFlySandboxId(appName, machine.id));
    }
    if (machines.length === 0) {
      // App shell (and possibly a volume) with no machine — still billed.
      await this.destroyRemainingAppResources(appName, context);
    }
  }

  /**
   * Delete any volumes still attached to the app, then the app itself once no
   * machines remain. Volumes are the part that keeps billing after a machine is
   * gone, so this runs even when the machine was already destroyed elsewhere.
   * The last-machine guard is retained for the legacy app-per-user layout: a
   * shared app survives until it is empty.
   */
  private async destroyRemainingAppResources(
    appName: string,
    resolved?: FlyAppOrgContext,
  ): Promise<void> {
    const context = resolved ?? await this.destroyContextFor(appName);
    const remainingMachines = await context.client.listMachines(appName).catch(() => [] as FlyMachine[]);
    if (remainingMachines.length > 0) {
      return;
    }
    const orphanedVolumes = await context.client.listVolumes(appName)
      .then((volumes) => volumes.map((volume) => volume.id))
      .catch(() => [] as string[]);
    await this.deleteVolumes(appName, orphanedVolumes, context);
    try {
      await context.client.deleteApp(appName);
    } catch (error) {
      console.warn('Failed to delete Fly app after its last machine was destroyed', { appName, error });
    }
  }

  private async deleteVolumes(
    appName: string,
    volumeIds: string[],
    resolved?: FlyAppOrgContext,
  ): Promise<void> {
    const context = resolved ?? await this.destroyContextFor(appName);
    for (const volumeId of volumeIds) {
      try {
        await context.client.deleteVolume(appName, volumeId);
      } catch (error) {
        console.warn('Failed to delete Fly volume during sandbox destroy', { appName, volumeId, error });
      }
    }
  }
}
