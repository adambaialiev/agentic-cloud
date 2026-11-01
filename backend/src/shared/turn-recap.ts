/**
 * The recap line under a conversation's latest completed turn (note #945):
 * The owner's ask for the terminal Claude Code's two muted lines under each agent
 * reply — "Worked for 12s · done 8:38 PM · 1 shell still running" and an
 * italic recap — in the Workspace's chats.
 *
 * ONE SOURCE. The recap is the agent row's own (agent-row-recap-design): the
 * same post-turn summary the fleet row, the hover card and the details screen
 * print, read off the same record. No second summarizer, so the chat can
 * never tell a different story from the row.
 *
 * The first line is the platform's own facts about the turn — when it started
 * and ended, both stamped on the record at the turn's end. What is still
 * running is read live by each screen (the jobs strip's count, the Chief of
 * Staff's `waiting`), never from here, so it is true when it is read.
 */

/** What a chat answer carries about the latest completed turn. */
export interface WorkspaceTurnRecap {
  /** When the turn ended — the record's durable turn boundary (note #455). */
  endedAt: string;
  /** When it started. Absent for a turn that ended before note #945. */
  startedAt?: string;
  /**
   * The row recap, once the summary that ran for THIS turn has arrived: a
   * recap stamped before the turn began describes the turn before it, and
   * the line draws nothing for it rather than an old sentence or a spinner.
   */
  recap?: string;
}

/** The record fields the line is read from. */
export interface TurnRecapSource {
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
  recap?: { text: string; at: string };
  /** When a summary last returned this recap, changed or not (note #945). */
  recapCheckedAt?: string;
}

/**
 * The latest completed turn of one agent record, or undefined when it has
 * none on record. The recap counts once a summary stamped it at or after the
 * turn's start — a mid-turn checkpoint of the turn included, which the
 * post-turn summary then rewrites in place — or, for a turn whose start was
 * never stamped, at or after its end, which only the post-turn summary is.
 */
export function turnRecapOf(record: TurnRecapSource | null | undefined): WorkspaceTurnRecap | undefined {
  const ended = Date.parse(record?.lastTurnEndedAt ?? '');
  if (!record || !Number.isFinite(ended)) return undefined;
  const started = Date.parse(record.lastTurnStartedAt ?? '');
  const startedAt = Number.isFinite(started) && started <= ended ? record.lastTurnStartedAt : undefined;
  const text = record.recap?.text?.trim() ?? '';
  const stamped = Math.max(Date.parse(record.recap?.at ?? '') || 0, Date.parse(record.recapCheckedAt ?? '') || 0);
  const since = startedAt ? started : ended;
  const recap = text && stamped >= since ? text : undefined;
  return {
    endedAt: record.lastTurnEndedAt!,
    ...(startedAt ? { startedAt } : {}),
    ...(recap ? { recap } : {}),
  };
}
