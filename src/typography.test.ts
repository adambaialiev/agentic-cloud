import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The guard on the type system.
 *
 * The scale in index.css is cursor.com's, ported whole (see the comment at the
 * top of that file). Three things about it are easy to undo by accident and
 * invisible when you do, so they are checked here rather than trusted:
 *
 *   1. A role that does not exist. `type-md-large` renders as nothing at all —
 *      Tailwind emits no class, the text falls back to the body's 16px, and
 *      the page still looks plausible. A typo in a size is not a broken build,
 *      it is a paragraph that quietly went the wrong size.
 *   2. Semibold on display type. Every heading on this site used to be
 *      `font-semibold`, and reaching for it again is the single most likely
 *      way this system gets walked back one heading at a time. Cursor's
 *      display type is regular; the hierarchy is the scale, not the weight.
 *   3. The numbers themselves. They are read off another company's stylesheet
 *      and cannot be re-derived from anything in this repo, so a well-meaning
 *      round of "tidying" would lose them for good.
 */

const ROOT = path.resolve(__dirname, '..');
const CSS = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');

/** size / line-height / letter-spacing, exactly as cursor.com sets them. */
const SCALE: Record<string, [string, string, string]> = {
  'type-2xl': ['4.5rem', '1.1', '-0.03em'],
  'type-xl': ['3.25rem', '1.15', '-0.025em'],
  'type-lg': ['2.25rem', '1.2', '-0.02em'],
  'type-md-lg': ['1.625rem', '1.25', '-0.0125em'],
  'type-md': ['1.375rem', '1.3', '-0.005em'],
  'type-md-sm': ['1.125rem', '1.4', '0'],
  'type-base': ['1rem', '1.5', '0.005em'],
  'type-sm': ['0.875rem', '1.5', '0.01em'],
  'type-xs': ['0.75rem', '1.5', '0.01em'],
};

/** The three at the top of the scale, which are set in regular and stay there. */
const DISPLAY_ROLES = ['type-2xl', 'type-xl', 'type-lg'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

const FILES = sourceFiles(path.join(ROOT, 'src'));

/** Every `type-*` token in a class string, with its `sm:`/`lg:` prefix dropped. */
function rolesIn(source: string): string[] {
  return [...source.matchAll(/(?:^|[\s"'`{])(?:[a-z]+:)?(type-[a-z-]+)/g)].map((m) => m[1]);
}

describe('the type scale', () => {
  it('defines every role as a Tailwind utility, with cursor.com’s own numbers', () => {
    for (const [role, [size, leading, tracking]] of Object.entries(SCALE)) {
      const block = new RegExp(`@utility ${role} \\{([^}]*)\\}`).exec(CSS);
      expect(block, `${role} is not declared in src/index.css`).not.toBeNull();
      const body = block![1];
      expect(body, `${role} font-size`).toMatch(new RegExp(`font-size:\\s*${size.replace('.', '\\.')};`));
      expect(body, `${role} line-height`).toMatch(new RegExp(`line-height:\\s*${leading.replace('.', '\\.')};`));
      expect(body, `${role} letter-spacing`).toMatch(
        new RegExp(`letter-spacing:\\s*${tracking.replace(/[.-]/g, (c) => `\\${c}`)};`),
      );
      // Weight is never part of a role: a role and `font-semibold` are both
      // one class, so which won would come down to stylesheet order.
      expect(body, `${role} must not set a weight`).not.toMatch(/font-weight/);
    }
  });

  it('is the only place a font size is set on the site’s pages', () => {
    const offenders = FILES.flatMap((file) => {
      // OgPreview draws a window's title bar at 10 and 11px. That is furniture
      // inside a picture of an app, not the site's own type.
      if (file.endsWith('OgPreview.tsx')) return [];
      const hits = readFileSync(file, 'utf8').match(/text-\[[0-9.]+px\]/g) ?? [];
      return hits.map((hit) => `${path.relative(ROOT, file)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });

  it('uses no role that does not exist', () => {
    const known = new Set(Object.keys(SCALE));
    const unknown = FILES.flatMap((file) =>
      rolesIn(readFileSync(file, 'utf8'))
        .filter((role) => !known.has(role))
        .map((role) => `${path.relative(ROOT, file)}: ${role}`),
    );
    expect(unknown).toEqual([]);
  });

  it('never sets display type in semibold', () => {
    // Class strings are literals in this codebase, so reading them as text
    // catches the mistake where it is made. A role composed in through a
    // template variable would slip past; nothing here does that today.
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const literal of readFileSync(file, 'utf8').match(/(["'`])[^"'`\n]*\1/g) ?? []) {
        const hasDisplay = DISPLAY_ROLES.some((role) =>
          new RegExp(`(?:^|[\\s"'\`])(?:[a-z]+:)?${role}(?![a-z-])`).test(literal),
        );
        if (hasDisplay && /font-(semibold|bold|black|extrabold)/.test(literal)) {
          offenders.push(`${path.relative(ROOT, file)}: ${literal.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the webfont', () => {
  const FACE = /@font-face\s*\{[^}]*font-family:\s*'Inter';[^}]*\}/.exec(CSS)?.[0] ?? '';

  it('is served from this origin and swaps rather than blocking', () => {
    expect(FACE).toMatch(/url\('\/fonts\/inter-latin-var\.woff2'\)/);
    expect(FACE).toMatch(/font-display:\s*swap/);
    expect(FACE).toMatch(/font-weight:\s*400 700/);
  });

  it('ships the file it asks for, and its licence', () => {
    expect(existsSync(path.join(ROOT, 'public/fonts/inter-latin-var.woff2'))).toBe(true);
    // SIL OFL: the licence travels with the font.
    expect(existsSync(path.join(ROOT, 'public/fonts/inter-LICENSE.txt'))).toBe(true);
  });

  it('is preloaded by the document that will use it', () => {
    // A font is invisible to the browser until the stylesheet is parsed, by
    // which time the first paint is already drawn in the fallback face.
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(
      /<link rel="preload" href="\/fonts\/inter-latin-var\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
    );
  });

  it('has a metric-matched fallback, so the swap does not move a line', () => {
    const fallback = /@font-face\s*\{[^}]*font-family:\s*'Inter Fallback';[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(fallback).toMatch(/size-adjust:\s*105\.27%/);
    expect(fallback).toMatch(/ascent-override:\s*92\.02%/);
    expect(fallback).toMatch(/descent-override:\s*22\.91%/);
  });
});
