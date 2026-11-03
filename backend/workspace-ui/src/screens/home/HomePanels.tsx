/**
 * What the workplace holds, as Home's Workplace window shows it (note #715):
 * what belongs to the workplace and says the same thing to everyone in it.
 * It was the overview's workplace half (note #404) and, before 2026-10-10,
 * half of Home; the sections, their order and every id inside are kept,
 * because the harnesses, the stylesheet and the simulations key on them.
 *
 * Since note #960 (Adam, 3 Nov 2026) it is an INDEX: the agent counts (note
 * #614) and its people with what their agents are doing (2026-10-28) are
 * drawn in full, then one row per shelf (`WorkplaceIndex`) — direct
 * messages and mail, notes, Drive, repositories, knowledge, sites, buckets,
 * secrets, the Chief of Staff's own settings — each opening a screen of its
 * own, with the reader's auto-merge switch (note #944) and their
 * subscription plates kept in place. It had stacked every one of those
 * inline, most with no heading, and scrolled for four screens.
 *
 * There was a ROOM view beside it — a room's messages and decisions, its
 * briefing, and its Agents and Notes shelves under a selector — until rooms
 * left the product (note #843). The agents and what waits on the reader are
 * the agents picker's now (`AgentSwitch`), and the notes are the
 * workplace's, here. A personal workspace has no workplace and so no
 * windows: it draws every shelf as its one column (`OverviewScreen`,
 * `PersonalPanel` below).
 */

import { useWorkspace } from '../../workspace/useWorkspace.js';
import { workplaceHasTeam } from '../org/org-words.js';
import { sitesOf } from '../sites/site-words.js';
import { AgentActivity } from './AgentActivity.js';
import { Agents } from './Agents.js';
import { Decisions } from './Decisions.js';
import { HomeJoinRequests } from './HomeJoinRequests.js';
import { Knowledge } from './Knowledge.js';
import { Notes } from './Notes.js';
import { People } from './People.js';
import { Repositories } from './Repositories.js';
import { Secrets } from './Secrets.js';
import { Sites } from './Sites.js';
import { UnreadMessages } from './UnreadMessages.js';
import { useWorkspaceAgentDetails } from './workspace-agent-details.js';
import { Storage } from './Storage.js';
import { WorkplaceIndex } from './WorkplaceIndex.js';
import { machineSizeParts } from '../agent/machine-words.js';
import { agentStateLine } from './agent-words.js';

/** The Workplace window's content: the pulse and the people drawn in full,
 *  then the index of everything else, each row a screen of its own (note
 *  #960). */
export function WorkplacePanel({ orgId }: { orgId: string }) {
  const { state } = useWorkspace();
  // The Chief of Staff's own read, for its row's one line: the machine it
  // runs on. Its screen makes the same read and draws the rest.
  const agent = useWorkspaceAgentDetails(orgId, false);
  const machine = agent.data?.machine
    ? machineSizeParts(agent.data.machine).join(' · ')
    : agent.data ? agentStateLine(agent.data.agent).text : null;
  return (
    <div id="homeWorkplace">
      {/* How much is running right now is the first question the
          workplace answers, before anyone is named (note #614). */}
      <AgentActivity />
      {/* Who is driving it, and what their agents are doing (2026-10-28) —
          wherever the workplace can have a team: a workplace of one that
          nobody can join has nobody to list, and makes no read for it. */}
      {workplaceHasTeam(state?.org, state?.invitesClosed) ? <People /> : null}
      {/* A person waiting at the door: absent, not empty, when nobody
          waits. */}
      <HomeJoinRequests />
      <WorkplaceIndex orgId={orgId} agentState={machine} />
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
