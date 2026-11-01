
export interface UserSandboxRecord {
  sandboxId: string;
  name: string;
  provider?: 'hetzner' | 'fly' | 'sumai';
  status: 'creating' | 'running' | 'stopped' | 'expired' | 'error';
  serverId?: number;
  region?: string;
  size?: string;
  publicAddress?: string;
  environmentPrepared?: boolean;
  codexPrepared?: boolean;
  codexVersion?: string;
  claudePrepared?: boolean;
  claudeVersion?: string;
  preparationStatus?: 'not_requested' | 'pending' | 'succeeded' | 'failed';
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt?: Date;
}

export interface UserSandboxState {
  defaultSandboxId: string | null;
  sandboxes: UserSandboxRecord[];
}

export interface SandboxStorage {
  getSandboxState(userId: string): Promise<UserSandboxState>;
  listSandboxes(userId: string): Promise<UserSandboxRecord[]>;
  getSandbox(userId: string, sandboxId: string): Promise<UserSandboxRecord | null>;
  getDefaultSandbox(userId: string): Promise<UserSandboxRecord | null>;
  saveSandbox(userId: string, record: UserSandboxRecord, options?: { makeDefault?: boolean }): Promise<void>;
  replaceSandbox(userId: string, previousSandboxId: string, record: UserSandboxRecord): Promise<void>;
  updateLastUsed(userId: string, sandboxId: string): Promise<void>;
  updateStatus(userId: string, sandboxId: string, status: UserSandboxRecord['status']): Promise<void>;
  setDefaultSandbox(userId: string, sandboxId: string): Promise<void>;
  deleteSandbox(userId: string, sandboxId: string): Promise<void>;
  deleteUserState(userId: string): Promise<void>;
}

const COLLECTION_NAME = 'user_sandboxes';

function cloneSandboxRecord(record: UserSandboxRecord): UserSandboxRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    lastUsedAt: new Date(record.lastUsedAt),
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
  };
}

function cloneSandboxState(state: UserSandboxState): UserSandboxState {
  return {
    defaultSandboxId: state.defaultSandboxId,
    sandboxes: state.sandboxes.map(cloneSandboxRecord),
  };
}

