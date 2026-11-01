/**
 * Schedules (note #779): wake an agent on a heartbeat, with a cap.
 *
 * One row, owned by a room, aimed at ONE room agent: a message, a cadence,
 * a daily window in a named time zone, and a budget. Each tick is a quiet
 * platform turn of that agent — like a finished job's receipt — carrying a
 * `[Platform] Scheduled` block. A schedule is a standing order to spend the
 * owner's subscription while nobody is watching, so a room agent only
 * PROPOSES one; the owner approves it on the agent's screen.
 *
 * The guards are the design: skip when working (never queue), cap in turns
 * and tokens that resets at local midnight, reset the chat before a tick
 * when it is past the threshold, pause when the chosen subscription has no
 * room, pause after three failed ticks in a row. The pure rules live here
 * so the service and the tests share one reading of them.
 */

import type { WorkspaceScheduleView } from '../shared/workspace-api.js';

export type AgentScheduleStatus = 'proposed' | 'active' | 'paused' | 'rejected';

export type AgentSchedulePauseReason = 'owner' | 'workspace-agent' | 'cap' | 'failures' | 'subscription';

export type AgentScheduleTickOutcome = 'ran' | 'skipped' | 'reset' | 'failed' | 'no-machine';

export interface AgentScheduleDay {
  /** Calendar day in the schedule's time zone, YYYY-MM-DD. */
  date: string;
  /** Scheduled turns that ran today (started and were not refused). */
  turns: number;
  /** Tokens those turns spent, as the token ledger credited them. */
  tokens: number;
  /** Ticks dropped because the agent was still working. */
  skipped: number;
  /** Ticks whose turn failed. */
  failed: number;
  /** Ticks that became a chat reset instead. */
  resets: number;
}

export interface AgentSchedule {
  id: string;
  orgId: string;
  /** The agent each tick wakes. Never the Workspace Agent. */
  agentId: string;
  /** The person whose subscription the ticks spend — the agent's owner. */
  ownerUserId: string;
  /** The agent that proposed it (itself or a sibling in the room). */
  createdByAgentId: string;
  createdAt: string;
  /** The words each tick carries. */
  message: string;
  everyMinutes: number;
  /** HH:MM, inclusive start and exclusive end, inside one local day. */
  windowFrom: string;
  windowTo: string;
  timeZone: string;
  capTurns?: number;
  capTokens?: number;
  status: AgentScheduleStatus;
  decidedAt?: string;
  pause?: {
    reason: AgentSchedulePauseReason;
    at: string;
    /** For a cap pause: when it lifts by itself (next local midnight). */
    until?: string;
    /** For a failure or subscription pause: the words the owner read. */
    detail?: string;
  };
  day: AgentScheduleDay;
  /** Consecutive failed ticks; three pause the schedule. */
  failStreak: number;
  nextTickAt?: string;
  lastTickAt?: string;
  lastOutcome?: AgentScheduleTickOutcome;
  /** A tick whose turn is running and whose outcome is still to be read. */
  tick?: { startedAt: string; tokensBefore: number };
}

export const SCHEDULE_MIN_MINUTES = 1;
export const SCHEDULE_MAX_MINUTES = 24 * 60;
export const SCHEDULE_MESSAGE_MAX = 2000;
/** Context fullness at which a tick becomes a reset turn instead. */
export const SCHEDULE_RESET_CONTEXT_PERCENT = 60;
/** Failed ticks in a row that pause the schedule. */
export const SCHEDULE_FAIL_STREAK_PAUSE = 3;
/** Jitter on each tick so two schedules in one room do not always collide. */
export const SCHEDULE_JITTER_MS = 5_000;

export function emptyScheduleDay(date: string): AgentScheduleDay {
  return { date, turns: 0, tokens: 0, skipped: 0, failed: 0, resets: 0 };
}

