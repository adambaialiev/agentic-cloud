/**
 * What the two decision screens SAY — the sentences, ported from the legacy
 * page so both shells describe the same proposal in the same words.
 */

import type {
  WorkspaceAgentRuntime,
  WorkspaceCheckRow,
  WorkspaceProposalDetailRecord,
} from '../../../../src/shared/workspace-api.js';
import { agentRuntimeLine } from '../home/agent-words.js';
import { checkBucket, checksGreen } from './checks.js';
import { personName } from '../../ui/chief-of-staff.js';

/**
 * How an agent SIGNS something: "Alex (the account owner)" — the agent, and
 * the human who drives it in parentheses (note #80). Either half may be
 * missing and the line still reads; neither, and it returns '' for the caller
 * to drop.
 */
export function agentSignature(agentName?: string | null, userName?: string | null): string {
  const agent = agentName ? personName(agentName) : agentName;
  if (agent && userName) return `${agent} (${userName})`;
  return agent || userName || '';
}

/**
 * How a remark is signed when the agent that wrote it has since been deleted
 * (note #705). {@link agentSignature} falls back to the driver alone, and over
 * a remark that read as the PERSON having written it — "Adam B · 7d ago" on
 * Willow's words, and the owner asking "is it me?". So this line
 * always says an agent wrote it, and that it is gone: by name where the
 * backend still knows one, as its person's agent where it does not.
 */
export function formerAgentSignature(agentName?: string | null, userName?: string | null): string {
  const who = agentName
    ? agentSignature(agentName, userName)
    : userName ? `${userName}’s agent` : 'An agent';
  return `${who}, no longer here`;
}

/** The concrete harness, model and effort an author will answer with — the
 *  same line, from the same helper, an agent's row on Home already wears. */
export function runtimeLine(runtime?: WorkspaceAgentRuntime | null): string {
  return runtime ? agentRuntimeLine(runtime) : '';
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** What state this proposal is in, in the hue that already means that on this
 *  page — and WHEN, which the row has always said and the screen never did. */
export function statusPill(
  pr: Pick<WorkspaceProposalDetailRecord, 'status' | 'decidedAt' | 'to' | 'draft'>,
  merging: boolean,
  when: string,
): { tone: string; text: string } {
  const stamp = pr.decidedAt && when ? ` ${when}` : '';
  if (merging) return { tone: 'running', text: 'Merging' };
  switch (pr.status) {
    // Quiet (note #293): the agent has not invited a decision. The pill must
    // not say "Waiting for you" — nobody is waiting on the reader yet.
    case 'open': return pr.draft
      ? { tone: 'quiet', text: 'Still being prepared' }
      : { tone: 'open', text: 'Waiting for you' };
    case 'merged': return { tone: 'merged', text: `Merged${stamp}` };
    case 'rejected': return { tone: 'rejected', text: `Rejected${stamp}` };
    case 'withdrawn': return { tone: 'quiet', text: `Withdrawn${stamp}` };
    case 'stale': return { tone: 'quiet', text: 'Went stale' };
    case 'conflict': return { tone: 'quiet', text: `Conflicts with ${pr.to}` };
    default: return { tone: 'quiet', text: pr.status };
  }
}

/**
 * What approving would do, said before it is done. A repo that opted into
 * required checks is the one place CI gets a vote, and the line says so.
 *
 * Nothing here tells the reader to reopen the proposal: the screen follows
 * the run itself, so the honest promise is that it will change under them.
 */
export function approveHint(
  pr: Pick<WorkspaceProposalDetailRecord, 'from' | 'to'> & { requireChecks?: boolean },
  checks: readonly WorkspaceCheckRow[],
): string {
  const failed = checks.some((check) => checkBucket(check.state) === 'failed');
  // A check that never reported is neither running nor failing, and saying
  // "they are still running" over a queue with nothing in it left the reader
  // waiting on a button that was never going to unlock by itself.
  const unjudged = checks.some((check) => checkBucket(check.state) === 'no-verdict');
  if (pr.requireChecks && !checksGreen(checks)) {
    return 'This repository merges only when its actions pass. '
      + (checks.length === 0
        ? 'None have run for this commit yet — give CI a moment; this screen picks them up on its own.'
        : failed
          ? 'They are failing — the Actions row above says where. Rejecting with a note still works.'
          : unjudged
            ? 'One never ran for this commit — a newer push took its slot before it started. Nothing failed and nothing is queued, so waiting will not change it: the merge stays shut until a fresh verdict lands, which a new push produces. Your agent can do that.'
            : 'They are still running — the merge button unlocks itself the moment they pass.');
  }
  return (failed
    ? 'The actions failed on this change — the Actions row above says where. Approving still merges '
    : 'Approving merges ')
    + `${pr.from} into ${pr.to}`
    + '. Nothing changes until you decide, and the agent hears the outcome either way.';
}

/** What the decision came back saying, in the reader's words. Null when the
 *  flow refused and only its own guard note can explain it. */
export function decisionWording(
  status: string | null | undefined,
  to: string,
  agentName: string | null,
): string | null {
  switch (status) {
    case 'merged': return `Merged into ${to}.`;
    case 'rejected': return `Rejected — tell ${agentName || 'the agent'} what to change.`;
    case 'stale': return 'Not merged: the branch changed after you were asked. Ask for a fresh proposal.';
    case 'conflict': return `Not merged: it conflicts with ${to}. The agent has been told to rebase.`;
    default: return null;
  }
}

/**
 * The same sentence for the other queue. A knowledge decision has no branch
 * and no agent to name — the page either went up or it did not — and anything
 * else the flow answers with is its own guard note, which only it can word.
 */
export function knowledgeDecisionWording(status: string | null | undefined): string | null {
  switch (status) {
    case 'approved': return 'Published.';
    case 'rejected': return 'Rejected — the agent has been told.';
    default: return null;
  }
}

