import { describe, expect, it } from 'vitest';
import { paceMarkText, paceWords, windowPace } from './pace.js';

/** Whether a window is being spent faster than its own length allows. */

const WEEK_MS = 7 * 24 * 3600_000;
const now = Date.parse('2026-09-03T12:00:00Z');
/** A weekly window `gone` through its length, with `usedPercent` spent. */
const weekly = (gone: number, usedPercent: number) => ({
  usedPercent,
  windowMins: 10_080,
  resetAt: new Date(now + WEEK_MS * (1 - gone)).toISOString(),
});
/** And a five-hour session window, the same way (note #341). */
const session = (gone: number, usedPercent: number) => ({
  usedPercent,
  windowMins: 300,
  resetAt: new Date(now + 5 * 3600_000 * (1 - gone)).toISOString(),
});

describe('the pace of a window', () => {
  it('measures the spend against how much of the window has gone by', () => {
    const pace = windowPace(weekly(0.5, 31), now)!;
    expect(pace.expectedPercent).toBe(50);
    expect(pace.deltaPercent).toBe(-19);
    expect(pace.verdict).toBe('under');
    expect(pace.runsOutInMs).toBeUndefined();
    expect(paceWords(pace)).toEqual({ tone: '', lead: '19% under an even pace' });
    expect(paceMarkText(pace)).toBe('An even pace would be 50% by now');
  });

  it('says when the allowance runs out, for a window spent too fast', () => {
    const pace = windowPace(weekly(0.5, 70), now)!;
    expect(pace.verdict).toBe('ahead');
    // 70% in half a week leaves 30% at that rate: another day and a half.
    expect(pace.runsOutInMs).toBe(1.5 * 24 * 3600_000);
    expect(paceWords(pace)).toEqual({ tone: 'warn', lead: '20% ahead of an even pace', tail: 'gone in 1d 12h' });
  });

  it('calls a small gap even, rather than nagging about a point either way', () => {
    expect(windowPace(weekly(0.5, 51), now)!.verdict).toBe('even');
    expect(windowPace(weekly(0.5, 48), now)!.verdict).toBe('even');
    expect(paceWords(windowPace(weekly(0.5, 51), now)!))
      .toEqual({ tone: '', lead: 'Right on an even pace' });
  });

  it('an untouched window only says how far under pace it is', () => {
    expect(paceWords(windowPace(weekly(0.5, 0), now)!))
      .toEqual({ tone: '', lead: '50% under an even pace' });
  });

  it('reads a five-hour session window on the same scale as a week', () => {
    // An hour into the five, a third of the session spent: at that rate the
    // allowance is gone with two hours of the session still to run.
    const pace = windowPace(session(0.2, 34), now)!;
    expect(pace.expectedPercent).toBeCloseTo(20);
    expect(pace.verdict).toBe('ahead');
    expect(paceMarkText(pace)).toBe('An even pace would be 20% by now');
    expect(paceWords(pace)).toEqual({
      tone: 'warn', lead: '14% ahead of an even pace', tail: 'gone in 1h 56m',
    });
    // Slower than the session allows, four hours in: nothing to forecast.
    expect(paceWords(windowPace(session(0.8, 51), now)!))
      .toEqual({ tone: '', lead: '29% under an even pace' });
  });

  it('waits out the first minutes of a session, as it does of a week', () => {
    // Five percent of five hours is fifteen minutes; one turn before that
    // reads as a rate no session could sustain.
    const fresh = windowPace(session(0.03, 9), now)!;
    expect(fresh.early).toBe(true);
    expect(paceWords(fresh))
      .toEqual({ tone: '', lead: '6% ahead of an even pace', tail: 'Period just started' });
    expect(windowPace(session(0.06, 9), now)!.early).toBeUndefined();
  });

  it('has nothing to say about a window it cannot place in time', () => {
    // A length of zero has no fraction of itself to have gone by.
    expect(windowPace({ usedPercent: 80, windowMins: 0, resetAt: new Date(now + 3600_000).toISOString() }, now)).toBeNull();
    // The two halves of a pace: without either there is no elapsed fraction.
    expect(windowPace({ usedPercent: 40, windowMins: 10_080 }, now)).toBeNull();
    expect(windowPace({ usedPercent: 40, resetAt: new Date(now + WEEK_MS / 2).toISOString() }, now)).toBeNull();
    expect(windowPace({ usedPercent: 40, windowMins: 10_080, resetAt: 'nonsense' }, now)).toBeNull();
    // Money, not a rationed allowance.
    expect(windowPace({ ...weekly(0.5, 40), spend: true }, now)).toBeNull();
  });

  it('shows the comparison from reset, without extrapolating early usage', () => {
    for (const elapsed of [0, 0.001, 2 / 168, 0.049999]) {
      const pace = windowPace(weekly(elapsed, 10), now)!;
      expect(pace.expectedPercent).toBeCloseTo(elapsed * 100);
      expect(pace.early).toBe(true);
      expect(pace.runsOutInMs).toBeUndefined();
      expect(paceWords(pace)).toEqual({
        tone: '', lead: `${Math.round(10 - elapsed * 100)}% ahead of an even pace`,
        tail: 'Period just started',
      });
    }
    expect(paceWords(windowPace(weekly(0, 0), now)!)).toEqual({
      tone: '', lead: 'Right on an even pace', tail: 'Period just started',
    });
    const settled = windowPace(weekly(0.05, 10), now)!;
    expect(settled.early).toBeUndefined();
    expect(settled.runsOutInMs).toBeGreaterThan(0);
    expect(paceWords(settled).tone).toBe('warn');
  });

  it('stops before a window starts, or once it is over or spent', () => {
    expect(windowPace(weekly(-0.01, 1), now)).toBeNull();
    // Past its own reset the reading describes a window that no longer exists.
    expect(windowPace(weekly(1.2, 40), now)).toBeNull();
    // Nothing left to pace; the meter already says it is full.
    expect(windowPace(weekly(0.5, 100), now)).toBeNull();
  });
});
