// Note #753 (the owner, 2026-10-14): "As a user, I can create multiple
// workplaces with each own chief of staff. Chief of staff should be able to
// send message to another chief of staff, if user asks." In real Chrome
// against the real router and the real Chief of Staff conversation service,
// one person with two workplaces, Studio and Bakery, a plan signed in in each:
//
//  1. In Studio, the person asks their Chief of Staff to ask Bakery. Its turn
//     (played by the harness, through the same hook the CLI route calls)
//     passes the message across; Studio shows the receipt and its reply.
//  2. Bakery's Chief of Staff gets ONE row — "Chief of Staff in Studio" —
//     answers it, and that answer comes back into Studio as "Chief of Staff
//     in Bakery", where it starts a reaction.
//  3. Switching to Bakery shows its side: the message and its answer.
//
// Screenshots land in OUT_DIR (~/n753/shots by default), phone.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-cos-cross-workplace.mts
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
import { AGENT_REPLY_REACT_ASK, WORKPLACE_MESSAGE_ASK } from '../backend/src/services/workspace-recap-chat.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n753/shots');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4253);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(), userStorage, new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(), mailbox.config, mailbox.mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
// A plan signed in in every workplace the person joins: both can think.
harnessEstablishedWorkplace(orgStorage);

const ids = { studio: '', bakery: '', user: '' };
const prompts: Array<{ org: string; prompt: string }> = [];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Each Chief of Staff's turn, played by the harness: what a real turn would do through the CLI. */
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: () => false,
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
  endWorkspaceAgentTurn: async () => 'none',
  converseWorkspaceRecap: async (userId: string, orgId: string, prompt: string) => {
    prompts.push({ org: orgId, prompt });
    await sleep(600);
    if (orgId === ids.bakery && prompt.includes(WORKPLACE_MESSAGE_ASK)) {
      return { text: '14 orders came in today: 9 for pickup and 5 for delivery. The sourdough sold out by 11.' };
    }
    if (orgId === ids.studio && prompt.includes(AGENT_REPLY_REACT_ASK)) {
      return { text: 'Bakery had **14 orders** today — 9 pickup, 5 delivery — and the sourdough sold out by 11.' };
    }
    if (orgId === ids.studio) {
      const sent = await deps.workspaceAgent!.messageWorkplace!({
        userId, orgId, orgName: 'Studio', toOrgId: ids.bakery, toName: 'Bakery',
        message: 'Adam asks: how many orders came in today, and did anything sell out?',
      });
      return { text: sent.ok ? 'I\'ve asked your Chief of Staff in Bakery. I\'ll tell you what it says.' : `I could not reach Bakery: ${sent.reason}` };
    }
    return { text: 'Done.' };
  },
} as unknown as RouteDeps['agentLifecycle'];

const deps = {
  userStorage, workspaceWebAuth, mailboxes: mailbox.mailboxes, orgStorage,
  secretStorage: new InMemorySecretStorage(), workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'), workspaceUiDefault: 'react', agentLifecycle,
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
      || (response.status() === 404 && url.pathname === '/workspace/api/recap');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const log = () => page.$eval('#recapChatLog', (node) => node.textContent?.replace(/\s+/g, ' ') ?? '');

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'adam@example.com', { firstName: 'Adam', lastName: 'Owner' });
  ids.user = account.userId;
  ids.studio = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Studio' })).org.orgId;
  ids.bakery = (await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Bakery' })).org.orgId;
  await orgStorage.setActiveOrg(account.userId, ids.studio);

  // 1. Studio: the person asks.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.type('#agentChatText', 'Ask my Bakery workplace how many orders came in today.');
  await page.click('#agentChatSend');
  // The reaction is the last thing to land: it alone says "9 pickup".
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('9 pickup'), { timeout: 30_000 });
  await sleep(800);
  const studio = await log();
  check('Studio: the receipt says it went to the Chief of Staff in Bakery', studio.includes('Sent to Chief of Staff in Bakery'), studio.slice(0, 400));
  check('Studio: Bakery’s answer arrives as the Chief of Staff in Bakery’s message', studio.includes('Chief of Staff in Bakery') && studio.includes('14 orders came in today: 9 for pickup and 5 for delivery.'));
  check('Studio: the answer starts a reaction, and it is read back to the person', studio.includes('Bakery had 14 orders today'));
  check('Studio: the person reads no "Waiting for" once the answer is in', !(await page.$eval('#screenHome', (node) => node.textContent ?? '')).includes('Waiting for'));
  await page.evaluate(() => { const pane = document.querySelector('#screenHome .chatpane'); if (pane) pane.scrollTop = pane.scrollHeight; });
  await sleep(300);
  await shot('studio-phone');

  // 3. Bakery's side, as a fresh tab opens it: on the server's active
  // workplace, the tab's own memory of Studio taken away (note #628).
  await orgStorage.setActiveOrg(account.userId, ids.bakery);
  await page.evaluate(() => sessionStorage.removeItem('acc.standingWorkplace'));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForFunction(() => document.getElementById('recapChatLog')?.textContent?.includes('sourdough sold out by 11'), { timeout: 15_000 });
  await sleep(500);
  const bakery = await log();
  check('Bakery: one message from the Chief of Staff in Studio, and its answer', bakery.includes('Chief of Staff in Studio') && bakery.includes('how many orders came in today, and did anything sell out?') && bakery.includes('14 orders came in today'), bakery.slice(0, 400));
  check('Bakery: nothing of Studio’s own conversation crossed over', !bakery.includes('Ask my Bakery workplace'));
  await shot('bakery-phone');

  check('each Chief of Staff thought once per turn: Studio twice, Bakery once', prompts.filter((p) => p.org === ids.studio).length === 2 && prompts.filter((p) => p.org === ids.bakery).length === 1, JSON.stringify(prompts.map((p) => p.org === ids.studio ? 'studio' : 'bakery')));
  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
