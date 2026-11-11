import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
// Lives under scripts/ because eighteen of its nineteen callers are the
// `verify-*` harnesses; the journeys are the one that reaches across.
import { settleAfterShot } from '../../scripts/browser-settle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function screenshotPathFor(slug) {
  return path.resolve(flagValue('--shot', path.join(os.tmpdir(), `infinite-agents-${slug}.png`)));
}

/**
 * Where a scenario's step pictures go: `--shots DIR`, else
 * `simulations/shots/<scenario>/` (git-ignored). Every `shoot()` call writes
 * the same moment twice, at a desktop width and at a phone width, and the
 * folder ends with an `index.json` naming each one, so the pictures can be
 * gathered for marketing without rerunning anything.
 */
export function shotsDirFor(slug) {
  return path.resolve(flagValue('--shots', path.join(repoRoot, 'simulations', 'shots', slug)));
}

/** The two widths every step is pictured at. Both at 2x, so the pictures
 *  are sharp on a phone screen and in a deck without re-shooting. */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 900, deviceScaleFactor: 2 },
  // Width only: asking Chrome for `isMobile`/`hasTouch` RELOADS the page,
  // which would throw away every transient panel a step had just opened.
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
};

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (existsSync(cacheRoot)) {
    for (const build of readdirSync(cacheRoot).sort().reverse()) {
      candidates.push(path.join(cacheRoot, build, 'chrome-linux64', 'chrome'));
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Chrome is required. Install it with: npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer',
  );
}

/**
 * Ten seconds is the budget for a screen that is already running to draw the
 * next thing, and it is enough for all but one shape: the FIRST screen after a
 * cold sign-in, where the bundle is still parsing while the screen's own reads
 * queue behind it. Pass a longer `timeout` there — CI runs four checks at a
 * time, and under that contention a cold first screen has taken past ten
 * seconds (main went red on exactly that, 2026-09-20). Everywhere else, leave
 * it: a wait that is generous by default turns a broken screen into a slow
 * suite rather than a fast failure.
 */
export async function waitVisible(page, selector, { timeout = 10_000 } = {}) {
  await page.waitForFunction((candidate) => {
    const node = document.querySelector(candidate);
    if (!node || node.hidden) return false;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  }, { timeout }, selector);
}

export const normalizedText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/**
 * The public front door's headline, in ONE place.
 *
 * Every scenario that walks in through the front door asserts it, and the
 * words themselves live in `src/pages/Home.tsx` (held by
 * `src/pages/Home.test.tsx`) since note #774 (2026-10-18): `/` opens on the
 * apps people built here, and the pitch with "Give Claude Code a team…"
 * moved, unchanged, to /product. They were copied into two harnesses, and when
 * the headline changed only one copy was updated — `onboarding.mjs` then died
 * on line 32 for days, which nothing anywhere reported, because these
 * harnesses are not in CI's browser lane. One copy is one thing to update.
 */
export const LANDING_HEADLINE = /The self-hosted, open-source workplace for Claude Code, Codex and OpenCode agents\./;
/** The shell draws only the panel that is showing, where the old page kept the
 *  others hidden in the document; "not showing" is either. */
export const hiddenOrAbsent = (page, selector) => page.$eval(selector, (node) => node.hidden).catch(() => true);
export const textOf = (page, selector) => page.$eval(selector, (node) => node.textContent);

/**
 * Wait until `selector` says `expected`, and return the text that SAID it.
 *
 * Reading the node again after the wait is a second, later look at a live
 * screen, and a screen that moves on can fail an assertion about a state it
 * really did reach. The join screen does exactly that: redeeming a link
 * rewrites the address with the new request id, which remounts the read, so
 * "Waiting for approval" flickers back to "Opening invitation" for as
 * long as that second read takes. On a fast machine the re-read lands before
 * the flicker; on a slow one it lands inside it. So the text comes back out
 * of the predicate itself, from the instant it was true.
 */
