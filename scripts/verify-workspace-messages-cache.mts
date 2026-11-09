/**
 * Note #1102, in real Chrome: Direct messages open from what this person
 * already saw, while the read is still out, and the read lands behind it.
 * Every read here waits behind a gate the check opens, so "painted before the
 * answer" is a state, not a race. Fixture people, the real Workspace router,
 * SQLite storage.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-messages-cache.mts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
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
const out = process.env.OUT_DIR || '/home/agent/messages-cache-proof'; mkdirSync(out, { recursive: true });
const chromeRoot = `${process.env.HOME}/.cache/puppeteer/chrome`;
const chrome = process.env.CHROME || path.join(chromeRoot, readdirSync(chromeRoot).sort().at(-1)!, 'chrome-linux64/chrome');

const users = new InMemoryUserStorage(), orgs = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgs);
const auth = new WorkspaceWebAuthService(new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(randomBytes(32).toString('base64')));
const enroll = async (username: string, first: string, last: string) => {
  const seed = await auth.startEnrollment(username);
  const issued = await auth.finishEnrollment({ enrollmentToken: seed.enrollmentToken, code: generateTotpCode(seed.secret) });
  await users.updateProfile(issued.userId, { person: { firstName: first, lastName: last } });
  return issued;
};
const ana = await enroll('fixture_ana', 'Ana', 'Reyes'), ben = await enroll('fixture_ben', 'Ben', 'Okafor'), cy = await enroll('fixture_cy', 'Cy', 'Lund');
const org = await orgs.createOrg({ name: 'Fixture Studio', createdByUserId: ana.userId });
for (const [who, role] of [[ana, 'admin'], [ben, 'member'], [cy, 'member']] as const) await orgs.addMember({ orgId: org.orgId, userId: who.userId, role });

// The messaging machine, with its reads held behind a gate the check opens.
const db = openSqliteDb(':memory:');
const base = new SqliteDirectMessageStorage(db);
let gate: Promise<void> | null = null, release = () => {}, held = 0;
const shut = () => { gate = new Promise<void>((resolve) => { release = () => { gate = null; resolve(); }; }); };
const waitGate = async () => { if (gate) { held += 1; await gate; } };
const messages: DirectMessageStorage = {
  inbox: async (...a) => { await waitGate(); return base.inbox(...a); },
  page: async (...a) => { await waitGate(); return base.page(...a); },
  send: (...a) => base.send(...a),
  readThrough: (...a) => base.readThrough(...a),
  count: (...a) => base.count(...a),
  unread: (...a) => base.unread(...a),
};

const app = express(); app.use(express.json());
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
app.use(workspaceRootRoutes());
app.use('/workspace', workspaceRoutes({
  userStorage: users, orgStorage: orgs, directMessageStorage: messages, workspaceWebAuth: auth,
  workspaceWebOrigin: origin, workspaceUiDir: path.resolve('backend/dist/workspace-ui'), secretStorage: new InMemorySecretStorage(),
} as RouteDeps));

for (let n = 1; n <= 40; n += 1) {
  await base.send(org.orgId, n % 2 ? ben.userId : ana.userId, n % 2 ? ana.userId : ben.userId, `Planning line ${n}: the launch checklist, item ${n}.`, `seed-message-${String(n).padStart(4, '0')}`);
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const errors: string[] = [];
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (error) => errors.push(String(error)));
  const signIn = async (who: typeof ana) => {
    await context.deleteCookie(...(await context.cookies()));
    await context.setCookie({ name: 'acc_session', value: who.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: who.csrfToken, url: origin });
  };
  const thread = (id: string) => `${origin}/messages/${id}?org=${org.orgId}`;
  const lines = (p: Page) => p.$$eval('[role=log] .chatmsg[data-message-id]', (nodes) => nodes.map((node) => node.textContent ?? ''));
  const kept = (p: Page) => p.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('agentbuilt.dm.')));
  /** Counts every frame in which the conversation stood empty, from now on. */
  // A string, not a function: tsx names inner functions with a helper the page does not have.
  const watchEmpty = (p: Page) => p.evaluate(`(() => {
    window.emptyFrames = 0;
    const tick = () => {
      if (!document.querySelector('[role=log] .chatmsg[data-message-id]') && document.getElementById('screenDirectMessage')) window.emptyFrames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);

  // 1. A first visit reads, draws, and keeps it.
  await signIn(ana);
  await page.goto(thread(ben.userId));
  await page.waitForFunction(() => document.querySelectorAll('[role=log] .chatmsg[data-message-id]').length === 40, { timeout: 15_000 });
  check('the first visit draws the conversation and keeps it for Ana', (await kept(page)).some((key) => key.includes('fixture_ana')), JSON.stringify(await kept(page)));

  // 2. Leave and come back with the read held: it is all there at once, at the reader's line.
  await page.$eval('.chatpane', (node) => { node.scrollTop = 300; node.dispatchEvent(new Event('scroll')); });
  const stood = await page.$eval('.chatpane', (node) => Math.round(node.scrollTop));
  await tap(page, '#screenDirectMessage .back');
  await page.waitForSelector('#screenMessages', { timeout: 10_000 });
  shut();
  await tap(page, `#screenMessages a.crow[href*="${ben.userId}"]`);
  await page.waitForSelector('#screenDirectMessage [role=log] .chatmsg[data-message-id]', { timeout: 5_000 });
  const back = { lines: (await lines(page)).length, top: await page.$eval('.chatpane', (node) => Math.round(node.scrollTop)), loading: await page.$('#screenDirectMessage .empty[role=status]') };
  check('back in the conversation with the read still out: every message drawn, no loading line', back.lines === 40 && back.loading === null && held > 0, JSON.stringify({ ...back, loading: Boolean(back.loading), held }));
  check('…and standing where the reader left it', Math.abs(back.top - stood) <= 2, `${back.top} vs ${stood}`);
  await page.screenshot({ path: `${out}/cached-open-phone.png` });
  await settleAfterShot(page);

  // 3. The read lands behind it: a new message appends, the conversation never empties.
  await watchEmpty(page);
  await base.send(org.orgId, ben.userId, ana.userId, 'Fresh from Ben while Ana was away.', 'seed-message-fresh-0001');
  release();
  await page.waitForFunction(() => document.querySelector('[role=log]')?.textContent?.includes('Fresh from Ben'), { timeout: 10_000 });
  const after = await lines(page);
  const empties = await page.evaluate(() => (window as unknown as { emptyFrames: number }).emptyFrames);
  check('the fresh read appended the new message after the kept ones, with no empty frame', after.length === 41 && after.at(-1) === 'Fresh from Ben while Ana was away.' && empties === 0, JSON.stringify({ count: after.length, empties }));

  // 4. A reload paints from the browser's own copy before the read answers.
  shut(); held = 0;
  await page.goto(thread(ben.userId));
  await page.waitForSelector('#screenDirectMessage [role=log] .chatmsg[data-message-id]', { timeout: 10_000 });
  check('a reload draws the kept conversation while its read is held', (await lines(page)).length === 41 && held > 0, `${(await lines(page)).length} drawn, ${held} reads held`);
  release();
  // …and the list too.
  shut(); held = 0;
  await page.goto(`${origin}/messages?org=${org.orgId}`);
  await page.waitForSelector('#screenMessages a.crow', { timeout: 10_000 });
  check('the Messages list draws from the kept copy while its read is held', held > 0 && (await page.$eval('#screenMessages a.crow .ctext', (node) => node.textContent ?? '')).includes('Fresh from Ben'));
  await page.screenshot({ path: `${out}/cached-list-phone.png` });
  await settleAfterShot(page);
  release();

  // 5. Another person in the same browser, without anyone signing out: none of Ana's copy reaches them.
  await signIn(cy);
  shut(); held = 0;
  await page.goto(thread(ben.userId));
  await page.waitForSelector('#screenDirectMessage', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#screenDirectMessage .empty[role=status]')?.textContent === 'Loading conversation…', { timeout: 10_000 });
  const leak = { drawn: (await lines(page)).length, kept: await kept(page), text: await page.$eval('#screenDirectMessage', (node) => node.textContent ?? '') };
  check('Cy, in Ana\'s browser, sees nothing of hers and her copy is gone from it', leak.drawn === 0 && !leak.kept.some((key) => key.includes('fixture_ana')) && !leak.text.includes('Planning line'), JSON.stringify({ drawn: leak.drawn, kept: leak.kept }));
  release();
  await page.waitForFunction(() => document.querySelector('.chatempty')?.textContent?.includes('Say hello'), { timeout: 10_000 });

  // 6. Sign-out empties it.
  await signIn(ana);
  await page.goto(thread(ben.userId));
  await page.waitForFunction(() => document.querySelectorAll('[role=log] .chatmsg[data-message-id]').length === 41, { timeout: 15_000 });
  check('Ana has a kept copy again before signing out', (await kept(page)).some((key) => key.includes('fixture_ana')));
  await page.goto(`${origin}/profile`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#profileAccessCard button', { timeout: 10_000 });
  const signedOut = await page.$$eval('#profileAccessCard button', (buttons) => {
    const button = buttons.find((node) => /Sign out$/.test(node.textContent ?? '')) as HTMLButtonElement | undefined;
    button?.click(); return Boolean(button);
  });
  await page.waitForFunction(() => !Object.keys(localStorage).some((key) => key.startsWith('agentbuilt.dm.')), { timeout: 10_000 }).catch(() => {});
  check('signing out empties every kept list and conversation from the browser', signedOut && (await kept(page)).length === 0, JSON.stringify(await kept(page)));

  check('the browser stayed clean', errors.length === 0, errors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`PASS: kept conversation and list paint while the read is held, the reader's line is kept, the read appends with no empty frame, a reload paints from the browser, no cross-person copy, sign-out clears. Screenshots: ${out}`);
} finally {
  release();
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
