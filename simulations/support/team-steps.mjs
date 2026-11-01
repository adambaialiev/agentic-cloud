/**
 * The steps every lived-in-Workspace scenario shares: signing a fixture
 * person in through the real form, addressing a workplace's screen, and
 * tapping the rows and buttons the shell draws as `div[role=button]` rather
 * than `<button>`.
 */
import assert from 'node:assert/strict';
import { normalizedText, waitVisible } from './browser-simulation.mjs';

/**
 * Open the gate on the authenticator login.
 *
 * The door opens on the EMAIL panel since note #467, and every fixture person
 * is an authenticator account — so a scenario that lands on `/` and
 * waits for `#authLoginPanel` waits forever. `signIn` learned that once and
 * kept it to itself; `recovery-access` and `returning-signin` start at the
 * same door without it and died there, which is why this is one exported step
 * rather than three copies.
 *
 * Note #562 took the row that used to offer it off the door, so this STEP IS
 * THE NAVIGATION now: the panel is reached by asking for it,
 * `/#authenticator`, and the gate reads that fragment when the app
 * BOOTS. Hence one goto and not a goto plus a fragment — a same-document
 * fragment change re-runs nothing, and a reload after it would cost every
 * scenario an extra document boot (which `recovery-access` counts).
 */
export async function openAuthenticatorLogin(page, app) {
  await page.goto(`${app.origin}/login#authenticator`, { waitUntil: 'domcontentloaded' });
  await waitVisible(page, '#authLoginPanel');
}

/**
 * Sign in as one of the fixture's people through the real sign-in form.
 *
 * Signing in lands on Home, the Chief of Staff's conversation (`#screenHome`;
 * the Workspace Agent, as a person sees it since note #715): its header
 * carries the name (the door to the Workplace window), the workplace switch
 * and the reader's picture, and the stack of faces by the message box opens
 * the agents picker. `openAgents` and `openWorkplace` take those taps.
 */
export async function signIn(page, app, { username, totpCode }) {
  await openAuthenticatorLogin(page, app);
  await page.type('#authUsername', username);
  await page.type('#authCode', totpCode);
  await page.click('#authLoginButton');
  await waitVisible(page, '#screenHome');
  await waitVisible(page, '#homeOrganizations');
}

/**
 * The agents picker (note #713), reached the way a reader reaches it: the
 * stack of faces by the message box. One list of every agent in the
 * workplace (`#agentSwitchGrid`, a card per agent), with the reader's unread
 * replies and the decisions waiting on them over it. A picker already up
 * stays as it is. The wait for `New agent` — the door at the end of the grid
 * — is what proves the picker has its state, not just its frame.
 *
 * It walked one level further, into the first ROOM tab, while the picker's
 * tabs were rooms and a room's view held the agents and notes shelves —
 * until rooms left the product (note #843).
 */
export async function openAgents(page) {
  if (!(await page.$('#agentSwitchSheet'))) {
    await waitVisible(page, '#agentChatSwitch');
    if (await page.$('#homeSheet')) await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 10_000 });
    await page.click('#agentChatSwitch');
  }
  await waitVisible(page, '#agentSwitchSheet #agentSwitchGrid');
  await page.waitForFunction(() => {
    const button = document.querySelector('#agentSwitchGrid #newAgentBtn');
    return button && !button.disabled && !button.hidden;
  }, { timeout: 10_000 });
}

/** Home's Workplace window (note #715): the Chief of Staff's name in Home's
 *  header opens it. */
export async function openWorkplace(page) {
  if (await page.$('#homeSheet #homeWorkplace')) return;
  await waitVisible(page, '#homeWorkplaceDoor');
  if (await page.$('#agentSwitchSheet')) {
    await page.click('#agentSwitchClose');
    await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  }
  await page.click('#homeWorkplaceDoor');
  await waitVisible(page, '#homeSheet #homeWorkplace');
}

/**
 * A screen's address with the workplace the router expects. It named a room
 * too (`&room=`) for the screens that were a room's — notes, secrets — until
 * rooms left the product (note #843): no route reads one any more, so every
 * address is the workplace's alone.
 */
