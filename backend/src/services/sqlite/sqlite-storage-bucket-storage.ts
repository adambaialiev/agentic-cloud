import { randomUUID } from 'node:crypto';
import { bucketIsLive, type StorageBucketDocument } from '../../types/storage-bucket.js';
import { bucketBelongsTo, type StorageBucketStorage } from '../storage-bucket-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * Bucket records on SQLite (note #768). `name` is a real column but not
 * unique: a destroyed bucket keeps its row as a tombstone and its name is
 * free again, so the live-name fence is in create(), as deployments keep it.
 */
export class SqliteStorageBucketStorage implements StorageBucketStorage {
  constructor(private readonly db: SqliteDb) {}

  async create(doc: Omit<StorageBucketDocument, 'id' | 'createdAt'>): Promise<StorageBucketDocument> {
    if (await this.getLiveByName({ orgId: doc.orgId, userId: doc.userId }, doc.name)) {
      throw new Error(`bucket "${doc.name}" already exists here`);
    }
    const full: StorageBucketDocument = { ...doc, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO storage_buckets (bucket_id, user_id, org_id, name, doc) VALUES (?, ?, ?, ?, ?)')
      .run(full.id, full.userId, full.orgId, full.name, serializeDoc(full));
    return full;
  }

  async get(id: string): Promise<StorageBucketDocument | null> {
    const row = this.db.prepare('SELECT doc FROM storage_buckets WHERE bucket_id = ?').get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<StorageBucketDocument>(row.doc) : null;
  }

  async getLiveByName(owner: { orgId: string | null; userId: string }, name: string): Promise<StorageBucketDocument | null> {
    const rows = this.db.prepare('SELECT doc FROM storage_buckets WHERE name = ?').all(name) as Array<{ doc: string }>;
    for (const row of rows) {
      const doc = deserializeDoc<StorageBucketDocument>(row.doc);
      if (bucketIsLive(doc) && bucketBelongsTo(doc, owner)) return doc;
    }
    return null;
  }

  async listByOrg(orgId: string): Promise<StorageBucketDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM storage_buckets WHERE org_id = ?').all(orgId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<StorageBucketDocument>(row.doc));
  }

  async listByUser(userId: string): Promise<StorageBucketDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM storage_buckets WHERE user_id = ?').all(userId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<StorageBucketDocument>(row.doc));
  }

  async listAll(): Promise<StorageBucketDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM storage_buckets').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<StorageBucketDocument>(row.doc));
  }

  async update(id: string, updates: Partial<StorageBucketDocument>): Promise<boolean> {
    const doc = await this.get(id);
    if (!doc) return false;
    const next = { ...doc } as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const full = next as unknown as StorageBucketDocument;
    this.db
      .prepare('UPDATE storage_buckets SET user_id = ?, org_id = ?, name = ?, doc = ? WHERE bucket_id = ?')
      .run(full.userId, full.orgId, full.name, serializeDoc(full), id);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM storage_buckets WHERE bucket_id = ?').run(id);
    return result.changes > 0;
  }
}
