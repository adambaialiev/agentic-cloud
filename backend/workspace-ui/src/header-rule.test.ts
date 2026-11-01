import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard on the header's full-width rule (note #542).
 *
 * On a desk the hairline under a screen's header runs the width of the
 * window rather than stopping at the 720px reading column. It is drawn as an
 * absolutely positioned `100vw` strip on the header's own bottom edge, and
 * that construction has two ways to go wrong that nothing on screen would
 * show the author of the next change:
 *
 *   1. The marketing site renders these same screens inside a 640px panel,
 *      with this stylesheet scoped under `.ws-live` by `scopeWorkspaceCss`
 *      in the site's vite.config.ts. That transform DROPS a rule whose
 *      selector starts with `html` or `body` and fences every other one. So
 *      a selector in this block that does not lead with one of those two
 *      words survives into the panel, where a `100vw` line runs clean across
 *      the landing page. It would look perfect in the Workspace.
 *
 *   2. `100vw` includes the width of a classic scrollbar, and an absolutely
 *      positioned box contributes its overflow to the document. Without
 *      `overflow-x: clip` on the root, every screen grows a horizontal
 *      scrollbar on the browsers that draw one — which is neither of the two
 *      this room can run.
 *
 * Both are cheap to assert about the source and expensive to notice later.
 */

const CSS = readFileSync(path.resolve(__dirname, 'workspace.css'), 'utf8');

/** The `@media` block the note added, comments and all: the first desk
 *  query AFTER the banner that names it, since 760px is the stylesheet's
 *  desk threshold and other rules (a chat clip's larger frame, note #700)
 *  open their own blocks at it. */
function fullWidthRuleBlock(): string {
  const banner = CSS.indexOf("The header's rule runs the width of the window");
  expect(banner, 'the note #542 banner').toBeGreaterThan(-1);
  const start = CSS.indexOf('@media (min-width: 760px)', banner);
  expect(start, 'the note #542 media block').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error('the block never closes');
}

/** Every selector the block declares, one per comma, comments removed. */
function selectorsOf(block: string): string[] {
  const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0])
    .filter((chunk) => chunk.trim())
    .flatMap((chunk) => chunk.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

describe("the header's rule on a desk", () => {
  const block = fullWidthRuleBlock();

  it('leads every selector with html or body, so the landing panel drops it', () => {
    const selectors = selectorsOf(block);
    expect(selectors.length).toBeGreaterThan(3);
    for (const selector of selectors) {
      expect(/^(html|body)(\b|$)/.test(selector), `${selector} escapes into .ws-live`).toBe(true);
    }
  });

  // Home's room tabs (`#roomSection`) were the third header to carry it,
  // until rooms left the product (note #843).
  it('draws the strip at the width of the window, on the two headers', () => {
    expect(block).toContain('width: 100vw');
    expect(block).toContain('margin-left: -50vw');
    for (const header of ['.pagehead::after', '.chathead::after']) {
      expect(block, header).toContain(header);
    }
    expect(block).not.toContain('#roomSection');
  });

  it('keeps the borders it replaces, transparent rather than removed', () => {
    // The pixel stays in the box, so no header changes height and nothing
    // below it moves by one.
    expect(block).toContain('border-bottom-color: transparent');
    expect(block).not.toContain('border-bottom: 0');
    expect(block).not.toContain('border-bottom: none');
  });

  it('guards the document against the scrollbar 100vw does not know about', () => {
    expect(block).toMatch(/html\s*{\s*overflow-x:\s*clip;?\s*}/);
    // `hidden` would make the root a scroll container and unstick every
    // sticky header in this file.
    expect(block).not.toContain('overflow-x: hidden');
  });
});
