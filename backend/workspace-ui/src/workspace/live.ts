/**
 * The pure half of Home's data: what the live tick changes and how unread
 * replies group. (How a room split the fleet lived here too, until rooms
 * left the product — note #843.) Ported from the legacy
 * page function for function (the tests there are the tests here), with
 * one difference — nothing is mutated. Every helper returns a new array
 * and reports whether anything changed, which is what lets React repaint
 * exactly the rows that moved.
 */

import type {
  WorkspaceAgentRow,
  WorkspaceAgentSessionLimit,
  WorkspaceAgentsLiveAnswer,
  WorkspaceNoteRow,
  WorkspaceNoteLiveClaim,
  WorkspaceNotificationRow,
  WorkspaceTeamAgentRow,
} from '../../../src/shared/workspace-api.js';
import { parseWorkspaceRoute } from '../../../src/shared/workspace-routes.js';

/** An agent row plus what the page knows that the server does not: when its
 *  recap last CHANGED under this reader, for the arrival animation. */
export interface HomeAgent extends WorkspaceAgentRow {
  recapArrivedAt?: number;
}

/** One recap version, including the honest change stamp when it has one. */
export function agentRecapVersion(agent: Pick<WorkspaceAgentRow, 'recap' | 'recapAt'> | null | undefined): string {
  return agent?.recap ? `${agent.recapAt ?? ''}\n${agent.recap}` : '';
}

/**
 * A fresh state read carries no arrival stamps. Carry the previous list's
 * over, and stamp a recap that differs from the one that was on screen —
 * the row then plays its arrival, and only then.
 */
export function carryAgentRecapArrivals(next: WorkspaceAgentRow[], previous: HomeAgent[] | null, now = Date.now()): HomeAgent[] {
  const before = new Map((previous ?? []).map((agent) => [agent.id, agent]));
  return next.map((agent) => {
    const old = before.get(agent.id);
    if (!old) return agent;
    const version = agentRecapVersion(agent);
    const prior = agentRecapVersion(old);
    if (version && version !== prior) return { ...agent, recapArrivedAt: now };
    if (old.recapArrivedAt && version === prior) return { ...agent, recapArrivedAt: old.recapArrivedAt };
    return agent;
  });
}

function sessionLimitVersion(limit: WorkspaceAgentSessionLimit | undefined): string {
  return limit ? [limit.hitAt, limit.resetAt, limit.resetsText ?? '', Boolean(limit.resumeReady)].join('|') : '';
}

export interface LiveTickResult {
  agents: HomeAgent[];
  /** A turn started or ended: the world moved, and only a full read says how. */
  moved: boolean;
  /** A recap, a job count or a session limit changed on a row that otherwise
   *  stood still. */
  changed: boolean;
}

export interface LiveNoteClaimResult {
  notes: WorkspaceNoteRow[] | null | undefined;
  changed: boolean;
  /** A claim disappeared. Only a full read can say whether the note is now
   *  unclaimed, back on a conflict, or already linked to a proposal. */
  reload: boolean;
}

const workVersion = (work: WorkspaceNoteRow['work']): string => JSON.stringify(work ?? null);

/**
 * Fold active note claims into a list without re-reading note bodies.
 *
 * The field is optional across a backend deploy: absence says nothing and
 * leaves every row alone. An empty list is an answer. A new/renewed claim can
 * be painted directly; a vanished one asks for one authoritative full read
 * because the state beneath a lease cannot be inferred safely.
 */
export function applyLiveNoteClaims(
  notes: WorkspaceNoteRow[] | null | undefined,
  claims: WorkspaceNoteLiveClaim[] | undefined,
): LiveNoteClaimResult {
  if (!notes || !claims) return { notes, changed: false, reload: false };
  const active = new Map(claims.map((row) => [row.id, row.work]));
  let changed = false;
  let reload = false;
  const next = notes.map((note) => {
    const work = active.get(note.id);
    if (!work) {
      if (note.work?.state === 'working') reload = true;
      return note;
    }
    // A proposal or landed change outranks a lease in the server's resolver.
    // Never walk one backwards because the underlying claim has not expired.
    if (note.work && ['proposal', 'merged', 'live'].includes(note.work.state)) return note;
    if (workVersion(note.work) === workVersion(work)) return note;
    changed = true;
    return { ...note, work };
  });
  return { notes: changed ? next : notes, changed, reload };
}

