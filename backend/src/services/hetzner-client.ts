import {
  CLOUD_DEFAULT_RESERVATION_HOURS,
  type CloudReservationQuote,
  type CloudServer,
  quoteReservationFromMonthlyPrice,
} from './cloud-provider.js';
import { Agent } from 'undici';

const HETZNER_BASE_URL = 'https://api.hetzner.cloud/v1';
const HETZNER_MAX_PAGE_SIZE = 50;
const HETZNER_CONNECT_TIMEOUT_MS = 30_000;

const hetznerApiDispatcher = new Agent({
  connect: {
    family: 4,
  },
  connectTimeout: HETZNER_CONNECT_TIMEOUT_MS,
});

export const HETZNER_SUPPORTED_LOCATIONS = ['fsn1', 'nbg1', 'hel1'] as const;
export type HetznerSupportedLocation = typeof HETZNER_SUPPORTED_LOCATIONS[number];
export const HETZNER_DEFAULT_LOCATION: HetznerSupportedLocation = 'nbg1';

export function isHetznerSupportedLocation(location: string | null | undefined): location is HetznerSupportedLocation {
  const normalizedLocation = location?.trim();
  return HETZNER_SUPPORTED_LOCATIONS.some((supportedLocation) => supportedLocation === normalizedLocation);
}

export interface HetznerPriceAmount {
  net?: string;
  gross?: string;
}

export interface HetznerServerTypePrice {
  location?: string;
  price_hourly?: HetznerPriceAmount;
  price_monthly?: HetznerPriceAmount;
  included_traffic?: number;
  price_per_tb_traffic?: HetznerPriceAmount;
}

export interface HetznerServerType {
  id: number;
  name: string;
  description?: string;
  cores?: number;
  memory?: number;
  disk?: number;
  deprecated?: boolean;
  prices?: HetznerServerTypePrice[];
  storage_type?: string;
  cpu_type?: string;
  category?: string;
  architecture?: string;
  locations?: Array<{
    id?: number;
    name?: string;
    recommended?: boolean;
    available?: boolean;
    deprecation?: unknown;
  }>;
}

export interface HetznerLocation {
  id: number;
  name: string;
  description?: string;
  country?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  network_zone?: string;
}

export interface HetznerImage {
  id: number;
  type?: string;
  status?: string;
  name?: string | null;
  description?: string;
  image_size?: number | null;
  disk_size?: number;
  created?: string;
  created_from?: unknown;
  bound_to?: number | null;
  os_flavor?: string;
  os_version?: string | null;
  architecture?: string;
  rapid_deploy?: boolean;
  protection?: {
    delete?: boolean;
  };
  deprecated?: string | null;
  labels?: Record<string, string>;
  deleted?: string | null;
}

export interface HetznerServer {
  id: number;
  name: string;
  status?: 'running' | 'initializing' | 'starting' | 'stopping' | 'off' | 'deleting' | 'migrating' | 'rebuilding' | 'unknown';
  created?: string;
  public_net?: {
    ipv4?: {
      ip?: string;
      blocked?: boolean;
      dns_ptr?: string;
    } | null;
    ipv6?: {
      ip?: string;
      blocked?: boolean;
      dns_ptr?: unknown;
    } | null;
    floating_ips?: number[];
  };
  server_type?: HetznerServerType;
  location?: HetznerLocation;
  image?: HetznerImage;
  labels?: Record<string, string>;
}

export interface HetznerAction {
  id: number;
  command?: string;
  status?: 'running' | 'success' | 'error';
  started?: string;
  finished?: string | null;
  progress?: number;
  resources?: Array<{
    id?: number;
    type?: string;
  }>;
  error?: {
    code?: string;
    message?: string;
  } | null;
}

export interface HetznerSshKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  labels?: Record<string, string>;
  created?: string;
}

export interface HetznerPricing {
  currency?: string;
  vat_rate?: string;
  server_types?: Array<{
    id: number;
    name: string;
    prices?: HetznerServerTypePrice[];
  }>;
  [key: string]: unknown;
}

