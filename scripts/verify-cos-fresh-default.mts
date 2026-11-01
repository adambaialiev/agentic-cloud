// Note #747 (the owner, 2026-10-12, testing as a fresh user): "picker should
// show models and default should be set as opus high, even if subscription
// is not yet connected", then "model picker screen should be disabled if
// user hasn't yet connected the subscription". In real Chrome against the
// real router, an account made the way the register route makes it — its
// first-run workplace, no Claude or ChatGPT sign-in, no agent:
//
//  1. Home's header names the default, opus · high, instead of
//     "Model & effort".
//  2. The Chief of Staff's model & effort page lists every model with Opus
//     current and High checked — not "No model choices are available." —
//     and is read-only: every row and level held, a line saying a
//     subscription opens it, and a button to the Subscriptions screen.
//  3. A tap on a model changes nothing; once a ChatGPT plan is connected the
//     default is GPT-6.1 Sol at high and the page opens: a pick is saved.
//
// Screenshots land in OUT_DIR (~/n747/shots by default), phone and desk,
// named with LABEL (after by default). LABEL=before runs against a build of
// the old code and records its failures without stopping at them.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-cos-fresh-default.mts
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
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n747/shots');
const LABEL = process.env.LABEL || 'after';
mkdirSync(OUT, { recursive: true });

