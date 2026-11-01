import type { SqliteDb } from './sqlite-db.js';
import { sumByAgent, type AgentWorkCredit, type AgentWorkDay, type AgentWorkSpan, type AgentWorkLedger, type AgentWorkTotal } from '../agent-work-ledger.js';

/**
 * The working-time ledger on disk (see AgentWorkLedger): one row per agent
 * and month, added to in place, and beside it one per agent and UTC day.
 * Plain columns rather than a JSON doc because the writes are small and
 * frequent (one per running agent per minute) and the reads are sums.
 */
export class SqliteAgentWorkLedger implements AgentWorkLedger {
  constructor(private readonly db: SqliteDb) {}

  credit(entry: AgentWorkCredit): void {
    if (!(entry.ms > 0)) return;
    const ms = Math.round(entry.ms);
    // One transaction, so the month and the day it fell on never disagree.
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT INTO agent_work_ledger (user_id, agent_id, month, org_id, agent_name, working_ms)'
        + ' VALUES (?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(user_id, agent_id, month) DO UPDATE SET'
        + ' working_ms = working_ms + excluded.working_ms,'
        + ' agent_name = excluded.agent_name,'
        + ' org_id = COALESCE(excluded.org_id, org_id)',
      ).run(entry.userId, entry.agentId, entry.month, entry.orgId, entry.agentName, ms);
      if (!entry.day) return;
      this.db.prepare(
        'INSERT INTO agent_work_days (user_id, agent_id, day, working_ms) VALUES (?, ?, ?, ?)'
        + ' ON CONFLICT(user_id, agent_id, day) DO UPDATE SET working_ms = working_ms + excluded.working_ms',
      ).run(entry.userId, entry.agentId, entry.day, ms);
    })();
  }

  daysSince(sinceDay: string): AgentWorkDay[] {
    const rows = this.db.prepare(
      'SELECT user_id, day, SUM(working_ms) AS ms FROM agent_work_days WHERE day >= ? GROUP BY user_id, day',
    ).all(sinceDay) as Array<{ user_id: string; day: string; ms: number }>;
    return rows.map((row) => ({ userId: row.user_id, day: row.day, ms: row.ms }));
  }

  agentsSince(userIds: readonly string[], sinceDay: string): AgentWorkSpan[] {
    if (userIds.length === 0) return [];
    const marks = userIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT user_id, agent_id, SUM(working_ms) AS ms FROM agent_work_days WHERE user_id IN (${marks}) AND day >= ?`
      + ' GROUP BY user_id, agent_id',
    ).all(...userIds, sinceDay) as Array<{ user_id: string; agent_id: string; ms: number }>;
    return rows.map((row) => ({ userId: row.user_id, agentId: row.agent_id, ms: row.ms }));
  }

  agentTotal(userId: string, agentId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(working_ms), 0) AS ms FROM agent_work_ledger WHERE user_id = ? AND agent_id = ?',
    ).get(userId, agentId) as { ms: number } | undefined;
    return row?.ms ?? 0;
  }

  userTotals(userId: string): AgentWorkTotal[] {
    const rows = this.db.prepare(
      'SELECT agent_id, month, org_id, agent_name, working_ms FROM agent_work_ledger WHERE user_id = ?',
    ).all(userId) as Array<{ agent_id: string; month: string; org_id: string | null; agent_name: string; working_ms: number }>;
    return sumByAgent(rows.map((row) => ({
      userId, agentId: row.agent_id, month: row.month, orgId: row.org_id, agentName: row.agent_name, ms: row.working_ms,
    })));
  }

  orgTotal(orgId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(working_ms), 0) AS ms FROM agent_work_ledger WHERE org_id = ?',
    ).get(orgId) as { ms: number } | undefined;
    return row?.ms ?? 0;
  }
}
