import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('the Workspace toast', () => {
  it('is the app\'s own paper card with its own words, an edge and elevation — not black (note #728)', () => {
    const rule = /^#banner\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    expect(rule).toContain('background: var(--bg); color: var(--text);');
    expect(rule).toContain('box-shadow: 0 12px 34px rgba(0, 0, 0, .14), 0 0 0 1px var(--border);');
    expect(rule).not.toContain('var(--text); color: #fff');
  });

  it('tells success from failure by its mark: the page\'s green, its red (note #728)', () => {
    const mark = /^#banner \.toastmark\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    expect(mark).toContain('color: var(--danger);');
    expect(css).toContain('#banner.ok .toastmark { color: var(--ok); }');
    const dismiss = /^#banner \.toastdismiss\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    expect(dismiss).toContain('color: var(--hint);');
  });

  it('stands along the top, clear of the notch, and slides down into place (note #722)', () => {
    const rule = /^#banner\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    expect(rule).toContain('top: calc(12px + env(safe-area-inset-top, 0px));');
    expect(rule).not.toMatch(/\bbottom:/);
    expect(rule).toContain('transform: translateY(calc(-100% - 16px));');
  });

  it('is as wide as what it says, centred at the top, wrapping at a cap rather than running edge to edge (note #737)', () => {
    const rule = /^#banner\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    // Both insets set, a fit-content width and auto margins: the card
    // shrinks to its mark, words and dismiss button and centres itself in
    // what is left — never wider than the screen less 12px each side.
    expect(rule).toContain('left: 12px; right: 12px; width: fit-content; max-width: 480px; margin: 0 auto;');
    expect(rule).not.toContain('max-width: 720px');
  });

  it('has no shrinking countdown line', () => {
    expect(css).not.toMatch(/#banner\s+\.drain/);
    expect(css).not.toMatch(/@keyframes\s+drain/);
  });

  it('centres the status mark and copy on one axis, with only dismiss clickable', () => {
    const banner = /^#banner\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    const mark = /^#banner \.toastmark\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    const dismiss = /^#banner \.toastdismiss\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? '';
    expect(banner).toContain('align-items: center;');
    expect(banner).toContain('pointer-events: none;');
    expect(mark).toContain('width: 17px; height: 17px; line-height: 0;');
    expect(dismiss).toContain('pointer-events: none;');
    expect(css).toContain('#banner.show .toastdismiss { pointer-events: auto; }');
  });
});
