/**
 * A knowledge proposal: what would change on each page, and the decision.
 *
 * This screen used to lead with the page RENDERED, which is the thing you
 * cannot check against — two renderings side by side leave finding the
 * difference to the reader, and a rewritten table inside prose that scans as
 * identical is exactly what gets missed. So the DIFF is the screen, open, in
 * the same card and colours a change proposal's diff wears; the rendering is
 * the button under it, because a knowledge page's whole point is that it
 * renders and only the rendering says whether the result reads well.
 *
 * That rendering is a LEAF of this screen with no address of its own — the
 * page it shows does not exist yet — so it spends a history entry at the same
 * address and the persistent header's Back is one hop up, onto the change the
 * reader left to go and read it.
 *
 * Deciding says so in the TOAST and does nothing else (note #303). It used to
 * throw the reader back to Home and leave a card standing there, which is two
 * things nobody asked for: the reader loses the page they were reading, and
 * the word for what happened outlives the moment it belongs to. So the screen
 * stays put and becomes the record — the bar goes, the signature line dates
 * the decision — exactly as a decided change proposal's does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceKnowledgeChange,
  WorkspaceKnowledgeDecisionAnswer,
  WorkspaceKnowledgeProposalDetailAnswer,
  WorkspaceMarginComment,
} from '../../../../src/shared/workspace-api.js';
import { Diff } from '../../render/Diff.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { knowledgePatch } from '../../render/knowledge-diff.js';
import { Markdown } from '../../render/Markdown.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { HandRow } from '../../ui/HandRow.js';
import { HandoffSend } from '../../ui/HandoffSend.js';
import { knowledgeProposalHandoffText } from '../../ui/handoff.js';
import { Icon } from '../../ui/icons.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { relative, useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import { markDecided } from '../../workspace/decided.js';
import type { HomeAgent } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SummaryRow } from './Checks.js';
import { DecideBar, NotReadyToDecide, NotYoursToDecide, type Decision } from './DecideBar.js';
import { FoldLong } from './FoldLong.js';
import { MarginThread } from './MarginThread.js';
import { agentSignature, knowledgeDecisionWording, runtimeLine } from './proposal-words.js';
import { ChatDoor, ProposalWho } from './ProposalHead.js';
import { agentFaceToId } from './face-to.js';
import { SkelKnowledgeChange, SkelRuntime, SkelWriteUp } from './Skeleton.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBanner } from '../../chrome/useBanner.js';

const detailPath = (id: string) => `api/knowledge/proposals/${encodeURIComponent(id)}`;

/** Which page in this proposal the reader stepped into, if any. Held in the
 *  history entry rather than in state so Back closes it. */
interface PreviewState { view?: string; page?: string }

/** "New knowledge", not "new page": the reader's word for this is the one on
 *  the section it lands in, and "page" is the file it happens to be. */
function changeLabel(action: WorkspaceKnowledgeChange['action']): string {
  if (action === 'delete') return 'Removing';
  if (action === 'create') return 'New knowledge';
  if (action === 'rename') return 'Renaming';
  return 'Update';
}

function ChangeCard({ change, onRead }: { change: WorkspaceKnowledgeChange; onRead: () => void }) {
  const gone = change.action === 'delete';
  // A rename carries the page's bytes unchanged, so the two versions are
  // identical and there is no patch to build — the change is the ADDRESS, and
  // the head above says it in full.
  const moving = change.action === 'rename' && Boolean(change.renameTo);
  // Built here rather than fetched: the response already carries both versions
  // of the source.
  const patch = useMemo(
    () => (moving
      ? null
      : knowledgePatch(`${change.page}.html`, change.currentHtml || '', gone ? '' : (change.html || ''))),
    [change.page, change.currentHtml, change.html, gone, moving],
  );
  return (
    <div className="card kchange">
      <div className="khead">
        <Icon name="bulb" size={14} />
        <span className={gone ? 'kact gone' : 'kact'}>{changeLabel(change.action)}</span>
        <span className="kname">{moving ? `${change.page} → ${change.renameTo}` : change.page}</span>
      </div>
      {/* A page that moved after this was written cannot land — said here, in
          front of the button, rather than discovered by tapping it. */}
      {change.moved ? (
        <div className="hintline">
          This page changed after the proposal was written, so this cannot be applied. Ask the agent to redo
          it against what the page says now.
        </div>
      ) : null}
      {moving ? (
        // Said plainly, because the diff below would otherwise be empty and
        // read as "nothing happens here". What a rename costs is worth naming
        // too: the page's own address is what other pages and notes quote.
        <div className="hintline">
          The page keeps every word it has — only its address changes, from <b>{change.page}</b> to{' '}
          <b>{change.renameTo}</b>. Its comments move with it.
        </div>
      ) : patch
        ? <Diff patch={patch} open />
        : <div className="hintline">This would leave the page exactly as it is.</div>}
      {/* Three words, and the same three whatever the change is: the card above
          already says UPDATE, or NEW KNOWLEDGE, or REMOVING, and names the
          page, so a button under it need not say which page or which version. */}
      <SummaryRow glyph="bulb" name="Read the page" opens className="kread" onPress={onRead} />
    </div>
  );
}

