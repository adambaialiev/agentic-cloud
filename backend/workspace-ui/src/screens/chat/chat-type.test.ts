import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The size a conversation is set at (note #417).
 *
 * The stylesheet's product scale is three sizes for CHROME — a row, a label,
 * a name at the head of a list — and a chat transcript is the one screen in
 * this app that is not chrome: it is running prose somebody sits and reads on
 * a phone. So a message takes the reading role, and everything that IS the
 * message follows it while everything that is furniture around it stays
 * where the scale put it.
 *
 * Held as a HIERARCHY rather than as numbers — a message stands above the
 * chrome, nothing inside a bubble is set under the bubble's own words, the
 * draft matches the message it is about to become, the receipts and rails
 * stay quieter, the composer and its held twin are the same box — so moving
 * the scale again is free as long as the shape survives it.
 *
 * Read out of the stylesheet as TEXT, which is the honest way to hold a rule
 * no component can be asked about: jsdom applies no author stylesheet, so a
 * computed style here would report the browser's default and agree with
 * anything. The real cascade is checked in a real browser instead, at the
 * chat stop of `simulations/workspace-tour.mjs`.
 */

// Resolved through `node:url` rather than `new URL(…, import.meta.url)`: the
// global URL in a jsdom test is the DOCUMENT's, and it answers a relative
// path with `http://localhost:3000/…` however file-shaped the base it was
// handed.
const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', '..', 'workspace.css'), 'utf8')
  // Comments first: this file explains itself at length, and a paragraph
  // about a size is not a declaration of one.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every declaration written against exactly this selector, joined in file
 * order — a rule split across two places is still one rule to a browser, and
 * the later one wins, which is what the readers below rely on.
 */
function declarations(selector: string): string {
  const found: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    const written = match[1].split(',').map((one) => one.replace(/\s+/g, ' ').trim());
    if (written.includes(selector)) found.push(match[2]);
  }
  if (!found.length) throw new Error(`no rule in workspace.css is written against \`${selector}\``);
  return found.join(';');
}

/** The scale itself: every custom property the page declares on `:root`. */
const tokens = new Map<string, string>(
  [...declarations(':root').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(
    (written) => [written[1], written[2].trim()],
  ),
);

/**
 * One property of that rule, with any role it names resolved to the number
 * behind it. The boundary is what keeps `height` from answering with
 * `max-height`, and a property written twice answers with the later one, as
 * the cascade does.
 */
function value(selector: string, property: string): string {
  const written = [...declarations(selector).matchAll(
    new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;]+)`, 'g'),
  )].at(-1);
  if (!written) throw new Error(`\`${selector}\` sets no ${property}`);
  return written[1].trim().replace(/var\((--[\w-]+)\)/g, (whole, name: string) => tokens.get(name) ?? whole);
}

const number = (written: string, unit: string, what: string): number => {
  const found = new RegExp(`(?<![\\w.])([\\d.]+)${unit}(?![\\w])`).exec(written);
  if (!found) throw new Error(`${what} is \`${written}\`, which carries no ${unit} value`);
  return Number(found[1]);
};

/** A length in px, off a property or straight off a role in the scale. */
const px = (selector: string, property: string): number =>
  number(value(selector, property), 'px', `${selector} ${property}`);

/** A size given relative to the type it sits inside. */
const em = (selector: string, property: string): number =>
  number(value(selector, property), 'em', `${selector} ${property}`);

/** The type size, however it is written: the page's own body text sets it
 *  inside the `font` shorthand, ahead of its leading. */
function size(selector: string): number {
  const shorthand = !/(?<![\w-])font-size\s*:/.test(declarations(selector));
  return number(value(selector, shorthand ? 'font' : 'font-size'), 'px', `${selector} font size`);
}

