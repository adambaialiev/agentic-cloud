/**
 * What the browser and this app do to the page underneath a harness — a
 * screenshot that moves it, a scroll it puts back, and a PDF viewer that never
 * lets go of it — and the waits that make the next step safe.
 *
 * THE STORY IN NOTE #538 IS HALF RIGHT, and the wrong half matters. It says a
 * full-page screenshot "perturbs the emulated viewport" and that a click races
 * the restore. That WAS true: with `captureBeyondViewport: false` Puppeteer
 * resized the viewport to the whole scroll height and put it back afterwards.
 * Puppeteer 25 defaults that option to TRUE and applies the default BEFORE it
 * looks at `fullPage` (`api/Page.js`, `setDefaultScreenshotOptions`), so the
 * resizing branch never runs. Measured on the real Knowledge screen: 420x860
 * before the shot and 420x860 after it, the row at top 859 both times, the
 * same DOM node. Nothing is restored, because nothing moved.
 *
 * What DOES happen is smaller and sharper. The page is sent a `resize` EVENT
 * anyway, at unchanged dimensions — one per full-page shot, measured on a bare
 * page against all three screenshot modes. The Workspace listens: `place-scroll`
 * holds a ResizeObserver on every screen, and ChatScreen and VoiceReview listen
 * directly. So a shot lands a re-render, and possibly a scroll correction, in
 * the page at the exact moment the harness takes its next step.
 *
 * Puppeteer's click then resolves the node, scrolls it into view, computes a
 * clickable point, and dispatches at that point. A scroll correction arriving
 * between the last two shows up as either of the two failures seen here:
 *
 *   - "Node is either not clickable or not an Element" — the box was gone when
 *     the point was computed. This took both of CI's attempts on 2026-09-16.
 *   - a click that throws nothing and does nothing, because the row moved after
 *     the point was computed, so the press landed on empty space and the screen
 *     it should have opened never arrived. Reproduced here under load.
 *
 * Neither is cured by waiting for the element BEFORE the click: `visible` only
 * asks for a non-empty box, which a row sitting at the bottom edge of the
 * viewport has throughout. The wait belongs after the SHOT — one place per
 * harness instead of the seventy call sites where a picture is followed by a
 * tap, and it waits out the disturbance rather than the symptom.
 */

/**
 * Resolves once the page has stopped moving: two consecutive animation frames
 * with the same scroll position and document height.
 *
 * Two frames rather than one because the reaction is two-stage — listeners and
 * ResizeObserver callbacks run in the first frame, and whatever they schedule
 * (a React commit, a scroll correction) is committed by the second. Stability
 * is measured rather than assumed, because "wait 200ms" is the kind of fixed
 * sleep that passes on a quiet machine and loses on CI, which is the whole
 * failure being fixed here.
 *
 * It cannot hang: frames are throttled in a backgrounded tab and a page can
 * animate forever, so a ceiling resolves it regardless. Costs ~3 frames on a
 * page that is already still.
 */
export async function settleAfterShot(page, { timeout = 1_000 } = {}) {
  await page.evaluate((limit) => new Promise((resolve) => {
    let previous = '';
    let quiet = 0;
    const done = () => { resolve(); };
    const tick = () => {
      const now = `${window.scrollX},${window.scrollY},${document.documentElement.scrollHeight}`;
      quiet = now === previous ? quiet + 1 : 0;
      previous = now;
      if (quiet >= 2) { done(); return; }
      requestAnimationFrame(tick);
    };
    setTimeout(done, limit);
    requestAnimationFrame(tick);
  }), timeout);
}

/**
 * Tap something the page may still be settling UNDER — the other half of the
 * problem `settleAfterShot` solves, and a different half.
 *
 * That one waits out a disturbance the harness itself caused, at the one place
 * it is caused. This one is for the disturbance nobody caused: a screen drawn
 * from what the tab already knew, filling in underneath as its reads land. The
 * Workspace deliberately draws a folder's NAME, its trail and Drive's counts
 * before its contents arrive (`drive-cache.ts`), so a harness that waits for
 * the heading and then taps a row is tapping a list that may not be there yet
 * — and on a loaded machine, is not. Both of CI's 2026-09-17 failures on
 * `verify-workspace-drive` were this, one of each kind:
 *
 *   - "No element found for selector" — the row had not been drawn at all.
 *     `waitForSelector` below is the whole answer to that one.
 *   - "Node is either not clickable or not an Element" — the row existed and
 *     was moving. A read landing above it reflows the list between Puppeteer
 *     resolving the node and computing its clickable point.
 *
 * So: wait for the element, then wait for its own BOX to stop moving — two
 * consecutive frames at the same rect, measured on the element rather than on
 * the page, because a row can move while the page's height and scroll do not.
 * It cannot hang: a ceiling resolves the wait and lets the click try anyway,
 * which fails with Puppeteer's own message rather than a timeout of ours.
 *
 * It does NOT replace `settleAfterShot`, and must not be read as making it
 * unnecessary: a screenshot's resize event arrives on its own schedule, and a
 * scroll correction answering one can land after this check and before the
 * press. Wait out the shot where the shot is taken; use this where a tap
 * follows a read.
 */
