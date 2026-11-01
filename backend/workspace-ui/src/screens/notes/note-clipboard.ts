/**
 * A note's own words, as plain text, for the clipboard (note #262).
 *
 * A note is stored as HTML, and HTML is not what anybody wants to paste into
 * a message: `<h2>Wifi</h2><p>The code is 4417.</p>` is markup about the
 * words, not the words. What the reader is looking at is prose, and what
 * leaves on the clipboard has to be the same prose — which means the LINES
 * have to survive. `htmlToText` on the server flattens a note to a single run
 * for titles and search, and a shopping list flattened into one line is
 * exactly the paste this exists to avoid.
 *
 * So the markup is walked instead, and each tag says what it means for a line:
 * a block stands apart with a blank line, a list item or a table row is one
 * line of the block around it, `<br>` is the break it always was, and a
 * preformatted run keeps every space it was written with.
 *
 * The TITLE is carried too. The screen drops the note's opening line from the
 * body because its header is already showing that line — but a note pasted
 * somewhere else has no header above it, and would arrive beheaded.
 */

import type { WorkspaceNoteRecord } from '../../../../src/shared/workspace-api.js';

/** Blocks that stand alone, with a blank line either side — the way they are
 *  read on the screen. */
const BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'ul', 'ol', 'dl', 'blockquote', 'table',
  'section', 'article', 'aside', 'nav', 'header', 'footer', 'main',
  'figure', 'details',
]);

/** Blocks that are one LINE of the block around them: three things on a list
 *  paste as three lines, not as three paragraphs. */
const LINES = new Set(['li', 'tr', 'dt', 'dd', 'caption', 'figcaption', 'summary']);

/** Nothing here is words. A picture is a file the note carries, and a drawing
 *  is `<text>` fragments that read as nonsense once out of their shape. */
const SILENT = new Set(['img', 'svg']);

/** Two cells of one row, on the line the row is. Not a tab: a note is prose,
 *  and it is pasted into a message far more often than into a spreadsheet. */
const CELL = ' · ';

/** The list an item is counting against, while its items are walked. */
interface Numbering { ordered: boolean; next: number }

function plainWords(html: string): string {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  let out = '';
  /** Line breaks owed to what has already been written: 1 a newline, 2 a
   *  blank line. Owed rather than written, so that a block which turns out to
   *  hold nothing costs no empty lines, and two adjacent blocks are one break
   *  and not two. */
  let owed = 0;

  /** `text` exactly as given, after whatever break it is standing behind. */
  const put = (text: string): void => {
    if (!text) return;
    if (owed && out) {
      // A line does not end in the space that happened to precede its break.
      out = out.replace(/[ \t]+$/, '');
      out += owed > 1 ? '\n\n' : '\n';
    }
    owed = 0;
    if (!out && !text.trim()) return;
    // Two runs of inline markup can each bring their own space to the gap
    // between them; the reader wrote one.
    out += out.endsWith(' ') && text.startsWith(' ') ? text.slice(1) : text;
  };

  /** Prose, whose whitespace collapses exactly as it does on screen. */
  const say = (raw: string): void => {
    const text = raw.replace(/\s+/g, ' ');
    put(!out || owed ? text.replace(/^ /, '') : text);
  };

  /** Nothing is owed before the first word: a note does not open on a blank
   *  line because its markup did. */
  const brk = (level: number): void => { if (out) owed = Math.max(owed, level); };

  const walk = (parent: Node, list: Numbering | null): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === node.TEXT_NODE) { say(node.nodeValue ?? ''); continue; }
      if (node.nodeType !== node.ELEMENT_NODE) continue;
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (SILENT.has(tag)) continue;
      if (tag === 'br') { brk(1); continue; }
      if (tag === 'pre') {
        // Read whole rather than walked: every space inside is meant, which is
        // the one place `say` would be wrong. The newline an author leaves
        // after `<pre>` is the tag's own formatting, not a first blank line.
        brk(2);
        put((element.textContent ?? '').replace(/^\n/, '').replace(/\s+$/, ''));
        brk(2);
        continue;
      }
      if (tag === 'li') {
        brk(1);
        put(list?.ordered ? `${list.next++}. ` : '- ');
        walk(element, null);
        brk(1);
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        if (element.previousElementSibling) put(CELL);
        walk(element, null);
        continue;
      }
      if (LINES.has(tag)) { brk(1); walk(element, null); brk(1); continue; }
      if (BLOCKS.has(tag)) {
        brk(2);
        walk(element, tag === 'ul' || tag === 'ol'
          ? { ordered: tag === 'ol', next: Number(element.getAttribute('start')) || 1 }
          : null);
        brk(2);
        continue;
      }
      // Inline, and everything the allowlist does not name: the tag says
      // nothing about lines, so only its words come through. A table section
      // is here too — `<tbody>` groups rows, it does not separate them.
      walk(element, list);
    }
  };

  walk(parsed.body, null);
  return out.replace(/[ \t]+$/gm, '').trim();
}

/**
 * What a copy of this note puts on the clipboard, or '' for a note with no
 * words in it — which has nothing to copy and is offered no button.
 *
 * The note's own `text` wins where there is one. That is the source the note
 * was written from and the source its Edit box hands back, so it is the note
 * itself rather than a reading of it; only a note somebody else wrote arrives
 * as markup alone.
 */
export function noteClipboardText(note: Pick<WorkspaceNoteRecord, 'html' | 'text'>): string {
  return (note.text ?? '').trim() || plainWords(note.html ?? '');
}
