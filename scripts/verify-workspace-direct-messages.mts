// Real browser sessions, real Workspace endpoints and SQLite; no API mocks.
// Home is the Chief of Staff's conversation, its overview in two windows (note #715).
// npm --prefix backend run build && backend/node_modules/.bin/tsx scripts/verify-workspace-direct-messages.mts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { closeHomeWindow, openWorkplaceWindow } from './workspace-harness-home.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { harnessEstablishedWorkplace } from './workspace-harness-auth.mjs';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemorySecretStorage } from '../backend/src/services/secret-storage.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { generateTotpCode } from '../backend/src/utils/totp.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { SqliteDirectMessageStorage } from '../backend/src/services/sqlite/sqlite-direct-message-storage.js';
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || '/home/agent/dm-proof'; mkdirSync(out, { recursive: true });
const chromeRoot = `${process.env.HOME}/.cache/puppeteer/chrome`;
const chrome = process.env.CHROME || path.join(chromeRoot, readdirSync(chromeRoot).sort().at(-1)!, 'chrome-linux64/chrome');
const users = new InMemoryUserStorage(), orgs = new InMemoryOrgStorage();
// Past the setup gate, for BOTH people: the lock is per reader, so without a
// live seat of his own Bob's browser would hold on setup while Alice's opened
// and every wait on his side would time out.
harnessEstablishedWorkplace(orgs);
const auth = new WorkspaceWebAuthService(new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(randomBytes(32).toString('base64')));
const enroll = async (username: string, name: string) => {
  const seed = await auth.startEnrollment(username);
  const issued = await auth.finishEnrollment({ enrollmentToken: seed.enrollmentToken, code: generateTotpCode(seed.secret) });
  await users.updateProfile(issued.userId, { person: { firstName: name, lastName: '' } });
  return issued;
};
const alice = await enroll('alice', 'Alice Morgan'), bob = await enroll('bob', 'Mira Chen');
const org = await orgs.createOrg({ name: 'Northstar Studio', createdByUserId: alice.userId });
await orgs.addMember({ orgId: org.orgId, userId: alice.userId, role: 'admin' });
await orgs.addMember({ orgId: org.orgId, userId: bob.userId, role: 'member' });
const db = openSqliteDb(':memory:'), messages = new SqliteDirectMessageStorage(db);
const app = express(); app.use(express.json());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
app.use(workspaceRootRoutes()); // the shell answers at the root of the domain (public-addresses)
// Each person's own mail address, so Home's Messages card shows Mail beside
// Direct messages as it does in production.
const mailboxes = { forUser: async (userId: string) => ({ userId, address: `${userId === alice.userId ? 'alice' : 'mira'}@northstar.test` }) };
app.use('/workspace', workspaceRoutes({ userStorage: users, orgStorage: orgs, directMessageStorage: messages, workspaceWebAuth: auth, mailboxes: mailboxes as never,
  workspaceWebOrigin: origin, workspaceUiDir: path.resolve('backend/dist/workspace-ui'), secretStorage: new InMemorySecretStorage(),
} as RouteDeps));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const contextA = await browser.createBrowserContext(), contextB = await browser.createBrowserContext();
  const errors: string[] = [];
  const setup = async (context: typeof contextA, session: typeof alice) => {
    await context.setCookie({ name: 'acc_session', value: session.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: session.csrfToken, url: origin });
    const page = await context.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', error => errors.push(String(error))); return page;
  };
  const a = await setup(contextA, alice), b = await setup(contextB, bob);
  const thread = (id: string) => `${origin}/messages/${id}?org=${org.orgId}`;
  // On again (29 Oct 2026). Every door a person would look for: Home's
  // Workplace window has the Messages card (Direct messages beside Mail)
  // under the team, whose teammate plate carries the send mark; the
  // teammate's own page has its Message button. Desk and phone, pictured.
  const doors = async (width: number, height: number, mobile: boolean, tag: string) => {
    await a.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    await openWorkplaceWindow(a, origin);
    await a.waitForSelector('#homeSheet #humanMessagesCard', { timeout: 10_000 });
    const card = await a.$eval('#humanMessagesCard', node => node.textContent ?? '');
    assert.ok(card.includes('Direct messages') && card.includes('Mail'), card);
    await a.waitForSelector(`#homePeople [data-person="${bob.userId}"] [data-row-door]`);
    assert.equal(await a.$(`#homePeople [data-person="${alice.userId}"] [data-row-door]`), null);
    // The picture starts at the team's heading: who is here, then how to reach them.
    await a.evaluate(() => {
      const head = document.getElementById('peopleHead');
      const sheet = head?.closest('.sheetbody, [role=dialog], #homeSheet');
      head?.scrollIntoView({ block: 'start' });
      if (sheet && sheet !== document.body) (sheet as HTMLElement).scrollBy(0, -12);
    });
    await a.screenshot({ path: `${out}/home-doors-${tag}.png` });
    await settleAfterShot(a);
    await closeHomeWindow(a);
    await a.goto(`${origin}/workplace/members/${bob.userId}?org=${org.orgId}`);
    await a.waitForSelector('#orgMemberActions .addrow');
    assert.deepEqual(await a.$$eval('#screenOrgMember .addrow', rows => rows.map(row => row.textContent)), ['Message Mira Chen', 'Make admin']);
    await a.screenshot({ path: `${out}/member-${tag}.png`, fullPage: true });
    await settleAfterShot(a);
  };
  await doors(1280, 900, false, 'desktop');
  await doors(390, 844, true, 'mobile');
  // The plate's mark is a real way in: it opens the conversation.
  await openWorkplaceWindow(a, origin);
  await a.waitForSelector(`#homePeople [data-person="${bob.userId}"] [data-row-door]`);
  await a.click(`#homePeople [data-person="${bob.userId}"] [data-row-door]`);
  await a.waitForSelector('#screenDirectMessage textarea:not([disabled])');
  assert.equal(a.url(), thread(bob.userId));
  await a.type('textarea', 'Hi Mira! Is the launch page ready for a final look?'); await a.click('#directMessageForm button.chatsend');
  await a.waitForFunction(() => document.querySelectorAll('.chatmsg.owner').length === 1);
  assert.equal(await messages.unread(org.orgId, bob.userId), 1);
  await b.goto(`${origin}/messages?org=${org.orgId}`); await b.waitForSelector('.unreaddot');
  await b.screenshot({ path: `${out}/inbox-mobile.png`, fullPage: true });
  await settleAfterShot(b);
  await b.click('#screenMessages .addrow'); await b.waitForSelector('#screenNewMessage .plates .crow');
  await b.screenshot({ path: `${out}/people-picker-mobile.png`, fullPage: true });
  await settleAfterShot(b);
  await b.click('#pageBack'); await b.waitForSelector('#screenMessages .crow');
  await b.click('#screenMessages .card .crow'); await b.waitForSelector('textarea:not([disabled])');
  await b.waitForFunction(() => document.querySelector('[role=log]')?.textContent?.includes('launch page'));
  assert.equal(await messages.unread(org.orgId, bob.userId), 0);
  await b.type('textarea', 'Yes — the new photos are in. I’ll send the final copy after lunch.'); await b.click('#directMessageForm button.chatsend');
  await a.waitForFunction(() => document.querySelector('[role=log]')?.textContent?.includes('after lunch'), { timeout: 10000 });
  await a.type('textarea', 'Perfect. I’ll check the mobile layout and we can publish together.'); await a.click('#directMessageForm button.chatsend');
  await a.waitForFunction(() => document.querySelectorAll('.chatmsg.owner').length === 2);
  await a.screenshot({ path: `${out}/conversation-mobile.png`, fullPage: true });
  const geometry = await a.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, height: innerHeight,
    bottom: document.querySelector('#directMessageForm')!.getBoundingClientRect().bottom, head: document.querySelector('.chathead')!.getBoundingClientRect().height,
    paneBottom: document.querySelector('.chatpane')!.getBoundingClientRect().bottom, composerTop: document.querySelector('#directMessageForm')!.getBoundingClientRect().top }));
  assert.equal(geometry.width, geometry.viewport); assert.ok(Math.abs(geometry.bottom - geometry.height) < 2, JSON.stringify(geometry));
  assert.equal(geometry.paneBottom, geometry.composerTop); assert.equal(geometry.head, 49);
  const controls = await a.evaluate(() => ({
    sendWidth: document.querySelector('.chatsend')!.getBoundingClientRect().width,
    sendHeight: document.querySelector('.chatsend')!.getBoundingClientRect().height,
    bubbleFont: getComputedStyle(document.querySelector('.chatmsg.owner')!).fontSize,
    bubbleFill: getComputedStyle(document.querySelector('.chatmsg.owner')!).backgroundColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    tail: getComputedStyle(document.querySelector('.chatmsg.owner')!).borderBottomRightRadius,
    day: document.querySelector('.chatday')?.textContent,
  }));
  assert.equal(controls.sendWidth, 40); assert.equal(controls.sendHeight, 40);
  // The transcript took a reading size on 2026-09-08 (3b5c05e8): a message
  // is read, not scanned, so the bubble is 17px and not the UI base.
  assert.equal(controls.bubbleFont, '17px'); assert.equal(controls.tail, '4px'); assert.equal(controls.day, 'Today');
  const shortHeight = await a.$eval('textarea', node => node.getBoundingClientRect().height);
  await a.type('textarea', 'A longer draft');
  await a.keyboard.down('Shift'); await a.keyboard.press('Enter'); await a.keyboard.up('Shift');
  await a.type('textarea', 'with another line');
  await a.keyboard.down('Shift'); await a.keyboard.press('Enter'); await a.keyboard.up('Shift');
  await a.type('textarea', 'and one more');
  assert.ok(await a.$eval('textarea', node => node.getBoundingClientRect().height > 70));
  await a.$eval('textarea', node => { const field = node as HTMLTextAreaElement; field.select(); });
  await a.keyboard.press('Backspace');
  assert.equal(await a.$eval('textarea', node => node.getBoundingClientRect().height), shortHeight);
  // Older history loads without moving the line under the reader's eye.
  for (let n = 0; n < 65; n++) await messages.send(org.orgId, alice.userId, bob.userId, `Earlier planning message ${n + 1}. Keeping the launch simple.`, `history-message-${n}`);
  await a.reload(); await a.waitForSelector('.chatpane > .addrow');
  await a.$eval('.chatpane', node => { node.scrollTop = 0; });
  await a.click('.chatpane > .addrow'); await a.waitForFunction(() => document.querySelectorAll('.chatmsg[data-message-id]').length === 68);
  assert.ok(await a.$eval('.chatpane', node => node.scrollTop > 0));
  // Leaving the phone's viewport reloads the page: wait for the conversation
  // to be back on screen before the picture, or it shows "Loading conversation…".
  await a.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
  await a.waitForFunction(() => document.querySelectorAll('[role=log] .chatmsg').length > 0, { timeout: 10_000 });
  await a.screenshot({ path: `${out}/conversation-desktop.png`, fullPage: true });
  // Closing membership also reaches an already-open screen on its next poll.
  await orgs.removeMember(org.orgId, bob.userId);
  await a.waitForFunction(() => document.querySelector('#directMessageForm')?.textContent?.includes('left the workplace'), { timeout: 10000 });
  await b.waitForFunction(() => document.querySelectorAll('.chatmsg[data-message-id]').length === 0, { timeout: 10000 });
  assert.equal(await a.$eval('textarea', node => (node as HTMLTextAreaElement).disabled), true);
  assert.deepEqual(errors, []);
  console.log('PASS: doors on desk and phone (Home Messages card beside Mail, teammate plate mark, Message button; the mark opens the conversation); two real browser sessions, sending and live replies, unread receipts, private inbox, mobile geometry, older history, desktop layout, membership revocation.');
  console.log(`Screenshots: ${out}`);
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
