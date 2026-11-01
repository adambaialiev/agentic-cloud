/**
 * The ledger of how long each agent has WORKED (note #644): milliseconds of
 * running turns, credited as they happen and summed for life.
 *
 * It is deliberately not a field on the agent record. The record is hard
 * deleted with the agent (`removeTelegramAgent`), and the owner asked that a
 * deleted agent's time never be lost: the person's screen keeps counting it
 * and names the agent among their former ones, and the workplace's total
 * keeps it too. So the rows live beside the record, keyed by owner and agent,
 * carrying the agent's name and workplace so they still mean something after
 * the record is gone. Nothing deletes them.
 *
 * Working time is not the machine's awake time (`machineRuntimeMs`): a
 * machine stays awake for minutes after every turn and is sampled by the
 * idle sweep, while this ledger is written from the turn's own clock.
 *
 * Monthly buckets (UTC, `YYYY-MM`), the same shape as the runtime meter, so
 * a per-month view costs nothing later; every screen today shows the lifetime
 * sum. Since 2026-10-10 every credit ALSO lands in a UTC day, per owner, for
 * the Leaderboard's week and its 90-day grid (spec: Clara's
 * ~/work/leaderboard). The day rows start that day: before it there was only
 * the month, and a month cannot be split back into days.
 */
export interface AgentWorkCredit {
  userId: string;
  agentId: string;
  /** The agent's workplace; `null` for a legacy record with no `orgId`. */
  orgId: string | null;
  /** The agent's name at the time of the credit, kept for the former-agents line. */
  agentName: string;
  /** UTC month bucket, `YYYY-MM`. */
  month: string;
  /**
   * UTC day bucket, `YYYY-MM-DD`, inside `month`. The meter always says it;
   * a credit without one lands in its month alone.
   */
  day?: string;
  /** Milliseconds to ADD to the bucket. */
  ms: number;
}

/** One owner's working time on one UTC day, every agent of theirs summed. */
export interface AgentWorkDay {
  userId: string;
  day: string;
  ms: number;
}

/** One agent's working time over a span of days (note #925): what a
 *  workplace's people cards add up, keeping the agents apart so each can be
 *  counted in the workplace it works in. */
export interface AgentWorkSpan {
  userId: string;
  agentId: string;
  ms: number;
}

/** One agent's lifetime, as the ledger knows it — with or without a record. */
export interface AgentWorkTotal {
  agentId: string;
  orgId: string | null;
  agentName: string;
  ms: number;
}

export interface AgentWorkLedger {
  credit(entry: AgentWorkCredit): void;
  /** Lifetime working milliseconds of one agent. */
  agentTotal(userId: string, agentId: string): number;
  /** Every agent this owner has ever had credited, deleted ones included. */
  userTotals(userId: string): AgentWorkTotal[];
  /** Lifetime working milliseconds of every agent recorded under this workplace. */
  orgTotal(orgId: string): number;
  /** Every owner's working time per day from `sinceDay` (inclusive) on. */
  daysSince(sinceDay: string): AgentWorkDay[];
  /** These owners' working time from `sinceDay` (inclusive) on, one row per
   *  agent: a workplace's week on its people cards (note #925). */
  agentsSince(userIds: readonly string[], sinceDay: string): AgentWorkSpan[];
}

/** UTC month bucket key, e.g. `"2026-09"`. */
export function workMonthKey(atMs: number): string {
  const at = new Date(atMs);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** UTC day bucket key, e.g. `"2026-10-10"`. */
export function workDayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Tests and the no-SQLite development path. */
export class InMemoryAgentWorkLedger implements AgentWorkLedger {
  private readonly rows = new Map<string, AgentWorkCredit>();
  private readonly days = new Map<string, AgentWorkDay>();
  private readonly agentDays = new Map<string, AgentWorkSpan & { day: string }>();

  credit(entry: AgentWorkCredit): void {
    if (!(entry.ms > 0)) return;
    const { day, ...month } = entry;
    const key = `${entry.userId}/${entry.agentId}/${entry.month}`;
    const existing = this.rows.get(key);
    this.rows.set(key, existing
      ? { ...existing, ms: existing.ms + entry.ms, agentName: entry.agentName, orgId: entry.orgId ?? existing.orgId }
      : month);
    if (!day) return;
    const dayKey = `${entry.userId}/${day}`;
    const total = this.days.get(dayKey) ?? { userId: entry.userId, day, ms: 0 };
    this.days.set(dayKey, { ...total, ms: total.ms + entry.ms });
    const agentDayKey = `${entry.userId}/${entry.agentId}/${day}`;
    const agentDay = this.agentDays.get(agentDayKey) ?? { userId: entry.userId, agentId: entry.agentId, day, ms: 0 };
    this.agentDays.set(agentDayKey, { ...agentDay, ms: agentDay.ms + entry.ms });
  }

  agentsSince(userIds: readonly string[], sinceDay: string): AgentWorkSpan[] {
    const owners = new Set(userIds);
    const byAgent = new Map<string, AgentWorkSpan>();
    for (const row of this.agentDays.values()) {
      if (!owners.has(row.userId) || row.day < sinceDay) continue;
      const key = `${row.userId}/${row.agentId}`;
      const total = byAgent.get(key) ?? { userId: row.userId, agentId: row.agentId, ms: 0 };
      total.ms += row.ms;
      byAgent.set(key, total);
    }
    return [...byAgent.values()];
  }

  daysSince(sinceDay: string): AgentWorkDay[] {
    return [...this.days.values()].filter((row) => row.day >= sinceDay).map((row) => ({ ...row }));
  }

  agentTotal(userId: string, agentId: string): number {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.userId === userId && row.agentId === agentId) total += row.ms;
    }
    return total;
  }

  userTotals(userId: string): AgentWorkTotal[] {
    return sumByAgent([...this.rows.values()].filter((row) => row.userId === userId));
  }

  orgTotal(orgId: string): number {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.orgId === orgId) total += row.ms;
    }
    return total;
  }
}

/** Fold month rows into one total per agent; the newest month names it. */
export function sumByAgent(rows: AgentWorkCredit[]): AgentWorkTotal[] {
  const byAgent = new Map<string, AgentWorkTotal & { month: string }>();
  for (const row of rows) {
    const current = byAgent.get(row.agentId);
    if (!current) {
      byAgent.set(row.agentId, { agentId: row.agentId, orgId: row.orgId, agentName: row.agentName, ms: row.ms, month: row.month });
      continue;
    }
    current.ms += row.ms;
    if (row.month > current.month) {
      current.month = row.month;
      current.agentName = row.agentName;
      current.orgId = row.orgId ?? current.orgId;
    }
  }
  return [...byAgent.values()].map(({ month: _month, ...total }) => total);
}
