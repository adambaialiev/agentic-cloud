import { describe, expect, it, vi } from 'vitest';
import { InMemoryPlatformCredentialPool, resolveSeatLease } from '../../services/platform-credential-pool.js';
import { CLAUDE_PROFILE_ENDPOINT, CLAUDE_USAGE_ENDPOINT } from '../../agent/claude/claude-usage.js';
import { OrgSeatCredentialSource, SEAT_LEASE_PREFIX } from '../../services/org-seat-credentials.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import type { OrgSeatDocument } from '../../types/org.js';

/**
 * The cutover's contract (org-layer-design): an org member's turns run on
 * their OWN seats — selected first, falling back only among their own —
 * and never on shared pool capacity, whatever state their seats are in.
 */

async function memberWithSeats(seats: Array<Partial<OrgSeatDocument> & { label: string }>) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'A', createdByUserId: 'marat' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'marat', role: 'admin' });
  const created: OrgSeatDocument[] = [];
  for (const seat of seats) {
    created.push(await orgStorage.addSeat({
      orgId: org.orgId, userId: 'marat',
      provider: 'claude', token: `tok-${seat.label}`, status: 'active',
      ...seat,
    } as never));
  }
  const source = new OrgSeatCredentialSource(orgStorage);
  const pool = new InMemoryPlatformCredentialPool(source);
  return { orgStorage, source, pool, org, created };
}

