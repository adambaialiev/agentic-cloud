/**
 * Put the page on a line, and hold it there until the reader takes over
 * (notes #280, #405).
 *
 * `window.scrollTo` is not a request the browser can always grant: it is
 * clamped by what the document is tall enough to hold AT THAT INSTANT, and in
 * this shell that instant is almost always the wrong one. A screen mounts as
 * the skeleton it draws while its read is in flight, so the two moments that
 * most need a line placed — a Back returning to a list, a leaf closing back
 * onto the screen it covered — both land while there is nothing there yet to
 * scroll. The write clamps, usually to zero, and nothing asks again.
 *
 * So the ask is held: the screen grows when its read lands, and the growth is
 * what this waits for. It is the same answer the chat's opening snap gives a
 * pane the shell has not bounded yet (note #278), moved up to the window and
 * shared, because two callers making it separately is two chances to get the
 * clamp wrong — which is exactly what happened the first time this was
 * written twice.
 *
 * AND THE LINE IS THEN DEFENDED, which until note #405 the top never was.
 * Reaching a line and keeping it are two different jobs, and this file only
 * did the first: the guard that skipped the wait — "the top is the one line
 * every document can hold, so there is nothing to wait for" — skipped the
 * hold with it, and returned in the same instruction. From that microsecond
 * the page belonged to nobody, so whatever moved it next kept it: a focus
 * without `preventScroll`, a `scrollIntoView`, a screen's own `scrollTo` a
 * layout phase later, an iOS fling still gliding, a phone's address bar or a
 * mini app's sheet resizing the window under a screen that was still
 * arriving. Measured in Chrome (`scripts/verify-workspace-react-scroll.mts`):
 * a 70px nudge 80ms, 700ms or 2s after a screen landed on its top was simply
 * kept — and so was one landing on a screen whose read was still out — while
 * the very same nudge against a line a Back had restored was taken straight
 * back. That asymmetry is the owner's report —
 * "slightly lower scroll position", on screen after screen, each one looking
 * like a bug of its own because the thing they share is an absence.
 *
 * The reader still wins the moment they ask for the page: a flick, a wheel, a
 * key or a pointer ends the hold outright. What they cannot ask for is a
 * scroll nobody made, and that is the only thing taken back.
 *
 * One window, so one placement: a new one cancels whatever was still being
 * held. That ordering carries the case that matters — a leaf whose Save
 * navigates hands the old screen's line back on its way out, and the incoming
 * entry's own placement, a layout phase later, overrules it.
 */

/**
 * How long a placement stays in force: long enough for a screen to grow tall
 * enough to hold the line it owes its reader, and — since note #405 — long
 * enough to keep that line afterwards.
 *
 * One window for both, because they are one job. Long enough for a read over
 * a phone's network, and short enough that a screen which is never going to
 * arrive stops being asked and the page goes back to belonging to whatever is
 * on it.
 */
const REACH_MS = 3000;

let holding: number | null = null;
let stop: () => void = () => {};
let leaves = 0;

/**
 * The line the page is still being put on, or null when it is settled.
 *
 * A scroll event while this is set is the browser answering a placement — a
 * clamp that fell short of the line, not the reader reading. `ScrollMemory`
 * asks before it banks one, because banking the clamp would overwrite the
 * very line being restored with the distance it failed to reach.
 */
export function placingScroll(): number | null {
  return holding;
}

/**
 * How many transient leaves are standing over the screen right now.
 *
 * A leaf has no address, so the window's scroll while one is up belongs to
 * NOBODY: banking it into the history entry underneath would replace the
 * reader's line on that screen with wherever a picker happened to sit, and
 * the screen would then come back somewhere they had never been. Counted
 * rather than flagged, because a picker can open over a form.
 */
export function leafStanding(): boolean {
  return leaves > 0;
}

export function enterLeaf(): void { leaves += 1; }
export function leaveLeaf(): void { leaves = Math.max(0, leaves - 1); }

/** Place the page on `line`, holding until the document can hold it and for a
 *  beat after it does. Returns the cancel, for a caller that goes away
 *  first. */
export function placeScroll(line: number): () => void {
  stop();
  holding = line;

  let observer: ResizeObserver | null = null;
  let timer = 0;

  /**
   * Put the page on its line, whenever it is not there and the document is
   * tall enough to hold it.
   *
   * This is both halves of the job. Called on the document growing, it is the
   * wait: a screen arriving at last tall enough for the line it owes. Called
   * on a scroll, it is the hold: something moved the page and left no sign of
   * a reader on it.
   */
  const hold = () => {
    if (document.documentElement.scrollHeight - window.innerHeight < line) return;
    // A tolerance rather than equality: a phone's scroll offset is a fraction
    // of a device pixel, so a browser answers a whole-number ask with the
    // nearest offset it has — which `!==` reads as a miss and would rewrite
    // on every scroll event for as long as the placement lasted.
    if (Math.abs(window.scrollY - line) > 1) window.scrollTo(0, line);
  };

  const release = () => {
    holding = null;
    stop = () => {};
    // The REACH_MS timer can outlive the window that scheduled it — a test
    // environment torn down mid-placement is the case that showed it, where
    // the callback landed on a `window` that no longer existed and took the
    // whole run down with an unhandled ReferenceError. Nothing is left to
    // detach when there is no window to detach it from.
    if (typeof window === 'undefined') return;
    clearTimeout(timer);
    observer?.disconnect();
    window.removeEventListener('scroll', hold);
    window.removeEventListener('wheel', release);
    window.removeEventListener('touchstart', release);
    window.removeEventListener('pointerdown', release);
    window.removeEventListener('keydown', release);
  };

  // The reader always wins. A flick, a wheel, a key or a pointer inside the
  // placement is them taking the page over, and a line asserted after that
  // would be a scroll nobody asked for — the one thing worse than the wrong
  // starting line.
  window.addEventListener('wheel', release, { passive: true });
  window.addEventListener('touchstart', release, { passive: true });
  window.addEventListener('pointerdown', release, { passive: true });
  window.addEventListener('keydown', release);
  // Everything else that moves the page arrives here with no reader behind
  // it, so the line stands.
  window.addEventListener('scroll', hold, { passive: true });
  observer = typeof ResizeObserver === 'function' ? new ResizeObserver(hold) : null;
  observer?.observe(document.documentElement);
  // A screen that never arrives must not hold the page for ever, with the
  // reader's own scrolls going unrecorded behind it.
  timer = window.setTimeout(release, REACH_MS);
  stop = release;

  window.scrollTo(0, line);
  return release;
}
