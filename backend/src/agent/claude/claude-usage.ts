/**
 * Live Claude account usage — the counterpart of codex-usage.ts.
 *
 * Claude Code's stream-json `rate_limit_event` carries no utilization
 * percentage (anthropic/claude-code#50518), so the passive stream capture in
 * claude-exec-events.ts almost never yields a window. Two live sources
 * instead, tried in order:
 *
 * 1. The OAuth usage endpoint the interactive /usage screen calls — exact
 *    per-window utilization, but it requires the `user:profile` scope that
 *    setup-tokens (our onboarding credential) do NOT carry (verified live:
 *    HTTP 403 "does not meet scope requirement").
 * 2. A 1-token inference probe whose `anthropic-ratelimit-unified-*`
 *    response headers carry the unified 5h/7d utilization — works with the
 *    inference-only scope, costing ~one haiku token on the user's own plan.
 *
 * Both are UNDOCUMENTED: not part of the published Anthropic API, but
 * long-stable and what the CLI itself relies on. The
 * `User-Agent: claude-code/<version>` header is required — without it the
 * usage endpoint rate-limits aggressively.
 */

import { createHash } from 'node:crypto';
import type { SecretStorage } from '../../services/secret-storage.js';
import type {
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from '../../types/user.js';
import { getStoredClaudeOauthToken } from './claude-login.js';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/**
 * WHICH subscription the account holds. A separate endpoint on purpose: the
 * usage payload carries percentages and nothing that names the plan (verified
 * live 2026-08-30 — no tier, type or price anywhere in it), so a screen
 * showing two Max sign-ins could not say which was the $100 one and which the
 * $200 one (note #142).
 */
export const CLAUDE_PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1.214';
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

/**
 * How long a plan reading is reused before the profile endpoint is asked
 * again. A plan changes when a human upgrades, not minute to minute, so the
 * 5-minute usage pass must not carry a second request every time — but a
 * reading nobody ever refreshes is its own bug (note #138), so it does expire.
 */
export const CLAUDE_PLAN_REREAD_MS = 6 * 60 * 60 * 1000;

/** Window durations the endpoint implies by key (it sends none explicitly). */
const WINDOW_DURATION_MINS: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
};

export type ClaudeUsageReadResult =
  | { kind: 'ok'; snapshot: ProviderUsageSnapshot }
  /** No stored OAuth token (interactive sign-in) — a fetch was never possible. */
  | { kind: 'no_token' }
  | { kind: 'failed' };

export type ClaudeTokenUsageReadResult =
  | { kind: 'ok'; snapshot: ProviderUsageSnapshot }
  /**
   * The Messages probe itself rejected the token (401/403 with no usage
   * headers) — the token is bad, not the network. The OAuth endpoint's 403 is
   * NOT this: setup-tokens always lack its `user:profile` scope.
   */
  | { kind: 'auth_rejected'; status: number }
  | { kind: 'failed' };

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseWindow(id: string, raw: unknown): ProviderUsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const utilization = finiteNumber(value.utilization);
  if (utilization === undefined || utilization < 0) return null;
  // The endpoint reports 0..100 and an ISO `resets_at`; the stored window
  // shape (shared with codex) wants epoch seconds.
  const resetsAtMs = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
  const windowDurationMins = WINDOW_DURATION_MINS[id];
  return {
    id,
    usedPercent: Math.min(100, utilization),
    ...(Number.isFinite(resetsAtMs) ? { resetsAt: Math.round(resetsAtMs / 1000) } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

/**
 * The endpoint's response → the stored snapshot. Window keys are taken as
 * they come (`five_hour`, `seven_day`, `seven_day_opus`, ...); `extra_usage`
 * is a differently-shaped object that only matters when enabled, mapped onto
 * the `overage` window id the usage screen already labels "Extra usage".
 */
export function parseClaudeOauthUsage(
  payload: unknown,
  capturedAt = new Date().toISOString(),
): ProviderUsageSnapshot | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const windows: Record<string, ProviderUsageWindow> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'extra_usage') {
      const extra = typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : null;
      if (extra?.is_enabled === true) {
        const parsed = parseWindow('overage', extra);
        if (parsed) windows.overage = parsed;
      }
      continue;
    }
    // Known keys only. The live payload carries unreleased experiment buckets
    // under codenames (`nimbus_quill`, `iguana_necktie`, … — seen 2026-08-23),
    // shaped exactly like real windows; without this gate each would render
    // as a meter labelled with its codename.
    if (WINDOW_DURATION_MINS[key] === undefined) continue;
    const parsed = parseWindow(key, value);
    if (parsed) windows[key] = parsed;
  }
  if (Object.keys(windows).length === 0) return null;
  return { windows, capturedAt };
}

