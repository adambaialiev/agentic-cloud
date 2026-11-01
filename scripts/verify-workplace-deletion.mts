// Deleting a whole workplace (owner, 2026-09-22), driven in real Chrome
// against the real backend router on in-memory stores, with TWO people signed
// in: the admin who asks and a member who is only told.
//
// What it proves: the admin's details page offers the door; its screen says
// what goes and what stays, and asks for the name typed; the admin lands on
// the lock screen, and the member's open Workspace turns into it on its own,
// without a reload; Keep this workplace brings both back; and once the three days
// are up the sweep deletes it and the member opens onto no workplace at all.
// Screenshots land in OUT_DIR (~/mini-preview by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workplace-deletion.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { WorkplaceDeletionService } from '../backend/src/services/workplace-deletion.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';

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

const PORT = Number(process.env.PORT || 4192);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLOUD = 'nomad-fly';
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage, { flyOrgSlug: CLOUD });
const quickNoteStorage = new InMemoryQuickNoteStorage();
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
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  orgStorage,
  orgGit: new OrgGitService({ orgStorage }),
  quickNoteStorage,
  secretStorage: new InMemorySecretStorage(),
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  // Asked only for the lock's refusal of a new agent, below: the lock answers
  // before anything is created, so creating is never reached.
  agentLifecycle: {
    createAgent: async () => { throw new Error('the lock should have refused the new agent first'); },
  } as unknown as RouteDeps['agentLifecycle'],
} as RouteDeps;

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
const consoleErrors: string[] = [];
/** The workplace the sweep has purged, once it has: a tab that stood in it
 *  is refused by name and then follows the account (note #628). */
