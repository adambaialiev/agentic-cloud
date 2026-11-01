/**
 * Types and parsing for `claude -p --output-format stream-json --verbose`
 * output (Claude Code v2.1.x).
 *
 * Observed event stream for a tool-using turn:
 *   {"type":"system","subtype":"init","session_id":"<uuid>","tools":[...],"mcp_servers":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]},"session_id":...}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use",...}]},...}
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]},...}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":...}
 *
 * A missing resume target yields:
 *   {"type":"result","subtype":"error_during_execution","is_error":true,...}
 * plus "No conversation found with session ID: <id>" on stderr.
 *
 * Lines arrive from the per-turn output file (harness-turn-output.ts), but
 * parsing stays defensive — \r and ANSI stripping, non-JSON noise reported
 * as null and skipped.
 */

import { stripAnsiEscapes } from '../codex/codex-exec-events.js';
import { clipHarnessActivityArgument } from '../harness-activity.js';
import type { ProviderUsageWindow } from '../../types/user.js';

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | { type: string; [key: string]: unknown };

export type ClaudeStreamEvent =
  | { type: 'system'; subtype?: string; session_id?: string; [key: string]: unknown }
  | {
    type: 'assistant';
    session_id?: string;
    message?: { content?: ClaudeContentBlock[]; model?: string };
    /** Claude Code's locally-generated terminal API failure, not model output. */
    is_api_error_message?: boolean;
    error?: string;
    [key: string]: unknown;
  }
  | { type: 'user'; session_id?: string; [key: string]: unknown }
  | {
    type: 'result';
    subtype?: string;
    is_error?: boolean;
    result?: string;
    session_id?: string;
    [key: string]: unknown;
  }
  | { type: string; [key: string]: unknown };

