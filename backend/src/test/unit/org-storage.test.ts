import { describe, expect, it, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { moveRecapChatsOutOfMemberships, SqliteOrgStorage } from '../../services/sqlite/sqlite-org-storage.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { InMemoryOrgStorage, mintInviteToken, type OrgStorage } from '../../services/org-storage.js';
import { WORKSPACE_AGENT_AVATAR_SLUGS } from '../../services/telegram-agent-avatars.js';

function seatDoc(orgId: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId, userId,
    provider: 'claude' as const,
    token: 'sk-ant-oat-test',
    label: 'my Max account',
    status: 'active' as const,
    ...overrides,
  };
}

const inFuture = new Date(Date.now() + 60_000).toISOString();

/** The storage contract, run against BOTH implementations (repo convention). */
function storageContract(name: string, make: () => OrgStorage, cleanup?: () => void) {
  describe(name, () => {
    afterEach(() => cleanup?.());

    it('keeps the Chief of Staff conversation apart from the membership (note #1098)', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'Acme', createdByUserId: 'u1' });
      await storage.addMember({ orgId: org.orgId, userId: 'u1', role: 'admin' });
      expect(await storage.getRecapChat(org.orgId, 'u1')).toBeNull();
      const chat = { messages: [{ id: 'm1', role: 'owner' as const, text: 'Hello', at: '2026-11-09T10:00:00.000Z' }], receipts: ['r1'], pending: [] };
      expect(await storage.saveRecapChat(org.orgId, 'u1', chat)).toBe(true);
      expect(await storage.getRecapChat(org.orgId, 'u1')).toEqual(chat);
      expect(await storage.getMembership(org.orgId, 'u1')).not.toHaveProperty('workspaceRecapChat');
      // One touch may still carry it beside the membership's own fields.
      const next = { ...chat, messages: [...chat.messages, { id: 'm2', role: 'assistant' as const, text: 'Hi', at: '2026-11-09T10:00:01.000Z' }] };
      expect(await storage.touchMember(org.orgId, 'u1', { workspaceRecapChat: next, lastSeenAt: '2026-11-09T10:00:02.000Z' })).toBe(true);
      expect(await storage.getRecapChat(org.orgId, 'u1')).toEqual(next);
      expect(await storage.getMembership(org.orgId, 'u1')).toMatchObject({ lastSeenAt: '2026-11-09T10:00:02.000Z' });
      expect(await storage.getMembership(org.orgId, 'u1')).not.toHaveProperty('workspaceRecapChat');
      // Not a member: nothing is written, and leaving takes the conversation with it.
      expect(await storage.saveRecapChat(org.orgId, 'stranger', chat)).toBe(false);
      expect(await storage.getRecapChat(org.orgId, 'stranger')).toBeNull();
      await storage.removeMember(org.orgId, 'u1');
      expect(await storage.getRecapChat(org.orgId, 'u1')).toBeNull();
    });

    it('creates an org and finds a member back through their membership', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'Acme Trading', createdByUserId: 'founder' });
      await storage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });

      const membership = await storage.getMembershipByUser('founder');
      expect(membership).toMatchObject({ orgId: org.orgId, role: 'admin' });
      expect(await storage.getOrg(org.orgId)).toMatchObject({ name: 'Acme Trading' });
      expect(WORKSPACE_AGENT_AVATAR_SLUGS).toContain(org.workspaceAgentAvatarSlug);
      expect((await storage.getOrg(org.orgId))?.workspaceAgentAvatarSlug)
        .toBe(org.workspaceAgentAvatarSlug);
      expect(await storage.getMembershipByUser('stranger')).toBeNull();
    });

    it('lists every org, for the control-plane sweeps', async () => {
      const storage = make();
      const a = await storage.createOrg({ name: 'A', createdByUserId: 'u1' });
      const b = await storage.createOrg({ name: 'B', createdByUserId: 'u2' });
      const listed = await storage.listOrgs();
      expect(listed.map((org) => org.orgId).sort()).toEqual([a.orgId, b.orgId].sort());
    });

    it('initializes an independent Workspace Agent runtime once without replacing a concurrent pick', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      await storage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
      const inherited = { cli: 'codex' as const, model: 'gpt-5.6-terra', effort: 'high' };
      const picked = { cli: 'claude' as const, model: 'opus', effort: 'max' };

      expect(await storage.initializeWorkspaceAgentSettings(org.orgId, 'nobody', inherited)).toBeNull();
      expect((await storage.initializeWorkspaceAgentSettings(org.orgId, 'founder', inherited))?.workspaceAgentSettings).toEqual(inherited);
      await storage.touchMember(org.orgId, 'founder', {
        workspaceAgentSettings: picked,
        workspaceRecapReadAt: 'now',
        inheritedSeatsAt: '2026-09-21T08:00:00.000Z',
      });
      const kept = await storage.initializeWorkspaceAgentSettings(org.orgId, 'founder', inherited);
      expect(kept?.workspaceAgentSettings).toEqual(picked);
      expect(kept?.workspaceRecapReadAt).toBe('now');
      expect(kept?.inheritedSeatsAt).toBe('2026-09-21T08:00:00.000Z');
    });

    it('keeps the workplace\'s one briefing on the membership, and a write leaves the rest of the membership standing (note #688)', async () => {
      // Briefings were per room under note #688; with rooms gone (note #923)
      // there is one per workplace, written over the membership in one touch
      // with its history — and that touch must not wipe what else the member
      // carries, like when they last read the card.
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      await storage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
      await storage.touchMember(org.orgId, 'founder', { workspaceRecapReadAt: 'now' });
      const recap = { text: 'The week.', at: '2026-10-04T10:00:00.000Z', fingerprint: 'a' };
      const history = [{ text: 'The week.', at: '2026-10-04T10:00:00.000Z' }];
      expect(await storage.touchMember(org.orgId, 'nobody', { workspaceRecap: recap, workspaceRecapHistory: history })).toBe(false);
      expect(await storage.touchMember(org.orgId, 'founder', { workspaceRecap: recap, workspaceRecapHistory: history })).toBe(true);
      const member = await storage.getMembership(org.orgId, 'founder');
      expect(member?.workspaceRecap).toEqual(recap);
      expect(member?.workspaceRecapHistory).toEqual(history);
      expect(member?.workspaceRecapReadAt).toBe('now');
      const rewritten = { ...recap, text: 'The week, later.' };
      await storage.touchMember(org.orgId, 'founder', { workspaceRecap: rewritten });
      const after = await storage.getMembership(org.orgId, 'founder');
      expect(after?.workspaceRecap).toEqual(rewritten);
      expect(after?.workspaceRecapHistory).toEqual(history);
      expect(after?.workspaceRecapReadAt).toBe('now');
    });

    it('holds several memberships and switches one persistent active workplace', async () => {
      const storage = make();
      const a = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      const b = await storage.createOrg({ name: 'B', createdByUserId: 'founder' });
      await storage.addMember({ orgId: a.orgId, userId: 'dana', role: 'member' });

      await storage.addMember({ orgId: b.orgId, userId: 'dana', role: 'member' });
      expect((await storage.listMembershipsByUser('dana')).map((row) => row.orgId))
        .toEqual([a.orgId, b.orgId]);
      expect((await storage.getMembershipByUser('dana'))?.orgId).toBe(a.orgId);
      expect(await storage.setActiveOrg('dana', b.orgId)).toBe(true);
      expect((await storage.getMembershipByUser('dana'))?.orgId).toBe(b.orgId);
      expect((await storage.listMembershipsByUser('dana')).filter((row) => row.active)).toHaveLength(1);
      expect(await storage.setActiveOrg('dana', 'not-theirs')).toBe(false);
    });

    it('lists members oldest-first and moves a role without touching the rest', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      // Distinct join times on purpose: joinedAt is stamped inside storage,
      // and two same-millisecond joins would be exercising the tie-break
      // instead of the ordering. 'founder' > 'dana' alphabetically, so a sort
      // that ignored joinedAt would flip this list.
      await storage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
      await new Promise((r) => setTimeout(r, 5));
      await storage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });

      expect(await storage.setMemberRole(org.orgId, 'dana', 'admin')).toBe(true);
      expect(await storage.setMemberRole(org.orgId, 'nobody', 'admin')).toBe(false);
      const members = await storage.listMembers(org.orgId);
      expect(members.map((m) => [m.userId, m.role])).toEqual([['founder', 'admin'], ['dana', 'admin']]);
    });

    it('adding a seat selects it and deselects the member’s previous pick of that provider only', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      await storage.addMember({ orgId: org.orgId, userId: 'marat', role: 'member' });
      const first = await storage.addSeat(seatDoc(org.orgId, 'marat', { label: 'first claude' }));
      const codex = await storage.addSeat(seatDoc(org.orgId, 'marat', { provider: 'codex', label: 'chatgpt' }));
      const second = await storage.addSeat(seatDoc(org.orgId, 'marat', { label: 'second claude' }));

      const seats = await storage.listSeatsByMember(org.orgId, 'marat');
      const byId = new Map(seats.map((s) => [s.seatId, s]));
      // The newest claude seat holds the pick; the codex seat is untouched —
      // selection is per provider, because a turn needs one of EACH at most.
      expect(byId.get(first.seatId)?.selected).toBe(false);
      expect(byId.get(second.seatId)?.selected).toBe(true);
      expect(byId.get(codex.seatId)?.selected).toBe(true);
    });

    it('selectSeat moves the pick back within the same member and provider', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      await storage.addMember({ orgId: org.orgId, userId: 'marat', role: 'member' });
      const first = await storage.addSeat(seatDoc(org.orgId, 'marat', { label: 'first' }));
      await storage.addSeat(seatDoc(org.orgId, 'marat', { label: 'second' }));

      expect(await storage.selectSeat(first.seatId)).toBe(true);
      const seats = await storage.listSeatsByMember(org.orgId, 'marat');
      expect(seats.find((s) => s.seatId === first.seatId)?.selected).toBe(true);
      expect(seats.filter((s) => s.selected)).toHaveLength(1);
      expect(await storage.selectSeat('unknown-seat')).toBe(false);
    });

    it('reuses one private sign-in in several orgs at once, with independent primary and fallback order', async () => {
      const storage = make();
      const a = await storage.createOrg({ name: 'A', createdByUserId: 'dana' });
      const b = await storage.createOrg({ name: 'B', createdByUserId: 'dana' });
      await storage.addMember({ orgId: a.orgId, userId: 'dana', role: 'admin' });
      await storage.addMember({ orgId: b.orgId, userId: 'dana', role: 'admin' });
      const first = await storage.addSeat(seatDoc(a.orgId, 'dana', { label: 'first' }));
      const second = await storage.addSeat(seatDoc(a.orgId, 'dana', { label: 'second' }));

      expect(await storage.assignSeat(b.orgId, 'dana', first.seatId)).not.toBeNull();
      expect(await storage.assignSeat(b.orgId, 'dana', second.seatId)).not.toBeNull();
      await storage.selectSeat(first.seatId, a.orgId);
      await storage.orderSeats(a.orgId, 'dana', 'claude', [second.seatId, first.seatId]);
      await storage.orderSeats(b.orgId, 'dana', 'claude', [first.seatId, second.seatId]);

      const inA = await storage.listSeatsByMember(a.orgId, 'dana');
      const inB = await storage.listSeatsByMember(b.orgId, 'dana');
      expect(inA.map((seat) => [seat.seatId, seat.selected]))
        .toEqual([[second.seatId, false], [first.seatId, true]]);
      expect(inB.map((seat) => [seat.seatId, seat.selected]))
        .toEqual([[first.seatId, false], [second.seatId, true]]);

      // Removing A's primary promotes A's survivor only. B keeps both, its
      // own order and its own primary; the credential itself is still there.
      expect(await storage.unassignSeat(a.orgId, 'dana', first.seatId)).toBe(true);
      expect((await storage.listSeatsByMember(a.orgId, 'dana')).map((seat) => [seat.seatId, seat.selected]))
        .toEqual([[second.seatId, true]]);
      expect((await storage.listSeatsByMember(b.orgId, 'dana')).map((seat) => [seat.seatId, seat.selected]))
        .toEqual([[first.seatId, false], [second.seatId, true]]);
      expect(await storage.getSeat(first.seatId)).not.toBeNull();

      // Deleting the underlying private sign-in is the separate, global verb.
      expect(await storage.removeSeat(second.seatId)).toBe(true);
      expect(await storage.getSeat(second.seatId)).toBeNull();
      expect(await storage.listSeatsByMember(a.orgId, 'dana')).toEqual([]);
      expect((await storage.listSeatsByMember(b.orgId, 'dana')).map((seat) => [seat.seatId, seat.selected]))
        .toEqual([[first.seatId, true]]);
    });

    it('one member’s seats never shadow another’s — the invariant the whole model rides on', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      await storage.addMember({ orgId: org.orgId, userId: 'marat', role: 'member' });
      await storage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });
      const marats = await storage.addSeat(seatDoc(org.orgId, 'marat'));
      const danas = await storage.addSeat(seatDoc(org.orgId, 'dana'));

      // Both stay selected: Dana's arrival must not deselect Marat's pick,
      // and each list answers with its owner's seats alone.
      expect((await storage.listSeatsByMember(org.orgId, 'marat')).map((s) => s.seatId)).toEqual([marats.seatId]);
      expect((await storage.listSeatsByMember(org.orgId, 'dana')).map((s) => s.seatId)).toEqual([danas.seatId]);
      expect(marats.selected && danas.selected).toBe(true);
    });

    it('removing a member drops only that org’s assignments; private sign-ins survive', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      await storage.addMember({ orgId: org.orgId, userId: 'marat', role: 'member' });
      await storage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });
      const marats = await storage.addSeat(seatDoc(org.orgId, 'marat'));
      await storage.addSeat(seatDoc(org.orgId, 'dana'));

      expect(await storage.removeMember(org.orgId, 'marat')).toBe(true);
      expect(await storage.listSeatsByMember(org.orgId, 'marat')).toEqual([]);
      expect((await storage.listSeatsByUser('marat')).map((seat) => seat.seatId)).toEqual([marats.seatId]);
      expect(await storage.listSeatsByMember(org.orgId, 'dana')).toHaveLength(1);
      expect(await storage.removeMember(org.orgId, 'marat')).toBe(false);
    });

    it('does not create an orphan sign-in for a user outside the target org', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });

      await expect(storage.addSeat(seatDoc(org.orgId, 'stranger'))).rejects.toThrow(/not a member/);
      expect(await storage.listSeatsByUser('stranger')).toEqual([]);
      expect(await storage.listAllSeats()).toEqual([]);
    });

    it('updateSeat refreshes updatedAt and cannot move a seat to another owner', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      await storage.addMember({ orgId: org.orgId, userId: 'marat', role: 'member' });
      const seat = await storage.addSeat(seatDoc(org.orgId, 'marat'));

      expect(await storage.updateSeat(seat.seatId, {
        status: 'cooldown', cooldownUntil: inFuture,
        // Attempted owner change — the signature forbids it; a cast smuggles
        // it in the way a bug would, and storage must pin the original.
        ...({ userId: 'dana' } as Record<string, never>),
      })).toBe(true);
      const after = await storage.getSeat(seat.seatId);
      expect(after).toMatchObject({ userId: 'marat', status: 'cooldown' });
      expect(after!.updatedAt >= seat.updatedAt).toBe(true);
    });

    it('an invite is redeemed exactly once, and the second tap says why', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      const invite = await storage.createInvite({
        orgId: org.orgId, createdByUserId: 'founder',
      });

      const first = await storage.redeemInvite(invite.token, 'newbie');
      expect(first).toMatchObject({
        ok: true,
        membership: { orgId: org.orgId, userId: 'newbie', role: 'member', invitedByUserId: 'founder' },
        org: { name: 'A' },
      });
      expect(await storage.redeemInvite(invite.token, 'second-tapper')).toEqual({ ok: false, reason: 'used' });
      // The newbie's membership survives the refused second tap.
      expect((await storage.getMembershipByUser('newbie'))?.orgId).toBe(org.orgId);
    });

    it('joining another workplace through an invite keeps earlier memberships and activates the target', async () => {
      const storage = make();
      const first = await storage.createOrg({ name: 'First', createdByUserId: 'first-admin' });
      const target = await storage.createOrg({ name: 'Target', createdByUserId: 'target-admin' });
      await storage.addMember({ orgId: first.orgId, userId: 'dana', role: 'member' });
      const invite = await storage.createInvite({
        orgId: target.orgId, createdByUserId: 'target-admin',
      });

      expect((await storage.redeemInvite(invite.token, 'dana')).ok).toBe(true);
      const memberships = await storage.listMembershipsByUser('dana');
      expect(memberships.map((membership) => membership.orgId)).toEqual([target.orgId, first.orgId]);
      expect(memberships.filter((membership) => membership.active)).toHaveLength(1);
      expect(memberships[0]?.active).toBe(true);
    });

    it('refuses unknown and already-member redemptions without side effects', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      await storage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });
      const live = await storage.createInvite({
        orgId: org.orgId, createdByUserId: 'founder',
      });

      expect(await storage.redeemInvite('no-such-token', 'newbie')).toEqual({ ok: false, reason: 'unknown' });
      expect(await storage.redeemInvite(live.token, 'dana')).toEqual({ ok: false, reason: 'already-member' });
      // The refused redemptions burned nothing: the live invite still works.
      expect((await storage.redeemInvite(live.token, 'newbie')).ok).toBe(true);
      expect(await storage.getMembershipByUser('newbie')).not.toBeNull();
    });

    it('lists an org’s invites newest-first and only its own', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      const other = await storage.createOrg({ name: 'B', createdByUserId: 'other' });
      const first = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      await new Promise((r) => setTimeout(r, 5));
      const second = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      await storage.createInvite({ orgId: other.orgId, createdByUserId: 'other' });

      expect((await storage.listInvites(org.orgId)).map((i) => i.token))
        .toEqual([second.token, first.token]);
    });

    it('mints a link with no expiry — revoking is the only thing that ends one', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      const invite = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      // Not merely far in the future: no expiry field at all, so nothing can
      // read a gate back into a link an admin has not revoked.
      expect(Object.keys(invite)).not.toContain('expiresAt');
      expect(Object.keys((await storage.getInvite(invite.token))!)).not.toContain('expiresAt');
      // A year of clock does not touch it; the same link still files a request.
      const later = new Date(Date.now() + 365 * 86400_000);
      expect((await storage.requestToJoin(invite.token, 'alice', later)).ok).toBe(true);
    });

    it('revokes an unused invite, refuses a used one, and says so honestly', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'founder' });
      const unused = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      const used = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      await storage.redeemInvite(used.token, 'newbie');

      expect(await storage.revokeInvite(unused.token)).toBe('revoked');
      expect(await storage.getInvite(unused.token)).toBeNull();
      // A revoked link redeems as unknown — dead, with no trace to resurrect.
      expect(await storage.redeemInvite(unused.token, 'late-tapper')).toEqual({ ok: false, reason: 'unknown' });
      // The used invite is history (it names who joined) and must survive.
      expect(await storage.revokeInvite(used.token)).toBe('used');
      expect(await storage.getInvite(used.token)).not.toBeNull();
      expect(await storage.revokeInvite('no-such-token')).toBe('unknown');
    });

    // ── Join requests (note #1): a reusable link files a request; an admin
    // decides it. ─────────────────────────────────────────────────────────
    const orgWithLink = async (storage: OrgStorage) => {
      const org = await storage.createOrg({ name: 'Nomad', createdByUserId: 'founder' });
      await storage.addMember({ orgId: org.orgId, userId: 'founder', role: 'admin' });
      const invite = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      return { org, invite };
    };

    it('one link serves many people: each files a pending request, nobody is a member yet, the link stays live', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);

      const alice = await storage.requestToJoin(invite.token, 'alice');
      const bob = await storage.requestToJoin(invite.token, 'bob');
      expect(alice).toMatchObject({ ok: true, org: { name: 'Nomad' }, request: { orgId: org.orgId, userId: 'alice', inviteToken: invite.token, status: 'pending' } });
      expect(bob).toMatchObject({ ok: true, request: { userId: 'bob', status: 'pending' } });
      expect(await storage.getMembership(org.orgId, 'alice')).toBeNull();
      expect(await storage.getMembership(org.orgId, 'bob')).toBeNull();
      expect((await storage.getInvite(invite.token))?.usedAt).toBeUndefined();
      expect((await storage.listJoinRequests(org.orgId)).map((r) => r.userId).sort()).toEqual(['alice', 'bob']);
      expect((await storage.listJoinRequestsByUser('alice')).map((r) => [r.orgId, r.status])).toEqual([[org.orgId, 'pending']]);
      expect(await storage.listJoinRequestsByUser('nobody')).toEqual([]);
      expect(await storage.getJoinRequest((alice as { request: { requestId: string } }).request.requestId))
        .toMatchObject({ userId: 'alice' });
      expect(await storage.getJoinRequest('nope')).toBeNull();
    });

    it('finds the latest decided request even when requests share a timestamp', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const now = new Date();
      for (let i = 0; i < 6; i += 1) {
        const filed = await storage.requestToJoin(invite.token, 'alice', now);
        if (!filed.ok) throw new Error('fixture did not file');
        await storage.decideJoinRequest(filed.request.requestId, 'founder', 'reject', now);
        expect((await storage.getJoinRequestByUser(org.orgId, 'alice'))?.requestId).toBe(filed.request.requestId);
      }
    });

    it('a second link, a reload and two concurrent taps all land on the same pending request', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const other = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });

      const [first, second, third] = await Promise.all([
        storage.requestToJoin(invite.token, 'alice'),
        storage.requestToJoin(other.token, 'alice'),
        storage.requestToJoin(invite.token, 'alice'),
      ]);
      const ids = [first, second, third].map((r) => (r.ok ? r.request.requestId : r.reason));
      expect(new Set(ids).size).toBe(1);
      expect(await storage.listJoinRequests(org.orgId)).toHaveLength(1);
      expect(await storage.getJoinRequestByUser(org.orgId, 'alice')).toMatchObject({ requestId: ids[0], status: 'pending' });
    });

    it('a request is refused exactly where a redeem would be: revoked, used, already a member', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const revoked = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      await storage.revokeInvite(revoked.token);
      const consumed = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      await storage.redeemInvite(consumed.token, 'legacy-joiner');

      expect(await storage.requestToJoin(revoked.token, 'alice')).toEqual({ ok: false, reason: 'unknown' });
      expect(await storage.requestToJoin('no-such-token', 'alice')).toEqual({ ok: false, reason: 'unknown' });
      expect(await storage.requestToJoin(consumed.token, 'alice')).toEqual({ ok: false, reason: 'used' });
      expect(await storage.requestToJoin(invite.token, 'founder')).toEqual({ ok: false, reason: 'already-member' });
      expect(await storage.listJoinRequests(org.orgId)).toEqual([]);
    });

    it('a pending request outlives its link: revoked afterwards, an admin can still decide it', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const filed = await storage.requestToJoin(invite.token, 'alice');
      expect(filed.ok).toBe(true);
      const requestId = (filed as { request: { requestId: string } }).request.requestId;
      expect(await storage.revokeInvite(invite.token)).toBe('revoked');
      // New requests through the dead link are refused, the filed one stands.
      expect(await storage.requestToJoin(invite.token, 'bob')).toEqual({ ok: false, reason: 'unknown' });
      expect(await storage.getJoinRequest(requestId)).toMatchObject({ status: 'pending' });
      expect(await storage.decideJoinRequest(requestId, 'founder', 'approve')).toMatchObject({ ok: true, request: { status: 'approved' } });
      expect(await storage.getMembership(org.orgId, 'alice')).toMatchObject({ role: 'member', invitedByUserId: 'founder' });
    });

    it('only a CURRENT admin of that org decides; approval makes a member, rejection makes nothing', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const other = await storage.createOrg({ name: 'Other', createdByUserId: 'x' });
      await storage.addMember({ orgId: other.orgId, userId: 'other-admin', role: 'admin' });
      await storage.addMember({ orgId: org.orgId, userId: 'plain', role: 'member' });
      await storage.addMember({ orgId: org.orgId, userId: 'ex-admin', role: 'admin' });
      await storage.removeMember(org.orgId, 'ex-admin');

      const alice = (await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } }).request.requestId;
      const bob = (await storage.requestToJoin(invite.token, 'bob') as { request: { requestId: string } }).request.requestId;
      for (const who of ['plain', 'ex-admin', 'other-admin', 'stranger']) {
        expect(await storage.decideJoinRequest(alice, who, 'approve')).toEqual({ ok: false, reason: 'forbidden' });
      }
      expect(await storage.getMembership(org.orgId, 'alice')).toBeNull();
      expect(await storage.decideJoinRequest('nope', 'founder', 'approve')).toEqual({ ok: false, reason: 'unknown' });

      const approved = await storage.decideJoinRequest(alice, 'founder', 'approve');
      expect(approved).toMatchObject({ ok: true, request: { status: 'approved', decidedByUserId: 'founder' } });
      expect((approved as { request: { decidedAt?: string } }).request.decidedAt).toBeTruthy();
      expect(await storage.getMembership(org.orgId, 'alice')).toMatchObject({ role: 'member', invitedByUserId: 'founder', active: true });

      expect(await storage.decideJoinRequest(bob, 'founder', 'reject')).toMatchObject({ ok: true, request: { status: 'rejected' } });
      expect(await storage.getMembership(org.orgId, 'bob')).toBeNull();
      // The link itself was never spent.
      expect((await storage.getInvite(invite.token))?.usedAt).toBeUndefined();
    });

    it('one request takes exactly one decision: racing approve/reject cannot both land, and a repeat says resolved', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      await storage.addMember({ orgId: org.orgId, userId: 'second-admin', role: 'admin' });
      const requestId = (await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } }).request.requestId;

      const results = await Promise.all([
        storage.decideJoinRequest(requestId, 'founder', 'approve'),
        storage.decideJoinRequest(requestId, 'second-admin', 'reject'),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason)).toEqual(['resolved']);
      const stored = await storage.getJoinRequest(requestId);
      const winner = results.find((r) => r.ok) as { request: { status: string } };
      expect(stored?.status).toBe(winner.request.status);
      expect(Boolean(await storage.getMembership(org.orgId, 'alice'))).toBe(winner.request.status === 'approved');
      expect(await storage.decideJoinRequest(requestId, 'founder', 'reject')).toEqual({ ok: false, reason: 'resolved' });
      expect(await storage.decideJoinRequest(requestId, 'founder', 'approve')).toEqual({ ok: false, reason: 'resolved' });
    });

    it('approval never rewrites a role or moves an active Workspace', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      // Dana already lives in another org: joining Nomad must not move her.
      const home = await storage.createOrg({ name: 'Home', createdByUserId: 'dana' });
      await storage.addMember({ orgId: home.orgId, userId: 'dana', role: 'admin' });
      const dana = (await storage.requestToJoin(invite.token, 'dana') as { request: { requestId: string } }).request.requestId;
      expect(await storage.decideJoinRequest(dana, 'founder', 'approve')).toMatchObject({ ok: true });
      expect(await storage.getMembership(org.orgId, 'dana')).toMatchObject({ role: 'member' });
      expect((await storage.getMembershipByUser('dana'))?.orgId).toBe(home.orgId);
      expect((await storage.getMembership(org.orgId, 'dana'))?.active).toBeFalsy();

      // Eve filed a request, then was added by hand as an admin before anyone
      // decided it: approving the stale request keeps her admin.
      const eve = (await storage.requestToJoin(invite.token, 'eve') as { request: { requestId: string } }).request.requestId;
      await storage.addMember({ orgId: org.orgId, userId: 'eve', role: 'admin' });
      expect(await storage.decideJoinRequest(eve, 'founder', 'approve')).toMatchObject({ ok: true, request: { status: 'approved' } });
      expect(await storage.getMembership(org.orgId, 'eve')).toMatchObject({ role: 'admin' });
    });

    it('after a rejection, or after an approved member is removed, a fresh request gets a new id and history stays', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const first = (await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } }).request.requestId;
      await storage.decideJoinRequest(first, 'founder', 'reject');

      const second = (await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } }).request.requestId;
      expect(second).not.toBe(first);
      expect(await storage.getJoinRequestByUser(org.orgId, 'alice')).toMatchObject({ requestId: second, status: 'pending' });
      expect((await storage.listJoinRequests(org.orgId)).map((r) => r.status).sort()).toEqual(['pending', 'rejected']);

      await storage.decideJoinRequest(second, 'founder', 'approve');
      expect(await storage.requestToJoin(invite.token, 'alice')).toEqual({ ok: false, reason: 'already-member' });
      await storage.removeMember(org.orgId, 'alice');
      const third = (await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } }).request.requestId;
      expect(new Set([first, second, third]).size).toBe(3);
      expect(await storage.listJoinRequests(org.orgId)).toHaveLength(3);
      expect((await storage.listJoinRequests(org.orgId))[0]?.requestId).toBe(third);
    });

    it('deleting an org takes its join requests with it', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'Empty', createdByUserId: 'founder' });
      const invite = await storage.createInvite({ orgId: org.orgId, createdByUserId: 'founder' });
      const filed = await storage.requestToJoin(invite.token, 'alice') as { request: { requestId: string } };
      expect(await storage.deleteOrg(org.orgId)).toBe(true);
      expect(await storage.getJoinRequest(filed.request.requestId)).toBeNull();
      expect(await storage.listJoinRequests(org.orgId)).toEqual([]);
    });

    it('legacy redeem: three concurrent taps on one single-use link admit exactly one', async () => {
      const storage = make();
      const { org, invite } = await orgWithLink(storage);
      const results = await Promise.all(['a', 'b', 'c'].map((u) => storage.redeemInvite(invite.token, u)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await storage.listMembers(org.orgId)).map((m) => m.userId)).toHaveLength(2);
    });

    it('updateOrg writes the Fly pointer without touching identity fields', async () => {
      const storage = make();
      const org = await storage.createOrg({ name: 'A', createdByUserId: 'f' });
      expect(await storage.updateOrg(org.orgId, {
        fly: { orgSlug: 'acme-agents', tokenSecretName: 'ACME_FLY_TOKEN' },
      })).toBe(true);
      expect(await storage.getOrg(org.orgId)).toMatchObject({
        orgId: org.orgId, createdAt: org.createdAt,
        fly: { orgSlug: 'acme-agents' },
      });
      expect(await storage.updateOrg('nope', { name: 'x' })).toBe(false);
    });
  });
}

