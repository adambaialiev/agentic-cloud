// Note #447: drive the built Workspace through the Chief of Staff's private
// runtime picker. The fixture starts as a pre-split membership with only the
// old shared recap setting; the picker starts on that inherited value,
// changes the Agent, and proves both the screen and storage keep the two
// model/effort pairs independent — the recap's stays where it was.
//
// Since note #656 the Workspace Agent is hidden, so its picker is reached
// from its conversation header. Since 2026-10-10 that conversation IS Home
// (/), and since note #715 it is the Chief of Staff's.
//
// The recap had a picker of its own, on the room's briefing card, and this
// check drove that one too, until rooms left the product (note #843): the
// briefing card went with the room view, so the recap's picker is drawn
// nowhere — and this proves it is not left standing anywhere either.
//
//   npm --prefix backend run build
//   OUT_DIR=/tmp/workspace-runtime-split backend/node_modules/.bin/tsx scripts/verify-workspace-runtime-split.mts

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
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';
import { openAgentsPicker, openWorkplaceWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'workspace-runtime-split-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().at(-1);
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
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
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
} as unknown as RouteDeps;
const app = express();
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

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'runtime-owner@example.com');
  await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Runtime studio' });

  const [org] = await orgStorage.listOrgs();
  const [owner] = await userStorage.getAllUsers();
  if (!org || !owner) throw new Error('the browser setup created no owner or workplace');
  const at = new Date().toISOString();
  await userStorage.updateProfile(owner.userId, {
    telegram: {
      ...(owner.telegram ?? {}),
      agents: {
        theo: {
          id: 'theo', name: 'Theo', cli: 'codex', orgId: org.orgId,
          serverId: 'fly_ia-theo.machine', connectedAt: at, createdAt: at,
        },
      },
    },
  });
  // Exactly the old shape: the recap has a setting and the Agent does not.
  const before = { cli: 'codex' as const, model: 'gpt-5.6-terra', effort: 'high' };
  await orgStorage.touchMember(org.orgId, owner.userId, { workspaceRecapSettings: before });

  // Home IS the conversation (since 2026-10-10), and its header is where the
  // Chief of Staff's picker is. Before the split the Agent ran on the one
  // shared setting, so that is what it starts on.
  await page.goto(`${ORIGIN}/?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#recapChatRuntime')?.textContent?.includes('gpt-5.6-terra'));
  await page.waitForSelector('#banner', { hidden: true, timeout: 7_000 });
  // Enrollment has an expected unauthenticated session read and favicon miss.
  consoleErrors.length = 0;

  // The recap's own picker stood on the room's briefing card (note #688),
  // and the card went with the room view (note #843): no control for it
  // anywhere a reader goes — Home, the agents picker, the Workplace window.
  const recapControls: string[] = [];
  const recapControlHere = async (where: string) => {
    if (await page.$('#overviewRuntimeControl, #workspaceRecap')) recapControls.push(where);
  };
  await recapControlHere('Home');
  await openAgentsPicker(page, ORIGIN);
  await recapControlHere('the agents picker');
  await openWorkplaceWindow(page, ORIGIN);
  await recapControlHere('the Workplace window');
  check('no briefing card and no recap picker stand anywhere: Home, the agents picker, the Workplace window',
    recapControls.length === 0, recapControls.join(', '));

  await page.goto(`${ORIGIN}/?org=${org.orgId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#recapChatRuntime')?.textContent?.includes('gpt-5.6-terra'));
  await page.click('#recapChatRuntime');
  await page.waitForSelector('#recapRuntimeTitle');
  check('the conversation opens the Chief of Staff picker',
    await page.$eval('#recapRuntimeTitle', (node) => node.textContent === 'Chief of Staff model & effort'));
  await page.screenshot({ path: path.join(OUT, 'agent-picker-phone.png') as `${string}.png`, fullPage: true });
  await settleAfterShot(page);
  await page.$$eval('#recapRuntimeModels button', (buttons) => buttons.find((button) => button.textContent?.includes('GPT-6 Astra'))?.click());
  await page.waitForFunction(() => document.querySelector('#recapRuntimeModels .current')?.textContent?.includes('GPT-6 Astra'));
  await page.$$eval('#recapRuntimeEfforts button', (buttons) => buttons.find((button) => button.textContent === 'Ultra')?.click());
  await page.waitForFunction(() => document.querySelector('#recapRuntimeEfforts .current')?.textContent === 'Ultra');
  await page.click('button.back');
  await page.waitForFunction(() => document.querySelector('#recapChatRuntime')?.textContent?.includes('gpt-6-astra'));

  const finalStored = await orgStorage.getMembership(org.orgId, owner.userId);
  check('changing the Agent leaves the recap on its own stored value',
    finalStored?.workspaceAgentSettings?.model === 'gpt-6-astra'
      && finalStored.workspaceAgentSettings.effort === 'ultra'
      && finalStored.workspaceRecapSettings?.model === before.model
      && finalStored.workspaceRecapSettings.effort === before.effort,
    JSON.stringify({ recap: finalStored?.workspaceRecapSettings, agent: finalStored?.workspaceAgentSettings }));
  await page.screenshot({ path: path.join(OUT, 'home-independent-phone.png') as `${string}.png` });
  await settleAfterShot(page);
  for (const width of [320, 390, 640]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    const geometry = await page.evaluate(() => {
      const runtime = document.getElementById('recapChatRuntime')!.getBoundingClientRect();
      return {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        runtimeRight: runtime.right,
      };
    });
    check(`the Chief of Staff's setting fits the header at ${width}px`,
      geometry.document === geometry.viewport
        && geometry.runtimeRight <= geometry.viewport,
      JSON.stringify(geometry));
  }

  check('the browser stayed clean', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
} finally {
  await browser.close();
  server.close();
}
