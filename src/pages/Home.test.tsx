import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home, { HOME_HEADLINE, TEAM_HEADING } from './Home';
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
  it('runs the problem in five faces, then the own cloud, how to start, for your team, close', () => {
    answer();
    draw();
    const headings = [...document.querySelectorAll('main h1, main section h2')]
      .filter((node) => !node.closest('.ws-live'))
      .map((node) => node.textContent);
    expect(headings).toEqual([
      HOME_HEADLINE,
      'Here’s the workplace.',
      TEAM_HEADING,
      'No session starts from zero.',
      'Add a key once. Every agent can use it.',
      'A desk for every agent.',
      'Hand out work from one chat.',
      OWN_CLOUD_HEADING,
      'How to start.',
      'For your team.',
      'Talk to us.',
    ]);
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    for (const gone of ['#proof', '#homeFounder', '#home-context', '#built-in', '#subscriptions', '#apps', '#home-close']) expect(document.querySelector(gone), gone).toBeNull();
  });

  // One paragraph per face, the problem named before the answer
  // (landing-copy-rules), beside the product's own panel.
  it('answers each face with one paragraph and the product’s own panel', () => {
    answer();
    draw();
    const faces = ['#team', '#memory', '#keys', '#computers', '#work'].map((id) => document.querySelector(id)!);
    for (const face of faces) expect(face.querySelectorAll('[data-face-words] > p').length, face.id).toBe(1);
    const paragraph = (id: string) => (document.querySelector(`${id} [data-face-words] > p`)!.textContent ?? '').replace(/\s+/g, ' ');
    // Note #839: the rhythm varies, the panel on the left every other
    // section. Since note #924 the chat sits beside its words too, as the
    // other four panels do, instead of wide under them.
    expect(['#team', '#memory', '#keys', '#computers', '#work'].map((id) => document.querySelector(`${id} [data-face-words]`)!.className.includes('lg:order-2'))).toEqual([false, true, false, true, false]);
    for (const id of ['#team', '#memory', '#keys', '#computers', '#work']) {
      const grid = document.querySelector(`${id} [data-face-words]`)!.parentElement!;
      expect(grid.className, id).toMatch(/lg:grid-cols-/);
      expect(grid.querySelector('.ws-live'), id).toBeTruthy();
    }
    expect(paragraph('#team')).toMatch(/^One Claude Code per engineer is a dozen private silos/);
    expect(paragraph('#team')).toMatch(/Never the chat behind it\.$/);
    expect(paragraph('#memory')).toMatch(/knowledge pages and read them before every job/);
    expect(paragraph('#keys')).toMatch(/nobody pastes it anywhere\.$/);
    // Note #924: a sentence the plan's caption or the heading already says
    // came out of three of them; no claim did.
    expect(paragraph('#memory')).not.toMatch(/starts where the last one stopped/);
    expect(paragraph('#work')).toMatch(/get back only what needs your yes\. You give it from your phone\.$/);
    // The workplace, not the laptop (the owner, 29 Oct, 18:59 UTC).
    expect(paragraph('#computers')).toMatch(/^A new engineer gets a desk on day one\. Your agent gets a terminal tab\./);
    expect(paragraph('#computers')).toMatch(/already set up with git, CI and hosting\. Nothing depends on your laptop\.$/);
    expect(paragraph('#computers')).not.toMatch(/sleeps|close the laptop|beyond the laptop/i);
    expect(paragraph('#work')).toMatch(/Chief of Staff/);
    // The panels: the Workspace's own screens, the People page's cards first.
    for (const id of ['#team', '#memory', '#keys', '#computers', '#work']) expect(document.querySelector(`${id} .ws-live`), id).toBeTruthy();
    // Note #840 (the owner, 30 Oct, 13:30 UTC): two teammates, neither "You"
    // nor an admin, each with a presence line and a latest action, both in
    // initials; not Priya Shah.
    const cards = [...document.querySelectorAll('#team .personplate')];
    expect(cards.map((card) => card.querySelector('.personname .name')?.textContent)).toEqual(['Lena Fischer', 'James Okafor']);
    expect(cards.map((card) => card.querySelector('.personhead .initials')?.textContent)).toEqual(['LF', 'JO']);
    expect(document.querySelector('#team .badge')).toBeNull();
    expect(cards.map((card) => card.querySelector('.personstate')?.textContent)).toEqual(['Here now', 'Active 6m ago']);
    expect(cards.map((card) => (card.querySelector('.personlatest')?.textContent ?? '').replace(/\u00a0/g, ' '))).toEqual([
      'Handed Ruby the batch route optimiser · 40m ago',
      'Approved Ruby’s proposal: route optimiser, first cut · 6m ago',
    ]);
    expect(document.querySelector('#team')!.textContent).not.toMatch(/Priya|Admin/);
    // Note #926 (the owner, 31 Oct 2026: contribution is "a hook"): the
    // heading leads with people and what their agents shipped, the paragraph
    // says only what the product's This week block shows (note #925), and
    // each card carries that block, with figures that differ.
    expect(TEAM_HEADING).toBe('See what everyone’s agents shipped. Live.');
    expect(paragraph('#team')).toMatch(/each person’s agents sit under their name/);
    expect(paragraph('#team')).toMatch(/agent hours, changes merged, tokens written and the latest change\. Live, for every member of the workplace, not only the lead\./);
    const weeks = cards.map((card) => card.querySelector('.pcontrib')!);
    expect(weeks.map((week) => week.querySelector('.pchead')?.textContent)).toEqual(['This week', 'This week']);
    // One grammar since note #928: every figure a cell, tokens one per provider.
    expect(weeks.map((week) => [...week.querySelectorAll('.pcstats > div')].map((stat) => (stat.textContent ?? '').replace(/\u00a0/g, ' ')))).toEqual([
      ['34hagent hours', '11changes merged', '2.1Mtokens · Claude Code'],
      ['19hagent hours', '6changes merged', '860Ktokens · Codex'],
    ]);
    expect(weeks.map((week) => (week.querySelector('.pclatest .pctitle')?.textContent))).toEqual(['Route optimiser, first cut', 'Retries for dropped pings']);
    // The block sits between the latest line and the agents, as in the product.
    for (const card of cards) expect(card.querySelector('.pcontrib + .cagents, .pcontrib ~ .cagents'), 'agents under the week').toBeTruthy();
    expect(document.querySelector('#computers #agentFacts')).toBeTruthy();
    expect(document.querySelector('#computers #agentInfoCard')).toBeNull();
  });

  // Note #841 (the owner, 30 Oct 2026, 13:31 UTC): one drawing of the whole
  // workplace right after the first screen, before the five parts zoom in.
  // Drawn in code, wide on a desk and tall on a phone, each one picture with
  // one sentence for a screen reader, and only the page's own names on it.
  // Redrawn without rooms after they left the product (the owner, 31 Oct).
  it('shows the whole workplace as one floor plan before the five parts', () => {
    answer();
    draw();
    const plan = document.querySelector('#workplace')!;
    expect(plan.previousElementSibling?.id).toBe('home-top');
    expect(plan.nextElementSibling?.id).toBe('team');
    expect(plan.querySelectorAll('p')).toHaveLength(0);
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

  // The first screen is the product: the headline written from the owner's
  // phrase, one line naming the five faces, and since note #924 (the owner,
  // 31 Oct 2026: "Build yours" read as confusing) no button: one text link
  // to How to start, in a row of its own so the cards stay level with the
  // words.
  it('opens on the headline, one line, and a text link to How to start', () => {
    answer();
    draw();
    const top = document.querySelector('#home-top')!;
    const lines = [...top.querySelectorAll(':scope > div > p')].map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Your Claude Code and Codex agents get what every engineer gets on day one/);
    expect(lines[0]!.split(' ').length).toBeLessThan(40);
    expect([...top.querySelectorAll('a')].map((link) => [link.getAttribute('href'), (link.textContent ?? '').trim()])).toEqual([['#start', 'How to start']]);
    expect(top.querySelector('#home-door')!.className).toMatch(/\blg:col-start-1\b/);
    expect(top.querySelector('a')!.className).not.toMatch(/\bbg-white\b|\brounded-xl\b/);
    expect(document.querySelector('main a[href="/#give-your-agent"]')).toBeNull();
    // A picture on a desk (the Workspace's agent list), none on a phone.
    expect(top.querySelector('#home-fleet')!.className).toMatch(/\bhidden\b.*\blg:block\b/);
    expect(top.querySelector('#home-fleet .ws-live')).toBeTruthy();
    expect(top.querySelector('code')).toBeNull();
    expect(document.querySelector('#start #give-your-agent code')?.textContent).toBe('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(document.querySelector('#start #qualifier')?.textContent?.trim()).toBe('Runs in your own Fly account. Free for now.');
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
  it('makes none of the claims we never make in the five faces', () => {
    answer();
    draw();
    const faces = ['#home-top', '#workplace', '#team', '#memory', '#keys', '#computers', '#work']
      .map((id) => document.querySelector(id)!.textContent ?? '').join(' ');
    expect(faces).not.toMatch(/\b(twenty|hundred|unlimited|\d+ agents)\b/i);
    expect(faces).not.toMatch(/each other.s (changes|work)|approve each other/i);
    expect(faces).not.toMatch(/\bfree\b/i);
    expect(faces).not.toMatch(/most secure|never forgets/i);
  });

  it('closes on the founder’s own address', () => {
    answer();
    draw();
    const close = document.querySelector('#contact')!;
    expect(close.textContent).toMatch(/adam@agenticcloudcomputer\.com/);
    expect([...close.querySelectorAll('a')].every((link) => link.getAttribute('href')?.startsWith('mailto:adam@agenticcloudcomputer.com'))).toBe(true);
  });

  // Note #791 (the owner, 2026-10-25): the apps people built here are off
  // the front door, and so are the header's Apps and Leaderboard links. The
  // page shows the founder's own system. Note #794 (the owner, the same
  // evening): sign-up is back, so the header's second door is Sign up again
  // and nothing on the page asks for access. Note #822 (the owner,
  // 2026-10-28): only the private copy is offered, so the header's second
  // door was Build yours (Get a copy until the offer was named), and nothing
  // leads to sign-up. Note #924 (the owner, 31 Oct 2026) took both doors off.
  it('shows no catalogue, no page links in the header, and sends nobody to sign up', () => {
    answer();
    draw();
    expect(document.querySelector('#home-apps')).toBeNull();
    expect(document.querySelector('#homeApps')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).some((url) => url.endsWith('/apps'))).toBe(false);
    expect(screen.queryAllByRole('link', { name: /See all/ })).toEqual([]);
    // Since note #924 the header is the mark and the name: no Sign in, no
    // Build yours.
    const header = document.querySelector('header')!;
    expect([...header.querySelectorAll('a')].map((link) => [link.getAttribute('href'), (link.textContent ?? '').trim()]))
      .toEqual([['/', 'Agentic Cloud Computer']]);
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
