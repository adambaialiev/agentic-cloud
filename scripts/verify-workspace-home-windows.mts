// Note #715 and the owner's follow-up (2026-10-11): Home is the Chief of
// Staff's conversation, with its face and its name as the door to the
// Workplace window, and the agents picker by the message box. Driven in
// real Chrome against a real workplace with nine agents and one note:
//
//  - the header: the face in its context ring, "Chief of Staff" as the
//    title, both opening Workplace; no Workplace or Rooms buttons; the
//    workplace switch and the reader's picture — on one line, phone and desk;
//  - Workplace opens with the picker's way in, on a phone from the bottom
//    edge and short of the top, at a desk from a fixed line near the top;
//    Escape, Close, the dim and the BROWSER'S Back each close it with its
//    exit — Back never leaves Home while it is open, and leaves no dead
//    entry behind once it closes; a reload stands it up again; it holds the
//    workplace's notes (note #843);
//  - the picker: every agent's card in one list, the search over them, with
//    no address and no history entry;
//  - Add a secret, from the Workplace window, opens the secrets screen;
//  - the overview's old address opens Home with the Workplace window, with
//    the picker, or — for a room's old notes shelf — the notes list.
//
// The picker had the rooms as its tabs, a room's tab was the room whole
// (its name, its briefing, its Agents / Notes shelves), and the old address
// opened the picker on the room and shelf it named, until rooms left the
// product (note #843).
//
// Screenshots land in OUT_DIR (~/n715-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-home-windows.mts
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
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
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
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n715-proof');
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

