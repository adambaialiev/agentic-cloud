import type {
  ManagedServerProvider,
  ManagedServerService,
} from './managed-server-service.js';
import type { CloudServer } from './cloud-provider.js';
import { SandboxStorage, UserSandboxRecord, UserSandboxState } from './sandbox-storage.js';
import { isFlySandboxId } from './fly-sandbox-id.js';
import type { WorkspaceRuntimeClient, WorkspaceProvisioningClient } from './sandbox-client.js';
import type { CreatedDevelopmentServer } from './sandbox-client.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_SANDBOXES_PER_USER = 5;
const DEFAULT_DEVELOPMENT_SERVER_NAME = 'Development Server';

/**
 * A sandbox is "server-backed" (a real provisioned machine, not a legacy
 * placeholder) when it carries a resolvable provider handle. Two encodings:
 * Hetzner uses a numeric `serverId` behind `hcloud-sandbox-<id>`; Fly uses the
 * opaque `fly-sandbox-<app>.<machine>` sandbox id (its `serverId` is absent,
 * since Fly identity is string-based and lives in the sandbox id itself).
 */
export function isServerBackedSandboxRecord(record: UserSandboxRecord): boolean {
  if (record.provider === 'fly' || isFlySandboxId(record.sandboxId)) {
    return isFlySandboxId(record.sandboxId);
  }
  return (record.provider === 'hetzner' || record.sandboxId.startsWith('hcloud-sandbox-'))
    && typeof record.serverId === 'number'
    && record.serverId > 0;
}

function getManagedProviderForSandbox(sandbox: UserSandboxRecord): ManagedServerProvider | undefined {
  return sandbox.provider === 'hetzner'
    ? sandbox.provider
    : undefined;
}

export class UserDevelopmentEnvironmentManager {
  private runtimeClient: WorkspaceRuntimeClient;
  private storage: SandboxStorage;
  private locks: Map<string, Promise<void>> = new Map();
  private managedServerService?: ManagedServerService;