/**
 * Apply one live tick to the fleet. `moved` when the working SET differs
 * from what the rows say; otherwise the tail of each working row (activity,
 * clock), any stamped recap, any change in durable job count, the finished
 * verdict and any session-limit change are folded in.
 */
export function applyLiveTick(agents: HomeAgent[], live: WorkspaceAgentsLiveAnswer, now = Date.now()): LiveTickResult {
  const working = new Map(live.agents.map((agent) => [agent.id, agent]));
  const moved = agents.some((agent) => Boolean(agent.working) !== working.has(agent.id));
  const recaps = new Map(live.recaps.map((recap) => [recap.id, recap]));
  const limits = new Map(live.sessionLimits.map((limit) => [limit.id, limit]));
  // Absent means "this answer says nothing about jobs" — a backend from
  // before note #588 — and every plate keeps the count it was drawn with.
  // An EMPTY list is an answer: nothing durable is running anywhere.
  const jobs = live.jobs ? new Map(live.jobs.map((row) => [row.id, row.count])) : null;
  // The same rule for the finished verdict (note #707): absent says nothing.
  const finished = live.finished ? new Set(live.finished) : null;
  let changed = false;
  const next = agents.map((agent) => {
    const fresh = working.get(agent.id);
    let row: HomeAgent = {
      ...agent,
      working: Boolean(fresh) || undefined,
      activity: fresh?.activity,
      activitySince: fresh?.activitySince,
    };
    const recap = recaps.get(agent.id);
    if (recap?.recap && agentRecapVersion(agent) !== agentRecapVersion(recap)) {
      row = { ...row, recap: recap.recap, recapAt: recap.recapAt, recapArrivedAt: now };
      if (!recap.recapAt) delete row.recapAt;
      changed = true;
    }
    // Durable work its machine picked up or finished since the last full
    // read (note #588). The count is recorded whenever the backend looks at
    // the machine — at the end of every turn, and while a chat or the jobs
    // list is open — so the plate now follows it without anyone opening one.
    if (jobs) {
      const count = jobs.get(agent.id) ?? 0;
      if ((agent.activeJobs ?? 0) !== count) {
        row = { ...row, activeJobs: count };
        if (!count) delete row.activeJobs;
        changed = true;
      }
    }
    // Written seconds after the turn ends, so it lands between full reads —
    // the fleet's reset button reads it (note #707).
    if (finished && Boolean(agent.finished) !== finished.has(agent.id)) {
      row = { ...row, finished: true };
      if (!finished.has(agent.id)) delete row.finished;
      changed = true;
    }
    const limit = limits.get(agent.id);
    if (sessionLimitVersion(agent.sessionLimit) !== sessionLimitVersion(limit)) {
      if (limit) {
        row = {
          ...row,
          sessionLimit: {
            hitAt: limit.hitAt,
            resetAt: limit.resetAt,
            ...(limit.resetsText ? { resetsText: limit.resetsText } : {}),
            resumeReady: Boolean(limit.resumeReady),
          },
        };
      } else {
        delete row.sessionLimit;
      }
      changed = true;
    }
    return row;
  });
  return { agents: next, moved, changed };
}

/**
 * Fold the tick's `teamWorking` into the teammates' agents (2026-09-23).
 *
 * Unlike the reader's own fleet, a teammate's agent starting or ending a turn
 * buys no full read: the strip draws nothing the full read would change —
 * no order, no queue, no job line — only which faces wear the live mark. Absent from an older backend, which leaves every face as drawn.
 */
export function applyLiveTeamWorking(
  teamAgents: WorkspaceTeamAgentRow[] | undefined,
  teamWorking: string[] | undefined,
): { teamAgents: WorkspaceTeamAgentRow[] | undefined; changed: boolean } {
  if (!teamAgents || !teamWorking) return { teamAgents, changed: false };
  const working = new Set(teamWorking);
  let changed = false;
  const next = teamAgents.map((agent) => {
    if (Boolean(agent.working) === working.has(agent.id)) return agent;
    changed = true;
    const row = { ...agent };
    if (working.has(agent.id)) row.working = true;
    else delete row.working;
    return row;
  });
  return { teamAgents: changed ? next : teamAgents, changed };
}

