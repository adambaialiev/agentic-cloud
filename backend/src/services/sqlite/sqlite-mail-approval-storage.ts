import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { MailApprovalDocument, MailApprovalStorage } from '../mail-approval-storage.js';

/** Durable email decisions, separate from both chat implementations. */
export class SqliteMailApprovalStorage implements MailApprovalStorage {
  constructor(private readonly db: SqliteDb) {}

  async create(doc: MailApprovalDocument): Promise<MailApprovalDocument> {
    this.db.prepare(
      `INSERT INTO workspace_mail_approvals (id, user_id, status, created_at, doc)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(doc.id, doc.userId, doc.status, doc.createdAt, serializeDoc(doc));
    return structuredClone(doc);
  }

  async get(userId: string, id: string): Promise<MailApprovalDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_mail_approvals WHERE id = ? AND user_id = ?',
    ).get(id, userId) as { doc: string } | undefined;
    return row ? deserializeDoc<MailApprovalDocument>(row.doc) : null;
  }

  async getMany(userId: string, ids: string[]): Promise<MailApprovalDocument[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return [];
    const marks = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT doc FROM workspace_mail_approvals WHERE user_id = ? AND id IN (${marks})`,
    ).all(userId, ...unique) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<MailApprovalDocument>(row.doc));
  }

  private transition(
    userId: string,
    id: string,
    from: MailApprovalDocument['status'],
    change: (doc: MailApprovalDocument) => MailApprovalDocument,
  ): MailApprovalDocument | null {
    const run = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT status, doc FROM workspace_mail_approvals WHERE id = ? AND user_id = ?',
      ).get(id, userId) as { status: string; doc: string } | undefined;
      if (!row || row.status !== from) return null;
      const next = change(deserializeDoc<MailApprovalDocument>(row.doc));
      const updated = this.db.prepare(
        `UPDATE workspace_mail_approvals SET status = ?, doc = ?
         WHERE id = ? AND user_id = ? AND status = ?`,
      ).run(next.status, serializeDoc(next), id, userId, from);
      return updated.changes === 1 ? next : null;
    });
    return run.immediate();
  }

  async claim(userId: string, id: string, at: string): Promise<MailApprovalDocument | null> {
    return this.transition(userId, id, 'pending', (doc) => ({
      ...doc, status: 'sending', sendingAt: at, error: undefined,
    }));
  }
  async reject(userId: string, id: string, at: string): Promise<MailApprovalDocument | null> {
    return this.transition(userId, id, 'pending', (doc) => ({
      ...doc, status: 'rejected', decidedAt: at, sendingAt: undefined, error: undefined,
    }));
  }
  async complete(userId: string, id: string, at: string, sentMessageId: string): Promise<MailApprovalDocument | null> {
    return this.transition(userId, id, 'sending', (doc) => ({
      ...doc, status: 'sent', decidedAt: at, sentMessageId, sendingAt: undefined, error: undefined,
    }));
  }
  async retry(userId: string, id: string, error: string): Promise<MailApprovalDocument | null> {
    return this.transition(userId, id, 'sending', (doc) => ({
      ...doc, status: 'pending', sendingAt: undefined, error,
    }));
  }
  async removePending(userId: string, id: string): Promise<void> {
    this.db.prepare(
      "DELETE FROM workspace_mail_approvals WHERE id = ? AND user_id = ? AND status = 'pending'",
    ).run(id, userId);
  }
}
