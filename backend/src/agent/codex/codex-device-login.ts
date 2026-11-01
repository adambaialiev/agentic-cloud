import { CODEX_USAGE_USER_AGENT } from './codex-usage.js';

/**
 * The ChatGPT seat mint, run by the backend itself (2026-09-22). These are the
 * three requests `codex login --device-auth` makes — mirrored from codex-cli
 * 0.155.0's `login/src/device_code_auth.rs` and `server.rs` — so the Workspace
 * sign-in no longer needs a CLI in a tmux pane on one of the member's
 * machines, nor a machine at all. Claude's seat mint moved the same way on
 * 2026-08-23 (`claude-usage.ts`); this is its Codex counterpart.
 *
 *  1. `usercode` hands out the one-time code the member types on OpenAI's
 *     page, and a `device_auth_id` that stays here.
 *  2. `token` answers 403/404 while the member has not approved yet, and
 *     then an authorization code together with the PKCE pair OpenAI itself
 *     generated for this device login.
 *  3. `/oauth/token` swaps that code for the id/access/refresh tokens.
 *
 * What lands is the auth.json the CLI would have written — same fields, same
 * order (`buildCodexAuthJson`) — because a Codex seat's token IS that file: it
 * is written onto the machine before each turn and the CLI refreshes it there.
 *
 * Checked live 2026-09-22 before this was written: `usercode` answers 200 to a
 * plain JSON POST from outside any CLI, and `token` answers 403
 * `deviceauth_authorization_pending` until the member approves.
 */

export const CODEX_AUTH_ISSUER = 'https://auth.openai.com';
/** The public Codex CLI OAuth client — the same one `codex login` uses. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_DEVICE_USERCODE_ENDPOINT = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_ENDPOINT = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_TOKEN_ENDPOINT = `${CODEX_AUTH_ISSUER}/oauth/token`;
/** Where the member types the code — what the CLI prints as its link. */
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_AUTH_ISSUER}/codex/device`;
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_ISSUER}/deviceauth/callback`;

const CODEX_LOGIN_TIMEOUT_MS = 10_000;
/** What the CLI falls back to when OpenAI names no interval. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export interface CodexDeviceCode {
  /** Stays server-side: with the member's approval, it collects the login. */
  deviceAuthId: string;
  /** What the member types on OpenAI's page, e.g. `6LP7-E6DH7`. */
  userCode: string;
  /** How often OpenAI wants the `token` endpoint asked. */
  intervalSeconds: number;
}

export type CodexDeviceCodeResult =
  | { kind: 'ok'; device: CodexDeviceCode }
  | { kind: 'failed'; reason: string };

export type CodexDevicePollResult =
  /** Not approved yet — ask again after the interval. */
  | { kind: 'pending' }
  | { kind: 'approved'; authorizationCode: string; codeVerifier: string }
  /** OpenAI refused this device login outright; only a new code can go on. */
  | { kind: 'rejected'; status: number }
  /** Retryable: no answer, or a server-side error. */
  | { kind: 'failed'; reason: string };

export interface CodexLoginTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export type CodexTokenExchangeResult =
  | { kind: 'ok'; tokens: CodexLoginTokens }
  | { kind: 'failed'; reason: string };

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'request failed';
}

/** Step 1: a fresh one-time code for the member to approve. */
export async function requestCodexDeviceCode(fetchImpl?: typeof fetch): Promise<CodexDeviceCodeResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CODEX_DEVICE_USERCODE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CODEX_USAGE_USER_AGENT },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(CODEX_LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    const deviceAuthId = typeof body.device_auth_id === 'string' ? body.device_auth_id : '';
    // The CLI accepts both spellings; so do we.
    const rawCode = body.user_code ?? body.usercode;
    const userCode = typeof rawCode === 'string' ? rawCode.trim() : '';
    if (!deviceAuthId || !userCode) return { kind: 'failed', reason: 'response carried no device code' };
    // OpenAI sends the interval as a string ("5").
    const interval = Number.parseInt(String(body.interval ?? ''), 10);
    return {
      kind: 'ok',
      device: {
        deviceAuthId,
        userCode,
        intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SECONDS,
      },
    };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
}

/**
 * Step 2, asked once: has the member approved yet? The CLI loops on this; the
 * seat flow asks it at most once per interval, from the screen's own poll.
 */
export async function pollCodexDeviceCode(
  device: Pick<CodexDeviceCode, 'deviceAuthId' | 'userCode'>,
  fetchImpl?: typeof fetch,
): Promise<CodexDevicePollResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CODEX_DEVICE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CODEX_USAGE_USER_AGENT },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal: AbortSignal.timeout(CODEX_LOGIN_TIMEOUT_MS),
    });
    // 403 is `deviceauth_authorization_pending`; the CLI keeps waiting on 404 too.
    if (response.status === 403 || response.status === 404) return { kind: 'pending' };
    if (!response.ok) {
      return response.status >= 400 && response.status < 500 && response.status !== 429
        ? { kind: 'rejected', status: response.status }
        : { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    const body = await response.json() as Record<string, unknown>;
    const authorizationCode = typeof body.authorization_code === 'string' ? body.authorization_code : '';
    const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
    if (!authorizationCode || !codeVerifier) return { kind: 'failed', reason: 'approval carried no authorization code' };
    return { kind: 'approved', authorizationCode, codeVerifier };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
}

/**
 * Step 3: the approved device login's code for its tokens. Single-use, like
 * every authorization code — a failure here means a fresh sign-in.
 */
export async function exchangeCodexDeviceAuthorization(
  approval: { authorizationCode: string; codeVerifier: string },
  fetchImpl?: typeof fetch,
): Promise<CodexTokenExchangeResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CODEX_USAGE_USER_AGENT },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: approval.authorizationCode,
        redirect_uri: CODEX_DEVICE_REDIRECT_URI,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: approval.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(CODEX_LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    const idToken = typeof body.id_token === 'string' ? body.id_token : '';
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!idToken || !accessToken || !refreshToken) {
      return { kind: 'failed', reason: 'response carried no token set' };
    }
    return { kind: 'ok', tokens: { idToken, accessToken, refreshToken } };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
}

/** The ChatGPT workspace the login belongs to, read off the id token as the CLI does. */
export function codexAccountIdFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (typeof auth !== 'object' || auth === null) return null;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' && accountId ? accountId : null;
  } catch {
    return null;
  }
}

/**
 * The auth.json the CLI writes after a device login (`persist_tokens_async`):
 * same fields, same order, pretty-printed the way serde does it.
 */
export function buildCodexAuthJson(tokens: CodexLoginTokens, now: Date = new Date()): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: codexAccountIdFromIdToken(tokens.idToken),
    },
    last_refresh: now.toISOString(),
  }, null, 2);
}
