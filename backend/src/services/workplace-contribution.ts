import { LEADERBOARD_DAYS_FROM, leaderboardWeekStart } from '../shared/leaderboard.js';
import type {
  WorkspaceContributionChange,
  WorkspaceContributionNumbers,
  WorkspaceMemberContribution,
  WorkspaceMemberContributionAnswer,
} from '../shared/workspace-api.js';
import type { UserProfileDocument } from '../types/user.js';
import type { AgentWorkSpan, AgentWorkTotal } from './agent-work-ledger.js';
import type { TokenAgentOutput } from './agent-token-ledger.js';
import type { MergedProposalSummary } from './git-pr-storage.js';
import { agentOwners, proposalOwner } from './leaderboard.js';

/**
 * How long one read of a workplace's contributions is served before it is
 * read again: every reader's people tick (five seconds, usePeople) in that
 * window shares it, so a workplace's cost does not grow with its readers.
 */
export const CONTRIBUTION_FRESH_MS = 10_000;

/** One member, as a contribution needs them. */
export interface ContributionMember {
  userId: string;
  profile: UserProfileDocument | null;
  /** The workplace an agent with no `orgId` belongs to: their first
   *  membership's, as everywhere else people are counted. */
  legacyOrgId: string | null;
}

/** What a workplace's contributions read, each from the store that already
 *  keeps it — the builder page's ledgers, no table of their own. */
export interface ContributionSources {
  members(orgId: string): Promise<ContributionMember[]>;
  /** Every agent this person ever had credited, with its workplace and its
   *  lifetime (AgentWorkLedger.userTotals). */
  workTotals(userId: string): AgentWorkTotal[];
  /** Working time per agent from `sinceDay` on (AgentWorkLedger.agentsSince). */
  workSince(userIds: readonly string[], sinceDay: string): AgentWorkSpan[];
  /** Output tokens per agent and provider (AgentTokenLedger.agentOutput). */
  tokenOutput(userIds: readonly string[], sinceDay: string): TokenAgentOutput[];
  /** Every proposal merged in this workplace's repositories. */
  merged(orgId: string): Promise<MergedProposalSummary[]>;
  repoName(repoId: string): Promise<string | undefined>;
  now?: () => number;
}

/** One person's contribution to one workplace. */
export interface PersonContribution {
  week: WorkspaceContributionNumbers;
  allTime: WorkspaceContributionNumbers;
  /** This week's merged changes, newest first. */
  merged: WorkspaceContributionChange[];
}

/** One read of a workplace: each member's contribution, and the week. */
export interface WorkplaceContributionSnapshot {
  weekStart: string;
  byUser: ReadonlyMap<string, PersonContribution>;
}

const zero = (): WorkspaceContributionNumbers => ({ workingMs: 0, merged: 0, tokens: {} });

/**
 * Every member's contribution to a workplace (note #925, Adam, 31 Oct 2026:
 * "people see each other's contribution made by their agent … the
 * workplace should be able to transparently give this information real
 * time"): the builder page's numbers (services/leaderboard.ts), cut to ONE
 * workplace —
 * - agent hours: the working-time ledger, from agents credited under this
 *   workplace; the week from its day rows, all time from its month rows,
 *   which go back before the day rows began (the "Agents worked" row,
 *   note #644, is the same number);
 * - changes merged: proposals merged in this workplace's repositories whose
 *   proposing agent is theirs (`proposalOwner`, the builder page's rule);
 * - tokens written: OUTPUT per provider from the token ledger, from rows
 *   credited under this workplace, never added together.
 * An agent from before workplaces counts in its person's first one, as the
 * agent counts on these cards already do.
 *
 * Counts and titles only — never a word of an agent's chat. Read whole at
 * most every CONTRIBUTION_FRESH_MS per workplace and shared by every reader.
 */
export class WorkplaceContributions {
  private readonly cached = new Map<string, { at: number; snapshot: Promise<WorkplaceContributionSnapshot> }>();

  constructor(private readonly sources: ContributionSources) {}

  read(orgId: string): Promise<WorkplaceContributionSnapshot> {
    const now = this.now();
    const kept = this.cached.get(orgId);
    if (kept && now - kept.at < CONTRIBUTION_FRESH_MS) return kept.snapshot;
    for (const [old, entry] of this.cached) if (now - entry.at >= CONTRIBUTION_FRESH_MS) this.cached.delete(old);
    const snapshot = this.build(orgId, now);
    this.cached.set(orgId, { at: now, snapshot });
    // A failed read is not kept: the next reader tries again.
    snapshot.catch(() => { if (this.cached.get(orgId)?.snapshot === snapshot) this.cached.delete(orgId); });
    return snapshot;
  }

