import { randomBytes } from 'node:crypto';
import {
  DIRECT_MESSAGE_APPROVAL_TTL_MS,
  DIRECT_MESSAGE_MAX_LENGTH,
  DIRECT_MESSAGE_VIA_PREFIX,
  DIRECT_MESSAGE_FILES_PER_MESSAGE,
  type DirectMessageApproval,
  type DirectMessageApprovalStatus,
  type DirectMessageFile,
} from '../shared/direct-messages.js';
import type { DirectMessageStorage } from './direct-message-storage.js';
import { OrgMsgHostOpening } from './org-msg-host.js';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite/sqlite-db.js';

/**
 * Note #1090: the Chief of Staff drafts a direct message to a teammate, and
 * only the person's tap on the card in its conversation sends it — as the
 * person, through the same storage their own Send uses, marked by its
 * request id (`DIRECT_MESSAGE_VIA_PREFIX`).
 *
 * What the platform keeps (note #608's storage rule): the draft's words only
 * while it WAITS for that tap. Every way out of waiting — sent, not sent,
 * expired — writes the row back without them, so a decided request is a
 * status, a teammate's id and name, and two times. Nothing here ever reads a
 * conversation: the one call into direct-message storage is `send`.
 */
export interface DirectMessageApprovalDocument {
  id: string;
  /** The person whose card it is, and who the message is from. */
  userId: string;
  orgId: string;
  /** The Workspace Agent credential that asked. */
  agentId: string;
  toUserId: string;
  toName: string;
  /** Present only while pending or sending. */
  text?: string;
  /**
   * Note #1125: the files it carries — their names, sizes and ids, present
   * only while it waits. The bytes wait on the messaging machine as the
   * person's own unsent uploads; a tap attaches them, anything else deletes them.
   */
  files?: DirectMessageFile[];
  /** Stable across retries: the messaging machine dedupes on it. */
  clientId: string;
  status: DirectMessageApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  sendingAt?: string;
  error?: string;
}

export interface DirectMessageApprovalStorage {
  create(doc: DirectMessageApprovalDocument): Promise<DirectMessageApprovalDocument>;
  get(userId: string, id: string): Promise<DirectMessageApprovalDocument | null>;
  getMany(userId: string, ids: string[]): Promise<DirectMessageApprovalDocument[]>;
  /** Compare-and-set on status. Null means another tap got there first. */
  transition(userId: string, id: string, from: DirectMessageApprovalStatus,
    change: (doc: DirectMessageApprovalDocument) => DirectMessageApprovalDocument): Promise<DirectMessageApprovalDocument | null>;
  /** A request whose card could not be placed is not a hidden approval. */
  removePending(userId: string, id: string): Promise<void>;
}

export class InMemoryDirectMessageApprovalStorage implements DirectMessageApprovalStorage {
  private readonly docs = new Map<string, DirectMessageApprovalDocument>();
  private key(userId: string, id: string) { return `${userId}/${id}`; }
  async create(doc: DirectMessageApprovalDocument) {
    const key = this.key(doc.userId, doc.id);
    if (this.docs.has(key)) throw new Error('message approval already exists');
    this.docs.set(key, structuredClone(doc));
    return structuredClone(doc);
  }
  async get(userId: string, id: string) {
    const doc = this.docs.get(this.key(userId, id));
    return doc ? structuredClone(doc) : null;
  }
  async getMany(userId: string, ids: string[]) {
    const wanted = new Set(ids);
    return [...this.docs.values()].filter((doc) => doc.userId === userId && wanted.has(doc.id)).map((doc) => structuredClone(doc));
  }
  async transition(userId: string, id: string, from: DirectMessageApprovalStatus,
    change: (doc: DirectMessageApprovalDocument) => DirectMessageApprovalDocument) {
    const key = this.key(userId, id), doc = this.docs.get(key);
    if (!doc || doc.status !== from) return null;
    const next = change(structuredClone(doc));
    this.docs.set(key, structuredClone(next));
    return structuredClone(next);
  }
  async removePending(userId: string, id: string) {
    const key = this.key(userId, id);
    if (this.docs.get(key)?.status === 'pending') this.docs.delete(key);
  }
}

