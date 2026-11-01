// Note #332: create from a note and stay there through reservation, setup,
// sign-in and readiness. The real shell runs against a scripted API; no
// agent machines are created and no messages are sent.
// npm --prefix backend run build:workspace-ui
// backend/node_modules/.bin/tsx scripts/verify-workspace-handoff-create.mts
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { agent, emptyState, noteRecord, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');
const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
  notes: [], noteFiles: true,
});
const note = noteRecord({ number: 332, title: 'Review the welcome page',
  html: '<p>Review the welcome page</p><p>Check the first visit and suggest improvements.</p>', byUser: true });
let created = 0;
let readsAfterCreate = 0;
let stage: 'setting-up' | 'needs-sign-in' | 'ready' = 'setting-up';
const errors: string[] = [];
const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => {
  // The first read misses the reserved record, as it can in production.
  if (created && ++readsAfterCreate >= 2) {
    state.agents = [agent({ id: 'ada', name: 'Ada', status: stage, model: 'Opus', effort: 'high' })];
  }
  res.json(state);
});
// Creating an agent has asked the workplace's cloud read whether Fly is
// connected since 2026-09-06 (cc42c983): unconnected, the flow offers the
// connect form instead of the choice of runtime. This workplace is already
// set up, which is the state the note's handoff starts from.
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly: { connected: true }, machines: null,
}));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/notes/332', (_req, res) => res.json({ note }));
// The create names the runtime and nothing else: it carried the room the
// note stood in until rooms left the product (note #843).
app.post('/workspace/api/agents', (req, res) => {
  assert.deepEqual(req.body, { cli: 'claude' });
  created += 1;
  res.json({ ok: true });
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
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/notes/332?org=o1`);
  const address = page.url();
  await page.waitForSelector('#noteHands .createhand');
  await page.click('#noteHands .createhand');
  const choose = await page.waitForSelector('::-p-text(Claude Code)');
  await choose!.click();
  await page.waitForFunction(() => document.querySelector('#noteHands .createhand')?.textContent?.includes('Creating agent'));
  await page.waitForFunction(() => document.querySelector('#noteHands [role="status"]')?.textContent === 'Setting up');
  assert.equal(await page.$eval('#noteHands .hname', (node) => node.textContent), 'Ada');
  assert.equal(await page.$('#noteHands button[aria-label^="Send Ada"]'), null);
  // Note #352: the word alone cannot tell a machine coming up from one that
  // died on the way, so the card wears home's meter — and the segment that is
  // moving is the one the machine is moving through on its own.
  const meter = () => page.$eval('#noteHands .steps', (node) => node.getAttribute('aria-label'));
  assert.equal(await meter(), 'Setup step 1 of 3');
  assert.notEqual(await page.$('#noteHands .steps span.now.live'), null);
  await page.screenshot({ path: path.join(out, 'n332-handoff-setting-up.png') });
  console.log('PASS: new agent appears in the note row during setup, with no premature Send action');
  stage = 'needs-sign-in';
  await page.waitForFunction(() => document.querySelector('#noteHands [role="status"]')?.textContent === 'Signing in');
  // The meter advances with it, and stops breathing: this waypoint waits on
  // the reader, and a segment moving at them would promise progress nobody is
  // making.
  assert.equal(await meter(), 'Setup step 2 of 3');
  assert.equal(await page.$('#noteHands .steps span.now.live'), null);
  console.log('PASS: setup status updates while the note stays open, and the meter moves with it');
  stage = 'ready';
  await page.waitForSelector('#noteHands button[aria-label^="Send Ada"]');
  assert.equal(page.url(), address);
  assert.equal(await page.$('#noteHands [role="status"]'), null);
  // Ready has no setup left to draw: the meter goes with the status word.
  assert.equal(await page.$('#noteHands .steps'), null);
  await page.screenshot({ path: path.join(out, 'n332-handoff-ready.png') });
  await page.click('#noteHands button[aria-label^="Send Ada"]');
  await page.waitForSelector('#noteSendText');
  assert.equal(await page.$eval('#noteSendText', (node) => (node as HTMLTextAreaElement).value), 'pick up the note #332');
  assert.equal(created, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: the ready agent opens the note handoff without a visit to Home or a duplicate create');
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
