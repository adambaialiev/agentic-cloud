import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgSeatSignInFlow } from '../../services/org-seat-signin-flow.js';
import {
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_PROFILE_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
} from '../../agent/claude/claude-usage.js';
import { fakeOpenAiLogin } from '../helpers/fake-openai-login.js';

afterEach(() => { vi.useRealTimers(); });

/** Move the clock past OpenAI's poll interval (5 s in the fake). */
function afterInterval(): void {
  vi.setSystemTime(Date.now() + 6_000);
}

/**
 * The Claude mint's two upstream calls, faked by URL: the token exchange and
 * the usage-endpoint verification. Configurable per test; records exchange
 * request bodies so tests can assert on PKCE material.
 */
function fakeClaudeOauth(overrides?: {
  exchangeStatus?: number;
  usageStatus?: number;
  profileSubscriptionStatus?: string;
}) {
  const calls = { exchanges: [] as Array<Record<string, unknown>>, usageReads: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === CLAUDE_OAUTH_TOKEN_ENDPOINT) {
      calls.exchanges.push(JSON.parse(String(init?.body ?? '{}')));
      const status = overrides?.exchangeStatus ?? 200;
      return {
        ok: status === 200,
        status,
        json: async () => (status === 200
          ? {
            access_token: 'at-seat-1',
            refresh_token: 'rt-seat-1',
            expires_in: 28_800,
            scope: 'user:profile user:inference',
          }
          : { error: 'invalid_grant' }),
      };
    }
    if (url === CLAUDE_USAGE_ENDPOINT) {
      calls.usageReads += 1;
      const status = overrides?.usageStatus ?? 200;
      return {
        ok: status === 200,
        status,
        json: async () => ({
          limits: [
            { kind: 'session', percent: 6, resets_at: '2026-08-23T09:20:00.000+00:00' },
            { kind: 'weekly_all', percent: 7, resets_at: '2026-08-29T15:00:00.000+00:00' },
            { kind: 'weekly_scoped', percent: 13, resets_at: '2026-08-29T15:00:00.000+00:00', scope: { model: { display_name: 'Fable' } } },
          ],
          extra_usage: { is_enabled: true, monthly_limit: 8000, used_credits: 5632, utilization: 70.4, currency: 'USD', decimal_places: 2 },
        }),
      };
    }
    if (url === CLAUDE_PROFILE_ENDPOINT) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          organization: {
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_20x',
            subscription_status: overrides?.profileSubscriptionStatus ?? 'active',
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function makeFlow(
  oauth?: { fetchImpl: typeof fetch },
  onSeatAdded?: ReturnType<typeof vi.fn>,
) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'founder' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });
  const flow = new OrgSeatSignInFlow({
    orgStorage,
    ...(oauth ? { fetchImpl: oauth.fetchImpl } : {}),
    ...(onSeatAdded ? { onSeatAdded } : {}),
  });
  return { flow, orgStorage, orgId: org.orgId };
}

