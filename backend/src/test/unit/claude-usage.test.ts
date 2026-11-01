import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeAuthorizeRequest,
  CLAUDE_MESSAGES_ENDPOINT,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_PROFILE_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  CLAUDE_USAGE_USER_AGENT,
  exchangeClaudeAuthorizationCode,
  parseClaudeOauthLimits,
  parseClaudeOauthUsage,
  parseClaudeProfilePlan,
  parseClaudeProfileSubscriptionStatus,
  parseClaudeRateLimitHeaders,
  readClaudeProviderUsage,
  readClaudeUsageForToken,
  readClaudeUsageWithProfileToken,
  refreshClaudeOAuthToken,
} from '../../agent/claude/claude-usage.js';
import type { SecretStorage } from '../../services/secret-storage.js';

/**
 * The live payload from max-1 on 2026-08-14, trimmed to the fields we read.
 * Note what it proves: the per-model window is in `limits[]` and the legacy
 * top-level `seven_day_opus`/`seven_day_sonnet` keys are NULL — a parser that
 * only knows those keys sees no per-model data at all.
 */
const LIMITS_USAGE_RESPONSE = {
  five_hour: { utilization: 3.0, resets_at: '2026-08-14T15:19:59.576891+00:00' },
  seven_day: { utilization: 97.0, resets_at: '2026-08-15T14:59:59.576918+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 3, resets_at: '2026-08-14T15:19:59.576891+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 97, resets_at: '2026-08-15T14:59:59.576918+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      resets_at: '2026-08-15T14:59:59.577184+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
};

/** The endpoint's real response shape (verified against claude-code 2.1.214). */
const OAUTH_USAGE_RESPONSE = {
  five_hour: { utilization: 33, resets_at: '2026-07-19T12:00:00.000+00:00' },
  seven_day: { utilization: 13.4, resets_at: '2026-07-25T00:59:59.000+00:00' },
  seven_day_opus: { utilization: 5.5, resets_at: '2026-07-24T03:00:00.000+00:00' },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

/**
 * The profile endpoint's real response, trimmed to what we read — captured
 * live on 2026-08-30. `rate_limit_tier` is the only field in either payload
 * that separates a $200 Max from a $100 one.
 */
const PROFILE_RESPONSE = {
  account: { has_claude_max: true, has_claude_pro: false },
  organization: {
    organization_type: 'claude_max',
    billing_type: 'stripe_subscription',
    rate_limit_tier: 'default_claude_max_20x',
    seat_tier: null,
    subscription_status: 'active',
  },
};

function secretStorageWithToken(token: string | null): SecretStorage {
  return {
    getSecretByKey: vi.fn().mockResolvedValue(
      token ? { secretId: 's1', userId: 'user-1', key: 'claude-oauth-token', value: token } : null,
    ),
  } as unknown as SecretStorage;
}

describe('parseClaudeOauthLimits', () => {
  it('reads the unified windows and keeps the per-model one apart', () => {
    const usage = parseClaudeOauthLimits(LIMITS_USAGE_RESPONSE, '2026-08-14T14:30:00.000Z')!;
    expect(usage.snapshot.windows.five_hour).toMatchObject({ usedPercent: 3, windowDurationMins: 300 });
    expect(usage.snapshot.windows.seven_day).toMatchObject({ usedPercent: 97, windowDurationMins: 10_080 });
    expect(usage.snapshot.windows.seven_day.resetsAt)
      .toBe(Math.round(Date.parse('2026-08-15T14:59:59.576918+00:00') / 1000));

    // Keyed by the lowercased display name, which IS the catalog alias — one
    // key serves routing and the billing lane.
    expect(usage.modelWindows.fable).toMatchObject({ id: 'seven_day_fable', usedPercent: 100 });

    // The unified map must NOT gain the fable window: selection scores
    // unscoped turns on its max, and a full fable row there would bench an
    // account with room for every other model.
    expect(Object.keys(usage.snapshot.windows).sort()).toEqual(['five_hour', 'seven_day']);
  });

  it('is null when there is no limits array to read', () => {
    expect(parseClaudeOauthLimits({ five_hour: { utilization: 10 } })).toBeNull();
    expect(parseClaudeOauthLimits({ limits: [] })).toBeNull();
    expect(parseClaudeOauthLimits(null)).toBeNull();
  });

  it('skips scoped entries with no model name rather than inventing a key', () => {
    const usage = parseClaudeOauthLimits({
      limits: [
        { kind: 'weekly_all', percent: 50 },
        { kind: 'weekly_scoped', percent: 80, scope: { model: { display_name: '' } } },
        { kind: 'weekly_scoped', percent: 80, scope: null },
      ],
    })!;
    expect(usage.modelWindows).toEqual({});
    expect(usage.snapshot.windows.seven_day.usedPercent).toBe(50);
  });
});

describe('readClaudeUsageWithProfileToken', () => {
  it('prefers limits[] and falls back to the legacy top-level keys', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => LIMITS_USAGE_RESPONSE });
    const read = await readClaudeUsageWithProfileToken('at-1', fetchImpl as unknown as typeof fetch);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.usage.modelWindows.fable.usedPercent).toBe(100);
    expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE_USAGE_ENDPOINT);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer at-1');

    const legacy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OAUTH_USAGE_RESPONSE });
    const fallback = await readClaudeUsageWithProfileToken('at-1', legacy as unknown as typeof fetch);
    expect(fallback.kind).toBe('ok');
    if (fallback.kind === 'ok') {
      expect(fallback.usage.snapshot.windows.five_hour.usedPercent).toBe(33);
      expect(fallback.usage.modelWindows).toEqual({});
    }
  });

  it('reports an auth rejection distinctly from a failure — only one is the token\'s fault', async () => {
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await readClaudeUsageWithProfileToken('at-1', rejected as unknown as typeof fetch))
      .toEqual({ kind: 'auth_rejected', status: 401 });

    const broken = vi.fn().mockRejectedValue(new Error('network'));
    expect(await readClaudeUsageWithProfileToken('at-1', broken as unknown as typeof fetch))
      .toEqual({ kind: 'failed' });
  });

  it('distinguishes a past-due subscription from a rejected OAuth grant', async () => {
    const pastDueProfile = {
      ...PROFILE_RESPONSE,
      organization: { ...PROFILE_RESPONSE.organization, subscription_status: 'past_due' },
    };
    const payment = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pastDueProfile), { status: 200 }));
    expect(await readClaudeUsageWithProfileToken('at-1', payment as unknown as typeof fetch, undefined, 0))
      .toEqual({
        kind: 'payment_required',
        subscriptionStatus: 'past_due',
        plan: { planType: 'max_20x', planReadAt: '1970-01-01T00:00:00.000Z' },
      });
    expect(payment.mock.calls.map((call) => call[0]))
      .toEqual([CLAUDE_USAGE_ENDPOINT, CLAUDE_PROFILE_ENDPOINT]);

    // A 403 with an active profile proves OAuth is alive and leaves runtime
    // inference as the authority; it is not rewritten as auth death.
    const active = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(PROFILE_RESPONSE), { status: 200 }));
    expect(await readClaudeUsageWithProfileToken('at-1', active as unknown as typeof fetch))
      .toEqual({
        kind: 'profile_access_forbidden',
        profile: { planType: 'max_20x', subscriptionStatus: 'active' },
      });
  });

  it('names the subscription beside the windows, from the profile endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url === CLAUDE_PROFILE_ENDPOINT
      ? { ok: true, status: 200, json: async () => PROFILE_RESPONSE }
      : { ok: true, status: 200, json: async () => LIMITS_USAGE_RESPONSE }));
    const read = await readClaudeUsageWithProfileToken(
      'at-1', fetchImpl as unknown as typeof fetch, undefined, Date.parse('2026-08-30T09:00:00.000Z'),
    );
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.usage.snapshot.planType).toBe('max_20x');
      expect(read.usage.snapshot.planReadAt).toBe('2026-08-30T09:00:00.000Z');
      // The windows the caller actually came for are untouched by the extra read.
      expect(read.usage.modelWindows.fable.usedPercent).toBe(100);
    }
    expect(fetchImpl.mock.calls.map((call) => call[0]))
      .toEqual([CLAUDE_USAGE_ENDPOINT, CLAUDE_PROFILE_ENDPOINT]);
  });

  it('reuses a young plan and re-reads a stale one — one endpoint, two schedules', async () => {
    const profileCalls = () => fetchImpl.mock.calls.filter((call) => call[0] === CLAUDE_PROFILE_ENDPOINT).length;
    const fetchImpl = vi.fn(async (url: string) => (url === CLAUDE_PROFILE_ENDPOINT
      ? { ok: true, status: 200, json: async () => PROFILE_RESPONSE }
      : { ok: true, status: 200, json: async () => LIMITS_USAGE_RESPONSE }));
    const nowMs = Date.parse('2026-08-30T09:00:00.000Z');

    // An hour old: the usage pass costs one request, not two.
    const young = await readClaudeUsageWithProfileToken(
      'at-1', fetchImpl as unknown as typeof fetch,
      { planType: 'max_5x', planReadAt: '2026-08-30T08:00:00.000Z' }, nowMs,
    );
    if (young.kind === 'ok') expect(young.usage.snapshot.planType).toBe('max_5x');
    expect(profileCalls()).toBe(0);

    // A day old: an upgrade must not be pinned to the sign-in date (note #138).
    const stale = await readClaudeUsageWithProfileToken(
      'at-1', fetchImpl as unknown as typeof fetch,
      { planType: 'max_5x', planReadAt: '2026-08-29T09:00:00.000Z' }, nowMs,
    );
    if (stale.kind === 'ok') expect(stale.usage.snapshot.planType).toBe('max_20x');
    expect(profileCalls()).toBe(1);
  });

  it('keeps the plan it knew when the profile read fails — a timeout is not an answer', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url === CLAUDE_PROFILE_ENDPOINT
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => LIMITS_USAGE_RESPONSE }));
    const read = await readClaudeUsageWithProfileToken(
      'at-1', fetchImpl as unknown as typeof fetch,
      { planType: 'max_20x', planReadAt: '2026-08-01T09:00:00.000Z' }, Date.parse('2026-08-30T09:00:00.000Z'),
    );
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.usage.snapshot.planType).toBe('max_20x');
      // …and stays stale rather than claiming to have just been read.
      expect(read.usage.snapshot.planReadAt).toBe('2026-08-01T09:00:00.000Z');
    }
  });
});

