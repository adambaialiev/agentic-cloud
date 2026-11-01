/**
 * The row of agent cards under a document that has just been read (notes
 * #87/#105/#113/#186), and the sentence that stands in its place when there
 * is nobody to draw.
 *
 * ONE row for every document that carries it — a quick note, a knowledge
 * page, and either kind of proposal while it awaits review. "Who does this?"
 * is the same question under each, and a second copy of the answer is a
 * second copy to keep honest as the creation plate and these four hints
 * keep moving. What the caller brings is the only part that
 * differs: what the section is CALLED, what to call the thing being handed
 * over, what a tap opens — and whether this document is taking hands at all.
 *
 * A workplace with no agents gets the creation plate: making its first one
 * is now the useful next act (note #113). A legacy account with no
 * workplace still gets no advert it cannot use. A fleet that is all
 * mid-turn keeps the card and says so: that is the reader's own fleet being
 * busy, which is the answer to "why is the row I saw yesterday gone".
 *
 * The row offered the agents of the room being viewed, and made new ones in
 * it, until rooms left the product (note #843): it is the whole fleet now.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBanner } from '../chrome/useBanner.js';
import { toFor } from '../routes.js';
import {
  agentPresence, agentRecapLine, missingSeatRefusal, providerLabel,
} from '../screens/home/agent-words.js';
import type { HomeAgent } from '../workspace/live.js';
import { useFleet } from '../workspace/useFleet.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { AgentFace } from './AgentFace.js';
import { AgentName } from './AgentName.js';
import { NewAgentFlow } from '../cloud/NewAgentFlow.js';
import { ContextRing, WorkingFace } from './ContextRing.js';
import { TypeIcon } from './icons.js';
import { StepsMeter } from './SetupSteps.js';
import { idleAgentsToHandTo } from './handoff.js';

/**
 * One candidate: the agent's picture wearing its context ring, then the
 * identity that matters at handoff time — name, harness, effective model and
 * effort, and what it last DID, read through the same helper the home list
 * reads so the sentence here is the sentence there (note #116).
 *
 * The picture opens details. The rest opens a handoff for a ready agent,
 * or details while setup or a paused subscription still needs attention.
 * The face's tap is spent where it is caught, so it opens only one screen.
 *
 * An agent that has not finished setting up wears the home list's loading
 * state rather than a bare status word (note #352): the turning ring in place
 * of the context one — there is no context to draw yet anyway — and the same
 * three-segment meter under it. A still card reading "Setting up" is
 * indistinguishable from one that gave up an hour ago, and this row is
 * exactly where a reader is waiting for that agent to become tappable.
 */
function HandTile({ agent, noun, onOpen, onDetail }: {
  agent: HomeAgent;
  noun: string;
  onOpen: (agent: HomeAgent) => void;
  onDetail: (agent: HomeAgent) => void;
}) {
  const harness = providerLabel(agent.cli);
  const recap = agentRecapLine(agent);
  const ready = agent.status === 'ready' && !agent.working;
  const status = agentPresence(agent).label;
  const coming = agent.status === 'setting-up';
  // The visible text is IN the tile, so the label would otherwise be read
  // twice. Name the act and include the same run facts for non-visual
  // readers; the recap rides it last, after a full stop, or the clamp above
  // would be its only copy.
  const run = [harness, agent.model, agent.effort ? `${agent.effort} effort` : '']
    .filter(Boolean)
    .join(', ');
  // Durable work it left running beyond its turns (note #564) — the same count
  // its plate on the home list wears. A fact here, not a door: this card's
  // one act is the handoff, and "idle" over a machine mid-build is half the
  // truth at the moment somebody picks who to hand work to.
  const jobCount = agent.status === 'ready' ? agent.activeJobs ?? 0 : 0;
  const jobs = jobCount > 0 ? `${jobCount} background ${jobCount === 1 ? 'job' : 'jobs'}` : '';
  const label = ready
    ? `Send ${agent.name}${run ? ` — ${run} —` : ''} a message about this ${noun}`
      + (jobs ? `. ${jobs} running` : '')
      + (recap ? `. ${recap}` : '')
    : `Open ${agent.name} details — ${status}${jobs ? `. ${jobs} running` : ''}`;
  return (
    // A div, not a button: it holds two of them. Its own job is to catch the
    // tap on the padding between them, exactly as the legacy tile does — the
    // keyboard reaches the handoff through `.handpick`, whose press bubbles
    // here.
    <div className="hand" onClick={() => ready ? onOpen(agent) : onDetail(agent)}>
      <button
        className="handface"
        type="button"
        aria-label={`Open ${agent.name} details`}
        onClick={(event) => { event.stopPropagation(); onDetail(agent); }}
      >
        {coming
          ? <WorkingFace><AgentFace agent={agent} /></WorkingFace>
          : <ContextRing context={agent.context}><AgentFace agent={agent} /></ContextRing>}
      </button>
      {/* No handler of its own: a tap or an Enter here bubbles to the card,
          which is the handoff. One target, one act. */}
      <button className="handpick" type="button" aria-label={label}>
        <span className="hname"><AgentName agent={agent} /></span>
        <span className="hharness">{harness}</span>
        <span className="hmodel">{agent.model || ''}</span>
        <span className="heffort">{agent.effort || ''}</span>
        {jobs ? <span className="hjobs"><span className="hjobsdot" aria-hidden="true" />{jobs}</span> : null}
        {!ready ? <span className="habout" role="status">{status}</span>
          : recap ? <span className="habout">{recap}</span> : null}
      </button>
      {/* Outside the button, not in it: a button holds phrasing, and the
          meter is the card's own foot — full width, in the same place on
          every card of the row, the way the fleet plate draws it. */}
      <StepsMeter status={agent.status} />
    </div>
  );
}