/** The top and bottom of a `padding` shorthand, by the shorthand's own rules. */
function padding(selector: string): { top: number; bottom: number } {
  // One or two values and the bottom IS the top; three or four and the third
  // is the bottom.
  const sides = value(selector, 'padding').split(/\s+/).map((one) => Number.parseFloat(one) || 0);
  return { top: sides[0], bottom: sides.length > 2 ? sides[2] : sides[0] };
}

const MESSAGE = '.chatmsg';
const BOX = '.chatbar textarea';

describe('the size a conversation is read at', () => {
  it('sets a message above the size the app is scanned at', () => {
    // The workhorse role is for chrome — rows, labels, buttons — and a
    // transcript is the one screen made of nothing but the words themselves.
    expect(size(MESSAGE)).toBeGreaterThan(size('body'));
    // And it is read on a phone: this is the floor under that role, the
    // number every phone messenger sets a message at.
    expect(number(tokens.get('--ui-read') ?? '', 'px', 'the reading role')).toBeGreaterThanOrEqual(16);
  });

  it('carries the markdown inside a bubble with the words', () => {
    // Relative to the bubble, so a change to the reading role takes them
    // with it. A heading set under the paragraph it heads is a footnote, so
    // the smallest of them IS the words themselves, and each level stands at
    // least as tall as the one below it.
    const headings = [1, 2, 3, 4].map((level) => em(`.chatmsg .chatmarkdown h${level}`, 'font-size'));
    expect(headings.at(-1)).toBe(1);
    for (const [at, heading] of headings.entries()) {
      const under = at + 1 < headings.length ? headings[at + 1] : 1;
      expect(heading, `h${at + 1}`).toBeGreaterThanOrEqual(under);
    }
    // A reply that is mostly a command is still a message. Mono runs heavier
    // than prose at the same number, so the block sits under the words — but
    // it moves with them rather than staying where the file viewer's own
    // rule left it.
    const code = em('.chatmsg .chatmarkdown pre code', 'font-size') * size(MESSAGE);
    expect(code).toBeLessThan(size(MESSAGE));
    expect(code).toBeGreaterThan(px('.md pre code', 'font-size'));
  });

  it('types the draft at the size the message will be', () => {
    // A send that visibly grows the words is the screen saying it changed
    // them.
    expect(size(BOX)).toBe(size(MESSAGE));
  });

  it('keeps the furniture quieter than the messages', () => {
    const words = size(MESSAGE);
    for (const quiet of [
      '.chatday',                 // the day rail
      '.chatmsg.newchatdivider',  // the fresh-chat rule
      '.chatmsg.chatquiet',       // an event the reader themselves caused
      '.chatmsg.recapdid',        // what the Chief of Staff did for the reader (note #725)
      '.chatmsg.recapattention',  // a hand-off that fell through (note #725)
      '.chatmsg.recapnoticed',    // what the platform noticed (note #725)
      '.chatmsg.recapunfinished', // a request that did not complete (note #725)
      '.chatnoticetitle',         // a platform receipt: an event, not a voice
      '.chatfrom',                // who is speaking, over their words
      '.chatlive .chatmsg',       // the typing bubble
    ]) {
      expect(size(quiet), quiet).toBeLessThan(words);
    }
  });
});

describe("the composer's box", () => {
  it('stands exactly as tall as the Send button beside it', () => {
    // Which is why its leading is pinned rather than taken from the reading
    // role: at 1.45 a 17px line is 24.65px, and the pill would outgrow the
    // round button it sits next to.
    const { top, bottom } = padding(BOX);
    expect(px(BOX, 'line-height') + top + bottom).toBe(px('.chatsend', 'height'));
  });

  it('is the box the wait holds open, to the pixel', () => {
    // The held bar is a real `.chatbar`; only its fill is borrowed. A wait
    // standing at a different height is the composer — and the transcript
    // above it — jumping the moment the read lands (note #309).
    for (const property of ['font-size', 'line-height']) {
      expect(px('.chatwaitbox', property), property).toBe(px(BOX, property));
    }
    expect(padding('.chatwaitbox')).toEqual(padding(BOX));
  });
});
