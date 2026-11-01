import type {
  CloudProviderName,
  CloudServer,
} from './cloud-provider.js';
import type { SessionRuntimeContext } from '../types/runtime-context.js';
import {
  DEFAULT_DEVELOPMENT_SSH_USER,
  getDefaultDevelopmentRootForSshUser,
} from './development-root.js';

export type ManagedServerStatus =
  | 'active'
  | 'deleted'
  | 'delete_failed'
  | 'provisioning'
  | 'error';

export type ManagedServerPreparationStatus =
  | 'not_requested'
  | 'pending'
  | 'succeeded'
  | 'failed';

export type ManagedServerPurpose = 'default_sandbox' | 'deployment' | 'general';

export type ManagedServerProvider =
  | 'digitalocean'
  | 'hetzner'
  | 'fly';

export type ManagedServerTunnelStatus = 'online' | 'offline';



export interface ManagedServerRecord {
  recordId: string;
  userId: string;
  serverId: number;
  provider: ManagedServerProvider;
  name: string;
  purpose: ManagedServerPurpose;
  isDefaultDevelopment: boolean;
  status: ManagedServerStatus;
  cloudStatus?: string;
  region?: string;
  size?: string;
  image?: string;
  tags?: string[];
  publicAddress?: string;
  environmentPrepared: boolean;
  codexPrepared: boolean;
  codexVersion?: string;
  claudePrepared: boolean;
  claudeVersion?: string;
  preparationStatus: ManagedServerPreparationStatus;
  preparationSummary?: string;
  preparationError?: string;
  preparedAt?: string;
  deletedAt?: string;
  sourceSessionId?: string;
  sourceToolCallId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedServerStorage {
  listAllServers(): Promise<ManagedServerRecord[]>;
  listServers(userId: string): Promise<ManagedServerRecord[]>;
  getServer(
    userId: string,
    serverId: number,
    provider?: ManagedServerProvider,
  ): Promise<ManagedServerRecord | null>;
  getServerByRecordId(userId: string, recordId: string): Promise<ManagedServerRecord | null>;
  updateServer(
    userId: string,
    serverId: number,
    updater: (record: ManagedServerRecord) => ManagedServerRecord | null,
    provider?: ManagedServerProvider,
  ): Promise<ManagedServerRecord | null>;
  saveServer(record: ManagedServerRecord): Promise<void>;
  deleteServer(userId: string, serverId: number, provider?: ManagedServerProvider): Promise<void>;
}

const COLLECTION_NAME = 'managed_droplets';
const CLOUD_MANAGED_PROVIDERS = ['digitalocean', 'hetzner'] as const satisfies readonly CloudProviderName[];




function cloneRecord(record: ManagedServerRecord): ManagedServerRecord {
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tags = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}


function normalizePurpose(value: unknown): ManagedServerPurpose {
  return value === 'default_sandbox' || value === 'deployment' || value === 'general'
    ? value
    : 'general';
}

function normalizeProvider(value: unknown): ManagedServerProvider {
  if (value === 'digitalocean' || value === 'hetzner' || value === 'fly') {
    return value;
  }
  return 'hetzner';
}

function normalizeStatus(value: unknown): ManagedServerStatus {
  return value === 'active'
    || value === 'deleted'
    || value === 'delete_failed'
    || value === 'provisioning'
    || value === 'error'
    ? value
    : 'active';
}

function normalizePreparationStatus(value: unknown): ManagedServerPreparationStatus {
  return value === 'not_requested'
    || value === 'pending'
    || value === 'succeeded'
    || value === 'failed'
    ? value
    : 'not_requested';
}


function parseServerRecord(data: Record<string, unknown> | undefined): ManagedServerRecord | null {
  if (!data) {
    return null;
  }

  const recordId = normalizeString(data.recordId);
  const userId = normalizeString(data.userId);
  // Persisted field name remains `dropletId` for backward compatibility.
  const serverId = Number(data.dropletId);
  const name = normalizeString(data.name);
  if (!recordId || !userId || !Number.isFinite(serverId) || serverId < 1 || !name) {
    return null;
  }

  const createdAt = normalizeString(data.createdAt) ?? new Date().toISOString();
  const updatedAt = normalizeString(data.updatedAt) ?? createdAt;
  const provider = normalizeProvider(data.provider);

  return {
    recordId,
    userId,
    serverId: Math.floor(serverId),
    provider,
    name,
    purpose: normalizePurpose(data.purpose),
    isDefaultDevelopment: data.isDefaultDevelopment === true,
    status: normalizeStatus(data.status),
    cloudStatus: normalizeString(data.cloudStatus),
    region: normalizeString(data.region),
    size: normalizeString(data.size),
    image: normalizeString(data.image),
    tags: normalizeTags(data.tags),
    publicAddress: normalizeString(data.publicAddress),
    environmentPrepared: data.environmentPrepared === true,
    codexPrepared: data.codexPrepared === true,
    codexVersion: normalizeString(data.codexVersion),
    claudePrepared: data.claudePrepared === true,
    claudeVersion: normalizeString(data.claudeVersion),
    preparationStatus: normalizePreparationStatus(data.preparationStatus),
    preparationSummary: normalizeString(data.preparationSummary),
    preparationError: normalizeString(data.preparationError),
    preparedAt: normalizeString(data.preparedAt),
    deletedAt: normalizeString(data.deletedAt),
    sourceSessionId: normalizeString(data.sourceSessionId),
    sourceToolCallId: normalizeString(data.sourceToolCallId),
    createdAt,
    updatedAt,
  };
}

function serializeServerRecord(record: ManagedServerRecord): Record<string, unknown> {
  const storedRecord: Partial<ManagedServerRecord> = { ...record };
  // Persist under the legacy `dropletId` field name; emitted explicitly below.
  delete storedRecord.serverId;
  delete storedRecord.environmentPrepared;
  delete storedRecord.codexPrepared;
  delete storedRecord.codexVersion;
  delete storedRecord.claudePrepared;
  delete storedRecord.claudeVersion;
  delete storedRecord.preparationStatus;
  delete storedRecord.preparationSummary;
  delete storedRecord.preparationError;
  delete storedRecord.preparedAt;

  return {
    ...storedRecord,
    dropletId: record.serverId,
    tags: record.tags ?? null,
    cloudStatus: record.cloudStatus ?? null,
    region: record.region ?? null,
    size: record.size ?? null,
    image: record.image ?? null,
    publicAddress: record.publicAddress ?? null,
    provider: record.provider ?? 'hetzner',
    deletedAt: record.deletedAt ?? null,
    sourceSessionId: record.sourceSessionId ?? null,
    sourceToolCallId: record.sourceToolCallId ?? null,
  };
}

function isStoredServerRecord(record: ManagedServerRecord | null): record is ManagedServerRecord {
  return record !== null && record.status !== 'deleted';
}

function isCloudManagedProvider(
  provider: ManagedServerProvider | undefined,
): provider is CloudProviderName {
  return provider === 'digitalocean' || provider === 'hetzner';
}

function getCloudRecordPrefix(provider: CloudProviderName): string {
  if (provider === 'hetzner') return 'hcloud';
  if (provider === 'fly') return 'fly';
  return 'do';
}

export function buildCloudManagedServerRecordId(
  provider: CloudProviderName,
  serverId: number,
): string {
  return `${getCloudRecordPrefix(provider)}_${Math.floor(serverId)}`;
}

function getStorageRecordId(record: ManagedServerRecord): string {
  return isCloudManagedProvider(record.provider)
    ? buildCloudManagedServerRecordId(record.provider, record.serverId)
    : record.recordId;
}

function normalizeStorageRecord(record: ManagedServerRecord): ManagedServerRecord {
  const recordId = getStorageRecordId(record);
  return record.recordId === recordId
    ? record
    : { ...record, recordId };
}

function matchesProvider(
  record: ManagedServerRecord,
  provider: ManagedServerProvider | undefined,
): boolean {
  return provider === undefined || record.provider === provider;
}


export class InMemoryManagedServerStorage implements ManagedServerStorage {
  private readonly records = new Map<string, ManagedServerRecord[]>();

