/**
 * The geometry of a chat's one scroller, and its way back to the newest
 * message (note #334) — shared by the room chat and the Chief of Staff's
 * (note #730), so the two cannot drift apart. The button itself is
 * `ChatJump` in ChatScreen.tsx.
 */

import { reducedMotion } from '../../ui/motion.js';

/** How near the newest message counts as following the conversation. */
export const NEAR_BOTTOM_PX = 200;

/** True once the reader is a whole pane or more above the newest message —
 *  far enough that the end is no longer a flick away, which is when a way
 *  back down earns its place over the words (note #334). Nearer than that
 *  the button would be furniture in the way of the last few lines. A pane
 *  with no height yet (jsdom, a first paint) falls back to the near-bottom
 *  band, so the reading never asks for zero. */
export const farFromBottom = (pane: HTMLElement): boolean =>
  pane.scrollHeight - pane.scrollTop - pane.clientHeight >= Math.max(pane.clientHeight, NEAR_BOTTOM_PX);

/** Smooth only for rows landing in a watched conversation; opening a chat
 *  snaps straight to its end, and reduced motion keeps the snap always.
 *  `scrollTo` is what carries the curve, and the plain assignment is the same
 *  snap in every browser — including the one the jsdom tests run in, which
 *  gives an element no `scrollTo` at all. */
export function scrollToBottom(pane: HTMLElement | null, smooth = false): void {
  if (!pane) return;
  const top = pane.scrollHeight;
  if (smooth && !reducedMotion() && typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior: 'smooth' });
  else pane.scrollTop = top;
}

/**
 * Whether the way back down shows, read off one scroll at a settled pane
 * height (notes #334, #730): a whole pane or more above the newest message,
 * or whatever else the screen counts (`also`). A jump in flight keeps it gone
 * for the whole trip down — every frame of a smooth scroll is still "far from
 * the end", and the button coming back for those frames read as a tap that
 * did nothing — until the trip lands or the reader turns back up themselves.
 */
export function readChatJump(anchor: HTMLDivElement | null, pane: HTMLElement, also = false): void {
  if (!anchor) return;
  const trip = anchor.dataset.trip;
  if (trip !== undefined) {
    if (pane.scrollTop >= Number(trip) && farFromBottom(pane)) { anchor.dataset.trip = String(pane.scrollTop); return; }
    delete anchor.dataset.trip;
  }
  anchor.hidden = !(farFromBottom(pane) || also);
}

/** The tap: the button goes at once, and the pane travels to the newest message. */
export function jumpToNewest(anchor: HTMLDivElement | null, pane: HTMLElement | null): void {
  if (anchor) { anchor.hidden = true; anchor.dataset.trip = String(pane?.scrollTop ?? 0); }
  scrollToBottom(pane, true);
}
