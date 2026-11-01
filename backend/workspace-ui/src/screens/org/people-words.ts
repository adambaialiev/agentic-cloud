/**
 * The words a person's row says on the People page (note #328), and the
 * pure half of keeping that page live. Functions over the member the server
 * sent; the components draw them — the same split the agent rows keep in
 * `agent-words.ts`, so a test can hold the rule without a DOM.
 */

import { harnessName } from '../../../../src/shared/harness-clis.js';
import type {
  WorkspaceContributionChange,
  WorkspaceContributionNumbers,
  WorkspaceMemberContribution,
  WorkspaceOrgMember,
  WorkspaceOrgMemberAgent,
  WorkspacePersonAgentLive,
  WorkspacePersonLive,
} from '../../../../src/shared/workspace-api.js';
import { durationWords, relative } from '../../ui/time.js';
import { formatHours, formatTokens } from '../people/board-words.js';

/** The state line: here right now, else when they were last, else when they
 *  joined — a fact in every case, never filler. */
export function personStatusLine(
  person: Pick<WorkspaceOrgMember, 'here' | 'lastSeenAt' | 'joinedAt'>,
  now = Date.now(),
): string {
  if (person.here) return 'Here now';
  if (person.lastSeenAt) {
    const when = relative(person.lastSeenAt, now);
    if (when) return `Active ${when}`;
  }
  const joined = relative(person.joinedAt, now);
  return joined ? `Joined ${joined}` : 'Just joined';
}

/**
 * WHEN the latest line happened, as an "ago" (note #385): "just now",
 * "5m ago", "3h ago", "2d ago". A recap is the record of ONE action, and an
 * action with no hour on it reads as now — "Messaged Ruby" says nothing about
 * whether the room is moving or was moving on Tuesday. '' when there is no
 * line to place; a stamp the clock cannot read, or one a second ahead of the
 * browser, reads as "just now" rather than vanishing, exactly as the agent
 * screen's own "Recap from" row treats it.
 */
export function personRecapAgo(
  person: Pick<WorkspaceOrgMember, 'recap' | 'recapAt'>,
  now = Date.now(),
): string {
  if (!person.recap || !person.recapAt) return '';
  return relative(person.recapAt, now) || 'just now';
}

/**
 * Whether any row on this list says something that MOVES — an "Active 4m ago",
 * a recap's "ago" or the latest merged change's (note #925) — and therefore whether the shared clock should tick
 * behind it. One rule for Home's deck, the People page and a member's own
 * screen: a stamp that stops counting is a stamp that lies, and three copies
 * of the condition is how one of them quietly stops.
 */
export function peopleClockMoves(
  people: Array<Pick<WorkspaceOrgMember, 'here' | 'lastSeenAt' | 'recap' | 'recapAt' | 'contribution'>>,
): boolean {
  return people.some((person) => (!person.here && Boolean(person.lastSeenAt))
    || Boolean(person.recap && person.recapAt)
    || Boolean(person.contribution?.latest));
}

/** The quiet line under the name — identity facts, where an agent's row
 *  says its runtime: the role, then how many agents they drive here. */
export function personFactsLine(
  person: Pick<WorkspaceOrgMember, 'role' | 'agents'>,
  { role = true }: { role?: boolean } = {},
): string {
  const agents = person.agents === 0 ? 'no agents' : personAgentCountLine(person.agents);
  // No role while inviting is switched off (note #205), so the agents lead.
  if (!role) return agents === 'no agents' ? 'No agents' : agents;
  return `${person.role === 'admin' ? 'Admin' : 'Member'} · ${agents}`;
}

/** How many agents somebody drives here, as the member's own screen says
 *  it (note #346). It shares its counting with `personFactsLine`, which says
 *  the same fact on the plate — one wording, two places. */
export function personAgentCountLine(agents: number): string {
  return agents === 0 ? 'No agents yet' : agents === 1 ? '1 agent' : `${agents} agents`;
}

/**
 * The agents somebody no longer has, whose hours are in their total — the
 * one place a deleted agent is still named, longest first: "including Ruby
 * 3h 10m and Max 12m, no longer here". '' when there are none.
 */