  private findServerRecord(
    userId: string,
    serverId: number,
    provider?: ManagedServerProvider,
  ): ManagedServerRecord | null {
    const records = this.records.get(userId) ?? [];
    if (isCloudManagedProvider(provider)) {
      const recordId = buildCloudManagedServerRecordId(provider, serverId);
      return records.find((candidate) => (
        candidate.recordId === recordId
        || (candidate.serverId === serverId && candidate.provider === provider)
      )) ?? null;
    }

    if (provider) {
      return records.find((candidate) => (
        candidate.serverId === serverId
        && candidate.provider === provider
      )) ?? null;
    }

    for (const knownProvider of CLOUD_MANAGED_PROVIDERS) {
      const recordId = buildCloudManagedServerRecordId(knownProvider, serverId);
      const record = records.find((candidate) => candidate.recordId === recordId);
      if (record) {
        return record;
      }
    }

    return records.find((candidate) => candidate.serverId === serverId) ?? null;
  }

  async listAllServers(): Promise<ManagedServerRecord[]> {
    return Array.from(this.records.values())
      .flat()
      .filter((record) => record.status !== 'deleted')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneRecord);
  }

  async listServers(userId: string): Promise<ManagedServerRecord[]> {
    return (this.records.get(userId) ?? [])
      .filter((record) => record.status !== 'deleted')
      .map(cloneRecord);
  }

