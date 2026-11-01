import type { CloudServer } from './cloud-provider.js';
import { flyBillingRefusalWords, flyBillingUrlFrom, type FlyOrganizationBilling } from './fly-billing.js';

/**
 * Thin wrapper over the Fly Machines REST API (https://api.machines.dev/v1).
 * Mirrors {@link HetznerClient}: one method per REST operation, a shared
 * `request()` that attaches the bearer token and normalizes errors, and pure
 * mappers into the platform's `CloudServer` shape.
 *
 * Only the operations `FlySandboxClient` needs are implemented (apps, volumes,
 * machines lifecycle). Verified against Fly's Machines API docs, July 2026.
 */

export const FLY_API_BASE_URL = 'https://api.machines.dev/v1';
/**
 * IP allocation lives on the legacy GraphQL API, not the Machines REST API —
 * the Machines API has no endpoint for it. `expose_port` allocates the app's
 * (free) shared IPv4 here so fly-proxy has a public address to route from.
 */
export const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';
const FLY_DEFAULT_WAIT_TIMEOUT_SECONDS = 60;

export interface FlyApp {
  name: string;
  organization?: { slug?: string } | null;
  status?: string;
}

export interface FlyVolume {
  id: string;
  name?: string;
  state?: string;
  size_gb?: number;
  region?: string;
  zone?: string;
  attached_machine_id?: string | null;
  /** Days of automatic daily snapshots Fly keeps for this volume. */
  snapshot_retention?: number;
}

export interface FlyMachineGuest {
  cpu_kind?: string;
  cpus?: number;
  memory_mb?: number;
}

/**
 * Rootfs persistence (config-level `rootfs` block, NOT part of `guest` — the
 * flyctl flag is --rootfs-persist but the API field is config.rootfs.persist;
 * verified live 2026-08-07). Fly wipes the rootfs on EVERY stop/start by
 * default ("never"), not just on image updates. "restart" keeps it across
 * restarts/stop-start but still rebuilds on image update; "always" keeps it
 * across both.
 */
export interface FlyMachineRootfs {
  persist?: 'never' | 'restart' | 'always';
}

export interface FlyMachineMount {
  volume?: string;
  path?: string;
  name?: string;
  /**
   * Volume auto-extend, applied by Fly itself — no backend polling. At
   * `extend_threshold_percent` full the volume grows by `add_size_gb`, up to
   * `size_gb_limit`. Both of the first two are required together.
   *
   * This is what lets the initial volume be small. Volumes are billed on
   * PROVISIONED size, so guessing high taxes every agent that never fills it;
   * guessing low used to mean an agent wedged mid-`npm install`. Growing on
   * demand removes the guess. Note the one-way ratchet: Fly can extend a
   * volume but never shrink it, so a single heavy clone raises that agent's
   * floor permanently.
   */
  extend_threshold_percent?: number;
  add_size_gb?: number;
  size_gb_limit?: number;
}

/** One public port fly-proxy listens on for a {@link FlyMachineService}. */
export interface FlyMachineServicePort {
  port: number;
  handlers?: string[];
  /** On an `http` handler, 301-redirects every request to its HTTPS peer. */
  force_https?: boolean;
  [key: string]: unknown;
}

/**
 * An edge-proxy service on a machine: fly-proxy forwards `ports[].port` (public)
 * to `internal_port` (inside the machine). `expose_port` writes one of these to
 * map 443/80 → the user's service port.
 */
export interface FlyMachineService {
  protocol: string;
  internal_port: number;
  ports: FlyMachineServicePort[];
  /**
   * fly-proxy boots a stopped machine when a request arrives for this
   * service. The counterpart `autostop` is deliberately NEVER set on AGENT
   * machines: fly-proxy only sees public edge traffic, not the backend's SSH
   * turns, so proxy-side stopping would kill machines mid-turn — stopping
   * stays the idle reaper's job there. A machine whose ONLY traffic rides
   * this service (the per-org git host) is the one place `autostop` is
   * correct: the proxy sees everything, so quiet genuinely means idle.
   */
  autostart?: boolean;
  autostop?: 'off' | 'stop' | 'suspend';
  [key: string]: unknown;
}

