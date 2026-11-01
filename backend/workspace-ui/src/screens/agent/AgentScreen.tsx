import { overviewTo } from '../home/home-address.js';
import { isHarnessCli } from '../../../../src/shared/harness-clis.js';
import { HeadRuntimeButton } from '../../ui/HeadRuntimeButton.js';
import { ScheduleCard } from './ScheduleCard.js';
/**
 * The agent's own screen: what it is, what it runs, what it last said, the
 * proposals it has made, and the delete.
 *
 * Three rules from the legacy `openAgentInfo` survive the port intact:
 *
 *  - WARM FIRST. The state read already carries this agent's record-known
 *    version seed, so the screen opens on facts. The live version read
 *    refreshes them underneath; a failed refresh leaves rows that were true a
 *    moment ago standing, and only a screen with nothing on it says why.
 *  - LIVE WHERE IT MATTERS. `busy` is the one field here that goes stale
 *    while the screen is being looked at, and the context reading is written
 *    when a TURN ENDS. Both are read off the fleet row, which the live tick
 *    patches — so the update buttons unlock the moment a turn finishes and
 *    the number the reader is looking at is the one that turn just moved.
 *  - THE DELETE IS WRITTEN FIRST, outside the version card, so an agent whose
 *    machine never came up — the one most likely to need removing — still has
 *    a way out when there is nothing truthful to say about it.
 *
 * Only the two pickers are transient (knowledge page "miniapp-navigation"):
 * they keep this address underneath them, and Back closes them rather than
 * spending a history entry.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceAgentProposalsAnswer,
  WorkspaceAgentRuntimeAnswer,
  WorkspaceAgentVersionAnswer,
  WorkspaceAgentVersionSeed,
  WorkspaceChatLatestAnswer,
  WorkspaceIdleMessageAnswer,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AgentName } from '../../ui/AgentName.js';
import { AskByTyping, AskToConfirm } from '../../ui/Ask.js';
import { askedOf } from '../../ui/ask-words.js';
import { ContextRing } from '../../ui/ContextRing.js';
import { ContextUsageRow } from '../../ui/ContextUsageRow.js';
import { contextPercent } from '../../ui/context-heat.js';
import { Icon } from '../../ui/icons.js';
import { Markdown } from '../../render/Markdown.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { coarseActive, durationWords, elapsed, relative, useNow } from '../../ui/time.js';
import { dayWords } from '../../ui/format.js';
import { useFleet } from '../../workspace/useFleet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { KnowledgeProposalRow, ProposalRow } from '../home/Decisions.js';
import { ChatDoor } from '../decisions/ProposalHead.js';
import { FoldLong } from '../decisions/FoldLong.js';
import { agentChattable, agentMachineLine, agentRuntimeLine } from '../home/agent-words.js';
import { MachinePicker } from './MachinePicker.js';
import { machineSizeWords } from './machine-words.js';
import { SeatPicker } from './SeatPicker.js';
import { forgetAgent, heldAgent, holdAgent } from './agent-cache.js';
import { RuntimePicker } from './RuntimePicker.js';
import { BusyLockButton, CardRow } from './VersionRows.js';
import {
  agentLastReplyOf, agentProposalHistory, cliNote, cliRidesImage, deleteHint, docsNote, imageNote,
  chosenSeat, machineLine, runtimeValue, showsSubscriptionRow, subscriptionLabel, waitingLine,
} from './agent-facts.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One fact, in the shape the whole screen uses: a key, a value, and — where
 *  the value would raise a question — the answer to it. */
function DetailRow({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="drow">
      <div className="k">{label}</div>
      {children}
      {note ? <div className="v dim">{note}</div> : null}
    </div>
  );
}

