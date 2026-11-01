import { randomUUID } from 'node:crypto';
import { isLiveRepo, type GitRepoDocument } from '../../types/git-repo.js';
import { byDeletedAtDesc, type GitRepoStorage } from '../git-repo-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * `user_id` + `name` are real columns (both lookup paths), indexed but NOT
 * unique: since slice 5 a deleted repo keeps its row and its name while it
 * waits in the host's trash, so the live-name fence moved into create() —
 * the same place deployments keep it, for the same reason, and single-writer
 * at this scale (one backend process) is what makes that sound.
 */
export class SqliteGitRepoStorage implements GitRepoStorage {
  constructor(private readonly db: SqliteDb) {}

  async create(
    doc: Omit<GitRepoDocument, 'id' | 'createdAt'>,
    uniqueAcrossNamespaceIds: readonly string[] = [],
  ): Promise<GitRepoDocument> {
    const full: GitRepoDocument = {
      ...doc,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    // LIVE names only: a tombstone holding this name is a repo its owner
    // deleted, and refusing to reuse the name would make delete-then-recreate
    // — the most ordinary thing anyone does after a bad start — impossible
    // until the window expired.
    // Across the workplace's namespaces when the caller names them (note
    // #566): a repository belongs to the workplace, so two rooms cannot each
    // hold an `api` any more.
    if (await this.getLiveByNameIn([full.userId, ...uniqueAcrossNamespaceIds], full.name)) {
      throw new Error(`repo "${full.name}" already exists on this account`);
    }
    this.db
      .prepare('INSERT INTO git_repos (repo_id, user_id, name, doc) VALUES (?, ?, ?, ?)')
      .run(full.id, full.userId, full.name, serializeDoc(full));
    return full;
  }

  async get(id: string): Promise<GitRepoDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM git_repos WHERE repo_id = ?')
      .get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<GitRepoDocument>(row.doc) : null;
  }

  async getPublicById(publicId: string): Promise<GitRepoDocument | null> {
    const row = this.db
      .prepare("SELECT doc FROM git_repos WHERE json_extract(doc, '$.publicAccess.id') = ? AND json_extract(doc, '$.deletedAt') IS NULL")
      .get(publicId) as { doc: string } | undefined;
    return row ? deserializeDoc<GitRepoDocument>(row.doc) : null;
  }

  async listPublic(): Promise<GitRepoDocument[]> {
    const rows = this.db
      .prepare("SELECT doc FROM git_repos WHERE json_extract(doc, '$.publicAccess.id') IS NOT NULL AND json_extract(doc, '$.deletedAt') IS NULL")
      .all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitRepoDocument>(row.doc))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every row for a (user, name) — live one and tombstones alike. */
  private rowsByName(userId: string, name: string): GitRepoDocument[] {
    const rows = this.db
      .prepare('SELECT doc FROM git_repos WHERE user_id = ? AND name = ?')
      .all(userId, name) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<GitRepoDocument>(row.doc));
  }

  async getByName(userId: string, name: string): Promise<GitRepoDocument | null> {
    return this.rowsByName(userId, name).find(isLiveRepo) ?? null;
  }

  async listByUser(userId: string): Promise<GitRepoDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM git_repos WHERE user_id = ?')
      .all(userId) as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<GitRepoDocument>(row.doc))
      .filter(isLiveRepo)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every row at any of these namespaces. Repositories per workplace are a
   *  small set and a workplace has a handful of namespaces, so one indexed
   *  read per namespace beats parsing the whole registry. */
  private docsIn(namespaceIds: readonly string[]): GitRepoDocument[] {
    const read = this.db.prepare('SELECT doc FROM git_repos WHERE user_id = ?');
    return [...new Set(namespaceIds)].flatMap((namespaceId) => (
      (read.all(namespaceId) as Array<{ doc: string }>).map((row) => deserializeDoc<GitRepoDocument>(row.doc))
    ));
  }

  async getLiveByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null> {
    return (await this.listLiveIn(namespaceIds)).find((doc) => doc.name === name) ?? null;
  }

  async listLiveIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]> {
    return this.docsIn(namespaceIds)
      .filter(isLiveRepo)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listTrashedIn(namespaceIds: readonly string[]): Promise<GitRepoDocument[]> {
    return this.docsIn(namespaceIds).filter((doc) => !isLiveRepo(doc)).sort(byDeletedAtDesc);
  }

  async getTrashedByNameIn(namespaceIds: readonly string[], name: string): Promise<GitRepoDocument | null> {
    return (await this.listTrashedIn(namespaceIds)).find((doc) => doc.name === name) ?? null;
  }

  async listTrashedByUser(userId: string): Promise<GitRepoDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM git_repos WHERE user_id = ?')
      .all(userId) as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<GitRepoDocument>(row.doc))
      .filter((doc) => !isLiveRepo(doc))
      .sort(byDeletedAtDesc);
  }

  async getTrashedByName(userId: string, name: string): Promise<GitRepoDocument | null> {
    return this.rowsByName(userId, name)
      .filter((doc) => !isLiveRepo(doc))
      .sort(byDeletedAtDesc)[0] ?? null;
  }

  async listNamespacesByOrg(orgId: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT user_id FROM git_repos WHERE json_extract(doc, '$.orgId') = ?")
      .all(orgId) as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  async update(id: string, updates: Partial<GitRepoDocument>): Promise<boolean> {
    const doc = await this.get(id);
    if (!doc) return false;
    const next = { ...doc, ...updates };
    const result = this.db
      .prepare('UPDATE git_repos SET user_id = ?, name = ?, doc = ? WHERE repo_id = ?')
      .run(next.userId, next.name, serializeDoc(next), id);
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM git_repos WHERE repo_id = ?').run(id).changes > 0;
  }

  async totalBytesForUser(userId: string): Promise<number> {
    const docs = await this.listByUser(userId);
    return docs.reduce((sum, doc) => sum + (doc.sizeBytes || 0), 0);
  }
}
