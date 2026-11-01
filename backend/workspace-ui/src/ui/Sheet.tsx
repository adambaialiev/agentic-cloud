/**
 * The sheet: one shell for every window that stands over a screen without
 * leaving it (note #715). The agents picker was the first (notes #581,
 * #713); Home's Workplace and Rooms windows are the same shell, so they
 * open and close with the same movement, wear the same flat paper and are
 * dismissed the same ways.
 *
 * On a phone it rises from the bottom edge and stops short of the top, so
 * the screen it came from is still there above it. At a desk it hangs from a
 * fixed line near the top of the screen, the way the launcher does. The
 * shell owns only that: the dim, the card, the way in, the way out, and
 * Escape. What is inside — and what Back, Close and Escape MEAN there — is
 * the caller's.
 *
 * Every way out plays the exit first (note #713, the owner): the card slides
 * back down where it came from (at a desk it fades and shrinks a touch), the
 * dim fades with it, and only then is it gone. The caller asks for that by
 * setting `leaving`; the shell calls `onGone` once the exit has played.
 * Asked for less movement, it is gone at once. While leaving, the dim takes
 * no taps — the reader is not held up by a window on its way out.
 */

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from './motion.js';

/** The longest way out — the phone's slide down (`agentsheetdown`). */
const EXIT_MS = 200;
/** The exit animations, by name: the end of one of THESE is the card gone,
 *  not the end of its way in or of something inside it. */
const EXITS = new Set(['agentsheetdown', 'agentsheetpopout']);

export function Sheet({
  id, className = '', labelledBy, leaving, onGone, onDim, onEscape, cardRef, still = false, children,
}: {
  id: string;
  /** Added to the card's own `agentsheet` class. */
  className?: string;
  labelledBy: string;
  /** Play the way out, then call `onGone`. */
  leaving: boolean;
  onGone: () => void;
  /** A tap on the dim around the card. */
  onDim: () => void;
  /** Escape, at a desk. */
  onEscape: () => void;
  cardRef?: RefObject<HTMLDivElement | null>;
  /** Stand without the way in — a window coming back from a screen that
   *  covered it is returning, not arriving. */
  still?: boolean;
  children: ReactNode;
}) {
  const ownCard = useRef<HTMLDivElement>(null);
  const card = cardRef ?? ownCard;
  const gone = useRef(onGone);
  const escape = useRef(onEscape);
  useEffect(() => { gone.current = onGone; escape.current = onEscape; });

  // Gone when the exit has PLAYED: the browser says when its animation has
  // finished, at whatever speed it actually ran, so a slow frame never cuts
  // the slide short. A browser that plays none (or cannot say) waits the
  // exit's own length; one that never finishes is let go well after.
  // Asked for less movement, the way out is not played at all: gone at
  // once, and the dim never wears `leaving` for a frame.
  const instant = leaving && reducedMotion();
  useEffect(() => {
    if (!leaving) return;
    if (instant) { gone.current(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; gone.current(); } };
    const exits = (card.current?.getAnimations?.() ?? [])
      .filter((one) => EXITS.has((one as CSSAnimation).animationName));
    const backstop = window.setTimeout(finish, exits.length ? EXIT_MS * 8 : EXIT_MS + 80);
    if (exits.length) void Promise.all(exits.map((one) => one.finished)).then(finish, finish);
    return () => window.clearTimeout(backstop);
  }, [leaving, instant, card]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') escape.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className={`scrim sheetscrim${leaving && !instant ? ' leaving' : ''}${still ? ' still' : ''}`}
      onClick={(event) => { if (!leaving && event.target === event.currentTarget) onDim(); }}
      role="presentation"
    >
      <div
        className={`agentsheet${className ? ` ${className}` : ''}`}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={card}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
