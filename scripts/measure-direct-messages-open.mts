/**
 * Note #1102: how long Direct messages take to show something useful, step
 * by step, for one Workspace build. Not a check (it asserts nothing and is
 * not named verify-*): run it against two builds to compare them.
 *
 *   DIST=backend/dist/workspace-ui PROFILE=phone WAKE_MS=5000 \
 *     backend/node_modules/.bin/tsx scripts/measure-direct-messages-open.mts
 *
 * The messaging machine is modelled by what was measured on production on
 * 9 Nov 2026: HOP_MS per read while it is awake, and WAKE_MS added to the
 * first read after it has gone to sleep. PROFILE=phone adds 150 ms of round
 * trip, 1.6 Mbit/s down, 750 kbit/s up and a 4x slower CPU.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { harnessEstablishedWorkplace } from './workspace-harness-auth.mjs';
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

let asleep = false;
const hop = async () => {
  const wait = asleep ? WAKE_MS + HOP_MS : HOP_MS; asleep = false;
  await new Promise((resolve) => setTimeout(resolve, wait));
};
const messages: DirectMessageStorage = {
  inbox: async (...a) => { await hop(); return base.inbox(...a); },
  page: async (...a) => { await hop(); return base.page(...a); },
  send: async (...a) => { await hop(); return base.send(...a); },
  readThrough: async (...a) => { await hop(); return base.readThrough(...a); },
  count: (...a) => base.count(...a),
  unread: (...a) => base.unread(...a),
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
const LIST = '#screenMessages a.crow', MESSAGE = '#screenDirectMessage [role=log] .chatmsg[data-message-id]';
const timed = async (p: Page, act: () => Promise<unknown>, selector: string) => {
  const t0 = Date.now(); await act();
  await p.waitForSelector(selector, { timeout: 30_000, polling: 'mutation' } as never);
  return Date.now() - t0;
};
const results: Record<string, number[]> = {};
const note = (label: string, ms: number) => { (results[label] ??= []).push(ms); };
try {
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(PHONE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 860 });
    const cdp = await page.createCDPSession();
    if (PHONE) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await context.setCookie({ name: 'acc_session', value: ana.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: ana.csrfToken, url: origin });
    const list = `${origin}/messages?org=${org.orgId}`, convo = `${origin}/messages/${ben.userId}?org=${org.orgId}`;
    const inApp = (to: string) => page.evaluate((target) => { history.pushState({}, '', target); dispatchEvent(new PopStateEvent('popstate')); }, to);
    // A tab already open on the Workspace (the shell is loaded), then:
    await page.goto(`${origin}/?org=${org.orgId}`); await page.waitForSelector('#screenHome', { timeout: 30_000 });
    asleep = true; note('1 open the list, machine asleep', await timed(page, () => inApp(list), LIST));
    note('2 open a conversation (first time)', await timed(page, () => inApp(convo), MESSAGE));
    note('3 back to the list', await timed(page, () => inApp(list), LIST));
    note('4 the conversation again', await timed(page, () => inApp(convo), MESSAGE));
    asleep = true; await inApp(`/?org=${org.orgId}`); await page.waitForSelector('#screenHome');
    note('5 the conversation again, machine asleep', await timed(page, () => inApp(convo), MESSAGE));
    asleep = true; note('6 reload the conversation, machine asleep', await timed(page, () => page.goto(convo), MESSAGE));
    note('7 reload the conversation, machine awake', await timed(page, () => page.goto(convo), MESSAGE));
    await context.close();
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  for (const [label, xs] of Object.entries(results)) console.log(`${label}\t${median(xs)} ms\t(${xs.join(', ')})`);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