describe('parseClaudeProfilePlan', () => {
  it('separates the two Max sizes, which only the rate-limit tier does', () => {
    expect(parseClaudeProfilePlan(PROFILE_RESPONSE)).toBe('max_20x');
    expect(parseClaudeProfilePlan({
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
    })).toBe('max_5x');
    // `organization_type` says `claude_max` for BOTH — on its own it answers
    // the wrong question (note #142).
    expect(parseClaudeProfilePlan({ organization: { organization_type: 'claude_pro' } })).toBe('pro');
  });

  it('falls back past a tier that names no plan, and says nothing when nothing does', () => {
    expect(parseClaudeProfilePlan({
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default' },
    })).toBe('max');
    // An unreleased size keeps its own words rather than being dropped.
    expect(parseClaudeProfilePlan({
      organization: { rate_limit_tier: 'default_claude_max_50x' },
    })).toBe('max_50x');
    expect(parseClaudeProfilePlan({ organization: {} })).toBeUndefined();
    expect(parseClaudeProfilePlan({})).toBeUndefined();
    expect(parseClaudeProfilePlan(null)).toBeUndefined();
  });
});

describe('parseClaudeProfileSubscriptionStatus', () => {
  it('normalizes the provider state without inventing one', () => {
    expect(parseClaudeProfileSubscriptionStatus(PROFILE_RESPONSE)).toBe('active');
    expect(parseClaudeProfileSubscriptionStatus({ organization: { subscription_status: ' PAST_DUE ' } }))
      .toBe('past_due');
    expect(parseClaudeProfileSubscriptionStatus({ organization: {} })).toBeUndefined();
    expect(parseClaudeProfileSubscriptionStatus(null)).toBeUndefined();
  });
});

