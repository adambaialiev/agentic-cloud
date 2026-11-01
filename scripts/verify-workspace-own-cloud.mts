/**
 * A workplace the platform marked to bring its own Fly account (note #801), in
 * the real shell at phone width:
 *   1. its admin finds the token form under Cloud account on the workplace
 *      screen, and connecting turns it into the account's card;
 *   2. a connected account whose Fly billing is not in order carries a red
 *      line that says so in plain words, with the link to fix it.
 *
 *   cd backend && npm run build:workspace-ui
 *   npx tsx scripts/verify-workspace-own-cloud.mts [--shell backend/dist/workspace-ui]
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

const org = { orgId: 'o1', name: 'Northwind AI', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 1, agents: 0 }],
  agents: [],
});
type Fly = Record<string, unknown>;
let fly: Fly = {
  connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 }, ownCloudAllowed: true,
};
let billing: { problem: string; fixUrl: string } | undefined;
const detail = () => ({
  orgId: 'o1', name: 'Northwind AI', role: 'admin', canDelete: true,
  members: [{ userId: 'u1', name: 'Dana', you: true, role: 'admin', joinedAt: '2026-10-26T00:00:00Z', agents: 0, workedMs: 0 }],
  invites: [], joinRequests: [],
  fly,
});
const errors: string[] = [];
let pasted = '';
const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org', (_req, res) => res.json({ org: detail() }));
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [] }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly,
  machines: fly.connected ? { active: 0, sleeping: 0, checkedAt: new Date().toISOString() } : null,
  ...(billing ? { billing } : {}),
}));
app.post('/workspace/api/org/fly', (req, res) => {
  pasted = String(req.body?.token ?? '');
  fly = { connected: true, orgSlug: 'northwind-agents', peer: 'up' };
  res.json({ ok: true, orgSlug: 'northwind-agents', appCount: 0, peer: 'up', moved: false });
});
app.use(['/api', '/auth'], (req, res) => {
  errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // 1. The marked workplace: the token form, standing open under Cloud account.
  await page.goto(`http://127.0.0.1:${port}/workplace?org=o1`);
  await page.waitForSelector('#orgCloudConnect input');
  await page.$eval('#orgCloud', (node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(out, 'own-cloud-connect.png') });
  console.log('PASS: a marked workplace shows its admin the Fly token form');

  await page.type('#orgCloudConnect input', 'fo1_northwind');
  await page.$$eval('#orgCloudConnect button', (buttons) => {
    (buttons.find((b) => b.textContent?.trim() === 'Connect cloud') as HTMLButtonElement | undefined)?.click();
  });
  await page.waitForFunction(() => document.querySelector('#orgCloudCard .name')?.textContent === 'northwind-agents', { timeout: 10_000 });
  assert.equal(pasted, 'fo1_northwind');
  assert.equal(await page.$('#orgCloudConnect'), null, 'the form is gone once connected');
  await page.$eval('#orgCloud', (node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(out, 'own-cloud-connected.png') });
  console.log('PASS: connecting turns the form into the account card');

  // 2. The same account with its Fly bill past due: the red line.
  billing = {
    problem: 'Fly says the bill for your Fly organization "northwind-agents" is past due. Settle it at https://fly.io/dashboard/northwind-agents/billing first; until then Fly refuses to build or change machines there.',
    fixUrl: 'https://fly.io/dashboard/northwind-agents/billing',
  };
  await page.goto(`http://127.0.0.1:${port}/workplace?org=o1`);
  await page.waitForSelector('#orgCloudBilling');
  const line = await page.$eval('#orgCloudBilling', (node) => ({
    text: node.textContent ?? '',
    href: node.querySelector('a')?.getAttribute('href'),
    width: node.getBoundingClientRect().width,
    card: node.closest('.card')?.getBoundingClientRect().width ?? 0,
  }));
  assert.match(line.text, /is past due/);
  assert.equal(line.href, 'https://fly.io/dashboard/northwind-agents/billing');
  assert.ok(line.width <= line.card, 'the line stays inside its card');
  await page.$eval('#orgCloud', (node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(out, 'own-cloud-billing.png') });
  console.log('PASS: a billing problem is a red line on the Cloud card, with the link to fix it');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
