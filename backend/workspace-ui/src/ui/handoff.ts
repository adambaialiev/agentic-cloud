/**
 * Handing a document to an agent (notes #87/#105/#113/#186/#327): who can be
 * handed one, and the sentence the Send opens with.
 *
 * The words are here rather than beside one screen because notes, knowledge
 * pages and proposal reviews all carry the row, and "who does this?" is the
 * same question under each. A second copy of these sentences is a second copy
 * to keep honest.
 */

import type { WorkspaceIdleMessageAnswer } from '../../../src/shared/workspace-api.js';
import { WorkspaceApiError, jsonBody, type WorkspaceApi } from '../api/client.js';
import type { HomeAgent } from '../workspace/live.js';

/**
 * The agents that could take a document on right now: ready, and not
 * mid-turn.
 *
 * Only the ones standing in the room being viewed, while there were rooms —
 * the room wall (note #85): a note and a knowledge page were read out of the
 * room the page was viewing, so an agent from another room could not open
 * the thing it was being handed. Every agent reads the workplace's notes
 * and pages since rooms left the product (note #843), so every one of them
 * is a candidate.
 */
export function idleAgentsToHandTo(agents: HomeAgent[] | null): HomeAgent[] {
  return (agents ?? []).filter((agent) => agent.status === 'ready' && !agent.working);
}

/**
 * How every hand-off message opens, whatever document it was tapped under —
 * ONE reading of the agent's context, because the two sentences below differ
 * in what they ask for and not in when a fresh chat is worth asking for.
 *
 * "reset chat and" leads when the agent is carrying a measured context fill:
 * taking a document on is a NEW job, and an agent that starts it holding a
 * conversation about something else spends part of its window on the old
 * thing. No context means no reset — an agent that has not run since its last
 * reset is already clean, and prefixing that one would ask it to throw away
 * nothing, twice.
 */
export function handoffLead(agent: Pick<HomeAgent, 'context'>): string {
  const used = agent.context?.usedPercent;
  return typeof used === 'number' && used > 0 ? 'reset chat and ' : '';
}

/** What the Send opens with under a quick note, and the whole of note #87's
 *  ask: tell the agent to pick this note up. A PREFILL, not a decision — the
 *  screen it lands on is a box the reader can edit or empty. */
export function noteHandoffText(agent: Pick<HomeAgent, 'context'>, number: number): string {
  return `${handoffLead(agent)}pick up the note #${number}`;
}

/**
 * A change proposal is numbered inside its repository, so BOTH pieces are
 * needed to find it from another machine. The title is recognition rather
 * than an address: it lets the reader check the prefill against the screen
 * they just tapped without making an editable title part of the lookup.
 */
export function changeProposalHandoffText(
  agent: Pick<HomeAgent, 'context'>,
  repo: string,
  number: number,
  title?: string,
): string {
  const named = typeof title === 'string' ? title.trim() : '';
  return `${handoffLead(agent)}review change proposal #${number} in ${repo}`
    + (named ? `, “${named}”` : '');
}

/**
 * Knowledge proposals share one account-wide sequence, so their number is
 * the address. As above, the title is the human check beside it, not the
 * thing the receiving agent has to guess a command from.
 */
export function knowledgeProposalHandoffText(
  agent: Pick<HomeAgent, 'context'>,
  number: number,
  title?: string,
): string {
  const named = typeof title === 'string' ? title.trim() : '';
  return `${handoffLead(agent)}review knowledge proposal #${number}`
    + (named ? `, “${named}”` : '');
}

/**
 * The same sentence under a knowledge page (notes #186 and #249), and the
 * words of it that had to be decided rather than copied.
 *
 * By title AND explicitly labelled ID. The title tells the reader which page
 * they are handing over; the ID is the canonical name everything addresses it
 * by — the one `agentbuilt knowledge show` takes. An unlabelled trailing slug
 * looked like more sentence rather than an exact identifier (note #249).
 *
 * "read", not "pick up". A note carries a REQUEST, which is why picking one up
 * is a whole job on its own; a page carries KNOWLEDGE, and what is wanted
 * after it has been read is the reader's to say. So the prefill stops at the
 * part that is certain and the box opens with the cursor at the end of it.
 */
export function kpageHandoffText(
  agent: Pick<HomeAgent, 'context'>,
  name: string,
  title?: string,
): string {
  const human = typeof title === 'string' ? title.trim() : '';
  const titled = human && human !== name ? ` “${human}”` : '';
  return `${handoffLead(agent)}read the knowledge page${titled} (ID: ${name})`;
}

/** AGENT_USER_MESSAGE_MAX_LENGTH, the number the route refuses past — held
 *  here so the box stops rather than taking a paste it will hand back. */
export const HANDOFF_MESSAGE_MAX = 10_000;

/** How many times a send waits out a platform restart before giving up, and
 *  how long it waits between tries. The legacy `postIdleMessage`'s numbers. */
export const HANDOFF_RESTART_RETRIES = 30;
export const HANDOFF_RESTART_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Send one of this account's idle agents a message the reader wrote here.
 *
 * A 409 is the platform's idle-only rule showing through and is passed
 * straight to the reader: nothing was sent, pick another. A `restarting` is
 * the one refusal worth waiting out — the machine is coming back up, and the
 * message would land a second later — so it is retried rather than reported.
 */
export async function sendHandoffMessage(
  api: WorkspaceApi,
  agentId: string,
  message: string,
): Promise<WorkspaceIdleMessageAnswer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.api<WorkspaceIdleMessageAnswer>(
        `api/agents/${encodeURIComponent(agentId)}/message`,
        jsonBody({ message }),
      );
    } catch (error) {
      const restarting = error instanceof WorkspaceApiError && error.code === 'restarting';
      if (!restarting || attempt >= HANDOFF_RESTART_RETRIES) throw error;
      await sleep(HANDOFF_RESTART_WAIT_MS);
    }
  }
}
