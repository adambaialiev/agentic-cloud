import { workspaceRecordFor, type WorkspacePurpose } from '../types/user.js';
import {
  type PersonPhotoState,
  type AgentCli,
  type AgentRecord,
  type TelegramAgentTask,
  type TelegramOnboardingState,
  type ProviderUsageSnapshot,
  UserProfileDocument,
  resolveAgentMessagingPolicy,
} from '../types/user.js';
import { normalizeAgentUsername } from '../utils/agent-username.js';

/**
 * Lifecycle fields on one agent record that may be written field-scoped.
 * `null` deletes the field.
 *
 * The `exposed*` pair is here because they are machine-scoped: both describe
 * ports published on `https://<app>.fly.dev`, and that app dies with the
 * machine. Re-provisioning has to clear them in the SAME write that swaps
 * `serverId`, or /agents keeps advertising a URL that 404s.
 */
export interface TelegramAgentFieldUpdates {
  /** The dedicated Workspace assistant can change provider without moving machines. */
  cli?: AgentCli;
  /** The durable turn boundary (note #455): stamped when a work turn ends. */
  lastTurnEndedAt?: string | null;
  /** When that turn started (note #945), stamped in the same write. */
  lastTurnStartedAt?: string | null;
  /** When a recap summary last returned, changed or not (note #945). */
  recapCheckedAt?: string | null;
  /** The post-turn summary's "finished" verdict (note #707); `null` when it judged otherwise. */
  workFinishedAt?: string | null;
  /** Immutable workplace assignment; written by creation/backfill only. */
  orgId?: string | null;
  /** Room assignment inside that org (note #85); `null` exists only to read
   *  or repair a legacy pre-room record. The one field a move rewrites. */
  roomId?: string | null;
  /** The agent's own Workspace line; `null` when it clears it. */
  about?: string | null;
  /** The Workspace Agent's ask to remove this agent (note #710); `null` when the owner keeps it. */
  removeAsk?: AgentRecord['removeAsk'] | null;
  /**
   * The last two jobs this agent was set going on, newest first. Written as
   * the WHOLE array by both its writers — the turn-start recorder, which
   * shifts a new entry in, and `PUT /api/agent-cli/task`, where the agent
   * renames the entry the recorder just wrote — for the same reason
   * `machineRuntimeMs` is: an index path would buy no concurrency and leave
   * two half-written entries possible.
   *
   * The two cannot race in practice: the recorder runs as a turn starts and
   * the agent can only call the CLI from inside one. If they ever did, the
   * loser is one caption on one row, which is why neither takes a lock.
   */
  tasks?: TelegramAgentTask[] | null;
  /** Post-turn summarizer's rolling row line (agent-row-recap-design). */
  recap?: { text: string; at: string } | null;
  /** Last subscription-window stop; cleared after the next admitted turn succeeds. */
  sessionLimit?: AgentRecord['sessionLimit'] | null;
  /** Set by a CLI auth hash-mismatch; `null` when an identity write lands. */
  agentbuiltTokenStale?: boolean | null;
  /** `null` when the agent's machine is recycled — the next turn re-provisions. */
  serverId?: string | null;
  /** Set before the app exists; `null` in the same write that saves `serverId`. */
  provisioningAppName?: string | null;
  /** Grows in the same write that re-points `serverId` away from an app (note #792). */
  retiredMachineApps?: AgentRecord['retiredMachineApps'] | null;
  connectedAt?: string | null;
  oauthPendingAt?: string | null;
  /** `null` in the write that starts a founding agent's setup (note #144). */
  planned?: true | null;
  identityVersion?: number | null;
  /** Branded preview slug — set once at provision; survives rebuilds. */
  previewHostname?: string | null;
  exposedUrl?: string | null;
  exposedPorts?: number[] | null;
  lastActivityAt?: string | null;
  recycleWarnedAt?: string | null;
  cliVersion?: string | null;
  cliVersionCheckedAt?: string | null;
  /** Machine image the machine was last CONFIRMED on (MachineImageUpdater). */
  machineImage?: string | null;
  machineImageCheckedAt?: string | null;
  /** `null` with `serverId` — the machine holding the plaintext token is gone. */
  agentbuiltTokenHash?: string | null;
  /** Platform pool credential pinned to this agent's machine (see AgentRecord). */
  platformCredentialId?: string | null;
  /** Per-agent seat override (note #129); `null` returns the agent to the org default. */
  seatId?: string | null;
  /** Concrete CLI model chosen for this agent; `null` returns to the CLI default. */
  model?: string | null;
  /** Model-aware reasoning effort; `null` returns to that model's default. */
  effort?: string | null;
  /** Who last changed the pair on the person's behalf, until the agent's next turn is told (note #776); `null` once told. */
  runtimeChange?: AgentRecord['runtimeChange'] | null;
  /**
   * Written as the WHOLE map (read-modify-write by its single writer, the
   * runtime meter) — a dot-path per month key would leak `machineRuntimeMs`
   * into the update grammar for no concurrency gain.
   */
  machineRuntimeMs?: Record<string, number> | null;
  /**
   * The machine shape last seen on the control plane (note #356), written
   * whole because it is one fact: three halves of a size that disagree are
   * not a size anybody can read.
   */
  machineSize?: AgentRecord['machineSize'] | null;
  /** ISO stamp riding the same write as `machineSize`. */
  machineSizeAt?: string | null;
  /**
   * Last turn's context fill. `null` clears it, which is what a conversation
   * reset does — an empty window must not keep reporting the old one's.
   */
  contextUsage?: AgentRecord['contextUsage'] | null;
  /** Codex's running token total at the last credited turn (agent/turn-tokens.ts). */
  codexTokenBase?: AgentRecord['codexTokenBase'] | null;
  /** Claude Code's per-model running total at the last credited turn. */
  claudeTokenBase?: AgentRecord['claudeTokenBase'] | null;
  /** The last observed count of running managed jobs (note #564). */
  activeJobs?: AgentRecord['activeJobs'] | null;
}

