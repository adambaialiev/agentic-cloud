export type CloudProviderName = 'digitalocean' | 'hetzner' | 'fly';

export interface CloudServer {
  /**
   * Numeric provider id (Hetzner/DigitalOcean). Fly identifies machines by
   * opaque string ids, which live in {@link CloudServer.machineId}/{@link
   * CloudServer.appName} instead; Fly servers set this to a non-identifying `0`.
   */
  id: number;
  provider: CloudProviderName;
  /** Fly machine id (hex string). Absent for numeric-id providers. */
  machineId?: string;
  /** Fly per-user app slug the machine belongs to. Absent for other providers. */
  appName?: string;
  name: string;
  status?: string;
  createdAt?: string;
  region?: string;
  size?: string;
  image?: string;
  tags?: string[];
  publicAddress?: string;
  raw?: unknown;
}

export interface CloudAction {
  id: number;
  provider: CloudProviderName;
  status?: string;
  type?: string;
  startedAt?: string;
  completedAt?: string | null;
  raw?: unknown;
}

export interface CloudSshKey {
  id: number;
  provider: CloudProviderName;
  name: string;
  fingerprint: string;
  publicKey: string;
  raw?: unknown;
}

export interface CloudServerTypePrice {
  location?: string;
  hourly: number;
  monthly: number;
  currency: string;
}

export interface CloudServerType {
  id?: number;
  provider: CloudProviderName;
  name: string;
  description?: string;
  cpuCount?: number;
  memoryGb?: number;
  diskGb?: number;
  architecture?: string;
  prices: CloudServerTypePrice[];
  raw?: unknown;
}

export interface CloudLocation {
  id?: number;
  provider: CloudProviderName;
  name: string;
  description?: string;
  country?: string;
  city?: string;
  networkZone?: string;
  raw?: unknown;
}

export interface CloudImage {
  id: number | string;
  provider: CloudProviderName;
  name?: string;
  slug?: string;
  description?: string;
  type?: string;
  architecture?: string;
  status?: string;
  raw?: unknown;
}

export interface CloudReservationQuote {
  provider: CloudProviderName;
  size: string;
  region?: string;
  monthlyAmount: number;
  hourlyAmount: number;
  currency: string;
  upfrontHours: number;
  baseCents: number;
  pricingSource: 'static' | 'provider';
}

export const CLOUD_DEFAULT_RESERVATION_HOURS = 24;

export function formatCloudMoney(cents: number, currency: string): string {
  const amount = (Math.max(0, Math.round(cents)) / 100).toFixed(2);
  return currency.toUpperCase() === 'USD'
    ? `$${amount}`
    : `${currency.toUpperCase()} ${amount}`;
}

export function quoteReservationFromMonthlyPrice(args: {
  provider: CloudProviderName;
  size: string;
  monthlyAmount: number;
  currency: string;
  region?: string;
  upfrontHours?: number;
  pricingSource: CloudReservationQuote['pricingSource'];
}): CloudReservationQuote {
  const upfrontHours = args.upfrontHours ?? CLOUD_DEFAULT_RESERVATION_HOURS;
  const hourlyAmount = args.monthlyAmount / 730;
  return {
    provider: args.provider,
    size: args.size.trim(),
    region: args.region?.trim() || undefined,
    monthlyAmount: args.monthlyAmount,
    hourlyAmount,
    currency: args.currency,
    upfrontHours,
    baseCents: Math.max(1, Math.ceil(hourlyAmount * upfrontHours * 100)),
    pricingSource: args.pricingSource,
  };
}
