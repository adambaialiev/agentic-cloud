import { randomUUID } from 'node:crypto';
import { bucketIsLive, type StorageBucketDocument } from '../types/storage-bucket.js';

/**
 * Bucket records (note #768). Like deployments, a destroyed bucket keeps its
 * row as a tombstone and its name is free again: a bucket's bytes are gone
 * with it, so there is no address to reserve.
 */
export interface StorageBucketStorage {
  create(doc: Omit<StorageBucketDocument, 'id' | 'createdAt'>): Promise<StorageBucketDocument>;
  get(id: string): Promise<StorageBucketDocument | null>;
  /** The live bucket of that name in that workplace (or, org-less, that user's), else null. */
  getLiveByName(owner: { orgId: string | null; userId: string }, name: string): Promise<StorageBucketDocument | null>;
  listByOrg(orgId: string): Promise<StorageBucketDocument[]>;
  listByUser(userId: string): Promise<StorageBucketDocument[]>;
  listAll(): Promise<StorageBucketDocument[]>;
  /** Partial field update; undefined fields untouched. */
  update(id: string, updates: Partial<StorageBucketDocument>): Promise<boolean>;
  /** Remove the record outright (a deleted workplace). */
  delete(id: string): Promise<boolean>;
}

export function bucketBelongsTo(doc: StorageBucketDocument, owner: { orgId: string | null; userId: string }): boolean {
  return owner.orgId ? doc.orgId === owner.orgId : doc.userId === owner.userId;
}

export class InMemoryStorageBucketStorage implements StorageBucketStorage {
  private docs = new Map<string, StorageBucketDocument>();

  async create(doc: Omit<StorageBucketDocument, 'id' | 'createdAt'>): Promise<StorageBucketDocument> {
    if (await this.getLiveByName({ orgId: doc.orgId, userId: doc.userId }, doc.name)) {
      throw new Error(`bucket "${doc.name}" already exists here`);
    }
    const full: StorageBucketDocument = { ...doc, id: randomUUID(), createdAt: new Date().toISOString() };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<StorageBucketDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async getLiveByName(owner: { orgId: string | null; userId: string }, name: string): Promise<StorageBucketDocument | null> {
    for (const doc of this.docs.values()) {
      if (doc.name === name && bucketIsLive(doc) && bucketBelongsTo(doc, owner)) return doc;
    }
    return null;
  }

  async listByOrg(orgId: string): Promise<StorageBucketDocument[]> {
    return [...this.docs.values()].filter((doc) => doc.orgId === orgId);
  }

  async listByUser(userId: string): Promise<StorageBucketDocument[]> {
    return [...this.docs.values()].filter((doc) => doc.userId === userId);
  }

  async listAll(): Promise<StorageBucketDocument[]> {
    return [...this.docs.values()];
  }

  async update(id: string, updates: Partial<StorageBucketDocument>): Promise<boolean> {
    const doc = this.docs.get(id);
    if (!doc) return false;
    const next = { ...doc };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    this.docs.set(id, next);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }
}
