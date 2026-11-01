import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type {
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from '../../types/user.js';

const CODEX_USAGE_REQUEST_ID = 2;

/**
 * The account endpoint the Codex CLI's own app server reads. Calling it with
 * the saved auth.json lets the backend freshen an idle seat without waking an
 * agent machine or waiting for another model turn to finish.
 */
export const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_USAGE_USER_AGENT = 'codex-cli/infinite-agents';
const CODEX_USAGE_TIMEOUT_MS = 10_000;

export type CodexAuthUsageReadResult =
  | { kind: 'ok'; snapshot: ProviderUsageSnapshot }
  /** The access token was rejected. A later Codex turn may still refresh the saved sign-in. */
  | { kind: 'auth_rejected'; status: number }
  | { kind: 'failed' };

/**
 * A short-lived app-server probe. Keeping stdin open briefly gives the server
 * time to flush its JSONL response before the pipe closes; no model turn runs.
 */
export const CODEX_USAGE_COMMAND = [
  '{',
  `printf '%s\\n' '${JSON.stringify({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'infinite-agents-usage', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    },
  })}' '${JSON.stringify({ method: 'initialized' })}' '${JSON.stringify({
    id: CODEX_USAGE_REQUEST_ID,
    method: 'account/rateLimits/read',
    params: null,
  })}';`,
  'sleep 2;',
  '}',
  '| timeout 8s codex app-server --stdio 2>/dev/null',
].join(' ');

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseWindow(id: string, raw: unknown): ProviderUsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const usedPercent = finiteNumber(value.usedPercent);
  if (usedPercent === undefined) return null;
  const resetsAt = finiteNumber(value.resetsAt);
  const windowDurationMins = finiteNumber(value.windowDurationMins);
  return {
    id,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

/** The snake-case window shape returned by /wham/usage. */
function parseAccountWindow(id: string, raw: unknown): ProviderUsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === undefined) return null;
  const resetsAt = finiteNumber(value.reset_at);
  const windowSeconds = finiteNumber(value.limit_window_seconds);
  return {
    id,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowSeconds !== undefined ? { windowDurationMins: windowSeconds / 60 } : {}),
  };
}

/**
 * The Codex account endpoint's response -> the same snapshot stored after a
 * machine-side app-server read. Dynamic primary/secondary ids are retained:
 * their durations, not an assumption here, decide whether the UI calls them
 * five hours, seven days, or something else.
 */
export function parseCodexAccountUsage(
  payload: unknown,
  capturedAt = new Date().toISOString(),
): ProviderUsageSnapshot | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const rawRateLimit = value.rate_limit;
  if (typeof rawRateLimit !== 'object' || rawRateLimit === null) return null;
  const rateLimit = rawRateLimit as Record<string, unknown>;
  const windows: Record<string, ProviderUsageWindow> = {};
  const primary = parseAccountWindow('primary', rateLimit.primary_window);
  const secondary = parseAccountWindow('secondary', rateLimit.secondary_window);
  if (primary) windows.primary = primary;
  if (secondary) windows.secondary = secondary;
  if (Object.keys(windows).length === 0) return null;

  const creditsValue = value.credits;
  const credits = typeof creditsValue === 'object' && creditsValue !== null
    ? creditsValue as Record<string, unknown>
    : null;
  return {
    windows,
    capturedAt,
    ...(typeof value.plan_type === 'string' && value.plan_type
      ? { planType: value.plan_type }
      : {}),
    ...(credits && typeof credits.has_credits === 'boolean' && typeof credits.unlimited === 'boolean'
      ? {
          credits: {
            hasCredits: credits.has_credits,
            unlimited: credits.unlimited,
            ...(typeof credits.balance === 'string' ? { balance: credits.balance } : {}),
          },
        }
      : {}),
  };
}

/**
 * Read current usage directly from the saved Codex sign-in. The full
 * auth.json stays in memory; only its bearer token and account id leave in
 * the provider request, and neither is ever returned or logged.
 */
export async function readCodexUsageForAuthJson(
  authJson: string,
  fetchImpl?: typeof fetch,
): Promise<CodexAuthUsageReadResult> {
  let auth: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(authJson);
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'failed' };
    auth = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'failed' };
  }
  const tokens = typeof auth.tokens === 'object' && auth.tokens !== null
    ? auth.tokens as Record<string, unknown>
    : null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
  const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : '';
  if (!accessToken || !accountId) return { kind: 'failed' };

  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(CODEX_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        'User-Agent': CODEX_USAGE_USER_AGENT,
      },
      signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? { kind: 'auth_rejected', status: response.status }
        : { kind: 'failed' };
    }
    const snapshot = parseCodexAccountUsage(await response.json());
    return snapshot ? { kind: 'ok', snapshot } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export function parseCodexUsageOutput(
  stdout: string,
  capturedAt = new Date().toISOString(),
): ProviderUsageSnapshot | null {
  for (const line of stdout.split(/\r?\n/)) {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      message = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.id !== CODEX_USAGE_REQUEST_ID) continue;
    const result = message.result;
    if (typeof result !== 'object' || result === null) return null;
    const resultValue = result as Record<string, unknown>;
    let rateLimits = resultValue.rateLimits;
    if ((typeof rateLimits !== 'object' || rateLimits === null) && resultValue.rateLimitsByLimitId) {
      const byId = resultValue.rateLimitsByLimitId;
      if (typeof byId === 'object' && byId !== null) {
        rateLimits = Object.values(byId as Record<string, unknown>)[0];
      }
    }
    if (typeof rateLimits !== 'object' || rateLimits === null) return null;
    const value = rateLimits as Record<string, unknown>;
    const windows: Record<string, ProviderUsageWindow> = {};
    for (const id of ['primary', 'secondary'] as const) {
      const parsed = parseWindow(id, value[id]);
      if (parsed) windows[id] = parsed;
    }
    if (Object.keys(windows).length === 0) return null;

    const creditsValue = value.credits;
    const credits = typeof creditsValue === 'object' && creditsValue !== null
      ? creditsValue as Record<string, unknown>
      : null;
    return {
      windows,
      capturedAt,
      ...(typeof value.planType === 'string' && value.planType
        ? { planType: value.planType }
        : {}),
      ...(credits && typeof credits.hasCredits === 'boolean' && typeof credits.unlimited === 'boolean'
        ? {
            credits: {
              hasCredits: credits.hasCredits,
              unlimited: credits.unlimited,
              ...(typeof credits.balance === 'string' ? { balance: credits.balance } : {}),
            },
          }
        : {}),
    };
  }
  return null;
}

export async function readCodexProviderUsage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  sshUser: string;
}): Promise<ProviderUsageSnapshot | null> {
  const result = await args.sandboxClient.execSync(
    args.sandboxId,
    CODEX_USAGE_COMMAND,
    undefined,
    { timeoutMs: 30_000, sshUser: args.sshUser },
  );
  return parseCodexUsageOutput(result.stdout);
}
