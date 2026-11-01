// PICTURES of the person cards for note #833 (Adam, 2026-10-29: "just
// redesign this"): three people — one with no agents and no picture, the
// reader with one agent, one with a picture and four agents, two of them
// working — with direct messages on so the send door shows. Desk and phone,
// Home's Workplace window, the People page and a member's screen. Shots only;
// the checks live in verify-workspace-team-people.mts.
//
//   cd backend && npm run build:workspace-ui
//   SHOT_TAG=before backend/node_modules/.bin/tsx scripts/shot-person-cards-833.mts
//
// (Adapted from the team view harness, whose header follows.) Drives the React Workspace in real Chrome against a real backend router to
// check the team view (Adam, 2026-10-28: "let's bring back the team UI where
// I can see my teammates and their statuses and what their agents cooking").
//
// Home's Workplace window stands a People deck right after the agent counts:
// one plate per person — here now, or when they were last — and under each
// person the agents they drive, Working or Idle, with the same one-line
// recap the agent's own row carries. Each agent's line opens that agent; the
// rest of the plate opens the person. The People page draws the same plates,
// and a member's own screen lists every agent the same way. The people tick
// moves an agent's state and recap with no full read. A workplace of one
// that nobody can join draws none of it and makes no people read.
// Screenshots land in ~/mini-preview/team-people-*.png, desk and phone.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-team-people.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDirectMessageStorage } from '../backend/src/services/sqlite/sqlite-direct-message-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import {
  harnessEstablishedWorkplace, harnessMailService, harnessSignedIn, harnessWorkplace,
} from './workspace-harness-auth.mjs';
import { closeHomeWindow, openWorkplaceWindow } from './workspace-harness-home.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(cache).filter((name) => name.startsWith('linux-')).sort();
  const newest = builds[builds.length - 1];
  if (!newest) throw new Error(`no Chrome under ${cache} — npx puppeteer browsers install chrome`);
  return path.join(cache, newest, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4188);
const TAG = process.env.SHOT_TAG || 'after';
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A stand-in for a member's profile picture: a real drawn square. */
const PERSON_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c9785b"/>'
  + '<circle cx="32" cy="26" r="12" fill="#f3d9c6"/><rect x="14" y="42" width="36" height="22" rx="11" fill="#f3d9c6"/></svg>',
).toString('base64');

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

/** Which agents are mid-turn, as `ownerUserId:agentId`. */
const working = new Set<string>();

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  orgStorage,
  directMessageStorage: new SqliteDirectMessageStorage(openSqliteDb(':memory:')),
  mediaStorage: {
    createReadAccess: async () => ({ url: PERSON_PHOTO, expiresAt: new Date(Date.now() + 900_000).toISOString() }),
  },
  agentLifecycle: {
    isAgentWorking: (userId: string, agentId: string) => working.has(`${userId}:${agentId}`),
  },
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
let peopleReads = 0;
let stateReads = 0;
app.use((req, _res, next) => {
  if (/\/api\/org\/people$/.test(req.path)) peopleReads += 1;
  if (/\/api\/state$/.test(req.path)) stateReads += 1;
  next();
});
app.use('/workspace', workspaceRoutes(deps));
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('PAGE ERROR', String(error)));
  const me = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com', { firstName: 'Saddam', lastName: 'Bakirov' });
  const { org } = await harnessWorkplace(orgStorage, { userId: me.userId, name: 'Nomad Trading' });
  await orgStorage.addSeat({ orgId: org.orgId, userId: me.userId, provider: 'claude', token: 't', label: 'my Claude', status: 'active' } as never);
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
  const agent = (id: string, name: string, recap: string, at = earlier) => ({
    id, name, cli: 'claude', createdAt: at, serverId: `m-${id}`, connectedAt: at, lastActivityAt: at, orgId: org.orgId,
    recap: { text: recap, at },
  });
  const mine = await userStorage.getProfile(me.userId);
  await userStorage.updateProfile(me.userId, { telegram: { ...(mine?.telegram ?? {}), agents: {
    felix: agent('felix', 'Felix', 'Wrote the onboarding email series; waiting on your review.'),
  } } as never });
  await userStorage.createProfile('dana', { email: 'dana@example.com', displayName: 'Dana Ives' } as never);
  await userStorage.updateProfile('dana', {
    person: { firstName: 'Dana', lastName: 'Ives', photo: { storagePath: 'people/dana.png' } },
    telegram: { chatId: '2', linkedAt: now, telegramUserId: '43', agents: {
      leo: agent('leo', 'Leo', 'Fixing the footer on the landing page; checks running.', now),
      nora: agent('nora', 'Nora', 'Drafted the pricing page copy; two options ready for Dana.'),
      mia: agent('mia', 'Mia', 'Rewriting the pricing table for annual plans.', now),
      otis: agent('otis', 'Otis', 'Summarised last week’s support tickets.'),
    } } as never,
  });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member', invitedByUserId: me.userId } as never);
  const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString();
  await orgStorage.touchMember(org.orgId, 'dana', { lastSeenAt: fourMinutesAgo, recap: { text: 'Approved proposal #12: Pricing page redesign', at: fourMinutesAgo } });
  await userStorage.createProfile('mira', { email: 'mira@example.com', displayName: 'Mira Chen' } as never);
  await userStorage.updateProfile('mira', { person: { firstName: 'Mira', lastName: 'Chen' } } as never);
  await orgStorage.addMember({ orgId: org.orgId, userId: 'mira', role: 'member', invitedByUserId: me.userId } as never);
  working.add('dana:leo');
  working.add('dana:mia');

  for (const [device, viewport] of [
    ['phone', { width: 390, height: 844, deviceScaleFactor: 2 }],
    ['desk', { width: 1280, height: 900, deviceScaleFactor: 1 }],
  ] as const) {
    await page.setViewport(viewport);
    await openWorkplaceWindow(page, ORIGIN);
    await page.waitForSelector('#homeSheet #homePeople .crow[data-person="dana"]', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => document.getElementById('agentActivity')?.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, `n833-${TAG}-home-${device}.png`) as `${string}.png` });
    await settleAfterShot(page);
    await closeHomeWindow(page);
    await page.goto(`${ORIGIN}/workplace/people?org=${org.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#people .crow[data-person="dana"]', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(OUT, `n833-${TAG}-people-${device}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
    await page.goto(`${ORIGIN}/workplace/members/dana?org=${org.orgId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#orgMemberAgents', { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(OUT, `n833-${TAG}-member-${device}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  }
  console.log(`shots in ${OUT}: n833-${TAG}-*`);
} finally {
  await browser.close();
  server.close();
}
