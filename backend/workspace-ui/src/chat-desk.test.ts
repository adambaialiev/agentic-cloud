import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard on the chat's desk layout (note #547).
 *
 * While a conversation is up, the frame from `body` down is `overflow:
 * hidden` and the transcript pane is the only scroller. On a desk that pane
 * used to be the 720px column in the middle of the window, so a wheel turned
 * over either gutter reached a frame with nothing to scroll. The fix widens
 * the SCROLLER to the window and moves the column inside it, by taking the
 * frame's side gutters away for the chat screens and giving them back as
 * padding on the header, the optional job strip, the pane and the composer.
 *
 * Two things about that construction nothing on screen would tell the author
 * of the next change:
 *
 *   1. Every selector must lead with `body`. The marketing site renders these
 *      same screens inside a 640px panel with this stylesheet scoped under
 *      `.ws-live` by `scopeWorkspaceCss`, which DROPS a body-led rule and
 *      fences every other one — and a panel has no gutters to take away. The
 *      header-rule block above this one lives by the same rule.
 *
 *   2. The header's own guard finds the FIRST `@media (min-width: 760px)` in
 *      the file and asserts about its contents. This block shares the
 *      threshold and must stay behind it, or the two tests start reading
 *      each other's rules.
 *
 * The real-browser proof — a pointer over the gutter, a wheel, a transcript
 * that moved — is in scripts/verify-workspace-react-agent-chat.mts.
 */

const CSS = readFileSync(path.resolve(__dirname, 'workspace.css'), 'utf8');

/** The `@media` block the note added, comments and all. */
function deskChatBlock(): string {
  const heading = CSS.indexOf('(note #547)');
  expect(heading, 'the note #547 heading').toBeGreaterThan(-1);
  const start = CSS.indexOf('@media (min-width: 760px)', heading);
  expect(start, 'the note #547 media block').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error('the block never closes');
}

/** Every selector the block declares, one per comma, comments removed. */
function selectorsOf(block: string): string[] {
  const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0])
    .filter((chunk) => chunk.trim())
    .flatMap((chunk) => chunk.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

/** The transcript pane must be the containing block for the absolutely
 *  positioned labels inside it (note #736, 2026-10-11): a `.sr-only` span in a
 *  forwarded proposal's working dot, with the document as its containing
 *  block, made the page 185,889px tall in WebKit on the owner's iPhone, and
 *  iOS then centred the focused box with a page scroll. jsdom lays nothing
 *  out, so the rule is read from the stylesheet itself. */
describe('the transcript pane contains its hidden labels', () => {
  it('is positioned, so an absolute .sr-only inside a row scrolls with it instead of extending the page', () => {
    const start = CSS.indexOf('.chatpane {');
    expect(start).toBeGreaterThan(-1);
    const block = CSS.slice(start, CSS.indexOf('}', start));
    expect(block).toMatch(/position:\s*relative/);
    const srOnly = CSS.slice(CSS.indexOf('.sr-only {'), CSS.indexOf('}', CSS.indexOf('.sr-only {')));
    expect(srOnly).toMatch(/position:\s*absolute/);
  });
});

describe('the chat on a desk', () => {
  const block = deskChatBlock();

  it('stands behind the header-rule block, whose guard reads the first 760px media query', () => {
    expect(CSS.indexOf('@media (min-width: 760px)')).toBeLessThan(CSS.indexOf('(note #547)'));
  });

  it('leads every selector with body, so the landing panel drops it', () => {
    const selectors = selectorsOf(block);
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      expect(/^body\b/.test(selector), `${selector} escapes into .ws-live`).toBe(true);
    }
  });

  it('takes the frame’s side gutters away only while a chat is open', () => {
    for (const selector of selectorsOf(block)) {
      expect(selector, 'a rule here applies to a conversation, never to a page').toContain('agent-chat-open');
    }
    expect(block).toMatch(/#webFrame\s*{[^}]*width: 100%;[^}]*padding-left: 0;[^}]*padding-right: 0;/);
    expect(block).toMatch(/#webMain\s*{[^}]*width: 100%;/);
  });

  it('gives the gutter back to every chat strip as padding, and stops their bleed', () => {
    expect(block).toContain('--chat-gutter: max(clamp(16px, 3vw, 40px), calc(50% - 360px))');
    for (const piece of ['.chathead', '.chatjobsrow', '.chatpane', '.chatbar']) {
      expect(block, piece).toContain(`body.agent-chat-open ${piece}`);
    }
    expect(block).toContain('width: 100%; margin-left: 0; margin-right: 0;');
    // The composer keeps the 8px it always had inside its edge, so its 640px
    // row centres exactly as it did.
    expect(block).toContain('calc(var(--chat-gutter) - 8px)');
  });

  it('leaves the shell’s scroll model alone', () => {
    // The pane is the one scroller and the frame is hidden; this block only
    // reshapes boxes. An `overflow` here would be a second scroller or an
    // unstuck header, and neither is what the note asked for.
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('overflow');
  });
});
