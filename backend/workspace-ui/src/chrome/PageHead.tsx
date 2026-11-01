/**
 * The persistent header over every ordinary destination: Back, live state
 * when there is one, and under them the screen's own name. The screen underneath
 * may also say what it is live about — an agent's own screen says whether it
 * is working (`HeadPresence`).
 * Absent on Home itself, and on the chat, which pins its own identity header
 * with its own Back — exactly as the legacy `#pageHead` is.
 *
 * There is ONE header, and every detail screen fills the same one (note
 * #282). A screen hands its mark, title and sub line to `ScreenTitle`, which
 * renders them into the slot below the navigation row; the hairline along the
 * bottom closes the whole block off, exactly as the chat's identity bar is
 * closed off from its transcript (note #278). Before this the bar carried
 * nothing and each screen drew its own heading beneath it, in whichever of
 * three shapes that screen had been given.
 *
 * Back asks a transient leaf first. A picker or a form has no address by
 * design (knowledge page "miniapp-navigation"), so there is no entry for Back
 * to move through and the screen that opened one owns the return.
 *
 * Failing that it SPENDS a history entry when the browser has one of ours
 * underneath: it never repaints a parent while leaving the child's address in
 * place. A pasted or reloaded address has no entry of ours beneath it, so
 * Back there replaces it with Home — the honest root, and the same answer the
 * legacy page synthesizes.
 */

import { useWorkspace } from '../workspace/useWorkspace.js';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { matchPath, useLocation, useNavigationType } from 'react-router-dom';
import { BackContext, type BackValue } from './back-context.js';
import { HeadPresence } from './HeadPresence.js';
import { HeadSlotContext } from './head-slot.js';
import { useReturnToParent } from './history.js';
import { useBack } from './useBack.js';
import { routerPathFor } from '../routes.js';
import { Svg } from '../ui/icons.js';
import { RadioButton } from '../radio/RadioButton.js';

export function BackProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  // A replacement gives the same browser entry a fresh React Router key.
  // Keep one VISIT token through replacements, but move it on every push or
  // pop: a leaf belongs to the visit it covered, not merely to a pathname.
  const visit = useRef(0);
  const seenKey = useRef(location.key);
  const [visibleVisit, setVisibleVisit] = useState(0);
  useLayoutEffect(() => {
    if (seenKey.current === location.key) return;
    seenKey.current = location.key;
    if (navigationType !== 'REPLACE') visit.current += 1;
    setVisibleVisit(visit.current);
  }, [location.key, navigationType]);
  const claims = useRef<Array<{ handler: () => void; covers: boolean; visit: number }>>([]);
  // The ref is what `handle` reads, because it must always see the newest
  // leaf; the count is what asks the header to read it again after a covering
  // claim arrives or leaves. Its visit keeps that count from standing the
  // header up on the next screen. Only the leaves that need the shared bar are
  // counted — a partial one with its own Close does not
  // (`back-context`).
  const [depth, setDepth] = useState(0);
  const [depthVisit, setDepthVisit] = useState(0);

  const syncCovering = useCallback(() => {
    const current = visit.current;
    setDepthVisit(current);
    setDepth(claims.current.filter((candidate) => candidate.visit === current && candidate.covers).length);
  }, []);

  const claim = useCallback((handler: () => void, options?: { covers?: boolean }) => {
    // A transient leaf belongs to the browser ENTRY it covered, not to the
    // provider that happens to outlive every screen. Usually React removes
    // the leaf in the same commit as navigation. Keeping the visit here is
    // the hard edge for a partial sheet or an async close that survives that
    // commit: it must never swallow Back on the screen that just arrived.
    const held = { handler, covers: options?.covers !== false, visit: visit.current };
    claims.current = [...claims.current, held];
    syncCovering();
    return () => {
      claims.current = claims.current.filter((candidate) => candidate !== held);
      syncCovering();
    };
  }, [syncCovering]);

  const handle = useCallback(() => {
    // The newest leaf first: pickers can stack, and the one on top is the one
    // the reader is looking at. An owner from another browser entry is stale
    // here even if its effect cleanup has not run yet.
    const top = claims.current.findLast((candidate) => candidate.visit === visit.current);
    if (!top) return false;
    top.handler();
    return true;
  }, []);

  const claimed = depthVisit === visibleVisit && depth > 0;
  const value = useMemo<BackValue>(() => ({ claim, handle, claimed }), [claim, handle, claimed]);
  return <BackContext value={value}>{children}</BackContext>;
}

export function PageHead({ children }: { children: ReactNode }) {
  const location = useLocation();
  const back = useBack();
  const returnToParent = useReturnToParent();
  // The slot is state and not a ref because what fills it are the screens
  // BELOW this component: they can only portal into a node that already
  // exists, so the header has to render once and say so.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // Home and the chat pin their own way about, so the persistent header steps
  // aside there — unless a transient leaf is standing over one of them, which
  // has no address of its own and would otherwise have no way out at all.
  const own = location.pathname === '/' || location.pathname === '/signup'
    || Boolean(matchPath(routerPathFor('chat'), location.pathname))
    || Boolean(matchPath(routerPathFor('directMessage'), location.pathname))
    || Boolean(matchPath(routerPathFor('recapChat'), location.pathname));
  // A person waiting on another workplace's admin (the join detour in
  // RequiredSetup, since note #726 the one thing that still stands in front
  // of the Workspace): every address bounces back to their invite, so Back
  // on it would lead nowhere.
  const state = useWorkspace().state;
  const gated = Boolean(state?.joining && (state.org?.unnamed || !state.org));
  const goBack = () => {
    if (back.handle()) return;
    returnToParent();
  };
  const stands = !own || back.claimed;
  // The shape of what is returned never changes with `stands`, only the
  // header inside it. Swapping the ROOT — a bare provider for a fragment —
  // put the provider at a different position, and React answered by tearing
  // the whole app below it down and building it again: a leaf that claimed
  // Back on mount unmounted itself the moment the header appeared, taking
  // the half-written note in it along.
  return (
    <>
      {stands ? (
        <header className="pagehead" id="pageHead">
          <nav className="pagenav" aria-label="Page navigation">
            {/* Behind the setup gate there is nowhere to go back TO: the only
                screens open there are doors (a join request, the profile),
                and Back from one led a person who came to join a team into
                founding a workplace they never asked for. */}
            {gated && location.pathname.startsWith('/invite/')
              ? <span aria-hidden="true" />
              : <button className="back" id="pageBack" type="button" onClick={goBack}><Svg name="back" size={20} />Back</button>}
            {/* On screens that have something live to say about themselves —
                today only an agent's own — it stands in the row's middle. */}
            <HeadPresence />
            {/* The work radio's play button (note #712) closes the row. */}
            <RadioButton />
          </nav>
          <div className="pageid" id="pageId" ref={setSlot} />
        </header>
      ) : null}
      <HeadSlotContext value={stands ? slot : null}>{children}</HeadSlotContext>
    </>
  );
}
