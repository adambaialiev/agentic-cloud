// Note #726: the new onboarding, in real Chrome against the real router and
// the real Chief of Staff conversation service. The four pictures of Rosa's
// design, phone and desk:
//
//  1. Create account, and Home opens at once on the greeting — by first
//     name — with the three starter answers; no setup gate, no agents.
//  2. A starter tapped: the words land as the person's message, the fixed
//     sign-in ask answers them, the picker card stands under it, and no
//     turn runs. A second message is kept too.
//  3. The plan lands (the harness stamps the seat and fires the same hook
//     the sign-in does): the receipt row, the setup line, the agents
//     brought in as rows, the plan reply, and the progress card under the
//     log moving from Starting… to Ready.
//  4. The sign-in card is gone once the plan is in; the arriving card is
//     gone once every agent is ready.
//
// Screenshots land in OUT_DIR (~/n726-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-first-run-onboarding.mts
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
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n726-proof');
mkdirSync(OUT, { recursive: true });

/** The Chrome puppeteer downloaded, whichever build it is — resolved rather
 *  than pinned, so a machine rebuild does not strand this script. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4233);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
// No established-workplace patch here: the account workplace must arrive bare, as the register route makes it.

import { addMemberSeat } from '../backend/src/services/org-seat-signin.js';
import { addTelegramAgentRecord, type AgentRecord } from '../backend/src/types/user.js';
import { agentBroughtInReceipt } from '../backend/src/shared/first-run.js';

/**
 * The Chief of Staff's first turn, played by the harness: no model and no
 * machine here, so the turn does what the real one does through the CLI —
 * brings two agents in (their records, then their computers
 * "built" over a few seconds), leaves the receipts — and answers with the
 * plan in Rosa's shape. The platform-side words the screen draws (the
 * greeting, the ask, the receipt of the plan) come from the real service.
 */