export class SqliteDirectMessageApprovalStorage implements DirectMessageApprovalStorage {
  constructor(private readonly db: SqliteDb) {}
  async create(doc: DirectMessageApprovalDocument) {
    this.db.prepare(
      `INSERT INTO workspace_message_approvals (id, user_id, status, created_at, doc) VALUES (?, ?, ?, ?, ?)`,
    ).run(doc.id, doc.userId, doc.status, doc.createdAt, serializeDoc(doc));
    return structuredClone(doc);
  }
  async get(userId: string, id: string) {
    const row = this.db.prepare('SELECT doc FROM workspace_message_approvals WHERE id = ? AND user_id = ?')
      .get(id, userId) as { doc: string } | undefined;
    return row ? deserializeDoc<DirectMessageApprovalDocument>(row.doc) : null;
  }
  async getMany(userId: string, ids: string[]) {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return [];
    const rows = this.db.prepare(
      `SELECT doc FROM workspace_message_approvals WHERE user_id = ? AND id IN (${unique.map(() => '?').join(', ')})`,
    ).all(userId, ...unique) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<DirectMessageApprovalDocument>(row.doc));
  }
  async transition(userId: string, id: string, from: DirectMessageApprovalStatus,
    change: (doc: DirectMessageApprovalDocument) => DirectMessageApprovalDocument) {
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT status, doc FROM workspace_message_approvals WHERE id = ? AND user_id = ?')
        .get(id, userId) as { status: string; doc: string } | undefined;
      if (!row || row.status !== from) return null;
      const next = change(deserializeDoc<DirectMessageApprovalDocument>(row.doc));
      const updated = this.db.prepare(
        'UPDATE workspace_message_approvals SET status = ?, doc = ? WHERE id = ? AND user_id = ? AND status = ?',
      ).run(next.status, serializeDoc(next), id, userId, from);
      return updated.changes === 1 ? next : null;
    });
    return run.immediate();
  }
  async removePending(userId: string, id: string) {
    this.db.prepare("DELETE FROM workspace_message_approvals WHERE id = ? AND user_id = ? AND status = 'pending'").run(id, userId);
  }
}

export const DIRECT_MESSAGE_APPROVAL_SEND_STALE_MS = 5 * 60_000;

/** What the card may see: never the agent, the request id or the owner. */
export function visibleDirectMessageApproval(doc: DirectMessageApprovalDocument): DirectMessageApproval {
  const waiting = doc.status === 'pending' || doc.status === 'sending';
  return {
    id: doc.id,
    to: { userId: doc.toUserId, name: doc.toName },
    ...(waiting && doc.text ? { text: doc.text } : {}),
    ...(waiting && doc.files?.length ? { files: doc.files } : {}),
    status: doc.status,
    createdAt: doc.createdAt,
    ...(doc.decidedAt ? { decidedAt: doc.decidedAt } : {}),
    ...(doc.error ? { error: doc.error } : {}),
  };
}

/** Decided: the words go, whatever the outcome. */
const settled = (doc: DirectMessageApprovalDocument, status: DirectMessageApprovalStatus, at: string, error?: string): DirectMessageApprovalDocument => {
  const { text: _text, files: _files, sendingAt: _sending, error: _error, ...rest } = doc;
  return { ...rest, status, decidedAt: at, ...(error ? { error } : {}) };
};

export class DirectMessageApprovalError extends Error {}

/** The person a name means among the workplace's other members — or why none. */
export function resolveTeammate(
  people: Array<{ userId: string; name: string }>,
  asked: string,
): { userId: string; name: string } | { error: string } {
  const wanted = asked.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!wanted) return { error: 'Name the teammate to write to.' };
  const byId = people.find((person) => person.userId === asked.trim());
  if (byId) return byId;
  const exact = people.filter((person) => person.name.toLowerCase() === wanted);
  const matches = exact.length ? exact
    : people.filter((person) => person.name.toLowerCase().split(' ')[0] === wanted);
  const names = people.map((person) => `"${person.name}"`).join(', ');
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return { error: `More than one teammate is called "${asked.trim()}" — give the full name or the id. Members: ${names}.` };
  return { error: `"${asked.trim()}" is not a member of this workplace. Members you can write to: ${names}.` };
}

