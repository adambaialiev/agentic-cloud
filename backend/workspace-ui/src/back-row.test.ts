import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard on where Back STANDS, beside the ones on the corners and the type.
 *
 * There are two bars in the Workspace and both draw the same worded Back: the
 * shared `.pagehead` over every ordinary screen, and the chat's own
 * `.chathead`, which exists because its Back has to stand beside the agent's
 * face (note #188). Note #312 already holds them to the same 48px row. What
 * this file holds is the other half of "the same place": the chevron's inset
 * from the reading column, and the top of the row inside its own bar.
 *
 * The failure it exists to catch is the one our owner reported in note #483 —
 * Back moving on the way out of a chat. Nothing about either bar was wrong on
 * its own screen, which is why it survived so long: the numbers only disagree
 * when you put one screen where the other one just was, and no test that
 * reads a single bar can see it. So this one works the arithmetic of both
 * bars back to the same answers and compares them.
 *
 * jsdom lays nothing out, so these come off the stylesheet itself.
 */

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8')
  // Comments out first: this stylesheet explains its geometry in prose, and a
  // comment that says `padding: 2px` is not a rule that sets one.
  .replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const pattern = new RegExp(`(?:^|[{};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  const found = [...css.matchAll(pattern)].map((match) => match[1]);
  expect(found.length, `${selector} is declared once`).toBe(1);
  return found[0];
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body);
  expect(match, `${property} is declared`).toBeTruthy();
  return match![1].trim();
}

/** A px shorthand read the way the box model reads it: top and left. */
function box(value: string): { top: number; left: number } {
  const parts = value.split(/\s+/).map((part) => Number(part.replace('px', '')));
  expect(parts.every((part) => Number.isFinite(part)), `${value} is all px`).toBe(true);
  const [top, right = top, , left = right] = parts;
  return { top, left };
}

const px = (body: string, property: string) => box(declaration(body, property));
const size = (body: string, property: string) => Number(declaration(body, property).replace('px', ''));

describe('the Back row, on both bars', () => {
  const pagehead = rule('.pagehead');
  const chathead = rule('.chathead');
  const chatpane = rule('.chatpane');
  const chatbar = rule('.chatbar');
  const back = rule('.back, .orgswap');
  const chatBack = rule('.chathead .back');

  it('starts the chevron on the reading column’s own margin', () => {
    // Both bars are bled out of the column and pad their way back in, so the
    // sum below is where the chevron lands relative to the column's edge —
    // which is where the title under the shared bar, the agent's face in the
    // chat, and every card and bubble on both screens begin.
    const shared = px(pagehead, 'margin').left + px(pagehead, 'padding').left + px(back, 'padding').left;
    // The chat's bar insets further than the shared one because its Back
    // stands beside a face, so Back pulls its own padding back out again.
    const chat = px(chathead, 'margin').left + px(chathead, 'padding').left
      + px(chatBack, 'margin').left + px(back, 'padding').left;

    expect(chat).toBe(shared);
    expect(shared).toBe(0);
  });

  it('bleeds both bars the same distance past the column', () => {
    // What makes the two hairlines the same line in two places — and what
    // makes the sum above width-independent, since the column is inset by 16
    // on a phone and centred in wider gutters on a desk.
    const bleed = px(pagehead, 'margin').left;
    expect(bleed).toBe(-16);
    for (const [what, body] of [
      ['chathead', chathead],
      ['chatjobsrow', rule('.chatjobsrow')],
      ['chatpane', chatpane],
      ['chatbar', chatbar],
    ] as const) {
      expect(px(body, 'margin').left, what).toBe(bleed);
      expect(declaration(body, 'width'), what).toBe('calc(100% + 32px)');
    }
  });

  it('starts the row at the top of its own bar', () => {
    // `.pagenav` and `.chathead` ARE the 48px row (note #312); a pixel of
    // padding above either one lowers Back on that bar alone.
    expect(px(pagehead, 'padding').top).toBe(0);
    expect(px(chathead, 'padding').top).toBe(0);
  });

  it('gives both rows the same 48 pixels', () => {
    const shared = size(rule('.pagenav'), 'min-height');
    // The chat's bar carries the hairline the shared one hangs on `.pagehead`
    // around its row, and `box-sizing` is border-box here, so its declared
    // height is the row plus that line.
    const hairline = Number(/^(\d+)px/.exec(declaration(chathead, 'border-bottom'))![1]);
    expect(size(chathead, 'min-height') - hairline).toBe(shared);
    expect(shared).toBe(48);
  });
});
