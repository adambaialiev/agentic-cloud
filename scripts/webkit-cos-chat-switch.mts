// Note #754 — the Chief of Staff's chat, after switching workplaces.
//
// The owner, 2026-10-15: "Why when I switch back to “ACC” workspace my scroll
// position in the chief of staff chat screen is not at the bottom". He was in
// another workplace (Demonstrations) and switched back to ACC; its Chief of
// Staff chat opened in the middle of the conversation.
//
// Drives Playwright's WebKit — the engine Safari is built on — on the iPhone
// 15 Pro Max's screen, touch and user agent. One person, two workplaces, each
// with its own Chief of Staff conversation: ACC's long, with a picture near
// the end; Demonstrations' short. On a phone network (every conversation read
// answers late, the picture later), so the copy this tab kept is drawn first
// and the fresh answer lands over it, a reply that came in meanwhile with it.
//
//  1. Switching by the header's workplace menu, the reader having scrolled
//     Demonstrations' chat up into older messages: ACC must open at its
//     newest message and stay there while the answer and the picture arrive.
//  2. The same with Demonstrations' chat scrolled up and back down to its
//     own newest message.
//  3. Switching by the Workplaces screen (`/workplaces`), both ways.
//  4. Inside ACC, Back from a note returns to the line the reader left
//     (the leave/return pair, knowledge page miniapp-navigation).
//
// Before the fix, 1 and 2 opened ACC in the middle of its conversation: the
// switch moved the workplace at once but the address a beat later (the
// router moves it in a transition), so ACC's conversation was drawn while
// the address still named Demonstrations' history entry — and it took the
// line Demonstrations' chat had left on that entry for a line of its own to
// return to. TRACE=1 prints every scroll of each switch back.
//
// Not in the CI browser stage (that stage installs Chrome only), so it is
// named `webkit-*`, not `verify-*`. Run it by hand:
//
//   npm --prefix backend run build
//   (mkdir -p ~/pw && cd ~/pw && npm i playwright && npx playwright install webkit && sudo npx playwright install-deps webkit)
//   PLAYWRIGHT_DIR=~/pw OUT_DIR=/tmp/cos-switch backend/node_modules/.bin/tsx scripts/webkit-cos-chat-switch.mts

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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'cos-chat-switch-webkit');
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 4199);
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

