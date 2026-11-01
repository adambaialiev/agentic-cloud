import type { MailboxClaimOutcome, MailboxDocument, MailboxStorage } from '../mailbox-storage.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/** Address ownership, decided by the database rather than by a read followed
 *  by a write: both uniqueness rules are checked inside one transaction. */
export class SqliteMailboxStorage implements MailboxStorage {
  constructor(private readonly db: SqliteDb) {}

  private read(where: 'address' | 'user_id', value: string): MailboxDocument | null {
    const row = this.db.prepare(`SELECT doc FROM workspace_mailboxes WHERE ${where} = ?`)
      .get(value) as { doc: string } | undefined;
    return row ? deserializeDoc<MailboxDocument>(row.doc) : null;
  }

  async getByAddress(address: string): Promise<MailboxDocument | null> {
    return this.read('address', address);
  }

  async getByUser(userId: string): Promise<MailboxDocument | null> {
    return this.read('user_id', userId);
  }

  async claim(doc: MailboxDocument): Promise<MailboxClaimOutcome> {
    const transaction = this.db.transaction(() => {
      if (this.read('address', doc.address)) return 'address_taken' as const;
      if (this.read('user_id', doc.userId)) return 'user_has_mailbox' as const;
      this.db.prepare(
        'INSERT INTO workspace_mailboxes (address, user_id, doc) VALUES (?, ?, ?)',
      ).run(doc.address, doc.userId, serializeDoc(doc));
      return 'claimed' as const;
    });
    return transaction.immediate();
  }

  async release(userId: string, address: string): Promise<void> {
    this.db.prepare('DELETE FROM workspace_mailboxes WHERE user_id = ? AND address = ?').run(userId, address);
  }

  /**
   * Who this address wakes (slice 11). A field on the document rather than a
   * column: nothing queries by it — the only read is "this address just
   * received a letter, who did its owner choose" — and a mailbox is already
   * fetched whole by both of its keys.
   */
  async setWakeAgent(userId: string, agentId: string | null): Promise<MailboxDocument | null> {
    const transaction = this.db.transaction((): MailboxDocument | null => {
      const current = this.read('user_id', userId);
      if (!current) return null;
      const { wakeAgentId: _was, ...rest } = current;
      const next: MailboxDocument = { ...rest, ...(agentId ? { wakeAgentId: agentId } : {}) };
      this.db.prepare('UPDATE workspace_mailboxes SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(next), userId);
      return next;
    });
    return transaction.immediate();
  }
}
