/**
 * The quote at the bottom of an answer (note #509, slice 8).
 *
 * Every mail client answers a letter by writing above a copy of it — `On
 * Tuesday, Priya wrote:` and the whole letter again, marked with `>` or put in
 * a blockquote. Read one message at a time that copy was context. Read as a
 * CONVERSATION it is the message directly above, a second time, under every
 * answer: a three-letter thread becomes six letters to scroll through.
 *
 * So a quote at the very END of a message, that repeats a message already in
 * the conversation, is folded behind a tap. Folded, never removed: the words
 * are still there, one press away, exactly as the sender sent them. And only
 * when BOTH hold — a quote in the middle of a message is somebody answering
 * point by point, and a quote of a letter this conversation does not hold is
 * the only copy the reader has of it.
 *
 * Pure, and the only place this is decided, so the screen and its tests read
 * the same answer.
 */

/** A message cut in two: what its sender wrote, and the quote under it. */
export interface MailQuoteSplit {
  said: string;
  /** The folded part, attribution line included. Absent when nothing folds. */
  quoted?: string;
}

/** Everything that is not a letter or a digit, gone — so a quote rewrapped at
 *  72 columns, marked with `>` and re-punctuated by a mail client still reads
 *  as the same words as the letter it copied. */
function normalized(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** How much of an earlier letter a quote must carry to be a copy of it: the
 *  opening of it, long enough that two different letters do not share it. */
const PROBE = 60;
/** The shortest quote that is still a copy when it is only a letter's
 *  opening: a line, not a word that every letter starts with. */
const TRIMMED = 24;

/**
 * Whether a quote repeats a message already in the conversation: it carries
 * the opening words of one of them. The opening, not the whole — a client
 * trims a long quote, and a letter's own quote of the one before it is
 * itself folded on the way.
 */
export function quoteRepeats(quoted: string, earlier: string[]): boolean {
  const quote = normalized(quoted);
  if (!quote) return false;
  return earlier.some((letter) => {
    const words = normalized(letter);
    const probe = words.slice(0, PROBE);
    // The letter's opening is in the quote — or the quote, cut short by the
    // client that made it, is the letter's opening.
    return (probe.length > 0 && quote.includes(probe)) || (quote.length >= TRIMMED && words.startsWith(quote));
  });
}

const QUOTE_LINE = /^\s*>/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i;

/**
 * The quote at the end of a plain-text message, if it has one: a run of
 * `>` lines reaching to the end (blank lines between them allowed), with the
 * sentence introducing it — `On …, Priya wrote:`, wrapped over as many as
 * three lines — and Outlook's `----- Original Message -----` form.
 */
export function splitQuotedText(text: string, earlier: string[]): MailQuoteSplit {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end -= 1;

  let start = end;
  while (start > 0 && (QUOTE_LINE.test(lines[start - 1]!) || !lines[start - 1]!.trim())) start -= 1;
  const quoting = lines.slice(start, end).some((line) => QUOTE_LINE.test(line));
  if (quoting) {
    while (start < end && !lines[start]!.trim()) start += 1;
    // The sentence introducing it, when there is one: the paragraph just
    // above (blank lines between allowed), when it is at most three lines —
    // a client wraps `On …, Priya <priya@…> wrote:` over two — and ends in a
    // colon. Failing that, its last line alone, for a client that set the
    // sentence straight under the words with no blank line between.
    let above = start;
    while (above > 0 && !lines[above - 1]!.trim()) above -= 1;
    let top = above;
    while (top > 0 && lines[top - 1]!.trim() && above - top < 3) top -= 1;
    const paragraph = lines.slice(top, above).join(' ').trim();
    const standsAlone = top === 0 || !lines[top - 1]!.trim();
    if (above > top && standsAlone && paragraph.length <= 300 && /:\s*$/.test(paragraph)) start = top;
    else if (above > 0 && /:\s*$/.test(lines[above - 1]!) && lines[above - 1]!.trim().length <= 300) start = above - 1;
  } else {
    const original = lines.slice(0, end).findIndex((line) => ORIGINAL_MESSAGE.test(line));
    if (original < 0) return { said: text };
    start = original;
  }
  const said = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(start, end).join('\n');
  // A message that is ALL quote has nothing to fold it under.
  if (!said.trim() || !quoteRepeats(quoted, earlier)) return { said: text };
  return { said, quoted };
}

/** The text a node would show, whitespace and all. */
function wordsOf(node: Node): string {
  return node.textContent ?? '';
}

/** Whether anything with words in it follows `node` in the body. */
function wordsAfter(node: Node, body: HTMLElement): boolean {
  for (let at: Node | null = node; at && at !== body; at = at.parentNode) {
    for (let next = at.nextSibling; next; next = next.nextSibling) {
      if (wordsOf(next).trim()) return true;
    }
  }
  return false;
}

/** The element introducing a bare blockquote — `On …, Priya wrote:` — when
 *  the element just before it is short and ends in a colon. */
function introduction(quote: Element): Element | null {
  let before = quote.previousSibling;
  while (before && ((before.nodeType === 3 && !wordsOf(before).trim()) || (before as Element).tagName === 'BR')) before = before.previousSibling;
  if (!before || before.nodeType !== 1) return null;
  const said = wordsOf(before).trim();
  return said.length <= 300 && /:\s*$/.test(said) ? before as Element : null;
}

/**
 * The quote at the end of an HTML message: Gmail's `.gmail_quote`, the
 * `#appendonsend` / `#divRplyFwdMsg` Outlook opens one with, or a last
 * blockquote (with the line introducing it) that nothing with words follows.
 * The two halves come back as markup, and each still goes through the same
 * allowlist the whole message would have — nothing here makes markup safe.
 */
export function splitQuotedHtml(html: string, earlier: string[]): MailQuoteSplit {
  if (typeof DOMParser === 'undefined' || !html) return { said: html };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  // A quote that is one element: the rest of the message has to END with it.
  const containers = [
    ...[...body.querySelectorAll('.gmail_quote')].filter((node) => !node.parentElement?.closest('.gmail_quote')),
    ...[...body.querySelectorAll('blockquote')].filter((node) => !node.parentElement?.closest('blockquote')),
  ].filter((node) => !wordsAfter(node, body))
    .map((node) => (node.tagName === 'BLOCKQUOTE' ? introduction(node) ?? node : node));
  // Outlook's: a marker, with the letter it answers laid out AFTER it rather
  // than inside it — so everything from the marker on is the quote.
  const markers = ['#appendonsend', '#divRplyFwdMsg'].flatMap((selector) => {
    const found = body.querySelector(selector);
    return found ? [found] : [];
  });
  const start = [...containers, ...markers]
    // The earliest one is where the quote begins.
    .sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
  if (!start) return { said: html };

  const range = doc.createRange();
  range.setStart(body, 0);
  range.setEndBefore(start);
  const saidPart = range.cloneContents();
  range.setStartBefore(start);
  range.setEnd(body, body.childNodes.length);
  const quotedPart = range.cloneContents();
  const serialize = (fragment: DocumentFragment) => {
    const holder = doc.createElement('div');
    holder.append(fragment);
    return holder;
  };
  const said = serialize(saidPart);
  const quoted = serialize(quotedPart);
  if (!wordsOf(said).trim() || !quoteRepeats(wordsOf(quoted), earlier)) return { said: html };
  return { said: said.innerHTML, quoted: quoted.innerHTML };
}

/** What an earlier message in the conversation SAYS, as words to look for in
 *  a later one's quote: its text, or the words of its markup. */
export function mailWordsOf(message: { text?: string; html?: string }): string {
  if (message.text?.trim()) return message.text;
  if (!message.html || typeof DOMParser === 'undefined') return '';
  return new DOMParser().parseFromString(message.html, 'text/html').body.textContent ?? '';
}
