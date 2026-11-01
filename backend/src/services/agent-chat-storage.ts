import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import type { MediaStorage } from './media-storage.js';
import { inferContentType, sanitizeStorageSegment } from './session-attachments.js';
import { UPLOAD_PART_BYTES } from '../shared/uploads.js';
import { imageDimensions } from '../utils/image-dimensions.js';
import { WORKSPACE_AGENT_CHAT_ID } from '../shared/workspace-recap-chat.js';

/**
 * The Workspace chat screen's record of what an agent and its owner said
 * (inhouse-chat-design, note #131) — the chat SURFACE, not the harness
 * conversation. The CLI's own transcript on the agent's machine remains the
 * only real history; these rows exist so the Mini App has something to render,
 * and losing them never breaks an agent. Append-only, capped, and written
 * beside the recap buffer's three voices: the owner's messages, the agent's
 * replies, and platform notices.
 */

export type AgentChatRole = 'owner' | 'agent' | 'platform';

/**
 * A file riding a chat row — the `ATTACH:` path's Workspace surface. The
 * bytes live in media storage under `storagePath`; the row carries only the
 * facts the screen needs, and `storagePath` never leaves the backend.
 */
export interface AgentChatFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** A picture's pixel size, read from its header when it was stored (note
   *  #302) — what lets the screen draw the row at its final height before the
   *  bytes arrive. Absent on files stored before this existed and on anything
   *  that is not a picture; a preview read fills it in for the former. */
  width?: number;
  height?: number;
  /** Always present on stored rows; stripped from what the screen reads. */
  storagePath?: string;
}

/**
 * A chat file has no product cap (note #943, the owner: "unlimited"). Until
 * then it was 25 MB, borrowed from the harness's attachment rule, and the
 * whole message rode one request into this server's memory. Now a file past
 * one part goes up in parts (`chat-file-uploads.ts`) straight into the
 * workplace's bucket, the agent's machine streams it to disk, and the one
 * ceiling left is the protocol's own: S3 stitches at most 10,000 parts, and
 * a part is 8 MiB — 78 GB. Past that the screen says so, with the number.
 * (A file bigger than the agent's free disk still lands in the chat and
 * downloads; the turn is told it could not be put on the machine, and why.)
 */
export const AGENT_CHAT_FILE_MAX_BYTES = UPLOAD_PART_BYTES * 10_000;

/** The one refusal a chat file can earn for its size. */
export function agentChatFileTooBig(sizeBytes: number): string {
  const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(0);
  return `A chat file can be up to ${gb(AGENT_CHAT_FILE_MAX_BYTES)} GB — this one is ${gb(sizeBytes)} GB.`;
}

/**
 * What one request may carry INLINE (note #672 took the old five-file cap
 * away, note #943 the per-file one). The edge in front of the backend
 * (Cloudflare) answers 413 to any request body over 100 MB before it reaches
 * this code; 95 MB leaves room for the manifest and the envelope around it.
 * The screen sends anything that would not fit in parts first and names it in
 * the manifest instead, so a message is never refused for this — only a
 * client that ignores the parts door can meet it.
 */
export const AGENT_CHAT_MESSAGE_MAX_BYTES = 95 * 1024 * 1024;

/**
 * How many of one message's files are written to media storage at a time. A
 * set of fifty screenshots is fifty objects; firing them all at once buys
 * nothing over a few lanes and turns one send into a burst on the store.
 */
const AGENT_CHAT_UPLOAD_LANES = 6;

/** Why this SET of inline files cannot ride one request, or null. */
export function agentChatFileSetRefusal(sizes: readonly number[]): string | null {
  if (sizes.length === 0) return 'Attach at least one file.';
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= AGENT_CHAT_MESSAGE_MAX_BYTES) return null;
  return `One request carries up to ${AGENT_CHAT_MESSAGE_MAX_BYTES / 1024 / 1024} MB of files inline — these come to ${(total / 1024 / 1024).toFixed(1)} MB. Reload the page and send them again: it sends big files in parts.`;
}

/**
 * `Promise.allSettled` over a message's files, a few lanes at a time. Every
 * item still settles before this returns, which is what lets a caller clean
 * up a failed set without an upload landing after the cleanup.
 */
export async function settleAgentChatUploads<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      try {
        results[at] = { status: 'fulfilled', value: await work(items[at]) };
      } catch (reason) {
        results[at] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_CHAT_UPLOAD_LANES, items.length) }, lane));
  return results;
}

