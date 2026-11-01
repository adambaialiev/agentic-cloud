// Drives WHERE THE REACT WORKSPACE PUTS THE PAGE, in real Chrome against a
// real backend router: the line a screen opens on, the line a Back owes the
// reader, and the line a transient leaf must not inherit from the screen it
// covers. This is note #280's own harness — "why is a detail page's scroll
// position not at the top? it's slightly lower" — and jsdom can say nothing
// about any of it, because every number here comes out of a real layout and
// a real browser's clamp.
// The account here is a personal one, with no workplace: its Home (`/`) is
// still the one-column overview (`#screenOverview`), where a workplace's Home
// is the Chief of Staff's conversation with windows over it (note #715).
// Screenshots land in ~/mini-preview/n280-scroll-*.png.
//
// The  screens are placed by this same machinery and are checked
// in scripts/verify-workspace-react-org.mts, where their fixture lives — note
// #314 reported the spend screen opening on the line the last screen was on.
// Worth knowing why that check had to wait for a skeleton: while the screen
// was one short "Loading…" box its document could not hold any offset at all,
// so the browser clamped it to zero for free and "it opens at its top" was
// true by accident. A wait with a shape is what makes the placement below
// load-bearing there.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-scroll.mts
//   … --shell <dir>   run against a different built shell (production's own)
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

/** Whichever Chrome this machine actually has: the cache directory is named
 *  for the build, and pinning one version here is how a harness stops working
 *  after the next upgrade. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const PORT = Number(process.env.PORT || 4179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const shellArg = process.argv.indexOf('--shell');
const SHELL_DIR = shellArg > 0 ? process.argv[shellArg + 1]! : path.join(REPO, 'backend/dist/workspace-ui');
/**
 * A phone with its KEYBOARD UP, which is the window the composer is actually
 * read in and the only one it is tall enough to scroll in. At the full 860 a
 * leaf fits whole, the browser's clamp lands on zero by luck, and note #280's
 * own bug is invisible — which is exactly how it survived this long.
 *
 * 360, not the 420 this stood at until the type scale landed (`6866ac65`).
 * That rewrite took ~36px out of the composer — metadata went 10px to 12px
 * but leading went 1.45-1.6 to 1.27-1.35, and the form came out shorter —
 * so at 420 the composer measured a `reach` of exactly 0: it fitted the
 * window whole, `leaf.y === 0` went true by the clamp rather than by the
 * placement, and the guard below said so. It had 8px of room before, which
 * was never a margin, only luck that had not run out yet.
 *
 * At 360 it has 24 — it was 32 until the corner-and-padding scale (#778)
 * landed and took another 8. That direction is the point: two design
 * changes in one day each shortened this form, and neither could have
 * known this guard existed. KEEP A REAL MARGIN HERE. If it fails again the
 * composer has shrunk again — lower this number, do not delete the guard.
 */
const VIEW = { width: 420, height: 360 };

const userStorage = new InMemoryUserStorage();
// Signing up has needed a confirmed address since 2026-09-11. This is the
// harness's own mailbox: it keeps the link the router mints so the browser
// can follow it, exactly as a person follows the one in their mail.
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const quickNoteStorage = new InMemoryQuickNoteStorage();
const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: SHELL_DIR,
  workspaceUiDefault: 'react',
  quickNoteStorage,
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
/** A read over a phone's network, so every screen below is measured while it
 *  is still the skeleton it mounts as — which is the state the whole file is
 *  about. */
