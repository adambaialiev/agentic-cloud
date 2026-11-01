import type { OrgSeatProvider } from '../types/org.js';
import type { SeatSignInPhase } from './org-seat-signin-flow.js';
import type { CodexDeviceCode } from '../agent/codex/codex-device-login.js';

/**
 * A seat sign-in ceremony that was outstanding when the backend stopped.
 *
 * Deploys restart this service, and the ceremony used to live only in
 * `OrgSeatSignInFlow`'s in-memory map — so a deploy in the middle of one
 * silently ate it. Observed live on 2026-09-06, when the Codex ceremony still
 * ran on the member's machine: the device flow started 04:23:57, an unrelated
 * deploy restarted the backend at 04:29:49, and the new process came up with
 * an empty map. The member's screen showed neither a result nor an error —
 * the poll simply answered "no sign-in here" — and the one-time code they had
 * already approved was spent on nothing.
 *
 * One document per member, written while a Codex device login waits for the
 * member's approval and deleted the moment it is approved, reaches a
 * terminal state, is cancelled, or lapses. This is transient operational
 * state with a hard ceiling: nothing here outlives the provider's own code
 * lifetime (SIGNIN_MAX_AGE_MS).
 *
 * **Only a Codex ceremony is persisted.** Its member approves on OpenAI's
 * page, where nothing of ours sees them, so forgetting it wastes an approval
 * nobody is told about. What it carries is the device login itself: the code
 * the member is already reading off their own screen, and the id that
 * collects the login once they approve — worthless without that approval,
 * which only the member can give, and expired within the quarter hour. The
 * Claude mint's PKCE verifier is live secret material whose paste comes back
 * to us, so a restart costs that member one tap and it is not written down.
 */
export interface SeatSignInDocument {
  /** One ceremony per member; the member is the key. */
  userId: string;
  /** Pinned at start, so a restart cannot land the seat in another org. */
  orgId: string;
  provider: OrgSeatProvider;
  /** Epoch ms — the ceremony's age bound, carried across the restart with it. */
  startedAt: number;
  state: SeatSignInPhase;
  /**
   * The device login the poll resumes. Absent on a record written before
   * 2026-09-22, when the ceremony was a CLI on a machine; restore drops those.
   */
  device?: CodexDeviceCode;
}

export interface SeatSignInStorage {
  save(doc: SeatSignInDocument): Promise<void>;
  /** Every outstanding ceremony, for the boot-time restore. */
  listAll(): Promise<SeatSignInDocument[]>;
  delete(userId: string): Promise<void>;
}

export class InMemorySeatSignInStorage implements SeatSignInStorage {
  private docs = new Map<string, SeatSignInDocument>();

  async save(doc: SeatSignInDocument): Promise<void> {
    this.docs.set(doc.userId, doc);
  }

  async listAll(): Promise<SeatSignInDocument[]> {
    return [...this.docs.values()];
  }

  async delete(userId: string): Promise<void> {
    this.docs.delete(userId);
  }
}