/** The last choice under a document: the existing creation flow, in the same
 *  plate shape as the agents it will eventually add to the row. */
function CreateHandTile() {
  const { state } = useWorkspace();
  const { createAgent, pendingCreates } = useFleet();
  const banner = useBanner();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const org = state?.org ?? null;
  const busy = pendingCreates > 0;

  const answer = (cli: string | null) => {
    setAsking(false);
    if (!cli) return;
    const refusal = missingSeatRefusal(cli, org);
    if (refusal && org) {
      banner.show(refusal);
      navigate(toFor({ kind: 'seats', orgId: org.orgId })!);
      return;
    }
    void createAgent(cli);
  };

  return (
    <>
      <button
        className="hand createhand"
        type="button"
        disabled={busy}
        aria-label={busy ? 'Creating an agent' : 'Create an agent'}
        onClick={() => setAsking(true)}
      >
        <div className="ctxring blank">
          {busy ? <span className="spinner" /> : <TypeIcon glyph="plus" />}
        </div>
        <span className="hname">{busy ? 'Creating agent…' : 'Create agent'}</span>
      </button>
      {asking
        ? <NewAgentFlow onAnswer={answer} />
        : null}
    </>
  );
}

/** What the sentence under the row says, in the state it is actually in. */
function handHint(
  noun: string,
  idle: number,
  fleet: number,
  pendingCreates: number,
  waiting: number,
): string {
  if (waiting) {
    return `Agents still setting up or paused show their status here. Tap their card for details; hand over this ${noun} when they are ready.`;
  }
  if (idle) {
    return 'Tap a face for agent details. Tap the rest of its card to hand over this '
      + `${noun}; the answer lands in that agent's Workspace conversation.`;
  }
  if (!fleet) {
    return pendingCreates
      ? `The new agent appears here when it is ready to take this ${noun}.`
      : `Create an agent, then hand it this ${noun} when it is ready.`;
  }
  return fleet === 1
    ? 'Your agent is working right now. This row comes back when it is free.'
    : 'Every agent here is working right now. This row comes back when one is free.';
}

export interface HandRowProps {
  /** Section ids, so the shared stylesheet dresses this row as itself. */
  ids: { head: string; card: string; row: string; hint: string };
  /** What to call the thing being handed over, in the hint and the label. */
  noun: string;
  /** What the section calls itself. The default names the ACT — a note or a
   *  page is genuinely passed to somebody else to carry on with. A proposal
   *  is not: it stays the author's, and the only thing another agent is being
   *  asked for is a look at it (note #390), which is why both decision
   *  screens name this "Ask for review" instead. */
  head?: string;
  /** This document is not taking hands at all — an archived note, or one an
   *  agent already holds, or a proposal whose decision has landed. A
   *  knowledge page is never closed: it is never archived and nobody claims
   *  one. */
  closed?: boolean;
  /** A document's own author is not a hand-off candidate for that document:
   *  proposals use this to offer the review to somebody else. */
  excludeAgentId?: string;
  onOpen: (agent: HomeAgent) => void;
  onDetail: (agent: HomeAgent) => void;
}

export function HandRow({
  ids, noun, head = 'Hand it to an agent', closed, excludeAgentId, onOpen, onDetail,
}: HandRowProps) {
  const { agents, state } = useWorkspace();
  const { pendingCreates } = useFleet();
  const fleet = (agents ?? []).filter((agent) => agent.id !== excludeAgentId);
  const canCreate = Boolean(state?.org);
  const idle = idleAgentsToHandTo(agents).filter((agent) => agent.id !== excludeAgentId);
  // A reserved record ends the creation indicator before setup finishes.
  // Keep that record visible here, just as Home does (note #332), with a
  // details door until it can actually accept a handoff.
  const waiting = fleet.filter((agent) => !agent.working && agent.status !== 'ready' && agent.status !== 'retired');
  // A legacy account with no workplace has nowhere a new agent could be
  // placed; it keeps its quiet empty screen.
  const bare = Boolean(closed) || (fleet.length === 0 && !canCreate);
  // The row itself goes when there is nothing in it — but the card and its
  // sentence stay, because a row that was there yesterday needs an answer.
  const empty = idle.length === 0 && waiting.length === 0 && !canCreate;
  return (
    <>
      <h2 id={ids.head} hidden={bare}>{head}</h2>
      <div className="card" id={ids.card} hidden={bare}>
        <div className="facerow" id={ids.row} hidden={empty}>
          {[...idle, ...waiting].map((agent) => (
            <HandTile agent={agent} key={agent.id} noun={noun} onOpen={onOpen} onDetail={onDetail} />
          ))}
          {/* Last, exactly where note #113 asked for it: after every agent
              choice, and only where the create flow has a workplace to put
              the result in. */}
          {canCreate ? <CreateHandTile /> : null}
        </div>
        <div className={empty ? 'facehint alone' : 'facehint'} id={ids.hint}>
          {handHint(noun, idle.length, fleet.length, pendingCreates, waiting.length)}
        </div>
      </div>
    </>
  );
}
