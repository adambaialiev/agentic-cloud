// Note #727 — the Chief of Staff's chat on an iPhone keyboard. Builds on the
// harness of verify-workspace-agent-context.mts (note #444: real browser, authenticated Workspace routes and a persisted
// Workspace Agent context reading. Proves that one backend measurement draws
// the shared ring in the chat, then the shared meter and explicit reset ask
// on agent details. Home drew it too until note #656 hid the agent: Home is
// now checked for having no card, and the chat is opened on its address.
// Since 2026-10-10 Home IS that conversation (/). Since note #715 it is the
// Chief of Staff's; since the owner's follow-up (2026-10-11) its header
// wears the face in its context ring again, as the door to the Workplace
// window, and the reading stands on the agent's own cards at the foot of
// that window.
//
// Note #615: the same conversation, left through a note link in one of its
// replies and come Back to, stands on the line the reader left — from its
// very first frame, rather than empty and then at the newest message.
//
// Note #623: note receipts an older conversation stored are not drawn.
//
// Note #736: Send lets go of the box in the tap, as the room chat's does.
// The same journeys in Safari's engine: scripts/webkit-cos-chat-keyboard.mts.
//
//   npm --prefix backend run build
//   OUT_DIR=/tmp/cos-chat-keyboard backend/node_modules/.bin/tsx scripts/verify-cos-chat-keyboard.mts
//
// The keyboard is SIMULATED, as the room chat's own check does (4e there):
// Chrome has no on-screen keyboard. The simulation is the iPhone measured in
// note #351 — with the keys up `innerHeight` is the visible height, the
// layout height stays the whole screen, the phone scrolls the page to put the
// box on the keys, and Safari refuses the first scroll back on the closing
// frame. A grey block stands where the keys would be. The journey: focus the
// box, type, tap the conversation to put the keyboard away, keyboard goes.
// The same journey runs on a room chat for comparison.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'cos-chat-keyboard-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
const quickNoteStorage = new InMemoryQuickNoteStorage();
// The workplace this harness founds is one that is already set up: its
// cloud is connected and a subscription is signed in, so the Workspace
// opens instead of holding on the first-run setup steps.
harnessEstablishedWorkplace(orgStorage);
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
const deps = {
  userStorage,
  orgStorage,
  quickNoteStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  agentLifecycle: {
    // A send starts a turn that is still thinking when it is looked at.
    converseWorkspaceRecap: () => new Promise(() => {}),
    summarizeWorkspaceRecap: async () => ({ text: 'The Workspace Agent now carries its own context reading.\n\nIts ring and details agree on the same measured turn.\n\nStart a fresh chat when the ring reaches red.' }),
    // The version card a room agent's screen reads, answered for the
    // Workspace Agent too (owner, 2026-09-21): machine software behind, so
    // the update button stands under it.
    agentVersion: async () => ({
      cliLabel: 'Claude Code', installed: '2.1.276', pinned: '2.1.276', cliUpdateAvailable: false,
      image: { current: false, canUpdate: true }, busy: false, turnCount: 12,
      docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true },
    }),
  },
} as unknown as RouteDeps;
const app = express();
// A send is in flight for a beat, as over a phone's network (note #736):
// long enough for a box held read-only through it to be seen.
app.use((req, _res, next) => {
  if (req.method === 'POST' && req.path.endsWith('/api/recap/chat')) setTimeout(next, 1500);
  else next();
});
app.use(express.json());
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
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 500) consoleErrors.push(`${response.status()} ${response.url()}`); });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'context-owner@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Context studio' });

  const [owner] = await userStorage.getAllUsers();
  if (!owner) throw new Error('the browser setup created no owner');
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        theo: {
          id: 'theo', name: 'Theo', cli: 'codex', model: 'gpt-5.6-terra', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-theo.machine', connectedAt: at, createdAt: at,
          lastActivityAt: at, recap: { text: 'Added the context-usage path.', at },
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, {
    cli: 'claude', model: 'sonnet', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at,
    machineSize: { cpuKind: 'shared', cpus: 1, memoryMb: 2048 },
    contextUsage: { tokens: 940_000, model: 'claude-sonnet-5-20260320', at },
  });
  // A note, and a conversation long enough to scroll with a door to it in an
  // older reply: the owner's journey in note #615.
  const note = await quickNoteStorage.create({
    userId: org.orgId, html: '<h2>Call the printer</h2><p>Ask whether Tuesday still works.</p>',
    createdByAgentId: 'user', createdByUserId: owner.userId, updatedByAgentId: 'user', updatedByUserId: owner.userId,
  } as never);
  const noteHref = `/notes/${note.number}?org=${org.orgId}`;
  const messages = Array.from({ length: 24 }, (_, n) => [
    { id: `o${n}`, role: 'owner' as const, text: `Question ${n + 1}: what changed on the booking page?`, at },
    { id: `a${n}`, role: 'assistant' as const, at, text: n === 8
      ? `Still open: [#${note.number}](${noteHref}) — the printer call.`
      : `Answer ${n + 1}: the booking page picked up another small fix, and its checks are green again.` },
  ]).flat();
  // Note #623: the note receipts an older conversation stored under its last
  // request — a card per note verb — are no longer drawn; the reply is.
  const legacyReceipts = ['Created note', 'Updated note', 'Archived note'].map((verb, n) => ({
    id: `r${n}`, role: 'action' as const, text: `${verb}: Call the printer`, at, href: noteHref,
  }));
  messages.push(
    { id: 'o-last', role: 'owner' as const, text: 'Tidy up the printer note.', at },
    ...legacyReceipts,
    { id: 'a-last', role: 'assistant' as const, text: 'I tidied up the printer note and put it away.', at },
  );
  const shown = messages.length - legacyReceipts.length;
  await orgStorage.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
    workspaceRecapChat: { messages, receipts: [], pending: [] },
  });
  await page.goto(`${ORIGIN}/`);

  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForSelector('#banner', { hidden: true, timeout: 7_000 });
  // Enrollment begins with an expected unauthenticated session read and the
  // browser may ask for a favicon this fixture does not serve. From this
  // point on, every error belongs to the feature journey itself.
  consoleErrors.length = 0;
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('put it away'), { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 600));

  const KEYS = 336;
  // tsx's keepNames wraps the functions inside the page scripts below in a
  // `__name` call the page does not have; give it one.
  await page.evaluate('window.__name = (fn) => fn');
  // The phone, as the page sees it: readings it can be asked for, a page it
  // can scroll, and a scroll back it refuses once.
  const install = () => page.evaluate((keys) => {
    const w = window as unknown as { sim?: { layout: number; inner: number; refuse: boolean }; realViewport?: VisualViewport; realScrollTo?: typeof window.scrollTo };
    if (w.sim) return;
    const layout = window.innerHeight;
    const sim = w.sim = { layout, inner: layout, refuse: false };
    const real = (w.realViewport ??= window.visualViewport!);
    const realScrollTo = (w.realScrollTo ??= window.scrollTo.bind(window));
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => sim.inner });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => sim.layout });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
      get height() { void document.documentElement.offsetHeight; return sim.inner; },
      get offsetTop() { return Math.round(window.scrollY); },
      width: real.width, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
      addEventListener: real.addEventListener.bind(real), removeEventListener: real.removeEventListener.bind(real),
    } });
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: (x: number, y?: number) => {
      if (sim.refuse) { sim.refuse = false; return; }
      realScrollTo(x as number, y as number);
    } });
    // And its touch: a tap on words that cannot take the focus does not move
    // it — the box keeps it and the keys stay up — where a desktop click
    // would blur it. Only a screen's own handler can put the keys away.
    document.addEventListener('mousedown', (event) => {
      const target = event.target as Element;
      if (!target.closest('input, textarea, select, button, a, label, [tabindex], [contenteditable]')) event.preventDefault();
    }, true);
    const style = document.createElement('style');
    style.id = 'simKeyboardStyle';
    document.head.append(style);
    const board = document.createElement('div');
    board.id = 'simKeyboard';
    board.textContent = 'keyboard';
    board.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${keys}px;background:#c9ccd1;color:#6b6f76;font:600 15px system-ui;display:none;align-items:center;justify-content:center;z-index:9999`;
    document.body.append(board);
  }, KEYS);
  const keysUp = () => page.evaluate(async (keys) => {
    const w = window as unknown as { sim: { layout: number; inner: number }; realViewport: VisualViewport; realScrollTo: typeof window.scrollTo };
    // The page grows by the keys' height (the layout viewport stays whole
    // while the window is the visible part), and the phone scrolls it.
    document.getElementById('simKeyboardStyle')!.textContent = `html { padding-bottom: ${keys}px; }`;
    document.getElementById('simKeyboard')!.style.display = 'flex';
    w.sim.inner = w.sim.layout - keys;
    w.realScrollTo(0, keys);
    w.realViewport.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    w.realViewport.dispatchEvent(new Event('scroll'));
  }, KEYS);
  // The keys go. The page stays as tall as Safari left it, and the first
  // scroll back is refused, as on the closing frame of the phone in #351.
  const keysDown = () => page.evaluate(async () => {
    const w = window as unknown as { sim: { layout: number; inner: number; refuse: boolean }; realViewport: VisualViewport };
    document.getElementById('simKeyboard')!.style.display = 'none';
    w.sim.inner = w.sim.layout;
    w.sim.refuse = true;
    w.realViewport.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 1200));
  });
  const settle = () => page.evaluate(() => {
    document.getElementById('simKeyboardStyle')!.textContent = '';
    (window as unknown as { realScrollTo: typeof window.scrollTo }).realScrollTo(0, 0);
  });
  const where = () => page.evaluate(() => {
    const head = document.querySelector('.screen:not([hidden]) .chathead')!.getBoundingClientRect();
    const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
    return { scrollY: Math.round(window.scrollY), headTop: Math.round(head.top), barBottom: Math.round(bar.bottom), window: (window as unknown as { sim: { layout: number } }).sim.layout, focused: document.activeElement?.id === 'agentChatText' };
  });
  const shot = async (name: string) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` }); await settleAfterShot(page); };

  const journey = async (label: string, prefix: string, inert: string) => {
    await install();
    // A finger on the box, as on the phone: a touch is also what tells the
    // shell's scroll keeper (place-scroll.ts) that the page is the reader's.
    await page.click('#agentChatText');
    await keysUp();
    await page.keyboard.type('Can you check the booking page?');
    await new Promise((r) => setTimeout(r, 900));
    const up = await where();
    check(`${label}: with the keys up the message box sits on them`, Math.abs(up.barBottom - (up.window - KEYS)) <= 2 && up.focused, JSON.stringify(up));
    await shot(`${prefix}-1-keyboard-up`);
    // Tap the conversation, on the words of a message.
    const target = await page.$(inert);
    const box = await target!.boundingBox();
    await page.mouse.click(box!.x + 20, box!.y + box!.height / 2);
    await new Promise((r) => setTimeout(r, 100));
    const tapped = await where();
    check(`${label}: a tap on the conversation takes the focus off the box (the keyboard goes)`, !tapped.focused, JSON.stringify(tapped));
    await keysDown();
    const down = await where();
    check(`${label}: once the keyboard has gone the page is back — header at the top, box at the bottom`, down.scrollY === 0 && down.headTop === 0 && Math.abs(down.barBottom - down.window) <= 1, JSON.stringify(down));
    await shot(`${prefix}-2-keyboard-gone`);
    const kept = await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value);
    check(`${label}: the draft is still in the box`, kept === 'Can you check the booking page?', kept);
    await settle();
  };

  await journey('Chief of Staff (Home)', 'cos', '#recapChatLog .chatmsg.agent:last-of-type p');

  // The keyboard put away some other way, with the box still holding the
  // focus: no blur, so nothing on the screen arms a retry of its own.
  await page.click('#agentChatText');
  await keysUp();
  await new Promise((r) => setTimeout(r, 900));
  await keysDown();
  const kept = await where();
  check('Chief of Staff (Home): a keyboard that leaves with the box still focused gives the page back too',
    kept.focused && kept.scrollY === 0 && kept.headTop === 0 && Math.abs(kept.barBottom - kept.window) <= 1, JSON.stringify(kept));
  await shot('cos-3-keyboard-gone-box-focused');
  await page.evaluate(() => (document.getElementById('agentChatText') as HTMLElement).blur());
  await settle();

  // Note #736: Send lets go of the box inside the tap, as the room chat's
  // does — empty, unfocused, never read-only under the keyboard. Holding it
  // focused and read-only for the whole request is what let an iPhone's
  // keyboard leave with the box still focused, and the page stayed up.
  await page.evaluate(() => {
    const touch = (query: string) => ({ media: query, matches: query === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: touch });
  });
  await page.click('#agentChatText');
  await keysUp();
  await page.keyboard.type('Is the booking page fast?');
  await page.click('#agentChatSend');
  await new Promise((r) => setTimeout(r, 100));
  const sending = await page.evaluate(() => {
    const field = document.getElementById('agentChatText') as HTMLTextAreaElement;
    return { focused: document.activeElement === field, readOnly: field.readOnly, value: field.value };
  });
  check('Chief of Staff (Home): Send lets go of the box in the tap — empty, not focused, not read-only', !sending.focused && !sending.readOnly && sending.value === '', JSON.stringify(sending));
  await keysDown();
  const sent = await where();
  check('Chief of Staff (Home): after Send the page is back — header at the top, box at the bottom', sent.scrollY === 0 && sent.headTop === 0 && Math.abs(sent.barBottom - sent.window) <= 1, JSON.stringify(sent));
  await shot('cos-4-after-send');
  await settle();

  // The same journey on a room chat, which has always had the tap.
  await page.goto(`${ORIGIN}/chat/theo?org=${org.orgId}`);
  await page.waitForSelector('#screenAgentChat #agentChatText', { timeout: 15_000 });
  await page.evaluate('window.__name = (fn) => fn');
  await new Promise((r) => setTimeout(r, 800));
  await journey('Room chat (Theo)', 'room', '#agentChatScroll');

  // This harness has no room-chat backend: the room chat's history read
  // answers 503, and its screen and box are drawn all the same.
  const errors = consoleErrors.filter((line) => !line.includes('/api/agents/theo/chat') && !line.includes('status of 503'));
  check('the browser stayed clean', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
}
