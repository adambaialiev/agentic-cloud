import { useState } from 'react';
import type {
  WorkspaceChatMessage,
  WorkspaceKnowledgePageRow,
  WorkspaceNoteRow,
  WorkspaceOrgMember,
  WorkspaceProposalRow,
  WorkspaceSiteRow,
} from '../../backend/src/shared/workspace-api';
import { ChatMessageRow } from '../../backend/workspace-ui/src/screens/chat/ChatMessageRow';
import { AgentRow } from '../../backend/workspace-ui/src/screens/home/Agents';
import { ProposalRow } from '../../backend/workspace-ui/src/screens/home/Decisions';
import { KnowledgeRow } from '../../backend/workspace-ui/src/screens/knowledge/KnowledgeRow';
import { SiteRow } from '../../backend/workspace-ui/src/screens/home/Sites';
import { agentRuntimeLine } from '../../backend/workspace-ui/src/screens/home/agent-words';
import { NoteRow } from '../../backend/workspace-ui/src/screens/notes/NoteRow';
import { PersonFacesPlate } from '../../backend/workspace-ui/src/screens/org/PersonFacesPlate';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { AgentName } from '../../backend/workspace-ui/src/ui/AgentName';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import { useNow } from '../../backend/workspace-ui/src/ui/time';
import type { HomeAgent } from '../../backend/workspace-ui/src/workspace/live';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HERO_FLEET_BEYOND, HOUR, JAMES, MINUTE, ago, useHydrated, useRunningFleet } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * The hero's picture since note #185 (the owner, 2026-10-08): one row of
 * cards that never stops moving — the people, their agents, and what passes
 * between them in a working day. A proposal, a knowledge page, a site
 * going live, a note handed to an agent, one agent writing to another.
 *
 * Every card is the Workspace's own row component, as on the rest of the page
 * (see live/fixture.ts): the person and agent plates from Home, the decision
 * queue's two rows, the Sites card's row, a note row, and a peer's bubble in
 * an agent's chat. A row Home lists in a card stands in a card of its own,
 * and names itself as it does on Home: by its glyph, with no heading.
 *
 * Who is in it is one person and the team he runs: James, wearing the faces
 * of his eighteen agents, then eight of them, with what passed between them
 * in among them. It was four people, each before their own agents, until
 * inviting was switched off and a workplace became one person's (notes #205
 * and #206); the person plate draws no role, as the app's does while
 * inviting is off.
 *
 * The motion is CSS only (.landing-marquee in index.css). The row is drawn
 * three times and the track slides by exactly one copy, so the seam is
 * invisible: it opens on the middle copy, level with the headline, with the
 * one before it filling the gutter and the one after it still running past
 * the right edge when the loop comes round. A reader who asked their system
 * for less motion gets that first frame, standing still; a pointer resting
 * on the row holds it, so a card can be read. The whole panel is inert and
 * hidden from assistive readers like every other, so the copies are for the
 * eye alone; the sentence before the panel says what the row shows, once.
 *
 * No ids: the row is drawn three times, and the app's sections carry ids
 * that the page's other panels also use (landing-live-panels, "One id per
 * page"). So it draws the rows, not the sections: the same row components
 * the sections are made of, in the sections' own classes.
 */

const PROPOSAL: WorkspaceProposalRow = {
  id: 'pr_41',
  number: 41,
  repoName: 'northstar-routing',
  title: 'Batch route optimiser for the routing service',
  body: null,
  from: 'batch-optimiser',
  to: 'main',
  diffStat: { insertions: 1240, deletions: 86 },
  status: 'open',
  createdAt: ago(3 * HOUR),
  decidedAt: null,
  agentName: 'Ruby',
  agentAvatarUrl: FACES.ruby,
  agentId: 'agent_ruby',
  userName: 'James',
  canDecide: true,
  checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
};

/* Otis's on-call page, live in knowledge: since note #746 a knowledge
   change lands at once and nobody decides it, so since note #1016 the row is
   the page itself (Home's KnowledgeRow), not a proposal waiting. */
const KNOWLEDGE_PAGE: WorkspaceKnowledgePageRow = {
  name: 'pipeline-on-call',
  title: 'On-call for the pings pipeline',
  description: 'What each alert means and what to do',
  sizeBytes: 4_200,
  sha: 'fixture-pipeline-on-call',
  updatedAt: ago(3 * HOUR),
  agentName: 'Otis',
  agentAvatarUrl: FACES.otis,
  agentId: 'agent_otis',
};

const SITE: WorkspaceSiteRow = {
  name: 'dispatch',
  url: 'https://dispatch.agents.northstar.com',
  preset: 'service',
  status: 'live',
  kind: 'service',
  agentName: 'Ada',
  agentAvatarUrl: FACES.ada,
  createdAt: ago(24 * DAY),
  lastDeployAt: ago(6 * HOUR),
};

/** James hands Mia — ready — the alert her last job set up the pipeline
 *  for. "Handed to", not "Working by": she has not started. */
const HANDOFF: WorkspaceNoteRow = {
  id: 'note_61',
  number: 61,
  title: 'Page on-call when a van stops pinging',
  preview: 'Ten minutes of silence from a van on shift should wake somebody up.',
  createdAt: ago(9 * MINUTE),
  updatedAt: ago(4 * MINUTE),
  byUser: true,
  authorName: 'James',
  authorPhotoUrl: FACES.jamesPerson,
  work: { state: 'handed', agentName: 'Mia', agentId: 'agent_mia' },
};