const PLAN = 'Here\'s the plan for **Meal planner**:\n- **Juno** builds the waitlist page and puts it live.\n- **Ivy** writes your first knowledge page: who the app is for and what comes first. Every agent reads it before a job.\n\nThey\'re starting now. I\'ll tell you when the page is up.';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
let firstTurn: { userId: string; orgId: string } | null = null;
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: () => false,
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
  endWorkspaceAgentTurn: async () => 'none',
  converseWorkspaceRecap: async (userId: string, orgId: string, _prompt: string, _settings: unknown, onPhase?: (phase: string) => Promise<void>) => {
    firstTurn = { userId, orgId };
    try { return await firstTurnOf(userId, orgId, onPhase); } catch (error) { console.error('[harness] the first turn failed:', error); throw error; }
  },
} as unknown as RouteDeps['agentLifecycle'];
async function firstTurnOf(userId: string, orgId: string, onPhase?: (phase: string) => Promise<void>) {
  {
    await onPhase?.('Getting your Chief of Staff ready…');
    await sleep(5000);
    await onPhase?.('Thinking…');
    await sleep(1200);
    // No room to open since note #843: `agent create` brings each agent
    // into the workplace itself.
    const ids: string[] = [];
    for (const name of ['Juno', 'Ivy']) {
      const profile = (await userStorage.getProfile(userId))!;
      const telegram = profile.telegram ?? { chatId: '1', linkedAt: iso(0), notificationsEnabled: true, agents: {} };
      const added = addTelegramAgentRecord(telegram as never, 'claude', name, undefined, orgId);
      const record: AgentRecord = { ...added.agents[added.agentId]!, planned: true } as AgentRecord;
      await userStorage.updateProfile(userId, { telegram: { ...telegram, agents: { ...added.agents, [added.agentId]: record } } as never });
      ids.push(added.agentId);
      await deps.workspaceAgent!.receipt(userId, orgId, agentBroughtInReceipt(name));
      await sleep(400);
    }
    // Their computers, over the next seconds: planned → being built → ready.
    void (async () => {
      const move = async (id: string, fields: Record<string, unknown>) => { await userStorage.updateAgentFields(userId, id, fields as never); };
      await sleep(3000); await move(ids[0]!, { planned: null, serverId: 'm-juno' });
      await sleep(3000); await move(ids[1]!, { planned: null, serverId: 'm-ivy' });
      await sleep(4000); await move(ids[0]!, { connectedAt: iso(0) });
      await sleep(4000); await move(ids[1]!, { connectedAt: iso(0) });
    })();
    return { text: PLAN };
  }
}

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  secretStorage: new InMemorySecretStorage(),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle,
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
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico')
      || (response.status() === 503 && url.pathname === '/workspace/api/drive')
      // This harness wires neither the briefing nor the sign-in ceremony: the
      // recap card's read and the sign-in page's start answer as unavailable.
      || (response.status() === 404 && url.pathname === '/workspace/api/recap')
      || (response.status() === 503 && url.pathname === '/workspace/api/org/signin');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
  const rows = () => page.$$eval('#recapChatLog .chatmsg', (nodes) => nodes.map((node) => node.textContent?.trim().replace(/\s+/g, ' ') ?? ''));

  // 1. Create account — the way the register route does, with the account
  //    workplace made beside it — and open Home.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'samira@example.com', { firstName: 'Samira', lastName: 'Khan' });
  const org = await orgStorage.createOrg({ name: 'Samira’s workplace', createdByUserId: account.userId, setupRequired: true, unnamed: true, foundingPending: true, firstRun: true });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  await orgStorage.addMember({ orgId: org.orgId, userId: account.userId, role: 'admin' });
  await orgStorage.setActiveOrg(account.userId, org.orgId);
  const [me] = await userStorage.getAllUsers();
  await userStorage.updateProfile(me!.userId, { person: { firstName: 'Samira', lastName: 'Khan' } } as never);

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForSelector('#firstRunStarters', { timeout: 15_000 });
  check('Home opens at once: no setup gate', !(await page.$('#requiredSetup')) && new URL(page.url()).pathname === '/');
  check('the greeting, by first name', (await rows())[0] === 'Hi Samira, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.', (await rows())[0]);
  check('the three starter answers', (await texts('#firstRunStarters .chatstarter')).join('|') === 'Put a waitlist page live for my idea.|Look at my website and tell me what to fix first.|Set up a team for my startup.');
  check('no agents were made', Object.keys((await userStorage.getProfile(account.userId))?.telegram?.agents ?? {}).length === 0);
  const state = await page.evaluate(async () => (await (await fetch('/workspace/api/state', { credentials: 'include' })).json()) as { org: { setupRequired?: boolean; founded?: boolean } });
  check('the state says nothing is required', !state.org.setupRequired, JSON.stringify(state.org));
  await shot('1-first-screen-phone');

  // 2. A starter tapped: the message, the ask, the card; no turn.
  await page.click('#firstRunStarters .chatstarter');
  await page.waitForSelector('#firstRunSignIn', { timeout: 15_000 });
  await pause(300);
  const afterTap = await rows();
  check('the tap sent the words, and the fixed ask answered them',
    afterTap[1] === 'Put a waitlist page live for my idea.' && afterTap[2] === 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.', JSON.stringify(afterTap));
  check('the starters are gone, the card stands with its two rows and its line',
    !(await page.$('#firstRunStarters')) && (await texts('#firstRunSignIn .crow .name')).join('|') === 'Claude|Codex'
      && (await texts('#firstRunSignInWhere'))[0] === 'You sign in on Claude\'s or OpenAI\'s own page, and your password never touches us.');
  check('no turn ran', firstTurn === null && !(await page.$eval('#recapChatLive', (node) => !(node as HTMLElement).hidden)));
  await shot('2-sign-in-when-needed-phone');
  // A second message before signing in.
  await page.type('#agentChatText', 'Also a logo, later.');
  await page.click('#agentChatSend');
  await page.waitForFunction(() => document.querySelectorAll('#recapChatLog .chatmsg').length >= 5, { timeout: 10_000 });
  const kept = await rows();
  check('another message is kept, and the reply points at the card above', kept.at(-1) === 'I\'ve kept that too. Sign in your plan above, and I\'ll start on all of it.' && Boolean(await page.$('#firstRunSignIn')), JSON.stringify(kept.slice(-2)));
  // The card's Claude row opens the sign-in page, with the way back to Home.
  await page.click('#firstRunSignIn .crow[data-provider="claude"]');
  await page.waitForFunction(() => location.pathname.endsWith('/seats/sign-in/claude'), { timeout: 10_000 });
  check('Claude opens its own sign-in page', new URL(page.url()).pathname.endsWith('/seats/sign-in/claude'));
  await page.goBack();
  await page.waitForSelector('#screenHome', { timeout: 10_000 });

  // 3. The plan lands: the same hook the sign-in fires.
  await addMemberSeat({ orgStorage, userId: account.userId, orgId: org.orgId, provider: 'claude', token: 'harness-token', label: 'Claude · harness' } as never);
  await deps.workplaceFounding!.foundIfReady(account.userId, org.orgId);
  await deps.workspaceAgent!.seatSignedIn!(account.userId, org.orgId, 'claude');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#recapChatLog .chatmsg')).some((node) => node.textContent?.includes('Your Claude plan is signed in.')), { timeout: 10_000 });
  check('the sign-in card is gone once the plan is in', !(await page.$('#firstRunSignIn')));
  await page.waitForFunction(() => document.getElementById('recapChatActivity')?.textContent === 'Getting your Chief of Staff ready…', { timeout: 10_000 }).catch(() => {});
  check('the setup line names the Chief of Staff', (await texts('#recapChatActivity'))[0] === 'Getting your Chief of Staff ready…', (await texts('#recapChatActivity'))[0]);
  await shot('3a-plan-landed-phone');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#recapChatLog .chatmsg')).some((node) => node.textContent?.includes('Here\'s the plan')), { timeout: 20_000 });
  await page.waitForSelector('#firstRunTeam', { timeout: 15_000 });
  await pause(300);
  const planned = await rows();
  check('the receipts and the plan, in order',
    !planned.some((row) => row.includes('the room')) && planned.some((row) => row.endsWith('Brought in Juno.')) && planned.some((row) => row.endsWith('Brought in Ivy.'))
      && planned.at(-1)!.startsWith('Here\'s the plan for Meal planner:'), JSON.stringify(planned.slice(-5)));
  // The card was headed by the room the agents arrived in until rooms left
  // the product (note #843): one card, "Arriving".
  check('the progress card: "Arriving" over the agents, with their words',
    (await texts('#firstRunTeam .arrivinghead')).join('|') === 'Arriving' && (await texts('#firstRunTeam .crow .name')).join('|') === 'Juno|Ivy'
      && (await texts('#firstRunTeam .crow .ctext')).every((line) => ['Starting…', 'Computer being built…', 'Ready'].includes(line)),
    JSON.stringify(await texts('#firstRunTeam .crow .ctext')));
  await shot('3-team-for-the-job-phone');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#firstRunTeam .crow .ctext')).some((node) => node.textContent === 'Computer being built…'), { timeout: 20_000 }).catch(() => {});
  await shot('3b-computers-being-built-phone');
  // It counted one room, the agents' unseen home, until rooms left the
  // product (note #843): the agents are the only thing the turn made.
  const workplaceAgents = Object.values((await userStorage.getProfile(account.userId))?.telegram?.agents ?? {})
    .filter((agent) => agent.orgId === org.orgId && !agent.purpose).map((agent) => agent.name).sort();
  check('no founding happened underneath: only the two agents the turn brought in', workplaceAgents.join('|') === 'Ivy|Juno', JSON.stringify(workplaceAgents));

  // 4. Every agent ready: the card goes, the roster has them.
  await page.waitForFunction(() => !document.getElementById('firstRunTeam'), { timeout: 40_000 });
  check('the arriving card is gone once every agent is ready', !(await page.$('#firstRunTeam')));
  await shot('4-team-ready-phone');

  // Desk: the same conversation, wide.
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  await pause(300);
  await shot('home-first-run-desk');
  // And a second account at a desk, for the first two pictures wide.
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  const two = await harnessSignedIn(page2, workspaceWebAuth, ORIGIN, 'noor@example.com', { firstName: 'Noor', lastName: 'Ali' });
  const org2 = await orgStorage.createOrg({ name: 'Noor’s workplace', createdByUserId: two.userId, setupRequired: true, unnamed: true, foundingPending: true, firstRun: true });
  await orgStorage.updateOrg(org2.orgId, { git: { namespaceId: org2.orgId } });
  await orgStorage.addMember({ orgId: org2.orgId, userId: two.userId, role: 'admin' });
  await orgStorage.setActiveOrg(two.userId, org2.orgId);
  await userStorage.updateProfile(two.userId, { person: { firstName: 'Noor', lastName: 'Ali' } } as never);
  await page2.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page2.waitForSelector('#firstRunStarters', { timeout: 15_000 });
  await page2.screenshot({ path: path.join(OUT, '1-first-screen-desk.png') });
  await page2.click('#firstRunStarters .chatstarter:nth-child(3)');
  await page2.waitForSelector('#firstRunSignIn', { timeout: 15_000 });
  await pause(300);
  await page2.screenshot({ path: path.join(OUT, '2-sign-in-when-needed-desk.png') });
  await page2.close();

  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('\nFirst-run onboarding browser verification passed.');
}
