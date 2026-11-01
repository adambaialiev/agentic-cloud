/**
 * The words and the order of the teammates' agents strip (`TeamAgents`),
 * kept apart from the component so both are tested without a screen.
 */

import type {
  WorkspaceKnowledgeProposalRow,
  WorkspaceProposalRow,
  WorkspaceTeamAgentRow,
} from '../../../../src/shared/workspace-api.js';

export interface TeamProposals {
  knowledge: WorkspaceKnowledgeProposalRow[];
  changes: WorkspaceProposalRow[];
}

export interface TeamGroup {
  owner: WorkspaceTeamAgentRow['owner'];
  agents: WorkspaceTeamAgentRow[];
  /** What this person's agents have made ready in the room and are waiting
   *  on them to decide — beside the agents, because it is theirs to decide. */
  proposals: TeamProposals;
}

/**
 * The room's open proposals that wait on SOMEBODY ELSE (note #652): the ones
 * the state already carries for this room with `canDecide` false — made
 * ready by a teammate's agent, in this room, and decided by the person who
 * drives it. Knowledge first, then changes, exactly as the reader's own queue
 * orders them, so the two lists read the same. A quiet proposal never reaches
 * the state, so none is here.
 */
export function teamProposals(
  prs: WorkspaceProposalRow[] | undefined,
  knowledgeProposals: WorkspaceKnowledgeProposalRow[] | undefined,
): TeamProposals {
  return {
    knowledge: (knowledgeProposals ?? []).filter((proposal) => proposal.canDecide === false),
    changes: (prs ?? []).filter((proposal) => proposal.canDecide === false),
  };
}

/**
 * One group per person, mid-turn agents (and their people) first, each
 * person's agents' proposals with them (the owner, on note #652: "if human
 * agents have proposal, let's colocate them with agents"). A proposal is
 * matched to its person through the agent that made it. One whose agent has
 * since left the room, or been deleted, still stands — under the person the
 * row can name, or under "A teammate" when it cannot — after everyone who is
 * here. Pure, so the order is tested without a screen.
 */
export function teamGroups(agents: WorkspaceTeamAgentRow[], proposals: TeamProposals = { knowledge: [], changes: [] }): TeamGroup[] {
  const byOwner = new Map<string, TeamGroup>();
  // A stable sort: within each half the server's order stands.
  const ordered = [...agents].sort((a, b) => Number(Boolean(b.working)) - Number(Boolean(a.working)));
  for (const agent of ordered) {
    const group = byOwner.get(agent.owner.userId);
    if (group) group.agents.push(agent);
    else byOwner.set(agent.owner.userId, { owner: agent.owner, agents: [agent], proposals: { knowledge: [], changes: [] } });
  }
  const ownerOfAgent = new Map<string, string>();
  for (const agent of agents) ownerOfAgent.set(agent.id, agent.owner.userId);
  const strays = new Map<string, TeamGroup>();
  const place = (agentId: string | undefined, userName: string | undefined): TeamProposals => {
    const ownerId = agentId ? ownerOfAgent.get(agentId) : undefined;
    const group = ownerId ? byOwner.get(ownerId) : undefined;
    if (group) return group.proposals;
    // Nobody here made it: a group of its own, named as well as the row can.
    const key = userName ?? '';
    const stray = strays.get(key);
    if (stray) return stray.proposals;
    const made: TeamGroup = {
      owner: { userId: `stray:${key}`, ...(userName ? { name: userName } : {}) },
      agents: [],
      proposals: { knowledge: [], changes: [] },
    };
    strays.set(key, made);
    return made.proposals;
  };
  for (const proposal of proposals.knowledge) place(proposal.agentId, undefined).knowledge.push(proposal);
  for (const proposal of proposals.changes) place(proposal.agentId, proposal.userName).changes.push(proposal);
  return [...byOwner.values(), ...strays.values()];
}

/** How many proposals a group holds. */
export function groupProposalCount(group: TeamGroup): number {
  return group.proposals.knowledge.length + group.proposals.changes.length;
}

/** "Leo, Dana's agent, working now" — everything the picture says. */
export function teamAgentLabel(agent: WorkspaceTeamAgentRow): string {
  const whose = agent.owner.name ? `${agent.owner.name}’s agent` : 'a teammate’s agent';
  const state = agent.working ? ', working now' : agent.status === 'setting-up' ? ', being set up' : '';
  return `${agent.name}, ${whose}${state}`;
}
