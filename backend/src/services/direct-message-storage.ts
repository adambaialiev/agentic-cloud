import type { DirectMessage, DirectMessageFile } from '../shared/direct-messages.js';

export class DirectMessageConflict extends Error {}

export interface DirectMessageSummary {
  peerId: string;
  lastMessage: DirectMessage;
  unread: number;
}
/** Callers authorize current membership. Every method is async: in production
 * the text lives on the workplace's own messaging machine (note #608), not in
 * the platform database. `unread` and `count` must answer WITHOUT reaching
 * that machine — Home asks every five seconds, and would never let it sleep.
 * No method accepts an arbitrary thread ID:
 * every read and write is keyed by the authenticated human and their peer. */
export interface DirectMessageStorage {
  inbox(orgId: string, userId: string): Promise<DirectMessageSummary[]>;
  page(orgId: string, userId: string, peerId: string, limit: number, before?: number, after?: number): Promise<{ messages: DirectMessage[]; hasMore: boolean }>;
  /** `files`: ids of this sender's own unsent uploads for this conversation (note #1125). */
  send(orgId: string, userId: string, peerId: string, text: string, clientId: string, files?: string[]): Promise<{ message: DirectMessage; created: boolean }>;
  readThrough(orgId: string, userId: string, peerId: string, messageId: number): Promise<void>;
  /** How many people in the workplace have been written to — zero means no conversations. */
  count(orgId: string): Promise<number>;
  unread(orgId: string, userId: string): Promise<number>;
  /**
   * A deleted workplace (2026-09-22): drop what the PLATFORM keeps about its
   * conversations. The text itself is on the workplace's own messaging
   * machine, in its own cloud account, and is left there with it.
   */
  forgetWorkplace?(orgId: string): Promise<void>;
  /**
   * Note #1104: start the workplace's messaging machine in the background,
   * because Home drew the Messages card. Reads nothing; never waits for the
   * machine. Absent where there is no machine to wake (development).
   */
  wake?(orgId: string): Promise<void>;
  /**
   * Note #1125: files. Absent where messages have no machine to keep bytes
   * on (development). An upload is PENDING — its uploader's alone — until a
   * send names it; `thumbOf` stores a picture's small copy beside its file.
   */
  files?: DirectMessageFileStorage;
}

export interface DirectMessageUpload {
  name: string;
  type: string;
  width?: number;
  height?: number;
  thumbOf?: string;
}
export interface DirectMessageFileBytes {
  file: DirectMessageFile;
  size: number;
  body: ReadableStream<Uint8Array>;
}
export interface DirectMessageFileStorage {
  upload(orgId: string, userId: string, peerId: string, meta: DirectMessageUpload, bytes: Buffer): Promise<DirectMessageFile>;
  /** Null when this person may not have it: not their pair's, or someone else's unsent upload. */
  read(orgId: string, userId: string, peerId: string, fileId: string, thumb: boolean): Promise<DirectMessageFileBytes | null>;
  /** This person's own unsent uploads among `fileIds`. */
  pending(orgId: string, userId: string, peerId: string, fileIds: string[]): Promise<DirectMessageFile[]>;
  discard(orgId: string, userId: string, peerId: string, fileIds: string[]): Promise<void>;
}
