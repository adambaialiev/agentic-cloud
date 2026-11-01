/**
 * Types and parsing for `opencode run --format json` (opencode 1.19.3, read
 * with a stub model provider on 2026-10-20, note #780). One JSON object per
 * line, every one carrying the conversation's `sessionID`:
 *
 *   {"type":"step_start","sessionID":"ses_…","part":{…}}
 *   {"type":"tool_use","sessionID":"ses_…","part":{"tool":"bash","state":{"status":"completed","input":{…},"output":"…","title":"…"}}}
 *   {"type":"step_finish","sessionID":"ses_…","part":{"reason":"tool-calls","tokens":{…},"cost":0.0001}}
 *   {"type":"text","sessionID":"ses_…","part":{"text":"…"}}
 *   {"type":"error","sessionID":"ses_…","error":{"name":"APIError","data":{"message":"…","statusCode":401,…}}}
 *
 * A step is ONE model request, and its `tokens` are that request's alone —
 * not a running total, within a turn or across `--session` resumes (two
 * requests of 1,000 and 2,000 prompt tokens report 1,000 and 2,000; the
 * resumed turn's 3,000 reports 3,000). `input` leaves the cache reads out and
 * `output` leaves the reasoning out (a completion of 11 with 3 reasoning
 * reports output 8, reasoning 3).
 *
 * A `tool_use` line arrives when the tool has FINISHED, never when it starts;
 * text arrives whole, once its part has ended.
 *
 * `platform_limit` is not OpenCode's: it is written into the same stream by
 * the platform's plugin (opencode-limit-plugin.ts) when OpenCode would
 * otherwise sit out a usage limit's reset — hours, in silence — and the turn
 * ends on it instead.
 */

import { clipHarnessActivityArgument } from '../harness-activity.js';
import { stripAnsiEscapes } from '../codex/codex-exec-events.js';

export interface OpenCodeStepTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpenCodeApiErrorData {
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
  responseBody?: string;
}

export type OpenCodeRunEvent =
  | { type: 'step_start'; sessionID?: string; part?: unknown }
  | { type: 'step_finish'; sessionID?: string; part?: { reason?: string; tokens?: OpenCodeStepTokens } }
  | { type: 'text'; sessionID?: string; part?: { text?: string } }
  | { type: 'reasoning'; sessionID?: string; part?: { text?: string } }
  | {
    type: 'tool_use';
    sessionID?: string;
    part?: { tool?: string; state?: { status?: string; input?: Record<string, unknown>; title?: string; error?: string } };
  }
  | { type: 'error'; sessionID?: string; error?: { name?: string; data?: OpenCodeApiErrorData } }
  | {
    type: 'platform_limit';
    sessionID?: string;
    /** OpenCode's own reason: `account_rate_limit` (a Go window), `free_tier_limit`, or `long_retry`. */
    reason?: string;
    provider?: string;
    message?: string;
    /** Epoch ms OpenCode would have retried at — the window's reset. */
    retryAt?: number;
  }
  | { type: string; sessionID?: string; [key: string]: unknown };

export function parseOpenCodeEventLine(rawLine: string): OpenCodeRunEvent | null {
  const line = stripAnsiEscapes(rawLine).replace(/\r+$/, '').trim();
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as OpenCodeRunEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** The conversation the line belongs to, when it names one. */
export function openCodeSessionId(event: OpenCodeRunEvent): string | null {
  const id = (event as { sessionID?: unknown }).sessionID;
  return typeof id === 'string' && id.startsWith('ses_') ? id : null;
}

/** The assistant text a `text` line delivers, or null. */
export function openCodeText(event: OpenCodeRunEvent): string | null {
  if (event.type !== 'text') return null;
  const text = (event as { part?: { text?: unknown } }).part?.text;
  return typeof text === 'string' ? text : null;
}

/** One request's tokens off a `step_finish` line, or null. */
export function openCodeStepTokens(event: OpenCodeRunEvent): OpenCodeStepTokens | null {
  if (event.type !== 'step_finish') return null;
  const tokens = (event as { part?: { tokens?: unknown } }).part?.tokens;
  return typeof tokens === 'object' && tokens !== null ? tokens as OpenCodeStepTokens : null;
}

/**
 * The size of the prompt a request sent: fresh input plus what the cache
 * served and wrote — what "how full is the window" means. Null when the step
 * carried no figures.
 */
export function openCodePromptTokens(tokens: OpenCodeStepTokens): number | null {
  const prompt = num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write);
  return prompt > 0 ? prompt : null;
}

/** A short line for the live status: the tool that just ran. */
export function openCodeToolSummary(event: OpenCodeRunEvent): string | null {
  if (event.type !== 'tool_use') return null;
  const part = (event as { part?: { tool?: unknown; state?: { input?: Record<string, unknown>; title?: unknown } } }).part;
  const tool = typeof part?.tool === 'string' ? part.tool : '';
  const input = part?.state?.input ?? {};
  switch (tool) {
    case 'bash':
      return typeof input.command === 'string' ? `$ ${clipHarnessActivityArgument(input.command)}` : 'running a command';
    case 'edit':
    case 'write':
    case 'apply_patch':
      return 'editing files';
    case 'read':
    case 'glob':
    case 'grep':
      return 'reading files';
    case 'webfetch':
    case 'websearch':
      return 'searching the web';
    case 'task':
      return 'working with a helper';
    case '':
      return null;
    default:
      return 'using a tool';
  }
}

/** What an `error` line says, as the person should read it. */
export function openCodeErrorMessage(event: OpenCodeRunEvent): string | null {
  if (event.type !== 'error') return null;
  const error = (event as { error?: { name?: unknown; data?: { message?: unknown } } }).error;
  const message = error?.data?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return typeof error?.name === 'string' ? error.name : 'OpenCode reported an error.';
}

/** The provider's HTTP status on an `error` line, when it came from one. */
export function openCodeErrorStatus(event: OpenCodeRunEvent): number | undefined {
  if (event.type !== 'error') return undefined;
  const status = (event as { error?: { data?: { statusCode?: unknown } } }).error?.data?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** The provider's raw answer on an `error` line (it names the limit kind). */
export function openCodeErrorBody(event: OpenCodeRunEvent): string {
  if (event.type !== 'error') return '';
  const body = (event as { error?: { data?: { responseBody?: unknown } } }).error?.data?.responseBody;
  return typeof body === 'string' ? body : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