export function parseClaudeStreamEventLine(rawLine: string): ClaudeStreamEvent | null {
  const line = stripAnsiEscapes(rawLine).replace(/\r+$/, '').trim();
  if (!line.startsWith('{') || !line.endsWith('}')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ClaudeStreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function getClaudeSessionId(event: ClaudeStreamEvent): string | undefined {
  const id = (event as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeUsedPercent(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric < 0) return undefined;
  // Agent SDK RateLimitEvent documents utilization as 0..1; status-line
  // snapshots use 0..100. Accept both because stream-json has used both shapes.
  return Math.min(100, numeric <= 1 ? numeric * 100 : numeric);
}

function parseWindow(id: string, raw: unknown): ProviderUsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const usedPercent = normalizeUsedPercent(
    value.used_percentage ?? value.usedPercent ?? value.utilization,
  );
  if (usedPercent === undefined) return null;
  const resetsAt = finiteNumber(value.resets_at ?? value.resetsAt);
  const windowDurationMins = finiteNumber(
    value.window_duration_mins ?? value.windowDurationMins,
  );
  return {
    id,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

/**
 * Extract account quota windows from Claude Code's structured stream. Newer
 * CLIs can expose either a full `rate_limits` snapshot or a sparse
 * `rate_limit_event`; callers merge the returned windows with their cache.
 */
export function getClaudeUsageWindows(event: ClaudeStreamEvent): ProviderUsageWindow[] {
  const raw = event as Record<string, unknown>;
  const windows: ProviderUsageWindow[] = [];
  const snapshot = raw.rate_limits ?? raw.rateLimits;
  if (typeof snapshot === 'object' && snapshot !== null) {
    for (const [id, value] of Object.entries(snapshot as Record<string, unknown>)) {
      const parsed = parseWindow(id, value);
      if (parsed) windows.push(parsed);
    }
  }

  if (event.type === 'rate_limit_event') {
    const info = raw.rate_limit_info ?? raw.rateLimitInfo;
    if (typeof info === 'object' && info !== null) {
      const value = info as Record<string, unknown>;
      const idValue = value.rate_limit_type ?? value.rateLimitType;
      const id = typeof idValue === 'string' && idValue ? idValue : 'active';
      const parsed = parseWindow(id, value);
      if (parsed) windows.push(parsed);
    }
  }
  return windows;
}

/**
 * `resets_at` from a `rate_limit_event`, as epoch seconds — readable even when
 * the event carries no utilization. getClaudeUsageWindows drops such events
 * (parseWindow needs a percentage, and per anthropic/claude-code#50518 most
 * rate_limit_events carry none), but the reset moment alone is what the
 * platform pool needs to size a credential's cooldown when a turn dies on a
 * usage limit. ISO strings are accepted defensively alongside epoch numbers.
 */
export function getClaudeRateLimitResetAt(event: ClaudeStreamEvent): number | undefined {
  if (event.type !== 'rate_limit_event') return undefined;
  const raw = event as Record<string, unknown>;
  const info = raw.rate_limit_info ?? raw.rateLimitInfo;
  if (typeof info !== 'object' || info === null) return undefined;
  const value = info as Record<string, unknown>;
  const resetsAt = value.resets_at ?? value.resetsAt;
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0) {
    return resetsAt;
  }
  if (typeof resetsAt === 'string' && resetsAt) {
    const parsedMs = Date.parse(resetsAt);
    if (Number.isFinite(parsedMs)) return Math.round(parsedMs / 1000);
  }
  return undefined;
}

/** Concrete model reported by Claude Code, when present on init or assistant events. */
export function getClaudeModel(event: ClaudeStreamEvent): string | undefined {
  // A terminal API failure is emitted as a synthetic assistant message in
  // Claude Code 2.1.251. Its `<synthetic>` model must not overwrite the last
  // real model reported by the turn.
  if (event.type === 'assistant' && event.is_api_error_message === true) return undefined;
  const eventModel = (event as { model?: unknown }).model;
  if (typeof eventModel === 'string' && eventModel.trim()) {
    return eventModel.trim();
  }
  const messageModel = (event as { message?: { model?: unknown } }).message?.model;
  return typeof messageModel === 'string' && messageModel.trim()
    ? messageModel.trim()
    : undefined;
}

/**
 * How full the context window was for THIS request, in tokens — the prompt the
 * model actually received.
 *
 * Only an `assistant` event, and deliberately not `result`. A turn makes many
 * API calls and `result.usage` is their SUM, so reading context from it would
 * report ten round trips of a 40k conversation as 400k and show a window
 * bursting when it is comfortable. The last assistant event is the most recent
 * prompt, which is what "how full is it right now" means.
 *
 * All three input counts add up, because all three were sent: a cached read is
 * still occupying the window, it was merely cheaper to send. Leaving cache
 * reads out is the easy version of this that reads near-zero on exactly the
 * long conversations the number exists to warn about.
 */
export function getClaudeContextTokens(event: ClaudeStreamEvent): number | undefined {
  if (event.type !== 'assistant') return undefined;
  const usage = (event as { message?: { usage?: unknown } }).message?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const count = (key: string): number => {
    const value = (usage as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const total = count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  // A synthetic answer (no API call was made) reports all zeros; that is not a
  // measurement of an empty context, it is the absence of one.
  return total > 0 ? total : undefined;
}

/** Text blocks from an assistant event (ignores tool_use and other blocks). */
export function getAssistantTextBlocks(event: ClaudeStreamEvent): string[] {
  if (event.type !== 'assistant') return [];
  const content = (event as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ) {
      const text = (block as ClaudeTextBlock).text.trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

/**
 * Claude Code 2.1.251's terminal API-error shape. The CLI emits this as an
 * `assistant` event before its `result` event, but the text is diagnostics,
 * not an answer: delivering it leaks a raw 401 into the conversation before
 * the harness can re-lease a rotated platform token.
 */
export function getClaudeApiErrorMessage(event: ClaudeStreamEvent): string | undefined {
  if (event.type !== 'assistant' || event.is_api_error_message !== true) return undefined;
  const text = getAssistantTextBlocks(event).join('\n').trim();
  if (text) return text;
  return typeof event.error === 'string' && event.error.trim() ? event.error.trim() : undefined;
}

/**
 * Short human-readable summaries of the tool_use blocks in an assistant event
 * (for the live "what is the agent doing" status): tool name plus a tight
 * argument — the Bash command, a file's basename — capped for button labels.
 */
export function getToolUseSummaries(event: ClaudeStreamEvent): string[] {
  if (event.type !== 'assistant') return [];
  const content = (event as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const summaries: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; name?: unknown; input?: Record<string, unknown> };
    if (typed.type !== 'tool_use' || typeof typed.name !== 'string') continue;
    const input = typed.input ?? {};
    const argument = typeof input.command === 'string' ? input.command
      : typeof input.file_path === 'string' ? String(input.file_path).split('/').at(-1)
      : typeof input.pattern === 'string' ? input.pattern
      : typeof input.url === 'string' ? input.url
      : '';
    const clean = clipHarnessActivityArgument(String(argument));
    summaries.push(clean ? `${typed.name}: ${clean}` : typed.name);
  }
  return summaries;
}

export interface ClaudeResultInfo {
  isError: boolean;
  text?: string;
  subtype?: string;
}

export function getResultInfo(event: ClaudeStreamEvent): ClaudeResultInfo | null {
  if (event.type !== 'result') return null;
  const e = event as Extract<ClaudeStreamEvent, { type: 'result' }>;
  return {
    isError: e.is_error === true,
    text: typeof e.result === 'string' ? e.result : undefined,
    subtype: typeof e.subtype === 'string' ? e.subtype : undefined,
  };
}
