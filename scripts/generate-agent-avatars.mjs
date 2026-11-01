#!/usr/bin/env node
// Generates one pixel-art dog avatar per agent name into
// backend/assets/agent-avatars/<name>.jpg, using fal.
//
//   node scripts/generate-agent-avatars.mjs --print          # prompts only, no API calls, no key needed
//   FAL_KEY=... node scripts/generate-agent-avatars.mjs      # the full run (1 hero + 39 referenced)
//   FAL_KEY=... node scripts/generate-agent-avatars.mjs --only Nina,Nora --force
//   FAL_KEY=... node scripts/generate-agent-avatars.mjs --hero-url https://fal.media/...  # reuse a hero you liked
//   FAL_KEY=... node scripts/generate-agent-avatars.mjs --workspace-agent --force        # only the Workspace Agent's reserved face
//
// Why a hero: the first dog is generated from the prompt alone, and its fal URL
// is then passed as a style reference for the other thirty-nine, so all forty
// share one lighting setup. Forty independent generations do not look like one
// litter. If the hero comes out wrong, delete it, rerun, and only then let the
// rest follow — that is what --only and --hero-url are for.
//
// TOPPING THE POOL UP rather than regenerating it is the normal case now, and
// it needs both flags — the run is idempotent (existing files are skipped
// without --force), but a bare run still mints a NEW hero and conditions the
// new dogs on a lighting setup the ones already on disk never saw:
//
//   FAL_KEY=... node scripts/generate-agent-avatars.mjs --hero-url <the Leo used before>
//
// The key never belongs in this repo. Export FAL_KEY in your shell for the run.
//
// Prompts and the reasoning behind the framing: scripts/agent-avatar-prompts.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOGS,
  HERO_NAME,
  WORKSPACE_AGENT_SLUG,
  buildPrompt,
  buildReferencePrompt,
  buildWorkspaceAgentPrompt,
} from './agent-avatar-prompts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_SOURCE = path.join(REPO_ROOT, 'backend', 'src', 'types', 'user.ts');
const OUTPUT_DIR = path.join(REPO_ROOT, 'backend', 'assets', 'agent-avatars');

// Telegram crops profile photos to a circle and serves them small; 512px square
// is plenty, and pixel art at this palette size costs a few KB per file.
const OUTPUT_SIZE = 512;

// The pixel grid the art is forced onto. Diffusion models draw pixel-art-
// FLAVOURED images: the "pixels" are subtly different sizes, off-grid, and
// anti-aliased at every edge, which reads as blurry fake retro. Downsampling to
// a real grid is what makes it actual pixel art — and it also throws away the
// model's failed fine detail rather than shrinking it. 128 keeps the pixels
// small enough to read as a drawn cartoon sprite rather than a blocky mosaic,
// while still leaving every breed silhouette distinguishable, which is the one
// job the avatar has.
const PIXEL_GRID = Number(process.env.AVATAR_GRID ?? 128);

// Overridable because fal renames endpoints faster than this script will be
// touched. Anything that takes `prompt` (text) / `prompt` + `image_urls` (edit)
// and returns `images[0].url` works unchanged.
const TEXT_MODEL = process.env.FAL_TEXT_MODEL ?? 'fal-ai/nano-banana';
const EDIT_MODEL = process.env.FAL_EDIT_MODEL ?? 'fal-ai/nano-banana/edit';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * The pool lives in TypeScript the backend actually ships; parse it rather than
 * copying it, so a name added there without a dog fails here instead of
 * silently shipping an agent with no face.
 */
