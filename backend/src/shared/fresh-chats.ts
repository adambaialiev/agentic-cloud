/**
 * Which of a room's agents can be offered a fresh chat from the room's own
 * button (note #707: "room should have button that reset agents that are
 * completed, safe to reset"). ONE definition, read by the Agents tab to decide
 * whether the button stands and whom it names, and by the server again at the
 * press, so the page can never ask for a reset the backend would not stand
 * behind.
 *
 * "Finished" is the recap summarizer's verdict on the latest turn — the one
 * reader that saw the conversation — and the rest are the platform's own
 * records, each a way the work can still come back to the agent: a turn
 * running, a proposal waiting on a decision, a durable job that will report,
 * a stop on its subscription window, a note it holds. Any one of them keeps
 * the agent's conversation, because a fresh chat makes it forget.
 */

import type { WorkspaceAgentRow } from './workspace-api.js';

/**
 * Whether the summarizer's FINISHED verdict still stands: it must be newer
 * than the end of the last turn. A summary that failed leaves the previous
 * turn's verdict on the record, and that says nothing about the turn after.
 * A record from before turn ends were stamped has nothing to be newer than.
 */
export function agentWorkFinished(record: { workFinishedAt?: string; lastTurnEndedAt?: string }): boolean {
  const finished = Date.parse(record.workFinishedAt ?? '');
  if (!Number.isFinite(finished)) return false;
  const ended = Date.parse(record.lastTurnEndedAt ?? '');
  return !Number.isFinite(ended) || finished > ended;
}

export type FreshChatRow = Pick<
  WorkspaceAgentRow,
  'id' | 'status' | 'working' | 'finished' | 'context' | 'doing' | 'activeJobs' | 'sessionLimit'
>;

/**
 * Why this agent's conversation must be kept, in words that finish "Ben …",
 * or null when it is safe to reset: ready, idle, its work finished, a
 * conversation to clear (a measured reading above zero — where the agent
 * screen's own "Ask agent to reset chat" stands too), and nothing on the
 * records that will come back to it. `holdingNotes` names the agents with a
 * live note claim.
 */
export function freshChatRefusal(row: FreshChatRow, holdingNotes: ReadonlySet<string> = new Set()): string | null {
  if (row.status !== 'ready') return 'is not ready to run';
  if (row.working) return 'is working right now';
  if ((row.context?.usedPercent ?? 0) <= 0) return 'has no conversation to clear';
  if (row.finished !== true) return 'has work that is not finished';
  if (row.doing?.kind === 'proposal') return 'has a proposal waiting';
  if (row.activeJobs) return 'has a background job running';
  if (row.sessionLimit) return 'is stopped on its subscription limit';
  if (holdingNotes.has(row.id)) return 'is holding a note it works from';
  return null;
}

export function agentReadyForFreshChat(row: FreshChatRow, holdingNotes?: ReadonlySet<string>): boolean {
  return freshChatRefusal(row, holdingNotes) === null;
}

/**
 * The words the room's button sends each agent: the owner's own "reset chat",
 * exactly what the agent screen's single button sends (note #707 reuses it
 * rather than inventing a second dialect). It is an ASK, not a silent reset —
 * the agent saves what matters to its scratchpad first, then clears its chat.
 */
export const FRESH_CHAT_MESSAGE = 'reset chat';
