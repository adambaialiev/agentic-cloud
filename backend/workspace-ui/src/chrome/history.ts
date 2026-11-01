import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, type To } from 'react-router-dom';

/**
 * The browser's own list of this tab's entries, as the Navigation API shows
 * it (Chrome, Edge, Safari 26.2 and later). Only the one fact Back needs is
 * read off it: where in that list the page standing now is.
 */
interface BrowserNavigation {
  currentEntry?: { index: number } | null;
}

function browserNavigation(): BrowserNavigation | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { navigation?: BrowserNavigation }).navigation;
}

/**
 * What the browser stack can tell us about where a screen came from.
 *
 * React Router numbers the browser entries it owns in `history.state.idx`.
 * Zero is the page-session root; a positive index proves there is one of our
 * entries underneath. Its location key cannot prove that: a REPLACE writes a
 * fresh key while keeping index zero, which used to make Back call
 * `navigate(-1)` against an empty stack and visibly do nothing (note #440).
 *
 * That index is still only the router's own count, written into the entry
 * and carried with it — and the browser does not have to agree with it. On
 * the owner's iPhone a proposal page's Back did nothing (note #742) while
 * Safari's own back arrow was grey: the browser had nothing under the page
 * and the count said there was. So where the browser keeps a list of its own
 * (the Navigation API), its word that this page is the FIRST of the tab
 * settles it. It is never asked to prove more than that: its list stops at
 * the page's origin and does not know which entries are ours, which is what
 * the router's count is for.
 *
 * MemoryRouter does not write the browser's history state. The key fallback
 * keeps component tests honest there, but only when the browser state does
 * not describe this same location.
 */
export function hasEntryBeneath(
  location: { key: string },
  browserState: unknown = typeof window === 'undefined' ? undefined : window.history.state,
  navigation: BrowserNavigation | undefined = browserNavigation(),
): boolean {
  if (navigation?.currentEntry?.index === 0) return false;
  if (browserState && typeof browserState === 'object') {
    const state = browserState as { idx?: unknown; key?: unknown };
    const sameEntry = state.key === location.key
      || (state.key === undefined && location.key === 'default');
    if (sameEntry && typeof state.idx === 'number') return state.idx > 0;
  }
  return location.key !== 'default';
}

/**
 * How long a Back the browser was asked for may take to land before it is
 * taken to have had nowhere to go. A traverse to an entry of this page is a
 * task or two away, so this is long past any real one and short enough that
 * the fallback still reads as the answer to the tap.
 */
export const BACK_LANDING_MS = 600;

/**
 * The way out of a screen: its header's Back, or a mutation that ends the
 * screen's reason to exist — archiving the note being read, say.
 *
 * It owes the reader the place they came FROM, not a place the app picked
 * for them (knowledge page "miniapp-navigation": an archived note returns
 * through its real parent). So it spends our own entry when there is one
 * underneath, and falls back to an honest root — Home, unless the screen
 * names its own parent — when the address was pasted or reloaded and there
 * is nothing of ours below it. The fallback REPLACES this entry: it is where
 * the reader goes instead, never one more page for Back to walk through.
 *
 * And it never does nothing (note #742). Where the browser cannot say what
 * is under the page (no Navigation API), the router's count is all there is
 * to go on, and the count can be wrong. A step back the browser had nowhere
 * to take lands nowhere — no `popstate`, no page left, the same entry still
 * standing — and after {@link BACK_LANDING_MS} of that, the root is where the
 * reader goes.
 */
export function useReturnToParent(fallback: To = '/', options: { state?: unknown } = {}): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = options;
  // The entry standing NOW, for a check that runs after renders this
  // callback's closure never saw.
  const standing = useRef(location.key);
  useLayoutEffect(() => { standing.current = location.key; }, [location.key]);
  // The step back still being watched, so a second press or the screen
  // going away does not leave it to fire into someone else's page.
  const watching = useRef<(() => void) | null>(null);
  useEffect(() => () => watching.current?.(), []);
  return useCallback(() => {
    const root = () => navigate(fallback, { replace: true, ...(state === undefined ? {} : { state }) });
    watching.current?.();
    if (!hasEntryBeneath(location)) {
      root();
      return;
    }
    const from = standing.current;
    let timer = 0;
    const stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', stop);
      window.removeEventListener('pagehide', stop);
      if (watching.current === stop) watching.current = null;
    };
    timer = window.setTimeout(() => {
      stop();
      if (standing.current === from) root();
    }, BACK_LANDING_MS);
    // A traverse within this page says so with `popstate`; one to another
    // document takes this page away with it.
    window.addEventListener('popstate', stop);
    window.addEventListener('pagehide', stop);
    watching.current = stop;
    navigate(-1);
  }, [fallback, location, navigate, state]);
}