export interface UserStorage {
  getProfile(userId: string): Promise<UserProfileDocument | null>;
  createProfile(userId: string, data: Partial<UserProfileDocument>): Promise<UserProfileDocument>;
  updateProfile(userId: string, updates: Partial<UserProfileDocument>): Promise<void>;
  /**
   * Field-scoped write of an agent's native CLI conversation continuity ids
   * (`telegram.agents.<agentId>.conversation`). `opts.agentId` pins the write
   * to that exact agent; without it the call no-ops (there is no "active
   * agent" anymore — every turn is pinned). `null` deletes a field. Kept
   * separate from updateProfile so harness turns never clobber concurrent
   * updates to the rest of the telegram state. No-ops when the target agent
   * is missing.
   */
  updateTelegramHarnessConversation(
    userId: string,
    updates: { codexThreadId?: string | null; claudeSessionId?: string | null; opencodeSessionId?: string | null },
    opts?: { agentId?: string },
  ): Promise<void>;
  /** Account-level provider usage, written without replacing the fleet state. */
  updateTelegramProviderUsage?(
    userId: string,
    cli: AgentCli,
    snapshot: ProviderUsageSnapshot,
  ): Promise<void>;
  /**
   * Field-scoped write of top-level telegram bookkeeping fields (the identity
   * mirror, the activity stamp, onboarding milestones). These writers run in
   * the background of live turns, so like the other field-scoped methods they
   * must never replace the whole telegram map — a full-map write from a stale
   * snapshot silently deletes concurrent additions such as a just-reserved
   * pending agent record. `null`/`undefined` deletes a field; `onboarding`
   * keys merge into `telegram.onboarding` (never deleted). No-ops when the
   * user has no telegram link.
   */
  updateTelegramLinkFields(
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
  ): Promise<void>;
  /**
   * Field-scoped write of the human's own profile (`person.*` — the name and
   * face teammates see, note #57). Field-scoped like every other writer here:
   * the profile screen saves concurrently with turn bookkeeping, and a whole-
   * document write from a stale snapshot would clobber it. `null` deletes a
   * field; omitted fields stay as they are.
   */
  updatePersonFields(
    userId: string,
    fields: {
      firstName?: string | null;
      lastName?: string | null;
      photo?: PersonPhotoState | null;
      confirmedAt?: string | null;
      x?: string | null;
    },
  ): Promise<void>;
  /**
   * Field-scoped write of lifecycle fields on ONE agent record
   * (`telegram.agents.<agentId>.<field>`). Setup runs these writers
   * concurrently with bookkeeping and turn activity, so none of them may
   * replace the agents map (or the record) wholesale — a stale full-map write
   * deletes concurrent stamps; it silently un-stamped `oauthPendingAt`
   * mid-sign-in (live, 2026-07-22). `null` deletes a field. Returns false
   * (writing nothing) when the agent record is missing, so callers can fail
   * loud instead of resurrecting a deleted record.
   */
  updateAgentFields(
    userId: string,
    agentId: string,
    fields: TelegramAgentFieldUpdates,
  ): Promise<boolean>;
  /** Atomically reserve the private org-wide assistant. Infrastructure includes
   * this record; regular agent rosters and general chat routes exclude it. */
  /**
   * The person's private record for a workplace — the Workspace Agent by
   * default, or the briefing machine's (note #437) — created on first use
   * and returned as it stands afterwards. Null when the id is taken by a
   * record of another purpose, which no path creates.
   */
  reserveWorkspaceAssistant?(userId: string, orgId: string, purpose?: WorkspacePurpose): Promise<AgentRecord | null>;
  /**
   * Atomically add one admitted work turn to an agent's lifetime total.
   * A legacy record with no counter starts at one; a missing agent returns
   * null. Kept separate from the general field writer so two adjacent turn
   * completions cannot both read the same old value and lose an increment.
   */
  incrementTelegramAgentTurnCount(userId: string, agentId: string): Promise<number | null>;
  /**
   * Delete ONE agent record (`telegram.agents.<agentId>`) and nothing else.
   * Field-scoped for the same reason the writers above are: deletion runs
   * concurrently with turn bookkeeping, and a full-map write from a stale
   * snapshot would resurrect the deleted record (or drop a sibling created
   * since the read). Returns false when the record was already gone, so the
   * caller can tell "deleted it" from "nothing to delete" instead of guessing.
   */
  removeTelegramAgent(userId: string, agentId: string): Promise<boolean>;
  deleteUserData(userId: string): Promise<void>;
  findUserByTelegramUserId(telegramUserId: string): Promise<UserProfileDocument | null>;
  getAllUsers(): Promise<UserProfileDocument[]>;
}