const PORT = Number(process.env.PORT || 4231);
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
const quickNoteStorage = new InMemoryQuickNoteStorage();

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
  orgGit: new OrgGitService({ orgStorage }),
  quickNoteStorage,
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
    // This harness wires no Drive service: the Workplace window's Drive
    // shelf answers 503, which is the shelf's business, not the window's.
    const expected = (response.status() === 401 && url.pathname === '/workspace/auth/session')
      || (response.status() === 404 && url.pathname === '/favicon.ico')
      || (response.status() === 503 && url.pathname === '/workspace/api/drive');
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  /** The window and its dim have finished arriving. */
  const settled = () => page.waitForFunction(() => {
    const sheet = document.getElementById('homeSheet');
    return Boolean(sheet) && sheet!.getAnimations().length === 0 && sheet!.parentElement!.getAnimations().length === 0;
  }, { timeout: 10_000 });
  const gone = () => page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 10_000 });
  const title = () => page.$eval('#homeSheetTitle', (node) => node.textContent?.trim() ?? '');
  const depth = () => page.evaluate(() => (history.state?.usr?.homeSheet ?? []).length as number);
  const box = (selector: string) => page.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  });

  // 1. A workplace with nine agents, a short conversation with the Chief of
  //    Staff, and one note — the workplace's, at its own namespace (note
  //    #843).
  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  const seed = (id: string, name: string, minutesAgo: number, recap: string) => [id, {
    id, name, cli: 'claude', createdAt: iso(60 * 24 * 4), serverId: `m-${id}`,
    connectedAt: iso(60 * 24 * 4), model: 'opus', effort: 'xhigh',
    lastActivityAt: iso(minutesAgo), recap: { text: recap, at: iso(minutesAgo) },
  }] as const;
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: Object.fromEntries([
        seed('alex', 'Alex', 2, 'Built the agents picker.'),
        seed('ada', 'Ada', 16, 'Trimmed the agent instruction file.'),
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
  await quickNoteStorage.create({
    userId: org.git?.namespaceId ?? org.orgId, html: '<h2>Launch checklist</h2><p>Ten things before the waitlist opens.</p>',
    createdByAgentId: 'user', createdByUserId: account.userId, updatedByAgentId: 'user', updatedByUserId: account.userId,
  } as never);
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

  // 2. Home: the header.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome #recapChatTitle', { timeout: 15_000 });
  await page.waitForSelector('#homeWorkplaceDoor', { timeout: 10_000 });
  await page.waitForSelector('#agentChatSwitch', { timeout: 10_000 });
  check('Home is titled Chief of Staff', (await page.$eval('#recapChatTitle', (node) => node.textContent?.trim())) === 'Chief of Staff');
  const face = await page.$eval('#recapChatFace', (node) => ({
    tag: node.tagName, ring: Boolean(node.querySelector('.ctxring')), picture: Boolean(node.querySelector('.ctxring .avatar, .ctxring .icon')),
    hidden: node.getAttribute('aria-hidden'),
  }));
  check('the header wears the face in its context ring, as a button out of the reading order',
    face.tag === 'BUTTON' && face.ring && face.picture && face.hidden === 'true', JSON.stringify(face));
  check('the title is the door to Workplace, and not a link',
    await page.$eval('#recapChatTitle', (node) => node.tagName === 'H1' && !node.closest('a') && node.querySelector('#homeWorkplaceDoor')?.tagName === 'BUTTON'));
  check('no Workplace or Rooms buttons in the header',
    !(await page.$('#homeDoors')) && !(await page.$('#homeRoomsDoor'))
      && (await page.$$eval('#screenHome .chathead button', (nodes) => nodes.map((node) => node.textContent?.trim()).filter((text) => text === 'Rooms' || text === 'Workplace').length)) === 0);
  const phoneHead = await page.evaluate(() => {
    const head = document.querySelector('#screenHome > .chathead')!.getBoundingClientRect();
    const title = document.getElementById('recapChatTitle')!;
    const account = document.getElementById('homeAccount')!.getBoundingClientRect();
    return {
      head: Math.round(head.height), titleWhole: title.scrollWidth <= title.clientWidth,
      right: Math.round(account.right), width: document.documentElement.clientWidth,
    };
  });
  check('on a phone the header is one line, the title whole', phoneHead.head <= 56 && phoneHead.titleWhole && phoneHead.right <= phoneHead.width, JSON.stringify(phoneHead));
  await shot('home-header-phone');
  // The workplace switch still drops its menu over Home (note #609).
  await page.click('#homeOrganizations');
  await page.waitForSelector('#workplaceMenu', { visible: true });
  check('the workplace switch opens its menu over Home', new URL(page.url()).pathname === '/');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#workplaceMenu', { hidden: true });

  // 3. Workplace, on a phone, from the name: the picker's sheet, from the
  //    bottom edge.
  await page.click('#homeWorkplaceDoor');
  await page.waitForSelector('#homeSheet');
  const rising = await page.$eval('#homeSheet', (node) => node.getAnimations().map((one) => (one as CSSAnimation).animationName).join(','));
  check('Workplace rises with the picker’s own way in', rising.includes('agentsheetup'), rising);
  await settled();
  check('Workplace is the window’s title', (await title()) === 'Workplace');
  check('the name wears the open state', (await page.$eval('#homeWorkplaceDoor', (node) => node.getAttribute('aria-expanded'))) === 'true');
  check('it holds the Workplace sections and the Chief of Staff’s own cards',
    Boolean(await page.$('#homeSheet #homeWorkplace #agentActivity')) && Boolean(await page.$('#homeSheet #homeWorkplace #recapAgentSection')),
    String(await page.$$eval('#homeSheet #homeWorkplace > *', (nodes) => nodes.map((node) => node.id).join(','))));
  check('no room in it', !(await page.$('#homeSheet #homeRoom')));
  // The notes were a room's shelf until rooms left the product (note #843):
  // the workplace's notes stand in its window, with the way to write one.
  check('it holds the workplace’s notes, and the way to write one',
    (await page.$eval('#homeSheet #homeWorkplace', (node) => node.querySelector('#notesCard')?.textContent ?? '')).includes('Launch checklist')
      && Boolean(await page.$('#homeSheet #homeWorkplace #notesCard #newNoteBtn')),
    await page.$eval('#homeSheet #homeWorkplace', (node) => node.querySelector('#notesCard')?.textContent?.slice(0, 120) ?? '(no notes card)'));
  const phoneSheet = await box('#homeSheet');
  check('on a phone it stands on the bottom edge and short of the top',
    phoneSheet.bottom === 844 && phoneSheet.top > 40, JSON.stringify(phoneSheet));
  check('one history entry for the window', (await depth()) === 1);
  check('the address did not change', new URL(page.url()).pathname === '/' && !new URL(page.url()).search);
  await shot('workplace-phone');
  // Back on a phone: the browser's own, which is what the gesture is.
  await page.goBack();
  await page.waitForSelector('#homeSheet.agentsheet', { timeout: 2_000 }).catch(() => {});
  const sinking = await page.$eval('#homeSheet', (node) => ({
    leaving: node.parentElement!.classList.contains('leaving'),
    names: node.getAnimations().map((one) => (one as CSSAnimation).animationName).join(','),
  })).catch(() => null);
  check('Back closes the window with its exit', Boolean(sinking?.leaving) && sinking!.names.includes('agentsheetdown'), JSON.stringify(sinking));
  await gone();
  check('…and stays on Home', new URL(page.url()).pathname === '/' && Boolean(await page.$('#screenHome')));
  // From the face too.
  await page.click('#recapChatFace');
  await settled();
  check('the face opens Workplace too', (await title()) === 'Workplace' && (await depth()) === 1);
  await page.keyboard.press('Escape');
  await gone();
  check('Escape closes it', (await depth()) === 0 && new URL(page.url()).pathname === '/');
  // Close spends the entry: the next Back leaves Home rather than landing
  // on a dead entry.
  const before = await page.evaluate(() => history.state?.key as string);
  await page.click('#homeWorkplaceDoor');
  await settled();
  await page.click('#homeSheetClose');
  await gone();
  const state = await page.evaluate(() => ({ key: history.state?.key as string, sheet: history.state?.usr?.homeSheet ?? null }));
  check('Close leaves the reader on Home’s own entry, not on a spent one', state.sheet === null && state.key === before && (await depth()) === 0, JSON.stringify({ before, ...state }));
  // A reload stands it up again.
  await page.click('#homeWorkplaceDoor');
  await settled();
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#homeSheet', { timeout: 10_000 });
  check('a reload stands the window up again, without replaying the way in',
    (await title()) === 'Workplace' && (await page.$eval('#homeSheet', (node) => node.getAnimations().length)) === 0 && (await depth()) === 1);
  await page.click('#homeSheetClose');
  await gone();

  // 4. The picker: one list of every agent — no tabs, no room view (note
  //    #843).
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchSheet', { timeout: 10_000 });
  await page.waitForFunction(() => document.getElementById('agentSwitchSheet')!.getAnimations().length === 0, { timeout: 10_000 });
  const picker = await page.evaluate(() => ({
    cards: document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length,
    search: Boolean(document.getElementById('agentSwitchSearch')),
    tabs: document.querySelectorAll('#agentSwitchSheet [role="tab"]').length,
    room: Boolean(document.querySelector('#agentSwitchSheet #homeRoom, #agentSwitchRoom')),
    sheets: (history.state?.usr?.homeSheet ?? []).length, path: location.pathname + location.search,
  }));
  check('the picker is every agent’s card, with the search over them, and no tabs',
    picker.cards === 9 && picker.search && picker.tabs === 0 && !picker.room, JSON.stringify(picker));
  check('…with no address and no history entry', picker.sheets === 0 && picker.path === '/', JSON.stringify(picker));
  await shot('picker-all-phone');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  check('Escape closes the picker and stays on Home', new URL(page.url()).pathname === '/' && Boolean(await page.$('#screenHome')));

  // 5. Secrets are the Workplace window's (note #783 — one set per
  //    workplace, like repositories), and Add a secret goes to the secrets
  //    screen with its form up.
  await page.click('#homeWorkplaceDoor');
  await page.waitForSelector('#homeSheet #homeWorkplace #secrets', { timeout: 10_000 });
  await settled();
  check('the Workplace window carries the Secrets card',
    Boolean(await page.$('#homeSheet #homeWorkplace #secrets')) && !(await page.$('#roomContentTab-secrets')));
  const opened = await page.evaluate(() => {
    const door = [...document.querySelectorAll<HTMLButtonElement>('#homeSheet #homeWorkplace button')]
      .find((node) => node.textContent?.trim() === 'Add a secret');
    door?.click();
    return Boolean(door);
  });
  check('the Secrets card offers Add a secret', opened);
  await page.waitForSelector('#screenAdd #addForm', { timeout: 10_000 });
  const form = await box('#screenAdd #addForm');
  check('Add a secret opens the secrets screen with the form up, at the workplace\'s address',
    new URL(page.url()).pathname === '/secrets' && new URL(page.url()).searchParams.has('org') && !new URL(page.url()).searchParams.has('room'),
    page.url());
  check('…and the form is on screen, not off it', form.top > 60 && form.top < 500 && form.height > 100, JSON.stringify(form));
  await shot('secret-add-phone');
  await page.goBack({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenHome', { timeout: 10_000 });
  check('Back from it returns to Home', new URL(page.url()).pathname === '/' && Boolean(await page.$('#screenHome')));
  if (await page.$('#homeSheetClose')) {
    await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 10_000 }).catch(() => {});
  }

  // 6. The overview's old addresses. One that named a room opens the
  //    picker — every agent — and drops the room; one that named a room's
  //    Notes shelf opens the notes list, the workplace's one list (note
  //    #843). The room they name is one that no longer exists anywhere.
  const oldRoom = 'room_growth';
  await page.goto(`${ORIGIN}/overview?org=${org.orgId}&half=rooms&room=${oldRoom}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentSwitchSheet #agentSwitchGrid', { timeout: 10_000 });
  check('the old rooms address lands on Home with the picker, every agent in it',
    new URL(page.url()).pathname === '/' && !new URL(page.url()).search
      && (await page.$$eval('#agentSwitchGrid .crow[data-agent]', (nodes) => nodes.length)) === 9 && !(await page.$('#homeSheet')),
    page.url());
  await page.click('#agentSwitchClose');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });
  await page.goto(`${ORIGIN}/overview?org=${org.orgId}&half=rooms&room=${oldRoom}&content=notes`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenNotes', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#screenNotes')?.textContent?.includes('Launch checklist'), { timeout: 10_000 }).catch(() => {});
  check('the old address of a room’s Notes shelf opens the notes list, with no room in its address',
    new URL(page.url()).pathname === '/notes' && !new URL(page.url()).searchParams.has('room')
      && (await page.$eval('#screenNotes', (node) => node.textContent ?? '')).includes('Launch checklist'),
    page.url());
  await page.goto(`${ORIGIN}/overview?org=${org.orgId}&half=workplace`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('homeSheetTitle')?.textContent === 'Workplace', { timeout: 10_000 });
  check('half=workplace opens the Workplace window', new URL(page.url()).pathname === '/');
  await page.goBack();
  await gone();
  check('…and its Back closes the window rather than leaving Home', new URL(page.url()).pathname === '/' && Boolean(await page.$('#screenHome')));

  // 7. At a desk: the header on one line, the window and the picker from a
  //    fixed top line.
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  await pause(150);
  const deskHead = await page.evaluate(() => ({
    head: Math.round(document.querySelector('#screenHome > .chathead')!.getBoundingClientRect().height),
    face: Boolean(document.querySelector('#recapChatFace .ctxring')),
  }));
  check('at a desk the header is one line with the face', deskHead.head <= 50 && deskHead.face, JSON.stringify(deskHead));
  await shot('home-header-desk');
  await page.click('#homeWorkplaceDoor');
  const popping = await page.$eval('#homeSheet', (node) => node.getAnimations().map((one) => (one as CSSAnimation).animationName).join(','));
  check('at a desk it pops in like the picker', popping.includes('agentsheetpop'), popping);
  await settled();
  const deskSheet = await box('#homeSheet');
  check('at a desk it hangs from a line near the top, and is not full height',
    deskSheet.top >= 48 && deskSheet.bottom < 860 && deskSheet.width <= 760, JSON.stringify(deskSheet));
  await shot('workplace-desk');
  // The dim closes it too.
  await page.mouse.click(20, 840);
  await gone();
  check('a tap on the dim closes it', (await depth()) === 0);
  // The picker at a desk: from the same fixed top line as the window, and
  // short of the bottom. It kept that line between All and a room's tab
  // until rooms left the product (note #843).
  await page.click('#agentChatSwitch');
  await page.waitForSelector('#agentSwitchGrid', { timeout: 10_000 });
  await page.waitForFunction(() => document.getElementById('agentSwitchSheet')!.getAnimations().length === 0, { timeout: 10_000 });
  await pause(300);
  const deskAll = await box('#agentSwitchSheet');
  check('at a desk the picker hangs from a line near the top, and is not full height',
    deskAll.top >= 48 && deskAll.bottom < 860, JSON.stringify(deskAll));
  await shot('picker-all-desk');
  await page.click('#agentSwitchClose');
  await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout: 10_000 });

  check('no unexpected browser errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('\nHome windows browser verification passed.');
}