/** The first thing wrong with a Workspace chat upload, or null. */
export function validateAgentChatAttachment(args: {
  fileName: string;
  sizeBytes: number;
}): string | null {
  if (!args.fileName || args.fileName.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.fileName)) {
    return 'File names here are letters, digits, dots, dashes and underscores (up to 120 characters) — rename the file and attach it again.';
  }
  if (args.sizeBytes <= 0) return 'The upload arrived empty.';
  if (args.sizeBytes > AGENT_CHAT_FILE_MAX_BYTES) return agentChatFileTooBig(args.sizeBytes);
  return null;
}

export interface AgentChatMessage {
  /** Monotonic per-agent sequence — the chat screen's incremental-read cursor. */
  seq: number;
  role: AgentChatRole;
  /** A platform row whose presentation is structural rather than prose. */
  kind?: 'new-chat-divider';
  text: string;
  /** ISO timestamp of when the platform saw the message. */
  at: string;
  /** Files selected together in one owner message. */
  files?: AgentChatFile[];
  /**
   * Rows written before multi-file chat shipped, and the agent's single-file
   * ATTACH path. Readers keep accepting this shape indefinitely.
   */
  file?: AgentChatFile;
  /**
   * The Workspace screen a decision-request row opens (note #146): the id of
   * the change proposal (`pr`) or knowledge proposal (`kp`) being asked
   * about. The approve/reject UI lives on that screen; the row is the ask.
   */
  open?: { pr?: string; kp?: string };
  /** The durable mail request rendered and decided inside this chat. */
  mailApprovalId?: string;
}

/**
 * The path segment a chat's files are filed under (note #650): the workplace
 * the agent works in. Media storage picks a workplace's store from that
 * segment, and a person's own id there resolves to their OLDEST workplace —
 * for a member whose agent works in a workplace they joined later, a store
 * that may not exist at all, so every file sent in that chat was refused.
 * The person's id is left only for a record from before workplaces.
 */
export function agentChatStorageOwner(userId: string, orgId: string | undefined): string {
  return orgId?.trim() || userId;
}

/** Where a chat file's bytes live; the prefix is what agent deletion clears. */
export function agentChatStoragePrefix(owner: string, agentId: string): string {
  return `users/${sanitizeStorageSegment(owner, 'user')}/agent-chats/${sanitizeStorageSegment(agentId, 'agent')}/`;
}

export function agentChatAttachmentPath(
  owner: string,
  agentId: string,
  fileId: string,
  fileName: string,
): string {
  return `${agentChatStoragePrefix(owner, agentId)}${sanitizeStorageSegment(fileId, 'file')}/${sanitizeStorageSegment(fileName, 'attachment')}`;
}

/** Where the Workspace Agent's chat files live for one person in one workplace. */
export function recapChatFilePath(user: string, org: string, fileId: string, fileName: string): string {
  return agentChatAttachmentPath(agentChatStorageOwner(user, org), `${WORKSPACE_AGENT_CHAT_ID}-${user}`, fileId, fileName);
}

/** How much of a parted file's head is read to measure a picture. JPEG's
 *  size marker sits after any EXIF block, which can run to 64 KB on its own. */
const UPLOADED_HEAD_BYTES = 256 * 1024;

/**
 * A file that went up in parts, found where its id and name say it is (note
 * #943) and read back for the facts a chat row carries: its real size from
 * the store, never from the client, and a picture's pixel size from its head.
 * Null when there is no such object — a stale or forged id.
 */
export async function uploadedChatFileFacts(media: MediaStorage, storagePath: string): Promise<{ sizeBytes: number; width?: number; height?: number } | null> {
  if (!media.peekObject) return null;
  const peeked = await media.peekObject({ storagePath, bytes: UPLOADED_HEAD_BYTES });
  if (!peeked || peeked.sizeBytes <= 0) return null;
  return { sizeBytes: peeked.sizeBytes, ...(imageDimensions(peeked.head) ?? {}) };
}

/**
 * A stored picture's pixel size, for a row written before sizes were (note
 * #302): read from its head when the store can, rather than from the whole
 * object — a picture in the chat may now be any size at all (note #943).
 */
export async function measureStoredPicture(media: MediaStorage, storagePath: string): Promise<{ width: number; height: number } | null> {
  if (media.peekObject) {
    const peeked = await media.peekObject({ storagePath, bytes: UPLOADED_HEAD_BYTES });
    return peeked ? imageDimensions(peeked.head) : null;
  }
  return imageDimensions(await media.downloadObject({ storagePath }));
}

