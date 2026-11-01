import { createHash } from 'node:crypto';
import {
  COMMENT_AUTHOR_USER,
  COMMENT_MAX_LENGTH,
  MAX_COMMENTS,
  validateMarginComment,
  type MarginComment,
} from './comment.js';
import {
  editableTextFromSafeHtml,
  htmlToText,
  textToSafeHtml,
  validateSafeHtml,
  type SafeHtmlLabels,
} from './safe-html.js';

/**
 * Quick notes (docs/agent-quick-notes.md): one short HTML document an agent
 * writes straight into the account, with no repository behind it and no
 * approval in front of it.
 *
 * The third store, and deliberately the least ceremonious of the three. A repo
 * is a tree an agent clones and branches; a knowledge page is a document the
 * owner approves before it lands. A quick note is a jotting — the wifi code,
 * the number to call back, what the user asked for on Tuesday — and every gate
 * that makes the other two trustworthy would make this one useless.
 *
 * HTML, and the SAME html knowledge pages are written in (`safe-html.ts`):
 * headings, lists, tables, links, inline SVG, no CSS and no JavaScript. What a
 * note does NOT need is a page's ceremony — no `<title>`, no `<meta
 * description>`, no name. It is a fragment, its title is read from its own
 * first line, and plain prose with no tags at all is valid HTML and stays a
 * perfectly good note. That is what keeps it quick.
 */

/** How a refusal names this format. Knowledge pages have their own wording. */
export const QUICK_NOTE_HTML_LABELS: SafeHtmlLabels = {
  one: 'a quick note',
  many: 'Quick notes',
  thing: 'note',
};

/** Comments use the same semantic-HTML contract as the note above them. */
export const QUICK_NOTE_COMMENT_HTML_LABELS: SafeHtmlLabels = {
  one: 'a note comment',
  many: 'Note comments',
  thing: 'comment',
};

/**
 * Long enough for a whole document — a plan, a spec, a brief — not only a
 * jotting. It was 8000 (a heading, a list and a small table) until note #676:
 * an agent asked to write a game plan handed its user an 11 KB file in the
 * chat, and "save this plan in notes" then had nowhere to put it. A note is
 * where the user and every agent look for what was written down, so the
 * ceiling has to fit what agents actually write. The body parser on both
 * note routes is widened to match (`index.ts`); the default 100 KB would
 * refuse a note this size before the route ever saw it.
 */
export const QUICK_NOTE_MAX_LENGTH = 100_000;

/** Enough that nobody meets it by jotting; low enough to bound the account.
 *  LIVE notes only — archived notes do not count toward this ceiling.
 *  Counted per namespace, which since rooms were merged (note #843) is the
 *  whole WORKPLACE: 100 per room became 100 for everyone, so Adam raised it
 *  (30 Oct 2026, note #921) and named no number — 500. A personal account
 *  is its own namespace and shares the figure. */
export const QUICK_NOTES_MAX_PER_USER = 500;

/**
 * What `createdByAgentId` / `updatedByAgentId` say when the note was written by
 * the PERSON, in the Workspace, rather than by one of their agents.
 *
 * A sentinel in the same field rather than a second one: every surface already
 * reads "who last touched this" out of that id, and a nullable author would
 * have each of them inventing its own answer for the empty case. It cannot
 * collide — an agent id is a UUID (`addTelegramAgentRecord`). The same
 * sentinel signs a comment a person leaves anywhere — canonical in
 * `comment.ts` now that the margin is shared beyond notes.
 */
export const QUICK_NOTE_AUTHOR_USER = COMMENT_AUTHOR_USER;

/** Was this note last written by the user themselves, in the Workspace? */
export function quickNoteIsUsers(doc: Pick<QuickNoteDocument, 'updatedByAgentId'>): boolean {
  return doc.updatedByAgentId === QUICK_NOTE_AUTHOR_USER;
}

/**
 * How much a person may TYPE into the Workspace's note box.
 *
 * Lower than the HTML limit because it is measured on different words: an
 * agent's characters are partly markup, and what the user types is all note.
 * It also leaves the conversion room — `textToSafeHtml` adds a `<p>` per
 * block and escapes `&`, `<` and `>` — so a note that fits the box cannot be
 * refused by a limit the person never saw. Half the HTML ceiling keeps that
 * true for any text at all. (4000 until note #676, when both limits grew.)
 */
