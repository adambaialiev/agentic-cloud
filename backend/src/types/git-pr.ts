/**
 * A change proposal on an internal repo (docs/agent-git-phase2-review.md).
 *
 * The gate exists for the HUMAN: agents propose, the user approves from
 * Telegram, and only that approval moves the protected branch. Nothing in the
 * agent-facing surface can approve — see the absent verb in the CLI.
 */

import { COMMENT_HTML_LABELS, validateMarginComment, type MarginComment } from './comment.js';
import type { PullRequestAutoApproval, PullRequestAutoApproveFallback } from '../shared/auto-approve.js';

export type GitPullRequestStatus =
  | 'open'      // waiting for the user
  | 'merged'
  | 'rejected'  // the user declined
  | 'withdrawn' // the proposing agent closed it
  | 'stale'     // legacy: a moved branch used to end a proposal; open ones now refresh instead
  | 'conflict'; // cannot merge cleanly; the agent must rebase and re-propose

export interface GitPullRequestDocument {
  id: string;
  repoId: string;
  /** The repo's NAMESPACE (see GitRepoDocument.userId) — not necessarily the
   *  proposer: on a shared org repo that is the org's namespace. */
  userId: string;
  /**
   * The room namespace the proposing agent was working from. This differs
   * from `userId` when a repository is shared into another room: `userId`
   * keeps naming the repo's physical home, while this field keeps the
   * proposal in the room whose agent asked for the decision.
   *
   * Optional for proposals recorded before repositories could be shared.
   */
  roomNamespaceId?: string;
  /**
   * The proposing agent's OWNER — whose chat the outcome wakes and the only
   * human allowed to decide. Absent on proposals from before the org layer;
   * ownership then falls back to possession of the proposing agent record.
   */
  createdByUserId?: string;
  /** Per repo, human-facing: "PR #3". */
  number: number;
  title: string;
  body?: string;
  sourceBranch: string;
  targetBranch: string;
  /**
   * Pinned at creation, RE-PINNED on every later push to the source branch,
   * and re-verified at merge. The user approves a DIFF: the decision carries
   * the sha the decider was shown, and a mismatch refreshes the proposal and
   * asks again rather than landing work nobody read.
   */
  headSha: string;
  baseSha?: string;
  diffStat: { files: number; insertions: number; deletions: number };
  commitSubjects: string[];
  /**
   * Quick-note requests this proposal implements (note #99). Optional because
   * not every change starts on a note and legacy proposals predate the link.
   * Several notes may deliberately share one implementation.
   */
  quickNoteNumbers?: number[];
  /**
   * The room whose quick notes the numbers above address. Usually this is the
   * repository's own namespace and legacy documents omit it. A repository
   * shared into another room (note #108) can implement work requested there,
   * where note #12 is a different document from home-room note #12.
   */
  quickNoteNamespaceId?: string;
  /**
   * Set whenever a push moved the pin after creation. Its real job is the
   * pre-refresh Telegram cards: a decision arriving WITHOUT a shown sha is
   * only safe to act on while the pin still is what that card displayed.
   */
  refreshedAt?: string;
  /**
   * The proposing agent asked for its branch to land as ONE squashed commit.
   * Chosen at creation, by the agent: the diff the user approves is identical
   * either way — history shape is merge mechanics, not part of the gate.
   */
  squash?: boolean;
  createdByAgentId: string;
  createdAt: string;
  status: GitPullRequestStatus;
  /**
   * Recorded, and NOT yet put in front of the user (Owner, note #293).
   *
   * `pr create` used to be the ask itself: the card, the browser notification
   * and the queue row all landed the instant the proposal existed, while the
   * agent was still attaching screenshots, re-running checks, or finding the
   * bug it would fix in the next push. The owner could approve a change its
   * author was not finished with. So a proposal now starts quiet — visible to
   * the agent (`pr list`, `pr show`) and editable, but with no card, no
   * notification, no queue row, and no decision possible — until the agent
   * runs `agentbuilt pr ready <n>` to say it has nothing left to do.
   *
   * Absent on every proposal recorded before this existed, which were all
   * shown at creation; absent again once shown. Only ever `true`.
   */
  draft?: true;
  /** When the agent invited the user to decide it (`pr ready`). Absent on
   *  legacy proposals, which were shown the moment they were created. */
  readyAt?: string;
  /**
   * The agent that ran `pr ready` — whose chat the ask card went to. Usually
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
  /** Optional reason, relayed to the agent: "no" alone makes it retry blindly. */
  decisionNote?: string;
  /**
   * Merged by auto-approve mode (note #944), not by a person: `decidedBy`
   * stays empty, because nobody read it, and this says which mode did —
   * turned on when, by whom. Every surface that names the decider reads it.
   */
  autoApproved?: PullRequestAutoApproval;
  /**
   * Auto-approve was on when this was made ready but did not merge it — the
   * checks held it, or the merge failed — so it waits for its owner like any
   * other proposal, with the reason shown. Cleared by nothing: a later
   * decision simply stands beside it.
   */
  autoApproveFallback?: PullRequestAutoApproveFallback;
  mergeCommitSha?: string;
  /**
   * The instant the approved merge started, before the target ref moved.
   *
   * A fast-forward landing reuses the proposal head SHA, so the status store
   * contains two runs under the same key: the source-branch checks the user
   * approved, then the protected-branch checks and deploys that deliver it.
   * This cutoff is what lets the proposal screen show only the latter as the
   * delivery run. Optional for proposals decided before that screen existed.
   */
  deliveryStartedAt?: string;
  /** Files shown beside the decision. Absent on most proposals. */
  attachments?: PullRequestAttachment[];
  /**
   * The proposal's margin (Owner, note #66): remarks UNDER the change from
   * anyone in the workplace — the proposing agent adding what it learned,
   * a teammate's agent flagging a collision, the person asking on the record.
   * The shared shape notes grew first; kept ON the document for the same
   * reason a note's are — a comment has no life apart from the proposal, and
   * the proposal is one document every surface fetches whole.
   */
  comments?: MarginComment[];
}