export function addressOf(app, screenPath) {
  const params = new URLSearchParams({ org: app.fixture.organization.id });
  return `${app.origin}${screenPath}?${params}`;
}

/** Open a screen by address and wait for its root to be drawn. */
export async function open(page, app, screenPath, rootSelector) {
  await page.goto(addressOf(app, screenPath), { waitUntil: 'domcontentloaded' });
  await waitVisible(page, rootSelector);
}

/** Tap the row or button inside `scope` whose visible text says `text`. */
export async function tapByText(page, scope, text, selector = 'button, [role="button"]') {
  await page.waitForFunction((container, wanted, candidates) => {
    const root = document.querySelector(container);
    if (!root) return false;
    return [...root.querySelectorAll(candidates)].some((node) => (node.textContent || '').replace(/\s+/g, ' ').includes(wanted));
  }, { timeout: 10_000 }, scope, text, selector);
  const tapped = await page.evaluate((container, wanted, candidates) => {
    const root = document.querySelector(container);
    const node = [...root.querySelectorAll(candidates)].find((candidate) => (candidate.textContent || '').replace(/\s+/g, ' ').includes(wanted));
    if (!node) return false;
    node.click();
    return true;
  }, scope, text, selector);
  assert.ok(tapped, `nothing in ${scope} says "${text}"`);
}

/** The title every screen portals into its header: the persistent one, or
 *  — for a screen opened inside the agents picker, as a page of it (note
 *  #722) — the head of the page on top. */
export async function headerTitle(page) {
  const title = '#pageHead #pageId h1, #agentSwitchSheet .windowpage:not([hidden]) .windowhead h1';
  await waitVisible(page, title);
  return normalizedText(await page.$eval(title, (node) => node.textContent));
}

/**
 * The faces inside `selector` are pictures, not the fallback glyph.
 *
 * `AgentFace` and `PersonFace` both draw an `<img class="avatar">` when they
 * have a picture and an inline SVG glyph when they do not, so counting the
 * images is what separates "this agent has a face" from "this agent is a grey
 * circle" — which no assertion on text can tell apart.
 */
export async function assertFaces(page, selector, count, what = 'faces') {
  await page.waitForFunction((container, wanted) => {
    const images = [
      ...document.querySelectorAll(`${container} img.avatar, ${container} img.face, ${container} img.aface`),
    ];
    // The element arrives before its bytes do. Waiting only for the count made
    // a busy browser inspect the newest face between insertion and decode,
    // then call a healthy image broken (seen twice in CI on 2026-09-21).
    return images.length >= wanted && images.every((image) => image.complete && image.naturalWidth > 0);
  }, { timeout: 10_000 }, selector, count).catch(() => {});
  const found = await page.evaluate((container) => [
    ...document.querySelectorAll(`${container} img.avatar, ${container} img.face, ${container} img.aface`),
  ].map((image) => ({ src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0 })), selector);
  assert.equal(found.length, count, `${selector} draws ${found.length} ${what}, expected ${count}`);
  assert.deepEqual(found.filter((image) => !image.loaded), [], `${selector} has ${what} that did not load`);
  return found.map((image) => image.src);
}

/**
 * The workplace's people are a door in the account menu, not a deck on Home
 * (note #634): the reader's own picture in Home's header opens the menu, and
 * its People row opens the People page. `backHome` returns to Home — with
 * the window the reader left standing, if one was (note #715).
 */
export async function openPeople(page) {
  await waitVisible(page, '#homeAccount');
  await page.click('#homeAccount');
  await waitVisible(page, '#accountMenuPeople');
  await page.click('#accountMenuPeople');
  await waitVisible(page, '#screenPeople');
}
export async function backHome(page) {
  await page.goBack();
  await waitVisible(page, '#screenHome');
}

/** Wait until `selector`'s text includes every one of `parts`. The timeout is
 *  worth raising when what is being waited for is a POLL rather than a render:
 *  a screen that asks again every 15s cannot be proved by a 15s wait. */
export async function waitForAll(page, selector, parts, timeout = 15_000) {
  await page.waitForFunction((candidate, wanted) => {
    const node = document.querySelector(candidate);
    if (!node) return false;
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    return wanted.every((part) => text.includes(part));
  }, { timeout }, selector, parts);
}