export const QUICK_NOTE_MAX_TEXT_LENGTH = 50_000;

/**
 * A remark on a note (Owner, note #9; the margin opened to people with #64).
 *
 * The margin, not the page. A note is one document with one author's words in
 * it, and the rule that keeps it trustworthy is that nobody rewrites somebody
 * else's — the user does not edit an agent's note, and an agent that rewrites
 * the user's note has put its own words in their mouth. A comment is what
 * everybody else has instead: "I called, they are closed Mondays" said UNDER
 * the note, signed, leaving what is written above it exactly as it was.
 * First agents-only; since note #64 the person writes in the same margin from
 * their Workspace, signed with the same sentinel their own notes carry.
 *
 * The shared `MarginComment` shape (`comment.ts`) — notes grew it first, and
 * proposals and knowledge pages now hang the same record.
 *
 * Semantic HTML, through the same allowlist as the note it hangs off. A plain
 * sentence is still valid; structure such as paragraphs, emphasis and code is
 * rendered rather than exposed as source in the Workspace.
 */
export type QuickNoteComment = MarginComment;

/** One remark. Long enough to say why, short enough to stay a remark. */
export const QUICK_NOTE_COMMENT_MAX_LENGTH = COMMENT_MAX_LENGTH;

/**
 * Comments on one note. High enough that no conversation meets it, low enough
 * that a note cannot grow without bound — the note itself has a limit and its
 * margin needs one too.
 */
export const QUICK_NOTE_MAX_COMMENTS = MAX_COMMENTS;

/** The first thing wrong with this comment, or null. */
export function validateQuickNoteComment(text: string): string | null {
  return validateMarginComment(text, QUICK_NOTE_COMMENT_HTML_LABELS, 'Anything longer belongs in the note itself.');
}

/**
 * Files a note can carry (docs/agent-quick-notes.md, added 2026-08-17 on
 * Owner's ask): the menu photo beside the note about the menu, the PDF an
 * agent produced beside the note that says what it is. The bytes live in media
 * storage under the note's own prefix; the note's row carries only this
 * record, so a list of notes stays as cheap as it was.
 *
 * `addedByAgentId` follows the author fields' convention exactly — an agent's
 * id, or QUICK_NOTE_AUTHOR_USER for a file the user attached in the Workspace.
 *
 * Attaching is NOT editing. Any agent and the user may attach to (or take a
 * file off) any note, including one whose words they may not rewrite: the
 * Workspace's edit gate exists because rewriting an agent's WORDS leaves the
 * agent contradicting the note, and a file added alongside them changes no
 * words. It is the reasoning the margin runs on too, and it is why attaching
 * survived the ownership rule of note #637 while archiving did not: adding to
 * somebody's note leaves it standing where they put it, and taking it off
 * their desk does not.
 */
export interface QuickNoteAttachment {
  id: string;
  /** As uploaded, sanitized. Unique per note — the name is the CLI's handle. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** users/<uid>/notes/<noteId>/<attachmentId>/<fileName> in media storage. */
  storagePath: string;
  addedByAgentId: string;
  /** Human owner when {@link addedByAgentId} is the user sentinel. */
  addedByUserId?: string;
  addedAt: string;
}

/**
 * Per file and per note. A note is a jotting with receipts, not a drive: five
 * files is a menu, a floor plan and three photos. Up to 100 MB each since
 * note #784 (the owner: a screen recording or a phone video belongs on the
 * note it is about); anything past one upload part travels in parts
 * (`shared/uploads.ts`, `services/note-file-uploads.ts`).
 */
export const QUICK_NOTE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const QUICK_NOTE_MAX_ATTACHMENTS = 5;
/** The one-request upload a CLI from before note #784 still sends: its body
 *  is buffered whole, so it keeps the old ceiling. */