export function AgentScreen() {
  const { id = '' } = useParams();
  const { state, agents, reload, patchAgentRuntime } = useWorkspace();
  const { departing, deleteAgent } = useFleet();
  const { api } = useSession();
  const banner = useBanner();
  const navigate = useNavigate();
  const notes = useNoteRefs();

  // Opened on what this tab last read of this agent (note #630): the screen
  // is rebuilt per visit, and the reads below refresh it silently.
  const [held] = useState(() => heldAgent(id));
  const [fresh, setFresh] = useState<WorkspaceAgentVersionAnswer | null>(held.version ?? null);
  const [versionError, setVersionError] = useState('');
  // Boxed on purpose: "not read yet" and "read, and there is none" are
  // different answers, and only the second may erase the seed below it.
  const [reply, setReply] = useState<{ value: { text: string; at?: string } | null } | null>(held.reply ?? null);
  // One read, both kinds: "not read yet" and "read, and it has proposed
  // nothing" are the same empty section here, which is why this one is not
  // boxed the way the last reply above it is.
  const [proposed, setProposed] = useState<WorkspaceAgentProposalsAnswer | null>(held.proposals ?? null);
  const [showAllPrs, setShowAllPrs] = useState(false);
  const [leaf, setLeaf] = useState<'runtime' | 'machine' | 'seat' | null>(null);
  const [asking, setAsking] = useState<'delete' | 'machine' | null>(null);
  const [running, setRunning] = useState<'cli' | 'machine' | null>(null);
  const [resetAsked, setResetAsked] = useState(false);
  // Keep answered: the ask leaves the screen now and the record on reload.
  const [kept, setKept] = useState(false);
  const parked = useRef(0);

  const agent = (agents ?? []).find((row) => row.id === id) ?? null;
  const deleting = departing.has(id);

  const readVersion = useCallback(async (): Promise<void> => {
    try {
      const answer = await api.api<WorkspaceAgentVersionAnswer>(`api/agents/${encodeURIComponent(id)}/version`);
      holdAgent(id, { version: answer });
      setFresh(answer);
      setVersionError('');
    } catch (error) {
      // A failed refresh does not erase rows that were true a moment ago —
      // whether from this screen's own reading or from the state seed.
      setVersionError(errorMessage(error));
    }
  }, [api, id]);

  // Three reads on open, each independent: this screen is rebuilt per agent
  // (App keys it on the id), so nothing here has a previous agent's answer to
  // clear first.
  useEffect(() => {
    let alive = true;
    void readVersion();
    // Independent of the version card below it on purpose: the chat store is
    // local and quick, while version inspection may take longer.
    void api.api<WorkspaceChatLatestAnswer>(`api/agents/${encodeURIComponent(id)}/chat/latest`)
      .then((answer) => {
        const said = { value: agentLastReplyOf(answer.message) };
        holdAgent(id, { reply: said });
        if (alive) setReply(said);
      })
      .catch(() => { /* words that were true a moment ago beat an empty section */ });
    // Across repositories, rooms and both proposal stores, so it cannot ride
    // the version read. A failed optional history read says nothing rather
    // than "no proposals".
    void api.api<WorkspaceAgentProposalsAnswer>(`api/agents/${encodeURIComponent(id)}/prs`)
      .then((answer) => { holdAgent(id, { proposals: answer }); if (alive) setProposed(answer); })
      .catch(() => { /* the section simply stays absent */ });
    return () => { alive = false; };
  }, [api, id, readVersion]);

  // A transient leaf covers this screen rather than replacing it, so the
  // reader lands back on the row they came to change rather than at the top.
  useLayoutEffect(() => {
    if (leaf) return;
    window.scrollTo(0, parked.current);
  }, [leaf]);
  const openLeaf = (which: 'runtime' | 'machine' | 'seat') => { parked.current = window.scrollY; setLeaf(which); };
  const closeLeaf = useCallback(() => setLeaf(null), []);

  const runtimeWritten = useCallback((result: WorkspaceAgentRuntimeAnswer) => {
    // Keep every already-painted copy of the runtime on the same answer: this
    // screen's facts, and the header and the fleet row behind them, which are
    // drawn from the state's own row rather than from this read. Both halves
    // are needed — the facts are this screen's, the row is everybody's — and
    // the reload that follows only confirms what the server has already said.
    setFresh((current) => (current ? { ...current, model: result.model, effort: result.effort } : current));
    patchAgentRuntime(id, { model: result.model, effort: result.effort });
    void reload().catch(() => { /* the next poll confirms the same values */ });
  }, [id, patchAgentRuntime, reload]);

  const now = useNow(Boolean(agent?.working && agent.activitySince));

  if (!agents) {
    return <div className="screen" id="screenAgent" aria-busy="true"><div id="loading"><span className="sr-only">Loading…</span></div></div>;
  }
  if (!agent) {
    return (
      <div className="screen" id="screenAgent">
        <div className="card authpanel" role="alert" id="agentGone">
          <h2>That agent is not here</h2>
          <div className="authsub">It may have been deleted, or it belongs to another workspace.</div>
          <button className="btn primary" type="button" onClick={() => navigate(overviewTo(state?.org?.orgId, { half: 'agents' }))}>Back to your agents</button>
        </div>
      </div>
    );
  }

  if (leaf === 'runtime') {
    return <RuntimePicker agent={agent} onClose={closeLeaf} onWritten={runtimeWritten} />;
  }
  if (leaf === 'seat') {
    return <SeatPicker agent={agent} onClose={closeLeaf} />;
  }
  if (leaf === 'machine') {
    return (
      <MachinePicker
        agent={agent}
        busy={Boolean(agent.working)}
        onClose={closeLeaf}
        // The Machine row is drawn from the version read, so a size that
        // changed under the leaf has to come back through that read rather
        // than be patched in from the answer the leaf happened to see.
        onWritten={() => { void readVersion(); }}
      />
    );
  }

  // What this screen can already say, best first: the reading it took itself,
  // else the seed the state read brought with the agent.
  const info: WorkspaceAgentVersionAnswer | WorkspaceAgentVersionSeed | null = fresh ?? agent.version ?? null;
  // The machine row costs a control-plane read, so the state's warm seed does
  // not carry it: the row simply joins the others when the live read lands.
  const machine = fresh?.machine ?? null;
  // The fleet row is the live truth about a running turn; the version read's
  // own `busy` is a snapshot from when the screen opened, and this screen is
  // the one a reader opens BECAUSE something is running.
  const busy = Boolean(agent.working);
  const org = state?.org ?? null;
  const limit = agent.status === 'ready' && !agent.working ? agent.sessionLimit : null;
  const waiting = waitingLine(agent, org);
  const user = state?.user ?? null;
  const turnCount = Number.isSafeInteger(agent.version?.turnCount) ? agent.version!.turnCount : info?.turnCount;
  const runtimeText = info ? runtimeValue(info) : '';
  const headerRuntime = agentRuntimeLine(agent);
  // The header's machine door says the SHAPE alone — the record already knows
  // it, so the door is there from the first paint. The Machine row below says
  // the whole line (where it runs, whether it is awake), which only the live
  // read can answer; the live read's shape supersedes the record's here the
  // moment it lands, so the two never disagree about the same machine.
  const headerMachine = machine ? machineSizeWords(machine) : agentMachineLine(agent);
  const headerSeat = chosenSeat(agent, org?.seatUsage) ? subscriptionLabel(agent, org?.seatUsage) : '';
  const runtimeChangeable = isHarnessCli(agent.cli);
  const chattable = agentChattable(agent);
  // The narrow read when it has landed; until then the seed the state read
  // brought with the agent, which is what makes the FIRST open warm.
  const lastReply = reply ? reply.value : agentLastReplyOf(agent.lastReply);
  // How long ago that reply was said, beside its label — in the same words
  // the Workspace Agent's card already stamps its own last reply with, since
  // the two draw the same block (note #558). The words alone cannot say
  // whether this is what the agent said a minute ago or what it said
  // yesterday, and that is the first thing a reader wants from them. Empty
  // for a reply carrying no time, or one stamped ahead of the clock: the
  // label then reads exactly as it did before.
  const lastReplyAge = lastReply?.at ? relative(lastReply.at, now) : '';
  const proposals = agentProposalHistory(proposed);
  const shownPrs = showAllPrs ? proposals : proposals.slice(0, 5);

  const startUpdate = async (which: 'cli' | 'machine') => {
    setRunning(which);
    try {
      await api.api(`api/agents/${encodeURIComponent(agent.id)}/${which === 'cli' ? 'update-cli' : 'update-machine'}`, { method: 'POST' });
      banner.show('Updated — all set.', true);
      await readVersion();
    } catch (error) {
      banner.show(errorMessage(error));
      await readVersion();
    } finally {
      setRunning(null);
    }
  };

  /**
   * An ASK, not a silent reset: the existing user-to-agent message path
   * starts a turn, and the agent saves anything durable before it clears its
   * own chat. The tap stays spent until that turn removes the reading.
   */
  const askReset = async () => {
    setResetAsked(true);
    try {
      const result = await api.api<WorkspaceIdleMessageAnswer>(
        `api/agents/${encodeURIComponent(agent.id)}/message`,
        jsonBody({ message: 'reset chat' }),
      );
      banner.show(`${result.name || agent.name} will reset its chat — the answer lands in its chat.`, true);
    } catch (error) {
      setResetAsked(false);
      banner.show(errorMessage(error));
    }
  };

  /** Resume is an ordinary owner message, not a hidden mutation: it keeps the
   *  native conversation, the recap capture and the transcript on the path
   *  every other follow-up takes. */
  const resume = async () => {
    try {
      const result = await api.api<WorkspaceIdleMessageAnswer>(
        `api/agents/${encodeURIComponent(agent.id)}/message`,
        jsonBody({ message: 'resume' }),
      );
      banner.show(`${result.name || agent.name} is resuming — the answer lands in its chat.`, true);
      await reload().catch(() => { /* the live poll confirms the accepted turn */ });
    } catch (error) {
      banner.show(errorMessage(error));
    }
  };

  /** Keep an agent the Workspace Agent asked to remove (note #710). */
  const keep = async () => {
    try {
      await api.api(`api/agents/${encodeURIComponent(agent.id)}/keep`, { method: 'POST' });
      setKept(true);
      await reload().catch(() => { /* the ask is off the record either way */ });
    } catch (error) {
      banner.show(errorMessage(error));
    }
  };

  const confirmDelete = async (confirmed: boolean) => {
    setAsking(null);
    if (!confirmed) return;
    const result = await deleteAgent(agent);
    // The list first, so the row is on screen for the moment it leaves.
    if (result.ok) { forgetAgent(agent.id); navigate(overviewTo(state?.org?.orgId, { half: 'agents' })); }
  };

  return (
    <div className="screen" id="screenAgent">
      <ScreenTitle
        markId="agentInfoHead"
        // No face, no ring, and no mark at all: a ring around nothing is
        // precisely the empty disc the fallback exists to avoid, and a mark
        // box holding a hidden picture still spends the header's gap and
        // indents the name past every other screen's.
        mark={agent.avatarUrl
          ? <ContextRing context={agent.context}><AgentFace agent={agent} /></ContextRing>
          : null}
        titleId="agentInfoTitle"
        title={<AgentName agent={agent} />}
        subNode={(
          <>
            {runtimeChangeable
              ? (
                <HeadRuntimeButton id="agentInfoSub" text={headerRuntime} onClick={() => openLeaf('runtime')} />
              )
              : <div className="sub" id="agentInfoSub">{headerRuntime}</div>}
            {/* The machine, beside what it thinks with (note #356). The two
                doors in this header are the two halves of one question — what
                this agent runs, and what it runs on — and the machine used to
                be reachable only by scrolling the facts card, which is the one
                screen element a reader opens THIS screen to change.

                Warm off the state's record-known shape, then exact once the
                live read lands: the same "opens on facts" bargain the version
                card makes, and the reason this door does not appear a second
                after the header has already settled. Absent when nothing has
                ever read this machine — a door with no words to say is not a
                door, and the Machine row below still leads to the same
                place. */}
            {headerMachine
              ? (
                <button
                  className="sub headmachine"
                  id="agentInfoMachine"
                  type="button"
                  // A different name from the Machine row's, on purpose and
                  // by the pattern the runtime pair already set here: the two
                  // doors lead to one screen, and a reader listening to this
                  // page must be able to tell "the control in the header"
                  // from "the fact row further down" rather than hearing the
                  // same sentence twice.
                  aria-label={`Choose the machine size. Current: ${headerMachine}`}
                  onClick={() => openLeaf('machine')}
                >
                  <span>{headerMachine}</span>
                </button>
              )
              : null}
            {/* A chosen subscription, under what it runs on (note #773) —
                only when the agent was GIVEN one: the workplace default is
                what every other agent does and needs no line of its own. */}
            {headerSeat
              ? (
                <button
                  className="sub headmachine"
                  id="agentInfoSeat"
                  type="button"
                  aria-label={`Choose the subscription. Current: ${headerSeat}, chosen for ${agent.name}`}
                  onClick={() => openLeaf('seat')}
                >
                  <span>on {headerSeat}</span>
                </button>
              )
              : null}
          </>
        )}
      />

      {/* Recap first — the durable latest-work sentence the fleet row
          previews — then the exact latest reply, kept separate so showing the
          reply never removes the recap above it. */}
      {agent.recap ? <div className="asays" id="agentInfoAbout">{agent.recap}</div> : null}
      {lastReply
        ? (
          <div className="agentlast" id="agentInfoLast">
            <div className="agentlastlabel">Last reply{lastReplyAge ? ` · ${lastReplyAge}` : ''}</div>
            {/* Folded when long (note #461), keyed on the words so a new
                reply arrives folded rather than inheriting the last one's tap. */}
            <FoldLong contentKey={lastReply.text}><div className="agentlastbody" id="agentInfoLastMessage"><Markdown source={lastReply.text} className="agentmessage" notes={notes} workspaceLinks /></div></FoldLong>
          </div>
        )
        : null}

      {chattable
        ? <ChatDoor id="agentChat" onPress={() => navigate(toFor({ kind: 'chat', id: agent.id })!)} />
        : null}

      <div className="card" id="agentFacts" hidden={!info && !limit && !waiting && !user}>
        {limit
          ? (
            <div className="agentlimit">
              <div className="limiticon"><Icon name="alert" size={18} /></div>
              <div className="agentlimitbody">
                <div className="agentlimithead">{limit.resumeReady ? 'Session limit reset' : 'Session limit reached'}</div>
                <div className="agentlimittext">
                  {limit.resumeReady
                    ? `The subscription is ready again. Resume sends a message so ${agent.name} can continue from where it stopped.`
                    : limit.resetsText
                      ? `The subscription resets ${limit.resetsText}. Resume appears here as soon as it is ready.`
                      : 'The subscription resets automatically. Resume appears here as soon as it is ready.'}
                </div>
                {limit.resumeReady
                  ? <button className="btn primary limitresume" type="button" onClick={() => { void resume(); }}>Resume</button>
                  : null}
              </div>
            </div>
          )
          : null}
        {waiting ? <DetailRow label="Status"><div className="v">{waiting}</div></DetailRow> : null}
        {/* WHO DRIVES IT (note #57) — the same signature every comment carries,
            on the screen that IS the agent, and a door to that person's page. */}
        {user?.name
          ? (
            <DetailRow label="Driven by">
              <button className="v person act" type="button" onClick={() => navigate(toFor({ kind: 'profile' })!)}>
                {user.profile?.photoUrl ? <img className="aface small" src={user.profile.photoUrl} alt="" /> : null}
                <span>{user.name} — you</span>
              </button>
            </DetailRow>
          )
          : null}
        {/* The Room row stood here, a door to moving the agent to another
            room, until rooms left the product (note #843). */}
        {showsSubscriptionRow(agent, org)
          ? (
            <DetailRow label="Subscription">
              {/* The agent's own choice of sign-in (note #773): a leaf, like
                  the model beside it. Which sign-in is primary
                  for the whole workplace stays the subscription's own page. */}
              <button
                className="v person act"
                type="button"
                aria-label={`Choose the subscription. Current: ${subscriptionLabel(agent, org?.seatUsage)}`}
                onClick={() => openLeaf('seat')}
              >
                <span>{subscriptionLabel(agent, org?.seatUsage)}</span>
              </button>
            </DetailRow>
          )
          : null}
        {machine
          ? (
            // "Asleep" is the normal state of a healthy agent and reads like a
            // fault to anyone who doesn't know that, so the row says what wakes it.
            <DetailRow label="Machine" note={machine.awake ? undefined : 'It wakes on your next message.'}>
              {/* A door since note #268: the same row now leads to what the
                  machine is made of and the sizes it can move onto. */}
              <button
                className="v person act machinevalue"
                type="button"
                aria-label={`Machine details and size. Current: ${machineLine(machine)}`}
                onClick={() => openLeaf('machine')}
              >
                <span>{machineLine(machine)}</span>
              </button>
            </DetailRow>
          )
          : null}
        {busy
          ? (
            <DetailRow label="Working">
              <div className="v">
                {agent.activitySince ? <><span>{elapsed(agent.activitySince, now)}</span><span> · </span></> : null}
                <span>{agent.activity || (agent.activitySince ? 'thinking…' : 'Right now')}</span>
              </div>
            </DetailRow>
          )
          : info?.lastActiveAt
            ? <DetailRow label="Last worked"><div className="v">{coarseActive(info.lastActiveAt, now)}</div></DetailRow>
            : null}
        {busy && agent.now
          ? (
            <DetailRow label="Working on" note={agent.nowAt ? `Started ${relative(agent.nowAt, now)}` : undefined}>
              <div className="v">{agent.now}</div>
            </DetailRow>
          )
          : null}
        {/* The agent's lifetime work total, not the current conversation:
            resetting a heavy chat should not erase the history of work it did. */}
        {Number.isSafeInteger(turnCount) && turnCount! >= 0
          ? <DetailRow label="Turns"><div className="v">{turnCount!.toLocaleString()}</div></DetailRow>
          : null}
        {/* How long it has worked, for life (note #644): every turn it ran,
            summed off a ledger that outlives both chat resets and the agent
            itself. An agent older than the counting says since when. */}
        {info && Number.isFinite(info.workedMs)
          ? (
            <DetailRow label="Worked" note={info.workedSince ? `Counted since ${dayWords(info.workedSince)}` : undefined}>
              <div className="v">{info.workedMs > 0 ? durationWords(info.workedMs) : 'Nothing yet'}</div>
            </DetailRow>
          )
          : null}
        {/* The recap itself lives above the facts, whole. What the facts carry
            is its AGE — a fact of the record the paragraph has no place for. */}
        {agent.recap && agent.recapAt
          ? <DetailRow label="Recap from"><div className="v">{relative(agent.recapAt, now) || 'just now'}</div></DetailRow>
          : null}
        {runtimeText
          ? (
            <DetailRow label="Thinks with">
              {runtimeChangeable
                ? (
                  <button
                    className="v person act runtimevalue"
                    type="button"
                    aria-label={`Change model and effort. Current: ${runtimeText}`}
                    onClick={() => openLeaf('runtime')}
                  >
                    <span>{runtimeText}</span>
                  </button>
                )
                : <div className="v">{runtimeText}</div>}
            </DetailRow>
          )
          : null}
        {info?.siteUrl
          ? (
            <DetailRow label="Its site">
              <a className="v act" href={info.siteUrl} target="_blank" rel="noopener noreferrer">
                {info.siteUrl.replace(/^https?:\/\//, '')}
              </a>
            </DetailRow>
          )
          : null}
      </div>

      <ScheduleCard agentId={id} now={now} />

      <div className="card" id="agentInfoCard">
        {!info
          ? <div className="empty">{versionError || 'Checking…'}</div>
          : (
            <>
              <CardRow glyph="terminal" title={info.cliLabel} meta={cliNote(info)} />
              {info.cliUpdateAvailable && !cliRidesImage(info)
                ? <BusyLockButton label={`Update ${info.cliLabel}`} busy={busy} running={running === 'cli'} onPress={() => { void startUpdate('cli'); }} />
                : null}
              {info.image
                ? (
                  <>
                    <CardRow glyph="drive" title="Machine software" meta={imageNote(info.image)} />
                    {info.image.canUpdate
                      ? <BusyLockButton label="Update machine software" busy={busy} running={running === 'machine'} onPress={() => setAsking('machine')} />
                      : null}
                  </>
                )
                : null}
              {/* What the agent was TOLD, under what it runs. No update button:
                  a machine behind this backend is rewritten by the backend at
                  the start of the agent's next turn, so the row says WHEN. */}
              {info.docs ? <CardRow glyph="filetext" title={info.docs.file} meta={docsNote(info.docs)} /> : null}
              <ContextUsageRow context={agent.context} busy={busy} />
              {contextPercent(agent.context) ? (
                <button
                  className="addrow busylock contextreset"
                  type="button"
                  disabled={busy || resetAsked}
                  style={busy || resetAsked ? { opacity: '.55' } : undefined}
                  data-running={resetAsked ? '1' : undefined}
                  onClick={() => { void askReset(); }}
                >
                  {resetAsked ? 'Asked — it will answer in its chat' : 'Ask agent to reset chat'}
                </button>
              ) : null}
              {/* Written whether or not it is busy and hidden when it is not, so
                  the tick shows and hides it as the turn starts and ends. */}
              <div className="hintblock busyhint" hidden={!busy}>
                {agent.name} is busy with a task right now — these actions unlock when it finishes.
              </div>
            </>
          )}
      </div>

      {/* The one place that can answer "what has this agent proposed" across
          repositories AND the knowledge base (note #276) — one list, newest
          first, because they are one body of work. Absent for an agent with
          no history — an empty card would be another fact to read without
          answering a question. */}
      <h2 id="agentPrsHead" hidden={proposals.length === 0}>Proposals</h2>
      <div className="card" id="agentPrs" hidden={proposals.length === 0}>
        {shownPrs.map((entry) => ('pr' in entry
          ? <ProposalRow key={entry.key} pr={entry.pr} branch={entry.pr.repoName} outcome />
          : <KnowledgeProposalRow key={entry.key} proposal={entry.page} outcome />))}
        {proposals.length > shownPrs.length
          ? (
            <button className="crow open" type="button" onClick={() => setShowAllPrs(true)}>
              <div className="main"><div className="name plain act">Show all {proposals.length} proposals</div></div>
            </button>
          )
          : null}
      </div>

      <div id="agentDanger">
        {/* The Workspace Agent's ask (note #710), over the one button that
            answers it: who asked, why, and Keep beside Delete. Deleting is
            still the typed name below — an ask lowers no gate. */}
        {agent.removeAsk && !kept ? (
          <div className="hintblock" id="agentRemoveAsk">
            {`${askedOf(agent.removeAsk)} to remove this agent${agent.removeAsk.reason ? `: ${agent.removeAsk.reason}` : ''}`}
          </div>
        ) : null}
        <div id="agentActions" className="danger-actions">
          <button className="btn danger bare" type="button" disabled={deleting} onClick={() => setAsking('delete')}>
            {deleting ? 'Deleting…' : 'Delete this agent'}
          </button>
          {agent.removeAsk && !kept ? (
            <button className="btn ghost bare" type="button" disabled={deleting} onClick={() => { void keep(); }}>Keep it</button>
          ) : null}
        </div>
        <div className="hintblock" id="agentHint">{deleteHint(agent)}</div>
      </div>

      {asking === 'delete'
        ? (
          <AskByTyping
            name={agent.name}
            lines={[
              'Its machine and everything on it are erased, for good. Its chat stops answering.',
              'This cannot be undone.',
            ]}
            verb="Delete"
            onAnswer={(confirmed) => { void confirmDelete(confirmed); }}
          />
        )
        : null}
      {asking === 'machine'
        ? (
          <AskToConfirm
            title="Update the machine software?"
            message="It restarts the machine — running apps stop for a minute, files are kept."
            verb="Update"
            onAnswer={(confirmed) => { setAsking(null); if (confirmed) void startUpdate('machine'); }}
          />
        )
        : null}
    </div>
  );
}
