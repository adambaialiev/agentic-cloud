import { randomUUID } from 'node:crypto';
import type { AgentRecord } from '../types/user.js';
import type { WorkspaceAgentEvent } from '../shared/workspace-agent-proactive.js';
import type { AgentScheduleStorage } from './agent-schedule-storage.js';
import {
  type AgentSchedule,
  type AgentSchedulePauseReason,
  type AgentScheduleTickOutcome,
  SCHEDULE_FAIL_STREAK_PAUSE,
  SCHEDULE_JITTER_MS,
  SCHEDULE_MESSAGE_MAX,
  SCHEDULE_RESET_CONTEXT_PERCENT,
  buildScheduledTickPrompt,
  capReached,
  describeCap,
  describeSchedule,
  emptyScheduleDay,
  inWindow,
  isValidTimeZone,
  localParts,
  nextLocalMidnight,
  nextTickFrom,
  parseEvery,
  parseWindow,
  scheduledTaskLine,
} from '../types/agent-schedule.js';

/** How often the sweep looks. The resolution of a cadence, not a second timer. */
export const SCHEDULE_SWEEP_MS = 30_000;
/** A tick whose turn has not been seen to end for this long is settled as ran. */
const STALE_TICK_MS = 3 * 60 * 60_000;
/** The failed-turn row's prefix (workspace-agent-events.ts) — the one durable sign a turn failed. */
export const FAILED_TURN_ROW_PREFIX = 'The delegated session encountered an error.';

export interface AgentScheduleServiceDeps {
  storage: AgentScheduleStorage;
  now?: () => Date;
  random?: () => number;
  /** One of the owner's agents, or null when gone. */
  getAgent(userId: string, agentId: string): Promise<AgentRecord | null>;
  /** Every agent of the owner, for a name-or-id lookup. */
  listAgents(userId: string): Promise<AgentRecord[]>;
  isAgentWorking(userId: string, agentId: string): boolean;
  /** The agent's context fullness, 0–100, or null when unknown. */
  contextPercent(agent: AgentRecord): number | null;
  /** A quiet platform turn carrying the tick. Never queues: `busy` when a turn is running. */
  startScheduledTurn(args: { userId: string; agentId: string; content: string; task: string }): Promise<'delivered' | 'busy' | 'no-machine' | 'failed'>;
  /** The agent's own fresh chat, as `agentbuilt chat new` does it. */
  resetChat(args: { userId: string; agentId: string }): Promise<{ ok: boolean }>;
  /** Whether the subscription this agent runs on has room for its model now; null when nothing is known. */
  subscriptionHasRoom(userId: string, agent: AgentRecord): Promise<boolean | null>;
  /** Tokens this agent has spent lately (any monotone total): ticks read the difference. */
  tokensSpent(userId: string, agentId: string): number;
  latestChatRow(userId: string, agentId: string): Promise<{ role: string; text: string; at: string } | null>;
  /** The owner is told: a row in the agent's chat, and the Chief of Staff's quiet event turn. */
  tellOwner(args: { userId: string; orgId: string; agentId: string; text: string; event: WorkspaceAgentEvent }): Promise<void>;
  /** A platform row in the agent's chat only (a decision, a pause by hand). */
  recordRow(args: { userId: string; agentId: string; text: string }): Promise<void>;
  /** The proposing agent is woken with the owner's decision. */
  notifyAgent(args: { userId: string; agentId: string; text: string; task: string }): Promise<unknown>;
  log?: (line: string) => void;
}

export type ScheduleRefusal = { ok: false; code: 'not_found' | 'refused' | 'invalid' | 'unavailable'; reason: string };

export interface ProposeScheduleArgs {
  userId: string;
  orgId: string;
  byAgentId: string;
  /** Name or id of the target; the proposer itself when absent. */
  agent?: string;
  message: string;
  every: string;
  window?: string;
  timeZone?: string;
  capTurns?: number;
  capTokens?: number;
}

