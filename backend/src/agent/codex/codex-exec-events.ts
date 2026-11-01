/**
 * Types and parsing for `codex exec --json` JSONL output (codex-cli 0.142.x).
 *
 * Observed event stream for a turn:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_0","type":"command_execution",...}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
 *
 * Lines arrive from the per-turn output file (harness-turn-output.ts), but
 * parsing stays defensive — \r and ANSI stripping, non-JSON noise (login
 * hints, warnings) reported as `null` and skipped by callers.
 */

import { clipHarnessActivityArgument } from '../harness-activity.js';

export interface CodexAgentMessageItem {
  id: string;
  type: 'agent_message';
  text: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: 'command_execution';
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface CodexUnknownItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export type CodexExecItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexUnknownItem;

export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export type CodexExecEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexTokenUsage }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'item.started'; item: CodexExecItem }
  | { type: 'item.updated'; item: CodexExecItem }
  | { type: 'item.completed'; item: CodexExecItem }
  | { type: 'error'; message?: string }
  | { type: string; [key: string]: unknown };

export function isAgentMessageItem(item: CodexExecItem): item is CodexAgentMessageItem {
  return item.type === 'agent_message' && typeof (item as CodexAgentMessageItem).text === 'string';
}

export function getCompletedItem(event: CodexExecEvent): CodexExecItem | null {
  if (event.type !== 'item.completed') return null;
  const item = (event as { item?: unknown }).item;
  if (typeof item !== 'object' || item === null) return null;
  if (typeof (item as { type?: unknown }).type !== 'string') return null;
  return item as CodexExecItem;
}

/**
 * Short human-readable summary of an item.started event (live status): the
 * command for command_execution, a generic label for other item kinds, null
 * for kinds with nothing meaningful to show.
 */
export function getStartedItemSummary(event: CodexExecEvent): string | null {
  if (event.type !== 'item.started') return null;
  const item = (event as { item?: unknown }).item;
  if (typeof item !== 'object' || item === null) return null;
  const typed = item as { type?: unknown; command?: unknown };
  switch (typed.type) {
    case 'command_execution':
      return typeof typed.command === 'string'
        ? `$ ${clipHarnessActivityArgument(typed.command)}`
        : 'running a command';
    case 'file_change':
      return 'editing files';
    case 'web_search':
      return 'searching the web';
    case 'mcp_tool_call':
      return 'using a tool';
    default:
      return null;
  }
}

export function parseCodexExecEventLine(rawLine: string): CodexExecEvent | null {
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
      return parsed as CodexExecEvent;
    }
    return null;
  } catch {
    return null;
  }
}

// PTY output colorizes some lines (e.g. login hints interleaved before the
// JSONL stream); escapes must go before the JSON shape check.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsiEscapes(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}
