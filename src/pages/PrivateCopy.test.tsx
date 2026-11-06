import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_GUIDE_PATH, AGENT_LINE, OWN_CLOUD_HEADING, PLATFORM_SOURCE_URL } from './PrivateCopy';
import Home, { HOME_HEADLINE } from './Home';
import { ROLLED_APPS } from '../components/CopyArt';

const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);
// Since note #832 the own-cloud page is part of the one home page.
const PrivateCopy = Home;

const ROOT = path.resolve(__dirname, '..', '..');
const installer = readFileSync(path.join(ROOT, 'infra/copy-installer/install.mjs'), 'utf8');
const guide = readFileSync(path.join(ROOT, 'public', AGENT_GUIDE_PATH), 'utf8');

describe('Your own Agentic Cloud, on the one home page (notes #829, #832)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }))));
  afterEach(() => vi.unstubAllGlobals());

  // Note #829 (the owner, 2026-10-28): for the CTO or founder who decides,
  // not the engineer; the company's data is the reason, and it comes first.
  it('speaks to the leader in headings, panels and links, no description (note #978)', () => {
    render(<PrivateCopy />);

    // Since note #835 the page leads with the product; the own cloud is the
    // second chapter of the story. Since note #978 (the owner, 4 Nov 2026,
    // 13:26 UTC: "each section should be without description text") it is
    // its heading, its links and the drawing: the data lead, the
    // open-source paragraph, the three steps, "What it takes" and the
    // qualifier came off. Since note #999 the heading is "Run it in your own
    // cloud. The code is open-source." and "Nothing of yours stays with us."
    // came off too.
    expect(screen.getByRole('heading', { level: 1, name: HOME_HEADLINE })).toBeTruthy();
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: OWN_CLOUD_HEADING })).toBeTruthy();
    expect(OWN_CLOUD_HEADING).toBe('Run it in your own cloud. The code is open-source.');
    expect(document.body.textContent).not.toMatch(/Nothing of yours stays with us|runs in your company’s own cloud\./);
    expect(document.querySelector('#own-cloud h3')).toBeNull();
    // "open-source" is a link to the public code, opening a new tab; its
    // hint describes the link and stays out of the heading's name.
    const open = screen.getByRole('link', { name: 'open-source' });
    expect(open.closest('h2')).toBeTruthy();
    expect(open.getAttribute('href')).toBe(PLATFORM_SOURCE_URL);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('#own-cloud-lead')).toBeNull();
    expect(document.querySelector('#takes')).toBeNull();
    expect(document.querySelector('#start ol')).toBeNull();
    expect(document.querySelector('#qualifier')).toBeNull();
    for (const id of ['#own-cloud', '#start']) {
      const shown = [...document.querySelector(id)!.querySelectorAll('p, li')].filter((node) => !node.closest('.ws-live, figure, svg, [role="img"]') && !node.classList.contains('sr-only'));
      expect(shown.map((node) => node.textContent), id).toEqual([]);
    }
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/About fifteen minutes\./);
    expect(body).not.toMatch(/free trial|first month/i);
  });

  // The page's main action: one line for the leader's own terminal agent.
  it('hands the leader one line for their agent, pointing at the guide, with a Copy button', () => {
    render(<PrivateCopy />);

    expect(AGENT_LINE).toBe('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(AGENT_LINE).not.toMatch(/\n/);
    const section = document.querySelector('#give-your-agent')!;
    expect(section.querySelector('code')!.textContent).toBe(AGENT_LINE);
    expect(section.querySelector('button')!.textContent).toBe('Copy');
    // It opens the start section since note #835; the first screen's text
    // link jumps there (a "Build yours" button until note #924). Since note
    // #951 link and section carry the action's own name.
    expect(document.querySelector('#start #give-your-agent')).toBeTruthy();
    // Since note #984 nothing above links here: the first-screen door left
    // with its screen.
    expect(document.querySelector('a[href="#start"]')).toBeNull();
    expect(document.querySelector('#start h2')?.textContent).toBe('Build your own Agentic Cloud.');
    for (const section of document.querySelectorAll('main > section')) expect(section.innerHTML, section.id).not.toContain('hello@agenticcloudcomputer.com');
    // The paste hint under it came off with note #978.
    expect(section.textContent).not.toMatch(/Paste it into/);
    // Since note #1025 a phone gets the same line and Copy as a desk: one
    // heading, one line, one button, no links, nothing hidden by screen size.
    expect([...section.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Give this to your agent']);
    expect(section.querySelectorAll('code')).toHaveLength(1);
    expect(section.querySelectorAll('button')).toHaveLength(1);
    expect(section.querySelectorAll('a')).toHaveLength(0);
    expect(section.querySelector('#on-a-phone')).toBeNull();
    expect(section.querySelector('.hidden, [class*="sm:hidden"]')).toBeNull();
    expect(section.textContent).not.toMatch(/Send me the line|Write to the founder|from a laptop/);
    // The line wraps on a narrow screen rather than pushing the page sideways.
    expect(section.querySelector('code')!.className).toMatch(/\bbreak-words\b/);
    expect(section.querySelector('code')!.className).toMatch(/\bmin-w-0\b/);
  });

  // The guide is what an agent runs from: every flag and every message it
  // quotes must be the installer's own, or the agent is told a fiction.
  it('keeps the agent guide true to install.mjs', () => {
    const usage = installer.split('\n').filter((line) => line.includes("say('")).join('\n');
    // Every flag but the version checks of node and flyctl, and flyctl's own
    // sign-in code, is an installer flag.
    const flags = new Set((guide.match(/--[a-z][a-z-]+/g) ?? []).filter((flag) => flag !== '--version' && flag !== '--code'));
    expect(flags.size).toBeGreaterThan(8);
    for (const flag of flags) expect(new RegExp(`${flag}(?=[\\s\\]'])`).test(usage), flag).toBe(true);
    // The agent's contract with the installer: its exit codes, the reasons
    // a person is needed, the JSON result line and the handover file.
    const exits = installer.match(/export const EXIT = \{([^}]+)\}/)![1];
    for (const [name, code] of [['done', 0], ['failed', 1], ['usage', 2], ['person', 3], ['waiting', 4]] as const) {
      expect(exits, name).toMatch(new RegExp(`${name}: ${code}\\b`));
      expect(guide, `exit ${code}`).toMatch(new RegExp(`\\| \`${code}\` \\|`));
    }
    const reasons = new Set([...installer.matchAll(/(?:reason: |PersonNeeded\()'([a-z-]+)'/g)].map((m) => m[1]));
    // update-key and licence stay in the installer behind COPY_LICENCE=on;
    // with licensing off (note #935) the guide never meets them.
    for (const reason of ['update-key', 'licence']) expect(reasons.has(reason), `installer reason ${reason}`).toBe(true);
    // No mail-key since note #946: email is set up later, in the Workspace.
    expect(reasons.has('mail-key')).toBe(false);
    expect(guide).not.toMatch(/--resend-key-file|--smtp-/);
    for (const reason of ['domain', 'fly-organization', 'fly-sign-in', 'billing', 'dns']) {
      expect(reasons.has(reason), `installer reason ${reason}`).toBe(true);
      expect(guide, `guide reason ${reason}`).toContain(`\`${reason}\``);
    }
    expect(installer).toContain("event: 'result'");
    expect(guide).toContain('{"event": "result", ...}');
    expect(installer).toContain('-handover.txt');
    expect(guide).toContain('<prefix>-handover.txt');
    for (const command of ['--plan --json', '--json --wait 0', 'node install.mjs status --json', '--json --wait 20']) expect(guide, command).toContain(command);
    expect(guide).toContain('node install.mjs upgrade --json');
    // Licensing is off: nothing in the guide sends the agent to us (note #935).
    expect(guide).not.toMatch(/update\.key|licence\.txt|--key-file|--licence-file|adam@agenticcloudcomputer|free trial/);
    expect(guide).toContain('free for now');
  });

  // It must never claim the agent can do it all alone (note #829).
  it('tells the agent where to stop and ask its person, and to show the plan first', () => {
    const asks = guide.split('\n').filter((line) => /ASK YOUR PERSON/.test(line)).join('\n');
    expect(asks.length).toBeGreaterThan(0);
    // flyctl and the person's own sign-in come first, so the organizations
    // can be listed for them to pick from (the owner, 28 Oct 2026, 17:27 UTC).
    const check = guide.slice(guide.indexOf('## 1. Check this computer'), guide.indexOf('## 2.'));
    expect(check).toMatch(/https:\/\/fly\.io\/install\.sh/);
    const signIn = guide.slice(guide.indexOf('## 2. Sign in to Fly: ASK YOUR PERSON'), guide.indexOf('## 3.'));
    expect(signIn).toMatch(/your person signs in themselves/);
    // No browser on this computer: the link goes to the person, the agent waits.
    expect(signIn).toMatch(/\*\*No browser here\*\*[^\n]*give your person the link it printed, and wait/);
    expect(signIn).toContain('fly auth login --code <code>');
    const questions = guide.slice(guide.indexOf('## 3. ASK YOUR PERSON'), guide.indexOf('## 4.'));
    expect(questions).toMatch(/^Run `fly orgs list` and show your person the organizations it lists/m);
    expect(guide.indexOf('fly orgs list')).toBeGreaterThan(guide.indexOf('## 3. ASK YOUR PERSON'));
    for (const point of [/Fly organization/, /card on file and its bill/, /domain name/, /Do not ask about email/, /Who adds the DNS records/]) {
      expect(questions, String(point)).toMatch(point);
    }
    expect(guide).not.toContain('hello@agenticcloudcomputer.com');
    expect(questions).not.toMatch(/You cannot continue without them/);
    expect(guide).toMatch(/## 6\. DNS: ASK YOUR PERSON/);
    expect(guide).toMatch(/Show your person all three, in plain words, and \*\*wait for their yes\*\*/);
    expect(guide).toMatch(/Do not read it out, copy it or open it yourself/);
    expect(guide).toMatch(/Change nothing until your person has agreed\*\* to the plan/);
    expect(guide).not.toMatch(/USD|per person|\bper seat\b/);
  });

  // The guide downloads one exact installer, by its git blob id in the public
  // repository, and has the agent check its SHA-256 (the owner, 28 Oct 2026,
  // 17:27 UTC), so what the agent runs is the file the tests above hold the
  // guide to. Change install.mjs and this fails until the guide names the new
  // file: the values to put in are in the failure. CI publishes the folder,
  // and with it the blob, when the change lands on main.
  // Since note #941 the guide downloads from the platform's own public
  // repository, pinned to one COMMIT (a branch would move under it) and to
  // the file's SHA-256. Change install.mjs and this fails until the guide
  // prints the new SHA-256 and names a commit that holds the new file. In the
  // same proposal: commit the installer change first, then the guide naming
  // that commit's sha (approval lands the branch whole, so it reaches main).
  it('pins the installer the guide downloads to this install.mjs, at one commit of our own repository', () => {
    const bytes = readFileSync(path.join(ROOT, 'infra/copy-installer/install.mjs'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const downloads = guide.match(/^curl [^\n]*install\.mjs[^\n]*$/gm) ?? [];
    expect(downloads).toHaveLength(1);
    const pinned = /^curl -fsSL -o install\.mjs 'https:\/\/agenticcloudcomputer\.com\/workspace\/api\/public\/workplaces\/acc\/repos\/agentic-cloud\/raw\/([0-9a-f]{40})\?path=infra\/copy-installer\/install\.mjs'$/.exec(downloads[0]!);
    expect(pinned, downloads[0]).not.toBeNull();
    expect(guide).toContain(`must print \`${sha256}\``);
    expect(guide).not.toMatch(/github\.com|githubusercontent/);
    // Where the history is here (a full clone), the named commit must hold
    // exactly this file; a shallow CI clone may not have it, and the SHA-256
    // the agent checks is the guard that always runs.
    let atPin: Buffer | null = null;
    try {
      atPin = execFileSync('git', ['show', `${pinned![1]}:infra/copy-installer/install.mjs`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* not in this clone */ }
    if (atPin) expect(createHash('sha256').update(atPin).digest('hex')).toBe(sha256);
  });

  // Note #959: the whole platform is open source (the public repository,
  // AGPL-3.0), not only the installer, and nothing says we keep the source.
  // Since note #1002 (the owner, 5 Nov 2026, 12:45 UTC) the licence link is
  // off the section; the code and why it is Fly stay.
  it('links the open-source code under its heading, and not the licence', () => {
    render(<PrivateCopy />);

    const section = document.querySelector('#with-us')!;
    // Since note #978 the sentence that said it came off; the heading and
    // the link to the code say it.
    expect(section.querySelector('p')).toBeNull();
    const links = [...section.querySelectorAll('a')].map((link) => [link.getAttribute('href'), (link.textContent ?? '').replace('(opens in a new tab)', '').trim()]);
    expect(links).toEqual([
      [PLATFORM_SOURCE_URL, 'Read the code'],
      ['/why-fly', 'Why it runs on Fly'],
    ]);
    expect(document.body.textContent).not.toMatch(/The AGPL-3\.0 licence/);
  });

  // Note #827: the drawing and the film stay; since note #835 the drawing of
  // what runs on whose side is in the own-cloud chapter, the film under For
  // your team.
  it('keeps the drawing in the own-cloud chapter, named once for a screen reader', () => {
    render(<PrivateCopy />);

    expect(document.querySelector('#own-cloud #your-side figure.copy-art')).toBeTruthy();
    // For your team and its install film left with note #984.
    expect(document.querySelector('#for-your-team')).toBeNull();
    for (const figure of document.querySelectorAll('figure.copy-art')) {
      const named = figure.matches('[role="img"]') ? [figure] : [...figure.querySelectorAll('[role="img"]')];
      expect(named.length, figure.className).toBeGreaterThan(0);
      for (const picture of named) expect((picture.getAttribute('aria-label') ?? '').length).toBeGreaterThan(40);
    }
    const order = installer.match(/const ROLL_ORDER = \[([^\]]+)\]/)![1].match(/'([a-z]+)'/g)!.map((name) => name.slice(1, -1));
    expect(ROLLED_APPS).toEqual(order);
    // "Read the guide your agent follows" left with For your team; the
    // guide is still the address inside the line to copy.
    expect(document.querySelector(`a[href="${AGENT_GUIDE_PATH}"]`)).toBeNull();
    expect(document.querySelector('#give-your-agent code')!.textContent).toContain(AGENT_GUIDE_PATH);
  });

  // The old address answers for good (public/_redirects), and the edge
  // serves the page and its guide as static files.
  it('keeps /private-copy and /own-cloud answering with a permanent redirect home, and serves the guide as Markdown', () => {
    const redirects = readFileSync(path.join(ROOT, 'public/_redirects'), 'utf8');
    for (const old of ['/private-copy', '/own-cloud']) {
      expect(redirects).toMatch(new RegExp(`^${old} / 301$`, 'm'));
      expect(redirects).toMatch(new RegExp(`^${old}/ / 301$`, 'm'));
    }
    const headers = readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
    expect(headers).toMatch(/\/own-cloud\.md\n\s+Content-Type: text\/markdown; charset=utf-8/);
  });

  // claims-we-never-make: no price of ours, no promise about the future, no
  // "the model never sees your code", no business AI plan, no certifications.
  it('makes none of the claims we never make', () => {
    render(<PrivateCopy />);

    for (const text of [document.body.textContent ?? '', guide]) {
      expect(text).not.toMatch(/€|£|per seat|per person|discount|founding|free forever|unlimited|no ceiling|most secure|SOC ?2|ISO ?27001|HIPAA|certified/i);
      expect(text).not.toMatch(/never sees your code|your code never leaves/i);
      expect(text).not.toMatch(/Telegram|Claude Team|ChatGPT (Business|Team|Enterprise)/i);
    }
  });
});
