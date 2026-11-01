/**
 * Settings → Your builder page → the X profile editor (note #755), in the real
 * shell and real Chrome at phone and desktop widths. Adam's phone showed
 * the open editor squeezed onto one line: the text box got half the row,
 * Cancel floated above it and Save between, and nothing lined up.
 *
 * Checks, with the editor open:
 *   - the text box is as wide as the row's content (its label's width);
 *   - Cancel and Save share a line, centred on each other, below the box;
 *   - Save is enabled and wears the accent (not the disabled grey);
 *   - Save still saves and Cancel still closes, with no page errors.
 *
 *   npx tsx scripts/verify-workspace-x-profile-row.mts [--shell backend/dist/workspace-ui]
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

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 1, agents: 0 }],
  agents: [],
  user: {
    name: 'Adam B',
    profile: { firstName: 'Adam', lastName: 'B', incomplete: false },
    account: { browserLogin: { enabled: true, method: 'totp', username: 'adam' } },
  },
});
let settings: { x?: string } = {};
const errors: string[] = [];
const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/profile/x', (_req, res) => res.json(settings));
app.put('/workspace/api/profile/x', (req, res) => {
  const asked = req.body as { x?: string };
  if (typeof asked.x === 'string') settings = { x: asked.x.replace(/^@/, '') || undefined };
  res.json(settings);
});
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;

type Box = { left: number; right: number; top: number; bottom: number; width: number };
const box = (page: Page, selector: string) => page.$eval(selector, (node) => {
  const r = node.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } as Box;
});
const middle = (b: Box) => (b.top + b.bottom) / 2;

async function openEditor(page: Page) {
  await page.waitForSelector('#profileXRow');
  await page.click('#profileXRow');
  await page.waitForSelector('#profileXForm');
  await page.type('#profileX', 'AdamBuiltThis');
  await page.$eval('#profileXCard', (node) => node.scrollIntoView({ block: 'center' }));
}

async function checkRow(page: Page, shot: string, label: string) {
  await openEditor(page);
  await page.screenshot({ path: path.join(out, shot) });
  const form = await box(page, '#profileXForm');
  const main = await box(page, '#profileXForm .main');
  const input = await box(page, '#profileX');
  const cancel = await box(page, '#profileXForm .btn');
  const save = await box(page, '#profileXSave');
  const within = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
  assert.ok(within(input.width, main.width, 1), `${label}: the text box is ${input.width}px wide in a ${main.width}px column`);
  assert.ok(within(input.width, form.width - 24, 1), `${label}: the text box is ${input.width}px wide in a ${form.width}px row`);
  assert.ok(within(middle(cancel), middle(save), 1), `${label}: Cancel centred at ${middle(cancel)} but Save at ${middle(save)}`);
  assert.ok(cancel.top >= input.bottom, `${label}: Cancel (top ${cancel.top}) is not below the text box (bottom ${input.bottom})`);
  assert.ok(save.top >= input.bottom, `${label}: Save (top ${save.top}) is not below the text box (bottom ${input.bottom})`);
  assert.ok(save.right <= main.right + 1, `${label}: Save ends at ${save.right}, past the column's ${main.right}`);
  const look = await page.$eval('#profileXSave', (node) => {
    const style = getComputedStyle(node);
    return { disabled: (node as HTMLButtonElement).disabled, color: style.color, background: style.backgroundColor };
  });
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  assert.equal(look.disabled, false, `${label}: Save is disabled before anything is saving`);
  const toRgb = (hex: string) => hex.length === 7 ? `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})` : hex;
  assert.equal(look.color, toRgb(accent), `${label}: Save's words are ${look.color}, not the accent ${accent}`);
  console.log(`PASS: ${label}: the text box fills the row and Cancel and Save stand together under it`);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));

  // 1. A phone, the editor open with a handle typed in — Adam's screenshot.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/profile`);
  await checkRow(page, 'x-profile-row-phone.png', 'phone');

  // 2. Cancel closes the editor and keeps what was there.
  await page.click('#profileXForm .btn');
  await page.waitForSelector('#profileXRow');
  assert.equal(settings.x, undefined, 'Cancel saved nothing');
  console.log('PASS: Cancel closes the editor without saving');

  // 3. Save writes the handle, @-less, and the resting row shows it.
  await page.click('#profileXRow');
  await page.waitForSelector('#profileXForm');
  await page.type('#profileX', '@AdamBuiltThis');
  await page.click('#profileXSave');
  await page.waitForFunction(() => document.querySelector('#profileXRow .meta')?.textContent?.startsWith('@AdamBuiltThis'));
  assert.equal(settings.x, 'AdamBuiltThis');
  console.log('PASS: Save writes the handle and the row shows it');

  // 4. A desktop window, the same editor.
  settings = {};
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.goto(`http://127.0.0.1:${port}/profile`);
  await checkRow(page, 'x-profile-row-desktop.png', 'desktop');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