// A phone network: the conversation's read answers late, the workplace's own
// read later, the picture later still.
const app = express();
app.use((req, _res, next) => {
  if (!req.path.includes('/api/')) { next(); return; }
  setTimeout(next, req.path.endsWith('/api/recap/chat') ? 700 : 1200);
});
const PICTURE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#d9e4f2"/><text x="40" y="420" font-size="40">screenshot</text></svg>`,
);
app.get('/picture.svg', (_req, res) => { setTimeout(() => { res.type('image/svg+xml').send(PICTURE); }, 1800); });
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
  const account = await harnessSignedIn(shim as never, workspaceWebAuth, ORIGIN, 'switch-owner@example.com');
  const acc = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' })).org;
  const demos = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Demonstrations' })).org;
  await orgStorage.setActiveOrg(account.userId, acc.orgId);
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const org of [acc, demos]) {
    const agent = await userStorage.reserveWorkspaceAssistant(account.userId, org.orgId);
    if (!agent) throw new Error(`the Chief of Staff of ${org.name} was not reserved`);
    await userStorage.updateAgentFields(account.userId, agent.id, {
      cli: 'claude', model: 'sonnet', effort: 'high', serverId: `fly_ia-cos-${org.orgId.slice(0, 6)}.machine`, connectedAt: at,
    });
  }

  // ACC's conversation as long as the owner's, a screenshot in its last reply
  // but one; Demonstrations' a few exchanges.
  const report = (n: number) => `Report ${n}: the booking page is fixed.\n\n${'The calendar now keeps the chosen day after a refresh, and the checks are green again. '.repeat(4)}`;
  const accMessages: RecapMessage[] = Array.from({ length: 30 }, (_, n): RecapMessage[] => [
    { id: `o${n}`, role: 'owner', text: `Question ${n + 1}: what changed on the booking page?`, at },
    { id: `a${n}`, role: 'assistant', at, text: `Answer ${n + 1}: the booking page picked up another small fix.\n\n- the calendar\n- the checks\n- the copy` },
    ...(n % 4 === 3 ? [{ id: `r${n}`, role: 'agent' as const, name: 'Theo', text: report(n + 1), at }] : []),
  ]).flat();
  accMessages.push({
    id: 'a-picture', role: 'assistant', at, text: 'Here is how it looks now.',
    files: [{ id: 'shot', fileName: 'booking.svg', contentType: 'image/svg+xml', sizeBytes: PICTURE.length }],
  });
  accMessages.push({ id: 'a-last', role: 'assistant', at, text: 'Anything else for the booking page?' });
  const demosMessages: RecapMessage[] = Array.from({ length: 7 }, (_, n): RecapMessage[] => [
    { id: `d-o${n}`, role: 'owner', text: `Demo ${n + 1}: is the walkthrough ready?`, at },
    { id: `d-a${n}`, role: 'assistant', at, text: `Demo ${n + 1} is ready.\n\n- the script\n- the screenshots\n- the timing` },
  ]).flat();
  const store = (orgId: string, list: RecapMessage[]) => orgStorage.touchMember(orgId, account.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'sonnet', effort: 'high' },
    workspaceRecapChat: { messages: list, receipts: [], pending: [] },
  });
  await store(acc.orgId, accMessages);
  await store(demos.orgId, demosMessages);
  let grown = accMessages;
  /** A reply lands in ACC while the reader is in the other workplace. */
  const growAcc = async (id: string) => {
    grown = [...grown, { id: `${id}-reply`, role: 'assistant', text: `Theo finished the booking page while you were away (${id}).`, at: new Date().toISOString() }];
    await store(acc.orgId, grown);
    return `while you were away (${id})`;
  };

  await page.route(/\/chat\/files\/shot(\?|$)/, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ url: `${ORIGIN}/picture.svg`, fileName: 'booking.svg' }),
  }));
  await page.addInitScript('window.__name = (fn) => fn');

  type Seen = { t: number; rows: number; top: number; gap: number; newest: boolean; shown: boolean; title: string };
  /** Where the transcript stands, and whether its last row says `newest` — on screen, whole. */
  const where = (newest: string) => page.evaluate((text) => {
    const pane = document.getElementById('recapChatScroll');
    const rows = [...document.querySelectorAll('#recapChatLog .chatmsg')];
    const last = rows.at(-1);
    if (!pane) return { rows: 0, top: 0, gap: 0, newest: false, shown: false, title: document.querySelector('.orgswapname')?.textContent ?? '' };
    const box = pane.getBoundingClientRect();
    const row = last?.getBoundingClientRect();
    return {
      rows: rows.length,
      top: Math.round(pane.scrollTop),
      gap: Math.round(pane.scrollHeight - pane.clientHeight - pane.scrollTop),
      newest: Boolean(last?.textContent?.includes(text)),
      shown: Boolean(row && row.bottom <= box.bottom + 1 && row.top >= box.top - 1),
      title: document.querySelector('.orgswapname')?.textContent ?? '',
    };
  }, newest);
  const atEnd = (seen: Omit<Seen, 't'>) => seen.gap <= 2 && seen.newest && seen.shown;
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const trace = () => page.evaluate(() => {
    const log: string[] = ((window as unknown as { scrollLog: string[] }).scrollLog = []);
    const t0 = performance.now();
    document.addEventListener('scroll', (event) => {
      const el = event.target as HTMLElement;
      if (el.id !== 'recapChatScroll') return;
      log.push(`${Math.round(performance.now() - t0)} scroll top=${Math.round(el.scrollTop)} height=${el.scrollHeight} gap=${Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)} at=${location.pathname}`);
    }, { capture: true });
  });
  const dump = async () => { if (process.env.TRACE) console.log((await page.evaluate(() => (window as unknown as { scrollLog?: string[] }).scrollLog ?? [])).join('\n')); };

  /** Pick a workplace from the header's switch menu. */
  const switchByMenu = async (name: string) => {
    await page.tap('#homeOrganizations');
    const row = page.locator('#workplaceMenu .orgmenurow', { hasText: name });
    await row.waitFor();
    await row.tap();
  };
  /** Pick a workplace on the Workplaces screen, reached inside the app. */
  const switchByScreen = async (name: string) => {
    await page.evaluate(() => { history.pushState(null, '', '/workplaces'); dispatchEvent(new PopStateEvent('popstate')); });
    const row = page.locator('#screenOrgPicker .orgrow', { hasText: name });
    await row.waitFor();
    await row.tap();
  };
  /** Sample the pane every 100 ms for `ms` from now. */
  const sample = async (newest: string, ms: number) => {
    const seen: Seen[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      seen.push({ t: Date.now() - t0, ...(await where(newest)) });
      await page.waitForTimeout(100);
    }
    return seen;
  };
  /**
   * Back in ACC: from the first sample that shows ACC's conversation drawn,
   * every sample stands at its end — the held copy first, then the fresh
   * answer with the reply that came in meanwhile, then the picture.
   */
  const judge = (label: string, seen: Seen[]) => {
    const drawn = seen.filter((s) => s.title === 'ACC' && s.rows > 20);
    const off = drawn.filter((s) => s.gap > 2);
    const last = seen.at(-1)!;
    check(`${label}: opens at the newest message`, drawn.length > 0 && drawn[0]!.gap <= 2, JSON.stringify(drawn[0] ?? null));
    check(`${label}: stays there while the answer and the picture arrive`, off.length === 0, off.length ? `${off.length} of ${drawn.length} samples away from the end, e.g. ${JSON.stringify(off[0])}` : '');
    check(`${label}: ends at the reply that came in meanwhile`, atEnd(last), JSON.stringify(last));
  };

  // 0. ACC opens at its end.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#recapChatLog .chatmsg', { timeout: 15_000 });
  await page.waitForTimeout(3000);
  const opened = await where('Anything else');
  check('0. ACC opened: at the newest message', atEnd(opened), JSON.stringify(opened));
  await shot('0-acc-opened');

  // 1. To Demonstrations by the header menu; the reader scrolls up there.
  await switchByMenu('Demonstrations');
  await page.waitForFunction(() => document.querySelector('.orgswapname')?.textContent === 'Demonstrations');
  await page.waitForTimeout(2500);
  const demosOpened = await where('Demo 7 is ready');
  check('1a. Demonstrations opened: at the newest message', atEnd(demosOpened), JSON.stringify(demosOpened));
  await page.evaluate(() => { const el = document.getElementById('recapChatScroll')!; el.scrollTop = Math.round(el.scrollHeight / 3); });
  await page.waitForTimeout(400);
  await shot('1-demos-scrolled-up');
  let newest = await growAcc('1');
  await trace();
  await switchByMenu('ACC');
  let seen = await sample(newest, 4500);
  judge('1b. back to ACC by the menu, Demonstrations scrolled up', seen);
  await dump();
  await shot('1-acc-back');

  // 2. The same, Demonstrations scrolled up and back down to its own end.
  await switchByMenu('Demonstrations');
  await page.waitForFunction(() => document.querySelector('.orgswapname')?.textContent === 'Demonstrations');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const el = document.getElementById('recapChatScroll')!; el.scrollTop = Math.round(el.scrollHeight / 3); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const el = document.getElementById('recapChatScroll')!; el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);
  newest = await growAcc('2');
  await trace();
  await switchByMenu('ACC');
  seen = await sample(newest, 4500);
  judge('2. back to ACC by the menu, Demonstrations back at its end', seen);
  await dump();
  await shot('2-acc-back');

  // 3. By the Workplaces screen, both ways.
  await switchByScreen('Demonstrations');
  await page.waitForFunction(() => document.querySelector('.orgswapname')?.textContent === 'Demonstrations');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const el = document.getElementById('recapChatScroll')!; el.scrollTop = Math.round(el.scrollHeight / 3); });
  await page.waitForTimeout(400);
  newest = await growAcc('3');
  await trace();
  await switchByScreen('ACC');
  seen = await sample(newest, 4500);
  judge('3. back to ACC by the Workplaces screen', seen);
  await dump();
  await shot('3-acc-back');

  // 4. Inside ACC: up into older messages, into a note, Back.
  await page.evaluate(() => { document.getElementById('recapChatScroll')!.scrollTop = 1500; });
  await page.waitForTimeout(400);
  const left = await page.evaluate(() => Math.round(document.getElementById('recapChatScroll')!.scrollTop));
  await page.evaluate(() => { history.pushState(null, '', '/notes/1'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(() => !document.getElementById('recapChatScroll'), { timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.goBack();
  await page.waitForSelector('#recapChatLog .chatmsg');
  await page.waitForTimeout(2000);
  const returned = await page.evaluate(() => {
    const el = document.getElementById('recapChatScroll')!;
    return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) };
  });
  check('4. Back from a note inside ACC returns to the line the reader left', Math.abs(returned.top - left) <= 2 && returned.gap > 1000, JSON.stringify({ left, ...returned }));
  await shot('4-acc-back-from-note');

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
