/**
 * Note #1104: Home's Workplace window, then Direct messages, after a quiet
 * spell, in a browser that has nothing kept — for one Workspace build. Not a
 * check: run it on two builds (with and without the wake from Home).
 *
 *   DIST=backend/dist/workspace-ui PROFILE=phone GAPS=1000,3000,5000 \
 *     backend/node_modules/.bin/tsx scripts/measure-direct-messages-wake.mts
 *
 * The machine is modelled by production's measurements (note #1102): a read
 * to a sleeping machine waits WAKE_MS; a wake asked for in the background
 * makes it ready WAKE_MS after the ask. GAPS is how long the person looks at
 * the window before tapping Direct messages.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { harnessEstablishedWorkplace } from './workspace-harness-auth.mjs';
import { tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { generateTotpCode } from '../backend/src/utils/totp.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDirectMessageStorage } from '../backend/src/services/sqlite/sqlite-direct-message-storage.js';
import type { DirectMessageStorage } from '../backend/src/services/direct-message-storage.js';

const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const chromeRoot = `${process.env.HOME}/.cache/puppeteer/chrome`;
const chrome = process.env.CHROME || path.join(chromeRoot, readdirSync(chromeRoot).sort().at(-1)!, 'chrome-linux64/chrome');
const DIST = path.resolve(process.env.DIST || 'backend/dist/workspace-ui');
const PHONE = process.env.PROFILE === 'phone';
const HOP_MS = Number(process.env.HOP_MS ?? 10), WAKE_MS = Number(process.env.WAKE_MS ?? 5000);
const RUNS = Number(process.env.RUNS ?? 3);
const GAPS = (process.env.GAPS ?? '1000,3000,5000').split(',').map(Number);

const users = new InMemoryUserStorage(), orgs = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgs);
const auth = new WorkspaceWebAuthService(new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(randomBytes(32).toString('base64')));
const enroll = async (username: string, first: string) => {
  const seed = await auth.startEnrollment(username);
  const issued = await auth.finishEnrollment({ enrollmentToken: seed.enrollmentToken, code: generateTotpCode(seed.secret) });
  await users.updateProfile(issued.userId, { person: { firstName: first, lastName: 'Fixture' } });
  return issued;
};
const ana = await enroll('fixture_ana', 'Ana'), ben = await enroll('fixture_ben', 'Ben');
const org = await orgs.createOrg({ name: 'Fixture Studio', createdByUserId: ana.userId });
await orgs.addMember({ orgId: org.orgId, userId: ana.userId, role: 'admin' });
await orgs.addMember({ orgId: org.orgId, userId: ben.userId, role: 'member' });
const db = openSqliteDb(':memory:'), base = new SqliteDirectMessageStorage(db);
for (let n = 1; n <= 60; n += 1) await base.send(org.orgId, n % 2 ? ben.userId : ana.userId, n % 2 ? ana.userId : ben.userId, `Line ${n} of the launch plan.`, `measure-message-${String(n).padStart(4, '0')}`);

let asleep = false, readyAt = 0, upAtTap: boolean[] = [];
const hop = async () => {
  let wait = HOP_MS;
  if (asleep) { wait += readyAt ? Math.max(0, readyAt - Date.now()) : WAKE_MS; asleep = false; readyAt = 0; }
  await new Promise((resolve) => setTimeout(resolve, wait));
};
const messages: DirectMessageStorage = {
  inbox: async (...a) => { await hop(); return base.inbox(...a); },
  page: async (...a) => { await hop(); return base.page(...a); },
  send: async (...a) => { await hop(); return base.send(...a); },
  readThrough: async (...a) => { await hop(); return base.readThrough(...a); },
  count: (...a) => base.count(...a),
  unread: (...a) => base.unread(...a),
  // The background wake: ready WAKE_MS after it is asked, reading nothing.
  wake: async () => { if (asleep && !readyAt) readyAt = Date.now() + WAKE_MS; },
};
const app = express(); app.use(express.json());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
app.use(workspaceRootRoutes({ workspaceUiDir: DIST }));
app.use('/workspace', workspaceRoutes({
  userStorage: users, orgStorage: orgs, directMessageStorage: messages, workspaceWebAuth: auth,
  workspaceWebOrigin: origin, workspaceUiDir: DIST, secretStorage: new InMemorySecretStorage(),
} as RouteDeps));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results: Record<string, number[]> = {};
const note = (label: string, ms: number) => { (results[label] ??= []).push(ms); };
try {
  for (const gap of GAPS) for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.createBrowserContext();
    const page: Page = await context.newPage();
    await page.setViewport(PHONE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 860 });
    const cdp = await page.createCDPSession();
    if (PHONE) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await context.setCookie({ name: 'acc_session', value: ana.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: ana.csrfToken, url: origin });
    asleep = true; readyAt = 0;
    await page.goto(`${origin}/overview?half=workplace&org=${org.orgId}`);
    await page.waitForSelector('#humanMessagesCard a.crow', { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, gap));
    upAtTap.push(!asleep || (readyAt > 0 && readyAt <= Date.now()));
    const t0 = Date.now();
    await tap(page, '#humanMessagesCard a.crow[href*="/messages"]');
    await page.waitForSelector('#screenMessages a.crow', { timeout: 30_000 });
    const list = Date.now() - t0;
    await tap(page, '#screenMessages a.crow');
    await page.waitForSelector('#screenDirectMessage [role=log] .chatmsg[data-message-id]', { timeout: 30_000 });
    note(`look ${gap / 1000} s, then tap: list`, list);
    note(`look ${gap / 1000} s, then tap: first message`, Date.now() - t0);
    note(`look ${gap / 1000} s: machine up at the tap (1 = yes)`, upAtTap.at(-1) ? 1 : 0);
    await context.close();
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  for (const [label, xs] of Object.entries(results)) console.log(`${label}\t${median(xs)}\t(${xs.join(', ')})`);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