/**
 * A file the proposal CARRIES (Owner, notes #10 and #18): the screenshot of
 * the screen that changed, the export the change produced, the photo of the
 * thing on a bench.
 *
 * A proposal is decided on a phone, and what a phone can show of a diff is
 * thin. The body already says what changed in words; this is the half a
 * sentence cannot carry — "here is what the pricing page looks like now",
 * attached to the very card the decision is made on. Until this existed an
 * agent's only way to show one was to send it into the chat separately, where
 * it arrives detached from the proposal it is about and is scrolled past.
 *
 * The same record a note's file is (`QuickNoteAttachment`), deliberately: two
 * stores, one shape, so the CLI's verbs and the Workspace's card work the same
 * way on both and neither has to be learnt twice.
 *
 * `addedByAgentId` follows the document's own convention — an agent's id, or
 * QUICK_NOTE_AUTHOR_USER for a file the user put on in the Workspace.
 */
export interface PullRequestAttachment {
  id: string;
  /** As uploaded, sanitized. Unique per proposal — the name is the handle. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** users/<uid>/prs/<prId>/<attachmentId>/<fileName> in media storage. */
  storagePath: string;
  addedByAgentId: string;
  addedAt: string;
  /** A picture's pixel size, read from its header when it was attached
   *  (note #825) — so the sheet can draw its frame at the right shape before
   *  a byte of it arrives. Absent for anything that is not a picture, and
   *  for pictures attached before it was recorded (measured once on first
   *  read, and written back). */
  width?: number;
  height?: number;
}

/**
 * Per file and per proposal — the same numbers a note carries, for the same
 * reason: five files is a before, an after and three details, and past 10 MB
 * the thing being attached is an artifact that belongs in the branch itself.
 */
export const PR_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PR_MAX_ATTACHMENTS = 5;

