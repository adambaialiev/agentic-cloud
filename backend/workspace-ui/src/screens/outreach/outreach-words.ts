/**
 * Outreach's words (note #1089): what the owner reads on his own screen.
 * None of this reaches a prospect — the letters' words come from note #799,
 * through the import, and are never written here.
 */

import {
  OUTREACH_STATE_WORDS, outreachLocalTime,
  type OutreachNext, type OutreachRow, type OutreachState, type OutreachStep, type OutreachTouch,
} from '../../../../src/shared/outreach.js';

export const stateWords = (state: OutreachState): string => OUTREACH_STATE_WORDS[state];

export const stepWords = (step: OutreachStep): string => (step === 'first' ? 'First letter' : step === 'day4' ? 'Day-4 follow-up' : 'Day-11 follow-up');

const shortDate = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** What is next for a company, in a few words, or nothing. */
export function nextWords(next: OutreachNext | null): string {
  if (!next) return '';
  if (next.step === 'first') return 'Ready to send';
  return next.due ? `${stepWords(next.step)} due` : `${stepWords(next.step)} on ${shortDate(next.dueAt!)}`;
}

/** "Mon 09:14 there", or why there is no time. */
export function localTimeWords(city: string | null, now: number): string {
  if (!city) return 'No city';
  const time = outreachLocalTime(city, new Date(now));
  return time ? `${city} · ${time} there` : `${city} · no local time`;
}

export function listSub(rows: OutreachRow[]): string {
  const fit = rows.filter((row) => row.fit === 'fit');
  const count = (state: OutreachState) => fit.filter((row) => row.state === state).length;
  const parts = [`${fit.length} companies`];
  for (const state of ['sent', 'replied', 'trying', 'installed'] as const) {
    if (count(state)) parts.push(`${count(state)} ${stateWords(state).toLowerCase()}`);
  }
  return parts.join(' · ');
}

/** One touch on the timeline, as a heading line. */
export function touchWords(touch: OutreachTouch): string {
  switch (touch.kind) {
    case 'sent': return `${stepWords(touch.step)} sent to ${touch.to}`;
    case 'reply': return `${touch.suspicious ? 'A letter claiming to be from' : 'Reply from'} ${touch.from}`;
    case 'note': return 'Your note';
    case 'state': return `${stateWords(touch.from)} → ${stateWords(touch.to)}`;
    case 'installed': return `Installed: their own copy at ${touch.domain} reported in`;
    case 'edit': {
      const field = touch.field === 'email' ? 'Address' : touch.field === 'person' ? 'Person' : 'City';
      return `${field}: ${touch.from ?? 'none'} → ${touch.to ?? 'none'}`;
    }
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}
