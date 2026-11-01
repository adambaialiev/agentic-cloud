import { describe, expect, it } from 'vitest';
import { OrgAdminSeats, type AdminSeatMember } from '../../services/org-admin-seats.js';

/**
 * The invariant this holds is "a workplace always has an admin", and the
 * only interesting cases are the ones where two transitions overlap. Every
 * test here therefore starts one transition, holds it open at the point the
 * real routes await a remote agent retirement, and runs the second one into
 * it — which is exactly the window the September 5 simulations found.
 */

/** A transition parked at its slow step until the test lets it finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Let every started transition reach its slow step before asserting. */
const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const twoAdmins: AdminSeatMember[] = [
  { userId: 'a', role: 'admin' },
  { userId: 'b', role: 'admin' },
];

describe('OrgAdminSeats', () => {
  it('refuses the second of two overlapping admin departures', async () => {
    const seats = new OrgAdminSeats();
    const retirement = gate();
    let landed = false;

    const first = seats.giveUp({
      orgId: 'org-1',
      userId: 'a',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { await retirement.opened; landed = true; return 'gone'; },
    });

    // B asks while A is still retiring. Both read the same two admins from
    // storage — A's row does not move until its retirement finishes — so
    // only the reservation can tell B that one of them is spoken for.
    const second = await seats.giveUp({
      orgId: 'org-1',
      userId: 'b',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { throw new Error('B must never reach its slow work'); },
    });
    expect(second).toEqual({ ok: false, reason: 'last-admin' });
    expect(landed).toBe(false);

    retirement.open();
    expect(await first).toEqual({ ok: true, value: 'gone' });
    expect(seats.inFlight).toBe(0);
  });

  it('refuses a self-demotion that overlaps the other admin’s departure', async () => {
    const seats = new OrgAdminSeats();
    const retirement = gate();

    const leaving = seats.giveUp({
      orgId: 'org-1',
      userId: 'a',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { await retirement.opened; return 'gone'; },
    });

    const demotion = await seats.giveUp({
      orgId: 'org-1',
      userId: 'b',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { throw new Error('B must never be demoted'); },
    });
    expect(demotion).toEqual({ ok: false, reason: 'last-admin' });

    retirement.open();
    await leaving;
  });

  it('gives the seat back when the transition fails, so the member can try again', async () => {
    const seats = new OrgAdminSeats();
    const refused = await seats.giveUp({
      orgId: 'org-1',
      userId: 'a',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { throw new Error('the machine could not be reached'); },
    }).catch((error: Error) => error.message);
    expect(refused).toBe('the machine could not be reached');
    // The seat was never given up, so B is still free to leave instead.
    expect(seats.inFlight).toBe(0);
    const next = await seats.giveUp({
      orgId: 'org-1',
      userId: 'b',
      holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => 'gone',
    });
    expect(next).toEqual({ ok: true, value: 'gone' });
  });

  it('lets the last admin leave once somebody else has been promoted', async () => {
    const seats = new OrgAdminSeats();
    const sole: AdminSeatMember[] = [{ userId: 'a', role: 'admin' }, { userId: 'b', role: 'member' }];
    expect(await seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => sole,
      settle: async () => 'gone',
    })).toEqual({ ok: false, reason: 'last-admin' });

    expect(await seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => 'gone',
    })).toEqual({ ok: true, value: 'gone' });
  });

  it('never blocks a departure that costs no admin seat', async () => {
    const seats = new OrgAdminSeats();
    const retirement = gate();
    const admin = seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { await retirement.opened; return 'admin gone'; },
    });
    // An ordinary member leaving while an admin retires: their transition
    // cannot break the invariant, so it must not wait on the lock either.
    expect(await seats.giveUp({
      orgId: 'org-1', userId: 'c', holdsAdmin: false,
      listMembers: async () => { throw new Error('a member departure reads nothing'); },
      settle: async () => 'member gone',
    })).toEqual({ ok: true, value: 'member gone' });
    retirement.open();
    await admin;
  });

  it('holds the invariant separately per workplace', async () => {
    const seats = new OrgAdminSeats();
    const retirement = gate();
    const first = seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => { await retirement.opened; return 'gone'; },
    });
    // A different workplace's admins are not the ones being promised away.
    expect(await seats.giveUp({
      orgId: 'org-2', userId: 'a', holdsAdmin: true,
      listMembers: async () => twoAdmins,
      settle: async () => 'gone',
    })).toEqual({ ok: true, value: 'gone' });
    retirement.open();
    await first;
  });

  it('counts a member’s two overlapping departures separately', async () => {
    const seats = new OrgAdminSeats();
    const firstGate = gate();
    const secondGate = gate();
    const threeAdmins: AdminSeatMember[] = [...twoAdmins, { userId: 'c', role: 'admin' }];

    // A double-tapped Leave. The first to finish must not hand A's seat back
    // while the second is still standing on it.
    const first = seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => threeAdmins,
      settle: async () => { await firstGate.opened; return 1; },
    });
    const second = seats.giveUp({
      orgId: 'org-1', userId: 'a', holdsAdmin: true,
      listMembers: async () => threeAdmins,
      settle: async () => { await secondGate.opened; return 2; },
    });
    await settled();
    expect(seats.inFlight).toBe(2);
    firstGate.open();
    await first;
    expect(seats.inFlight).toBe(1);

    // B may still leave — C remains — but with A's seat still reserved,
    // C may not follow.
    expect(await seats.giveUp({
      orgId: 'org-1', userId: 'b', holdsAdmin: true,
      listMembers: async () => threeAdmins,
      settle: async () => 'b gone',
    })).toEqual({ ok: true, value: 'b gone' });

    secondGate.open();
    await second;
    expect(seats.inFlight).toBe(0);
  });

  it('serializes checks so two arrivals cannot both read a free seat', async () => {
    const seats = new OrgAdminSeats();
    let reading = 0;
    let overlapped = false;
    // The read itself is asynchronous in production (it goes to storage), so
    // the lock has to cover the read AND the decision, not just the decision.
    const listMembers = async () => {
      reading += 1;
      if (reading > 1) overlapped = true;
      await Promise.resolve();
      reading -= 1;
      return twoAdmins;
    };
    // Both transitions stay open until the gate lifts, which is what makes
    // them genuinely concurrent rather than merely started together.
    const retirement = gate();
    const settle = async () => { await retirement.opened; return 'gone'; };
    const both = Promise.all([
      seats.giveUp({ orgId: 'org-1', userId: 'a', holdsAdmin: true, listMembers, settle }),
      seats.giveUp({ orgId: 'org-1', userId: 'b', holdsAdmin: true, listMembers, settle }),
    ]);
    await settled();
    retirement.open();
    const results = await both;
    expect(overlapped).toBe(false);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });
});
