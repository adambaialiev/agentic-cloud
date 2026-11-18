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

function opensWithTag(text: string): boolean {
  if (!OPENS_WITH_TAG.test(text)) return false;
  // `<https://example.com>` is an autolink, and `<you@x.com>` a mail one:
  // both match the tag pattern only by accident of their first letters.
  return !/^\s*<[a-z][a-z0-9+.-]*:/i.test(text) && !/^\s*<[^>\s]*@[^>\s]*>/.test(text);
}

/** A line that opens an HTML block, at the very start of the line. */
const BLOCK_LINE = /\n(?=<(?:p|div|form|h[1-6]|ul|ol|table|section|article|fieldset|details|label|button|style|script)\b)/gi;

/**
 * A reply as its Markdown lead-in and its HTML, or null for a Markdown reply.
 *
 * Note #1191, found live: a Claude Code turn writes its words as one text
 * block, and an agent says a sentence before its form ("Six decisions are
 * open — pick yours:") as often as not. That reply does not START with a
 * tag, so it read as Markdown with the form's tags shown as text. So a reply
 * may also open with Markdown and turn to HTML at a line that starts with a
 * block tag — but only when what follows asks for something (a form, a
 * button, a script: `htmlReplyNeedsFrame`) and the line is not inside a
 * fenced code block, so a Markdown reply that SHOWS some HTML stays one.
 */
export function htmlReplyParts(text: string | null | undefined): { lead: string; html: string } | null {
  if (!text) return null;
  if (opensWithTag(text)) return { lead: '', html: text };
  for (const match of text.matchAll(BLOCK_LINE)) {
    const before = text.slice(0, match.index);
    if ((before.match(/^[ \t]*(```|~~~)/gm) ?? []).length % 2) continue;
    const html = text.slice(match.index + 1);
    if (!htmlReplyNeedsFrame(html)) return null;
    return { lead: before.trim(), html };
  }
  return null;
}

export function isHtmlReply(text: string | null | undefined): boolean {
  return htmlReplyParts(text) !== null;
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
  const parts = htmlReplyParts(text);
  if (!parts) return text;
  const words = htmlToPlainText(parts.html);
  return parts.lead ? `${parts.lead}\n\n${words}`.trim() : words;
}

/**
 * The person's answer through a reply's HTML is an ordinary message of theirs
 * on the record, with the reply it answers named by its seq. One answer per
 * reply, and only the NEWEST reply of the agent can be answered: an older one
 * belongs to a turn that is over, and its controls stand drawn but inert.
 */
export type HtmlReplyAnswerState = 'live' | 'answered' | 'old';

/**
 * Note #1191: the same answer states for an ordinary agent's own chat, whose
 * rows are numbered by `seq`. Adam, 18 Nov 2026, widening note #1186:
 * regular agents may answer in HTML too, by the Chief of Staff's rules — so
 * an HTML reply stays `live` until the person answers it (once, a person's
 * row naming it by `answerTo`), and only a fresh chat (a new-chat divider
 * after it) makes it `old`.
 */
export interface HtmlStateRow {
  seq: number;
  role: string;
  kind?: string;
  text: string;
  answerTo?: number;
}

export function agentChatHtmlStates(rows: readonly HtmlStateRow[]): Map<number, HtmlReplyAnswerState> {
  const answered = new Set(rows.flatMap((row) => (row.role === 'owner' && typeof row.answerTo === 'number' ? [row.answerTo] : [])));
  let fresh = -Infinity;
  for (const row of rows) if (row.kind === 'new-chat-divider' && row.seq > fresh) fresh = row.seq;
  const states = new Map<number, HtmlReplyAnswerState>();
  for (const row of rows) {
    if (row.role !== 'agent' || !isHtmlReply(row.text)) continue;
    states.set(row.seq, answered.has(row.seq) ? 'answered' : row.seq > fresh ? 'live' : 'old');
  }
  return states;
}

/** A reply's opening words, for telling an agent which reply was answered. */
export function replyOpening(text: string, max = 240): string {
  const words = replyPlainText(text).replace(/\s+/g, ' ').trim();
  return words.length > max ? `${words.slice(0, max - 1)}…` : words;
}
