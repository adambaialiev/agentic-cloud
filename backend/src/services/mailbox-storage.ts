/**
 * Who owns which address on the mail domain. One mailbox per person, one
 * person per address, and both halves are decided inside a transaction —
 * two people submitting the same name at the same instant is exactly the
 * case a uniqueness rule written in application code gets wrong.
 *
 * There is no held-but-not-yet-real state: signing up IS choosing the
 * address (note #509), so the account and its address are created together
 * and the name is its owner's from that moment.
 */

export interface MailboxDocument {
  address: string;
  localPart: string;
  userId: string;
  createdAt: string;
  /**
   * The ONE agent this person chose to be woken when a letter arrives here
   * (note #509, slice 11). Absent is the default and means NOBODY: mail
   * starts no turn unless its owner said so in Settings, and an agent that
   * has been deleted or moved out of their reach falls back to absent again.
   *
   * It lives on the mailbox rather than on the profile because the choice is
   * about this ADDRESS — the thing letters arrive at — and a person holds
   * exactly one.
   */
  wakeAgentId?: string;
}

export type MailboxClaimOutcome = 'claimed' | 'address_taken' | 'user_has_mailbox';

export interface MailboxStorage {
  getByAddress(address: string): Promise<MailboxDocument | null>;
  getByUser(userId: string): Promise<MailboxDocument | null>;
  /**
   * Take a name for a person. Refuses an address anybody holds — an address
   * is never reissued — and refuses a second mailbox for one person.
   */
  claim(doc: MailboxDocument): Promise<MailboxClaimOutcome>;
  /**
   * Give a name back — the rollback when the account it was taken for could
   * not be created. Both halves must match, so a mistaken call can never
   * take an address off somebody who is using it.
   */
  release(userId: string, address: string): Promise<void>;
  /**
   * Choose (or unchoose) the agent a letter wakes. Answers the mailbox as it
   * now stands, or null when this person holds no address. Writing the same
   * choice twice is not an error: this is a setting, not a claim.
   */
  setWakeAgent(userId: string, agentId: string | null): Promise<MailboxDocument | null>;
}
