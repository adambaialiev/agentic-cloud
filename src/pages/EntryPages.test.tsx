import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ClaudeCodeInTheCloud, { AiAgentsForYourTeam, CodexInTheCloud } from './EntryPages';
import {
  AGENTS_FOR_YOUR_TEAM,
  CLAUDE_CODE_IN_THE_CLOUD,
  CODEX_IN_THE_CLOUD,
  type EntrySpec,
} from '../lib/entry-specs';
import { FAQS } from '../lib/product-copy';

// The live panels are the Workspace's own components, which navigate on tap
// and so need a router above them — as they have on the site.
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const PAGES: [string, () => React.JSX.Element, EntrySpec][] = [
  ['Claude Code in the cloud', ClaudeCodeInTheCloud, CLAUDE_CODE_IN_THE_CLOUD],
  ['Codex in the cloud', CodexInTheCloud, CODEX_IN_THE_CLOUD],
  ['AI agents for your team', AiAgentsForYourTeam, AGENTS_FOR_YOUR_TEAM],
];

describe.each(PAGES)('%s', (_name, Page, spec) => {
  it('answers one question and sends the reader to the whole story', () => {
    render(<Page />);

    expect(screen.getByRole('heading', { level: 1, name: spec.h1 })).toBeTruthy();
    // The copy's door since note #822 (only the private copy is offered);
    // "Start free" to /signup until then.
    expect(screen.getAllByRole('link', { name: /Build your own Agentic Cloud/ })[0]?.getAttribute('href'))
      .toBe('/#give-your-agent');
    expect(screen.queryAllByRole('link', { name: /Start free|Sign up/ })).toEqual([]);
    expect(document.querySelector('a[href="/signup"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'See the whole product' }).getAttribute('href')).toBe('/product');
    // Not a second product tour: the front page runs more than twenty panels,
    // an entry page answers its own question with a handful.
    const panels = document.querySelectorAll('.ws-live');
    expect(panels.length).toBeGreaterThanOrEqual(3);
    expect(panels.length).toBeLessThanOrEqual(6);
  });

  it('shows the product rather than describing it, and fences every panel off', () => {
    render(<Page />);

    const shots = screen.queryAllByRole('img').filter((img) => (img.getAttribute('src') ?? '').startsWith('/shots/'));
    expect(shots.length).toBe(0);
    for (const panel of document.querySelectorAll('.ws-live')) {
      expect(panel.hasAttribute('inert')).toBe(true);
      const said = panel.previousElementSibling;
      expect(said?.className).toBe('sr-only');
      expect((said?.textContent ?? '').length).toBeGreaterThan(20);
    }
  });

  // The failure this guards against is the one that cost us a day in August:
  // the same answer written down twice, drifting apart, and a prospect
  // catching it in one click. These pages quote lib/product-copy.ts.
  it('quotes the site’s one copy of each answer', () => {
    render(<Page />);

    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    if (spec.faqs) expect(spec.faqs.length).toBeGreaterThanOrEqual(4);
    for (const faq of spec.faqs ?? []) {
      expect(FAQS).toContain(faq);
      expect(body).toContain(faq.question);
      expect(body).toContain(faq.answer.replace(/\s+/g, ' '));
    }
  });

  it('makes no claim the front page retired', () => {
    render(<Page />);

    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/Telegram|bot per agent|founding (?:price|discount)/i);
    // No price, no plan ladder, no refund path: there is no billing system to
    // charge one, and /refunds is gone.
    expect(body).not.toMatch(/\$\s?\d|per seat|per month|\/refunds/i);
    // The cost answer says it; the team page has no answers since 2026-10-12.
    // Since note #935 (1 Nov 2026) an own cloud is free for now, with no
    // licence, and nothing offers our hosting (claims-we-never-make).
    if (spec.faqs) expect(body).toMatch(/Your own Agentic Cloud is free for now: no licence, no key and no charge from us\./);
    expect(body).not.toMatch(/free trial|licence from us/);
    expect(body).not.toMatch(/free to use|runs .{0,30} for you, free|we run it for you|\bour cloud|at no charge|thirty live sites/i);
    // The honest answer about the model, never the flattering one.
    expect(body).not.toMatch(/never sees your code|your code never leaves/i);
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href === '/tour' || href.startsWith('/guides') || href === '/refunds')).toBe(false);
  });

  it('puts the words before the panel on a phone', () => {
    render(<Page />);

    for (const section of document.querySelectorAll('main > section')) {
      const heading = section.querySelector('h1, h2');
      const panel = section.querySelector('.ws-live');
      if (!heading || !panel) continue;
      expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('stands on the landing page’s own ground', () => {
    const { container } = render(<Page />);
    const main = container.querySelector('main')!;

    expect(main.className).toContain('bg-panel');
    expect(main.className).toContain('text-white');
    const light = ['bg-canvas', 'text-ink', 'text-prose', 'text-faint', 'bg-white'];
    // An ink button (the header's Build yours from note #839 until note
    // #924) is bg-white with paper text: on this ground "white" is the ink.
    const offenders = [...container.querySelectorAll('*')].filter((el) => !/(?:^|\s)text-panel(?![a-z-])/.test(String(el.className))).flatMap((el) =>
      light.filter((token) =>
        el.className && typeof el.className === 'string'
          ? new RegExp(`(?:^|\\s)${token}(?![a-z-])`).test(el.className)
          : false,
      ),
    );
    expect([...new Set(offenders)]).toEqual([]);
  });
});

// Inviting people is switched off and the Workspace hides people and roles
// (notes #205 and #206), so a workplace is one person's. The team page tells
// that story: one person runs the agents through the Chief of Staff. No
// People deck, no role, no teammate joining.
describe('AI agents for your team, while a workplace is one person’s', () => {
  it('pictures one person running the agents, not a team of people', () => {
    render(<AiAgentsForYourTeam />);

    expect(document.querySelector('[data-person]')).toBeNull();
    expect(document.querySelector('#peopleSection')).toBeNull();
    const section = screen.getByRole('heading', { level: 2, name: 'One conversation runs the whole team.' }).closest('section')!;
    expect(section.querySelector('.ws-live .chathead')?.textContent).toContain('Chief of Staff');
    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(body).not.toMatch(/(?:Admin|Member) · \d+ agents|join with a link|Bring your team in|whole company can brief/);
    expect(body).not.toMatch(/Can my teammates see my keys/);
  });

  // The owner took this page's questions and answers off (2026-10-12).
  it('has no questions and answers', () => {
    render(<AiAgentsForYourTeam />);

    expect(screen.queryByRole('heading', { name: 'The questions people actually ask.' })).toBeNull();
    expect(document.querySelector('dl')).toBeNull();
  });
});

describe('The entry page set', () => {
  it('gives each page its own headline and its own door', () => {
    const specs = PAGES.map(([, , spec]) => spec);
    expect(new Set(specs.map((spec) => spec.h1)).size).toBe(specs.length);
    expect(new Set(specs.map((spec) => spec.closing)).size).toBe(specs.length);
    expect(new Set(specs.map((spec) => spec.slug)).size).toBe(specs.length);
  });

  // Three pages that shared a heading would be three copies of one page, which
  // is what a search engine calls thin content and what a reader calls a maze.
  it('does not repeat one page’s section headings on another', () => {
    const specs = PAGES.map(([, , spec]) => spec);
    for (const [index, spec] of specs.entries()) {
      for (const other of specs.slice(index + 1)) {
        const shared = spec.blocks
          .map((block) => block.heading)
          .filter((heading) => other.blocks.some((block) => block.heading === heading));
        expect(shared).toEqual([]);
      }
    }
  });
});