describe('OrgSeatSignInFlow — claude (our own OAuth mint, no machine)', () => {
  it('start answers awaiting_code with a fresh authorize URL — nothing runs on any machine', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    expect(started.state.phase).toBe('awaiting_code');
    const url = new URL((started.state as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('scope')).toContain('user:profile');
    expect(url.searchParams.get('scope')).not.toContain('org:create_api_key');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // 32-byte state — the 16-byte one fails the consent page (learned live).
    expect(url.searchParams.get('state')!.length).toBe(43);
  });

  it('a pasted code becomes a grant seat carrying oauth + its first usage picture', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgStorage, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const state = new URL((started.state as { url: string }).url).searchParams.get('state')!;

    const done = await flow.submitCode('dana', `the-code#${state}`);
    expect(done?.state.phase).toBe('done');
    // The exchange carried the pasted code and the SERVER-held verifier.
    expect(oauth.calls.exchanges[0]).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
    expect(typeof oauth.calls.exchanges[0].code_verifier).toBe('string');

    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      provider: 'claude',
      token: 'at-seat-1',
      selected: true,
      oauth: { refreshToken: 'rt-seat-1' },
    });
    expect(seats[0].oauth?.expiresAt).toBeGreaterThan(Date.now());
    // The verification read doubles as the first snapshot: meters from paint one.
    expect(seats[0].usage?.windows.five_hour?.usedPercent).toBe(6);
    expect(seats[0].usage?.spend).toMatchObject({ usedMinor: 5632, limitMinor: 8000 });
    expect(seats[0].modelWindows?.fable?.usedPercent).toBe(13);
  });

  it('a code from a different sign-in page is refused by state, before any exchange', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgId } = await makeFlow(oauth);
    await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const after = await flow.submitCode('dana', 'the-code#some-other-state');
    expect(after?.state.phase).toBe('awaiting_code');
    expect(oauth.calls.exchanges).toHaveLength(0);
  });

  it('a rejected exchange re-arms with a FRESH authorize URL and an honest note', async () => {
    const oauth = fakeClaudeOauth({ exchangeStatus: 400 });
    const { flow, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const firstUrl = (started.state as { url: string }).url;
    const state = new URL(firstUrl).searchParams.get('state')!;

    const after = await flow.submitCode('dana', `bad-code#${state}`);
    expect(after?.state.phase).toBe('awaiting_code');
    expect((after?.state as { url: string }).url).not.toBe(firstUrl);
    expect((after?.state as { note?: string }).note).toContain('didn\'t work');
  });

  it('a grant whose live check is REJECTED fails the flow instead of storing a dead seat', async () => {
    const oauth = fakeClaudeOauth({ usageStatus: 401 });
    const { flow, orgStorage, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const state = new URL((started.state as { url: string }).url).searchParams.get('state')!;
    const after = await flow.submitCode('dana', `the-code#${state}`);
    expect(after?.state.phase).toBe('failed');
    expect(await orgStorage.listSeatsByMember(orgId, 'dana')).toHaveLength(0);
  });

  it('a transient usage failure still lands the seat — the refresher fills the meters in', async () => {
    const oauth = fakeClaudeOauth({ usageStatus: 500 });
    const { flow, orgStorage, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const state = new URL((started.state as { url: string }).url).searchParams.get('state')!;
    const after = await flow.submitCode('dana', `the-code#${state}`);
    expect(after?.state.phase).toBe('done');
    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0].usage).toBeUndefined();
    expect(seats[0].oauth?.refreshToken).toBe('rt-seat-1');
  });

  it('stores a past-due grant as payment-required without waking agents or asking for OAuth again', async () => {
    const oauth = fakeClaudeOauth({ usageStatus: 403, profileSubscriptionStatus: 'past_due' });
    const onSeatAdded = vi.fn().mockResolvedValue(undefined);
    const { flow, orgStorage, orgId } = await makeFlow(oauth, onSeatAdded);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    const state = new URL((started.state as { url: string }).url).searchParams.get('state')!;

    const after = await flow.submitCode('dana', `the-code#${state}`);

    expect(after?.state.phase).toBe('done');
    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      status: 'payment_required',
      subscriptionStatus: 'past_due',
      usage: { planType: 'max_20x', windows: {} },
      oauth: { refreshToken: 'rt-seat-1' },
    });
    expect(seats[0].oauth?.failedAt).toBeUndefined();
    expect(onSeatAdded).not.toHaveBeenCalled();
  });
});

