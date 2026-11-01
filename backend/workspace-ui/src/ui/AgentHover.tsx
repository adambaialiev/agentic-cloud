/**
 * WHO is behind a face, raised on hover (note #295).
 *
 * The decision queue draws the proposing agent as a 16px picture on the line
 * under the title and says nothing else about it: not its name, not what it
 * runs, not whether it is at work right now. On a phone that is the right
 * trade — the row is a door, and the screen behind it writes all of it out —
 * but a desktop reader has a pointer and nothing to point it at. This is the
 * answer to pointing at the face.
 *
 * Every fact on the card is READ, not invented here: the name and the crown
 * from `AgentName`, the harness/model/effort line from the same helper the
 * fleet row wears, the working state from `agentPresence` — the same one
 * word, in the same colours, the agent's own header uses — and what the agent
 * most recently DID, from the same recap line as its row on Home (the owner,
 * on the proposal). That last one is the fact that tells one face from
 * another: `Felix · Claude Code · opus` names a runtime, not an agent. The
 * card is therefore live: the fleet it reads is the live-ticked one, so an
 * agent that starts a turn while the pointer rests on it turns Active under
 * it, and a recap that lands mid-hover lands here.
 *
 * Hover only, and only where hovering is a real gesture. The card is fixed
 * over the page and takes no pointer events of its own — it cannot swallow
 * the tap on the row it stands over, and it cannot chase the pointer off the
 * face and flicker — and a coarse pointer never sees it at all. Nothing on
 * it is unique to it: an agent's proposal screen names the agent and writes
 * its runtime under the signature, and its own screen says the rest. So a
 * reader with no mouse loses nothing, and the row keeps its one tab stop
 * rather than growing a second, per-row focus target for a duplicate fact.
 */

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceTeamAgentRow } from '../../../src/shared/workspace-api.js';
import { agentPresence, agentRecapLine, agentRuntimeLine } from '../screens/home/agent-words.js';
import type { HomeAgent } from '../workspace/live.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { AgentFace } from './AgentFace.js';
import { AgentName } from './AgentName.js';

/** Air between the face and the card, and the closest the card may come to
 *  the edge of the window. */
const GAP = 9;
const EDGE = 12;

/**
 * Put the card over the face it belongs to, in viewport coordinates.
 *
 * Written onto the node from its ref rather than held in state: whether the
 * card fits ABOVE the face depends on how tall the card came out, which is
 * knowable only once it is drawn — and a measured state write there repaints
 * the whole queue to move a box a reader has not seen yet. Above by
 * preference, because a card under the face covers the row below it, which
 * is the next thing the reader was about to read.
 */
function place(card: HTMLElement, anchor: DOMRect): void {
  const box = card.getBoundingClientRect();
  const above = anchor.top - GAP - box.height;
  const top = above >= EDGE
    ? above
    : Math.max(EDGE, Math.min(anchor.bottom + GAP, window.innerHeight - EDGE - box.height));
  // Left-aligned on the face, not centred on it: these faces sit at the left
  // of a 720px reading column, and a card centred on one hangs out over the
  // empty margin beside it. Anchored this way it opens INTO the column, where
  // the reader is already looking.
  const from = anchor.left - 10;
  const left = Math.max(EDGE, Math.min(from, window.innerWidth - EDGE - box.width));
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

/**
 * The card itself. An agent the fleet still has brings everything; one it
 * does not — erased since it proposed — keeps its name and its picture, and
 * the card says only what it can stand behind rather than filling the space
 * with a guess about a runtime nobody read.
 *
 * Another MEMBER'S agent (2026-09-23) is neither: the workplace knows whose
 * it is and whether it is at work right now, so the card says both — the
 * person who drives it where the runtime would stand, and the same presence
 * word — and leaves its runtime and recap to its own page.
 */
function AgentCard({ anchor, agent, teammate, name, avatarUrl }: {
  anchor: DOMRect;
  agent: HomeAgent | null;
  teammate: WorkspaceTeamAgentRow | null;
  name?: string | null;
  avatarUrl?: string;
}) {
  const runtime = agent
    ? agentRuntimeLine(agent)
    : teammate ? (teammate.owner.name ? `${teammate.owner.name}’s agent` : 'A teammate’s agent') : '';
  const presence = agent ? agentPresence(agent) : teammate ? agentPresence(teammate) : null;
  const recap = agent ? agentRecapLine(agent) : '';
  return (
    <div className="agentcard" role="tooltip" ref={(node) => { if (node) place(node, anchor); }}>
      <div className="agentcardwho">
        {/* The picture the reader is pointing at, drawn by the shared rule so
            a broken one falls back to the bot glyph here exactly as it does
            in the row — at 34px, where a face is a face and not a smudge. */}
        <AgentFace agent={{ avatarUrl: agent?.avatarUrl ?? teammate?.avatarUrl ?? avatarUrl, status: agent?.status ?? 'ready' }} />
        <div className="agentcardid">
          <div className="name plain">{agent ? <AgentName agent={agent} /> : teammate?.name ?? name}</div>
          {runtime ? <div className="cruntime">{runtime}</div> : null}
        </div>
      </div>
      {presence
        ? (
          <span className={`headstate ${presence.tone}`}>
            <span className="statedot" />
            <span className="statetext">{presence.label}</span>
          </span>
        )
        : null}
      {/* Last, in the order the fleet row reads: what it is, then what state
          it is in, then what it has been doing. An agent with nothing to
          report gets no empty line for it. */}
      {recap ? <div className="cabout">{recap}</div> : null}
    </div>
  );
}

/**
 * Wraps a face — a bare picture, or the button one that opens the agent —
 * and answers a pointer that comes to rest on it. `id` is the agent behind
 * the thing being hovered; with no id, and no name to fall back on, there is
 * nothing to say and the face is left exactly as it was.
 */
export function AgentHover({ id, name, avatarUrl, children }: {
  id?: string;
  name?: string | null;
  avatarUrl?: string;
  children: ReactNode;
}) {
  const { agents, state } = useWorkspace();
  /** Where the face is, caught at the moment the pointer arrives — the card
   *  is drawn from it, and its absence is what "no card" means. */
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const agent = id ? agents?.find((row) => row.id === id) ?? null : null;
  const teammate = id && !agent ? state?.teamAgents?.find((row) => row.id === id) ?? null : null;
  if (!agent && !teammate && !name) return <>{children}</>;
  return (
    <span
      className="facehover"
      onMouseEnter={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      {children}
      {anchor
        ? createPortal(
          <AgentCard anchor={anchor} agent={agent} teammate={teammate} name={name} avatarUrl={avatarUrl} />,
          document.body,
        )
        : null}
    </span>
  );
}
