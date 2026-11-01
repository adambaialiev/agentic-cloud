// Note #718 (the owner, 2026-10-11): two things around Home, in real Chrome
// against a real workplace with nine agents.
//
//  1. THE LOADING SKELETON is the shape of Home — the Chief of Staff's
//     conversation — and not the old Workplace page: a held header with the
//     face and the name, the pane, and the message box with the door to the
//     agents before it (it promised rooms too until note #843), standing in
//     the chat's viewport-tall shell
//     so the real Home lands on it without a jump. Held by keeping the
//     workspace read unanswered, then released.
//  2. THE MODEL & EFFORT PICKERS show their choices the moment they open,
//     with the read still unanswered: the Chief of Staff's (the catalog of
//     every harness the workplace reaches, no current pair yet) and an
//     agent's (its harness's catalog with the current pair marked); the read,
//     released, lands over it.
//  3. NOTE #735: the Chief of Staff's header never says "Model & effort" over
//     a choice this browser has already seen. A browser that never saw one
//     keeps the general words; after one visit, a fresh open with the
//     settings read held (a slow network) draws the remembered pair, and its
//     picker opens with that pair marked.
//
// Screenshots land in OUT_DIR (~/n718-proof by default), phone and desk.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-home-skeleton-pickers.mts
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n718-proof');
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

const PORT = Number(process.env.PORT || 4232);
const AGENT_CHAT_PATH = '/chat/alex';
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
harnessEstablishedWorkplace(orgStorage);

