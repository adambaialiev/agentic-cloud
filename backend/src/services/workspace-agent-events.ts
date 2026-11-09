import type { OrgStorage } from './org-storage.js';
import { orgKnowledgeShelfNamespace } from './org-git.js';
import type { UserStorage } from './user-storage.js';
import type { QuickNoteStorage } from './quick-note-storage.js';
import type { GitPullRequestStorage } from './git-pr-storage.js';
import type { GitCommitStatusStorage } from './git-commit-status-storage.js';
import type { KnowledgeProposalStorage } from './knowledge-storage.js';
import type { RecapConversation } from '../shared/workspace-recap-chat.js';
import type { AgentRecord } from '../types/user.js';
import type { MailArrival } from '../types/mail-arrival.js';
import { isWorkspaceAgent } from '../types/user.js';
import { effectiveStatusState } from '../types/git-commit-status.js';
import { pullRequestAwaitsDecision } from '../types/git-pr.js';
import { QUICK_NOTE_AUTHOR_USER, quickNoteIsArchived, quickNoteTitle } from '../types/quick-note.js';
import { resolveQuickNoteWorkMap } from './quick-note-work.js';
import { workspaceRoutePath } from '../shared/workspace-routes.js';
import {
  dayIn,
  inQuietHours,
  QUIET_HOURS_EXEMPT,
  resolveWorkspaceAgentProactive,
  type WorkspaceAgentEvent,
  type WorkspaceAgentProactive,
} from '../shared/workspace-agent-proactive.js';

/**
 * Event turns (note #716): what the platform notices for one person's Chief
 * of Staff, and the sweep that hands it over.
 *
 * DETECTION IS BY STATE, NOT BY HOOK. Most of these events are a state that
 * has held for a while — a proposal waiting a day, a note unclaimed for two —
 * and no write happens at the moment they become true, so a sweep is the only
 * thing that can see them. The sweep re-reads the workplace every
 * {@link EVENT_SWEEP_INTERVAL_MS}; the writes that make an event at once (a
 * turn ending, a check landing) NUDGE it for the people concerned, so a red
 * build or a failed turn is seen in about a minute rather than at the next
 * tick. Mail is the one event that is not a state at all: its arrival is
 * handed over directly ({@link WorkspaceAgentEventSweep.mailArrived}).
 *
 * ONCE PER CAUSE PER DAY. Every event names its cause with a key, and a key
 * that already started a turn in the last day is never handed over again (the
 * ledger on the membership). A key names its episode: a red sha, one report,
 * one letter, one note; a state that persists and is worth a daily reminder —
 * a proposal still waiting — carries the day in its key.
 *
 * Everything new in one sweep is ONE turn: the conversation lands each event
 * as its own row and reacts to them together.
 */

/** How often every person with event turns on is swept. */
export const EVENT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** How long after boot the first sweep runs: the turns a restart recovered come first. */
export const EVENT_SWEEP_BOOT_DELAY_MS = 3 * 60 * 1000;
/** How long a nudge waits, so a burst of writes is one sweep. */
export const EVENT_NUDGE_DEBOUNCE_MS = 45 * 1000;
/** How long a cause is remembered: "once per day" for most, and the memory
 *  that keeps a note's once-only event from coming back every day. */
export const EVENT_LEDGER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many events in one turn; the rest wait for the next sweep. */
export const EVENTS_PER_TURN = 8;
/** A room agent's failed turn reads as this in its chat (background-runner). */
export const FAILED_TURN_PREFIX = 'The delegated session encountered an error.';
/** Letters held through quiet hours, per person, in memory. */
const HELD_MAIL_MAX = 20;

/** A room agent's newest chat message, of either voice. */
export interface LatestChatRow { role: 'owner' | 'agent' | 'platform'; text: string; at: string; seq: number }

