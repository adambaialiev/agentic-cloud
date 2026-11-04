/**
 * The words of the recap line under a conversation's latest completed turn
 * (note #945) — kept apart from the component that draws them (TurnRecap.tsx).
 */

import type { WorkspaceTurnRecap } from '../../../../src/shared/turn-recap.js';

/** How long a turn worked: "12s", "3m 4s", "1h 2m". */
export function workedFor(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return secs % 60 ? `${mins}m ${secs % 60}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
}

/** When it finished: the clock today, the day and the clock before that. */
export function doneAt(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `yesterday ${clock}`;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock}`;
}

/** "Alex", "Alex and Mia", "Alex, Mia and Noah", "4 agents". */
function names(list: string[]): string {
  if (list.length > 3) return `${list.length} agents`;
  if (list.length < 2) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/**
 * The facts line's words. `jobs` is what the agent left running past its
 * turn (the jobs strip's own count), `waiting` whose answers the Chief of
 * Staff is still collecting — both read live by the screen, so the clause
 * goes the moment the thing stops.
 */
export function turnFacts(turn: WorkspaceTurnRecap, still: { jobs?: number; waiting?: string[] } = {}, now = Date.now()): string {
  const parts: string[] = [];
  const started = Date.parse(turn.startedAt ?? '');
  const ended = Date.parse(turn.endedAt);
  if (Number.isFinite(started) && Number.isFinite(ended)) parts.push(`Worked for ${workedFor(ended - started)}`);
  const done = doneAt(turn.endedAt, now);
  if (done) parts.push(parts.length ? `done ${done}` : `Done ${done}`);
  const jobs = still.jobs ?? 0;
  if (jobs > 0) parts.push(`${jobs} background ${jobs === 1 ? 'job' : 'jobs'} still running`);
  if (still.waiting?.length) parts.push(`waiting on ${names(still.waiting)}`);
  return parts.join(' · ');
}

/**
 * Whether the line belongs at the end of this conversation now: a completed
 * turn on record, nothing running or on its way, and the conversation's last
 * word not the reader's own (that starts the next turn), nor a reply newer
 * than the turn the record knows of.
 */
export function showsTurnRecap(
  turn: WorkspaceTurnRecap | undefined,
  conversation: { busy: boolean; last?: { role: string; at?: string }; lastReplyAt?: string },
): turn is WorkspaceTurnRecap {
  if (!turn || conversation.busy || !conversation.last) return false;
  if (conversation.last.role === 'owner') return false;
  const ended = Date.parse(turn.endedAt);
  const replied = Date.parse(conversation.lastReplyAt ?? '');
  return !Number.isFinite(replied) || replied <= ended;
}

/**
 * One sentence a line (note #976): the recap's own words, unchanged, split
 * where a sentence ends — a stop, then a space, then what starts a sentence.
 * "agenticcloudcomputer.com" or "v1.2" has no space after its dot and stays whole.
 */
export function recapSentences(recap: string): string[] {
  return recap.split(/(?<=[.!?…])\s+(?=[A-Z0-9"“'‘(])/).map((sentence) => sentence.trim()).filter(Boolean);
}
