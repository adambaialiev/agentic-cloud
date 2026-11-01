import type { UserStorage } from './user-storage.js';
import { parseFlyServerRecordId, parseFlySandboxId } from './fly-sandbox-id.js';
import { listAgents, type AgentRecord } from '../types/user.js';

const DEFAULT_IDLE_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_WARN_LEAD_MS = 24 * 60 * 60_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_STARTUP_DELAY_MS = 2 * 60_000;

export type FlyRecycleAction = 'destroy' | 'warn' | 'keep';

export type FlyRecycleReason =
  | 'idle'
  | 'warning'
  | 'no-machine'
  | 'not-fly'
  | 'in-flight-turn'
  | 'kept-plan'
  | 'unknown-activity'
  | 'already-warned'
  | 'recently-active';

export interface FlyRecycleDecision {
  action: FlyRecycleAction;
  reason: FlyRecycleReason;
}

export interface FlyAgentRecyclerDeps {
  /** Tears down the machine, its volume, and its app. */
  sandboxClient: { destroySandbox: (sandboxId: string) => Promise<void> };
  userStorage: Pick<UserStorage, 'getAllUsers' | 'updateAgentFields'>;
  /** Whether a harness/setup turn is currently running for this user. */
  isTurnRunningForUser: (userId: string) => boolean;
  /**
   * Whether this user belongs to an org. Members' and admins' machines are
   * exempt from idle recycling — with the pricing ladder retired
   * (org-layer-design), membership is the whole of "kept", and when someone
   * is removed from their org the exemption ends and three idle days later
   * the machines go.
   */
  isOrgMember: (userId: string) => Promise<boolean>;
  /**
   * Deliver the pre-recycle warning in the agent's own Telegram chat. Returns
   * false when it could not be delivered (no bot, chat never opened), which
   * leaves the agent unstamped so a later sweep tries again.
   */
  warnOwner: (args: { userId: string; agent: AgentRecord; daysLeft: number }) => Promise<boolean>;
  /** Idle time before a machine is recycled. Default 3 days. */
  idleMs?: number;
  /** How far ahead of the deadline the owner is warned. Default 1 day. */
  warnLeadMs?: number;
  intervalMs?: number;
  /**
   * How long after {@link FlyAgentRecycler.start} the first sweep runs.
   * Default 2 minutes — see `start` for why it is delayed rather than immediate.
   */
  startupDelayMs?: number;
  now?: () => number;
}

export interface FlyRecycleSweepResult {
  /** Every agent the sweep looked at, whatever was decided about it. */
  examined: number;
  /** Of those, the ones due for a warning or recycling. */
  considered: number;
  destroyed: number;
  warned: number;
  /** Due for action, but the action failed — the record was left as it was. */
  kept: number;
}

/**
 * Destroys the machines of agents nobody has touched in {@link idleMs}, and
 * warns their owner a day before.
 *
 * The idle reaper next door only STOPS machines, which does nothing for the
 * dominant cost: volumes bill on provisioned size whether or not the machine
 * ever runs again, so every abandoned signup accrues a floor forever. Stopping
 * is the right response to "idle for fifteen minutes"; recycling is the right
 * response to "idle for three days".
 *
 * This is only safe because an agent can rebuild its machine on the next
 * message (`ensureTelegramAgentMachine`) — the record, the bot and the CLI
 * sign-in all outlive the machine. Recycling clears `serverId`, which IS the
 * signal that makes the next turn provision a fresh one, so the two halves are
 * the same mechanism seen from opposite ends. What the user genuinely loses is
 * the volume's contents, which is why they are warned first and why the
 * threshold is days rather than hours.
 *
 * Two deliberate differences from the idle reaper:
 *
 * - **It walks agent RECORDS, not Fly apps.** It has to write the record
 *   anyway, and record-first means an agent whose machine has already vanished
 *   gets its stale `serverId` cleared as a side effect instead of lingering.
 * - **It does not check for live terminal sessions.** That check earns its keep
 *   at a 15-minute threshold; at three days any live session implies activity
 *   far more recent than the deadline, so `lastActivityAt` already covers it —
 *   and skipping it avoids a per-agent Fly API call.
 *
 * Activity is judged PER AGENT (`agent.lastActivityAt`, stamped by the agent's
 * own chat), falling back to the owner's account-level stamps only for agents
 * created before that field existed. Per-agent is what makes an abandoned
 * second agent collectable at all: under account-level activity a user who
 * kept one agent busy kept every sibling's machine alive indefinitely.
 */