export async function waitForText(page, selector, expected) {
  const handle = await page.waitForFunction((candidate, wanted) => {
    const node = document.querySelector(candidate);
    if (!node || node.hidden) return false;
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    // A truthy return is what ends the wait, and it is also the value handed
    // back — so an element whose whole text is the empty string keeps waiting.
    return text.includes(wanted) ? text : false;
  }, { timeout: 10_000 }, selector, expected);
  return handle.jsonValue();
}

export async function clearAndType(page, selector, value) {
  await page.$eval(selector, (node) => {
    node.value = '';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type(selector, value);
}

export function matchingRequests(app, method, requestPath) {
  return app.requests.filter((request) => (
    request.method === method && request.path === requestPath
  ));
}

export function assertRequestCount(app, method, requestPath, count) {
  const matches = matchingRequests(app, method, requestPath);
  assert.equal(matches.length, count, `${method} ${requestPath} was called ${matches.length} times`);
  return matches;
}

/**
 * Signing in lands on Home, the Chief of Staff's conversation. The agents
 * this reads are in the agents picker by the message box (note #715 and the
 * owner's follow-up): one list of every agent in the workplace, and for a
 * workplace with none, the card that says how to start one. The address
 * stays Home's throughout.
 *
 * The picker's tabs were the workplace's ROOMS, and this walked into the
 * first one and read its name, until rooms left the product (note #843).
 */
export async function readWorkspaceHome(page) {
  await waitVisible(page, '#screenHome');
  await waitVisible(page, '#agentChatSwitch');
  // A reload stands the Workplace window that was open up again (it is the
  // entry's state): close it before the stack it covers is tapped.
  if (await page.$('#homeSheetClose')) {
    await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 10_000 });
  }
  // The agents picker too, pages and all (note #722): put away, so the
  // stack it covers can be tapped.
  if (await page.$('#agentSwitchSheet')) {
    await page.click((await page.$('#windowClose')) ? '#windowClose' : '#agentSwitchClose');
    await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  }
  await page.click('#agentChatSwitch');
  await waitVisible(page, '#agentSwitchSheet #agentSwitchGrid');
  await page.waitForFunction(() => {
    const button = document.querySelector('#agentSwitchGrid #newAgentBtn');
    return button && !button.disabled && !button.hidden;
  }, { timeout: 10_000 });
  return page.evaluate(() => ({
    pathname: location.pathname,
    organizationControl: document.querySelector('#homeOrganizations')?.getAttribute('aria-label'),
    agentsEmpty: document.querySelector('#agentSwitchEmpty')?.textContent,
    newAgent: document.querySelector('#newAgentLabel')?.textContent,
  }));
}

/** The fixture's Home, as `readWorkspaceHome` read it: a workplace with no
 *  agent yet. It also took the fixture, for the room name a tab had to
 *  carry, until rooms left the product (note #843). */
export function assertFixtureWorkspaceHome(view) {
  // Home's address: the windows have none of their own (note #715).
  assert.equal(view.pathname, '/');
  // Note #420 retired the identity header: Home proves it is inside a
  // workplace with the switch at the far edge of its header.
  assert.equal(view.organizationControl, 'Switch workplace');
  assert.match(normalizedText(view.agentsEmpty), /Start with an agent/);
  assert.match(
    normalizedText(view.agentsEmpty),
    /Agents are teammates you can message with work\./,
  );
  assert.equal(normalizedText(view.newAgent), 'New agent');
}

function assertIsolated(app, telemetry) {
  assert.deepEqual(app.faults, []);
  assert.deepEqual(telemetry.unexpectedExternal, []);
  assert.deepEqual(telemetry.pageErrors, []);
  assert.deepEqual(telemetry.webSockets, []);
}