describe('seat-backed leaseForUser', () => {
  it('leases one explicitly assigned sign-in in two workplaces at the same time', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const first = await orgStorage.createOrg({ name: 'First', createdByUserId: 'marat' });
    const second = await orgStorage.createOrg({ name: 'Second', createdByUserId: 'marat' });
    await orgStorage.addMember({ orgId: first.orgId, userId: 'marat', role: 'admin' });
    await orgStorage.addMember({ orgId: second.orgId, userId: 'marat', role: 'admin' });
    const seat = await orgStorage.addSeat({
      orgId: first.orgId, userId: 'marat', provider: 'claude', token: 'same-private-token',
      label: 'Reusable', status: 'active',
    });
    await orgStorage.assignSeat(second.orgId, 'marat', seat.seatId);
    const pool = new InMemoryPlatformCredentialPool(new OrgSeatCredentialSource(orgStorage));

    // No release between the calls: simultaneous reuse is deliberate. The
    // credential is private to Marat, not locked to either workplace.
    const inFirst = await pool.leaseForUser('claude', 'marat', { orgId: first.orgId });
    const inSecond = await pool.leaseForUser('claude', 'marat', { orgId: second.orgId });

    expect(inFirst).toEqual({
      kind: 'dedicated', lease: { credentialId: `${SEAT_LEASE_PREFIX}${seat.seatId}`, token: 'same-private-token' },
    });
    expect(inSecond).toEqual(inFirst);
  });

  it('a member leases their selected seat, and release routes back onto it', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([
      { label: 'first' }, { label: 'second' },  // second ends selected
    ]);
    const lease = await pool.leaseForUser('claude', 'marat');
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    expect(lease.lease.token).toBe('tok-second');
    expect(lease.lease.credentialId).toBe(`${SEAT_LEASE_PREFIX}${created[1]!.seatId}`);

    // A rate limit cools the seat itself down, through the pool's own brain.
    await pool.releaseCredential(lease.lease.credentialId, { kind: 'rate_limited', retryAfterSeconds: 60 });
    const seat = await orgStorage.getSeat(created[1]!.seatId);
    expect(seat?.status).toBe('cooldown');
    expect(seat?.cooldownUntil).toBeTruthy();
  });

  it('falls back to the member’s OTHER seat when the selected one cools down — never to the pool', async () => {
    const { pool } = await memberWithSeats([
      { label: 'spare' },
      { label: 'main', status: 'cooldown', cooldownUntil: '2099-01-01T00:00:00.000Z' },
    ]);
    // A juicy unowned pool credential exists; a member must never see it.
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-pool', label: 'pool-1' });

    const lease = await pool.leaseForUser('claude', 'marat');
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    expect(lease.lease.token).toBe('tok-spare');
  });

  it('falls back around a payment-blocked primary and names billing when none is ready', async () => {
    const withFallback = await memberWithSeats([
      { label: 'spare' },
      { label: 'main', status: 'payment_required', subscriptionStatus: 'past_due' },
    ]);
    const lease = await withFallback.pool.leaseForUser('claude', 'marat');
    expect(lease).toMatchObject({ kind: 'dedicated', lease: { token: 'tok-spare' } });

    const blocked = await memberWithSeats([
      { label: 'only', status: 'payment_required', subscriptionStatus: 'past_due' },
    ]);
    expect(await blocked.pool.leaseForUser('claude', 'marat')).toEqual({ kind: 'payment_required' });
  });

  it('every seat cooling down answers exhausted with the earliest reset — not a pool hop', async () => {
    const { pool } = await memberWithSeats([
      { label: 'a', status: 'cooldown', cooldownUntil: '2099-01-01T00:00:00.000Z' },
      { label: 'b', status: 'cooldown', cooldownUntil: '2098-01-01T00:00:00.000Z' },
    ]);
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-pool', label: 'pool-1' });

    const lease = await pool.leaseForUser('claude', 'marat');
    expect(lease).toEqual({ kind: 'dedicated_exhausted', resetAt: '2098-01-01T00:00:00.000Z' });
  });

  it('all seats dead is still never limbo — the member needs re-auth, not someone else’s account', async () => {
    const { pool } = await memberWithSeats([{ label: 'dead-one', status: 'dead' }]);
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-pool', label: 'pool-1' });

    const lease = await pool.leaseForUser('claude', 'marat');
    expect(lease.kind).toBe('dedicated_exhausted');
  });

  it('a member with no assigned seat never borrows the pool; an org-less human still can', async () => {
    const { pool } = await memberWithSeats([{ label: 'claude-only' }]);
    const added = await pool.addCredential({ provider: 'codex', token: '{"auth":1}', label: 'pool-codex' });

    // Marat is a member but has no CODEX sign-in assigned here: fail closed,
    // even though a tempting platform credential exists.
    const codexLease = await pool.leaseForUser('codex', 'marat');
    expect(codexLease.kind).toBe('dedicated_exhausted');

    // A stranger with no membership at all: unchanged path too.
    const strangerLease = await pool.leaseForUser('claude', 'stranger');
    expect(strangerLease.kind).toBe('limbo');
    expect(added.credentialId).toBeTruthy();
  });

  it('repeated auth failures kill the seat through the shared death threshold', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([{ label: 'flaky' }]);
    const id = `${SEAT_LEASE_PREFIX}${created[0]!.seatId}`;
    await pool.releaseCredential(id, { kind: 'auth_failed', detail: 'HTTP 401' });
    expect((await orgStorage.getSeat(created[0]!.seatId))?.status).toBe('active');
    await pool.releaseCredential(id, { kind: 'auth_failed', detail: 'HTTP 401' });
    const seat = await orgStorage.getSeat(created[0]!.seatId);
    expect(seat?.status).toBe('dead');
    expect(seat?.deadReason).toBe('HTTP 401');
  });

  it('a refreshed Codex auth.json lands on the seat at release — the sync-back follows the seat', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([
      { label: 'gpt', provider: 'codex', token: '{"v":1}' },
    ]);
    const lease = await pool.leaseForUser('codex', 'marat');
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    await pool.releaseCredential(lease.lease.credentialId, { kind: 'ok' }, { refreshedToken: '{"v":2}' });
    expect((await orgStorage.getSeat(created[0]!.seatId))?.token).toBe('{"v":2}');
  });

  it('the refresher updates an idle Codex seat without requiring another turn', async () => {
    const token = JSON.stringify({ tokens: { access_token: 'at-codex', account_id: 'acct-codex' } });
    const { pool, orgStorage, created } = await memberWithSeats([
      { label: 'gpt', provider: 'codex', token },
    ]);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 604_800,
            reset_at: 1_788_464_760,
          },
          secondary_window: null,
        },
        plan_type: 'prolite',
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }),
    });
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

    const seat = await orgStorage.getSeat(created[0]!.seatId);
    expect(seat?.usage?.windows.primary).toMatchObject({ usedPercent: 42, windowDurationMins: 10_080 });
    expect(seat?.usageRefreshedAt).toBeTruthy();
  });

  it('a model-scoped trip benches that model on the seat and keeps the rest serving', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([{ label: 'only' }]);
    // As the periodic probe would leave it: unified windows show headroom,
    // which is what lets the outcome brain bench one model instead of the
    // whole seat. Without a snapshot it deliberately cools everything down.
    await orgStorage.updateSeat(created[0]!.seatId, {
      usage: {
        windows: { five_hour: { id: 'five_hour', usedPercent: 20 } },
        capturedAt: new Date().toISOString(),
      } as never,
      usageRefreshedAt: new Date().toISOString(),
    });
    const id = `${SEAT_LEASE_PREFIX}${created[0]!.seatId}`;
    await pool.releaseCredential(id, { kind: 'rate_limited', model: 'fable', retryAfterSeconds: 3600 });

    // Fable is benched on the member's only seat…
    const fableLease = await pool.leaseForUser('claude', 'marat', { model: 'fable' });
    expect(fableLease.kind).toBe('dedicated_exhausted');
    // …while other models keep working on the same seat.
    const otherLease = await pool.leaseForUser('claude', 'marat', { model: 'opus' });
    expect(otherLease.kind).toBe('dedicated');
  });

  it('an agent’s seat pin outranks the org’s selected seat (note #129)', async () => {
    const { pool, created } = await memberWithSeats([
      { label: 'pinned' }, { label: 'org-primary' },  // org-primary ends selected
    ]);
    const lease = await pool.leaseForUser('claude', 'marat', { seatId: created[0]!.seatId });
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    expect(lease.lease.token).toBe('tok-pinned');
    expect(lease.lease.credentialId).toBe(`${SEAT_LEASE_PREFIX}${created[0]!.seatId}`);
  });

  it('a pinned seat in cooldown falls back like a selected one — the pin never strands a turn', async () => {
    const { pool, created } = await memberWithSeats([
      { label: 'pinned', status: 'cooldown', cooldownUntil: '2099-01-01T00:00:00.000Z' },
      { label: 'org-primary' },
    ]);
    const lease = await pool.leaseForUser('claude', 'marat', { seatId: created[0]!.seatId });
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    expect(lease.lease.token).toBe('tok-org-primary');
  });

  it('a chosen seat that runs out hands the turn to the primary, then takes it back once it has room (note #773)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-18T09:00:00.000Z') });
    try {
      const { pool, created } = await memberWithSeats([
        { label: 'chosen' }, { label: 'org-primary' },  // org-primary ends selected
      ]);
      const chosen = created[0]!.seatId;
      const lease = async (model: string) => {
        const answer = await pool.leaseForUser('claude', 'marat', { seatId: chosen, model });
        return answer.kind === 'dedicated' ? answer.lease.token : answer.kind;
      };
      expect(await lease('fable')).toBe('tok-chosen');
      // The chosen seat's turn dies on "Switch to another model" (note #772).
      await pool.releaseCredential(`${SEAT_LEASE_PREFIX}${chosen}`, {
        kind: 'rate_limited', model: 'fable', modelOnly: true, retryAfterSeconds: 3600,
      });
      expect(await lease('fable')).toBe('tok-org-primary');
      // Only Fable moved: every other model still runs on the chosen seat.
      expect(await lease('opus')).toBe('tok-chosen');
      // An hour on, the chosen seat has room again and is first once more.
      vi.setSystemTime(new Date('2026-10-18T10:00:01.000Z'));
      expect(await lease('fable')).toBe('tok-chosen');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pin naming a seat the member no longer holds here is ignored — the stale record degrades to the default', async () => {
    const { pool, orgStorage, org, created } = await memberWithSeats([
      { label: 'kept' }, { label: 'let-go' },  // let-go ends selected…
    ]);
    await orgStorage.unassignSeat(org.orgId, 'marat', created[1]!.seatId);
    const lease = await pool.leaseForUser('claude', 'marat', { seatId: created[1]!.seatId });
    expect(lease.kind).toBe('dedicated');
    if (lease.kind !== 'dedicated') return;
    expect(lease.lease.token).toBe('tok-kept');
  });

  it('limbo honours the machine pin through leaseForUser (the Codex stickiness the pool had)', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const pool = new InMemoryPlatformCredentialPool(new OrgSeatCredentialSource(orgStorage));
    await pool.addCredential({ provider: 'codex', token: '{"a":1}', label: 'codex-a' });
    const b = await pool.addCredential({ provider: 'codex', token: '{"b":1}', label: 'codex-b' });

    const lease = await pool.leaseForUser('codex', 'limbo-user', { preferredCredentialId: b.credentialId });
    expect(lease.kind).toBe('limbo');
    if (lease.kind !== 'limbo') return;
    expect(lease.lease?.credentialId).toBe(b.credentialId);
  });
});

