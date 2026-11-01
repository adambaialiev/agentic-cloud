/**
 * A wait, and whether it is worth drawing.
 *
 * A loading state that appears and vanishes inside a few frames is not
 * progress — it is a flicker, and the reader reads a flicker as a fault. That
 * is note #287 in the user's own words: "I saw a flash of loading state, which
 * was wrong." So a wait here has three states rather than two:
 *
 *   quiet  the answer may still be immediate, so nothing new is drawn;
 *   drawn  it is plainly late, and the screen says so;
 *   ready  the answer is in, and has replaced whatever was holding its place.
 *
 * The hold between the last two is what makes "it never flashes" true rather
 * than nearly true. It costs nothing in the two cases that actually happen — a
 * fast answer never draws anything at all, and a slow one has been on screen
 * far longer than the hold by the time it lands. It is paid only inside the
 * narrow window between them, which is precisely the window a flicker lives
 * in.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How late an answer has to be before the wait is worth drawing. Under a
 *  quarter second a reader experiences a tap as having simply worked, and
 *  anything drawn in that time is seen only as it leaves. */
export const WAIT_QUIET_MS = 250;
/** Once drawn, the shortest time it stays. Long enough to have been read as an
 *  answer of its own rather than as a blink. */
export const WAIT_HOLD_MS = 300;

export type Wait = 'quiet' | 'drawn' | 'ready';

export function useWait(pending: boolean): Wait {
  const [drawn, setDrawn] = useState(false);
  const shownAt = useRef(0);
  // Whether a wait has actually BEEN on the screen. Written after a render
  // that drew one is committed, and read by the next render — see the batch
  // below, which is the whole reason this exists.
  const painted = useRef(false);

  // Late enough to say so. The timer is torn down when the answer lands, so an
  // answer inside the quiet window never draws anything — not even for a
  // frame.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { shownAt.current = Date.now(); setDrawn(true); }, WAIT_QUIET_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // The answer is in, and something is standing in its place: leave it there
  // for the remainder of the hold. A skeleton already past it clears on the
  // next tick — and one that was never painted at all (below) clears at once,
  // because there is nothing there to hold.
  useEffect(() => {
    if (pending || !drawn) return;
    const left = painted.current ? Math.max(0, WAIT_HOLD_MS - (Date.now() - shownAt.current)) : 0;
    const timer = setTimeout(() => setDrawn(false), left);
    return () => clearTimeout(timer);
  }, [pending, drawn]);

  // Derived, never stored: an answer that drew nothing is ready in the SAME
  // render it arrives in. Routing that through a state update would give the
  // reader one painted frame of the wait after the wait was over.
  //
  // `painted` is the guard against the race this hook can otherwise CAUSE. A
  // loaded machine does not slow one thing down, it changes the order: the
  // quiet timer expires in the same batch as the answer landing, the effect
  // that would have cleared the timer has not run yet, and React renders once
  // with both — the answer in hand and `drawn` true. Without the guard the
  // screen then replaces a list the reader is already looking at with a
  // loading card, for the length of the hold. Measured on Drive on
  // 2026-09-17 (`ready -> drawn` with data in hand): the list unmounted, a
  // tap aimed at one of its rows landed on a node that was no longer in the
  // document, and nothing happened — which is also how it turned CI red, four
  // times in two days, on a test that clicks a folder.
  //
  // So a wait is drawn only while it is either still wanted or already on the
  // screen. One the answer beat to the batch is never drawn at all.
  const wait: Wait = drawn && (pending || painted.current) ? 'drawn' : pending ? 'quiet' : 'ready';
  useLayoutEffect(() => { painted.current = wait === 'drawn'; }, [wait]);
  return wait;
}
