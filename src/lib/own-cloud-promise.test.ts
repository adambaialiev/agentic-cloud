import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Note #1059 (Adam's decision on note #1056; the daily pulse of note #1057,
// first offered in release 2026.11.07.0): once copies send a daily report,
// the public words say so. None of the company's data comes to us; a daily
// report of counts and the contact they chose does, which their admin sees
// and can turn off. "Nothing leaves your account" stays a claim we never
// make (their AI provider reads what agents send it).
const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const PLACES = [
  'src/pages/Landing.tsx',
  'src/pages/WhyFly.tsx',
  'src/lib/product-copy.ts',
  'public/own-cloud.md',
  'scripts/prerender.mjs',
  'infra/copy-installer/README.md',
  'src/components/CopyArt.tsx',
];
const OLD = [
  /nothing of yours comes to us/i,
  /with nothing of yours on our side/i,
  /with nothing on\s+(>\s*)?our side/i,
  /bill you read yourself, nothing on our side/i,
  /Nothing of the company's comes to us/i,
  /There is no telemetry/i,
  /makes one kind of call to us/i,
  /from the first release that carries it/i,
  /\['Diagnostics,', 'only if your', 'admin sends it'\]/,
];

describe('the own-cloud promise says what copies send (note #1059)', () => {
  it.each(PLACES)('%s has none of the old promise', (file) => {
    const text = read(file);
    for (const old of OLD) expect(text).not.toMatch(old);
    expect(text).not.toMatch(/(nothing|none of your data)\s+leaves/i);
  });

  it.each(PLACES)('%s says a daily report goes out', (file) => {
    expect(read(file).replace(/\s+/g, ' ')).toMatch(/daily report|once a day[^.]*report|Daily counts/i);
  });

  it('says the admin sees it and can turn it off wherever the page promises it', () => {
    for (const file of ['src/pages/Landing.tsx', 'src/pages/WhyFly.tsx', 'src/lib/product-copy.ts', 'public/own-cloud.md', 'scripts/prerender.mjs']) {
      expect(read(file).replace(/\s+/g, ' ')).toMatch(/admin sees[^.]*turn (it )?off/i);
    }
    expect(read('infra/copy-installer/README.md')).toMatch(/Workplace › What we tell Agentic Cloud/);
  });
});
