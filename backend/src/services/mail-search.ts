/**
 * Searching a person's own mail (note #509, slice 7) — the two pure halves:
 * what words a message is FOUND by, and how the words somebody typed become
 * a query. The index itself is `workspace_mail_search` (sqlite-mail-search.ts).
 *
 * Found by three things, the three a person remembers a letter by: who it was
 * with, what it was about, and something it said.
 */

import type { MailMessageDocument, MailPartyRef } from './mail-message-storage.js';

/** A search longer than this is not somebody looking for a letter. */
export const MAIL_SEARCH_MAX_LENGTH = 200;
/** Words past this are dropped rather than refused: each one only narrows. */
export const MAIL_SEARCH_MAX_WORDS = 12;

export interface MailSearchFields {
  people: string;
  subject: string;
  body: string;
}

const partyWords = (parties: readonly (MailPartyRef | undefined)[]): string => parties
  .flatMap((party) => (party ? [party.name?.trim() ?? '', party.address] : []))
  .filter(Boolean)
  .join(' ');

/**
 * Markup's words, and none of its furniture. Indexing the tags would make
 * every formatted letter a match for `div`, `table` or `font`, and a
 * stylesheet's colours for `ffffff`.
 */
function wordsOfHtml(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * What one message is found by.
 *
 * WHO is the other side of it, never this person: every letter that arrived
 * was sent TO them and everything they started came FROM them, so indexing
 * their own address would make it match every row. A message that arrived is
 * found by who sent it; one they started, by who it went to.
 *
 * The BODY is the one the screen draws — the text a person typed, or, for a
 * letter that carried only markup, the words in that markup. For something
 * they started, it is what they wrote.
 */
export function mailSearchFields(doc: Pick<MailMessageDocument,
  'direction' | 'from' | 'to' | 'subject' | 'text' | 'html' | 'wrote'>): MailSearchFields {
  const sent = (doc.direction ?? 'in') === 'sent';
  const text = (sent ? doc.wrote ?? doc.text : doc.text)?.trim();
  return {
    people: sent ? partyWords(doc.to ?? []) : partyWords([doc.from]),
    subject: doc.subject ?? '',
    body: text || (doc.html ? wordsOfHtml(doc.html) : ''),
  };
}

/**
 * The words somebody typed, as an FTS5 query — or null when there is nothing
 * in them to look for, which the list answers with no rows rather than with
 * every row.
 *
 * Every word is QUOTED, so nothing typed is ever read as query syntax: `OR`,
 * `NEAR`, a dash or a stray `*` is only ever a word to find. A quoted word the
 * tokenizer splits — `priya@harborlight.co` — becomes a phrase, which is what
 * makes an address find the letters from that address and not every letter
 * that mentions `co`. Each ends in `*`, because a search box is read as it is
 * typed: `invo` is already looking for the invoice.
 */
export function mailSearchMatch(words: unknown): string | null {
  const said = typeof words === 'string' ? words.slice(0, MAIL_SEARCH_MAX_LENGTH) : '';
  const terms = said
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ''))
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, MAIL_SEARCH_MAX_WORDS);
  return terms.length ? terms.map((word) => `"${word}"*`).join(' ') : null;
}
