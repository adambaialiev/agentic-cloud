/**
 * Framing a new profile picture (note #660), in the real shell and real
 * Chrome: choosing a picture opens it under a fixed circle, a finger drags
 * it, two fingers pinch it, and what reaches the server is exactly the
 * square that stood behind the circle — checked by reading the uploaded
 * picture's own pixels back, not by trusting the arithmetic that cut it.
 *
 * The picture is four bands of colour, 200px each across 800×400 (red,
 * green, blue, yellow), so where the cut landed is a colour question.
 *
 *   npx tsx scripts/verify-workspace-picture-frame.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
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
    name: 'Saddam B',
    profile: { firstName: 'Saddam', lastName: 'B', incomplete: false },
    account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } },
  },
});
const uploads: { type: string; bytes: Buffer }[] = [];
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (_req, res) => res.json(signedIn()));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
// Settings' builder-page section reads the X profile on mount (note #824).
app.get('/workspace/api/profile/x', (_req, res) => res.json({}));
// The server's half, as the real route takes it: raw bytes, the type in the
// header. The picture then becomes the profile's, at an address of its own.
app.post('/workspace/api/profile/photo', express.raw({ type: () => true, limit: '6mb' }), (req, res) => {
  uploads.push({ type: String(req.get('content-type')), bytes: req.body as Buffer });
  const photoUrl = `/uploaded/${uploads.length}`;
  state.user.profile!.photoUrl = photoUrl;
  res.json({ ok: true, photoUrl });
});
app.get('/uploaded/:n', (req, res) => {
  const upload = uploads[Number(req.params.n) - 1];
  if (!upload) return res.status(404).end();
  return res.type(upload.type).send(upload.bytes);
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
const scratch = mkdtempSync(path.join(os.tmpdir(), 'picture-frame-'));

/** The four-band picture, drawn by the browser and saved where the file
 *  chooser can take it from. */
async function bandsFile(page: Page): Promise<string> {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const context = canvas.getContext('2d')!;
    ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].forEach((colour, band) => {
      context.fillStyle = colour;
      context.fillRect(band * 200, 0, 200, 400);
    });
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const file = path.join(scratch, 'bands.png');
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** The last upload, read back by the browser: its size and the colour at
 *  each of the given fractions across its middle row. */
async function readUpload(page: Page, across: number[]): Promise<{ width: number; height: number; colours: string[] }> {
  return page.evaluate(async (url, fractions) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const y = Math.floor(bitmap.height / 2);
    // No named helpers in here: tsx wraps them in a `__name` the page has
    // never heard of.
    return {
      width: bitmap.width,
      height: bitmap.height,
      colours: fractions.map((fraction) => {
        const [r, g, b] = context.getImageData(Math.floor(bitmap.width * fraction), y, 1, 1).data;
        const lit = [r! > 200, g! > 200, b! > 200].map(Number).join('');
        return ({ '100': 'red', '010': 'green', '001': 'blue', '110': 'yellow' } as Record<string, string>)[lit] ?? `rgb(${r},${g},${b})`;
      }),
    };
  }, `/uploaded/${uploads.length}`, across);
}

async function openFrame(page: Page, file: string) {
  const input = await page.$('#profilePhotoInput');
  await input!.uploadFile(file);
  await page.waitForSelector('#pictureFrame');
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('#pictureFrameStage img');
    return Boolean(image && !image.hidden && image.complete);
  });
  const box = await page.$eval('#pictureFrameStage', (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
  return { centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, circle: box.width * 0.8, box };
}

/** Where the picture's left edge stands, in percent of the stage. A finger
 *  lands on whole pixels and the stage is rarely a whole number of them
 *  wide, so a position is right to within a tenth of a percent. */
const pictureLeft = (page: Page) => page.$eval('#pictureFrameStage img', (node) => Number.parseFloat((node as HTMLImageElement).style.left));
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 0.25, `${what}: ${actual}% is not ${expected}%`);

