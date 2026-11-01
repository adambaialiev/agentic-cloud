import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_FAILURE_DEATH_THRESHOLD,
  InMemoryPlatformCredentialPool,
  applyLeaseOutcome,
  isLeasable,
  modelWindowPercent,
  resolveUserLease,
  selectLeaseCandidate,
} from '../../services/platform-credential-pool.js';
import {
  CLAUDE_MESSAGES_ENDPOINT,
  CLAUDE_PROFILE_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  readClaudeUsageForToken,
} from '../../agent/claude/claude-usage.js';
import type { PlatformCredentialDocument } from '../../types/platform-credential.js';

const NOW = '2026-07-30T12:00:00.000Z';

function credential(overrides: Partial<PlatformCredentialDocument> = {}): PlatformCredentialDocument {
  return {
    credentialId: `cred_${Math.random().toString(36).slice(2, 9)}`,
    provider: 'claude',
    token: 'sk-ant-oat01-test-token-abcdefghijklmnop',
    label: 'test',
    status: 'active',
    inFlightCount: 0,
    authFailureStreak: 0,
    totalLeases: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function withUsage(doc: PlatformCredentialDocument, fiveHourPercent: number): PlatformCredentialDocument {
  return {
    ...doc,
    usage: {
      windows: { five_hour: { id: 'five_hour', usedPercent: fiveHourPercent } },
      capturedAt: NOW,
    },
  };
}

describe('isLeasable', () => {
  it('rejects dead and disabled outright, accepts active', () => {
    expect(isLeasable(credential(), NOW)).toBe(true);
    expect(isLeasable(credential({ status: 'payment_required' }), NOW)).toBe(false);
    expect(isLeasable(credential({ status: 'dead' }), NOW)).toBe(false);
    expect(isLeasable(credential({ status: 'disabled' }), NOW)).toBe(false);
  });

  it('treats an expired cooldown as leasable and a future one as not', () => {
    expect(isLeasable(credential({ status: 'cooldown', cooldownUntil: '2026-07-30T11:00:00.000Z' }), NOW)).toBe(true);
    expect(isLeasable(credential({ status: 'cooldown', cooldownUntil: '2026-07-30T13:00:00.000Z' }), NOW)).toBe(false);
  });
});

describe('selectLeaseCandidate', () => {
  it('prefers the credential with the emptiest usage window', () => {
    const fresh = withUsage(credential({ label: 'fresh' }), 10);
    const nearlyFull = withUsage(credential({ label: 'full' }), 90);
    expect(selectLeaseCandidate([nearlyFull, fresh], NOW)?.label).toBe('fresh');
  });

  it('weighs in-flight turns so an idle busier-window credential can win', () => {
    // 50% + 0 in flight beats 30% + 3 in flight (30 + 3×10 = 60).
    const idle = withUsage(credential({ label: 'idle' }), 50);
    const swamped = withUsage(credential({ label: 'swamped', inFlightCount: 3 }), 30);
    expect(selectLeaseCandidate([swamped, idle], NOW)?.label).toBe('idle');
  });

  it('never picks dead or cooling credentials, even when they score best', () => {
    const dead = withUsage(credential({ label: 'dead', status: 'dead' }), 0);
    const cooling = withUsage(
      credential({ label: 'cooling', status: 'cooldown', cooldownUntil: '2026-07-30T13:00:00.000Z' }),
      0,
    );
    const alive = withUsage(credential({ label: 'alive' }), 95);
    expect(selectLeaseCandidate([dead, cooling, alive], NOW)?.label).toBe('alive');
    expect(selectLeaseCandidate([dead, cooling], NOW)).toBeNull();
  });

  it('breaks score ties toward the least recently leased', () => {
    const stale = withUsage(credential({ label: 'stale', lastLeasedAt: '2026-07-30T09:00:00.000Z' }), 40);
    const recent = withUsage(credential({ label: 'recent', lastLeasedAt: '2026-07-30T11:59:00.000Z' }), 40);
    expect(selectLeaseCandidate([recent, stale], NOW)?.label).toBe('stale');
  });

  it('a leasable preferred credential wins over a better-scoring one (pin stickiness)', () => {
    const pinned = withUsage(credential({ credentialId: 'cred_pinned', label: 'pinned' }), 80);
    const better = withUsage(credential({ label: 'better' }), 10);
    expect(selectLeaseCandidate([better, pinned], NOW, 'cred_pinned')?.label).toBe('pinned');
  });

  it('a benched preferred credential is ignored and scoring takes over', () => {
    const pinned = withUsage(credential({ credentialId: 'cred_pinned', label: 'pinned', status: 'dead' }), 0);
    const other = withUsage(credential({ label: 'other' }), 90);
    expect(selectLeaseCandidate([pinned, other], NOW, 'cred_pinned')?.label).toBe('other');
  });

  it('the operator routing pin beats scoring — that is the whole switcher', () => {
    const routed = withUsage(credential({ label: 'routed', routingPin: true }), 85);
    const emptier = withUsage(credential({ label: 'emptier' }), 5);
    expect(selectLeaseCandidate([emptier, routed], NOW)?.label).toBe('routed');
  });

  it("the caller's preference outranks the operator pin", () => {
    // A Codex machine holds ONE account's auth.json: routing it elsewhere
    // produces a broken turn, while ignoring the ops pin only produces a
    // differently-routed one.
    const routed = withUsage(credential({ label: 'routed', routingPin: true }), 5);
    const held = withUsage(credential({ credentialId: 'cred_held', label: 'held' }), 90);
    expect(selectLeaseCandidate([routed, held], NOW, 'cred_held')?.label).toBe('held');
  });

  it('a pin steers but never strands: a cooling pinned account falls back to scoring', () => {
    const routed = withUsage(credential({
      label: 'routed', routingPin: true, status: 'cooldown', cooldownUntil: '2026-07-30T13:00:00.000Z',
    }), 5);
    const other = withUsage(credential({ label: 'other' }), 95);
    expect(selectLeaseCandidate([routed, other], NOW)?.label).toBe('other');
  });
});

describe('applyLeaseOutcome', () => {
  it('ok decrements in-flight, clears the failure streak, and revives a cooldown', () => {
    const doc = credential({ status: 'cooldown', inFlightCount: 2, authFailureStreak: 1 });
    const updates = applyLeaseOutcome(doc, { kind: 'ok' }, NOW);
    expect(updates).toMatchObject({ inFlightCount: 1, authFailureStreak: 0, status: 'active' });
  });

  it('rate_limited benches the credential for the default cooldown', () => {
    const updates = applyLeaseOutcome(credential({ inFlightCount: 1 }), { kind: 'rate_limited' }, NOW);
    expect(updates.status).toBe('cooldown');
    expect(updates.cooldownUntil).toBe('2026-07-30T12:30:00.000Z');
  });

  it('rate_limited honors an explicit retry-after', () => {
    const updates = applyLeaseOutcome(
      credential({ inFlightCount: 1 }),
      { kind: 'rate_limited', retryAfterSeconds: 60 },
      NOW,
    );
    expect(updates.cooldownUntil).toBe('2026-07-30T12:01:00.000Z');
  });

  it('auth_failed kills the credential only at the streak threshold', () => {
    const first = applyLeaseOutcome(credential({ inFlightCount: 1 }), { kind: 'auth_failed' }, NOW);
    expect(first.authFailureStreak).toBe(1);
    expect(first.status).toBeUndefined();

    const fatal = applyLeaseOutcome(
      credential({ inFlightCount: 1, authFailureStreak: AUTH_FAILURE_DEATH_THRESHOLD - 1 }),
      { kind: 'auth_failed', detail: 'OAuth token revoked' },
      NOW,
    );
    expect(fatal.status).toBe('dead');
    expect(fatal.deadReason).toBe('OAuth token revoked');
  });

  it('payment_required preserves the grant and records the provider state', () => {
    const updates = applyLeaseOutcome(
      credential({ inFlightCount: 1, authFailureStreak: 1, deadReason: 'old auth guess' }),
      { kind: 'payment_required', subscriptionStatus: 'past_due' },
      NOW,
    );
    expect(updates).toMatchObject({
      status: 'payment_required', authFailureStreak: 0, deadReason: '',
      subscriptionStatus: 'past_due', subscriptionStatusReadAt: NOW,
    });
  });

  it('error is neutral: only the in-flight count moves', () => {
    const updates = applyLeaseOutcome(credential({ inFlightCount: 1, authFailureStreak: 1 }), { kind: 'error' }, NOW);
    expect(updates).toEqual({ inFlightCount: 0, updatedAt: NOW });
  });

  it('release extras store fresh usage and a refreshed secret (codex write-back)', () => {
    const usage = {
      windows: { primary: { id: 'primary', usedPercent: 12 } },
      capturedAt: NOW,
    };
    const updates = applyLeaseOutcome(
      credential({ inFlightCount: 1, token: '{"old":true}' }),
      { kind: 'ok' },
      NOW,
      { usage, refreshedToken: '{"new":true}' },
    );
    expect(updates.usage).toBe(usage);
    expect(updates.usageRefreshedAt).toBe(NOW);
    expect(updates.token).toBe('{"new":true}');
  });

  it('an unchanged refreshed token writes nothing; an auth-failed turn never writes one', () => {
    const same = applyLeaseOutcome(
      credential({ inFlightCount: 1, token: '{"same":true}' }),
      { kind: 'ok' },
      NOW,
      { refreshedToken: '{"same":true}' },
    );
    expect(same.token).toBeUndefined();

    const suspect = applyLeaseOutcome(
      credential({ inFlightCount: 1, token: '{"old":true}' }),
      { kind: 'auth_failed' },
      NOW,
      { refreshedToken: '{"tampered":true}' },
    );
    expect(suspect.token).toBeUndefined();
  });
});

describe('model windows and scoring', () => {
  it('a model window is what the ACCOUNT reports, or 0 — no estimate since the shared pool went', () => {
    const doc = credential({
      usage: { windows: { seven_day: { id: 'seven_day', usedPercent: 20 } }, capturedAt: NOW },
      modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 20 } },
    });
    expect(modelWindowPercent(doc, 'fable')).toBe(20);
    expect(modelWindowPercent(doc, 'opus')).toBe(0);
  });

  it('a full reported fable window does not bench the credential for other models', () => {
    const exhausted = withUsage(
      credential({ label: 'fable-spent', modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 100 } } }),
      10,
    );
    const other = withUsage(credential({ label: 'other' }), 40);
    // Fable goes elsewhere...
    expect(selectLeaseCandidate([exhausted, other], NOW, undefined, 'fable')?.label).toBe('other');
    // ...while sonnet still prefers the emptier unified window on the very
    // same credential. This is why model windows are stored apart from the
    // unified ones.
    expect(selectLeaseCandidate([exhausted, other], NOW, undefined, 'sonnet')?.label).toBe('fable-spent');
    expect(selectLeaseCandidate([exhausted, other], NOW)?.label).toBe('fable-spent');
  });
});

