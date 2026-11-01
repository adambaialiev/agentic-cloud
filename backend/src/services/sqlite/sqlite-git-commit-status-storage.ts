import { randomUUID } from 'node:crypto';
import type { GitCommitStatusDocument } from '../../types/git-commit-status.js';
import type { GitCommitStatusStorage } from '../git-commit-status-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

export class SqliteGitCommitStatusStorage implements GitCommitStatusStorage {
  constructor(private readonly db: SqliteDb) {}

  async deleteByRepo(repoId: string): Promise<void> {
    this.db.prepare('DELETE FROM git_commit_statuses WHERE repo_id = ?').run(repoId);
  }

  async upsert(
    doc: Omit<GitCommitStatusDocument, 'id'> & { id?: string },
  ): Promise<GitCommitStatusDocument> {
    const existing = await this.get(doc.repoId, doc.sha, doc.context);
    const full: GitCommitStatusDocument = { ...doc, id: doc.id ?? existing?.id ?? randomUUID() };
    // The unique (repo_id, sha, context) index makes the replace atomic:
    // latest write wins wholesale, per the storage contract.
    this.db
      .prepare(
        'INSERT INTO git_commit_statuses (status_id, repo_id, sha, context, doc) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT (repo_id, sha, context) DO UPDATE SET doc = excluded.doc',
      )
      .run(full.id, full.repoId, full.sha, full.context, serializeDoc(full));
    return full;
  }

  async get(repoId: string, sha: string, context: string): Promise<GitCommitStatusDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM git_commit_statuses WHERE repo_id = ? AND sha = ? AND context = ?')
      .get(repoId, sha, context) as { doc: string } | undefined;
    return row ? deserializeDoc<GitCommitStatusDocument>(row.doc) : null;
  }

  async listBySha(repoId: string, sha: string): Promise<GitCommitStatusDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM git_commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY context')
      .all(repoId, sha) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitCommitStatusDocument>(row.doc));
  }

  async listByShas(repoId: string, shas: string[]): Promise<GitCommitStatusDocument[]> {
    if (shas.length === 0) return [];
    const placeholders = shas.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT doc FROM git_commit_statuses WHERE repo_id = ? AND sha IN (${placeholders}) ORDER BY context`)
      .all(repoId, ...shas) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitCommitStatusDocument>(row.doc));
  }

  async listRecentByRepo(repoId: string, limit: number): Promise<GitCommitStatusDocument[]> {
    const rows = this.db
      .prepare(
        'SELECT doc FROM git_commit_statuses WHERE repo_id = ? '
        + "ORDER BY json_extract(doc, '$.startedAt') DESC, context LIMIT ?",
      )
      .all(repoId, limit) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitCommitStatusDocument>(row.doc));
  }

  async listByReposSince(repoIds: string[], sinceIso: string): Promise<GitCommitStatusDocument[]> {
    if (repoIds.length === 0) return [];
    const placeholders = repoIds.map(() => '?').join(', ');
    // ISO-8601 UTC stamps compare as strings; `repo_id` leads the unique
    // index, so the scan is one repository's rows at a time.
    const rows = this.db
      .prepare(
        `SELECT doc FROM git_commit_statuses WHERE repo_id IN (${placeholders}) `
        + "AND json_extract(doc, '$.startedAt') >= ?",
      )
      .all(...repoIds, sinceIso) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitCommitStatusDocument>(row.doc));
  }
}