  async getServer(
    userId: string,
    serverId: number,
    provider?: ManagedServerProvider,
  ): Promise<ManagedServerRecord | null> {
    const record = this.findServerRecord(userId, serverId, provider);
    return isStoredServerRecord(record) && matchesProvider(record, provider) ? cloneRecord(record) : null;
  }

  async getServerByRecordId(userId: string, recordId: string): Promise<ManagedServerRecord | null> {
    const normalizedRecordId = normalizeString(recordId);
    if (!normalizedRecordId) {
      return null;
    }
    const record = (this.records.get(userId) ?? []).find((candidate) => candidate.recordId === normalizedRecordId) ?? null;
    return isStoredServerRecord(record) ? cloneRecord(record) : null;
  }

  async updateServer(
    userId: string,
    serverId: number,
    updater: (record: ManagedServerRecord) => ManagedServerRecord | null,
    provider?: ManagedServerProvider,
  ): Promise<ManagedServerRecord | null> {
    const existing = await this.getServer(userId, serverId, provider);
    if (!existing) {
      return null;
    }

    const nextRecord = updater(existing);
    if (!nextRecord) {
      return null;
    }

    const storedRecord = normalizeStorageRecord(nextRecord);
    await this.saveServer(storedRecord);
    return cloneRecord(storedRecord);
  }

  async saveServer(record: ManagedServerRecord): Promise<void> {
    const storedRecord = normalizeStorageRecord(record);
    if (storedRecord.status === 'deleted') {
      await this.deleteServer(storedRecord.userId, storedRecord.serverId, storedRecord.provider);
      return;
    }

    const existing = [...(this.records.get(storedRecord.userId) ?? [])];
    const index = existing.findIndex((candidate) => candidate.recordId === storedRecord.recordId);
    if (index >= 0) {
      existing[index] = cloneRecord(storedRecord);
    } else {
      existing.push(cloneRecord(storedRecord));
    }
    existing.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    this.records.set(storedRecord.userId, existing);
  }

  async deleteServer(
    userId: string,
    serverId: number,
    provider?: ManagedServerProvider,
  ): Promise<void> {
    const existing = this.records.get(userId) ?? [];
    const target = this.findServerRecord(userId, serverId, provider);
    if (!target) {
      return;
    }

    const remaining = existing.filter((candidate) => candidate.recordId !== target.recordId);
    if (remaining.length > 0) {
      this.records.set(userId, remaining);
    } else {
      this.records.delete(userId);
    }
  }
}

function mapCloudServerStatus(status: string | undefined): ManagedServerStatus {
  switch (status) {
    case 'new':
    case 'initializing':
    case 'starting':
    case 'rebuilding':
      return 'provisioning';
    case 'deleting':
      return 'deleted';
    case 'error':
    case 'unknown':
      return 'error';
    default:
      return 'active';
  }
}

export class ManagedServerService {
  constructor(private readonly storage: ManagedServerStorage) {}

  async listAllServers(): Promise<ManagedServerRecord[]> {
    return this.storage.listAllServers();
  }

  async listServers(userId: string): Promise<ManagedServerRecord[]> {
    return this.storage.listServers(userId);
  }

  async getServer(
    userId: string,
    serverId: number,
    provider?: ManagedServerProvider,
  ): Promise<ManagedServerRecord | null> {
    return this.storage.getServer(userId, serverId, provider);
  }

  async getServerByRecordId(userId: string, recordId: string): Promise<ManagedServerRecord | null> {
    return this.storage.getServerByRecordId(userId, recordId);
  }