export interface WorkspaceAgentEventDeps {
  orgStorage: Pick<OrgStorage, 'listOrgs' | 'getOrg' | 'listMembers' | 'getMembership' | 'touchMember' | 'listMembershipsByUser' | 'getRecapChat'>;
  userStorage: Pick<UserStorage, 'getProfile'>;
  quickNoteStorage?: Pick<QuickNoteStorage, 'listByUser'>;
  gitPullRequestStorage?: GitPullRequestStorage;
  gitCommitStatusStorage?: GitCommitStatusStorage;
  knowledgeProposalStorage?: Pick<KnowledgeProposalStorage, 'listByUser'>;
  /** The newest owner-or-agent row of a room agent's chat (a fresh-chat divider ends it). */
  latestChatRow?(userId: string, agentId: string): Promise<LatestChatRow | null>;
  isAgentWorking?(userId: string, agentId: string): boolean;
  /** Who holds a mail address, and which agent (if any) its letters wake. */
  mailHolderOf?(address: string): Promise<string | null>;
  mailWakeAgentOf?(userId: string): Promise<string | null>;
  /** The conversation: lands the events and starts the turn. */
  receiveEvents(args: { userId: string; orgId: string; events: WorkspaceAgentEvent[] }): Promise<boolean>;
  now?(): Date;
}

/** What one person's sweep needs to know besides the stores. */
export interface EventMemberContext {
  userId: string;
  orgId: string;
  settings: WorkspaceAgentProactive;
  /** The person's own agents in this workplace, the Workspace Agent included. */
  agents: AgentRecord[];
  /** The workplace's own namespace, where every note stands (note #843). */
  workplaceNamespace: string;
  /** Its old rooms' namespaces, walked for the proposals still recorded at them. */
  formerNamespaces?: string[];
  conversation: RecapConversation | undefined;
  now: Date;
}