/**
 * One file a chat message carries: its bytes, inline in the request, or the
 * id of a file that already went up in parts under this conversation's prefix
 * (note #943). The manifest says which.
 */
export type AgentChatUpload =
  | { fileName: string; contentType?: string; data: Uint8Array; uploadId?: undefined }
  | { fileName: string; contentType?: string; uploadId: string; data?: undefined };

/** A message's files, stored: the row's facts, and the digest of what came inline. */
export interface StoredAgentChatUpload {
  file: AgentChatFile & { storagePath: string };
  /** Only for bytes this server saw whole; a parted file is checked by size. */
  sha256?: string;
}

export class AgentChatUploadsFailed extends Error {}

/**
 * Every file of one message into media storage — inline bytes written, parted
 * files found where they were put — or none of them: on any failure the bytes
 * this request wrote are deleted again, and the caller says that nothing was
 * sent.
 */
export async function storeAgentChatUploads(
  media: MediaStorage,
  uploads: readonly AgentChatUpload[],
  pathFor: (fileId: string, fileName: string) => string,
): Promise<StoredAgentChatUpload[]> {
  const prepared = uploads.map((upload) => {
    const id = upload.uploadId ?? randomUUID();
    const contentType = inferContentType(upload.fileName, upload.contentType);
    return { upload, id, contentType, storagePath: pathFor(id, upload.fileName) };
  });
  const settled = await settleAgentChatUploads(prepared, async ({ upload, id, contentType, storagePath }): Promise<StoredAgentChatUpload> => {
    if (upload.data === undefined) {
      const facts = await uploadedChatFileFacts(media, storagePath);
      if (!facts) throw new AgentChatUploadsFailed('One of those files did not finish uploading. Nothing was sent — send it again.');
      return { file: { id, fileName: upload.fileName, contentType, ...facts, storagePath } };
    }
    const data = Buffer.isBuffer(upload.data) ? upload.data : Buffer.from(upload.data.buffer, upload.data.byteOffset, upload.data.byteLength);
    await media.uploadObject({ storagePath, contentType, data });
    return {
      // A picture's size rides the row so the chat can hold its place before
      // the bytes land (note #302); measured from the bytes, not the name.
      file: { id, fileName: upload.fileName, contentType, sizeBytes: data.byteLength, ...(imageDimensions(data) ?? {}), storagePath },
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    // Only what THIS request wrote. A parted file stays where it went up: the
    // id came from the client, and a refused send must never be a way to
    // delete a file some earlier row of the conversation still shows. One
    // nothing points at is cleared with the agent's chat files.
    await Promise.all(prepared.filter(({ upload }) => upload.data !== undefined)
      .map(({ storagePath }) => media.deleteObject?.({ storagePath }).catch(() => {})));
    throw failed.reason instanceof AgentChatUploadsFailed
      ? failed.reason
      : new AgentChatUploadsFailed('Those files could not be uploaded just now. Nothing was sent.');
  }
  return settled.map((result) => (result as PromiseFulfilledResult<StoredAgentChatUpload>).value);
}

/**
 * A chat window, not an archive: enough rows that reopening the screen shows
 * the whole recent conversation, small enough that a chatty agent cannot grow
 * a table nobody reads. Oldest rows are trimmed as new ones land.
 */
export const AGENT_CHAT_MESSAGE_CAP = 500;

/**
 * How far back `getLatestTextByRole` looks for one voice's newest words. A
 * reply sits within a handful of rows of the end of any real conversation, so
 * this is a peek, not a search — and it is what lets the fleet's details
 * screens be seeded from one state read without every agent dragging its whole
 * 500-row window through memory. Beyond it the answer is null, which readers
 * already treat as "nothing to show" rather than an error.
 */
export const AGENT_CHAT_LATEST_SCAN = 40;

export interface AgentChatAppendResult {
  seq: number;
  /**
   * Rows the cap pushed out with this append, whole — so the caller can put
   * their file bytes (which live outside this table) to rest as well.
   */
  trimmed: AgentChatMessage[];
}

export interface AgentChatStorage {
  /** Appends one message; returns its seq and whatever the cap trimmed. */
  append(
    userId: string,
    agentId: string,
    message: Omit<AgentChatMessage, 'seq'>,
  ): Promise<AgentChatAppendResult>;
  /** Rows with seq strictly greater than `afterSeq`, oldest first. */
  getAfter(userId: string, agentId: string, afterSeq: number): Promise<AgentChatMessage[]>;
  /**
   * Rewrites one row in place, keeping its seq. The one caller measures a
   * picture stored before its size was recorded and writes the size back so
   * the next read carries it; a seq no longer in the window is a no-op.
   */
  replace(userId: string, agentId: string, seq: number, message: Omit<AgentChatMessage, 'seq'>): Promise<void>;
  /**
   * Newest non-empty text row from one voice, within the newest
   * `AGENT_CHAT_LATEST_SCAN` rows. This is deliberately separate from the
   * incremental chat read: a surface asking for the agent's latest words must
   * not download the whole 500-row window or mark the chat read.
   */
  getLatestTextByRole(
    userId: string,
    agentId: string,
    role: AgentChatRole,
  ): Promise<AgentChatMessage | null>;
  /**
   * The newest MESSAGE in the chat — the owner's or the agent's, whichever
   * was said last — within the same `AGENT_CHAT_LATEST_SCAN` peek, so a
   * fleet can be asked without dragging windows through memory. Platform
   * receipts are stepped over (a turn's receipt after a picture does not make
   * the picture any less the last thing said), and a fresh-chat divider ends
   * the walk with null: what was said before a reset is not this
   * conversation's last message.
   */
  getLatestMessage(userId: string, agentId: string): Promise<AgentChatMessage | null>;
  /** Drops the whole chat — the delete-agent path. */
  deleteForAgent(userId: string, agentId: string): Promise<void>;
}

/** The `getLatestMessage` rule, on one row walked newest-first: the row
 *  itself, `null` to stop with nothing, or `undefined` to keep walking. */
function latestMessageStep(message: AgentChatMessage | null): AgentChatMessage | null | undefined {
  if (!message) return undefined;
  if (message.kind === 'new-chat-divider') return null;
  if (message.role === 'owner' || message.role === 'agent') return message;
  return undefined;
}

export class SqliteAgentChatStorage implements AgentChatStorage {
  constructor(private readonly db: SqliteDb) {}

  /**
   * One stored row, or null when its document will not parse.
   *
   * NULL RATHER THAN A THROW, deliberately. A `JSON.parse` straight into a
   * `map` makes every read of a conversation all-or-nothing: one unreadable
   * document and the whole transcript answers 500, for that one agent,
   * permanently — and the Workspace chat screen has no way back from a read
   * that never succeeds (note #301). These rows are a rendering surface and
   * the file says so above: the CLI's own transcript on the agent's machine is
   * the real history, and losing one of these never breaks an agent. So a row
   * that cannot be read costs its own line and nothing else, which is the rule
   * the reply seeds beside this already follow — "one agent's unreadable chat
   * must not cost the rest of the fleet its seeds".
   */
  private static parse(row: { seq: number; doc: string }): AgentChatMessage | null {
    try {
      return { seq: row.seq, ...JSON.parse(row.doc) as Omit<AgentChatMessage, 'seq'> };
    } catch {
      return null;
    }
  }

  async append(
    userId: string,
    agentId: string,
    message: Omit<AgentChatMessage, 'seq'>,
  ): Promise<AgentChatAppendResult> {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM agent_chat_messages WHERE user_id = ? AND agent_id = ?',
    ).get(userId, agentId) as { maxSeq: number };
    const seq = row.maxSeq + 1;
    this.db.prepare(
      'INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)',
    ).run(userId, agentId, seq, JSON.stringify(message));
    let trimmed: AgentChatMessage[] = [];
    if (seq > AGENT_CHAT_MESSAGE_CAP) {
      const doomed = this.db.prepare(
        'SELECT seq, doc FROM agent_chat_messages WHERE user_id = ? AND agent_id = ? AND seq <= ? ORDER BY seq ASC',
      ).all(userId, agentId, seq - AGENT_CHAT_MESSAGE_CAP) as Array<{ seq: number; doc: string }>;
      // A row whose document will not parse is still a row the cap is
      // dropping; it simply has no file paths to hand back.
      trimmed = doomed.map(SqliteAgentChatStorage.parse).filter((row): row is AgentChatMessage => row !== null);
      this.db.prepare(
        'DELETE FROM agent_chat_messages WHERE user_id = ? AND agent_id = ? AND seq <= ?',
      ).run(userId, agentId, seq - AGENT_CHAT_MESSAGE_CAP);
    }
    return { seq, trimmed };
  }

  async getAfter(userId: string, agentId: string, afterSeq: number): Promise<AgentChatMessage[]> {
    const rows = this.db.prepare(
      'SELECT seq, doc FROM agent_chat_messages WHERE user_id = ? AND agent_id = ? AND seq > ? ORDER BY seq ASC',
    ).all(userId, agentId, afterSeq) as Array<{ seq: number; doc: string }>;
    return rows.map(SqliteAgentChatStorage.parse).filter((row): row is AgentChatMessage => row !== null);
  }

  async replace(userId: string, agentId: string, seq: number, message: Omit<AgentChatMessage, 'seq'>): Promise<void> {
    this.db.prepare(
      'UPDATE agent_chat_messages SET doc = ? WHERE user_id = ? AND agent_id = ? AND seq = ?',
    ).run(JSON.stringify(message), userId, agentId, seq);
  }

  async getLatestTextByRole(
    userId: string,
    agentId: string,
    role: AgentChatRole,
  ): Promise<AgentChatMessage | null> {
    // Walking newest-first lets an owner or platform row after the reply — or
    // a file-only agent row — be skipped without adding presentation columns to
    // this document store. Bounded, because the alternative is materialising
    // every row of a 500-message window to read the last line of it.
    const rows = this.db.prepare(
      'SELECT seq, doc FROM agent_chat_messages WHERE user_id = ? AND agent_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(userId, agentId, AGENT_CHAT_LATEST_SCAN) as Array<{ seq: number; doc: string }>;
    for (const row of rows) {
      const message = SqliteAgentChatStorage.parse(row);
      if (message?.role === role && message.text.trim()) return message;
    }
    return null;
  }

  async getLatestMessage(userId: string, agentId: string): Promise<AgentChatMessage | null> {
    const rows = this.db.prepare(
      'SELECT seq, doc FROM agent_chat_messages WHERE user_id = ? AND agent_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(userId, agentId, AGENT_CHAT_LATEST_SCAN) as Array<{ seq: number; doc: string }>;
    for (const row of rows) {
      const step = latestMessageStep(SqliteAgentChatStorage.parse(row));
      if (step !== undefined) return step;
    }
    return null;
  }

  async deleteForAgent(userId: string, agentId: string): Promise<void> {
    this.db.prepare('DELETE FROM agent_chat_messages WHERE user_id = ? AND agent_id = ?')
      .run(userId, agentId);
  }
}

export class InMemoryAgentChatStorage implements AgentChatStorage {
  private readonly chats = new Map<string, AgentChatMessage[]>();

  async append(
    userId: string,
    agentId: string,
    message: Omit<AgentChatMessage, 'seq'>,
  ): Promise<AgentChatAppendResult> {
    const key = `${userId}/${agentId}`;
    const rows = this.chats.get(key) ?? [];
    const seq = (rows[rows.length - 1]?.seq ?? 0) + 1;
    rows.push({ seq, ...message });
    const trimmed = rows.slice(0, Math.max(0, rows.length - AGENT_CHAT_MESSAGE_CAP));
    this.chats.set(key, rows.slice(-AGENT_CHAT_MESSAGE_CAP));
    return { seq, trimmed };
  }

  async getAfter(userId: string, agentId: string, afterSeq: number): Promise<AgentChatMessage[]> {
    return (this.chats.get(`${userId}/${agentId}`) ?? []).filter((row) => row.seq > afterSeq);
  }

  async replace(userId: string, agentId: string, seq: number, message: Omit<AgentChatMessage, 'seq'>): Promise<void> {
    const rows = this.chats.get(`${userId}/${agentId}`) ?? [];
    const at = rows.findIndex((row) => row.seq === seq);
    if (at >= 0) rows[at] = { seq, ...message };
  }

  async getLatestTextByRole(
    userId: string,
    agentId: string,
    role: AgentChatRole,
  ): Promise<AgentChatMessage | null> {
    const rows = this.chats.get(`${userId}/${agentId}`) ?? [];
    const floor = Math.max(0, rows.length - AGENT_CHAT_LATEST_SCAN);
    for (let index = rows.length - 1; index >= floor; index -= 1) {
      const message = rows[index]!;
      if (message.role === role && message.text.trim()) return message;
    }
    return null;
  }

  async getLatestMessage(userId: string, agentId: string): Promise<AgentChatMessage | null> {
    const rows = this.chats.get(`${userId}/${agentId}`) ?? [];
    const floor = Math.max(0, rows.length - AGENT_CHAT_LATEST_SCAN);
    for (let index = rows.length - 1; index >= floor; index -= 1) {
      const step = latestMessageStep(rows[index]!);
      if (step !== undefined) return step;
    }
    return null;
  }

  async deleteForAgent(userId: string, agentId: string): Promise<void> {
    this.chats.delete(`${userId}/${agentId}`);
  }
}
