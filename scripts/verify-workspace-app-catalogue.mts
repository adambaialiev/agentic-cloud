/**
 * The app catalogue at the root of the domain (note #756): `/apps` reads
 * without an account and shows every listed site, newest first — picture,
 * name, one line, maker, link — on a phone and on a desk; a site with no
 * picture yet shows its name instead; someone signed in reads it inside
 * the Workspace, under its own header with Back.
 *
 *   npx tsx scripts/verify-workspace-app-catalogue.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { emptyState, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');

let session: 'stranger' | 'reader' = 'stranger';
const org = { orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 2, agents: 1 }],
  agents: [],
});

/** Three small "apps", drawn by this script so the catalogue has real pictures to show. */
const FAKE_APPS: Record<string, string> = {
  'ember-coffee': `<body style="margin:0;font-family:Inter,Arial,sans-serif;background:#fff7ed;color:#431407">
    <div style="padding:48px 64px"><div style="font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#9a3412">Ember Coffee</div>
    <h1 style="font-size:64px;margin:16px 0 8px;letter-spacing:-.03em">Order before you reach the counter.</h1>
    <p style="font-size:22px;color:#7c2d12;max-width:620px">Tap your usual, pay once, pick it up warm. No queue, no card machine, no waiting.</p>
    <div style="display:flex;gap:16px;margin-top:40px">${['Flat white', 'Cortado', 'Filter'].map((n) => `<div style="flex:1;background:#fff;border-radius:16px;padding:24px;border:1px solid #fed7aa"><div style="font-size:28px">☕</div><div style="font-size:20px;margin-top:8px">${n}</div><div style="color:#9a3412">€3.20</div></div>`).join('')}</div></div></body>`,
  'math-tutor': `<body style="margin:0;font-family:Inter,Arial,sans-serif;background:#0f172a;color:#e2e8f0">
    <div style="padding:48px 64px"><div style="font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:#7dd3fc">Math tutor · 5th grade</div>
    <h1 style="font-size:56px;margin:16px 0 24px;letter-spacing:-.03em">Problem 7 of 10</h1>
    <div style="background:#1e293b;border-radius:16px;padding:40px;font-size:40px;text-align:center">3 × (12 − 5) + 9 = ?</div>
    <div style="display:flex;gap:16px;margin-top:24px">${['21', '30', '36', '27'].map((n) => `<div style="flex:1;background:#334155;border-radius:12px;padding:20px;font-size:28px;text-align:center">${n}</div>`).join('')}</div></div></body>`,
  'garden-log': `<body style="margin:0;font-family:Inter,Arial,sans-serif;background:#f0fdf4;color:#14532d">
    <div style="padding:48px 64px"><h1 style="font-size:56px;margin:0 0 8px;letter-spacing:-.03em">Garden log</h1>
    <p style="font-size:20px;color:#166534">What was planted, watered and picked — one line a day.</p>
    ${['Mon · Tomatoes watered, 2 L', 'Tue · Basil cut back', 'Wed · First courgette picked 🥒', 'Thu · Lettuce sown, row 3'].map((l) => `<div style="background:#fff;border:1px solid #bbf7d0;border-radius:12px;padding:18px 24px;margin-top:12px;font-size:22px">${l}</div>`).join('')}</div></body>`,
};

