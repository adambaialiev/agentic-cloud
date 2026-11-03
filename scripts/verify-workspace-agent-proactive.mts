// Note #716: the Chief of Staff on its own — event turns and standing
// permissions — driven in real Chrome against a real workplace:
//
//  - the Workplace window's "On its own" card: off by default with one
//    switch; turned on, the waits and quiet hours under it, the four standing
//    permissions, and what it noticed lately (quiet turns included);
//  - a switch writes through the real route and the page repaints from the
//    answer; the reader's own time zone rides along;
//  - Home: an event turn that told the person reads as the events it
//    noticed, a receipt that says it acted on its own, and its reply — and a
//    quiet one leaves nothing in the chat.
//
// Screenshots land in OUT_DIR (~/n716-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-agent-proactive.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { DEFAULT_WORKSPACE_AGENT_PROACTIVE } from '../backend/src/shared/workspace-agent-proactive.js';
import { workspaceAssistantId } from '../backend/src/types/user.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n716-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4233);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(), userStorage, new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: () => false,
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
} as unknown as RouteDeps['agentLifecycle'];
const deps = {
  userStorage, workspaceWebAuth, mailboxes: mailbox.mailboxes, orgStorage, secretStorage: new InMemorySecretStorage(),
  workspaceWebOrigin: ORIGIN, workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'), workspaceUiDefault: 'react', agentLifecycle,
} as RouteDeps;
const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.emulateTimezone('Asia/Bishkek');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico')
      || (response.status() === 503 && url.pathname === '/workspace/api/drive')
      // No version service is wired: the version card is the cards' scenery.
      || (response.status() === 503 && /^\/workspace\/api\/agents\/[^/]+\/version$/.test(url.pathname));
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  // The banner a switch raises is the switch's answer, not the screen: it is
  // closed before a picture is taken.
  const shot = async (name: string) => {
    await page.$$eval('#banner .toastdismiss', (nodes) => nodes.forEach((node) => (node as HTMLButtonElement).click())).catch(() => {});
    await new Promise((done) => setTimeout(done, 400));
    await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  };
  const settled = () => page.waitForFunction(() => {
    const sheet = document.getElementById('homeSheet');
    return Boolean(sheet) && sheet!.getAnimations().length === 0 && sheet!.parentElement!.getAnimations().length === 0;
  }, { timeout: 10_000 });

  // A workplace with two agents and a Chief of Staff that has already run
  // event turns: one it told the person about, two quiet.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const waId = workspaceAssistantId(me.userId, org.orgId);
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        alex: { id: 'alex', name: 'Alex', cli: 'claude', createdAt: iso(5000), serverId: 'm-alex', connectedAt: iso(5000), model: 'opus', effort: 'xhigh', lastActivityAt: iso(40), recap: { text: 'Agents picker.', at: iso(40) } },
        ben: { id: 'ben', name: 'Ben', cli: 'claude', createdAt: iso(5000), serverId: 'm-ben', connectedAt: iso(5000), model: 'opus', effort: 'high', lastActivityAt: iso(60 * 30), recap: { text: 'Merged and live.', at: iso(60 * 30) } },
        [waId]: { id: waId, name: 'Workspace Agent', cli: 'claude', model: 'opus', effort: 'high', orgId: org.orgId, purpose: 'workspace-recap', createdAt: iso(5000), connectedAt: iso(5000), serverId: 'm-wa' },
      } as never,
    },
  });
  const red = 'Checks failed on proposal #1321 "Agents picker: search keeps its place" by Alex: ci/checks.';
  await orgStorage.touchMember(org.orgId, account.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceAgentProactive: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE, timeZone: 'Asia/Bishkek' },
    workspaceRecapChat: {
      receipts: [], pending: [],
      messages: [
        { id: 'o1', role: 'owner', text: 'What is everyone working on this morning?', at: iso(240) },
        { id: 'a1', role: 'assistant', at: iso(239), text: 'Alex is finishing the agents picker; Ben\'s booking work is merged and live. Nothing waits for your decision.' },
        { id: 'e1', role: 'action', kind: 'event', answered: true, hidden: true, at: iso(180), text: 'Note #731 "Pricing page copy" has been unclaimed for 2 days.' },
        { id: 'q1', role: 'assistant', kind: 'quiet', hidden: true, event: true, at: iso(179), text: 'It is a reference note Adam keeps, not a request.' },
        { id: 'e2', role: 'action', kind: 'event', answered: true, at: iso(95), text: 'Ben reported "Merged and live: the booking page loads in 1.2 s." 30 hours ago, and you have not answered in its chat.' },
        { id: 'r2', role: 'action', at: iso(94), text: 'On its own: asked Ben for a fresh chat.' },
        { id: 'q2', role: 'assistant', kind: 'quiet', hidden: true, event: true, at: iso(94), text: 'Ben\'s booking work is merged and live; asked him for a fresh chat.' },
        { id: 'e3', role: 'action', kind: 'event', answered: true, at: iso(12), text: red },
        { id: 'a3', role: 'assistant', event: true, at: iso(11), text: 'Checks went red on Alex\'s #1321 — a picker test fails on the phone layout. Alex is idle, so nothing is fixing it yet. Shall I ask him to look?' },
      ],
    },
  } as never);

  // 1. Home: the event turn that told the person, and nothing of the quiet ones.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForFunction(() => document.body.textContent?.includes('Shall I ask him to look?'), { timeout: 10_000 });
  const chat = await page.evaluate(() => document.querySelector('#screenHome')!.textContent ?? '');
  check('the told event turn reads as what it noticed and its reply', chat.includes('Checks failed on proposal #1321') && chat.includes('Shall I ask him to look?'));
  // Since note #725 it is the quiet line every action of the agent's takes,
  // tagged rather than prefixed.
  const own = await page.evaluate(() => [...document.querySelectorAll('#recapChatLog .chatmsg.recapdid')]
    .map((row) => `${row.querySelector('.recaptag')?.textContent ?? ''}|${row.textContent ?? ''}`));
  check('a receipt of its own motion says so', own.includes('on its own|on its ownBen starts a fresh chat'), JSON.stringify(own));
  check('quiet turns leave nothing in the chat', !chat.includes('reference note Adam keeps') && !chat.includes('Pricing page copy'));
  await page.evaluate(() => document.querySelector('.chatlist, #recapChatList, .chatscroll')?.scrollTo?.({ top: 1e6 }));
  await shot('home-event-turn-phone');

  // 2. The Chief of Staff's own screen, the last row of the Workplace
  //    window (note #960): off by default, one switch.
  await page.click('#homeWorkplaceDoor');
  await settled();
  await page.waitForSelector('#homeSheet #indexChiefOfStaff', { timeout: 10_000 });
  await page.$eval('#homeSheet #indexChiefOfStaff', (node) => (node as HTMLElement).click());
  await page.waitForSelector('#screenChiefOfStaff #recapEventTurns', { timeout: 10_000 });
  check('event turns start off', (await page.$eval('#recapEventTurns', (node) => node.getAttribute('aria-checked'))) === 'false');
  check('nothing else to set while off', !(await page.$('#recapPermissionsCard')) && !(await page.$('#recapWaitProposal')));
  await page.$eval('#recapProactiveHead', (node) => node.scrollIntoView({ block: 'start' }));
  await shot('workplace-on-its-own-off-phone');

  // 3. On: the waits, quiet hours, the four permissions; one permission on.
  await page.click('#recapEventTurns');
  await page.waitForFunction(() => document.getElementById('recapEventTurns')?.getAttribute('aria-checked') === 'true', { timeout: 10_000 });
  const stored = (await orgStorage.getMembership(org.orgId, account.userId))?.workspaceAgentProactive;
  check('the switch wrote through the real route, with the reader\'s own zone', stored?.events === true && stored.timeZone === 'Asia/Bishkek', JSON.stringify(stored));
  await page.click('#recapPermission-reset-finished-agent');
  await page.waitForFunction(() => document.getElementById('recapPermission-reset-finished-agent')?.getAttribute('aria-checked') === 'true', { timeout: 10_000 });
  await page.click('#recapPermission-ask-silent-agent');
  await page.waitForFunction(() => document.getElementById('recapPermission-ask-silent-agent')?.getAttribute('aria-checked') === 'true', { timeout: 10_000 });
  const after = (await orgStorage.getMembership(org.orgId, account.userId))?.workspaceAgentProactive;
  check('two permissions on, two off', after?.permissions['reset-finished-agent'] === true && after.permissions['ask-silent-agent'] === true
    && after.permissions['hand-unclaimed-note'] === false && after.permissions['archive-finished-note'] === false, JSON.stringify(after?.permissions));
  const titles = await page.$$eval('#recapPermissionsCard [role="switch"] .name', (nodes) => nodes.map((node) => node.textContent));
  check('the four permissions, in the note\'s words', JSON.stringify(titles) === JSON.stringify(['Reset a finished agent’s chat', 'Hand an unclaimed note to a free agent', 'Ask a silent agent to report', 'Archive a finished note']), JSON.stringify(titles));
  const noticed = await page.$$eval('#recapNoticedCard .row', (nodes) => nodes.map((node) => node.textContent ?? ''));
  check('Noticed lately lists all three turns, quiet ones too, newest first',
    noticed.length === 3 && noticed[0]!.includes('Told you in its chat') && noticed[1]!.includes('Kept quiet') && noticed[1]!.includes('1 action') && noticed[2]!.includes('reference note'), JSON.stringify(noticed));
  const overflow = await page.evaluate(() => {
    const sheet = document.getElementById('screenChiefOfStaff')!;
    return [...sheet.querySelectorAll('#recapProactiveCard, #recapPermissionsCard, #recapNoticedCard')].some((node) => node.scrollWidth > node.clientWidth + 1);
  });
  check('nothing overflows its card on a phone', !overflow);
  await page.$eval('#recapProactiveHead', (node) => node.scrollIntoView({ block: 'start' }));
  await shot('workplace-on-its-own-phone');
  await page.$eval('#recapPermissionsHead', (node) => node.scrollIntoView({ block: 'start' }));
  await shot('workplace-permissions-phone');

  // 4. At a desk.
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${ORIGIN}/chief-of-staff?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenChiefOfStaff #recapPermissionsCard', { timeout: 10_000 });
  await page.$eval('#recapProactiveHead', (node) => node.scrollIntoView({ block: 'start' }));
  await shot('workplace-on-its-own-desk');

  check('no console errors or failed requests', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${failures.length ? `${failures.length} FAILED: ${failures.join('; ')}` : 'ALL PASS'} — shots in ${OUT}`);
process.exit(failures.length ? 1 : 0);
