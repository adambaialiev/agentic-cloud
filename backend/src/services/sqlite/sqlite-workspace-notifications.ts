import type {
  WorkspaceNotificationDocument,
  WorkspaceNotificationStorage,
} from '../workspace-notifications.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

export class SqliteWorkspaceNotificationStorage implements WorkspaceNotificationStorage {
  constructor(private readonly db: SqliteDb) {}

  async createNotification(doc: WorkspaceNotificationDocument) {
    const transaction = this.db.transaction(() => {
      const inserted = this.db.prepare(
        'INSERT OR IGNORE INTO workspace_notifications '
        + '(notification_id, user_id, dedupe_key, created_at, doc) VALUES (?, ?, ?, ?, ?)',
      ).run(doc.notificationId, doc.userId, doc.dedupeKey, doc.createdAt, serializeDoc(doc));
      if (inserted.changes > 0) {
        // Retain a useful inbox without letting an abandoned account grow the
        // database forever. The newest 200 survive.
        this.db.prepare(
          'DELETE FROM workspace_notifications WHERE user_id = ? AND notification_id NOT IN '
          + '(SELECT notification_id FROM workspace_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)',
        ).run(doc.userId, doc.userId);
        return { doc, created: true };
      }
      const row = this.db.prepare(
        'SELECT doc FROM workspace_notifications WHERE user_id = ? AND dedupe_key = ?',
      ).get(doc.userId, doc.dedupeKey) as { doc: string };
      return { doc: deserializeDoc<WorkspaceNotificationDocument>(row.doc), created: false };
    });
    return transaction();
  }

  async listNotifications(userId: string, limit: number) {
    const rows = this.db.prepare(
      'SELECT doc FROM workspace_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<WorkspaceNotificationDocument>(row.doc));
  }

  async markRead(userId: string, notificationIds: string[], readAt: string) {
    if (!notificationIds.length) return 0;
    const transaction = this.db.transaction(() => {
      const read = this.db.prepare(
        'SELECT doc FROM workspace_notifications WHERE user_id = ? AND notification_id = ?',
      );
      const update = this.db.prepare(
        'UPDATE workspace_notifications SET doc = ? WHERE user_id = ? AND notification_id = ?',
      );
      let count = 0;
      for (const id of notificationIds) {
        const row = read.get(userId, id) as { doc: string } | undefined;
        if (!row) continue;
        const doc = deserializeDoc<WorkspaceNotificationDocument>(row.doc);
        if (doc.readAt) continue;
        doc.readAt = readAt;
        update.run(serializeDoc(doc), userId, id);
        count += 1;
      }
      return count;
    });
    return transaction();
  }

  async markAllRead(userId: string, readAt: string) {
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare(
        'SELECT notification_id, doc FROM workspace_notifications WHERE user_id = ?',
      ).all(userId) as Array<{ notification_id: string; doc: string }>;
      const update = this.db.prepare(
        'UPDATE workspace_notifications SET doc = ? WHERE notification_id = ?',
      );
      let count = 0;
      for (const row of rows) {
        const doc = deserializeDoc<WorkspaceNotificationDocument>(row.doc);
        if (doc.readAt) continue;
        doc.readAt = readAt;
        update.run(serializeDoc(doc), row.notification_id);
        count += 1;
      }
      return count;
    });
    return transaction();
  }

}