describe('refreshClaudeOAuthToken', () => {
  it('posts the refresh grant and returns the rotated tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 28_800 }),
    });
    const before = Date.now();
    const result = await refreshClaudeOAuthToken('rt-1', fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.accessToken).toBe('at-2');
      // The rotated refresh token must come back to the caller — dropping it
      // strands the credential at the NEXT refresh, hours later.
      expect(result.refreshToken).toBe('rt-2');
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + 28_800_000);
    }
    expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE_OAUTH_TOKEN_ENDPOINT);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
    });
  });

  it('separates a dead grant from a transient failure', async () => {
    const dead = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    expect(await refreshClaudeOAuthToken('rt-1', dead as unknown as typeof fetch))
      .toEqual({ kind: 'rejected', status: 400 });
    // A 429 or 5xx is worth retrying next pass — it must not kill the grant.
    // The status rides along: a retry loop that only says "failed" is how the
    // 2026-08-16 429 stayed invisible for 17 hours.
    const busy = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    expect(await refreshClaudeOAuthToken('rt-1', busy as unknown as typeof fetch))
      .toEqual({ kind: 'failed', reason: 'HTTP 429' });
  });

  // The regression guard for that outage: the other two hostnames answer 429
  // to every refresh, so the pool must ask the one that answers.
  it('refreshes against api.anthropic.com', () => {
    expect(CLAUDE_OAUTH_TOKEN_ENDPOINT).toBe('https://api.anthropic.com/v1/oauth/token');
  });
});