/** `8m`, `90s`, `2h`, `15` (minutes) → minutes, or null. */
export function parseEvery(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? 'm';
  const minutes = unit.startsWith('s') ? n / 60 : unit.startsWith('h') ? n * 60 : n;
  if (minutes < SCHEDULE_MIN_MINUTES || minutes > SCHEDULE_MAX_MINUTES) return null;
  return Math.round(minutes * 100) / 100;
}

/** `07:00-23:00` → from/to, or null. `00:00-24:00` is the whole day. */
export function parseWindow(text: string): { from: string; to: string } | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [fh, fm, th, tm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (fm > 59 || tm > 59 || fh > 23 || th > 24 || (th === 24 && tm > 0)) return null;
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  if (to <= from) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${pad(fh)}:${pad(fm)}`, to: `${pad(th)}:${pad(tm)}` };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock parts of `now` in `timeZone`. */
export function localParts(timeZone: string, now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The UTC instant of local `date` at `minutes` past local midnight in `timeZone`. */
export function localToUtc(timeZone: string, date: string, minutes: number): Date {
  const [y, mo, d] = date.split('-').map(Number);
  // The wall time read as UTC, corrected by the zone's offset at that instant
  // (twice, so a DST edge between the two readings still lands).
  const target = Date.UTC(y, mo - 1, d) + minutes * 60_000;
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const at = localParts(timeZone, new Date(guess));
    const [ay, am, ad] = at.date.split('-').map(Number);
    const wall = Date.UTC(ay, am - 1, ad) + at.minutes * 60_000;
    guess += target - wall;
  }
  return new Date(guess);
}

/** Next local midnight after `now` in `timeZone` — when the daily counters reset. */
export function nextLocalMidnight(timeZone: string, now: Date): Date {
  const { date } = localParts(timeZone, now);
  return localToUtc(timeZone, date, 24 * 60);
}

export function inWindow(schedule: Pick<AgentSchedule, 'windowFrom' | 'windowTo' | 'timeZone'>, now: Date): boolean {
  const { minutes } = localParts(schedule.timeZone, now);
  return minutes >= minutesOf(schedule.windowFrom) && minutes < minutesOf(schedule.windowTo);
}

/**
 * The next tick at or after `earliest`: `earliest` itself when the window is
 * open then, otherwise the window's next opening. Jitter is added by the
 * caller so this stays a pure clock.
 */
export function nextTickFrom(schedule: Pick<AgentSchedule, 'windowFrom' | 'windowTo' | 'timeZone'>, earliest: Date): Date {
  if (inWindow(schedule, earliest)) return earliest;
  const { date, minutes } = localParts(schedule.timeZone, earliest);
  const from = minutesOf(schedule.windowFrom);
  if (minutes < from) return localToUtc(schedule.timeZone, date, from);
  // Past today's window: tomorrow's opening.
  return localToUtc(schedule.timeZone, date, 24 * 60 + from);
}

export function capReached(schedule: Pick<AgentSchedule, 'capTurns' | 'capTokens' | 'day'>): 'turns' | 'tokens' | null {
  if (schedule.capTurns !== undefined && schedule.day.turns >= schedule.capTurns) return 'turns';
  if (schedule.capTokens !== undefined && schedule.day.tokens >= schedule.capTokens) return 'tokens';
  return null;
}

/** The words a person reads for a cadence. */
export function describeEvery(minutes: number): string {
  if (minutes < 1) return `every ${Math.round(minutes * 60)} seconds`;
  if (minutes === 1) return 'every minute';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return `every ${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} minutes`;
}

export function describeCap(schedule: Pick<AgentSchedule, 'capTurns' | 'capTokens'>): string {
  const parts: string[] = [];
  if (schedule.capTurns !== undefined) parts.push(`${schedule.capTurns} turns`);
  if (schedule.capTokens !== undefined) parts.push(`${schedule.capTokens.toLocaleString('en-US')} tokens`);
  return parts.length ? `at most ${parts.join(' and ')} a day` : 'no daily cap';
}

/** One line a person or agent reads: cadence, window, zone, cap. */
export function describeSchedule(schedule: Pick<AgentSchedule, 'everyMinutes' | 'windowFrom' | 'windowTo' | 'timeZone' | 'capTurns' | 'capTokens'>): string {
  return `${describeEvery(schedule.everyMinutes)}, ${schedule.windowFrom}–${schedule.windowTo} ${schedule.timeZone}, ${describeCap(schedule)}`;
}

export function describePause(pause: NonNullable<AgentSchedule['pause']>): string {
  switch (pause.reason) {
    case 'owner': return 'paused by you';
    case 'workspace-agent': return 'paused by the Chief of Staff';
    case 'cap': return 'paused: daily cap reached, resumes at midnight';
    case 'failures': return 'paused: three ticks failed in a row';
    case 'subscription': return 'paused: the subscription has no room';
  }
}

/** The tick's `[Platform]` block, the way a job receipt reads. */
export function buildScheduledTickPrompt(args: {
  schedule: Pick<AgentSchedule, 'id' | 'message' | 'everyMinutes' | 'windowFrom' | 'windowTo' | 'timeZone' | 'capTurns' | 'capTokens' | 'day'>;
}): string {
  const { schedule } = args;
  const used = schedule.capTurns !== undefined
    ? `This is scheduled turn ${schedule.day.turns + 1} of ${schedule.capTurns} today`
    : `This is scheduled turn ${schedule.day.turns + 1} today`;
  return [
    `[Platform] Scheduled tick. Your user approved a schedule (${schedule.id}, ${describeSchedule(schedule)}) that started this turn with these words:`,
    '',
    schedule.message,
    '',
    `${used}${schedule.capTokens !== undefined ? `, with ${schedule.day.tokens.toLocaleString('en-US')} of ${schedule.capTokens.toLocaleString('en-US')} tokens spent` : ''}. Nobody wrote to you and nobody is waiting on a reply: this is a quiet turn, like a finished job's receipt, and your user has been told NOTHING — no message, no row in their chat. Do the work the schedule asks for, then end the turn; write to your user only if something actually needs them, in your own words.`,
    `Keep whatever must survive between ticks in a repo, a bucket or ~/SCRATCHPAD.md, never in this chat: when your chat is past ${SCHEDULE_RESET_CONTEXT_PERCENT}% full, a tick resets it instead of working, and the next tick starts fresh. If you are still working when the next tick lands, that tick is skipped, never queued.`,
  ].join('\n');
}

