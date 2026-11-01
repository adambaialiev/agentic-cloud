import type { SessionToolCallProgress } from '../types/persistence.js';
import type {
  SessionHistoryEntrySummary,
  SessionObservation,
  SessionToolSummary,
} from '../types/tools.js';
import { formatUserLocalTimestamp } from '../utils/time-zone.js';

/**
 * Shared helpers for rendering one `list-sessions` line.
 *
 * The output is deliberately raw — it reports what the child session actually
 * did (its recent tool calls, with timestamps) and what it last said
 * (`last_reply`, with the time it was sent). It does NOT try to guess the
 * session's "phase" or whether it is stuck: those interpretations belong to the
 * coordinator, which has the full picture. `last_reply` is only the child's
 * last message to the coordinator and is NOT refreshed while the child works
 * silently, so the coordinator must judge liveness from `recent_tools` and
 * their timestamps, not from `last_reply` alone.
 *
 * Timestamps are emitted in the user's saved local timezone rather than as
 * relative ages ("5s ago"). Local absolute timestamps are stable for a given
 * snapshot and timezone, so replay text stays cacheable while preserving the
 * clock context the coordinator needs.
 *
 * Both the live formatter (tool-executor) and the history replay formatter
 * (model-messages) import from here so the rendered text stays identical.
 */

/** Emit a local timestamp only when the user's timezone is known. */
function localTimestamp(timestamp: string | undefined, timeZone: string | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  return formatUserLocalTimestamp(timestamp, timeZone) ?? undefined;
}

function formatToolCallToken(
  toolCall: SessionToolCallProgress,
  timeZone: string | undefined,
): string {
  const base = `${toolCall.toolName}:${toolCall.status}`;
  const timestamp = localTimestamp(toolCall.timestamp, timeZone);
  return timestamp ? `${base} @ ${timestamp}` : base;
}

/**
 * Render one `list-sessions` line. Shared by the live tool result and the
 * history replay so both stay byte-for-byte identical.
 */
export function formatSessionSummaryLine(
  session: SessionToolSummary,
  options: { timeZone?: string } = {},
): string {
  const parts = [`- ${session.sessionId}`];
  if (session.title) {
    parts.push(session.title);
  }
  parts.push(`status=${session.status}`);

  const updatedAt = localTimestamp(session.updatedAt, options.timeZone);
  if (updatedAt) {
    parts.push(`updated=${updatedAt}`);
  }
  const currentActivity = session.currentActivity ?? session.progress?.currentActivity;
  if (currentActivity) {
    parts.push(`current_activity=${currentActivity}`);
  }
  const totalSteps = session.totalSteps ?? session.progress?.totalSteps;
  if (typeof totalSteps === 'number') {
    parts.push(`total_steps=${totalSteps}`);
  }

  // Where the session last touched a terminal. This is the resume pointer for
  // any uncommitted working-tree state the session left behind: without it a
  // coordinator only knows THAT edits exist somewhere, not where.
  const terminalContext = session.progress?.lastTerminalContext;
  if (terminalContext && (terminalContext.serverId || terminalContext.cwd)) {
    const locationParts: string[] = [];
    if (terminalContext.serverId) {
      locationParts.push(`server ${terminalContext.serverId}`);
    }
    if (terminalContext.cwd) {
      locationParts.push(`cwd ${terminalContext.cwd}`);
    }
    parts.push(`last_terminal=${JSON.stringify(locationParts.join(', '))}`);
  }

  const recentToolCalls = session.recentToolCalls ?? session.progress?.recentToolCalls;
  const lastActivity = session.lastActivity ?? session.progress?.lastActivity;
  if (lastActivity) {
    parts.push(`last_activity=${JSON.stringify(formatToolCallToken(lastActivity, options.timeZone))}`);
  }
  if (recentToolCalls?.length) {
    // Newest first; show the last few so real progress (and failures) is visible.
    const summary = recentToolCalls
      .slice(0, 3)
      .map((toolCall) => formatToolCallToken(toolCall, options.timeZone))
      .join(', ');
    parts.push(`recent_tools=${JSON.stringify(summary)}`);
  }

  if (typeof session.lastError === 'string' && session.lastError.trim()) {
    const lastError = session.lastError.replace(/\s+/g, ' ').trim();
    parts.push(`last_error=${JSON.stringify(lastError)}`);
  }
  if (typeof session.lastAssistantMessage === 'string' && session.lastAssistantMessage.trim()) {
    const lastReply = session.lastAssistantMessage.replace(/\s+/g, ' ').trim();
    parts.push(`last_reply=${JSON.stringify(lastReply)}`);
    // The send time matters because last_reply is NOT refreshed while the child
    // works silently — a stale last_reply with fresh recent_tools just means the
    // child has been busy since it last spoke.
    const lastReplyAt = localTimestamp(session.lastAssistantMessageAt, options.timeZone);
    if (lastReplyAt) {
      parts.push(`last_reply_at=${JSON.stringify(lastReplyAt)}`);
    }
  }

  return parts.join(' | ');
}