describe('parseClaudeOauthUsage', () => {
  it('maps windows to the stored shape: percent, epoch-seconds reset, implied duration', () => {
    const snapshot = parseClaudeOauthUsage(OAUTH_USAGE_RESPONSE, '2026-07-19T10:00:00.000Z')!;
    expect(snapshot.capturedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(snapshot.windows.five_hour).toEqual({
      id: 'five_hour',
      usedPercent: 33,
      resetsAt: Math.round(Date.parse('2026-07-19T12:00:00.000+00:00') / 1000),
      windowDurationMins: 300,
    });
    expect(snapshot.windows.seven_day).toMatchObject({ usedPercent: 13.4, windowDurationMins: 10_080 });
    expect(snapshot.windows.seven_day_opus).toMatchObject({ usedPercent: 5.5 });
    // Disabled extra usage (utilization null) never becomes a window.
    expect(snapshot.windows.overage).toBeUndefined();
  });

  it('maps enabled extra usage onto the overage window and clamps percentages', () => {
    const snapshot = parseClaudeOauthUsage({
      five_hour: { utilization: 250, resets_at: '2026-07-19T12:00:00.000Z' },
      extra_usage: { is_enabled: true, utilization: 12 },
    })!;
    expect(snapshot.windows.five_hour.usedPercent).toBe(100);
    expect(snapshot.windows.overage).toMatchObject({ id: 'overage', usedPercent: 12 });
  });

  it('returns null for garbage or a response with no usable windows', () => {
    expect(parseClaudeOauthUsage(null)).toBeNull();
    expect(parseClaudeOauthUsage('nope')).toBeNull();
    expect(parseClaudeOauthUsage({ five_hour: { utilization: 'high' } })).toBeNull();
  });
});

describe('parseClaudeRateLimitHeaders', () => {
  it('reads the unified 5h/7d buckets: 0..1 utilization → percent, epoch resets', () => {
    /** Real header shape from a live Messages call (verified 2026-07-19). */
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
      'anthropic-ratelimit-unified-5h-reset': '1784455800',
      'anthropic-ratelimit-unified-7d-utilization': '0.07',
      'anthropic-ratelimit-unified-7d-reset': '1784991600',
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    const snapshot = parseClaudeRateLimitHeaders(headers, '2026-07-19T10:00:00.000Z')!;
    expect(snapshot.windows.five_hour).toEqual({
      id: 'five_hour', usedPercent: 35, resetsAt: 1_784_455_800, windowDurationMins: 300,
    });
    expect(snapshot.windows.seven_day).toEqual({
      id: 'seven_day', usedPercent: 7, resetsAt: 1_784_991_600, windowDurationMins: 10_080,
    });
  });

  it('reads a full window as 100% — exactly 1.0, or past it (note #692)', () => {
    // Live shape of a drained 5h window (429, verified 2026-10-03): `1.0`.
    const full = parseClaudeRateLimitHeaders(new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
    }))!;
    expect(full.windows.five_hour?.usedPercent).toBe(100);
    // An overshot window is still a fraction: 1.01 is 101%, shown as full —
    // never "1% used", which is what reading it as a percent produced.
    const over = parseClaudeRateLimitHeaders(new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '1.01',
      'anthropic-ratelimit-unified-7d-utilization': '1.5',
    }))!;
    expect(over.windows.five_hour?.usedPercent).toBe(100);
    expect(over.windows.seven_day?.usedPercent).toBe(100);
  });

  it('returns null when no utilization headers are present', () => {
    expect(parseClaudeRateLimitHeaders(new Headers({ 'content-type': 'application/json' }))).toBeNull();
  });
});