/**
 * The one agent in the fleet that goes by this name, or null (note #353).
 *
 * A message from another agent is stored as its sender's NAME — the id is
 * nowhere in the row — so a face in a transcript is identified the way a
 * reader identifies it, by reading the name and knowing the fleet. The fleet
 * this searches is the whole workplace's, because that is exactly the set an
 * agent may be messaged from.
 *
 * Matched the way `agentbuilt agent message` matches the recipient it was
 * given: trimmed and case-insensitively. And AMBIGUITY IS AN ANSWER — that
 * command refuses a name two agents answer to and asks for an id, so a
 * reader gets no card and no door here rather than one agent's runtime and
 * recap presented as another's. Nothing about the row is lost by that: the
 * name and the picture are the row's own, and they stand exactly as before.
 */
export function agentNamed<T extends Pick<WorkspaceAgentRow, 'name'>>(
  agents: T[] | null | undefined,
  name: string | null | undefined,
): T | null {
  const wanted = (name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const found = (agents ?? []).filter((agent) => (agent.name ?? '').trim().toLowerCase() === wanted);
  return found.length === 1 ? found[0]! : null;
}

/** The agent a chat-completion notification opens, or null. */
export function unreadChatAgentId(notification: WorkspaceNotificationRow, origin: string): string | null {
  if (notification.readAt || notification.kind !== 'agent_completed') return null;
  try {
    const target = new URL(notification.url, origin);
    if (target.origin !== origin) return null;
    const route = parseWorkspaceRoute(target.pathname, target.search);
    return route?.kind === 'chat' && route.id ? route.id : null;
  } catch {
    return null;
  }
}

/** Home is the direct-conversation queue, not a second activity feed: only a
 *  reply to the reader's own message counts. Historical rows have no source
 *  and stay outside it too. */
export function directUnreadChatAgentId(notification: WorkspaceNotificationRow, origin: string): string | null {
  return notification.source === 'direct_agent_chat' ? unreadChatAgentId(notification, origin) : null;
}

export interface UnreadConversation<T> {
  agent: T;
  count: number;
  latestAt: string;
}

/** Unread direct replies grouped per agent, newest conversation first,
 *  limited to the agents on screen. */
export function groupUnreadConversations<T extends Pick<WorkspaceAgentRow, 'id'>>(
  notifications: WorkspaceNotificationRow[],
  visibleAgents: T[],
  origin: string,
): UnreadConversation<T>[] {
  const byId = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const unread = new Map<string, UnreadConversation<T>>();
  for (const notification of notifications) {
    const agentId = directUnreadChatAgentId(notification, origin);
    const agent = agentId ? byId.get(agentId) : undefined;
    if (!agent) continue;
    const at = notification.createdAt ?? '';
    const existing = unread.get(agent.id);
    if (existing) {
      existing.count += 1;
      if (at > existing.latestAt) existing.latestAt = at;
    } else {
      unread.set(agent.id, { agent, count: 1, latestAt: at });
    }
  }
  return [...unread.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

/**
 * Whether anything waits on this reader behind the agents picker's button
 * (note #843): an unread direct reply from one of their agents, or a
 * decision only they are asked to take. The rooms' marks said this one room
 * at a time — a dot per room tab, the button's ring for any room — until
 * rooms left the product; it is one question about the workplace now.
 */
export function readerNeedsAttention(
  agents: Array<Pick<WorkspaceAgentRow, 'id'>> | null,
  notifications: WorkspaceNotificationRow[],
  origin: string,
  decisionsWaiting: number,
): boolean {
  if (decisionsWaiting > 0) return true;
  const agentIds = new Set((agents ?? []).map((agent) => agent.id));
  return notifications.some((notification) => {
    const agentId = directUnreadChatAgentId(notification, origin);
    return Boolean(agentId && agentIds.has(agentId));
  });
}

/**
 * One line of plain text from a Markdown reply, for the unread row: enough to
 * recognise which answer arrived, never markup. Strips the marks the chat
 * renderer would have drawn — emphasis, code spans, headings, links, list
 * bullets — and squeezes whitespace. Not a renderer: nothing here becomes DOM.
 */
export function markdownPreview(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One line from the reply itself, empty when that reply carries no words. */
export function unreadMessagePreview(agent: Pick<WorkspaceAgentRow, 'lastReply'>): string {
  const source = typeof agent.lastReply?.text === 'string' ? agent.lastReply.text.trim() : '';
  return source ? markdownPreview(source) : '';
}

/** What is waiting, for a row that has no words of its own to show. Split from
 *  the preview above so the count has ONE source: the row says it here, or as
 *  its own short fact beside the words, never both (note #271). */
export function unreadRepliesWord(count: number): string {
  return count === 1 ? 'New reply' : `${count} new replies`;
}
