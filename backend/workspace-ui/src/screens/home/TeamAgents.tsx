/**
 * The OTHER members' agents, as one compact strip at the foot of the agents
 * picker (2026-09-23, the owner: "those agents should not be hidden from
 * other humans … even there, we should make some compact UI showing avatars
 * of other humans' agents existing and working in the room"). It stood at
 * the foot of a room's Agents tab, and named that room's, until rooms left
 * the product (note #843): it is every teammate's agent now.
 *
 * The list itself stays the reader's OWN fleet — every plate on it is a
 * control only its owner may use: a chat, a runtime, a machine. This strip is
 * the rest of the workplace at a glance, and nothing more: whose agents are here,
 * grouped under the person who drives them, and which of them is mid-turn
 * right now. Each face is a door to that agent's read-only page (note #640);
 * what it was asked to do stays between it and its owner (note #346), so no
 * recap and no activity line.
 *
 * It stands BELOW the reader's own fleet, after the creation door. The
 * teammates' agents are still easy to scan in one compact line, while the
 * fleet above remains the first and primary list. Its label is not a
 * heading, so the outline still begins at "Agents" and its counts still
 * describe only the reader's own plates.
 *
 * Absent when nobody else has an agent: an empty strip would be a label
 * announcing nothing in the one list a person opens to work.
 *
 * Mid-turn agents lead, their person with them, because the live tick is
 * what moves them and "who is working here now" is the question the strip
 * is for; everyone else keeps the server's most-recently-active order.
 *
 * One person per line, and under each person THEIR OPEN PROPOSALS (note
 * #652): what that person's agents have made ready and are waiting on them
 * to decide. They sit with the person rather than in a list
 * of their own, because whose they are is the first thing the reader wants
 * to know about one (the owner: "if human agents have proposal, let's
 * colocate them with agents"). The reader cannot decide one — Home's queue
 * is theirs alone — but a proposal is workplace business the moment it is
 * made ready: everyone reads it, everyone writes in its margin, and an agent
 * about to touch the same files should know it is there. The rows are the
 * queue's own, so a face, a branch and a check pip mean here what they mean
 * there; each opens the proposal, read-only for this reader. What the agent
 * was ASKED stays between it and its owner (note #346) — a proposal is what
 * it chose to show the workplace.
 */

import { useNavigate } from 'react-router-dom';
import { AgentFace } from '../../ui/AgentFace.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { useOrgId } from '../org/useOrgApi.js';
import { KnowledgeProposalRow, ProposalRow } from './Decisions.js';
import { groupProposalCount, teamAgentLabel, teamGroups, teamProposals } from './team-words.js';

export function TeamAgents() {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const orgId = useOrgId();
  const here = state?.teamAgents ?? [];
  // The state's proposal lists are the workplace's.
  const proposals = teamProposals(state?.prs, state?.knowledgeProposals);
  const proposed = proposals.knowledge.length + proposals.changes.length;
  // A proposal outlives the agent that made it, so the strip stands for the
  // proposals alone when it has to.
  if (!here.length && !proposed) return null;
  const working = here.filter((agent) => agent.working).length;
  const count = `${here.length} ${here.length === 1 ? 'agent' : 'agents'}`;
  const proposedCount = `${proposed} ${proposed === 1 ? 'proposal' : 'proposals'}`;
  const countLabel = [
    here.length ? count : '',
    working ? `${working} working now` : '',
    proposed ? `${proposedCount} awaiting their owners` : '',
  ].filter(Boolean).join(', ');
  return (
    <section id="teamAgents" className="teamagents" aria-label="Teammates’ agents">
      <div className="teamhead">
        <span className="teamtitle" aria-hidden="true">Teammates’ agents</span>
        <span className="teamcount" aria-label={countLabel}>
          {here.length ? <span>{count}</span> : null}
          {working ? <><span className="sep"> · </span><span className="active">{working} working</span></> : null}
          {proposed ? <>{here.length ? <span className="sep"> · </span> : null}<span>{proposedCount}</span></> : null}
        </span>
      </div>
      <ul className="teamgroups">
        {teamGroups(here, proposals).map((group) => (
          <li className="teamgroup" key={group.owner.userId} data-team-owner={group.owner.userId}>
            <div className="teamline">
              {/* The person is a door to their page (the owner, 2026-09-23),
                  as their face is everywhere else in the Workspace. A stray
                  group — a proposal whose agent is gone — has no real user
                  behind its name, so it is named and not a door. */}
              {orgId && !group.owner.userId.startsWith('stray:')
                ? (
                  <button
                    className="teamowner door"
                    type="button"
                    data-team-owner-door={group.owner.userId}
                    aria-label={`Open ${group.owner.name ?? 'this teammate'}`}
                    onClick={() => navigate(toFor({ kind: 'organizationMember', id: group.owner.userId, orgId })!)}
                  >
                    <span className="ownerface"><PersonFace photoUrl={group.owner.photoUrl} /></span>
                    <span className="ownername">{group.owner.name ?? 'A teammate'}</span>
                  </button>
                )
                : (
                  <span className="teamowner">
                    <span className="ownerface"><PersonFace photoUrl={group.owner.photoUrl} /></span>
                    <span className="ownername">{group.owner.name ?? 'A teammate'}</span>
                  </span>
                )}
              <span className="teamfaces">
                {group.agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`teamface${agent.working ? ' live' : ''}${agent.status === 'setting-up' ? ' coming' : ''}`}
                    type="button"
                    data-team-agent={agent.id}
                    aria-label={`${teamAgentLabel(agent)}. Open`}
                    title={teamAgentLabel(agent)}
                    onClick={() => navigate(toFor({ kind: 'agent', id: agent.id })!)}
                  >
                    <AgentFace agent={agent} />
                    {agent.working ? <span className="livedot" aria-hidden="true" /> : null}
                  </button>
                ))}
              </span>
            </div>
            {groupProposalCount(group)
              ? (
                <div
                  className="teamproposals"
                  role="group"
                  aria-label={`${group.owner.name ?? 'A teammate'}’s ${groupProposalCount(group) === 1 ? 'proposal' : 'proposals'}, awaiting them`}
                >
                  {group.proposals.changes.map((pr) => <ProposalRow key={pr.id} pr={pr} plain />)}
                  {group.proposals.knowledge.map((proposal) => <KnowledgeProposalRow key={proposal.id} proposal={proposal} plain />)}
                </div>
              )
              : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
