import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coarseActive, countdown, elapsed, relative, useNow } from './time.js';

/** The three ways a screen says WHEN, and the clock behind them. */

function Clock({ running }: { running: boolean }) {
  return <span data-testid="now">{useNow(running)}</span>;
}
const read = () => Number(screen.getByTestId('now').textContent);

afterEach(() => { vi.useRealTimers(); });

describe('the words', () => {
  it('relative counts back, and refuses a future or broken instant', () => {
    const now = Date.parse('2026-09-02T12:00:00Z');
    expect(relative('2026-09-02T11:59:30Z', now)).toBe('just now');
    expect(relative('2026-09-02T11:55:00Z', now)).toBe('5m ago');
    expect(relative('2026-09-02T09:00:00Z', now)).toBe('3h ago');
    expect(relative('2026-08-31T12:00:00Z', now)).toBe('2d ago');
    expect(relative('2026-09-02T12:00:01Z', now)).toBe('');
    expect(relative('nonsense', now)).toBe('');
  });

  it('coarseActive counts calendar days, not 24-hour blocks', () => {
    // 23:50 and 00:10 are an hour apart, and "yesterday" is what a person means.
    const now = Date.parse('2026-09-02T00:10:00');
    expect(coarseActive('2026-09-02T00:05:00', now)).toBe('today');
    expect(coarseActive('2026-09-01T23:50:00', now)).toBe('yesterday');
    expect(coarseActive('2026-08-30T12:00:00', now)).toBe('3d ago');
  });

  it('elapsed is a stopwatch', () => {
    const started = Date.parse('2026-09-02T12:00:00Z');
    expect(elapsed('2026-09-02T12:00:00Z', started + 42_000)).toBe('0:42');
    expect(elapsed('2026-09-02T12:00:00Z', started + 725_000)).toBe('12:05');
    expect(elapsed('2026-09-02T12:00:00Z', started + 3_789_000)).toBe('1:03:09');
  });
});

describe('the clock', () => {
  it('a still reading is this component’s own mount, not someone else’s tick', () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-09-02T12:00:00Z');
    vi.setSystemTime(t0);
    render(<Clock running={false} />);
    expect(read()).toBe(t0);
  });

  it('a running reading moves by the second, and a still one does not', () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-09-02T12:00:00Z');
    vi.setSystemTime(t0);
    const still = render(<Clock running={false} />);
    expect(read()).toBe(t0);
    render(<Clock running />, { container: document.body.appendChild(document.createElement('div')) });

    // Advancing the fake timers moves the fake clock with them.
    act(() => { vi.advanceTimersByTime(3000); });
    const readings = screen.getAllByTestId('now').map((node) => Number(node.textContent));
    expect(readings[0]).toBe(t0);
    expect(readings[1]).toBe(t0 + 3000);
    still.unmount();
  });

  /** The other direction (note #510): what the recap card says while a
   *  briefing is waiting on its cadence floor. */
  it('counts down to a due moment, and says nothing when there is nothing to wait for', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    expect(countdown(new Date(now + 4 * 60_000).toISOString(), now)).toBe('in 4m');
    expect(countdown(new Date(now + 59 * 60_000).toISOString(), now)).toBe('in 59m');
    expect(countdown(new Date(now + 60 * 60_000).toISOString(), now)).toBe('in 1h');
    // Inside the last minute the run is starting: the caller falls back to
    // whatever it says while one is actually in flight.
    expect(countdown(new Date(now + 30_000).toISOString(), now)).toBe('');
    expect(countdown(new Date(now - 60_000).toISOString(), now)).toBe('');
    expect(countdown('not a date', now)).toBe('');
  });

});
