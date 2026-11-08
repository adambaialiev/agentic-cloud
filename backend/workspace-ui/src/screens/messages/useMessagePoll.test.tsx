import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_READ_GIVE_UP_MS, POLL_STALE_ON_RETURN_MS, useMessagePoll } from './useMessagePoll.js';

/** Note #1069: a read that hangs must not stop the poll for good. */
function Poller({ read }: { read: (alive: () => boolean) => Promise<void> }) { useMessagePoll(read); return null; }
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useMessagePoll through a read that never answers (note #1069)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); setHidden(false); vi.useRealTimers(); });

  it('lets a hung read go after the give-up time, asks again, and never lets the late answer draw', async () => {
    const drawn: string[] = [];
    let release: (() => void) | undefined;
    let calls = 0;
    const read = vi.fn(async (alive: () => boolean) => {
      calls += 1;
      if (calls === 1) { await new Promise<void>((resolve) => { release = resolve; }); if (alive()) drawn.push('late'); return; }
      if (alive()) drawn.push(`read ${calls}`);
    });
    render(<Poller read={read} />);
    await tick(10);
    expect(calls).toBe(1);
    await tick(POLL_READ_GIVE_UP_MS - 100);
    expect(calls).toBe(1);
    await tick(100 + 3000);
    expect(calls).toBe(2);
    expect(drawn).toEqual(['read 2']);
    release!(); await tick(10);
    expect(drawn).toEqual(['read 2']);
    await tick(3000);
    expect(calls).toBe(3);
  });

  it('asks again at once on return when the read in flight began before the page was put away', async () => {
    let calls = 0;
    const read = vi.fn(async () => { calls += 1; if (calls === 1) await new Promise<void>(() => {}); });
    render(<Poller read={read} />);
    await tick(10);
    setHidden(true);
    await tick(POLL_STALE_ON_RETURN_MS + 1000);
    expect(calls).toBe(1);
    setHidden(false);
    await tick(10);
    expect(calls).toBe(2);
  });

  it('leaves a fresh read alone on return: still single-flight', async () => {
    let calls = 0;
    const read = vi.fn(async () => { calls += 1; await new Promise<void>(() => {}); });
    render(<Poller read={read} />);
    await tick(10);
    setHidden(true); setHidden(false);
    await tick(10);
    expect(calls).toBe(1);
  });
});
