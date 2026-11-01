import { randomUUID } from 'node:crypto';
import type { MarginComment } from '../types/comment.js';
import type { GitPullRequestDocument } from '../types/git-pr.js';
import {
  pullRequestBlocksQuickNote,
  pullRequestQuickNoteNamespaceId,
  pullRequestQuickNoteNumbers,
  pullRequestRoomNamespaceId,
} from '../types/git-pr.js';

/**
 * A merged proposal, as a person's contribution reads it (note #925): whose
 * it was, what it was called and when it landed — not its body, its diff or
 * its comments, which a card read every few seconds has no use for.
 */
export type MergedProposalSummary = Pick<
  GitPullRequestDocument,
  'id' | 'repoId' | 'number' | 'title' | 'createdByUserId' | 'createdByAgentId'
> & { decidedAt: string };

/** Two `pr create` calls minted the same number at the same moment — the
 *  unique (repo_id, number) index caught the loser, and a retry will win. */
export class PullRequestNumberRaceError extends Error {
  constructor() {
    super('another proposal was created at the same moment — try again');
    this.name = 'PullRequestNumberRaceError';
  }
}

export class QuickNoteProposalConflictError extends Error {
  constructor(
    readonly noteNumber: number,
    readonly proposal: GitPullRequestDocument,
  ) {
    super(`note #${noteNumber} already has ${proposal.status} PR #${proposal.number}`);
    this.name = 'QuickNoteProposalConflictError';
  }
}

/** The existing proposal that fences this create, if any. */
export function conflictingQuickNoteProposal(
  candidate: Pick<GitPullRequestDocument, 'userId' | 'quickNoteNamespaceId' | 'quickNoteNumbers' | 'title' | 'body' | 'commitSubjects'>,
  existing: GitPullRequestDocument[],
): { noteNumber: number; proposal: GitPullRequestDocument } | null {
  const wanted = new Set(pullRequestQuickNoteNumbers(candidate));
  if (!wanted.size) return null;
  for (const proposal of existing) {
    if (pullRequestQuickNoteNamespaceId(proposal) !== pullRequestQuickNoteNamespaceId(candidate)
      || !pullRequestBlocksQuickNote(proposal.status)) continue;
    const number = pullRequestQuickNoteNumbers(proposal).find((note) => wanted.has(note));
    if (number !== undefined) return { noteNumber: number, proposal };
  }
  return null;
}

/**
 * Storage for change proposals (docs/agent-git-phase2-review.md). `number` is
 * allocated here, per repo, because it is what the user sees in Telegram and
 * what the agent passes back on the CLI.
 */
export interface GitPullRequestStorage {
  create(
    doc: Omit<GitPullRequestDocument, 'id' | 'createdAt' | 'number'>,
  ): Promise<GitPullRequestDocument>;
  get(id: string): Promise<GitPullRequestDocument | null>;
  getByNumber(repoId: string, number: number): Promise<GitPullRequestDocument | null>;
  listByRepo(repoId: string): Promise<GitPullRequestDocument[]>;
  /** Every proposal in one note/repo namespace, including decided history. */
  listByUser(userId: string): Promise<GitPullRequestDocument[]>;
  /** Proposals linked to notes in this namespace (shared repos may live elsewhere). */
  listByQuickNoteNamespace(namespaceId: string): Promise<GitPullRequestDocument[]>;
  /** Proposals whose decision belongs to this room, even when the repository
   *  itself is homed elsewhere and merely shared in. */
  listByRoomNamespace(namespaceId: string): Promise<GitPullRequestDocument[]>;
  listOpenByUser(userId: string): Promise<GitPullRequestDocument[]>;
  /** Every proposal merged at or after `sinceIso`, in every repository —
   *  the Leaderboard's merges, this week's and each grid day's. */
  listMergedSince(sinceIso: string): Promise<GitPullRequestDocument[]>;
  /** Every proposal ever merged in these namespaces — a workplace's, for its
   *  people cards (note #925) — as the few fields a contribution needs. */
  listMergedIn(namespaceIds: readonly string[]): Promise<MergedProposalSummary[]>;
  update(id: string, updates: Partial<GitPullRequestDocument>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /**
   * Appends a remark. Its own method for the reason the note store's is
   * (`QuickNoteStorage.addComment`): the writers are a person tapping Send
   * and an agent mid-turn, and a read-modify-write from each would quietly
   * drop one of them. Implementations do the whole append atomically.
   */
  addComment(id: string, comment: MarginComment): Promise<GitPullRequestDocument | null>;
  editComment(id: string, commentId: string, text: string, editedAt: string): Promise<GitPullRequestDocument | null>;
  /** Takes the author's own remark out of the thread, whole. */
  deleteComment(id: string, commentId: string): Promise<GitPullRequestDocument | null>;
}

export function nextPullRequestNumber(existing: GitPullRequestDocument[]): number {
  // Max + 1, never count + 1: withdrawn and rejected PRs keep their numbers,
  // and reusing one would make "PR #3" ambiguous in the chat history.
  return existing.reduce((max, doc) => Math.max(max, doc.number), 0) + 1;
}

export class InMemoryGitPullRequestStorage implements GitPullRequestStorage {
  private docs = new Map<string, GitPullRequestDocument>();