describe('OrgSeatSignInFlow — codex (our own device login, no machine)', () => {
  it('start answers the one-time code at once — asked of OpenAI, nothing runs on any machine', async () => {
    const openai = fakeOpenAiLogin();
    const { flow, orgId } = await makeFlow(openai);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    expect(started.state).toEqual({
      phase: 'awaiting_approval',
      url: 'https://auth.openai.com/codex/device',
      userCode: '6LP7-E6DH7',
    });
    // The CLI's own public client.
    expect(openai.calls.usercode).toEqual([{ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }]);
  });

  it('asks OpenAI no faster than its interval, however often the screen polls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openai = fakeOpenAiLogin();
    const { flow, orgId } = await makeFlow(openai);
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    await flow.poll('dana');
    await flow.poll('dana');
    expect(openai.calls.polls).toHaveLength(0);
    afterInterval();
    expect((await flow.poll('dana'))?.state.phase).toBe('awaiting_approval');
    await flow.poll('dana');
    expect(openai.calls.polls).toEqual([{ device_auth_id: 'dev-auth-1', user_code: '6LP7-E6DH7' }]);
  });

  it('the approval becomes a seat holding the auth.json the CLI would have written, with its first usage reading', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openai = fakeOpenAiLogin();
    const onSeatAdded = vi.fn(async () => {});
    const { flow, orgStorage, orgId } = await makeFlow(openai, onSeatAdded);
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });

    openai.state.approved = true;
    afterInterval();
    const done = await flow.poll('dana');
    expect(done?.state).toMatchObject({ phase: 'done', label: expect.stringContaining('ChatGPT') });
    // The exchange spent the approval's code against OpenAI's own verifier.
    const exchange = new URLSearchParams(openai.calls.exchanges[0]);
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code_verifier: 'verifier-1',
    });

    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    const auth = JSON.parse(seats[0]!.token);
    expect(auth).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'acct-123' },
      last_refresh: expect.any(String),
    });
    // Verified with the same credential before it was stored.
    expect(openai.calls.usageReads[0]).toMatchObject({ Authorization: 'Bearer access-1', 'ChatGPT-Account-Id': 'acct-123' });
    expect(seats[0]!.usage?.windows.primary?.usedPercent).toBe(12);
    expect(onSeatAdded).toHaveBeenCalledWith('dana', 'codex', orgId);
  });

  it('a login whose live check is REJECTED fails the flow instead of storing a dead seat', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openai = fakeOpenAiLogin({ usageStatus: 401 });
    const { flow, orgStorage, orgId } = await makeFlow(openai);
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    openai.state.approved = true;
    afterInterval();
    expect((await flow.poll('dana'))?.state.phase).toBe('failed');
    expect(await orgStorage.listSeatsByMember(orgId, 'dana')).toHaveLength(0);
  });

  it('a transient usage failure still lands the seat — the refresher fills the meters in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openai = fakeOpenAiLogin({ usageStatus: 503 });
    const { flow, orgStorage, orgId } = await makeFlow(openai);
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    openai.state.approved = true;
    afterInterval();
    expect((await flow.poll('dana'))?.state.phase).toBe('done');
    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0]!.usage).toBeUndefined();
  });

  it('OpenAI not answering the code request fails honestly, with nothing to wait for', async () => {
    const { flow, orgId } = await makeFlow(fakeOpenAiLogin({ usercodeStatus: 503 }));
    const started = await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    expect(started.state).toEqual({ phase: 'failed', reason: expect.stringContaining('didn’t answer') });
  });

  it('a blip while waiting keeps waiting; a refusal ends it for a fresh code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const blip = fakeOpenAiLogin({ pollStatus: 502 });
    const first = await makeFlow(blip);
    await first.flow.start({ orgId: first.orgId, userId: 'dana', provider: 'codex' });
    afterInterval();
    expect((await first.flow.poll('dana'))?.state.phase).toBe('awaiting_approval');

    const refused = fakeOpenAiLogin({ pollStatus: 400 });
    const second = await makeFlow(refused);
    await second.flow.start({ orgId: second.orgId, userId: 'dana', provider: 'codex' });
    afterInterval();
    expect((await second.flow.poll('dana'))?.state).toEqual({ phase: 'failed', reason: expect.stringContaining('fresh code') });
  });

  it('a failed exchange fails the flow — the approval\'s code is single-use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openai = fakeOpenAiLogin({ exchangeStatus: 400 });
    const { flow, orgStorage, orgId } = await makeFlow(openai);
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    openai.state.approved = true;
    afterInterval();
    expect((await flow.poll('dana'))?.state.phase).toBe('failed');
    afterInterval();
    await flow.poll('dana');
    expect(openai.calls.exchanges).toHaveLength(1);
    expect(await orgStorage.listSeatsByMember(orgId, 'dana')).toHaveLength(0);
  });
});

