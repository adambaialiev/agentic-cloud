import { workDayKey, workMonthKey, type AgentWorkLedger } from './agent-work-ledger.js';

/**
 * From when the platform counts working time (note #644). Every agent's total
 * starts at zero on this day — there is no per-turn record to backfill from,
 * only machine awake time, which overstates — so an agent older than this
 * carries the date on its screen beside the number.
 */
export const AGENT_WORK_COUNTED_SINCE = '2026-09-23T00:00:00.000Z';

/** A turn the meter is timing: whose, which agent's, and since when. */
export interface RunningAgentTurn {
  userId: string;
  agentId: string;
  startedAtMs: number;
}

/** What a credit needs to know about its agent beyond the ids. */
export interface AgentWorkIdentity {
  orgId: string | null;
  name: string;
}

interface Checkpoint {
  /** The ledger has been credited up to this moment. */
  atMs: number;
  /** Fixed at the first credit, so a turn outlives the record it began on. */
  identity: AgentWorkIdentity;
}

/**
 * Turns working time into ledger rows (see AgentWorkLedger).
 *
 * The clock is the turn's own: a run slot's start, from the background
 * runner, or the Workspace Agent's exec. Rather than crediting a whole turn
 * once at its end — where a backend restart or a Manual Stop in the middle of
 * a long turn would lose all of it — the meter is TICKED once a minute and
 * credits every running turn with the time since its last checkpoint, then
 * `finish` credits the tail when the turn ends. A turn cut off by anything
 * therefore loses at most one tick, which is what the owner asked for:
 * interrupted work counts up to the cut.
 *
 * A turn spanning midnight (UTC) is split there, so each day — and so each
 * month — holds only its own minutes.
 */
export class AgentWorkMeter {
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** Turns the runner does not know about (the Workspace Agent's exec). */
  private readonly extra = new Map<string, RunningAgentTurn>();
  /** The start of the last turn finished per agent, so a hook firing twice credits once. */
  private readonly lastFinished = new Map<string, number>();

  constructor(private readonly deps: {
    ledger: AgentWorkLedger;
    /** Who this agent is now; `null` when its record is gone. */
    describeAgent: (userId: string, agentId: string) => Promise<AgentWorkIdentity | null>;
    /** Every turn the background runner is holding a slot for right now. */
    listRunning: () => RunningAgentTurn[];
    now?: () => number;
  }) {}

  /**
   * Time a turn the runner does not hold — returns the matching `finish`.
   * Registering rather than crediting at the end keeps the tick's guarantee
   * for these turns too.
   */
  begin(userId: string, agentId: string): () => Promise<void> {
    const startedAtMs = this.now();
    const key = turnKey(userId, agentId);
    this.extra.set(key, { userId, agentId, startedAtMs });
    return async () => {
      this.extra.delete(key);
      await this.finish(userId, agentId, startedAtMs);
    };
  }

  /** The turn ended: credit what the last tick has not, and forget it. */
  async finish(userId: string, agentId: string, startedAtMs: number): Promise<void> {
    const key = turnKey(userId, agentId);
    if (this.lastFinished.get(key) === startedAtMs) return;
    this.lastFinished.set(key, startedAtMs);
    const now = this.now();
    try {
      await this.creditSince(userId, agentId, startedAtMs, now);
    } finally {
      this.checkpoints.delete(key);
    }
  }

  /** Credit every running turn up to now; forget checkpoints of turns that are gone. */
  async tick(): Promise<void> {
    const now = this.now();
    const running = [...this.deps.listRunning(), ...this.extra.values()];
    const live = new Set<string>();
    for (const turn of running) {
      const key = turnKey(turn.userId, turn.agentId);
      live.add(key);
      try {
        await this.creditSince(turn.userId, turn.agentId, turn.startedAtMs, now);
      } catch (error) {
        console.warn(`[WorkMeter] could not credit ${key}:`, error);
      }
    }
    for (const key of this.checkpoints.keys()) {
      if (!live.has(key)) this.checkpoints.delete(key);
    }
  }

  private async creditSince(userId: string, agentId: string, startedAtMs: number, now: number): Promise<void> {
    const key = turnKey(userId, agentId);
    let checkpoint = this.checkpoints.get(key);
    if (!checkpoint) {
      const identity = await this.deps.describeAgent(userId, agentId);
      // No record and no earlier credit: nothing to name the time after.
      if (!identity) return;
      checkpoint = { atMs: startedAtMs, identity };
    }
    let from = checkpoint.atMs;
    while (from < now) {
      const to = Math.min(now, nextDayStart(from));
      this.deps.ledger.credit({
        userId,
        agentId,
        orgId: checkpoint.identity.orgId,
        agentName: checkpoint.identity.name,
        month: workMonthKey(from),
        day: workDayKey(from),
        ms: to - from,
      });
      from = to;
    }
    this.checkpoints.set(key, { ...checkpoint, atMs: Math.max(checkpoint.atMs, now) });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function turnKey(userId: string, agentId: string): string {
  return `${userId}/${agentId}`;
}

function nextDayStart(atMs: number): number {
  const at = new Date(atMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
}
