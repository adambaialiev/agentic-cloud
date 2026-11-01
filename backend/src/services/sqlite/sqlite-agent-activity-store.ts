import type { SqliteDb } from './sqlite-db.js';
import type { AgentActivityStore } from '../agent-activity-store.js';

/**
 * Durable per-agent activity stamp; one integer row per agent. Survives a
 * backend restart so the idle reaper's `recently-active` gate is answerable
 * on the first sweep after a deploy (see AgentActivityStore).
 */
export class SqliteAgentActivityStore implements AgentActivityStore {
  constructor(private readonly db: SqliteDb) {}

  get(userId: string, agentId: string): number | undefined {
    const row = this.db.prepare(
      'SELECT last_active_at_ms FROM telegram_agent_activity WHERE user_id = ? AND agent_id = ?',
    ).get(userId, agentId) as { last_active_at_ms: number } | undefined;
    return row?.last_active_at_ms;
  }

  put(userId: string, agentId: string, atMs: number): void {
    this.db.prepare(
      'INSERT INTO telegram_agent_activity (user_id, agent_id, last_active_at_ms) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id, agent_id) DO UPDATE SET last_active_at_ms = excluded.last_active_at_ms',
    ).run(userId, agentId, atMs);
  }

  delete(userId: string, agentId: string): void {
    this.db.prepare('DELETE FROM telegram_agent_activity WHERE user_id = ? AND agent_id = ?')
      .run(userId, agentId);
  }
}
