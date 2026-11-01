import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import WhyFly, { SOURCES, SOURCES_READ_ON } from './WhyFly';
import Home from './Home';
import { WHY_FLY_PATH } from './PrivateCopy';

void React;

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

/* Note #838 (the owner, 30 Oct 2026): why the Agentic Cloud runs on Fly, not
   AWS or Google Cloud. Every claim about a vendor carries that vendor's own
   page as its source. */
describe('Why your Agentic Cloud runs on Fly (note #838)', () => {
  // Through the buyer's eyes (the owner, 07:06 UTC): what you get first, then
  // the clouds in plain words, then the questions a team asks.
  it('reads what you get, one account, need by need, the questions, the door and the sources', () => {
    draw(<WhyFly />);
    expect(screen.getByRole('heading', { level: 1, name: 'Why your Agentic Cloud runs on Fly.' })).toBeTruthy();
    expect([...document.querySelectorAll('main section h2')].map((node) => node.textContent)).toEqual([
      'One account of yours. One bill.',
      'What an agent needs, cloud by cloud.',
      'Questions your team will ask.',
      'Build it in your own Fly account.',
      `Sources, each read on ${SOURCES_READ_ON}`,
    ]);
    // The comparison is a table on a desk (a row per need, a column per
    // cloud) and a block per need on a phone; no grid of identical cards.
    const table = document.querySelector('#compare table')!;
    expect([...table.querySelectorAll('thead th')].map((node) => node.textContent)).toEqual(['Fly', 'AWS', 'Google Cloud', 'Vercel']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(4);
    for (const row of table.querySelectorAll('tbody tr')) expect(row.querySelectorAll('td'), row.textContent ?? '').toHaveLength(4);
    for (const block of document.querySelectorAll('#compare .lg\\:hidden > div')) {
      expect([...block.querySelectorAll('dt')].map((node) => node.textContent), block.textContent ?? '').toEqual(['Fly', 'AWS', 'Google Cloud', 'Vercel']);
    }
    expect(document.querySelector('#compare [class*="rounded-2xl"]')).toBeNull();
    // The page's one drawing: an agent's computer through a day.
    expect(document.querySelector('#why-fly-top figure svg[role="img"]')?.getAttribute('aria-label')).toMatch(/awake by itself when a link is opened/);
  });

  it('cites every source, numbered in the order the page first cites them, each from the vendor’s own site', () => {
    draw(<WhyFly />);
    const cited = [...document.querySelectorAll('main sup a')].map((link) => Number(link.textContent));
    const firsts = cited.filter((n, at) => cited.indexOf(n) === at);
    expect(firsts).toEqual(SOURCES.map((_, at) => at + 1));
    for (const n of cited) expect(document.querySelector(`#source-${n} a`), String(n)).toBeTruthy();
    for (const source of SOURCES) {
      expect(new URL(source.url).hostname, source.id).toMatch(/(^|\.)(fly\.io|amazon\.com|google\.com|vercel\.com|agenticcloudcomputer\.com)$/);
    }
    expect(SOURCES_READ_ON).toBe('30 October 2026');
  });

  // Both clouds moved this year: the page must not repeat the old lines.
  it('says what is true of AWS and Google Cloud today', () => {
    draw(<WhyFly />);
    const text = (document.querySelector('#compare')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/run only inside some EC2 server types/);
    expect(text).toMatch(/Lambda MicroVMs wake on traffic, but each lives at most 8 hours/);
    expect(text).not.toMatch(/only on bare metal|requires? bare.metal|\.metal/i);
    // Vercel's Sandbox is a real microVM whose files persist (the owner's
    // ask, 30 Oct, 06:31 UTC; Greta's findings on note #838).
    expect(text).toMatch(/Every Sandbox is a lightweight virtual machine with full admin rights/);
    expect(text).toMatch(/A Sandbox saves its files when it stops/);
    expect(text).not.toMatch(/Vercel[^.]*(only (functions|containers)|containers only|no (VMs?|microVMs?))/i);
  });

  // The owner, 07:06 UTC: no wake time, no Fly incidents, nothing about
  // running off Fly; answer the team's questions instead of listing doubts.
  it('answers the team’s questions plainly, and makes none of the claims we never make', () => {
    draw(<WhyFly />);
    const questions = [...document.querySelectorAll('#questions dt')].map((node) => node.textContent);
    expect(questions).toEqual([
      'Is Fly one more vendor to approve?',
      'Do our AWS or Google Cloud credits apply?',
      'Where does our data live, and how is it backed up?',
    ]);
    const answers = (document.querySelector('#questions')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(answers).toMatch(/SOC 2 Type II report and a HIPAA package with a signed BAA/);
    expect(answers).toMatch(/No\. Fly bills your account directly/);
    // What infra/copy-installer/install.mjs sets up: snapshot_retention = 7
    // on the backend's and the code host's disks, and DB_BACKUP_KEEP 14.
    expect(answers).toMatch(/every day and keeps a week of them/);
    expect(answers).toMatch(/with the last 14 kept/);
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/ten seconds|\b10 ?s\b|seconds to wake|reliab|incident|status page|outage/i);
    expect(body).not.toMatch(/weaker|tell us\. We would rather/i);
    // Plain words for a buyer; the source titles below are the vendors' own.
    const words = [...document.querySelectorAll('main > section:not(#sources)')].map((node) => node.textContent ?? '').join(' ');
    expect(words).not.toMatch(/proxy|\bSDK\b|nested virtuali[sz]ation|\bKVM\b|bare metal|\bMachines?\b|microVM|Firecracker/);
    expect(body).not.toMatch(/most secure|unbreakable|nothing leaves|guarantee|always on|99\.9|unlimited|free forever/i);
    expect(body).not.toMatch(/stuck on a laptop|stops? at a pull request|beyond the laptop/i);
    expect(body).not.toMatch(/must (stay|run) on Fly|move off Fly|leave Fly|\bour own (microVM|Firecracker)|Sprites/i);
    expect(body).not.toMatch(/\bcopy\b/i);
    expect(body).not.toMatch(/bin\/bash/);
    expect(body).toMatch(/about \$0\.86 a day while it stood, plus about \$0\.09 an hour for each awake agent/);
  });

  it('is linked from the home page’s own-cloud chapter', () => {
    draw(<Home />);
    expect(WHY_FLY_PATH).toBe('/why-fly');
    expect(document.querySelector(`#own-cloud a[href="${WHY_FLY_PATH}"]`)?.textContent).toBe('Why it runs on Fly');
  });
});
