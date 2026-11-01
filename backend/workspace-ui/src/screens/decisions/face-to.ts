/**
 * Where an agent's face leads from a PROPOSAL — its own file because these
 * are functions, not components, and a module that exports both loses fast
 * refresh for the screen beside them.
 */

import { toFor } from '../../routes.js';
import type { HomeAgent } from '../../workspace/live.js';

/**
 * Where an agent's face leads on a proposal screen (note #617): its CHAT,
 * because the reader looking at a proposal wants to talk about it, not to
 * read the agent's machine and runtime. An agent with no chat to open yet
 * (still setting up, or gone quiet) keeps the door to its own page.
 */
export function agentFaceTo(agent: HomeAgent): string | null {
  const chattable = agent.status === 'ready' || Boolean(agent.working);
  return toFor(chattable ? { kind: 'chat', id: agent.id } : { kind: 'agent', id: agent.id });
}

/**
 * The same door, for a face that carries only an ID (note #640) — which is
 * every face on a proposal since a teammate's agent gained a screen. An agent
 * of the reader's own keeps the rule above: its chat, because that is what a
 * reader with a question about the change actually wants. A teammate's has no
 * chat of theirs to open, so its face leads to its read-only page.
 */
export function agentFaceToId(agentId: string, agents: readonly HomeAgent[] | null): string | null {
  const own = agents?.find((row) => row.id === agentId);
  return own ? agentFaceTo(own) : toFor({ kind: 'agent', id: agentId });
}