describe('model-scoped cooldowns', () => {
  it('a trip on a named model with unified headroom benches only that model', () => {
    const doc = withUsage(credential({ inFlightCount: 1 }), 51);
    const updates = applyLeaseOutcome(doc, { kind: 'rate_limited', retryAfterSeconds: 3600, model: 'fable' }, NOW);
    expect(updates.status).toBeUndefined();
    expect(updates.cooldownUntil).toBeUndefined();
    expect(updates.modelCooldowns).toEqual({ fable: '2026-07-30T13:00:00.000Z' });
  });

  it('scoping needs evidence: exhausted or missing unified windows bench everything', () => {
    const exhausted = withUsage(credential({ inFlightCount: 1 }), 93);
    expect(applyLeaseOutcome(exhausted, { kind: 'rate_limited', model: 'fable' }, NOW).status).toBe('cooldown');
    const blind = credential({ inFlightCount: 1 });
    expect(applyLeaseOutcome(blind, { kind: 'rate_limited', model: 'fable' }, NOW).status).toBe('cooldown');
  });

  it('a trip the CLI calls model-only benches the model even on a nearly full account (note #772)', () => {
    // A Max seat at 98% of its week whose Fable window is spent still runs
    // Opus; benching the whole seat would strand every other model with it.
    const nearlyFull = withUsage(credential({ inFlightCount: 1 }), 98);
    const updates = applyLeaseOutcome(
      nearlyFull,
      { kind: 'rate_limited', retryAfterSeconds: 3600, model: 'fable', modelOnly: true },
      NOW,
    );
    expect(updates.status).toBeUndefined();
    expect(updates.modelCooldowns).toEqual({ fable: '2026-07-30T13:00:00.000Z' });
    // Without a model to scope to, model-only has nothing to bench but the seat.
    expect(applyLeaseOutcome(nearlyFull, { kind: 'rate_limited', modelOnly: true }, NOW).status).toBe('cooldown');
  });

  it('a scoped trip merges with existing entries instead of replacing them', () => {
    const doc = withUsage(
      credential({ inFlightCount: 1, modelCooldowns: { sonnet: '2026-07-30T15:00:00.000Z' } }),
      51,
    );
    const updates = applyLeaseOutcome(doc, { kind: 'rate_limited', retryAfterSeconds: 3600, model: 'fable' }, NOW);
    expect(updates.modelCooldowns).toEqual({
      sonnet: '2026-07-30T15:00:00.000Z',
      fable: '2026-07-30T13:00:00.000Z',
    });
  });

  it('isLeasable blocks only the scoped model, and only until the entry expires', () => {
    const doc = credential({ modelCooldowns: { fable: '2026-07-30T13:00:00.000Z' } });
    expect(isLeasable(doc, NOW, 'fable')).toBe(false);
    expect(isLeasable(doc, NOW, 'opus')).toBe(true);
    // A model-less lease can't be matched against the scoped map.
    expect(isLeasable(doc, NOW)).toBe(true);
    expect(isLeasable(doc, '2026-07-30T14:00:00.000Z', 'fable')).toBe(true);
  });

  it('selection skips a model-benched credential for that model but offers it to others', () => {
    const benched = withUsage(credential({ modelCooldowns: { fable: '2026-07-30T18:00:00.000Z' } }), 10);
    const other = withUsage(credential(), 70);
    // benched scores far better (10% vs 70%) — only the model scoping keeps it out.
    expect(selectLeaseCandidate([benched, other], NOW, undefined, 'fable')?.credentialId)
      .toBe(other.credentialId);
    expect(selectLeaseCandidate([benched, other], NOW, undefined, 'sonnet')?.credentialId)
      .toBe(benched.credentialId);
  });

  it('refreshUsage prunes expired scoped entries and keeps live ones', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-gggggggggggggggg', label: 'g' });
    const [doc] = await pool.listCredentials('claude');
    doc.modelCooldowns = { fable: '2000-01-01T00:00:00.000Z', opus: '2999-01-01T00:00:00.000Z' };
    // Probe offline: the sweep still runs its bookkeeping updates.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    const [after] = await pool.listCredentials('claude');
    expect(after.modelCooldowns).toEqual({ opus: '2999-01-01T00:00:00.000Z' });
  });
});

