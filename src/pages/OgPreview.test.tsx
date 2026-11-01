import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render as renderBare } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import OgPreview from './OgPreview';
import Landing from './Landing';
import FourPhases from './FourPhases';

// The live chat panel is the Workspace's own screen, which navigates on tap
// and so needs a router above it — as it has on the site.
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const ROOT = path.resolve(__dirname, '..', '..');

describe('The social card', () => {
  // This is the most-seen asset we have: the whole distribution motion is a
  // forwarded link, and this is the picture on the card. It went stale
  // silently for ten days after the 2026-08-20 pivot, and the capture that
  // replaced the drawing shipped a fixture hostname and a conversation opening
  // mid-sentence for eight days. It is the product itself now.
  it('shows the Workspace running, not a picture of it', () => {
    const { container } = render(<OgPreview />);

    expect(container.querySelectorAll('img[src^="/shots/"]')).toHaveLength(0);
    const panel = container.querySelector('.ws-live');
    expect(panel).toBeTruthy();
    expect(panel!.hasAttribute('inert')).toBe(true);
  });

  // The owner's call, 2026-09-14: the card shows the front page's own fleet
  // panel, close up — so the picture in the chat app and the screen a reader
  // lands on are one thing. It is the four-agent fleet the landing draws in
  // "A team, not one bot", not the hero's three: the hero leaves a quarter of
  // its grid empty, which reads as room for more at full size and as a
  // rendering fault in a thumbnail. Four also puts both CLIs on the card
  // twice, which is what the headline above it promises.
  it('is the hero’s own fleet, eight agents fading out past the first rows', () => {
    const { container: card } = render(<OgPreview />);
    const { container: phases } = render(<FourPhases />);

    const names = (root: Element) => [...root.querySelectorAll('.crow .agentidentity .name')]
      .map((node) => node.textContent?.trim());
    // The hero's agents, not the team tile: the card says what the front
    // page says first, that the fleet keeps going (the owner, 2026-09-16).
    // Since note #185 (2026-10-08) the hero carries them in a moving row,
    // among the people and their work, each after the person who drives
    // them; the card keeps the fleet as one deck, the dogs being the brand.
    // Same eight agents, so the comparison ignores the order. The row is
    // drawn three times (see LiveMarquee); the first copy is the row. Since
    // note #199 (2026-10-09) the front page has no hero, and the row stands
    // under the fourth phase on /four-phases.
    const heroAgents = [...phases.querySelectorAll('#phase-4 .landing-marquee-copy:first-child .is-agent .agentidentity .name')]
      .map((node) => node.textContent?.trim());
    const cardPanel = card.querySelector('.ws-live')!;
    expect([...names(cardPanel)].sort()).toEqual(heroAgents.sort());
    expect(names(cardPanel).length).toBe(8);
    // Faces, not initials: the dogs are the brand, and at the size this is
    // read they are the only thing on the panel still legible.
    expect(cardPanel.querySelectorAll('img.avatar').length).toBe(8);
    // Most of them mid-job. A card that shows a team standing idle is
    // selling the wrong thing; a fleet with nobody idle is a demo.
    expect([...cardPanel.querySelectorAll('.cline .ctext')]
      .filter((line) => line.textContent === 'Now')).toHaveLength(6);
    // The fade is the card's own, sized to finish before the card's edge.
    expect(card.querySelector('.og-fleet')).toBeTruthy();
    expect(readFileSync(path.join(ROOT, 'src/index.css'), 'utf8')).toMatch(/\.og-fleet \.plates \{\s*mask-image: linear-gradient\(to bottom/);
  });

  it('carries the headline alone, word for word from the front page', () => {
    const { container: card } = render(<OgPreview />);
    const { container: landing } = render(<Landing />);

    const headline = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(headline(card.querySelector('h1'))).toBe(headline(landing.querySelector('h1')));
    // No lede under it since 2026-09-14: at the size this is read the second
    // sentence was never read, and the panel beside it says the same thing in
    // the product's own pixels.
    expect(card.querySelector('h1 + p')).toBeNull();
  });

  it('keeps the card inside its own 1200x630 frame', () => {
    const { container } = render(<OgPreview />);

    const canvas = container.querySelector('#og-canvas')!;
    expect(canvas.className).toContain('h-[630px]');
    expect(canvas.className).toContain('w-[1200px]');
    expect(canvas.className).toContain('overflow-hidden');
    // The fleet panel is taller than the frame on purpose and runs off its
    // bottom edge, faded to nothing before it gets there. The row it sits in
    // is what clips, so the headline beside it is centred in the card and
    // not in the panel's full height.
    const frame = container.querySelector('.og-fleet')!.parentElement!;
    expect(frame.className).not.toMatch(/max-h-\[\d+px\]/);
    expect(frame.className).toContain('self-start');
    expect(frame.className).toContain('rounded-');
    expect(frame.parentElement!.className).toContain('overflow-hidden');
    expect(frame.parentElement!.className).toContain('items-center');
  });
});
