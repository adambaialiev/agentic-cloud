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
 * tap on, through the chat header's name. An agent whose line names
 * something to fix keeps the door to where it is fixed, so the tap answers
 * the words on it: a paused agent with NO matching seat goes to the sign-in
 * door; one still setting up, paused on a seat it can have, out of session or
 * retired opens its own screen, which says what it waits for — the
 * Subscription row, the Resume button.
 */
export function agentDoor(agent: HomeAgent, org: WorkspaceOrgSummary | null): string {
  if (agent.status === 'needs-seat' && !hasExistingSeatForAgent(agent, org) && org) {
    return toFor({ kind: 'seats', orgId: org.orgId })!;
  }
  if (agentChattable(agent) && !agentSessionLimited(agent)) return toFor({ kind: 'chat', id: agent.id })!;
  return toFor({ kind: 'agent', id: agent.id })!;
}
