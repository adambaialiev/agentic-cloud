// Outreach (note #1089), in real Chrome on the real router: the owner's own
// screen for cold outreach. Made-up companies only (the real list lives on a
// note in the workplace, never in this public repository).
//
//   - the fixture owner sees all fourteen companies, the first batch in its
//     order, the gaps (no address, no city) shown and not filled, and their
//     local time right for the seven cities;
//   - a profile opens the note's own letter word for word, counted as note
//     #799 counts; a template's placeholders keep Send off;
//   - a press of Send leaves through the mail service as the owner, lands in
//     his Sent and on the timeline, and moves the company to Sent;
//   - a reply from the company's domain lands on the profile as Replied, and
//     a copy's first pulse with the company's domain makes it Installed;
//   - a member of the same workplace has no door, no screen and no route.
//
// Pictures at desk and phone width land in $OUT_DIR (default ~/mini-preview),
// named outreach-*.png.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-outreach.mts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import { MailboxService } from '../backend/src/services/mailbox-service.js';
import { SqliteMailboxStorage } from '../backend/src/services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../backend/src/services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../backend/src/services/sqlite/sqlite-db.js';
import { MailOutboxService } from '../backend/src/services/mail-outbox.js';
import type { OutboundMail } from '../backend/src/services/mail-sender.js';
import { OutreachService } from '../backend/src/services/outreach.js';
import { InMemoryOutreachStore } from '../backend/src/services/outreach-storage.js';
import { outreachLocalTime, outreachWordCount, parseOutreachSeed } from '../backend/src/shared/outreach.js';
import { fixtureOutreachSeed } from '../backend/src/shared/outreach-fixtures.js';
import type { CopyPulse } from '../backend/src/shared/copy-pulse.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../backend/src/services/workspace-web-auth.js';
import { harnessEstablishedWorkplace, harnessSignedIn, harnessWorkplace } from './workspace-harness-auth.mjs';
import { settleAfterShot, tap } from './browser-settle.mjs';

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
const PORT = Number(process.env.PORT || 4191);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const userStorage = new InMemoryUserStorage();
const db = openSqliteDb(':memory:');
const mailboxStorage = new SqliteMailboxStorage(db);
const mailboxes = new MailboxService(mailboxStorage);
const messages = new SqliteMailMessageStorage(db);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  { workspaceUrl: `${ORIGIN}/`, sender: { async sendVerification() {} } },
  mailboxes,
);
const orgStorage = new InMemoryOrgStorage();
harnessEstablishedWorkplace(orgStorage);

// The provider: what would leave, kept here instead.
const left: OutboundMail[] = [];
const outbox = new MailOutboxService({ mailboxes: mailboxStorage, messages, sender: { send: async (mail: OutboundMail) => { left.push(mail); return {}; } } });
const outreach = new OutreachService({
  store: new InMemoryOutreachStore(),
  outbox: () => outbox,
  mailboxes: mailboxStorage,
  senderName: async () => 'Adam Owner',
});

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes,
  mailMessages: messages,
  mailOutbox: outbox,
  orgStorage,
  outreach,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: path.join(REPO, 'backend/dist/workspace-ui'),
  workspaceUiDefault: 'react',
  agentLifecycle: {},
} as unknown as RouteDeps;

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
const text = (page: Page, selector: string) => page.$eval(selector, (node) => (node as HTMLElement).innerText.trim());
const value = (page: Page, selector: string) => page.$eval(selector, (node) => (node as HTMLInputElement).value);