function readNamePool() {
  const source = fs.readFileSync(POOL_SOURCE, 'utf8');
  const block = /TELEGRAM_AGENT_NAME_POOL[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1];
  if (!block) {
    throw new Error(`Could not find TELEGRAM_AGENT_NAME_POOL in ${POOL_SOURCE}`);
  }
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function assertPoolMatchesPrompts(pool) {
  const missing = pool.filter((name) => !DOGS[name]);
  const extra = Object.keys(DOGS).filter((name) => !pool.includes(name));
  if (missing.length || extra.length) {
    const lines = [];
    if (missing.length) lines.push(`  no dog for: ${missing.join(', ')}`);
    if (extra.length) lines.push(`  dog for a name no longer in the pool: ${extra.join(', ')}`);
    throw new Error(`scripts/agent-avatar-prompts.mjs is out of sync with the name pool:\n${lines.join('\n')}`);
  }
}

async function falRun(model, input) {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new Error('FAL_KEY is not set — export it for this run (never commit it).');
  }
  const headers = { Authorization: `Key ${key}`, 'content-type': 'application/json' };

  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const queued = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    // Print what fal echoed back verbatim: a renamed model or a rejected
    // parameter is otherwise indistinguishable from a real failure.
    throw new Error(`fal rejected the ${model} request (${submit.status}): ${JSON.stringify(queued)}`);
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusResponse = await fetch(queued.status_url, { headers });
    const status = await statusResponse.json().catch(() => ({}));
    if (status.status === 'COMPLETED') {
      const resultResponse = await fetch(queued.response_url, { headers });
      const result = await resultResponse.json().catch(() => ({}));
      const url = result?.images?.[0]?.url;
      if (!url) {
        throw new Error(`${model} completed without an image: ${JSON.stringify(result)}`);
      }
      return url;
    }
    if (status.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) {
      throw new Error(`${model} ended as ${status.status}: ${JSON.stringify(status)}`);
    }
  }
  throw new Error(`${model} did not finish within 5 minutes`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${url} (${response.status})`);
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * Turn fal's 1024px near-pixel-art into real pixel art: area-average down to
 * PIXEL_GRID, which collapses the model's ragged half-pixels into one honest
 * cell, then scale back up with nearest-neighbour so every cell is a hard
 * square. Two lines of ffmpeg do the whole job.
 *
 * Palette quantisation (palettegen + paletteuse) is deliberately NOT here: it
 * speckled the flat dark background with stray colours even at dither=none, and
 * blew the file from 12KB to 125KB. The downscale already does the flattening
 * that matters.
 *
 * Output is JPEG because Telegram's InputProfilePhotoStatic only accepts .jpg,
 * and these files are uploaded as-is. -q:v 2 with yuvj444p keeps the quality
 * high and, crucially, skips chroma subsampling — 4:2:0 would smear colour
 * across exactly the hard pixel edges this art is made of.
 */
function toAvatarFile(source, destination) {
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', source,
      '-vf',
      `scale=${PIXEL_GRID}:${PIXEL_GRID}:flags=area,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:flags=neighbor`,
      '-q:v', '2',
      '-pix_fmt', 'yuvj444p',
      destination,
    ], { stdio: 'ignore' });
    fs.rmSync(source, { force: true });
  } catch (error) {
    const fallback = destination.replace(/\.jpg$/, '.raw.png');
    fs.renameSync(source, fallback);
    console.warn(
      `  ! ffmpeg failed (${error.message.split('\n')[0]}) — kept the full-size original at ` +
        `${path.relative(REPO_ROOT, fallback)}`,
    );
  }
}

const pool = readNamePool();
assertPoolMatchesPrompts(pool);

if (flag('print')) {
  for (const name of pool) {
    console.log(`\n=== ${name}${name === HERO_NAME ? '  (hero — generated first, no reference)' : ''}\n`);
    console.log(name === HERO_NAME ? buildPrompt(name) : buildReferencePrompt(name));
  }
  console.log(`\n${pool.length} prompts. Nothing was generated — drop --print to run them.`);
  process.exit(0);
}

const only = value('only')?.split(',').map((name) => name.trim()).filter(Boolean);
const force = flag('force');
// The Workspace Agent's face is outside the pool (note #434): asked for by
// its own flag, and then it is the only thing generated.
const workspaceAgentOnly = flag('workspace-agent');
const targets = workspaceAgentOnly ? [] : only ?? pool;

const unknown = targets.filter((name) => !pool.includes(name));
if (unknown.length) {
  console.error(`Not agent names: ${unknown.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const fileFor = (name) => path.join(OUTPUT_DIR, `${name.toLowerCase()}.jpg`);

// The hero has to exist before anything can reference it.
let heroUrl = value('hero-url');
if (!heroUrl) {
  console.log(`Hero: ${HERO_NAME} (defines the lighting for the other ${pool.length - 1})`);
  heroUrl = await falRun(TEXT_MODEL, {
    prompt: buildPrompt(HERO_NAME),
    num_images: 1,
    output_format: 'png',
    aspect_ratio: '1:1',
  });
  console.log(`  ${heroUrl}`);
  if (targets.includes(HERO_NAME) && (force || !fs.existsSync(fileFor(HERO_NAME)))) {
    const temporary = path.join(OUTPUT_DIR, `${HERO_NAME.toLowerCase()}.fal.png`);
    await download(heroUrl, temporary);
    toAvatarFile(temporary, fileFor(HERO_NAME));
    console.log(`  wrote ${path.relative(REPO_ROOT, fileFor(HERO_NAME))}`);
  }
}

let generated = 0;
let skipped = 0;
for (const name of targets) {
  if (name === HERO_NAME && !value('hero-url')) {
    continue;
  }
  const destination = fileFor(name);
  if (!force && fs.existsSync(destination)) {
    skipped += 1;
    continue;
  }

  console.log(`${name}…`);
  const url = await falRun(EDIT_MODEL, {
    prompt: buildReferencePrompt(name),
    image_urls: [heroUrl],
    num_images: 1,
    output_format: 'png',
  });
  const temporary = path.join(OUTPUT_DIR, `${name.toLowerCase()}.fal.png`);
  await download(url, temporary);
  toAvatarFile(temporary, destination);
  generated += 1;
  console.log(`  wrote ${path.relative(REPO_ROOT, destination)}`);
}

if (workspaceAgentOnly) {
  const destination = path.join(OUTPUT_DIR, `${WORKSPACE_AGENT_SLUG}.jpg`);
  if (!force && fs.existsSync(destination)) {
    skipped += 1;
  } else {
    console.log(`${WORKSPACE_AGENT_SLUG}…`);
    const url = await falRun(EDIT_MODEL, {
      prompt: buildWorkspaceAgentPrompt(),
      image_urls: [heroUrl],
      num_images: 1,
      output_format: 'png',
    });
    const temporary = path.join(OUTPUT_DIR, `${WORKSPACE_AGENT_SLUG}.fal.png`);
    await download(url, temporary);
    toAvatarFile(temporary, destination);
    generated += 1;
    console.log(`  wrote ${path.relative(REPO_ROOT, destination)}`);
  }
}

console.log(
  `\nDone: ${generated} generated, ${skipped} already present (--force to redo).` +
    `\nHero reference: ${heroUrl}` +
    '\nReview them at 40px — that is the size that matters — before committing.',
);
