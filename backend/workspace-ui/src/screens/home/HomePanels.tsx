/**
 * What the workplace holds, as Home's Workplace window shows it (note #715):
 * what belongs to the workplace and says the same thing to everyone in it.
 * It was the overview's workplace half (note #404) and, before 2026-10-10,
 * half of Home; the sections, their order and every id inside are kept,
 * because the harnesses, the stylesheet and the simulations key on them.
 *
 * The agent counts (note #614), its people and what their agents are doing
 * (2026-10-28, where it can have a team), the direct channels and join
 * requests (note #606), sign-ins, the notes (note #843), the shared Drive
 * (note #363), repositories, knowledge and sites (note #566), buckets (note
 * #768) and secrets (note #783) — then the Chief of Staff's own cards
 * (machine, versions, context), which stood at the foot of this half when it
 * was that agent's details page.
 *
 * There was a ROOM view beside it — a room's messages and decisions, its
 * briefing, and its Agents and Notes shelves under a selector — until rooms
 * left the product (note #843). The agents and what waits on the reader are
 * the agents picker's now (`AgentSwitch`), and the notes are the
 * workplace's, here. A personal workspace has no workplace and so no
 * windows: it draws every shelf as its one column (`OverviewScreen`,
 * `PersonalPanel` below).
 */

import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { SeatStrip } from '../../ui/SeatStrip.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { workplaceHasTeam } from '../org/org-words.js';
import { sitesOf } from '../sites/site-words.js';
import { AgentActivity } from './AgentActivity.js';
import { Agents } from './Agents.js';
import { AutoMerge } from './AutoMerge.js';
import { Decisions } from './Decisions.js';
import { Drive } from './Drive.js';
import { HomeJoinRequests } from './HomeJoinRequests.js';
import { HumanMessages } from './HumanMessages.js';
import { Knowledge } from './Knowledge.js';
import { Notes } from './Notes.js';
import { People } from './People.js';
import { Repositories } from './Repositories.js';
import { Secrets } from './Secrets.js';
import { Sites } from './Sites.js';
import { UnreadMessages } from './UnreadMessages.js';
import { WorkspaceAgentCards } from './WorkspaceAgentCards.js';
import { useWorkspaceAgentDetails } from './workspace-agent-details.js';
import { Storage } from './Storage.js';

/** The Workplace window's content. */
export function WorkplacePanel({ orgId }: { orgId: string }) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const agent = useWorkspaceAgentDetails(orgId, false);
  const hasSites = sitesOf(state).length > 0;
  return (
    <div id="homeWorkplace">
      {/* How much is running right now is the first question the
          workplace answers, before anyone is named (note #614). */}
      <AgentActivity />
      {/* Who is driving it, and what their agents are doing (2026-10-28) —
          wherever the workplace can have a team: a workplace of one that
          nobody can join has nobody to list, and makes no read for it. */}
      {workplaceHasTeam(state?.org, state?.invitesClosed) ? <People /> : null}
      {/* The ways one person reaches another (note #606). */}
      <HumanMessages />
      {/* A person waiting at the door: absent, not empty, when nobody
          waits. */}
      <HomeJoinRequests />
      <SeatStrip ids={{ section: 'seatsHomeSection', row: 'seatsHome' }} addIcon={false} />
      {/* The notes are the workplace's (note #843): one list, which was a
          room's shelf. Writing one opens the notes screen with the box up,
          as Add a secret opens the secrets screen with its form: this
          window has no pages of its own to draw a leaf in. */}
      <Notes onWrite={() => navigate(toFor({ kind: 'notes', orgId })!, { state: { compose: true } })} />
      {/* Drive, repositories, knowledge and sites belong to the workplace
          (notes #363, #566): every agent and every member reach all of
          them. Sites only once the workplace has one. */}
      <Drive />
      <Repositories />
      {/* The reader's own auto-merge (note #944): what happens to their
          agents' proposals, beside where those proposals land. */}
      <AutoMerge />
      <Knowledge />
      {hasSites ? <Sites /> : null}
      {/* Buckets only once the workplace has one (note #768). */}
      <Storage />
      {/* Secrets are one set for the workplace (note #783), like
          repositories: every agent is handed them. */}
      <Secrets />
      {/* The Chief of Staff's own cards close it: what the workplace's
          front door runs on, after what the workplace holds. */}
      <WorkspaceAgentCards orgId={orgId} details={agent} />
    </div>
  );
}

/** What a personal workspace's shelves open over it: a leaf with no address,
 *  which the screen holding them draws in its place. */
export interface PersonalLeaves {
  onWrite: () => void;
  onAddSecret: () => void;
}

/**
 * A personal workspace's one column (`OverviewScreen`): what needs the
 * reader (messages and decisions), then every shelf at once, repositories,
 * knowledge and sites among them because it has no Workplace to put them
 * in. It was a room's view, drawn untabbed, until rooms left the product
 * (note #843); the ids are the ones the stylesheet and the harnesses know.
 */
export function PersonalPanel({ leaves }: { leaves: PersonalLeaves }) {
  const { state } = useWorkspace();
  const hasSites = sitesOf(state).length > 0;
  return (
    <div id="homeRoom">
      {/* Messages and decisions are activity rather than a shelf: they
          stand first, so nothing below can hide a request that needs the
          reader. */}
      <div id="roomActivity">
        <UnreadMessages />
        <Decisions />
      </div>
      <div className="roomcontentpanel" id="roomContentPanel-agents"><Agents /></div>
      <div className="roomcontentpanel" id="roomContentPanel-notes"><Notes onWrite={leaves.onWrite} /></div>
      <div className="roomcontentpanel" id="roomContentPanel-repositories"><Repositories /></div>
      <div className="roomcontentpanel" id="roomContentPanel-knowledge"><Knowledge /></div>
      <div className="roomcontentpanel" id="roomContentPanel-secrets"><Secrets onAdd={leaves.onAddSecret} /></div>
      {hasSites ? <div className="roomcontentpanel" id="roomContentPanel-sites"><Sites /></div> : null}
      <div className="roomcontentpanel" id="roomContentPanel-storage"><Storage /></div>
    </div>
  );
}
