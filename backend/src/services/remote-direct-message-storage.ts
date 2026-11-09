import type { DirectMessage } from '../shared/direct-messages.js';
import { DirectMessageConflict, type DirectMessageStorage, type DirectMessageSummary } from './direct-message-storage.js';
import { OrgMsgHostRefusal, type OrgMsgHostService } from './org-msg-host.js';

/**
 * The ONE thing about direct messages the platform keeps (note #608): how
 * many unread messages each person has. A bare number per person — no text,
 * no sender, no pair — so Home's five-second badge and the "is this workplace
 * empty" check never wake the messaging machine, which would otherwise never
 * sleep. The messaging host is the authority: every answer of its that moves
 * a person's total carries the new total, and it is simply written down.
 */
export interface DirectMessageUnreadStore {
  get(orgId: string, userId: string): number;
  set(orgId: string, userId: string, unread: number): void;
  /** People in the workplace who have ever been written to. */
  people(orgId: string): number;
  /** Every counter of one workplace, gone — its deletion. */
  forget?(orgId: string): void;
}

/** Direct messages stored on the workplace's own messaging machine. */
export class RemoteDirectMessageStorage implements DirectMessageStorage {
  constructor(
    private readonly host: Pick<OrgMsgHostService, 'call'> & Partial<Pick<OrgMsgHostService, 'wake'>>,
    private readonly unreadStore: DirectMessageUnreadStore,
  ) {}

  async wake(orgId: string): Promise<void> {
    await this.host.wake?.(orgId);
  }

  async forgetWorkplace(orgId: string): Promise<void> {
    this.unreadStore.forget?.(orgId);
  }

  async inbox(orgId: string, userId: string): Promise<DirectMessageSummary[]> {
    const { threads } = await this.host.call<{ threads: DirectMessageSummary[] }>(orgId, 'inbox', { userId });
    // The inbox is the full truth for this person, so it also heals a number
    // a lost answer left stale.
    const unread = threads.reduce((n, thread) => n + thread.unread, 0);
    if (threads.length || this.unreadStore.get(orgId, userId)) this.unreadStore.set(orgId, userId, unread);
    return threads;
  }

  async page(orgId: string, userId: string, peerId: string, limit: number, before?: number, after?: number) {
    return this.host.call<{ messages: DirectMessage[]; hasMore: boolean }>(orgId, 'page', {
      userId, peerId, limit, ...(before ? { before } : {}), ...(after ? { after } : {}),
    });
  }

  async send(orgId: string, userId: string, peerId: string, text: string, clientId: string) {
    try {
      const answer = await this.host.call<{ message: DirectMessage; created: boolean; peerUnread: number }>(
        orgId, 'send', { userId, peerId, text, clientId });
      this.unreadStore.set(orgId, peerId, answer.peerUnread);
      return { message: answer.message, created: answer.created };
    } catch (error) {
      if (error instanceof OrgMsgHostRefusal && error.status === 409) throw new DirectMessageConflict(error.message);
      throw error;
    }
  }

  async readThrough(orgId: string, userId: string, peerId: string, messageId: number): Promise<void> {
    const { unread } = await this.host.call<{ unread: number }>(orgId, 'read', { userId, peerId, messageId });
    this.unreadStore.set(orgId, userId, unread);
  }

  async count(orgId: string): Promise<number> {
    return this.unreadStore.people(orgId);
  }

  async unread(orgId: string, userId: string): Promise<number> {
    return this.unreadStore.get(orgId, userId);
  }
}
