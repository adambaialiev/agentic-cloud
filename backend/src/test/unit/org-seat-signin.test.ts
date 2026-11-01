import { describe, expect, it } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { addMemberSeat, memberHasLiveSeat, signInSeatLabel } from '../../services/org-seat-signin.js';

async function makeOrgWithMember(userId = 'dana') {
  const storage = new InMemoryOrgStorage();
  const org = await storage.createOrg({ name: 'Acme Trading', createdByUserId: 'founder' });
  await storage.addMember({ orgId: org.orgId, userId, role: 'member' });
  return { storage, orgId: org.orgId };
}

describe('addMemberSeat — where a completed sign-in ceremony lands', () => {
  it('stores the sign-in as the member\'s newest, selected seat', async () => {
    const { storage, orgId } = await makeOrgWithMember();

    const result = await addMemberSeat({
      orgStorage: storage, userId: 'dana', orgId, provider: 'claude', token: 'sk-ant-oat-fresh',
    });

    expect(result.outcome).toBe('added');
    const seats = await storage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      provider: 'claude', token: 'sk-ant-oat-fresh', status: 'active', selected: true,
    });
  });

  it('answers no_org for a human in no org — the caller falls back to the pre-org path', async () => {
    const storage = new InMemoryOrgStorage();
    const result = await addMemberSeat({
      orgStorage: storage, userId: 'stranger', orgId: 'missing', provider: 'claude', token: 'sk-ant-oat-x',
    });
    expect(result.outcome).toBe('no_org');
  });

  it('replaces this org\'s dead assignments without changing another org', async () => {
    const { storage, orgId } = await makeOrgWithMember();
    const other = await storage.createOrg({ name: 'Other', createdByUserId: 'dana' });
    await storage.addMember({ orgId: other.orgId, userId: 'dana', role: 'admin' });
    const dead = await storage.addSeat({
      orgId, userId: 'dana', provider: 'claude', token: 'sk-ant-oat-revoked',
      label: 'old', status: 'dead',
    });
    await storage.assignSeat(other.orgId, 'dana', dead.seatId);

    const result = await addMemberSeat({
      orgStorage: storage, userId: 'dana', orgId, provider: 'claude', token: 'sk-ant-oat-fresh',
    });

    expect(result).toMatchObject({ outcome: 'added', replacedDeadSeats: 1 });
    const seats = await storage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0].token).toBe('sk-ant-oat-fresh');
    // The new sign-in lands only here. The old private credential and Other's
    // assignment survive until Dana explicitly deletes that sign-in globally.
    expect(await storage.getSeat(dead.seatId)).not.toBeNull();
    expect((await storage.listSeatsByMember(other.orgId, 'dana')).map((seat) => seat.seatId))
      .toEqual([dead.seatId]);
    expect((await storage.listSeatsByMember(other.orgId, 'dana'))[0]?.status).toBe('dead');
  });

  it('never touches live seats — several subscriptions per member is a designed-for shape', async () => {
    const { storage, orgId } = await makeOrgWithMember();
    await storage.addSeat({
      orgId, userId: 'dana', provider: 'claude', token: 'sk-ant-oat-first',
      label: 'work Max', status: 'active',
    });
    await storage.addSeat({
      orgId, userId: 'dana', provider: 'codex', token: '{"openai":"auth"}',
      label: 'ChatGPT', status: 'active',
    });

    await addMemberSeat({
      orgStorage: storage, userId: 'dana', orgId, provider: 'claude', token: 'sk-ant-oat-second',
    });

    const seats = await storage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(3);
    // The fresh sign-in is the claude pick now; the codex pick is untouched.
    const selected = seats.filter((seat) => seat.selected);
    expect(selected.map((seat) => seat.token).sort()).toEqual(['sk-ant-oat-second', '{"openai":"auth"}'].sort());
  });

  it('leaves a cooldown seat alone — it restores itself and is not a re-auth target', async () => {
    const { storage, orgId } = await makeOrgWithMember();
    await storage.addSeat({
      orgId, userId: 'dana', provider: 'claude', token: 'sk-ant-oat-cooling',
      label: 'cooling', status: 'cooldown',
    });

    const result = await addMemberSeat({
      orgStorage: storage, userId: 'dana', orgId, provider: 'claude', token: 'sk-ant-oat-fresh',
    });

    expect(result).toMatchObject({ outcome: 'added', replacedDeadSeats: 0 });
    expect(await storage.listSeatsByMember(orgId, 'dana')).toHaveLength(2);
  });
});

describe('memberHasLiveSeat — the door-or-connect decision', () => {
  it('counts active and cooldown, never dead/disabled, and only the named provider', async () => {
    const { storage, orgId } = await makeOrgWithMember();
    expect(await memberHasLiveSeat(storage, 'dana', 'claude')).toBe(false);

    await storage.addSeat({
      orgId, userId: 'dana', provider: 'claude', token: 't', label: 'l', status: 'dead',
    });
    expect(await memberHasLiveSeat(storage, 'dana', 'claude')).toBe(false);

    await storage.addSeat({
      orgId, userId: 'dana', provider: 'claude', token: 't2', label: 'l2', status: 'cooldown',
    });
    expect(await memberHasLiveSeat(storage, 'dana', 'claude')).toBe(true);
    expect(await memberHasLiveSeat(storage, 'dana', 'codex')).toBe(false);
  });

  it('is false for a human in no org', async () => {
    const storage = new InMemoryOrgStorage();
    expect(await memberHasLiveSeat(storage, 'stranger', 'claude')).toBe(false);
  });
});

describe('signInSeatLabel', () => {
  it('names the subscription the way the user bought it, with the sign-in date', () => {
    const date = new Date('2026-08-22T12:00:00Z');
    expect(signInSeatLabel('claude', date)).toBe('Claude · 22 Aug 2026');
    expect(signInSeatLabel('codex', date)).toBe('ChatGPT · 22 Aug 2026');
  });
});