  constructor(
    runtimeClient: WorkspaceRuntimeClient,
    storage: SandboxStorage,
    managedServerService?: ManagedServerService,
  ) {
    this.runtimeClient = runtimeClient;
    this.storage = storage;
    this.managedServerService = managedServerService;
  }

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.locks.set(userId, queued);

    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      releaseLock();
      if (this.locks.get(userId) === queued) {
        this.locks.delete(userId);
      }
    }
  }

  async listSandboxesForUser(userId: string): Promise<UserSandboxState> {
    return this.storage.getSandboxState(userId);
  }

  async getSandbox(userId: string, sandboxId: string): Promise<UserSandboxRecord | null> {
    return this.storage.getSandbox(userId, sandboxId);
  }

  async getDefaultSandboxForUser(userId: string): Promise<UserSandboxRecord | null> {
    return this.withUserLock(userId, async () => this.resolveExistingDefaultSandboxForUser(userId));
  }

  async ensureDefaultSandboxForUser(userId: string): Promise<UserSandboxRecord> {
    return this.withUserLock(userId, async () => {
      const existingDefaultSandbox = await this.resolveExistingDefaultSandboxForUser(userId);
      if (existingDefaultSandbox) {
        return existingDefaultSandbox;
      }

      return this.createNewSandbox(userId, DEFAULT_DEVELOPMENT_SERVER_NAME, { makeDefault: true });
    });
  }

  async resolveSandboxForSession(userId: string, sandboxId?: string | null): Promise<UserSandboxRecord> {
    if (sandboxId) {
      const sandbox = await this.storage.getSandbox(userId, sandboxId);
      if (!sandbox) {
        throw new Error('Sandbox not found');
      }

      if (this.isServerBackedSandbox(sandbox)) {
        return sandbox;
      }

      return this.replaceLegacySandboxWithServer(userId, sandbox, false);
    }

    const defaultSandbox = await this.getDefaultSandboxForUser(userId);
    if (!defaultSandbox) {
      throw new Error('Sandbox not found');
    }
    return defaultSandbox;
  }

  async createSandbox(userId: string, name: string): Promise<UserSandboxRecord> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Sandbox name is required');
    }

    return this.withUserLock(userId, async () => {
      const state = await this.storage.getSandboxState(userId);
      if (state.sandboxes.length >= MAX_SANDBOXES_PER_USER) {
        throw new Error(`Maximum of ${MAX_SANDBOXES_PER_USER} sandboxes reached`);
      }

      return this.createNewSandbox(userId, trimmedName);
    });
  }

  /**
   * Update last used timestamp for a user's sandbox
   */
  async touchSandbox(userId: string, sandboxId: string): Promise<void> {
    await this.storage.updateLastUsed(userId, sandboxId);
  }

  /**
   * Admin cleanup: destroy all sandboxes for a user.
   */
  async destroyUserSandbox(userId: string): Promise<void> {
    const state = await this.storage.getSandboxState(userId);

    for (const sandbox of state.sandboxes) {
      try {
        if (this.isServerBackedSandbox(sandbox)) {
          await this.runtimeClient.destroySandbox(sandbox.sandboxId);
          if (this.managedServerService && sandbox.serverId) {
            await this.managedServerService.markDeleted({
              userId,
              serverId: sandbox.serverId,
              provider: getManagedProviderForSandbox(sandbox),
            });
          }
        }
      } catch (error) {
        console.error(`Failed to destroy sandbox ${sandbox.sandboxId}:`, error);
      }

      await this.storage.deleteSandbox(userId, sandbox.sandboxId);
    }

    await this.storage.deleteUserState(userId);
  }

  /**
   * Reset a user's sandbox: create a new backing sandbox, swap it into storage,
   * and destroy the old instance asynchronously.
   */
  async resetSandbox(userId: string, sandboxId: string): Promise<{ oldSandboxId: string; sandbox: UserSandboxRecord }> {
    return this.withUserLock(userId, async () => {
      const currentSandbox = await this.storage.getSandbox(userId, sandboxId);
      if (!currentSandbox) {
        throw new Error('Sandbox not found');
      }

      const state = await this.storage.getSandboxState(userId);
      const replacementSandbox = await this.createProviderSandboxRecord(userId, currentSandbox.name, {
        makeDefault: state.defaultSandboxId === currentSandbox.sandboxId,
      });
      await this.storage.replaceSandbox(userId, currentSandbox.sandboxId, replacementSandbox);

      if (this.isServerBackedSandbox(currentSandbox)) {
        this.runtimeClient.destroySandbox(currentSandbox.sandboxId).catch((error) => {
          console.error(`Failed to destroy old sandbox ${currentSandbox.sandboxId}:`, error);
        });
        if (this.managedServerService && currentSandbox.serverId) {
          this.managedServerService.markDeleted({
            userId,
            serverId: currentSandbox.serverId,
            provider: getManagedProviderForSandbox(currentSandbox),
          }).catch((error) => {
            console.error(`Failed to mark old sandbox server ${currentSandbox.serverId} deleted:`, error);
          });
        }
      }

      return {
        oldSandboxId: currentSandbox.sandboxId,
        sandbox: replacementSandbox,
      };
    });
  }

  /**
   * Create a new sandbox with retry logic
   */
  private async createProviderSandboxRecord(
    userId: string,
    name: string,
    options?: { makeDefault?: boolean },
  ): Promise<UserSandboxRecord> {
    if (!this.canProvisionServerSandbox()) {
      throw new Error('Sandbox provisioning is unavailable because the managed server provider is not configured.');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const provisioner = this.getProvisioningClient();
        if (!provisioner) {
          throw new Error('Sandbox provisioning client is unavailable.');
        }
        const makeDefault = options?.makeDefault ?? await this.shouldMakeNextSandboxDefault(userId);
        const createdSandbox = await provisioner.createDevelopmentSandbox({
          userId,
          name,
          tags: this.buildSandboxTags(userId, makeDefault),
          prepareEnvironment: true,
        });
        return this.buildSandboxRecordFromCreatedSandbox(
          userId,
          name,
          createdSandbox,
          makeDefault,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`Sandbox creation attempt ${attempt + 1}/${MAX_RETRIES} failed:`, error);

        if (attempt < MAX_RETRIES - 1) {
          // Exponential backoff
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`Failed to create sandbox after ${MAX_RETRIES} attempts: ${lastError?.message}`);
  }

  private async createNewSandbox(
    userId: string,
    name: string,
    options?: { makeDefault?: boolean },
  ): Promise<UserSandboxRecord> {
    const existingDefaultSandbox = await this.storage.getDefaultSandbox(userId);
    const effectiveOptions = {
      makeDefault: options?.makeDefault ?? !existingDefaultSandbox,
    };
    const record = await this.createProviderSandboxRecord(userId, name, effectiveOptions);
    await this.storage.saveSandbox(userId, record, effectiveOptions);
    console.log(`Created new development server ${record.sandboxId} (${record.name}) for user ${userId}`);
    return record;
  }

  private canProvisionServerSandbox(): boolean {
    return Boolean(this.getProvisioningClient());
  }

  private async resolveExistingDefaultSandboxForUser(userId: string): Promise<UserSandboxRecord | null> {
    const defaultSandbox = await this.storage.getDefaultSandbox(userId);
    if (defaultSandbox) {
      if (this.isServerBackedSandbox(defaultSandbox)) {
        return defaultSandbox;
      }

      return this.replaceLegacySandboxWithServer(userId, defaultSandbox, true);
    }

    const state = await this.storage.getSandboxState(userId);
    if (state.sandboxes.length === 0) {
      return null;
    }

    const fallbackSandbox = state.sandboxes[0];
    if (this.isServerBackedSandbox(fallbackSandbox)) {
      await this.storage.setDefaultSandbox(userId, fallbackSandbox.sandboxId);
      return fallbackSandbox;
    }

    return this.replaceLegacySandboxWithServer(userId, fallbackSandbox, true);
  }

  private getProvisioningClient(): WorkspaceProvisioningClient | null {
    const candidate = this.runtimeClient as Partial<WorkspaceProvisioningClient>;
    return typeof candidate.createDevelopmentSandbox === 'function'
      && typeof candidate.getDefaultSandboxSize === 'function'
      ? candidate as WorkspaceProvisioningClient
      : null;
  }

  private isServerBackedSandbox(record: UserSandboxRecord): boolean {
    return isServerBackedSandboxRecord(record);
  }

  private async shouldMakeNextSandboxDefault(userId: string): Promise<boolean> {
    const currentDefault = await this.storage.getDefaultSandbox(userId);
    return !currentDefault || !this.isServerBackedSandbox(currentDefault);
  }

  private buildSandboxTags(userId: string, makeDefault: boolean): string[] {
    const userSegment = userId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'user';
    return [
      'sumai-sandbox',
      `user-${userSegment}`,
      makeDefault ? 'default-development' : 'development',
    ];
  }

  private resolveCreatedServer(createdSandbox: CreatedDevelopmentServer): CloudServer {
    if (createdSandbox.server) {
      return createdSandbox.server;
    }

    throw new Error('Provisioning client returned no server metadata.');
  }

  private async buildSandboxRecordFromCreatedSandbox(
    userId: string,
    name: string,
    createdSandbox: CreatedDevelopmentServer,
    makeDefault: boolean,
  ): Promise<UserSandboxRecord> {
    const now = new Date();
    const server = this.resolveCreatedServer(createdSandbox);
    if (server.provider !== 'hetzner' && server.provider !== 'fly') {
      throw new Error(`Provisioning client returned unsupported provider ${server.provider}.`);
    }
    // Fly identifies machines by an opaque string (encoded in the sandbox id),
    // not the numeric `serverId` the Hetzner/managed-server path tracks.
    const isNumericIdProvider = server.provider === 'hetzner';
    const record: UserSandboxRecord = {
      sandboxId: createdSandbox.sandboxId,
      name,
      provider: server.provider,
      status: server.status === 'new' || server.status === 'initializing' || server.status === 'starting'
        ? 'creating'
        : 'running',
      ...(isNumericIdProvider ? { serverId: server.id } : {}),
      region: server.region,
      size: server.size,
      publicAddress: server.publicAddress,
      environmentPrepared: createdSandbox.environmentPrepared,
      codexPrepared: createdSandbox.codexPrepared,
      codexVersion: createdSandbox.codexVersion,
      claudePrepared: createdSandbox.claudePrepared,
      claudeVersion: createdSandbox.claudeVersion,
      preparationStatus: createdSandbox.preparationStatus,
      createdAt: now,
      lastUsedAt: now,
    };

    // Only numeric-id cloud providers are tracked in managed-server storage
    // (its record ids and lookups are numeric). Fly agents are registered by
    // the setup-agent tools against the string `serverId` on the agent record.
    if (this.managedServerService && isNumericIdProvider) {
      await this.managedServerService.registerCreatedCloudServer({
        userId,
        server,
        purpose: 'general',
      });
      await this.managedServerService.updatePreparationState({
        userId,
        serverId: server.id,
        provider: server.provider,
        environmentPrepared: createdSandbox.environmentPrepared,
        codexPrepared: createdSandbox.codexPrepared,
        codexVersion: createdSandbox.codexVersion,
        claudePrepared: createdSandbox.claudePrepared,
        claudeVersion: createdSandbox.claudeVersion,
          preparationStatus: createdSandbox.preparationStatus,
        preparationSummary: createdSandbox.preparationSummary,
        preparationError: createdSandbox.preparationError,
      });
    }

    return record;
  }

  private async replaceLegacySandboxWithServer(
    userId: string,
    legacySandbox: UserSandboxRecord,
    makeDefault: boolean,
  ): Promise<UserSandboxRecord> {
    const replacement = await this.createProviderSandboxRecord(userId, legacySandbox.name, {
      makeDefault,
    });
    await this.storage.replaceSandbox(userId, legacySandbox.sandboxId, replacement);
    if (makeDefault) {
      await this.storage.setDefaultSandbox(userId, replacement.sandboxId);
    }
    return replacement;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
