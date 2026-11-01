import { randomUUID } from 'node:crypto';
import type { MarginComment } from '../../types/comment.js';
import {
  pullRequestQuickNoteNamespaceId,
  pullRequestRoomNamespaceId,
  type GitPullRequestDocument,
} from '../../types/git-pr.js';
import type { GitPullRequestStorage, MergedProposalSummary } from '../git-pr-storage.js';
import {
  PullRequestNumberRaceError,
  QuickNoteProposalConflictError,
  conflictingQuickNoteProposal,
  nextPullRequestNumber,
} from '../git-pr-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * `repo_id` + `number` are real columns: the pair is how Telegram callbacks
 * and the CLI both address a PR, and UNIQUE across it stops two concurrent
 * `pr create` calls minting the same "PR #3".
 */
export class SqliteGitPullRequestStorage implements GitPullRequestStorage {
  constructor(private readonly db: SqliteDb) {}

  async create(
    doc: Omit<GitPullRequestDocument, 'id' | 'createdAt' | 'number'>,
  ): Promise<GitPullRequestDocument> {
    try {
      return this.db.transaction(() => {
        // The duplicate-note check and insert share one immediate transaction:
        // two agents racing the same note cannot both pass the read.
        // A shared repository may link a note from a room other than the
        // repo's home namespace. Read the small proposal registry whole so
        // the duplicate-note fence follows that explicit namespace rather
        // than the indexed home column.
        const allRows = this.db.prepare('SELECT doc FROM git_pull_requests').all() as Array<{ doc: string }>;
        const allDocs = allRows.map((row) => deserializeDoc<GitPullRequestDocument>(row.doc));
        const conflict = conflictingQuickNoteProposal(doc, allDocs);
        if (conflict) throw new QuickNoteProposalConflictError(conflict.noteNumber, conflict.proposal);
        // Numbering reads by REPO, never by namespace: a room move re-keys
        // the repo record but deliberately leaves its proposals where they
        // were made, so a namespace-filtered max restarts at "PR #1" and
        // dies on the unique (repo_id, number) index.
        const inRepo = allDocs.filter((proposal) => proposal.repoId === doc.repoId);
        const full: GitPullRequestDocument = {
          ...doc,
          id: randomUUID(),
          number: nextPullRequestNumber(inRepo),
          createdAt: new Date().toISOString(),
        };
        this.db
          .prepare('INSERT INTO git_pull_requests (pr_id, repo_id, user_id, number, doc) VALUES (?, ?, ?, ?, ?)')
          .run(full.id, full.repoId, full.userId, full.number, serializeDoc(full));
        return full;
      }).immediate();
    } catch (error) {
      if (error instanceof QuickNoteProposalConflictError) throw error;
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new PullRequestNumberRaceError();
      }
      throw error;
    }
  }

  async get(id: string): Promise<GitPullRequestDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM git_pull_requests WHERE pr_id = ?')
      .get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<GitPullRequestDocument>(row.doc) : null;
  }

  async getByNumber(repoId: string, number: number): Promise<GitPullRequestDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM git_pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, number) as { doc: string } | undefined;
    return row ? deserializeDoc<GitPullRequestDocument>(row.doc) : null;
  }

  async listByRepo(repoId: string): Promise<GitPullRequestDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM git_pull_requests WHERE repo_id = ? ORDER BY number')
      .all(repoId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitPullRequestDocument>(row.doc));
  }

  async listByUser(userId: string): Promise<GitPullRequestDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM git_pull_requests WHERE user_id = ?')
      .all(userId) as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<GitPullRequestDocument>(row.doc))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByQuickNoteNamespace(namespaceId: string): Promise<GitPullRequestDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM git_pull_requests').all() as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<GitPullRequestDocument>(row.doc))
      .filter((doc) => pullRequestQuickNoteNamespaceId(doc) === namespaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByRoomNamespace(namespaceId: string): Promise<GitPullRequestDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM git_pull_requests').all() as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<GitPullRequestDocument>(row.doc))
      .filter((doc) => pullRequestRoomNamespaceId(doc) === namespaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listOpenByUser(userId: string): Promise<GitPullRequestDocument[]> {
    return (await this.listByUser(userId)).filter((doc) => doc.status === 'open');
  }

  async listMergedSince(sinceIso: string): Promise<GitPullRequestDocument[]> {
    // Filtered inside SQLite: the board asks every half minute, and only a
    // week's merges of the whole registry are wanted.
    const rows = this.db.prepare(
      "SELECT doc FROM git_pull_requests WHERE json_extract(doc, '$.status') = 'merged'"
      + " AND json_extract(doc, '$.decidedAt') >= ?",
    ).all(sinceIso) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitPullRequestDocument>(row.doc));
  }

  async listMergedIn(namespaceIds: readonly string[]): Promise<MergedProposalSummary[]> {
    if (namespaceIds.length === 0) return [];
    const marks = namespaceIds.map(() => '?').join(', ');
    // Only the fields a contribution says, read inside SQLite: a busy
    // workplace has merged thousands, and the cards ask every few seconds.
    const rows = this.db.prepare(
      "SELECT pr_id AS id, repo_id AS repoId, number, json_extract(doc, '$.title') AS title,"
      + " json_extract(doc, '$.createdByUserId') AS createdByUserId,"
      + " json_extract(doc, '$.createdByAgentId') AS createdByAgentId,"
      + " json_extract(doc, '$.decidedAt') AS decidedAt FROM git_pull_requests"
      + " WHERE json_extract(doc, '$.status') = 'merged' AND json_extract(doc, '$.decidedAt') IS NOT NULL"
      + ` AND (user_id IN (${marks}) OR json_extract(doc, '$.roomNamespaceId') IN (${marks}))`,
    ).all(...namespaceIds, ...namespaceIds) as Array<MergedProposalSummary & { createdByUserId: string | null }>;
    return rows.map(({ createdByUserId, ...row }) => ({ ...row, ...(createdByUserId ? { createdByUserId } : {}) }));
  }

  async update(id: string, updates: Partial<GitPullRequestDocument>): Promise<boolean> {
    const doc = await this.get(id);
    if (!doc) return false;
    const next = { ...doc, ...updates };
    const result = this.db
      .prepare('UPDATE git_pull_requests SET repo_id = ?, user_id = ?, number = ?, doc = ? WHERE pr_id = ?')
      .run(next.repoId, next.userId, next.number, serializeDoc(next), id);
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM git_pull_requests WHERE pr_id = ?').run(id).changes > 0;
  }

  /** The one write with a real race in it — a person tapping Send and an
   *  agent mid-turn — so the append runs whole inside one transaction, the
   *  same shape as the note store's. */
  async addComment(id: string, comment: MarginComment): Promise<GitPullRequestDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM git_pull_requests WHERE pr_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<GitPullRequestDocument>(row.doc);
      const next = { ...doc, comments: [...(doc.comments ?? []), comment] };
      this.db
        .prepare('UPDATE git_pull_requests SET doc = ? WHERE pr_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }

  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<GitPullRequestDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM git_pull_requests WHERE pr_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<GitPullRequestDocument>(row.doc);
      const at = (doc.comments ?? []).findIndex((comment) => comment.id === commentId);
      if (at < 0) return null;
      const comments = [...(doc.comments ?? [])];
      comments[at] = { ...comments[at]!, text, editedAt };
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE git_pull_requests SET doc = ? WHERE pr_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }

  async deleteComment(id: string, commentId: string): Promise<GitPullRequestDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM git_pull_requests WHERE pr_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<GitPullRequestDocument>(row.doc);
      const comments = (doc.comments ?? []).filter((comment) => comment.id !== commentId);
      if (comments.length === (doc.comments ?? []).length) return null;
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE git_pull_requests SET doc = ? WHERE pr_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }
}
