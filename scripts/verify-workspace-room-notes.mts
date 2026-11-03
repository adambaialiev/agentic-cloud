// Notes #468 and #487, then #843: the workplace's notes are ONE list.
// Drive the real Workspace shell in phone-sized Chrome against a workplace
// and prove it: the Workplace window and the notes screen show the
// workplace's notes — the Chief of Staff's own among them, not kept apart —
// with no private shelf, no private writing door and no door to a room of
// the agent's; an old link that still names a room opens the note and
// names no room; and an address that still carries `?room=` reads the
// workplace as it is.
//
// It proved the Chief of Staff's own note ROOM until rooms left the product
// (note #843): that what the agent wrote for itself there stayed out of
// everybody's notes, that the one way in was a door on the agent's cards,
// that the room was no row among the rooms, that it answered as a
// destination for the agent's own work with no screen of its own, and that
// a note's header named its room ("in Sales"). Stage 3 dropped rooms from
// the data, so the agent's notes are the workplace's like everybody's, and
// what is left to prove is that one list.
// Screenshots land in OUT_DIR (~/n468-proof by default).
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-room-notes.mts
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
import { OrgGitService } from '../backend/src/services/org-git.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';
import { openAgentsPicker, openWorkplaceWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'n468-proof');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const PORT = Number(process.env.PORT || 4186);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const userStorage = new InMemoryUserStorage();
const orgStorage = new InMemoryOrgStorage();
// The workplace this harness founds is one that is already set up: its
// cloud is connected and a subscription is signed in, so the Workspace
// opens instead of holding on the first-run setup steps.
harnessEstablishedWorkplace(orgStorage);
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
      // Asked on purpose below: the room routes are gone (note #843).
      || (response.status() === 404 && /\/workspace\/api\/rooms\/[a-z0-9_-]+$/i.test(url.pathname));
    if (response.status() >= 400 && !expected) consoleErrors.push(`${response.status()} ${response.url()}`);
  });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };

  const account = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  const { org } = await harnessWorkplace(orgStorage, { userId: account.userId, name: 'Nomad Trading' });
  const orgId = org.orgId;
  // Both at the workplace's one namespace (note #843): a note an agent
  // wrote for the team, and one the Chief of Staff wrote — which its own
  // room kept apart until rooms left the product.
  const salesNote = await quickNoteStorage.create({
    userId: orgId, html: '<h2>Visible sales note</h2>',
    createdByAgentId: 'agent', updatedByAgentId: 'agent',
  });
  await quickNoteStorage.create({
    userId: orgId, html: '<h2>Chief of Staff follow-ups</h2>',
    createdByAgentId: 'workspace-agent', updatedByAgentId: 'workspace-agent',
  });
  await openAgentsPicker(page, ORIGIN);
  await page.waitForFunction(() => !document.getElementById('banner'), { timeout: 7_000 });

  // The workplace's notes are the Workplace window's (note #843), where a
  // room's Notes shelf stood: one row of its index since note #960, which
  // counts both notes and opens the one list.
  await openWorkplaceWindow(page, ORIGIN);
  await page.waitForSelector('#homeWorkplace #indexNotes', { timeout: 10_000 });
  const workplace = await page.$eval('#homeWorkplace', (node) => ({
    notes: node.querySelector('#indexNotes')?.textContent ?? '',
    privateCard: Boolean(node.querySelector('#workspaceNotesCard')),
    writeDoor: Boolean(node.querySelector('#newWorkspaceNoteBtn')),
    agentDoor: Boolean(node.querySelector('#recapAgentRoom')),
  }));
  check('the Workplace window counts the workplace’s notes, the Chief of Staff’s among them',
    /^Notes2 notes/.test(workplace.notes), workplace.notes);
  check('the Workplace window has no private Notes shelf', !workplace.privateCard);
  check('the Workplace window has no private writing door', !workplace.writeDoor);
  // The agent's cards carried the one door into its room until rooms left
  // the product (note #843).
  check('the agent’s cards carry no door to a room', !workplace.agentDoor);
  await shot('01-workplace-notes');

  // An address that still carries `?room=` reads the workplace as it is —
  // nothing reads the word (note #843) — and a room's own route is gone.
  const direct = await page.evaluate(async ({ number }) => {
    const [state, note, roomDetail] = await Promise.all([
      fetch('/workspace/api/state?room=room_sales'),
      fetch(`/workspace/api/notes/${number}?room=room_sales`),
      fetch('/workspace/api/rooms/room_sales'),
    ]);
    return { state: state.status, note: note.status, room: roomDetail.status };
  }, { number: salesNote.number });
  check('a state read naming a room reads the workplace', direct.state === 200, String(direct.state));
  check('…a note read naming one answers the note', direct.note === 200, String(direct.note));
  check('…and a room has no route of its own', direct.room === 404, String(direct.room));

  // The notes screen is the same one list.
  await page.goto(`${ORIGIN}/notes?org=${encodeURIComponent(orgId)}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#screenNotes')?.textContent?.includes('Visible sales note'), { timeout: 10_000 }).catch(() => {});
  const notesScreen = await page.$eval('#screenNotes', (node) => node.textContent ?? '');
  check('the notes screen shows the workplace’s notes, the Chief of Staff’s among them',
    notesScreen.includes('Visible sales note') && notesScreen.includes('Chief of Staff follow-ups'), notesScreen.slice(0, 160));
  await shot('02-notes-list');

  // Note #556 named a note's room in its header ("in Sales"), because #1 in
  // Sales and #1 in the agent's room were different notes; the line went
  // with rooms (note #843). An old link that still carries `&room=` opens
  // the note, and names no room.
  await page.goto(
    `${ORIGIN}/notes/${salesNote.number}?org=${encodeURIComponent(orgId)}&room=room_sales`,
    { waitUntil: 'networkidle0' },
  );
  await page.waitForSelector('#screenNote #noteBody', { timeout: 10_000 });
  const opened = await page.evaluate(() => ({
    roomSub: Boolean(document.querySelector('#noteRoomSub')),
    header: document.querySelector('.phead')?.textContent ?? '',
  }));
  // The note's <h2> is its title, so its words stand in the header.
  check('an old note link with `&room=` opens the note', opened.header.includes('Visible sales note'), opened.header.slice(0, 120));
  check('…and its header names no room', !opened.roomSub && !/\bin Sales\b/.test(opened.header), opened.header);
  await shot('05-note-header');

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
