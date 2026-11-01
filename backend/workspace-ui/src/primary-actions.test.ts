import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const components = readdirSync(path.join(ROOT, 'src'), { recursive: true })
  .filter((name): name is string => typeof name === 'string' && name.endsWith('.tsx'))
  .map((name) => readFileSync(path.join(ROOT, 'src', name), 'utf8'))
  .join('\n');

describe('primary actions', () => {
  it('draws no hairline on either primary-action vocabulary', () => {
    expect(css).not.toMatch(/\.btn\.primary[^,{]*::after/);
    expect(css).not.toMatch(/\.save[^,{]*::after/);
  });

  // A room's detail and danger actions shared the rule until rooms left the
  // product (note #843).
  it('keeps bare subscription actions tucked left and close together', () => {
    const detailActions = /(?:^|\n)#seatActions\s*\{([^}]*)}/.exec(css)?.[1] ?? '';
    expect(detailActions).toContain('gap: 2px;');
    expect(detailActions).toContain('padding-left: 8px;');
  });

  it('gives commits below fields a quiet, thumb-sized surface', () => {
    const commit = /(?:^|\n)\.formcommit\s*\{([^}]*)}/.exec(css)?.[1] ?? '';
    const hit = /(?:^|\n)\.formcommit::after\s*\{([^}]*)}/.exec(css)?.[1] ?? '';
    expect(commit).toContain('width: fit-content;');
    expect(commit).toContain('min-width: 112px;');
    expect(commit).toContain('min-height: 40px;');
    expect(commit).toContain('border-radius: 999px;');
    expect(commit).toContain('background: var(--accent-soft);');
    expect(hit).toContain('inset: -2px 0;');
  });

  it('answers a confirmation in red text rather than a filled slab (note #624)', () => {
    const danger = /(?:^|\n)\.ask \.btn\.danger\s*\{([^}]*)}/.exec(css)?.[1] ?? '';
    // The rule says ONE thing: the weight that ranks this answer above
    // Cancel. Everything else — no fill, the danger ink, the same box as its
    // neighbour — is inherited, which is what keeps the two answers one
    // shape apart in colour alone.
    expect(danger).toContain('font-weight: 500;');
    expect(danger).not.toMatch(/background|border-radius|padding/);
    expect(/(?:^|\n)\.ask \.btns \.btn\s*\{([^}]*)}/.exec(css)?.[1] ?? '').toContain('padding: 11px 12px;');
  });

  it('uses that surface for every form submit instead of the loose text-action style', () => {
    expect(components).not.toMatch(/<button(?=[^>]*type="submit")(?=[^>]*className="btn primary")[^>]*>/);
  });

  it('uses it for content commits that submit without a native form', () => {
    for (const id of ['mailComposeSend', 'mailReplySend']) {
      expect(components).toMatch(new RegExp(`<button[^>]*className="formcommit"[^>]*id="${id}"`));
    }
  });
});
