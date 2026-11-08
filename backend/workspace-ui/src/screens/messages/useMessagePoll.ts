import { useEffect, useMemo, useRef } from 'react';
import { WorkspaceApiError } from '../../api/client.js';
/** The workplace's messaging machine sleeps when nobody is writing, and the
 * first open wakes it. That is a state to wait through, not an error: the
 * poll asks again by itself, so the screen says so quietly. */
export const isOpening = (err: unknown) => err instanceof WorkspaceApiError && err.code === 'opening';
/**
 * How long one read may stay unanswered before the poll stops waiting for it
 * and asks again (note #1069). A request in flight when a phone locks can
 * hang rather than fail, and a single-flight poll behind it never asked
 * again: the screen stood on its last picture until a reload. Long enough
 * for a big answer on a slow signal.
 */
export const POLL_READ_GIVE_UP_MS = 45_000;
/** On return to a visible page, a read older than this is presumed lost with the sleep and asked again at once. */
export const POLL_STALE_ON_RETURN_MS = 10_000;
/**
 * Single-flight reads; stop while hidden and catch up on return. A read that
 * hangs is let go after `POLL_READ_GIVE_UP_MS`, or at once on return when it
 * began before the page was put away; its `alive()` answers false from then
 * on, so a late answer to it never draws over a newer one.
 */
export function useMessagePoll(read: (alive: () => boolean) => Promise<void>, interval = 3000) {
  useEffect(() => {
    let alive = true, busy = false, epoch = 0, startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, giveUp: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); if (alive && !document.hidden) timer = setTimeout(() => { void tick(); }, interval); };
    const letGo = () => { epoch += 1; busy = false; clearTimeout(giveUp); };
    const tick = async () => {
      if (!alive || busy || document.hidden) return;
      busy = true; startedAt = Date.now();
      const mine = ++epoch;
      clearTimeout(giveUp);
      giveUp = setTimeout(() => { if (epoch === mine) { letGo(); schedule(); } }, POLL_READ_GIVE_UP_MS);
      try { await read(() => alive && epoch === mine); }
      finally { if (epoch === mine) { busy = false; clearTimeout(giveUp); schedule(); } }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      if (busy && Date.now() - startedAt > POLL_STALE_ON_RETURN_MS) letGo();
      void tick();
    };
    void tick(); document.addEventListener('visibilitychange', visibility);
    return () => { alive = false; clearTimeout(timer); clearTimeout(giveUp); document.removeEventListener('visibilitychange', visibility); };
  }, [read, interval]);
}

/**
 * How many polls in a row may miss before the screen says so (note #1069).
 * One missed read is the network, not news: a phone on a weak signal, or one
 * that locked with a read in flight, drops a body now and then, and the next
 * tick three seconds later usually lands. The banner is for a read that
 * keeps failing.
 */
export const POLL_MISSES_BEFORE_BANNER = 3;

/** A poll's answer that is an object at all — the least every read needs before it touches a field. */
export const isAnswerObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** What the banner says about a read that keeps failing: the reason, and the HTTP status when there was one. */
export function pollFailureLine(err: unknown): string {
  const reason = err instanceof Error && err.message ? err.message : 'The read failed.';
  if (!(err instanceof WorkspaceApiError) || err.status < 400 || reason.includes(String(err.status))) return reason;
  return `${reason} (HTTP ${err.status})`;
}

/**
 * Counts a poll's misses in a row. `miss` answers whether this one is the
 * miss that should be shown; `hit` starts the count again.
 */
export function usePollMisses() {
  const misses = useRef(0);
  return useMemo(() => ({
    hit: () => { misses.current = 0; },
    miss: () => { misses.current += 1; return misses.current >= POLL_MISSES_BEFORE_BANNER; },
  }), []);
}
