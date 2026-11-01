import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { SeatSignInDocument, SeatSignInStorage } from '../seat-signin-storage.js';
import type { SecretCipher } from '../secret-cipher.js';
import { openSeatSignIn, sealSeatSignIn } from '../seat-credential-cipher.js';

export class SqliteSeatSignInStorage implements SeatSignInStorage {
  constructor(private readonly db: SqliteDb, private readonly cipher: SecretCipher | null = null) {}

  async save(doc: SeatSignInDocument): Promise<void> {
    this.db.prepare(
      'INSERT INTO seat_signins (user_id, doc) VALUES (?, ?)'
      + ' ON CONFLICT(user_id) DO UPDATE SET doc = excluded.doc',
    ).run(doc.userId, serializeDoc(sealSeatSignIn(doc, this.cipher)));
  }

  async listAll(): Promise<SeatSignInDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM seat_signins').all() as Array<{ doc: string }>;
    return rows.map((row) => openSeatSignIn(deserializeDoc<SeatSignInDocument>(row.doc), this.cipher));
  }

  async delete(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM seat_signins WHERE user_id = ?').run(userId);
  }
}