const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(session === 'stranger' ? { authenticated: false } : signedIn()));
app.get('/fake/:name', (req, res) => {
  const html = FAKE_APPS[req.params.name!];
  if (!html) return res.status(404).end();
  return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"></head>${html}</html>`);
});
let port = 0;
app.get('/workspace/api/public/apps', (_req, res) => res.json({ apps: [
  {
    name: 'ember-coffee', url: 'https://ember-coffee.agentbuilt.app', line: 'Order your coffee before you reach the counter, and pick it up warm.',
    builder: { name: 'Adam Reyes', handle: 'adam', photoUrl: '/faces/ada.jpg' },
    pictureUrl: `http://127.0.0.1:${port}/shots/ember-coffee.png`, publishedAt: '2026-10-15T10:00:00.000Z', createdAt: '2026-10-15T10:00:00.000Z',
  },
  {
    name: 'math-tutor', url: 'https://math-tutor.agentbuilt.app', line: 'Daily practice for the 5th grade, one problem at a time.',
    builder: { name: 'Lena Fischer', handle: 'lena', photoUrl: '/faces/hazel.jpg' },
    pictureUrl: `http://127.0.0.1:${port}/shots/math-tutor.png`, publishedAt: '2026-10-14T10:00:00.000Z', createdAt: '2026-10-14T10:00:00.000Z',
  },
  {
    name: 'garden-log', url: 'https://garden-log.agentbuilt.app', line: 'What was planted, watered and picked, one line a day.',
    builder: { name: 'Jun Park' },
    pictureUrl: `http://127.0.0.1:${port}/shots/garden-log.png`, publishedAt: '2026-10-12T10:00:00.000Z', createdAt: '2026-10-12T10:00:00.000Z',
  },
  {
    name: 'nomad-ledger', url: 'https://nomad-ledger.agentbuilt.app', line: 'Expenses for a small trading desk, shared with the accountant.',
    builder: { name: 'Adam Reyes', handle: 'adam', photoUrl: '/faces/ada.jpg' }, publishedAt: '2026-10-10T10:00:00.000Z', createdAt: '2026-10-10T10:00:00.000Z',
  },
] }));
app.use('/faces', express.static(path.join(root, 'public/agent-avatars')));
app.use('/shots', express.static(out));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [] }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  const text = (selector: string) => page.$eval(selector, (node) => node.textContent ?? '');

  // 0. The pictures, as the CLI takes them: 1280×800 of each site.
  await page.setViewport({ width: 1280, height: 800 });
  for (const name of Object.keys(FAKE_APPS)) {
    await page.goto(`http://127.0.0.1:${port}/fake/${name}`);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }

  // 1. A stranger on a phone: every listed app, newest first, no sign-in gate.
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/apps`);
  await page.waitForSelector('#appsGrid .appcard');
  assert.equal(await text('#appsTitle'), 'Apps');
  assert.match(await text('#appsSub'), /4 apps/);
  assert.deepEqual(await page.$$eval('.appcard', (nodes) => nodes.map((n) => n.getAttribute('data-app'))), ['ember-coffee', 'math-tutor', 'garden-log', 'nomad-ledger']);
  assert.equal(await page.$('#authGate, #loginForm, form.authpanel'), null, 'no sign-in gate stands before a public page');
  assert.ok(await page.$('.public-repo-head'), 'the visitor header stands over the page');
  assert.equal(await page.title(), 'Apps — Agentic Cloud Computer');
  // The pictures actually drew.
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.appshot img')].every((img) => img.complete && img.naturalWidth > 0));
  assert.equal(await page.$$eval('.appshot img', (nodes) => nodes.length), 3);
  assert.equal(await text('.appcard[data-app="nomad-ledger"] .appnoshot'), 'nomad-ledger');
  // The maker's door and the site's.
  assert.equal(await page.$eval('.appcard[data-app="ember-coffee"] a.appbuilder', (n) => n.getAttribute('href')), '/adam');
  assert.equal(await page.$eval('.appcard[data-app="ember-coffee"] h2 a', (n) => n.getAttribute('href')), 'https://ember-coffee.agentbuilt.app');
  // One column on a phone: every card as wide as the grid.
  const widths = await page.$$eval('.appcard', (nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().width)));
  assert.ok(widths.every((w) => w === widths[0] && w > 300), `one column on a phone, got ${widths.join(',')}`);
  await page.screenshot({ path: path.join(out, 'apps-phone.png'), fullPage: true });
  console.log('PASS: a stranger reads the catalogue on a phone, newest first, with pictures and makers');

  // 2. The same on a desk: three across.
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.goto(`http://127.0.0.1:${port}/apps`);
  await page.waitForSelector('#appsGrid .appcard');
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.appshot img')].every((img) => img.complete && img.naturalWidth > 0));
  const tops = await page.$$eval('.appcard', (nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
  assert.equal(new Set(tops.slice(0, 3)).size, 1, `the first three cards share a row on a desk, got tops ${tops.join(',')}`);
  await page.screenshot({ path: path.join(out, 'apps-desktop.png'), fullPage: true });
  console.log('PASS: on a desk the catalogue is a grid, three across');

  // 3. Someone signed in reads it inside the Workspace, under its header with Back.
  session = 'reader';
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/apps`);
  await page.waitForSelector('#appsGrid .appcard');
  await page.waitForSelector('#pageBack');
  assert.equal(await page.$('.public-repo-head'), null, 'no visitor header over a signed-in reader');
  assert.equal(await page.$('#publicDoors'), null, 'no Open Workspace door for someone already in it');
  await page.screenshot({ path: path.join(out, 'apps-signed-in.png'), fullPage: true });
  console.log('PASS: someone signed in reads the catalogue under the Workspace header, with Back');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
