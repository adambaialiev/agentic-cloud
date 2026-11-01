/**
 * One change proposal, and the decision on it.
 *
 * The order is the reading order: what it is, who asked, how big it is and
 * what CI made of it, then their write-up, the request behind it and the
 * evidence they attached. The diff is a screen of its own behind the first
 * summary row — a forty-file proposal must not put its own file count below
 * a fold.
 *
 * That diff is a LEAF of this screen and has no address of its own (rule 2 of
 * the migration plan: a transient view keeps the stable route underneath it).
 * It spends a history entry at the same address, so the persistent header's
 * Back closes the diff and lands on the row it was opened from, and the
 * reading line comes back with it.
 *
 * The decision is pinned to the bottom rather than stacked above the reading.
 * Both orders keep it one thumb away; only this one lets the change reach the
 * reader first.
 *
 * A decision that LANDS announces itself in the toast and nowhere else (note
 * #303): the bar goes, the pill says what became of the proposal, and the
 * screen is the record any reader opening it tomorrow would see. Only a
 * failure stays written on the screen — the bar is still there, and a
 * five-second toast is the wrong place for something the reader must act on.
 *
 * The screen is kept in step with CI: it asks again while anything can still
 * change, and repaints the three things that depend on the answer — the action
 * rows, the decision bar, and the line that says what approving would do. It
 * keeps asking even while the reader is off in the diff, because the loop is
 * short-lived by construction and it means Back lands them on the truth.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceCheckRow,
  WorkspaceMarginComment,
  WorkspaceProposalCommit,
  WorkspaceProposalDecisionAnswer,
  WorkspaceProposalDeliveryAnswer,
  WorkspaceProposalDetailAnswer,
} from '../../../../src/shared/workspace-api.js';
import { Diff } from '../../render/Diff.js';
import { Markdown } from '../../render/Markdown.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { HandRow } from '../../ui/HandRow.js';
import { HandoffSend } from '../../ui/HandoffSend.js';
import { changeProposalHandoffText } from '../../ui/handoff.js';
import { Icon } from '../../ui/icons.js';
import { reducedMotion } from '../../ui/motion.js';
import { relative, useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import { markDecided } from '../../workspace/decided.js';
import type { HomeAgent } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import { ChecksRow, SummaryRow } from './Checks.js';
import { checkBucket, checksGreen } from './checks.js';
import { DecideBar, NotReadyToDecide, NotYoursToDecide, type Decision } from './DecideBar.js';
import { Delivery } from './Delivery.js';
import { deliverySignature, deliveryWaiting, type DeliveryView } from './delivery.js';
import { FoldLong } from './FoldLong.js';
import { ChatDoor, ProposalEyebrow, ProposalPills, ProposalWho } from './ProposalHead.js';
import { agentFaceToId } from './face-to.js';
import { MarginThread } from './MarginThread.js';
import { ProposalFiles } from './ProposalFiles.js';
import { warmMediaOrigin } from './proposal-previews.js';
import { agentSignature, approveHint, decisionWording, runtimeLine, statusPill } from './proposal-words.js';
import {
  SkelDecide, SkelEyebrow, SkelPills, SkelRuntime, SkelSummary, SkelWho, SkelWriteUp,
} from './Skeleton.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBanner } from '../../chrome/useBanner.js';

/** Fast enough that a check landing feels immediate, slow enough to be quiet:
 *  the same 5s the home queue already polls on. */
export const PR_POLL_MS = 5000;
/** How long to keep asking for an action that has not appeared AT ALL. CI
 *  files its first row within seconds of the push, so two minutes of silence
 *  is an answer rather than a delay — and the reader is told to give it a
 *  moment. */
export const PR_FIRST_CHECK_POLLS = 24;
/** How far below the sticky header the landing sequence comes to rest: clear
 *  enough of the rule to read as its own thing, close enough that its first
 *  stage is not pushed down the screen. */
export const LANDING_GAP_PX = 12;

