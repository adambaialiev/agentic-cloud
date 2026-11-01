/**
 * Proposals the Chief of Staff forwarded into its conversation (note #724).
 *
 * The owner, 2026-10-11: "In chief of staff screen, in chat, I should see
 * proposals. Chief of staff should forward them." Its replies named PR
 * numbers as plain text, with nothing to tap. Now the agent runs
 * `agentbuilt forward`, the row stores a pointer, and every read of the
 * conversation answers with the proposal AS IT STANDS — so this card says
 * Merged the moment it merges, never the Awaiting it said when it landed.
 *
 * Each card is the row every other list draws for that proposal (Home's
 * decision queue, an agent's history): the same face, branch, number, check
 * pip and size, and the same door onto the proposal's own screen, which is
 * where it is approved or rejected — with its diff, its checks and its
 * screenshots in view, and every refusal (a conflict, a stale branch) said
 * where it already is. Above the row, what it is, which room it came from,
 * and its state in the decision queue's own words.
 */

import { useNavigate } from 'react-router-dom';
import type { WorkspaceForwardedProposal } from '../../../../src/shared/workspace-recap-chat.js';
import { toFor } from '../../routes.js';
import { decidedHere, useDecided } from '../../workspace/decided.js';
import { KnowledgeProposalRow, ProposalRow } from '../home/Decisions.js';
import { forwardedDoor, forwardedState } from './forwarded-words.js';

/** The card as it stands — and a decision taken in this tab stands at once,
 *  ahead of the conversation's next read, which will say the same (note
 *  #743). */
function asDecided(entry: WorkspaceForwardedProposal): WorkspaceForwardedProposal {
  const outcome = decidedHere(entry.kind, entry.id);
  if (!outcome) return entry;
  const { pr, knowledge } = entry;
  if (pr?.status === 'open') return { ...entry, pr: { ...pr, status: outcome as typeof pr.status } };
  if (knowledge?.status === 'open') return { ...entry, knowledge: { ...knowledge, status: outcome as typeof knowledge.status } };
  return entry;
}

function ForwardedProposal({ entry: read, at, arriving }: { entry: WorkspaceForwardedProposal; at?: string; arriving?: boolean }) {
  const navigate = useNavigate();
  useDecided();
  const entry = asDecided(read);
  const state = forwardedState(entry);
  const door = forwardedDoor(entry);
  const to = entry.pr ? toFor({ kind: 'pr', id: entry.id }) : entry.knowledge ? toFor({ kind: 'knowledge', id: entry.id }) : null;
  const kind = entry.kind === 'pr' ? 'Change proposal' : 'Knowledge proposal';
  return (
    <div
      className={`chatmsg platform forwarded${entry.kind === 'knowledge' ? ' knowledge' : ''}${arriving ? ' arriving' : ''}`}
      data-forwarded={`${entry.kind}:${entry.id}`}
      title={at ? new Date(at).toLocaleString() : undefined}
    >
      <div className="chatnotice">
        <div className="chatnoticebody">
          <div className="chatnoticehead">
            {/* It named the proposal's room after the kind, while there were
                rooms (note #843). */}
            <span className="chatnoticelabel">{kind}</span>
            <span className={`chatnoticestatus ${state.tone}`}>{state.label}</span>
          </div>
          {entry.pr
            ? <div className="forwardedrow"><ProposalRow pr={entry.pr} plain /></div>
            : entry.knowledge
              ? <div className="forwardedrow"><KnowledgeProposalRow proposal={entry.knowledge} plain /></div>
              : <div className="chatnoticetitle">Its repository has been deleted, so there is nothing left to open.</div>}
          {door && to
            ? <button className="chatnoticedoor forwardeddoor" type="button" onClick={() => navigate(to)}>{door}</button>
            : null}
        </div>
      </div>
    </div>
  );
}

/** One row of the conversation: a card per forwarded proposal, in order. */
export function ForwardedProposals({ forwarded, at, arriving }: {
  forwarded: WorkspaceForwardedProposal[];
  at?: string;
  arriving?: boolean;
}) {
  return (
    <div className="forwardedlist">
      {forwarded.map((entry) => <ForwardedProposal key={`${entry.kind}:${entry.id}`} entry={entry} at={at} arriving={arriving} />)}
    </div>
  );
}
