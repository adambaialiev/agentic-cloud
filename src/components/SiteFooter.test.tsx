import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SiteFooter, { FOOTER_QUIET } from './SiteFooter';
import { NewTabContext } from '../lib/new-tab';

const css = readFileSync(path.resolve(__dirname, '..', 'index.css'), 'utf8');
const landing = /\.landing-page\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const hex = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(landing)![1]!;
const luminance = (value: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('SiteFooter', () => {
  // Note #999: the home page opens every link in a new tab; everywhere else
  // the footer's links open in place, as before.
  it('opens its links in place, unless the page asks for new tabs', () => {
    const { container, unmount } = render(<SiteFooter pitch="Pitch." tone="dark" />);
    expect([...container.querySelectorAll('a')].every((a) => !a.hasAttribute('target'))).toBe(true);
    unmount();
    const home = render(<NewTabContext.Provider value={true}><SiteFooter pitch="Pitch." tone="dark" /></NewTabContext.Provider>);
    const links = [...home.container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(5);
    expect(links.every((a) => a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    home.unmount();
  });

  // The owner, 28 Oct 2026: the footer's column titles and closing line were
  // the hint grey at 80%, which measured 3.6:1 on every public page. Small
  // text needs 4.5:1, so no footer text is a fraction of its colour.
  it('sets every footer text in a full-strength colour', () => {
    for (const tone of ['dark', 'light'] as const) {
      const { container, unmount } = render(<SiteFooter pitch="Pitch." tone={tone} />);
      const classes = [...container.querySelectorAll('footer *')].map((el) => el.getAttribute('class') ?? '').join(' ');
      expect(classes, tone).not.toMatch(/(^|\s)text-[a-z-]+\/\d+/);
      // The two column titles and the closing line are the quiet ones.
      const quiet = [...container.querySelectorAll('footer p')].filter((p) => /^(Product|Legal|©)/.test(p.textContent ?? ''));
      expect(quiet, tone).toHaveLength(3);
      for (const p of quiet) expect(p.className.split(' '), `${tone}: ${p.textContent}`).toContain(FOOTER_QUIET[tone]);
      unmount();
    }
  });

  it('keeps the public pages’ quiet grey above 4.5:1 on their background', () => {
    expect(contrast(hex('--color-hint'), hex('--color-panel'))).toBeGreaterThanOrEqual(4.5);
  });
});