/**
 * The `extra_usage` object → the spend block, when the account has usage
 * credits enabled and the amounts are actually present (they are null on
 * accounts that never enabled it).
 */
function parseExtraUsageSpend(raw: unknown): ProviderUsageSnapshot['spend'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const extra = raw as Record<string, unknown>;
  if (extra.is_enabled !== true) return undefined;
  const usedMinor = finiteNumber(extra.used_credits);
  const limitMinor = finiteNumber(extra.monthly_limit);
  if (usedMinor === undefined || limitMinor === undefined || limitMinor <= 0) return undefined;
  return {
    usedMinor: Math.round(usedMinor),
    limitMinor: Math.round(limitMinor),
    currency: typeof extra.currency === 'string' && extra.currency ? extra.currency : 'USD',
    exponent: finiteNumber(extra.decimal_places) ?? 2,
  };
}

/**
 * The account's windows as the OAuth usage endpoint reports them: the unified
 * ones, plus the PER-MODEL windows kept deliberately apart.
 *
 * They must not share one map. Selection scores a credential on the max of
 * its unified windows; a 100%-full Fable window landing in there would read
 * as "this account is full" for sonnet and opus turns too, and bench a
 * credential with plenty of room.
 */
export interface ClaudeAccountUsage {
  snapshot: ProviderUsageSnapshot;
  /** Model alias (lowercased `display_name`, e.g. `fable`) → its own window. */
  modelWindows: Record<string, ProviderUsageWindow>;
}

/**
 * Parse the `limits[]` array the usage endpoint returns — the ONLY place the
 * per-model windows appear. The legacy top-level `seven_day_opus` /
 * `seven_day_sonnet` keys read `null` on live accounts (verified on the $200
 * Max, 2026-08-14) while `limits[]` carried the real Fable row, so a parser
 * that only knows the top-level keys sees no per-model data at all.
 *
 * Shape per entry: `{kind, percent, resets_at, scope: {model: {display_name}}}`
 * with kind one of `session` (the 5-hour window), `weekly_all`, or
 * `weekly_scoped` (per-model). Percent is 0..100.
 */
export function parseClaudeOauthLimits(
  payload: unknown,
  capturedAt = new Date().toISOString(),
): ClaudeAccountUsage | null {
  const limits = (payload as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return null;
  const windows: Record<string, ProviderUsageWindow> = {};
  const modelWindows: Record<string, ProviderUsageWindow> = {};
  // Usage credits ("extra usage") ride beside limits[]: the percent becomes
  // the `overage` window and the amounts the spend block — the full picture
  // the account's own /usage screen shows.
  const extraRaw = (payload as { extra_usage?: unknown }).extra_usage;
  const spend = parseExtraUsageSpend(extraRaw);
  if ((extraRaw as { is_enabled?: unknown } | null | undefined)?.is_enabled === true) {
    const overage = parseWindow('overage', extraRaw);
    if (overage) windows.overage = overage;
  }
  for (const raw of limits) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const percent = finiteNumber(entry.percent);
    if (percent === undefined || percent < 0) continue;
    const resetsAtMs = typeof entry.resets_at === 'string' ? Date.parse(entry.resets_at) : NaN;
    const reset = Number.isFinite(resetsAtMs) ? { resetsAt: Math.round(resetsAtMs / 1000) } : {};
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    if (kind === 'session') {
      windows.five_hour = {
        id: 'five_hour',
        usedPercent: Math.min(100, percent),
        ...reset,
        windowDurationMins: WINDOW_DURATION_MINS.five_hour,
      };
    } else if (kind === 'weekly_all') {
      windows.seven_day = {
        id: 'seven_day',
        usedPercent: Math.min(100, percent),
        ...reset,
        windowDurationMins: WINDOW_DURATION_MINS.seven_day,
      };
    } else if (kind === 'weekly_scoped') {
      const scope = entry.scope as { model?: { display_name?: unknown } } | undefined;
      const displayName = scope?.model?.display_name;
      if (typeof displayName !== 'string' || !displayName.trim()) continue;
      // Lowercased display name == the catalog alias we route and meter on
      // ("Fable" → `fable`), so one key works for the pool and the billing lane.
      const alias = displayName.trim().toLowerCase();
      modelWindows[alias] = {
        id: `seven_day_${alias}`,
        usedPercent: Math.min(100, percent),
        ...reset,
        windowDurationMins: WINDOW_DURATION_MINS.seven_day,
      };
    }
  }
  if (Object.keys(windows).length === 0 && Object.keys(modelWindows).length === 0) return null;
  return { snapshot: { windows, capturedAt, ...(spend ? { spend } : {}) }, modelWindows };
}