const detailPath = (id: string) => `api/prs/${encodeURIComponent(id)}`;

/** Whether anything on this screen can still change on its own: an action
 *  still running, or a gated proposal CI has not spoken about yet. Everything
 *  else is settled, and a settled screen has no business asking the server. */
function checksWaiting(detail: WorkspaceProposalDetailAnswer, tries: number): boolean {
  if (detail.pr.status !== 'open') return false;
  const checks = detail.checks ?? [];
  if (checks.some((check) => check.state === 'pending')) return true;
  return checks.length === 0 && Boolean(detail.requireChecks) && tries < PR_FIRST_CHECK_POLLS;
}

/** How big the change is, in the right-hand column every row keeps for its one
 *  scannable number. A span, not a div: it reads inside a heading and a prose
 *  line as happily as it does as a flex child of a row. */
function StatNode({ stat }: { stat?: { insertions: number; deletions: number } }) {
  const { insertions, deletions } = stat ?? { insertions: 0, deletions: 0 };
  return (
    <span className="stat">
      <span className="plus">+{insertions}</span>
      <span className="minus">−{deletions}</span>
    </span>
  );
}

/**
 * Subject and sha, one row each — the sha is what a reader takes to a
 * terminal, and with one there is a commit to open. Sha and age share one
 * right-hand column, stacked: a proposal's commits are the only place that
 * says WHEN the work was done, and hanging the age off the end of the subject
 * would have paid for it in subject width on a phone.
 */
function CommitRows({ commits, commitTo, now }: {
  commits: readonly WorkspaceProposalCommit[];
  commitTo: (sha: string) => string | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <SummaryRow
        glyph="commit"
        name={`${commits.length} commit${commits.length === 1 ? '' : 's'}`}
        opens
        onPress={() => setOpen(!open)}
      />
      <div className="prlist" hidden={!open}>
        {commits.map((commit, at) => {
          // Without a sha — the frozen record of a compare that failed — the
          // row stays a plain line.
          const to = commit.sha ? commitTo(commit.sha) : null;
          const when = commit.at ? relative(commit.at, now) : '';
          const line = (
            <>
              <span className="psubject">{commit.subject}</span>
              {commit.sha ? (
                <div className="pmeta">
                  <span className="psha">{commit.sha.slice(0, 7)}</span>
                  {when ? <span className="pwhen">{when}</span> : null}
                </div>
              ) : null}
              {to ? <Icon name="chev" size={15} className="icon chev" /> : null}
            </>
          );
          const key = `${commit.sha ?? ''}:${at}`;
          return to
            ? <PressableRow className="prcommit open" key={key} onPress={() => navigate(to)}>{line}</PressableRow>
            : <div className="prcommit" key={key}>{line}</div>;
        })}
      </div>
    </>
  );
}

