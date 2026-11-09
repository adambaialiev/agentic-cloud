import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The page for agents (note #1106; Adam, 9 Nov 2026, 17:48 UTC: "we should
 * provide link optimized for agent to see all functionality of our
 * workplace"). public/workplace.md is read whole in one fetch by the agent
 * that opens a letter's link, so it carries every part of a workplace and
 * keeps every rule of claims-we-never-make.
 */
const ROOT = path.resolve(__dirname, '../..');
const page = readFileSync(path.join(ROOT, 'public/workplace.md'), 'utf8');
const flat = page.replace(/\s+/g, ' ');

describe('workplace.md, the page for agents (note #1106)', () => {
  it('is plain Markdown, one page, small enough to read in one fetch', () => {
    expect(page.startsWith('# ')).toBe(true);
    expect(page).not.toMatch(/<[a-z][^>]*>/i);
    expect(page.length).toBeLessThan(30_000);
  });

  it('names every part of a workplace', () => {
    for (const part of ['Chief of Staff', 'Agents', 'Subscriptions', 'Notes', 'Knowledge pages', 'Drive', 'Repositories, CI and proposals', 'Sites and hosting',
      'Object storage', 'Secrets', 'Email', 'direct messages', 'Schedules', 'Voice', 'Your own Agentic Cloud', 'How an agent works here']) {
      expect(page, part).toContain(part);
    }
    for (const tool of ['Claude Code', 'Codex', 'OpenCode']) expect(page).toContain(tool);
  });

  it('says the data sentence word for word, and none of the claims we never make', () => {
    expect(flat).toContain('None of your data comes to us: only a daily report of counts and the contact you chose, which your admin sees and can turn off.');
    expect(flat).toMatch(/waits for its owner's yes, or merges by itself once the owner has turned on auto-merge/);
    expect(flat).toContain('Several agents can share one seat, and more seats run more agents at once.');
    expect(flat).toContain('free for now: no licence, no key and no charge from us');
    for (const never of [/nothing (of yours )?leaves/i, /never sees your code/i, /never forgets/i, /knows everything/i, /single sign-on|\bSSO\b/, /unlimited|no ceiling/i,
      /free forever|always free/i, /private copy|get a copy/i, /telegram/i, /our cloud/i, /Claude Team|ChatGPT Business|ChatGPT Team/i, /allows|approved by Anthropic|compliant/i,
      /nothing merges without/i, /second subscription/i]) {
      expect(flat, String(never)).not.toMatch(never);
    }
  });

  it('links the home page and the setup guide, and llms.txt points at it', () => {
    expect(page).toContain('https://agenticcloudcomputer.com/own-cloud.md');
    expect(page).toContain('https://agenticcloudcomputer.com/\n');
    const llms = readFileSync(path.join(ROOT, 'scripts/prerender.mjs'), 'utf8');
    expect(llms).toContain('https://agenticcloudcomputer.com/workplace.md');
    const headers = readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
    expect(headers).toMatch(/\/workplace\.md\n\s+Content-Type: text\/markdown; charset=utf-8/);
  });
});
