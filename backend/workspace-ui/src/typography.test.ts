import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard on the Workspace's type.
 *
 * The scale in workspace.css is Cursor's PRODUCT scale — three sizes, two
 * weights, hierarchy carried by colour — ported from their own stylesheet (the
 * comment at the top of that file says what and why). Two things about it are
 * easy to undo one rule at a time and impossible to see in a diff:
 *
 *   1. A hand-set pixel size. This file had twenty-two of them; the whole point
 *      of the port is that a new rule picks a role instead of inventing a
 *      twenty-third.
 *   2. A weight above 500. The one reading exception is new mail (note #651):
 *      its sender and subject use 700 so unread rows stand out in the inbox.
 *
 * Both allow a short list of furniture exceptions. Each one is a GLYPH SIZED TO A BOX — a monogram centred in an
 * avatar, an image-viewer control, the one-time-code field, the read-aloud
 * editor, a sign-in step's number in its 18px badge. None of those is type a person reads at a size; they are furniture.
 */

const ROOT = path.resolve(__dirname, '..');
const SHEETS = ['src/workspace.css', 'src/join-flow.css'].map((file) => ({
  file,
  css: readFileSync(path.join(ROOT, file), 'utf8'),
}));

/** Selectors whose size comes from the box around it, not from a reading role. */
const FURNITURE = [
  '.join-person-mark',
  '.ivcontrol',
  '.authotp',
  '.voicereview-text',
  '.voicereview-status',
  '.stepn',
  // Not furniture but the landing page's own header, copied whole onto the
  // public pages (the owner, 2026-09-27: "absolutely the same") — the site's
  // Inter at 16px, 600 on the name and on Sign up, as SiteHeader.tsx draws it.
  '.public-repo-head',
  '.public-repo-brand',
  '.public-repo-doors',
  // The app catalogue's title (note #756), at the landing's display size:
  // a public page of its own rather than a Workspace screen, the shape the
  // owner approved for the Leaderboard on 2026-10-10 (gone since note #824).
  '.appstop h1',
];

/** size, and the leading it carries — Cursor's product ratios, ours scaled. */
const SCALE: Record<string, [string, string]> = {
  '--ui-sm': ['12px', '1.27'],
  '--ui-base': ['13px', '1.35'],
  '--ui-lg': ['14px', '1.35'],
};

function offenders(pattern: RegExp, exceptions = FURNITURE): string[] {
  const found: string[] = [];
  for (const { file, css } of SHEETS) {
    // The selector is often a line above its declarations, so an exception
    // has to be carried down the rule rather than looked for on the line.
    let selector = '';
    for (const line of css.split('\n')) {
      if (line.includes('{')) selector = line.split('{')[0].trim() || selector;
      if (!pattern.test(line)) continue;
      const rule = `${selector} ${line}`;
      if (exceptions.some((exception) => rule.includes(exception))) continue;
      found.push(`${file}: ${line.trim().slice(0, 90)}`);
    }
  }
  return found;
}

describe('the Workspace type scale', () => {
  it('carries Cursor’s product ratios, and their leading', () => {
    const css = SHEETS[0].css;
    for (const [role, [size, leading]] of Object.entries(SCALE)) {
      expect(css, `${role} size`).toContain(`${role}: ${size};`);
      expect(css, `${role} leading`).toContain(`${role}-leading: ${leading};`);
    }
    // The ratios are what carries the look — a label sits 8% under body copy
    // here as it does there, not 20% under as it did before the port.
    const px = (role: string) => Number(SCALE[role][0].replace('px', ''));
    expect(Math.abs(px('--ui-sm') / px('--ui-base') - 11 / 12)).toBeLessThan(0.01);
    expect(Math.abs(px('--ui-lg') / px('--ui-base') - 13 / 12)).toBeLessThan(0.01);
  });

  it('keeps the two constrained spec lines off the reading scale', () => {
    // Note 396: both plate spec lines read as ONE line at 390px and above.
    // They are sized by the widest fact that has to fit, not by a role — the
    // scale's smallest step left five pixels of room, which is a coin toss
    // between font stacks rather than a margin, and the same commit folded on
    // one machine while passing on another.
    const css = SHEETS[0].css;
    expect(css).toMatch(/\.plates \.cruntime \{ font-size: var\(--ui-spec\);/);
    expect(css).toMatch(/\.plates \.cmachine \{ font-size: var\(--ui-spec-long\);/);
    expect(css).toContain('--ui-spec: 10.5px;');
    expect(css).toContain('--ui-spec-long: 10px;');
    // The machine line is the longer of the two and has to stay the smaller.
    expect(10).toBeLessThan(10.5);
  });

  it('sets no size by hand', () => {
    expect(offenders(/font-size:\s*[0-9.]+px/)).toEqual([]);
  });

  it('reserves weight above 500 for new mail', () => {
    const newMail = [
      '#mailList .crow.mailnew .name.plain',
      '#mailList .crow.mailnew .cline.mailsubject .ctext',
    ];
    expect(offenders(/font-weight:\s*(?:[6-9][0-9]{2}|1000|bold|bolder)/, [...FURNITURE, ...newMail])).toEqual([]);
    expect(SHEETS[0].css).toContain(`${newMail[0]} { font-weight: 700; }`);
    expect(SHEETS[0].css).toContain(`${newMail[1]} { color: var(--text); font-weight: 700; }`);
  });

  it('leaves the leading a ratio, so a title does not inherit a body’s line', () => {
    // `font: 13px/17.5px` inherits the COMPUTED 17.5px into every descendant,
    // and a 22px title drawn on a 17.5px line has its rows touching.
    const body = /body\s*\{[^}]*\}/.exec(SHEETS[0].css)?.[0] ?? '';
    expect(body).toContain('var(--ui-base)/var(--ui-base-leading)');
    expect(SHEETS[0].css).not.toMatch(/--ui-(sm|base|lg)-leading:\s*[0-9.]+px/);
  });

  it('keeps Home section names accessible without drawing repeated labels', () => {
    const css = SHEETS[0].css;
    const homeHeadings = /h2\.homehead\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(homeHeadings).toContain('position: absolute');
    expect(homeHeadings).toContain('clip-path: inset(50%)');
    expect(css).toContain('h2.homehead:not([hidden]) + * { margin-top: 26px; }');
  });

  it('moves the requested reading surfaces up one product step', () => {
    const css = SHEETS[0].css;
    const details = /^#kpageBody \.kpage\s*\{[^}]*\}/m.exec(css)?.[0] ?? '';
    const recap = /\.recaptext\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const noteComposer = /#noteText\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const agentRecap = /\.asays\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const agentReply = /\.agentlastbody\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(details).toContain('font-size: var(--ui-lg)');
    expect(details).toContain('line-height: var(--ui-lg-leading)');
    expect(recap).toContain('font-size: var(--ui-lg)');
    expect(recap).toContain('line-height: var(--ui-lg-leading)');
    expect(css).toContain('.recaptext strong { font-size: var(--ui-lg); }');
    expect(noteComposer).toContain('font-size: var(--ui-read)');
    expect(noteComposer).toContain('line-height: var(--ui-read-leading)');
    expect(agentRecap).toContain('font-size: var(--ui-lg)');
    expect(agentRecap).toContain('line-height: var(--ui-lg-leading)');
    expect(agentReply).toContain('font-size: var(--ui-lg)');
    expect(agentReply).toContain('line-height: var(--ui-lg-leading)');
    // The renderer is shared by comments and proposal previews; only a note
    // or knowledge page on its own detail screen becomes reading-sized.
    expect(css).toContain('.kpage { font-size: var(--ui-base);');
  });

  it('sets a note and its remarks at the chat\'s own reading size, headings and code following the words as in a chat (note #731)', () => {
    const css = SHEETS[0].css;
    const chat = /^\.chatmsg\s*\{[^}]*\}/m.exec(css)?.[0] ?? '';
    const note = /^#noteBody \.kpage:not\(#noteWait\), #screenNote \.ncmt \.ctext\s*\{[^}]*\}/m.exec(css)?.[0] ?? '';
    // One token, not a second number: the note is the chat's size by name.
    for (const rule of [chat, note]) {
      expect(rule).toContain('font-size: var(--ui-read)');
      expect(rule).toContain('line-height: var(--ui-read-leading)');
    }
    // The steps a chat bubble's headings and code take, in the same order.
    const steps = (prefix: string) => ['h1', 'h2', 'h3'].map((tag) => new RegExp(`${prefix}[^\\n{]*\\b${tag} \\{ font-size: ([.0-9]+em); \\}`).exec(css)?.[1]);
    expect(steps(':is\\(#noteBody')).toEqual(steps('\\.chatmsg \\.chatmarkdown'));
    expect(css).toMatch(/:is\(#noteBody[^\n{]*\) pre code \{ font-size: \.85em; \}/);
    // The boxes a note and a remark are written in are the size they are read at.
    expect(/#noteText\s*\{[^}]*\}/.exec(css)?.[0]).toContain('font-size: var(--ui-read)');
    expect(css).toContain('#screenNote :is(.cmtform, .cmteditform) textarea { font-size: var(--ui-read); line-height: var(--ui-read-leading); }');
  });

  it('raises proposal explanations and agent-detail values without raising their chrome', () => {
    const css = SHEETS[0].css;
    const proposals = /#prBody \.md, #kpBody \.md\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const agentValues = /#agentFacts \.drow \.v,[\s\S]*?#agentInfoCard \.crow \.name\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const agentMeta = /#agentInfoCard \.crow \.cline\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(proposals).toContain('font-size: var(--ui-lg)');
    expect(proposals).toContain('line-height: var(--ui-lg-leading)');
    expect(agentValues).toContain('font-size: var(--ui-lg)');
    expect(agentValues).toContain('line-height: var(--ui-lg-leading)');
    expect(agentMeta).toContain('font-size: var(--ui-base)');
    expect(agentMeta).toContain('line-height: var(--ui-base-leading)');
    expect(css).toContain('.drow .k { font-size: var(--ui-sm);');
    expect(css).toContain('.checkrow .cdesc { margin-top: 3px; font-size: var(--ui-sm);');
  });
});