const hoursSince = (iso: string | undefined, now: Date): number => {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? (now.getTime() - at) / 3_600_000 : 0;
};
const quote = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const ago = (hours: number): string => (hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.floor(hours)} hours`);

/**
 * Every event that holds for one person right now, before the once-a-day
 * rule and quiet hours are applied. Reads only the person's own agents'
 * proposals and chats and the workplace's notes; never a teammate's chat.
 */
export async function collectWorkspaceAgentEvents(deps: WorkspaceAgentEventDeps, member: EventMemberContext): Promise<WorkspaceAgentEvent[]> {
  const { userId, orgId, settings, now } = member;
  const events: WorkspaceAgentEvent[] = [];
  const day = dayIn(settings.timeZone, now);
  const own = new Map(member.agents.map((agent) => [agent.id, agent]));
  const nameOf = (agentId: string | undefined) => {
    const agent = agentId ? own.get(agentId) : undefined;
    return agent ? (isWorkspaceAgent(agent) ? 'the Chief of Staff' : agent.name) : 'an agent';
  };
  const ownProposal = (doc: { createdByUserId?: string; createdByAgentId: string }) => (
    doc.createdByUserId ? doc.createdByUserId === userId : own.has(doc.createdByAgentId)
  );
  const working = (agentId: string) => Boolean(deps.isAgentWorking?.(userId, agentId));

  // A workplace is one place (note #843): its namespace first, with the
  // notes, then its old rooms' namespaces for proposals still standing there.
  const workplace = member.workplaceNamespace;
  const places = [workplace, ...new Set((member.formerNamespaces ?? []).filter((namespace) => namespace !== workplace))];
  for (const namespace of places) {
    const notesHere = namespace === workplace;
    // Proposals: red checks, and a decision that has waited.
    const prs = await deps.gitPullRequestStorage?.listOpenByUser(namespace).catch(() => []) ?? [];
    for (const pr of prs) {
      if (pr.status !== 'open' || !ownProposal(pr)) continue;
      const href = workspaceRoutePath({ kind: 'pr', id: pr.id }) ?? undefined;
      const statuses = deps.gitCommitStatusStorage ? await deps.gitCommitStatusStorage.listBySha(pr.repoId, pr.headSha).catch(() => []) : [];
      const failed = statuses.filter((status) => {
        const state = effectiveStatusState(status, now);
        return state === 'failure' || state === 'error';
      });
      // An author still working is most likely fixing it; its turn ending
      // nudges the next sweep. A draft is still its author's business.
      if (failed.length && !pr.draft && !working(pr.createdByAgentId)) {
        events.push({
          kind: 'checks-red', key: `checks-red:${pr.id}:${pr.headSha}`,
          text: `Checks failed on proposal #${pr.number} "${quote(pr.title, 80)}" by ${nameOf(pr.createdByAgentId)}: ${failed.map((s) => s.context).join(', ')}.`,
          at: failed.map((s) => s.completedAt ?? s.startedAt).sort().at(-1) ?? now.toISOString(), ...(href ? { href } : {}),
        });
      }
      const since = pr.readyAt ?? pr.createdAt;
      const waited = hoursSince(since, now);
      if (pullRequestAwaitsDecision(pr) && waited >= settings.thresholds.proposalHours) {
        events.push({
          kind: 'proposal-waiting', key: `proposal-waiting:${pr.id}:${day}`,
          text: `Proposal #${pr.number} "${quote(pr.title, 80)}" by ${nameOf(pr.createdByAgentId)} has waited ${ago(waited)} for your decision.`,
          at: since, ...(href ? { href } : {}),
        });
      }
    }
    const kps = await deps.knowledgeProposalStorage?.listByUser(namespace).catch(() => []) ?? [];
    for (const kp of kps) {
      if (kp.status !== 'open' || kp.draft || !ownProposal(kp)) continue;
      const since = kp.readyAt ?? kp.createdAt;
      const waited = hoursSince(since, now);
      if (waited < settings.thresholds.proposalHours) continue;
      const href = workspaceRoutePath({ kind: 'knowledge', id: kp.id }) ?? undefined;
      events.push({
        kind: 'proposal-waiting', key: `proposal-waiting:kp:${kp.id}:${day}`,
        text: `Knowledge proposal #${kp.number} "${quote(kp.title, 80)}" by ${nameOf(kp.createdByAgentId)} has waited ${ago(waited)} for your decision.`,
        at: since, ...(href ? { href } : {}),
      });
    }
    // Notes the person (or their Chief of Staff) asked for that nobody picked up.
    // An agent's own note is usually a report or a plan, not a request.
    const notes = (!notesHere ? [] : await deps.quickNoteStorage?.listByUser(namespace).catch(() => []) ?? [])
      .filter((note) => !quickNoteIsArchived(note) && hoursSince(note.createdAt, now) >= settings.thresholds.noteHours)
      .filter((note) => (note.createdByAgentId === QUICK_NOTE_AUTHOR_USER && (!note.createdByUserId || note.createdByUserId === userId))
        || (own.has(note.createdByAgentId) && isWorkspaceAgent(own.get(note.createdByAgentId)!)));
    if (notes.length) {
      const work = await resolveQuickNoteWorkMap({ notes, pullRequests: deps.gitPullRequestStorage, commitStatuses: deps.gitCommitStatusStorage, now }).catch(() => new Map());
      for (const note of notes) {
        if ((work.get(note.id)?.state ?? 'unclaimed') !== 'unclaimed') continue;
        const href = workspaceRoutePath({ kind: 'note', id: String(note.number), orgId }) ?? undefined;
        events.push({
          kind: 'note-unclaimed', key: `note-unclaimed:${note.id}`,
          text: `Note #${note.number} "${quote(quickNoteTitle(note.html), 80)}" has been unclaimed for ${ago(hoursSince(note.createdAt, now))}.`,
          at: note.createdAt, ...(href ? { href } : {}),
        });
      }
    }
  }

  // The person's room agents: a turn that failed, a report nobody answered.
  const conversation = member.conversation;
  for (const agent of member.agents) {
    if (isWorkspaceAgent(agent) || agent.purpose || working(agent.id) || !deps.latestChatRow) continue;
    const latest = await deps.latestChatRow(userId, agent.id).catch(() => null);
    if (!latest || latest.role !== 'agent') continue;
    if (latest.text.startsWith(FAILED_TURN_PREFIX)) {
      // Only a recent failure: an old one is history the person has seen.
      if (hoursSince(latest.at, now) > 24) continue;
      events.push({
        kind: 'turn-failed', key: `turn-failed:${agent.id}:${latest.seq}`,
        text: `${agent.name}'s last turn failed: ${quote(latest.text.slice(FAILED_TURN_PREFIX.length)) || 'no reason given'}.`,
        at: latest.at,
      });
      continue;
    }
    const waited = hoursSince(latest.at, now);
    if (waited < settings.thresholds.reportHours) continue;
    // An answer the agent also sent the Chief of Staff was already read there.
    const answeredHere = conversation?.messages.some((m) => m.role === 'agent' && m.name === agent.name && Math.abs(Date.parse(m.at) - Date.parse(latest.at)) < 15 * 60_000);
    if (answeredHere) continue;
    events.push({
      kind: 'report-unanswered', key: `report-unanswered:${agent.id}:${latest.seq}`,
      text: `${agent.name} reported "${quote(latest.text)}" ${ago(waited)} ago, and you have not answered in its chat.`,
      at: latest.at,
    });
  }
  // An agent the Chief of Staff waited for that never answered.
  for (const silent of conversation?.silent ?? []) {
    if (hoursSince(silent.at, now) > 24) continue;
    events.push({
      kind: 'no-reply', key: `no-reply:${silent.agentId}:${day}`,
      text: silent.cut
        ? `${silent.name} stopped working without sending back the answer the Chief of Staff was waiting for; its turn may have been cut short.`
        : `${silent.name} finished without sending back the answer the Chief of Staff was waiting for.`,
      at: silent.at,
    });
  }
  return events;
}

