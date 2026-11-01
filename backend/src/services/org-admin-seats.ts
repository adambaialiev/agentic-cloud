/**
 * The last-admin invariant, held across transitions that are not atomic.
 *
 * Leaving, being removed and demoting yourself all ask the same question —
 * "is there another admin?" — and all answer it by reading the member list.
 * Between that read and the membership row actually moving, the leave and
 * remove routes retire the member's agents: slow, remote work that awaits.
 * Two transitions overlapping in that window both read the same healthy
 * count, both decide they are safe, and both land. The workplace is left
 * with no admin at all, and every 200 in the logs says it went fine.
 *
 * That is a check-then-act race, so the check and the decision to proceed
 * happen together, under one per-workplace lock, and what the winner
 * takes away from it is a RESERVATION on the seat it is about to give up.
 * The reservation outlives the lock — it stands for the whole transition,
 * including the slow retirement — and every later check discounts the seats
 * other in-flight transitions have already promised away. So the second
 * departure sees one admin, minus one already leaving, and is refused while
 * it can still be refused cheaply.
 *
 * Reserving BEFORE the irreversible work is the point of the ordering. The
 * alternative — retire first, re-check at the end — has to reject a member
 * whose agents are already gone, which is not a rejection at all: nothing
 * can put them back. Here the seat is promised while everything is still
 * undoable, so by the time retirement starts the departure is already known
 * to be safe and the final write never has to be taken back.
 *
 * The lock is held only for the read and the reservation, never for the
 * retirement. A departure that hangs on an unreachable machine must not also
 * freeze the promotion that would give the workplace its next admin.
 *
 * This is in-process state, which is what the invariant needs and all it
 * needs: one backend process owns the SQLite database these rows live in.
 */

/** Only the two fields the invariant reads. */
export interface AdminSeatMember {
  userId: string;
  role: string;
}

export type AdminSeatOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'last-admin' };

export class OrgAdminSeats {
  /** Per-workplace critical section, as a chain of promises. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Seats promised away and not yet given up, per workplace. Counted
   * rather than merely present: the same member can have two transitions in
   * flight (a double-tapped Leave), and the first to finish must not release
   * a reservation the second is still standing on.
   */
  private readonly promised = new Map<string, Map<string, number>>();

  /** Run `fn` with nothing else deciding this workplace's membership. */
  private async withOrgLock<T>(orgId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(orgId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(orgId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Nobody queued behind us, so the workplace goes back to holding no
      // lock at all. A later arrival starts a fresh chain rather than one
      // that grows for the life of the process.
      if (this.tails.get(orgId) === tail) this.tails.delete(orgId);
    }
  }

  /** Admins whose seat is not already promised to a transition in flight. */
  private remainingAdmins(
    orgId: string,
    members: readonly AdminSeatMember[],
    departing: string,
  ): number {
    const promised = this.promised.get(orgId);
    return members.filter((member) => (
      member.role === 'admin'
      && member.userId !== departing
      && !promised?.has(member.userId)
    )).length;
  }

  private reserve(orgId: string, userId: string): void {
    const held = this.promised.get(orgId) ?? new Map<string, number>();
    held.set(userId, (held.get(userId) ?? 0) + 1);
    this.promised.set(orgId, held);
  }

  private release(orgId: string, userId: string): void {
    const held = this.promised.get(orgId);
    if (!held) return;
    const count = (held.get(userId) ?? 0) - 1;
    if (count > 0) held.set(userId, count);
    else held.delete(userId);
    if (held.size === 0) this.promised.delete(orgId);
  }

  /**
   * Take a member through a transition that costs the workplace an admin
   * seat — leaving, being removed, or being demoted.
   *
   * `holdsAdmin` false means the transition costs no seat: `settle` runs
   * straight away, unserialized, because it cannot break the invariant.
   *
   * Otherwise the seat is checked and reserved under the lock. `settle` runs
   * outside it, and must be the whole rest of the transition — the retirement
   * AND the membership write — because the reservation is released the moment
   * it returns, and releasing it before the row moves would hand the seat back
   * to the next check while this member is still, on paper, an admin.
   */
  async giveUp<T>(args: {
    orgId: string;
    userId: string;
    holdsAdmin: boolean;
    listMembers: () => Promise<readonly AdminSeatMember[]>;
    settle: () => Promise<T>;
  }): Promise<AdminSeatOutcome<T>> {
    if (!args.holdsAdmin) return { ok: true, value: await args.settle() };

    const reserved = await this.withOrgLock(args.orgId, async () => {
      const members = await args.listMembers();
      if (this.remainingAdmins(args.orgId, members, args.userId) === 0) return false;
      this.reserve(args.orgId, args.userId);
      return true;
    });
    if (!reserved) return { ok: false, reason: 'last-admin' };

    try {
      return { ok: true, value: await args.settle() };
    } finally {
      this.release(args.orgId, args.userId);
    }
  }

  /** In-flight transitions, for tests and for asserting a clean shutdown. */
  get inFlight(): number {
    let total = 0;
    for (const held of this.promised.values()) {
      for (const count of held.values()) total += count;
    }
    return total;
  }
}

/**
 * The invariant belongs to the process, not to a router: it is the one thing
 * that must still hold when two requests are served by anything at all. A
 * per-router instance would quietly stop protecting anything the day a second
 * router is mounted, and that failure would look exactly like the bug this
 * fixes — two successes and no admin left.
 */
export const orgAdminSeats = new OrgAdminSeats();
