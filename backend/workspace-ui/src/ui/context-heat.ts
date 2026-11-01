import { contextHeat } from '../../../src/shared/context-heat.js';

// The thresholds live in shared/context-heat.ts so the agents' own guidance
// reads the same numbers as this ring; re-exported here for the drawings.
export { contextHeat };

/**
 * The ring is a glanceable gauge rather than text, so it can use a brighter
 * colour than the palette's text-bearing semantic inks. Rotate continuously
 * from green (room to work) to red (time for a fresh chat) instead of leaving
 * the ordinary case in the same blue as every link and selected control.
 */
export function contextHue(pct: number): number {
  const clamped = Math.min(100, Math.max(0, pct));
  return Math.round(140 * (1 - clamped / 100));
}

/** The reading clamped to the bar, or null when there is nothing measured.
 *  A ring at 0% would read as "empty and measured" rather than "not
 *  measured", which is why absence stays absence all the way down. */
export function contextPercent(context: { usedPercent?: number } | null | undefined): number | null {
  if (!context || typeof context.usedPercent !== 'number') return null;
  return Math.min(100, Math.max(0, context.usedPercent));
}