export function ProposalScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { agents, state, reload } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow(false);
  const banner = useBanner();
  // `notes` below is the proposal's own linked notes; this is the mention
  // renderer, which turns "note #284" in the write-up into a door.
  const noteRefs = useNoteRefs();

  const [detail, setDetail] = useState<WorkspaceProposalDetailAnswer | null>(null);
  const [loadError, setLoadError] = useState('');
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  /** The idle agent picked to review this proposal. The Send is a transient
   *  leaf on the proposal's address, just like the one a note opens. */
  const [handing, setHanding] = useState<HomeAgent | null>(null);
  /** The margin's own line: what posting a comment came back saying. The
   *  DECISION does not write here — it speaks in the toast (note #303). */
  const [said, setSaid] = useState('');
  /** What went wrong with a decision: the guard note from a flow that refused,
   *  or the error the call threw. It stays ON the screen rather than draining
   *  away with a toast, because the bar is still there and the question it
   *  asks is still open. */
  const [refusal, setRefusal] = useState('');
  /** Re-arms the CI loop after each poll without touching the record. */
  const [tick, setTick] = useState(0);
  /** Whether the first read is late enough to say so, and long enough that
   *  saying so does not read as a flicker (note #287). */
  const wait = useWait(!detail && !loadError);
  // The picture store's connection, opened while this proposal is being
  // read rather than after its answer names a picture (follow-up to #825).
  useEffect(() => { warmMediaOrigin(); }, []);

  /** Set by an approval made ON THIS SCREEN, and cleared by the scroll it
   *  asks for. A merge decided in the chat or on another device paints the
   *  same card, and a screen that moved under a reader who tapped nothing is a
   *  screen behaving on its own. */
  const toLanding = useRef(false);

  const alive = useRef(true);
  // A decision is a merge on the host that takes seconds. A refresh landing in
  // the middle would repaint the bar and take the busy state away from a merge
  // that is still happening, so the screen holds still until it is over.
  const decidingRef = useRef(false);
  const tries = useRef(0);
  const quiet = useRef(0);
  const signature = useRef('');
  // The room every call rides in, read at the moment it is made: a proposal is
  // addressed by id alone, so a room switch behind this screen must not send
  // it back to the server for the same record.

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The row that opened this screen already carries the proposal's write-up.
  // Painting it BEFORE the live compare starts is the difference between a
  // body that was true a moment ago and a blank Loading screen, while the
  // diff, checks and status still refresh underneath.
  const queued = (state?.prs ?? []).find((row) => row.id === id);

  // Addresses, needed by the wait as much as by the answer: the repository the
  // eyebrow points at, and the notes this proposal implements.
  const orgId = state?.org?.orgId;
  const scope = orgId ? { orgId } : {};
  const repoTo = (name: string) => (orgId ? toFor({ kind: 'repo', id: name, ...scope }) : null);
  const noteTo = (number: number) => (orgId ? toFor({ kind: 'note', id: String(number), ...scope }) : null);

  /** What a refresh is allowed to change. The diff is deliberately NOT in that
   *  list: what the reader decides on is what they were shown, and a branch
   *  that moves mid-read is caught by the head sha the approval carries. */
  const applyRefresh = useCallback((fresh: WorkspaceProposalDetailAnswer) => {
    setDetail((current) => (current ? {
      ...current,
      checks: fresh.checks ?? [],
      requireChecks: fresh.requireChecks,
      ci: fresh.ci,
      pr: {
        ...current.pr,
        // Decided elsewhere — in the chat, or on another device. The header
        // pill is what says so, exactly as it would had the screen opened on
        // it.
        status: fresh.pr.status,
        decidedAt: fresh.pr.decidedAt,
        decisionNote: fresh.pr.decisionNote,
      },
    } : current));
    if (fresh.pr.status === 'merged' && fresh.delivery) {
      quiet.current = 0;
      signature.current = deliverySignature(fresh.delivery);
      setDelivery({ ...fresh.delivery, settled: !deliveryWaiting(fresh.delivery, 0) });
    }
  }, []);

  // The first read. A failed one does not make the cached write-up untrue: the
  // error takes the place of the wait, and everything the queue row already
  // said keeps standing under it.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceProposalDetailAnswer>(
          detailPath(id), undefined,
        );
        if (!current || !alive.current) return;
        tries.current = 0;
        setDetail(answer);
        setLoadError('');
        if (answer.delivery) {
          quiet.current = 0;
          signature.current = deliverySignature(answer.delivery);
          setDelivery({ ...answer.delivery, settled: !deliveryWaiting(answer.delivery, 0) });
        }
      } catch (error) {
        if (current && alive.current) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { current = false; };
  }, [api, id]);

  // The CI loop. It ends when CI stops talking; what ends it early is opening
  // a different proposal, which unmounts this screen.
  useEffect(() => {
    if (!detail || !checksWaiting(detail, tries.current)) return;
    const held = setTimeout(() => {
      void (async () => {
        // Mid-merge: ask again in a moment rather than paint over a live
        // decision.
        if (decidingRef.current) { if (alive.current) setTick((value) => value + 1); return; }
        try {
          const fresh = await api.api<WorkspaceProposalDetailAnswer>(
            detailPath(id), undefined,
          );
          if (!alive.current) return;
          tries.current = (fresh.checks ?? []).length === 0 ? tries.current + 1 : 0;
          applyRefresh(fresh);
        } catch {
          // A poll that fails says nothing on the screen — the last good
          // answer is still true, and the next one is five seconds away.
          if (alive.current) tries.current += 1;
        }
        if (alive.current) setTick((value) => value + 1);
      })();
    }, PR_POLL_MS);
    return () => clearTimeout(held);
  }, [api, id, detail, tick, applyRefresh]);

  // The landing loop, on its own endpoint: a main-branch run can be serial and
  // several minutes long, and polling the full proposal route for it would ask
  // the git host to rebuild a frozen diff that cannot change.
  useEffect(() => {
    if (!delivery || delivery.settled || delivery.merging) return;
    const held = setTimeout(() => {
      void (async () => {
        try {
          const fresh = await api.api<WorkspaceProposalDeliveryAnswer>(
            `${detailPath(id)}/delivery`, undefined,
          );
          if (!alive.current) return;
          if (fresh.status !== 'merged' || !fresh.delivery) {
            // A merge is irreversible, so this only covers a stale client
            // talking to an older backend. Leave the record on screen and stop
            // claiming it is live rather than inventing a fourth state.
            setDelivery((current) => (current ? { ...current, settled: true } : current));
            return;
          }
          const next = deliverySignature(fresh.delivery);
          const running = (fresh.delivery.checks ?? []).some((check) => check.state === 'pending');
          quiet.current = running || next !== signature.current ? 0 : quiet.current + 1;
          signature.current = next;
          setDelivery({ ...fresh.delivery, settled: !deliveryWaiting(fresh.delivery, quiet.current) });
          setDetail((current) => (current ? {
            ...current,
            pr: { ...current.pr, status: 'merged', decidedAt: fresh.decidedAt ?? current.pr.decidedAt },
          } : current));
        } catch {
          // The last good answer remains true. The age bound settles even a
          // screen whose backend stays unreachable.
          if (alive.current) {
            quiet.current += 1;
            setDelivery((current) => (current
              ? { ...current, settled: !deliveryWaiting(current, quiet.current) }
              : current));
          }
        }
      })();
    }, PR_POLL_MS);
    return () => clearTimeout(held);
  }, [api, id, delivery]);

  // Approving turns the screen's question from "should this land?" into "what
  // is happening now?" — and the reader is at the BOTTOM of the page, on the
  // bar they just tapped, while the answer is written at the top of it. So the
  // approval takes them to it.
  //
  // Measured in an effect, after the commit, never beside the `setDelivery`
  // that asks for it: a card still being laid out answers 0 for every box, and
  // the screen would slide to the wrong line.
  useEffect(() => {
    if (!toLanding.current || !delivery) return;
    const node = document.getElementById('prDelivery');
    if (!node) return;
    toLanding.current = false;
    // Under the sticky header, not behind it.
    const head = document.getElementById('pageHead');
    const clear = head ? head.getBoundingClientRect().height : 0;
    const top = Math.max(0, node.getBoundingClientRect().top + window.scrollY - clear - LANDING_GAP_PX);
    // The movement IS the explanation of what the tap did, so it is smooth —
    // unless the reader has asked for less of it, in which case it just
    // arrives.
    if (!reducedMotion() && typeof window.scrollTo === 'function') {
      window.scrollTo({ top, behavior: 'smooth' });
    } else {
      window.scrollTo(0, top);
    }
  }, [delivery]);

  const onComments = useCallback((comments: WorkspaceMarginComment[]) => {
    setDetail((current) => (current ? { ...current, pr: { ...current.pr, comments } } : current));
  }, []);
  const closeHandoff = useCallback(() => { setHanding(null); }, []);

  const decide = (decision: Decision) => {
    const pr = detail?.pr;
    if (!pr || deciding) return;
    // Known before the landing is: a repository with CI off says so on its
    // later stages from the first frame, rather than promising them as next.
    const ci = detail?.ci;
    setDeciding(decision);
    decidingRef.current = true;
    setRefusal('');
    // Approval changes the screen's question from "should this land?" to "what
    // is happening now?": the merge is the active stage and the later two are
    // visibly next, before any network answer exists to list.
    if (decision === 'approve') {
      toLanding.current = true;
      setDelivery({ branch: pr.to, mergedAt: null, checks: [], live: false, ci, merging: true, settled: false });
    }
    void (async () => {
      try {
        const out = await api.api<WorkspaceProposalDecisionAnswer>(`${detailPath(pr.id)}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // headSha: the state this screen showed. What merges is exactly what
          // was read; a branch that moved re-asks instead. No note rides a
          // rejection from here — the reason belongs in the chat with the
          // agent, in the user's own words.
          body: JSON.stringify({ decision, ...(detail?.headSha ? { headSha: detail.headSha } : {}) }),
        });
        // Before the screen asks whether it is still standing: a reader who
        // left while the merge ran has decided all the same, and every
        // waiting list owes them that (note #743).
        markDecided('pr', pr.id, out.status);
        // Home's state is as stale for a reader who has gone as for one who
        // stayed: its room marks still count this proposal.
        if (!alive.current) { void reload(); return; }
        const line = decisionWording(out.status, pr.to, pr.agentName);
        if (line) {
          // The decision announces itself in the TOAST, and nowhere else (note
          // #303). What stays on the screen underneath is the record — the
          // pill, and what became of the merge — which is what any reader
          // opening this proposal tomorrow sees too. The tick is for a
          // decision that landed as asked; a merge that did not happen
          // (stale, conflicts) keeps the warning mark it deserves.
          banner.show(line, out.status === 'merged' || out.status === 'rejected');
        } else {
          // The flow refused (already decided, proposal gone) or the merge
          // itself failed; the guard note says which, and the chat has the
          // detail. Said once, on the screen — a five-second toast is the
          // wrong place for something the reader has to act on.
          setRefusal(out.note || 'That did not work — the chat with the agent has the details.');
        }
        if (out.status) {
          const landed = out.status;
          setDetail((current) => (current ? {
            ...current,
            pr: {
              ...current.pr,
              status: landed,
              decidedAt: current.pr.decidedAt
                ?? ((landed === 'merged' || landed === 'rejected') ? new Date().toISOString() : null),
            },
          } : current));
        }
        if (decision === 'approve') {
          if (out.status === 'merged') {
            quiet.current = 0;
            signature.current = '';
            setDelivery({
              branch: pr.to,
              mergedAt: new Date().toISOString(),
              checks: [],
              live: false,
              ci,
              merging: false,
              settled: false,
            });
          } else {
            setDelivery(null);
          }
        }
        // The home queue is stale now — refresh it behind this screen so Back
        // lands on the truth.
        void reload();
      } catch (error) {
        if (!alive.current) return;
        if (decision === 'approve') setDelivery(null);
        setRefusal(error instanceof Error ? error.message : String(error));
      } finally {
        decidingRef.current = false;
        if (alive.current) setDeciding(null);
      }
    })();
  };

  // ---- The wait (note #299) ---------------------------------------------
  // What the row that opened this screen already knows is painted as ITSELF:
  // its name, the repository and number, the state it is in, the branches it
  // is between, who proposed it and their own write-up. Only what the live
  // compare has to answer for is held — that agent's runtime, the size of the
  // change, its commits, what CI made of it — and the decision is held as
  // ROOM rather than as buttons.
  //
  // A screen opened from anywhere but the queue — a link, an agent's own list,
  // a proposal already decided — knows none of that, and gets the whole shape
  // instead.
  if (!detail) {
    // A failure is not a wait. It replaces the whole shape at once rather than
    // leaving the reader watching boxes breathe over something that is never
    // going to arrive.
    const drawn = wait === 'drawn' && !loadError;
    const waitAgent = queued?.agentId ? (agents ?? []).find((row) => row.id === queued.agentId) : undefined;
    const waitChat = waitAgent && (waitAgent.status === 'ready' || Boolean(waitAgent.working));
    // Whether there will be a bar is knowable, so its room is reserved from
    // the first frame — otherwise the answer landing lengthens the page under
    // a thumb that is already scrolling.
    const waitBar = Boolean(queued && queued.status === 'open' && queued.canDecide !== false);
    const waitSigned = agentSignature(queued?.agentName, queued?.userName);
    const waitWhen = queued?.createdAt ? relative(queued.createdAt, now) : '';
    return (
      <>
        <div className={waitBar ? 'screen hasbar' : 'screen'} id="screenPr" aria-busy={!loadError}>
          {/* Drawn for nobody, read aloud to somebody: the blocks below are
              decoration, so the wait still says in words what it is. It stands
              HERE, above the screen's own blocks, rather than between two of
              them — `#prBody .mdwrap + .card` is what gives the summary card
              its gap, and a node slipped between those two siblings takes the
              gap away and moves the card 14px up. */}
          {drawn ? <span className="sr-only" role="status">Loading this proposal…</span> : null}
          <ScreenTitle
            titleId="prTitle"
            title={queued?.title ?? 'Proposal'}
            subNode={queued
              ? (
                <ProposalEyebrow
                  repoName={queued.repoName}
                  repoTo={repoTo(queued.repoName)}
                  number={queued.number}
                />
              )
              : drawn ? <SkelEyebrow /> : null}
          />
          {queued
            ? (
              <ProposalPills
                pill={statusPill(queued, false, relative(queued.decidedAt ?? '', now))}
                to={queued.to}
                from={queued.from}
              />
            )
            : drawn ? <SkelPills /> : null}
          {queued
            ? (
              <ProposalWho
                id="prWho"
                avatarUrl={queued.agentAvatarUrl}
                agentId={queued.agentId}
                agentTo={queued.agentId ? agentFaceToId(queued.agentId, agents ?? null) : null}
                agentName={queued.agentName}
                line={(waitSigned ? `${waitSigned} proposed this` : 'Proposed') + (waitWhen ? ` · ${waitWhen}` : '')}
                {...(drawn && queued.agentName ? { runtime: <SkelRuntime /> } : {})}
                hidden={!waitSigned && !waitWhen}
              />
            )
            : drawn ? <SkelWho /> : null}
          {waitChat
            ? <ChatDoor id="prChat" onPress={() => navigate(toFor({ kind: 'chat', id: waitAgent.id })!)} />
            : null}
          <div id="prBody">
            {loadError ? <div className="empty">{loadError}</div> : null}
            {drawn ? (
              <>
                <SkelSummary rows={!queued || queued.status === 'open' ? 3 : 2} />
                {queued?.body ? null : <SkelWriteUp />}
              </>
            ) : null}
            {queued?.body ? <FoldLong contentKey={queued.body}><Markdown source={queued.body} notes={noteRefs} /></FoldLong> : null}
          </div>
        </div>
        {drawn && waitBar ? <SkelDecide /> : null}
      </>
    );
  }

  const pr = detail.pr;
  const checks: WorkspaceCheckRow[] = detail.checks ?? [];
  const stat = detail.diffStat ?? pr.diffStat ?? { files: 0, insertions: 0, deletions: 0 };
  const files = ('files' in stat ? stat.files : 0) ?? 0;
  const fileWord = `${files} file${files === 1 ? '' : 's'} changed`;
  const commits = detail.commits ?? [];
  // A quiet proposal (note #293) is nobody's to decide yet: the server sends
  // canDecide false for it, and the screen says WHY below, in place of the
  // "not yours" line — it is the owner's, and the agent is still on it.
  const decidable = pr.status === 'open' && pr.canDecide !== false && !pr.draft;
  const failed = checks.some((check) => checkBucket(check.state) === 'failed');
  const blocked = Boolean(detail.requireChecks) && !checksGreen(checks);
  const agent = pr.agentId ? (agents ?? []).find((row) => row.id === pr.agentId) : undefined;
  const chattable = agent && (agent.status === 'ready' || Boolean(agent.working));
  const notes: Array<{ number: number; title?: string }> = pr.quickNotes?.length
    ? pr.quickNotes
    : (pr.quickNoteNumbers ?? []).map((number) => ({ number }));
  const pill = statusPill(pr, Boolean(delivery?.merging), relative(pr.decidedAt ?? '', now));
  const signed = agentSignature(pr.agentName, pr.userName);
  const authored = pr.createdAt ? relative(pr.createdAt, now) : '';
  const runtime = runtimeLine(pr.agentRuntime);
  const commitTo = (sha: string) => (orgId ? toFor({ kind: 'repoCommit', id: pr.repoName, sha, ...scope }) : null);
  const showingDiff = (location.state as { view?: string } | null)?.view === 'diff';

  if (handing) {
    return (
      <HandoffSend
        agent={handing}
        prefill={changeProposalHandoffText(handing, pr.repoName, pr.number, pr.title)}
        onClose={closeHandoff}
      />
    );
  }

  const bar = decidable ? (
    <DecideBar
      approveLabel={blocked ? 'Actions must pass first' : failed ? 'Approve anyway' : 'Approve & merge'}
      blocked={blocked}
      failed={failed}
      busy={deciding}
      onDecide={decide}
    />
  ) : null;

  if (showingDiff) {
    return (
      <>
        <div className={decidable ? 'screen hasbar' : 'screen'} id="screenPrDiff">
          <ScreenTitle
            titleId="prDiffTitle"
            title={fileWord}
            subId="prDiffSub"
            sub={<span><StatNode stat={stat} />{` · ${pr.from} → ${pr.to}`}</span>}
          />
          <div id="prDiffBody">
            {detail.compareError
              ? <div className="empty">The diff cannot be read right now: {detail.compareError}</div>
              : !detail.patch
                ? (
                  <div className="empty">
                    {pr.status === 'open'
                      ? 'No difference between the branches right now.'
                      : 'This proposal changed no files.'}
                  </div>
                )
                : (
                  <>
                    <Diff patch={detail.patch} />
                    {detail.patchTruncated ? (
                      <div className="empty">
                        The diff is longer than the host sends — this is the beginning of it.
                      </div>
                    ) : null}
                  </>
                )}
          </div>
        </div>
        {bar}
      </>
    );
  }

  return (
    <>
      <div className={decidable ? 'screen hasbar' : 'screen'} id="screenPr">
        <ScreenTitle
          titleId="prTitle"
          title={pr.title}
          subNode={(
            <ProposalEyebrow
              repoName={pr.repoName}
              repoTo={repoTo(pr.repoName)}
              number={pr.number}
              notes={notes}
              noteTo={noteTo}
            />
          )}
        />
        <ProposalPills pill={pill} to={pr.to} from={pr.from} />
        <ProposalWho
          id="prWho"
          avatarUrl={pr.agentAvatarUrl}
          agentId={pr.agentId}
          agentTo={pr.agentId ? agentFaceToId(pr.agentId, agents ?? null) : null}
          agentName={pr.agentName}
          line={(signed ? `${signed} proposed this` : 'Proposed') + (authored ? ` · ${authored}` : '')}
          runtime={runtime}
          hidden={!signed && !authored && !runtime}
        />
        {/* The way to talk to the agent that wrote this (note #152): a
            question about the change, or the "no, because…" the decision bar
            deliberately does not collect. */}
        {chattable ? <ChatDoor id="prChat" onPress={() => navigate(toFor({ kind: 'chat', id: agent.id })!)} /> : null}
        <div id="prBody">
          {delivery ? <Delivery delivery={delivery} decidedAt={pr.decidedAt} /> : null}
          <div className="card" id="prSummary">
            <SummaryRow
              glyph="filecode"
              name={fileWord}
              side={<StatNode stat={stat} />}
              opens
              onPress={() => navigate(`${location.pathname}${location.search}`, { state: { view: 'diff' } })}
            />
            {commits.length > 0 ? <CommitRows commits={commits} commitTo={commitTo} now={now} /> : null}
            {/* Once merged, the source-branch rows give way to the Delivery
                card: on a fast-forward the new main run reuses the same sha and
                would otherwise appear twice, under the misleading old name. */}
            {pr.status === 'merged' ? null : <ChecksRow checks={checks} />}
          </div>
          {/* The agent's own words about the change, rendered by the same
              markdown renderer the file viewer uses, so nothing in it can
              become live markup. */}
          {pr.body ? <FoldLong contentKey={pr.body}><Markdown source={pr.body} notes={noteRefs} /></FoldLong> : null}
          {/* The request behind the change, right under the write-up (note
              #206): a door to each note this proposal implements, named by the
              note's own title so the reader knows the ask without leaving. */}
          {notes.length ? (
            <div className="card" id="prNotes">
              {notes.map((note) => {
                const to = noteTo(note.number);
                return (
                  <SummaryRow
                    key={note.number}
                    glyph="note"
                    tint="note"
                    name={note.title || `Note #${note.number}`}
                    side={<span className="cside">#{note.number}</span>}
                    opens
                    {...(to ? { onPress: () => navigate(to) } : {})}
                  />
                );
              })}
            </div>
          ) : null}
          <ProposalFiles proposalId={pr.id} files={pr.attachments ?? []} onError={setSaid} />
          {/* The reason the user gave — the same words the agent was woken
              with, so this screen stays the complete record of the decision. */}
          {pr.decisionNote ? <div className="hintline">Your note to the agent: {pr.decisionNote}</div> : null}
          {refusal ? <div className="hintline" id="prRefusal">{refusal}</div> : null}
          {/* Kept on the screen even when there is nothing to say yet: a
              refresh re-says it, and a proposal decided out from under this
              screen has to be able to take the line away again. */}
          <div className="hintline" id="prHint" hidden={pr.status !== 'open' || Boolean(pr.draft)}>
            {approveHint({ from: pr.from, to: pr.to, requireChecks: detail.requireChecks }, checks)}
          </div>
          {/* The margin's answer — only ever a refusal now: a comment that
              lands starts nobody, so a successful post says nothing. */}
          {said ? <div className="hintline" id="prSaid" role="status">{said}</div> : null}
        </div>
        {/* The review hand-off comes after everything the reviewer must read
            and before the margin about it: the same reading order a note's
            words, hand-off and comments use. A decided proposal is a record,
            no longer a review waiting to be handed around. */}
        <HandRow
          ids={{ head: 'prHandsHead', card: 'prHandsCard', row: 'prHands', hint: 'prHandsHint' }}
          noun="proposal"
          head="Ask for review"
          closed={pr.status !== 'open'}
          excludeAgentId={pr.agentId}
          onOpen={setHanding}
          onDetail={(row) => navigate(toFor({ kind: 'agent', id: row.id })!)}
        />
        {/* The margin, after everything the decision reads (note #66) —
            remarks are ABOUT the change, and the change comes first. */}
        <MarginThread
          ids={{ head: 'prCommentsHead', card: 'prCommentsCard', box: 'prComments' }}
          comments={pr.comments ?? []}
          canWrite={pr.status === 'open' || pr.status === 'conflict'}
          path={`${detailPath(pr.id)}/comments`}
          onPosted={onComments}
          onAgentId={(agentId) => navigate(agentFaceToId(agentId, agents ?? null)!)}
          onSay={setSaid}
        />
      </div>
      {pr.status === 'open' && pr.draft
        ? <NotReadyToDecide agentName={pr.agentName} />
        : pr.status === 'open' && pr.canDecide === false ? <NotYoursToDecide what="change" /> : null}
      {bar}
    </>
  );
}
