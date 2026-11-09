import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import Home, { BOOKFACE_LINK, BOOKFACE_URL, FILM_BACKGROUND, FILM_SECTION_NAMES, FILM_SECTION_SHORT_NAMES, HOME_HEADLINE, PRODUCT_FILM, PRODUCT_FILM_TALL } from './Home';
import { filmUrl, PRODUCT_FILM_PATH, PRODUCT_FILM_TALL_PATH } from '../lib/films';
import { TALL_FILM_QUERY } from '../components/HomeFilm';
import { HOME_COLUMN, SCREEN_MAX_HEIGHT, SCREEN_MAX_WIDTH } from '../components/landing-kit';
import { OWN_CLOUD_HEADING } from './PrivateCopy';
import { GUEST_HEADING } from '../components/GuestAgent';
import { VALUE_FACTS, VALUE_HEADING, VALUE_LEAD } from '../lib/value-copy';

void React;

function answer() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })));
}

const draw = () => render(<MemoryRouter><Home /></MemoryRouter>);

describe('Home, the product first and the own cloud second (note #835)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Note #835 (the owner, 29 Oct 2026, 18:10 UTC): lead with the problem,
  // "coding agents are great engineers with no workplace around them", in its
  // five faces, each answered by the product; then "and all of it runs in
  // your own cloud"; How to start, For your team and Talk to us as they were.
  // The long tour is /product's alone.
  // Note #1003 (the owner, 5 Nov 2026, 12:49 UTC): the first screen names
  // the product with its mark, above the film and not over it, as words and
  // no link; the footer's name stands with the mark too.
  it('names the product with its mark above the film and in the footer', () => {
    answer();
    draw();
    const film = document.querySelector('#film')!;
    const masthead = film.querySelector('[data-masthead]')!;
    expect(masthead.textContent).toBe('Agentic Cloud Computer');
    expect(masthead.querySelector('a')).toBeNull();
    expect(masthead.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(masthead.closest('[data-film-box]')).toBeNull();
    expect(masthead.compareDocumentPosition(film.querySelector('[data-film-box]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(film.querySelector('h1, h2, h3')).toBeNull();
    const name = document.querySelector('footer [data-footer-name]')!;
    expect(name.textContent?.trim()).toBe('Agentic Cloud Computer');
    expect(name.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  // Note #999 (the owner, 5 Nov 2026, 11:32 UTC: "all links in the landing
  // page should open in new tab"): every anchor on the page, the footer's
  // included, opens a new tab without handing over the opener, and says so
  // to a screen reader.
  it('opens every link on the page in a new tab', () => {
    answer();
    draw();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const name = `${link.textContent} ${link.getAttribute('href')}`;
      expect(link.getAttribute('target'), name).toBe('_blank');
      expect(link.getAttribute('rel'), name).toBe('noopener noreferrer');
      expect(`${link.textContent ?? ''} ${link.getAttribute('aria-describedby') ? 'described' : ''}`, name).toMatch(/opens in a new tab|described/);
    }
    expect(links.some((link) => link.closest('footer'))).toBe(true);
  });

  it('runs seven screens: the film, the value, the workplace, the own cloud, how to build yours, an agent of your own, the footer', () => {
    answer();
    draw();
    const headings = [...document.querySelectorAll('main h1, main section h2')]
      .filter((node) => !node.closest('.ws-live'))
      .map((node) => node.textContent);
    expect(headings).toEqual([
      HOME_HEADLINE,
      VALUE_HEADING,
      OWN_CLOUD_HEADING,
      'Build your own Agentic Cloud.',
      GUEST_HEADING,
    ]);
    // Note #1012 (Adam, 6 Nov 2026, 05:50 UTC): the agent screen is last,
    // and the footer is the only thing under it. Since note #1039 it is the
    // guest's own agent; Hugo's "Ask an agent that reads the code." is gone.
    const last = document.querySelector('main > section#your-agent')!;
    expect(last.nextElementSibling?.tagName).toBe('FOOTER');
    expect(document.querySelector('#ask')).toBeNull();
    // Since note #984 (the owner, 4 Nov 2026, 14:07 UTC) the page is five
    // screens: the film, the workplace drawing, the own cloud, how to build
    // yours, the footer. The headline is the page's one h1, not drawn.
    expect(document.querySelector('main h1')!.className).toMatch(/\bsr-only\b/);
    for (const id of ['#home-top', '#team', '#memory', '#keys', '#computers', '#work', '#for-your-team', '#contact']) expect(document.querySelector(id), id).toBeNull();
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    for (const gone of ['#proof', '#homeFounder', '#home-context', '#built-in', '#subscriptions', '#apps', '#home-close']) expect(document.querySelector(gone), gone).toBeNull();
  });

  // Note #1085 (Adam, 8 Nov 2026): the value in one breath, right after the
  // film. Option B of three, with his changes: two facts, no link, the word
  // fatigue, independence from Anthropic and OpenAI, and a short data
  // sentence that still admits the daily report. Never "leaves".
  it('says the value right after the film: heading, lead and two facts, no link', () => {
    answer();
    draw();
    const value = document.querySelector('main > section#value')!;
    expect(value.previousElementSibling?.id).toBe(PRODUCT_FILM ? 'film' : undefined);
    expect(value.nextElementSibling?.id).toBe('workplace');
    expect(value.querySelector('h2')!.textContent).toBe('Your agents. Your cloud. Your data.');
    expect(value.querySelector('p')!.textContent).toBe(VALUE_LEAD);
    expect(VALUE_LEAD).toMatch(/None of your data comes to us, only a daily report\.$/);
    expect(VALUE_HEADING).toBe('Your agents. Your cloud. Your data.');
    const facts = [...value.querySelectorAll('[data-value-fact]')].map((fact) => [fact.querySelector('dt')!.textContent, fact.querySelector('dd')!.textContent]);
    expect(facts).toEqual(VALUE_FACTS.map(({ title, line }) => [title, line]));
    expect(facts.map(([title]) => title)).toEqual(['Built in', 'Switch tools, keep the context']);
    expect(facts[0]![1]).toMatch(/fatigue/);
    expect(facts[1]![1]).toMatch(/not to Anthropic or OpenAI/);
    expect(value.querySelectorAll('a, button')).toHaveLength(0);
    const words = value.textContent ?? '';
    expect(words).not.toMatch(/leaves|never sees|cutting.edge|latest|best|free|price/i);
    expect(words).not.toMatch(/Kept current/);
  });

  // Note #841 (the owner, 30 Oct 2026, 13:31 UTC): one drawing of the whole
  // workplace right after the first screen, before the five parts zoom in.
  // Drawn in code, wide on a desk and tall on a phone, each one picture with
  // one sentence for a screen reader, and only the page's own names on it.
  // Redrawn without rooms after they left the product (the owner, 31 Oct).
  it('shows the whole workplace as one floor plan, alone in the screen after the film', () => {
    answer();
    draw();
    const plan = document.querySelector('#workplace')!;
    // Since note #984 it follows the film and leads to the own cloud, with
    // no heading: "Here's the workplace." came off; the plan's labels say it.
    // Since note #1085 the value screen sits between the film and the plan.
    expect(plan.previousElementSibling?.id).toBe('value');
    expect(plan.nextElementSibling?.id).toBe('own-cloud');
    expect(plan.querySelectorAll('h1, h2, h3, p')).toHaveLength(0);
    expect(plan.querySelectorAll('img')).toHaveLength(0);
    const drawings = [...plan.querySelectorAll('svg[role="img"]')];
    expect(drawings).toHaveLength(2);
    expect(drawings[0]!.closest('[data-plan-wide]')!.parentElement!.className).toMatch(/\bhidden\b.*\blg:block\b/);
    expect(drawings[1]!.closest('div.lg\\:hidden')).toBeTruthy();
    for (const drawing of drawings) {
      expect((drawing.getAttribute('aria-label') ?? '').length).toBeGreaterThan(200);
      const words = drawing.textContent ?? '';
      for (const part of ['Chief of Staff', 'Your yes', 'Desks', 'Memory', 'Keys', 'Code and checks', 'jobs', 'proposals']) expect(words, part).toContain(part);
      // Note #1013: auto-merge is part of the drawing, and the old promise is gone.
      expect(words).toContain('auto-merge');
      expect(words).toMatch(/told either way/);
      expect(words).not.toMatch(/nothing goes live/);
      for (const name of ['Ruby', 'Milo', 'Otis', 'Ada']) expect(words, name).toContain(name);
      // Only agents on the floor (the owner, 31 Oct): the one person drawn is you.
      expect(words).not.toMatch(/Lena|James|Priya/);
      expect(words).not.toMatch(/\d/);
      // Rooms left the product (note #843): one open floor, no rooms on it.
      expect(words).not.toMatch(/\broom|Product|Growth/i);
      expect(drawing.getAttribute('aria-label')).not.toMatch(/\broom/i);
      // Note #924: the plan's one door is the way in; Memory, Keys and Code
      // and checks are shelves along the wall, with no door to read as a
      // room. Both lines are dashed and drawn as they are, never animated in.
      const arcs = [...drawing.querySelectorAll('path')].filter((path) => /A/.test(path.getAttribute('d') ?? ''));
      expect(arcs).toHaveLength(1);
      const jobs = [...drawing.querySelectorAll('path.stroke-accent')].filter((path) => !path.getAttribute('transform'));
      expect(jobs.length).toBeGreaterThan(1);
      for (const line of jobs) expect(line.getAttribute('stroke-dasharray')).toBeTruthy();
      expect(drawing.querySelector('[class*="workplace-art-"]')).toBeNull();
    }
  });

  // Note #1025 (the owner, 6 Nov 2026): one version for every screen. The
  // phone's own heading and its two doors (note #832, "Send me the line" and
  // "Write to the founder") are gone; the line and Copy are for everyone.
  it('gives a phone the same line and Copy as a desk', () => {
    answer();
    draw();
    const action = document.querySelector('#give-your-agent')!;
    expect(document.querySelector('#on-a-phone')).toBeNull();
    expect(action.querySelector('.hidden:not([data-copy-tag]), [class*="sm:hidden"]')).toBeNull();
    expect(action.querySelector('h3')!.textContent).toBe('Give this to your agent');
    expect(action.querySelector('code')!.textContent).toBe('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(action.querySelector('button')!.getAttribute('aria-label')).toBe('Copy');
    expect(action.querySelectorAll('a')).toHaveLength(0);
    // Note #1097: the sentence breaks only between its groups, the address
    // stays whole and may break once, after the host's slash, never in a word.
    const code = action.querySelector('code')!;
    expect([...code.querySelectorAll('.whitespace-nowrap')].map((group) => group.textContent)).toEqual(['Set up our own', 'Agentic Cloud', 'by following', 'own-cloud.md']);
    const address = code.querySelector('.inline-block')!;
    expect(address.textContent).toBe('https://agenticcloudcomputer.com/own-cloud.md');
    expect(address.querySelectorAll('wbr')).toHaveLength(1);
    expect(address.querySelector('wbr')!.previousSibling!.textContent).toMatch(/\/$/);
    const start = document.querySelector('#start')!.textContent ?? '';
    expect(start).not.toMatch(/Send me the line|Write to the founder|sets it up from a laptop/);
  });

  // claims-we-never-make, for the new words: no agent counts, no "approves
  // each other's changes", "free" only for the first month.
  it('makes none of the claims we never make on its screens', () => {
    answer();
    draw();
    const words = [...document.querySelectorAll('main > section')].map((section) => section.textContent ?? '').join(' ');
    expect(words).not.toMatch(/\b(twenty|hundred|unlimited|\d+ agents)\b/i);
    expect(words).not.toMatch(/each other.s (changes|work)|approve each other/i);
    expect(words).not.toMatch(/most secure|never forgets/i);
  });

  // Note #791 (the owner, 2026-10-25): the apps people built here are off
  // the front door, and so are the header's Apps and Leaderboard links. The
  // page shows the founder's own system. Note #794 (the owner, the same
  // evening): sign-up is back, so the header's second door is Sign up again
  // and nothing on the page asks for access. Note #822 (the owner,
  // 2026-10-28): only the private copy is offered, so the header's second
  // door was Build yours (Get a copy until the offer was named), and nothing
  // leads to sign-up. Note #924 (the owner, 31 Oct 2026) took both doors off.
  it('shows no catalogue, no header, and sends nobody to sign up', () => {
    answer();
    draw();
    expect(document.querySelector('#home-apps')).toBeNull();
    expect(document.querySelector('#homeApps')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).some((url) => url.endsWith('/apps'))).toBe(false);
    expect(screen.queryAllByRole('link', { name: /See all/ })).toEqual([]);
    // Since note #924 the header was the mark and the name alone; since
    // note #977 (the owner: "Remove header") there is none: the film is the
    // first thing, and the footer carries the name.
    expect(document.querySelector('header')).toBeNull();
    expect(document.querySelector('main > section')?.id).toBe(PRODUCT_FILM ? 'film' : 'workplace');
    expect(document.querySelector('footer')!.textContent).toMatch(/Agentic Cloud Computer/);
    expect(screen.queryAllByRole('link', { name: /Sign up/ })).toEqual([]);
    expect(document.querySelector('a[href="/signup"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bour cloud|on us\b|at no charge|thirty live sites/i);
    expect(screen.queryAllByRole('link', { name: /Request access/ })).toEqual([]);
    expect(document.querySelector('#home-request')).toBeNull();
    expect(document.body.textContent).not.toMatch(/by request|request access|not open for sign-up|registration is closed/i);
    expect(document.body.textContent).not.toMatch(/for everyone|anyone can sign up/i);
  });

  // Since note #835 the founder's live week is off the page, so it reads
  // nothing live: the prerendered page is the whole page. Since note #1010
  // the one exception is the guide's status, read once for its face and name
  // (the screen is whole without it).
  it('reads nothing live but the guest agent’s status', () => {
    answer();
    draw();
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual(['/workspace/api/public/guest']);
    expect(document.querySelector('[role="status"][aria-label="Loading"]')).toBeNull();
  });
});

// The home film (HomeFilm.tsx). Note #965: it opens the page, above the
// headline, and starts by itself, muted, inline and looping; a visitor who
// asks for reduced motion, or whose browser refuses, gets the poster and our
// play button. Note #970: never the browser's controls. Note #971: a click,
// tap, Space or Enter pauses and resumes it, with a mark that goes. Note #973
// (the owner, 4 Nov 2026, 07:48 UTC: "Can we make vertical version of the
// video? For phones"): a phone (TALL_FILM_QUERY) gets the tall cut in a tall
// frame, a desk the wide one, and only one film is ever asked for.
describe('Home, the film first and playing by itself (notes #965, #970, #971, #973)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function screenIs({ still = false, phone = false }: { still?: boolean; phone?: boolean }) {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: (still && query.includes('prefers-reduced-motion: reduce')) || (phone && query === TALL_FILM_QUERY),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })));
  }

  async function settle() {
    await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });
  }

  it('opens the page above the headline, plays the wide film on a desk, with one link to the site and no controls', async () => {
    answer();
    screenIs({});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    const film = document.querySelector('#film')!;
    expect(document.querySelector('main section')).toBe(film);
    // The first screen; the page's h1 (not drawn, note #984) precedes it.
    expect(film.nextElementSibling?.id).toBe('value');
    expect(film.previousElementSibling?.tagName).toBe('H1');
    // No heading, paragraph or caption around it; one link, to the site.
    expect(film.querySelectorAll('h1, h2, h3, p, figcaption')).toHaveLength(0);
    expect(screen.queryByText('Watch it work, start to finish.')).toBeNull();
    const links = [...film.querySelectorAll('a')].map((a) => [a.getAttribute('href'), (a.textContent ?? '').trim()]);
    expect(links).toEqual(BOOKFACE_URL ? [[BOOKFACE_URL, `${BOOKFACE_LINK} (opens in a new tab)`]] : []);
    if (BOOKFACE_URL) {
      // Note #981 (the owner, 4 Nov 2026, 13:58 UTC: "Open the site they
      // built should have different design and open in new tab"): a new tab,
      // said to a screen reader, with an outward arrow; an outlined pill at
      // least 44 px tall, not the page's underlined text link and not a
      // filled button.
      const site = film.querySelector<HTMLAnchorElement>('#film-site a')!;
      expect(site.target).toBe('_blank');
      expect(site.rel).toBe('noopener noreferrer');
      expect(site.querySelector('.sr-only')?.textContent).toBe(' (opens in a new tab)');
      expect(site.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
      expect(site.className).toMatch(/\brounded-full\b/);
      expect(site.className).toMatch(/\bborder\b/);
      expect(site.className).toMatch(/\bmin-h-11\b/);
      expect(site.className).not.toMatch(/(^|\s)bg-white\b|\bborder-b\b/);
      expect(site.closest('[data-film-box]')).toBeTruthy();
    }
    const video = film.querySelector('video')!;
    // Started from code, never by the attribute, so reduced motion holds.
    expect(video.autoplay).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.playsInline ?? video.hasAttribute('playsinline')).toBeTruthy();
    // One film: the wide one, and no other source in the markup.
    expect(video.getAttribute('src')).toBe(filmUrl(PRODUCT_FILM_PATH));
    expect(video.querySelectorAll('source')).toHaveLength(0);
    expect(filmUrl('films/x.mp4')).toMatch(/^https:\/\/[^/]+\/films\/x\.mp4$/);
    // No poster since note #998: until its first frame the frame is a plain
    // fill in the film's own background colour, in both shapes, and no
    // picture lies over the film.
    expect(film.querySelector('picture, img')).toBeNull();
    const frame = film.querySelector('[data-film-frame]') as HTMLElement;
    expect(frame.style.getPropertyValue('--film-bg')).toBe(FILM_BACKGROUND);
    expect(frame.className).toMatch(/\bbg-\[var\(--film-bg\)\]/);
    if (PRODUCT_FILM_TALL) {
      expect(frame.style.getPropertyValue('--film-bg-tall')).toBe(FILM_BACKGROUND);
      expect(frame.className).toMatch(/\bmax-sm:bg-\[var\(--film-bg-tall\)\]/);
    }
    // Never the browser's controls (note #970).
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(video.hasAttribute('disableremoteplayback')).toBe(true);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    video.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /^Play the film of Bookface 2006/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Pause the film of Bookface 2006/ })).toBeTruthy();
  });

  it('plays the tall film in a tall frame on a phone, and only that one', async () => {
    answer();
    screenIs({ phone: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    draw();
    await settle();
    if (!PRODUCT_FILM || !PRODUCT_FILM_TALL) return;
    const video = document.querySelector('#film video')!;
    expect(video.getAttribute('src')).toBe(filmUrl(PRODUCT_FILM_TALL_PATH));
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('controls')).toBe(false);
    // The frame is the film's own shape: tall under sm, wide from sm up,
    // and never taller than leaves the headline's first line in view.
    const frame = document.querySelector('#film [data-film-frame]')!;
    expect(frame.className).toMatch(/\baspect-\[4\/5\]/);
    expect(frame.className).toMatch(/\bsm:aspect-video\b/);
    // Edge to edge since note #977: the phone's whole width, no cap.
    expect(frame.className).not.toMatch(/max-w-/);
    // The timeline follows the tall film's own section starts.
    expect([...document.querySelectorAll('[data-film-section]')].map((b) => b.querySelector('.sm\\:hidden')?.textContent)).toEqual([...FILM_SECTION_SHORT_NAMES]);
    // and the names share the phone's row equally, one column per name.
    const names = document.querySelector('#film [data-film-timeline] ol') as HTMLElement;
    expect(names.style.getPropertyValue('--film-names')).toBe(`repeat(${FILM_SECTION_SHORT_NAMES.length}, minmax(0, 1fr))`);
  });

  it('holds still on its plain placeholder for reduced motion, and our play button starts it without controls', async () => {
    answer();
    screenIs({ still: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    expect(play).not.toHaveBeenCalled();
    const video = document.querySelector('#film video')!;
    expect(video.hasAttribute('controls')).toBe(false);
    expect(document.querySelector('#film picture, #film img')).toBeNull();
    const button = screen.getByRole('button', { name: /^Play the film of Bookface 2006, built by two people’s agents/ });
    button.focus();
    fireEvent.click(button);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('controls')).toBe(false);
    expect(screen.queryByRole('button', { name: /^Play the film of Bookface 2006/ })).toBeNull();
    // A keyboard that pressed our button lands on the film's own button.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Pause the film of Bookface 2006/ }));
  });

  it('pauses on a tap and resumes on the next, with no controls and no mark left behind', async () => {
    answer();
    screenIs({});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    let paused = false;
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused);
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    const video = document.querySelector('#film video')!;
    const toggle = screen.getByRole('button', { name: /^Pause the film of Bookface 2006, built by two people’s agents/ });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.className).toMatch(/\binset-0\b/);
    expect(toggle.className).toMatch(/focus-visible:outline/);
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      expect(pause).toHaveBeenCalledTimes(1);
      paused = true;
      expect(toggle.getAttribute('aria-label')).toMatch(/^Play the film of Bookface 2006/);
      expect(toggle.querySelector('[data-film-mark="pause"]')).toBeTruthy();
      expect(video.hasAttribute('controls')).toBe(false);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(toggle.querySelector('[data-film-mark]')).toBeNull();
      fireEvent.click(toggle);
      expect(play).toHaveBeenCalledTimes(2);
      paused = false;
      expect(toggle.getAttribute('aria-label')).toMatch(/^Pause the film of Bookface 2006/);
      expect(toggle.querySelector('[data-film-mark="play"]')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(toggle.querySelector('[data-film-mark]')).toBeNull();
      expect(video.hasAttribute('controls')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Note #977 (the owner, 4 Nov 2026, 12:43 UTC: "below the video player,
  // let's implement switcher to different sections of the video. Timeline").
  it('names the film’s sections under it, fills the played part and jumps on a click', async () => {
    answer();
    screenIs({});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => 4);
    let paused = false;
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused);
    draw();
    await settle();
    if (!PRODUCT_FILM?.sections) return;
    const timeline = document.querySelector('#film [data-film-timeline]')!;
    expect(timeline.getAttribute('role')).toBe('group');
    expect(timeline.getAttribute('aria-label')).toBe('Sections of the film');
    // One button per act (three since note #996), in order, named by the
    // owner; the first is the current one.
    const names = [...timeline.querySelectorAll<HTMLButtonElement>('[data-film-section]')];
    expect(names.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(names.map((b) => b.querySelector('.hidden')?.textContent)).toEqual([...FILM_SECTION_NAMES]);
    expect(names.map((b) => b.getAttribute('aria-current'))).toEqual(['step', null, null]);
    // The bar: one segment per section, proportional to its length, hidden
    // from a screen reader (the names are its buttons) and out of the tab order.
    const bar = timeline.querySelector('[aria-hidden="true"]') as HTMLElement;
    const starts = PRODUCT_FILM.sections.map((section) => section.at);
    const ends = [...starts.slice(1), PRODUCT_FILM.length!];
    expect(bar.style.gridTemplateColumns).toBe(starts.map((at, i) => `${ends[i]! - at}fr`).join(' '));
    expect([...bar.querySelectorAll('button')].every((b) => b.tabIndex === -1)).toBe(true);
    // A click on a name jumps to that section's first frame and plays on.
    const video = document.querySelector('#film video')!;
    paused = true;
    play.mockClear();
    fireEvent.click(names[1]!);
    expect(video.currentTime).toBe(starts[1]);
    expect(play).toHaveBeenCalledTimes(1);
    paused = false;
    // The played part fills and the current section moves with the film.
    fireEvent(video, new Event('seeked'));
    await settle();
    expect(names.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(bar.querySelectorAll('[data-film-played]')[0]!.getAttribute('data-film-played')).toBe('1.00');
    expect(bar.querySelectorAll('[data-film-played]')[2]!.getAttribute('data-film-played')).toBe('0.00');
    // Still no browser controls.
    expect(video.hasAttribute('controls')).toBe(false);
  });

  it('lands a jump made before the film has loaded once its length is known', async () => {
    answer();
    screenIs({ still: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    draw();
    await settle();
    if (!PRODUCT_FILM?.sections) return;
    const video = document.querySelector('#film video')!;
    // Reduced motion: nothing has loaded (readyState 0); a click on a
    // section still starts it there.
    fireEvent.click(document.querySelectorAll('[data-film-section]')[2]!);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBe(PRODUCT_FILM.sections[2]!.at);
    expect(screen.getByRole('button', { name: /^Pause the film of Bookface 2006/ })).toBeTruthy();
  });

  it('runs every section edge to edge, with no column and no line caps', () => {
    answer();
    draw();
    for (const section of document.querySelectorAll('main > section')) {
      expect(section.className).not.toMatch(/\bmax-w-6xl\b|\bmx-auto\b/);
    }
    const capped = [...document.querySelectorAll('main h1, main h2, main p')].filter((node) => !node.closest('.ws-live, figure, svg') && /max-w-\[/.test(node.className));
    expect(capped).toEqual([]);
  });

  // Note #978 (the owner, 4 Nov 2026, 13:23 UTC: "Each section should take
  // the whole space horizontally and vertically. For extra large displays,
  // we should have max width and max height").
  it('makes every section one screen, its content under one width cap, the film sized to fit one screen', () => {
    answer();
    draw();
    const screens = [...document.querySelectorAll('main > section')];
    expect(screens.map((section) => section.id)).toEqual([
      ...(PRODUCT_FILM ? ['film'] : []), 'value', 'workplace', 'own-cloud', 'start', 'your-agent',
    ]);
    for (const section of screens) {
      expect(section.hasAttribute('data-screen'), section.id).toBe(true);
      expect(section.className, section.id).toMatch(/\bmin-h-\[100svh\]/);
      expect(section.className, section.id).toMatch(/\bjustify-center\b/);
      expect(section.className, section.id).not.toMatch(/(^|\s)(h-\[|max-h-|overflow-hidden|snap-)/);
      const content = section.querySelector(':scope > [data-screen-content]')!;
      expect(content.className, section.id).toMatch(/\bmx-auto\b.*\bmax-w-\[1280px\]/);
    }
    // A hairline between screens, none above the first.
    expect(screens.map((section) => /\bborder-t\b/.test(section.className))).toEqual(screens.map((_, i) => i > 0));
    expect(SCREEN_MAX_WIDTH).toBe(1280);
    expect(SCREEN_MAX_HEIGHT).toBe(900);
    if (!PRODUCT_FILM) return;
    // The film, its timeline and its link in one screen: as wide as the
    // screen allows, unless that is taller than min(screen, 900 px) leaves.
    const box = document.querySelector('#film [data-film-box]')!;
    // Since note #1003 the room left also holds the masthead above the
    // film (211 px on a phone, 300 px from sm up), which takes the same width.
    expect(box.className).toMatch(/w-\[min\(100%,calc\(\(100svh_-_211px\)\*4\/5\)\)\]/);
    expect(box.className).toMatch(/sm:w-\[min\(100%,calc\(\(min\(100svh,900px\)_-_300px\)\*16\/9\)\)\]/);
    const masthead = document.querySelector('#film [data-masthead]')!;
    for (const width of box.className.split(' ').filter((c) => c.includes('w-[min('))) expect(masthead.className.split(' ')).toContain(width);
    expect(box.querySelector('[data-film-timeline]')).toBeTruthy();
    expect(box.querySelector('#film-site a')).toBeTruthy();
  });

  // Note #1088 (Adam, 9 Nov 2026, 08:50 UTC): one column for the whole page,
  // the film's own width. The film, the masthead, every screen below it and
  // the footer read the one rule (HOME_COLUMN), never a number; the
  // workplace drawing is placed by the same rule, its building's walls on
  // the column and "You" outside them to the left. The real edges are
  // measured in a browser (simulations/onboarding.mjs).
  it('puts the film, every screen below it and the footer on one column', () => {
    answer();
    draw();
    expect(HOME_COLUMN).toBe('sm:w-[min(100%,calc((min(100svh,900px)_-_300px)*16/9))]');
    const onColumn = (node: Element) => node.className.split(/\s+/).includes(HOME_COLUMN);
    expect(onColumn(document.querySelector('#film [data-film-box]')!)).toBe(true);
    expect(onColumn(document.querySelector('#film [data-masthead]')!)).toBe(true);
    for (const section of document.querySelectorAll('main > section')) {
      const content = section.querySelector(':scope > [data-screen-content]')!;
      // The workplace screen places its drawing by the column instead.
      expect(onColumn(content), section.id).toBe(section.id !== 'workplace');
    }
    // jsdom drops the drawing's max()/min() placement, so its edges are
    // measured in a real browser (simulations/onboarding.mjs).
    expect(document.querySelector('#workplace [data-plan-wide]')).toBeTruthy();
    expect([...document.querySelectorAll('footer div')].some(onColumn)).toBe(true);
  });

  // Note #1096 (Adam, 9 Nov 2026, 14:53 UTC): the own-cloud drawing larger,
  // its type larger and its dashed line's label short. The wide plan's cards
  // carry 17-unit titles (14 before), and the label is the phone's own
  // words; the screen-reader sentence keeps the whole of it.
  it('draws the own cloud at reading size, with the short label on the line to us', () => {
    answer();
    draw();
    const wide = [...document.querySelectorAll('#your-side svg')][0]!;
    const words = [...wide.querySelectorAll('text')].map((text) => text.textContent);
    expect(words).toContain('Daily counts, and diagnostics if your admin sends them');
    expect(words.join(' ')).not.toMatch(/which your admin sees|only if your admin sends it/);
    const title = [...wide.querySelectorAll('text')].find((text) => text.textContent === 'Workspace')!;
    expect(Number(title.getAttribute('font-size'))).toBe(17);
    expect(wide.getAttribute('aria-label')).toMatch(/daily report of counts goes out, which your admin sees and can turn off, and a diagnostics bundle only if your admin sends it/);
  });

  it('shows the poster and play button when the browser refuses to start it', async () => {
    answer();
    screenIs({ phone: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new DOMException('refused', 'NotAllowedError')));
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    expect(document.querySelector('#film video')!.hasAttribute('controls')).toBe(false);
    expect(document.querySelector('#film picture, #film img')).toBeNull();
    expect(screen.getByRole('button', { name: /^Play the film of Bookface 2006/ })).toBeTruthy();
  });
});