/** OpenCode's key check, faked by URL: the Go model list answers a key it knows. */
function fakeOpenCodeKeys(known: string, status: number | 'down' = 200) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'https://opencode.ai/inference/go/v1/models') throw new Error(`unexpected fetch: ${url}`);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    asked.push(auth);
    if (status === 'down') throw new Error('connect ETIMEDOUT');
    const ok = auth === `Bearer ${known}` && status === 200;
    return { ok, status: ok ? 200 : (status === 200 ? 401 : status), json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

describe('OrgSeatSignInFlow — opencode (a pasted API key, note #780)', () => {
  it('start points at the OpenCode console and waits for the key — no OAuth, nothing asked of anyone yet', async () => {
    const keys = fakeOpenCodeKeys('sk-good-key-0001');
    const { flow, orgId } = await makeFlow(keys);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    expect(started.state).toEqual({ phase: 'awaiting_code', url: 'https://opencode.ai/auth' });
    expect(keys.asked).toEqual([]);
  });

  it('a key OpenCode accepts becomes the member\'s selected seat, and wakes their OpenCode agents', async () => {
    const keys = fakeOpenCodeKeys('sk-good-key-0001');
    const onSeatAdded = vi.fn().mockResolvedValue(undefined);
    const { flow, orgStorage, orgId } = await makeFlow(keys, onSeatAdded);
    await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    const done = await flow.submitCode('dana', '  sk-good-key-0001 \n', orgId);
    expect(done?.state).toMatchObject({ phase: 'done', label: expect.stringMatching(/^OpenCode · /) });
    expect(keys.asked).toEqual(['Bearer sk-good-key-0001']);
    const seats = await orgStorage.listSeatsByMember(orgId, 'dana');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ provider: 'opencode', token: 'sk-good-key-0001', selected: true, status: 'active' });
    expect(seats[0].oauth).toBeUndefined();
    expect(onSeatAdded).toHaveBeenCalledWith('dana', 'opencode', orgId);
  });

  it('a key OpenCode refuses stores nothing and asks again, with the reason', async () => {
    const keys = fakeOpenCodeKeys('sk-good-key-0001');
    const { flow, orgStorage, orgId } = await makeFlow(keys);
    await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    const again = await flow.submitCode('dana', 'sk-wrong-key-9999', orgId);
    expect(again?.state).toMatchObject({ phase: 'awaiting_code', url: 'https://opencode.ai/auth', note: expect.stringMatching(/didn.t accept that key/) });
    expect(await orgStorage.listSeatsByMember(orgId, 'dana')).toEqual([]);
    // Still the same ceremony: the next paste is checked as before.
    expect((await flow.submitCode('dana', 'sk-good-key-0001', orgId))?.state.phase).toBe('done');
  });

  it('OpenCode not answering keeps the paste box rather than storing an unchecked key', async () => {
    const { flow, orgStorage, orgId } = await makeFlow(fakeOpenCodeKeys('sk-good-key-0001', 'down'));
    await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    const again = await flow.submitCode('dana', 'sk-good-key-0001', orgId);
    expect(again?.state).toMatchObject({ phase: 'awaiting_code', note: expect.stringMatching(/didn.t answer/) });
    expect(await orgStorage.listSeatsByMember(orgId, 'dana')).toEqual([]);
  });

  it('a paste that cannot be a key is not sent anywhere', async () => {
    const keys = fakeOpenCodeKeys('sk-good-key-0001');
    const { flow, orgId } = await makeFlow(keys);
    await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    const again = await flow.submitCode('dana', 'two words', orgId);
    expect(again?.state).toMatchObject({ phase: 'awaiting_code', note: expect.stringMatching(/doesn.t look like an OpenCode key/) });
    expect(keys.asked).toEqual([]);
  });

  it('the poll leaves a key ceremony waiting, past the codes\' fifteen minutes', async () => {
    vi.useFakeTimers();
    const { flow, orgId } = await makeFlow(fakeOpenCodeKeys('sk-good-key-0001'));
    await flow.start({ orgId, userId: 'dana', provider: 'opencode' });
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect((await flow.poll('dana', orgId))?.state.phase).toBe('awaiting_code');
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect((await flow.poll('dana', orgId))?.state.phase).toBe('failed');
  });
});