export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  guest?: FlyMachineGuest;
  mounts?: FlyMachineMount[];
  services?: FlyMachineService[];
  rootfs?: FlyMachineRootfs;
  [key: string]: unknown;
}

export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'suspended'
  | 'replacing'
  | 'destroying'
  | 'destroyed'
  | (string & {});

/** One lifecycle entry from the bounded event list returned with a Machine. */
export interface FlyMachineEvent {
  type?: string;
  status?: string;
  source?: string;
  /** Epoch milliseconds in Fly's Machines API responses. */
  timestamp?: number | string;
}

export interface FlyMachine {
  id: string;
  name?: string;
  state?: FlyMachineState;
  region?: string;
  instance_id?: string;
  private_ip?: string;
  /** RFC3339 creation stamp, as returned by the Machines API. */
  created_at?: string;
  /** RFC3339 stamp of the latest state/configuration change. */
  updated_at?: string;
  /** Most recent lifecycle events, newest first. */
  events?: FlyMachineEvent[];
  config?: FlyMachineConfig;
}

export interface CreateFlyAppArgs {
  appName: string;
  orgSlug: string;
  /**
   * Custom 6PN network name; creates a per-app private network. Currently
   * unused — `FlySandboxClient` puts every user app on the org DEFAULT network
   * because the backend's single WireGuard peer only routes that network
   * (cross-tenant isolation moved to the machine image's nftables firewall).
   * Kept for the monetization path, where the backend would peer per-network.
   */
  network?: string;
}

export interface CreateFlyVolumeArgs {
  name: string;
  region: string;
  sizeGb: number;
  /** Days of Fly's automatic daily snapshots to keep (their default is 5). */
  snapshotRetentionDays?: number;
}

export interface CreateFlyMachineArgs {
  name?: string;
  region: string;
  image: string;
  env?: Record<string, string>;
  guest: FlyMachineGuest;
  mounts?: FlyMachineMount[];
  rootfs?: FlyMachineRootfs;
  /**
   * Edge-proxy services baked into the INITIAL machine config. Setting services
   * on an already-running machine reboots it, so pre-provisioning the public
   * service here (at create) makes the machine boot publish-ready with no later
   * reboot. See `FlySandboxClient` (the pre-provisioned 443/80 → public-port
   * service).
   */
  services?: FlyMachineService[];
  /**
   * Entrypoint override for one-shot machines (org CI): the image's default
   * boot is replaced whole. The slice-5 rehearsal is why these three are
   * EXPLICIT args: they used to ride in as extra keys, this method's
   * whitelist silently dropped them, and the machine booted sshd instead of
   * the job — a hang no unit fake could see.
   */
  init?: { exec?: string[]; entrypoint?: string[]; cmd?: string[] };
  /** Fly removes the machine when it exits — the one-shot job shape. */
  autoDestroy?: boolean;
  restart?: { policy: 'no' | 'always' | 'on-failure' };
}

export interface FlyMachineWaitArgs {
  state?: Extract<FlyMachineState, 'started' | 'stopped' | 'suspended' | 'destroyed'>;
  /** Required by Fly when waiting for the `stopped` state. */
  instanceId?: string;
  timeoutSeconds?: number;
}

/**
 * Map a Fly machine into the platform `CloudServer` shape. Fly identity is
 * string-based (opaque app slug + hex machine id), which does not fit
 * `CloudServer.id: number`; the real identity travels in `machineId`/`appName`
 * (and, downstream, in the `fly-sandbox-<app>.<machine>` sandbox id), so `id`
 * is a non-identifying `0`. `publicAddress` carries the private 6PN IPv6 — the
 * address the backend actually SSHes to (Fly machines have no public IP).
 */