/** The schedule as screens and the CLI read it. */
export function scheduleView(doc: AgentSchedule, names: { agentName: string; proposerName: string }, now: Date): WorkspaceScheduleView {
  return {
    id: doc.id,
    agentId: doc.agentId,
    agentName: names.agentName,
    status: doc.status,
    ...(doc.pause ? { pause: { ...doc.pause, text: describePause(doc.pause) } } : {}),
    message: doc.message,
    everyMinutes: doc.everyMinutes,
    windowFrom: doc.windowFrom,
    windowTo: doc.windowTo,
    timeZone: doc.timeZone,
    ...(doc.capTurns !== undefined ? { capTurns: doc.capTurns } : {}),
    ...(doc.capTokens !== undefined ? { capTokens: doc.capTokens } : {}),
    summary: describeSchedule(doc),
    day: { ...doc.day },
    failStreak: doc.failStreak,
    ...(doc.nextTickAt && doc.status === 'active' ? { nextTickAt: doc.nextTickAt } : {}),
    ...(doc.lastTickAt ? { lastTickAt: doc.lastTickAt } : {}),
    ...(doc.lastOutcome ? { lastOutcome: doc.lastOutcome } : {}),
    ticking: Boolean(doc.tick),
    awake: doc.status === 'active' && inWindow(doc, now),
    proposedBy: { agentId: doc.createdByAgentId, name: names.proposerName },
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
  };
}

/** The row's "Now" line while a scheduled turn runs. */
export function scheduledTaskLine(message: string): string {
  return `Scheduled: ${message}`;
}