export const QUICK_NOTE_SINGLE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * An address this note used before it moved to another room (note #111).
 *
 * Notes are numbered inside a room namespace, so the pair — never the number
 * alone — is the old address. Keeping it lets structured work already linked
 * to that address follow the note after the move, and gives file cleanup every
 * namespace prefix the note may have written into over its life.
 */
export interface QuickNoteLocation {
  userId: string;
  number: number;
}

/**
 * One turn's exclusive right to act on a note (note #99).
 *
 * The lease is intentionally finite: a killed turn must not leave a request
 * locked forever. Starting the same note again renews it and, importantly,
 * takes a fresh fingerprint of everything the agent just reread. A proposal
 * is accepted only while that fingerprint still matches the note.
 */
export const QUICK_NOTE_CLAIM_LEASE_MS = 2 * 60 * 60_000;

export interface QuickNoteClaim {
  agentId: string;
  /** The human driving the claimant, for the same cross-org boundary notes use. */
  userId: string;
  /** Snapshot of the name at claim time, so another member's agent is named. */
  agentName: string;
  claimedAt: string;
  expiresAt: string;
  /** Hash of the body, margin and files the claimant actually reread. */
  fingerprint: string;
}

/** What a row shows as the note's name. Longer titles are cut, never wrapped. */
export const QUICK_NOTE_TITLE_MAX_LENGTH = 90;

/** How much of the body travels in a LIST, before the reader opens one. */
export const QUICK_NOTE_PREVIEW_MAX_LENGTH = 160;

export interface QuickNoteDocument {
  id: string;
  userId: string;
  /** Per storage namespace, human-facing: "note #3". A personal namespace is
   *  one user; a workplace namespace is shared by its members. */
  number: number;
  /**
   * Earlier room-scoped addresses, oldest first (note #111). Absent until the
   * first move. A return to an earlier room reuses its old number when that
   * address is still free; otherwise the destination allocates a new one.
   */
  previousLocations?: QuickNoteLocation[];
  /** The whole note, exactly as it was written. Its first line is its title. */
  html: string;
  createdByAgentId: string;
  /** Human owner behind the authoring agent, or the Workspace writer. */
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  /** Who last rewrote it — often not who created it. Agents belonging to that
   *  same human may pick it up; workplace teammates comment instead. */
  updatedByAgentId: string;
  /**
   * Human owner behind the last writer. This disambiguates the shared org
   * namespace's `user` sentinel: another member's note is human-written, but
   * it is not “written by you” and cannot be rewritten in your Workspace.
   * Absent on legacy personal notes, whose `userId` is the owner fallback.
   */
  updatedByUserId?: string;
  /**
   * Remarks on the note, oldest first — a thread reads down. Absent on a note
   * nobody has commented on, which is most of them.
   *
   * Kept ON the note rather than in a table of their own: a comment has no life
   * apart from the note it is about, it is deleted with it, and the note is
   * already one document that every surface fetches whole.
   */
  comments?: QuickNoteComment[];
  /** Files carried alongside the words. Absent on most notes. */
  attachments?: QuickNoteAttachment[];
  /**
   * Exclusive, expiring ownership of work sourced from this note (note #99).
   * Expired claims remain harmless historical bytes until the next write;
   * every reader goes through {@link activeQuickNoteClaim}.
   */
  claim?: QuickNoteClaim;
  /**
   * Who the user handed this note to, and when (notes #234/#258). Cleared the
   * moment any agent claims it — the claim is the stronger, truer statement of
   * the same thing, and leaving both would let a released note fall back to
   * "handed" after the agent had said it was not doing this.
   */
  handoff?: QuickNoteHandoff;
  /**
   * Put away, and out of every list that is not the archive (Owner, note
   * #23: "Notes should not be delete. It should be archived. And only from
   * archive a note can be deleted.").
   *
   * A STATE on the note, not a second store, and the note keeps everything it
   * had — its number, its words, its comments, its files. That is what makes
   * unarchiving free and what makes this different from the repo trash, which
   * moves bytes on a host and runs a clock. There is no clock here: an
   * archived note stays until somebody deletes it on purpose, which is the
   * whole of what the rule asks for.
   *
   * An archived note is READ-ONLY — no edit, no comment, no file on or off.
   * Not to protect it, but because a note being kept up to date inside the
   * archive is a live note in the wrong place, and the answer an agent
   * deserves is "bring it back first" rather than a write nobody will see.
   */
  archivedAt?: string;
  /** Who put it away — an agent's id, or {@link QUICK_NOTE_AUTHOR_USER}. */
  archivedByAgentId?: string;
}

/** The material whose movement makes an old claim stale. */
export function quickNoteFingerprint(
  doc: Pick<QuickNoteDocument, 'html' | 'updatedAt' | 'comments' | 'attachments' | 'archivedAt'>,
): string {
  const material = JSON.stringify({
    html: doc.html,
    updatedAt: doc.updatedAt,
    comments: (doc.comments ?? []).map((comment) => ({
      id: comment.id,
      text: comment.text,
      createdAt: comment.createdAt,
    })),
    attachments: (doc.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      addedAt: attachment.addedAt,
    })),
    archivedAt: doc.archivedAt,
  });
  return createHash('sha256').update(material).digest('hex');
}

