import { randomUUID } from 'node:crypto';
import type { MarginComment } from '../types/comment.js';
import type { KnowledgeProposalDocument } from '../types/knowledge.js';
import { highestNumber, type NumberSeries } from './workplace-numbers.js';

/**
 * Storage for knowledge proposals (docs/agent-knowledge-pages.md). `number` is
 * allocated here, not per repo as PR numbers are: since note #741 from one
 * series for the whole WORKPLACE (`NumberSeries`, passed by the route that
 * knows it), so "knowledge proposal #3" is unambiguous without naming a room.
 * Proposals numbered per room before that kept their numbers, which is why
 * `findByNumber` answers with every match and the caller picks
 * (`pickNumbered`). Without a series — a personal account — the namespace is
 * its own series, exactly as before.
 *
 * The proposed HTML lives in the document. An unapproved page is therefore
 * nowhere a reader can reach — not on a branch, not in the base — which is the
 * whole reason a one-file document does not need one.
 */
export interface KnowledgeProposalStorage {
  create(
    doc: Omit<KnowledgeProposalDocument, 'id' | 'createdAt' | 'number'>,
    numbering?: NumberSeries,
  ): Promise<KnowledgeProposalDocument>;
  get(id: string): Promise<KnowledgeProposalDocument | null>;
  getByNumber(userId: string, number: number): Promise<KnowledgeProposalDocument | null>;
  /** Every proposal in these namespaces holding the number (note #741). */
  findByNumber(namespaces: readonly string[], number: number): Promise<KnowledgeProposalDocument[]>;
  listByUser(userId: string): Promise<KnowledgeProposalDocument[]>;
  listOpenByUser(userId: string): Promise<KnowledgeProposalDocument[]>;
  /** Every open proposal anywhere — for the one-time settling of what was
   *  still waiting when knowledge stopped needing approval (note #746). */
  listAllOpen(): Promise<KnowledgeProposalDocument[]>;
  update(id: string, updates: Partial<KnowledgeProposalDocument>): Promise<boolean>;
  /** Room deletion removes the room's complete proposal history. */
  deleteByUser(userId: string): Promise<number>;
  /** Forget a workplace's number series, with the workplace itself. */
  deleteSeries(series: string): Promise<void>;
  /**
   * Appends a remark. Its own method for the reason the note store's is
   * (`QuickNoteStorage.addComment`): the writers are a person tapping Send
   * and an agent mid-turn, and a read-modify-write from each would quietly
   * drop one of them. Implementations do the whole append atomically.
   */
  addComment(id: string, comment: MarginComment): Promise<KnowledgeProposalDocument | null>;
  editComment(id: string, commentId: string, text: string, editedAt: string): Promise<KnowledgeProposalDocument | null>;
  /** Takes the author's own remark out of the thread, whole. */
  deleteComment(id: string, commentId: string): Promise<KnowledgeProposalDocument | null>;
}

export function nextKnowledgeProposalNumber(existing: KnowledgeProposalDocument[]): number {
  // Max + 1, never count + 1: a rejected or withdrawn proposal keeps its
  // number, and reusing one would make "#3" mean two things in one chat.
  return highestNumber(existing) + 1;
}

export class InMemoryKnowledgeProposalStorage implements KnowledgeProposalStorage {
  private docs = new Map<string, KnowledgeProposalDocument>();
  /** Highest number a series ever issued — a room's proposals leave with the
   *  room, and its numbers must not come back. */
  private issued = new Map<string, number>();

  async create(
    doc: Omit<KnowledgeProposalDocument, 'id' | 'createdAt' | 'number'>,
    numbering?: NumberSeries,
  ): Promise<KnowledgeProposalDocument> {
    const series = numbering ?? { series: doc.userId, namespaces: [doc.userId] };
    const number = Math.max(
      this.issued.get(series.series) ?? 0,
      ...series.namespaces.map((namespace) => this.issued.get(namespace) ?? 0),
      ...await Promise.all(series.namespaces.map(async (namespace) => nextKnowledgeProposalNumber(await this.listByUser(namespace)) - 1)),
    ) + 1;
    this.issued.set(series.series, number);
    this.issued.set(doc.userId, Math.max(this.issued.get(doc.userId) ?? 0, number));
    const full: KnowledgeProposalDocument = {
      ...doc,
      id: randomUUID(),
      number,
      createdAt: new Date().toISOString(),
    };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<KnowledgeProposalDocument | null> {
    return this.docs.get(id) ?? null;
  }

  async getByNumber(userId: string, number: number): Promise<KnowledgeProposalDocument | null> {
    for (const doc of this.docs.values()) {
      if (doc.userId === userId && doc.number === number) return doc;
    }
    return null;
  }

  async findByNumber(namespaces: readonly string[], number: number): Promise<KnowledgeProposalDocument[]> {
    const wanted = new Set(namespaces);
    return [...this.docs.values()].filter((doc) => wanted.has(doc.userId) && doc.number === number);
  }

  async listByUser(userId: string): Promise<KnowledgeProposalDocument[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.userId === userId)
      .sort((a, b) => a.number - b.number);
  }

  async listOpenByUser(userId: string): Promise<KnowledgeProposalDocument[]> {
    return (await this.listByUser(userId)).filter((doc) => doc.status === 'open');
  }

  async listAllOpen(): Promise<KnowledgeProposalDocument[]> {
    return [...this.docs.values()].filter((doc) => doc.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async update(id: string, updates: Partial<KnowledgeProposalDocument>): Promise<boolean> {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.set(id, { ...doc, ...updates });
    return true;
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [id, doc] of this.docs) {
      if (doc.userId !== userId) continue;
      this.docs.delete(id);
      removed += 1;
    }
    this.issued.delete(userId);
    return removed;
  }

  async deleteSeries(series: string): Promise<void> {
    this.issued.delete(series);
  }

  async addComment(id: string, comment: MarginComment): Promise<KnowledgeProposalDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const next = { ...doc, comments: [...(doc.comments ?? []), comment] };
    this.docs.set(id, next);
    return next;
  }

  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<KnowledgeProposalDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const at = (doc.comments ?? []).findIndex((comment) => comment.id === commentId);
    if (at < 0) return null;
    const comments = [...(doc.comments ?? [])];
    comments[at] = { ...comments[at]!, text, editedAt };
    const next = { ...doc, comments };
    this.docs.set(id, next);
    return next;
  }

  async deleteComment(id: string, commentId: string): Promise<KnowledgeProposalDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const comments = (doc.comments ?? []).filter((comment) => comment.id !== commentId);
    if (comments.length === (doc.comments ?? []).length) return null;
    const next = { ...doc, comments };
    this.docs.set(id, next);
    return next;
  }
}
