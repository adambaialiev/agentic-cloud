import { COMMENT_HTML_LABELS, validateMarginComment, type MarginComment } from './comment.js';
import { validateSafeHtml, decodeHtmlText, type SafeHtmlLabels } from './safe-html.js';

/**
 * Knowledge pages (docs/agent-knowledge-pages.md): one HTML file per page,
 * read RENDERED by the owner in the Workspace and read as SOURCE by agents
 * from the CLI, and changed only through a proposal the owner approves.
 *
 * The sibling of the repo system, deliberately not the same thing: a repo is a
 * tree an agent clones and branches, a page is one document with a name. The
 * gate is identical in shape — nothing agent-facing can approve.
 */

/** Generous for a document; small enough that an agent reading one is cheap. */
export const KNOWLEDGE_PAGE_MAX_BYTES = 1024 * 1024;

/** One proposal's total payload. A cap on the row, not a product promise. */
export const KNOWLEDGE_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;

/** Enough that nobody meets it by writing; low enough to bound the base. */
export const KNOWLEDGE_BASE_MAX_PAGES = 200;

export const MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH = 120;
export const MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH = 2000;
export const MAX_KNOWLEDGE_DECISION_NOTE_LENGTH = 500;

/**
 * Same shape as a repo name, for the same reason: it becomes a path segment
 * (`pages/<name>.html`) and a URL segment, and one namespace's rules being
 * memorable matters more than either being maximally permissive.
 */
export const KNOWLEDGE_PAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/;

export function validateKnowledgePageName(name: string): string | null {
  // Before the pattern, which would refuse this for the dot and say something
  // less useful: passing a filename is the mistake worth naming outright.
  if (name.endsWith('.html')) {
    return 'Leave the ".html" off — a page name is a name, not a filename.';
  }
  if (!KNOWLEDGE_PAGE_NAME_PATTERN.test(name)) {
    return 'Page names are 2–62 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.';
  }
  return null;
}

/**
 * The first thing wrong with a rename, or null.
 *
 * Both names are page names, and they have to differ — a rename to the same
 * address is a proposal that asks the reader to approve nothing.
 */
export function validateKnowledgeRename(from: string, to: string): string | null {
  for (const [name, which] of [[from, 'The page being renamed'], [to, 'The new name']] as const) {
    const error = validateKnowledgePageName(name);
    if (error) return `${which}: ${error}`;
  }
  if (from === to) return `"${from}" is already its name — a rename has to move it somewhere.`;
  return null;
}

/** Where one page lives inside the user's knowledge base. */
export function knowledgePagePath(name: string): string {
  return `pages/${name}.html`;
}

/**
 * A file a knowledge PAGE carries (Owner, notes #10 and #18).
 *
 * The point of these is not a download list — it is that a page can SHOW a
 * picture. Until now the only way to put an image in a page was an absolute
 * `https://` URL to something outside the account, or a base64 `data:` URI
 * inline, which means a megabyte of encoded bytes in the middle of the source
 * every agent reads and every proposal diffs. A page's own diagram now has a
 * place to live, and the page points at it: `<img src="files/chart.png">`.
 *
 * The record is `QuickNoteAttachment`'s and `PullRequestAttachment`'s, a third
 * time. The two things that ARE different here both come from the gate:
 *
 *   - the file rides a PROPOSAL and lands with the page, because a diagram
 *     can mislead exactly as a paragraph can, and the user approves what a
 *     page says;
 *   - the record lives in the base's `index.json` and therefore in git, beside
 *     the title and description it already keeps there. Only the RECORD — the
 *     bytes stay in media storage, since a git base is no place for photos.
 */
export interface KnowledgePageAttachment {
  id: string;
  /** As uploaded, sanitized. Unique per page — and the name a page's own
   *  `<img src="files/NAME">` points at, which is why it is the handle. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** users/<uid>/knowledge/<page>/<attachmentId>/<fileName> in media storage. */
  storagePath: string;
  addedByAgentId: string;
  addedAt: string;
}

/** Per file and per page — the numbers a note and a proposal already use. */
export const KNOWLEDGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_MAX_ATTACHMENTS = 5;

/**
 * How a page points at its own file. Deliberately ONE shape and no other:
 * `files/<name>`, resolved against the page it is written in.
 *
 * Relative and rooted URLs are already accepted by `validateSafeHtml` (they
 * are not schemes, so nothing there refuses them) and are already DROPPED by
 * the Workspace's renderer, which allows only anchors, absolute URLs and
 * `data:` images. So this prefix is not a hole being opened — it is the one
 * relative form that now means something, and it means "a file on this page".
 */
