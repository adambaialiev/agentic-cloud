import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import FourPhases from './FourPhases';

// The moving row is built from the Workspace's own row components, which
// navigate on tap and so need a router above them — as they have on the site.
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const ROOT = path.resolve(__dirname, '..', '..');

describe('FourPhases', () => {
  // Note #172 (the owner, 2026-10-04): AI at work has come in four phases,
  // and the product is the fourth. The section stood on the front page until
  // note #199 (2026-10-09) moved it here whole; only the fourth phase is
  // marked current, carries the product's name and shows the team's faces.
  // Since note #206 the team is one person's agents: inviting is switched
  // off, a workplace is one person's, and the page draws no teammate.
  it('opens on the four phases, the front page\'s section moved whole', () => {
    render(<FourPhases />);

    const phases = document.querySelector('#phases')!;
    expect(document.querySelector('main > section')).toBe(phases);
    expect(screen.getByRole('heading', { level: 1, name: 'AI at work has four phases. Start in the fourth.' })).toBeTruthy();
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    expect(phases.textContent).toMatch(/The first three made one person faster\. The fourth gives that person a team\./);
    const steps = [...phases.querySelectorAll('ol > li')];
    expect(steps.map((step) => step.querySelector('h3')?.textContent)).toEqual([
      'Chat',
      'Connected chat',
      'Agents with a computer',
      'A team of agents working with you',
    ]);
    expect([...phases.querySelectorAll('[aria-current="step"]')]).toEqual([steps[3]]);
    const labels = steps.map((step) => step.querySelector('h3')!.previousElementSibling?.textContent);
    expect(labels).toEqual(['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4 · Agentic Cloud Computer']);
    // A drawing over every phase (the owner asked for more visuals), hidden
    // from assistive technology because the words under it say the same.
    // Only the fourth has a team in it: one person and James's eighteen
    // agents, one of them commenting on the note — no teammate.
    for (const step of steps) expect(step.querySelector('[aria-hidden="true"]')?.textContent?.length).toBeGreaterThan(10);
    expect(steps[3].textContent).toMatch(/1 person, 18 agents/);
    expect(steps[3].textContent).toMatch(/Driver app must work with no signal/);
    expect(steps[3].textContent).toMatch(/Otiscommented/);
    expect(document.body.textContent).not.toMatch(/\d+ people|Priya|Leo|Tom\b|team of people/);
  });

  // Note #199: "write some content there. extend". Each phase gets a chapter
  // of its own under the row, labelled as the row labels it, in the front
  // page's calm pitch voice: a heading that promises, one paragraph.
  it('tells each phase in a chapter of its own', () => {
    render(<FourPhases />);

    const chapters = [1, 2, 3, 4].map((phase) => document.querySelector(`#phase-${phase}`)!);
    expect(chapters.map((chapter) => chapter.querySelector('h2')?.textContent)).toEqual([
      'A faster start. The same finish.',
      'Better answers. Still yours to carry.',
      'The work gets done. One job at a time.',
      'One agent becomes a team.',
    ]);
    expect(chapters.map((chapter) => chapter.querySelector('h2')!.previousElementSibling?.textContent)).toEqual([
      'Phase 1 · Chat',
      'Phase 2 · Connected chat',
      'Phase 3 · Agents with a computer',
      'Phase 4 · Agentic Cloud Computer',
    ]);
    for (const chapter of chapters) {
      // One paragraph under each heading: the section's own prose, not the
      // live panel's caption.
      expect(chapter.querySelectorAll(':scope > p')).toHaveLength(2);
      expect(chapter.querySelector('.landing-chapter-divider')).toBeTruthy();
    }
    // The first three are other kinds of tool: words, no live panel. The
    // fourth is the product, running.
    for (const chapter of chapters.slice(0, 3)) expect(chapter.querySelector('.ws-live')).toBeNull();
    expect(chapters[3]!.querySelector('.ws-live')).toBeTruthy();
    expect(chapters[3]!.textContent).toMatch(/Agents prepare\. You decide\./);
  });

  // claims-we-never-make: phase two is other tools reading your files, and
  // nothing may read as a connection to anybody's Slack, Notion or Drive; no
  // tool is named for contrast; and the page promises nothing the product
  // does not do.
  it('names no tool for contrast and makes none of the retired claims', () => {
    render(<FourPhases />);

    const words = [...document.querySelectorAll('#phases, [id^="phase-"]')]
      .map((section) => [...section.querySelectorAll('h1, h2, h3, :scope > p, li > p')].map((node) => node.textContent).join(' '))
      .join(' ');
    expect(words).not.toMatch(/Slack|Notion|Gmail|Google Drive|Confluence|ChatGPT|Claude|Codex|Copilot|Cursor/);
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/never forgets|knows everything|learns automatically|no ceiling|unlimited|free forever|\bcoworkers?\b/i);
    expect(body).not.toMatch(/\$\s?\d|per seat per month/);
  });

  // Its doors were Start free and Sign up, to /signup; since note #822 (only
  // the private copy is offered) they are the copy's; the header's second
  // door was Build yours until note #924 took both of its doors off.
  it('opens on the private copy, and sends the reader home for the rest', () => {
    render(<FourPhases />);

    expect(screen.getAllByRole('link', { name: /Build your own Agentic Cloud/ }).map((link) => link.getAttribute('href'))).toEqual(['/#give-your-agent', '/#give-your-agent']);
    expect(screen.getByRole('link', { name: 'See the whole product' }).getAttribute('href')).toBe('/product');
    const door = document.querySelector('#door')!;
    expect(door.querySelector('h2')?.textContent).toBe('Step into the fourth phase.');
    expect(screen.queryAllByRole('link', { name: /Start free|Sign up/ })).toEqual([]);
    expect(document.querySelector('a[href="/signup"]')).toBeNull();
    // Its own Sign in, beside the door; the header's went with note #924.
    expect(screen.getAllByRole('link', { name: 'Sign in' }).map((link) => link.getAttribute('href'))).toEqual(['/login']);
    expect(document.querySelector('header a[href="/login"]')).toBeNull();
  });

  // Note #185 (the owner, 2026-10-08): one row of cards that never stops
  // moving — the person, his agents, and what passes between them: a
  // proposal, a knowledge proposal, a site, a note handed to an agent, one
  // agent writing to another. Every card is the app's own row component. It
  // was the front page's hero picture until note #199 moved it here, under
  // the fourth phase, which is what it shows.
  it('shows the fourth phase as the product itself: a moving row of the app\'s own cards', () => {
    render(<FourPhases />);

    const fourth = document.querySelector('#phase-4')!;
    const panel = fourth.querySelector('.landing-marquee .ws-live') as HTMLElement;
    expect(panel).toBeTruthy();
    // The only panel on the page, fenced and described like every other.
    expect([...document.querySelectorAll('.ws-live')]).toEqual([panel]);
    expect(panel.hasAttribute('inert')).toBe(true);
    const spoken = panel.previousElementSibling!;
    expect(spoken.className).toContain('sr-only');
    expect(spoken.textContent).toMatch(/^A moving row of the Workspace’s cards\./);
    expect(spoken.textContent).toMatch(/Ruby and Milo, both on Claude Code and mid-job/);
    expect(spoken.textContent).toMatch(/James handing Mia a note/);
    expect(spoken.textContent).not.toMatch(/admin|member/i);

    // Drawn three times, so the track can open on the middle copy, level
    // with the headline, and slide by exactly one copy with no seam.
    const copies = [...panel.querySelectorAll('.landing-marquee-copy')];
    expect(copies).toHaveLength(3);
    expect(copies[1]!.innerHTML).toBe(copies[0]!.innerHTML);
    expect(copies[2]!.innerHTML).toBe(copies[0]!.innerHTML);
    // And so nothing in it may carry an id: every copy would repeat it,
    // and the page's other panels draw the same screens (landing-live-panels,
    // "One id per page").
    expect(panel.querySelectorAll('[id]')).toHaveLength(0);

    // The one person, then the agents, with what passed between them.
    const row = copies[0]!;
    expect([...row.querySelectorAll(':scope > .landing-marquee-place')].map((place) => place.className.replace('landing-marquee-place ', ''))).toEqual([
      'is-person', 'is-agent', 'is-agent', 'is-message',
      'is-agent', 'is-agent', 'is-pair',
      'is-agent', 'is-pair', 'is-agent', 'is-agent', 'is-agent',
    ]);
    expect([...row.querySelectorAll('[data-person] .name')].map((name) => name.textContent)).toEqual(['James (you)']);
    // No role on the plate, as the app draws it while inviting is off.
    expect(row.querySelector('[data-person] .cruntime')?.textContent).toBe('18 agents');
    // He wears the faces of all eighteen: six, then the count.
    const worn = row.querySelector('[data-person="user_james"] .cfaces')!;
    expect(worn.getAttribute('aria-label')?.split(', ')).toHaveLength(18);
    expect(worn.querySelectorAll('img.face').length).toBe(6);
    expect(worn.querySelector('.more')?.textContent).toBe('+12');
    for (const face of row.querySelectorAll('[data-person] img.avatar')) {
      expect(face.getAttribute('src')).toMatch(/^\/agent-avatars\/[a-z]+\.svg$/);
    }
    const agents = [...row.querySelectorAll('.is-agent')];
    expect(agents.map((plate) => plate.querySelector('.agentidentity .name')?.textContent)).toEqual([
      'Ruby', 'Milo', 'Otis', 'Theo', 'Ada', 'Mia', 'Nora', 'Finn',
    ]);
    for (const face of row.querySelectorAll('.is-agent img.avatar')) {
      expect(face.getAttribute('src')).toMatch(/^\/agent-avatars\/[a-z]+\.jpg$/);
    }
    // Two of the eight are ready: a fleet with nobody idle is a picture of a
    // demo. Six are mid-job, and no two of their clocks agree.
    expect(agents.filter((plate) => /Ready/.test(plate.textContent ?? ''))).toHaveLength(2);
    const timers = [...row.querySelectorAll('.is-agent .crun')].map((timer) => timer.textContent);
    expect(timers).toHaveLength(6);
    expect(new Set(timers).size).toBe(6);
    expect(row.textContent).toMatch(/opus · high/);
    expect(row.textContent).toMatch(/gpt-5\.6-sol · medium/);
    expect(row.textContent).toMatch(/gpt-6-astra · high/);

    // What passes between them, each the row Home lists it as.
    const [decisions, made] = [...row.querySelectorAll('.is-pair')];
    expect(decisions!.textContent).toMatch(/Batch route optimiser for the routing service/);
    expect(decisions!.textContent).toMatch(/#41/);
    expect(decisions!.textContent).toMatch(/On-call for the pings pipeline/);
    expect(made!.textContent).toMatch(/dispatch/);
    expect(made!.textContent).toMatch(/Page on-call when a van stops pinging/);
    expect(made!.textContent).toMatch(/Handed to Mia/);
    const chat = row.querySelector('.is-message')!;
    expect(chat.querySelector('.chathead')?.textContent).toMatch(/Milo/);
    expect(chat.querySelector('.chatmsg.peer .chatfrom')?.textContent).toBe('Ruby');
    expect(chat.textContent).toMatch(/Does billing count it\?/);

    // It moves by CSS alone, holds still under a resting pointer, and stands
    // still for a reader who asked for less motion.
    const css = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
    expect(css).toMatch(/@keyframes landing-marquee \{ from \{ transform: translateX\(calc\(-100% \/ 3\)\); \} to \{ transform: translateX\(calc\(-200% \/ 3\)\); \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.landing-marquee \.landing-marquee-track \{ animation: none; transform: translateX\(calc\(-100% \/ 3\)\); \} \}/);
    expect(css).toMatch(/\.landing-marquee:hover \.landing-marquee-track \{ animation-play-state: paused; \}/);
    expect(panel.querySelector('.chip')).toBeNull();
  });
});