let purged: string | null = null;
const watch = (page: Page, who: string) => {
  page.on('pageerror', (error) => consoleErrors.push(`${who}: ${String(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(`${who}: ${message.text()}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico')
      // The refusal this harness asks for on purpose, below.
      || (response.status() === 409 && url.pathname === '/workspace/api/agents')
      // The admin's tab still stands in the purged workplace and names it on
      // every read (note #628). The refusal is the signal: the shell drops
      // it and follows the account, asserted below.
      || (response.status() === 403 && purged !== null && url.searchParams.get('org') === purged);
    if (response.status() >= 400 && !expected) consoleErrors.push(`${who}: ${response.status()} ${response.url()}`);
  });
};
const textOf = (page: Page, selector: string) => page.$eval(selector, (node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());

try {
  const admin = await browser.newPage();
  await admin.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  watch(admin, 'admin');
  const memberContext = await browser.createBrowserContext();
  const member = await memberContext.newPage();
  await member.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  watch(member, 'member');
  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: path.join(OUT, `workplace-deletion-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };

  const saddam = await harnessSignedIn(admin, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'Baialiev' });
  const mira = await harnessSignedIn(member, workspaceWebAuth, ORIGIN, 'mira@example.com', { firstName: 'Mira', lastName: 'Chen' });
  const { org } = await harnessWorkplace(orgStorage, { userId: saddam.userId, name: 'Nomad Trading' });
  await orgStorage.addMember({ orgId: org.orgId, userId: mira.userId, role: 'member' });
  await orgStorage.setActiveOrg(mira.userId, org.orgId);
  // The workplace's notes, at its one namespace (note #843).
  for (const html of ['<h2>Launch plan</h2>', '<h2>Press list</h2>', '<h2>Leads</h2>']) {
    await quickNoteStorage.create({ userId: org.orgId, html, createdByAgentId: 'user', updatedByAgentId: 'user' } as never);
  }

  // The member is sitting on Home when the admin asks — the lock has to
  // reach an open Workspace on its own.
  await member.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await member.waitForSelector('#screenHome', { timeout: 10_000 });

  await admin.goto(`${ORIGIN}/workplace?org=${encodeURIComponent(org.orgId)}`, { waitUntil: 'networkidle0' });
  await admin.waitForSelector('#screenOrg #orgDeleteDoor', { timeout: 10_000 });
  const door = await admin.$eval('#orgDeleteDoor', (node) => {
    const own = node.getBoundingClientRect();
    const rename = document.getElementById('orgRenameBtn')!.getBoundingClientRect();
    return {
      text: node.textContent ?? '',
      // Right under Rename, both on the page's right edge (owner, 2026-09-22).
      belowRename: own.top >= rename.bottom - 1 && own.top - rename.bottom < 12,
      rightAligned: Math.abs(own.right - rename.right) <= 1,
      onTheRight: own.left > window.innerWidth / 2,
      last: node.closest('#orgNameActions') === document.getElementById('screenOrg')!.lastElementChild,
    };
  });
  check('an admin of a workplace with people and work in it gets the delete door', door.text === 'Delete this workplace', door.text);
  check('…at the foot of the page, on the right, directly under Rename', door.belowRename && door.rightAligned && door.onTheRight && door.last, JSON.stringify(door));
  await shot(admin, '01-details');

  await tap(admin, '#orgDeleteDoor');
  await admin.waitForSelector('#screenOrgDelete #orgDeleteGoes', { timeout: 10_000 });
  const goes = await textOf(admin, '#orgDeleteGoes');
  // It counted the rooms too, a row of their own, until rooms left the
  // product (note #843): the notes are the workplace's, and no Rooms row
  // stands.
  check('the screen lists what goes: every note in the workplace, and no Rooms row', goes.includes('Notes3') && !/Rooms?\d/.test(goes), goes);
  const stays = await textOf(admin, '#orgDeleteStays');
  check('…and what stays, naming the Fly account left standing', stays.includes('Everyone’s account') && stays.includes(`Your Fly account${CLOUD}: its machines`), stays);
  const when = await textOf(admin, '#orgDeleteWhen');
  check('…and that it locks now and goes for good three days later', when.includes('It locks as soon as you confirm') && when.includes('deleted for good on'), when);
  check('…and who is told', (await textOf(admin, '#orgDeleteTold')).includes('2 people'));
  check('the delete screen keeps the workplace’s address', admin.url().includes('/workplace?org='), admin.url());
  await shot(admin, '02-delete-screen');

  await tap(admin, '#orgDeleteConfirm');
  await admin.waitForSelector('.ask input', { visible: true, timeout: 10_000 });
  const confirmDisabled = () => admin.$eval('.ask .btn.danger', (node) => (node as HTMLButtonElement).disabled);
  check('the confirmation waits for the name', await confirmDisabled());
  await admin.type('.ask input', 'Nomad Trading');
  check('…typed exactly', !(await confirmDisabled()), await admin.$eval('.ask input', (node) => (node as HTMLInputElement).value));
  // The shape of that answer (note #624): the red WORD, not a red slab. It
  // is MEASURED here rather than read back out of the stylesheet, because a
  // rule that merely looks right in the source is exactly what shipped the
  // filled version. The ink is compared with the palette's own `--danger`
  // through a probe, not with a hex written down here, and the box with
  // Cancel's — the point is that the two answers now differ in colour and
  // weight alone.
  const answer = await admin.evaluate(`(() => {
    var danger = document.querySelector('.ask .btn.danger');
    var cancel = document.querySelector('.ask .btn.ghost');
    var probe = document.createElement('span');
    document.body.append(probe);
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    var wanted = getComputedStyle(probe).color;
    probe.remove();
    var box = danger.getBoundingClientRect();
    var other = cancel.getBoundingClientRect();
    var style = getComputedStyle(danger);
    return {
      fill: style.backgroundColor, ink: style.color, wanted: wanted, radius: style.borderTopLeftRadius,
      weight: style.fontWeight, cancelWeight: getComputedStyle(cancel).fontWeight,
      height: Math.round(box.height), cancelHeight: Math.round(other.height),
    };
  })()`) as {
    fill: string; ink: string; wanted: string; radius: string;
    weight: string; cancelWeight: string; height: number; cancelHeight: number;
  };
  check('the answer is the red word, with nothing filled behind it (note #624)',
    answer.fill === 'rgba(0, 0, 0, 0)' && answer.ink === answer.wanted && answer.radius === '0px',
    JSON.stringify(answer));
  check('…ranked above Cancel by its weight alone, in a box the same height',
    answer.weight === '500' && answer.cancelWeight === '400' && answer.height === answer.cancelHeight,
    JSON.stringify(answer));
  await shot(admin, '03-confirm');
  await tap(admin, '.ask .btn.danger');

  await admin.waitForSelector('#workplaceDeleting', { timeout: 10_000 });
  const lock = await textOf(admin, '#workplaceDeleting h1');
  check('the admin lands on the lock screen', lock === 'Nomad Trading is being deleted', lock);
  const said = await textOf(admin, '#workplaceDeleting .authhero p');
  check('…which says who asked and when it goes', said.includes('Saddam Baialiev asked to delete it on') && said.includes('It will be deleted for good on'), said);
  check('…and offers the admin Keep this workplace', Boolean(await admin.$('#workplaceKeep')));
  const record = (await orgStorage.getOrg(org.orgId))?.deletion;
  check('the server holds it for three days (note #654)', Boolean(record)
    && Date.parse(record!.purgeAt) - Date.parse(record!.requestedAt) === 3 * 24 * 3600_000, JSON.stringify(record));
  await shot(admin, '04-lock-admin');

  // The member's Home turns into the lock on the live tick, with no reload.
  await member.waitForSelector('#workplaceDeleting', { timeout: 15_000 });
  check('the member’s open Workspace turns into the lock by itself', (await textOf(member, '#workplaceDeleting h1')) === 'Nomad Trading is being deleted');
  check('…with no Keep for a member', !(await member.$('#workplaceKeep')));
  check('…and a way out to a workplace of their own', (await textOf(member, '#workplaceDeletingWayOut')) === 'New workplace');
  // Asked as a new agent, the kind of new work a member's own request can
  // start here. It was asked as a new room until rooms left the product
  // (note #843).
  const refused = await member.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((part) => part.includes('csrf'))?.split('=')[1] ?? '';
    const answer = await fetch('/workspace/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
      body: JSON.stringify({ cli: 'claude' }),
    });
    return { status: answer.status, body: await answer.json() as { error?: string } };
  });
  check('the server refuses new work in a locked workplace', refused.status === 409 && refused.body.error === 'Nomad Trading is being deleted, so no new agent can start there.', JSON.stringify(refused));
  await shot(member, '05-lock-member');

  await tap(admin, '#workplaceKeep');
  await admin.waitForSelector('#screenOrg, #screenHome', { timeout: 10_000 });
  check('Keep lifts the lock for the admin', !(await admin.$('#workplaceDeleting')));
  check('…and the server forgets the deletion', !(await orgStorage.getOrg(org.orgId))?.deletion);
  await member.waitForFunction(() => !document.getElementById('workplaceDeleting'), { timeout: 15_000 });
  await member.waitForSelector('#screenHome', { timeout: 10_000 });
  check('…and the member’s Workspace comes back by itself', true);
  await shot(admin, '06-kept');

  // Three days later: asked again, and the sweep finds it due. Written as a
  // record rather than asked through `schedule`, which refuses an ask within
  // an hour of a Keep — so the record is complete, as a real one would be.
  const deletion = new WorkplaceDeletionService(deps);
  await orgStorage.updateOrg(org.orgId, { deletion: {
    requestedAt: new Date(Date.now() - 3 * 24 * 3600_000 - 60_000).toISOString(),
    requestedByUserId: saddam.userId, requestedByName: 'Saddam Baialiev',
    purgeAt: new Date(Date.now() - 1000).toISOString(),
  } });
  const swept = await deletion.sweep();
  purged = org.orgId;
  check('the sweep deletes a workplace whose three days are up', swept.purged.includes(org.orgId) && !(await orgStorage.getOrg(org.orgId)), JSON.stringify(swept));
  check('…with its notes', (await quickNoteStorage.listByUser(org.orgId)).length === 0);
  await member.reload({ waitUntil: 'networkidle0' });
  await member.waitForFunction(() => document.body.textContent?.includes('New workplace'), { timeout: 10_000 });
  check('the member opens onto no workplace, with the door to found one', !(await member.$('#workplaceDeleting')));
  await shot(member, '07-after-member');
  // The admin's tab was never reloaded. It stood in the purged workplace,
  // is refused by name on its next live tick, and follows the account by
  // itself underneath the details screen it is still showing; one tap of
  // Back lands on a Home that stands in no workplace.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  await tap(admin, '#pageBack');
  await admin.waitForFunction(() => document.body.textContent?.includes('New workplace'), { timeout: 15_000 });
  check('the admin’s open tab follows the account out of the purged workplace by itself', !(await admin.$('#workplaceDeleting')));
  await shot(admin, '08-after-admin');

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