/**
 * The events that may start a turn now: a cause the ledger has not seen, and
 * outside quiet hours unless exempt. A key names its episode, so a key is
 * handed over ONCE while the ledger remembers it; what persists and is worth
 * a daily word carries the day in its key, which is what makes it "once a
 * day" rather than once.
 */
export function eventsDue(events: WorkspaceAgentEvent[], ledger: Record<string, string> | undefined, settings: WorkspaceAgentProactive, now: Date): WorkspaceAgentEvent[] {
  const quiet = inQuietHours(settings, now);
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    if (ledger?.[event.key]) return false;
    return !quiet || QUIET_HOURS_EXEMPT.has(event.kind);
  }).slice(0, EVENTS_PER_TURN);
}

/** The ledger with these causes recorded and anything older than the keep window dropped. */
export function recordInLedger(ledger: Record<string, string> | undefined, events: WorkspaceAgentEvent[], now: Date): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, at] of Object.entries(ledger ?? {})) {
    if (now.getTime() - Date.parse(at) < EVENT_LEDGER_KEEP_MS) next[key] = at;
  }
  for (const event of events) next[event.key] = now.toISOString();
  return next;
}

/**
 * The sweep: every person who turned event turns on and has started their
 * Workspace Agent, on a timer and when nudged.
 */
