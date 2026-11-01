import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useWait, WAIT_HOLD_MS, WAIT_QUIET_MS } from './wait.js';

/**
 * The rule note #287 asked for, in three tests: a wait nobody would notice is
 * never drawn, one that is drawn is not snatched away, and a wait that ends in
 * a failure ends at once.
 */

afterEach(() => { vi.useRealTimers(); });

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('a wait', () => {
  it('draws nothing at all for an answer that is quick', async () => {
    vi.useFakeTimers();
    const view = renderHook(({ pending }) => useWait(pending), { initialProps: { pending: true } });
    expect(view.result.current).toBe('quiet');
    await tick(WAIT_QUIET_MS - 40);
    expect(view.result.current).toBe('quiet');
    // The answer lands inside the quiet window: the screen goes straight from
    // holding nothing to showing everything, with no grey frame in between.
    view.rerender({ pending: false });
    expect(view.result.current).toBe('ready');
    await tick(WAIT_QUIET_MS + WAIT_HOLD_MS);
    expect(view.result.current).toBe('ready');
  });

  it('says so once the answer is plainly late', async () => {
    vi.useFakeTimers();
    const view = renderHook(({ pending }) => useWait(pending), { initialProps: { pending: true } });
    await tick(WAIT_QUIET_MS + 10);
    expect(view.result.current).toBe('drawn');
  });

  it('keeps a drawn wait on screen long enough to have been read', async () => {
    vi.useFakeTimers();
    const view = renderHook(({ pending }) => useWait(pending), { initialProps: { pending: true } });
    await tick(WAIT_QUIET_MS + 10);
    expect(view.result.current).toBe('drawn');
    // The answer arrives 10ms after the skeleton did. Snatching it away now is
    // the flicker; it stays for the rest of its hold instead.
    view.rerender({ pending: false });
    await tick(WAIT_HOLD_MS - 60);
    expect(view.result.current).toBe('drawn');
    await tick(120);
    expect(view.result.current).toBe('ready');
  });

  it('lets a long wait go the moment its answer lands', async () => {
    vi.useFakeTimers();
    const view = renderHook(({ pending }) => useWait(pending), { initialProps: { pending: true } });
    await tick(4000);
    expect(view.result.current).toBe('drawn');
    view.rerender({ pending: false });
    await tick(20);
    expect(view.result.current).toBe('ready');
  });

  it('never draws a wait over an answer that is already on the screen', async () => {
    vi.useFakeTimers();
    // A loaded machine does not slow one thing down; it changes the ORDER.
    // The quiet timer expires in the same batch as the answer landing, so
    // React renders once, with the answer in AND the timer's word for it that
    // nothing has arrived. Drawing the wait then replaces a list the reader is
    // already looking at — and, for a quarter of a second, a row they may be
    // reaching for: measured 2026-09-17, `ready -> drawn` with the data in
    // hand, unmounting the list under a tap that then landed on nothing.
    const seen: string[] = [];
    let land = () => {};
    function Screen() {
      const [answered, setAnswered] = useState(false);
      land = () => setAnswered(true);
      seen.push(useWait(!answered));
      return null;
    }
    render(<Screen />);
    act(() => { vi.advanceTimersByTime(WAIT_QUIET_MS); land(); });
    expect(seen).not.toContain('drawn');
    await tick(WAIT_HOLD_MS + 50);
    expect(seen).not.toContain('drawn');
    expect(seen.at(-1)).toBe('ready');
  });
});