describe('grant seats (the Workspace OAuth mint)', () => {
  const LIMITS_RESPONSE = {
    limits: [
      { kind: 'session', percent: 6, resets_at: '2026-08-23T09:20:00.000+00:00' },
      { kind: 'weekly_all', percent: 7, resets_at: '2026-08-29T15:00:00.000+00:00' },
      { kind: 'weekly_scoped', percent: 13, resets_at: '2026-08-29T15:00:00.000+00:00', scope: { model: { display_name: 'Fable' } } },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 8000, used_credits: 5632, utilization: 70.4, currency: 'USD', decimal_places: 2 },
  };
  /** The profile endpoint's answer — the only place the plan's SIZE appears. */
  const PROFILE_RESPONSE = {
    organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
  };

  it('the refresher reads the seat token itself at the usage endpoint — full picture onto the seat', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([
      { label: 'grant', oauth: { refreshToken: 'rt-1', expiresAt: Date.now() + 7 * 3_600_000 } },
    ]);
    const fetchImpl = vi.fn(async (url: string) => (url === CLAUDE_PROFILE_ENDPOINT
      ? { ok: true, status: 200, json: async () => PROFILE_RESPONSE }
      : { ok: true, status: 200, json: async () => LIMITS_RESPONSE }));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

    // The two OAuth reads and NO header probe: the seat's own profile-scoped
    // token answers both, so no haiku token is spent on the member's plan.
    expect(fetchImpl.mock.calls.map((call) => call[0]))
      .toEqual([CLAUDE_USAGE_ENDPOINT, CLAUDE_PROFILE_ENDPOINT]);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-grant');

    const seat = (await orgStorage.getSeat(created[0]!.seatId))!;
    expect(seat.usage?.windows.seven_day?.usedPercent).toBe(7);
    expect(seat.usage?.windows.overage?.usedPercent).toBe(70.4);
    expect(seat.usage?.spend).toMatchObject({ usedMinor: 5632, limitMinor: 8000 });
    expect(seat.modelWindows?.fable?.usedPercent).toBe(13);
    expect(seat.modelWindowsReadAt).toBeTruthy();
    // …and WHICH subscription those percentages are percentages of (note #142).
    expect(seat.usage?.planType).toBe('max_20x');
    expect(seat.usage?.planReadAt).toBeTruthy();
  });

  it('an expiring grant renews on the refresher pass: fresh token AND rotated refresh token land on the seat', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([
      { label: 'grant', oauth: { refreshToken: 'rt-1', expiresAt: Date.now() + 5 * 60_000 } },
    ]);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ access_token: 'at-fresh', refresh_token: 'rt-2', expires_in: 28_800 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => LIMITS_RESPONSE });
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

    const seat = (await orgStorage.getSeat(created[0]!.seatId))!;
    // The seat's TURN token is the fresh access token — one credential, both jobs.
    expect(seat.token).toBe('at-fresh');
    expect(seat.oauth?.refreshToken).toBe('rt-2');
    expect(seat.oauth?.expiresAt).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    expect(seat.usage?.windows.five_hour?.usedPercent).toBe(6);
  });

  it('a lease on an expiring grant refreshes FIRST — the turn never receives a dying token', async () => {
    const { source, orgStorage, created } = await memberWithSeats([
      { label: 'grant', oauth: { refreshToken: 'rt-1', expiresAt: Date.now() + 2 * 60_000 } },
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ access_token: 'at-lease-fresh', refresh_token: 'rt-2', expires_in: 28_800 }),
    });
    const lease = await resolveSeatLease(source, 'claude', 'marat', undefined, fetchImpl as unknown as typeof fetch);
    expect(lease).toMatchObject({ kind: 'dedicated', lease: { token: 'at-lease-fresh' } });
    const seat = (await orgStorage.getSeat(created[0]!.seatId))!;
    expect(seat.token).toBe('at-lease-fresh');
    expect(seat.oauth?.refreshToken).toBe('rt-2');
  });

  it('a lease-time refresh failure still hands out the held token — deciding dead is the refresher\'s job', async () => {
    const { source, created } = await memberWithSeats([
      { label: 'grant', oauth: { refreshToken: 'rt-1', expiresAt: Date.now() + 2 * 60_000 } },
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    const lease = await resolveSeatLease(source, 'claude', 'marat', undefined, fetchImpl as unknown as typeof fetch);
    expect(lease).toMatchObject({ kind: 'dedicated', lease: { token: 'tok-grant' } });
    expect(created[0]!.oauth?.refreshToken).toBe('rt-1');
  });

  it('a legacy setup-token seat costs exactly one probe call — the doomed endpoint try is gone', async () => {
    const { pool, orgStorage, created } = await memberWithSeats([{ label: 'legacy' }]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{}', {
      status: 200,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-overage-utilization': '0.2',
      },
    }));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const seat = (await orgStorage.getSeat(created[0]!.seatId))!;
    expect(seat.usage?.windows.five_hour?.usedPercent).toBe(10);
    // Extra usage as a percent reaches even inference-only seats via headers.
    expect(seat.usage?.windows.overage?.usedPercent).toBe(20);
  });
});