/**
 * The host that actually answers a refresh. `platform.claude.com` and
 * `console.anthropic.com` both reply 429 `rate_limit_error` in ~60ms to every
 * refresh, from any IP — a blanket edge rule, not our request rate. On
 * 2026-08-16 that froze both pool accounts' Fable window for 17 hours: the
 * grants were alive (they refreshed first try against this host), but the
 * 429 is neither 400 nor 401, so it read as a retryable `failed` forever.
 */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token';
/** The public Claude Code OAuth client — the same one the CLI's own login uses. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * The seat mint (org-layer seats, "option B"): we drive the OAuth authorize +
 * exchange ourselves instead of shelling `claude setup-token` on a member's
 * machine. The point is the SCOPES — setup-tokens are `user:inference` alone
 * (the CLI's own authorize URL says so), which is why a seat could never read
 * the usage endpoint; minting with `user:profile` gives ONE credential that
 * both runs turns and reads the full usage picture (per-model windows, usage
 * credits). Verified live 2026-08-23: exchange 200, usage endpoint 200,
 * inference 200 on the same token, `claude -p` accepts it via
 * CLAUDE_CODE_OAUTH_TOKEN unchanged.
 *
 * Every parameter here is mirrored from claude-code 2.1.223's interactive
 * login, learned the expensive way (two failed consent taps):
 *  - the redirect must be `platform.claude.com` — the old
 *    `console.anthropic.com` callback answers "Invalid request format";
 *  - `state` must be 32 bytes (43 chars base64url) — a 16-byte state fails
 *    the same way;
 *  - `org:create_api_key` is deliberately absent: the server silently does
 *    not grant it even when asked (verified twice), and we never mint keys.
 */
export const CLAUDE_OAUTH_AUTHORIZE_ENDPOINT = 'https://claude.com/cai/oauth/authorize';
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_SEAT_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

