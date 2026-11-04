/**
 * Home's fleet: every agent, most recently used first as the server orders
 * them, each a plate that opens the conversation with it. (Every agent in
 * the viewed room, until rooms left the product — note #843.)
 * Ported from the legacy `renderAgents` / `agentRow` and their word
 * helpers; the states, the words and the class vocabulary are the same so
 * the one stylesheet draws both shells alike.
 *
 * The two fleet-shaped transitions live here too, off `useFleet()`:
 *
 *  - MID-DELETE. A row whose agent is being erased drops every "still coming"
 *    signal — no door, no live dot, no setup meter, no session-limit mark —
 *    because nothing about it is on its way anywhere any more. It keeps its
 *    recap so it does not change height on the way out.
 *  - MID-CREATE. A plate stands in for an agent whose record has not arrived,
 *    LAST in the list, because that is where its real row lands: an agent
 *    nobody has used yet sorts to the bottom, and the two must agree or the
 *    create reads as a jump from one end of the list to the other.
 *
 * The fleet is ONE list. Note #412 took the All / Claude Code / Codex tabs
 * off this section: a fleet is few enough to read whole, it is
 * ordered by what the reader came for (most recently used first), and each
 * plate's model already says which harness it runs. Don't put the tabs back
 * without asking — a narrowed fleet also hides the newest agent, which is
 * the one the reader is usually looking for.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceFreshChatsAnswer } from '../../../../src/shared/workspace-api.js';
import { agentReadyForFreshChat } from '../../../../src/shared/fresh-chats.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AgentName } from '../../ui/AgentName.js';
import { ContextRing, WorkingFace } from '../../ui/ContextRing.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ROW_DOOR_ATTR } from '../../ui/FaceDoor.js';
import { Svg, TypeIcon } from '../../ui/icons.js';
import { StepsMeter } from '../../ui/SetupSteps.js';
import { elapsed, useNow } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import type { HomeAgent } from '../../workspace/live.js';
import { useFleet } from '../../workspace/useFleet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { agentDoor, agentFixDoor } from './agent-door.js';
import { AgentFiles } from './AgentFiles.js';
import { PressableRow } from './PressableRow.js';
import { TeamAgents } from './TeamAgents.js';
import {
  agentClockMoves, agentMachineFacts, agentNowLine, agentPlateLine, agentRecapLine, agentRuntimeFacts, agentSessionLimited,
} from './agent-words.js';
import { useNewAgent } from './useNewAgent.js';
import { freshChatsLabel, freshChatsQuestion, freshChatsResult } from './fresh-chat-words.js';

/**
 * One quiet line of identity facts — the model and its effort, or the cores
 * and the memory — where each fact stays whole (note #396).
 *
 * A plate is half a phone wide, and these two lines were the only text on it
 * that could not fold: `nowrap` plus an ellipsis, which on every supported
 * width cut the model in half and dropped the effort and the memory
 * entirely. So the facts are drawn as their own boxes and the line WRAPS
 * between them under pressure instead of ending in a `…`. It only comes to
 * that on a narrow phone; the widths a fleet is usually read at hold each
 * line whole.
 *
 * The separator travels with the fact it introduces, so a folded line reads
 * `2 dedicated cores` / `· 4 GB` rather than leaving a middot dangling off
 * the end of the first one — and the line's text is character-for-character
 * the string it was before, which is what a screen reader still hears.
 */
function FactLine({ className, facts }: { className: string; facts: string[] }) {
  return (
    <div className={className}>
      {facts.map((fact, index) => (
        <span className="fact" key={index}>{index ? ' · ' : ''}{fact}</span>
      ))}
    </div>
  );
}

/** The state line's tail while a turn runs: the clock, then the tool line. */
function LiveTail({ agent, now }: { agent: HomeAgent; now: number }) {
  return (
    <>
      {agent.activitySince ? <><span className="csep">·</span><span className="cwhen crun">{elapsed(agent.activitySince, now)}</span></> : null}
      {agent.activity ? <><span className="csep cactsep">·</span><span className="cact">{agent.activity}</span></> : null}
    </>
  );
}