export class WorkspaceAgentEventSweep {
  private timer?: ReturnType<typeof setInterval>;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private readonly nudges = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly heldMail = new Map<string, WorkspaceAgentEvent[]>();
  constructor(private readonly deps: WorkspaceAgentEventDeps) {}
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  start(): void {
    if (this.timer) return;
    this.bootTimer = setTimeout(() => { void this.sweepAll(); }, EVENT_SWEEP_BOOT_DELAY_MS);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => { void this.sweepAll(); }, EVENT_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    console.log(`[workspace-agent-events] sweeping every ${EVENT_SWEEP_INTERVAL_MS / 60_000} minutes`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    for (const handle of this.nudges.values()) clearTimeout(handle);
    this.nudges.clear();
    this.timer = undefined;
  }

  /** Something changed for this person: sweep them soon, once for a burst. Every workplace of theirs when none is named. */
  nudge(userId: string, orgId?: string | null): void {
    const key = `${userId}/${orgId ?? '*'}`;
    if (this.nudges.has(key)) return;
    const handle = setTimeout(() => {
      this.nudges.delete(key);
      void (async () => {
        const orgs = orgId ? [orgId] : (await this.deps.orgStorage.listMembershipsByUser(userId).catch(() => [])).map((m) => m.orgId);
        for (const org of orgs) await this.sweepMember(userId, org);
      })().catch((error) => console.warn(`[workspace-agent-events] nudge for ${userId} failed:`, error));
    }, EVENT_NUDGE_DEBOUNCE_MS);
    handle.unref?.();
    this.nudges.set(key, handle);
  }
  /** Something changed in a workplace (a check landed): sweep each member who turned event turns on. */
  nudgeOrg(orgId: string | null | undefined): void {
    if (!orgId) return;
    void this.deps.orgStorage.listMembers(orgId).then((members) => {
      for (const member of members) if (member.workspaceAgentProactive?.events) this.nudge(member.userId, orgId);
    }).catch(() => {});
  }

  async sweepAll(): Promise<void> {
    const orgs = await this.deps.orgStorage.listOrgs().catch(() => []);
    for (const org of orgs) {
      if (org.deletion) continue;
      const members = await this.deps.orgStorage.listMembers(org.orgId).catch(() => []);
      for (const member of members) {
        if (!member.workspaceAgentProactive?.events) continue;
        await this.sweepMember(member.userId, org.orgId).catch((error) => console.warn(`[workspace-agent-events] ${member.userId}/${org.orgId} sweep failed:`, error));
      }
    }
  }

  /** One person in one workplace: collect, apply the rules, hand over. Resolves how many events started a turn. */
  sweepMember(userId: string, orgId: string, extra: WorkspaceAgentEvent[] = []): Promise<number> {
    const key = memberKey(userId, orgId);
    const before = this.inFlight.get(key);
    const run = (async () => {
      await before?.catch(() => 0);
      return this.sweepOnce(userId, orgId, extra);
    })();
    this.inFlight.set(key, run);
    return run.finally(() => { if (this.inFlight.get(key) === run) this.inFlight.delete(key); });
  }

  private async sweepOnce(userId: string, orgId: string, extra: WorkspaceAgentEvent[]): Promise<number> {
    const member = await this.deps.orgStorage.getMembership(orgId, userId).catch(() => null);
    if (!member) return 0;
    const settings = resolveWorkspaceAgentProactive(member.workspaceAgentProactive);
    if (!settings.events) return 0;
    const profile = await this.deps.userStorage.getProfile(userId).catch(() => null);
    const agents = Object.values(profile?.telegram?.agents ?? {}).filter((agent) => agent.orgId === orgId && agent.sealed !== 'guest');
    // Never started: an event must not build a machine nobody asked for.
    if (!agents.some(isWorkspaceAgent)) return 0;
    const now = this.now();
    const org = await this.deps.orgStorage.getOrg(orgId).catch(() => null);
    if (!org) return 0;
    const collected = await collectWorkspaceAgentEvents(this.deps, {
      userId, orgId, settings, agents,
      workplaceNamespace: orgKnowledgeShelfNamespace(org), formerNamespaces: org.roomsMerged?.namespaces ?? [],
      conversation: (await this.deps.orgStorage.getRecapChat(orgId, userId).catch(() => null)) ?? undefined, now,
    });
    const quiet = inQuietHours(settings, now);
    const stored = this.heldMail.get(memberKey(userId, orgId)) ?? [];
    const due = eventsDue([...extra, ...(quiet ? [] : stored), ...collected], member.workspaceAgentEventLedger, settings, now);
    // A letter is the one event no sweep finds again: one that did not make
    // this turn — quiet hours, or past the turn's cap — waits in memory for
    // the next.
    const handed = new Set(due.map((event) => event.key));
    const waiting = [...stored, ...extra].filter((event, i, all) => !handed.has(event.key) && !member.workspaceAgentEventLedger?.[event.key]
      && all.findIndex((other) => other.key === event.key) === i);
    if (waiting.length) this.heldMail.set(memberKey(userId, orgId), waiting.slice(-HELD_MAIL_MAX));
    else this.heldMail.delete(memberKey(userId, orgId));
    if (!due.length) return 0;
    // The ledger first: a turn that fails to start is not retried every ten
    // minutes, and a crash mid-hand-over cannot hand the same cause twice.
    await this.deps.orgStorage.touchMember(orgId, userId, { workspaceAgentEventLedger: recordInLedger(member.workspaceAgentEventLedger, due, now) });
    const started = await this.deps.receiveEvents({ userId, orgId, events: due }).catch((error) => {
      console.warn(`[workspace-agent-events] ${userId}/${orgId} could not start an event turn:`, error);
      return false;
    });
    console.info(`[workspace-agent-events] ${userId}/${orgId}: ${due.length} event(s) ${started ? 'handed over' : 'not handed over'} (${due.map((e) => e.kind).join(', ')})`);
    return started ? due.length : 0;
  }

  /**
   * A letter arrived (note #716). Handed over at once — in each workplace
   * where its holder turned event turns on — unless a room agent already
   * wakes for their mail, in which case that agent has it. Inside quiet hours
   * it waits, in memory, for them to end.
   */
  async mailArrived(arrival: MailArrival, opts: { suspicious?: boolean } = {}): Promise<void> {
    const userId = await this.deps.mailHolderOf?.(arrival.address).catch(() => null);
    if (!userId) return;
    if (await this.deps.mailWakeAgentOf?.(userId).catch(() => null)) return;
    const from = arrival.fromName ? `${arrival.fromName} <${arrival.from ?? 'unknown'}>` : arrival.from ?? 'an unknown sender';
    const href = workspaceRoutePath({ kind: 'mailMessage', id: arrival.id }) ?? undefined;
    const event: WorkspaceAgentEvent = {
      kind: 'mail', key: `mail:${arrival.id}`,
      text: `A letter arrived from ${from}: "${quote(arrival.subject || '(no subject)', 100)}"${opts.suspicious ? ' — the checks marked it suspicious' : ''}.`,
      at: arrival.receivedAt, ...(href ? { href } : {}),
    };
    const memberships = await this.deps.orgStorage.listMembershipsByUser(userId).catch(() => []);
    for (const membership of memberships) {
      if (!membership.workspaceAgentProactive?.events) continue;
      await this.sweepMember(userId, membership.orgId, [event]).catch(() => 0);
    }
  }

  /**
   * A schedule stopped itself (note #779): the cap for the day, three
   * failed ticks, or a subscription with no room. One quiet event turn, in
   * the workplace the schedule lives in, when its owner has event turns on
   * — an ordinary tick never comes here, or the Chief of Staff's chat
   * becomes the show's log.
   */
  async scheduleEvent(userId: string, orgId: string, event: WorkspaceAgentEvent): Promise<number> {
    const membership = await this.deps.orgStorage.getMembership(orgId, userId).catch(() => null);
    if (!membership?.workspaceAgentProactive?.events) return 0;
    return this.sweepMember(userId, orgId, [event]).catch(() => 0);
  }
}

const memberKey = (userId: string, orgId: string) => `${orgId}/${userId}`;
