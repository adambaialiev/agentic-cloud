/**
 * Whether a subscription is carrying a room-agent turn or a private
 * Workspace Agent/briefing lease, as ONE MARK (notes #326 and #648).
 *
 * It is `livedot` — the same 6px accent disc that means "a turn is running"
 * on the fleet's own rows, breathing the same breath. Not a chip: a
 * subscription's item is a compact two-line card, and a pill on its title
 * line is a second object competing with the name and the plan for a reader
 * who only wants to know which sign-in is hot right now. The mark is the
 * whole answer, so the mark is the whole thing.
 *
 * Before #648, the mark counted only visible room agents. The briefing's
 * private machine used the seat without appearing in that list, leaving its
 * card quiet while the briefing itself showed a live dot.
 *
 * Before #326, the words there said "In use" whenever the seat was PRIMARY
 * and its reading was current — a fact about assignment, not about use. It
 * claimed use on a primary no agent had touched in a week, and said nothing
 * at all on a fallback seat three pinned agents were working on.
 */

import { agentsWorkingOnSeat } from './seat-words.js';
import type { WorkspaceSeatUsage } from '../../../src/shared/workspace-api.js';

type SeatIdentity = Pick<WorkspaceSeatUsage, 'seatId' | 'provider' | 'selected'>;
type SeatUser = { cli: string; seatId?: string; working?: boolean };

/** Null unless a turn or briefing actually holds this sign-in. */
export function SeatUseDot({ seat, agents, seats, activeSeatIds }: {
  seat: SeatIdentity;
  agents: SeatUser[] | null | undefined;
  seats: SeatIdentity[];
  activeSeatIds?: string[];
}) {
  const working = agentsWorkingOnSeat(seat, agents, seats);
  const workspaceUsingSeat = activeSeatIds?.includes(seat.seatId) ?? false;
  if (!working && !workspaceUsingSeat) return null;
  return (
    <>
      {/* Decoration, so `aria-hidden`; the words beside it are what a reader
          who cannot see the colour gets, and they carry the count too. */}
      <span className="livedot seatdot" aria-hidden="true" />
      <span className="sr-only">
        {working
          ? `In use — ${working === 1 ? 'one agent is' : `${working} agents are`} working on it now${workspaceUsingSeat ? ', and your Chief of Staff or briefing is using it' : ''}`
          : 'In use by your Chief of Staff or briefing now'}
      </span>
    </>
  );
}