export const KNOWLEDGE_FILE_SRC_PREFIX = 'files/';

/** The file this `src` names, or null if it is not a page-file reference. */
export function knowledgeFileRef(src: string): string | null {
  const value = String(src ?? '').trim();
  if (!value.startsWith(KNOWLEDGE_FILE_SRC_PREFIX)) return null;
  const name = value.slice(KNOWLEDGE_FILE_SRC_PREFIX.length);
  // No traversal, no nesting, no query: the name is a file ON this page and
  // nothing else can be addressed through it.
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return name;
}

/**
 * The first thing wrong with an upload, or null. The note's rule, a third
 * time — with one addition that is specific to pages: the name ends up inside
 * the page's own markup as `files/<name>`, so it has to survive being written
 * by hand as well as being a storage segment.
 */
export function validateKnowledgeAttachment(args: {
  fileName: string;
  sizeBytes: number;
  existing: ReadonlyArray<Pick<KnowledgePageAttachment, 'fileName'>>;
}): string | null {
  if (!args.fileName || args.fileName.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.fileName)) {
    return 'File names here are letters, digits, dots, dashes and underscores (up to 120 characters) — rename the file and attach it again. The page points at it by this name.';
  }
  if (args.sizeBytes <= 0) return 'The upload arrived empty.';
  if (args.sizeBytes > KNOWLEDGE_ATTACHMENT_MAX_BYTES) {
    return `A page carries files up to ${KNOWLEDGE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB — this one is ${(args.sizeBytes / 1024 / 1024).toFixed(1)} MB.`;
  }
  if (args.existing.some((a) => a.fileName === args.fileName)) {
    return `This page already has a file named ${args.fileName} — attach it under another name, or take the old one off in the same proposal.`;
  }
  if (args.existing.length >= KNOWLEDGE_MAX_ATTACHMENTS) {
    return `A page carries at most ${KNOWLEDGE_MAX_ATTACHMENTS} files. Take one off first.`;
  }
  return null;
}

/** Where one page's file lives in media storage. Keyed by the PAGE, not by
 *  the proposal that landed it: a file outlives the change that added it. */
export function knowledgeAttachmentPath(
  userId: string,
  page: string,
  attachmentId: string,
  fileName: string,
): string {
  return ['users', userId, 'knowledge', page, attachmentId, fileName].join('/');
}

/** Every attachment belonging to one room's knowledge base, including files
 *  still staged on proposals that never landed. */
export function knowledgeStoragePrefix(userId: string): string {
  return ['users', userId, 'knowledge', ''].join('/');
}

export interface KnowledgePageMeta {
  title: string;
  description: string;
}

export interface KnowledgePageSummary extends KnowledgePageMeta {
  name: string;
  sizeBytes: number;
  /** The blob's sha — what a proposal pins to detect that a page MOVED. */
  sha: string;
  updatedAt?: string;
  /**
   * The agent whose proposal last landed this page — recorded in the index at
   * landing time, so a row can wear its face the way a site's and a note's do.
   *
   * Absent for every page landed before this was recorded, and for a page read
   * off disk when the index has no entry for it: the row then keeps its
   * description and simply has no face, which is the same fallback a deleted
   * agent leaves behind.
   */
  updatedByAgentId?: string;
  /** The room namespace the page came from (note #566) — a label on a shelf
   *  the whole workplace shares, never a permission. Absent means the room
   *  standing at the shelf's own namespace, or a personal account. */
  originNamespaceId?: string;
  /** The files the page carries, from the index. Absent when it carries none,
   *  which is nearly all of them. */
  attachments?: KnowledgePageAttachment[];
}

/**
 * One page's change inside a proposal. The HTML travels WITH the proposal
 * rather than sitting on a branch: a one-file document has nothing to gain
 * from a branch, and this way an unapproved page is nowhere a reader can
 * reach it.
 */