/**
 * How long the Workspace says a note is HANDED to an agent (notes #234/#258).
 *
 * The same two hours a claim lasts, and for the same reason read from the
 * other end: a lease is how long an agent may hold a note before somebody
 * else may take it, so an agent that has not picked this one up in the time
 * its own claim would have run is not on it. Past that the note goes back to
 * Unclaimed on its own — nothing has to remember to clean it up, and a
 * handoff nobody answered cannot sit on the board looking like work in hand.
 */
export const QUICK_NOTE_HANDOFF_WINDOW_MS = QUICK_NOTE_CLAIM_LEASE_MS;

/**
 * The user gave this note to an agent, and the agent has not picked it up yet
 * (note #234: "there should be explicit state that it's handed off").
 *
 * The gap this fills is real and was invisible: handing a note over sends the
 * agent a message and touches nothing on the note, so the row kept saying
 * Unclaimed until the agent got round to `note start` — through the whole wake
 * and the whole read. The user, looking at their own board, could not tell the
 * notes they had already dealt out from the ones still waiting, and the honest
 * answer to "did that send?" was to open the agent's chat.
 *
 * A handoff is NOT a claim and deliberately does not act like one. It takes no
 * lease, fences no agent out and is written by the person rather than won by
 * the worker — every atomic guarantee note #99 built stays exactly where it
 * was. What it records is one fact with a clock on it: this was asked of this
 * agent at this moment. The claim, when it comes, replaces it.
 */
export interface QuickNoteHandoff {
  agentId: string;
  /** The name at handoff time, so a retired agent still names who was asked —
   *  the same snapshot, for the same reason, a claim keeps. */
  agentName: string;
  /** The PERSON who handed it over, for the rooms a note can be shared in. */
  userId: string;
  handedAt: string;
  expiresAt: string;
}

