/**
 * Agents answer in HTML (note #1186).
 *
 * Adam, 16 Nov 2026: "in chats with agents I want to see not markdown, but
 * html only. agent should send html to user to provide output and receive
 * interaction … and we should render html only in chats with agents …
 * interactive html".
 *
 * So an agent's reply in its chat may be HTML. Nothing marks it as such but
 * its own first character: a reply that OPENS with a tag is HTML, anything
 * else is the Markdown every reply was before this note — which is what keeps
 * every old conversation reading as it always did, with no migration and no
 * flag on a stored row.
 *
 * This module is shared by the backend and the Workspace, because both must
 * agree on the one question (is this reply HTML?) and on the plain words of
 * one — every reader that is not the chat bubble (the row recap, the copy
 * that reaches the Chief of Staff, a notification, the recap read aloud)
 * wants sentences, never tags.
 *
 * The way back (the person's tap or form, sent as their message) is described
 * where it is drawn, in workspace-ui/src/screens/chat/HtmlReply.tsx, and its
 * safety where the frame is served, routes/reply-frame.ts.
 */

/** A reply is HTML when, past leading whitespace, it opens with an element
 *  (or a comment or doctype) — `<p>`, `<div class=…>`, `<!-- … -->`. A
 *  Markdown reply never does: an autolink (`<https://…>`) is not a tag name,
 *  and prose that mentions `<div>` mid-sentence does not START with it. */
const OPENS_WITH_TAG = /^\s*(?:<!--|<!doctype\s|<[a-z][a-z0-9-]*(?=[\s>/]))/i;

export function isHtmlReply(text: string | null | undefined): boolean {
  if (!text) return false;
  if (!OPENS_WITH_TAG.test(text)) return false;
  // `<https://example.com>` is an autolink, and `<you@x.com>` a mail one:
  // both match the tag pattern only by accident of their first letters.
  return !/^\s*<[a-z][a-z0-9+.-]*:/i.test(text) && !/^\s*<[^>\s]*@[^>\s]*>/.test(text);
}

/**
 * Whether an HTML reply needs the sandboxed frame rather than the Workspace's
 * own allowlisted renderer: anything that runs (script, an `on…` handler),
 * styles itself, or asks for an answer (a form or one of its controls, a
 * `data-reply` button). Everything else is words and is drawn natively, in the
 * page's own type, at no cost.
 */
const NEEDS_FRAME = /<(?:script|style|form|button|input|select|textarea|canvas|dialog|video|audio|iframe|template|slot|link|meta|object|embed)\b|\s(?:on[a-z]+|style|data-reply)\s*=/i;

export function htmlReplyNeedsFrame(html: string): boolean {
  return NEEDS_FRAME.test(html);
}

/** Elements whose CONTENT is not words a person reads. */
const DROPPED = /<(script|style|head|title|template|noscript|svg|canvas|select|textarea|object|iframe)\b[\s\S]*?<\/\1\s*>/gi;
/** Elements that end a line of words. */
const BLOCK = /^(?:p|div|section|article|aside|header|footer|main|nav|h[1-6]|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|form|fieldset|legend|details|summary|hr|br|label|caption)$/i;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', deg: '°', euro: '€',
  rarr: '→', larr: '←', check: '✓',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * The words of an HTML reply as plain text: a line per block, `- ` before a
 * list item, a button as `[its label]`, scripts, styles and drawings gone,
 * entities decoded, runs of blank lines folded to one. No DOM — this runs on
 * the backend too — and none needed: the output is read, never rendered, so
 * a malformed tag costs a stray word at worst.
 */
export function htmlToPlainText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/gi, '');
  text = text.replace(DROPPED, ' ');
  text = text.replace(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi, (_whole, close: string, name: string) => {
    const tag = name.toLowerCase();
    if (tag === 'li' && !close) return '\n- ';
    if (tag === 'button') return close ? '] ' : ' [';
    if (tag === 'td' || tag === 'th') return close ? ' ' : ' ';
    if (tag === 'br' || tag === 'hr') return '\n';
    return BLOCK.test(tag) ? '\n' : '';
  });
  // A stray `<` that never closed a tag is left as written.
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A reply's words for any reader that is not the chat bubble: the plain text
 *  of an HTML reply, and a Markdown reply exactly as it was written. */
export function replyPlainText(text: string): string {
  return isHtmlReply(text) ? htmlToPlainText(text) : text;
}

/**
 * The person's answer through a reply's HTML is an ordinary message of theirs
 * on the record, with the reply it answers named by its seq. One answer per
 * reply, and only the NEWEST reply of the agent can be answered: an older one
 * belongs to a turn that is over, and its controls stand drawn but inert.
 */
export type HtmlReplyAnswerState = 'live' | 'answered' | 'old';
