/**
 * A person's public page at the root of the domain (knowledge page
 * "public-addresses", slice 5), in the real shell: `/adam` reads without an
 * account and says the name, the picture, the address and the public
 * repositories git counts them in; a word nobody holds says there is
 * nothing at this address; a signed-in colleague is sent on to the member
 * screen of the workplace they share; and a mouse resting on a day of the
 * last 90 raises that day's numbers over the grid, where a thumb does not.
 *
 *   npx tsx scripts/verify-workspace-person.mts [--shell backend/dist/workspace-ui]
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

// Who is reading: nobody, until the colleague check signs them in.
let session: 'stranger' | 'colleague' | 'reader' | 'builder' = 'stranger';
const org = { orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 2, agents: 1 }],
  agents: [],
});
const detail = {
  orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', canDelete: true,
  members: [
    { userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 },
    { userId: 'u2', name: 'Adam Reyes', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', invitedByName: 'Saddam', agents: 0, workedMs: 0, email: 'adam@agenticcloudcomputer.com' },
  ],
  invites: [], joinRequests: [],
  fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
};
// Twelve weeks and a Monday (2026-07-20 to 2026-10-12), with three worked days.
const HOUR = 3_600_000;
const days = Array.from({ length: 85 }, (_, index) => (index < 82 ? { workingMs: null, merged: 0 } : { workingMs: 0, merged: 0 }));
days[82] = { workingMs: 2 * HOUR, merged: 1, claude: 1_200_000 } as typeof days[number];
days[83] = { workingMs: 22 * 60_000, merged: 3, claude: 640, codex: 512_300 } as typeof days[number];
const board = {
  place: 1, agents: 16, working: 3, runs: ['claude'], week: { workingMs: 24 * 60_000, merged: 0, claude: 1_000 },
  grid: days.map((day) => (day.workingMs ? 3 : 0)), gridStart: '2026-07-20', days, allTime: { workingMs: 2 * HOUR },
};
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(session === 'stranger' || session === 'builder' ? { authenticated: false } : signedIn()));
app.get('/workspace/api/public/addresses/:handle', (req, res) => {
  if (req.params.handle !== 'adam') return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({ kind: 'person', person: {
    handle: 'adam',
    name: 'Adam Reyes',
    photoUrl: '/faces/ada.jpg',
    repos: [
      { name: 'infinite-agents', workplace: 'Nomad Trading', workplaceHandle: 'nomad-trading', publicUrl: '/nomad-trading/infinite-agents', commits: 212 },
      { name: 'site', workplace: 'Nomad Trading', workplaceHandle: 'nomad-trading', publicUrl: '/nomad-trading/site', commits: 1 },
    ],
    ...(session === 'colleague' ? { colleague: { orgId: 'o1', userId: 'u2' } } : {}),
    ...(session === 'builder' ? { board } : {}),
  } });
});
app.use('/faces', express.static(path.join(root, 'public/agent-avatars')));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org', (_req, res) => res.json({ org: detail }));
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [] }));
// A member's contribution to the workplace (note #925): nothing yet.
app.get('/workspace/api/org/members/:userId/contribution', (_req, res) => res.json({
  weekStart: '2026-10-26', tokensFrom: '2026-10-10',
  week: { workingMs: 0, merged: 0, tokens: {} }, allTime: { workingMs: 0, merged: 0, tokens: {} }, merged: [],
}));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
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

  // 1. A stranger reads the page: name, address, public repositories — and no sign-in gate.
  await page.goto(`http://127.0.0.1:${port}/adam`);
  await page.waitForSelector('#personName');
  assert.equal(await text('#personName'), 'Adam Reyes');
  assert.equal(await text('#personAddress'), 'agenticcloudcomputer.com/adam');
  assert.equal(await page.$$eval('#personRepos a.trow', (nodes) => nodes.length), 2);
  assert.match(await text('#personRepos'), /Nomad Trading \/ infinite-agents/);
  assert.match(await text('#personRepos'), /212 commits/);
  assert.match(await text('#personRepos'), /1 commit\b/);
  assert.equal(await page.$('#authGate, #loginForm, form.authpanel'), null, 'no sign-in gate stands before a public page');
  assert.equal(await page.title(), 'Adam Reyes (adam)');
  await page.screenshot({ path: path.join(out, 'person-page.png'), fullPage: true });
  console.log('PASS: a stranger reads the name, the address and the public repositories at /adam');

  // 2. A word nobody holds: nothing at this address, no gate, no leak.
  await page.goto(`http://127.0.0.1:${port}/nobody-here`);
  await page.waitForSelector('#personMissing');
  assert.match(await text('#personMissing'), /Nothing at this address/);
  assert.match(await text('#personMissing'), /agenticcloudcomputer\.com\/nobody-here/);
  await page.screenshot({ path: path.join(out, 'person-missing.png') });
  console.log('PASS: a handle nobody holds says there is nothing at this address');

  // 3. A signed-in colleague is sent on to the member screen of the shared workplace.
  session = 'colleague';
  await page.goto(`http://127.0.0.1:${port}/adam`);
  await page.waitForFunction("location.pathname === '/workplace/members/u2' && location.search === '?org=o1'", { timeout: 10000 });
  await page.waitForSelector('#screenOrgMember');
  assert.match(await text('#screenOrgMember'), /adam@agenticcloudcomputer\.com/);
  assert.match(await page.$eval('body', (node) => node.textContent ?? ''), /Adam Reyes/);
  await page.screenshot({ path: path.join(out, 'person-colleague.png'), fullPage: true });
  console.log('PASS: a colleague lands on the member screen of the workplace they share');

  // 4. Someone signed in who shares no workplace with them reads the page
  //    inside the Workspace, under its
  //    own header with Back, never the visitor's (the owner, 2026-10-11).
  session = 'reader';
  await page.goto(`http://127.0.0.1:${port}/adam`);
  await page.waitForSelector('#personName');
  await page.waitForSelector('#pageBack');
  assert.equal(await page.$('.public-repo-head'), null, 'no visitor header over a signed-in reader');
  assert.equal(await page.$('#publicDoors'), null, 'no Open Workspace door for someone already in it');
  assert.equal(await text('#personName'), 'Adam Reyes');
  await page.screenshot({ path: path.join(out, 'person-signed-in.png'), fullPage: true });
  console.log('PASS: someone signed in reads the page under the Workspace header, with Back');

  // 5. A mouse on a day of the last 90 raises its numbers over the grid,
  //    inside the window and clear of the square (the owner, 2026-10-27).
  session = 'builder';
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/adam`);
  await page.waitForSelector('#personDays button.lbcell');
  const sunday = (await page.$$('#personDays button.lbcell'))[83]!;
  await sunday.hover();
  await page.waitForSelector('.daycard');
  assert.match(await text('.daycard'), /^Sun, Oct 11, 2026 ?22min agent hours3 changes mergedClaude Code 640 tokens writtenCodex 512K tokens written$/);
  const [cardBox, cellBox] = [await (await page.$('.daycard'))!.boundingBox(), await sunday.boundingBox()];
  assert.ok(cardBox!.y + cardBox!.height <= cellBox!.y, 'the card stands above the square, not over it');
  assert.ok(cardBox!.x >= 0 && cardBox!.x + cardBox!.width <= 1280, 'the card stays inside the window');
  assert.equal(await page.$('#personDay'), null, 'pointing opens nothing');
  await page.screenshot({ path: path.join(out, 'person-day-hover.png'), clip: { x: 0, y: cellBox!.y - 260, width: 1280, height: 480 } });
  await page.mouse.move(5, 5);
  await page.waitForFunction("!document.querySelector('.daycard')");
  // Under a thumb the card never shows: the tap opens the day below instead.
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  assert.ok(await page.evaluate("matchMedia('(pointer: coarse)').matches"), 'the phone viewport has a coarse pointer');
  const phoneSunday = (await page.$$('#personDays button.lbcell'))[83]!;
  await phoneSunday.hover();
  await page.waitForSelector('.daycard');
  assert.equal(await page.$eval('.daycard', (node) => getComputedStyle(node).display), 'none');
  console.log('PASS: a mouse on a day raises its numbers over the grid; a thumb never sees the card');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