export async function tap(page, selector, { timeout = 10_000, still = 1_000 } = {}) {
  const handle = await page.waitForSelector(selector, { visible: true, timeout });
  if (!handle) throw new Error(`tap: nothing matched ${selector}`);
  await wheelIntoView(page, handle);
  await handle.evaluate((element, limit) => new Promise((resolve) => {
    let previous = '';
    let quiet = 0;
    const done = () => { resolve(); };
    const tick = () => {
      const box = element.getBoundingClientRect();
      const now = `${box.x},${box.y},${box.width},${box.height}`;
      quiet = now === previous ? quiet + 1 : 0;
      previous = now;
      if (quiet >= 2) { done(); return; }
      requestAnimationFrame(tick);
    };
    setTimeout(done, limit);
    requestAnimationFrame(tick);
  }), still);
  await handle.click();
  return handle;
}

/**
 * Brings an element into view the way a PERSON does, with the wheel, because
 * this app undoes any other kind of scroll.
 *
 * The Workspace remembers where each screen was scrolled to and puts it back
 * (note #238). It treats a USER scroll as the new truth and a programmatic one
 * as noise: measured on Home at 420x860, `element.scrollIntoView()` moves the
 * window to y=361 and something puts it back to 0 within 80 ms — the same at
 * 600 ms after the screen settled, so this is not a race with startup — while
 * a `mouse.wheel` of 300 lands at 300 and is still there three seconds later.
 *
 * That is what breaks a tap on anything below the fold, and the Drive card on
 * Home is 27 px below it. `ElementHandle.click` scrolls the element into view,
 * computes a point, and presses — and the restore lands in between, so the
 * press goes to where the row WAS. Caught in the act: the card's own box at
 * y=887 while the press went to 210,556, onto an empty div. Nothing throws.
 * The screen simply does not open, and the harness fails later, somewhere else,
 * on a heading that never changed.
 *
 * Puppeteer's Locator API cannot be used here for the same reason: its
 * `ensureElementIsInTheViewport` scrolls, waits for the element to intersect,
 * and retries — against an app that undoes the scroll, it spins until its
 * timeout. Measured: every locator tap of `#driveCard a` failed at exactly
 * 10 s, and the same tap with that one condition switched off took 111 ms.
 */
async function wheelIntoView(page, handle) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const view = await handle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      // A box taller than the screen can never sit inside it, so what is asked
      // for is the room a press needs rather than the whole element.
      const height = Math.min(box.height, window.innerHeight);
      return {
        need: box.top >= 0 && box.top + height <= window.innerHeight
          ? 0 : Math.round(box.top - (window.innerHeight - height) / 2),
        width: window.innerWidth,
        height: window.innerHeight,
        at: Math.round(window.scrollY),
      };
    });
    if (!view.need) return;
    // The wheel needs a pointer over the page, and the middle of the viewport
    // is the one place that is always inside it.
    await page.mouse.move(Math.round(view.width / 2), Math.round(view.height / 2));
    await page.mouse.wheel({ deltaY: view.need });
    // A wheel is not applied by the time the call returns — measured at 0 px
    // immediately after and the full delta 100 ms later — so the box is read
    // again rather than trusting the number just sent.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    // A page that did not move is a page at its end: the element is as close to
    // the screen as scrolling can bring it, and `click` is left to do whatever
    // it did before this helper existed rather than spinning until the ceiling.
    if (await page.evaluate(() => Math.round(window.scrollY)) === view.at) return;
  }
}

/**
 * Takes Chrome's PDF viewer off the page, so the next navigation can finish.
 *
 * A `page.goto` after a PDF preview times out at 30 s while the page it
 * navigated to is loading perfectly well underneath it. Measured here on
 * `verify-workspace-drive`, which went red on main on 2026-09-17 and failed
 * two runs in six on a loaded workbench: the server logs the document request
 * for the new URL, answers it, and the new screen then makes its own API calls
 * and starts its five-second `agents/live` poll — all inside the thirty
 * seconds Puppeteer spends deciding the navigation never happened.
 *
 * What it is waiting for is the frame tree, not the document. An `<iframe>`
 * pointing at a PDF is three frames, not one:
 *
 *   http://…/drive/files/…        the page
 *   http://…/objects/…?disposition=inline   the iframe
 *   chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html
 *
 * The third is Chrome's own PDF viewer, and it holds its fetch of the document
 * open for as long as it is on the screen — the request gets its 200 and never
 * reaches `requestfinished`. Puppeteer's LifecycleWatcher wants the lifecycle
 * event in EVERY frame it knows about, so one frame that never finishes
 * loading holds the whole navigation open. `waitUntil: 'domcontentloaded'`
 * does not help; it was tried, and hung the same way.
 *
 * Whether it bites is a race: the viewer refetches the document a few hundred
 * milliseconds after the iframe appears, and a harness that navigates before
 * that lands gets away with it. A quiet machine usually does. A CI box with
 * four harnesses on four cores does not, which is why this is red there and
 * green here.
 *
 * So the cure is to take the viewer off the page rather than to wait longer.
 * Removing the iframe drops both child frames and cancels the pending fetch;
 * setting its `src` to `about:blank` also unblocks the navigation, but leaves
 * that fetch in flight forever, which would hang the next `networkidle0`.
 */
export async function closePdfViewer(page, frame) {
  await frame.evaluate((node) => { node.remove(); });
  // Measured as immediate — the detach lands before the evaluate returns — but
  // asserted rather than assumed, because the whole failure being fixed here is
  // a frame that outlived the moment a harness stopped thinking about it.
  const left = page.frames().filter((each) => each !== page.mainFrame()).map((each) => each.url());
  if (left.length) throw new Error(`PDF viewer still attached: ${left.join(', ')}`);
}
