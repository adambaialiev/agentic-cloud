import type { WorkspaceOrgSummary } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import type { HomeAgent } from '../../workspace/live.js';
import { agentChattable, agentSessionLimited, hasExistingSeatForAgent } from './agent-words.js';

/**
 * Where tapping an agent leads — a plate on Home and the agents switcher's
 * face alike (note #713), so the two doors cannot disagree about one agent.
 *
 * The conversation (note #573), as the Workspace Agent's card has since note
 * #439: an agent is tapped to be talked to, and everything ABOUT it is one
 * tap on, through the chat header's name. An agent that cannot take a
 * message — still setting up, paused for a sign-in or a seat, out of
 * session or retired — opens its OWN screen, which says what it waits for
 * and is where it is deleted (note #983: a paused agent's plate used to lead
 * only to the sign-in, so an agent whose sign-in had lapsed could not be
 * reached to be removed). The sign-in a paused plate names is still one tap
 * away: its line is a door of its own (`agentFixDoor`).
 */
export function agentDoor(agent: HomeAgent): string {
  if (agentChattable(agent) && !agentSessionLimited(agent)) return toFor({ kind: 'chat', id: agent.id })!;
  return toFor({ kind: 'agent', id: agent.id })!;
}

/**
 * Where the state line of a paused plate leads, when it names something to
 * fix somewhere else: an agent paused with NO matching seat goes to the
 * workplace's subscriptions, where the sign-in it asks for is made. null for
 * every other agent — its line is words, not a door.
 */
export function agentFixDoor(agent: HomeAgent, org: WorkspaceOrgSummary | null): string | null {
  if (agent.status === 'needs-seat' && !hasExistingSeatForAgent(agent, org) && org) {
    return toFor({ kind: 'seats', orgId: org.orgId })!;
  }
  return null;
}
