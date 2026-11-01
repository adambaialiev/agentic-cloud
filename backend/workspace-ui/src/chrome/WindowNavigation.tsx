/**
 * A window's own pages (note #722, the owner: "rooms window has its own
 * internal navigation stack. If user traverse the content, it should be
 * rendered inside of the window").
 *
 * A window over a screen — the agents picker's rooms — draws what its rows
 * open INSIDE itself: a proposal, a note, an agent, and whatever those open
 * in turn, each a page over the one it came from, with a Back of the
 * window's own. The screens are the app's own (`DestinationsContext`) and
 * do not know they are in a window. Two contexts make that true:
 *
 * - `WindowNavigation` replaces the router's navigator under the window, so
 *   every `navigate()`, `<Link>` and `<Navigate>` inside it asks the window
 *   (`WindowMoves`) rather than the browser's address bar. The window decides
 *   what is a page of its own and what leaves it (a conversation does).
 * - `WindowLocation` gives one page its own location, so the screen drawn
 *   there reads its address — `useParams`, `useSearchParams`, `?org=` — as
 *   if it were the page's.
 *
 * Hrefs are the outer router's, so a page's links still say where they lead
 * and still open in a new tab.
 */

import { useContext, useMemo, type ReactNode } from 'react';
import {
  NavigationType,
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_NavigationContext as NavigationContext,
  UNSAFE_RouteContext as RouteContext,
  type Location,
  type Navigator,
  type To,
} from 'react-router-dom';
import { pathOf, type WindowMoves, type WindowPage } from './window-pages.js';

/** Every navigation under it is the window's to answer. */
export function WindowNavigation({ level, moves, children }: {
  level: number;
  moves: WindowMoves;
  children: ReactNode;
}) {
  const outer = useContext(NavigationContext);
  const value = useMemo(() => {
    const encode = outer.navigator.encodeLocation;
    const navigator: Navigator = {
      createHref: (to) => outer.navigator.createHref(to),
      ...(encode ? { encodeLocation: (to: To) => encode(to) } : {}),
      go: (delta) => moves.go(delta),
      push: (to, state) => moves.to(pathOf(to), state, false, level),
      replace: (to, state) => moves.to(pathOf(to), state, true, level),
    };
    return { ...outer, navigator };
  }, [outer, moves, level]);
  return <NavigationContext value={value}>{children}</NavigationContext>;
}

/** A page's own location, and no route above it: the screens drawn here
 *  match their addresses from the root, as they do on the page. */
const NO_ROUTE = { outlet: null, matches: [], isDataRoute: false };

export function WindowLocation({ page, children }: { page: WindowPage; children: ReactNode }) {
  const value = useMemo(() => {
    const location: Location = {
      pathname: page.pathname, search: page.search, hash: page.hash, state: page.state ?? null, key: page.key,
    };
    return { location, navigationType: NavigationType.Push };
  }, [page]);
  return (
    <LocationContext value={value}>
      <RouteContext value={NO_ROUTE}>{children}</RouteContext>
    </LocationContext>
  );
}