export interface CreateHetznerServerArgs {
  name: string;
  /** Platform size maps to Hetzner server_type. */
  size: string;
  /** Platform region maps to Hetzner location. */
  region?: string;
  image: string;
  tags?: string[];
  labels?: Record<string, string>;
  ssh_keys?: Array<string | number>;
  start_after_create?: boolean;
  enableIpv4?: boolean;
  enableIpv6?: boolean;
  user_data?: string;
}

interface HetznerListMeta {
  pagination?: {
    page?: number;
    per_page?: number;
    previous_page?: number | null;
    next_page?: number | null;
    last_page?: number | null;
    total_entries?: number | null;
  };
}

interface HetznerErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

function normalizePublicKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizePublicKeyMaterial(value: string): string {
  return normalizePublicKey(value).split(' ').slice(0, 2).join(' ');
}

function parseMoneyAmount(value: HetznerPriceAmount | undefined): number | null {
  const candidate = value?.gross ?? value?.net;
  if (!candidate) {
    return null;
  }

  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeLabelValue(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 63);
}

function tagsToLabels(tags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [index, tag] of (tags ?? []).entries()) {
    const value = sanitizeLabelValue(tag);
    if (value) {
      labels[`infinite-agents/tag-${index}`] = value;
    }
  }
  return labels;
}

export function getHetznerServerPublicAddress(server: Pick<HetznerServer, 'public_net'>): string | undefined {
  const publicV4 = server.public_net?.ipv4?.ip?.trim();
  if (publicV4) {
    return publicV4;
  }

  const publicV6 = server.public_net?.ipv6?.ip?.trim();
  return publicV6 || undefined;
}

export function mapHetznerServer(server: HetznerServer, tags?: string[]): CloudServer {
  return {
    id: server.id,
    provider: 'hetzner',
    name: server.name,
    status: server.status,
    createdAt: server.created,
    region: server.location?.name,
    size: server.server_type?.name,
    image: server.image?.name ?? server.image?.description,
    tags,
    publicAddress: getHetznerServerPublicAddress(server),
    raw: server,
  };
}

export function quoteHetznerReservationFromPricing(args: {
  pricing: HetznerPricing;
  size: string;
  region?: string;
  upfrontHours?: number;
}): CloudReservationQuote | null {
  const normalizedSize = args.size.trim();
  const normalizedRegion = args.region?.trim() || HETZNER_DEFAULT_LOCATION;
  const serverType = args.pricing.server_types?.find((candidate) => candidate.name === normalizedSize);
  if (!serverType) {
    return null;
  }

  const prices = serverType.prices ?? [];
  const matchingPrice = prices.find((price) => price.location === normalizedRegion);
  if (!matchingPrice) {
    return null;
  }

  const monthlyAmount = parseMoneyAmount(matchingPrice.price_monthly);
  if (monthlyAmount === null) {
    return null;
  }

  return quoteReservationFromMonthlyPrice({
    provider: 'hetzner',
    size: normalizedSize,
    region: matchingPrice.location ?? normalizedRegion,
    monthlyAmount,
    currency: args.pricing.currency || 'EUR',
    upfrontHours: args.upfrontHours ?? CLOUD_DEFAULT_RESERVATION_HOURS,
    pricingSource: 'provider',
  });
}

/**
 * Resolves which supported EU locations a Hetzner server type can actually be
 * ordered in. The `/server_types` payload carries per-type availability that the
 * global `/pricing` catalog does not: an explicit `locations[].available` flag
 * when present, otherwise the set of locations that appear in the type's own
 * `prices[]`. This is deliberately distinct from the pricing catalog, which
 * quotes every type in every region regardless of whether it can be provisioned
 * there. When the payload carries no location data at all, `hasSignal` is false
 * and callers should defer to the provider API rather than blocking a create.
 */
