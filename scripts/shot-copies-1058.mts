/**
 * The Copies screen (note #1058) in the real shell and real Chrome, at desk
 * and phone widths, against the fixture pulses (note #1057's exact shape):
 * the list with one copy of each kind, a copy's history, an opted-out copy,
 * the Write-to-contact draft, the account menu row, the empty list, and the
 * alerts as rows in the Chief of Staff's chat.
 *
 *   cd backend && npm run build:workspace-ui
 *   backend/node_modules/.bin/tsx scripts/shot-copies-1058.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { emptyState, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';
import { copyConditions, copyDay, copyRow, sortCopies, type CopyPulseRecord } from '../backend/src/shared/copy-pulse.js';
import { fixtureCopies, fixtureHistory } from '../backend/src/shared/copy-pulse-fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');

const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];
const now = new Date();
const records: CopyPulseRecord[] = [];
const days = new Map<string, ReturnType<typeof copyDay>[]>();
for (const { pulse, receivedAt } of fixtureCopies(now)) {
  const history = fixtureHistory(pulse, receivedAt);
  records.push({ copyId: pulse.copyId, firstSeenAt: receivedAt[0]!, lastSeenAt: receivedAt.at(-1)!, pulse: { ...history.at(-1)!.pulse, receivedAt: receivedAt.at(-1)! } });
  days.set(pulse.copyId, history.map((one) => copyDay({ copyId: pulse.copyId, day: one.receivedAt.slice(0, 10), lastSeenAt: one.receivedAt, pulse: { ...one.pulse, receivedAt: one.receivedAt } })).reverse());
}
let empty = false;
const org = { orgId: 'o1', name: 'ACC', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const state = () => emptyState({
  org,
  organizations: [{ ...org, active: true, members: 1, agents: 1 }],
  user: {
    name: 'Adam B',
    profile: { firstName: 'Adam', lastName: 'B', incomplete: false },
    account: {
      browserLogin: { enabled: true, method: 'email', email: 'adam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
      mailbox: { address: 'adam@agenticcloudcomputer.com' },
    },
  },
  copies: true,
});
// The alerts as the sweep lands them, rows only (event turns off).
const alertRows = records.flatMap((record) => copyConditions(record, OFFERED, now).holding.map((alert, i) => ({
  id: `e-${record.copyId}-${i}`, role: 'action', kind: 'event', text: alert.text, href: `/copies/${record.copyId}`,
  at: new Date(now.getTime() - 20 * 60_000).toISOString(),
})));

const errors: string[] = [];
const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/copies', (_req, res) => res.json({ copies: empty ? [] : sortCopies(records.map((r) => copyRow(r, OFFERED, now))), latestRelease: OFFERED.at(-1) }));
app.get('/workspace/api/copies/:id', (req, res) => {
  const record = records.find((r) => r.copyId === req.params.id);
  if (!record) return res.status(404).json({ error: 'No copy by that id has sent a pulse.' });
  return res.json({ copy: copyRow(record, OFFERED, now), latestRelease: OFFERED.at(-1), days: days.get(record.copyId) });
});
app.get('/workspace/api/mail/messages', (_req, res) => res.json({ address: 'adam@agenticcloudcomputer.com', messages: [] }));
app.get('/workspace/api/mail/conversations', (_req, res) => res.json({ address: 'adam@agenticcloudcomputer.com', conversations: [] }));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/recap/chat', (_req, res) => res.json({ orgId: 'o1', messages: alertRows, working: false, waiting: [] }));
app.get('/workspace/api/recap/agent', (_req, res) => res.json({ orgId: 'o1', agent: { name: 'Workspace Agent', started: true, working: false, waiting: [] }, settings: null }));
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  res.status(404).json({ error: `Unscripted ${req.method} ${req.originalUrl}` });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function shoot(page: Page, where: string, ready: string, shot: string, label: string, full = true) {
  await page.goto(`http://127.0.0.1:${port}${where}`);
  await page.waitForSelector(ready, { visible: true, timeout: 15_000 });
  await pause(700);
  await page.screenshot({ path: path.join(out, shot), fullPage: full });
  console.log(`PASS: ${label}`);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  for (const [width, viewport] of [
    ['desktop', { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
    ['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ] as const) {
    await page.setViewport(viewport);
    await shoot(page, '/copies', '.copyrow', `n1058-copies-${width}.png`, `${width}: the list, four copies`);
    assert.equal(await page.$$eval('.copyrow', (rows) => rows.length), 4);
    assert.match(await page.$eval('#copiesSub', (n) => n.textContent ?? ''), /4 copies · 3 need a look/);
    await shoot(page, '/copies/fixture-acme-0001', '#copyChart', `n1058-copy-${width}.png`, `${width}: one copy and its history`);
    assert.equal(await page.$$eval('#copyChart [data-day]', (bars) => bars.length), 21);
    await shoot(page, '/copies/fixture-initech-04', '#copyOptedOut', `n1058-opted-out-${width}.png`, `${width}: an opted-out copy`);
    await shoot(page, '/copies/fixture-northwind-02', '#copyWrite', `n1058-northwind-${width}.png`, `${width}: behind, little disk`);
    await page.click('#copyWrite');
    await page.waitForSelector('#screenMailCompose', { visible: true, timeout: 10_000 });
    assert.equal(await page.$eval('#mailToField', (n) => (n as HTMLInputElement).value), 'ravi@northwind.example');
    assert.equal(await page.$eval('#mailSubjectField', (n) => (n as HTMLInputElement).value), 'Your Agentic Cloud at cloud.northwind.example');
    await pause(400);
    await page.screenshot({ path: path.join(out, `n1058-write-${width}.png`) });
    console.log(`PASS: ${width}: Write to contact opens a draft, To and Subject filled, nothing sent`);
    await shoot(page, '/', '.recapnoticed', `n1058-alerts-${width}.png`, `${width}: the alerts as rows in the Chief of Staff chat`, false);
    await page.click('#homeAccount');
    await page.waitForSelector('#accountMenuCopies', { visible: true, timeout: 5_000 });
    await pause(300);
    await page.screenshot({ path: path.join(out, `n1058-menu-${width}.png`) });
    console.log(`PASS: ${width}: the account menu offers Copies`);
  }
  empty = true;
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await shoot(page, '/copies', '#copiesEmpty', 'n1058-empty-phone.png', 'phone: no copy yet');
  assert.deepEqual(errors, []);
  console.log('PASS: no page errors');
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
