#!/usr/bin/env node
// Re-shoots public/og-image.png from the /og-preview route.
//
//   npm run dev                      # or: npm run build && npm run preview
//   node scripts/shoot-og-image.mjs  # add a URL argument for a non-default port
//
// The route renders a fixed 1200x630 #og-canvas; this grabs that element at
// deviceScaleFactor 2, which is the 2400x1260 asset index.html advertises.
// Bump the ?v= cache-buster on og:image / twitter:image after replacing it —
// Telegram, X and Slack all cache the old bytes by URL.
//
// Driven by puppeteer-core against the Chrome already on this machine, which
// is what the rest of the repo's screenshot tooling uses. Set CHROME_PATH if
// yours lives somewhere other than the macOS default.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chromePath)) {
  console.error(
    `No Chrome at ${chromePath}.\n` +
      'Point CHROME_PATH at your own build:  CHROME_PATH=/path/to/chrome node scripts/shoot-og-image.mjs',
  );
  process.exit(1);
}

const url = process.argv[2] ?? 'http://localhost:5173/og-preview';
const output = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'og-image.png',
);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });

await page.goto(url, { waitUntil: 'networkidle0' });
const canvas = await page.waitForSelector('#og-canvas', { visible: true });
// The site ships a webfont again (Inter, self-hosted — see the type comment in
// src/index.css), so this is now load-bearing rather than a precaution: shoot
// before it resolves and the fallback face is baked into the asset, on the one
// picture that gets forwarded.
await page.evaluate(() => document.fonts.ready);
await canvas.screenshot({ path: output });
await browser.close();

console.log(`Wrote ${output} (1200x630 @2x)`);
