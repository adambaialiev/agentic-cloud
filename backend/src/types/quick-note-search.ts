import {
  quickNoteIsArchived,
  quickNotePreview,
  quickNoteTitle,
  type QuickNoteDocument,
} from './quick-note.js';
import { htmlToText } from './safe-html.js';

/**
 * Finding one note among hundreds (note #242).
 *
 * A note is a jotting, so the account that finds notes useful is exactly the
 * account that ends up with a lot of them — the live list is capped at a
 * hundred, and the archive under it has no ceiling at all. Past that point the
 * two lists stop answering the only question anybody brings to them: "where is
 * the one about the wifi?"
 *
 * Everything a search needs to agree on lives here, in ONE place, because
 * there are two stores behind this feature and a search that finds a note on a
 * developer's laptop and misses it in production is worse than no search. The
 * SQLite store hands the words to an FTS5 index and gets candidates back; the
 * in-memory store walks its own map. Both then decide "does this match" and
 * "which comes first" with the functions below, so the two answers are the
 * same answer.
 */

/** How many results one search hands back. A screenful and then some: past
 *  this the query is the thing to fix, not the list. */
export const QUICK_NOTE_SEARCH_LIMIT = 50;

/**
 * How many notes an index is asked for before the ranking below sorts them.
 * The index orders by its own relevance score, which is not the order this
 * file wants — so it is used to NARROW (that is what an index is for) and the
 * ranking is done here, on documents, exactly as the in-memory store does it.
 * Comfortably above any one room's note count, so the two stores rank the same
 * set rather than two different prefixes of it.
 */
export const QUICK_NOTE_SEARCH_CANDIDATES = 500;

/** More words than anybody types at a list, and a bound on the work one
 *  request can ask an index for. */
export const QUICK_NOTE_SEARCH_MAX_TERMS = 8;

/** Everything after this many characters of one note is not what the row has
 *  room to show anyway. */
const SNIPPET_MAX_LENGTH = 140;

/**
 * The form both sides of a search are compared in: lower case, and without the
 * marks a phone's keyboard makes optional — "cafe" finds "café", "Ремонт"
 * finds "ремонт". It is the same folding the SQLite index is built with
 * (`unicode61 remove_diacritics 2`), which is what keeps the two stores
 * agreeing about what matches.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The words of a string, by the same rule the index tokenizes on: runs of
 *  letters and digits, everything else a separator. */
