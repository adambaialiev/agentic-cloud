/**
 * The account menu's name opens the reader's own builder page (Adam, 28 Oct
 * 2026, note #824: "in the header dropdown I should be able to click on my
 * name and my profile opens, my builder page"), in the real shell and real
 * Chrome at desktop and phone widths. The public Leaderboard went the same
 * day, and with it the menu's Leaderboard row and Home's door to it.
 *
 * Checks:
 *   - the menu's first row is the reader's name, a menu item, with no
 *     Leaderboard row anywhere in the menu or on Home;
 *   - choosing it opens /<their address> inside the Workspace, with Back,
 *     and their numbers: this week, all time, the last 90 days;
 *   - no place on any board, and no page errors.
 *
 *   npx tsx scripts/verify-account-menu-builder-page.mts [--shell backend/dist/workspace-ui]
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

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');

const HOUR = 3_600_000;
const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 3, agents: 4 }],
  agents: [],
  user: {
    name: 'Adam B',
    profile: { firstName: 'Adam', lastName: 'B', incomplete: false },
    account: {
      browserLogin: { enabled: true, method: 'email', email: 'adam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
      mailbox: { address: 'adam@agenticcloudcomputer.com' },
    },
  },
});

// The last 90 days up to today, a busy last fortnight.
const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86_400_000;
const gridStart = new Date(monday - 84 * 86_400_000).toISOString().slice(0, 10);
const length = Math.round((today - Date.parse(`${gridStart}T00:00:00Z`)) / 86_400_000) + 1;
const days = Array.from({ length }, (_, index) => {
  const busy = index >= length - 14 ? 1 + ((index * 5) % 9) : 0;
  return { workingMs: busy * HOUR, merged: busy ? index % 4 : 0, ...(busy ? { claude: busy * 410_000 } : {}) };
});
const top = Math.max(...days.map((day) => day.workingMs));
const board = {
  agents: 4, working: 2, runs: ['claude', 'codex'],
  week: { workingMs: 41 * HOUR, merged: 9, claude: 6_400_000, codex: 1_200_000 },
  grid: days.map((day) => (day.workingMs ? Math.max(1, Math.ceil((day.workingMs / top) * 4)) : 0)),
  gridStart, days, allTime: { workingMs: 212 * HOUR, claude: 38_000_000, codex: 4_100_000 },
};

const errors: string[] = [];
const asked: string[] = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => { asked.push(req.path); next(); });
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/recap/chat', (_req, res) => res.json({ orgId: 'o1', messages: [], working: false, waiting: [] }));
app.get('/workspace/api/recap/agent', (_req, res) => res.json({ orgId: 'o1', agent: { name: 'Workspace Agent', started: false, working: false, waiting: [] }, settings: null }));
app.get('/workspace/api/public/addresses/:handle', (req, res) => {
  if (req.params.handle !== 'adam') return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({ kind: 'person', person: { handle: 'adam', name: 'Adam B', repos: [], x: 'AdamBuiltThis', board } });
});
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  // Home reads more than this screen needs; an empty answer is enough.
  res.status(404).json({ error: `Unscripted ${req.method} ${req.originalUrl}` });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;

async function openMenu(page: Page, shot: string, label: string) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#homeAccount', { visible: true, timeout: 15_000 });
  assert.equal(await page.$('#leaderboardDoor'), null, `${label}: Home still has a Leaderboard door`);
  await page.click('#homeAccount');
  await page.waitForSelector('#accountMenu', { visible: true, timeout: 5_000 });
  const rows = await page.$$eval('#accountMenu [role=menuitem]', (nodes) => nodes.map((node) => ({ id: node.id, name: node.querySelector('.orgmenuname')?.textContent ?? '' })));
  assert.deepEqual(rows.map((row) => row.id)[0], 'accountMenuSelf', `${label}: the first row is ${JSON.stringify(rows[0])}`);
  assert.deepEqual(rows.map((row) => row.name), ['Adam B', 'People', 'Apps', 'Settings'], `${label}: menu rows`);
  assert.doesNotMatch(await page.$eval('#accountMenu', (node) => node.textContent ?? ''), /Leaderboard/, `${label}: the menu names the Leaderboard`);
  // Past the menu's .14s entrance, so the picture is the menu at rest.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(out, shot) });
  console.log(`PASS: ${label}: the menu opens on the reader's name as a door, with no Leaderboard row`);
}

async function openPage(page: Page, shot: string, label: string) {
  await page.click('#accountMenuSelf');
  await page.waitForFunction(() => location.pathname === '/adam', { timeout: 10_000 });
  await page.waitForSelector('#personWeek', { timeout: 10_000 });
  assert.ok(await page.$('#pageBack'), `${label}: no Back on the builder page`);
  assert.ok(await page.$('#personAllTime') && await page.$('#personDays'), `${label}: all time or the 90 days are missing`);
  assert.equal(await page.$('#accountMenu'), null, `${label}: the menu stayed open`);
  assert.doesNotMatch(await page.$eval('body', (node) => node.textContent ?? ''), /Leaderboard|#\d+ on the/, `${label}: the page names a board`);
  await page.screenshot({ path: path.join(out, shot), fullPage: true });
  console.log(`PASS: ${label}: the name opens their own builder page inside the Workspace, with their numbers`);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await openMenu(page, 'n824-menu-desktop.png', 'desktop');
  await openPage(page, 'n824-page-desktop.png', 'desktop');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await openMenu(page, 'n824-menu-phone.png', 'phone');
  await openPage(page, 'n824-page-phone.png', 'phone');

  assert.ok(!asked.some((route) => route.includes('leaderboard')), `asked for the board: ${asked.filter((route) => route.includes('leaderboard')).join(', ')}`);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
