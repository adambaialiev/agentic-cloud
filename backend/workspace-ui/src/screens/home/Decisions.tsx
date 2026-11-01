/**
 * The viewed room's decision queue (note #98): every row is open and waiting
 * on THIS reader — change proposals first, then knowledge proposals (note
 * #463: code is what the room ships, so it leads) — under one heading that
 * names the shared state. Personal, not administrative: a
 * proposal only another member may decide is not in it. Gone when empty.
 */

import { useNavigate } from 'react-router-dom';
import type {
  WorkspaceKnowledgeProposalRow,
  WorkspaceProposalRow,
} from '../../../../src/shared/workspace-api.js';
import { AgentHover } from '../../ui/AgentHover.js';
import { RowFace } from '../../ui/FaceDoor.js';
import { AgentWorkingDot } from '../../ui/AgentWorkingDot.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { stillWaiting, useDecided } from '../../workspace/decided.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
// One check vocabulary, shared with the screen this row opens: the queue's
// pip and the proposal's Actions row must not mean different things by the
// same state.
import { CheckPip } from '../decisions/Checks.js';
import { PressableRow } from './PressableRow.js';
import { KNOWLEDGE_STATE_TEXT, PR_STATE_TEXT, prStateKey } from './proposal-state-words.js';

function DiffStat({ stat }: { stat: WorkspaceProposalRow['diffStat'] }) {
  const { insertions, deletions } = stat ?? { insertions: 0, deletions: 0 };
  return <span className="stat"><span className="plus">+{insertions}</span><span className="minus">−{deletions}</span></span>;
}

/** An unknown status is still a status: say it plainly rather than leaving
 *  that one row silent about what happened to it. */
function ProposalState({ status, words }: { status: string; words: Record<string, { label: string; tone: string }> }) {
  const state = words[status];
  return <span className={`prstate${state ? state.tone : ' mut'}`}>{state ? state.label : String(status || '')}</span>;
}

/** What the state leaves for the line: when it was decided, and nothing else.
 *  A conflict keeps its branch, the one case where the state alone does not
 *  say what to do about it. */
function proposalWhen(pr: WorkspaceProposalRow, now?: number): string {
  if (pr.status === 'conflict') return `with ${pr.to}`;
  return pr.decidedAt ? relative(pr.decidedAt, now) : '';
}

/** A time never gives way: "· 7d ago" ellipsised to "· 7d···" is three
 *  characters of nothing. */
function When({ when }: { when: string }) {
  return when ? <span className="cwhen">· {when}</span> : null;
}

/**
 * A change proposal as a list lists it: title; the source branch and the
 * repository, because the room can span repositories; the proposing agent's
 * face; the number the chat card calls it; the check pip; the size.
 *
 * The face — and, while that agent is mid-turn, one dot beside it (note
 * #369) — is all this line says about the agent: there is no room on it for
 * a name, let alone a runtime. A pointer resting on the face says the rest
 * (note #295); a thumb opens the screen, which writes it all out.
 *
 * `outcome` is for a list of MIXED states — an agent's own history, where
 * every row is about one agent and what the line is really asking is what
 * happened. The state text LEADS the line there, because it is the one thing
 * on it that cannot be allowed to ellipsise away; the branch is what gives.
 */
