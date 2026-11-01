/**
 * Is this subscription window being spent faster or slower than its own
 * length allows? Shared by the browser's usage meter and the private recap,
 * so both give the same answer about evenly distributed consumption.
 */

/** Show the comparison immediately, but wait before extrapolating a new
 * period's usage into an exhaustion forecast. */
const PACE_FORECAST_MIN_ELAPSED = 0.05;
/** Within this many points of even, "on pace" is the honest word. */
const PACE_DEADBAND = 3;

export interface Pace {
  /** Where an even spend would stand right now, 0..100. */
  expectedPercent: number;
  /** Spent minus expected, in points. Positive is spending too fast. */
  deltaPercent: number;
  verdict: 'ahead' | 'even' | 'under';
  /** The comparison is valid, but too little time has passed for a forecast. */
  early?: boolean;
  /** How long the allowance lasts at this rate, only when before reset. */
  runsOutInMs?: number;
}

export interface PaceInput {
  usedPercent: number;
  resetAt?: string;
  windowMins?: number;
  spend?: true;
}

/** The pace of one window, or null when there is nothing honest to say. */
export function windowPace(window: PaceInput, now: number): Pace | null {
  // A spend cap is money, not a rationed allowance, and it carries no length.
  if (window.spend) return null;
  // Both halves are needed to place the window in time, and a non-positive
  // length has no fraction of itself to have gone by.
  if (!window.resetAt || !window.windowMins || window.windowMins <= 0) return null;
  const resetAt = Date.parse(window.resetAt);
  if (!Number.isFinite(resetAt)) return null;
  const durationMs = window.windowMins * 60_000;
  const elapsedMs = durationMs - (resetAt - now);
  const fraction = elapsedMs / durationMs;
  // Before it starts or after it resets, the reading is not this window's pace.
  if (!(fraction >= 0) || fraction > 1) return null;
  const early = fraction < PACE_FORECAST_MIN_ELAPSED;
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  // Nothing remains to pace once the window is spent.
  if (usedPercent >= 100) return null;
  const expectedPercent = fraction * 100;
  const deltaPercent = usedPercent - expectedPercent;
  const verdict = deltaPercent > PACE_DEADBAND
    ? 'ahead'
    : deltaPercent < -PACE_DEADBAND ? 'under' : 'even';
  return {
    expectedPercent,
    deltaPercent,
    verdict,
    ...(early ? { early: true } : {}),
    ...(!early && verdict === 'ahead' && usedPercent > 0
      ? { runsOutInMs: (elapsedMs * (100 - usedPercent)) / usedPercent }
      : {}),
  };
}