const parsed = parseOutreachSeed(fixtureOutreachSeed());
if (!parsed.ok) throw new Error(parsed.error);
const SEED = parsed.seed;
const CITIES: Record<string, string> = {
  'northwind-health': 'San Francisco', 'fernhill-labs': 'Seattle', 'lakeview-data': 'Chicago', 'harbor-pine': 'New York',
  'capitol-ledger': 'Washington DC', 'aurora-clinic': 'Helsinki', 'tallow-co': 'Austin',
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) check('no console error', false, message.text());
  });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  const owner = await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'adam@example.com', { firstName: 'Adam', lastName: 'Owner' });
  const { org: workplace } = await harnessWorkplace(orgStorage, { userId: owner.userId, name: 'ACC' });
  await userStorage.updateProfile(owner.userId, { roles: { admin: true } } as never);
  await outreach.import(owner.userId, SEED);

  // 1. The list, at a desk.
  await page.goto(`${ORIGIN}/outreach`);
  await page.waitForFunction(() => document.querySelectorAll('#screenOutreach .outreachrow').length === 14, { timeout: 20_000 });
  const batch = await page.$$eval('#outreach-batch .outreachrow', (rows) => rows.map((row) => row.getAttribute('data-target')));
  check('all fourteen companies, the first batch of ten in the note\'s order', batch.length === 10 && batch[0] === 'northwind-health' && batch[9] === 'meridian-policy', JSON.stringify(batch));
  const sections = await page.$$eval('#screenOutreach section h2', (heads) => heads.map((head) => head.textContent));
  check('then the groups, the dropped last', JSON.stringify(sections) === JSON.stringify(['First batch', 'Group B', 'Group C', 'Not a fit']), JSON.stringify(sections));
  const solace = await text(page, '[data-target="solace-studio"]');
  check('a company with no address says so, and no city says so', solace.includes('No address on note #799') && solace.includes('No city'), solace);
  const juniper = await text(page, '[data-target="juniper-works"]');
  check('"US remote" gets no guessed time', juniper.includes('US remote · no local time'), juniper);
  for (const [id, city] of Object.entries(CITIES)) {
    const row = await text(page, `[data-target="${id}"]`);
    // Read once; a minute may turn between the page drawing it and this line.
    const now = Date.now();
    const want = [outreachLocalTime(city, new Date(now)), outreachLocalTime(city, new Date(now - 60_000))];
    check(`${city}: local time right`, want.some((time) => row.includes(`${city} · ${time} there`)), `${row} / ${want.join(' or ')}`);
  }
  await page.screenshot({ path: path.join(OUT, 'outreach-list-desk.png'), fullPage: true });
  await settleAfterShot(page);

  // 2. One profile: the note's own letter, word for word.
  await tap(page, '[data-target="northwind-health"]');
  await page.waitForSelector('#outreachTextField', { timeout: 20_000 });
  const letter = SEED.targets[0]!.firstEmail!;
  const box = await value(page, '#outreachTextField');
  check('the ready letter is prefilled word for word', box === letter.body, JSON.stringify(box.slice(0, 60)));
  check('…with its subject', (await value(page, '#outreachSubjectField')) === letter.subject);
  const count = await text(page, '#outreachWordCount');
  check('the live word count is note #799\'s', count.startsWith(`${outreachWordCount(letter.subject, letter.body)} words · `), count);
  check('the "not this address" warning is shown', (await text(page, '#outreachNotThis')).includes('patient line'));
  check('the signal shows where it was read', (await text(page, '#outreachSignal')).includes('Source: their careers page'));
  await page.screenshot({ path: path.join(OUT, 'outreach-profile-desk.png'), fullPage: true });
  await settleAfterShot(page);

  // 3. The press.
  check('nothing has left before the press', left.length === 0, String(left.length));
  await tap(page, '#outreachSendGo');
  await page.waitForFunction(() => document.querySelector('#outreachTargetSub')?.textContent === 'Sent', { timeout: 20_000 });
  await page.waitForSelector('#outreachTouches [data-kind="sent"]', { timeout: 20_000 });
  const sentMail = left[0];
  check('one letter left, as the owner, to the company, with exactly the words', left.length === 1
    && sentMail!.from.address === owner.address && sentMail!.from.name === 'Adam Owner'
    && sentMail!.to[0]!.address === 'mara@northwind-health.test' && sentMail!.text === `${letter.body}\n` && !('html' in sentMail!),
  JSON.stringify({ n: left.length, from: sentMail?.from, to: sentMail?.to }));
  const inSent = await page.evaluate(async () => (await fetch('/workspace/api/mail/messages?in=sent')).json()) as { messages?: Array<{ to?: string; subject?: string }> };
  check('it is in the owner\'s Sent', JSON.stringify(inSent).includes('mara@northwind-health.test'), JSON.stringify(inSent).slice(0, 200));
  const after = await text(page, '#outreachSend');
  check('the next letter is the day-4 follow-up, not yet due', after.startsWith('Day-4 follow-up on'), after);

  // 4. A reply from their domain, and an install. Off the screen first: it polls nothing, but the rule holds.
  await page.goto('about:blank');
  await outreach.noteArrival({ id: 'mm_reply_fixture', address: owner.address, from: 'cto@northwind-health.test', subject: 'Re: Your agents need a workplace', receivedAt: new Date().toISOString() });
  await outreach.notePulse({ copyId: 'copy-fixture-1', domain: 'agents.lakeview-data.test', contactName: 'Ines', contactEmail: 'ops@elsewhere.test' } as CopyPulse);
  await page.goto(`${ORIGIN}/outreach/northwind-health`);
  await page.waitForFunction(() => document.querySelector('#outreachTargetSub')?.textContent === 'Replied', { timeout: 20_000 });
  check('the reply is on the timeline', (await text(page, '#outreachTouches')).includes('Reply from cto@northwind-health.test'));
  await page.screenshot({ path: path.join(OUT, 'outreach-replied-desk.png'), fullPage: true });
  await settleAfterShot(page);
  await page.goto(`${ORIGIN}/outreach/lakeview-data`);
  await page.waitForFunction(() => document.querySelector('#outreachTargetSub')?.textContent === 'Installed', { timeout: 20_000 });
  check('a pulse from their domain made them Installed', (await text(page, '#outreachTouches')).includes('agents.lakeview-data.test'));

  // 5. A template: Send stays off while a placeholder is in the box.
  await page.goto(`${ORIGIN}/outreach/kestrel-systems`);
  await page.waitForSelector('#outreachPlaceholders', { timeout: 20_000 });
  check('a template placeholder keeps Send off', await page.$eval('#outreachSendGo', (node) => (node as HTMLButtonElement).disabled));

  // 6. The phone.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${ORIGIN}/outreach`);
  await page.waitForFunction(() => document.querySelectorAll('#screenOutreach .outreachrow').length === 14, { timeout: 20_000 });
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('the list fits a phone with no sideways scroll', fits);
  await page.screenshot({ path: path.join(OUT, 'outreach-list-phone.png') });
  await settleAfterShot(page);
  await page.goto(`${ORIGIN}/outreach/fernhill-labs`);
  await page.waitForSelector('#outreachTextField', { timeout: 20_000 });
  check('the profile fits a phone with no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(OUT, 'outreach-profile-phone.png') });
  await settleAfterShot(page);

  // 7. A member of the same workplace: no door, no screen, no route.
  const member = await browser.createBrowserContext();
  const other = await member.newPage();
  await other.setViewport({ width: 1280, height: 900 });
  const joiner = await harnessSignedIn(other, workspaceWebAuth, ORIGIN, 'dana@example.com', { firstName: 'Dana', lastName: 'Member' });
  await orgStorage.addMember({ orgId: workplace.orgId, userId: joiner.userId, role: 'member' });
  await orgStorage.setActiveOrg(joiner.userId, workplace.orgId);
  await other.goto(`${ORIGIN}/outreach`);
  await other.waitForFunction(() => document.body.innerText.includes('This is not a Workspace address we know'), { timeout: 20_000 });
  check('a member gets no Outreach screen', !(await other.$('#screenOutreach')));
  const refused = await other.evaluate(async () => {
    const list = await fetch('/workspace/api/outreach');
    const one = await fetch('/workspace/api/outreach/targets/northwind-health');
    const csrf = document.cookie.split('; ').find((part) => part.includes('csrf'))?.split('=')[1] ?? '';
    const send = await fetch('/workspace/api/outreach/targets/fernhill-labs/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ step: 'first', subject: 's', text: 't' }),
    });
    return [list.status, one.status, send.status];
  });
  check('…and every route refuses them', refused.every((status) => status === 403), JSON.stringify(refused));
  check('…and nothing left on their press', left.length === 1, String(left.length));
  await member.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