  private async build(orgId: string, now: number): Promise<WorkplaceContributionSnapshot> {
    const weekStart = leaderboardWeekStart(now);
    const weekFrom = `${weekStart}T00:00:00.000Z`;
    const members = await this.sources.members(orgId);
    const ids = members.map((member) => member.userId);
    const byUser = new Map<string, PersonContribution>();
    const contributionOf = (userId: string) => {
      let entry = byUser.get(userId);
      if (!entry) { entry = { week: zero(), allTime: zero(), merged: [] }; byUser.set(userId, entry); }
      return entry;
    };

    // Which agents work here, per person: the workplace the ledger credited
    // them under, else the one their record names, else — an agent from
    // before workplaces — their person's first.
    const here = new Map<string, Set<string>>();
    const names = new Map<string, string>();
    for (const member of members) {
      const agents = new Set<string>();
      const inThisOrg = (agentOrgId: string | null | undefined) => (
        agentOrgId ? agentOrgId === orgId : member.legacyOrgId === orgId
      );
      const records = member.profile?.telegram?.agents ?? {};
      const entry = contributionOf(member.userId);
      for (const total of this.sources.workTotals(member.userId)) {
        names.set(total.agentId, total.agentName);
        if (!inThisOrg(total.orgId ?? records[total.agentId]?.orgId)) continue;
        agents.add(total.agentId);
        entry.allTime.workingMs += total.ms;
      }
      for (const agent of Object.values(records)) {
        if (!agent) continue;
        names.set(agent.id, agent.name);
        if (inThisOrg(agent.orgId)) agents.add(agent.id);
      }
      here.set(member.userId, agents);
    }

    for (const span of this.sources.workSince(ids, weekStart)) {
      if (here.get(span.userId)?.has(span.agentId)) contributionOf(span.userId).week.workingMs += span.ms;
    }

    for (const row of this.sources.tokenOutput(ids, weekStart)) {
      if (!here.has(row.userId)) continue;
      const counted = row.orgId ? row.orgId === orgId : Boolean(here.get(row.userId)?.has(row.agentId));
      if (!counted) continue;
      const entry = contributionOf(row.userId);
      if (row.total > 0) entry.allTime.tokens[row.provider] = (entry.allTime.tokens[row.provider] ?? 0) + row.total;
      if (row.since > 0) entry.week.tokens[row.provider] = (entry.week.tokens[row.provider] ?? 0) + row.since;
    }

    const owners = agentOwners(members.map((member) => member.profile));
    const memberIds = new Set(ids);
    const thisWeek: Array<{ owner: string; doc: MergedProposalSummary }> = [];
    for (const doc of await this.sources.merged(orgId)) {
      const owner = proposalOwner(doc, owners);
      // A change by someone who has since left is theirs, not anyone here's.
      if (!owner || !memberIds.has(owner)) continue;
      const entry = contributionOf(owner);
      entry.allTime.merged += 1;
      if (doc.decidedAt >= weekFrom) {
        entry.week.merged += 1;
        thisWeek.push({ owner, doc });
      }
    }
    thisWeek.sort((a, b) => b.doc.decidedAt.localeCompare(a.doc.decidedAt) || b.doc.number - a.doc.number);
    const repos = new Map<string, Promise<string | undefined>>();
    for (const { owner, doc } of thisWeek) {
      if (!repos.has(doc.repoId)) repos.set(doc.repoId, this.sources.repoName(doc.repoId).catch(() => undefined));
      const repo = await repos.get(doc.repoId)!;
      const agentName = names.get(doc.createdByAgentId);
      contributionOf(owner).merged.push({
        id: doc.id,
        title: doc.title,
        at: doc.decidedAt,
        number: doc.number,
        ...(repo ? { repo } : {}),
        ...(agentName ? { agentName } : {}),
      });
    }

    return { weekStart, byUser };
  }

  private now(): number {
    return this.sources.now?.() ?? Date.now();
  }
}

/** A person's card's share of it: the week and its latest change. */
export function cardContribution(entry: PersonContribution | undefined): WorkspaceMemberContribution {
  if (!entry) return { week: zero() };
  return { week: entry.week, ...(entry.merged[0] ? { latest: entry.merged[0] } : {}) };
}

/** The member's screen's whole answer. */
export function memberContributionAnswer(
  snapshot: WorkplaceContributionSnapshot,
  userId: string,
): WorkspaceMemberContributionAnswer {
  const entry = snapshot.byUser.get(userId);
  return {
    weekStart: snapshot.weekStart,
    tokensFrom: LEADERBOARD_DAYS_FROM,
    week: entry?.week ?? zero(),
    allTime: entry?.allTime ?? zero(),
    merged: entry?.merged ?? [],
  };
}
