// Note #820: the hello for a person who JOINS a workplace that already
// exists, in real Chrome against the real router and the real Chief of Staff
// conversation service.
//
//  1. Adam's workplace has work in it: his agents with what they last did
//     (one working now), and the workplace's notes.
//  2. Cara redeems Adam's invite and opens Home: her Chief of Staff greets
//     her by name, names the workplace, every agent in one Agents list with
//     what they did, and the latest notes as links — no starter answers.
//     It named each room with its agents, an empty room too, and kept the
//     Chief of Staff's own room's notes out, until rooms left the product
//     (note #843).
//  3. A note link opens that note. Back on Home, the hello is the same row.
//  4. She writes before any plan: the same sign-in ask as a founder's.
//  5. Her plan lands: an ordinary turn on what she wrote — never the first
//     run's "bring a team in" for a brand-new workplace.
//  6. Adam, the founder of an older workplace, gets no hello on his Home.
//
// Screenshots land in OUT_DIR (~/n820-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-joiner-welcome.mts
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
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { addMemberSeat } from '../backend/src/services/org-seat-signin.js';
import { addTelegramAgentRecord, type AgentRecord } from '../backend/src/types/user.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n820-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4236);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(), userStorage, new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
const quickNoteStorage = new InMemoryQuickNoteStorage();
const working = new Set<string>();
const prompts: string[] = [];
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: (_userId: string, agentId: string) => working.has(agentId),
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
  endWorkspaceAgentTurn: async () => 'none',
  converseWorkspaceRecap: async (_userId: string, _orgId: string, prompt: string) => {
    prompts.push(prompt);
    return { text: 'Juno is writing the launch email for the waitlist. Want me to ask Juno for the draft so you can read it first?' };
  },
} as unknown as RouteDeps['agentLifecycle'];
const deps = {
  userStorage, workspaceWebAuth, mailboxes: mailbox.mailboxes, orgStorage, quickNoteStorage,
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

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const adamPage = await (await browser.createBrowserContext()).newPage();
  const consoleErrors: string[] = [];
  const watch = (page: typeof adamPage) => {
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
        || (response.status() === 404 && url.pathname === '/favicon.ico')
        || (response.status() === 503 && url.pathname === '/workspace/api/drive')
        || (response.status() === 404 && url.pathname === '/workspace/api/recap')
        || (response.status() === 503 && url.pathname === '/workspace/api/org/signin');
      if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
    });
  };
  watch(adamPage);
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

  // 1. Adam's workplace, with work in it.
  const adam = await harnessSignedIn(adamPage, workspaceWebAuth, ORIGIN, 'adam@example.com', { firstName: 'Adam', lastName: 'Bay' });
  const { org } = await harnessWorkplace(orgStorage, { userId: adam.userId, name: 'Northwind Labs' });
  await userStorage.updateProfile(adam.userId, { person: { firstName: 'Adam', lastName: 'Bay' } } as never);
  const agent = async (name: string, recap: string, minutesAgo: number) => {
    const profile = (await userStorage.getProfile(adam.userId))!;
    const telegram = profile.telegram ?? { chatId: '1', linkedAt: iso(900), notificationsEnabled: true, agents: {} };
    const added = addTelegramAgentRecord(telegram as never, 'claude', name, undefined, org.orgId);
    const record = { ...added.agents[added.agentId]!, serverId: `m-${name}`, connectedAt: iso(900), recap: { text: recap, at: iso(minutesAgo) } } as AgentRecord;
    await userStorage.updateProfile(adam.userId, { telegram: { ...telegram, agents: { ...added.agents, [added.agentId]: record } } as never });
    return added.agentId;
  };
  await agent('Ruby', 'Put the new pricing page live and checked it on a phone. Waiting on Adam to approve the wording.', 30);
  await agent('Ben', 'Fixed the slow image loading on the home page; it now loads in under a second.', 240);
  working.add(await agent('Juno', 'Writing the launch email for the waitlist, from the team\'s notes.', 5));
  // The workplace's notes, at its one namespace (note #843).
  const note = async (html: string) => quickNoteStorage.create({ userId: org.orgId, html, createdByAgentId: 'user', createdByUserId: adam.userId, updatedByAgentId: 'user', updatedByUserId: adam.userId });
  await note('<h2>Launch checklist</h2><p>Ten things before we open the waitlist.</p>');
  await pause(5);
  await note('<h2>Who we are writing to</h2><p>Small teams running many agents.</p>');
  await pause(5);
  const latest = await note('<h2>Pricing ideas</h2><p>Per seat, or per agent?</p>');

  // 2. Cara joins through Adam's invite and opens Home on a phone.
  const page = await (await browser.createBrowserContext()).newPage();
  watch(page);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const cara = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'cara@example.com', { firstName: 'Cara', lastName: 'Diaz' });
  await userStorage.updateProfile(cara.userId, { person: { firstName: 'Cara', lastName: 'Diaz' } } as never);
  const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: adam.userId });
  const joined = await orgStorage.redeemInvite(invite.token, cara.userId);
  check('Cara joined through the invite', joined.ok);
  await orgStorage.setActiveOrg(cara.userId, org.orgId);
  const rows = () => page.$$eval('#recapChatLog .chatmsg', (nodes) => nodes.map((node) => (node as HTMLElement).innerText.trim()));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatLog .chatmsg', { timeout: 15_000 });
  await pause(300);
  const hello = (await rows())[0] ?? '';
  console.log(`--- the hello, as drawn ---\n${hello}\n---`);
  check('greets her by name and names the workplace', hello.startsWith('Hi Cara, welcome to Northwind Labs. I\'m your Chief of Staff here. Here\'s what\'s already going on.'), hello.split('\n')[0]);
  check('one Agents list: every agent with what it did, the working one first',
    /Agents\s+Juno, Adam's agent: Writing the launch email[^\n]*\s+Ruby, Adam's agent: Put the new pricing page live and checked it on a phone\.\s+Ben, Adam's agent: Fixed the slow image loading/.test(hello));
  check('the latest notes, newest first', /Latest notes\s+Pricing ideas\s+Who we are writing to\s+Launch checklist/.test(hello));
  check('it names no room', !/\broom/i.test(hello));
  check('drawn as a message, not as the founder\'s empty state (note #967)', !(await page.$('#chiefOfStaffEmpty')));
  check('it closes on an invitation to ask', hello.endsWith('Ask me about any of it, or tell me what you\'d like to work on.'));
  const bold = (await page.$$eval('#recapChatLog .chatmsg strong', (nodes) => nodes.map((node) => node.textContent))).join('|');
  check('the Agents heading and the agents\' names are bold', bold.split('|').includes('Agents') && bold.split('|').includes('Juno'), bold);
  await page.screenshot({ path: path.join(OUT, '1-joiner-welcome-phone.png'), fullPage: false });

  // 3. A note link opens the note; Back returns to the same hello.
  const href = await page.$eval('#recapChatLog .chatmsg a', (link) => link.getAttribute('href'));
  // The note's own address, which names no room since rooms left the
  // product (note #843).
  check('the newest note is a link to it', href === `/notes/${latest.number}?org=${encodeURIComponent(org.orgId)}`, href ?? '');
  await page.click('#recapChatLog .chatmsg a');
  await page.waitForFunction(() => location.pathname.startsWith('/notes/'), { timeout: 10_000 });
  await page.waitForFunction(() => document.body.innerText.includes('Per seat, or per agent?'), { timeout: 10_000 }).catch(() => {});
  check('the link opens the note', (await page.evaluate(() => document.body.innerText)).includes('Per seat, or per agent?'));
  await page.screenshot({ path: path.join(OUT, '2-note-from-the-hello-phone.png') });
  await page.goBack();
  await page.waitForSelector('#screenHome #recapChatLog .chatmsg', { timeout: 10_000 });
  check('the hello is written once', (await rows()).length === 1);

  // 4. She writes before any plan: the founder's sign-in ask, unchanged.
  await page.type('#agentChatText', 'What is Juno working on?');
  await page.click('#agentChatSend');
  await page.waitForSelector('#firstRunSignIn', { timeout: 15_000 });
  await pause(300);
  check('the sign-in ask answers, with the card', (await rows()).at(-1) === 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.');
  check('no turn ran without a plan', prompts.length === 0);
  await page.screenshot({ path: path.join(OUT, '3-sign-in-ask-phone.png') });

  // 5. Her plan lands: an ordinary turn, not a brand-new workplace's first run.
  await addMemberSeat({ orgStorage, userId: cara.userId, orgId: org.orgId, provider: 'claude', token: 'harness-token', label: 'Claude · harness' } as never);
  await deps.workspaceAgent!.seatSignedIn!(cara.userId, org.orgId, 'claude');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#recapChatLog .chatmsg')).some((node) => node.textContent?.includes('launch email for the waitlist. Want me')), { timeout: 20_000 });
  check('a turn answered her question', prompts.length === 1);
  check('…never the first run of a brand-new workplace', !prompts[0]!.includes('brand-new workplace'));
  check('…reading her hello and her question', prompts[0]!.includes('welcome to Northwind Labs') && prompts[0]!.includes('What is Juno working on?'));
  await pause(300);
  await page.screenshot({ path: path.join(OUT, '4-first-answer-phone.png') });

  // The hello at a desk, for the wide picture.
  const desk = await (await browser.createBrowserContext()).newPage();
  watch(desk);
  await desk.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  const dev = await harnessSignedIn(desk, workspaceWebAuth, ORIGIN, 'devrao@example.com', { firstName: 'Dev', lastName: 'Rao' });
  await userStorage.updateProfile(dev.userId, { person: { firstName: 'Dev', lastName: 'Rao' } } as never);
  const devJoined = await orgStorage.redeemInvite((await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: adam.userId })).token, dev.userId);
  check('a second person joins through an invite', devJoined.ok);
  await orgStorage.setActiveOrg(dev.userId, org.orgId);
  await desk.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await desk.waitForSelector('#screenHome #recapChatLog .chatmsg', { timeout: 15_000 });
  await pause(300);
  check('a second joiner gets his own hello', ((await desk.$eval('#recapChatLog .chatmsg', (node) => (node as HTMLElement).innerText)) ?? '').startsWith('Hi Dev, welcome to Northwind Labs.'));
  await desk.screenshot({ path: path.join(OUT, '5-joiner-welcome-desk.png') });

  // 6. The founder of this older workplace: no hello on his own Home.
  await adamPage.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await adamPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await adamPage.waitForSelector('#screenHome #recapChatLog .chatempty, #screenHome #recapChatLog .chatmsg', { timeout: 15_000 });
  const founderRows = await adamPage.$$eval('#recapChatLog .chatmsg', (nodes) => nodes.map((node) => node.textContent));
  check('the founder gets no welcome to his own workplace', founderRows.length === 0 && Boolean(await adamPage.$('#recapChatLog .chatempty')), JSON.stringify(founderRows));

  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('\nJoiner welcome browser verification passed.');
}