function toDate(value: unknown): Date | undefined {
  if (value == null) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'object' && value !== null && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function fallbackSandboxName(index: number, isDefault: boolean): string {
  if (isDefault || index === 0) {
    return 'Default Sandbox';
  }

  return `Sandbox ${index + 1}`;
}

function normalizeSandboxRecord(
  value: Record<string, unknown>,
  index: number,
  defaultSandboxId: string | null,
): UserSandboxRecord | null {
  const sandboxId = typeof value.sandboxId === 'string' ? value.sandboxId : null;
  if (!sandboxId) {
    return null;
  }

  const name = typeof value.name === 'string' && value.name.trim().length > 0
    ? value.name.trim()
    : fallbackSandboxName(index, sandboxId === defaultSandboxId);

  return {
    sandboxId,
    name,
    provider: value.provider === 'hetzner' || value.provider === 'fly' || value.provider === 'sumai'
      ? value.provider
      : sandboxId.startsWith('fly-sandbox-')
        ? 'fly'
        : sandboxId.startsWith('hcloud-sandbox-')
          ? 'hetzner'
          : (
              typeof value.serverId === 'number'
                ? 'hetzner'
                : 'sumai'
            ),
    status: (
      value.status === 'creating'
      || value.status === 'running'
      || value.status === 'stopped'
      || value.status === 'expired'
      || value.status === 'error'
    )
      ? value.status
      : 'running',
    serverId: Number.isFinite(Number(value.serverId))
      ? Math.max(1, Math.floor(Number(value.serverId)))
      : undefined,
    region: typeof value.region === 'string' ? value.region : undefined,
    size: typeof value.size === 'string' ? value.size : undefined,
    publicAddress: typeof value.publicAddress === 'string' ? value.publicAddress : undefined,
    environmentPrepared: typeof value.environmentPrepared === 'boolean' ? value.environmentPrepared : undefined,
    codexPrepared: typeof value.codexPrepared === 'boolean' ? value.codexPrepared : undefined,
    codexVersion: typeof value.codexVersion === 'string' && value.codexVersion.trim()
      ? value.codexVersion.trim()
      : undefined,
    claudePrepared: typeof value.claudePrepared === 'boolean' ? value.claudePrepared : undefined,
    claudeVersion: typeof value.claudeVersion === 'string' && value.claudeVersion.trim()
      ? value.claudeVersion.trim()
      : undefined,
    preparationStatus: (
      value.preparationStatus === 'not_requested'
      || value.preparationStatus === 'pending'
      || value.preparationStatus === 'succeeded'
      || value.preparationStatus === 'failed'
    )
      ? value.preparationStatus
      : undefined,
    createdAt: toDate(value.createdAt) ?? new Date(),
    lastUsedAt: toDate(value.lastUsedAt) ?? new Date(),
    expiresAt: toDate(value.expiresAt),
  };
}

function normalizeSandboxState(state: UserSandboxState): UserSandboxState {
  const sandboxes = state.sandboxes.map(cloneSandboxRecord);
  const hasDefault = !!state.defaultSandboxId && sandboxes.some((sandbox) => sandbox.sandboxId === state.defaultSandboxId);

  return {
    defaultSandboxId: sandboxes.length === 0
      ? null
      : (hasDefault ? state.defaultSandboxId : sandboxes[0].sandboxId),
    sandboxes,
  };
}

function parseSandboxState(data: Record<string, unknown> | undefined): UserSandboxState {
  if (!data) {
    return { defaultSandboxId: null, sandboxes: [] };
  }

  if (Array.isArray(data.sandboxes)) {
    const requestedDefaultSandboxId = typeof data.defaultSandboxId === 'string' ? data.defaultSandboxId : null;
    const sandboxes = data.sandboxes
      .map((value, index) => {
        if (typeof value !== 'object' || value === null) {
          return null;
        }

        return normalizeSandboxRecord(value as Record<string, unknown>, index, requestedDefaultSandboxId);
      })
      .filter((value): value is UserSandboxRecord => value !== null);

    return normalizeSandboxState({
      defaultSandboxId: requestedDefaultSandboxId,
      sandboxes,
    });
  }

  const legacyRecord = normalizeSandboxRecord(data, 0, typeof data.sandboxId === 'string' ? data.sandboxId : null);
  if (!legacyRecord) {
    return { defaultSandboxId: null, sandboxes: [] };
  }

  return {
    defaultSandboxId: legacyRecord.sandboxId,
    sandboxes: [legacyRecord],
  };
}

function serializeSandboxState(state: UserSandboxState): Record<string, unknown> {
  const normalized = normalizeSandboxState(state);
  return {
    defaultSandboxId: normalized.defaultSandboxId,
    sandboxes: normalized.sandboxes.map((sandbox) => ({
      sandboxId: sandbox.sandboxId,
      name: sandbox.name,
      provider: sandbox.provider ?? null,
      status: sandbox.status,
      serverId: sandbox.serverId ?? null,
      region: sandbox.region ?? null,
      size: sandbox.size ?? null,
      publicAddress: sandbox.publicAddress ?? null,
      environmentPrepared: typeof sandbox.environmentPrepared === 'boolean' ? sandbox.environmentPrepared : null,
      codexPrepared: typeof sandbox.codexPrepared === 'boolean' ? sandbox.codexPrepared : null,
      codexVersion: sandbox.codexVersion ?? null,
      claudePrepared: typeof sandbox.claudePrepared === 'boolean' ? sandbox.claudePrepared : null,
      claudeVersion: sandbox.claudeVersion ?? null,
      preparationStatus: sandbox.preparationStatus ?? null,
      createdAt: sandbox.createdAt,
      lastUsedAt: sandbox.lastUsedAt,
      expiresAt: sandbox.expiresAt ?? null,
    })),
  };
}


/**
 * In-memory implementation for development/testing when SQLite is not configured
 */
export class InMemorySandboxStorage implements SandboxStorage {
  private storage: Map<string, UserSandboxState> = new Map();

  async getSandboxState(userId: string): Promise<UserSandboxState> {
    return cloneSandboxState(this.storage.get(userId) ?? { defaultSandboxId: null, sandboxes: [] });
  }

  async listSandboxes(userId: string): Promise<UserSandboxRecord[]> {
    return (await this.getSandboxState(userId)).sandboxes;
  }

  async getSandbox(userId: string, sandboxId: string): Promise<UserSandboxRecord | null> {
    const sandbox = (await this.getSandboxState(userId)).sandboxes.find((candidate) => candidate.sandboxId === sandboxId);
    return sandbox ? cloneSandboxRecord(sandbox) : null;
  }

  async getDefaultSandbox(userId: string): Promise<UserSandboxRecord | null> {
    const state = await this.getSandboxState(userId);
    const sandbox = state.defaultSandboxId
      ? state.sandboxes.find((candidate) => candidate.sandboxId === state.defaultSandboxId)
      : state.sandboxes[0];
    return sandbox ? cloneSandboxRecord(sandbox) : null;
  }

  async saveSandbox(userId: string, record: UserSandboxRecord, options?: { makeDefault?: boolean }): Promise<void> {
    const state = await this.getSandboxState(userId);
    const existingIndex = state.sandboxes.findIndex((sandbox) => sandbox.sandboxId === record.sandboxId);
    if (existingIndex === -1) {
      state.sandboxes.push(cloneSandboxRecord(record));
    } else {
      state.sandboxes[existingIndex] = cloneSandboxRecord(record);
    }

    if (options?.makeDefault || !state.defaultSandboxId) {
      state.defaultSandboxId = record.sandboxId;
    }

    this.storage.set(userId, normalizeSandboxState(state));
  }

  async replaceSandbox(userId: string, previousSandboxId: string, record: UserSandboxRecord): Promise<void> {
    const state = await this.getSandboxState(userId);
    state.sandboxes = state.sandboxes.map((sandbox) => (
      sandbox.sandboxId === previousSandboxId
        ? cloneSandboxRecord(record)
        : sandbox
    ));

    if (state.defaultSandboxId === previousSandboxId) {
      state.defaultSandboxId = record.sandboxId;
    }

    this.storage.set(userId, normalizeSandboxState(state));
  }

  async updateLastUsed(userId: string, sandboxId: string): Promise<void> {
    const state = await this.getSandboxState(userId);
    state.sandboxes = state.sandboxes.map((sandbox) => (
      sandbox.sandboxId === sandboxId
        ? { ...sandbox, lastUsedAt: new Date() }
        : sandbox
    ));
    this.storage.set(userId, normalizeSandboxState(state));
  }

  async updateStatus(userId: string, sandboxId: string, status: UserSandboxRecord['status']): Promise<void> {
    const state = await this.getSandboxState(userId);
    state.sandboxes = state.sandboxes.map((sandbox) => (
      sandbox.sandboxId === sandboxId
        ? { ...sandbox, status }
        : sandbox
    ));
    this.storage.set(userId, normalizeSandboxState(state));
  }

  async setDefaultSandbox(userId: string, sandboxId: string): Promise<void> {
    const state = await this.getSandboxState(userId);
    if (!state.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId)) {
      return;
    }

    state.defaultSandboxId = sandboxId;
    this.storage.set(userId, normalizeSandboxState(state));
  }

  async deleteSandbox(userId: string, sandboxId: string): Promise<void> {
    const state = await this.getSandboxState(userId);
    state.sandboxes = state.sandboxes.filter((sandbox) => sandbox.sandboxId !== sandboxId);
    if (state.defaultSandboxId === sandboxId) {
      state.defaultSandboxId = state.sandboxes[0]?.sandboxId ?? null;
    }
    this.storage.set(userId, normalizeSandboxState(state));
  }

  async deleteUserState(userId: string): Promise<void> {
    this.storage.delete(userId);
  }
}
