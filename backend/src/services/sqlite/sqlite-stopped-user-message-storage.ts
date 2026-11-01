import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type {
  StoppedUserMessagesDocument,
  StoppedUserMessageStorage,
} from '../stopped-user-message-storage.js';

export class SqliteStoppedUserMessageStorage implements StoppedUserMessageStorage {
  constructor(private readonly db: SqliteDb) {}

  async save(doc: StoppedUserMessagesDocument): Promise<void> {
    this.db.prepare(
      'INSERT INTO stopped_user_messages (run_key, doc) VALUES (?, ?)'
      + ' ON CONFLICT(run_key) DO UPDATE SET doc = excluded.doc',
    ).run(doc.runKey, serializeDoc(doc));
  }

  async listAll(): Promise<StoppedUserMessagesDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM stopped_user_messages').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<StoppedUserMessagesDocument>(row.doc));
  }

  async delete(runKey: string): Promise<void> {
    this.db.prepare('DELETE FROM stopped_user_messages WHERE run_key = ?').run(runKey);
  }

  async deleteIfGeneration(runKey: string, generation: string): Promise<boolean> {
    const result = this.db.prepare(
      "DELETE FROM stopped_user_messages WHERE run_key = ? AND json_extract(doc, '$.generation') = ?",
    ).run(runKey, generation);
    return result.changes > 0;
  }
}