/** The page as it WOULD be — with the files the change would leave it with, so
 *  "read the page as it would be" shows the diagram it would have rather than
 *  a gap where one is (notes #10/#18). */
function ProposedPage({ change }: { change: WorkspaceKnowledgeChange }) {
  const notes = useNoteRefs();
  const gone = change.action === 'delete';
  const title = change.title || change.page;
  const source = (gone ? change.currentHtml : change.html) || '';
  // The files this change would LEAVE the page with are its gallery, so the
  // preview steps between diagrams exactly as the live page does.
  const viewer = useImageViewer();
  const gallery = useMemo(
    () => Object.entries(change.files ?? {}).map(([name, url]) => ({ name, url })),
    [change.files],
  );
  const openImage = useCallback((url: string, name: string) => {
    const at = gallery.findIndex((image) => image.name === name);
    viewer(gallery.length ? gallery : [{ url, name }], at < 0 ? 0 : at);
  }, [gallery, viewer]);
  const files = useMemo(() => change.files ?? null, [change.files]);
  return (
    <div className="screen" id="screenKnowledgePage">
      <ScreenTitle titleId="kpageTitle" title={title} subId="kpageSub" sub={change.description || ''} />
      <div id="kpageBody">
        <KnowledgeHtml source={source} files={files} dropTitle={title} onImage={openImage} noteRefs={notes} />
      </div>
    </div>
  );
}