export class FlyAgentRecycler {
  private readonly idleMs: number;
  private readonly warnLeadMs: number;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(private readonly deps: FlyAgentRecyclerDeps) {
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.warnLeadMs = deps.warnLeadMs ?? DEFAULT_WARN_LEAD_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.startupDelayMs = Math.max(0, deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Begins sweeping: once shortly after start, then every {@link intervalMs}.
   *
   * The startup sweep is not decoration. An interval alone only ever fires in a
   * process that survives a full hour, and every deploy restarts this backend —
   * so on a day of frequent deploys the recycler ran zero times, and nothing
   * said so. What that costs is not only late collection: destruction is judged
   * on absolute idle time, so a machine whose deadline passed unswept is torn
   * down on the first sweep that does run WITHOUT its owner ever receiving the
   * day-ahead warning, which is exactly the case the warning exists for.
   *
   * Delayed rather than immediate because boot is busy and `warnOwner` posts
   * into the agent's own chat: sweeping before the bots rehydrate produces
   * warnings that cannot be delivered. Those are safely retried on a later
   * sweep — the agent is left unstamped — but a sweep that warns nobody is a
   * wasted pass over every user record.
   */
  start(): void {
    if (this.timer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.runOnce()
        .then((result) => {
          // Sweeps are otherwise silent unless they act, so the logs could not
          // answer "has this ever run?" — which is how it went unnoticed that
          // it had not. One line per boot makes the answer readable, and it
          // leads with `examined` so "walked the fleet, nothing was due" cannot
          // read the same as "walked nothing at all" — that ambiguity is the
          // very shape of the bug this sweep exists to prevent.
          console.log(
            `[FlyAgentRecycler] startup sweep: examined ${result.examined}, due ${result.considered}, ` +
              `destroyed ${result.destroyed}, warned ${result.warned}, kept ${result.kept}`,
          );
        })
        .catch((error) => {
          console.warn('[FlyAgentRecycler] startup sweep failed', error);
        });
    }, this.startupDelayMs);
    this.startupTimer.unref?.();

    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.warn('[FlyAgentRecycler] sweep failed', error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Pure decision — the safety gate, isolated for testing.
   *
   * `lastActivityAt` is the owner's most recent Telegram activity. It is
   * combined with the agent's own `createdAt` rather than trusted alone: a
   * freshly created agent belonging to a user whose activity stamp is missing
   * or stale must never be recycled minutes after it was built. When neither
   * timestamp is usable the answer is always keep — an unattributable machine
   * is left alone, because destroying is not recoverable.
   */
  decideRecycle(args: {
    agent: AgentRecord;
    lastActivityAt: number | undefined;
    turnRunning: boolean;
    /** True when the owner's machines are kept (paid rungs, admins) — never recycle those. */
    keptMachines?: boolean;
    now: number;
  }): FlyRecycleDecision {
    const { agent, lastActivityAt, turnRunning, keptMachines, now } = args;

    if (!agent.serverId) {
      // Already recycled, or never provisioned. Nothing to bill, nothing to do.
      return { action: 'keep', reason: 'no-machine' };
    }
    if (keptMachines) {
      // "Machines never recycled" is the paid promise — checked after the
      // no-machine guard so a Plus agent with no machine still reads as such,
      // and before everything else so no idle math can override the plan.
      return { action: 'keep', reason: 'kept-plan' };
    }
    const sandboxId = parseFlyServerRecordId(agent.serverId);
    if (!sandboxId || !parseFlySandboxId(sandboxId)) {
      // Hetzner/legacy machines have their own lifecycle and billing.
      return { action: 'keep', reason: 'not-fly' };
    }
    if (turnRunning) {
      return { action: 'keep', reason: 'in-flight-turn' };
    }

    // Prefer the agent's OWN traffic. When it has any, the owner's
    // account-level activity is deliberately ignored — otherwise one busy agent
    // keeps every abandoned sibling's machine alive forever, which is the whole
    // reason the per-agent stamp exists. Agents predating that field have no
    // stamp and fall back to account-level, so they behave as they always did.
    const agentActivity = parseEpoch(agent.lastActivityAt);
    const idleSince = agentActivity !== undefined
      ? maxDefined(agentActivity, parseEpoch(agent.createdAt))
      : maxDefined(lastActivityAt, parseEpoch(agent.createdAt));
    if (idleSince === undefined) {
      return { action: 'keep', reason: 'unknown-activity' };
    }

    const idleFor = now - idleSince;
    if (idleFor >= this.idleMs) {
      return { action: 'destroy', reason: 'idle' };
    }
    if (idleFor >= this.idleMs - this.warnLeadMs) {
      return agent.recycleWarnedAt
        ? { action: 'keep', reason: 'already-warned' }
        : { action: 'warn', reason: 'warning' };
    }
    return { action: 'keep', reason: 'recently-active' };
  }

  /** One sweep. Safe to call directly (tests) or on the interval. */
  async runOnce(): Promise<FlyRecycleSweepResult> {
    if (this.running) {
      return { examined: 0, considered: 0, destroyed: 0, warned: 0, kept: 0 };
    }
    this.running = true;
    try {
      const now = this.now();
      const users = await this.deps.userStorage.getAllUsers().catch((error) => {
        console.warn('[FlyAgentRecycler] getAllUsers failed', error);
        return [];
      });

      const result: FlyRecycleSweepResult = { examined: 0, considered: 0, destroyed: 0, warned: 0, kept: 0 };

      for (const user of users) {
        const agents = listAgents(user.telegram, true);
        if (agents.length === 0) continue;
        const lastActivityAt = maxDefined(
          parseEpoch(user.telegram?.lastActivityAt),
          parseEpoch(user.telegram?.lastUserActivityAt),
        );
        const turnRunning = this.deps.isTurnRunningForUser(user.userId);
        // Org members and admin accounts. Read per user, not cached across
        // the sweep — a membership removed mid-sweep is a rare race worth
        // exactly nothing.
        const keptMachines = user.roles?.admin === true
          || await this.deps.isOrgMember(user.userId).catch(() => true);

        for (const agent of agents) {
          result.examined += 1;
          const decision = this.decideRecycle({ agent, lastActivityAt, turnRunning, keptMachines, now });
          if (decision.action === 'keep') {
            continue;
          }
          result.considered += 1;
          if (decision.action === 'warn') {
            await this.warnAgentOwner(user.userId, agent, result);
          } else {
            await this.recycleAgentMachine(user.userId, agent, result);
          }
        }
      }

      if (result.destroyed > 0 || result.warned > 0) {
        console.log(
          `[FlyAgentRecycler] swept: destroyed=${result.destroyed} warned=${result.warned} kept=${result.kept}`,
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async warnAgentOwner(
    userId: string,
    agent: AgentRecord,
    result: FlyRecycleSweepResult,
  ): Promise<void> {
    const daysLeft = Math.max(1, Math.round(this.warnLeadMs / (24 * 60 * 60_000)));
    let delivered = false;
    try {
      delivered = await this.deps.warnOwner({ userId, agent, daysLeft });
    } catch (error) {
      console.warn(`[FlyAgentRecycler] warning failed for agent ${agent.id}`, error);
    }
    if (!delivered) {
      // Leave it unstamped so the next sweep tries again — an undelivered
      // warning must not buy the agent a silent recycle.
      result.kept += 1;
      return;
    }
    await this.deps.userStorage
      .updateAgentFields(userId, agent.id, { recycleWarnedAt: new Date(this.now()).toISOString() })
      .catch((error) => {
        // Worst case the user gets the warning twice; far better than the
        // alternative of a warning that silently never repeats.
        console.warn(`[FlyAgentRecycler] could not stamp recycleWarnedAt for ${agent.id}`, error);
        return false;
      });
    result.warned += 1;
  }

  private async recycleAgentMachine(
    userId: string,
    agent: AgentRecord,
    result: FlyRecycleSweepResult,
  ): Promise<void> {
    const sandboxId = parseFlyServerRecordId(agent.serverId);
    if (!sandboxId) {
      result.kept += 1;
      return;
    }
    try {
      // Destroy BEFORE clearing the record. The other order leaks a billed
      // machine that nothing references if the teardown fails; this order, at
      // worst, leaves a stale serverId that the next turn's existence probe
      // resolves by rebuilding.
      await this.deps.sandboxClient.destroySandbox(sandboxId);
    } catch (error) {
      console.warn(`[FlyAgentRecycler] failed to destroy ${sandboxId} for agent ${agent.id}`, error);
      result.kept += 1;
      return;
    }
    await this.deps.userStorage.updateAgentFields(userId, agent.id, {
      // Clearing serverId IS the re-provision trigger: the next turn sees an
      // agent with no machine and builds one. The rest described the dead app.
      serverId: null,
      identityVersion: null,
      exposedUrl: null,
      exposedPorts: null,
      recycleWarnedAt: null,
      agentbuiltTokenHash: null,
    });
    result.destroyed += 1;
    console.log(`[FlyAgentRecycler] recycled ${sandboxId} for agent ${agent.id} (user ${userId})`);
  }
}

function parseEpoch(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (max === undefined || value > max) max = value;
  }
  return max;
}