  async registerCreatedCloudServer(args: {
    userId: string;
    server: CloudServer;
    purpose: ManagedServerPurpose;
    sourceSessionId?: string;
    sourceToolCallId?: string;
  }): Promise<ManagedServerRecord> {
    const now = new Date().toISOString();
    const existing = await this.storage.getServer(args.userId, args.server.id, args.server.provider);

    const record: ManagedServerRecord = {
      recordId: buildCloudManagedServerRecordId(args.server.provider, args.server.id),
      userId: args.userId,
      serverId: args.server.id,
      provider: args.server.provider,
      name: args.server.name,
      purpose: args.purpose,
      isDefaultDevelopment: false,
      status: mapCloudServerStatus(args.server.status),
      cloudStatus: args.server.status,
      region: args.server.region,
      size: args.server.size,
      image: args.server.image,
      tags: args.server.tags,
      publicAddress: args.server.publicAddress,
      environmentPrepared: existing?.environmentPrepared ?? false,
      codexPrepared: existing?.codexPrepared ?? false,
      codexVersion: existing?.codexVersion,
      claudePrepared: existing?.claudePrepared ?? false,
      claudeVersion: existing?.claudeVersion,
      preparationStatus: existing?.preparationStatus ?? 'not_requested',
      preparationSummary: existing?.preparationSummary,
      preparationError: existing?.preparationError,
      preparedAt: existing?.preparedAt,
      sourceSessionId: args.sourceSessionId,
      sourceToolCallId: args.sourceToolCallId,
      deletedAt: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.storage.saveServer(record);
    return record;
  }







  async updatePreparationState(args: {
    userId: string;
    serverId: number;
    environmentPrepared: boolean;
    codexPrepared?: boolean;
    codexVersion?: string;
    claudePrepared?: boolean;
    claudeVersion?: string;
        preparationStatus: ManagedServerPreparationStatus;
    preparationSummary?: string;
    preparationError?: string;
    provider?: ManagedServerProvider;
  }): Promise<ManagedServerRecord | null> {
    const existing = await this.storage.getServer(args.userId, args.serverId, args.provider);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const codexPrepared = args.codexPrepared ?? existing.codexPrepared;
    const claudePrepared = args.claudePrepared ?? existing.claudePrepared;
    const nextRecord: ManagedServerRecord = {
      ...existing,
      environmentPrepared: args.environmentPrepared,
      codexPrepared,
      codexVersion: codexPrepared ? (args.codexVersion ?? existing.codexVersion) : undefined,
      claudePrepared,
      claudeVersion: claudePrepared ? (args.claudeVersion ?? existing.claudeVersion) : undefined,
      preparationStatus: args.preparationStatus,
      preparationSummary: args.preparationSummary,
      preparationError: args.preparationError,
      preparedAt: args.environmentPrepared ? now : existing.preparedAt,
      updatedAt: now,
    };
    await this.storage.saveServer(nextRecord);
    return nextRecord;
  }

  async markCloudServerResized(args: {
    userId: string;
    server: CloudServer;
    resizedAt: string;
  }): Promise<ManagedServerRecord | null> {
    const existing = await this.storage.getServer(args.userId, args.server.id, args.server.provider);
    if (!existing) {
      return null;
    }

    const nextRecord: ManagedServerRecord = {
      ...existing,
      name: args.server.name,
      status: mapCloudServerStatus(args.server.status),
      cloudStatus: args.server.status,
      region: args.server.region ?? existing.region,
      size: args.server.size ?? existing.size,
      image: args.server.image ?? existing.image,
      tags: args.server.tags ?? existing.tags,
      publicAddress: args.server.publicAddress ?? existing.publicAddress,
      updatedAt: args.resizedAt,
    };
    await this.storage.saveServer(nextRecord);
    return nextRecord;
  }

  async markDeleted(args: {
    userId: string;
    serverId: number;
    provider?: ManagedServerProvider;
    deleteFailed?: boolean;
  }): Promise<ManagedServerRecord | null> {
    const existing = await this.storage.getServer(args.userId, args.serverId, args.provider);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const nextRecord: ManagedServerRecord = {
      ...existing,
      status: args.deleteFailed ? 'delete_failed' : 'deleted',
      cloudStatus: args.deleteFailed ? existing.cloudStatus : 'deleted',
      deletedAt: args.deleteFailed ? existing.deletedAt : now,
      updatedAt: now,
      isDefaultDevelopment: args.deleteFailed ? existing.isDefaultDevelopment : false,
    };
    if (args.deleteFailed) {
      await this.storage.saveServer(nextRecord);
    } else {
      await this.storage.deleteServer(args.userId, args.serverId, existing.provider);
    }
    return nextRecord;
  }

  async buildRuntimeContext(userId: string): Promise<SessionRuntimeContext | undefined> {
    const servers = await this.storage.listServers(userId);
    if (servers.length === 0) {
      return {
        managedServers: {
          servers: [],
        },
      };
    }

    const activeFirst = [...servers].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'active' ? -1 : 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });

    const developmentRoot = getDefaultDevelopmentRootForSshUser(DEFAULT_DEVELOPMENT_SSH_USER);

    return {
      developmentRoot,
      managedServers: {
        servers: activeFirst.map((server) => ({
          recordId: server.recordId,
          serverId: server.serverId,
          provider: server.provider,
          name: server.name,
          // The retired `default_sandbox` purpose is surfaced as a general development server.
          purpose: server.purpose === 'default_sandbox' ? 'general' : server.purpose,
          status: server.status,
          cloudStatus: server.cloudStatus,
          region: server.region,
          size: server.size,
          publicAddress: server.publicAddress,
          updatedAt: server.updatedAt,
        })),
      },
    };
  }
}
