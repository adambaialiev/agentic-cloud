import type { WorkspaceMailApproval } from '../shared/workspace-mail.js';
import type { MailAttachmentRecord } from './mail-message-storage.js';

/** The durable half the browser never receives. */
export interface MailApprovalDocument extends WorkspaceMailApproval {
  userId: string;
  agentId: string;
  orgId?: string;
  senderName?: string;
  /** The incoming message a reply answers; absent for a new message. */
  replyToMessageId?: string;
  /** The letter a forward passes on (slice 12). */
  forwardOfMessageId?: string;
  /** For a forward: the words the agent wrote. `text` is everything that
   *  goes out, the forwarded letter included, because that is what the owner
   *  approves; this is what is handed back to the outbox to rebuild it. */
  wrote?: string;
  /**
   * Every file that leaves with it, KEPT when the request was made (slice 12):
   * the agent's own files are staged under the prefix of the message this
   * will become, and a forward's carried files are the letter's own records.
   * Frozen here with the Cc, so an approval retried after an interrupted send
   * hands the provider exactly the same payload under the same key.
   */
  files?: MailAttachmentRecord[];
  /** Stable across retries after an interrupted provider call. */
  outboundId: string;
  sendingAt?: string;
}

export interface MailApprovalStorage {
  create(doc: MailApprovalDocument): Promise<MailApprovalDocument>;
  get(userId: string, id: string): Promise<MailApprovalDocument | null>;
  getMany(userId: string, ids: string[]): Promise<MailApprovalDocument[]>;
  /** pending → sending, atomically. Null means another tap got there first. */
  claim(userId: string, id: string, at: string): Promise<MailApprovalDocument | null>;
  /** pending → rejected, atomically. */
  reject(userId: string, id: string, at: string): Promise<MailApprovalDocument | null>;
  /** sending → sent, atomically. */
  complete(userId: string, id: string, at: string, sentMessageId: string): Promise<MailApprovalDocument | null>;
  /** A provider or validation failure reopens the exact same request. */
  retry(userId: string, id: string, error: string): Promise<MailApprovalDocument | null>;
  /** A request whose chat row could not be written is not a hidden approval. */
  removePending(userId: string, id: string): Promise<void>;
}

/** Unit/dev storage with the same compare-and-set transitions as SQLite. */
export class InMemoryMailApprovalStorage implements MailApprovalStorage {
  private readonly docs = new Map<string, MailApprovalDocument>();
  private key(userId: string, id: string) { return `${userId}/${id}`; }
  private copy(doc: MailApprovalDocument): MailApprovalDocument { return structuredClone(doc); }

  async create(doc: MailApprovalDocument): Promise<MailApprovalDocument> {
    const key = this.key(doc.userId, doc.id);
    if (this.docs.has(key)) throw new Error('mail approval already exists');
    this.docs.set(key, this.copy(doc));
    return this.copy(doc);
  }
  async get(userId: string, id: string): Promise<MailApprovalDocument | null> {
    const doc = this.docs.get(this.key(userId, id));
    return doc ? this.copy(doc) : null;
  }
  async getMany(userId: string, ids: string[]): Promise<MailApprovalDocument[]> {
    const wanted = new Set(ids);
    return [...this.docs.values()]
      .filter((doc) => doc.userId === userId && wanted.has(doc.id))
      .map((doc) => this.copy(doc));
  }
  async claim(userId: string, id: string, at: string): Promise<MailApprovalDocument | null> {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (!doc || doc.status !== 'pending') return null;
    const next = { ...doc, status: 'sending' as const, sendingAt: at, error: undefined };
    this.docs.set(key, next);
    return this.copy(next);
  }
  async reject(userId: string, id: string, at: string): Promise<MailApprovalDocument | null> {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (!doc || doc.status !== 'pending') return null;
    const next = { ...doc, status: 'rejected' as const, decidedAt: at, sendingAt: undefined, error: undefined };
    this.docs.set(key, next);
    return this.copy(next);
  }
  async complete(userId: string, id: string, at: string, sentMessageId: string): Promise<MailApprovalDocument | null> {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (!doc || doc.status !== 'sending') return null;
    const next = { ...doc, status: 'sent' as const, decidedAt: at, sentMessageId, sendingAt: undefined, error: undefined };
    this.docs.set(key, next);
    return this.copy(next);
  }
  async retry(userId: string, id: string, error: string): Promise<MailApprovalDocument | null> {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (!doc || doc.status !== 'sending') return null;
    const next = { ...doc, status: 'pending' as const, sendingAt: undefined, error };
    this.docs.set(key, next);
    return this.copy(next);
  }
  async removePending(userId: string, id: string): Promise<void> {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (doc?.status === 'pending') this.docs.delete(key);
  }
}