describe('InMemoryPlatformCredentialPool', () => {
  it('lease → release round trip tracks in-flight and lease counts', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const added = await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-aaaaaaaaaaaaaaaa', label: 'a' });

    const lease = await pool.leaseCredential('claude');
    expect(lease).toMatchObject({ credentialId: added.credentialId, token: added.token });
    let [doc] = await pool.listCredentials('claude');
    expect(doc).toMatchObject({ inFlightCount: 1, totalLeases: 1 });

    await pool.releaseCredential(lease!.credentialId, { kind: 'ok' });
    [doc] = await pool.listCredentials('claude');
    expect(doc.inFlightCount).toBe(0);
  });

  it('returns null when nothing is leasable', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    expect(await pool.leaseCredential('claude')).toBeNull();

    const added = await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-bbbbbbbbbbbbbbbb', label: 'b' });
    const lease = await pool.leaseCredential('claude');
    await pool.releaseCredential(lease!.credentialId, { kind: 'auth_failed' });
    await pool.releaseCredential(added.credentialId, { kind: 'auth_failed' });
    expect(await pool.leaseCredential('claude')).toBeNull();
  });

  it('a rate-limited credential is skipped, then leasable again after the cooldown', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-cccccccccccccccc', label: 'c' });
    const lease = await pool.leaseCredential('claude');
    await pool.releaseCredential(lease!.credentialId, { kind: 'rate_limited', retryAfterSeconds: 1 });
    expect(await pool.leaseCredential('claude')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await pool.leaseCredential('claude')).not.toBeNull();
  });

  it('refreshUsage stores probed windows on live credentials', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-dddddddddddddddd', label: 'd' });
    // Setup-token: the endpoint is skipped outright (it could only 403);
    // the header probe is the whole read.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.42',
          'anthropic-ratelimit-unified-5h-reset': '1753876800',
        },
      }));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    const [doc] = await pool.listCredentials('claude');
    expect(doc.usage?.windows.five_hour).toMatchObject({ usedPercent: 42 });
    expect(doc.usageRefreshedAt).toBeTruthy();
  });

  it('a header-probe reading keeps the plan the credential already reported (note #692)', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const added = await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-plankeep0000000', label: 'p' });
    Object.assign(added, {
      usage: {
        windows: { five_hour: { id: 'five_hour', usedPercent: 100 } },
        capturedAt: '2026-10-03T15:00:00.000Z',
        planType: 'max_5x',
        planReadAt: '2026-10-03T14:00:00.000Z',
      },
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{}', {
      status: 429,
      headers: { 'anthropic-ratelimit-unified-5h-utilization': '1.01' },
    }));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    const [doc] = await pool.listCredentials('claude');
    expect(doc.usage?.windows.five_hour).toMatchObject({ usedPercent: 100 });
    expect(doc.usage).toMatchObject({ planType: 'max_5x', planReadAt: '2026-10-03T14:00:00.000Z' });
  });

  it('coalesces overlapping timer/UI usage refreshes into one provider pass', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({
      provider: 'claude',
      token: 'sk-ant-oat01-tok-singleflight',
      label: 'singleflight',
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImpl = vi.fn(async () => {
      await fetchGate;
      return new Response('{}', { status: 200 });
    });

    const timerRefresh = pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    const workspaceRefresh = pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    releaseFetch();
    await Promise.all([timerRefresh, workspaceRefresh]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Completion releases the gate; a later request still performs a fresh
    // read instead of leaving the pool permanently pinned to old data.
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('reading windows through the account usage endpoint', () => {
    const LIMITS_BODY = JSON.stringify({
      limits: [
        { kind: 'session', percent: 3, resets_at: '2026-08-14T15:19:59.000+00:00' },
        { kind: 'weekly_all', percent: 97, resets_at: '2026-08-15T14:59:59.000+00:00' },
        {
          kind: 'weekly_scoped',
          percent: 100,
          resets_at: '2026-08-15T14:59:59.000+00:00',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    });
    const PROFILE_BODY = JSON.stringify({
      organization: {
        organization_type: 'claude_max',
        rate_limit_tier: 'default_claude_max_20x',
        subscription_status: 'active',
      },
    });

    async function poolWithUsageAuth(usageAuth: PlatformCredentialDocument['usageAuth']) {
      const pool = new InMemoryPlatformCredentialPool();
      await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-pppppppppppppppp', label: 'p' });
      const [doc] = await pool.listCredentials('claude');
      doc.usageAuth = usageAuth;
      return pool;
    }

    it('stores the real per-model window and never calls the header probe', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', expiresAt: Date.now() + 3_600_000 });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(LIMITS_BODY, { status: 200 }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

      const [doc] = await pool.listCredentials('claude');
      expect(doc.usage?.windows.seven_day).toMatchObject({ usedPercent: 97 });
      expect(doc.modelWindows?.fable).toMatchObject({ usedPercent: 100 });
      // The two OAuth reads and nothing else: the endpoints answered, so no
      // header probe — and no haiku token spent.
      expect(fetchImpl.mock.calls.map((call) => call[0]))
        .toEqual([CLAUDE_USAGE_ENDPOINT, CLAUDE_PROFILE_ENDPOINT]);
    });

    it('carries a plan it already knows instead of asking again every five minutes', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', expiresAt: Date.now() + 3_600_000 });
      const [before] = await pool.listCredentials('claude');
      before!.usage = {
        capturedAt: NOW,
        windows: {},
        planType: 'max_5x',
        planReadAt: new Date(Date.now() - 60_000).toISOString(),
      };
      const fetchImpl = vi.fn().mockResolvedValue(new Response(LIMITS_BODY, { status: 200 }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

      const [doc] = await pool.listCredentials('claude');
      expect(doc.usage?.planType).toBe('max_5x');
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([CLAUDE_USAGE_ENDPOINT]);
    });

    it('renews an access token that is about to expire, keeping the rotated refresh token', async () => {
      const pool = await poolWithUsageAuth({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 60_000, // inside the renew margin
      });
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 28_800 }),
          { status: 200 },
        ))
        .mockResolvedValueOnce(new Response(LIMITS_BODY, { status: 200 }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

      const [doc] = await pool.listCredentials('claude');
      expect(doc.usageAuth?.accessToken).toBe('at-new');
      expect(doc.usageAuth?.refreshToken).toBe('rt-new');
      expect(doc.modelWindows?.fable.usedPercent).toBe(100);
      // The read used the NEW token, not the expiring one.
      expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer at-new');
    });

    it('a dead usage grant degrades to the header probe and NEVER kills the credential', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-dead', refreshToken: 'rt-dead' });
      const fetchImpl = vi.fn()
        // usage endpoint rejects the access token
        .mockResolvedValueOnce(new Response('nope', { status: 401 }))
        // refresh grant is dead too
        .mockResolvedValueOnce(new Response('nope', { status: 400 }))
        // ...so the pass falls through to the header probe alone — the
        // endpoint is never re-asked with a token that just failed it
        .mockResolvedValueOnce(new Response('{}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.5' },
        }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

      const [doc] = await pool.listCredentials('claude');
      // The credential still serves turns: this token only ever READ usage.
      expect(doc.status).toBe('active');
      expect(doc.authFailureStreak).toBe(0);
      expect(doc.usage?.windows.five_hour).toMatchObject({ usedPercent: 50 });
      expect(doc.usageAuth?.failedAt).toBeTruthy();
      expect(doc.usageAuth?.failedReason).toContain('400');
    });

    it('a successful profile read resets the auth-failure streak — the grant is provably alive', async () => {
      // Grant seats' successes only ever flow through the profile path, so a
      // streak that never reset there could add stray blips up to a death.
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', expiresAt: Date.now() + 3_600_000 });
      const [seeded] = await pool.listCredentials('claude');
      seeded.authFailureStreak = 1;
      const fetchImpl = vi.fn().mockResolvedValue(new Response(LIMITS_BODY, { status: 200 }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);

      const [doc] = await pool.listCredentials('claude');
      expect(doc.authFailureStreak).toBe(0);
    });

    it('a credential whose usage grant already died goes straight to the probe', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-dead', failedAt: '2026-08-14T00:00:00.000Z' });
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('{}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
        }));
      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.usage?.windows.five_hour).toMatchObject({ usedPercent: 25 });
      // No retry of the dead grant, no doomed endpoint call — ONE probe.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('turns a past-due 403 into a probeable payment state and keeps last-known usage', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', refreshToken: 'rt-1' });
      const [seeded] = await pool.listCredentials('claude');
      seeded.usage = {
        windows: { five_hour: { id: 'five_hour', usedPercent: 26 } },
        capturedAt: NOW,
        planType: 'max_5x',
      };
      seeded.usageRefreshedAt = NOW;
      seeded.authFailureStreak = 1;
      const pastDue = JSON.stringify({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
          subscription_status: 'past_due',
        },
      });
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
        .mockResolvedValueOnce(new Response(pastDue, { status: 200 }));

      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('payment_required');
      expect(doc.subscriptionStatus).toBe('past_due');
      expect(doc.authFailureStreak).toBe(0);
      expect(doc.usage?.windows.five_hour.usedPercent).toBe(26);
      expect(doc.usage?.planType).toBe('max_20x');
      expect(doc.usageRefreshedAt).toBe(NOW);
      expect(doc.usageAuth?.failedAt).toBeUndefined();
    });

    it('restores payment-required only after an active profile and working inference', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', refreshToken: 'rt-1' });
      const [seeded] = await pool.listCredentials('claude');
      seeded.status = 'payment_required';
      seeded.subscriptionStatus = 'past_due';
      seeded.usage = {
        windows: { five_hour: { id: 'five_hour', usedPercent: 26 } },
        capturedAt: NOW,
        planType: 'max_20x',
        planReadAt: new Date().toISOString(),
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(LIMITS_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response(PROFILE_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.03' },
        }));

      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('active');
      expect(doc.subscriptionStatus).toBe('active');
      expect(doc.authFailureStreak).toBe(0);
      expect(doc.usage?.windows.seven_day.usedPercent).toBe(97);
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
        CLAUDE_USAGE_ENDPOINT,
        CLAUDE_PROFILE_ENDPOINT,
        CLAUDE_MESSAGES_ENDPOINT,
      ]);
      expect(fetchImpl.mock.calls[2][1].headers.Authorization)
        .toBe('Bearer sk-ant-oat01-tok-pppppppppppppppp');
    });

    it('keeps the payment state when billing is active but inference is still rejected', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', refreshToken: 'rt-1' });
      const [seeded] = await pool.listCredentials('claude');
      seeded.status = 'payment_required';
      seeded.subscriptionStatus = 'past_due';
      seeded.usage = {
        windows: {}, capturedAt: NOW, planType: 'max_20x', planReadAt: new Date().toISOString(),
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(LIMITS_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response(PROFILE_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('payment_required');
      expect(doc.subscriptionStatus).toBe('active');
      expect(doc.authFailureStreak).toBe(0);
      expect(doc.deadReason).toBe('');
    });

    it('does not restore on a 429 carrying quota headers', async () => {
      const pool = await poolWithUsageAuth({ accessToken: 'at-1', refreshToken: 'rt-1' });
      const [seeded] = await pool.listCredentials('claude');
      seeded.status = 'payment_required';
      seeded.subscriptionStatus = 'past_due';
      seeded.usage = { windows: {}, capturedAt: NOW, planType: 'max_20x' };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(LIMITS_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response(PROFILE_BODY, { status: 200 }))
        .mockResolvedValueOnce(new Response('rate limited', {
          status: 429,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.9' },
        }));

      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('payment_required');
    });

    it('changes billing to sign-in only after the refresh grant is explicitly rejected twice', async () => {
      const pool = await poolWithUsageAuth({
        accessToken: 'at-expired', refreshToken: 'rt-revoked', expiresAt: Date.now() - 60_000,
      });
      const [seeded] = await pool.listCredentials('claude');
      seeded.status = 'payment_required';
      seeded.subscriptionStatus = 'past_due';
      const rejected = vi.fn().mockResolvedValue(new Response('invalid_grant', { status: 400 }));

      await pool.refreshUsage(rejected as unknown as typeof fetch);
      expect((await pool.listCredentials('claude'))[0]!.status).toBe('payment_required');
      await pool.refreshUsage(rejected as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('dead');
      expect(doc.deadReason).toContain('refresh grant');
    });

    it('repairs the already-deployed dead-403 shape into payment-required', async () => {
      const pool = await poolWithUsageAuth({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        failedAt: '2026-08-30T16:30:00.000Z',
        failedReason: 'usage read rejected with HTTP 403',
      });
      const [seeded] = await pool.listCredentials('claude');
      seeded.status = 'dead';
      seeded.deadReason = 'usage probe rejected with HTTP 403';
      seeded.authFailureStreak = 2;
      const pastDue = JSON.stringify({
        organization: {
          rate_limit_tier: 'default_claude_max_20x',
          subscription_status: 'past_due',
        },
      });
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
        .mockResolvedValueOnce(new Response(pastDue, { status: 200 }));

      await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
      const [doc] = await pool.listCredentials('claude');
      expect(doc.status).toBe('payment_required');
      expect(doc.subscriptionStatus).toBe('past_due');
      expect(doc.authFailureStreak).toBe(0);
      expect(doc.usageAuth?.failedAt).toBeUndefined();
      expect(doc.usageAuth?.failedReason).toBeUndefined();
      expect(doc.deadReason).toBe('');
    });
  });

  it('providers are isolated: a codex lease never returns a claude credential', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-ffffffffffffffff', label: 'claude' });
    expect(await pool.leaseCredential('codex')).toBeNull();
    await pool.addCredential({ provider: 'codex', token: '{"tokens":{}}', label: 'codex' });
    const lease = await pool.leaseCredential('codex');
    expect(lease?.token).toBe('{"tokens":{}}');
  });

  it('refreshUsage freshens an idle codex credential directly from its saved auth.json', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({
      provider: 'codex',
      token: JSON.stringify({ tokens: { access_token: 'at-codex', account_id: 'acct-codex' } }),
      label: 'codex',
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: {
          primary_window: {
            used_percent: 88,
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [doc] = await pool.listCredentials('codex');
    expect(doc.usage?.windows.primary).toMatchObject({
      usedPercent: 88,
      windowDurationMins: 10_080,
      resetsAt: 1_788_464_760,
    });
    expect(doc.usageRefreshedAt).toBeTruthy();
    expect(doc.usage?.planType).toBe('prolite');
  });

  it('does not kill a codex sign-in when only its refreshable access token is rejected', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({
      provider: 'codex',
      token: JSON.stringify({ tokens: { access_token: 'at-old', account_id: 'acct-codex' } }),
      label: 'codex',
    });
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await pool.refreshUsage(rejected as unknown as typeof fetch);
    await pool.refreshUsage(rejected as unknown as typeof fetch);
    const [doc] = await pool.listCredentials('codex');
    expect(doc.status).toBe('active');
    expect(doc.authFailureStreak).toBe(0);
  });

  it('refreshUsage marks a credential dead after repeated probe auth rejections', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'sk-ant-oat01-tok-eeeeeeeeeeeeeeee', label: 'e' });
    // Both the endpoint and the probe reject with 401 and no usage headers.
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    await pool.refreshUsage(fetchImpl as unknown as typeof fetch);
    const [doc] = await pool.listCredentials('claude');
    expect(doc.status).toBe('dead');
    expect(doc.deadReason).toContain('401');
  });
});