export function mapFlyMachine(machine: FlyMachine, appName: string, tags?: string[]): CloudServer {
  return {
    id: 0,
    provider: 'fly',
    machineId: machine.id,
    appName,
    name: machine.name ?? machine.id,
    status: machine.state,
    region: machine.region,
    size: machine.config?.guest
      ? `${machine.config.guest.cpu_kind ?? 'shared'}-${machine.config.guest.cpus ?? 1}x-${machine.config.guest.memory_mb ?? 0}mb`
      : undefined,
    image: machine.config?.image,
    tags,
    publicAddress: machine.private_ip,
    raw: machine,
  };
}

interface FlyErrorPayload {
  error?: string;
  message?: string;
}

/**
 * A non-2xx response from the Fly API, carrying the HTTP status so callers can
 * branch on it instead of regex-matching the message.
 *
 * 404 is the one that matters: an app or machine Fly no longer knows about is
 * gone for good, and the caller's job is to re-provision rather than retry.
 * Every other status stays a plain failure — treating a 500 or a network blip
 * as "gone" would throw away a healthy machine (and the user's work on it).
 */
export class FlyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FlyApiError';
  }
}

/**
 * Fly's 422 "We require your billing information" (note #801): the
 * organization's billing is not in order, and Fly will build or change
 * nothing there until it is. Its message is already the plain words a person
 * is shown (`flyBillingRefusalWords`); `flyMessage` keeps Fly's own for the
 * log. Still a FlyApiError with status 422 for anything matching on that.
 */
export class FlyBillingRequiredError extends FlyApiError {
  readonly fixUrl: string | undefined;
  constructor(readonly flyMessage: string) {
    const fixUrl = flyBillingUrlFrom(flyMessage);
    super(flyBillingRefusalWords(fixUrl), 422);
    this.name = 'FlyBillingRequiredError';
    this.fixUrl = fixUrl;
  }
}

/** True for Fly's billing refusal, wherever a caller meets it. */
export function isFlyBillingRequired(error: unknown): error is FlyBillingRequiredError {
  return error instanceof FlyBillingRequiredError;
}

/** App IP inventory, read from GraphQL to keep `expose_port` idempotent. */
export interface FlyAppIpAddresses {
  /** The app's shared IPv4 string, when one is allocated. */
  sharedV4?: string;
  addresses: Array<{ id?: string; address?: string; type?: string; region?: string }>;
}

