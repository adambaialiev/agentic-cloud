import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OgPreview, { SQUARE_SAFE } from './OgPreview';
import { HOME_TITLE, SHARE_DESCRIPTION, SHARE_HEADLINE, SHARE_IMAGE_ALT, SHARE_IMAGE_VERSION, SHARE_LINE, SHARE_TITLE } from '../lib/share-card';

const ROOT = path.resolve(__dirname, '..', '..');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const meta = (key: string) => new RegExp(`<meta (?:property|name)="${key.replace(/[:]/g, '\\:')}" content="([^"]*)"`).exec(indexHtml)?.[1];

describe('The share card (note #1004)', () => {
  // The most-seen picture we publish. Since note #1004 (the owner's pick,
  // variant A of the mock-up): words only, the masthead, the film's closing
  // words as the one big line and the problem we solve under it.
  it('is words only: the masthead, the headline and the problem line', () => {
    const { container } = render(<OgPreview />);
    const card = container.querySelector('#og-canvas')!;
    expect(card.querySelector('[data-og-masthead]')?.textContent?.trim()).toBe('Agentic Cloud Computer');
    // One sentence a line (note #1137), so the headline fits the centre square.
    expect(card.querySelector('h1')!.textContent).toBe(SHARE_HEADLINE.replace(/\. /g, '.'));
    expect(card.querySelectorAll('h1 br')).toHaveLength(3);
    expect(card.querySelector('p')?.textContent?.replace(/\u00a0/g, ' ')).toBe(SHARE_LINE);
    // No screenshots, no live panels, no avatars: nothing that is
    // unreadable at the size a preview is drawn.
    expect(card.querySelectorAll('img, .ws-live')).toHaveLength(0);
  });

  // Note #1137: WhatsApp and iMessage may draw only the centre square
  // (x 285..915). The words stand in one column narrower than that square,
  // centred; scripts/shoot-og-image.mjs measures the real render.
  it('keeps every word inside the centre square', () => {
    const { container } = render(<OgPreview />);
    const canvas = container.querySelector('#og-canvas')!;
    expect(canvas.className).toContain('justify-center');
    const column = canvas.querySelector('[data-og-column]') as HTMLElement;
    expect(column.style.width).toBe(`${SQUARE_SAFE.column}px`);
    expect(SQUARE_SAFE.column).toBeLessThanOrEqual(SQUARE_SAFE.right - SQUARE_SAFE.left - 60);
  });

  it('keeps the card inside its own 1200x630 frame', () => {
    const { container } = render(<OgPreview />);
    const canvas = container.querySelector('#og-canvas')!;
    expect(canvas.className).toContain('h-[630px]');
    expect(canvas.className).toContain('w-[1200px]');
    expect(canvas.className).toContain('overflow-hidden');
  });

  // index.html's tags are what every route's card starts from; the home
  // route's title and description are rewritten from ROUTES to the same
  // words (entry-server.test).
  it('publishes the picked words in index.html, with the site name and the image alt', () => {
    expect(SHARE_TITLE.length).toBeLessThanOrEqual(60);
    expect(SHARE_DESCRIPTION.length).toBeLessThan(150);
    expect(indexHtml).toContain(`<title>${HOME_TITLE}</title>`);
    expect(meta('description')).toBe(SHARE_DESCRIPTION);
    expect(meta('og:title')).toBe(SHARE_TITLE);
    expect(meta('og:description')).toBe(SHARE_DESCRIPTION);
    expect(meta('twitter:title')).toBe(SHARE_TITLE);
    expect(meta('twitter:description')).toBe(SHARE_DESCRIPTION);
    expect(meta('og:site_name')).toBe('Agentic Cloud Computer');
    expect(meta('og:image:alt')).toBe(SHARE_IMAGE_ALT);
    expect(meta('twitter:image:alt')).toBe(SHARE_IMAGE_ALT);
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('og:image')).toBe(`https://agenticcloudcomputer.com/og-image.png?v=${SHARE_IMAGE_VERSION}`);
    expect(meta('twitter:image')).toBe(`https://agenticcloudcomputer.com/og-image.png?v=${SHARE_IMAGE_VERSION}`);
  });
});