/** Blocks every origin but the fixture's, and records what a page did wrong. */
async function preparePage(page, app, telemetry) {
  await page.setViewport(VIEWPORTS.desktop);
  page.setDefaultTimeout(10_000);
  // Pictures are taken between steps; a transition caught halfway is a
  // different picture every run, so the app is asked to skip its motion.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (error) => telemetry.pageErrors.push(error.message));
  page.on('websocketcreated', (socket) => telemetry.webSockets.push(socket.url()));

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void (async () => {
      const url = new URL(request.url());
      if (url.origin === app.origin || url.protocol === 'data:' || url.protocol === 'blob:') {
        await request.continue();
        return;
      }
      telemetry.unexpectedExternal.push(`${request.method()} ${url.href}`);
      await request.abort('blockedbyclient');
    })().catch((error) => {
      telemetry.unexpectedExternal.push(`interception failed for ${request.url()}: ${error.message}`);
      if (!request.isInterceptResolutionHandled()) void request.abort('failed');
    });
  });
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every picture on the page has actually arrived.
 *
 * A face that fails to load is the one defect a screenshot cannot survive and
 * an assertion on text would never catch: the app quietly swaps a broken
 * `<img>` for its grey fallback glyph, which reads as a missing feature. So
 * the check runs before every capture rather than at the end — a picture is
 * only taken of a screen whose images are all real.
 */
async function assertPicturesLoaded(page, moment, fullPage) {
  // A long page defers its images until they are scrolled near (`loading=
  // "lazy"`), and a full-page capture would then photograph the empty frames
  // it never scrolled to. Sweep the page first, put it back, and only then
  // wait — the sweep is also what makes the lazy images real for the picture.
  if (fullPage) {
    await page.evaluate(async () => {
      const held = window.scrollY;
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      window.scrollTo(0, held);
    });
  }
  // What has to be loaded is what the picture will CONTAIN: a full-page
  // capture holds the whole document, a plain one holds the viewport. An
  // image the reader would have to scroll to is not in the frame, and a page
  // that legitimately defers it (`loading="lazy"`) is not broken.
  const framed = `[...document.images].filter((image) => {
    if (all) return true;
    const box = image.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
  })`;
  await page.waitForFunction(
    new Function('all', `return ${framed}.every((image) => image.complete)`),
    { timeout: 15_000 }, fullPage,
  ).catch(() => { /* the assertion below names what is still missing */ });
  const broken = await page.evaluate(
    new Function('all', `return ${framed}
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.getAttribute('src') || '(no src)')`),
    fullPage,
  );
  assert.deepEqual(broken, [], `pictures did not load before "${moment}"`);
}

/**
 * One named moment, pictured at both widths. `fullPage` captures the whole
 * scroll height (a long Home); the default is the screen as a person sees it.
 * The scroll position is put back afterwards, so a step that pictures the
 * middle of a page does not move the journey.
 */
function makeShooter({ page, dir, slug, manifest }) {
  let sequence = 0;
  return async function shoot(name, { fullPage = false, page: target = page, banner = false } = {}) {
    sequence += 1;
    // The toast lives five seconds and floats over the composer, so a picture
    // taken straight after an action photographs the app wearing a message
    // that has nothing to do with what the picture is of. Wait it out —
    // unless the toast IS the moment, which is what `banner` says.
    if (!banner) {
      await target.waitForFunction(() => !document.querySelector('#banner'), { timeout: 8_000 })
        .catch(() => { /* a banner that outlives the wait is in the picture; the step still holds */ });
    }
    await assertPicturesLoaded(target, name, fullPage);
    const stem = `${String(sequence).padStart(2, '0')}-${name}`;
    const scrollY = await target.evaluate(() => window.scrollY);
    const files = {};
    for (const [width, viewport] of Object.entries(VIEWPORTS)) {
      await target.setViewport(viewport);
      // A viewport change re-lays the page; give fonts and the scroller a beat.
      await settle(250);
      await target.evaluate((y) => window.scrollTo(0, y), scrollY);
      const file = path.join(dir, `${stem}.${width}.png`);
      mkdirSync(dir, { recursive: true });
      await target.screenshot({ path: file, fullPage });
      files[width] = path.basename(file);
    }
    await target.setViewport(VIEWPORTS.desktop);
    await settle(100);
    await target.evaluate((y) => window.scrollTo(0, y), scrollY);
    // And do not hand the journey back a page that is still moving. Picturing
    // a moment changes the viewport three times and scrolls it back, and the
    // step after a picture is very often a tap: the shell answers all of that
    // with a re-render and `place-scroll`'s own scroll correction, which lands
    // between the tap's aim and its press and makes it miss (note #538 —
    // `scripts/browser-settle.mjs` has the measurements). The two fixed sleeps
    // above are a quiet machine's luck; this one waits for the page itself.
    await settleAfterShot(target);
    manifest.push({ step: sequence, name, scenario: slug, fullPage, files });
    return files;
  };
}

