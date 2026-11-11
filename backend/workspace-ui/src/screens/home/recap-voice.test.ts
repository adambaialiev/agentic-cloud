import { describe, expect, it } from 'vitest';
import { RECAP_AUTOPLAY_FRESH_MS, RECAP_NOT_PRIMED, recapAutoplay } from './recap-voice.js';

/** Note #1146: only a new recap plays by itself, once per turn. */
describe('recapAutoplay', () => {
  const at = Date.parse('2026-11-11T09:00:00Z');
  const turn = (endedAt: string, recap?: string) => ({ endedAt, ...(recap ? { recap } : {}) });
  const live = { shown: true, on: true, visible: true, at };

  it('treats what stood when the screen opened as history', () => {
    const first = recapAutoplay(RECAP_NOT_PRIMED, { ...live, turn: turn('2026-11-11T08:59:50Z', 'Old news.') });
    expect(first.play).toBe(false);
    expect(recapAutoplay(first.heard, { ...live, turn: turn('2026-11-11T08:59:50Z', 'Old news.') }).play).toBe(false);
  });

  it('plays a recap that arrives later, once — a rewrite of the same turn is not read again', () => {
    let heard = recapAutoplay(RECAP_NOT_PRIMED, { ...live, turn: turn('2026-11-11T08:59:00Z') }).heard;
    expect(heard).toEqual({ primed: true, turn: null });
    const arrived = recapAutoplay(heard, { ...live, turn: turn('2026-11-11T08:59:00Z', 'I shipped it.') });
    expect(arrived.play).toBe(true);
    heard = arrived.heard;
    expect(recapAutoplay(heard, { ...live, turn: turn('2026-11-11T08:59:00Z', 'I shipped it, and checked it.') }).play).toBe(false);
    expect(recapAutoplay(heard, { ...live, turn: turn('2026-11-11T08:59:58Z', 'Next one.') }).play).toBe(true);
  });

  it('passes over a recap that arrives with the speaker off, the tab hidden, the line not shown, or long after its turn', () => {
    const primed = { primed: true, turn: null };
    const next = turn('2026-11-11T08:59:30Z', 'News.');
    for (const change of [{ on: false }, { visible: false }]) {
      const step = recapAutoplay(primed, { ...live, ...change, turn: next });
      expect(step.play).toBe(false);
      // Passed over for good: turning on or coming back does not replay it.
      expect(recapAutoplay(step.heard, { ...live, turn: next }).play).toBe(false);
    }
    const hidden = recapAutoplay(primed, { ...live, shown: false, turn: next });
    expect(hidden).toEqual({ play: false, heard: primed });
    const stale = turn(new Date(at - RECAP_AUTOPLAY_FRESH_MS - 1).toISOString(), 'Long ago.');
    expect(recapAutoplay(primed, { ...live, turn: stale }).play).toBe(false);
  });
});