/** The agents' conversations are scenery here; only Clara is working. */
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: (_userId: string, agentId: string) => agentId === 'clara',
  agentActivity: () => null,
  listManagedJobs: async () => ({ jobs: [], recent: [] }),
} as unknown as RouteDeps['agentLifecycle'];

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
      || (response.status() === 503 && url.pathname === '/workspace/api/drive');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const box = (selector: string) => page.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  });
  const names = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));

  // Reads held back, by path, until released: the way to see a wait in a
  // browser that answers in two milliseconds.
  const holding = new Set<string>();
  const held: Array<{ path: string; request: import('puppeteer-core').HTTPRequest }> = [];
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (holding.has(pathname)) { held.push({ path: pathname, request }); return; }
    void request.continue();
  });
  const release = async (pathname: string) => {
    holding.delete(pathname);
    for (const one of held.splice(0).filter((one) => one.path === pathname)) await one.request.continue();
  };

  // 1. The workplace: nine agents, a short conversation with the Chief of
  //    Staff on Opus · high.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (id: string, name: string, minutesAgo: number, recap: string, cli = 'claude', model = 'opus', effort = 'xhigh') => [id, {
    id, name, cli, createdAt: iso(60 * 24 * 4), serverId: `m-${id}`,
    connectedAt: iso(60 * 24 * 4), model, effort,
    lastActivityAt: iso(minutesAgo), recap: { text: recap, at: iso(minutesAgo) },
  }] as const;
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: Object.fromEntries([
        seed('alex', 'Alex', 2, 'Built the agents picker.'),
        seed('ada', 'Ada', 16, 'Trimmed the agent instruction file.', 'codex', 'gpt-6-sol', 'high'),
        seed('oscar', 'Oscar', 62, 'Token ledger on Subscriptions.'),
        seed('iris', 'Iris', 60 * 26, 'Workplace deletion gate.'),
        seed('ben', 'Ben', 60 * 27, 'Reset finished agents.'),
        seed('noah', 'Noah', 34, 'Landing storyboard.'),
        seed('rosa', 'Rosa', 75, 'Checked the delete gate.'),
        seed('clara', 'Clara', 11, 'Leaderboard working time.'),
        seed('willow', 'Willow', 60 * 3, 'Product page.'),
      ]) as never,
    },
  });
  const at = iso(30);
  await orgStorage.touchMember(org.orgId, account.userId, {
    workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
    workspaceRecapChat: {
      messages: [
        { id: 'o1', role: 'owner', text: 'What is everyone working on this morning?', at },
        { id: 'a1', role: 'assistant', at, text: 'Platform: Alex is finishing the agents picker and Oscar is checking the token ledger. Growth: Clara is on the Leaderboard and Noah on the landing storyboard. Nothing is waiting for your decision.' },
      ],
      receipts: [],
      pending: [],
    },
  } as never);

  // 2. The skeleton, on a phone: the workspace read held, Home's wait is the
  //    conversation's shape, in the chat's shell.
  const skeletonShape = async (width: number, height: number, label: string) => {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    holding.add('/workspace/api/state');
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#workplaceLoadingSkeleton', { timeout: 15_000 });
    await pause(250);
    const shape = await page.evaluate(() => {
      const wait = document.getElementById('workplaceLoadingSkeleton')!;
      return {
        face: Boolean(wait.querySelector('.chathead .chatface .skel.face')),
        name: Boolean(wait.querySelector('.chathead .chatwho h1 .skel')),
        pane: Boolean(wait.querySelector('.chatpane')),
        turns: wait.querySelectorAll('.chatmsg').length,
        door: Boolean(wait.querySelector('.chatbar .chatagents.chatwaitagents')),
        boxAndSend: Boolean(wait.querySelector('.chatbar .chatinput')) && Boolean(wait.querySelector('.chatbar .skel-send')),
        oldPage: Boolean(wait.querySelector('.recapbrief, .seatstrip, .workplace-loading-nav')),
        shell: document.body.classList.contains('agent-chat-open'),
        words: wait.querySelector('[role="status"]')?.textContent,
      };
    });
    check(`${label}: the wait is the conversation's shape — face, name, pane, door, box and Send, no turns, not the old page`,
      shape.face && shape.name && shape.pane && shape.turns === 0 && shape.door && shape.boxAndSend && !shape.oldPage && shape.shell
        && shape.words === 'Loading your workplace…', JSON.stringify(shape));
    const headWait = await box('#workplaceLoadingSkeleton .chathead');
    const barWait = await box('#workplaceLoadingSkeleton .chatbar');
    check(`${label}: the held header stands at the top and the held box on the bottom edge`,
      headWait.top === 0 && headWait.height <= 56 && barWait.bottom === height, JSON.stringify({ headWait, barWait }));
    await shot(`skeleton-${label}`);
    // Released: Home lands in the same boxes.
    await release('/workspace/api/state');
    await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
    await page.waitForSelector('#agentChatSwitch', { timeout: 10_000 });
    await pause(250);
    const headHome = await box('#screenHome > .chathead');
    const barHome = await box('#screenHome .chatbar');
    const bodyClass = await page.evaluate(() => document.body.className);
    check(`${label}: Home's header and message box land where the held ones stood`,
      headHome.top === headWait.top && Math.abs(headHome.height - headWait.height) <= 1
        && barHome.bottom === barWait.bottom && Math.abs(barHome.height - barWait.height) <= 1,
      JSON.stringify({ headWait, headHome, barWait, barHome, bodyClass }));
    check(`${label}: the wait is gone`, !(await page.$('#workplaceLoadingSkeleton')));
    await shot(`home-${label}`);
  };
  await skeletonShape(390, 844, 'phone');
  await skeletonShape(1280, 860, 'desk');

  // 3. The Chief of Staff's picker on a cold open: its settings read held,
  //    the choices stand at once — Codex and Claude, since the workplace
  //    reaches both — with no current pair; released, the pair lands.
  const chiefPicker = async (width: number, height: number, label: string) => {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    // A browser that has never seen the Chief of Staff's choice: the visits
    // above already have (note #735), so their memory is taken away first.
    await page.evaluate(() => localStorage.removeItem('agentbuilt.privateRuntimes'));
    holding.add('/workspace/api/recap/agent/settings');
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#recapChatRuntime', { timeout: 15_000 });
    await pause(400);
    check(`${label}: before its read the header offers the picker in general words`, (await names('#recapChatRuntime'))[0] === 'Model & effort');
    await page.click('#recapChatRuntime');
    await page.waitForSelector('#screenRecapRuntime', { timeout: 10_000 });
    await pause(200);
    const listed = await names('#recapRuntimeModels .crow .name');
    check(`${label}: the Chief of Staff's picker lists both catalogs at once`,
      listed.join('|') === 'GPT-6 Astra|GPT-6.1 Sol|GPT-6.1 Terra|GPT-6 Sol|GPT-6 Luna|GPT-5.6 Sol|GPT-5.6 Terra|GPT-5.6 Luna|GPT-5.5|Fable|Opus|Sonnet'
        && !(await page.$('#recapRuntimeModels .crow.current'))
        && (await names('#recapRuntimeEfforts'))[0] === 'Effort choices follow the model.'
        && !(await page.$$eval('#screenRecapRuntime', (nodes) => nodes.some((node) => node.textContent?.includes('Loading choices')))),
      listed.join('|'));
    await shot(`picker-chief-${label}`);
    await release('/workspace/api/recap/agent/settings');
    await page.waitForFunction(() => document.querySelector('#recapRuntimeModels .crow.current')?.textContent?.includes('Opus'), { timeout: 10_000 });
    const after = await names('#recapRuntimeModels .crow .name');
    check(`${label}: the read lands over it — Opus current, High checked, the list unchanged`,
      after.join('|') === listed.join('|')
        && (await page.$eval('#recapRuntimeEfforts [role="radio"][aria-checked="true"]', (node) => node.textContent)) === 'High',
      JSON.stringify({ after }));
    await shot(`picker-chief-${label}-landed`);

    // Note #735: the next fresh open, on a slow network — the settings read
    // held — draws the pair this browser last saw, never the placeholder.
    holding.add('/workspace/api/recap/agent/settings');
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#recapChatRuntime', { timeout: 15_000 });
    await pause(400);
    check(`${label}: a fresh open with its read held draws the remembered model and effort`,
      (await names('#recapChatRuntime'))[0] === 'opus · high', JSON.stringify(await names('#recapChatRuntime')));
    await shot(`home-chief-${label}-remembered`);
    await page.click('#recapChatRuntime');
    await page.waitForSelector('#screenRecapRuntime', { timeout: 10_000 });
    await pause(200);
    const marked = await page.$eval('#recapRuntimeModels .crow.current', (node) => node.textContent?.trim() ?? '').catch(() => '');
    check(`${label}: …and its picker opens with that pair marked, before the read`,
      marked.includes('Opus') && (await page.$eval('#recapRuntimeEfforts [role="radio"][aria-checked="true"]', (node) => node.textContent).catch(() => '')) === 'High',
      marked);
    await release('/workspace/api/recap/agent/settings');
    await pause(300);
  };
  await chiefPicker(390, 844, 'phone');
  await chiefPicker(1280, 860, 'desk');

  // 4. An agent's picker on a cold open, from its conversation header:
  //    Alex runs Claude on Opus · Extra high, and its picker says so before
  //    the runtime read answers.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  holding.add('/workspace/api/agents/alex/runtime');
  await page.goto(`${ORIGIN}${AGENT_CHAT_PATH}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#agentChatStatus', { timeout: 15_000 });
  await page.click('#agentChatStatus');
  await page.waitForSelector('#screenAgentRuntime', { timeout: 10_000 });
  await pause(200);
  const alexModels = await names('#agentRuntimeModels .crow .name');
  const alexCurrent = await page.$eval('#agentRuntimeModels .crow.current', (node) => node.textContent?.trim() ?? '').catch(() => '');
  const alexLevels = await names('#agentRuntimeEfforts [role="radio"]');
  const alexChecked = await page.$eval('#agentRuntimeEfforts [role="radio"][aria-checked="true"]', (node) => node.textContent).catch(() => '');
  check('Alex’s picker opens complete before its read: the Claude catalog, Opus current, Extra high checked',
    alexModels.join('|') === 'Fable|Opus|Sonnet' && alexCurrent.includes('Opus') && alexLevels.join('|') === 'Medium|High|Extra high|Max' && alexChecked === 'Extra high',
    JSON.stringify({ alexModels, alexCurrent, alexLevels, alexChecked }));
  await shot('picker-agent-phone');
  await release('/workspace/api/agents/alex/runtime');
  await pause(400);
  check('…and the read changes nothing it already had right',
    (await names('#agentRuntimeModels .crow .name')).join('|') === 'Fable|Opus|Sonnet'
      && (await page.$eval('#agentRuntimeModels .crow.current', (node) => node.textContent ?? '')).includes('Opus'));

  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('\nHome skeleton and picker browser verification passed.');
}