/** The Chrome puppeteer downloaded, whichever build it is. */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4247);
const ORIGIN = `http://127.0.0.1:${PORT}`;
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
// No established-workplace patch: the workplace arrives bare, with no seat.
const orgStorage = new InMemoryOrgStorage();
const agentLifecycle = {
  agentChatMessages: async () => [],
  isAgentWorking: () => false,
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
const EVERY_MODEL = 'GPT-6 Astra|GPT-6.1 Sol|GPT-6.1 Terra|GPT-6 Sol|GPT-6 Luna|GPT-5.6 Sol|GPT-5.6 Terra|GPT-5.6 Luna|GPT-5.5|Fable|Opus|Sonnet';

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
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
      || (response.status() === 404 && url.pathname === '/workspace/api/recap')
      || (response.status() === 503 && url.pathname === '/workspace/api/org/signin');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${LABEL}-${name}.png`) as `${string}.png` });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
  const soon = (fn: string) => page.waitForFunction(fn, { timeout: 5_000 }).then(() => true, () => false);

  // The account, as the register route makes it: a first-run workplace of
  // its own, no seat, no agent.
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'adam@example.com', { firstName: 'Adam', lastName: 'Fresh' });
  const org = await orgStorage.createOrg({ name: 'Adam’s workplace', createdByUserId: account.userId, setupRequired: true, unnamed: true, foundingPending: true, firstRun: true });
  await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  await orgStorage.addMember({ orgId: org.orgId, userId: account.userId, role: 'admin' });
  await orgStorage.setActiveOrg(account.userId, org.orgId);
  await userStorage.updateProfile(account.userId, { person: { firstName: 'Adam', lastName: 'Fresh' } } as never);
  check('the account has no subscription and no agent',
    (await orgStorage.listSeatsByMember(org.orgId, account.userId)).length === 0
      && Object.keys((await userStorage.getProfile(account.userId))?.telegram?.agents ?? {}).length === 0);

  const fresh = async (width: number, height: number, label: string) => {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenHome #recapChatRuntime', { timeout: 15_000 });
    await page.waitForSelector('#firstRunStarters', { timeout: 15_000 }).catch(() => {});
    await soon(`document.getElementById('recapChatRuntime')?.textContent === 'opus · high'`);
    await pause(300);
    const header = (await texts('#recapChatRuntime'))[0];
    check(`${label}: the header names the default, opus · high`, header === 'opus · high', header);
    await shot(`home-${label}`);

    await page.click('#recapChatRuntime');
    await page.waitForSelector('#screenRecapRuntime', { timeout: 10_000 });
    await soon(`document.querySelector('#recapRuntimeModels .crow.current')?.textContent?.includes('Opus')`);
    await pause(300);
    const listed = await texts('#recapRuntimeModels .crow .name');
    const open = await page.$$eval('#recapRuntimeModels button.crow, #recapRuntimeEfforts .effortstep:not(.current)', (nodes) => nodes.filter((node) => !(node as HTMLButtonElement).disabled).length);
    check(`${label}: the picker lists every model, and nothing on it can be picked yet`,
      listed.join('|') === EVERY_MODEL && open === 0 && !listed.some((name) => name.includes('unavailable')), JSON.stringify({ listed, open }));
    const why = (await texts('#recapRuntimeLockWhy'))[0];
    const door = (await texts('#recapRuntimeConnect'))[0];
    check(`${label}: it says a subscription opens it, with the button to connect one`,
      why === 'Connect a Claude or ChatGPT subscription to change the model and effort.' && door === 'Connect a subscription'
        && !(await page.$('#recapRuntimeHint')), JSON.stringify({ why, door }));
    const current = await page.$eval('#recapRuntimeModels .crow.current', (node) => node.textContent?.trim() ?? '').catch(() => '');
    const levels = await texts('#recapRuntimeEfforts [role="radio"]');
    const checked = await page.$eval('#recapRuntimeEfforts [role="radio"][aria-checked="true"]', (node) => node.textContent).catch(() => '');
    check(`${label}: Opus is current, with its levels and High checked`,
      current.includes('Opus') && levels.join('|') === 'Medium|High|Extra high|Max' && checked === 'High',
      JSON.stringify({ current, levels, checked }));
    const page_ = (await texts('#screenRecapRuntime'))[0] ?? '';
    check(`${label}: no "No model choices" and no "Effort choices follow the model"`,
      !page_.includes('No model choices are available.') && !page_.includes('Effort choices follow the model.'));
    await shot(`picker-${label}`);
  };
  await fresh(1280, 860, 'desk');
  await fresh(390, 844, 'phone');

  // A tap before the sign-in changes nothing, and the button opens Subscriptions.
  const tapRow = async (name: string) => {
    for (const row of await page.$$('#recapRuntimeModels .crow')) {
      if ((await row.evaluate((node) => node.querySelector('.name')?.textContent)) === name) { await row.click(); return; }
    }
  };
  await tapRow('GPT-6 Astra');
  await pause(500);
  const still = await page.$eval('#recapRuntimeModels .crow.current', (node) => node.textContent?.trim() ?? '').catch(() => '');
  check('a tap before any sign-in changes nothing and saves nothing',
    still.includes('Opus') && !(await orgStorage.getMembership(org.orgId, account.userId))?.workspaceAgentSettings, still);
  await page.click('#recapRuntimeConnect');
  check('"Connect a subscription" opens the Subscriptions screen',
    await page.waitForSelector('#screenSeats', { timeout: 10_000 }).then(() => true, () => false));

  // Signed in to ChatGPT: the default follows it, and the page opens.
  await orgStorage.addSeat({
    orgId: org.orgId, userId: account.userId, provider: 'codex',
    token: 'harness-seat-token', label: 'ChatGPT · harness', status: 'active',
  } as never);
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatRuntime', { timeout: 15_000 });
  await soon(`document.getElementById('recapChatRuntime')?.textContent === 'gpt-6.1-sol · high'`);
  const signed = (await texts('#recapChatRuntime'))[0];
  check('once ChatGPT is connected, the default is gpt-6.1-sol · high', signed === 'gpt-6.1-sol · high', signed);
  await page.click('#recapChatRuntime');
  await page.waitForSelector('#screenRecapRuntime', { timeout: 10_000 });
  await soon(`document.querySelector('#recapRuntimeModels .crow.current')?.textContent?.includes('GPT-6.1 Sol')`);
  await pause(300);
  check('…and the page opens: no lock, the ChatGPT models pickable',
    !(await page.$('#recapRuntimeLock')) && (await page.$$eval('#recapRuntimeModels button.crow', (nodes) => nodes.length > 0 && nodes.every((node) => !(node as HTMLButtonElement).disabled))));
  await tapRow('GPT-6 Astra');
  const landed = await soon(`document.querySelector('#recapRuntimeModels .crow.current')?.textContent?.includes('GPT-6 Astra')`);
  const stored = (await orgStorage.getMembership(org.orgId, account.userId))?.workspaceAgentSettings;
  check('a pick after the sign-in is saved',
    landed && stored?.cli === 'codex' && stored.model === 'gpt-6-astra' && stored.effort === 'high', JSON.stringify({ landed, stored }));
  await pause(200);
  await shot('signed-in-phone');

  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed (${LABEL}).` : `\nAll checks passed (${LABEL}).`);
process.exit(failures.length && LABEL !== 'before' ? 1 : 0);
