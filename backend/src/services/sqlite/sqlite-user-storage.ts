import { workspaceRecordFor, type WorkspacePurpose } from '../../types/user.js';
import type { AgentRecord } from '../../types/user.js';
import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { UserStorage, TelegramAgentFieldUpdates } from '../user-storage.js';
import {
  type PersonPhotoState,
  type AgentCli,
  type TelegramOnboardingState,
  type ProviderUsageSnapshot,
  UserProfileDocument,
  resolveAgentMessagingPolicy,
} from '../../types/user.js';
import { normalizeAgentUsername } from '../../utils/agent-username.js';

/**
 * SQLite-backed UserStorage. Same document shape and semantics as the
 * InMemory implementation; each mutation is one transaction, so
 * the field-scoped-write guarantees the interface documents (no full-map
 * clobbers) hold trivially — there is exactly one writer process and every
 * method re-reads the row it mutates inside its transaction.
 */
export class SqliteUserStorage implements UserStorage {
  constructor(private readonly db: SqliteDb) {}

  private loadProfile(userId: string): UserProfileDocument | null {
    const row = this.db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId) as { doc: string } | undefined;
    return row ? deserializeDoc<UserProfileDocument>(row.doc) : null;
  }

  private saveProfile(profile: UserProfileDocument): void {
    this.db.prepare(
      'INSERT INTO users (user_id, doc) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET doc = excluded.doc',
    ).run(profile.userId, serializeDoc(profile));
  }

  private usernameOwner(username: string): string | undefined {
    const row = this.db.prepare('SELECT user_id FROM usernames WHERE username = ?').get(username) as { user_id: string } | undefined;
    return row?.user_id;
  }

  /** Run fn inside a transaction and persist the profile it returns. */
  private mutateProfile<T>(
    userId: string,
    fn: (profile: UserProfileDocument) => { result: T; persist: boolean },
    missingResult: T,
  ): T {
    const tx = this.db.transaction((): T => {
      const profile = this.loadProfile(userId);
      if (!profile) return missingResult;
      const { result, persist } = fn(profile);
      if (persist) this.saveProfile(profile);
      return result;
    });
    return tx();
  }

  async getProfile(userId: string): Promise<UserProfileDocument | null> {
    return this.loadProfile(userId);
  }

  async createProfile(userId: string, data: Partial<UserProfileDocument>): Promise<UserProfileDocument> {
    const tx = this.db.transaction((): UserProfileDocument => {
      const now = new Date();
      const username = data.username ? normalizeAgentUsername(data.username) : undefined;
      const profile: UserProfileDocument = {
        userId,
        email: data.email || '',
        displayName: data.displayName || '',
        photoURL: data.photoURL || '',
        username,
        authType: data.authType,
        roles: data.roles ? { ...data.roles } : undefined,
        telegram: data.telegram ? { ...data.telegram } : undefined,
        telegramMemory: data.telegramMemory ? { ...data.telegramMemory } : undefined,
        agentMessaging: resolveAgentMessagingPolicy(data.agentMessaging),
        onboardingCompletedAt: data.onboardingCompletedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      if (username) {
        const existingOwnerUserId = this.usernameOwner(username);
        if (existingOwnerUserId && existingOwnerUserId !== userId) {
          throw new Error(`Username ${username} is already in use.`);
        }
      }
      this.saveProfile(profile);
      if (username) {
        this.db.prepare(
          'INSERT INTO usernames (username, user_id) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET user_id = excluded.user_id',
        ).run(username, userId);
      }
      return profile;
    });
    return tx();
  }

  async updateProfile(userId: string, updates: Partial<UserProfileDocument>): Promise<void> {
    const tx = this.db.transaction(() => {
      const profile = this.loadProfile(userId);
      if (!profile) return;
      const currentUsername = profile.username ? normalizeAgentUsername(profile.username) : undefined;
      const usernameWasUpdated = Object.prototype.hasOwnProperty.call(updates, 'username');
      const nextUsername = typeof updates.username === 'string'
        ? normalizeAgentUsername(updates.username)
        : updates.username;
      const nextAgentMessaging = updates.agentMessaging
        ? resolveAgentMessagingPolicy(updates.agentMessaging)
        : updates.agentMessaging;
      if (usernameWasUpdated && nextUsername && nextUsername !== currentUsername) {
        const existingOwnerUserId = this.usernameOwner(nextUsername);
        if (existingOwnerUserId && existingOwnerUserId !== userId) {
          throw new Error(`Username ${nextUsername} is already in use.`);
        }
      }
      Object.assign(profile, updates, {
        ...(usernameWasUpdated ? { username: nextUsername } : {}),
        ...(updates.agentMessaging !== undefined ? { agentMessaging: nextAgentMessaging } : {}),
        updatedAt: new Date(),
      });
      this.saveProfile(profile);
      if (!usernameWasUpdated || nextUsername === currentUsername) {
        return;
      }
      if (currentUsername) {
        this.db.prepare('DELETE FROM usernames WHERE username = ? AND user_id = ?').run(currentUsername, userId);
      }
      if (nextUsername) {
        this.db.prepare(
          'INSERT INTO usernames (username, user_id) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET user_id = excluded.user_id',
        ).run(nextUsername, userId);
      }
    });
    tx();
  }

  async updateTelegramHarnessConversation(
    userId: string,
    updates: { codexThreadId?: string | null; claudeSessionId?: string | null; opencodeSessionId?: string | null },
    opts?: { agentId?: string },
  ): Promise<void> {
    this.mutateProfile(userId, (profile) => {
      const telegram = profile.telegram ?? {};
      const targetAgentId = opts?.agentId;
      const targetAgent = targetAgentId ? telegram.agents?.[targetAgentId] : undefined;
      if (!targetAgentId || !targetAgent) return { result: undefined, persist: false };
      const conversation = { ...(targetAgent.conversation ?? {}) };
      for (const key of ['codexThreadId', 'claudeSessionId', 'opencodeSessionId'] as const) {
        if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
        const value = updates[key];
        if (value == null) {
          delete conversation[key];
        } else {
          conversation[key] = value;
        }
      }
      profile.telegram = {
        ...telegram,
        agents: {
          ...telegram.agents,
          [targetAgentId]: { ...targetAgent, conversation },
        },
      };
      profile.updatedAt = new Date();
      return { result: undefined, persist: true };
    }, undefined);
  }

  async updateTelegramProviderUsage(
    userId: string,
    cli: AgentCli,
    snapshot: ProviderUsageSnapshot,
  ): Promise<void> {
    this.mutateProfile(userId, (profile) => {
      if (!profile.telegram) return { result: undefined, persist: false };
      profile.telegram = {
        ...profile.telegram,
        providerUsage: {
          ...profile.telegram.providerUsage,
          [cli]: snapshot,
        },
      };
      profile.updatedAt = new Date();
      return { result: undefined, persist: true };
    }, undefined);
  }




  async updateTelegramLinkFields(
    userId: string,
    fields: {
      lastUserActivityAt?: string;
      lastActivityAt?: string;
      lastNotificationAt?: string;
      username?: string | null;
      languageCode?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      onboarding?: Partial<TelegramOnboardingState>;
    },
  ): Promise<void> {
    this.mutateProfile(userId, (profile) => {
      if (!profile.telegram) return { result: undefined, persist: false };
      const { onboarding, ...scalars } = fields;
      const telegram = { ...profile.telegram } as Record<string, unknown> & NonNullable<UserProfileDocument['telegram']>;
      for (const [key, value] of Object.entries(scalars)) {
        if (value == null) {
          delete telegram[key];
        } else {
          telegram[key] = value;
        }
      }
      if (onboarding) {
        const nextOnboarding: Record<string, string> = { ...(telegram.onboarding ?? {}) };
        for (const [key, value] of Object.entries(onboarding)) {
          if (value == null) continue;
          nextOnboarding[key] = value;
        }
        telegram.onboarding = nextOnboarding;
      }
      profile.telegram = telegram;
      profile.updatedAt = new Date();
      return { result: undefined, persist: true };
    }, undefined);
  }

  async updatePersonFields(
    userId: string,
    fields: {
      firstName?: string | null;
      lastName?: string | null;
      photo?: PersonPhotoState | null;
      confirmedAt?: string | null;
      x?: string | null;
    },
  ): Promise<void> {
    this.mutateProfile(userId, (profile) => {
      const person = { ...(profile.person ?? {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (value === null) {
          delete person[key];
        } else {
          person[key] = value;
        }
      }
      profile.person = person;
      profile.updatedAt = new Date();
      return { result: undefined, persist: true };
    }, undefined);
  }

  async reserveWorkspaceAssistant(userId: string, orgId: string, purpose: WorkspacePurpose = 'workspace-recap'): Promise<AgentRecord | null> {
    return this.db.transaction(() => {
      const profile = this.loadProfile(userId);
      if (!profile) return null;
      const { id, name } = workspaceRecordFor(purpose, userId, orgId);
      const existing = profile.telegram?.agents?.[id];
      if (existing) {
        if (existing.purpose !== purpose) return null;
        // Same record, the agent's name: reserved as "Workspace Recap" while
        // it could only read, renamed the first time it is reached again.
        if (existing.name === name) return existing;
        const renamed = { ...existing, name };
        profile.telegram = { ...profile.telegram, agents: { ...profile.telegram?.agents, [id]: renamed } };
        this.saveProfile(profile);
        return renamed;
      }
      const agent: AgentRecord = { id, orgId, name, purpose, cli: 'codex', createdAt: new Date().toISOString() };
      profile.telegram = { ...profile.telegram, agents: { ...profile.telegram?.agents, [id]: agent } };
      this.saveProfile(profile);
      return agent;
    })();
  }

  async updateAgentFields(
    userId: string,
    agentId: string,
    fields: TelegramAgentFieldUpdates,
  ): Promise<boolean> {
    return this.mutateProfile(userId, (profile) => {
      const telegram = profile.telegram;
      const targetAgent = telegram?.agents?.[agentId];
      if (!telegram || !targetAgent) return { result: false, persist: false };
      const updatedAgent = { ...targetAgent } as Record<string, unknown> & typeof targetAgent;
      for (const [key, value] of Object.entries(fields)) {
        if (value == null) {
          delete updatedAgent[key];
        } else {
          updatedAgent[key] = value;
        }
      }
      profile.telegram = {
        ...telegram,
        agents: { ...telegram.agents, [agentId]: updatedAgent },
      };
      profile.updatedAt = new Date();
      return { result: true, persist: true };
    }, false);
  }

  async incrementTelegramAgentTurnCount(userId: string, agentId: string): Promise<number | null> {
    return this.mutateProfile(userId, (profile) => {
      const telegram = profile.telegram;
      const targetAgent = telegram?.agents?.[agentId];
      if (!telegram || !targetAgent) return { result: null, persist: false };
      const current = Number.isSafeInteger(targetAgent.turnCount) && (targetAgent.turnCount ?? -1) >= 0
        ? targetAgent.turnCount!
        : 0;
      const turnCount = Math.min(Number.MAX_SAFE_INTEGER, current + 1);
      profile.telegram = {
        ...telegram,
        agents: { ...telegram.agents, [agentId]: { ...targetAgent, turnCount } },
      };
      profile.updatedAt = new Date();
      return { result: turnCount, persist: true };
    }, null);
  }

  async removeTelegramAgent(userId: string, agentId: string): Promise<boolean> {
    return this.mutateProfile(userId, (profile) => {
      const telegram = profile.telegram;
      if (!telegram?.agents?.[agentId]) return { result: false, persist: false };
      const agents = { ...telegram.agents };
      delete agents[agentId];
      profile.telegram = { ...telegram, agents };
      profile.updatedAt = new Date();
      return { result: true, persist: true };
    }, false);
  }

  async deleteUserData(userId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM usernames WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    });
    tx();
  }


  async findUserByTelegramUserId(telegramUserId: string): Promise<UserProfileDocument | null> {
    if (!telegramUserId) return null;
    return this.findBy((profile) => profile.telegram?.telegramUserId === telegramUserId);
  }


  async getAllUsers(): Promise<UserProfileDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM users').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<UserProfileDocument>(row.doc));
  }

  /**
   * Full scan, like the InMemory finders. At the current user count a scan is
   * faster than maintaining index columns; add generated JSON columns if the
   * users table ever grows past a few thousand rows.
   */
  private findBy(predicate: (profile: UserProfileDocument) => boolean): UserProfileDocument | null {
    for (const row of this.db.prepare('SELECT doc FROM users').iterate() as IterableIterator<{ doc: string }>) {
      const profile = deserializeDoc<UserProfileDocument>(row.doc);
      if (predicate(profile)) return profile;
    }
    return null;
  }
}