export class AgentScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /** Agents an open, active schedule keeps awake — the reaper's eighth gate, refreshed each sweep. */
  private awake = new Set<string>();

  constructor(private readonly deps: AgentScheduleServiceDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  private log(line: string): void { (this.deps.log ?? ((text) => console.log(text)))(`[schedules] ${line}`); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch((error) => this.log(`sweep failed: ${String(error)}`)); }, SCHEDULE_SWEEP_MS);
    this.timer.unref?.();
    void this.sweep().catch((error) => this.log(`sweep failed: ${String(error)}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The reaper's gate: an active schedule inside its window holds this agent's machine awake. */
  holdsAwake(userId: string, agentId: string): boolean {
    return this.awake.has(`${userId}/${agentId}`);
  }

  async get(id: string): Promise<AgentSchedule | null> {
    return this.deps.storage.get(id);
  }

  async forAgent(agentId: string): Promise<AgentSchedule | null> {
    const docs = (await this.deps.storage.listByAgent(agentId)).filter((doc) => doc.status !== 'rejected');
    docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return docs[0] ?? null;
  }

  async list(args: { orgId: string; ownerUserId: string }): Promise<AgentSchedule[]> {
    const docs = await this.deps.storage.listByOrg(args.orgId);
    return docs
      .filter((doc) => doc.ownerUserId === args.ownerUserId && doc.status !== 'rejected')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * An agent proposes a schedule for itself or a sibling in its workplace.
   * Nothing ticks until the owner approves it on the agent's screen.
   */
  async propose(args: ProposeScheduleArgs): Promise<{ ok: true; schedule: AgentSchedule; targetName: string } | ScheduleRefusal> {
    const message = args.message.trim();
    if (!message) return { ok: false, code: 'invalid', reason: 'Say what each tick should tell the agent: --message "…".' };
    if (message.length > SCHEDULE_MESSAGE_MAX) return { ok: false, code: 'invalid', reason: `The message is ${message.length} characters — keep it under ${SCHEDULE_MESSAGE_MAX}; put the long version in a note or the repo.` };
    const everyMinutes = parseEvery(args.every);
    if (everyMinutes === null) return { ok: false, code: 'invalid', reason: '--every takes a cadence from 1m to 24h, like 8m, 90s or 2h.' };
    const window = parseWindow(args.window ?? '00:00-24:00');
    if (!window) return { ok: false, code: 'invalid', reason: '--window is HH:MM-HH:MM inside one day, like 07:00-23:00 (00:00-24:00 is the whole day).' };
    const timeZone = (args.timeZone ?? 'UTC').trim();
    if (!isValidTimeZone(timeZone)) return { ok: false, code: 'invalid', reason: `"${timeZone}" is not a time zone this backend knows — use an IANA name like Europe/Amsterdam or America/Los_Angeles.` };
    for (const [flag, value] of [['--cap-turns', args.capTurns], ['--cap-tokens', args.capTokens]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) return { ok: false, code: 'invalid', reason: `${flag} is a whole number above zero.` };
    }
    const proposer = await this.deps.getAgent(args.userId, args.byAgentId);
    if (!proposer) return { ok: false, code: 'not_found', reason: 'Your own agent record was not found.' };
    if (proposer.purpose) return { ok: false, code: 'refused', reason: 'The Chief of Staff lists and pauses schedules; it cannot create one. An agent proposes a schedule, and the person approves it on the agent\'s screen.' };
    let target = proposer;
    if (args.agent && args.agent.trim()) {
      const wanted = args.agent.trim();
      // Only this workplace's agents: an agent of the owner's in another
      // workplace is not this one's to schedule (the room check used to
      // fence this; a workplace is the fence now, note #843).
      const agents = (await this.deps.listAgents(args.userId)).filter((doc) => doc.orgId === args.orgId);
      const matches = agents.filter((doc) => doc.id === wanted || doc.name.toLowerCase() === wanted.toLowerCase());
      if (matches.length === 0) return { ok: false, code: 'not_found', reason: `No agent named "${wanted}" is in this workplace. Read \`agentbuilt agent list\` for the names.` };
      if (matches.length > 1) return { ok: false, code: 'refused', reason: `More than one agent is named "${wanted}" — use its id from \`agentbuilt agent list\`.` };
      target = matches[0]!;
    }
    if (target.purpose) return { ok: false, code: 'refused', reason: 'The Chief of Staff can never be the target of a schedule. Aim it at another agent.' };
    const existing = await this.forAgent(target.id);
    if (existing) {
      return { ok: false, code: 'refused', reason: `${target.name} already has a schedule (${existing.id}, ${existing.status}${existing.pause ? `, ${existing.pause.reason}` : ''}). One schedule per agent: pause, resume or ask your user to remove it on ${target.name}'s screen.` };
    }
    const now = this.now();
    const schedule: AgentSchedule = {
      id: `sch_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      orgId: args.orgId,
      agentId: target.id,
      ownerUserId: args.userId,
      createdByAgentId: proposer.id,
      createdAt: now.toISOString(),
      message,
      everyMinutes,
      windowFrom: window.from,
      windowTo: window.to,
      timeZone,
      ...(args.capTurns !== undefined ? { capTurns: args.capTurns } : {}),
      ...(args.capTokens !== undefined ? { capTokens: args.capTokens } : {}),
      status: 'proposed',
      day: emptyScheduleDay(localParts(timeZone, now).date),
      failStreak: 0,
    };
    await this.deps.storage.put(schedule);
    const who = proposer.id === target.id ? `${proposer.name} asked for a schedule` : `${proposer.name} proposed a schedule for ${target.name}`;
    await this.deps.recordRow({
      userId: args.userId, agentId: target.id,
      text: `${who}: "${message}" ${describeSchedule(schedule)}. Approve or reject it under Schedule on this screen.`,
    }).catch(() => undefined);
    this.log(`proposed ${schedule.id} for ${target.id} by ${proposer.id}`);
    return { ok: true, schedule, targetName: target.name };
  }

  /** The owner's decision on the agent's screen. Approval starts the clock. */
  async decide(args: { userId: string; id: string; decision: 'approve' | 'reject' }): Promise<{ ok: true; schedule: AgentSchedule } | ScheduleRefusal> {
    const doc = await this.deps.storage.get(args.id);
    if (!doc || doc.ownerUserId !== args.userId) return { ok: false, code: 'not_found', reason: 'No such schedule.' };
    if (doc.status !== 'proposed') return { ok: false, code: 'refused', reason: `This schedule is already ${doc.status}.` };
    const now = this.now();
    const target = await this.deps.getAgent(args.userId, doc.agentId);
    const next: AgentSchedule = args.decision === 'approve'
      ? { ...doc, status: 'active', decidedAt: now.toISOString(), nextTickAt: this.nextTick(doc, now).toISOString() }
      : { ...doc, status: 'rejected', decidedAt: now.toISOString() };
    await this.deps.storage.put(next);
    const name = target?.name ?? 'the agent';
    const line = args.decision === 'approve'
      ? `Schedule approved: ${name} wakes ${describeSchedule(next)}.`
      : `Schedule rejected: ${name} will not be woken ${describeSchedule(next)}.`;
    await this.deps.recordRow({ userId: args.userId, agentId: doc.agentId, text: line }).catch(() => undefined);
    const word = args.decision === 'approve' ? 'APPROVED' : 'REJECTED';
    await this.deps.notifyAgent({
      userId: args.userId, agentId: doc.createdByAgentId,
      text: `[Platform] Your user ${word} the schedule you proposed (${next.id}: "${next.message}", ${describeSchedule(next)}).`
        + (args.decision === 'approve'
          ? ` ${name} now receives a quiet [Platform] Scheduled tick on that cadence inside the window, ${describeCap(next)}; a tick that lands while ${name} is working is skipped, and a chat past ${SCHEDULE_RESET_CONTEXT_PERCENT}% full is reset by a tick instead of worked in. Keep state in a repo, a bucket or ~/SCRATCHPAD.md, never in chat. Nothing else to do: end the turn unless this changes your plan.`
          : ' Nothing will tick. If a schedule is still the right tool, ask your user what to change before proposing again.'),
      task: `Picking up your user's answer on the schedule`,
    }).catch(() => undefined);
    this.refreshAwake(next, target ? now : null);
    return { ok: true, schedule: next };
  }

  /** The owner, the Chief of Staff, or (after an automatic pause) an agent. */
  async pause(args: { id: string; userId: string; by: 'owner' | 'workspace-agent' | 'agent' }): Promise<{ ok: true; schedule: AgentSchedule; changed: boolean } | ScheduleRefusal> {
    const doc = await this.deps.storage.get(args.id);
    if (!doc || doc.ownerUserId !== args.userId) return { ok: false, code: 'not_found', reason: 'No such schedule.' };
    if (doc.status === 'proposed' || doc.status === 'rejected') return { ok: false, code: 'refused', reason: `This schedule is ${doc.status}, so there is nothing to pause.` };
    if (doc.status === 'paused' && doc.pause?.reason !== 'cap') return { ok: true, schedule: doc, changed: false };
    const reason: AgentSchedulePauseReason = args.by === 'owner' ? 'owner' : args.by === 'workspace-agent' ? 'workspace-agent' : 'owner';
    const next: AgentSchedule = { ...doc, status: 'paused', pause: { reason, at: this.now().toISOString() }, nextTickAt: undefined };
    await this.deps.storage.put(next);
    await this.deps.recordRow({ userId: args.userId, agentId: doc.agentId, text: `Schedule paused by ${args.by === 'workspace-agent' ? 'Workspace Agent' : args.by === 'owner' ? 'you' : 'an agent'}.` }).catch(() => undefined);
    this.awake.delete(`${doc.ownerUserId}/${doc.agentId}`);
    return { ok: true, schedule: next, changed: true };
  }

  /** The owner resumes any pause; an agent only a pause the platform made. The Chief of Staff never resumes. */
  async resume(args: { id: string; userId: string; by: 'owner' | 'agent' }): Promise<{ ok: true; schedule: AgentSchedule; changed: boolean } | ScheduleRefusal> {
    const doc = await this.deps.storage.get(args.id);
    if (!doc || doc.ownerUserId !== args.userId) return { ok: false, code: 'not_found', reason: 'No such schedule.' };
    if (doc.status === 'active') return { ok: true, schedule: doc, changed: false };
    if (doc.status !== 'paused') return { ok: false, code: 'refused', reason: `This schedule is ${doc.status}, so there is nothing to resume.` };
    if (args.by === 'agent' && (doc.pause?.reason === 'owner' || doc.pause?.reason === 'workspace-agent')) {
      return { ok: false, code: 'refused', reason: 'Your user paused this schedule; only they resume it, on the agent\'s screen. Tell them if it matters.' };
    }
    const now = this.now();
    const next: AgentSchedule = { ...doc, status: 'active', pause: undefined, failStreak: 0, nextTickAt: this.nextTick(doc, now).toISOString() };
    if (doc.pause?.reason === 'cap') next.day = emptyScheduleDay(localParts(doc.timeZone, now).date);
    await this.deps.storage.put(next);
    await this.deps.recordRow({ userId: args.userId, agentId: doc.agentId, text: `Schedule resumed by ${args.by === 'owner' ? 'you' : 'an agent'}.` }).catch(() => undefined);
    this.refreshAwake(next, now);
    return { ok: true, schedule: next, changed: true };
  }

  /** The owner removes the schedule from the agent's screen; a proposal can be withdrawn by its proposer. */
  async remove(args: { id: string; userId: string; byAgentId?: string }): Promise<{ ok: true } | ScheduleRefusal> {
    const doc = await this.deps.storage.get(args.id);
    if (!doc || doc.ownerUserId !== args.userId) return { ok: false, code: 'not_found', reason: 'No such schedule.' };
    if (args.byAgentId && !(doc.status === 'proposed' && doc.createdByAgentId === args.byAgentId)) {
      return { ok: false, code: 'refused', reason: 'Only a proposal of your own can be withdrawn; an approved schedule is removed by your user on the agent\'s screen.' };
    }
    await this.deps.storage.delete(args.id);
    this.awake.delete(`${doc.ownerUserId}/${doc.agentId}`);
    await this.deps.recordRow({ userId: args.userId, agentId: doc.agentId, text: args.byAgentId ? 'Schedule proposal withdrawn.' : 'Schedule removed by you.' }).catch(() => undefined);
    return { ok: true };
  }

  private nextTick(doc: Pick<AgentSchedule, 'windowFrom' | 'windowTo' | 'timeZone' | 'everyMinutes'>, from: Date, afterCadence = false): Date {
    const jitter = Math.floor((this.deps.random?.() ?? Math.random()) * SCHEDULE_JITTER_MS);
    const earliest = new Date(from.getTime() + (afterCadence ? doc.everyMinutes * 60_000 : 0) + jitter);
    return nextTickFrom(doc, earliest);
  }

  private refreshAwake(doc: AgentSchedule, now: Date | null): void {
    const key = `${doc.ownerUserId}/${doc.agentId}`;
    if (now && doc.status === 'active' && inWindow(doc, now)) this.awake.add(key);
    else this.awake.delete(key);
  }

  /** One pass over every live schedule. Safe to call directly (tests) or on the interval. */
  async sweep(now = this.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const docs = await this.deps.storage.listLive();
      const awake = new Set<string>();
      for (const doc of docs) {
        try {
          const after = await this.sweepOne(doc, now);
          if (after.status === 'active' && inWindow(after, now)) awake.add(`${after.ownerUserId}/${after.agentId}`);
        } catch (error) {
          this.log(`${doc.id}: ${String(error)}`);
        }
      }
      this.awake = awake;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(input: AgentSchedule, now: Date): Promise<AgentSchedule> {
    let doc = input;
    const today = localParts(doc.timeZone, now).date;
    // Local midnight: the counters start over, and a cap pause lifts.
    if (doc.day.date !== today) {
      doc = { ...doc, day: emptyScheduleDay(today) };
      if (doc.status === 'paused' && doc.pause?.reason === 'cap') {
        doc = { ...doc, status: 'active', pause: undefined, nextTickAt: this.nextTick(doc, now).toISOString() };
        await this.deps.recordRow({ userId: doc.ownerUserId, agentId: doc.agentId, text: 'Schedule resumed: a new day, the daily cap starts over.' }).catch(() => undefined);
      }
      await this.deps.storage.put(doc);
    }
    if (doc.status !== 'active') return doc;
    const agent = await this.deps.getAgent(doc.ownerUserId, doc.agentId);
    if (!agent) {
      // The agent is gone: the schedule goes with it.
      await this.deps.storage.delete(doc.id);
      return { ...doc, status: 'rejected' };
    }
    if (doc.tick) {
      const settled = await this.settle(doc, agent, now);
      if (!settled) return doc;
      doc = settled;
      if (doc.status !== 'active') return doc;
    }
    if (!doc.nextTickAt) {
      doc = { ...doc, nextTickAt: this.nextTick(doc, now).toISOString() };
      await this.deps.storage.put(doc);
    }
    if (new Date(doc.nextTickAt!).getTime() > now.getTime()) return doc;
    if (!inWindow(doc, now)) {
      doc = { ...doc, nextTickAt: this.nextTick(doc, now).toISOString() };
      await this.deps.storage.put(doc);
      return doc;
    }
    return this.tick(doc, agent, now);
  }

  /** A tick whose turn ended: read what became of it. Null while it still runs. */
  private async settle(doc: AgentSchedule, agent: AgentRecord, now: Date): Promise<AgentSchedule | null> {
    const tick = doc.tick!;
    const startedAt = new Date(tick.startedAt).getTime();
    const working = this.deps.isAgentWorking(doc.ownerUserId, doc.agentId);
    const ended = agent.lastTurnEndedAt && new Date(agent.lastTurnEndedAt).getTime() >= startedAt;
    const stale = now.getTime() - startedAt > STALE_TICK_MS;
    if (working && !stale) return null;
    if (!ended && !stale && now.getTime() - startedAt < SCHEDULE_SWEEP_MS * 2) return null;
    const spent = Math.max(0, this.deps.tokensSpent(doc.ownerUserId, doc.agentId) - tick.tokensBefore);
    let next: AgentSchedule = { ...doc, tick: undefined, day: { ...doc.day, tokens: doc.day.tokens + spent } };
    const limitHit = agent.sessionLimit && new Date(agent.sessionLimit.hitAt).getTime() >= startedAt;
    if (limitHit) {
      return this.pauseFor(next, 'subscription', now, `${agent.name}'s scheduled turn could not run: the subscription has no room${agent.sessionLimit?.resetAt ? ` until ${agent.sessionLimit.resetAt}` : ''}.`);
    }
    const latest = await this.deps.latestChatRow(doc.ownerUserId, doc.agentId).catch(() => null);
    const failed = latest && latest.role === 'agent' && latest.text.startsWith(FAILED_TURN_ROW_PREFIX) && new Date(latest.at).getTime() >= startedAt;
    if (failed) {
      next = { ...next, failStreak: next.failStreak + 1, lastOutcome: 'failed', day: { ...next.day, failed: next.day.failed + 1 } };
      if (next.failStreak >= SCHEDULE_FAIL_STREAK_PAUSE) {
        return this.pauseFor(next, 'failures', now, `${agent.name}'s scheduled turns failed ${next.failStreak} times in a row; the last said: ${latest!.text.slice(FAILED_TURN_ROW_PREFIX.length).trim().slice(0, 200) || 'no reason given'}.`);
      }
    } else {
      next = { ...next, failStreak: 0, lastOutcome: 'ran' };
    }
    const cap = capReached(next);
    if (cap) return this.pauseForCap(next, agent, now, cap);
    await this.deps.storage.put(next);
    return next;
  }

  private async pauseFor(doc: AgentSchedule, reason: 'failures' | 'subscription', now: Date, detail: string): Promise<AgentSchedule> {
    const next: AgentSchedule = { ...doc, status: 'paused', pause: { reason, at: now.toISOString(), detail }, nextTickAt: undefined };
    await this.deps.storage.put(next);
    const text = `Schedule paused: ${detail} Resume it under Schedule on this screen when it can run again.`;
    await this.deps.tellOwner({
      userId: doc.ownerUserId, orgId: doc.orgId, agentId: doc.agentId, text,
      event: { kind: reason === 'failures' ? 'schedule-failed' : 'schedule-subscription', key: `schedule:${doc.id}:${reason}:${now.toISOString()}`, text: `${text.replace(/ Resume it under.*$/, '')}`, at: now.toISOString() },
    }).catch(() => undefined);
    this.log(`${doc.id} paused: ${reason}`);
    return next;
  }

  private async pauseForCap(doc: AgentSchedule, agent: AgentRecord, now: Date, cap: 'turns' | 'tokens'): Promise<AgentSchedule> {
    const until = nextLocalMidnight(doc.timeZone, now);
    const next: AgentSchedule = { ...doc, status: 'paused', pause: { reason: 'cap', at: now.toISOString(), until: until.toISOString() }, nextTickAt: undefined };
    await this.deps.storage.put(next);
    const what = cap === 'turns' ? `${doc.day.turns} scheduled turns` : `${doc.day.tokens.toLocaleString('en-US')} tokens`;
    const text = `Schedule paused for today: ${agent.name} reached its daily cap (${what}). It resumes at midnight ${doc.timeZone}; ${agent.name} itself still answers you.`;
    await this.deps.tellOwner({
      userId: doc.ownerUserId, orgId: doc.orgId, agentId: doc.agentId, text,
      event: { kind: 'schedule-cap', key: `schedule:${doc.id}:cap:${doc.day.date}`, text, at: now.toISOString() },
    }).catch(() => undefined);
    this.log(`${doc.id} paused: cap (${cap})`);
    return next;
  }

  private async tick(doc: AgentSchedule, agent: AgentRecord, now: Date): Promise<AgentSchedule> {
    const after = (outcome: AgentScheduleTickOutcome, patch: Partial<AgentSchedule> = {}): AgentSchedule => ({
      ...doc, ...patch, lastTickAt: now.toISOString(), lastOutcome: outcome, nextTickAt: this.nextTick(doc, now, true).toISOString(),
    });
    const cap = capReached(doc);
    if (cap) return this.pauseForCap(doc, agent, now, cap);
    // Skip, never queue.
    if (this.deps.isAgentWorking(doc.ownerUserId, doc.agentId)) {
      const next = after('skipped', { day: { ...doc.day, skipped: doc.day.skipped + 1 } });
      await this.deps.storage.put(next);
      return next;
    }
    // Subscription exhausted means pause, not fall over — and never the next subscription.
    const room = await this.deps.subscriptionHasRoom(doc.ownerUserId, agent).catch(() => null);
    if (room === false) {
      return this.pauseFor(doc, 'subscription', now, `${agent.name}'s scheduled turn could not run: the subscription it runs on has no room right now.`);
    }
    // Full chat means reset first; the next tick does the work.
    const percent = this.deps.contextPercent(agent);
    if (percent !== null && percent >= SCHEDULE_RESET_CONTEXT_PERCENT) {
      const reset = await this.deps.resetChat({ userId: doc.ownerUserId, agentId: doc.agentId }).catch(() => ({ ok: false }));
      const next = after('reset', { day: { ...doc.day, resets: doc.day.resets + (reset.ok ? 1 : 0) } });
      await this.deps.storage.put(next);
      this.log(`${doc.id}: reset turn (${percent}% full)`);
      return next;
    }
    const started = await this.deps.startScheduledTurn({
      userId: doc.ownerUserId, agentId: doc.agentId,
      content: buildScheduledTickPrompt({ schedule: doc }),
      task: scheduledTaskLine(doc.message),
    });
    if (started === 'busy') {
      const next = after('skipped', { day: { ...doc.day, skipped: doc.day.skipped + 1 } });
      await this.deps.storage.put(next);
      return next;
    }
    if (started !== 'delivered') {
      const failStreak = doc.failStreak + 1;
      let next = after(started === 'no-machine' ? 'no-machine' : 'failed', { failStreak, day: { ...doc.day, failed: doc.day.failed + 1 } });
      if (failStreak >= SCHEDULE_FAIL_STREAK_PAUSE) {
        next = await this.pauseFor(next, 'failures', now, `${agent.name}'s scheduled turns could not start ${failStreak} times in a row (${started === 'no-machine' ? 'its machine is not connected' : 'the turn failed to start'}).`);
        return next;
      }
      await this.deps.storage.put(next);
      return next;
    }
    const next = after('ran', {
      day: { ...doc.day, turns: doc.day.turns + 1 },
      tick: { startedAt: now.toISOString(), tokensBefore: this.deps.tokensSpent(doc.ownerUserId, doc.agentId) },
    });
    await this.deps.storage.put(next);
    return next;
  }
}