describe('readClaudeProviderUsage', () => {
  it('fetches with the bearer token and the required claude-code User-Agent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(OAUTH_USAGE_RESPONSE), { status: 200 }),
    );
    const result = await readClaudeProviderUsage({
      secretStorage: secretStorageWithToken('sk-ant-oat01-abc'),
      userId: 'user-1',
      fetchImpl,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.snapshot.windows.five_hour.usedPercent).toBe(33);
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CLAUDE_USAGE_ENDPOINT);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat01-abc',
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
    });
  });

  it('reports no_token when nothing is stored (interactive sign-in)', async () => {
    const fetchImpl = vi.fn();
    const result = await readClaudeProviderUsage({
      secretStorage: secretStorageWithToken(null),
      userId: 'user-1',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'no_token' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the 1-token inference header probe when the scope is rejected (setup-tokens)', async () => {
    const fetchImpl = vi.fn()
      // The OAuth usage endpoint rejects setup-tokens: 403 permission_error.
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ type: 'error', error: { type: 'permission_error' } }),
        { status: 403 },
      ))
      .mockResolvedValueOnce(new Response('{"type":"message"}', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.35',
          'anthropic-ratelimit-unified-5h-reset': '1784455800',
          'anthropic-ratelimit-unified-7d-utilization': '0.07',
          'anthropic-ratelimit-unified-7d-reset': '1784991600',
        },
      }));

    const result = await readClaudeProviderUsage({
      secretStorage: secretStorageWithToken('sk-ant-oat01-abc'),
      userId: 'user-1',
      fetchImpl,
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.snapshot.windows.five_hour).toMatchObject({ usedPercent: 35 });
      expect(result.snapshot.windows.seven_day).toMatchObject({ usedPercent: 7 });
    }
    const [probeUrl, probeInit] = fetchImpl.mock.calls[1];
    expect(probeUrl).toBe(CLAUDE_MESSAGES_ENDPOINT);
    expect(probeInit.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat01-abc',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    // The probe stays as cheap as inference gets: one output token, discarded.
    expect(JSON.parse(probeInit.body)).toMatchObject({ max_tokens: 1 });
  });

  it('reports failed on HTTP errors and thrown fetches, never throwing', async () => {
    expect(await readClaudeProviderUsage({
      secretStorage: secretStorageWithToken('sk-ant-oat01-abc'),
      userId: 'user-1',
      fetchImpl: vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    })).toEqual({ kind: 'failed' });

    expect(await readClaudeProviderUsage({
      secretStorage: secretStorageWithToken('sk-ant-oat01-abc'),
      userId: 'user-1',
      fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
    })).toEqual({ kind: 'failed' });
  });
});