/** A claim that has not expired, or null. Invalid legacy timestamps expire. */
export function activeQuickNoteClaim(
  doc: Pick<QuickNoteDocument, 'claim'>,
  now: Date = new Date(),
): QuickNoteClaim | null {
  const claim = doc.claim;
  if (!claim) return null;
  const expiresAt = Date.parse(claim.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime() ? claim : null;
}

/** A handoff still inside its window, or null — read exactly like a claim,
 *  including the rule that an unparseable timestamp has expired. */
export function activeQuickNoteHandoff(
  doc: Pick<QuickNoteDocument, 'handoff'>,
  now: Date = new Date(),
): QuickNoteHandoff | null {
  const handoff = doc.handoff;
  if (!handoff) return null;
  const expiresAt = Date.parse(handoff.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime() ? handoff : null;
}

/** Is this note in the archive? The one test every surface asks. */
export function quickNoteIsArchived(doc: Pick<QuickNoteDocument, 'archivedAt'>): boolean {
  return Boolean(doc.archivedAt);
}

/**
 * A row as it may actually be on disk. Notes shipped plain-text first
 * (2026-08-16) and became HTML hours later, so a handful of `text` rows exist
 * and must keep reading correctly — see `normalizeQuickNote`.
 */
export type StoredQuickNote = Omit<QuickNoteDocument, 'html'> & {
  html?: string;
  /** The pre-HTML field. Plain text, and read as plain text. */
  text?: string;
};

/**
 * One stored row as the rest of the code may assume it is: HTML, always.
 *
 * A legacy plain-text note is CONVERTED on read rather than migrated in place
 * — the conversion is pure and cheap, it survives a restore from a backup
 * taken before the change, and it means no write ever has to run against
 * everyone's data to make a format change land. The first edit rewrites the
 * row in the new shape on its own.
 */
export function normalizeQuickNote(doc: StoredQuickNote): QuickNoteDocument {
  const { text, ...rest } = doc;
  if (typeof rest.html === 'string' && rest.html) return rest as QuickNoteDocument;
  return { ...rest, html: textToSafeHtml(text ?? '') };
}

/**
 * The first thing wrong with this note, or null. Thin on purpose: everything
 * here beyond "it exists, it fits, it is the HTML we display" would be a rule
 * an agent has to remember before jotting.
 */
export function validateQuickNoteHtml(html: string): string | null {
  if (!html.trim()) return 'A note needs some text.';
  if (html.length > QUICK_NOTE_MAX_LENGTH) {
    return `A quick note is at most ${QUICK_NOTE_MAX_LENGTH} characters (this one is ${html.length}). Anything longer wants to be a knowledge page.`;
  }
  return validateSafeHtml(html, QUICK_NOTE_HTML_LABELS);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** The first block-level chunk of a fragment, as source. */
function firstBlock(html: string): string {
  // A heading wins wherever it is, because an agent that wrote one meant it as
  // the note's name. Otherwise the first block element, otherwise the lot —
  // a note that is one bare sentence is titled by that sentence.
  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  if (heading) return heading[1]!;
  const block = /<(p|li|div|td|th|blockquote|dt|dd|figcaption|summary)[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  if (block) return block[2]!;
  const upToBreak = html.split(/<br\s*\/?>/i)[0]!;
  return upToBreak;
}

/**
 * The note's name: its first heading or first block, as plain words. Every
 * surface shows this — the row on home, the screen's own heading, the line the
 * CLI prints — so it is derived ONCE, here.
 */
export function quickNoteTitle(html: string): string {
  const title = htmlToText(firstBlock(html));
  // A fragment whose first block is empty (an image, a stray wrapper) still
  // needs a name: fall back to whatever words the note does have.
  return clip(title || htmlToText(html), QUICK_NOTE_TITLE_MAX_LENGTH);
}

/**
 * Everything after the title, on one line, for a list. Empty when the note IS
 * its title — a one-line note has said all of itself in the row's first line,
 * and repeating it underneath reads as a rendering fault.
 */
export function quickNotePreview(html: string): string {
  const whole = htmlToText(html);
  const title = htmlToText(firstBlock(html));
  const rest = title && whole.startsWith(title) ? whole.slice(title.length).trim() : whole;
  return clip(rest, QUICK_NOTE_PREVIEW_MAX_LENGTH);
}

/**
 * One remark, shortened to what a row has room to show of it: its FIRST
 * SENTENCE, whole.
 *
 * A comment is stored as semantic HTML, so the row takes only its visible
 * words. What there ALSO is is line structure: a comment may run to a thousand
 * characters over several paragraphs, and pasted into a row those breaks
 * become gaps a reader reads as the end of the sentence. So it is collapsed
 * to single spaces first.
 *
 * Then it is cut at the first full stop rather than at a character count, and
 * that is the whole design. An agent's remark almost always opens with the
 * answer and then spends three more sentences on the detail — "Diagnosed and
 * fixed — proposal #157 is in your chat." followed by which column was wrong
 * and how it was checked. Cut by length, the row ends "…is in your…", which
 * promises an answer and withholds it. Cut at the stop, the row carries a
 * complete thought and the detail stays where it belongs, inside the note
 * (Owner, 2026-08-18, off a photo of his own phone).
 *
 * The length cap survives as a backstop, for the remark written as one
 * enormous sentence and for the one with no full stop in it at all.
 */
export function quickNoteCommentPreview(text: string): string {
  // Stripping an inline tag leaves a defensive space on either side. Keep it
  // between words, but not before punctuation or just inside parentheses —
  // `<strong>fixed</strong>.` reads "fixed.", not "fixed .".
  const flat = htmlToText(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)}\]])/g, '$1')
    .replace(/([({\[])\s+/g, '$1')
    .trim();
  // Long enough in front of the stop that a version number or an "e.g." does
  // not end the sentence on the row, and the terminator has to be followed by
  // a space or the end — "1.14.0" is not a sentence, "…in your chat." is.
  const sentence = /^(.{20,}?[.!?])(?:\s|$)/.exec(flat);
  const first = sentence ? sentence[1]! : flat;
  return clip(first, QUICK_NOTE_PREVIEW_MAX_LENGTH);
}

/**
 * A note back in the plain text it was typed as, for the box the user edits it
 * in — the exact inverse of `textToSafeHtml`, which is what wrote it.
 *
 * Only ever asked for a note the USER wrote, and that is the point: those are
 * paragraphs and line breaks and nothing else, so this round-trips them whole.
 * An agent's note is HTML with tables and lists in it, which no text box can
 * hold — which is a second reason the Workspace does not offer to edit one.
 */
export function quickNoteEditableText(html: string): string {
  return editableTextFromSafeHtml(html);
}

/** One note as every list shows it — the CLI's and the Workspace's. */
export interface QuickNoteSummary {
  id: string;
  number: number;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  /** Present only when the user wrote it themselves. Absent, not false, for the
   *  same reason a retired agent's name is dropped: a row says who touched a
   *  note or says nothing, and "byUser: false" is a fact nobody displays. */
  byUser?: true;
  /** How many remarks hang off it, absent when none. A list is where an agent
   *  finds out a comment exists at all — nothing pushes one at it. */
  comments?: number;
  /** How many files ride along. Absent when none do, like `byUser`. */
  files?: number;
  /** When it was put away. Absent — not false — on a live note, like every
   *  other conditional field here: a live row says nothing about the archive.
   *  Present on a row only ever drawn in the archive, which sounds redundant
   *  until a note is opened from a stale list and has to know what it is. */
  archivedAt?: string;
}

export function summarizeQuickNote(doc: QuickNoteDocument): QuickNoteSummary {
  return {
    id: doc.id,
    number: doc.number,
    title: quickNoteTitle(doc.html),
    preview: quickNotePreview(doc.html),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    // Carried by the summary rather than looked up per surface: an agent
    // reading `note list` needs this as much as the Workspace does — a note in
    // the user's own words is one to add to, not one to rewrite.
    ...(quickNoteIsUsers(doc) ? { byUser: true as const } : {}),
    ...(doc.comments?.length ? { comments: doc.comments.length } : {}),
    ...(doc.attachments?.length ? { files: doc.attachments.length } : {}),
    ...(doc.archivedAt ? { archivedAt: doc.archivedAt } : {}),
  };
}

/**
 * The first thing wrong with an upload, or null. The name check matters most:
 * the file name is the handle the CLI addresses a file by and a path segment
 * in storage, so a name that survives sanitizeStorageSegment unchanged is the
 * only kind accepted — an agent that uploads "результат (1).pdf" should be
 * told to rename it, not have it silently become something else.
 */
export function validateQuickNoteAttachment(args: {
  fileName: string;
  sizeBytes: number;
  existing: ReadonlyArray<Pick<QuickNoteAttachment, 'fileName'>>;
}): string | null {
  if (!args.fileName || args.fileName.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.fileName)) {
    return 'File names here are letters, digits, dots, dashes and underscores (up to 120 characters) — rename the file and attach it again.';
  }
  if (args.sizeBytes <= 0) return 'The upload arrived empty.';
  if (args.sizeBytes > QUICK_NOTE_ATTACHMENT_MAX_BYTES) {
    return `A note carries files up to ${QUICK_NOTE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB — this one is ${(args.sizeBytes / 1024 / 1024).toFixed(1)} MB. Something that size belongs in Drive.`;
  }
  // Duplicate before count: a re-upload of a name the note already has is a
  // duplicate whether or not there is room, and "take one off" is the wrong
  // advice for it.
  if (args.existing.some((a) => a.fileName === args.fileName)) {
    return `This note already has a file named ${args.fileName} — take it off first, or use another name.`;
  }
  if (args.existing.length >= QUICK_NOTE_MAX_ATTACHMENTS) {
    return `A note carries at most ${QUICK_NOTE_MAX_ATTACHMENTS} files. Take one off first, or start another note.`;
  }
  return null;
}

/** Where a note's file lives in media storage. The note's own prefix, so
 *  deleting the note can clear everything under it in one call. */
export function quickNoteAttachmentPath(
  userId: string,
  noteId: string,
  attachmentId: string,
  fileName: string,
): string {
  return ['users', userId, 'notes', noteId, attachmentId, fileName].join('/');
}

export function quickNoteStoragePrefix(userId: string, noteId: string): string {
  return ['users', userId, 'notes', noteId, ''].join('/');
}
