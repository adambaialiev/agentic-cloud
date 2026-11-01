// Note #736 — the Chief of Staff's chat on an iPhone keyboard, in WebKit.
//
// Note #727's check (verify-cos-chat-keyboard.mts) drives Chrome. Adam's
// phone runs Safari, so this one drives Playwright's WebKit — the engine
// Safari is built on — with the iPhone 15 Pro Max's screen, touch and user
// agent, on the Chief of Staff's chat and on a room chat, and closes the
// keyboard three ways on each: a tap on the conversation, the keys going
// with the box still focused, and Send.
//
// Not in the CI browser stage (that stage installs Chrome only), so it is
// named `webkit-*`, not `verify-*`. Run it by hand:
//
//   npm --prefix backend run build
//   (mkdir -p ~/pw && cd ~/pw && npm i playwright && npx playwright install webkit && sudo npx playwright install-deps webkit)
//   PLAYWRIGHT_DIR=~/pw OUT_DIR=/tmp/cos-webkit backend/node_modules/.bin/tsx scripts/webkit-cos-chat-keyboard.mts
//
// WebKit on Linux has no on-screen keyboard either, so the keyboard is
// SIMULATED, from what iPhones have been seen to do:
//  - keys up: `innerHeight` is the visible height, the layout height stays
//    the whole screen, and the phone scrolls the page to put the box on the
//    keys (measured on the owner's phone, note #351);
//  - keys gone with a BLUR (the box lost the focus): Safari refuses the
//    first scroll back on the closing frame (note #351);
//  - keys gone with the box STILL FOCUSED — a box turned read-only under
//    the keyboard, or the keyboard put away without a blur: the visible page
//    stays panned while `scrollY` already reads zero (the iOS 26 visual
//    viewport reports: Apple developer forums thread 800154, WebKit bug
//    297779). The page's own next `scrollTo` puts it back.
// A grey block stands where the keys would be. What a real iPhone does can
// still differ; only the phone itself can say.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'cos-chat-keyboard-webkit');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 4197);
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
    // A send starts a turn that is still thinking when the pictures are taken
    // — the "Thinking…" of Adam's screenshot.
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
// The send is in flight for a beat, as over a phone's network: long enough
// for a box held read-only through it to be seen.
app.use((req, _res, next) => {
  if (req.method === 'POST' && /\/api\/(recap\/chat|agents\/[^/]+\/chat)$/.test(req.path)) setTimeout(next, 1500);
  else next();
});
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));