describe('the full-picture additions (2026-08-23)', () => {
  it('limits[] parsing carries extra usage: the overage window plus spend amounts', () => {
    const usage = parseClaudeOauthLimits({
      limits: [{ kind: 'weekly_all', percent: 7 }],
      extra_usage: {
        is_enabled: true, monthly_limit: 8000, used_credits: 5632,
        utilization: 70.39999999999999, currency: 'USD', decimal_places: 2,
      },
    })!;
    expect(usage.snapshot.windows.overage).toMatchObject({ id: 'overage', usedPercent: 70.39999999999999 });
    // Minor units, no formatting baked in: $56.32 of $80.00.
    expect(usage.snapshot.spend).toEqual({ usedMinor: 5632, limitMinor: 8000, currency: 'USD', exponent: 2 });
  });

  it('disabled or amount-less extra usage yields neither window nor spend', () => {
    const disabled = parseClaudeOauthLimits({
      limits: [{ kind: 'weekly_all', percent: 7 }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    })!;
    expect(disabled.snapshot.windows.overage).toBeUndefined();
    expect(disabled.snapshot.spend).toBeUndefined();
  });

  it('legacy top-level parsing ignores unreleased codename buckets', () => {
    // Live payload 2026-08-23 carried nimbus_quill/iguana_necktie/cinder_cove
    // shaped exactly like windows; without the gate each renders as a meter
    // labelled with its codename.
    const snapshot = parseClaudeOauthUsage({
      five_hour: { utilization: 6 },
      nimbus_quill: { utilization: 0, resets_at: null },
      iguana_necktie: { utilization: 40 },
    })!;
    expect(Object.keys(snapshot.windows)).toEqual(['five_hour']);
  });

  it('the header probe reads the overage bucket too — extra usage without any scope', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.01',
      'anthropic-ratelimit-unified-7d-utilization': '0.06',
      'anthropic-ratelimit-unified-overage-utilization': '0.704',
      'anthropic-ratelimit-unified-overage-reset': '1788220800',
    });
    const snapshot = parseClaudeRateLimitHeaders(headers)!;
    expect(snapshot.windows.overage).toEqual({ id: 'overage', usedPercent: 70.4, resetsAt: 1_788_220_800 });
  });

  it('readClaudeUsageForToken can skip the endpoint a setup-token can never pass', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
      },
    }));
    const read = await readClaudeUsageForToken('sk-ant-oat01-x'.padEnd(40, 'y'), fetchImpl as unknown as typeof fetch, { skipUsageEndpoint: true });
    expect(read.kind).toBe('ok');
    // ONE call — the Messages probe. The endpoint was not burned.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE_MESSAGES_ENDPOINT);
  });

  it('does not treat quota headers on a rejected inference response as proof of access', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('forbidden', {
      status: 403,
      headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' },
    }));
    await expect(readClaudeUsageForToken(
      'sk-ant-oat01-x'.padEnd(40, 'y'),
      fetchImpl as unknown as typeof fetch,
      { skipUsageEndpoint: true },
    )).resolves.toEqual({ kind: 'auth_rejected', status: 403 });
  });
});

describe('the seat mint (authorize + exchange)', () => {
  it('builds the authorize URL exactly as the CLI does, minus the API-key scope', () => {
    const request = buildClaudeAuthorizeRequest();
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
    // platform.claude.com — the console.anthropic.com callback answers
    // "Invalid request format" (cost two live consent taps to learn).
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload');
    // 32-byte state and verifier (43 chars base64url) — 16-byte state is
    // refused the same way the wrong redirect is.
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(request.verifier).toHaveLength(43);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges code#state against the held PKCE pair', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 28_800, scope: 'user:profile user:inference' }),
    });
    const result = await exchangeClaudeAuthorizationCode(
      'the-code#the-state',
      { verifier: 'the-verifier', state: 'the-state' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.grant).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', scopes: ['user:profile', 'user:inference'] });
      expect(result.grant.expiresAt).toBeGreaterThan(Date.now());
    }
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      state: 'the-state',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    });
  });

  it('a state that does not match the held pair never reaches the network', async () => {
    const fetchImpl = vi.fn();
    const result = await exchangeClaudeAuthorizationCode(
      'the-code#stale-state',
      { verifier: 'v', state: 'expected-state' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.kind).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('separates a refused code from a service failure', async () => {
    const refused = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    expect((await exchangeClaudeAuthorizationCode('c#s', { verifier: 'v', state: 's' }, refused as unknown as typeof fetch)).kind).toBe('rejected');
    const broken = vi.fn().mockRejectedValue(new Error('network down'));
    expect((await exchangeClaudeAuthorizationCode('c#s', { verifier: 'v', state: 's' }, broken as unknown as typeof fetch)).kind).toBe('failed');
  });
});
