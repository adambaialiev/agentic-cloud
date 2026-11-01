/**
 * The fold's measurement, without a component around it — a card that already
 * has a row for the button (Home's Workspace agent card) drives the same fold
 * and draws `ReadMore` where it belongs. `FoldLong.tsx` is this plus the box.
 *
 * Measured, not guessed at: the height is read from the write-up as it
 * actually stands — the `.md` the stylesheet clips, never a box around it. A
 * wrapper's height is the CLIPPED height once the fold is on, so measuring one
 * unfolded the reply on the next render and folded it again on the one after,
 * and the card jumped on every poll (note #461). The clipped node itself still
 * reports its whole content as `scrollHeight`, folded or not.
 *
 * It is read before the paint, so a new reply never shows whole for a frame
 * and then snaps shut. A node with no layout (a hidden screen) answers 0 for
 * every height; that is no answer at all, and the fold is left as it was.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';

export const FOLD_HEIGHT = 340;

export interface Fold {
  /** Goes on the box around the write-up, and carries the folded class. */
  className: string;
  /** True while the tail is hidden — the only time a Read more belongs anywhere. */
  showFold: boolean;
  open: () => void;
}

/**
 * `contentKey` is WHAT is folded, not how it is drawn: a new write-up arrives
 * folded again, and a re-render of the same one changes nothing. Keying the
 * opened state on it is what keeps a poll from reopening — or re-closing —
 * what the reader just tapped.
 */
export function useFold(wrap: RefObject<HTMLDivElement | null>, contentKey: string): Fold {
  const [folded, setFolded] = useState(false);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const node = wrap.current?.querySelector('.md') ?? wrap.current?.firstElementChild;
      // Set before the paint, React's own layout-measuring pattern; it
      // settles at once, because the answer no longer depends on the fold.
      if (node && node.scrollHeight > 0) setFolded(node.scrollHeight > FOLD_HEIGHT);
    };
    measure();
    // The same words are a different height on a narrower phone, and a
    // picture or a late font changes one after the first answer. Nothing to
    // watch in jsdom, which lays nothing out.
    if (typeof ResizeObserver !== 'function' || !wrap.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap.current);
    return () => observer.disconnect();
  }, [wrap, contentKey]);
  return {
    className: folded && openedKey !== contentKey ? 'mdwrap folded' : 'mdwrap',
    showFold: folded && openedKey !== contentKey,
    open: () => setOpenedKey(contentKey),
  };
}
