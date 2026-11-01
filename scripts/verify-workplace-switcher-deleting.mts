// Note #654, in real Chrome: a workplace that is being deleted wears its
// "Being deleted" badge in GREY in Home's workplace switcher and in the
// picker — the same grey as "Admin" beside it, not the red that used to
// make it read as an alarm. Screenshots land in ~/mini-preview/n654-*.png.
// Since 2026-10-10 Home is the Chief of Staff's conversation and the switch
// stands in its header, beside the Workplace and Rooms doors (note #715).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workplace-switcher-deleting.mts
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
import { WORKPLACE_DELETION_GRACE_MS } from '../backend/src/services/workplace-deletion.js';
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
const PORT = Number(process.env.PORT || 4184);
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

/** The badge's ink beside the palette's own greys and reds, measured in the
 *  page rather than read out of the stylesheet. */
const BADGE_INK = `(() => {
  const badge = Array.from(document.querySelectorAll(SCOPE + ' .badge')).find((node) => node.textContent === 'Being deleted');
  const admin = Array.from(document.querySelectorAll(SCOPE + ' .badge')).find((node) => node.textContent === 'Admin');
  if (!badge || !admin) return null;
  const probe = document.createElement('span');
  document.body.append(probe);
  const paint = (name) => { probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return getComputedStyle(probe).color; };
  const hint = paint('--hint'); const danger = paint('--danger');
  probe.remove();
  return { ink: getComputedStyle(badge).color, admin: getComputedStyle(admin).color, hint, danger, className: badge.className };
})()`;
type Ink = { ink: string; admin: string; hint: string; danger: string; className: string } | null;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = (name: string, clip?: { width: number; height: number }) => page.screenshot({
    path: path.join(OUT, `n654-${name}.png`) as `${string}.png`,
    ...clip ? { clip: { x: 0, y: 0, ...clip } } : {},
  });

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'Baialiev' });
  const home = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'ACC' });
  const going = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Good Company' });
  const requestedAt = new Date();
  await orgStorage.updateOrg(going.org.orgId, {
    deletion: {
      requestedAt: requestedAt.toISOString(),
      requestedByUserId: account.userId,
      requestedByName: 'Saddam Baialiev',
      purgeAt: new Date(requestedAt.getTime() + WORKPLACE_DELETION_GRACE_MS).toISOString(),
    },
  });
  await orgStorage.setActiveOrg(account.userId, home.org.orgId);
  check('the lock is three days long (note #654)', WORKPLACE_DELETION_GRACE_MS === 3 * 24 * 3600_000, String(WORKPLACE_DELETION_GRACE_MS));

  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#screenHome #homeOrganizations', { timeout: 20_000 });
  await tap(page, '#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { timeout: 20_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#workplaceMenu .badge')).some((node) => node.textContent === 'Being deleted'), { timeout: 20_000 });
  const menu = await page.evaluate(`const SCOPE = '#workplaceMenu'; ${BADGE_INK}`) as Ink;
  check('the switcher says which workplace is being deleted', Boolean(menu), JSON.stringify(menu));
  check('…in grey, the same as Admin beside it, and not the red it wore', Boolean(menu) && menu!.ink === menu!.hint && menu!.ink === menu!.admin && menu!.ink !== menu!.danger, JSON.stringify(menu));
  await shot('switcher', { width: 420, height: 320 });

  await page.goto(`${ORIGIN}/workplaces`);
  await page.waitForSelector('#orgPickerList', { timeout: 20_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#orgPickerList .badge')).some((node) => node.textContent === 'Being deleted'), { timeout: 20_000 });
  const picker = await page.evaluate(`const SCOPE = '#orgPickerList'; ${BADGE_INK}`) as Ink;
  check('the picker says so too, in the same grey', Boolean(picker) && picker!.ink === picker!.hint && picker!.ink !== picker!.danger, JSON.stringify(picker));
  await shot('picker');
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
