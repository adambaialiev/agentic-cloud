// Note #750 — the Chief of Staff's chat, phone closed and opened again.
//
// The owner: "When I closed my phone, and opened again, I was in chief of
// staff chat screen but my scroll position was in the middle of chat, not at
// the end." The conversation is Home, so it is the screen a phone comes back
// to more than any other.
//
// Drives Playwright's WebKit — the engine Safari is built on, with Safari's
// scroll anchoring — on the iPhone 15 Pro Max's screen, touch and user agent,
// through the ways a phone hands a page back after its screen was off: the
// page kept (1), with Safari's bars moving (2), laid out sideways for the app
// switcher's picture (3), laid out a sliver tall while dark (4) or in its
// first frames back (5), wider (6) or narrower (7) for a moment as it wakes,
// loaded again from nothing on a phone network (8), put back from the
// back-forward cache (9). In each the reader was at the newest message when
// the screen went dark, and a reply and an agent's report came in meanwhile:
// they must be at the reply when it comes back. A reader who had scrolled up
// into older messages keeps their line, and is offered the way down (10).
//
// Before the fix, 4 and 6 woke up in the middle of the conversation: Safari
// moved the scroll to keep the words in place as the page changed size, and
// the screen took that scroll for the reader leaving the end. TRACE=1 prints
// every scroll and resize of each journey.
//
// Not in the CI browser stage (that stage installs Chrome only), so it is
// named `webkit-*`, not `verify-*`. Run it by hand:
//
//   npm --prefix backend run build
//   (mkdir -p ~/pw && cd ~/pw && npm i playwright && npx playwright install webkit && sudo npx playwright install-deps webkit)
//   PLAYWRIGHT_DIR=~/pw OUT_DIR=/tmp/cos-reopen backend/node_modules/.bin/tsx scripts/webkit-cos-chat-reopen.mts

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import type { RecapMessage } from '../backend/src/shared/workspace-recap-chat.js';
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'cos-chat-reopen-webkit');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 4198);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
const quickNoteStorage = new InMemoryQuickNoteStorage();
harnessEstablishedWorkplace(orgStorage);
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
    converseWorkspaceRecap: () => new Promise(() => {}),
    summarizeWorkspaceRecap: async () => ({ text: 'Quiet day.' }),
  },
} as unknown as RouteDeps;

