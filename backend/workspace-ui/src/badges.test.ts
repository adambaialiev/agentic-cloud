import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * States are WORDS, not badges — our user's rule for the whole Workspace,
 * given in chat on 2026-09-09 and first asked for on one screen in note #425
 * ("Badge should be just color word, without background").
 *
 * It is a rule about a handful of shared classes rather than about any one
 * screen, which is exactly why it needs pinning: `.badge`, `.pill` and
 * `.headstate` are drawn by repositories, notes, sites, seats, machines,
 * workplaces, chat receipts, the join flow and both agent headers, so a fill
 * put back on one of them quietly returns lozenges to a dozen screens at
 * once. These assertions read the stylesheet the shell actually ships.
 */

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8');

/** The stylesheet's rules, comments stripped, as [selectors, declarations].
 *  Innermost braces win, so rules nested in an `@media` are read too and the
 *  wrapper itself never matches. */
const rules = (() => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.trim(),
    body: match[2]!,
  }));
})();

/** Rules whose SUBJECT — the compound the rule actually paints — carries the
 *  class. A descendant of it (`.headstate .statedot`) is a different object
 *  and is allowed its own shape. */
const paintedBy = (className: string) =>
  rules.filter((rule) =>
    rule.selectors.split(',').some((selector) => {
      const subject = selector.trim().split(/[\s>+~]+/).pop() ?? '';
      return subject.split('.').slice(1).includes(className);
    }),
  );

describe('a state is a word, not a badge', () => {
  for (const className of ['badge', 'pill', 'headstate']) {
    it(`gives .${className} no fill, no padding and no lozenge`, () => {
      const painted = paintedBy(className);
      expect(painted.length).toBeGreaterThan(0);
      for (const rule of painted) {
        expect(rule.body, `${rule.selectors} may not fill`).not.toMatch(/(^|[;{\s])background(-color)?\s*:/);
        expect(rule.body, `${rule.selectors} may not pad`).not.toMatch(/(^|[;{\s])padding[\w-]*\s*:/);
        expect(rule.body, `${rule.selectors} may not round`).not.toMatch(/(^|[;{\s])border-radius\s*:/);
      }
    });
  }

  it('keeps each state class coloured by a palette role', () => {
    // The colour is the whole signal once the box is gone, so every tone still
    // has to name an ink — and only inks the palette test proves readable.
    for (const tone of ['.badge.agent', '.badge.ok', '.badge.mut', '.badge.warn', '.badge.busy',
      '.pill.open', '.pill.running', '.pill.merged', '.pill.rejected', '.pill.quiet']) {
      const rule = rules.find((one) => one.selectors === tone);
      expect(rule, `${tone} is missing`).toBeTruthy();
      expect(rule!.body, tone).toMatch(/color: var\(--(accent|hint|ok|danger|warn)\);/);
    }
  });

  it('keeps the working dot, which is not badge chrome', () => {
    // The agent header reads on two channels: the word's colour and a dot that
    // breathes while a turn runs and is hollow when none does (note #326 —
    // "not a badge, just a blue dot"). Dropping the lozenge must not drop it.
    expect(css).toContain('.headstate .statedot {');
    expect(css).toContain('.headstate.active .statedot { animation: breathe');
    expect(css).toContain('.headstate.idle .statedot { background: none;');
  });
});
