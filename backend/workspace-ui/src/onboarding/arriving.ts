/**
 * What the arriving rows say and when they stand (2026-09-18), kept apart
 * from the screen so it can be tested and reused without drawing anything.
 * The gate's arriving screen is gone (note #726); the rows live on in the
 * Chief of Staff chat's progress card while it brings a team in.
 */

import type { HomeAgent } from '../workspace/live.js';

/**
 * How many of the founding agents must be ready before Continue opens (the
 * owner, 2026-09-18). Set to four when the team was six, and so every one of
 * them once the team became four (2026-09-24). Two since the owner's word the
 * same day — "Continue should be active if 2 agents were created" — so the
 * founder steps in beside the first two while the rest keep coming.
 */
export const ARRIVED_WHEN_READY = 2;

/** What an arriving agent's row says while all the builds run together. */
export function arrivingLine(agent: Pick<HomeAgent, 'status'>): string {
  if (agent.status === 'ready') return 'Ready';
  if (agent.status === 'planned') return 'Starting…';
  return 'Computer being built…';
}

/** Whether the team has arrived enough to step in: two ready, or every one of a smaller team. */
export function teamArrived(agents: ReadonlyArray<Pick<HomeAgent, 'status'>>): boolean {
  if (agents.length === 0) return false;
  const ready = agents.filter((agent) => agent.status === 'ready').length;
  return ready >= Math.min(ARRIVED_WHEN_READY, agents.length);
}

const onTheWay = (agent: Pick<HomeAgent, 'status'>): boolean => agent.status === 'planned' || agent.status === 'setting-up';

/**
 * The agents still being brought in: every one planned or being built, and
 * every one `shown` arriving already — so a row that turns Ready stays until
 * the whole of them are. Nothing once every one is ready.
 *
 * It was each ROOM whose agents were arriving, the room's whole roster under
 * its name, until rooms left the product (note #843): one list of the
 * workplace's agents has no roster to show beside the new ones, so the card
 * remembers who it showed arriving instead.
 */
export function arrivingAgents(agents: HomeAgent[], shown: ReadonlySet<string> = new Set()): HomeAgent[] {
  const members = agents.filter((agent) => agent.status !== 'retired' && (shown.has(agent.id) || onTheWay(agent)));
  return members.some(onTheWay) ? members : [];
}
