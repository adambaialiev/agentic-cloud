// Note #629: each face in the hand-it-to-an-agent row answers the pointer on
// its own — it lifts under a hovering pointer and sinks under a press — so it
// reads as the details door it is, apart from the card's handoff. The real
// shell runs against a scripted API; nothing is sent.
// npm --prefix backend run build:workspace-ui
// backend/node_modules/.bin/tsx scripts/verify-workspace-handoff-face.mts
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
const at = new Date().toISOString();
const face = (name: string) => `/avatars/${name}.jpg`;
const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
  notes: [], noteFiles: true,
  agents: [
    agent({ id: 'alex', name: 'Alex', model: 'opus', effort: 'high', avatarUrl: face('alex'),
      recap: 'Hid note cards from the Workspace Agent chat; merged and live.' }),
    agent({ id: 'ben', name: 'Ben', model: 'fable', effort: 'medium', avatarUrl: face('ben'),
      recap: 'Menu icons on Invite and Workplace settings, live and verified.' }),
    agent({ id: 'ada', name: 'Ada', model: 'opus', effort: 'xhigh', avatarUrl: face('ada'),
      recap: 'Knowledge page on navigation live and verified.',
      context: { usedPercent: 62, tokens: 124_000, window: 200_000, at } }),
  ],
});
const note = noteRecord({ number: 629, title: 'Faces that answer',
  html: '<p>In handoff UI, each agent card\'s avatar should react to hover or press.</p>', byUser: true });
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/notes/629', (_req, res) => res.json({ note }));
app.use('/avatars', express.static(path.join(root, 'backend/assets/agent-avatars')));
app.use(['/api', '/auth'], (req, res) => {
  errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
// Headless Chrome reports no hovering pointer at all, so the desk this looks
// at has to be named: a mouse (Blink's HoverType 2 and PointerType 4).
const mouse = '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4';
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', mouse] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/notes/629?org=o1`);
  await page.waitForSelector('#noteHands .handface');
  assert.equal(await page.evaluate('matchMedia("(hover: hover)").matches'), true);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('#noteHands .avatar')]
    .every((img) => img.complete && img.naturalWidth > 0));
  const card = await page.$('#noteHands');
  const faces = await page.$$('#noteHands .handface');
  assert.equal(faces.length, 3);
  const scale = (index: number) => page.$$eval('#noteHands .handface', (nodes, i) => {
    const matrix = getComputedStyle(nodes[i]).transform;
    return matrix === 'none' ? 1 : new DOMMatrix(matrix).a;
  }, index);
  // Waits for the face to SETTLE at a scale rather than sleeping a guess at
  // the transition: on a CI host shared with every other check, a fixed pause
  // is how a frame read mid-transition turns into a red run. A string, not a
  // function — tsx names functions and the page has no __name to call.
  const settlesAt = (index: number, target: number) => page.waitForFunction(
    `(() => { const m = getComputedStyle(document.querySelectorAll('#noteHands .handface')[${index}]).transform;
      return Math.abs((m === 'none' ? 1 : new DOMMatrix(m).a) - ${target}) < 0.001; })()`,
    { timeout: 5000 });
  // For the asserts that something did NOT move: give it the whole transition
  // and more to move in, then look.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 400));
  const shot = (name: string) => card!.screenshot({ path: path.join(out, name) });

  await page.mouse.move(5, 5);
  await pause();
  assert.equal(await scale(1), 1);
  await shot('n629-face-rest.png');

  await faces[1].hover();
  await settlesAt(1, 1.08);
  assert.equal(await scale(0), 1, 'its neighbours stay where they are');
  assert.notEqual(await page.$eval('#noteHands .handface:hover', (node) => getComputedStyle(node).filter), 'none');
  await shot('n629-face-hover.png');
  console.log('PASS: the face under the pointer lifts, and only that one');

  // Hovering the card's words is the OTHER door: the face must not answer it.
  await page.hover('#noteHands .hand:nth-child(2) .hname');
  await settlesAt(1, 1);
  await pause();
  assert.equal(await scale(1), 1);
  console.log('PASS: the rest of the card leaves the face still');

  await faces[1].hover();
  await page.mouse.down();
  await settlesAt(1, 0.92);
  assert.equal(await page.$eval('#noteHands .handface:active', (node) => getComputedStyle(node).opacity), '1');
  await shot('n629-face-press.png');
  // Let go off the face, so the press is cancelled rather than opening details.
  await page.mouse.move(5, 5);
  await page.mouse.up();
  console.log('PASS: the pressed face sinks, at full strength rather than faded');

  // A touch screen has no hover: a tapped face must not stay lifted.
  const touch = await browser.newPage();
  await touch.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await touch.goto(`http://127.0.0.1:${port}/notes/629?org=o1`);
  await touch.waitForSelector('#noteHands .handface');
  assert.equal(await touch.evaluate('matchMedia("(hover: hover)").matches'), false);
  await touch.hover('#noteHands .hand:nth-child(2) .handface');
  await pause();
  assert.equal(await touch.$$eval('#noteHands .handface', (nodes) => getComputedStyle(nodes[1]).transform), 'none');
  await touch.close();
  console.log('PASS: without a hovering pointer the face does not lift');

  // Motion unwelcome: no movement, and the press still answers with the fade.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.mouse.move(5, 5);
  await settlesAt(1, 1);
  await faces[1].hover();
  await pause();
  assert.equal(await scale(1), 1);
  await page.mouse.down();
  assert.equal(await page.$eval('#noteHands .handface:active', (node) => getComputedStyle(node).opacity), '0.7');
  await page.mouse.move(5, 5);
  await page.mouse.up();
  console.log('PASS: with reduced motion the face stays put and the press fades instead');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
