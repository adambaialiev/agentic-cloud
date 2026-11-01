import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CHAPTERS, chapterPath } from '../docs/chapters';
import { FAQS } from '../lib/product-copy';
import { ROUTES } from '../entry-server';
import DocsChapterRoute, { Chapter, DocsIndex } from './Docs';

/**
 * The documentation is the longest customer-facing surface on the site and
 * the one most likely to drift, so the rules the landing keeps by hand are
 * kept here by test: every chapter is reachable, every panel is fenced, no
 * retired claim is made, and every door on it leads somewhere that exists.
 */

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

/** A product room, by its plural or by a word that points at one. */
const ROOMS = /\brooms\b|\b(a|an|the|this|that|each|every|another|its|their|your|one|any) room\b/i;

/** The live panels are the app's own components, and some carry the app's
 *  router hooks, so a chapter is drawn inside a router as the site draws it. */
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

describe('the documentation', () => {
  it('lists every chapter on the contents page, in order, with its own door', () => {
    render(<DocsIndex />);

    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeTruthy();
    const doors = [...document.querySelectorAll('article a[href^="/docs/"]')].map((a) => a.getAttribute('href'));
    expect(doors).toEqual(CHAPTERS.map(chapterPath));
    expect(CHAPTERS.length).toBeGreaterThanOrEqual(10);
  });

  it('gives every chapter a unique slug, title and description, and a real body', () => {
    expect(new Set(CHAPTERS.map((c) => c.slug)).size).toBe(CHAPTERS.length);
    expect(new Set(CHAPTERS.map((c) => c.title)).size).toBe(CHAPTERS.length);
    expect(new Set(CHAPTERS.map((c) => c.description)).size).toBe(CHAPTERS.length);
    for (const chapter of CHAPTERS) {
      expect(chapter.slug, chapter.slug).toMatch(/^[a-z0-9-]+$/);
      expect(chapter.sections.length, `${chapter.slug} has sections`).toBeGreaterThanOrEqual(3);
      expect(chapter.reference.length, `${chapter.slug} has a reference`).toBeGreaterThanOrEqual(4);
      expect(new Set(chapter.sections.map((s) => s.id)).size).toBe(chapter.sections.length);
      expect(chapter.description.length).toBeLessThanOrEqual(170);
    }
  });

  it('prerenders every chapter under its own route', () => {
    for (const chapter of CHAPTERS) {
      const route = ROUTES.find((r) => r.path === chapterPath(chapter));
      expect(route, chapter.slug).toBeTruthy();
      expect(route?.title).toContain(chapter.title);
      expect(route?.noindex).toBeFalsy();
    }
  });

  it.each(CHAPTERS.map((chapter) => [chapter.slug, chapter] as const))('draws %s as a chapter with its sidebar, sections, reference and doors', (_slug, chapter) => {
    render(<Chapter chapter={chapter} />);

    expect(screen.getByRole('heading', { level: 1, name: chapter.title })).toBeTruthy();
    // The sidebar marks this chapter and lists all of them.
    const current = document.querySelector('nav[aria-label="Chapters"] a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe(chapterPath(chapter));
    for (const other of CHAPTERS) {
      expect(document.querySelector(`nav[aria-label="Chapters"] a[href="${chapterPath(other)}"]`), other.slug).toBeTruthy();
    }
    // Every section is a heading with its anchor, and the reference closes it.
    for (const section of chapter.sections) {
      expect(document.getElementById(section.id), section.id).toBeTruthy();
      expect(screen.getByRole('heading', { level: 2, name: section.heading })).toBeTruthy();
    }
    expect(document.getElementById('reference')).toBeTruthy();
    // Previous and next.
    const index = CHAPTERS.indexOf(chapter);
    const doors = document.querySelector('nav[aria-label="Chapters, previous and next"]')!;
    if (index > 0) expect(doors.querySelector(`a[href="${chapterPath(CHAPTERS[index - 1]!)}"]`)).toBeTruthy();
    if (index < CHAPTERS.length - 1) expect(doors.querySelector(`a[href="${chapterPath(CHAPTERS[index + 1]!)}"]`)).toBeTruthy();
    // Nothing left unwritten.
    expect(text()).not.toMatch(/PLACEHOLDER|\bTODO\b|\bTBD\b|lorem ipsum/);
  });

  it('fences every live panel off, with a spoken sentence before it', () => {
    for (const chapter of CHAPTERS) {
      const { unmount } = render(<Chapter chapter={chapter} />);
      for (const panel of document.querySelectorAll('.ws-live')) {
        expect(panel.hasAttribute('inert')).toBe(true);
        const said = panel.previousElementSibling;
        expect(said?.className).toBe('sr-only');
        expect((said?.textContent ?? '').length).toBeGreaterThan(20);
      }
      unmount();
    }
  });

  // The claims page (knowledge "claims-we-never-make") and "the-product":
  // the words that cost us something once, kept out by test rather than by
  // memory. The FAQ in lib/product-copy.ts is the one copy of each answer.
  it('makes no retired claim anywhere in the documentation', () => {
    for (const chapter of [...CHAPTERS]) {
      const { unmount } = render(<Chapter chapter={chapter} />);
      const body = text();
      expect(body, chapter.slug).not.toMatch(/telegram/i);
      expect(body, chapter.slug).not.toMatch(/\bcoworkers?\b/i);
      expect(body, chapter.slug).not.toMatch(/\$\s?\d/);
      expect(body, chapter.slug).not.toMatch(/(fifteen|15) (quiet |idle )?minutes/i);
      expect(body, chapter.slug).not.toMatch(/founding (discount|price|rate)|launch price|waiting list/i);
      expect(body, chapter.slug).not.toMatch(/nothing of yours rests with us|never sees your code/i);
      expect(body, chapter.slug).not.toMatch(/\bslide deck\b|\bdemo video\b/i);
      // Note #664 (2026-09-25): a new workplace connects no cloud of its own;
      // its machines and sites run on ours (no agent count is named since
      // note #817, see below).
      expect(body, chapter.slug).not.toMatch(/your (own )?Fly(\.io)? (account|bill|cloud|organization)|Org deploy token|in your own cloud account/i);
      // The owner, 2026-09-25: the provider is our implementation; the docs
      // say "the cloud" and never name it.
      expect(body, chapter.slug).not.toMatch(/\bFly\b|Fly\.io|Fly Machine/);
      expect(body, chapter.slug).not.toMatch(/no (ceiling|limit) on how many|unlimited agents/i);
      // Rooms left the product on 30–31 Oct 2026 (note #843): a workplace is
      // one place, and work kept apart goes in another workplace. "Room" as
      // space ("so the reply has room") is not a room.
      expect(body, chapter.slug).not.toMatch(ROOMS);
      unmount();
    }
    for (const faq of FAQS) expect(faq.answer, faq.key).not.toMatch(ROOMS);
  });

  // The owner, 2026-10-27 and note #817 (2026-10-28): public words never
  // name a number of agents and never say "unlimited". Prose only: the
  // Cloud card panel is the Workspace's own screen and draws what the
  // product counts.
  it('names no number of agents and never says unlimited, in a chapter or an answer', () => {
    const count = /up to (twenty|20)\b|at most (twenty|20)\b|\b(twenty|20) agents|at (twenty|20)\b|unlimited/i;
    for (const chapter of CHAPTERS) {
      const { unmount } = render(<Chapter chapter={chapter} />);
      const prose = [...document.querySelectorAll('article')]
        .map((article) => {
          const copy = article.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.ws-live, [aria-hidden="true"], .sr-only').forEach((node) => node.remove());
          return copy.textContent ?? '';
        })
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(prose, chapter.slug).not.toMatch(count);
      unmount();
    }
    for (const faq of FAQS) expect(faq.answer, faq.key).not.toMatch(count);
  });

  it('links only to addresses that exist', () => {
    const known = new Set(ROUTES.map((r) => r.path));
    for (const chapter of CHAPTERS) {
      const { unmount } = render(<Chapter chapter={chapter} />);
      for (const a of document.querySelectorAll('article a[href]')) {
        // A live panel is the product's own screen, inert, and its links are
        // the app's: a door into the Workspace, not a door on this page.
        if (a.closest('.ws-live')) continue;
        const href = a.getAttribute('href')!;
        if (href.startsWith('#')) {
          expect(document.getElementById(href.slice(1)), `${chapter.slug}: ${href}`).toBeTruthy();
        } else if (href.startsWith('/docs')) {
          const [path, hash] = href.split('#');
          expect(known.has(path!), `${chapter.slug}: ${href}`).toBe(true);
          if (hash) {
            const target = CHAPTERS.find((c) => chapterPath(c) === path);
            expect(target?.sections.some((s) => s.id === hash) || hash === 'reference', `${chapter.slug}: ${href}`).toBe(true);
          }
        } else if (href.startsWith('/')) {
          expect(known.has(href.split('#')[0]!) || href === '/login' || href === '/signup' || href.startsWith('/workspace'), `${chapter.slug}: ${href}`).toBe(true);
        } else {
          expect(href, `${chapter.slug}: ${href}`).toMatch(/^(https:\/\/|mailto:)/);
        }
      }
      unmount();
    }
  });

  it('answers the front page’s questions the same way, where it answers them at all', () => {
    // A chapter that quotes an FAQ answer quotes it whole; a chapter that
    // does not quote it must not contradict its numbers.
    for (const chapter of CHAPTERS) {
      const { unmount } = render(<Chapter chapter={chapter} />);
      const body = text();
      if (/three quiet minutes|about three/.test(body)) expect(body).not.toMatch(/five quiet minutes|ten quiet minutes/);
      for (const faq of FAQS) {
        if (body.includes(faq.question)) expect(body, `${chapter.slug} quotes "${faq.question}" whole`).toContain(faq.answer.replace(/\s+/g, ' '));
      }
      unmount();
    }
  });

  // The front page's answers each end in a door to the chapter that says the
  // rest. A door to a chapter or a section that is not there is worse than
  // no door: it is the one link on the page a curious reader follows.
  it('gives every front-page answer a door into a chapter that exists', () => {
    for (const faq of FAQS) {
      const [path, hash] = faq.docs.split('#');
      const chapter = CHAPTERS.find((c) => chapterPath(c) === path);
      expect(chapter, `${faq.key}: ${faq.docs}`).toBeTruthy();
      if (hash) expect(chapter!.sections.some((s) => s.id === hash), `${faq.key}: ${faq.docs}`).toBe(true);
    }
  });

  it('sends an unknown chapter to the contents', () => {
    renderBare(
      <MemoryRouter initialEntries={['/docs/no-such-chapter']}>
        <Routes>
          <Route path="/docs" element={<DocsIndex />} />
          <Route path="/docs/:slug" element={<DocsChapterRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeTruthy();
  });
});