export interface ClaudeAuthorizeRequest {
  url: string;
  /** PKCE verifier — held server-side, never shown to the member. */
  verifier: string;
  /** Anti-CSRF state; the pasted code comes back as `<code>#<state>`. */
  state: string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh authorize URL + the PKCE material its exchange will need. */
export function buildClaudeAuthorizeRequest(
  randomBytesImpl: (size: number) => Uint8Array = (size) => crypto.getRandomValues(new Uint8Array(size)),
): ClaudeAuthorizeRequest {
  const verifier = base64Url(randomBytesImpl(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytesImpl(32));
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_SEAT_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state };
}

export interface ClaudeSeatGrant {
  /** The access token — runs turns AND reads usage. Lives ~8h. */
  accessToken: string;
  /** Rotates on every refresh; persist what comes back or the grant strands. */
  refreshToken: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopes?: string[];
}

export type ClaudeCodeExchangeResult =
  | { kind: 'ok'; grant: ClaudeSeatGrant }
  /** The consent page's code was wrong/expired/reused — the member retries. */
  | { kind: 'rejected'; status: number }
  | { kind: 'failed'; reason: string };

/**
 * Swap the code the member pasted (`<code>#<state>`, the consent page's own
 * format) for the grant. The state rides in the paste, so a paste from a
 * DIFFERENT authorize page (stale tab, forwarded link) fails loudly here
 * instead of minting a grant against the wrong PKCE pair.
 */
export async function exchangeClaudeAuthorizationCode(
  pastedCode: string,
  pkce: { verifier: string; state: string },
  fetchImpl?: typeof fetch,
): Promise<ClaudeCodeExchangeResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const [code, pastedState] = pastedCode.trim().split('#');
  if (!code) return { kind: 'rejected', status: 400 };
  if (pastedState !== undefined && pastedState !== pkce.state) {
    return { kind: 'failed', reason: 'state mismatch — the code came from a different sign-in page' };
  }
  try {
    const response = await doFetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': CLAUDE_USAGE_USER_AGENT },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code_verifier: pkce.verifier,
        state: pastedState ?? pkce.state,
      }),
      signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return response.status >= 400 && response.status < 500
        ? { kind: 'rejected', status: response.status }
        : { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    const body = await response.json() as Record<string, unknown>;
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!accessToken || !refreshToken) {
      return { kind: 'failed', reason: 'response carried no token pair' };
    }
    const expiresIn = finiteNumber(body.expires_in);
    return {
      kind: 'ok',
      grant: {
        accessToken,
        refreshToken,
        ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
        ...(typeof body.scope === 'string' && body.scope ? { scopes: body.scope.split(' ') } : {}),
      },
    };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? `${error.name}: ${error.message}` : 'request failed' };
  }
}

export type ClaudeOAuthRefreshResult =
  | { kind: 'ok'; accessToken: string; refreshToken?: string; expiresAt?: number }
  /** The refresh token itself is no longer good — needs a human to sign in again. */
  | { kind: 'rejected'; status: number }
  /**
   * Retryable. `reason` is what took 17 hours to learn once: a bare "failed"
   * hides whether the endpoint said 429, returned nothing, or never answered.
   */
  | { kind: 'failed'; reason: string };

/**
 * Exchange a refresh token for a fresh access token. Access tokens last ~8
 * hours, so an unattended pool has to do this or the usage read goes dark
 * overnight and silently falls back to the coarser header probe.
 *
 * A rotated refresh token comes back in the response and MUST be persisted —
 * dropping it strands the credential at the next refresh.
 */
