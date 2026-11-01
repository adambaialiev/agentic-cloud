import { Timestamp } from '../types/timestamp.js';
import { AgentMessage } from '../types/agent.js';
import {
  AgentSessionDocument,
  AgentSessionStatus,
  AgentType,
  ClarifyingQuestionState,
  AutonomousState,
  PersistedBlockerState,
  PersistedPlanState,
} from '../types/persistence.js';
import type { SessionRuntimeContext } from '../types/runtime-context.js';
import { resolveAgentType } from '../utils/agent-type.js';


export type SessionUpdateFields = Partial<
  Pick<
    AgentSessionDocument,
    | 'sandboxId'
    | 'machineName'
    | 'status'
    | 'agentType'
    | 'model'
    | 'runtimeContext'
    | 'plan'
    | 'observations'
    | 'activeHypothesis'
    | 'touchedFiles'
    | 'blocker'
    | 'progress'
    | 'title'
    | 'pendingClarification'
    | 'clarifyingQuestion'
    | 'lastError'
    | 'lastErrorType'
    | 'lastAssistantMessage'
    | 'lastAssistantMessageAt'
    | 'telegramReplyDirective'
    | 'tokenUsage'
    | 'isAutonomous'
    | 'autonomousState'
    | 'mission'
    | 'thinkingTime'
    | 'runner'
    | 'shutdownCheckpointAt'
    | 'codexThreadId'
    | 'claudeSessionId'
  >
> & {
};

export type SessionRunnerStateUpdateFields = Partial<
  Pick<
    AgentSessionDocument,
    | 'thinkingTime'
    | 'runner'
    | 'shutdownCheckpointAt'
  >
>;

export interface HistoryReplayUpdate {
  seq: number;
  replayThinking?: string;
  replayContent?: string;
  toolCalls?: AgentMessage['toolCalls'];
  attachments?: AgentMessage['attachments'];
}

export interface SessionHistoryPage {
  messages: AgentMessage[];
  oldestLoadedSeq: number | null;
  hasMoreHistory: boolean;
}

type LatestUserMessageRole = Extract<AgentMessage['role'], 'user' | 'assistant'>;
type AdminVisibleConversationMessage = AgentMessage & { role: LatestUserMessageRole };

export interface LatestUserMessageSummary {
  userId: string;
  sessionId: string;
  role: LatestUserMessageRole;
  content: string;
  createdAt: string | null;
}

export interface SessionStorage {
  getSession(userId: string, sessionId: string): Promise<AgentSessionDocument | null>;
  getHistory(userId: string, sessionId: string): Promise<AgentMessage[]>;
  getHistoryPage?(
    userId: string,
    sessionId: string,
    options?: {
      beforeSeq?: number;
      limit?: number;
    },
  ): Promise<SessionHistoryPage>;
  createSession(sessionId: string, userId: string, options?: {
    sandboxId?: string;
    machineName?: string;
    isAutonomous?: boolean;
    agentType?: AgentType;
    autonomousState?: AutonomousState;
    mission?: string;
    model?: string;
    runtimeContext?: SessionRuntimeContext;
    observations?: string[];
    touchedFiles?: string[];
    plan?: PersistedPlanState;
    blocker?: PersistedBlockerState;
    title?: string;
  }): Promise<AgentSessionDocument>;
  updateSession(
    userId: string,
    sessionId: string,
    updates: SessionUpdateFields
  ): Promise<void>;
  updateSessionRunnerState?(
    userId: string,
    sessionId: string,
    updates: SessionRunnerStateUpdateFields
  ): Promise<void>;
  addToHistory(userId: string, sessionId: string, message: AgentMessage): Promise<void>;
  clearSessionHistory(userId: string, sessionId: string): Promise<void>;
  updateHistoryReplayData?(
    userId: string,
    sessionId: string,
    updates: HistoryReplayUpdate[],
  ): Promise<void>;
  claimClarificationAnswer?(userId: string, sessionId: string): Promise<boolean>;
  getSessionsForUser?(userId: string, options?: { limit?: number }): Promise<AgentSessionDocument[]>;
  getLatestUserMessages?(userIds: string[]): Promise<Record<string, LatestUserMessageSummary>>;
  replaceSandboxForUser?(userId: string, previousSandboxId: string, nextSandboxId: string): Promise<void>;
  deleteSession?(userId: string, sessionId: string): Promise<void>;
}