export class DirectMessageApprovalService {
  constructor(
    private readonly storage: DirectMessageApprovalStorage,
    private readonly messages: () => (Pick<DirectMessageStorage, 'send'> & Partial<Pick<DirectMessageStorage, 'files'>>) | undefined,
    private readonly isMember: (orgId: string, userId: string) => Promise<boolean>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A deploy can cut the process between the send and its outcome; the
   *  stable request id makes a retry safe, so a stale send reopens. A draft
   *  nobody answered in a day expires, and takes its words with it. */
  private async current(doc: DirectMessageApprovalDocument): Promise<DirectMessageApprovalDocument> {
    const now = this.now().getTime();
    if (doc.status === 'sending' && doc.sendingAt && now - Date.parse(doc.sendingAt) >= DIRECT_MESSAGE_APPROVAL_SEND_STALE_MS) {
      return await this.storage.transition(doc.userId, doc.id, 'sending', (d) => {
        const { sendingAt: _s, ...rest } = d;
        return { ...rest, status: 'pending', error: 'The last send was interrupted. Review it and try again.' };
      }) ?? doc;
    }
    if (doc.status === 'pending' && now - Date.parse(doc.createdAt) >= DIRECT_MESSAGE_APPROVAL_TTL_MS) {
      const expired = await this.storage.transition(doc.userId, doc.id, 'pending',
        (d) => settled(d, 'expired', this.now().toISOString()));
      if (expired) void this.letGo(doc);
      return expired ?? doc;
    }
    return doc;
  }

  /** A draft that will never be sent takes its waiting files with it (best effort: the machine deletes unsent ones after 26 hours anyway). */
  private async letGo(doc: DirectMessageApprovalDocument): Promise<void> {
    const ids = (doc.files ?? []).map((file) => file.id);
    if (!ids.length) return;
    await this.messages()?.files?.discard(doc.orgId, doc.userId, doc.toUserId, ids)
      .catch(() => { console.warn('[direct-message-approval] waiting files were not discarded; the messaging machine sweeps them'); });
  }

  async request(args: { userId: string; orgId: string; agentId: string; to: { userId: string; name: string }; text: string; files?: DirectMessageFile[] }): Promise<DirectMessageApprovalDocument> {
    const text = args.text.trim();
    const files = args.files ?? [];
    if (files.length > DIRECT_MESSAGE_FILES_PER_MESSAGE) throw new DirectMessageApprovalError(`A message can carry up to ${DIRECT_MESSAGE_FILES_PER_MESSAGE} files.`);
    if ((!text && !files.length) || text.length > DIRECT_MESSAGE_MAX_LENGTH) {
      throw new DirectMessageApprovalError(`Write a message of up to ${DIRECT_MESSAGE_MAX_LENGTH.toLocaleString('en-US')} characters.`);
    }
    if (args.to.userId === args.userId) throw new DirectMessageApprovalError('That is your user. A direct message goes to a teammate.');
    return this.storage.create({
      id: `dma_${randomBytes(9).toString('hex')}`,
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.agentId,
      toUserId: args.to.userId,
      toName: args.to.name,
      text,
      ...(files.length ? { files } : {}),
      clientId: `${DIRECT_MESSAGE_VIA_PREFIX}${randomBytes(12).toString('hex')}`,
      status: 'pending',
      createdAt: this.now().toISOString(),
    });
  }

  async get(userId: string, id: string): Promise<DirectMessageApprovalDocument | null> {
    const doc = await this.storage.get(userId, id);
    return doc ? this.current(doc) : null;
  }

  async getMany(userId: string, ids: string[]): Promise<Map<string, DirectMessageApproval>> {
    const docs = await Promise.all((await this.storage.getMany(userId, ids)).map((doc) => this.current(doc)));
    return new Map(docs.map((doc) => [doc.id, visibleDirectMessageApproval(doc)]));
  }

  async withdraw(userId: string, id: string): Promise<void> {
    await this.storage.removePending(userId, id);
  }

  /** The person's tap — the only path to `send`. `orgId` is the workplace the
   *  tap came from; a card is answered only in its own. */
  async decide(args: { userId: string; orgId: string; id: string; decision: 'approve' | 'reject' }): Promise<DirectMessageApproval | null> {
    const found = await this.get(args.userId, args.id);
    if (!found || found.orgId !== args.orgId) return null;
    if (found.status !== 'pending') return visibleDirectMessageApproval(found);
    const at = this.now().toISOString();
    if (args.decision === 'reject') {
      const done = await this.storage.transition(args.userId, args.id, 'pending', (doc) => settled(doc, 'rejected', at));
      if (done) await this.letGo(found);
      return visibleDirectMessageApproval(done ?? (await this.storage.get(args.userId, args.id)) ?? found);
    }
    if (!await this.isMember(found.orgId, found.toUserId)) {
      const gone = await this.storage.transition(args.userId, args.id, 'pending',
        (doc) => settled(doc, 'rejected', at, `${doc.toName} is no longer in this workplace. Nothing was sent.`));
      if (gone) await this.letGo(found);
      return visibleDirectMessageApproval(gone ?? (await this.storage.get(args.userId, args.id)) ?? found);
    }
    const messages = this.messages();
    if (!messages) {
      const open = await this.storage.transition(args.userId, args.id, 'pending', (doc) => ({ ...doc, error: 'Messages are not available right now. Nothing was sent.' }));
      return visibleDirectMessageApproval(open ?? found);
    }
    const claimed = await this.storage.transition(args.userId, args.id, 'pending', (doc) => {
      const { error: _e, ...rest } = doc;
      return { ...rest, status: 'sending', sendingAt: at };
    });
    if (!claimed) {
      const latest = await this.storage.get(args.userId, args.id);
      return latest ? visibleDirectMessageApproval(latest) : null;
    }
    try {
      await messages.send(claimed.orgId, claimed.userId, claimed.toUserId, claimed.text ?? '', claimed.clientId,
        (claimed.files ?? []).map((file) => file.id));
    } catch (error) {
      // Never log the error itself: it may carry the words.
      const words = error instanceof OrgMsgHostOpening
        ? 'Messages are waking up. Try Send message again in a few seconds.'
        : 'The message could not be sent. Try again in a moment.';
      if (!(error instanceof OrgMsgHostOpening)) console.warn('[direct-message-approval] send failed');
      const reopened = await this.storage.transition(args.userId, args.id, 'sending', (doc) => {
        const { sendingAt: _s, ...rest } = doc;
        return { ...rest, status: 'pending', error: words };
      });
      return visibleDirectMessageApproval(reopened ?? claimed);
    }
    const sent = await this.storage.transition(args.userId, args.id, 'sending', (doc) => settled(doc, 'sent', this.now().toISOString()));
    return visibleDirectMessageApproval(sent ?? (await this.storage.get(args.userId, args.id)) ?? claimed);
  }
}
