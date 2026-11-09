/** Private, workplace-scoped human conversations. IDs are ordered cursors. */
/** Whether any door to direct messages is offered (see routes/workspace.ts). */
export const DIRECT_MESSAGES_OFFERED = true;
export const DIRECT_MESSAGE_MAX_LENGTH = 8000;
export const DIRECT_MESSAGE_PAGE_SIZE = 50;
export interface DirectMessage {
  id: number;
  senderId: string;
  text: string;
  createdAt: string;
  clientId: string;
}
export interface DirectMessagePerson {
  userId: string;
  name: string;
  photoUrl?: string;
  available: boolean;
}
export interface DirectMessageThread {
  person: DirectMessagePerson;
  lastMessage: DirectMessage;
  unread: number;
}
export interface DirectMessageInbox {
  threads: DirectMessageThread[];
  unread: number;
}
export interface DirectMessagePage {
  orgName: string;
  person: DirectMessagePerson;
  viewerId: string;
  messages: DirectMessage[];
  hasMore: boolean;
}

/**
 * Note #1090 (Adam, 9 Nov 2026: "Chief of Staff should be able to send
 * message through agentbuilt cli"). A message the person released from their
 * Chief of Staff's card is an ordinary message of theirs, sent with a request
 * id that starts with this prefix — the ONE mark it carries. The messaging
 * machine already keeps and returns every message's request id, so the mark
 * needs no new column there, works on machines built before it, and the
 * platform stores nothing about it. A browser cannot send it
 * (`crypto.randomUUID()` never starts with a "v", and the browser route
 * refuses the prefix), so only the card's tap writes it.
 */
export const DIRECT_MESSAGE_VIA_PREFIX = 'via-cos-';
export function sentViaChiefOfStaff(message: Pick<DirectMessage, 'clientId'>): boolean {
  return typeof message.clientId === 'string' && message.clientId.startsWith(DIRECT_MESSAGE_VIA_PREFIX);
}

/**
 * The Chief of Staff's draft to one teammate, as the person's card sees it.
 * `text` is there only while it waits for the tap: once it is decided — sent,
 * not sent, or expired — the platform keeps no words of it (note #608's
 * storage rule); the message itself lives only on the messaging machine.
 */
export type DirectMessageApprovalStatus = 'pending' | 'sending' | 'sent' | 'rejected' | 'expired';
export interface DirectMessageApproval {
  id: string;
  /** The teammate it goes to, by id (the card's door) and name. */
  to: { userId: string; name: string };
  text?: string;
  status: DirectMessageApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  error?: string;
}
export interface DirectMessageApprovalAnswer { approval: DirectMessageApproval }
/** A draft nobody answered stops being sendable, and its words go. */
export const DIRECT_MESSAGE_APPROVAL_TTL_MS = 24 * 60 * 60_000;
