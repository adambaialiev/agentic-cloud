/**
 * Where markdown ends and HTML begins inside one write-up (note #317).
 *
 * Agents on this platform write HTML all day — a quick note is HTML, a
 * knowledge page is HTML — so a proposal's write-up arrives in HTML often
 * enough that showing its tags as words is simply wrong. It also arrives as
 * markdown, and as markdown with a `<b>` in the middle of a sentence. This
 * decides, run by run, which one is in front of us; the RENDERING is the
 * knowledge page's own allowlist walker, so there is one definition of "HTML
 * this platform will show" and not a second one growing here.
 *
 * The rules are deliberately narrow, because the cost of guessing wrong is
 * words that disappear:
 *
 *  - A BLOCK starts only where a block-level tag starts a LINE, and runs to
 *    the first blank line at which everything it opened has closed. That is
 *    CommonMark's own HTML-block rule, and it is what keeps `agentbuilt note
 *    add "<h2>Wifi</h2>"` — a tag quoted mid-sentence — the words it is.
 *  - INLINE, only a matched PAIR of an inline tag: `<b>x</b>` is bold,
 *    while a lone `<T>`, a `<Component>` or an unclosed `<div` is text. An
 *    agent naming a type or a tag in passing is not writing markup.
 *  - `<br>` is the one exception to the pair rule: nobody writes it meaning
 *    the characters.
 *
 * Anything a rule does not claim reaches the markdown parser exactly as it
 * always did, and anything the walker does not allow is dropped there, as it
 * is on every page and note.
 */

/** Tags that open a block of HTML when they open a line. Table sections are
 *  here too: a `<tr>` on its own line means a table is being written. */
export const HTML_BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'section', 'article', 'aside', 'nav', 'header', 'footer', 'main',
  'figure', 'figcaption', 'details', 'summary', 'svg',
]);

/** Tags that may be a pair inside a line of prose. Deliberately only what is
 *  inline by nature: a `<p>` mid-sentence is far more likely to be an example
 *  than a paragraph. */
export const HTML_INLINE_TAGS = new Set([
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'abbr', 'code', 'kbd', 'samp', 'var', 'q', 'cite', 'time', 'span',
]);

/** No closing tag exists for these, so they never hold a run open. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'use', 'stop']);

const TAGS = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;

/** `<b>x</b>` — one pair of an inline tag, and its own tag closes it. */
export const HTML_INLINE_PAIR = new RegExp(
  `<(${[...HTML_INLINE_TAGS].join('|')})\\b([^>]*)>([\\s\\S]*?)</\\1\\s*>`,
  'i',
);

export const HTML_BREAK = /<br\s*\/?>/i;

/** How many block-level elements this line leaves open. Only tags that could
 *  hold a run open are counted — an unknown one is not markup here. */
function depthOf(line: string): number {
  let depth = 0;
  TAGS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAGS.exec(line))) {
    const tag = match[2]!.toLowerCase();
    if (VOID_TAGS.has(tag) || match[3] === '/') continue;
    if (!HTML_BLOCK_TAGS.has(tag) && !HTML_INLINE_TAGS.has(tag)) continue;
    depth += match[1] ? -1 : 1;
  }
  return depth;
}

const BLOCK_START = /^ {0,3}<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/;

/** Whether this line opens a block of HTML. A paragraph gives way to one, as
 *  it gives way to a heading or a list: "Here is what changed:" and a `<ul>`
 *  on the next line is one thought, and nobody types a blank line between
 *  them. */
export function opensHtmlBlock(line: string): boolean {
  const opener = BLOCK_START.exec(line);
  return Boolean(opener && HTML_BLOCK_TAGS.has(opener[1]!.toLowerCase()));
}

/**
 * The HTML block beginning at `lines[from]`, or null if none does.
 *
 * `next` is the line to carry on from, so the caller's loop moves exactly as
 * it does for every other block it recognises.
 */
export function htmlBlockAt(lines: string[], from: number): { html: string; next: number } | null {
  if (!opensHtmlBlock(lines[from] ?? '')) return null;
  const buffer: string[] = [];
  let depth = 0;
  let index = from;
  while (index < lines.length) {
    const line = lines[index]!;
    // A blank line ends the run — unless something is still open, in which
    // case the blank line is inside a table or a list the author spaced out.
    if (!line.trim() && depth <= 0 && buffer.length) break;
    buffer.push(line);
    depth += depthOf(line);
    index += 1;
  }
  return { html: buffer.join('\n'), next: index };
}
