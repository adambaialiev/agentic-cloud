// Note #644: what working time looks like in real Chrome — the agent's
// "Worked" row, the person's "Agents worked" row naming a former agent, and
// the People page's workplace total. Screenshots land in
// ~/mini-preview/n644-*.png.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/shot-work-time-644.mts
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemoryAgentWorkLedger } from '../backend/src/services/agent-work-ledger.js';
import { AGENT_WORK_COUNTED_SINCE } from '../backend/src/services/agent-work-meter.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4189);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const H = 3_600_000;
const M = 60_000;

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
const agentWorkLedger = new InMemoryAgentWorkLedger();
const deps = {
  userStorage,
  workspaceWebAuth,
  orgStorage,
  agentWorkLedger,
  secretStorage: new InMemorySecretStorage(),
  quickNoteStorage: new InMemoryQuickNoteStorage(),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: process.env.WORKSPACE_UI_DIR || path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => console.log('PAGE ERROR', String(error)));

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'Baialiev' });
  const { org: orgDoc } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const me = { userId: account.userId };

  // One living agent, older than the counting; one deleted one the ledger still names.
  const profile = (await userStorage.getProfile(me.userId))!;
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(profile.telegram ?? { chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '1' }),
      agents: {
        'agent-ben': {
          id: 'agent-ben', name: 'Ben', cli: 'claude', createdAt: '2026-08-12T09:00:00.000Z', connectedAt: '2026-08-12T09:05:00.000Z',
          botStatus: 'active', orgId: orgDoc.orgId, serverId: 'fly_ia-ben.aa11', turnCount: 1204,
          recap: { text: 'Built the working-time ledger and the rows that read it.', at: new Date(Date.now() - 12 * M).toISOString() },
        },
        // The Workspace Agent: a record with a purpose, counted among the hours and never among the agents.
        'agent-ws': { id: 'agent-ws', name: 'Workspace Agent', cli: 'claude', createdAt: '2026-08-12T09:00:00.000Z', botStatus: 'active', orgId: orgDoc.orgId, purpose: 'workspace-briefing' },
      },
    } as never,
  });
  agentWorkLedger.credit({ userId: me.userId, agentId: 'agent-ben', orgId: orgDoc.orgId, agentName: 'Ben', month: '2026-09', ms: 41 * H + 20 * M });
  agentWorkLedger.credit({ userId: me.userId, agentId: 'agent-ruby', orgId: orgDoc.orgId, agentName: 'Ruby', month: '2026-09', ms: 3 * H + 10 * M });
  agentWorkLedger.credit({ userId: me.userId, agentId: 'agent-ws', orgId: orgDoc.orgId, agentName: 'Workspace Agent', month: '2026-09', ms: 25 * M });
  // The version card, as the record fills it in.
  (deps as { agentLifecycle?: unknown }).agentLifecycle = {
    isAgentWorking: () => false,
    agentActivity: () => null,
    agentVersion: async () => ({
      cliLabel: 'Claude Code', installed: '2.1.223', pinned: '2.1.223', cliUpdateAvailable: false, busy: false,
      machine: { awake: false, region: 'ams', regionName: 'Amsterdam', memoryMb: 2048, cpuKind: 'performance', cpus: 1 },
      model: 'Fable 5.1', effort: 'high', lastActiveAt: new Date(Date.now() - 12 * M).toISOString(),
      turnCount: 1204, workedMs: agentWorkLedger.agentTotal(me.userId, 'agent-ben'), workedSince: AGENT_WORK_COUNTED_SINCE,
      docs: { file: 'CLAUDE.md', version: 3, latest: 3, current: true },
    }),
  };

  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `n644-${name}.png`) as `${string}.png`, fullPage: false });
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 600); });

  await page.goto(`${ORIGIN}/agents/agent-ben?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent?.includes('Worked'), { timeout: 10_000 }).catch(async (error) => {
    console.log('agent screen text:', await page.evaluate(() => document.body.innerText.slice(0, 600)));
    throw error;
  });
  await settle();
  const workedRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.drow')];
    const row = rows.find((node) => node.querySelector('.k')?.textContent === 'Worked');
    return row?.textContent?.replace(/\s+/g, ' ').trim() ?? '(no Worked row)';
  });
  console.log(`agent: ${workedRow}`);
  await shot('agent');

  await page.goto(`${ORIGIN}/workplace/members/${me.userId}?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#orgMemberWorked', { timeout: 10_000 });
  await settle();
  console.log(`person: ${await page.$eval('#orgMemberWorked', (node) => node.textContent?.replace(/\s+/g, ' ').trim())}`);
  await shot('person');

  await page.goto(`${ORIGIN}/workplace/people?org=${orgDoc.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#peopleSub', { timeout: 10_000 });
  await settle();
  console.log(`people: ${await page.$eval('#peopleSub', (node) => node.textContent?.trim())}`);
  await shot('people');
} finally {
  await browser.close();
  server.close();
}