  async create(
    doc: Omit<GitPullRequestDocument, 'id' | 'createdAt' | 'number'>,
  ): Promise<GitPullRequestDocument> {
    // No await before the check-and-set: in-memory tests exercise the same
    // atomic contract SQLite's transaction provides in production.
    const existing = [...this.docs.values()];
    const conflict = conflictingQuickNoteProposal(doc, existing);
    if (conflict) throw new QuickNoteProposalConflictError(conflict.noteNumber, conflict.proposal);
    const full: GitPullRequestDocument = {
      ...doc,
      id: randomUUID(),
      number: nextPullRequestNumber(existing.filter((proposal) => proposal.repoId === doc.repoId)),
      createdAt: new Date().toISOString(),
    };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<GitPullRequestDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async getByNumber(repoId: string, number: number): Promise<GitPullRequestDocument | null> {
    for (const doc of this.docs.values()) {
      if (doc.repoId === repoId && doc.number === number) return doc;
    }
    return null;
  }

  async listByRepo(repoId: string): Promise<GitPullRequestDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.repoId === repoId)
      .sort((a, b) => a.number - b.number);
  }

  async listByUser(userId: string): Promise<GitPullRequestDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByQuickNoteNamespace(namespaceId: string): Promise<GitPullRequestDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => pullRequestQuickNoteNamespaceId(doc) === namespaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByRoomNamespace(namespaceId: string): Promise<GitPullRequestDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => pullRequestRoomNamespaceId(doc) === namespaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listOpenByUser(userId: string): Promise<GitPullRequestDocument[]> {
    return (await this.listByUser(userId)).filter((doc) => doc.status === 'open');
  }

  async listMergedSince(sinceIso: string): Promise<GitPullRequestDocument[]> {
    return [...this.docs.values()].filter((doc) => doc.status === 'merged' && (doc.decidedAt ?? '') >= sinceIso);
  }

  async listMergedIn(namespaceIds: readonly string[]): Promise<MergedProposalSummary[]> {
    const namespaces = new Set(namespaceIds);
    return [...this.docs.values()]
      .filter((doc) => doc.status === 'merged' && doc.decidedAt
        && (namespaces.has(doc.userId) || namespaces.has(pullRequestRoomNamespaceId(doc))))
      .map((doc) => ({
        id: doc.id, repoId: doc.repoId, number: doc.number, title: doc.title,
        ...(doc.createdByUserId ? { createdByUserId: doc.createdByUserId } : {}),
        createdByAgentId: doc.createdByAgentId, decidedAt: doc.decidedAt!,
      }));
  }

  async update(id: string, updates: Partial<GitPullRequestDocument>): Promise<boolean> {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.set(id, { ...doc, ...updates });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async addComment(id: string, comment: MarginComment): Promise<GitPullRequestDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const next = { ...doc, comments: [...(doc.comments ?? []), comment] };
    this.docs.set(id, next);
    return next;
  }

  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<GitPullRequestDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const at = (doc.comments ?? []).findIndex((comment) => comment.id === commentId);
    if (at < 0) return null;
    const comments = [...(doc.comments ?? [])];
    comments[at] = { ...comments[at]!, text, editedAt };
    const next = { ...doc, comments };
    this.docs.set(id, next);
    return next;
  }

  async deleteComment(id: string, commentId: string): Promise<GitPullRequestDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const comments = (doc.comments ?? []).filter((comment) => comment.id !== commentId);
    if (comments.length === (doc.comments ?? []).length) return null;
    const next = { ...doc, comments };
    this.docs.set(id, next);
    return next;
  }
}