async function useIt(page: Page, count: number) {
  await page.click('#pictureFrameUse');
  await page.waitForFunction((n) => !document.getElementById('pictureFrame') && document.querySelector<HTMLImageElement>('#profileFace')?.src.endsWith(`/uploaded/${n}`), {}, count);
  assert.equal(uploads.length, count);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/profile`);
  await page.waitForSelector('#profilePhotoCard');
  const bands = await bandsFile(page);

  // 1. Chosen: nothing goes up yet, and the picture stands under the circle
  //    at Fit — as tall as the circle, centred, the circle on green and blue.
  const frame = await openFrame(page, bands);
  assert.equal(uploads.length, 0, 'choosing a picture uploads nothing');
  near(await pictureLeft(page), -30, 'at Fit the 2:1 picture is centred');
  await page.screenshot({ path: path.join(out, 'picture-frame-chosen.png') });
  console.log('PASS: a chosen picture opens under the circle and nothing uploads yet');

  // 2. One finger drags it a quarter of the circle to the right; the circle
  //    now holds red, green, green, blue — and so does the upload.
  const quarter = frame.circle / 4;
  await page.touchscreen.touchStart(frame.centre.x, frame.centre.y);
  await page.touchscreen.touchMove(frame.centre.x + quarter / 2, frame.centre.y);
  await page.touchscreen.touchMove(frame.centre.x + quarter, frame.centre.y);
  await page.touchscreen.touchEnd();
  near(await pictureLeft(page), -10, 'dragged a quarter circle right');
  assert.ok(await page.$('#pictureFrame'), 'a drag that ends is not the backdrop saying no');
  await page.screenshot({ path: path.join(out, 'picture-frame-dragged.png') });
  await useIt(page, 1);
  assert.equal(uploads[0]!.type, 'image/png', 'a PNG stays a PNG');
  const first = await readUpload(page, [0.125, 0.375, 0.625, 0.875]);
  assert.deepEqual({ width: first.width, height: first.height }, { width: 400, height: 400 });
  assert.deepEqual(first.colours, ['red', 'green', 'green', 'blue']);
  await page.screenshot({ path: path.join(out, 'picture-frame-saved.png') });
  console.log('PASS: a finger drags the picture and the upload is exactly the square behind the circle');

  // 3. The mouse pushes it as far left as it goes (the edge holds), then two
  //    fingers spread twice as wide about the centre: 2x, a 200px square of
  //    blue and yellow from the right-hand half.
  const again = await openFrame(page, bands);
  await page.mouse.move(again.centre.x, again.centre.y);
  await page.mouse.down();
  await page.mouse.move(again.centre.x - again.circle, again.centre.y, { steps: 4 });
  await page.mouse.move(again.centre.x - 2 * again.circle, again.centre.y, { steps: 4 });
  await page.mouse.up();
  near(await pictureLeft(page), -70, 'the picture stops where its edge meets the circle');
  assert.ok(await page.$('#pictureFrame'), 'a mouse drag released over the dim does not close the frame');
  const one = await page.touchscreen.touchStart(again.centre.x - 30, again.centre.y);
  const two = await page.touchscreen.touchStart(again.centre.x + 30, again.centre.y);
  await one.move(again.centre.x - 45, again.centre.y);
  await two.move(again.centre.x + 45, again.centre.y);
  await one.move(again.centre.x - 60, again.centre.y);
  await two.move(again.centre.x + 60, again.centre.y);
  await one.end();
  await two.end();
  assert.equal(await page.$eval('#pictureFrameZoom', (node) => (node as HTMLInputElement).value), '2');
  await page.screenshot({ path: path.join(out, 'picture-frame-pinched.png') });
  await useIt(page, 2);
  const second = await readUpload(page, [0.25, 0.75]);
  assert.deepEqual({ width: second.width, height: second.height }, { width: 200, height: 200 });
  assert.deepEqual(second.colours, ['blue', 'yellow']);
  console.log('PASS: the mouse drags to the edge and a pinch zooms, and the upload follows both');

  // 4. Cancel: nothing goes up, and the face stays the one already chosen.
  await openFrame(page, bands);
  await page.click('#pictureFrame .btn.ghost');
  await page.waitForFunction(() => !document.getElementById('pictureFrame'));
  assert.equal(uploads.length, 2);
  console.log('PASS: Cancel closes the frame and uploads nothing');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}
