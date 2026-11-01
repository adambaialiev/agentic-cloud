/**
 * Classify harness turn failures that mean "the CLI's sign-in is dead" —
 * revoked/expired OAuth tokens, wiped credentials — as opposed to ordinary
 * work failures.
 *
 * DELIBERATELY TIGHT: these run against error output from turns whose job is
 * writing code, and that output can legitimately contain auth-flavored words
 * (a user's failing test printing `401 Unauthorized`, an agent building a
 * login page). A false positive here pauses all of the user's agents on that
 * CLI, so every pattern below is phrased the way the CLIs themselves report
 * their OWN auth problems, not how arbitrary programs report theirs.
 */

/** Claude Code CLI auth failures (`claude` reports these verbatim). */
const CLAUDE_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /please run \/login/i,
  /invalid api key/i,
  // The API's own phrasings ride through the CLI verbatim too: "OAuth access
  // token has been revoked" is what a turn sees when the shared grant rotates
  // out from under it (note #104) — the old adjacency-only pattern missed it.
  /oauth (?:access )?token (?:is |was |has |has been )?(?:expired|invalid|revoked)/i,
  /oauth (?:token )?revoked/i,
  /credentials? (?:are |is )?(?:expired|invalid|revoked)/i,
  /not logged in to claude/i,
];

/** Codex CLI auth failures (`codex` reports these verbatim). */
const CODEX_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /run `?codex login`?/i,
  /not logged in/i,
  /(?:auth|access|refresh) token (?:is )?(?:expired|invalid|revoked|missing)/i,
  /token refresh failed/i,
  /reauthenticat/i,
  /401 unauthorized.*(?:openai|chatgpt)/i,
];

/**
 * Claude Code subscription-limit exhaustion (the CLI reports these verbatim
 * when the plan's 5h/7d window is used up). Same tightness rule as the auth
 * patterns above — these run against arbitrary turn output. Used to cool down
 * platform pool credentials; a false positive costs one credential ~30 idle
 * minutes, a false negative just means the next lease fails the same way.
 */
const CLAUDE_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /\b(?:5-hour|five-hour|weekly|7-day|seven-day) limit reached/i,
  // Claude Code's own limit lines (2.1.300 keeps their openings in one list
  // and words each from the window that tripped): "You've hit your session
  // limit · resets 5pm (UTC)", "You've reached your Fable limit.", "You've
  // hit your team's shared budget.", "You're out of usage credits." Until
  // note #772 only the older "reached your usage/session limit" matched, so
  // none of these benched the seat that said them. Since 2.1.312 the 5-hour
  // window's line reads "You've hit your 5-hour limit · resets …" (read in
  // the 2.1.316 binary, note #929); this pattern covers both names.
  /you['’]ve hit your [^.\n·]{0,40}(?:limit|budget)\b/i,
  /you['’]ve reached your [^.\n·]{0,40}limit\b/i,
  /you['’]re out of (?:usage credits|extra usage)/i,
  /your org(?:anization)? is out of usage/i,
  /your seat type doesn['’]t include (?:usage credits|extra usage|usage)/i,
  /\b(?:fable|haiku|mythos|opus|sonnet)(?: [^·\n]{1,40})? requires usage credits\./i,
  /claude api error: 429/i,
];

export function isClaudeUsageLimitText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return CLAUDE_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Whether a Claude usage-limit line is about ONE model rather than the whole
 * subscription. The CLI says so itself: every limit it raises for a model
 * the account cannot run right now — that model's own weekly window, or a
 * model this plan only runs on usage credits — ends "Switch to another model
 * to continue" (or "/model to switch models"). The rest of the account still
 * serves, so the pool benches the model, not the seat (note #772).
 */
export function isClaudeModelLimitText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!isClaudeUsageLimitText(trimmed)) return false;
  return /switch to another model|\/model to switch models|requires usage credits/i.test(trimmed);
}

/**
 * The reset moment embedded in a Claude usage-limit error, as epoch seconds.
 * Anthropic's 429 body is literally `Claude AI usage limit reached|<epoch>`
 * and the CLI forwards it verbatim into the result event, so the pipe-glued
 * epoch names exactly when the TRIPPED window frees up — including the
 * per-model (Fable) weekly window, which resets days out, not minutes.
 * Only the 10-digit seconds form is accepted (2001–2286); anything else in
 * the text is someone's data, not Anthropic's timestamp.
 */
export function claudeUsageLimitResetAtSeconds(text: string | null | undefined): number | undefined {
  const match = (text ?? '').match(/limit reached\|(\d{10})(?!\d)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Clock-skew margin so a credential never revives seconds before its window actually resets. */
const USAGE_COOLDOWN_SLACK_SECONDS = 60;
/** Longest believable reset horizon: a weekly window plus a day — a garbage timestamp costs at most one cycle. */
const USAGE_COOLDOWN_CAP_SECONDS = 8 * 24 * 3600;

/**
 * Cooldown length for a credential whose usage window resets at
 * `resetAtSeconds`. Undefined when there is no reset or it isn't in the
 * future — the caller falls back to its default cooldown rather than benching
 * a credential on a stale hint.
 */
export function usageLimitCooldownSeconds(
  resetAtSeconds: number | undefined,
  nowMs: number,
): number | undefined {
  if (resetAtSeconds === undefined) return undefined;
  const delta = Math.ceil(resetAtSeconds - nowMs / 1000);
  if (delta <= 0) return undefined;
  return Math.min(delta + USAGE_COOLDOWN_SLACK_SECONDS, USAGE_COOLDOWN_CAP_SECONDS);
}

/**
 * Codex/ChatGPT subscription-limit exhaustion (the CLI reports these
 * verbatim). Same tightness rule and same 30-minute-bench blast radius as the
 * Claude patterns above.
 */
const CODEX_USAGE_LIMIT_PATTERNS: RegExp[] = [
  // Codex types a CURLY apostrophe ("You’ve hit your usage limit. Upgrade to
  // Plus…", seen in production): the straight-only pattern missed it, so an
  // exhausted ChatGPT seat was never benched (note #772).
  /you['’]?ve hit your usage limit/i,
  /usage limit (?:reached|hit)/i,
  /wait for your limits? to reset/i,
];

export function isCodexUsageLimitText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return CODEX_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isClaudeAuthFailureText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return CLAUDE_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Anthropic's inference refusal for an organization-level subscription pause. */
export function isClaudeBillingFailureText(text: string | null | undefined): boolean {
  return /OAuth authentication is currently not allowed for this workplace/i.test((text ?? '').trim());
}

export function isCodexAuthFailureText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return CODEX_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * OpenCode on an OpenCode Go/Zen key (note #780). The harness reads most of
 * this from the stream's structure — a 401 on an `error` line, a 429 whose
 * body names the limit, the platform plugin's `platform_limit` line — and
 * these patterns are the same facts in words, for text that arrives without
 * that structure. Phrased as OpenCode and its provider phrase them
 * (opencode 1.19.3, 2026-10-20): the server's "Invalid credential", and the
 * limit sentences OpenCode builds from `GoUsageLimitError` /
 * `FreeUsageLimitError`.
 */
const OPENCODE_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /^invalid credential\.?$/im,
];

const OPENCODE_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached\. it will reset in/i,
  /free usage exceeded, subscribe to go/i,
  /\b(?:GoUsageLimitError|FreeUsageLimitError)\b/,
];

export function isOpenCodeAuthFailureText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return OPENCODE_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isOpenCodeUsageLimitText(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return OPENCODE_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}
