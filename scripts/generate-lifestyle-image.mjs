// Generate lifestyle-photo candidates with fal.ai's nano-banana-pro.
//
//   FAL_KEY=... node scripts/generate-lifestyle-image.mjs "<prompt>" [count] [outdir]
//
// Writes candidate-1.jpg … candidate-N.jpg to outdir (default /tmp/lifestyle).
// Pick one, then crop it to the page's 1600×1074 frame with sharp
// (npm i -D sharp --no-save):
//
//   node -e "require('sharp')('cand.jpg').resize(1600,1074,{fit:'cover'}).jpeg({quality:82}).toFile('public/away/<name>.jpg')"
//
// 3:2 at 2K costs $0.15 per image (fal.ai pricing, 2026-08).
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [prompt, countArg, outdirArg] = process.argv.slice(2);
if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set');
if (!prompt) throw new Error('usage: generate-lifestyle-image.mjs "<prompt>" [count] [outdir]');

const count = Math.min(Number(countArg ?? 2), 4);
const outdir = outdirArg ?? '/tmp/lifestyle';
await mkdir(outdir, { recursive: true });

const res = await fetch('https://fal.run/fal-ai/nano-banana-pro', {
  method: 'POST',
  headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt,
    num_images: count,
    aspect_ratio: '3:2',
    resolution: '2K',
    output_format: 'jpeg',
  }),
});
if (!res.ok) throw new Error(`fal.ai ${res.status}: ${await res.text()}`);

const { images } = await res.json();
for (const [i, image] of images.entries()) {
  const file = join(outdir, `candidate-${i + 1}.jpg`);
  const bytes = await fetch(image.url).then((r) => r.arrayBuffer());
  await writeFile(file, Buffer.from(bytes));
  console.log(`${file}  (${Math.round(bytes.byteLength / 1024)} kB, ${image.width}×${image.height})`);
}