function tokenize(value: string): string[] {
  return fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * What the user typed, as the terms a store looks for. Punctuation is dropped
 * rather than escaped, which is also the whole of the injection story: a term
 * is letters and digits, so no query the user can type is FTS5 syntax.
 *
 * `#12` becomes `12`, and that is deliberate — the number is how every surface
 * here addresses a note, and typing it is the most precise search there is.
 */
export function quickNoteSearchTerms(query: string): string[] {
  return [...new Set(tokenize(query))].slice(0, QUICK_NOTE_SEARCH_MAX_TERMS);
}

/** A note as the index holds it: the line a reader recognises it by, and
 *  everything else it says. */
export interface QuickNoteSearchText {
  title: string;
  body: string;
}

/**
 * The searchable words of one note.
 *
 * The title carries the NUMBER as well, so `#12` finds note #12 — and so does
 * the plain `12`, since the number is what the user reads on every row and in
 * every CLI line.
 *
 * The body is the note's own words, then the remarks in its margin, then the
 * names of the files riding along. All three are things a person searching
 * remembers about a note and none of them are on the row: "the one Ruby said
 * was fixed", "the one with IMG_4179 on it". Markup never enters — the index
 * holds what the note SAYS, so no query can match a tag name.
 */
export function quickNoteSearchText(doc: QuickNoteDocument): QuickNoteSearchText {
  const comments = (doc.comments ?? []).map((comment) => htmlToText(comment.text));
  const files = (doc.attachments ?? []).map((attachment) => attachment.fileName);
  return {
    title: `${doc.number} ${quickNoteTitle(doc.html)}`,
    body: [htmlToText(doc.html), ...comments, ...files].filter(Boolean).join('\n'),
  };
}

/**
 * Does this note match every term? Each one has to open a word somewhere in
 * it: "keyb" finds "keyboard", "oard" finds nothing. That is what a search
 * field does while it is being typed into, and it is exactly what the index's
 * prefix query does, so both stores agree without either one guessing.
 */
export function quickNoteMatchesSearch(
  doc: QuickNoteDocument,
  terms: readonly string[],
): boolean {
  if (!terms.length) return false;
  const text = quickNoteSearchText(doc);
  const words = tokenize(`${text.title}\n${text.body}`);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/** Every term opens a word in the note's title (its number counts as one). */
function titleMatches(doc: QuickNoteDocument, terms: readonly string[]): boolean {
  const words = tokenize(quickNoteSearchText(doc).title);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/** The reader typed a note's number, whole. Not a prefix: `24` is somebody
 *  hunting for words, `246` is somebody who knows which note they want. */
function numberMatches(doc: QuickNoteDocument, terms: readonly string[]): boolean {
  return terms.some((term) => term === String(doc.number));
}

/**
 * The order results are read in, and it is one sentence long: the note you
 * named by number, then the ones whose TITLE matches, then the rest — live
 * notes ahead of archived ones, newest first inside each group.
 *
 * Not the index's own relevance score, for two reasons. It cannot be shared
 * with the store that has no index, so the two would drift apart; and this
 * product's every other list is read newest-down, so a search that reordered
 * by term frequency would be the one screen disagreeing with all of them about
 * what "first" means.
 */
export function rankQuickNoteSearch(
  docs: readonly QuickNoteDocument[],
  terms: readonly string[],
  limit: number,
): QuickNoteDocument[] {
  const tier = (doc: QuickNoteDocument): number => (
    numberMatches(doc, terms) ? 3 : titleMatches(doc, terms) ? 2 : 1
  );
  return [...docs]
    .sort((a, b) => (
      tier(b) - tier(a)
      || Number(quickNoteIsArchived(a)) - Number(quickNoteIsArchived(b))
      || b.updatedAt.localeCompare(a.updatedAt)
      || b.number - a.number
    ))
    .slice(0, Math.max(0, limit));
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * The line under a result: the part of the note the term is actually IN.
 *
 * A search result showing the note's opening words is a row that cannot say
 * why it is on screen — the match is a hundred characters further down, inside
 * a remark, or in the name of a file. So the snippet is a window around the
 * first term found, and only when nothing can be located does it fall back to
 * the preview every other list draws (which is the right answer for a note
 * matched by its title alone: the title is already the line above).
 *
 * Located with the term as typed rather than folded, because the position in
 * the ORIGINAL words is what a window has to be cut from. A query that only
 * matches through diacritic folding therefore lands on the fallback — the row
 * is still correct, it simply shows the note's opening line instead.
 */
export function quickNoteSearchSnippet(
  doc: QuickNoteDocument,
  terms: readonly string[],
): string {
  const flat = quickNoteSearchText(doc).body.replace(/\s+/g, ' ').trim();
  // Without the title, which is the line directly above this one on the row —
  // the same cut `quickNotePreview` makes, so a snippet never opens by
  // repeating the heading a reader has just read.
  const title = quickNoteTitle(doc.html).replace(/\s+/g, ' ').trim();
  const body = title && flat.startsWith(title) ? flat.slice(title.length).trim() : flat;
  const found = terms
    .map((term) => body.search(new RegExp(`(?<![\\p{L}\\p{N}])${term}`, 'iu')))
    .filter((at) => at >= 0)
    .sort((a, b) => a - b)[0];
  if (found === undefined) return quickNotePreview(doc.html);
  // A little room in front of the match, so the term is not the first thing on
  // the line with no idea what it belongs to — cut back to a word boundary so
  // the window never opens mid-word.
  const from = found < 24 ? 0 : body.lastIndexOf(' ', found - 20) + 1;
  return (from > 0 ? '…' : '') + clip(body.slice(from), SNIPPET_MAX_LENGTH);
}
