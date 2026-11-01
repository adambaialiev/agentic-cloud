/**
 * The words the agent's own screen says, ported from the legacy page's
 * `renderAgentFacts` / `paintAgentInfo` helpers so both shells describe one
 * agent the same way. Pure functions over the record and the version read;
 * the components draw them.
 */

import type {
  WorkspaceAgentProposalsAnswer,
  WorkspaceAgentRow,
  WorkspaceAgentVersionAnswer,
  WorkspaceKnowledgeProposalRow,
  WorkspaceOrgSummary,
  WorkspaceProposalRow,
  WorkspaceSeatUsage,
} from '../../../../src/shared/workspace-api.js';
import { memory } from '../../ui/file-kind.js';
import { isHarnessCli, subscriptionName } from '../../../../src/shared/harness-clis.js';
import { hasExistingSeatForAgent, hasPaymentRequiredSeatForAgent } from '../home/agent-words.js';
import { seatShortName } from '../../ui/seat-words.js';

/**
 * Which version of the platform's instructions a machine is working from, in
 * the shape the CLI row directly above it uses: the version, then whether it
 * is the current one.
 *
 * A machine that has never been written to has no number to give, and "v0"
 * would be a lie about a real file — so that case says what it is waiting
 * for. Behind names BOTH numbers, because "out of date" alone invites the
 * question this row exists to answer, and it says WHEN rather than offering a
 * button: the rewrite is the backend's own job at the next turn's start.
 */
export function docsNote(docs: WorkspaceAgentVersionAnswer['docs']): string {
  if (typeof docs.version !== 'number') return 'Not written yet — it lands on the first turn';
  return docs.current ? `v${docs.version} · up to date` : `v${docs.version} → v${docs.latest} on its next turn`;
}

/**
 * A pin bump rebuilds the machine image with the new pin baked in, so when
 * BOTH rows are behind, the machine update already delivers this CLI — two
 * buttons would invite a second tap for work the first one covers.
 */
export function cliRidesImage(info: WorkspaceAgentVersionAnswer): boolean {
  return Boolean(info.cliUpdateAvailable && info.image && info.image.canUpdate);
}

export function cliNote(info: WorkspaceAgentVersionAnswer): string {
  if (!info.installed) return 'Not read yet — it gets checked when the machine next goes quiet';
  if (info.cliUpdateAvailable) {
    return `${info.installed} → ${info.pinned}${cliRidesImage(info) ? ' — included in the machine software update below' : ' available'}`;
  }
  return info.installed + (info.pinned === info.installed ? ' · up to date' : '');
}

export function imageNote(image: NonNullable<WorkspaceAgentVersionAnswer['image']>): string {
  // State, never the ref. `sha-4d62e8729973` is meaningful to exactly one
  // reader of this screen, and it is not the person who owns the agent. What
  // a user needs before tapping is what it will cost them: the restart.
  return image.current ? 'Up to date' : 'Update available — it restarts the machine, about a minute';
}

/**
 * "4 dedicated cores" / "2 shared cores" — the processor, in the words the
 * choice is made in (note #268).
 *
 * SHARED VS DEDICATED IS SAID OUT LOUD, not implied by a size code. It is the
 * fact that explains an agent that has gone mysteriously slow — a shared core
 * is throttled under exactly the load a coding agent makes — and `2x` on a row
 * says nothing about it to anybody who has not read Fly's price list.
 * A kind we do not have a word for is left out rather than guessed at.
 */
export function processorWords(cpuKind: string | undefined, cpus: number | undefined): string {
  if (!cpus) return '';
  const kind = cpuKind === 'performance' ? 'dedicated' : cpuKind === 'shared' ? 'shared' : '';
  return `${cpus} ${kind ? `${kind} ` : ''}${cpus === 1 ? 'core' : 'cores'}`;
}

/** "Awake · Amsterdam · 4 dedicated cores · 8 GB" — where this agent lives
 *  and what it is made of, as it is sold. */