/** Launches Chrome with the same isolation and failure diagnostics for every scenario. */
/**
 * Refuse to photograph the shell on a machine that would draw it in the wrong
 * typeface. The Workspace asks for the system sans-serif; a fresh VM often has
 * no sans font at all, and Chrome then falls back to whatever fontconfig can
 * find — on 2026-09-07 that was a monospace face, and every one of the 39
 * marketing crops came back in it, looking like a terminal. The captures are
 * the product's public face, so this fails loudly before the first picture
 * rather than quietly after the last.
 */
function assertSansFont() {
  let family = '';
  try {
    family = execFileSync('fc-match', ['-f', '%{family}', 'sans-serif'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('fontconfig is missing (fc-match not found); install fonts first: sudo apt-get install -y fontconfig fonts-liberation fonts-noto-core');
  }
  if (!family || /mono|courier|dejavu sans mono/i.test(family)) {
    throw new Error(`sans-serif resolves to "${family || 'nothing'}" on this machine, so captures would render in the wrong typeface; install a sans font first: sudo apt-get install -y fonts-liberation fonts-noto-core`);
  }
  return family;
}

export async function runBrowserScenario({ app, screenshotPath, shotsDir, slug = 'scenario', run }) {
  let browser;
  let page;
  const telemetry = {
    pageErrors: [],
    unexpectedExternal: [],
    webSockets: [],
  };
  const manifest = [];
  const dir = shotsDir || shotsDirFor(slug);

  try {
    const sansFamily = assertSansFont();
    console.log(`sans-serif renders as ${sansFamily}`);
    browser = await puppeteer.launch({
      executablePath: chromeExecutable(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      // A full-page capture of the landing page is 2560x35624 device pixels,
      // and rasterising it takes ~110 s on a one-core machine — close enough
      // to Puppeteer's 180 s default that a busy host turns a healthy run
      // into a `Page.captureScreenshot timed out` with no failing assertion
      // to explain it. The screenshots are the point of these runs, so give
      // the slowest of them room rather than trimming what is pictured.
      protocolTimeout: 600_000,
    });
    await browser.defaultBrowserContext().overridePermissions(app.origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    page = await browser.newPage();
    await preparePage(page, app, telemetry);

    /** A second person in a second browser: its own cookies, same fixture. */
    const newPersona = async () => {
      const context = await browser.createBrowserContext();
      await context.overridePermissions(app.origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
      const other = await context.newPage();
      await preparePage(other, app, telemetry);
      return other;
    };

    const shoot = makeShooter({ page, dir, slug, manifest });
    await run({ page, telemetry, shoot, newPersona });
    assertIsolated(app, telemetry);
    mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    if (manifest.length) {
      writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`${manifest.length} moments pictured at two widths in ${dir}`);
    }
    return { telemetry, manifest };
  } catch (error) {
    for (const message of app.faults) console.error(`Fixture fault: ${message}`);
    for (const message of telemetry.unexpectedExternal) console.error(`Unexpected network: ${message}`);
    for (const message of telemetry.pageErrors) console.error(`Page error: ${message}`);
    if (page) {
      const failurePath = screenshotPath.replace(/(\.[^.]+)?$/, '.failure$1');
      mkdirSync(path.dirname(failurePath), { recursive: true });
      await page.setViewport(VIEWPORTS.desktop).catch(() => {});
      await page.screenshot({ path: failurePath }).catch(() => {});
      console.error(`Failure screenshot: ${failurePath}`);
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await app.close();
  }
}