export interface KnowledgePageChange {
  /**
   * The page this change is about — and on a RENAME, the name it has TODAY.
   * Everything keyed off this field wants the old name: `baseSha` is compared
   * against the page standing under it, and the index entry being carried
   * forward is filed under it. The new name is `renameTo`.
   */
  page: string;
  action: 'create' | 'edit' | 'delete' | 'rename';
  /**
   * Where a rename puts the page. Present only on a rename, and validated as
   * a page name in its own right.
   *
   * A rename exists because the alternative was delete-and-recreate, which
   * takes the page's whole margin with it (`knowledge-page-comments.ts`) —
   * so the names of five of this room's pages went on describing a product
   * we no longer have rather than pay that. It carries the page's bytes like
   * an edit does, so a proposal is still a complete picture of what lands,
   * and the words are deliberately untouched: an address is not a title.
   */
  renameTo?: string;
  /** Absent on a delete. */
  html?: string;
  /**
   * The files this page will have ONCE THIS LANDS — the whole set, not the
   * additions. Computed by the propose route from what the page carries today
   * plus what the agent attached minus what it detached, for the same reason
   * the html is carried whole: a proposal is a picture of the page as it will
   * be, and the user approves that picture rather than a patch of it.
   *
   * Absent on a change that neither adds nor removes one, which then leaves
   * the page's existing files exactly as they are.
   */
  attachments?: KnowledgePageAttachment[];
  /** Extracted at propose time; what the card and `list` show. Absent on a delete. */
  title?: string;
  description?: string;
  bytes?: number;
  /**
   * The blob sha this change was written against — null when the page did not
   * exist. Re-checked at approval: if the page moved in between, the proposal
   * is refused rather than silently clobbering what landed.
   */
  baseSha?: string | null;
  /**
   * The page's words BEFORE this change landed (note #746) — what "put it
   * back" restores. Recorded by the landing itself, so a change applied
   * without anybody's approval still leaves the way back in one step. Absent
   * on a create (there was no page) and on changes landed before this was
   * kept.
   */
  previousHtml?: string;
  /** The names of the files a removal took off the page (their bytes are
   *  cleared with the removal), so a restore can say what did not come back. */
  previousFiles?: string[];
}

export type KnowledgeProposalStatus =
  | 'open'       // waiting for the owner
  | 'approved'   // landed on the knowledge base
  | 'rejected'   // the owner declined
  | 'withdrawn'  // the proposing agent closed it
  | 'conflict';  // a page moved underneath it; the agent must redo it

export interface KnowledgeProposalDocument {
  id: string;
  /** The knowledge base's NAMESPACE (see GitRepoDocument.userId) — the org's
   *  shared one for members of a stamped org, not necessarily the proposer. */
  userId: string;
  /** The proposing agent's OWNER — whose chat the outcome wakes and the only
   *  human allowed to decide. Absent on proposals from before the org layer;
   *  possession of the proposing agent record is the fallback proof. */
  createdByUserId?: string;
  /** Per user, human-facing: "knowledge proposal #3". One base per user, so
   *  this counter is per user rather than per repo. */
  number: number;
  title: string;
  note?: string;
  changes: KnowledgePageChange[];
  createdByAgentId: string;
  createdAt: string;
  status: KnowledgeProposalStatus;
  /**
   * Recorded, and NOT yet put in front of the user (Owner, note #293, then
   * "do the same with knowledge page proposals"). Same contract as a change
   * proposal's `draft`: `knowledge propose` records the pages quietly — no
   * card, no notification, no queue row, no decision possible — and
   * `agentbuilt knowledge proposals ready <n>` is the invitation, run when
   * the agent has nothing left to do. Absent on every proposal recorded
   * before this existed; absent again once shown. Only ever `true`.
   */
  draft?: true;
  /**
   * Applied by the agent itself the moment it was written (note #746): no
   * card, no tap, the owner told rather than asked. Such a record is the
   * page's HISTORY — who, when, why, and the words before — and `restore`
   * writes another of them.
   */
  direct?: true;
  /** When this record is a restore: the page it put back and the record
   *  whose version it put back (absent = the version before the last change). */
  restoreOf?: { page: string; toNumber?: number };
  /** When the agent invited the user to decide it. Absent on legacy
   *  proposals, which were shown the moment they were created. */
  readyAt?: string;
  /**
   * The agent that ran `knowledge proposals ready` — whose chat the ask card went to. Usually
   * the proposer, but a reviewing agent may put a colleague's proposal in
   * front of the owner (note #684), and then the decision has two chats to
   * land on: the proposer's, which is woken as always, and this one, where the
   * card sits saying "Awaiting approval" and where the reviewer waits to hear.
   * Absent on legacy proposals, which were shown by their proposer at creation.
   */
  readyByAgentId?: string;
  decidedAt?: string;
  /** Always the owner — an agent can never appear here. */
  decidedBy?: string;
  decisionNote?: string;
  /** The commit an approval created on the knowledge base. */
  commitSha?: string;
  /**
   * The proposal's margin (Owner, note #66) — the same remarks a change
   * proposal on a repo carries, for the same conversation: what anyone in the
   * workplace has to say ABOUT the change, under it, while it is still
   * being decided. Kept on the document like a note's.
   */
  comments?: MarginComment[];
}