describe('OrgSeatSignInFlow — lifecycle', () => {
  it('poll with nothing running answers null; cancel forgets the attempt', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgId } = await makeFlow(oauth);
    expect(await flow.poll('dana')).toBeNull();

    await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    await flow.cancel('dana');
    expect(await flow.poll('dana')).toBeNull();
  });

  it('keeps a ceremony on the workplace where it began after the user switches context', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgStorage, orgId } = await makeFlow(oauth);
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'dana' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'dana', role: 'admin' });
    await flow.start({ orgId, userId: 'dana', provider: 'claude' });

    // The other org's screen sees no ceremony and cannot submit or cancel
    // this one. Switching back resumes the exact original flow.
    expect(await flow.poll('dana', other.orgId)).toBeNull();
    expect(await flow.submitCode('dana', 'not-for-this-org', other.orgId)).toBeNull();
    expect(oauth.calls.exchanges).toHaveLength(0);
    await flow.cancel('dana', other.orgId);
    expect((await flow.poll('dana', orgId))?.state.phase).toBe('awaiting_code');
    await flow.cancel('dana', orgId);
    expect(await flow.poll('dana', orgId)).toBeNull();
  });

  it('starting again replaces the previous attempt', async () => {
    const oauth = fakeClaudeOauth();
    const openai = fakeOpenAiLogin();
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => (
      String(input).startsWith('https://auth.openai.com') ? openai.fetchImpl(input, init) : oauth.fetchImpl(input, init)
    )) as typeof fetch;
    const { flow, orgId } = await makeFlow({ fetchImpl });
    await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    await flow.start({ orgId, userId: 'dana', provider: 'codex' });
    const status = await flow.poll('dana');
    expect(status?.provider).toBe('codex');
    expect(openai.calls.usercode).toHaveLength(1);
  });

  it('an attempt older than the code lifetime expires honestly', async () => {
    const oauth = fakeClaudeOauth();
    const { flow, orgId } = await makeFlow(oauth);
    const started = await flow.start({ orgId, userId: 'dana', provider: 'claude' });
    expect(started.state.phase).toBe('awaiting_code');
    // Reach into the session to age it — the flow has no clock injection.
    const session = (flow as unknown as { sessions: Map<string, { startedAt: number }> }).sessions.get('dana');
    session!.startedAt = Date.now() - 16 * 60_000;
    const expired = await flow.poll('dana');
    expect(expired?.state.phase).toBe('failed');
    expect((expired?.state as { reason: string }).reason).toContain('expired');
  });

  it('a landed seat fires onSeatAdded — sign-in is Mini-App-only, so this is what connects the waiting agents', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'founder' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'dana', role: 'member' });
    const oauth = fakeClaudeOauth();
    const connected: string[] = [];
    const flow = new OrgSeatSignInFlow({
      orgStorage,
      fetchImpl: oauth.fetchImpl,
      onSeatAdded: async (userId, provider) => { connected.push(`${userId}:${provider}`); },
    });
    const started = await flow.start({ orgId: org.orgId, userId: 'dana', provider: 'claude' });
    const state = new URL((started.state as { url: string }).url).searchParams.get('state')!;
    const done = await flow.submitCode('dana', `the-code#${state}`);
    expect(done?.state.phase).toBe('done');
    expect(connected).toEqual(['dana:claude']);
  });
});