export async function refreshClaudeOAuthToken(
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<ClaudeOAuthRefreshResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': CLAUDE_USAGE_USER_AGENT },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 400/401 mean the grant is dead; anything else is worth retrying later.
      return response.status === 400 || response.status === 401
        ? { kind: 'rejected', status: response.status }
        : { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    const body = await response.json() as Record<string, unknown>;
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    if (!accessToken) return { kind: 'failed', reason: 'response carried no access_token' };
    const expiresIn = finiteNumber(body.expires_in);
    return {
      kind: 'ok',
      accessToken,
      ...(typeof body.refresh_token === 'string' && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
      ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    };
  } catch (error) {
    // The request never completed (timeout, DNS, TLS, unparseable body). The
    // token is never part of an error message here — only the endpoint is.
    return { kind: 'failed', reason: error instanceof Error ? `${error.name}: ${error.message}` : 'request failed' };
  }
}

/**
 * The plan a profile payload describes, as the key the usage screens format:
 * `max_20x`, `max_5x`, `pro`.
 *
 * `rate_limit_tier` is the ONLY field that separates the two Max sizes —
 * `organization_type` reads `claude_max` for both. Verified live 2026-08-30:
 * the $200 pool account answers `default_claude_max_20x` and the $100 one
 * `default_claude_max_5x`. The prefixes are stripped rather than matched
 * against a list of today's tiers, so an unreleased size still arrives with
 * its own words instead of being dropped or mislabelled.
 */
export function parseClaudeProfilePlan(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = (payload as { organization?: unknown }).organization;
  const organization = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
  const normalize = (value: unknown): string => (typeof value === 'string' ? value : '')
    .trim().toLowerCase().replace(/^default_/, '').replace(/^claude_/, '');
  const tier = normalize(organization?.rate_limit_tier);
  // A bare `default` tier names no plan (API-shaped organizations report one);
  // the organization type still says Max or Pro, which is worth more than a
  // meter labelled "Default".
  const plan = tier && tier !== 'default' ? tier : normalize(organization?.organization_type);
  return plan || undefined;
}

/** Provider billing states where access is paused until money is collected. */
export const CLAUDE_PAYMENT_REQUIRED_STATUSES = new Set([
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
]);

/** The raw subscription state carried by the same profile payload as the plan. */
export function parseClaudeProfileSubscriptionStatus(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = (payload as { organization?: unknown }).organization;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>).subscription_status;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

export interface ClaudeProfileFacts {
  planType?: string;
  subscriptionStatus?: string;
}

/**
 * Read the small, non-secret account facts Anthropic exposes for this grant.
 * A 403 from the usage endpoint is ambiguous on its own; a successful profile
 * read saying `past_due` is what lets callers name billing instead of blaming
 * OAuth. Never throws — absence is deliberately not treated as evidence.
 */
export async function readClaudeProfileWithProfileToken(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<ClaudeProfileFacts | undefined> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CLAUDE_PROFILE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': CLAUDE_USAGE_USER_AGENT,
      },
      signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    const planType = parseClaudeProfilePlan(payload);
    const subscriptionStatus = parseClaudeProfileSubscriptionStatus(payload);
    return {
      ...(planType ? { planType } : {}),
      ...(subscriptionStatus ? { subscriptionStatus } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read the account's plan with a `user:profile`-scoped access token. Never
 * throws and never distinguishes its failures: the plan is a label on a screen
 * — losing it must not cost the caller the usage reading it came for.
 */
export async function readClaudePlanWithProfileToken(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  return (await readClaudeProfileWithProfileToken(accessToken, fetchImpl))?.planType;
}

/** The plan fields a snapshot carries — read now, or the last answer reused. */
export type ClaudePlanFields = Pick<ProviderUsageSnapshot, 'planType' | 'planReadAt'>;

/**
 * The plan for the snapshot about to be stored: the one already known while it
 * is young enough, otherwise a fresh look. A look that fails keeps the
 * previous answer — a plan we knew a minute ago does not become unknown
 * because one request timed out.
 */
async function resolveClaudePlan(
  accessToken: string,
  doFetch: typeof fetch,
  known: ClaudePlanFields | undefined,
  nowMs: number,
): Promise<ClaudePlanFields> {
  const carry = (): ClaudePlanFields => (known?.planType
    ? { planType: known.planType, ...(known.planReadAt ? { planReadAt: known.planReadAt } : {}) }
    : {});
  const readAtMs = known?.planReadAt ? Date.parse(known.planReadAt) : NaN;
  if (known?.planType && Number.isFinite(readAtMs) && nowMs - readAtMs < CLAUDE_PLAN_REREAD_MS) {
    return carry();
  }
  const planType = await readClaudePlanWithProfileToken(accessToken, doFetch);
  return planType ? { planType, planReadAt: new Date(nowMs).toISOString() } : carry();
}

export type ClaudeProfileUsageResult =
  | { kind: 'ok'; usage: ClaudeAccountUsage }
  /** The grant is alive; Anthropic's profile says billing paused the subscription. */
  | {
    kind: 'payment_required';
    subscriptionStatus: string;
    plan: ClaudePlanFields;
  }
  /** OAuth profile is readable, but the usage surface is forbidden. */
  | { kind: 'profile_access_forbidden'; profile: ClaudeProfileFacts }
  /** The access token was refused — caller should refresh and retry once. */
  | { kind: 'auth_rejected'; status: number }
  | { kind: 'failed' };

/**
 * Read the account's real windows with a `user:profile`-scoped access token.
 * This is the only source of the per-model (Fable) window: setup-tokens carry
 * `user:inference` alone and get a 403 here, which is why the pool otherwise
 * has to ESTIMATE that window from metered spend.
 */
export async function readClaudeUsageWithProfileToken(
  accessToken: string,
  fetchImpl?: typeof fetch,
  /** The plan this credential last reported, so a young one is not re-read. */
  knownPlan?: ClaudePlanFields,
  nowMs = Date.now(),
): Promise<ClaudeProfileUsageResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': CLAUDE_USAGE_USER_AGENT,
      },
      signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
    });
    if (response.status === 403) {
      // A billing pause and a bad grant both surface as 403 here. The profile
      // endpoint stays readable for a past-due Max subscription, so ask it
      // before turning a recoverable invoice into a destructive sign-in fix.
      const profile = await readClaudeProfileWithProfileToken(accessToken, doFetch);
      const subscriptionStatus = profile?.subscriptionStatus;
      if (subscriptionStatus && CLAUDE_PAYMENT_REQUIRED_STATUSES.has(subscriptionStatus)) {
        return {
          kind: 'payment_required',
          subscriptionStatus,
          plan: profile?.planType
            ? { planType: profile.planType, planReadAt: new Date(nowMs).toISOString() }
            : {},
        };
      }
      // A readable profile proves OAuth itself is alive. Callers that know
      // the runtime token can now verify inference without turning this
      // ambiguous usage-endpoint policy into “sign in again.”
      return profile
        ? { kind: 'profile_access_forbidden', profile }
        : { kind: 'failed' };
    }
    if (response.status === 401) {
      return { kind: 'auth_rejected', status: response.status };
    }
    if (!response.ok) return { kind: 'failed' };
    const payload = await response.json();
    // `limits[]` first — it is the only shape carrying per-model windows. The
    // top-level keys are the fallback for accounts that still report that way.
    const legacy = (): ClaudeAccountUsage | null => {
      const snapshot = parseClaudeOauthUsage(payload);
      return snapshot ? { snapshot, modelWindows: {} } : null;
    };
    const parsed = parseClaudeOauthLimits(payload) ?? legacy();
    if (!parsed) return { kind: 'failed' };
    // Only once the windows are in hand: the plan is a label beside them, and
    // a payload we could not parse is not worth a second request.
    const plan = await resolveClaudePlan(accessToken, doFetch, knownPlan, nowMs);
    return { kind: 'ok', usage: { ...parsed, snapshot: { ...parsed.snapshot, ...plan } } };
  } catch {
    return { kind: 'failed' };
  }
}

