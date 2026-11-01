import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard on the Workspace's corners, beside the one on its type.
 *
 * The scale is Cursor's product radii — 4 / 8 / 12px — and the failure it
 * exists to catch is the same one the type had: a new rule inventing a
 * fourteenth value because 13px looked right in the moment. Thirteen of those
 * are what made the boxes read softer than the type inside them.
 *
 * What is allowed beside the scale, and why each is not a corner on it:
 *
 *   999px / 50%  a pill or a circle, which is a shape rather than a radius —
 *                its curve is its own height and no scale can hold it.
 *   a face       an avatar's corner is a PROPORTION of its box (16px on 56px,
 *                13px on 46px, 10px on 34px), so it moves with the size of the
 *                picture and not with this scale.
 *   0            a square corner is a decision, not a missing one.
 */

const ROOT = path.resolve(__dirname, '..');
const SHEETS = ['src/workspace.css', 'src/join-flow.css'].map((file) => ({
  file,
  // Comments out first: this file explains its corners in prose, and a comment
  // that says `border-radius: 0` is not a rule that sets one.
  css: readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));

/** Selectors whose corner belongs to the picture in them, not to the scale. */
const FACES = ['.facebtn', '.aface', '.face '];

const SCALE: Record<string, string> = {
  '--r-sm': '4px',
  '--r-md': '8px',
  '--r-lg': '12px',
};

describe('the Workspace corner scale', () => {
  it('is Cursor’s product radii, and there are three of them', () => {
    const css = SHEETS[0].css;
    for (const [role, size] of Object.entries(SCALE)) {
      expect(css, role).toContain(`${role}: ${size};`);
    }
    expect(css).not.toMatch(/--r-(xl|2xl|xs)\s*:/);
  });

  it('sets no radius by hand', () => {
    const offenders: string[] = [];
    for (const { file, css } of SHEETS) {
      let selector = '';
      for (const line of css.split('\n')) {
        if (line.includes('{')) selector = line.split('{')[0].trim() || selector;
        const declaration = /border-radius:\s*([^;}\n]+)/.exec(line);
        if (!declaration) continue;
        const value = declaration[1].trim();
        // A pill, a circle, a square corner, or a value already off the scale.
        if (/999px|%|var\(--r-/.test(value) || /^0( 0)*$/.test(value)) continue;
        if (FACES.some((face) => `${selector} `.includes(face))) continue;
        offenders.push(`${file}: ${selector} { border-radius: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
