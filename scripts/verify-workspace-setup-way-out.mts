// Drives real Chrome for note #653: a person who belongs to two workplaces
// switches into a bare one — no subscription of theirs in it — and must be
// able to switch back to the other from there. That bare workplace used to
// stand behind the setup gate ("Connect your Fly cloud", then "Sign in a
// subscription" since note #664), with a way out drawn under the gate's
// card. Since note #726 there is no gate: the bare workplace is Home like
// any other — the Chief of Staff's conversation — and the way out is the
// workplace switch in Home's own header (note #715), so that is what is
// read here. Screenshots land in ~/mini-preview/n653-*.png.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-setup-way-out.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';
import { tap } from './browser-settle.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4183);
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
const orgStorage = new InMemoryOrgStorage();
// The FIRST workplace has a seat of this person's. The second one below is
// created past this patch on purpose, so it is exactly what a fresh
// workplace is: no subscription of this person's in it yet.
harnessEstablishedWorkplace(orgStorage);

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle: {},
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
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const text = async (selector: string) => page.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '').catch(() => '(none)');
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `n653-${name}.png`) as `${string}.png`, fullPage: true });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const home = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  // The second workplace: a member of it with no subscription there. Past
  // the harness patch on purpose, both the workplace and the membership: the
  // patch would hand it a seat. And its welcome is spent — the subscription
  // this person uses in Nomad Trading was carried in once and taken back out
  // (an explicit choice the product keeps). Nothing stands in front of it
  // since note #726: no cloud, no subscription step — a missing plan is
  // asked for inside the Chief of Staff's chat, when the person writes.
  const bare = await InMemoryOrgStorage.prototype.createOrg.call(orgStorage, { name: 'Side Hustle', createdByUserId: 'someone-else' });
  await orgStorage.updateOrg(bare.orgId, { git: { namespaceId: bare.orgId } });
  await InMemoryOrgStorage.prototype.addMember.call(orgStorage, { orgId: bare.orgId, userId: account.userId, role: 'admin' });
  await orgStorage.touchMember(bare.orgId, account.userId, { inheritedSeatsAt: new Date().toISOString() });
  await orgStorage.setActiveOrg(account.userId, bare.orgId);

  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 20_000 });
  check('switching into the bare workplace lands on Home, with no gate in front of it (note #726)',
    (await page.$('.requiredsetup, #requiredSetup, #teamArriving')) === null && (await text('#homeOrganizations .orgswapname')) === 'Side Hustle',
    await text('#homeOrganizations .orgswapname'));
  check('…with no subscription step and no cloud step on it', !/Sign in a subscription|Fly/.test(await text('#screenHome')), await text('#screenHome'));
  check('…which carries the workplace switch in its header as the way out', Boolean(await page.$('#screenHome .chathead #homeOrganizations')));
  await shot('bare-home');

  await tap(page, '#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { timeout: 20_000 });
  check('the menu lists the other workplace', /Nomad Trading/.test(await text('#workplaceMenu')), await text('#workplaceMenu'));
  await shot('menu');
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('#workplaceMenu .orgmenurow'));
    rows.find((row) => /Nomad Trading/.test(row.textContent ?? ''))?.click();
  });
  await page.waitForFunction(() => document.querySelector('#homeOrganizations .orgswapname')?.textContent === 'Nomad Trading', { timeout: 20_000 }).catch(() => {});
  check('tapping the other workplace opens its Home', (await text('#homeOrganizations .orgswapname')) === 'Nomad Trading', await text('#homeOrganizations .orgswapname'));
  const active = await orgStorage.getMembershipByUser(account.userId);
  check('…and it is the active workplace again', active?.orgId === home.org.orgId, active?.orgId ?? '(none)');
  await shot('home-after');

  // Back into the bare one through Home's own switch (this tab stands in
  // its own workplace since note #628, so the server marker alone would not
  // move it), and out again through the picker: the picker is reachable
  // from the bare workplace's Home, and Back from it returns there rather
  // than to a dead end.
  await tap(page, '#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { timeout: 20_000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('#workplaceMenu .orgmenurow'));
    rows.find((row) => /Side Hustle/.test(row.textContent ?? ''))?.click();
  });
  await page.waitForFunction(() => document.querySelector('#homeOrganizations .orgswapname')?.textContent === 'Side Hustle', { timeout: 20_000 }).catch(() => {});
  check('switching into it from Home shows its Home again, still with no gate',
    (await text('#homeOrganizations .orgswapname')) === 'Side Hustle' && (await page.$('.requiredsetup')) === null);
  await page.goto(`${ORIGIN}/workplaces`);
  await page.waitForSelector('#screenOrgPicker', { timeout: 20_000 });
  check('the picker opens from the bare workplace', (await text('#pageHead h1')) === 'Switch workplace', await text('#pageHead h1'));
  check('…listing both workplaces', /Nomad Trading/.test(await text('#orgPickerList')) && /Side Hustle/.test(await text('#orgPickerList')), await text('#orgPickerList'));
  await shot('picker');
  await page.goBack();
  await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 20_000 });
  check('Back from the picker returns to the bare workplace’s Home', (await text('#homeOrganizations .orgswapname')) === 'Side Hustle', await text('#homeOrganizations .orgswapname'));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
