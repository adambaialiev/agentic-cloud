/**
 * The apps directory in a company's own Agentic Cloud (note #1014): NOT
 * public. Adam, 6 Nov 2026: "workplace's apps directory should not be
 * public". A stranger who opens /apps meets the sign-in and not one name,
 * line or picture of a site; someone signed in reads their workplace's apps
 * inside the Workspace, under its header with Back, with one line saying
 * only the workplace's people see the page. Ours stays the public showcase
 * (verify-workspace-app-catalogue.mts).
 *
 * The shell is served as a copy serves it: with
 * `<meta name="acc-private-copy" content="1">`, and the scripted backend
 * answers /api/public/apps as the real one does in a copy (401 without a
 * session; routes/workspace.ts and its router test hold that side).
 *
 *   npx tsx scripts/verify-workspace-app-directory-copy.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

/** The shell as a copy's backend serves it (routes/workspace-ui.ts adds these). */
const COPY_META = '<meta name="acc-private-copy" content="1"><meta name="acc-public-host" content="agents.acme.test"><meta name="acc-mail-domain" content="agents.acme.test">';
const indexHtml = readFileSync(path.join(shell, 'index.html'), 'utf8').replace('<head>', `<head>${COPY_META}`);

let session: 'stranger' | 'member' = 'stranger';
const org = { orgId: 'o1', name: 'Acme', handle: 'acme', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 3, agents: 2 }],
  agents: [],
});
const SITES = ['acme-crm', 'acme-handbook', 'acme-status'];
const appsAsked: string[] = [];

const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(session === 'stranger' ? { authenticated: false } : signedIn()));
app.get('/workspace/api/public/apps', (_req, res) => {
  appsAsked.push(session);
  if (session === 'stranger') return res.status(401).json({ error: 'Sign in to see the apps of your workplace.' });
  return res.json({ apps: [
    {
      name: 'acme-crm', url: 'https://acme-crm.agents.acme.test', line: 'Every customer, every call, and who promised what.',
      builder: { name: 'Ada Admin', photoUrl: '/faces/ada.jpg' }, publishedAt: new Date(Date.now() - 3_600_000).toISOString(), createdAt: '2026-11-01T10:00:00.000Z',
    },
    {
      name: 'acme-handbook', url: 'https://acme-handbook.agents.acme.test', line: 'How we work: holidays, expenses and the on-call rota.',
      builder: { name: 'Dev Ops', photoUrl: '/faces/hazel.jpg' }, publishedAt: new Date(Date.now() - 86_400_000).toISOString(), createdAt: '2026-10-30T10:00:00.000Z',
    },
    {
      name: 'acme-status', url: 'https://acme-status.agents.acme.test', line: 'Is it up? The status of our three services, for the support desk.',
      builder: { name: 'Ada Admin', photoUrl: '/faces/ada.jpg' }, publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), createdAt: '2026-10-28T10:00:00.000Z',
    },
  ] });
});
app.use('/faces', express.static(path.join(root, 'public/agent-avatars')));
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
app.get('*', (_req, res) => res.type('html').send(indexHtml));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  const bodyText = () => page.evaluate(() => document.body.innerText);

  // 1. A stranger opens the copy's /apps: the sign-in, and nothing of the sites.
  for (const [label, viewport] of [
    ['phone', { width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ['desktop', { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
  ] as const) {
    await page.setViewport(viewport);
    await page.goto(`http://127.0.0.1:${port}/apps`);
    await page.waitForSelector('input[type="password"]');
    assert.equal(await page.$('#appsGrid, #screenApps, .appcard'), null, 'no apps screen for a stranger');
    const words = await bodyText();
    for (const name of SITES) assert.ok(!words.includes(name), `a stranger never sees ${name}`);
    await page.screenshot({ path: path.join(out, `copy-apps-stranger-${label}.png`), fullPage: true });
  }
  assert.ok(!appsAsked.includes('stranger'), 'the shell does not even ask for the list without a session');
  console.log('PASS: a stranger at a copy\'s /apps meets the sign-in, with no list and no pictures');

  // 2. A member reads their workplace's apps inside the Workspace, told who can see them.
  session = 'member';
  for (const [label, viewport] of [
    ['phone', { width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ['desktop', { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
  ] as const) {
    await page.setViewport(viewport);
    await page.goto(`http://127.0.0.1:${port}/apps`);
    await page.waitForSelector('#appsGrid .appcard');
    await page.waitForSelector('#pageBack');
    assert.deepEqual(await page.$$eval('.appcard', (nodes) => nodes.map((n) => n.getAttribute('data-app'))), SITES);
    assert.equal(await page.$eval('#appsPrivate', (n) => n.textContent), 'Only people in your workplace can see this page.');
    assert.equal(await page.$('.public-repo-head'), null, 'no visitor header over a member');
    await page.screenshot({ path: path.join(out, `copy-apps-member-${label}.png`), fullPage: true });
  }
  console.log('PASS: a member reads the workplace\'s apps under the Workspace header, told only its people see them');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
