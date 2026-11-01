/**
 * What the composer's agent stack shows, how the sheet behind it is ordered
 * (note #581), and its search (note #713). Pure, and its own file for the
 * same reason `room-faces.ts` is: the faces on the button and the cards in
 * the sheet are two drawings of one fleet, and a second copy of "who comes
 * first" is how they start disagreeing about it.
 *
 * The sheet had room tabs over it (note #713) — All, then every room — and
 * grouped the fleet under them, until rooms left the product (note #843).
 * All was the one that stayed: one list of every agent in the workplace.
 */

import type { WorkspaceAgentRow } from '../../../../src/shared/workspace-api.js';

/**
 * WHO this door can take the reader to: the fleet in its own order (most
 * recently used first), never the agent whose conversation is already open.
 *
 * One rule for both drawings of it — the faces on the button and the cards in
 * the sheet behind it. The button promised a set; the sheet is that set, which
 * is also why a card for the conversation already open has no place in it (the
 * owner, 2026-09-20): it would be the one row of the list that leads nowhere.
 *
 * The stack itself — how many faces are drawn and when a `+N` replaces the
 * rest — is `roomFaceParts`, applied by `RoomFaces` at the draw.
 */
export function agentSwitchStack<T extends Pick<WorkspaceAgentRow, 'id'>>(
  agents: T[] | null | undefined,
  currentId?: string | null,
): T[] {
  return (agents ?? []).filter((agent) => agent.id !== currentId);
}

/** Folded for matching: case and accents are not what anybody means. */
function folded(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The cards the sheet draws: every agent, working agents first
 * (`agentSwitchWorkingFirst`), narrowed to the names that contain what has
 * been typed. A name only — the box says "Search agents", and a card turning
 * up because a word of its recap matched reads as a wrong answer to a name.
 */
export function agentSwitchShown<T extends Pick<WorkspaceAgentRow, 'name' | 'working'>>(
  agents: T[],
  query: string,
): T[] {
  const pool = agentSwitchWorkingFirst(agents);
  const needle = folded(query);
  return needle ? pool.filter((agent) => folded(agent.name).includes(needle)) : pool;
}

/**
 * The sheet's order (note #775, the owner: "working agents sorted to the
 * top, room doesn't matter"): every agent with a turn running now before
 * every agent without one.
 *
 * Inside each half the fleet's own order stands — most recently used
 * first — because that is still the likeliest switch once "who is busy" has
 * been answered. The server already lifts a running turn to the top of the
 * fleet; the room groups were what pushed a busy agent of the second room
 * under the idle ones of the first, while there were rooms.
 */
export function agentSwitchWorkingFirst<T extends Pick<WorkspaceAgentRow, 'working'>>(agents: T[]): T[] {
  return [...agents.filter((agent) => agent.working), ...agents.filter((agent) => !agent.working)];
}

/**
 * The order the reader is holding still (note #775). The list re-sorts on
 * its own as agents start and stop, but never under a finger: while the
 * reader is touching it or scrolled down into it, every card stays in the
 * place it was drawn, and the cards that were not there yet join at the end.
 * An agent removed meanwhile simply leaves its place.
 */
export function agentSwitchHeld<T extends Pick<WorkspaceAgentRow, 'id'>>(held: string[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((agent) => [agent.id, agent]));
  const kept = held.flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
  const place = new Set(held);
  return [...kept, ...fresh.filter((agent) => !place.has(agent.id))];
}
