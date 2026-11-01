import { Timestamp } from '../../types/timestamp.js';
import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import {
  INITIAL_TRIGGER,
  type SessionStorage,
  type SessionUpdateFields,
  type SessionRunnerStateUpdateFields,
} from '../session-storage.js';
import type {
  AgentSessionDocument,
  AgentType,
  AutonomousState,
  PersistedBlockerState,
  PersistedPlanState,
} from '../../types/persistence.js';
import type { SessionRuntimeContext } from '../../types/runtime-context.js';
import type { AgentMessage } from '../../types/agent.js';
import { resolveAgentType } from '../../utils/agent-type.js';

/**
 * SQLite-backed SessionStorage. Session docs live in `sessions` (without
 * history), messages in `session_messages` keyed by
 * seq. The methods that only existed for the retired web app
 * (getSessionsForUser, deleteSession, ...) are interface-optional and not
 * implemented here.
 */
export class SqliteSessionStorage implements SessionStorage {
  constructor(private readonly db: SqliteDb) {}

  private loadSession(userId: string, sessionId: string): AgentSessionDocument | null {
    const row = this.db.prepare('SELECT doc FROM sessions WHERE user_id = ? AND session_id = ?')
      .get(userId, sessionId) as { doc: string } | undefined;
    if (!row) return null;
    const session = deserializeDoc<AgentSessionDocument>(row.doc);
    session.history = [];
    return session;
  }

  private saveSession(session: AgentSessionDocument): void {
    const { history: _history, ...doc } = session;
    this.db.prepare(
      'INSERT INTO sessions (user_id, session_id, doc) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id, session_id) DO UPDATE SET doc = excluded.doc',
    ).run(session.userId, session.sessionId, serializeDoc({ ...doc, history: [] }));
  }

  async getSession(userId: string, sessionId: string): Promise<AgentSessionDocument | null> {
    const session = this.loadSession(userId, sessionId);
    if (!session) return null;
    return {
      ...session,
      agentType: resolveAgentType(session.agentType, session.isAutonomous),
      history: [],
    };
  }

  async getHistory(userId: string, sessionId: string): Promise<AgentMessage[]> {
    const rows = this.db.prepare(
      'SELECT doc FROM session_messages WHERE user_id = ? AND session_id = ? ORDER BY seq ASC',
    ).all(userId, sessionId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<AgentMessage>(row.doc));
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
    const tx = this.db.transaction(() => {
      this.saveSession(session);
      this.db.prepare('DELETE FROM session_messages WHERE user_id = ? AND session_id = ?')
        .run(userId, sessionId);
    });
    tx();
    return {
      ...session,
      agentType: resolveAgentType(session.agentType, session.isAutonomous),
      history: [],
    };
  }

  async updateSession(
    userId: string,
    sessionId: string,
    updates: SessionUpdateFields,
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      const session = this.loadSession(userId, sessionId);
      if (!session) return;
      // undefined values delete the field: Object.assign puts the undefined on
      // the doc and serializeDoc drops it — same net effect as the previous
      // impl's FieldValue.delete() mapping.
      Object.assign(session, updates, { updatedAt: Timestamp.now() });
      this.saveSession(session);
    });
    tx();
  }

  async updateSessionRunnerState(
    userId: string,
    sessionId: string,
    updates: SessionRunnerStateUpdateFields,
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      const session = this.loadSession(userId, sessionId);
      if (!session) return;
      Object.assign(session, updates);
      this.saveSession(session);
    });
    tx();
  }

  async addToHistory(userId: string, sessionId: string, message: AgentMessage): Promise<void> {
    const tx = this.db.transaction(() => {
      const session = this.loadSession(userId, sessionId);
      if (!session) return;
      if (message.seq == null) {
        message.seq = session.messageCount;
      }
      message.createdAt = message.createdAt ?? new Date().toISOString();
      this.db.prepare(
        'INSERT INTO session_messages (user_id, session_id, seq, doc) VALUES (?, ?, ?, ?)'
        + ' ON CONFLICT(user_id, session_id, seq) DO UPDATE SET doc = excluded.doc',
      ).run(userId, sessionId, message.seq, serializeDoc(message));
      session.messageCount = session.messageCount + 1;

      // Set title from first non-trigger user message
      if (!session.title && message.role === 'user' && message.content !== INITIAL_TRIGGER) {
        const text = message.content.slice(0, 60);
        session.title = text.length < message.content.length ? text + '…' : text;
      }

      session.updatedAt = Timestamp.now();
      this.saveSession(session);
    });
    tx();
  }

  async clearSessionHistory(userId: string, sessionId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const session = this.loadSession(userId, sessionId);
      if (!session) return;
      this.db.prepare('DELETE FROM session_messages WHERE user_id = ? AND session_id = ?')
        .run(userId, sessionId);
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
      this.saveSession(session);
    });
    tx();
  }
}