const pw = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(process.env.HOME || '/home/agent', 'pw'), 'package.json'))('playwright') as typeof import('playwright');
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const browser = await pw.webkit.launch();
try {
  const context = await browser.newContext({ ...pw.devices['iPhone 15 Pro Max'] });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  // harnessSignedIn sets its cookies through puppeteer's browserContext().
  const shim = { browserContext: () => ({ setCookie: (...cookies: Array<Record<string, unknown>>) => context.addCookies(cookies.map(({ path: _path, ...cookie }) => cookie) as never) }) };
  const account = await harnessSignedIn(shim as never, workspaceWebAuth, ORIGIN, 'context-owner@example.com');
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

  const KEYS = 336;
  await page.addInitScript('window.__name = (fn) => fn');
  // The phone, as the page sees it.
  const install = () => page.evaluate((keys) => {
    type Sim = { layout: number; inner: number; up: boolean; refuse: boolean; stranded: number };
    const w = window as unknown as { sim?: Sim; realViewport?: VisualViewport; realScrollTo?: typeof window.scrollTo; keysUp?: () => void; keysDown?: (how: 'blur' | 'focused') => void };
    if (w.sim) return;
    const layout = window.innerHeight;
    const sim: Sim = w.sim = { layout, inner: layout, up: false, refuse: false, stranded: 0 };
    const real = (w.realViewport ??= window.visualViewport!);
    const realScrollTo = (w.realScrollTo ??= window.scrollTo.bind(window));
    const style = document.createElement('style');
    style.id = 'simKeyboardStyle';
    document.head.append(style);
    const paint = () => {
      style.textContent = (sim.up ? `html { padding-bottom: ${keys}px; }` : '')
        + (sim.stranded ? `html { transform: translateY(-${sim.stranded}px); }` : '');
    };
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => sim.inner });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => sim.layout });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
      get height() { void document.documentElement.offsetHeight; return sim.inner; },
      get offsetTop() { return sim.stranded || 0; },
      get pageTop() { return Math.round(window.scrollY) + sim.stranded; },
      width: real.width, offsetLeft: 0, pageLeft: 0, scale: 1,
      addEventListener: real.addEventListener.bind(real), removeEventListener: real.removeEventListener.bind(real),
    } });
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: (x: number, y?: number) => {
      if (sim.refuse) { sim.refuse = false; return; }
      // A scroll the page asks for re-syncs a stranded viewport.
      if (sim.stranded && !sim.up) { sim.stranded = 0; paint(); }
      realScrollTo(x as number, y as number);
    } });
    // A tap on words that cannot take the focus does not move it: only a
    // screen's own handler can put the keys away, as on the phone.
    document.addEventListener('mousedown', (event) => {
      const target = event.target as Element;
      if (!target.closest('input, textarea, select, button, a, label, [tabindex], [contenteditable]')) event.preventDefault();
    }, true);
    const board = document.createElement('div');
    board.id = 'simKeyboard';
    board.textContent = 'keyboard';
    board.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${keys}px;background:#c9ccd1;color:#6b6f76;font:600 15px system-ui;display:none;align-items:center;justify-content:center;z-index:9999`;
    document.body.append(board);
    w.keysUp = () => {
      sim.up = true; paint();
      board.style.display = 'flex';
      sim.inner = sim.layout - keys;
      realScrollTo(0, keys);
      real.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => real.dispatchEvent(new Event('scroll')));
    };
    w.keysDown = (how) => {
      if (!sim.up) return;
      board.style.display = 'none';
      sim.up = false;
      sim.inner = sim.layout;
      if (how === 'focused') {
        // The visible page stays where the keys left it; the document
        // scroll already reads zero.
        sim.stranded = Math.round(window.scrollY);
        realScrollTo(0, 0);
      } else {
        sim.refuse = true;
      }
      paint();
      real.dispatchEvent(new Event('resize'));
    };
    // The keyboard follows the box the way the phone's does: it goes with a
    // blur, and it goes — the box still focused — when the box turns
    // read-only under it.
    const box = () => document.getElementById('agentChatText') as HTMLTextAreaElement | null;
    document.addEventListener('focusout', (event) => { if (event.target === box()) w.keysDown!('blur'); }, true);
    new MutationObserver(() => {
      const field = box();
      if (field && field.readOnly && document.activeElement === field) w.keysDown!('focused');
    }).observe(document.body, { attributes: true, attributeFilter: ['readonly'], subtree: true });
  }, KEYS);
  const keysUp = async () => { await page.evaluate(() => (window as unknown as { keysUp: () => void }).keysUp()); await page.waitForTimeout(900); };
  const keysDownFocused = async () => { await page.evaluate(() => (window as unknown as { keysDown: (how: string) => void }).keysDown('focused')); };
  const where = () => page.evaluate(() => {
    const head = document.querySelector('.screen:not([hidden]) .chathead')?.getBoundingClientRect() ?? { top: NaN };
    const bar = document.getElementById('agentChatForm')?.getBoundingClientRect() ?? { bottom: NaN };
    const sim = (window as unknown as { sim: { layout: number; stranded: number } }).sim;
    // What the reader SEES: a stranded viewport is drawn as a transform,
    // which the boxes already carry.
    return {
      scrollY: Math.round(window.scrollY), stranded: sim.stranded,
      headTop: Math.round(head.top), barBottom: Math.round(bar.bottom),
      window: sim.layout, focused: document.activeElement?.id === 'agentChatText',
    };
  });
  const back = (at: Awaited<ReturnType<typeof where>>) => at.scrollY === 0 && at.stranded === 0 && at.headTop === 0 && Math.abs(at.barBottom - at.window) <= 1;
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const reset = () => page.evaluate(() => {
    const w = window as unknown as { sim: { stranded: number; up: boolean }; realScrollTo: typeof window.scrollTo };
    (document.getElementById('agentChatText') as HTMLElement).blur();
    w.sim.stranded = 0; w.sim.up = false;
    document.getElementById('simKeyboardStyle')!.textContent = '';
    w.realScrollTo(0, 0);
  });

  const journeys = async (label: string, prefix: string, inert: string) => {
    await install();
    const wait = (ms: number) => page.waitForTimeout(ms);

    // 1. Type, then tap the conversation.
    await page.tap('#agentChatText');
    await keysUp();
    await page.type('#agentChatText', 'Can you check the booking page?');
    const up = await where();
    check(`${label}: with the keys up the message box sits on them`, Math.abs(up.barBottom - (up.window - KEYS)) <= 2 && up.focused, JSON.stringify(up));
    await shot(`${prefix}-1-keyboard-up`);
    // A spot on the conversation that is words or background, never a
    // control: the room chat's empty pane holds the agent's face, a door.
    const spot = await page.evaluate((selector) => {
      const nodes = document.querySelectorAll(selector);
      const box = nodes[nodes.length - 1]!.getBoundingClientRect();
      for (let y = box.bottom - 12; y > box.top; y -= 12) {
        for (let x = box.left + 20; x < box.right; x += 24) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest('input, textarea, select, button, a, label, [role="button"], [tabindex]')) return { x, y };
        }
      }
      return null;
    }, inert);
    await page.touchscreen.tap(spot!.x, spot!.y);
    await wait(1200);
    const tapped = await where();
    check(`${label}: tap on the conversation — header back at the top, box at the bottom`, back(tapped) && !tapped.focused, JSON.stringify(tapped));
    await shot(`${prefix}-2-after-tap`);
    await reset();

    // 2. The keys go with the box still focused.
    await page.tap('#agentChatText');
    await keysUp();
    await keysDownFocused();
    await wait(1200);
    const kept = await where();
    check(`${label}: keys gone with the box still focused — page back`, back(kept), JSON.stringify(kept));
    await shot(`${prefix}-3-keys-gone-focused`);
    await reset();

    // 3. Send.
    await page.tap('#agentChatText');
    await keysUp();
    await page.tap('#agentChatSend');
    await wait(150);
    const sending = await page.evaluate(() => {
      const field = document.getElementById('agentChatText') as HTMLTextAreaElement;
      return { focused: document.activeElement === field, readOnly: field.readOnly, value: field.value };
    });
    check(`${label}: Send lets go of the box in the tap — empty, not focused, not read-only`, !sending.focused && !sending.readOnly && sending.value === '', JSON.stringify(sending));
    await wait(2200);
    const sent = await where();
    check(`${label}: after Send — header back at the top, box at the bottom`, back(sent), JSON.stringify(sent));
    await shot(`${prefix}-4-after-send`);
    await reset();
  };

  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('put it away'), undefined, { timeout: 10_000 });
  await page.waitForTimeout(600);
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  check('the page reads as a touch screen, as on the phone', touch);
  consoleErrors.length = 0;
  await journeys('Chief of Staff (Home)', 'cos', '#recapChatLog .chatmsg.agent p');

  await page.goto(`${ORIGIN}/chat/theo?org=${org.orgId}`);
  await page.waitForSelector('#screenAgentChat #agentChatText', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await journeys('Room chat (Theo)', 'room', '#agentChatScroll');

  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
}