export function hetznerServerTypeAvailability(serverType: HetznerServerType): {
  supportedLocations: HetznerSupportedLocation[];
  hasSignal: boolean;
} {
  const fromLocations = Array.isArray(serverType.locations)
    ? serverType.locations
        .filter((entry) => entry.available !== false)
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
  const fromPrices = Array.isArray(serverType.prices)
    ? serverType.prices
        .map((price) => price.location)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];

  const source = fromLocations.length > 0 ? fromLocations : fromPrices;
  const supportedLocations = HETZNER_SUPPORTED_LOCATIONS.filter((location) => source.includes(location));

  return {
    supportedLocations: [...supportedLocations],
    hasSignal: source.length > 0,
  };
}

export class HetznerClient {
  constructor(private readonly apiToken: string) {}

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  private async parseError(response: Response): Promise<string> {
    const raw = await response.text();
    if (!raw.trim()) {
      return `Hetzner API error (${response.status})`;
    }

    try {
      const payload = JSON.parse(raw) as HetznerErrorPayload;
      if (payload.error?.message) {
        return `Hetzner API error (${response.status}): ${payload.error.message}`;
      }
    } catch {
      // Fall through to raw body text.
    }

    return `Hetzner API error (${response.status}): ${raw}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${HETZNER_BASE_URL}${path}`, {
      ...init,
      dispatcher: hetznerApiDispatcher,
      headers: {
        ...this.getHeaders(),
        ...(init.headers ?? {}),
      },
    } as RequestInit & { dispatcher: Agent });

