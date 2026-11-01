/**
 * The floating menu that hangs from a control in Home's header row — the
 * workplace switch (note #609) and the reader's own picture (note #634)
 * both drop one. This is the shared shell; each caller brings its rows.
 *
 * Portalled to the end of the document and placed from the anchor's own
 * box, because the header row it opens from clips what grows out of it.
 * Placed in PAGE coordinates rather than fixed ones, so it scrolls with the
 * control it hangs from instead of floating free of it.
 *
 * Four ways out, all the same answer: a tap anywhere outside it, Escape,
 * Back (a partial leaf — the screen underneath is still being read), and
 * the address moving — which is what choosing a row that navigates does.
 *
 * The menu takes the focus, not its first row: one reflex Enter must not
 * act on whatever happens to be listed first. Arrow keys walk the rows.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useBackClaim } from '../../chrome/useBack.js';

type Place = { top: number; right: number };

function placeUnder(anchor: HTMLElement): Place {
  const box = anchor.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  return {
    top: box.bottom + window.scrollY + 4,
    // Right edge on the anchor's right edge.
    right: Math.max(12, viewport - box.right),
  };
}

export function HeaderMenu({ id, label, anchor, onClose, children }: {
  id: string;
  label: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const opened = useRef(location.pathname);
  const menu = useRef<HTMLDivElement>(null);
  const leave = useRef(onClose);
  const [place, setPlace] = useState<Place | null>(null);

  useEffect(() => { leave.current = onClose; });
  useBackClaim(onClose, true, { covers: false });

  useLayoutEffect(() => {
    const measure = () => { if (anchor.current) setPlace(placeUnder(anchor.current)); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor]);

  useEffect(() => {
    menu.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      leave.current();
      anchor.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return;
      leave.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [anchor]);

  // The address moved (a switch lands on Home, settings is its own screen),
  // so the control this hung from is not the one on screen any more.
  useEffect(() => {
    if (location.pathname !== opened.current) leave.current();
  }, [location.pathname]);

  const walk = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (at + 1) % items.length
          : (at <= 0 ? items.length - 1 : at - 1);
    items[next]!.focus();
  }, []);

  return createPortal(
    <div
      className="orgmenu" id={id} role="menu" aria-label={label}
      ref={menu} tabIndex={-1} onKeyDown={walk}
      style={place ? { top: place.top, right: place.right } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
