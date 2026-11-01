import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { BackContext, type BackValue } from './back-context.js';
import { enterLeaf, leafStanding, leaveLeaf, placeScroll } from './place-scroll.js';
import { recallScroll } from './scroll-memory.js';

export function useBack(): BackValue {
  const value = useContext(BackContext);
  if (!value) throw new Error('useBack() needs a BackProvider above it');
  return value;
}

/**
 * A transient leaf's own way out, offered for as long as it is on screen.
 * The claim is made in an effect, so nothing is registered during a render
 * and the newest leaf is always the one Back reaches first.
 */
export function useBackClaim(close: () => void, active = true, options?: { covers?: boolean }): void {
  // `claim` and not the whole context: the value moves when a leaf opens or
  // closes, and an effect that watched it would unclaim and reclaim itself
  // forever.
  const { claim } = useBack();
  // A leaf that covers only PART of the screen (`back-context`): no shared
  // Back bar summoned over the screen's own, and no scroll hand-off, because
  // the screen underneath was never left.
  const covers = options?.covers !== false;
  useEffect(() => {
    if (!active) return;
    return claim(close, { covers });
  }, [active, claim, close, covers]);
  useLeafScroll(covers);
}

/**
 * A leaf opens at its own top, and hands back the line the screen underneath
 * was on (note #280).
 *
 * A leaf has no address by design, so it REPLACES the screen that opened it
 * without the router hearing anything: `ScrollMemory` places a screen once
 * per history entry, and no entry was made. The window therefore simply kept
 * the offset the reader had scrolled to, clamped to whatever the leaf itself
 * was tall enough to hold. Measured: the note composer, opened from a notes
 * list 1400px down, came up at its own BOTTOM with its first line cut off
 * under the header — and by the same arithmetic every picker and form opened
 * from a scrolled screen came up somewhere in its middle. That is the owner's
 * "it's slightly lower, seems like scroll position is not reset" (notes #280,
 * #290), with nothing on the screen having moved to explain it.
 *
 * It rides `useBackClaim` because claiming Back is what MAKES something a
 * leaf: one place, every leaf there is, and every leaf there will be. It is
 * deliberately not tied to that hook's `active` — a form that refuses Back
 * while it is saving is still a leaf standing over a screen.
 *
 * The return is the other half, and it is the same pattern the note and agent
 * screens keep by hand for their own leaves (their `parked` line): what
 * covered a screen owes it the place the reader was reading. It goes through
 * `placeScroll` and not a bare `scrollTo` because the leaf is still the whole
 * document at the moment it hands the line back — a plain write there is
 * clamped to the LEAF's height and the list comes back 1400px short, which is
 * what the scroll harness caught the first time this was written.
 *
 * A leaf that ends in a NAVIGATION — the composer, whose Save lands on the
 * note it just made — hands its line to nobody: the unmount runs in the
 * commit's mutation phase, and `ScrollMemory` places the new entry a layout
 * phase later, which cancels this one.
 */
function useLeafScroll(covers = true): void {
  // The entry this leaf stands over, fixed at the moment it opened: a leaf
  // has no address of its own, and the one underneath is where its line is
  // kept.
  const location = useLocation();
  const entry = useRef(location.key);
  useLayoutEffect(() => {
    // A PARTIAL leaf takes nothing and gives nothing back: the screen it
    // stands on is still on screen, at the line its reader left it on.
    if (!covers) return;
    /**
     * The reader's line comes from the ENTRY's own memory and not from
     * `window.scrollY`, which by now is a lie: the leaf replaced the screen
     * in the same commit, so the document is already the leaf's height and
     * the browser has already clamped the reader's 1400 down to whatever this
     * form happens to be. `ScrollMemory` banked the real number on the last
     * scroll before the tap, and stands down for as long as this is up.
     */
    const line = recallScroll(entry.current) ?? 0;
    enterLeaf();
    placeScroll(0);
    return () => {
      leaveLeaf();
      // Leaves can stack (`BackProvider` says so), and the screen's line is
      // owed to the SCREEN. An inner one closing onto an outer one gives it
      // the top instead — which is exactly where that leaf was put when it
      // opened, and the only line anybody has ever recorded for it.
      placeScroll(leafStanding() ? 0 : line);
    };
  }, [covers]);
}
