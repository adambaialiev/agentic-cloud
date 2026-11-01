import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_GUIDE_PATH, AGENT_LINE, INSTALLER_SOURCE_URL, INSTALL_FILM, OWN_CLOUD_HEADING } from './PrivateCopy';
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
  it('speaks to the leader: why first, what stays with us, what it takes and who does it', () => {
    render(<PrivateCopy />);

    // Since note #835 the page leads with the product; the own cloud is the
    // second chapter of the story, and the data reason leads it.
    expect(screen.getByRole('heading', { level: 1, name: HOME_HEADLINE })).toBeTruthy();
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: OWN_CLOUD_HEADING })).toBeTruthy();
    const lead = (document.querySelector('#own-cloud #own-cloud-lead')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(lead).toMatch(/^What makes your agents good stays yours: your code, their conversations, your knowledge, your keys and your decisions\./);
    expect(lead).toMatch(/your own cloud account, on your domain\./);
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing of yours stays with us.' })).toBeTruthy();
    // What it takes, inside "How to start" since note #834; since note #924
    // a short box of five one-line items in the paragraph's words, nothing
    // dropped.
    const items = [...document.querySelectorAll('#start #takes li')].map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(document.querySelector('#start #takes h3')?.textContent).toBe('What it takes');
    expect(items).toHaveLength(5);
    expect(items[0]).toMatch(/^A Fly account that pays for the machines\. Fly bills it directly; nothing of ours is on that bill\.$/);
    expect(items[1]).toMatch(/^One domain of your own, such as agents\.yourcompany\.com\.$/);
    // The real figure first (the owner, 29 Oct, 17:00 UTC), the certificate wait second.
    expect(items[2]).toMatch(/^One command your agent runs\. In our clean run on 29 October it went from a new Fly organization to ready in 13 min 24 s\.$/);
    expect(items[3]).toMatch(/one has taken over an hour before/);
    // Free for now, with no licence (the owner, 1 Nov 2026, note #935).
    expect(items[4]).toMatch(/^Free for now: no licence, no key and no charge from us\.$/);
    const takes = items.join(' ');
    expect(takes).not.toMatch(/usually|always|guarantee/i);
    const body = document.body.textContent ?? '';
    // The time beside a 68-minute film: the work, and the wait said aloud.
    expect(document.querySelector('#takes')!.textContent).toMatch(/certificates in under a minute that time/);
    expect(body).not.toMatch(/About fifteen minutes\./);
    expect(body).toMatch(/Free for now: no licence, no key and no charge from us/);
    expect(body).not.toMatch(/free trial|first month/i);
    expect(body).toMatch(/Company single sign-on is not built\s+yet/);
  });

  // The page's main action: one line for the leader's own terminal agent.
  it('hands the leader one line for their agent, pointing at the guide, with a Copy button', () => {
    render(<PrivateCopy />);

    expect(AGENT_LINE).toBe('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(AGENT_LINE).not.toMatch(/\n/);
    const section = document.querySelector('#give-your-agent')!;
    expect(section.querySelector('code')!.textContent).toBe(AGENT_LINE);
    expect(section.querySelector('button')!.textContent).toBe('Copy');
    // It opens How to start since note #835; the first screen's text link
    // jumps there (a "Build yours" button until note #924).
    expect(document.querySelector('#start #give-your-agent')).toBeTruthy();
    expect(document.querySelector('#home-top #give-your-agent')).toBeNull();
    expect(document.querySelector('#home-top a[href="#start"]')?.textContent).toMatch(/^How to start/);
    // And it is the first step, not the second: the guide plans before our
    // two files exist, so pasting the line at once works (note #831).
    const steps = [...document.querySelectorAll('#start ol > li')].map((step) => step.textContent ?? '');
    expect(steps[0]).toMatch(/^Give your agent the line above\./);
    // Nothing to ask us for (note #935): the agent builds it on the person's yes.
    expect(steps[1]).toMatch(/^Say yes, and your agent builds your own Agentic Cloud\. Nothing is needed from us: no key, no licence\.$/);
    for (const section of document.querySelectorAll('main > section')) expect(section.innerHTML, section.id).not.toContain('hello@agenticcloudcomputer.com');
    expect(section.textContent).toMatch(/Paste it into Claude Code, Codex or any agent that works in a terminal\./);
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
    for (const reason of ['domain', 'fly-organization', 'fly-sign-in', 'billing', 'mail-key', 'dns']) {
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
    for (const point of [/Fly organization/, /card on file and its bill/, /domain name/, /How mail goes out/, /Who adds the DNS records/]) {
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
  it('pins the installer the guide downloads to this install.mjs', () => {
    const bytes = readFileSync(path.join(ROOT, 'infra/copy-installer/install.mjs'));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const downloads = guide.match(/^curl [^\n]*install\.mjs[^\n]*$/gm) ?? [];
    expect(downloads).toEqual([
      `curl -fsSL -H 'Accept: application/vnd.github.raw' -o install.mjs https://api.github.com/repos/adambaialiev/private-copy-installer/git/blobs/${blob}`,
    ]);
    expect(guide).toContain(`must print \`${sha256}\``);
    expect(guide).not.toMatch(/raw\.githubusercontent\.com/);
  });

  it('says the installer is open source and links its code', () => {
    render(<PrivateCopy />);

    const section = document.querySelector('#with-us')!;
    expect(section.textContent).toMatch(/The installer is open source/);
    const links = [...section.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual(INSTALLER_SOURCE_URL ? [INSTALLER_SOURCE_URL, '/why-fly'] : ['/why-fly']);
  });

  // Note #827: the drawing and the film stay; since note #835 the drawing of
  // what runs on whose side is in the own-cloud chapter, the film under For
  // your team.
  it('keeps the drawing in the own-cloud chapter and the film under For your team, each named once for a screen reader', () => {
    render(<PrivateCopy />);

    const team = document.querySelector('#for-your-team')!;
    expect(document.querySelector('#own-cloud #your-side figure.copy-art')).toBeTruthy();
    expect(team.querySelector('figure.copy-art')).toBeNull();
    for (const figure of document.querySelectorAll('figure.copy-art')) {
      const named = figure.matches('[role="img"]') ? [figure] : [...figure.querySelectorAll('[role="img"]')];
      expect(named.length, figure.className).toBeGreaterThan(0);
      for (const picture of named) expect((picture.getAttribute('aria-label') ?? '').length).toBeGreaterThan(40);
    }
    // The opening is words and the line for the agent, not a drawing.
    expect(document.querySelector('#home-top figure')).toBeNull();
    const order = installer.match(/const ROLL_ORDER = \[([^\]]+)\]/)![1].match(/'([a-z]+)'/g)!.map((name) => name.slice(1, -1));
    expect(ROLLED_APPS).toEqual(order);
    expect(team.querySelector(`a[href="${AGENT_GUIDE_PATH}"]`)).toBeTruthy();
  });

  it('shows the install film with a poster, and never plays it by itself', () => {
    render(<PrivateCopy />);

    const videos = [...document.querySelectorAll('#install video')] as HTMLVideoElement[];
    expect(videos).toHaveLength(INSTALL_FILM ? 1 : 0);
    if (!INSTALL_FILM) return;
    const [video] = videos;
    expect(video.autoplay).toBe(false);
    // Note #839: the clean poster first, with our own play button and no
    // browser controls over the caption in the picture; pressing it shows
    // the controls.
    expect(video.hasAttribute('controls')).toBe(false);
    const play = screen.getByRole('button', { name: 'Play the film of a real install' });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    fireEvent.click(play);
    expect(video.hasAttribute('controls')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Play the film of a real install' })).toBeNull();
    expect(video.muted).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toBeTruthy();
    expect(video.querySelector('source')!.getAttribute('src')).toMatch(/^https:\/\/iabkt-[0-9a-f]+\.fly\.storage\.tigris\.dev\/private-copy\/.+\.mp4$/);
    expect(document.querySelector('#install figcaption')!.textContent).toMatch(/^A real install on 29 Oct 2026: one command, 13 min 24 s from a clean Fly organization to ready, shown in 1 min 47 s\./);
  });

  // The close is the founder's own address (note #832); the keys still come
  // from hello@, as "How to start" says.
  it('ends on how to get in touch', () => {
    render(<PrivateCopy />);

    const contact = document.querySelector('#contact')!;
    expect(contact.textContent).toMatch(/adam@agenticcloudcomputer\.com/);
    expect([...contact.querySelectorAll('a')].every((link) => link.getAttribute('href')?.startsWith('mailto:adam@agenticcloudcomputer.com'))).toBe(true);
    expect(document.querySelector('#start')!.textContent).not.toMatch(/update key|licence from us/);
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
