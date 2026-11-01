/**
 * Is this window being spent faster or slower than it can afford?
 *
 * A weekly allowance divided evenly over its own length is 14.3% a day, so a
 * window that knows BOTH how long it is and when it resets knows how much of
 * itself has gone by — and the gap between that and the percent actually
 * spent is the whole answer: ahead of an even pace means it runs out before
 * the reset, under it means there is room to spare (note #279).
 *
 * EVERY window that knows its own length is read this way, the five-hour
 * session limit included (note #341). It was left out at first as
 * un-rationable — a session is MEANT to be burned in an afternoon — but the
 * same arithmetic on a short window answers the question actually asked at
 * the keyboard: at this rate, does the allowance outlast the afternoon? No
 * threshold below needs rescaling for it, because each one is a FRACTION of
 * the window rather than a length of time.
 */

import { type Pace, windowPace } from '../../../src/shared/usage-pace.js';
import { untilText } from './seat-words.js';

// Preserve this module's public surface for the usage components and tests;
// the arithmetic itself now lives beside the API shapes the server also uses.
export { windowPace };
export type { Pace };

/**
 * The sentence under the meter: the ANSWER — how far off an even pace this
 * is — plus the moment the allowance runs out when it is being spent early.
 * A slower week needs no projected end percentage: the reset line already
 * says how long remains, while the meter says how much remains (note #285).
 */
export function paceWords(pace: Pace): { tone: '' | 'warn'; lead: string; tail?: string } {
  const off = Math.round(Math.abs(pace.deltaPercent));
  const lead = pace.verdict === 'ahead'
    ? `${off}% ahead of an even pace`
    : pace.verdict === 'under'
      ? `${off}% under an even pace`
      : 'Right on an even pace';
  // Early exhaustion is actionable and belongs beside the warning. Under or
  // even pace needs no forecast: the current percentage is immediately above.
  return {
    tone: !pace.early && pace.verdict === 'ahead' ? 'warn' : '',
    lead,
    ...(pace.early
      ? { tail: 'Period just started' }
      : pace.runsOutInMs !== undefined ? { tail: `gone ${untilText(pace.runsOutInMs)}` } : {}),
  };
}

/** What the tick on the meter is, for a pointer and a screen reader. */
export function paceMarkText(pace: Pace): string {
  return `An even pace would be ${Math.round(pace.expectedPercent)}% by now`;
}