let delayMs = Number(process.env.DELAY_MS || 0);
app.use('/api', (_req, _res, next) => {
  if (delayMs) setTimeout(next, delayMs); else next();
});
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page$ = await browser.newPage();
  await page$.setViewport({ ...VIEW, deviceScaleFactor: 2 });
  page$.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = (name: string) => page$.screenshot({
    path: path.join(OUT, `n280-scroll-${name}.png`) as `${string}.png`,
  });
  /** Where the page is, and how far it COULD go — a landing line means
   *  nothing without the reach it was clamped by. */
  const where = () => page$.evaluate(() => ({
    y: Math.round(window.scrollY),
    reach: Math.round(document.documentElement.scrollHeight - window.innerHeight),
  }));
  const settle = (ms = 600) => new Promise((resolve) => { setTimeout(resolve, ms); });
  /**
   * The reader's own hand on the page.
   *
   * The flick comes first, because that is the order a browser reports it in
   * and, since note #405, it is how the shell tells a reader's scroll from a
   * scroll nobody asked for: a screen holds its line for the beat after it
   * lands, and gives it up the instant a reader asks for the page. A bare
   * `window.scrollTo` here would be modelling something a reader cannot do —
   * move the page while leaving no sign that they touched it — which is
   * exactly the shape of the bug this shell now defends against.
   */
  const readerScrolls = (to: number) => page$.evaluate((y: number) => {
    window.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    window.scrollTo(0, y);
  }, to);
  /** A tap that does not move the page first. Puppeteer's own `click` scrolls
   *  its target into view, which on this harness would be the mouse writing
   *  the very number under test. */
  const tap = (selector: string) => page$.evaluate((one) => {
    (document.querySelector(one) as HTMLElement).click();
  }, selector);

  // 1. An account, and a list long enough to have a middle.
  await harnessSignedIn(page$, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page$.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenOverview #agentsSection', { timeout: 10_000 });

  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (html: string) => quickNoteStorage.create({
    userId: me.userId, html,
    createdByAgentId: 'user', createdByUserId: me.userId,
    updatedByAgentId: 'user', updatedByUserId: me.userId,
  } as never);
  // One note long enough that its own screen scrolls: a landing line can only
  // be wrong on a screen with somewhere to be wrong.
  const long = Array.from({ length: 40 }, (_, n) =>
    `<p>Paragraph ${n + 1} of a note long enough that its own screen scrolls a good way down.</p>`).join('');
  await seed(`<p>The long one</p>${long}`);
  for (let n = 0; n < 30; n += 1) {
    await seed(`<p>Note number ${n + 1} — a line of words long enough to wrap on a phone and take two rows in the list.</p>`);
  }

  // 2. The app owns the scroll. With the browser's own `'auto'` there are two
  //    authorities on one number and the browser writes last, after this shell
  //    has already placed the screen (note #280).
  await page$.goto(`${ORIGIN}/notes`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  check('the shell takes scroll restoration off the browser',
    (await page$.evaluate(() => history.scrollRestoration)) === 'manual',
    await page$.evaluate(() => history.scrollRestoration));

  // 3. A screen opened for the first time opens at its top, however far down
  //    the reader was on the one they came from.
  await readerScrolls(600);
  await settle(250);
  const list = await where();
  check('the list is where the reader left it', list.y === 600, JSON.stringify(list));
  const href = await page$.$$eval('#notesList a.crow[href]', (nodes) =>
    (nodes.find((node) => (node.textContent ?? '').includes('The long one')) as HTMLAnchorElement)
      .getAttribute('href')!);
  await tap(`#notesList a.crow[href="${href}"]`);
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  await settle();
  const opened = await where();
  check('a note opened from far down the list opens at its own top',
    opened.y === 0 && opened.reach > 0, JSON.stringify(opened));
  await shot('opened');

  // 4. The line the reader was on comes back — and it has to survive the
  //    screen arriving in two pieces, because a `scrollTo` into a document
  //    still the height of its skeleton is clamped and nothing asks again.
  await tap('#pageBack');
  await page$.waitForSelector('#screenNotes', { timeout: 10_000 });
  await settle();
  const back = await where();
  check('Back returns the reader to the line they were reading',
    back.y === 600, JSON.stringify(back));

  // 5. A LEAF — a picker, a form, the composer — has no address, so nothing in
  //    the router hears it open and `ScrollMemory` never runs. Before note
  //    #280 it simply inherited the offset of the screen it covered, clamped
  //    to its own height: the composer opened from here came up at its own
  //    BOTTOM, with its first words cut off under the header.
  await readerScrolls(1400);
  await settle(250);
  const deep = await where();
  check('the reader is a long way down the list', deep.y === 1400, JSON.stringify(deep));
  await tap('#notesAddBtn');
  await page$.waitForSelector('#noteText', { timeout: 10_000 });
  await settle();
  const leaf = await where();
  check('the composer opens at its own top, not at the line underneath it',
    leaf.y === 0, JSON.stringify(leaf));
  check('…and it was a screen with somewhere else it could have opened',
    leaf.reach > 0, JSON.stringify(leaf));
  await shot('leaf');

  // 6. Closing one gives the line back: what covered a screen owes it the
  //    place the reader was reading.
  await tap('#pageBack');
  await page$.waitForSelector('#notesList .crow', { timeout: 10_000 });
  await settle();
  const returned = await where();
  check('closing the composer hands the list back the line it was on',
    returned.y === 1400, JSON.stringify(returned));

  // 7. A leaf that ends in a NAVIGATION hands the line to nobody: the note it
  //    just made is a new entry, and a new entry opens at its top (note #290).
  await readerScrolls(1400);
  await settle(250);
  await tap('#notesAddBtn');
  await page$.waitForSelector('#noteText', { timeout: 10_000 });
  await page$.type('#noteText', 'A note written from far down the list.');
  await tap('#saveNoteBtn');
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  await settle(900);
  const made = await where();
  check('the note just created opens at its own top', made.y === 0, JSON.stringify(made));
  await shot('created');

  // 8. THE LINE IS HELD, NOT JUST REACHED (note #405). Every check above
  //    reads the page once, after it has settled — which is exactly how a
  //    landing that is right on arrival and wrong a beat later survived five
  //    reports. What the reader sees is the page AFTER whatever moved it
  //    next: a focus without `preventScroll`, a screen's own `scrollTo` a
  //    layout phase later, an iOS fling still gliding, a phone's address bar
  //    or a mini app's sheet resizing the window under a screen that is
  //    still arriving. None of those can be dispatched here — but every one
  //    of them is a scroll that arrives with no sign of a reader on it, and
  //    that is exactly what a bare `window.scrollTo` is.
  //
  //    The nudge is deliberately small. "Slightly lower" is the whole
  //    report, and a 70px drift is the shape of it.
  // Check 7 left the reader on the note it had just written; the list is
  // where the doors are.
  await page$.goto(`${ORIGIN}/notes`, { waitUntil: 'networkidle0' });
  await page$.waitForSelector('#screenNotes #notesList .crow', { timeout: 10_000 });
  await settle();
  const nudge = async (after: number) => {
    await settle(after);
    await page$.evaluate(() => window.scrollTo(0, 70));
    await settle(500);
    return where();
  };
  for (const after of [80, 700, 2000]) {
    await readerScrolls(600);
    await settle(250);
    await tap(`#notesList a.crow[href="${href}"]`);
    await page$.waitForSelector('#screenNote', { timeout: 10_000 });
    const held = await nudge(after);
    check(`a screen keeps its top against a scroll nobody asked for, ${after}ms after landing`,
      held.y === 0, JSON.stringify(held));
    await tap('#pageBack');
    await page$.waitForSelector('#screenNotes', { timeout: 10_000 });
    await settle();
  }
  await shot('held');

  // …AND A SCREEN STILL ARRIVING KEEPS ITS TOP. A read over a phone's network
  // is still out a second and a half in, and that is exactly when it lands
  // and moves the page — the placement has to still be in force there or it
  // lets go precisely when it is needed. The read below takes 1.5s.
  delayMs = 1500;
  await readerScrolls(600);
  await settle(250);
  await tap(`#notesList a.crow[href="${href}"]`);
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  const late = await nudge(1600);
  check('a screen still arriving keeps its top 1.6s in, while its read lands',
    late.y === 0, JSON.stringify(late));
  delayMs = 0;
  await tap('#pageBack');
  await page$.waitForSelector('#screenNotes', { timeout: 10_000 });
  await settle();

  // 9. …AND THE READER STILL WINS. A hold that outlived the hand moving the
  //    page would be the worse bug of the two: the reader flicks, the shell
  //    pulls it back, and the screen is stuck. Their own flick ends it.
  await readerScrolls(600);
  await settle(250);
  await tap(`#notesList a.crow[href="${href}"]`);
  await page$.waitForSelector('#screenNote', { timeout: 10_000 });
  await settle(80);
  await page$.evaluate(() => {
    window.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    window.scrollTo(0, 240);
  });
  await settle(500);
  const reader = await where();
  check('…and the reader who takes the page over keeps it', reader.y === 240, JSON.stringify(reader));
  await tap('#pageBack');
  await page$.waitForSelector('#screenNotes', { timeout: 10_000 });
  await settle();
  const gaveBack = await where();
  check('…and Back still hands the list the line it was on', gaveBack.y === 600, JSON.stringify(gaveBack));

  // 10. THE PAGE IS AS TALL AS THE WINDOW THE READER CAN SEE (note #398).
  //    A shell frame sized in `vh` is sized in the LARGE viewport — a phone
  //    browser's height with its address bar retracted — so with the bar
  //    showing, every screen whose content fits still had 50-90px of empty
  //    band to scroll through, and a swipe left it sitting slightly below its
  //    top. Headless Chrome has no retracting bar, so `vh` and `dvh` measure
  //    the same here and no landing line above can see the difference: what
  //    is checkable in a browser is the unit the shell actually asks for.
  const frame = await page$.evaluate(() => {
    // A stack rather than a recursive helper: a named inner function inside
    // an evaluated page needs esbuild's `__name` shim, which is not there.
    const wanted = ['.web-mode', '.web-mode #webFrame'];
    const found: Record<string, string> = {};
    const stack: CSSRuleList[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try { stack.push(sheet.cssRules); } catch { /* another origin's sheet */ }
    }
    while (stack.length) {
      const rules = stack.pop()!;
      for (const rule of Array.from(rules)) {
        const grouping = rule as CSSRule & { cssRules?: CSSRuleList };
        if (grouping.cssRules) stack.push(grouping.cssRules);
        const styleRule = rule as CSSStyleRule;
        if (!styleRule.selectorText || !wanted.includes(styleRule.selectorText)) continue;
        const value = styleRule.style.getPropertyValue('min-height');
        if (value) found[styleRule.selectorText] = value;
      }
    }
    return found;
  });
  for (const selector of ['.web-mode', '.web-mode #webFrame']) {
    check(`${selector} is as tall as the visible window, not the retracted one`,
      frame[selector] === '100dvh', `min-height: ${frame[selector] ?? '(none)'}`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