    if (!response.ok) {
      throw new Error(await this.parseError(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async listPaginated<T>(
    path: string,
    rootKey: string,
    limit: number,
    queryParams: Record<string, string> = {},
  ): Promise<T[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const items: T[] = [];
    let page = 1;

    while (items.length < boundedLimit) {
      const query = new URLSearchParams({
        ...queryParams,
        page: String(page),
        per_page: String(Math.min(HETZNER_MAX_PAGE_SIZE, boundedLimit - items.length)),
      });
      const payload = await this.request<Record<string, unknown> & { meta?: HetznerListMeta }>(
        `${path}?${query.toString()}`,
      );
      const pageItems = Array.isArray(payload[rootKey])
        ? payload[rootKey] as T[]
        : [];
      items.push(...pageItems);

      const nextPage = payload.meta?.pagination?.next_page;
      if (!nextPage || pageItems.length === 0) {
        break;
      }

      page = nextPage;
    }

    return items;
  }

  async listServers(limit = 50): Promise<HetznerServer[]> {
    return this.listPaginated<HetznerServer>('/servers', 'servers', limit);
  }

  async getServer(serverId: number): Promise<HetznerServer> {
    const payload = await this.request<{ server: HetznerServer }>(`/servers/${serverId}`);
    return payload.server;
  }

  async createServer(args: CreateHetznerServerArgs): Promise<HetznerServer> {
    const labels = {
      ...tagsToLabels(args.tags),
      ...(args.labels ?? {}),
    };
    const body = {
      name: args.name,
      server_type: args.size,
      image: args.image,
      ...(args.region ? { location: args.region } : {}),
      ...(args.ssh_keys?.length ? { ssh_keys: args.ssh_keys } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(args.start_after_create !== undefined ? { start_after_create: args.start_after_create } : {}),
      ...(args.user_data ? { user_data: args.user_data } : {}),
      ...(
        args.enableIpv4 !== undefined || args.enableIpv6 !== undefined
          ? {
              public_net: {
                enable_ipv4: args.enableIpv4 !== false,
                enable_ipv6: args.enableIpv6 !== false,
              },
            }
          : {}
      ),
    };
    const payload = await this.request<{ server: HetznerServer }>('/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return payload.server;
  }

  async deleteServer(serverId: number): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>(`/servers/${serverId}`, {
      method: 'DELETE',
    });
    return payload.action;
  }

  async powerOn(serverId: number): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>(`/servers/${serverId}/actions/poweron`, {
      method: 'POST',
    });
    return payload.action;
  }

  async powerOff(serverId: number): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>(`/servers/${serverId}/actions/poweroff`, {
      method: 'POST',
    });
    return payload.action;
  }

  async createSnapshot(
    serverId: number,
    args: { description?: string; labels?: Record<string, string> } = {},
  ): Promise<{ image: HetznerImage; action: HetznerAction }> {
    const payload = await this.request<{ image: HetznerImage; action: HetznerAction }>(
      `/servers/${serverId}/actions/create_image`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'snapshot',
          ...(args.description ? { description: args.description } : {}),
          ...(args.labels && Object.keys(args.labels).length > 0 ? { labels: args.labels } : {}),
        }),
      },
    );
    return payload;
  }

  async getImage(imageId: number): Promise<HetznerImage> {
    const payload = await this.request<{ image: HetznerImage }>(`/images/${imageId}`);
    return payload.image;
  }

  async deleteImage(imageId: number): Promise<void> {
    await this.request<undefined>(`/images/${imageId}`, {
      method: 'DELETE',
    });
  }

  async resize(serverId: number, args: { size: string; disk?: boolean }): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>(`/servers/${serverId}/actions/change_type`, {
      method: 'POST',
      body: JSON.stringify({
        server_type: args.size,
        upgrade_disk: args.disk === true,
      }),
    });
    return payload.action;
  }

  async getAction(actionId: number): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>(`/servers/actions/${actionId}`);
    return payload.action;
  }

  async listServerTypes(limit = 200): Promise<HetznerServerType[]> {
    return this.listPaginated<HetznerServerType>('/server_types', 'server_types', limit);
  }

  async listLocations(limit = 50): Promise<HetznerLocation[]> {
    const locations = await this.listPaginated<HetznerLocation>('/locations', 'locations', limit);
    const supported = new Set<string>(HETZNER_SUPPORTED_LOCATIONS);
    return locations.filter((location) => supported.has(location.name));
  }

  async listImages(limit = 50): Promise<HetznerImage[]> {
    return this.listPaginated<HetznerImage>('/images', 'images', limit, {
      type: 'system',
      status: 'available',
    });
  }

  async getPricing(): Promise<HetznerPricing> {
    const payload = await this.request<{ pricing: HetznerPricing }>('/pricing');
    return payload.pricing;
  }

  async listSSHKeys(limit = 200): Promise<HetznerSshKey[]> {
    return this.listPaginated<HetznerSshKey>('/ssh_keys', 'ssh_keys', limit);
  }

  async listSshKeys(limit = 200): Promise<HetznerSshKey[]> {
    return this.listSSHKeys(limit);
  }

  async findSSHKeyByPublicKey(publicKey: string): Promise<HetznerSshKey | null> {
    const normalizedTarget = normalizePublicKeyMaterial(publicKey);
    const keys = await this.listSSHKeys();
    return keys.find((key) => normalizePublicKeyMaterial(key.public_key) === normalizedTarget) ?? null;
  }

  async findSshKeyByPublicKey(publicKey: string): Promise<HetznerSshKey | null> {
    return this.findSSHKeyByPublicKey(publicKey);
  }

  async findSSHKeyByName(name: string): Promise<HetznerSshKey | null> {
    const normalizedName = name.trim();
    if (!normalizedName) {
      return null;
    }

    const keys = await this.listPaginated<HetznerSshKey>('/ssh_keys', 'ssh_keys', 50, {
      name: normalizedName,
    });
    return keys.find((key) => key.name === normalizedName) ?? null;
  }

  async findSshKeyByName(name: string): Promise<HetznerSshKey | null> {
    return this.findSSHKeyByName(name);
  }

  async createSSHKey(name: string, publicKey: string): Promise<HetznerSshKey> {
    const payload = await this.request<{ ssh_key: HetznerSshKey }>('/ssh_keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        public_key: publicKey,
      }),
    });
    return payload.ssh_key;
  }

  async createSshKey(name: string, publicKey: string): Promise<HetznerSshKey> {
    return this.createSSHKey(name, publicKey);
  }

  async deleteSSHKey(keyId: number): Promise<void> {
    await this.request<void>(`/ssh_keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async deleteSshKey(keyId: number): Promise<void> {
    await this.deleteSSHKey(keyId);
  }
}