export function formerAgentsLine(person: Pick<WorkspaceOrgMember, 'formerAgents'>): string {
  const former = person.formerAgents ?? [];
  if (former.length === 0) return '';
  const parts = former.map((agent) => `${agent.name} ${durationWords(agent.workedMs)}`);
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `including ${list}, no longer here`;
}

/** "agents worked 41h 20m" — the workplace's whole working time (note #644),
 *  for the line under the People page's title. '' until an agent has. */
export function peopleWorkedLine(org: { workedMs?: number } | null): string {
  return org?.workedMs && org.workedMs > 0 ? `agents worked ${durationWords(org.workedMs)}` : '';
}

/** "3 people · 1 here now", "Just you" — the line under the page's title
 *  and on the workplace's door onto it. */
export function peopleSubLine(people: Array<Pick<WorkspaceOrgMember, 'here'>>): string {
  if (people.length <= 1) return 'Just you';
  const here = people.filter((person) => person.here).length;
  return `${people.length} people${here ? ` · ${here} here now` : ''}`;
}

/**
 * Fold one tick into the list: the live fields replace the row's, nothing
 * else moves. `changed` says whether any row differs, so a tick that found
 * the world still costs no repaint.
 *
 * A row the tick does not mention is a person who is no longer a member, and
 * it goes. The tick answers with every current member of the workplace it
 * was asked about — not only the ones whose facts moved — so absence here is
 * a fact and not a gap. Keeping those rows is how a removed member stayed on
 * an open People page, still reading "Here now", for as long as nobody
 * reloaded (the September 5 membership simulations).
 *
 * A tick that adds a row still cannot: a new member arrives with the next
 * full read, which is the only answer carrying their name, face and agents.
 */
export function applyPeopleLive(
  people: WorkspaceOrgMember[],
  live: WorkspacePersonLive[],
): { people: WorkspaceOrgMember[]; changed: boolean } {
  const fresh = new Map(live.map((person) => [person.userId, person]));
  let changed = false;
  const next: WorkspaceOrgMember[] = [];
  for (const person of people) {
    const tick = fresh.get(person.userId);
    if (!tick) { changed = true; continue; }
    const agents = tick.agents && person.agentFaces
      ? applyAgentsLive(person.agentFaces, tick.agents)
      : null;
    // Their week here (note #925) moves on the same tick; an older backend
    // sends none and the card keeps what the full read said.
    const contributed = tick.contribution && !sameContribution(tick.contribution, person.contribution);
    const row: WorkspaceOrgMember = {
      ...person,
      lastSeenAt: tick.lastSeenAt,
      here: tick.here,
      recap: tick.recap,
      recapAt: tick.recapAt,
      ...(agents?.changed ? { agentFaces: agents.agents, agents: agents.agents.length } : {}),
      ...(contributed ? { contribution: tick.contribution } : {}),
    };
    if (row.lastSeenAt !== person.lastSeenAt || row.here !== person.here
      || row.recap !== person.recap || row.recapAt !== person.recapAt || agents?.changed || contributed) {
      changed = true;
      next.push(row);
      continue;
    }
    next.push(person);
  }
  return { people: changed ? next : people, changed };
}

/**
 * Fold the tick's word on a person's agents into the ones the full read
 * named (2026-10-28): whether each is working, and its recap line. The tick
 * lists every agent the person drives here, so one it leaves out has gone;
 * one it adds is new, and waits for the next full read, the only answer
 * carrying its name and face.
 */
export function applyAgentsLive(
  agents: WorkspaceOrgMemberAgent[],
  live: WorkspacePersonAgentLive[],
): { agents: WorkspaceOrgMemberAgent[]; changed: boolean } {
  const fresh = new Map(live.map((agent) => [agent.id, agent]));
  let changed = false;
  const next: WorkspaceOrgMemberAgent[] = [];
  for (const agent of agents) {
    const tick = fresh.get(agent.id);
    if (!tick) { changed = true; continue; }
    if (tick.working === agent.working && tick.recap === agent.recap && tick.recapAt === agent.recapAt) {
      next.push(agent);
      continue;
    }
    changed = true;
    const rest: WorkspaceOrgMemberAgent = { ...agent };
    delete rest.working;
    delete rest.recap;
    delete rest.recapAt;
    next.push({
      ...rest,
      ...(tick.working ? { working: true as const } : {}),
      ...(tick.recap ? { recap: tick.recap } : {}),
      ...(tick.recapAt ? { recapAt: tick.recapAt } : {}),
    });
  }
  return { agents: changed ? next : agents, changed };
}

