import {
  CODEX_DEVICE_TOKEN_ENDPOINT,
  CODEX_DEVICE_USERCODE_ENDPOINT,
  CODEX_OAUTH_TOKEN_ENDPOINT,
} from '../../agent/codex/codex-device-login.js';
import { CODEX_USAGE_ENDPOINT } from '../../agent/codex/codex-usage.js';

/** An unsigned JWT carrying the claim the CLI reads the ChatGPT account off. */
export function fakeCodexIdToken(accountId = 'acct-123'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none' }),
    encode({ email: 'dana@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } }),
    'sig',
  ].join('.');
}

/**
 * OpenAI's side of a device login, faked by URL: the code, the approval the
 * member gives on OpenAI's page (`state.approved`), the token exchange and
 * the usage read that verifies the login. Every request is recorded.
 */
export function fakeOpenAiLogin(overrides?: {
  usercodeStatus?: number;
  pollStatus?: number;
  exchangeStatus?: number;
  usageStatus?: number;
}) {
  const state = { approved: false };
  const calls = {
    usercode: [] as unknown[],
    polls: [] as unknown[],
    exchanges: [] as string[],
    usageReads: [] as Record<string, string>[],
  };
  const answer = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === CODEX_DEVICE_USERCODE_ENDPOINT) {
      calls.usercode.push(JSON.parse(String(init?.body)));
      return answer(overrides?.usercodeStatus ?? 200, {
        device_auth_id: 'dev-auth-1', user_code: '6LP7-E6DH7', interval: '5', expires_at: '2026-09-22T05:00:00Z',
      });
    }
    if (url === CODEX_DEVICE_TOKEN_ENDPOINT) {
      calls.polls.push(JSON.parse(String(init?.body)));
      if (overrides?.pollStatus) return answer(overrides.pollStatus, { error: { code: 'nope' } });
      return state.approved
        ? answer(200, { authorization_code: 'auth-code-1', code_challenge: 'challenge', code_verifier: 'verifier-1' })
        : answer(403, { error: { code: 'deviceauth_authorization_pending' } });
    }
    if (url === CODEX_OAUTH_TOKEN_ENDPOINT) {
      calls.exchanges.push(String(init?.body));
      return answer(overrides?.exchangeStatus ?? 200, {
        id_token: fakeCodexIdToken(), access_token: 'access-1', refresh_token: 'refresh-1',
      });
    }
    if (url === CODEX_USAGE_ENDPOINT) {
      calls.usageReads.push(init?.headers as Record<string, string>);
      return answer(overrides?.usageStatus ?? 200, {
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_790_000_000 } },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, state, calls };
}