/**
 * Truncation caps for `observe-session` history rendering. Tool outputs and
 * assistant texts can be arbitrarily large; the observation is a peek, not a
 * transcript dump, so each block is bounded while newlines are preserved
 * (unlike the one-line `list-sessions` summary).
 */
const OBSERVE_CONTENT_MAX_CHARS = 2_000;
const OBSERVE_THINKING_MAX_CHARS = 1_000;
const OBSERVE_PARAMETERS_MAX_CHARS = 500;

function truncateObservationBlock(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}… [truncated ${normalized.length - maxChars} chars]`;
}

function formatObservationHistoryEntry(
  entry: SessionHistoryEntrySummary,
  position: number,
  total: number,
  timeZone: string | undefined,
): string {
  const roleLabel = entry.role === 'tool' && entry.toolName
    ? `tool (${entry.toolName})`
    : entry.role;
  const timestamp = localTimestamp(entry.createdAt, timeZone);
  const header = `--- [${position}/${total}] ${roleLabel}${timestamp ? ` @ ${timestamp}` : ''} ---`;

  const lines = [header];
  if (entry.thinking?.trim()) {
    lines.push('thinking:', truncateObservationBlock(entry.thinking, OBSERVE_THINKING_MAX_CHARS));
  }
  if (entry.content?.trim()) {
    lines.push(entry.role === 'tool' ? 'output:' : 'text:', truncateObservationBlock(entry.content, OBSERVE_CONTENT_MAX_CHARS));
  }
  for (const toolCall of entry.toolCalls ?? []) {
    lines.push(`tool_call: ${toolCall.toolName}${toolCall.isComplete === false ? ' (in progress)' : ''}`);
    if (toolCall.parameters && Object.keys(toolCall.parameters).length > 0) {
      let serialized: string;
      try {
        serialized = JSON.stringify(toolCall.parameters);
      } catch {
        serialized = '[unserializable parameters]';
      }
      lines.push(`parameters: ${truncateObservationBlock(serialized, OBSERVE_PARAMETERS_MAX_CHARS)}`);
    }
    if (toolCall.result?.trim()) {
      lines.push('result:', truncateObservationBlock(toolCall.result, OBSERVE_CONTENT_MAX_CHARS));
    }
  }
  if (lines.length === 1) {
    lines.push('(empty item)');
  }
  return lines.join('\n');
}

/**
 * Render an `observe-session` result: the same summary line as
 * `list-sessions`, followed by the last few history items with their real
 * content (assistant text/thinking, tool calls and their outputs).
 */
export function formatSessionObservation(
  observation: SessionObservation,
  options: { timeZone?: string } = {},
): string {
  const { history, totalHistoryItems } = observation;
  const sections = [
    'Session summary:',
    formatSessionSummaryLine(observation.session, options),
    '',
  ];
  if (history.length === 0) {
    sections.push('Recent history: (empty — the session has no history items yet)');
  } else {
    sections.push(`Recent history (last ${history.length} of ${totalHistoryItems} items, oldest first):`);
    const firstPosition = totalHistoryItems - history.length + 1;
    history.forEach((entry, index) => {
      sections.push(formatObservationHistoryEntry(
        entry,
        firstPosition + index,
        totalHistoryItems,
        options.timeZone,
      ));
    });
  }
  return sections.join('\n');
}
