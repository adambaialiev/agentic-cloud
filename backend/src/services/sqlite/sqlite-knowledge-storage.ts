import { randomUUID } from 'node:crypto';
import type { MarginComment } from '../../types/comment.js';
import type { KnowledgeProposalDocument } from '../../types/knowledge.js';
import type { KnowledgeProposalStorage } from '../knowledge-storage.js';
import type { NumberSeries } from '../workplace-numbers.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * `user_id` + `number` are real columns: the pair is how the CLI, the chat card
 * and the Workspace all address a proposal, and UNIQUE across it stops two
 * concurrent `knowledge propose` calls minting the same "#3".
 */
export class SqliteKnowledgeProposalStorage implements KnowledgeProposalStorage {
  constructor(private readonly db: SqliteDb) {}

  /**
   * The next number of a series (note #741), from a counter that only goes
   * up. Seeded in the same statement from the highest number any of the
   * series' namespaces holds and from every per-room counter among them, so
   * a workplace series started over rooms full of per-room numbers begins
   * above all of them, and a room deleted with its proposals never sees a
   * number of its reissued. One transaction, so two concurrent proposals
   * cannot read the same counter.
   */
  private allocateNumber(numbering: NumberSeries): number {
    return this.db.transaction(() => {
      const namespaces = [...new Set([numbering.series, ...numbering.namespaces])];
      const placeholders = namespaces.map(() => '?').join(', ');
      this.db.prepare(`
        INSERT INTO knowledge_proposal_numbers (series, issued)
        SELECT ?, MAX(
          COALESCE((SELECT MAX(number) FROM knowledge_proposals WHERE user_id IN (${placeholders})), 0),
          COALESCE((SELECT MAX(issued) FROM knowledge_proposal_numbers WHERE series IN (${placeholders})), 0)
        )
        ON CONFLICT (series) DO NOTHING
      `).run(numbering.series, ...namespaces, ...namespaces);
      this.db.prepare('UPDATE knowledge_proposal_numbers SET issued = issued + 1 WHERE series = ?').run(numbering.series);
      return (this.db
        .prepare('SELECT issued FROM knowledge_proposal_numbers WHERE series = ?')
        .get(numbering.series) as { issued: number }).issued;
    })();
  }

  async create(
    doc: Omit<KnowledgeProposalDocument, 'id' | 'createdAt' | 'number'>,
    numbering?: NumberSeries,
  ): Promise<KnowledgeProposalDocument> {
    const full: KnowledgeProposalDocument = {
      ...doc,
      id: randomUUID(),
      number: this.allocateNumber(numbering ?? { series: doc.userId, namespaces: [doc.userId] }),
      createdAt: new Date().toISOString(),
    };
    try {
      this.db
        .prepare('INSERT INTO knowledge_proposals (proposal_id, user_id, number, doc) VALUES (?, ?, ?, ?)')
        .run(full.id, full.userId, full.number, serializeDoc(full));
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new Error('another proposal was created at the same moment — try again');
      }
      throw error;
    }
    return full;
  }

  async get(id: string): Promise<KnowledgeProposalDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM knowledge_proposals WHERE proposal_id = ?')
      .get(id) as { doc: string } | undefined;
    return row ? deserializeDoc<KnowledgeProposalDocument>(row.doc) : null;
  }

  async getByNumber(userId: string, number: number): Promise<KnowledgeProposalDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM knowledge_proposals WHERE user_id = ? AND number = ?')
      .get(userId, number) as { doc: string } | undefined;
    return row ? deserializeDoc<KnowledgeProposalDocument>(row.doc) : null;
  }

  async findByNumber(namespaces: readonly string[], number: number): Promise<KnowledgeProposalDocument[]> {
    if (!namespaces.length) return [];
    const placeholders = namespaces.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT doc FROM knowledge_proposals WHERE user_id IN (${placeholders}) AND number = ?`)
      .all(...namespaces, number) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<KnowledgeProposalDocument>(row.doc));
  }

  async listByUser(userId: string): Promise<KnowledgeProposalDocument[]> {
    const rows = this.db
      .prepare('SELECT doc FROM knowledge_proposals WHERE user_id = ? ORDER BY number')
      .all(userId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<KnowledgeProposalDocument>(row.doc));
  }

  async listOpenByUser(userId: string): Promise<KnowledgeProposalDocument[]> {
    return (await this.listByUser(userId)).filter((doc) => doc.status === 'open');
  }

  async listAllOpen(): Promise<KnowledgeProposalDocument[]> {
    const rows = this.db
      .prepare("SELECT doc FROM knowledge_proposals WHERE json_extract(doc, '$.status') = 'open'")
      .all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<KnowledgeProposalDocument>(row.doc))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async update(id: string, updates: Partial<KnowledgeProposalDocument>): Promise<boolean> {
    const doc = await this.get(id);
    if (!doc) return false;
    const next = { ...doc, ...updates };
    const result = this.db
      .prepare('UPDATE knowledge_proposals SET user_id = ?, number = ?, doc = ? WHERE proposal_id = ?')
      .run(next.userId, next.number, serializeDoc(next), id);
    return result.changes > 0;
  }

  async deleteByUser(userId: string): Promise<number> {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_proposal_numbers WHERE series = ?').run(userId);
      return this.db.prepare('DELETE FROM knowledge_proposals WHERE user_id = ?').run(userId).changes;
    })();
  }

  async deleteSeries(series: string): Promise<void> {
    this.db.prepare('DELETE FROM knowledge_proposal_numbers WHERE series = ?').run(series);
  }

  /** The one write with a real race in it — a person tapping Send and an
   *  agent mid-turn — so the append runs whole inside one transaction, the
   *  same shape as the note store's. */
  async addComment(id: string, comment: MarginComment): Promise<KnowledgeProposalDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM knowledge_proposals WHERE proposal_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<KnowledgeProposalDocument>(row.doc);
      const next = { ...doc, comments: [...(doc.comments ?? []), comment] };
      this.db
        .prepare('UPDATE knowledge_proposals SET doc = ? WHERE proposal_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }

  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<KnowledgeProposalDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM knowledge_proposals WHERE proposal_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<KnowledgeProposalDocument>(row.doc);
      const at = (doc.comments ?? []).findIndex((comment) => comment.id === commentId);
      if (at < 0) return null;
      const comments = [...(doc.comments ?? [])];
      comments[at] = { ...comments[at]!, text, editedAt };
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE knowledge_proposals SET doc = ? WHERE proposal_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }

  async deleteComment(id: string, commentId: string): Promise<KnowledgeProposalDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM knowledge_proposals WHERE proposal_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = deserializeDoc<KnowledgeProposalDocument>(row.doc);
      const comments = (doc.comments ?? []).filter((comment) => comment.id !== commentId);
      if (comments.length === (doc.comments ?? []).length) return null;
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE knowledge_proposals SET doc = ? WHERE proposal_id = ?')
        .run(serializeDoc(next), id);
      return next;
    })();
  }
}
