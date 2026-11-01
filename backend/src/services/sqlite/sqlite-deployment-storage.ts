import { randomUUID } from 'node:crypto';
import type { DeploymentDocument } from '../../types/deployment.js';
import type { DeploymentStorage } from '../deployment-storage.js';
import { nameIsTaken } from '../deployment-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * `name` and `user_id` are real columns (lookup paths); the record itself is
 * the usual doc blob. `name` is deliberately NOT a UNIQUE column: destroyed
 * tombstones keep their name, and the live-name fence is enforced here in
 * create() (single-writer per name is fine at this scale — the backend is one
 * process and SQLite serializes writes).
 */
export class SqliteDeploymentStorage implements DeploymentStorage {
  constructor(private readonly db: SqliteDb) {}

  async create(doc: Omit<DeploymentDocument, 'id' | 'createdAt'>): Promise<DeploymentDocument> {
    const existing = await this.getByName(doc.name);
    if (nameIsTaken(existing)) {
      throw new Error(`deployment name "${doc.name}" is already taken`);
    }
    const full: DeploymentDocument = {
      ...doc,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO deployments (deployment_id, name, user_id, doc) VALUES (?, ?, ?, ?)')
      .run(full.id, full.name, full.userId, serializeDoc(full));
    return full;
  }

  async get(id: string): Promise<DeploymentDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM deployments WHERE deployment_id = ?')
      .get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<DeploymentDocument>(row.doc) : null;
  }

  async getByName(name: string): Promise<DeploymentDocument | null> {
    // The `name` column, plus any record that USED to answer on this name: a
    // renamed site keeps serving its old address, so that name is still taken.
    // JSON1 rather than a second column — the old names are a property of the
    // record, and one table shape is one migration fewer.
    const rows = this.db
      .prepare(
        'SELECT doc FROM deployments WHERE name = ? '
        + 'UNION ALL SELECT doc FROM deployments WHERE name != ? AND EXISTS ('
        + "SELECT 1 FROM json_each(json_extract(doc, '$.formerNames')) WHERE value = ?)",
      )
      .all(name, name, name) as Array<{ doc: string }>;
    let tombstone: DeploymentDocument | null = null;
    for (const row of rows) {
      const doc = deserializeDoc<DeploymentDocument>(row.doc);
      if (doc.status !== 'destroyed') return doc;
      tombstone = doc;
    }
    return tombstone;
  }

  async listByUser(userId: string): Promise<DeploymentDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM deployments WHERE user_id = ?')
      .all(userId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<DeploymentDocument>(r.doc));
  }

  async listByOrg(orgId: string): Promise<DeploymentDocument[]> {
    const rows = this.db
      .prepare("SELECT doc FROM deployments WHERE json_extract(doc, '$.orgId') = ?")
      .all(orgId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<DeploymentDocument>(r.doc));
  }

  async listAll(): Promise<DeploymentDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM deployments').all() as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<DeploymentDocument>(r.doc));
  }

  async update(id: string, updates: Partial<DeploymentDocument>): Promise<boolean> {
    const doc = await this.get(id);
    if (!doc) return false;
    const next = { ...doc, ...updates };
    const result = this.db
      .prepare('UPDATE deployments SET name = ?, user_id = ?, doc = ? WHERE deployment_id = ?')
      .run(next.name, next.userId, serializeDoc(next), id);
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM deployments WHERE deployment_id = ?').run(id).changes > 0;
  }
}