export function AgentRow({ agent, now }: { agent: HomeAgent; now: number }) {
  const { state } = useWorkspace();
  const { departing } = useFleet();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  const going = departing.get(agent.id);
  const limited = !going ? agentSessionLimited(agent) : undefined;
  const live = !going && agent.status === 'ready' && Boolean(agent.working);
  const meta = agentPlateLine(agent, org, now, Boolean(going));
  const metaClass = !going && (agent.status === 'needs-seat' || agent.status === 'payment-required') ? 'ctext act'
    : limited ? 'ctext limit' : live ? 'ctext keep' : 'ctext';
  const recap = agentRecapLine(agent);
  const arrived = Number.isFinite(agent.recapArrivedAt) && (agent.recapArrivedAt ?? 0) > 0;
  const nowLine = agentNowLine(agent);
  const open = () => navigate(agentDoor(agent));
  // The plate opens the agent's own screen; a paused line that names a
  // sign-in is a door of its own to where that sign-in is made (note #983).
  const fixDoor = going ? null : agentFixDoor(agent, org);
  const runtime = agentRuntimeFacts(agent);
  // What it runs ON, under what it thinks WITH (note #356). Both are identity
  // facts about the agent rather than states it passes through, which is why
  // they stay together directly under the name and out of the state line
  // below. They are drawn as their own block rather than inside the name's
  // column, because that column is what is left of a half-plate after the
  // portrait and it is far too narrow to say either of them (note #396).
  const machine = agentMachineFacts(agent);
  // Durable work it left running beyond its turns (note #564). A door of its
  // own to the list that explains each one, so its press must not also walk
  // through the plate's.
  const jobCount = !going && agent.status === 'ready' ? agent.activeJobs ?? 0 : 0;
  const jobsLabel = `${jobCount} background ${jobCount === 1 ? 'job' : 'jobs'}`;
  const body = (
    <>
      <div className="agenthead">
        {!going && agent.status === 'setting-up'
          ? <WorkingFace><AgentFace agent={agent} /></WorkingFace>
          : <ContextRing context={agent.context}><AgentFace agent={agent} /></ContextRing>}
        <div className="agentidentity">
          <div className="name plain"><AgentName agent={agent} /></div>
        </div>
        {going ? <span className="spinner" /> : null}
      </div>
      {runtime.length || machine.length
        ? (
          <div className="agentfacts">
            {runtime.length ? <FactLine className="cruntime" facts={runtime} /> : null}
            {machine.length ? <FactLine className="cmachine" facts={machine} /> : null}
          </div>
        )
        : null}
      <div className="main">
        <div className="cline">
          {live ? <span className="livedot" /> : null}
          {limited ? <span className="icon ft limitmark"><Svg name="alert" size={20} /></span> : null}
          <span className={metaClass} {...(fixDoor ? { [ROW_DOOR_ATTR]: fixDoor } : {})}>{meta}</span>
          {live ? <LiveTail agent={agent} now={now} /> : null}
        </div>
        {jobCount > 0
          ? (
            <button
              className="cjobs"
              type="button"
              aria-label={`${jobsLabel} running. Open details`}
              onClick={(event) => { event.stopPropagation(); navigate(toFor({ kind: 'agentJobs', id: agent.id })!); }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
            >
              <span className="cjobsdot" aria-hidden="true" />
              <span className="cjobstext">{jobsLabel}</span>
            </button>
          )
          : null}
        {recap
          ? (
            <div
              className={`cabout${arrived ? ' arrived' : ''}`}
              style={arrived ? { '--recap-arrival-delay': `-${Math.max(0, now - agent.recapArrivedAt!)}ms` } as React.CSSProperties : undefined}
            >
              {recap}
            </div>
          )
          : null}
        {/* What its newest message carried (note #553): the pictures the
            recap talks about, on the plate, each a door to the full-screen
            viewer. Not while it is going — nothing on it is on its way. */}
        {!going && agent.lastFiles?.length ? <AgentFiles agentId={agent.id} files={agent.lastFiles} /> : null}
        {nowLine ? <div className="ctask"><span className="tlabel">Now</span><span className="ttext">{nowLine}</span></div> : null}
        {going ? null : <StepsMeter status={agent.status} />}
      </div>
    </>
  );
  // No door while it is going: there is nothing on the other side of it.
  if (going) {
    return (
      <div className={`crow deleting${going === 'leaving' ? ' leaving' : ''}`} data-agent={agent.id}>{body}</div>
    );
  }
  return <PressableRow className="crow open" data-agent={agent.id} onPress={open}>{body}</PressableRow>;
}

/**
 * Stands in for an agent whose record has not arrived yet: the same shape as
 * a real row, in the place the real one will take, so the tap has an answer
 * before the server gives one.
 */
export function PendingAgentRow() {
  return (
    <div className="crow">
      <div className="agenthead">
        <WorkingFace><TypeIcon glyph="bot" /></WorkingFace>
        <div className="agentidentity"><div className="name plain">New agent</div></div>
      </div>
      <div className="main">
        <div className="cline"><span className="ctext">Getting it started…</span></div>
        <StepsMeter status="setting-up" />
      </div>
    </div>
  );
}

/**
 * The creation door. The rules — the chooser as the confirm, the walk to
 * the sign-in, the first-Codex exception, the ignored repeat tap — live in
 * `useNewAgent` rather than in this handler.
 *
 * The door stays the same action while a create runs — the pending plate
 * below IS the progress state, and a second loading indicator here would say
 * the same thing twice.
 *
 * It waited on a ROOM ("Create a room first") until rooms left the product
 * (note #843); an agent belongs to a workplace now, so a workplace is what
 * it waits on — which only the old personal workspace lacks.
 */
export function NewAgentDoor() {
  const { state } = useWorkspace();
  const { ask, flow } = useNewAgent();
  const can = Boolean(state?.org);

  return (
    <>
      <button
        className={can ? 'addrow' : 'addrow waiting'}
        id="newAgentBtn"
        type="button"
        disabled={!can}
        onClick={ask}
      >
        <span id="newAgentLabel">{can ? 'New agent' : 'Create a workplace first'}</span>
      </button>
      {flow}
    </>
  );
}

/**
 * "Reset finished agents" (note #707): one press that asks every agent here
 * whose work is finished — done, nothing waiting on anyone, and
 * nothing on the records that will come back to it (shared/fresh-chats.ts) —
 * to start a fresh chat. Absent when there is nobody to ask, as the agent
 * screen's own reset is absent with no conversation to clear.
 *
 * The question names them, because the press sends a message to each, and
 * the server judges each again at the press: whoever turned busy or opened a
 * proposal in between is left alone and named in the banner with the reason.
 * An agent asked is kept off the door until its reading changes — the reset
 * clears it — so a second press in the gap cannot ask it twice.
 */
export function FreshChatsDoor({ agents }: { agents: HomeAgent[] }) {
  const { state, reload } = useWorkspace();
  const { departing } = useFleet();
  const { api } = useSession();
  const banner = useBanner();
  const ask = useConfirm();
  const [asked, setAsked] = useState<ReadonlyMap<string, string>>(new Map());
  const [sending, setSending] = useState(false);
  const holding = new Set((state?.notes ?? []).flatMap((note) => (
    note.work?.state === 'working' && note.work.agentId ? [note.work.agentId] : []
  )));
  const ready = agents.filter((agent) => (
    !departing.has(agent.id)
    && agentReadyForFreshChat(agent, holding)
    && asked.get(agent.id) !== readingStamp(agent)
  ));
  if (!ready.length) return null;

  const press = async () => {
    if (sending) return;
    const names = ready.map((agent) => agent.name);
    if (!await ask(freshChatsQuestion(names))) return;
    setSending(true);
    try {
      const answer = await api.api<WorkspaceFreshChatsAnswer>(
        'api/agents/fresh-chats',
        jsonBody({ agentIds: ready.map((agent) => agent.id) }),
      );
      setAsked((before) => {
        const next = new Map(before);
        for (const { id } of answer.asked) {
          const agent = ready.find((row) => row.id === id);
          if (agent) next.set(id, readingStamp(agent));
        }
        return next;
      });
      const result = freshChatsResult(answer);
      banner.show(result.text, result.ok);
      // The asked agents are mid-turn now; the live tick would say so in a
      // few seconds, the full read says it at once.
      await reload().catch(() => { /* the live tick catches up */ });
    } catch (error) {
      banner.show(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <button className="addrow freshchats" id="freshChatsBtn" type="button" disabled={sending} onClick={() => { void press(); }}>
      {sending ? <span className="spinner" /> : null}
      <span>{freshChatsLabel(ready.length)}</span>
    </button>
  );
}

/** Which conversation an ask was made over: its measurement's stamp. */
function readingStamp(agent: HomeAgent): string {
  return agent.context?.at ?? '';
}

/**
 * The fleet as a personal workspace's one column draws it (`PersonalPanel`).
 * A workplace's agents are the agents picker's (`AgentSwitch`), which was a
 * room's Agents shelf drawn this way until rooms left the product (note
 * #843).
 */
export function Agents() {
  const { agents } = useWorkspace();
  const { removed, departingRows, pendingCreates } = useFleet();
  // An agent on its way out keeps its row until it has left (note #715),
  // even when a read that landed meanwhile no longer carries it.
  const leaving = [...departingRows.values()].filter((row) => !agents?.some((agent) => agent.id === row.id));
  const list = (agents ? [...agents, ...leaving] : leaving).filter((agent) => !removed.has(agent.id));
  const active = list.filter((agent) => Boolean(agent.working)).length;
  const now = useNow(agentClockMoves(list));
  const pending = Array.from({ length: pendingCreates }, (_, index) => index);
  const countLabel = `${list.length} agents total, ${active} active, ${list.length - active} idle`;
  return (
    <div id="agentsSection">
      <h2 className="agentshead homehead">
        <span>Agents</span>
        <span className="agentcounts" id="agentCounts" aria-label={countLabel}>
          <span>{list.length} total</span><span className="sep"> · </span>
          <span className="active">{active} active</span><span className="sep"> · </span>
          <span>{list.length - active} idle</span>
        </span>
      </h2>
      <div className="agentdeck">
        <div id="agents" className="plates">
          {list.length === 0 && pendingCreates === 0
              ? (
                <div className="agentemptycard">
                  <EmptyState glyph="bot" tint="act" title="Start with an agent" body="Agents are teammates you can message with work. They share this workplace’s notes, code, knowledge and secrets, and can work on them together." />
                  <NewAgentDoor />
                </div>
              )
              : (
                <>
                  {list.map((agent) => <AgentRow key={agent.id} agent={agent} now={now} />)}
                  {pending.map((index) => <PendingAgentRow key={index} />)}
                  <NewAgentDoor />
                </>
              )}
        </div>
      </div>
      <FreshChatsDoor agents={list} />
      <TeamAgents />
    </div>
  );
}
