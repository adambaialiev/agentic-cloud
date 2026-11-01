import type { DirectMessage } from '../shared/direct-messages.js';

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
  send(orgId: string, userId: string, peerId: string, text: string, clientId: string): Promise<{ message: DirectMessage; created: boolean }>;
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
}