/** Ruby's question in Milo's chat, and his answer: the peer conversation the
 *  docs show (LivePeerChat), cut to the two lines that make it one. */
const MESSAGE_ROWS = (): WorkspaceChatMessage[] => [
  {
    seq: 1,
    // A peer's message is stored as a platform row that names its sender;
    // the row draws it as an incoming bubble with Ruby's face on it.
    role: 'platform',
    at: ago(2 * HOUR + 3 * MINUTE),
    text: 'Message from agent Ruby: Every route now ends with the leg back to the depot. Does billing count it?',
    fromAvatarUrl: FACES.ruby,
  },
  {
    seq: 2,
    role: 'agent',
    at: ago(2 * HOUR + 1 * MINUTE),
    text: 'Only the stops. Nothing changes on the invoice.',
  },
];

type Card =
  | { kind: 'person'; person: WorkspaceOrgMember }
  | { kind: 'agent'; id: string }
  | { kind: 'proposal' }
  | { kind: 'knowledge' }
  | { kind: 'site' }
  | { kind: 'handoff' }
  | { kind: 'message'; to: string };

const agent = (name: string): Card => ({ kind: 'agent', id: `agent_${name}` });

/** The person, then the agents, with what passed between them. A row Home
 *  lists is a third of a plate's height, so two of them share a place in the
 *  row, one over the other: every place stands as tall as a plate, and the
 *  row's edges stay level while it moves. */
const ROW: (Card | [Card, Card])[] = [
  { kind: 'person', person: JAMES }, agent('ruby'), agent('milo'), { kind: 'message', to: 'agent_milo' },
  agent('otis'), agent('theo'), [{ kind: 'proposal' }, { kind: 'knowledge' }],
  agent('ada'), [{ kind: 'site' }, { kind: 'handoff' }], agent('mia'), agent('nora'), agent('finn'),
];

/** One agent's chat, head and all, with the one exchange in it. The head is
 *  the chat screen's own markup minus its ids, as in LiveChat. The bubbles
 *  carry a local clock, so they arrive with hydration (landing-live-panels). */
function Exchange({ agent: to }: { agent: HomeAgent }) {
  const hydrated = useHydrated();
  const [rows] = useState(MESSAGE_ROWS);
  return (
    <div className="card landing-marquee-chat">
      <div className="chathead">
        <div className="chatface">
          <ContextRing context={to.context}><AgentFace agent={to} /></ContextRing>
        </div>
        <div className="chatwho">
          <PanelTitle><AgentName agent={to} /></PanelTitle>
          <div className="sub chatruntime"><span>{agentRuntimeLine(to)}</span></div>
        </div>
      </div>
      <div className="chatlog">
        {hydrated
          ? rows.map((row) => (
            <ChatMessageRow
              key={row.seq}
              row={row}
              agentId={to.id}
              onOpenProposal={() => {}}
              onOpenFile={() => {}}
              onPictureLoaded={() => {}}
            />
          ))
          : null}
      </div>
    </div>
  );
}

function Drawn({ card, agents, now }: { card: Card; agents: HomeAgent[]; now: number }) {
  const byId = (id: string) => agents.find((one) => one.id === id)!;
  switch (card.kind) {
    case 'person':
      return <div className="plates"><PersonFacesPlate person={card.person} now={now} showRole={false} /></div>;
    case 'agent':
      return <div className="plates"><AgentRow agent={byId(card.id)} now={now} /></div>;
    case 'proposal':
      return <div className="card"><ProposalRow pr={PROPOSAL} /></div>;
    case 'knowledge':
      return <div className="card"><KnowledgeRow page={KNOWLEDGE_PAGE} now={now} /></div>;
    case 'site':
      return <div className="card"><SiteRow site={SITE} /></div>;
    case 'handoff':
      return <div className="card"><NoteRow note={HANDOFF} onOpen={() => {}} /></div>;
    case 'message':
      return <Exchange agent={byId(card.to)} />;
  }
}

function Cards({ agents, now }: { agents: HomeAgent[]; now: number }) {
  return ROW.map((place, index) => (Array.isArray(place)
    ? (
      <div key={index} className="landing-marquee-place is-pair">
        {place.map((card) => <Drawn key={card.kind} card={card} agents={agents} now={now} />)}
      </div>
    )
    : (
      <div key={index} className={`landing-marquee-place is-${place.kind}`}>
        <Drawn card={place} agents={agents} now={now} />
      </div>
    )));
}

export default function LiveMarquee({ className = '' }: { className?: string }) {
  const hydrated = useHydrated();
  const agents = useRunningFleet(HERO_FLEET_BEYOND);
  const now = useNow(hydrated);
  return (
    <LivePanel
      size="wide"
      className={`landing-marquee ${className}`}
      says="A moving row of the Workspace’s cards. James, who drives eighteen agents, then Ruby and Milo, both on Claude Code and mid-job, and Ruby asking Milo, in his chat, whether billing counts a van’s return leg, and his answer. Otis, on Codex and ready, and Theo, with Ruby’s proposal #41, the batch route optimiser, waiting for a decision, and Otis’s knowledge page, on-call for the pings pipeline, already live. Ada, on Codex, the dispatch app she published, and James handing Mia a note: page on-call when a van stops pinging. Then Mia, Nora and Finn."
    >
      <LiveWorkspace agents={agents} sites={[SITE]}>
        <div className="landing-marquee-track">
          {[0, 1, 2].map((copy) => (
            <div key={copy} className="landing-marquee-copy">
              <Cards agents={agents} now={now} />
            </div>
          ))}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