const USERNAME_COLLECTION = 'usernames';


export class InMemoryUserStorage implements UserStorage {
  private profiles = new Map<string, UserProfileDocument>();
  private usernames = new Map<string, string>();

  async getProfile(userId: string): Promise<UserProfileDocument | null> {
    return this.profiles.get(userId) ?? null;
  }

  async createProfile(userId: string, data: Partial<UserProfileDocument>): Promise<UserProfileDocument> {
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
      const existingOwnerUserId = this.usernames.get(username);
      if (existingOwnerUserId && existingOwnerUserId !== userId) {
        throw new Error(`Username ${username} is already in use.`);
      }
    }
    this.profiles.set(userId, profile);
    if (username) {
      this.usernames.set(username, userId);
    }
    return profile;
  }

  async updateProfile(userId: string, updates: Partial<UserProfileDocument>): Promise<void> {
    const profile = this.profiles.get(userId);
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
      const existingOwnerUserId = this.usernames.get(nextUsername);
      if (existingOwnerUserId && existingOwnerUserId !== userId) {
        throw new Error(`Username ${nextUsername} is already in use.`);
      }
    }
    Object.assign(profile, updates, {
      ...(usernameWasUpdated ? { username: nextUsername } : {}),
      ...(updates.agentMessaging !== undefined ? { agentMessaging: nextAgentMessaging } : {}),
      updatedAt: new Date(),
    });
    if (!usernameWasUpdated || nextUsername === currentUsername) {
      return;
    }
    if (currentUsername) {
      this.usernames.delete(currentUsername);
    }
    if (nextUsername) {
      this.usernames.set(nextUsername, userId);
    }
  }

  async updateTelegramHarnessConversation(
    userId: string,
    updates: { codexThreadId?: string | null; claudeSessionId?: string | null; opencodeSessionId?: string | null },
    opts?: { agentId?: string },
  ): Promise<void> {
    const profile = this.profiles.get(userId);
    if (!profile) return;
    const telegram = profile.telegram ?? {};
    const targetAgentId = opts?.agentId;
    const targetAgent = targetAgentId ? telegram.agents?.[targetAgentId] : undefined;
    if (!targetAgentId || !targetAgent) return;
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
  }

  async updateTelegramProviderUsage(
    userId: string,
    cli: AgentCli,
    snapshot: ProviderUsageSnapshot,
  ): Promise<void> {
    const profile = this.profiles.get(userId);
    if (!profile?.telegram) return;
    profile.telegram = {
      ...profile.telegram,
      providerUsage: {
        ...profile.telegram.providerUsage,
        [cli]: snapshot,
      },
    };
    profile.updatedAt = new Date();
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
    const profile = this.profiles.get(userId);
    if (!profile?.telegram) return;
    const { onboarding, ...scalars } = fields;
    const telegram = { ...profile.telegram } as Record<string, unknown> & typeof profile.telegram;
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
    const profile = this.profiles.get(userId);
    if (!profile) return;
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
  }

  async reserveWorkspaceAssistant(userId: string, orgId: string, purpose: WorkspacePurpose = 'workspace-recap'): Promise<AgentRecord | null> {
    const profile = this.profiles.get(userId);
    if (!profile) return null;
    const { id, name } = workspaceRecordFor(purpose, userId, orgId);
    const existing = profile.telegram?.agents?.[id];
    if (existing) {
      if (existing.purpose !== purpose) return null;
      // An assistant reserved under its read-only name is the same record;
      // it takes the agent's name the first time it is reached again.
      if (existing.name === name) return existing;
      const renamed = { ...existing, name };
      profile.telegram = { ...profile.telegram, agents: { ...profile.telegram?.agents, [id]: renamed } };
      return renamed;
    }
    const agent: AgentRecord = { id, orgId, name, purpose, cli: 'codex', createdAt: new Date().toISOString() };
    profile.telegram = { ...profile.telegram, agents: { ...profile.telegram?.agents, [id]: agent } };
    return agent;
  }

  async updateAgentFields(
    userId: string,
    agentId: string,
    fields: TelegramAgentFieldUpdates,
  ): Promise<boolean> {
    const profile = this.profiles.get(userId);
    const telegram = profile?.telegram;
    const targetAgent = telegram?.agents?.[agentId];
    if (!profile || !telegram || !targetAgent) return false;
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
    return true;
  }

  async incrementTelegramAgentTurnCount(userId: string, agentId: string): Promise<number | null> {
    const profile = this.profiles.get(userId);
    const telegram = profile?.telegram;
    const targetAgent = telegram?.agents?.[agentId];
    if (!profile || !telegram || !targetAgent) return null;
    const current = Number.isSafeInteger(targetAgent.turnCount) && (targetAgent.turnCount ?? -1) >= 0
      ? targetAgent.turnCount!
      : 0;
    const turnCount = Math.min(Number.MAX_SAFE_INTEGER, current + 1);
    profile.telegram = {
      ...telegram,
      agents: { ...telegram.agents, [agentId]: { ...targetAgent, turnCount } },
    };
    profile.updatedAt = new Date();
    return turnCount;
  }

  async removeTelegramAgent(userId: string, agentId: string): Promise<boolean> {
    const profile = this.profiles.get(userId);
    const telegram = profile?.telegram;
    if (!profile || !telegram?.agents?.[agentId]) return false;
    const agents = { ...telegram.agents };
    delete agents[agentId];
    profile.telegram = { ...telegram, agents };
    profile.updatedAt = new Date();
    return true;
  }

  async deleteUserData(userId: string): Promise<void> {
    const profile = this.profiles.get(userId);
    if (profile?.username) {
      this.usernames.delete(normalizeAgentUsername(profile.username));
    }
    this.profiles.delete(userId);
  }


  async findUserByTelegramUserId(telegramUserId: string): Promise<UserProfileDocument | null> {
    if (!telegramUserId) {
      return null;
    }

    for (const profile of this.profiles.values()) {
      if (profile.telegram?.telegramUserId === telegramUserId) {
        return profile;
      }
    }

    return null;
  }


  async getAllUsers(): Promise<UserProfileDocument[]> {
    return Array.from(this.profiles.values());
  }
}