export function ProposalRow({ pr, branch, outcome, plain }: {
  pr: WorkspaceProposalRow;
  /** What the branch chip names. Defaults to the proposal's source branch;
   *  an agent's history spends it on the repository instead. */
  branch?: string;
  outcome?: boolean;
  /** No type glyph: for a list that already says what its rows are — a
   *  teammate's proposals under their name (note #652), where the glyph
   *  column only pushed the row out of line with the person above it. */
  plain?: boolean;
}) {
  const navigate = useNavigate();
  const when = outcome ? proposalWhen(pr) : '';
  return (
    <PressableRow className={plain ? 'crow open plain' : 'crow open'} onPress={() => navigate(toFor({ kind: 'pr', id: pr.id })!)}>
      {plain ? null : <TypeIcon glyph="pr" tint={pr.status === 'open' && !pr.draft ? 'act' : ''} />}
      <div className="main">
        <div className="name plain">{pr.title}</div>
        <div className={outcome ? 'cline' : 'cline by'}>
          {outcome ? <ProposalState status={prStateKey(pr)} words={PR_STATE_TEXT} /> : null}
          {!outcome && pr.agentAvatarUrl
            ? (
              <>
                <AgentHover id={pr.agentId} name={pr.agentName} avatarUrl={pr.agentAvatarUrl}>
                  <RowFace agentId={pr.agentId} avatarUrl={pr.agentAvatarUrl} />
                </AgentHover>
                <AgentWorkingDot id={pr.agentId} />
              </>
            )
            : null}
          <span className="branch"><Icon name="git" size={13} /><span className="bname">{branch ?? pr.from}</span></span>
          {outcome
            ? <When when={when} />
            : pr.repoName ? <span className="ctext">· {pr.repoName}</span> : null}
        </div>
      </div>
      {pr.number ? <span className="cside num">#{pr.number}</span> : null}
      {pr.checks ? <CheckPip state={pr.checks.worst} /> : null}
      <DiffStat stat={pr.diffStat} />
    </PressableRow>
  );
}

/**
 * A knowledge proposal in the same queue — the same question, something is
 * waiting on you — with WHICH PAGES where the change row says which branch.
 *
 * `outcome` is the change row's, for the same list and by the same rule: an
 * agent's own history mixes states, so what became of it leads the line and
 * the face goes (every row there is the one agent this screen is about).
 */
export function KnowledgeProposalRow({ proposal, outcome, plain }: {
  proposal: WorkspaceKnowledgeProposalRow;
  outcome?: boolean;
  /** No type glyph — see `ProposalRow`. */
  plain?: boolean;
}) {
  const navigate = useNavigate();
  const when = outcome && proposal.decidedAt ? relative(proposal.decidedAt) : '';
  return (
    <PressableRow className={plain ? 'crow open plain' : 'crow open'} onPress={() => navigate(toFor({ kind: 'knowledge', id: proposal.id })!)}>
      {plain ? null : <TypeIcon glyph="bulb" tint={!outcome || (proposal.status === 'open' && !proposal.draft) ? 'act' : ''} />}
      <div className="main">
        <div className="name plain">{proposal.title}</div>
        <div className={outcome ? 'cline' : 'cline by'}>
          {outcome ? <ProposalState status={proposal.status === 'open' && proposal.draft ? 'draft' : proposal.status} words={KNOWLEDGE_STATE_TEXT} /> : null}
          {!outcome && proposal.agentAvatarUrl
            ? (
              <>
                <AgentHover id={proposal.agentId} name={proposal.agentName} avatarUrl={proposal.agentAvatarUrl}>
                  <RowFace agentId={proposal.agentId} avatarUrl={proposal.agentAvatarUrl} />
                </AgentHover>
                <AgentWorkingDot id={proposal.agentId} />
              </>
            )
            : null}
          {(proposal.pages ?? []).map((page) => (
            <span className="branch" key={page}><Icon name="bulb" size={13} /><span className="bname">{page}</span></span>
          ))}
          {outcome ? <When when={when} /> : null}
        </div>
      </div>
      <span className="cside num">#{proposal.number}</span>
    </PressableRow>
  );
}

export function Decisions() {
  const { state } = useWorkspace();
  // What was decided in this tab leaves the queue the moment it is decided,
  // not when the state read behind it next answers (note #743).
  useDecided();
  const changes = stillWaiting('pr', state?.prs ?? []).filter((proposal) => proposal.canDecide !== false);
  const knowledge = stillWaiting('knowledge', state?.knowledgeProposals ?? []).filter((proposal) => proposal.canDecide !== false);
  if (changes.length === 0 && knowledge.length === 0) {
    return (
      <>
        <h2 className="homehead" id="prsHead" hidden>Waiting for your decision</h2>
        <div className="card" id="prs" hidden />
      </>
    );
  }
  return (
    <>
      <h2 className="homehead" id="prsHead">Waiting for your decision</h2>
      <div className="card" id="prs">
        {changes.map((pr) => <ProposalRow key={pr.id} pr={pr} />)}
        {knowledge.map((proposal) => <KnowledgeProposalRow key={proposal.id} proposal={proposal} />)}
      </div>
    </>
  );
}