export const MAX_PR_TITLE_LENGTH = 120;
/**
 * The write-up, and the reason it is not 2000 any more (note #320).
 *
 * 2000 was the opening guess, and nothing downstream ever needed it: the
 * Telegram card quotes only the first `MAX_PROPOSAL_CARD_NOTE_LENGTH`
 * characters and cuts them on a word boundary, and the proposal screen folds
 * a tall body behind "Read more" (`FoldLong`). The cap bounds the row, and
 * that is all it does.
 *
 * Meanwhile the body became markdown that the screen RENDERS, so the same
 * argument costs more characters than it used to — the reasoning that first
 * put `QUICK_NOTE_MAX_LENGTH` at 8000, on the same kind of object: a document
 * an agent writes and the user reads in the Workspace. So this is that number
 * (the note limit has since grown to 100,000 for whole plans, note #676; a
 * proposal's body is a summary of a diff, not the document, so it stays).
 * A real write-up now never meets the ceiling, and one that does is refused
 * out loud rather than trimmed.
 */
export const MAX_PR_BODY_LENGTH = 8000;
/** A rejection reason is a sentence to the agent, not an essay. */
export const MAX_PR_DECISION_NOTE_LENGTH = 500;

export function validatePullRequestTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length < 3) return 'A PR title needs at least 3 characters.';
  if (trimmed.length > MAX_PR_TITLE_LENGTH) {
    return `Keep the title under ${MAX_PR_TITLE_LENGTH} characters — it has to fit in a Telegram notification.`;
  }
  return null;
}

/**
 * The first thing wrong with this write-up, or null.
 *
 * It REFUSES, and refusing is the whole point. The body used to be sliced at
 * the cap in silence, so a proposal reached the person deciding ending
 * mid-word — "I would leave them as history — s" on PR #596, which is how
 * note #320 was opened. Losing the end of an argument is bad; losing it
 * without telling the author, who then has no way to know to say it shorter,
 * is the bug. The title has always been told (above); the body was not.
 *
 * Nothing is lost by refusing here: `pr create` is the last step of the
 * push-then-check chain, so a body sent back is one command retyped, not a
 * branch re-pushed or a build re-run.
 */
export function validatePullRequestBody(body: string): string | null {
  if (body.length > MAX_PR_BODY_LENGTH) {
    return `A proposal body is at most ${MAX_PR_BODY_LENGTH} characters (this one is ${body.length}). Say what your user needs in order to decide, and leave the rest in the branch — a doc in the diff, or a comment on the proposal once it is open.`;
  }
  return null;
}

/**
 * The notes a proposal implements: exactly what `--note` recorded, nothing
 * read out of prose. The link used to be inferred from “note #N” in the
 * title, body and commit subjects as a bridge while older CLIs could not
 * send an explicit link. That bridge made every mention a claim — a body
 * whose EXAMPLE said “note #12” was refused over an archived note nobody
 * was working from — so it is gone (Owner, 2026-09-01): a mention is just
 * words, and only the flag links.
 */
export function pullRequestQuickNoteNumbers(
  doc: Pick<GitPullRequestDocument, 'quickNoteNumbers'>,
): number[] {
  return (doc.quickNoteNumbers ?? [])
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .sort((a, b) => a - b);
}

/** Which room owns this proposal's linked note numbers. */
export function pullRequestQuickNoteNamespaceId(
  doc: Pick<GitPullRequestDocument, 'userId' | 'quickNoteNamespaceId'>,
): string {
  return doc.quickNoteNamespaceId ?? doc.userId;
}

/**
 * Which room owns this proposal in the Workspace decision queue.
 *
 * New records carry that namespace directly. A linked note is the strongest
 * legacy evidence because it was resolved through the proposing agent's room
 * at creation. For an older unlinked proposal on a shared repository, callers
 * may supply the proposing agent's current namespace; the repo home is the
 * final compatibility fallback when that agent has since been deleted.
 */
export function pullRequestRoomNamespaceId(
  doc: Pick<GitPullRequestDocument, 'userId' | 'roomNamespaceId' | 'quickNoteNamespaceId'>,
  legacyAgentNamespaceId?: string,
): string {
  return doc.roomNamespaceId
    ?? doc.quickNoteNamespaceId
    ?? legacyAgentNamespaceId
    ?? doc.userId;
}