export const CLAUDE_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
/** Cheapest model for the header probe — the answer is discarded unread. */
const CLAUDE_USAGE_PROBE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Account windows from the `anthropic-ratelimit-unified-*` response headers
 * of a Messages API call. Utilization there is 0..1 (`0.35` = 35%), resets
 * are epoch seconds. Only the unified 5h/7d buckets exist in headers — no
 * per-model split like the OAuth endpoint's.
 */
export function parseClaudeRateLimitHeaders(
  headers: Headers,
  capturedAt = new Date().toISOString(),
): ProviderUsageSnapshot | null {
  const windows: Record<string, ProviderUsageWindow> = {};
  // `overage` is usage credits ("Extra usage"): percent of the monthly spend
  // limit. It rides the same headers as the plan windows (verified live
  // 2026-08-23), so even an inference-only setup-token gets this meter.
  for (const [bucket, id] of [['5h', 'five_hour'], ['7d', 'seven_day'], ['overage', 'overage']] as const) {
    const utilization = Number.parseFloat(
      headers.get(`anthropic-ratelimit-unified-${bucket}-utilization`) ?? '',
    );
    if (!Number.isFinite(utilization) || utilization < 0) continue;
    const resetsAt = Number.parseInt(
      headers.get(`anthropic-ratelimit-unified-${bucket}-reset`) ?? '',
      10,
    );
    // ALWAYS a fraction, above 1 included — the CLI reads it as
    // `Math.round(utilization * 100)` with no other branch. Treating a value
    // over 1 as "already a percent" turned an overshot window (`1.01`, a
    // turn that ran on past the line) into "1% used" on a full account, and
    // the next clean read flipped it back to 100% (note #692). Clamped to
    // 100 and rounded to two decimals so float artifacts don't leak into
    // storage.
    const usedPercent = Math.min(100, Math.round(utilization * 10_000) / 100);
    windows[id] = {
      id,
      usedPercent,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      ...(WINDOW_DURATION_MINS[id] !== undefined ? { windowDurationMins: WINDOW_DURATION_MINS[id] } : {}),
    };
  }
  return Object.keys(windows).length > 0 ? { windows, capturedAt } : null;
}

