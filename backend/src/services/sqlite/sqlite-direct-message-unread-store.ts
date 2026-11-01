import type { DirectMessageUnreadStore } from '../remote-direct-message-storage.js';
import type { SqliteDb } from './sqlite-db.js';

/** One number per person — see {@link DirectMessageUnreadStore}. Schema in sqlite-db.ts. */
export class SqliteDirectMessageUnreadStore implements DirectMessageUnreadStore {
  constructor(private readonly db: SqliteDb) {}

  get(orgId: string, userId: string): number {
    const row = this.db.prepare('SELECT unread FROM direct_message_unread WHERE org_id=? AND user_id=?').get(orgId, userId) as { unread: number } | undefined;
    return row?.unread ?? 0;
  }

  set(orgId: string, userId: string, unread: number): void {
    this.db.prepare(`INSERT INTO direct_message_unread (org_id,user_id,unread) VALUES (?,?,?)
      ON CONFLICT(org_id,user_id) DO UPDATE SET unread=excluded.unread`).run(orgId, userId, Math.max(0, Math.floor(unread)));
  }

  forget(orgId: string): void {
    this.db.prepare('DELETE FROM direct_message_unread WHERE org_id=?').run(orgId);
  }

  people(orgId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM direct_message_unread WHERE org_id=?').get(orgId) as { n: number }).n;
  }
}
