import type { SqliteDb } from './sqlite-db.js';
import type { AgentTokenCredit, AgentTokenLedger, TokenAgentDayTotal, TokenAgentOutput, TokenDayTotal, TokenOutputDay } from '../agent-token-ledger.js';
import { hasTokens } from '../agent-token-ledger.js';

/**
 * The token ledger on disk (see AgentTokenLedger): one row per agent, day,
 * provider and model, added to in place. Plain columns, like the
 * working-time ledger, because the writes are one per turn and the reads
 * are sums.
 */
export class SqliteAgentTokenLedger implements AgentTokenLedger {
  constructor(private readonly db: SqliteDb) {}

  credit(entry: AgentTokenCredit): void {
    if (!hasTokens(entry)) return;
    this.db.prepare(
      'INSERT INTO agent_token_ledger (user_id, agent_id, day, provider, model, org_id, agent_name,'
      + ' input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(user_id, agent_id, day, provider, model) DO UPDATE SET'
      + ' input_tokens = input_tokens + excluded.input_tokens,'
      + ' output_tokens = output_tokens + excluded.output_tokens,'
      + ' cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,'
      + ' cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,'
      + ' reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,'
      + ' agent_name = excluded.agent_name,'
      + ' org_id = COALESCE(excluded.org_id, org_id)',
    ).run(
      entry.userId, entry.agentId, entry.day, entry.provider, entry.model, entry.orgId, entry.agentName,
      Math.round(entry.input), Math.round(entry.output), Math.round(entry.cacheRead),
      Math.round(entry.cacheWrite), Math.round(entry.reasoning),
    );
  }

  userDays(userId: string, sinceDay: string): TokenDayTotal[] {
    const rows = this.db.prepare(
      'SELECT day, provider, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output,'
      + ' SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,'
      + ' SUM(reasoning_tokens) AS reasoning'
      + ' FROM agent_token_ledger WHERE user_id = ? AND day >= ? GROUP BY day, provider, model',
    ).all(userId, sinceDay) as TokenDayTotal[];
    return rows;
  }

  userAgentDays(userId: string, sinceDay: string): TokenAgentDayTotal[] {
    return this.db.prepare(
      'SELECT day, provider, model, agent_id AS agentId, agent_name AS agentName, org_id AS orgId,'
      + ' input_tokens AS input, output_tokens AS output, cache_read_tokens AS cacheRead,'
      + ' cache_write_tokens AS cacheWrite, reasoning_tokens AS reasoning'
      + ' FROM agent_token_ledger WHERE user_id = ? AND day >= ?',
    ).all(userId, sinceDay) as TokenAgentDayTotal[];
  }

  outputDaysSince(sinceDay: string): TokenOutputDay[] {
    return this.db.prepare(
      'SELECT user_id AS userId, day, provider, SUM(output_tokens) AS output FROM agent_token_ledger'
      + ' WHERE day >= ? GROUP BY user_id, day, provider HAVING SUM(output_tokens) > 0',
    ).all(sinceDay) as TokenOutputDay[];
  }

  agentOutput(userIds: readonly string[], sinceDay: string): TokenAgentOutput[] {
    if (userIds.length === 0) return [];
    const marks = userIds.map(() => '?').join(', ');
    // MAX(org_id): an agent works in one workplace, and a legacy row with
    // none sorts below any that has one.
    return this.db.prepare(
      'SELECT user_id AS userId, agent_id AS agentId, MAX(org_id) AS orgId, provider,'
      + ' SUM(output_tokens) AS total, SUM(CASE WHEN day >= ? THEN output_tokens ELSE 0 END) AS since'
      + ` FROM agent_token_ledger WHERE user_id IN (${marks})`
      + ' GROUP BY user_id, agent_id, provider HAVING SUM(output_tokens) > 0',
    ).all(sinceDay, ...userIds) as TokenAgentOutput[];
  }
}
