/**
 * The work radio switched off (Adam, 30 Oct 2026, note #842: "disable radio
 * functionality on the platform"), in the real shell and real Chrome at
 * desktop and phone widths. Off, the state read says `radio: false` and
 * carries no `radioLibrary`, even for the platform operator — that is the
 * server's half, covered by radio-routes.test.ts; this is the Workspace's.
 *
 * Checks, at both widths:
 *   - no Radio button, station arrow or player in Home's header, the shared
 *     header (Drive) or an agent chat's header;
 *   - no "Radio library" row in the account menu;
 *   - /radio draws the ordinary not-found screen;
 *   - nothing asks /api/radio, and no page errors.
 * And one picture of Home with the radio ON, for comparison.
 *
 *   cd backend && npm run build:workspace-ui
 *   backend/node_modules/.bin/tsx scripts/shot-radio-off-842.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { agent, emptyState, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const felix = agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high' });
let radioOn = false;
const state = () => emptyState({
  org,
  organizations: [{ ...org, active: true, members: 3, agents: 1 }],
  agents: [felix],
  user: {
    name: 'Adam B',
    profile: { firstName: 'Adam', lastName: 'B', incomplete: false },
    account: {
      browserLogin: { enabled: true, method: 'email', email: 'adam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
      mailbox: { address: 'adam@agenticcloudcomputer.com' },
    },
  },
  // Off is what every backend now answers, the operator's included.
  ...(radioOn ? { radio: true, radioLibrary: true as const } : { radio: false }),
});
const LOFI = { id: 'lofi', name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' };
const onAir = () => {
  const lofi = {
    station: LOFI,
    now: { track: { id: 'amber', title: 'Amber Streetlight', durationMs: 90_000 }, startsAt: new Date(Date.now() - 5_000).toISOString() },
    next: { track: { id: 'rainy', title: 'Rainy Notebook', durationMs: 90_000 }, startsAt: new Date(Date.now() + 85_000).toISOString() },
  };
  return { ...lofi, stations: [lofi], serverNow: new Date().toISOString() };
};

const errors: string[] = [];
const askedRadio: string[] = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (!radioOn && req.path.includes('/api/radio')) askedRadio.push(req.path); next(); });
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state()));
app.get('/workspace/api/radio', (_req, res) => (radioOn ? res.json(onAir()) : res.status(404).json({ error: 'The radio is off.' })));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/recap/chat', (_req, res) => res.json({ orgId: 'o1', messages: [], working: false, waiting: [] }));
app.get('/workspace/api/recap/agent', (_req, res) => res.json({ orgId: 'o1', agent: { name: 'Workspace Agent', started: false, working: false, waiting: [] }, settings: null }));
app.get('/workspace/api/agents/felix/chat', (_req, res) => res.json({
  messages: [
    { seq: 1, role: 'owner', text: 'Can you tidy the pricing page copy?', at: new Date(Date.now() - 600_000).toISOString() },
    { seq: 2, role: 'agent', text: 'Done — the three plans now read the same way, and the FAQ lost its duplicate answer.', at: new Date(Date.now() - 540_000).toISOString() },
  ],
  working: false,
}));
app.get('/workspace/api/drive', (_req, res) => res.json({ items: [], path: [], totalBytes: 2_400_000_000 }));
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  // The screens read more than these pictures need; an empty answer is enough.
  res.status(404).json({ error: `Unscripted ${req.method} ${req.originalUrl}` });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function noRadio(page: Page, label: string) {
  assert.equal(await page.$('.radiogroup, .radiobtn, .radiopick'), null, `${label}: a radio control is drawn`);
  assert.equal(await page.$('#radioStations'), null, `${label}: the station menu is drawn`);
}

async function shoot(page: Page, where: string, ready: string, shot: string, label: string) {
  await page.goto(`http://127.0.0.1:${port}${where}`);
  await page.waitForSelector(ready, { visible: true, timeout: 15_000 });
  await pause(800);
  await noRadio(page, label);
  await page.screenshot({ path: path.join(out, shot) });
  console.log(`PASS: ${label}: no radio`);
}

async function menu(page: Page, shot: string, label: string) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#homeAccount', { visible: true, timeout: 15_000 });
  await page.click('#homeAccount');
  await page.waitForSelector('#accountMenu', { visible: true, timeout: 5_000 });
  assert.equal(await page.$('#accountMenuRadioLibrary'), null, `${label}: the menu offers the Radio library`);
  assert.doesNotMatch(await page.$eval('#accountMenu', (node) => node.textContent ?? ''), /Radio/, `${label}: the menu names the radio`);
  await pause(300);
  await page.screenshot({ path: path.join(out, shot) });
  console.log(`PASS: ${label}: no Radio library row in the account menu`);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));

  for (const [width, viewport] of [
    ['desktop', { width: 1280, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
    ['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ] as const) {
    await page.setViewport(viewport);
    await shoot(page, '/', '#homeAccount', `n842-home-${width}.png`, `${width}: Home`);
    await shoot(page, '/drive?org=o1', '#pageHead', `n842-header-${width}.png`, `${width}: the shared header (Drive)`);
    await shoot(page, '/chat/felix?org=o1', '#screenAgentChat', `n842-chat-${width}.png`, `${width}: an agent chat`);
    await menu(page, `n842-menu-${width}.png`, `${width}: the account menu`);
    await shoot(page, '/radio', '#unknownScreen', `n842-radio-page-${width}.png`, `${width}: /radio is not found`);
  }
  assert.deepEqual(askedRadio, [], `the Workspace asked the radio: ${askedRadio.join(', ')}`);
  console.log('PASS: nothing asked /api/radio');

  // For comparison: the same Home with the radio on, as it was until today.
  radioOn = true;
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.radiobtn', { visible: true, timeout: 15_000 });
  await pause(500);
  await page.screenshot({ path: path.join(out, 'n842-before-home-desktop.png') });
  console.log('PASS: with the radio on, Home draws its button (the before picture)');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
