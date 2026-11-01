/**
 * The per-agent "last interaction" stamp the Fly idle reaper reads to decide
 * whether a machine is `recently-active`.
 *
 * It used to be a plain in-memory Map inside AgentService, and that
 * one fact shaped the whole fleet's sleep schedule: a fresh backend had an
 * empty map, so it could not tell an agent messaged a minute before the
 * deploy from one idle all week, and the reaper covered for that with a
 * 15-minute stop-nothing window after every boot. Deploys land more often
 * than that on a working day, so the windows chained end to end and the
 * reaper was effectively off (measured 2026-09-03: nothing slept 11:27-12:28,
 * every sweep `kept=10 (boot-grace=10)`).
 *
 * Durable, the stamp answers the question on the very first sweep after a
 * boot. It is deliberately NOT the persisted `lastActivityAt` on the agent
 * record: that one is throttled to one write an hour for the recycler, which
 * works in days, and would read up to an hour stale at a minutes-wide idle
 * window. This store is written on every interaction AND at the end of every
 * turn (so the idle clock starts when the agent finishes, whoever started the
 * turn) — one tiny row per agent — and read once per running machine per
 * sweep.
 */
export interface AgentActivityStore {
  /** Epoch ms of the last interaction with the agent, if any was recorded. */
  get(userId: string, agentId: string): number | undefined;
  put(userId: string, agentId: string, atMs: number): void;
  /** Forget the agent (its record is being deleted). */
  delete(userId: string, agentId: string): void;
}

function activityKey(userId: string, agentId: string): string {
  return `${userId}/${agentId}`;
}

/** Tests and the no-SQLite development path: the pre-durable behaviour. */
export class InMemoryAgentActivityStore implements AgentActivityStore {
  private readonly stamps = new Map<string, number>();

  get(userId: string, agentId: string): number | undefined {
    return this.stamps.get(activityKey(userId, agentId));
  }

  put(userId: string, agentId: string, atMs: number): void {
    this.stamps.set(activityKey(userId, agentId), atMs);
  }

  delete(userId: string, agentId: string): void {
    this.stamps.delete(activityKey(userId, agentId));
  }
}