/**
 * Whether this proposal is a question the user can answer right now: open,
 * AND the agent has said it is ready (note #293). Every surface that shows or
 * takes a decision — the queue, the tabs' attention dot, the decision route,
 * the card-tap flow — asks this rather than `status === 'open'`, so a quiet
 * proposal cannot be approved from any of them.
 */
export function pullRequestAwaitsDecision(
  doc: Pick<GitPullRequestDocument, 'status' | 'draft'>,
): boolean {
  return doc.status === 'open' && !doc.draft;
}

/** Exactly the proposal states note #99 says must fence a second attempt. */
export function pullRequestBlocksQuickNote(status: GitPullRequestStatus): boolean {
  return status === 'open' || status === 'merged';
}

/**
 * The first thing wrong with an upload, or null. Word for word the note's own
 * rule (`validateQuickNoteAttachment`), because the name check is load-bearing
 * in exactly the same way: the file name is the handle the CLI addresses a
 * file by and a path segment in storage, so a name that survives
 * sanitizeStorageSegment unchanged is the only kind accepted.
 */
export function validatePullRequestAttachment(args: {
  fileName: string;
  sizeBytes: number;
  existing: ReadonlyArray<Pick<PullRequestAttachment, 'fileName'>>;
}): string | null {
  if (!args.fileName || args.fileName.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.fileName)) {
    return 'File names here are letters, digits, dots, dashes and underscores (up to 120 characters) — rename the file and attach it again.';
  }
  if (args.sizeBytes <= 0) return 'The upload arrived empty.';
  if (args.sizeBytes > PR_ATTACHMENT_MAX_BYTES) {
    return `A proposal carries files up to ${PR_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB — this one is ${(args.sizeBytes / 1024 / 1024).toFixed(1)} MB. Something that size belongs in the branch, not on the card.`;
  }
  // Duplicate before count, as on a note: a re-upload of a name the proposal
  // already has is a duplicate whether or not there is room, and "take one
  // off" is the wrong advice for it.
  if (args.existing.some((a) => a.fileName === args.fileName)) {
    return `This proposal already has a file named ${args.fileName} — take it off first, or use another name.`;
  }
  if (args.existing.length >= PR_MAX_ATTACHMENTS) {
    return `A proposal carries at most ${PR_MAX_ATTACHMENTS} files. Take one off first.`;
  }
  return null;
}

/** Where one proposal's file lives in media storage. The proposal's own
 *  prefix, so a cleanup can clear everything under it in one call. */
export function pullRequestAttachmentPath(
  userId: string,
  prId: string,
  attachmentId: string,
  fileName: string,
): string {
  return ['users', userId, 'prs', prId, attachmentId, fileName].join('/');
}

export function pullRequestStoragePrefix(userId: string, prId: string): string {
  return ['users', userId, 'prs', prId, ''].join('/');
}

/**
 * Whether a proposal in this state can still take a file, and why not.
 *
 * A file on a proposal is evidence FOR the decision, so it stops making sense
 * the moment the decision is made: attaching to a merged or rejected proposal
 * adds a picture to a card nobody will open again. Open takes files, and so
 * does `conflict` — that one is still being worked on and will be re-proposed.
 */
export function pullRequestTakesAttachments(status: GitPullRequestStatus): boolean {
  return status === 'open' || status === 'conflict';
}

/**
 * Comments stop with the files and for the same reason: the margin is where
 * the question is discussed, and a decided proposal is not a question any
 * more. What follows a merge belongs in chat or on a note, where it will
 * actually be read — not under a card nobody opens again.
 */
export const pullRequestTakesComments = pullRequestTakesAttachments;

/** The first thing wrong with a remark on a proposal, or null. */
export function validatePullRequestComment(text: string): string | null {
  return validateMarginComment(text, COMMENT_HTML_LABELS, 'Anything longer belongs in the proposal body, or in the chat.');
}

/** Loose enough for `feat/x`, tight enough to stay a safe git argument. */
export function validateBranchName(branch: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(branch) || branch.includes('..')
    || branch.endsWith('/') || branch.endsWith('.lock') || branch.length > 200) {
    return `"${branch}" is not a usable branch name.`;
  }
  return null;
}
