import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import Home, { BOOKFACE_LINK, BOOKFACE_URL, FILM_SECTION_NAMES, FILM_SECTION_SHORT_NAMES, HOME_HEADLINE, PRODUCT_FILM, PRODUCT_FILM_TALL } from './Home';
import { filmUrl, PRODUCT_FILM_PATH, PRODUCT_FILM_TALL_PATH } from '../lib/films';
import { TALL_FILM_QUERY } from '../components/HomeFilm';
import { SCREEN_MAX_HEIGHT, SCREEN_MAX_WIDTH } from '../components/landing-kit';
import { OWN_CLOUD_HEADING } from './PrivateCopy';

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
  it('runs five screens: the film, the workplace, the own cloud, how to build yours, the footer', () => {
    answer();
    draw();
    const headings = [...document.querySelectorAll('main h1, main section h2')]
      .filter((node) => !node.closest('.ws-live'))
      .map((node) => node.textContent);
    expect(headings).toEqual([
      HOME_HEADLINE,
      OWN_CLOUD_HEADING,
      'Build your own Agentic Cloud.',
    ]);
    // Since note #984 (the owner, 4 Nov 2026, 14:07 UTC) the page is five
    // screens: the film, the workplace drawing, the own cloud, how to build
    // yours, the footer. The headline is the page's one h1, not drawn.
    expect(document.querySelector('main h1')!.className).toMatch(/\bsr-only\b/);
    for (const id of ['#home-top', '#team', '#memory', '#keys', '#computers', '#work', '#for-your-team', '#contact']) expect(document.querySelector(id), id).toBeNull();
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    for (const gone of ['#proof', '#homeFounder', '#home-context', '#built-in', '#subscriptions', '#apps', '#home-close']) expect(document.querySelector(gone), gone).toBeNull();
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
    expect(plan.previousElementSibling?.id).toBe(PRODUCT_FILM ? 'film' : undefined);
    expect(plan.nextElementSibling?.id).toBe('own-cloud');
    expect(plan.querySelectorAll('h1, h2, h3, p')).toHaveLength(0);
    expect(plan.querySelectorAll('img')).toHaveLength(0);
    const drawings = [...plan.querySelectorAll('svg[role="img"]')];
    expect(drawings).toHaveLength(2);
    expect(drawings[0]!.closest('div')!.className).toMatch(/\bhidden\b.*\blg:block\b/);
    expect(drawings[1]!.closest('div')!.className).toMatch(/\blg:hidden\b/);
    for (const drawing of drawings) {
      expect((drawing.getAttribute('aria-label') ?? '').length).toBeGreaterThan(200);
      const words = drawing.textContent ?? '';
      for (const part of ['Chief of Staff', 'Your yes', 'Desks', 'Memory', 'Keys', 'Code and checks', 'jobs', 'proposals']) expect(words, part).toContain(part);
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

  // Note #832: a cold email is read on a phone, where the line cannot run.
  it('gives a phone two doors: the line by mail to yourself, and the founder', () => {
    answer();
    draw();
    const phone = document.querySelector('#on-a-phone')!;
    expect(phone.className).toMatch(/\bsm:hidden\b/);
    expect(document.querySelector('#give-your-agent > .hidden.sm\\:block code')).toBeTruthy();
    const [line, founderDoor] = [...phone.querySelectorAll('a')];
    expect(line!.textContent).toMatch(/^Send me the line/);
    const mail = new URL(line!.getAttribute('href')!);
    expect(mail.protocol).toBe('mailto:');
    expect(mail.pathname).toBe('');
    expect(decodeURIComponent(mail.search)).toContain('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(founderDoor!.textContent).toMatch(/^Write to the founder/);
    expect(founderDoor!.getAttribute('href')).toMatch(/^mailto:adam@agenticcloudcomputer\.com\?/);
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
  // nothing live: the prerendered page is the whole page.
  it('reads nothing live', () => {
    answer();
    draw();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
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
    expect(film.nextElementSibling?.id).toBe('workplace');
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
    // The poster comes with the site, one picture whose source the browser
    // picks by the same query, so it fetches one poster.
    const poster = film.querySelector('picture')!;
    expect(poster.querySelector('img')!.getAttribute('src')).toBe(PRODUCT_FILM.poster);
    expect(PRODUCT_FILM.poster).not.toMatch(/^https?:/);
    if (PRODUCT_FILM_TALL) {
      const tall = poster.querySelector('source')!;
      expect(tall.getAttribute('media')).toBe(TALL_FILM_QUERY);
      expect(tall.getAttribute('srcset')).toBe(PRODUCT_FILM_TALL.poster);
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
    expect(frame.className).toMatch(/\baspect-\[9\/16\]/);
    expect(frame.className).toMatch(/\bsm:aspect-video\b/);
    // Edge to edge since note #977: the phone's whole width, no cap.
    expect(frame.className).not.toMatch(/max-w-/);
    // The timeline follows the tall film's own section starts.
    expect([...document.querySelectorAll('[data-film-section]')].map((b) => b.querySelector('.sm\\:hidden')?.textContent)).toEqual([...FILM_SECTION_SHORT_NAMES]);
    // and the names share the phone's row equally, one column per name.
    const names = document.querySelector('#film [data-film-timeline] ol') as HTMLElement;
    expect(names.style.getPropertyValue('--film-names')).toBe(`repeat(${FILM_SECTION_SHORT_NAMES.length}, minmax(0, 1fr))`);
  });

  it('holds still on its poster for reduced motion, and our play button starts it without controls', async () => {
    answer();
    screenIs({ still: true });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    expect(play).not.toHaveBeenCalled();
    const video = document.querySelector('#film video')!;
    expect(video.hasAttribute('controls')).toBe(false);
    expect(document.querySelector('#film picture img')).toBeTruthy();
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
    // One button per act (four since note #988), in order, named from the
    // film's captions; the first is the current one.
    const names = [...timeline.querySelectorAll<HTMLButtonElement>('[data-film-section]')];
    expect(names.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON']);
    expect(names.map((b) => b.querySelector('.hidden')?.textContent)).toEqual([...FILM_SECTION_NAMES]);
    expect(names.map((b) => b.getAttribute('aria-current'))).toEqual(['step', null, null, null]);
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
    fireEvent.click(names[2]!);
    expect(video.currentTime).toBe(starts[2]);
    expect(play).toHaveBeenCalledTimes(1);
    paused = false;
    // The played part fills and the current section moves with the film.
    fireEvent(video, new Event('seeked'));
    await settle();
    expect(names.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(bar.querySelectorAll('[data-film-played]')[0]!.getAttribute('data-film-played')).toBe('1.00');
    expect(bar.querySelectorAll('[data-film-played]')[3]!.getAttribute('data-film-played')).toBe('0.00');
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
      ...(PRODUCT_FILM ? ['film'] : []), 'workplace', 'own-cloud', 'start',
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
    expect(box.className).toMatch(/w-\[min\(100%,calc\(\(100svh_-_175px\)\*9\/16\)\)\]/);
    expect(box.className).toMatch(/sm:w-\[min\(100%,calc\(\(min\(100svh,900px\)_-_260px\)\*16\/9\)\)\]/);
    expect(box.querySelector('[data-film-timeline]')).toBeTruthy();
    expect(box.querySelector('#film-site a')).toBeTruthy();
  });

  it('shows the poster and play button when the browser refuses to start it', async () => {
    answer();
    screenIs({ phone: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new DOMException('refused', 'NotAllowedError')));
    draw();
    await settle();
    if (!PRODUCT_FILM) return;
    expect(document.querySelector('#film video')!.hasAttribute('controls')).toBe(false);
    expect(document.querySelector('#film picture img')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Play the film of Bookface 2006/ })).toBeTruthy();
  });
});
