/**
 * Note #1090, in real Chrome: the Chief of Staff's draft of a direct message
 * to a teammate is decided on a card in the person's own conversation with
 * it, and only the tap sends it — into the teammate's Direct messages, as
 * the person, marked "via their Chief of Staff". Two fixture people in one
 * workplace, two browser sessions, the real Workspace router, SQLite.
 *
 *   npm --prefix backend run build:workspace-ui
 *   OUT_DIR=/tmp/shots backend/node_modules/.bin/tsx scripts/verify-workspace-member-message.mts
 *
 * The card is seeded as the row `agentbuilt member message` places (the
 * route and its refusals are unit-tested in direct-message-approval.test.ts);
 * everything after it — the read, the tap, the send, the mark — is the
 * product's own path.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
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
import { DirectMessageApprovalService, SqliteDirectMessageApprovalStorage } from '../backend/src/services/direct-message-approval.js';

const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || '/home/agent/member-message-proof'; mkdirSync(out, { recursive: true });
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
// Fixture people, never real ones.
const owner = await enroll('fixture_owner', 'Rowan', 'Vale'), mate = await enroll('fixture_mate', 'Tamsin', 'Okoro');
const org = await orgs.createOrg({ name: 'Fixture Studio', createdByUserId: owner.userId });
await orgs.addMember({ orgId: org.orgId, userId: owner.userId, role: 'admin' });
await orgs.addMember({ orgId: org.orgId, userId: mate.userId, role: 'member' });

const db = openSqliteDb(':memory:');
const messages = new SqliteDirectMessageStorage(db);
const approvals = new DirectMessageApprovalService(new SqliteDirectMessageApprovalStorage(db), () => messages,
  async (orgId, userId) => Boolean(await orgs.getMembership(orgId, userId)));

const app = express(); app.use(express.json());
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
app.use(workspaceRootRoutes());
app.use('/workspace', workspaceRoutes({
  userStorage: users, orgStorage: orgs, directMessageStorage: messages, directMessageApprovals: approvals, workspaceWebAuth: auth,
  workspaceWebOrigin: origin, workspaceUiDir: path.resolve('backend/dist/workspace-ui'), secretStorage: new InMemorySecretStorage(),
} as RouteDeps));

// The person's Chief of Staff, and the two rows its `member message` would
// have placed in their conversation: one to send, one to refuse.
const at = new Date(Date.now() - 60_000).toISOString();
const wa = await users.reserveWorkspaceAssistant(owner.userId, org.orgId);
if (!wa) throw new Error('the Workspace Agent was not reserved');
const to = { userId: mate.userId, name: 'Tamsin Okoro' };
// Paragraphs, a line break inside one, a list with bold — what an agent
// writes (Adam, 9 Nov 13:25 UTC: it must read well formatted on BOTH screens).
const words = 'Tamsin, the review moved to Thursday at 3.\nRoom 4, second floor.\n\nPlease bring:\n- the launch deck\n- **the budget sheet**\n\nThanks!';
/** The shape a reader sees: each block's tag and rendered lines. */
const SHAPE = [
  { tag: 'P', lines: ['Tamsin, the review moved to Thursday at 3.', 'Room 4, second floor.'] },
  { tag: 'P', lines: ['Please bring:'] },
  { tag: 'UL', lines: ['the launch deck', 'the budget sheet'] },
  { tag: 'P', lines: ['Thanks!'] },
];
const shapeOf = (root: Element | null) => [...(root?.querySelector('.chatmarkdown')?.children ?? [])].map((block) => ({
  tag: block.tagName,
  lines: block.tagName === 'UL' ? [...block.querySelectorAll('li')].map((li) => (li as HTMLElement).innerText.trim()) : (block as HTMLElement).innerText.split('\n').map((line) => line.trim()),
  bold: [...block.querySelectorAll('strong')].map((b) => b.textContent),
}));
const keep = await approvals.request({ userId: owner.userId, orgId: org.orgId, agentId: wa.id, to, text: words });
const drop = await approvals.request({ userId: owner.userId, orgId: org.orgId, agentId: wa.id, to, text: 'Not this one.' });
const row = (id: string, approvalId: string) => ({ id, role: 'action' as const, at, text: 'Workspace Agent wants to send Tamsin Okoro a direct message. Nothing will be sent until you approve it here.', messageApprovalId: approvalId });
await orgs.touchMember(org.orgId, owner.userId, {
  workspaceAgentSettings: { cli: 'claude', model: 'opus', effort: 'high' },
  workspaceRecapChat: {
    messages: [
      { id: 'o1', role: 'owner' as const, at, text: 'Tell Tamsin the review moved to Thursday at 3, and to bring the deck.' },
      row('c1', keep.id),
      { id: 'a1', role: 'assistant' as const, at, text: 'It is on a card above, waiting for your tap.' },
      row('c2', drop.id),
    ],
    receipts: [], pending: [],
  },
} as never);

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const errors: string[] = [];
  const open = async (session: typeof owner) => {
    const context = await browser.createBrowserContext();
    await context.setCookie({ name: 'acc_session', value: session.token, url: origin, httpOnly: true }, { name: 'acc_csrf', value: session.csrfToken, url: origin });
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('response', (response) => { if (response.status() >= 400 && !response.url().includes('/favicon')) errors.push(`${response.status()} ${response.url()}`); });
    return page;
  };
  const a = await open(owner), b = await open(mate);

  // The card, in the person's own conversation: the teammate, the exact words, two answers.
  await a.goto(`${origin}/?org=${org.orgId}`);
  const card = `#recapChatLog [data-message-approval="${keep.id}"]`;
  await a.waitForSelector(`${card} .mailapprovaltext`, { timeout: 15_000 });
  const drawn = await a.$eval(card, (node) => ({
    label: node.querySelector('.chatnoticelabel')?.textContent,
    title: node.querySelector('.chatnoticetitle')?.textContent,
    raw: (node.querySelector('.mailapprovaltext') as HTMLElement | null)?.innerText ?? '',
    buttons: [...node.querySelectorAll('button')].map((button) => button.textContent),
    links: node.querySelectorAll('a').length,
  }));
  const cardShape = await a.evaluate(`(${shapeOf.toString()})(document.querySelector('${card} .mailapprovaltext'))`) as ReturnType<typeof shapeOf>;
  check('the card says what it is and to whom', drawn.label === 'Direct message'
    && drawn.title === 'Chief of Staff wants to send this to Tamsin Okoro', JSON.stringify(drawn));
  check('the card draws the words well formatted: paragraphs, the line break, the list, no markup',
    JSON.stringify(cardShape.map(({ tag, lines }) => ({ tag, lines }))) === JSON.stringify(SHAPE)
    && JSON.stringify(cardShape[2]?.bold) === JSON.stringify(['the budget sheet']) && !/\*\*|^\s*- /m.test(drawn.raw), JSON.stringify(cardShape));
  check('two answers and no door while it waits', JSON.stringify(drawn.buttons) === JSON.stringify(['Send message', 'Don’t send']) && drawn.links === 0, JSON.stringify(drawn));
  check('nothing has reached the teammate before the tap', (await messages.inbox(org.orgId, mate.userId)).length === 0);
  check('nothing overflows the phone', await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.$eval(card, (node) => node.scrollIntoView({ block: 'center' }));
  await a.screenshot({ path: `${out}/card-waiting-phone.png` });
  await settleAfterShot(a);

  // The tap.
  await tap(a, `${card} button.btn.primary`);
  await a.waitForFunction((selector) => document.querySelector(`${selector} .chatnoticestatus`)?.textContent === 'Sent', { timeout: 10_000 }, card);
  const after = await a.$eval(card, (node) => ({
    answer: node.querySelector('.mailapprovalanswer')?.textContent,
    text: node.querySelector('.mailapprovaltext')?.textContent ?? null,
    buttons: node.querySelectorAll('button').length,
    href: node.querySelector('a')?.getAttribute('href'),
  }));
  check('sent: the card says so, keeps no words, and opens the conversation', after.answer === 'Sent to Tamsin Okoro. Open the conversation'
    && after.text === null && after.buttons === 0 && after.href === `/messages/${mate.userId}?org=${org.orgId}`, JSON.stringify(after));
  const stored = db.prepare('SELECT status, doc FROM workspace_message_approvals').all() as Array<{ status: string; doc: string }>;
  check('the platform keeps no words of the sent draft', stored.some((one) => one.status === 'sent') && !stored.some((one) => one.status === 'sent' && one.doc.includes('Thursday')), JSON.stringify(stored.map((one) => one.status)));
  await a.screenshot({ path: `${out}/card-sent-phone.png` });
  await settleAfterShot(a);

  // The other card: refused, nothing more goes.
  const second = `#recapChatLog [data-message-approval="${drop.id}"]`;
  await tap(a, `${second} button.btn.danger`);
  await a.waitForFunction((selector) => document.querySelector(`${selector} .chatnoticestatus`)?.textContent === 'Not sent', { timeout: 10_000 }, second);
  check('refused: Not sent, and the words are gone from it', await a.$eval(second, (node) => !node.querySelector('.mailapprovaltext')
    && node.querySelector('.mailapprovalanswer')?.textContent === 'Nothing was sent.'));

  // What the teammate sees: one message, from the person, marked.
  await b.goto(`${origin}/messages/${owner.userId}?org=${org.orgId}`);
  await b.waitForSelector('[role=log] .chatmsg[data-message-id] .dmvia', { timeout: 15_000 });
  const theirs = await b.$$eval('[role=log] .chatmsg[data-message-id]', (nodes) => nodes.map((node) => ({
    side: node.classList.contains('owner') ? 'mine' : 'theirs',
    raw: (node.querySelector('.chatmarkdown') as HTMLElement | null)?.innerText ?? node.textContent ?? '',
    via: node.querySelector('.dmvia')?.textContent,
  })));
  check('the teammate has exactly one message, from the person, marked via their Chief of Staff', theirs.length === 1
    && theirs[0]?.side === 'theirs' && theirs[0]?.via === 'via their Chief of Staff', JSON.stringify(theirs));
  const dmShape = await b.evaluate(`(${shapeOf.toString()})(document.querySelector('[role=log] .chatmsg[data-message-id]'))`) as ReturnType<typeof shapeOf>;
  check('it reads exactly as the card did: the same paragraphs, line break, list and bold, no markup',
    JSON.stringify(dmShape) === JSON.stringify(cardShape) && !/\*\*|^\s*- /m.test(theirs[0]?.raw ?? ''), JSON.stringify(dmShape));
  check('what the messaging storage holds is the agent\'s words, whole', (await messages.page(org.orgId, mate.userId, owner.userId, 5)).messages[0]?.text === words);
  check('the header names the person it came from', await b.$eval('.chatwho h1', (node) => node.textContent) === 'Rowan Vale');
  await b.screenshot({ path: `${out}/teammate-conversation-phone.png` });
  await settleAfterShot(b);

  // And the person, through the card's door, sees their own side marked.
  await a.$eval(card, (node) => node.scrollIntoView({ block: 'center' }));
  await tap(a, `${card} a`);
  await a.waitForSelector('#screenDirectMessage [role=log] .chatmsg .dmvia', { timeout: 10_000 });
  const mine = await a.$eval('#screenDirectMessage [role=log] .chatmsg', (node) => ({ side: node.className, via: node.querySelector('.dmvia')?.textContent }));
  check('the person\'s own side reads via your Chief of Staff', mine.side.includes('owner') && mine.via === 'via your Chief of Staff', JSON.stringify(mine));
  await a.setViewport({ width: 1280, height: 860, isMobile: false, hasTouch: false });
  await a.waitForSelector('#screenDirectMessage [role=log] .chatmsg .dmvia', { timeout: 10_000 });
  await a.screenshot({ path: `${out}/person-conversation-desk.png` });

  check('the browsers stayed clean', errors.length === 0, errors.join(' | '));
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`PASS: card in the Chief of Staff conversation, the tap sends once as the person, the teammate sees it marked; refused sends nothing; no words kept. Screenshots: ${out}`);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