describe('release extras', () => {
  it('a release carrying usage stores the fresh snapshot on the credential', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'codex', token: '{"tokens":{}}', label: 'cx' });
    const lease = await pool.leaseCredential('codex');
    await pool.releaseCredential(lease!.credentialId, { kind: 'ok' }, {
      usage: { windows: { primary: { id: 'primary', usedPercent: 12 } }, capturedAt: NOW },
    });
    const [doc] = await pool.listCredentials('codex');
    expect(doc.usage?.windows.primary?.usedPercent).toBe(12);
  });
});

describe('readClaudeUsageForToken', () => {
  it('reports auth_rejected when the probe 401s without usage headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const read = await readClaudeUsageForToken('sk-ant-oat01-bad', fetchImpl as unknown as typeof fetch);
    expect(read).toEqual({ kind: 'auth_rejected', status: 401 });
  });

  it('still reads utilization headers off a 429 probe response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'anthropic-ratelimit-unified-7d-utilization': '1' },
      }));
    const read = await readClaudeUsageForToken('sk-ant-oat01-full', fetchImpl as unknown as typeof fetch);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.snapshot.windows.seven_day.usedPercent).toBe(100);
    }
  });
});

describe('setRoutingPin (the ops switcher)', () => {
  it('is exclusive: pinning one account clears the others', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const a = await pool.addCredential({ provider: 'claude', token: 't1', label: 'max-1' });
    const b = await pool.addCredential({ provider: 'claude', token: 't2', label: 'max-2-100' });

    expect(await pool.setRoutingPin('claude', a.credentialId)).toEqual({ label: 'max-1' });
    expect(await pool.setRoutingPin('claude', b.credentialId)).toEqual({ label: 'max-2-100' });

    const docs = await pool.listCredentials('claude');
    expect(docs.filter((doc) => doc.routingPin === true).map((doc) => doc.label)).toEqual(['max-2-100']);
  });

  it('null clears the pin and reports that nothing is pinned', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const a = await pool.addCredential({ provider: 'claude', token: 't1', label: 'max-1' });
    await pool.setRoutingPin('claude', a.credentialId);

    expect(await pool.setRoutingPin('claude', null)).toBeNull();
    const docs = await pool.listCredentials('claude');
    expect(docs.some((doc) => doc.routingPin === true)).toBe(false);
  });

  it('an unknown id clears the pin rather than pinning nothing silently', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const a = await pool.addCredential({ provider: 'claude', token: 't1', label: 'max-1' });
    await pool.setRoutingPin('claude', a.credentialId);

    // A stale button from an old message names a credential that is gone.
    expect(await pool.setRoutingPin('claude', 'cred_deleted')).toBeNull();
    const docs = await pool.listCredentials('claude');
    expect(docs.some((doc) => doc.routingPin === true)).toBe(false);
  });

  it('leases follow the pin end to end', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    await pool.addCredential({ provider: 'claude', token: 'empty-one', label: 'emptier' });
    const busy = await pool.addCredential({ provider: 'claude', token: 'busy-one', label: 'busy' });

    await pool.setRoutingPin('claude', busy.credentialId);
    const lease = await pool.leaseCredential('claude');
    expect(lease?.credentialId).toBe(busy.credentialId);
  });
});

