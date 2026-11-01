import { randomUUID } from 'node:crypto';
import { validateSafeHtml, type SafeHtmlLabels } from './safe-html.js';

/**
 * The margin, generalized (Owner, notes #64 and #66).
 *
 * Quick notes grew it first: a signed remark UNDER a document, leaving the
 * words above it exactly as they were. The same margin now hangs off a change
 * proposal, a knowledge proposal and a knowledge page — and it is written from
 * both sides: an agent mid-turn, or the person themselves in their Workspace.
 * One shape for every remark, so a reader of any thread is reading the same
 * thing and every storage appends the same record.
 *
 * What a comment is NOT, everywhere it appears: an edit. The document above
 * the margin keeps exactly one author's words in it, and the margin is where
 * everybody else gets to speak.
 */
export interface MarginComment {
  id: string;
  /**
   * The agent that left it — or {@link COMMENT_AUTHOR_USER} when a person
   * wrote it in their Workspace. The same sentinel-in-the-same-field
   * convention a note's author fields use: every surface already reads "who
   * said this" out of one id, and a nullable author would have each of them
   * inventing its own answer for the empty case.
   */
  authorId: string;
  /**
   * The human behind it, stamped at creation: the agent's driver (note #57),
   * so the signature survives the agent's retirement — or the person
   * themselves when {@link authorId} is the sentinel. Absent only on comments
   * from before the stamp existed; readers fall back to resolving the agent's
   * owner across the org.
   */
  userId?: string;
  /** Semantic HTML as written; plain words are valid HTML. */
  text: string;
  createdAt: string;
  /** Present after the author has changed their words. Creation stays fixed:
   *  the remark keeps its place in the thread and says plainly that it moved. */
  editedAt?: string;
}

/**
 * Who {@link MarginComment.authorId} names when the author is the PERSON, in
 * their Workspace, rather than one of the agents. Canonical here; the note
 * document's own author fields alias it. It cannot collide — an agent id is a
 * UUID (`addTelegramAgentRecord`).
 */
export const COMMENT_AUTHOR_USER = 'user';

/** One remark. Long enough to say why, short enough to stay a remark. */
export const COMMENT_MAX_LENGTH = 1000;

/**
 * Comments on one document. High enough that no conversation meets it, low
 * enough that nothing grows without bound — every document here has a size
 * limit of its own, and its margin needs one too.
 */
export const MAX_COMMENTS = 50;

/**
 * How much a person may TYPE into a Workspace comment box. Lower than the
 * HTML limit because it is measured on different words: what the user types
 * is all remark, and the conversion adds a `<p>` per block — the same room
 * `QUICK_NOTE_MAX_TEXT_LENGTH` leaves under the note limit, so a comment that
 * fits the box cannot be refused by a limit the person never saw.
 */
export const COMMENT_MAX_TEXT_LENGTH = 800;

/** How every surface that is not a note phrases a refusal. Notes keep their
 *  own labels — "a note comment" — from before the margin was shared. */
export const COMMENT_HTML_LABELS: SafeHtmlLabels = {
  one: 'a comment',
  many: 'Comments',
  thing: 'comment',
};

/**
 * The first thing wrong with this comment, or null. `advice` is the one
 * sentence that differs per surface: where words too long for a margin belong.
 */
export function validateMarginComment(text: string, labels: SafeHtmlLabels, advice: string): string | null {
  if (!text.trim()) return 'A comment needs some words.';
  if (text.length > COMMENT_MAX_LENGTH) {
    return `A comment is at most ${COMMENT_MAX_LENGTH} characters (this one is ${text.length}). ${advice}`;
  }
  return validateSafeHtml(text, labels);
}

/** A new remark, ready to append. The id and the clock live here so no two
 *  storages — and no two routes — can disagree about the shape. */
export function newMarginComment(authorId: string, text: string, userId?: string): MarginComment {
  return { id: randomUUID(), authorId, ...(userId ? { userId } : {}), text, createdAt: new Date().toISOString() };
}
