import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Workspace's light palette (note #418).
 *
 * These are not ornamental constants. The same roles draw 12px metadata,
 * links, decisions and filled chat bubbles on both the page and its cards,
 * so a pleasant screenshot can otherwise turn into unreadable working UI.
 */

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const value = (name: string) => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(css);
  if (!match) throw new Error(`missing literal ${name}`);
  return match[1]!;
};

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return 0.2126 * linear(channels[0]!) + 0.7152 * linear(channels[1]!) + 0.0722 * linear(channels[2]!);
};

const contrast = (one: string, two: string) => {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
};

describe('the Workspace palette', () => {
  it('uses the Claude-like paper and neutral surface with its own blue accent', () => {
    expect(value('--bg')).toBe('#fcfcfb');
    expect(value('--card')).toBe('#efefef');
    expect(value('--text')).toBe('#1f1e1d');
    expect(value('--accent')).toBe('#1a68d8');
    expect(css).toContain('color-scheme: light;');
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<meta name="theme-color" content="#fcfcfb">');
  });

  it('draws a starred letter’s star with an edge that reads as a shape on the page and on a card', () => {
    // Note #666. A graphic, not text: 3:1 is what WCAG asks of one, and the
    // edge carries it — the gold fill inside is decoration.
    for (const surface of [value('--bg'), value('--card')]) {
      expect(contrast(value('--star'), surface), `--star on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    expect(css).toContain('.mailstar.on { color: var(--star); }');
    expect(css).toContain('.mailstar.on svg { fill: var(--star-fill); }');
  });

  it('keeps every text-bearing role readable on the page and cards', () => {
    const surfaces = [value('--bg'), value('--card')];
    const inks = ['--text', '--hint', '--accent', '--danger', '--warn', '--ok'].map(value);
    for (const surface of surfaces) {
      for (const ink of inks) expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(value('--accent-text'), value('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain('.badge.busy { color: var(--warn); }');
    expect(css).toContain('.noteswipeaction {');
    expect(css).toContain('padding-left: 14px; color: var(--warn);');
    expect(css).toContain('.plus { color: var(--ok); }');
    expect(css).toContain('.minus { color: var(--danger); }');
  });

  /**
   * A TINT MAY SOFTEN A BACKGROUND; it may never be deep enough to take the
   * ink off the text standing on it. A conversation draws the reader's own
   * letters on the accent's own tint so they can tell their words from the
   * sender's (note #545, slice 8), and the accent is the tightest ink we
   * have: at 10% over the page its own colour falls under 4.5:1 on the
   * surface it made.
   */
  it('keeps the accent-tinted surfaces light enough to carry small text', () => {
    const mix = (ink: string, surface: string, share: number) => {
      const channels = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
      const [one, two] = [channels(ink), channels(surface)];
      const blended = one.map((channel, index) => Math.round(share * channel + (1 - share) * two[index]!));
      return `#${blended.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    };
    const share = /background: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\);/
      .exec(/\.mailletter\.mailown \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '')?.[1];
    expect(share, 'the reply tint is stated as a percentage of the accent').toBeTruthy();
    const surface = mix(value('--accent'), value('--bg'), Number(share) / 100);
    for (const ink of ['--text', '--hint', '--accent'].map(value)) {
      expect(contrast(ink, surface), `${ink} on the reply tint ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the full-screen media viewer intentionally dark and legible', () => {
    const viewer = /\.imageviewer, \.pdfviewer\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(viewer).toContain('--text: #ffffff;');
    expect(viewer).toContain('--hint: #aab4bf;');
    expect(viewer).toContain('background: #090b0f;');
  });
});