describe('dedicated credentials — resolveUserLease and setOwner', () => {
  it('an owned credential serves its owner and nobody else', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const shared = await pool.addCredential({ provider: 'claude', token: 'shared-token', label: 'pool-1' });
    const owned = await pool.addCredential({ provider: 'claude', token: 'owned-token', label: 'max-alice' });
    await pool.setOwner('claude', owned.credentialId, 'alice');

    // The owner is pinned to their credential.
    const alice = await pool.leaseForUser('claude', 'alice');
    expect(alice).toMatchObject({ kind: 'dedicated', lease: { credentialId: owned.credentialId } });
    // Everyone else scores over the unowned pool only.
    const bob = await pool.leaseForUser('claude', 'bob');
    expect(bob).toMatchObject({ kind: 'limbo', lease: { credentialId: shared.credentialId } });
    // The anonymous lease path never touches an owned credential either.
    expect((await pool.leaseCredential('claude'))?.credentialId).toBe(shared.credentialId);
  });

  it("a cooling owned credential means WAIT with the account's reset — never a hop to the pool", () => {
    const cooling = credential({
      ownerUserId: 'alice',
      status: 'cooldown',
      cooldownUntil: '2026-07-30T15:00:00.000Z',
    });
    const shared = credential({ label: 'pool-1' });
    expect(resolveUserLease([cooling, shared], 'alice', NOW))
      .toEqual({ kind: 'dedicated_exhausted', resetAt: '2026-07-30T15:00:00.000Z' });
  });

  it('a model-scoped cooldown on an owned credential blocks that model alone', () => {
    const fableSpent = credential({
      ownerUserId: 'alice',
      modelCooldowns: { fable: '2026-07-31T12:00:00.000Z' },
    });
    // `model` says the wall is this model's — another one runs now (note #772).
    expect(resolveUserLease([fableSpent], 'alice', NOW, 'fable'))
      .toEqual({ kind: 'dedicated_exhausted', resetAt: '2026-07-31T12:00:00.000Z', model: 'fable' });
    expect(resolveUserLease([fableSpent], 'alice', NOW, 'opus'))
      .toMatchObject({ kind: 'dedicated' });
  });

  it('a model-benched seat falls to the next seat that runs the model (note #772)', () => {
    // Adam's Demonstrations workplace on 2026-10-17: the new seat (selected,
    // first) runs Fable only on usage credits, the old one has spent its
    // Fable week. Once the new one is benched for Fable, Fable goes to the
    // old one; Opus still goes to the new one.
    const newSeat = credential({
      credentialId: 'seat_new', ownerUserId: 'alice',
      modelCooldowns: { fable: '2026-07-30T12:30:00.000Z' },
    });
    const oldSeat = credential({ credentialId: 'seat_old', ownerUserId: 'alice' });
    expect(resolveUserLease([newSeat, oldSeat], 'alice', NOW, 'fable'))
      .toMatchObject({ kind: 'dedicated', doc: { credentialId: 'seat_old' } });
    expect(resolveUserLease([newSeat, oldSeat], 'alice', NOW, 'opus'))
      .toMatchObject({ kind: 'dedicated', doc: { credentialId: 'seat_new' } });
  });

  it('names the model only when the model alone is what blocks every seat', () => {
    const fableOut = credential({
      ownerUserId: 'alice', modelCooldowns: { fable: '2026-07-31T12:00:00.000Z' },
    });
    const fableOutToo = credential({
      ownerUserId: 'alice', modelCooldowns: { fable: '2026-07-30T18:00:00.000Z' },
    });
    expect(resolveUserLease([fableOut, fableOutToo], 'alice', NOW, 'fable'))
      .toEqual({ kind: 'dedicated_exhausted', resetAt: '2026-07-30T18:00:00.000Z', model: 'fable' });
    // A seat cooling down as a whole runs nothing — that is the subscription.
    const accountOut = credential({
      ownerUserId: 'alice', status: 'cooldown', cooldownUntil: '2026-07-30T15:00:00.000Z',
      modelCooldowns: { fable: '2026-07-31T12:00:00.000Z' },
    });
    expect(resolveUserLease([accountOut], 'alice', NOW, 'fable'))
      .toEqual({ kind: 'dedicated_exhausted', resetAt: '2026-07-31T12:00:00.000Z' });
  });

  it('a dead owned credential drops its owner into limbo, not exhaustion', () => {
    const dead = credential({ ownerUserId: 'alice', status: 'dead' });
    const shared = credential({ label: 'pool-1' });
    const resolved = resolveUserLease([dead, shared], 'alice', NOW);
    expect(resolved.kind).toBe('limbo');
    expect((resolved as { doc: PlatformCredentialDocument | null }).doc?.label).toBe('pool-1');
  });

  it('an owned payment-blocked credential never hops into shared capacity', () => {
    const blocked = credential({ ownerUserId: 'alice', status: 'payment_required' });
    const shared = credential({ label: 'pool-1' });
    expect(resolveUserLease([blocked, shared], 'alice', NOW)).toEqual({ kind: 'payment_required' });
  });

  it('an empty unowned pool is a null limbo lease even when owned credentials exist', () => {
    const owned = credential({ ownerUserId: 'alice' });
    expect(resolveUserLease([owned], 'bob', NOW)).toEqual({ kind: 'limbo', doc: null });
  });

  it('setOwner is exclusive per user: owning a new credential releases the old one', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const first = await pool.addCredential({ provider: 'claude', token: 't1', label: 'max-old' });
    const second = await pool.addCredential({ provider: 'claude', token: 't2', label: 'max-new' });
    await pool.setOwner('claude', first.credentialId, 'alice');
    await pool.setOwner('claude', second.credentialId, 'alice');

    const docs = await pool.listCredentials('claude');
    expect(docs.find((doc) => doc.credentialId === first.credentialId)?.ownerUserId).toBeUndefined();
    expect(docs.find((doc) => doc.credentialId === second.credentialId)?.ownerUserId).toBe('alice');
    // And clearing returns it to the pool.
    await pool.setOwner('claude', second.credentialId, null);
    expect((await pool.listCredentials('claude')).every((doc) => doc.ownerUserId === undefined)).toBe(true);
    // A credential that does not exist reports so instead of pretending.
    expect(await pool.setOwner('claude', 'cred_missing', 'alice')).toBeNull();
  });

  it('leasing through leaseForUser marks the credential exactly like the anonymous path', async () => {
    const pool = new InMemoryPlatformCredentialPool();
    const owned = await pool.addCredential({ provider: 'claude', token: 't1', label: 'max-alice' });
    await pool.setOwner('claude', owned.credentialId, 'alice');
    await pool.leaseForUser('claude', 'alice');

    const [doc] = await pool.listCredentials('claude');
    expect(doc?.inFlightCount).toBe(1);
    expect(doc?.totalLeases).toBe(1);
    expect(doc?.lastLeasedAt).toBeDefined();
  });
});