describe('org storage', () => {
  it('mints invite tokens that fit a Telegram start payload beside their prefix', () => {
    const token = mintInviteToken();
    // start payloads cap at 64 chars of [A-Za-z0-9_-]; `join-` + token must fit.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(`join-${token}`.length).toBeLessThanOrEqual(64);
    expect(token).not.toBe(mintInviteToken());
  });

  storageContract('in-memory', () => new InMemoryOrgStorage());

  let db: SqliteDb | undefined;
  let dir: string | undefined;
  storageContract('sqlite', () => {
    dir = mkdtempSync(join(tmpdir(), 'org-storage-'));
    db = openSqliteDb(join(dir, 'test.db'));
    return new SqliteOrgStorage(db);
  }, () => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined; dir = undefined;
  });
  // Production runs with SECRETS_MASTER_KEY: seat secrets are sealed in the
  // row (seat-credential-cipher.ts) and every rule above must hold unchanged.
  storageContract('sqlite, seat secrets encrypted', () => {
    dir = mkdtempSync(join(tmpdir(), 'org-storage-'));
    db = openSqliteDb(join(dir, 'test.db'));
    return new SqliteOrgStorage(db, new SecretCipher(randomBytes(32).toString('base64')));
  }, () => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined; dir = undefined;
  });

  it('backfills pre-multi-org SQLite seats into idempotent per-org assignments', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'org-storage-migration-'));
    const legacyDb = openSqliteDb(join(legacyDir, 'test.db'));
    try {
      const older = {
        seatId: 'seat-older', orgId: 'org-legacy', userId: 'dana', provider: 'claude' as const,
        token: 'older-token', label: 'Older', status: 'active' as const, selected: true,
        createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      };
      const newer = {
        ...older, seatId: 'seat-newer', token: 'newer-token', label: 'Newer', selected: false,
        createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
      };
      const insert = legacyDb.prepare(
        'INSERT INTO org_seats (seat_id, org_id, user_id, doc) VALUES (?, ?, ?, ?)',
      );
      insert.run(older.seatId, older.orgId, older.userId, JSON.stringify(older));
      insert.run(newer.seatId, newer.orgId, newer.userId, JSON.stringify(newer));

      const storage = new SqliteOrgStorage(legacyDb);
      expect((await storage.listSeatsByMember('org-legacy', 'dana')).map((seat) => ({
        seatId: seat.seatId, selected: seat.selected, priority: seat.assignmentPriority,
      }))).toEqual([
        { seatId: 'seat-newer', selected: false, priority: 0 },
        { seatId: 'seat-older', selected: true, priority: 1 },
      ]);

      // Startup runs this constructor on every deploy. Existing assignment
      // choices must win over the legacy document forever after the cutover.
      await storage.selectSeat('seat-newer', 'org-legacy');
      new SqliteOrgStorage(legacyDb);
      expect((await storage.listSeatsByMember('org-legacy', 'dana')).map((seat) => [seat.seatId, seat.selected]))
        .toEqual([['seat-newer', true], ['seat-older', false]]);
      expect((legacyDb.prepare('SELECT COUNT(*) AS count FROM org_seat_assignments').get() as { count: number }).count)
        .toBe(2);
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('moving the Chief of Staff conversation out of the membership (note #1098)', () => {
  const legacy = () => {
    const db = openSqliteDb(':memory:');
    new SqliteOrgStorage(db);
    const chat = {
      messages: [
        { id: 'g', role: 'assistant', kind: 'greeting', text: 'Hi, I\u2019m your Chief of Staff.', at: '2026-09-13T12:01:10.000Z' },
        { id: 'o1', role: 'owner', text: 'A waitlist page \ud83d\ude80', at: '2026-09-13T12:03:00.000Z' },
        { id: 'd', role: 'action', text: '---', kind: 'new-chat-divider', at: '2026-09-14T08:00:00.000Z' },
        { id: 'h', role: 'action', text: 'Handed to Theo', at: '2026-09-14T08:01:00.000Z', proposals: [{ kind: 'pr', id: 'p1' }] },
      ],
      receipts: ['r1'], pending: [{ agentId: 'a1', name: 'Theo', sentAt: '2026-09-14T08:01:00.000Z', status: 'waiting' }], running: 'r1',
    };
    const insert = db.prepare('INSERT INTO org_members (org_id, user_id, doc) VALUES (?, ?, ?)');
    insert.run('o1', 'u1', JSON.stringify({ orgId: 'o1', userId: 'u1', role: 'admin', joinedAt: '2026-09-13T12:00:00.000Z', lastSeenAt: { __ts: '2026-11-01T00:00:00.000Z' }, workspaceRecapChat: chat }));
    insert.run('o1', 'u2', JSON.stringify({ orgId: 'o1', userId: 'u2', role: 'member', joinedAt: '2026-09-13T12:00:00.000Z' }));
    insert.run('o2', 'u1', JSON.stringify({ orgId: 'o2', userId: 'u1', role: 'admin', joinedAt: '2026-09-15T12:00:00.000Z', workspaceRecapChat: { messages: [], receipts: [], pending: [] } }));
    return { db, chat };
  };
  const raw = (db: SqliteDb, table: string, org: string, user: string) =>
    (db.prepare(`SELECT doc FROM ${table} WHERE org_id = ? AND user_id = ?`).get(org, user) as { doc: string } | undefined)?.doc;

  it('moves every conversation byte for byte, leaves the rest of each membership as it was, and a second start finds nothing', async () => {
    const { db, chat } = legacy();
    const before = JSON.parse(raw(db, 'org_members', 'o1', 'u1')!) as Record<string, unknown>;
    const first = moveRecapChatsOutOfMemberships(db);
    expect(first).toMatchObject({ moved: 2, merged: 0 });
    expect(raw(db, 'org_member_recap_chats', 'o1', 'u1')).toBe(JSON.stringify(chat));
    const { workspaceRecapChat: _moved, ...rest } = before;
    expect(raw(db, 'org_members', 'o1', 'u1')).toBe(JSON.stringify(rest));
    expect(raw(db, 'org_member_recap_chats', 'o1', 'u2')).toBeUndefined();
    const storage = new SqliteOrgStorage(db);
    expect(await storage.getRecapChat('o1', 'u1')).toEqual(chat);
    expect(await storage.getRecapChat('o2', 'u1')).toEqual({ messages: [], receipts: [], pending: [] });
    expect((await storage.getMembership('o1', 'u1'))?.lastSeenAt).toBeTruthy();
    expect(moveRecapChatsOutOfMemberships(db)).toEqual({ moved: 0, merged: 0, bytes: 0 });
  });

  it('after a rollback wrote a newer copy into the membership, keeps both copies\u2019 rows and the newer state', async () => {
    const { db, chat } = legacy();
    moveRecapChatsOutOfMemberships(db);
    // An older release, rolled back to, starts a blank conversation in the membership.
    const member = JSON.parse(raw(db, 'org_members', 'o1', 'u1')!) as Record<string, unknown>;
    const newer = { messages: [{ id: 'o9', role: 'owner', text: 'Still there?', at: '2026-11-09T10:00:00.000Z' }], receipts: ['r9'], pending: [] };
    db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?').run(JSON.stringify({ ...member, workspaceRecapChat: newer }), 'o1', 'u1');
    expect(moveRecapChatsOutOfMemberships(db)).toMatchObject({ moved: 1, merged: 1 });
    const merged = await new SqliteOrgStorage(db).getRecapChat('o1', 'u1');
    expect(merged?.messages.map((m) => m.id)).toEqual(['g', 'o1', 'd', 'h', 'o9']);
    expect(merged?.receipts).toEqual(['r1', 'r9']);
    expect(merged?.pending).toEqual([]);
    // The state is the newer copy's: no request of the older one still counts as running.
    expect(merged?.running).toBeUndefined();
    expect(chat.running).toBe('r1');
  });
});
