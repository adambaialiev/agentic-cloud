/**
 * Where each history entry was scrolled to, so Back lands on the line the
 * reader left rather than the top — the legacy page's `homeScrollY` and its
 * siblings, generalised to every entry by its key. Recorded on scroll, not
 * on leave: by the time the location has changed the new screen is already
 * measuring the page.
 *
 * The positions live in `scroll-memory.ts`, because the chat needs to ask
 * whether the entry it is opening has one; the placing itself lives in
 * `place-scroll.ts`, because a leaf has to do the same thing without a
 * history entry to hang it on.
 *
 * THIS FILE OWNS THE SCROLL, and until note #280 it only thought it did.
 * `history.scrollRestoration` was left at `'auto'`, which leaves the BROWSER
 * a second authority on the same number — and the browser writes LAST, after
 * this effect has run and after the screen it landed on has finished
 * painting. Two authorities on one number is the shape of the owner's report
 * ("scroll position is not reset when navigating to details page"), and it is
 * worth saying plainly that the shape is all it is: the landing itself was
 * chased through headless Chrome and headless WebKit — a scrolled list, a
 * scrolled Home, slow reads, a phone-sized window — and never came out below
 * the top there. What DID reproduce is in `useBack.ts`, a leaf away. This
 * half is the ownership being made true rather than assumed.
 *
 * WHICH MEANS THE RESTORE BELOW HAS TO ACTUALLY WORK, and it did not. A Back
 * lands while the incoming screen is still the skeleton it mounts as, and a
 * `scrollTo` into a document that short is clamped — to zero, usually.
 * Nothing asked again, and worse, the clamp was then recorded as the reader's
 * own line, so the real one was gone for good. The browser's `'auto'` had
 * been quietly doing the whole job, which is exactly why nobody had noticed:
 * turn it off on its own and Back stops remembering anything at all
 * (`scripts/verify-workspace-react-scroll.mts`). The two halves are one
 * change.
 *
 * AND OWNING A NUMBER MEANS KEEPING IT (note #405). Both halves above are
 * about the instant a screen lands, and for years that was all this shell
 * did: place the page once, in the layout phase, and let go. `place-scroll.ts`
 * holds the line now, so the placement below is in force for the beat after
 * it — which is the beat the reader's report lives in, since a screen is
 * still arriving then and everything that moves the page moves it there.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { leafStanding, placeScroll, placingScroll } from './place-scroll.js';
import { recallScroll, rememberScroll } from './scroll-memory.js';

export function ScrollMemory() {
  const location = useLocation();
  const currentKey = useRef(location.key);

  useEffect(() => {
    const onScroll = () => {
      if (placingScroll() !== null || leafStanding()) return;
      rememberScroll(currentKey.current, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Before any of them: one authority on the scroll, and it is this shell.
  // Declared above the placement so it is in force for the first one too.
  useLayoutEffect(() => { history.scrollRestoration = 'manual'; }, []);

  useLayoutEffect(() => {
    currentKey.current = location.key;
    return placeScroll(recallScroll(location.key) ?? 0);
  }, [location.key]);

  return null;
}