export class FlyClient {
  constructor(
    private readonly apiToken: string,
    private readonly baseUrl: string = FLY_API_BASE_URL,
    private readonly graphqlUrl: string = FLY_GRAPHQL_URL,
  ) {}

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  private async parseError(response: Response): Promise<string> {
    const raw = await response.text();
    if (!raw.trim()) {
      return `Fly API error (${response.status})`;
    }

    try {
      const payload = JSON.parse(raw) as FlyErrorPayload;
      const message = payload.error ?? payload.message;
      if (message) {
        return `Fly API error (${response.status}): ${message}`;
      }
    } catch {
      // Fall through to raw body text.
    }

    return `Fly API error (${response.status}): ${raw}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.getHeaders(),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const message = await this.parseError(response);
      if (response.status === 422 && /billing information/i.test(message)) {
        throw new FlyBillingRequiredError(message);
      }
      throw new FlyApiError(message, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  // ── Apps ──

  async createApp(args: CreateFlyAppArgs): Promise<void> {
    await this.request<unknown>('/apps', {
      method: 'POST',
      body: JSON.stringify({
        app_name: args.appName,
        org_slug: args.orgSlug,
        ...(args.network ? { network: args.network } : {}),
      }),
    });
  }

  async getApp(appName: string): Promise<FlyApp> {
    return this.request<FlyApp>(`/apps/${encodeURIComponent(appName)}`);
  }

  /** List the org's apps. Used by the idle reaper to enumerate user machines. */
  async listApps(orgSlug: string, init: Pick<RequestInit, 'signal'> = {}): Promise<FlyApp[]> {
    const payload = await this.request<{ apps?: FlyApp[] } | FlyApp[]>(
      `/apps?org_slug=${encodeURIComponent(orgSlug)}`,
      init,
    );
    if (Array.isArray(payload)) {
      return payload;
    }
    return Array.isArray(payload?.apps) ? payload.apps : [];
  }

  async deleteApp(appName: string): Promise<void> {
    await this.request<undefined>(`/apps/${encodeURIComponent(appName)}`, {
      method: 'DELETE',
    });
  }

  // ── Volumes ──

  async createVolume(appName: string, args: CreateFlyVolumeArgs): Promise<FlyVolume> {
    return this.request<FlyVolume>(`/apps/${encodeURIComponent(appName)}/volumes`, {
      method: 'POST',
      body: JSON.stringify({
        name: args.name,
        region: args.region,
        size_gb: args.sizeGb,
        ...(args.snapshotRetentionDays ? { snapshot_retention: args.snapshotRetentionDays } : {}),
      }),
    });
  }

  async listVolumes(appName: string): Promise<FlyVolume[]> {
    const payload = await this.request<FlyVolume[]>(`/apps/${encodeURIComponent(appName)}/volumes`);
    return Array.isArray(payload) ? payload : [];
  }

  async deleteVolume(appName: string, volumeId: string): Promise<void> {
    await this.request<undefined>(
      `/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}`,
      { method: 'DELETE' },
    );
  }

  async getVolume(appName: string, volumeId: string): Promise<FlyVolume> {
    return this.request<FlyVolume>(
      `/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}`,
    );
  }

  /**
   * Grow a volume to `sizeGb` (volumes only ever grow — Fly has no shrink).
   * `needs_restart` means the filesystem picks the new size up only after the
   * machine restarts; for an autostop host, a stop is enough — the next
   * request starts it fresh.
   */
  async extendVolume(appName: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }> {
    const payload = await this.request<{ needs_restart?: boolean }>(
      `/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}/extend`,
      { method: 'PUT', body: JSON.stringify({ size_gb: sizeGb }) },
    );
    return { needsRestart: Boolean(payload?.needs_restart) };
  }

  // ── Machines ──

  async createMachine(appName: string, args: CreateFlyMachineArgs): Promise<FlyMachine> {
    const config: FlyMachineConfig = {
      image: args.image,
      guest: args.guest,
      ...(args.env ? { env: args.env } : {}),
      ...(args.mounts?.length ? { mounts: args.mounts } : {}),
      ...(args.rootfs ? { rootfs: args.rootfs } : {}),
      ...(args.services?.length ? { services: args.services } : {}),
      ...(args.init ? { init: args.init } : {}),
      ...(args.autoDestroy !== undefined ? { auto_destroy: args.autoDestroy } : {}),
      ...(args.restart ? { restart: args.restart } : {}),
    };
    return this.request<FlyMachine>(`/apps/${encodeURIComponent(appName)}/machines`, {
      method: 'POST',
      body: JSON.stringify({
        region: args.region,
        ...(args.name ? { name: args.name } : {}),
        config,
      }),
    });
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine> {
    return this.request<FlyMachine>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
    );
  }

  /**
   * Replace a machine's config (Machines API updates are whole-config, not
   * partial — callers must read {@link getMachine} first, merge, and pass the
   * FULL config back). Used by `expose_port` to add/remove the edge-proxy
   * `services` block. Fly reboots a *running* machine on a successful config
   * change; the mounted volume (and the agent home on it) persists across it.
   *
   * **A config update BOOTS a stopped machine unless you pass `skipLaunch`.**
   * Fly's default is to leave the machine running after an update, whatever
   * state it was in before — "don't boot it up" is opt-in, and it is a
   * top-level field of the request body, NOT part of `config` (putting it in
   * `config` silently does nothing). Anything that writes to machines the user
   * is not currently using wants it, or it wakes the fleet.
   */
  async updateMachine(
    appName: string,
    machineId: string,
    config: FlyMachineConfig,
    options: { skipLaunch?: boolean } = {},
  ): Promise<FlyMachine> {
    return this.request<FlyMachine>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ config, ...(options.skipLaunch ? { skip_launch: true } : {}) }),
      },
    );
  }

  async listMachines(appName: string, init: Pick<RequestInit, 'signal'> = {}): Promise<FlyMachine[]> {
    const payload = await this.request<FlyMachine[]>(`/apps/${encodeURIComponent(appName)}/machines`, init);
    return Array.isArray(payload) ? payload : [];
  }

  async startMachine(appName: string, machineId: string): Promise<void> {
    await this.request<unknown>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`,
      { method: 'POST' },
    );
  }

  /**
   * Stop a machine. With `signal`/`timeout`, a HARD stop: Fly sends that
   * signal and kills the machine after `timeout` (a Go duration, "5s") — used
   * to end a stop that has hung on the host (note #763 follow-up, 2026-10-16).
   */
  async stopMachine(appName: string, machineId: string, options: { signal?: string; timeout?: string } = {}): Promise<void> {
    const body = options.signal || options.timeout
      ? { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeout ? { timeout: options.timeout } : {}) }
      : undefined;
    await this.request<unknown>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
      body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'POST' },
    );
  }

  async deleteMachine(appName: string, machineId: string, options: { force?: boolean } = {}): Promise<void> {
    const query = options.force ? '?force=true' : '';
    await this.request<undefined>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}${query}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Block until the machine reaches `state` (default `started`). Fly's own
   * long-poll endpoint; returns when the state is reached or throws on timeout.
   */
  async waitForMachineState(appName: string, machineId: string, args: FlyMachineWaitArgs = {}): Promise<void> {
    // Fly's wait endpoint only accepts a timeout in [1s, 60s]; clamp so callers
    // can pass a larger overall budget (achieved by polling this repeatedly).
    const timeoutSeconds = Math.max(1, Math.min(60, Math.floor(args.timeoutSeconds ?? FLY_DEFAULT_WAIT_TIMEOUT_SECONDS)));
    const query = new URLSearchParams({
      state: args.state ?? 'started',
      timeout: String(timeoutSeconds),
    });
    if (args.instanceId) {
      query.set('instance_id', args.instanceId);
    }
    await this.request<unknown>(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait?${query.toString()}`,
    );
  }

  // ── IP addresses (GraphQL) ──

  /** POST a GraphQL query to the legacy API with the same bearer token. */
  private async graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new FlyApiError(await this.parseError(response), response.status);
    }
    const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Fly GraphQL error: ${body.errors.map((e) => e.message ?? 'unknown').join('; ')}`);
    }
    return body.data as T;
  }

  /**
   * The organizations this TOKEN can see — the authority on where a pasted
   * token actually works. Fly de-duplicates org names silently ("big-bang"
   * becomes "big-bang-988"), so the name a user reads in the dashboard is
   * not always the name the API answers to; asking the token settles it.
   */
  async listOrganizations(): Promise<Array<{ slug: string; name: string }>> {
    const data = await this.graphqlRequest<{
      organizations?: { nodes?: Array<{ slug?: string | null; name?: string | null }> };
    }>('query { organizations { nodes { slug name } } }', {});
    return (data.organizations?.nodes ?? [])
      .map((node) => ({ slug: String(node?.slug ?? ''), name: String(node?.name ?? '') }))
      .filter((org) => org.slug.length > 0);
  }

  /**
   * Whether Fly will build in this organization (note #801): its billing
   * status and whether a card is saved. Read with the organization's own
   * token; `flyBillingProblem` turns it into words.
   */
  async getOrganizationBilling(orgSlug: string): Promise<FlyOrganizationBilling> {
    const data = await this.graphqlRequest<{
      organization?: { billingStatus?: string | null; isCreditCardSaved?: boolean | null } | null;
    }>('query($slug: String!) { organization(slug: $slug) { billingStatus isCreditCardSaved } }', { slug: orgSlug });
    if (!data?.organization) {
      throw new FlyApiError(`Fly organization "${orgSlug}" was not found`, 404);
    }
    return {
      billingStatus: String(data.organization.billingStatus ?? ''),
      isCreditCardSaved: data.organization.isCreditCardSaved === true,
    };
  }

  /** Read the app's allocated IPs (used to keep IP allocation idempotent). */
  async listIpAddresses(appName: string): Promise<FlyAppIpAddresses> {
    const data = await this.graphqlRequest<{
      app?: {
        sharedIpAddress?: string | null;
        ipAddresses?: { nodes?: Array<{ id?: string; address?: string; type?: string; region?: string }> };
      } | null;
    }>(
      `query($appName: String!) {
        app(name: $appName) {
          sharedIpAddress
          ipAddresses { nodes { id address type region } }
        }
      }`,
      { appName },
    );
    return {
      sharedV4: data.app?.sharedIpAddress ?? undefined,
      addresses: data.app?.ipAddresses?.nodes ?? [],
    };
  }

  /**
   * Allocate the app's **shared IPv4** (free, one per app). `appId` in the
   * GraphQL input is the app *name* (Fly keys apps by name). The mutation often
   * returns a null `ipAddress` for shared v4 even on success, so callers should
   * re-read {@link listIpAddresses} rather than trust the return.
   */
  async allocateSharedIpv4(appName: string): Promise<void> {
    await this.graphqlRequest<unknown>(
      `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          app { sharedIpAddress }
          ipAddress { id address type region }
        }
      }`,
      { input: { appId: appName, type: 'shared_v4' } },
    );
  }

  /**
   * Idempotently ensure the app has a shared IPv4, returning it when known.
   * Never double-allocates: reads current IPs first and only allocates when
   * absent.
   */
  async ensureSharedIpv4(appName: string): Promise<string | undefined> {
    const existing = await this.listIpAddresses(appName);
    if (existing.sharedV4) {
      return existing.sharedV4;
    }
    await this.allocateSharedIpv4(appName);
    const after = await this.listIpAddresses(appName).catch(() => ({ sharedV4: undefined, addresses: [] }));
    return after.sharedV4;
  }

  /**
   * Allocate (idempotently) the app's FLYCAST address — a private IPv6 the
   * Fly proxy answers on from inside the org's own network, which is what
   * gives a per-org git host wake-on-request with no public surface at all.
   * Returns the address; re-reads rather than trusting the mutation's echo,
   * the same discipline as the shared v4.
   */
  async ensureFlycastIpv6(appName: string): Promise<string | undefined> {
    const find = (ips: FlyAppIpAddresses) => ips.addresses
      .find((ip) => (ip.type ?? '').toLowerCase().startsWith('private'))?.address;
    const existing = find(await this.listIpAddresses(appName));
    if (existing) return existing;
    await this.graphqlRequest<unknown>(
      `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress { id address type region }
        }
      }`,
      { input: { appId: appName, type: 'private_v6' } },
    );
    return find(await this.listIpAddresses(appName).catch(() => ({ sharedV4: undefined, addresses: [] })));
  }

  /**
   * Allocate the app's dedicated IPv6 (free). Cert issuance for a custom
   * hostname needs the app reachable over IPv6 — learned in the first
   * deployments E2E (2026-08-04), where "Not verified" persisted until a v6
   * existed.
   */
  async allocateDedicatedIpv6(appName: string): Promise<void> {
    await this.graphqlRequest<unknown>(
      `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress { id address type region }
        }
      }`,
      { input: { appId: appName, type: 'v6' } },
    );
  }

  /** Idempotent counterpart, mirroring {@link ensureSharedIpv4}. */
  async ensureDedicatedIpv6(appName: string): Promise<void> {
    const existing = await this.listIpAddresses(appName);
    const hasV6 = existing.addresses.some((a) => a.type === 'v6' || a.type === 'dedicated_v6');
    if (!hasV6) {
      await this.allocateDedicatedIpv6(appName);
    }
  }

  /**
   * Read a hostname certificate's state. `dnsValidationTarget` is
   * `<hostname>.<token>.flydns.net.` — the `<token>` in it also names the
   * app's unique routing hostname `<token>.<app>.fly.dev`, which is what the
   * public CNAME must point at (routing + ownership proof in one record; a
   * CNAME to plain `<app>.fly.dev` never validates — E2E 2026-08-04).
   */
  async getCertificate(appName: string, hostname: string): Promise<{
    clientStatus?: string;
    dnsValidationTarget?: string;
    configured?: boolean;
  } | null> {
    const data = await this.graphqlRequest<{
      app?: { certificate?: { clientStatus?: string; dnsValidationTarget?: string; configured?: boolean } | null } | null;
    }>(
      `query($appName: String!, $hostname: String!) {
        app(name: $appName) {
          certificate(hostname: $hostname) { clientStatus dnsValidationTarget configured }
        }
      }`,
      { appName, hostname },
    );
    return data.app?.certificate ?? null;
  }

  /**
   * Ask Fly to look at a hostname's certificate again NOW. Without it, a
   * brand-new site's certificate waited on Fly's own retry schedule: its first
   * look comes before our DNS record exists (the record needs the token the
   * certificate creates), and the next came about eight minutes later on every
   * site measured (2026-09-25). Best-effort — a failed nudge changes nothing.
   */
  async checkCertificate(appName: string, hostname: string): Promise<void> {
    await this.graphqlRequest<unknown>(
      `mutation($appId: ID!, $hostname: String!) {
        checkCertificate(input: { appId: $appId, hostname: $hostname }) { certificate { clientStatus } }
      }`,
      { appId: appName, hostname },
    );
  }

  /**
   * Attach a custom hostname to the app — Fly then issues and renews a free
   * Let's Encrypt cert for it, as long as the hostname CNAMEs (unproxied) to
   * the app's unique `<token>.<app>.fly.dev` hostname (see
   * {@link getCertificate}). Certificate APIs are GraphQL-only, like the IP
   * ones. Idempotent: re-adding an existing hostname is a no-op error we
   * swallow.
   */
  async addCertificate(appName: string, hostname: string): Promise<void> {
    try {
      await this.graphqlRequest<unknown>(
        `mutation($appId: ID!, $hostname: String!) {
          addCertificate(appId: $appId, hostname: $hostname) {
            certificate { id hostname configured }
          }
        }`,
        { appId: appName, hostname },
      );
    } catch (error) {
      if (/already/i.test((error as Error).message)) {
        return;
      }
      throw error;
    }
  }

  /**
   * The org's GraphQL node id — what the WireGuard mutations key on (they
   * predate slugs as inputs). Rehearsed live 2026-08-23.
   */
  async resolveOrganizationId(orgSlug: string): Promise<string> {
    const data = await this.graphqlRequest<{ organization?: { id?: string } | null }>(
      `query($slug: String!) { organization(slug: $slug) { id } }`,
      { slug: orgSlug },
    );
    const id = data.organization?.id;
    if (!id) {
      throw new Error(`Fly org "${orgSlug}" is not visible to this token`);
    }
    return id;
  }

  /**
   * Create a Tigris object-storage bucket in the org (byo-git-design slice 4:
   * an org's git bundles land in ITS OWN bucket, on its bill). The S3
   * credentials come back ONCE, in the create response's `environment` —
   * later reads answer an empty map, which the first live probe proved
   * (2026-08-23) — so the caller must store them immediately. `public`
   * (note #768) is what `fly storage create --public` sends: the bucket's
   * objects are readable by anyone with the URL.
   */
  async createTigrisBucket(args: { organizationId: string; name: string; public?: boolean }): Promise<{
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  }> {
    const data = await this.graphqlRequest<{
      createAddOn?: { addOn?: { name?: string; environment?: Record<string, string> | null } | null } | null;
    }>(
      `mutation($input: CreateAddOnInput!) {
        createAddOn(input: $input) { addOn { name status environment } }
      }`,
      {
        input: {
          organizationId: args.organizationId,
          type: 'tigris',
          name: args.name,
          ...(args.public ? { options: { public: true } } : {}),
        },
      },
    );
    const env = data.createAddOn?.addOn?.environment ?? undefined;
    if (!env?.BUCKET_NAME || !env.AWS_ENDPOINT_URL_S3 || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(`Tigris bucket "${args.name}" was created without credentials in the response — nothing was stored, delete and retry`);
    }
    return {
      bucket: env.BUCKET_NAME,
      endpoint: env.AWS_ENDPOINT_URL_S3,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION ?? 'auto',
    };
  }

  /** Remove an extension (a Tigris bucket at off-boarding, a failed create). */
  async deleteAddOn(name: string): Promise<void> {
    await this.graphqlRequest<unknown>(
      `mutation($input: DeleteAddOnInput!) { deleteAddOn(input: $input) { deletedAddOnName } }`,
      { input: { name } },
    );
  }

  /**
   * Register a WireGuard peer in an org (byo-fly-design: one peer per client
   * org is how the backend reaches machines in a foreign 6PN network). Fly
   * answers with the address the peer got inside the org's network, the
   * gateway to dial, and the GATEWAY's public key — everything the local
   * config needs beside our own private key.
   */
  async addWireGuardPeer(args: {
    organizationId: string;
    region: string;
    name: string;
    pubkey: string;
  }): Promise<{ peerIp: string; endpoint: string; gatewayPubkey: string }> {
    const data = await this.graphqlRequest<{
      addWireGuardPeer?: { peerip?: string; endpointip?: string; pubkey?: string } | null;
    }>(
      `mutation($input: AddWireGuardPeerInput!) {
        addWireGuardPeer(input: $input) { peerip endpointip pubkey }
      }`,
      { input: args },
    );
    const peer = data.addWireGuardPeer;
    if (!peer?.peerip || !peer.endpointip || !peer.pubkey) {
      throw new Error(`Fly returned an incomplete WireGuard peer for "${args.name}"`);
    }
    return { peerIp: peer.peerip, endpoint: peer.endpointip, gatewayPubkey: peer.pubkey };
  }

  /** Remove a certificate (custom domain off-boarding). Absent → no-op error we swallow. */
  async deleteCertificate(appName: string, hostname: string): Promise<void> {
    try {
      await this.graphqlRequest<unknown>(
        `mutation($appId: ID!, $hostname: String!) {
          deleteCertificate(appId: $appId, hostname: $hostname) {
            certificate { id hostname }
          }
        }`,
        { appId: appName, hostname },
      );
    } catch (error) {
      if (/not found|does not exist/i.test((error as Error).message)) {
        return;
      }
      throw error;
    }
  }

  /** Remove a WireGuard peer by name. Removing an absent peer is an error we surface. */
  async removeWireGuardPeer(args: { organizationId: string; name: string }): Promise<void> {
    await this.graphqlRequest<unknown>(
      `mutation($input: RemoveWireGuardPeerInput!) {
        removeWireGuardPeer(input: $input) { organization { id } }
      }`,
      { input: args },
    );
  }
}