/** A person's agents as their plate lists them: the ones working right now
 *  first — "what is she running?" is the question the plate is read for —
 *  then the rest in the order the person made them. */
export function personAgentsInOrder(agents: WorkspaceOrgMemberAgent[]): WorkspaceOrgMemberAgent[] {
  return [...agents].sort((a, b) => Number(Boolean(b.working)) - Number(Boolean(a.working)));
}

/** An agent's state on a people surface, in two words: a turn is running,
 *  or it is waiting for its person. */
export function personAgentStateLine(agent: Pick<WorkspaceOrgMemberAgent, 'working'>): string {
  return agent.working ? 'Working' : 'Idle';
}

/** Who leads the list: the people here now, then the most recently seen,
 *  then the order they joined — as working agents lead the fleet. */
export function peopleInOrder(people: WorkspaceOrgMember[]): WorkspaceOrgMember[] {
  return [...people].sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here))
    || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
    || a.joinedAt.localeCompare(b.joinedAt));
}

/** Whether two readings of a person's week say the same: a tick that found
 *  nothing new repaints nothing. Small, flat objects, so their JSON is the
 *  comparison. */
function sameContribution(a: WorkspaceMemberContribution | undefined, b: WorkspaceMemberContribution | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** What a token number on a people surface is, in one line (the builder
 *  page's own hint, said of a teammate). */
export const CONTRIBUTION_TOKENS_HINT = 'Tokens written: what their agents wrote, not what they read.';

/** The providers a token count is kept apart for, in the order they are said. */
const TOKEN_PROVIDERS = ['claude', 'codex', 'opencode'] as const;

/** One figure of a contribution: the number, and what it counts. */
export interface ContributionStat {
  key: string;
  value: string;
  label: string;
}

/**
 * A contribution's figures, one grammar for all of them (note #928, Adam:
 * the first block "looks sloppy"): each a number over what it counts —
 * agent hours, changes merged, then tokens written as one figure per
 * provider that wrote any here ("2.1M" over "tokens · Claude Code"), never
 * added together. Every figure is said even at zero, and a week with no
 * tokens is one "0" over "tokens written" — a quiet week, not a gap.
 */
export function contributionStats(numbers: WorkspaceContributionNumbers): ContributionStat[] {
  const stats: ContributionStat[] = [
    { key: 'hours', value: formatHours(numbers.workingMs), label: 'agent hours' },
    { key: 'merged', value: String(numbers.merged), label: numbers.merged === 1 ? 'change merged' : 'changes merged' },
  ];
  const providers = TOKEN_PROVIDERS.filter((provider) => (numbers.tokens[provider] ?? 0) > 0);
  if (providers.length === 0) stats.push({ key: 'tokens', value: '0', label: 'tokens written' });
  for (const provider of providers) {
    stats.push({ key: provider, value: formatTokens(numbers.tokens[provider]!), label: `tokens\u00a0· ${harnessName(provider).replace(/ /g, '\u00a0')}` });
  }
  return stats;
}

/** When a change landed, as an "ago" — "just now" for a stamp a second
 *  ahead of the browser, as a recap's is. */
export function contributionChangeAgo(change: Pick<WorkspaceContributionChange, 'at'>, now = Date.now()): string {
  return relative(change.at, now) || 'just now';
}

/** Who made a change and where, under its title on a member's screen:
 *  "Leo · shop #12". */
export function contributionChangeFacts(change: WorkspaceContributionChange): string {
  const where = change.repo ? `${change.repo} #${change.number}` : `#${change.number}`;
  return change.agentName ? `${change.agentName} · ${where}` : where;
}