/**
 * Scope-proof fallback: a 1-token inference call whose ANSWER is thrown away
 * — the rate-limit headers on the response are the payload. This is the only
 * usage source a setup-token can reach (inference scope only; the OAuth
 * usage endpoint demands `user:profile`, which setup-tokens lack — verified
 * live 2026-07-19, HTTP 403). Costs roughly one haiku token on the user's
 * plan per refresh, in line with everything else the product runs there.
 * The `oauth-2025-04-20` beta header is how the CLI itself authenticates
 * OAuth tokens against the Messages API — undocumented, like the endpoint
 * above.
 */
async function probeClaudeUsageViaInference(
  token: string,
  doFetch: typeof fetch,
): Promise<{ snapshot: ProviderUsageSnapshot | null; status: number }> {
  const response = await doFetch(CLAUDE_MESSAGES_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
    },
    body: JSON.stringify({
      model: CLAUDE_USAGE_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
  });
  // Headers ride even some non-2xx responses (e.g. 429), and utilization is
  // exactly what a rate-limited account wants to see — parse regardless.
  return { snapshot: parseClaudeRateLimitHeaders(response.headers), status: response.status };
}

/**
 * Usage for a raw token — the platform credential pool's refresh path (no
 * secret storage in the loop). Same source order as the per-user reader:
 * rich OAuth endpoint first, header probe as the scope-proof fallback. Never
 * throws.
 */
export async function readClaudeUsageForToken(
  token: string,
  fetchImpl?: typeof fetch,
  opts?: {
    /**
     * Skip the OAuth usage endpoint and go straight to the header probe.
     * For a token KNOWN to be inference-only (every setup-token), the
     * endpoint attempt is doomed by scope — trying anyway costs one refused
     * request per credential per refresh pass, which at the 5-minute cadence
     * is hundreds of junk calls a day feeding the endpoint's edge 429s.
     */
    skipUsageEndpoint?: boolean;
    /** Recovery checks require an actual successful inference response, not quota headers on a 429. */
    requireSuccessfulResponse?: boolean;
  },
): Promise<ClaudeTokenUsageReadResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (!opts?.skipUsageEndpoint) {
    try {
      const response = await doFetch(CLAUDE_USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': CLAUDE_USAGE_USER_AGENT,
        },
        signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
      });
      if (response.ok) {
        const snapshot = parseClaudeOauthUsage(await response.json());
        if (snapshot) return { kind: 'ok', snapshot };
      }
    } catch {
      // Fall through to the header probe.
    }
  }
  try {
    const { snapshot, status } = await probeClaudeUsageViaInference(token, doFetch);
    // A rejected response may still carry old/quota headers. They describe an
    // account, but they do not prove this token can run a turn.
    if (status === 401 || status === 403) return { kind: 'auth_rejected', status };
    if (opts?.requireSuccessfulResponse && (status < 200 || status >= 300)) return { kind: 'failed' };
    if (snapshot) return { kind: 'ok', snapshot };
    if (opts?.requireSuccessfulResponse && status >= 200 && status < 300) {
      return { kind: 'ok', snapshot: { windows: {}, capturedAt: new Date().toISOString() } };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Fetch the account's usage with the stored setup-token. The OAuth usage
 * endpoint is tried first (richer: per-model windows) for tokens that carry
 * `user:profile`; setup-tokens fall back to the inference-header probe.
 * Never throws: `no_token` when there is nothing to authenticate with
 * (interactive sign-ins), `failed` for any network/HTTP/shape problem.
 */
export async function readClaudeProviderUsage(args: {
  secretStorage: SecretStorage;
  userId: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeUsageReadResult> {
  let token: string | null;
  try {
    token = await getStoredClaudeOauthToken(args.secretStorage, args.userId);
  } catch {
    return { kind: 'failed' };
  }
  if (!token) return { kind: 'no_token' };
  // A per-user auth rejection is not actionable here (the caller renders a
  // usage screen, it doesn't manage the credential), so it folds into failed.
  const read = await readClaudeUsageForToken(token, args.fetchImpl);
  return read.kind === 'ok' ? read : { kind: 'failed' };
}
