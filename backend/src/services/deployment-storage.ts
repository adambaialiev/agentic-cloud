import { randomUUID } from 'node:crypto';
import type { DeploymentDocument } from '../types/deployment.js';

/**
 * Storage for deployment records. Uniqueness of `name` is enforced HERE (the
 * public namespace is first-come-first-served); the DNS create is only a
 * defensive second fence.
 */
export interface DeploymentStorage {
  create(doc: Omit<DeploymentDocument, 'id' | 'createdAt'>): Promise<DeploymentDocument>;
  get(id: string): Promise<DeploymentDocument | null>;
  getByName(name: string): Promise<DeploymentDocument | null>;
  listByUser(userId: string): Promise<DeploymentDocument[]>;
  /** Every site owned by one workplace, irrespective of which member deployed it. */
  listByOrg(orgId: string): Promise<DeploymentDocument[]>;
  listAll(): Promise<DeploymentDocument[]>;
  /** Partial field update; undefined fields untouched, null deletes. */
  update(id: string, updates: Partial<DeploymentDocument>): Promise<boolean>;
  /** Permanently remove the record, freeing its name for anyone. A deleted
   *  WORKPLACE is the one caller (2026-09-22): unlike an ordinary site delete,
   *  nothing is left for a name tombstone to reserve the name to. */
  delete(id: string): Promise<boolean>;
}

/** Names of destroyed deployments return to the pool; live ones never do. */
export function nameIsTaken(existing: DeploymentDocument | null): boolean {
  return existing !== null && existing.status !== 'destroyed';
}

export class InMemoryDeploymentStorage implements DeploymentStorage {
  private docs = new Map<string, DeploymentDocument>();

  async create(doc: Omit<DeploymentDocument, 'id' | 'createdAt'>): Promise<DeploymentDocument> {
    const byName = await this.getByName(doc.name);
    if (nameIsTaken(byName)) {
      throw new Error(`deployment name "${doc.name}" is already taken`);
    }
    const full: DeploymentDocument = {
      ...doc,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<DeploymentDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async getByName(name: string): Promise<DeploymentDocument | null> {
    // Prefer the non-destroyed record when a name has history, and match a
    // name this deployment has been renamed AWAY from: the old address still
    // serves, so the name is still spoken for.
    let tombstone: DeploymentDocument | null = null;
    for (const doc of this.docs.values()) {
      if (doc.name !== name && !(doc.formerNames ?? []).includes(name)) continue;
      if (doc.status !== 'destroyed') return doc;
      tombstone = doc;
    }
    return tombstone;
  }

  async listByUser(userId: string): Promise<DeploymentDocument[]> {
    return [...this.docs.values()].filter((d) => d.userId === userId);
  }

  async listByOrg(orgId: string): Promise<DeploymentDocument[]> {
    return [...this.docs.values()].filter((d) => d.orgId === orgId);
  }

  async listAll(): Promise<DeploymentDocument[]> {
    return [...this.docs.values()];
  }

  async update(id: string, updates: Partial<DeploymentDocument>): Promise<boolean> {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.set(id, { ...doc, ...updates });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }
}
