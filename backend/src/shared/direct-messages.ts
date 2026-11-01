/** Private, workplace-scoped human conversations. IDs are ordered cursors. */
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
