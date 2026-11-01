import type { MailboxDocument, MailboxStorage } from './mailbox-storage.js';
import {
  mailAddress,
  mailLocalHint,
  mailLocalProblem,
  normalizeMailLocal,
  type WorkspaceMailAddressAvailability,
  type WorkspaceMailboxSummary,
} from '../shared/workspace-mail.js';

export class MailboxError extends Error {
  constructor(readonly code: 'invalid_mailbox' | 'mailbox_taken' | 'mailbox_exists', message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}

/**
 * Handing out addresses on the mail domain (note #509). The grammar is shared
 * with the browser; what only this side may decide is who ends up holding a
 * name, so every path through here ends in one storage claim.
 *
 * An address is for keeps. There is no rename and no release once an account
 * holds one: mail already in flight, and every person who wrote it down,
 * would otherwise arrive at whoever took the name next.
 */
export class MailboxService {
  constructor(
    private readonly storage: MailboxStorage,
    private readonly now: () => Date = () => new Date(),
    /**
     * Whether a WORKPLACE holds this word as its handle (knowledge page
     * "public-addresses"): a person's name is also `/<name>` at the root of
     * the domain, one namespace with workplace handles, so a word a workplace
     * has is not free for a person. Absent on a backend with no workplace
     * layer, where nothing else can hold a word.
     */
    private readonly heldByWorkplace: (local: string) => Promise<boolean> = async () => false,
  ) {}

  async forUser(userId: string): Promise<WorkspaceMailboxSummary | null> {
    const mailbox = await this.storage.getByUser(userId);
    return mailbox ? { address: mailbox.address } : null;
  }

  /** The account holding this address, or null. What the sign-in door asks. */
  async holderOf(address: string): Promise<string | null> {
    const mailbox = await this.storage.getByAddress(address.trim().toLowerCase());
    return mailbox?.userId ?? null;
  }

  /** Is this name free? The answer the signup field asks for while it is typed. */
  async availability(raw: unknown): Promise<WorkspaceMailAddressAvailability> {
    const local = normalizeMailLocal(raw);
    const problem = mailLocalProblem(local);
    if (problem) return { local, address: mailAddress(local), available: false, problem };
    if (await this.heldByWorkplace(local)) return { local, address: mailAddress(local), available: false };
    return { local, address: mailAddress(local), available: !await this.storage.getByAddress(mailAddress(local)) };
  }

  /** Take a name for a person, refusing anything the grammar refuses first. */
  async claim(userId: string, raw: unknown): Promise<MailboxDocument> {
    const local = normalizeMailLocal(raw);
    const problem = mailLocalProblem(local);
    if (problem) throw new MailboxError('invalid_mailbox', mailLocalHint(problem));
    if (await this.heldByWorkplace(local)) {
      throw new MailboxError('mailbox_taken', 'That address is already taken. Choose another.');
    }
    const doc: MailboxDocument = {
      address: mailAddress(local),
      localPart: local,
      userId,
      createdAt: this.now().toISOString(),
    };
    const outcome = await this.storage.claim(doc);
    if (outcome === 'address_taken') {
      throw new MailboxError('mailbox_taken', 'That address is already taken. Choose another name.');
    }
    if (outcome === 'user_has_mailbox') {
      throw new MailboxError('mailbox_exists', 'This account already has its own address.');
    }
    return doc;
  }

  /** The rollback for a name whose account could not be created. */
  async release(userId: string, address: string): Promise<void> {
    await this.storage.release(userId, address);
  }

  /** The whole mailbox, wake choice included — what Settings reads. */
  async mailboxOf(userId: string): Promise<MailboxDocument | null> {
    return this.storage.getByUser(userId);
  }

  /**
   * Choose which agent a letter arriving here wakes, or nobody (slice 11).
   * Whether that agent is really this person's is decided by the caller, who
   * is the only side holding the roster.
   */
  async setWakeAgent(userId: string, agentId: string | null): Promise<MailboxDocument | null> {
    return this.storage.setWakeAgent(userId, agentId);
  }
}
