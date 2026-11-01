import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import {
  pendingTurnDocId,
  type PendingTurnDocument,
  type PendingTurnStorage,
} from '../pending-turn-storage.js';

export class SqlitePendingTurnStorage implements PendingTurnStorage {
  constructor(private readonly db: SqliteDb) {}

  async save(doc: PendingTurnDocument): Promise<void> {
    this.db.prepare(
      'INSERT INTO pending_turns (doc_id, doc) VALUES (?, ?)'
      + ' ON CONFLICT(doc_id) DO UPDATE SET doc = excluded.doc',
    ).run(pendingTurnDocId(doc), serializeDoc(doc));
  }

  async listAll(): Promise<PendingTurnDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM pending_turns').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<PendingTurnDocument>(row.doc));
  }

  async delete(docId: string): Promise<void> {
    this.db.prepare('DELETE FROM pending_turns WHERE doc_id = ?').run(docId);
  }

  async deleteIfSavedAt(docId: string, savedAt: string, checkpointId?: string): Promise<boolean> {
    const result = checkpointId
      ? this.db.prepare(
        "DELETE FROM pending_turns WHERE doc_id = ? AND json_extract(doc, '$.checkpointId') = ?",
      ).run(docId, checkpointId)
      : this.db.prepare(
        "DELETE FROM pending_turns WHERE doc_id = ? AND json_extract(doc, '$.savedAt') = ?"
        + " AND json_type(doc, '$.checkpointId') IS NULL",
      ).run(docId, savedAt);
    return result.changes > 0;
  }
}