/**
 * Whether this proposal is a question the user can answer right now: open,
 * AND the agent has said it is ready. Every decision surface asks this — the
 * queue, the room tab's dot, the decision route, the decision flow — so a
 * quiet proposal cannot be approved from any of them.
 */
export function knowledgeProposalAwaitsDecision(
  doc: Pick<KnowledgeProposalDocument, 'status' | 'draft' | 'direct'>,
): boolean {
  // A direct change (note #746) is never a question for the person — not
  // even in the instant between its record and its landing.
  return doc.status === 'open' && !doc.draft && !doc.direct;
}

/**
 * Whether a proposal in this state still takes a remark. Open does, and so
 * does `conflict` — still being worked on and about to be re-proposed. A
 * decided proposal is not a question any more; what follows an approval
 * belongs in chat or on a note.
 */
export function knowledgeProposalTakesComments(status: KnowledgeProposalStatus): boolean {
  return status === 'open' || status === 'conflict';
}

/** The first thing wrong with a remark on a proposal or a page, or null. */
export function validateKnowledgeComment(text: string): string | null {
  return validateMarginComment(text, COMMENT_HTML_LABELS, 'Anything longer wants to be a change to the page itself.');
}

export function validateKnowledgeProposalTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length < 3) return 'A proposal title needs at least 3 characters.';
  if (trimmed.length > MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH) {
    return `Keep the title under ${MAX_KNOWLEDGE_PROPOSAL_TITLE_LENGTH} characters — it has to fit in a Telegram notification.`;
  }
  return null;
}

/**
 * The `--note "why this"`, held to its limit out loud — the same silent slice
 * a change proposal's body carried, on the same kind of object: the sentences
 * the user reads before approving (note #320).
 *
 * The limit itself stays 2000 where the change proposal's body was raised,
 * because the two do different jobs. A change proposal's body IS the argument
 * — there is nowhere else for it to live. This note only covers pages that
 * carry the substance themselves, and the reader has them right there.
 */
export function validateKnowledgeProposalNote(note: string): string | null {
  if (note.length > MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH) {
    return `A proposal note is at most ${MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH} characters (this one is ${note.length}). It says why the pages should land; the pages say the rest.`;
  }
  return null;
}

// ── What a page may contain ────────────────────────────────────────────────

/**
 * Semantic HTML only: no author CSS, no JavaScript (the doc's "What a page may
 * contain"). The rules themselves live in `safe-html.ts` and are shared with
 * quick notes — two formats the Workspace renders the same way, so an
 * allowlist each would be two allowlists drifting apart. Only the WORDING is
 * per-format, because an error that names the wrong thing teaches the wrong
 * lesson.
 */
export const KNOWLEDGE_HTML_LABELS: SafeHtmlLabels = {
  one: 'a knowledge page',
  many: 'Knowledge pages',
  thing: 'page',
};

/**
 * The first thing wrong with this page, or null. First rather than all: an
 * agent fixes one rule and re-runs, and a wall of errors mostly repeats the
 * same misunderstanding.
 */
export function validateKnowledgeHtml(html: string): string | null {
  if (Buffer.byteLength(html, 'utf8') > KNOWLEDGE_PAGE_MAX_BYTES) {
    return `A knowledge page is at most ${Math.round(KNOWLEDGE_PAGE_MAX_BYTES / 1024)} KB.`;
  }
  if (!html.trim()) return 'The page is empty.';
  return validateSafeHtml(html, KNOWLEDGE_HTML_LABELS);
}

/**
 * A page's title and description, read from the page itself. Required, both of
 * them: the description is what `knowledge list` prints and what the Workspace
 * shows under the name, and a page nobody can identify from a list is a page
 * nobody opens.
 */
export function readKnowledgePageMeta(html: string): KnowledgePageMeta | { error: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtmlText(titleMatch[1]!).replace(/\s+/g, ' ') : '';
  if (!title) {
    return { error: 'The page needs a <title> — it is the name your user sees on it.' };
  }
  if (title.length > 120) {
    return { error: 'Keep the <title> under 120 characters.' };
  }
  const descMatch = /<meta[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html);
  const contentMatch = descMatch ? /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(descMatch[0]) : null;
  const description = contentMatch ? decodeHtmlText(contentMatch[2] ?? contentMatch[3] ?? '').replace(/\s+/g, ' ') : '';
  if (!description) {
    return {
      error: 'The page needs a one-line description: <meta name="description" content="...">. It is what `knowledge list` shows, and what tells another agent whether this is the page it wants.',
    };
  }
  if (description.length > 200) {
    return { error: 'Keep the description under 200 characters — it is one line in a list.' };
  }
  return { title, description };
}
