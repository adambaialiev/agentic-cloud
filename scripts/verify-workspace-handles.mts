/**
 * A workplace's handle (knowledge page "public-addresses") is an identifier,
 * never shown (the owner, 2026-10-12, note #748), in the real shell: the
 * workplace screen names no address and offers no way to change one; the
 * rename form says nothing of one; the New workplace form asks for the name
 * and nothing else — no address row and no line about it.
 *
 *   npx tsx scripts/verify-workspace-handles.mts [--shell backend/dist/workspace-ui]
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

const org = { orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 2, agents: 1 }],
  agents: [],
  canCreateOrg: true,
});
const detail = {
  orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', canDelete: true,
  members: [
    { userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 },
    { userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', invitedByName: 'Saddam', agents: 0, workedMs: 0 },
  ],
  invites: [], joinRequests: [],
  fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
};
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org', (_req, res) => res.json({ org: detail }));
// Auto-approve mode (note #944): the workplace page reads its switch — off.
app.get('/workspace/api/org/auto-approve', (_req, res) => res.json({ on: false, canChange: true }));
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [] }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly: detail.fly, machines: { active: 1, sleeping: 0, checkedAt: new Date().toISOString() },
}));
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
  const text = (selector: string) => page.$eval(selector, (node) => node.textContent ?? '');

  const noAddress = async (where: string) => {
    const words = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(words, /agenticcloudcomputer\.com\//, `${where}: no public address`);
    assert.doesNotMatch(words, /address/i, `${where}: no word about an address`);
  };

  // 1. The workplace screen names no address and offers nothing to change one.
  await page.goto(`http://127.0.0.1:${port}/workplace?org=o1`);
  await page.waitForSelector('#orgRenameBtn');
  await noAddress('the workplace screen');
  assert.equal(await page.$('#orgHandleBtn'), null, 'no Change address');
  await page.screenshot({ path: path.join(out, 'handles-workplace.png'), fullPage: true });
  console.log('PASS: the workplace screen shows no address under its title and offers nothing to change one');

  // 2. Renaming says nothing of an address.
  await page.click('#orgRenameBtn');
  await page.waitForSelector('#orgNameSub');
  // It listed the rooms among what stays until rooms left the product (note
  // #843).
  assert.equal(await text('#orgNameSub'), 'A new name is all that changes. Its people, agents, code and shared work stay here.');
  await noAddress('the rename form');
  await page.screenshot({ path: path.join(out, 'handles-rename.png') });
  console.log('PASS: the rename form says nothing of an address');

  // 3. New workplace: the name, and nothing else — no address row, no line about it.
  await page.goto(`http://127.0.0.1:${port}/workplaces`);
  await page.waitForSelector('#orgNewDoor');
  await page.click('#orgNewDoor');
  await page.waitForSelector('#orgCreateName');
  await page.type('#orgCreateName', 'Acme Trading');
  assert.equal(await page.$('#orgCreateHandle'), null, 'no address row');
  assert.equal(await page.$$eval('#orgCreateForm input', (nodes) => nodes.length), 1, 'one input: the name');
  assert.deepEqual(await page.$$eval('#orgCreateForm .drow .k', (nodes) => nodes.map((node) => node.textContent)), ['Workplace name']);
  await noAddress('the New workplace form');
  await page.screenshot({ path: path.join(out, 'handles-create.png') });
  console.log('PASS: the New workplace form asks for the name and shows no address');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