// A phone network, when asked for: every read answers late, the workplace's
// own read later than the conversation's — the order a cold open sees.
const slow = { on: false };
const app = express();
app.use((req, _res, next) => {
  if (!slow.on || !req.path.includes('/api/')) { next(); return; }
  setTimeout(next, req.path.endsWith('/api/recap/chat') ? 400 : 1600);
});
// The picture a reply carries (note #749), answered late as a phone's
// network answers it. A tall one: a screenshot.
const PICTURE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#d9e4f2"/><text x="40" y="420" font-size="40">screenshot</text></svg>`,
);
app.get('/picture.svg', (_req, res) => {
  setTimeout(() => { res.type('image/svg+xml').send(PICTURE); }, slow.on ? 2500 : 50);
});
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
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
  const shim = { browserContext: () => ({ setCookie: (...cookies: Array<Record<string, unknown>>) => context.addCookies(cookies.map(({ path: _path, ...cookie }) => cookie) as never) }) };
  const account = await harnessSignedIn(shim as never, workspaceWebAuth, ORIGIN, 'reopen-owner@example.com');
  await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Reopen studio' });
  const [org] = await orgStorage.listOrgs();
  const [owner] = await userStorage.getAllUsers();
  if (!org || !owner) throw new Error('the browser setup created no owner or workplace');
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        theo: {
          id: 'theo', name: 'Theo', cli: 'codex', model: 'gpt-5.6-terra', effort: 'high',
          orgId: org.orgId, serverId: 'fly_ia-theo.machine', connectedAt: at, createdAt: at,
          lastActivityAt: at, recap: { text: 'Fixed the booking page.', at },
        },
      },
    },
  });
  const workspaceAgent = await userStorage.reserveWorkspaceAssistant(owner.userId, org.orgId);
  if (!workspaceAgent) throw new Error('the Workspace Agent was not reserved');
  await userStorage.updateAgentFields(owner.userId, workspaceAgent.id, {
    cli: 'claude', model: 'sonnet', effort: 'high', serverId: 'fly_ia-workspace.machine', connectedAt: at,
  });

  // A conversation as long as the owner's: questions, answers, and agents'
  // reports (folded since note #744), a screenshot in one of the later replies.
  const report = (n: number) => `Report ${n}: the booking page is fixed.\n\n${'The calendar now keeps the chosen day after a refresh, and the checks are green again. '.repeat(4)}`;
  const messages: RecapMessage[] = Array.from({ length: 30 }, (_, n): RecapMessage[] => [
    { id: `o${n}`, role: 'owner', text: `Question ${n + 1}: what changed on the booking page?`, at },
    { id: `a${n}`, role: 'assistant', at, text: `Answer ${n + 1}: the booking page picked up another small fix.\n\n- the calendar\n- the checks\n- the copy` },
    ...(n % 4 === 3 ? [{ id: `r${n}`, role: 'agent' as const, name: 'Theo', text: report(n + 1), at }] : []),
  ]).flat();
  messages.push({
    id: 'a-picture', role: 'assistant', at, text: 'Here is how it looks now.',
    files: [{ id: 'shot', fileName: 'booking.svg', contentType: 'image/svg+xml', sizeBytes: PICTURE.length }],
  });
  messages.push({ id: 'a-last', role: 'assistant', at, text: 'Anything else for the booking page?' });
  const store = (list: RecapMessage[]) => orgStorage.touchMember(org.orgId, owner.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
    workspaceRecapChat: { messages: list, receipts: [], pending: [] },
  });
  await store(messages);
  let grown = messages;
  const grow = async (id: string) => {
    grown = [...grown,
      { id: `${id}-report`, role: 'agent', name: 'Theo', text: report(99), at: new Date().toISOString() },
      { id: `${id}-reply`, role: 'assistant', text: 'Theo finished the booking page while you were away.', at: new Date().toISOString() },
    ];
    await store(grown);
    return `${id}-reply`;
  };

  // The picture's own address, as the files route mints it.
  await page.route(/\/chat\/files\/shot(\?|$)/, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ url: `${ORIGIN}/picture.svg`, fileName: 'booking.svg' }),
  }));
  await page.addInitScript('window.__name = (fn) => fn');
  // The phone's screen going dark and coming back, as the page sees it.
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    (window as unknown as { screenOff: () => void }).screenOff = () => {
      hidden = true;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      document.dispatchEvent(new Event('visibilitychange'));
    };
    (window as unknown as { screenOn: (persisted: boolean) => void }).screenOn = (persisted) => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      if (persisted) window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    };
  });
  const screenOff = () => page.evaluate(() => (window as unknown as { screenOff: () => void }).screenOff());
  const screenOn = (persisted = false) => page.evaluate((p) => (window as unknown as { screenOn: (p: boolean) => void }).screenOn(p), persisted);
  /** Where the transcript stands, and whether its last row is the reply
   *  that came in while the phone was dark — on screen, whole. */
  const where = (newest: string) => page.evaluate((text) => {
    const pane = document.getElementById('recapChatScroll')!;
    const box = pane.getBoundingClientRect();
    const last = [...document.querySelectorAll('#recapChatLog .chatmsg')].at(-1);
    const row = last?.getBoundingClientRect();
    return {
      gap: Math.round(pane.scrollHeight - pane.clientHeight - pane.scrollTop),
      top: Math.round(pane.scrollTop),
      newest: Boolean(last?.textContent?.includes(text)),
      shown: Boolean(row && row.bottom <= box.bottom + 1 && row.top >= box.top - 1),
    };
  }, newest);
  const atEnd = (label: string, seen: Awaited<ReturnType<typeof where>>) => check(label, seen.gap <= 2 && seen.newest && seen.shown, JSON.stringify(seen));
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  // TRACE=1 prints every scroll, resize and pane resize of a journey: what
  // found the cause (a scroll Safari made for a resize, read as the reader's).
  const trace = () => page.evaluate(() => {
    const el = document.getElementById('recapChatScroll')!;
    const log: string[] = ((window as unknown as { scrollLog: string[] }).scrollLog = []);
    const t0 = performance.now();
    const say = (what: string) => log.push(`${Math.round(performance.now() - t0)} ${what} top=${Math.round(el.scrollTop)} size=${el.clientWidth}x${el.clientHeight} gap=${Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)} hidden=${document.hidden}`);
    el.addEventListener('scroll', () => say('scroll'));
    new ResizeObserver(() => say('pane')).observe(el);
    window.addEventListener('resize', () => say('resize'));
  });
  const dump = async () => { if (process.env.TRACE) console.log((await page.evaluate(() => (window as unknown as { scrollLog?: string[] }).scrollLog ?? [])).join('\n')); };
  const size = page.viewportSize()!;
  const { width: W, height: H } = size;
  type Size = { width: number; height: number };
  /**
   * The reader at the newest message; the screen goes dark; the page is
   * laid out at `dark` sizes meanwhile, a reply and an agent's report come
   * in, the screen comes back through `waking` sizes and settles at the
   * phone's own. The reader must be at the reply.
   */
  const wake = async (label: string, shotName: string, dark: Size[], waking: Size[] = []) => {
    await page.evaluate(() => { const el = document.getElementById('recapChatScroll')!; el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(400);
    await trace();
    await screenOff();
    for (const next of dark) { await page.setViewportSize(next); await page.waitForTimeout(120); }
    await grow(shotName);
    await screenOn();
    for (const next of waking) { await page.setViewportSize(next); await page.waitForTimeout(40); }
    await page.setViewportSize(size);
    await page.waitForTimeout(2000);
    atEnd(label, await where('while you were away'));
    await dump();
    await shot(shotName);
  };

  // 0. The conversation opens at its end.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#recapChatLog .chatmsg');
  await page.waitForTimeout(1500);
  atEnd('0. opened: at the newest message', await where('Anything else'));
  await shot('0-opened');

  // The page kept while the screen was dark.
  await wake('1. dark and back, the conversation grown meanwhile', '1-kept', []);
  await wake('2. dark and back, Safari\'s bars gone on the lock screen and back on waking', '2-bars',
    [{ width: W, height: H + 90 }, { width: W, height: H - 60 }]);
  await wake('3. laid out sideways while dark (the app switcher\'s picture)', '3-rotated', [{ width: H, height: W }]);
  await wake('4. laid out a sliver tall while dark', '4-sliver-dark', [{ width: W, height: 120 }]);
  await wake('5. a sliver tall in the first frames back', '5-sliver-waking', [], [{ width: W, height: 120 }]);
  await wake('6. wider in the first frames back', '6-wide-waking', [], [{ width: W + 200, height: H }]);
  await wake('7. narrower and short, then tall, in the first frames back', '7-narrow-tall', [], [{ width: W - 120, height: H - 200 }, { width: W, height: H + 100 }]);

  // 8. The page discarded and loaded again from nothing, on a phone network:
  //    the conversation lands, then the workplace, then the picture.
  await screenOff();
  await grow('8-cold');
  slow.on = true;
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#recapChatLog .chatmsg', { timeout: 15_000 });
  await page.waitForTimeout(5000);
  atEnd('8. loaded again from nothing on a slow network', await where('while you were away'));
  await shot('8-cold');
  slow.on = false;

  // 9. Put back from the back-forward cache, `pageshow` persisted.
  await screenOff();
  await grow('9-bfcache');
  await screenOn(true);
  await page.waitForTimeout(2000);
  atEnd('9. put back from the back-forward cache', await where('while you were away'));
  await shot('9-bfcache');

  // 10. A reader up in older messages keeps their line through the same, and
  //     is offered the way down to what came in.
  await page.evaluate(() => { document.getElementById('recapChatScroll')!.scrollTop = 600; });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => document.getElementById('recapChatScroll')!.scrollTop);
  await screenOff();
  await page.setViewportSize({ width: W, height: 120 });
  await page.waitForTimeout(120);
  await grow('10-reading');
  await screenOn();
  await page.setViewportSize(size);
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => {
    const el = document.getElementById('recapChatScroll')!;
    return {
      top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
      jump: !(document.getElementById('recapChatJump')?.parentElement as HTMLElement | null)?.hidden,
    };
  });
  check('10. a reader up in older messages keeps their line, and is offered the way down', Math.abs(after.top - before) <= 80 && after.gap > 2000 && after.jump, JSON.stringify({ before, ...after }));
  await shot('10-reading');

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