export function machineLine(machine: NonNullable<WorkspaceAgentVersionAnswer['machine']>): string {
  return [
    machine.awake ? 'Awake' : 'Asleep',
    machine.regionName || machine.region,
    processorWords(machine.cpuKind, machine.cpus),
    machine.memoryMb ? memory(machine.memoryMb) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * What an agent that isn't ready yet is waiting for — almost the only thing
 * it has to show, and the one thing its owner wants to know. '' once it is.
 */
export function waitingLine(agent: WorkspaceAgentRow, org: WorkspaceOrgSummary | null): string {
  switch (agent.status) {
    case 'setting-up':
      return 'Setting up — a minute or two';
    case 'payment-required':
      return `${subscriptionName(agent.cli)} paused this subscription. Open it to restore access in your ${subscriptionName(agent.cli)} account.`;
    case 'needs-seat':
      return hasExistingSeatForAgent(agent, org)
        ? 'Its machine is ready — choose one of your existing subscriptions below.'
        : agent.cli === 'opencode'
          ? 'Its machine is ready — it wakes once you add your OpenCode key in Your subscriptions'
          : `Its machine is ready — it wakes once you sign in to ${subscriptionName(agent.cli)} in Your subscriptions`;
    case 'needs-sign-in':
      return 'Finish signing in — check its chat';
    case 'needs-bot':
      return 'Signed in — its chat still needs creating';
    case 'retired':
      return 'Retired — it can no longer run';
    default:
      return '';
  }
}

/**
 * Whether the Subscription row belongs on this screen at all: once the owner
 * HAS a seat this agent could run on — before that there is nothing to pick —
 * or while a pin is set, so a pin whose seat left is still visible rather
 * than silently ruling.
 */
export function showsSubscriptionRow(agent: WorkspaceAgentRow, org: WorkspaceOrgSummary | null): boolean {
  if (!isHarnessCli(agent.cli)) return false;
  return Boolean(agent.seatId) || hasExistingSeatForAgent(agent, org) || hasPaymentRequiredSeatForAgent(agent, org);
}

/** The words for "no chosen subscription": the workplace's primary decides (note #773). */
export const WORKPLACE_DEFAULT_SEAT = 'Workplace default';

/**
 * The sign-in this agent was given (note #773), or null when it follows the
 * workplace default. A pin naming a seat that is gone leases as the default,
 * so it reads as the default too; the seats this state read already carries
 * are the only list consulted, so opening this screen reads nothing extra.
 */
export function chosenSeat(
  agent: Pick<WorkspaceAgentRow, 'seatId'>,
  seats: WorkspaceSeatUsage[] | undefined,
): WorkspaceSeatUsage | null {
  if (!agent.seatId) return null;
  return seats?.find((seat) => seat.seatId === agent.seatId) ?? null;
}

/** What the Subscription row says: the chosen sign-in's short name, else the default. */
export function subscriptionLabel(agent: WorkspaceAgentRow, seats: WorkspaceSeatUsage[] | undefined): string {
  const seat = chosenSeat(agent, seats);
  return seat ? seatShortName(seat, seats) : WORKPLACE_DEFAULT_SEAT;
}

/** The runtime value, and whether it is a door: a live harness opens the
 *  shared model + effort picker, a retired one keeps the fact and offers no
 *  dead control. */
export function runtimeValue(info: WorkspaceAgentVersionAnswer): string {
  return info.model ? info.model + (info.effort ? ` · ${info.effort}` : '') : '';
}

/** The delete's hint. A retired agent's machine may be long gone already. */
export function deleteHint(agent: Pick<WorkspaceAgentRow, 'status'>): string {
  return agent.status === 'retired'
    ? 'Retired agents can no longer run. Deleting removes it from this list for good.'
    : 'Deleting erases its machine and everything on it, for good — its chat stops answering.';
}

/** Words worth showing under Last reply, or null — the one shape the screen
 *  holds, so a seed, a read and a chat row are all judged the same way. */
export function agentLastReplyOf(
  message: { text?: string; at?: string } | null | undefined,
): { text: string; at?: string } | null {
  if (!message || typeof message.text !== 'string' || !message.text.trim()) return null;
  return message.at ? { text: message.text, at: message.at } : { text: message.text };
}

/** One row of the proposal history: whichever kind it is, and when this agent
 *  proposed it. The `canDecide` this list omits is the reason for the cast —
 *  neither row reads it (the decision lives on the proposal's own screen). */
export type AgentProposalEntry =
  | { key: string; at: string; pr: WorkspaceProposalRow }
  | { key: string; at: string; page: WorkspaceKnowledgeProposalRow };

/**
 * What this agent has proposed, both kinds in ONE list, newest first.
 *
 * Interleaved rather than grouped by kind, which is the opposite of Home's
 * queue and for the opposite reason: the queue is a pile of open questions,
 * where change proposals going first is a running order; this is one agent's WORK,
 * where the question the reader arrives with is "what has it been doing", and
 * an answer that splits a week's work into two piles by store is answering a
 * different one. The glyph and the chips say which kind each row is.
 *
 * Sorted on when it was PROPOSED, like each half already arrives: the order
 * of the agent's own work, not of the reader's replies to it.
 */
export function agentProposalHistory(answer: WorkspaceAgentProposalsAnswer | null): AgentProposalEntry[] {
  if (!answer) return [];
  const entries: AgentProposalEntry[] = [
    ...(answer.prs ?? []).map((pr) => ({ key: `pr:${pr.id}`, at: pr.createdAt, pr: pr as WorkspaceProposalRow })),
    ...(answer.knowledgeProposals ?? []).map((page) => ({
      key: `kp:${page.id}`, at: page.createdAt, page: page as WorkspaceKnowledgeProposalRow,
    })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
