import type { MarginComment } from '../../types/comment.js';
import type { KnowledgePageCommentStorage } from '../knowledge-page-comments.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * One row per commented page — `(user_id, page)` is the key the routes ask
 * by, and most pages never grow a row at all. The thread is a doc blob like
 * every other margin here; the append runs whole inside one transaction for
 * the same reason the note store's does.
 */
export class SqliteKnowledgePageCommentStorage implements KnowledgePageCommentStorage {
  constructor(private readonly db: SqliteDb) {}

  private read(userId: string, page: string): MarginComment[] {
    const row = this.db
      .prepare('SELECT doc FROM knowledge_page_comments WHERE user_id = ? AND page = ?')
      .get(userId, page) as { doc: string } | undefined;
    return row ? deserializeDoc<{ comments: MarginComment[] }>(row.doc).comments : [];
  }

  async list(userId: string, page: string): Promise<MarginComment[]> {
    return this.read(userId, page);
  }

  async add(userId: string, page: string, comment: MarginComment): Promise<MarginComment[]> {
    return this.db.transaction(() => {
      const next = [...this.read(userId, page), comment];
      this.db
        .prepare(
          'INSERT INTO knowledge_page_comments (user_id, page, doc) VALUES (?, ?, ?) '
          + 'ON CONFLICT (user_id, page) DO UPDATE SET doc = excluded.doc',
        )
        .run(userId, page, serializeDoc({ comments: next }));
      return next;
    })();
  }

  async edit(userId: string, page: string, commentId: string, text: string, editedAt: string): Promise<MarginComment[] | null> {
    return this.db.transaction(() => {
      const comments = this.read(userId, page);
      const at = comments.findIndex((comment) => comment.id === commentId);
      if (at < 0) return null;
      comments[at] = { ...comments[at]!, text, editedAt };
      this.db
        .prepare('UPDATE knowledge_page_comments SET doc = ? WHERE user_id = ? AND page = ?')
        .run(serializeDoc({ comments }), userId, page);
      return comments;
    })();
  }

  async remove(userId: string, page: string, commentId: string): Promise<MarginComment[] | null> {
    return this.db.transaction(() => {
      const before = this.read(userId, page);
      const comments = before.filter((comment) => comment.id !== commentId);
      if (comments.length === before.length) return null;
      this.db
        .prepare('UPDATE knowledge_page_comments SET doc = ? WHERE user_id = ? AND page = ?')
        .run(serializeDoc({ comments }), userId, page);
      return comments;
    })();
  }

  async deletePage(userId: string, page: string): Promise<void> {
    this.db
      .prepare('DELETE FROM knowledge_page_comments WHERE user_id = ? AND page = ?')
      .run(userId, page);
  }

  async deleteByUser(userId: string): Promise<number> {
    return this.db.prepare('DELETE FROM knowledge_page_comments WHERE user_id = ?').run(userId).changes;
  }

  /** The page moved; its thread moves with it. Whole inside one transaction:
   *  the clear and the update are one change, so a reader can never see the
   *  margin under both names or under neither. */
  async renamePage(userId: string, from: string, to: string): Promise<void> {
    if (from === to) return;
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM knowledge_page_comments WHERE user_id = ? AND page = ?')
        .run(userId, to);
      this.db
        .prepare('UPDATE knowledge_page_comments SET page = ? WHERE user_id = ? AND page = ?')
        .run(to, userId, from);
    })();
  }

  /** A room's page joining the workplace's shelf (note #566): append, then
   *  clear the source, in one transaction — so a crash leaves the thread in
   *  exactly one place and a rerun finds nothing left to move. */
  async movePage(fromUserId: string, fromPage: string, toUserId: string, toPage: string): Promise<void> {
    if (fromUserId === toUserId && fromPage === toPage) return;
    this.db.transaction(() => {
      const moving = this.read(fromUserId, fromPage);
      if (moving.length === 0) return;
      const next = [...this.read(toUserId, toPage), ...moving];
      this.db
        .prepare(
          'INSERT INTO knowledge_page_comments (user_id, page, doc) VALUES (?, ?, ?) '
          + 'ON CONFLICT (user_id, page) DO UPDATE SET doc = excluded.doc',
        )
        .run(toUserId, toPage, serializeDoc({ comments: next }));
      this.db
        .prepare('DELETE FROM knowledge_page_comments WHERE user_id = ? AND page = ?')
        .run(fromUserId, fromPage);
    })();
  }
}
