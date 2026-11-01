import type { DirectMessage } from '../../shared/direct-messages.js';
import { DirectMessageConflict, type DirectMessageStorage, type DirectMessageSummary } from '../direct-message-storage.js';
import type { SqliteDb } from './sqlite-db.js';

const pair = (a: string, b: string) => a < b ? [a, b] : [b, a];
type Row = { id: number; sender_id: string; text: string; created_at: string; client_id: string };
const message = (r: Row): DirectMessage => ({ id: r.id, senderId: r.sender_id, text: r.text, createdAt: r.created_at, clientId: r.client_id });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  low_id TEXT NOT NULL,
  high_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_id TEXT NOT NULL,
  UNIQUE (org_id, low_id, high_id, sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS direct_messages_by_pair ON direct_messages (org_id, low_id, high_id, id);
CREATE TABLE IF NOT EXISTS direct_message_threads (
  org_id TEXT NOT NULL,
  low_id TEXT NOT NULL,
  high_id TEXT NOT NULL,
  last_id INTEGER NOT NULL,
  low_read INTEGER NOT NULL DEFAULT 0,
  high_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, low_id, high_id)
);
CREATE INDEX IF NOT EXISTS direct_message_threads_by_high ON direct_message_threads (org_id, high_id);
`;

/**
 * DEVELOPMENT AND TESTS ONLY (note #608). Production keeps no message text in
 * the platform database — `RemoteDirectMessageStorage` reaches the workplace's
 * own messaging machine instead. This keeps a backend with no cloud at all
 * usable, on a throwaway in-memory database that it lays its own tables in;
 * index.ts never hands it the real file.
 */
export class SqliteDirectMessageStorage implements DirectMessageStorage {
  constructor(private readonly db: SqliteDb) { db.exec(SCHEMA); }

  async inbox(orgId: string, userId: string): Promise<DirectMessageSummary[]> {
    const rows = this.db.prepare(`SELECT m.*, CASE WHEN t.low_id = ? THEN t.high_id ELSE t.low_id END AS peer_id,
      (SELECT COUNT(*) FROM direct_messages u WHERE u.org_id=t.org_id AND u.low_id=t.low_id AND u.high_id=t.high_id
       AND u.sender_id != ? AND u.id > CASE WHEN t.low_id=? THEN t.low_read ELSE t.high_read END) AS unread
      FROM direct_message_threads t JOIN direct_messages m ON m.id=t.last_id
      WHERE t.org_id=? AND (t.low_id=? OR t.high_id=?) ORDER BY t.last_id DESC`)
      .all(userId, userId, userId, orgId, userId, userId) as (Row & { peer_id: string; unread: number })[];
    return rows.map(r => ({ peerId: r.peer_id, lastMessage: message(r), unread: r.unread }));
  }

  async page(orgId: string, userId: string, peerId: string, limit: number, before?: number, after?: number) {
    const rows = this.db.prepare(`SELECT * FROM direct_messages WHERE org_id=? AND low_id=? AND high_id=?
      ${before ? 'AND id < ?' : after ? 'AND id > ?' : ''} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(orgId, ...pair(userId, peerId), ...(before ? [before] : after ? [after] : []), limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return { messages: (after ? selected : selected.reverse()).map(message), hasMore };
  }

  async send(orgId: string, userId: string, peerId: string, text: string, clientId: string) {
    return this.db.transaction(() => {
      const ids = pair(userId, peerId);
      const existing = this.db.prepare('SELECT * FROM direct_messages WHERE org_id=? AND low_id=? AND high_id=? AND sender_id=? AND client_id=?')
        .get(orgId, ...ids, userId, clientId) as Row | undefined;
      if (existing) {
        if (existing.text !== text) throw new DirectMessageConflict('This send was already used for a different message.');
        return { message: message(existing), created: false };
      }
      const createdAt = new Date().toISOString();
      const result = this.db.prepare('INSERT INTO direct_messages (org_id,low_id,high_id,sender_id,text,created_at,client_id) VALUES (?,?,?,?,?,?,?)')
        .run(orgId, ...ids, userId, text, createdAt, clientId);
      const id = Number(result.lastInsertRowid);
      this.db.prepare(`INSERT INTO direct_message_threads (org_id,low_id,high_id,last_id) VALUES (?,?,?,?)
        ON CONFLICT(org_id,low_id,high_id) DO UPDATE SET last_id=excluded.last_id`).run(orgId, ...ids, id);
      return { message: { id, senderId: userId, text, createdAt, clientId }, created: true };
    }).immediate();
  }

  async readThrough(orgId: string, userId: string, peerId: string, messageId: number): Promise<void> {
    const ids = pair(userId, peerId);
    // A receipt acknowledges only an actual message from THIS conversation.
    // Neither a future cursor nor a message from another pair can clear arrivals.
    if (!this.db.prepare('SELECT 1 FROM direct_messages WHERE org_id=? AND low_id=? AND high_id=? AND id=?').get(orgId, ...ids, messageId)) return;
    const column = ids[0] === userId ? 'low_read' : 'high_read';
    this.db.prepare(`UPDATE direct_message_threads SET ${column}=MAX(${column},?) WHERE org_id=? AND low_id=? AND high_id=?`)
      .run(messageId, orgId, ...ids);
  }

  async unread(orgId: string, userId: string): Promise<number> {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM direct_message_threads t JOIN direct_messages m
      ON m.org_id=t.org_id AND m.low_id=t.low_id AND m.high_id=t.high_id
      WHERE t.org_id=? AND (t.low_id=? OR t.high_id=?) AND m.sender_id != ?
      AND m.id > CASE WHEN t.low_id=? THEN t.low_read ELSE t.high_read END`)
      .get(orgId, userId, userId, userId, userId) as { n: number }).n;
  }

  async count(orgId: string): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM direct_message_threads WHERE org_id=?').get(orgId) as { n: number }).n;
  }
}