export const INITIAL_TRIGGER = "Hi, I just started a new session. Please introduce yourself and ask what I'd like you to help me with.";
const LATEST_USER_MESSAGE_PAGE_SIZE = 50;
const LATEST_USER_MESSAGE_USER_QUERY_BATCH_SIZE = 10;

function timestampMillis(value: unknown): number {
  if (!value) {
    return Number.NaN;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  if (value instanceof Date) {
    const timestampMs = value.getTime();
    return Number.isFinite(timestampMs) ? timestampMs : Number.NaN;
  }

  if (typeof value === 'string') {
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : Number.NaN;
  }

  if (typeof value === 'object') {
    const timestampLike = value as {
      toMillis?: unknown;
      toDate?: unknown;
      seconds?: unknown;
      nanoseconds?: unknown;
    };

    if (typeof timestampLike.toMillis === 'function') {
      const timestampMs = timestampLike.toMillis();
      return Number.isFinite(timestampMs) ? timestampMs : Number.NaN;
    }

    if (typeof timestampLike.toDate === 'function') {
      const timestampMs = timestampLike.toDate().getTime();
      return Number.isFinite(timestampMs) ? timestampMs : Number.NaN;
    }

    if (typeof timestampLike.seconds === 'number') {
      const nanoseconds = typeof timestampLike.nanoseconds === 'number' ? timestampLike.nanoseconds : 0;
      return (timestampLike.seconds * 1000) + (nanoseconds / 1_000_000);
    }
  }

  return Number.NaN;
}

function timestampIsoString(value: unknown): string | undefined {
  const timestampMs = timestampMillis(value);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
}

function isAdminVisibleConversationMessage(message: AgentMessage): message is AdminVisibleConversationMessage {
  return (message.role === 'user' || message.role === 'assistant')
    && message.content.trim().length > 0
    && message.content !== INITIAL_TRIGGER;
}

function compareLatestUserMessages(
  left: LatestUserMessageSummary | null,
  right: LatestUserMessageSummary | null,
): number {
  const leftMs = timestampMillis(left?.createdAt);
  const rightMs = timestampMillis(right?.createdAt);

  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (Number.isFinite(leftMs) && !Number.isFinite(rightMs)) {
    return 1;
  }
  if (!Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return -1;
  }
  return 0;
}

function getSessionTimestampMs(value: unknown): number | null {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const millis = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareSessionsByUpdatedAtDesc(
  left: AgentSessionDocument,
  right: AgentSessionDocument,
): number {
  const rightMs = getSessionTimestampMs(right.updatedAt) ?? 0;
  const leftMs = getSessionTimestampMs(left.updatedAt) ?? 0;
  if (rightMs !== leftMs) {
    return rightMs - leftMs;
  }
  return `${left.userId}/${left.sessionId}`.localeCompare(`${right.userId}/${right.sessionId}`);
}


/**
 * In-memory implementation for development/testing when SQLite is not configured
 */
export class InMemorySessionStorage implements SessionStorage {
  private storage: Map<string, AgentSessionDocument> = new Map();

  private storageKey(userId: string, sessionId: string): string {
    return `${userId}/${sessionId}`;
  }

  async getSession(userId: string, sessionId: string): Promise<AgentSessionDocument | null> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session) return null;
    // Return copy without history — callers that need it use getHistory() separately.
    return {
      ...session,
      agentType: resolveAgentType(session.agentType, session.isAutonomous),
      history: [],
    };
  }

  async getHistory(userId: string, sessionId: string): Promise<AgentMessage[]> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session) {
      return [];
    }

    return session.history.map((message) => ({ ...message }));
  }

  async getHistoryPage(
    userId: string,
    sessionId: string,
    options?: {
      beforeSeq?: number;
      limit?: number;
    },
  ): Promise<SessionHistoryPage> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session) {
      return { messages: [], oldestLoadedSeq: null, hasMoreHistory: false };
    }

    const requestedLimit = Math.trunc(options?.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;
    const beforeSeq = typeof options?.beforeSeq === 'number' && Number.isFinite(options.beforeSeq)
      ? options.beforeSeq
      : undefined;

    if (beforeSeq != null && beforeSeq <= 0) {
      return { messages: [], oldestLoadedSeq: null, hasMoreHistory: false };
    }

    const eligibleMessages = session.history.filter((message) => {
      if (beforeSeq == null) {
        return true;
      }
      return typeof message.seq === 'number' && message.seq < beforeSeq;
    });

    const pageMessages = eligibleMessages
      .slice(-limit)
      .map((message) => ({ ...message }));
    const oldestLoadedSeq = pageMessages.reduce<number | null>((oldest, message) => {
      if (typeof message.seq !== 'number') {
        return oldest;
      }
      if (oldest == null || message.seq < oldest) {
        return message.seq;
      }
      return oldest;
    }, null);

    return {
      messages: pageMessages,
      oldestLoadedSeq,
      hasMoreHistory: oldestLoadedSeq != null && oldestLoadedSeq > 0,
    };
  }

  async createSession(sessionId: string, userId: string, options?: {
    sandboxId?: string;
    machineName?: string;
    isAutonomous?: boolean;
    agentType?: AgentType;
    autonomousState?: AutonomousState;
    mission?: string;
    model?: string;
    runtimeContext?: SessionRuntimeContext;
    observations?: string[];
    touchedFiles?: string[];
    plan?: PersistedPlanState;
    blocker?: PersistedBlockerState;
    title?: string;
  }): Promise<AgentSessionDocument> {
    const now = Timestamp.now();
    const agentType = resolveAgentType(options?.agentType, options?.isAutonomous);
    const session: AgentSessionDocument = {
      sessionId,
      userId,
      sandboxId: options?.sandboxId,
      machineName: options?.machineName,
      status: 'idle',
      agentType,
      model: options?.model,
      runtimeContext: options?.runtimeContext,
      plan: options?.plan,
      observations: options?.observations ?? [],
      activeHypothesis: undefined,
      touchedFiles: options?.touchedFiles,
      blocker: options?.blocker,
      history: [],
      messageCount: 0,
      title: options?.title,
      pendingClarification: false,
      telegramReplyDirective: undefined,
      isAutonomous: options?.isAutonomous,
      autonomousState: options?.autonomousState,
      mission: options?.mission,
      createdAt: now,
      updatedAt: now,
    };
    this.storage.set(this.storageKey(userId, sessionId), session);
    return {
      ...session,
      agentType: resolveAgentType(session.agentType, session.isAutonomous),
      history: [],
    };
  }

  async updateSession(
    userId: string,
    sessionId: string,
    updates: SessionUpdateFields
  ): Promise<void> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (session) {
      Object.assign(session, updates, { updatedAt: Timestamp.now() });
    }
  }

  async updateSessionRunnerState(
    userId: string,
    sessionId: string,
    updates: SessionRunnerStateUpdateFields
  ): Promise<void> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session) {
      return;
    }

    Object.assign(session, updates);
  }

  async addToHistory(userId: string, sessionId: string, message: AgentMessage): Promise<void> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (session) {
      if (message.seq == null) {
        message.seq = session.messageCount;
      }
      message.createdAt = message.createdAt ?? new Date().toISOString();
      session.history.push(message);
      session.messageCount = session.history.length;

      // Set title from first non-trigger user message
      if (!session.title && message.role === 'user' && message.content !== INITIAL_TRIGGER) {
        const text = message.content.slice(0, 60);
        session.title = text.length < message.content.length ? text + '…' : text;
      }

      session.updatedAt = Timestamp.now();

    }
  }

  async clearSessionHistory(userId: string, sessionId: string): Promise<void> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session) {
      return;
    }

    session.history = [];
    session.messageCount = 0;
    session.status = 'idle';
    session.observations = [];
    session.plan = undefined;
    session.activeHypothesis = undefined;
    session.touchedFiles = undefined;
    session.blocker = undefined;
    session.progress = undefined;
    session.pendingClarification = false;
    session.clarifyingQuestion = undefined;
    session.lastError = undefined;
    session.lastErrorType = undefined;
    session.lastAssistantMessage = undefined;
    session.lastAssistantMessageAt = undefined;
    session.tokenUsage = undefined;
    session.telegramReplyDirective = undefined;
    session.thinkingTime = undefined;
    session.runner = undefined;
    session.shutdownCheckpointAt = undefined;
    session.updatedAt = Timestamp.now();
  }

  async updateHistoryReplayData(
    userId: string,
    sessionId: string,
    updates: HistoryReplayUpdate[],
  ): Promise<void> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session || updates.length === 0) {
      return;
    }

    const updatesBySeq = new Map(updates.map((update) => [update.seq, update]));
    for (const message of session.history) {
      if (message.seq == null) {
        continue;
      }

      const update = updatesBySeq.get(message.seq);
      if (!update) {
        continue;
      }

      if (update.replayThinking !== undefined) {
        message.replayThinking = update.replayThinking;
      }
      if (update.replayContent !== undefined) {
        message.replayContent = update.replayContent;
      }
      if (update.toolCalls !== undefined) {
        message.toolCalls = update.toolCalls;
      }
      if (update.attachments !== undefined) {
        message.attachments = update.attachments;
      }
    }

    session.updatedAt = Timestamp.now();
  }

  async claimClarificationAnswer(userId: string, sessionId: string): Promise<boolean> {
    const session = this.storage.get(this.storageKey(userId, sessionId));
    if (!session?.pendingClarification) return false;
    session.pendingClarification = false;
    session.clarifyingQuestion = undefined;
    session.updatedAt = Timestamp.now();
    return true;
  }

  async getSessionsForUser(userId: string, options?: { limit?: number }): Promise<AgentSessionDocument[]> {
    const sessions: AgentSessionDocument[] = [];
    for (const session of this.storage.values()) {
      if (session.userId === userId) {
        // Return lightweight version without history (matches SQLite behavior)
        sessions.push({
          ...session,
          agentType: resolveAgentType(session.agentType, session.isAutonomous),
          history: [],
        });
      }
    }
    // Sort by updatedAt descending
    const sortedSessions = sessions.sort((a, b) => b.updatedAt.seconds - a.updatedAt.seconds);
    const requestedLimit = Math.trunc(options?.limit ?? 0);
    return Number.isFinite(requestedLimit) && requestedLimit > 0
      ? sortedSessions.slice(0, requestedLimit)
      : sortedSessions;
  }

  async getLatestUserMessages(userIds: string[]): Promise<Record<string, LatestUserMessageSummary>> {
    const result: Record<string, LatestUserMessageSummary> = {};
    const userIdSet = new Set(userIds.map((userId) => userId.trim()).filter(Boolean));

    for (const userId of userIdSet) {
      let best: LatestUserMessageSummary | null = null;
      for (const session of this.storage.values()) {
        if (session.userId !== userId) {
          continue;
        }

        for (let index = session.history.length - 1; index >= 0; index -= 1) {
          const message = session.history[index];
          if (!message || !isAdminVisibleConversationMessage(message)) {
            continue;
          }

          const candidate: LatestUserMessageSummary = {
            userId,
            sessionId: session.sessionId,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt ?? null,
          };
          if (!best || compareLatestUserMessages(candidate, best) > 0) {
            best = candidate;
          }
          break;
        }
      }

      if (best) {
        result[userId] = best;
      }
    }

    return result;
  }

  async replaceSandboxForUser(userId: string, previousSandboxId: string, nextSandboxId: string): Promise<void> {
    for (const [key, session] of this.storage.entries()) {
      if (session.userId !== userId || session.sandboxId !== previousSandboxId) {
        continue;
      }

      this.storage.set(key, {
        ...session,
        sandboxId: nextSandboxId,
        updatedAt: Timestamp.now(),
      });
    }
  }

  async deleteSession(userId: string, sessionId: string): Promise<void> {
    this.storage.delete(this.storageKey(userId, sessionId));
  }
}