export function KnowledgeProposalScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { agents, state, reload } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow(false);
  const banner = useBanner();
  const notes = useNoteRefs();

  const [detail, setDetail] = useState<WorkspaceKnowledgeProposalDetailAnswer | null>(null);
  const [loadError, setLoadError] = useState('');
  const [deciding, setDeciding] = useState<Decision | null>(null);
  /** The idle agent picked to review this proposal. Kept out of the address:
   *  the Send is a transient leaf over the review screen. */
  const [handing, setHanding] = useState<HomeAgent | null>(null);
  /** What went wrong: a flow that refused, or the error the call threw. The
   *  decision that LANDS is not said here — it is said in the toast. */
  const [said, setSaid] = useState('');
  /** Whether the read is late enough to say so, and long enough that saying so
   *  does not read as a flicker (note #287). */
  const wait = useWait(!detail && !loadError);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceKnowledgeProposalDetailAnswer>(
          detailPath(id), undefined,
        );
        if (!current || !alive.current) return;
        setDetail(answer);
        setLoadError('');
      } catch (error) {
        if (current && alive.current) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { current = false; };
  }, [api, id]);

  const onComments = useCallback((comments: WorkspaceMarginComment[]) => {
    setDetail((current) => (current
      ? { ...current, proposal: { ...current.proposal, comments } }
      : current));
  }, []);
  const closeHandoff = useCallback(() => { setHanding(null); }, []);

  const decide = (decision: Decision) => {
    const proposal = detail?.proposal;
    if (!proposal || deciding) return;
    setDeciding(decision);
    setSaid('');
    void (async () => {
      try {
        const out = await api.api<WorkspaceKnowledgeDecisionAnswer>(`${detailPath(proposal.id)}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // No note rides a rejection from here, exactly as with a change
          // proposal: the reason belongs in the chat with the agent, in the
          // user's own words.
          body: JSON.stringify({ decision }),
        });
        // Every waiting list drops it now, whether or not this screen is
        // still standing to see the answer (note #743).
        markDecided('knowledge', proposal.id, out.status);
        if (!alive.current) { void reload(); return; }
        setDeciding(null);
        const line = knowledgeDecisionWording(out.status);
        if (line) {
          // The toast is the whole announcement (note #303). The screen keeps
          // the reader where they were and turns into the record: the local
          // status is what takes the bar away and dates the decision, which is
          // what the next read would say anyway.
          banner.show(line, true);
          setDetail((current) => (current ? {
            ...current,
            proposal: {
              ...current.proposal,
              status: out.status ?? current.proposal.status,
              decidedAt: current.proposal.decidedAt ?? new Date().toISOString(),
            },
          } : current));
        } else {
          // The guard note is the honest answer when the flow refused to act —
          // a page that moved, or a proposal already decided somewhere else.
          // Nothing was published, the bar is still there, so it stays written
          // on the screen instead of draining away.
          setSaid(out.note || 'That did not work — the chat with the agent has the details.');
        }
        // Home is now wrong in two places (the queue, and the pages
        // themselves), so it re-reads behind this screen rather than being
        // patched in the dark.
        void reload();
      } catch (error) {
        if (!alive.current) return;
        setDeciding(null);
        setSaid(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  // ---- The wait (note #299) ---------------------------------------------
  // The same rule the change queue's screen follows: what the row the reader
  // tapped already says is painted as itself — the proposal's name, who
  // proposed it, the door to that agent — and only what the read still owes is
  // held. Here that is the agent's runtime, the reason they gave, and the
  // pages themselves; the queue row knows HOW MANY of those there are, so the
  // wait draws one card each rather than a guess.
  if (!detail) {
    const drawn = wait === 'drawn' && !loadError;
    const queued = (state?.knowledgeProposals ?? []).find((row) => row.id === id);
    const waitAgent = queued?.agentId ? (agents ?? []).find((row) => row.id === queued.agentId) : undefined;
    const waitChat = waitAgent && (waitAgent.status === 'ready' || Boolean(waitAgent.working));
    const waitBar = Boolean(queued && queued.status === 'open' && queued.canDecide !== false);
    const waitSigned = agentSignature(queued?.agentName, null);
    const waitWhen = queued?.createdAt ? relative(queued.createdAt, now) : '';
    return (
      <div className={waitBar ? 'screen hasbar' : 'screen'} id="screenKp" aria-busy={!loadError}>
        {drawn ? <span className="sr-only" role="status">Loading this proposal…</span> : null}
        <ScreenTitle titleId="kpTitle" title={queued?.title ?? 'Proposal'} />
        {queued
          ? (
            <ProposalWho
              id="kpSub"
              className="sub who"
              avatarUrl={queued.agentAvatarUrl}
              agentId={queued.agentId}
              agentTo={queued.agentId ? agentFaceToId(queued.agentId, agents ?? null) : null}
              agentName={queued.agentName}
              line={(waitSigned ? `${waitSigned} proposed this` : 'Proposed') + (waitWhen ? ` · ${waitWhen}` : '')}
              {...(drawn && queued.agentName ? { runtime: <SkelRuntime /> } : {})}
            />
          )
          : null}
        {waitChat
          ? <ChatDoor id="kpChat" onPress={() => navigate(toFor({ kind: 'chat', id: waitAgent.id })!)} />
          : null}
        <div id="kpBody">
          {loadError ? <div className="empty">{loadError}</div> : null}
          {drawn ? (
            <>
              {/* The agent's reason for the change is the one held box here
                  that MIGHT not fill — a proposal can arrive without a note.
                  It is held anyway: almost all of them carry one, and the
                  alternative is a bare gap above the cards either way. */}
              <SkelWriteUp />
              {(queued?.pages?.length ? queued.pages : ['']).map((page, at) => (
                <SkelKnowledgeChange key={page || at} at={at} />
              ))}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  const proposal = detail.proposal;
  const changes = detail.changes ?? [];
  // A quiet proposal (note #293) is nobody's to decide yet — the server
  // sends canDecide false for it, and the screen says why, below.
  const decidable = proposal.status === 'open' && proposal.canDecide !== false && !proposal.draft;
  // A page that moved under the proposal will be refused on landing, so the
  // button says so instead of promising something the backend will decline.
  const stale = changes.some((change) => change.moved);
  const agent = proposal.agentId ? (agents ?? []).find((row) => row.id === proposal.agentId) : undefined;
  const chattable = agent && (agent.status === 'ready' || Boolean(agent.working));
  const preview = location.state as PreviewState | null;
  const shownPage = preview?.view === 'page'
    ? changes.find((change) => change.page === preview.page)
    : undefined;

  if (handing) {
    return (
      <HandoffSend
        agent={handing}
        prefill={knowledgeProposalHandoffText(handing, proposal.number, proposal.title)}
        onClose={closeHandoff}
      />
    );
  }

  const bar = decidable ? (
    <DecideBar
      approveLabel={stale ? 'A page changed — cannot apply' : 'Approve & publish'}
      approveRunning="Publishing"
      blocked={stale}
      busy={deciding}
      onDecide={decide}
    />
  ) : null;

  if (shownPage) {
    return (
      <>
        <ProposedPage change={shownPage} />
        {bar}
      </>
    );
  }

  // Who asked, and when — the same line a change proposal's screen carries,
  // with the same face. What it does NOT carry is a count of pages: the cards
  // below are the pages, each labelled with what would happen to it.
  const when = proposal.status === 'open'
    ? (proposal.createdAt ? relative(proposal.createdAt, now) : '')
    : (proposal.decidedAt ? relative(proposal.decidedAt, now) : '');
  const signed = agentSignature(proposal.agentName, proposal.userName);
  const runtime = runtimeLine(proposal.agentRuntime);

  return (
    <>
      <div className={decidable ? 'screen hasbar' : 'screen'} id="screenKp">
        <ScreenTitle titleId="kpTitle" title={proposal.title} />
        <ProposalWho
          id="kpSub"
          className="sub who"
          avatarUrl={proposal.agentAvatarUrl}
          agentId={proposal.agentId}
          agentTo={proposal.agentId ? agentFaceToId(proposal.agentId, agents ?? null) : null}
          agentName={proposal.agentName}
          line={(signed ? `${signed} proposed this` : 'Proposed')
            + (when ? ` · ${when}` : '')
            + (proposal.status === 'open' ? (proposal.draft ? ' · still being prepared' : '') : ` · ${proposal.status}`)}
          runtime={runtime}
        />
        {/* The same door a change proposal's screen carries (note #152): one
            decision queue, one way to reach the agent behind the row. */}
        {chattable ? <ChatDoor id="kpChat" onPress={() => navigate(toFor({ kind: 'chat', id: agent.id })!)} /> : null}
        <div id="kpBody">
          {/* The agent's own reason for the change, before the change itself. */}
          {proposal.note ? <FoldLong contentKey={proposal.note}><Markdown source={proposal.note} notes={notes} /></FoldLong> : null}
          {changes.map((change) => (
            <ChangeCard
              change={change}
              key={change.page}
              onRead={() => navigate(`${location.pathname}${location.search}`, {
                state: { view: 'page', page: change.page },
              })}
            />
          ))}
          {proposal.decisionNote ? (
            <div className="hintline">Your note to the agent: {proposal.decisionNote}</div>
          ) : null}
          {said ? <div className="hintline" id="kpSaid" role="status">{said}</div> : null}
        </div>
        {/* Review first, then the hand-off, then the margin about it — the
            same order as the change proposal and the note detail screen. */}
        <HandRow
          ids={{ head: 'kpHandsHead', card: 'kpHandsCard', row: 'kpHands', hint: 'kpHandsHint' }}
          noun="proposal"
          head="Ask for review"
          closed={proposal.status !== 'open'}
          excludeAgentId={proposal.agentId}
          onOpen={setHanding}
          onDetail={(row) => navigate(toFor({ kind: 'agent', id: row.id })!)}
        />
        {/* The knowledge proposal's margin — the change proposal's, on the
            other decision queue, under the same rules. */}
        <MarginThread
          ids={{ head: 'kpCommentsHead', card: 'kpCommentsCard', box: 'kpComments' }}
          comments={proposal.comments ?? []}
          canWrite={proposal.status === 'open' || proposal.status === 'conflict'}
          path={`${detailPath(proposal.id)}/comments`}
          onPosted={onComments}
          onAgentId={(agentId) => navigate(agentFaceToId(agentId, agents ?? null)!)}
          onSay={setSaid}
        />
      </div>
      {proposal.status === 'open' && proposal.draft
        ? <NotReadyToDecide agentName={proposal.agentName} />
        : proposal.status === 'open' && proposal.canDecide === false ? <NotYoursToDecide what="page" /> : null}
      {bar}
    </>
  );
}
