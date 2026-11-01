/**
 * The three-segment meter an agent wears while its machine is still coming
 * up: behind it filled, here breathing, ahead empty.
 *
 * Shared rather than owned by the fleet list (note #352). The same agent
 * appears in the row of candidates under a document, and a card there that
 * said only "Setting up" — no turning ring, no meter — read as an agent that
 * had stalled rather than one three quarters of the way to ready. A reader
 * has no way to tell "still coming" from "stuck" except by the thing MOVING,
 * so both places draw it from here.
 *
 * It takes the STATUS rather than a step number, and answers `null` for a
 * status with no setup left (ready, retired) — so the one place that knows
 * which waypoint a status stands on is this file, and a caller only has to
 * know whether it is drawing an agent at all.
 */

import type { WorkspaceAgentStatus } from '../../../src/shared/workspace-api.js';

// The three waypoints a new agent passes on its way to Ready.
const SETUP_STAGE: Partial<Record<WorkspaceAgentStatus, number>> = {
  'setting-up': 0, 'needs-seat': 1, 'needs-sign-in': 1, 'needs-bot': 2,
};
// A founding agent (note #144) has not set foot on the road: it is waiting
// for the workplace's cloud and subscription, and a meter promising progress
// on its own behalf would lie. It wears none.

export function StepsMeter({ status }: { status: WorkspaceAgentStatus }) {
  const stage = SETUP_STAGE[status];
  if (stage === undefined) return null;
  // Only the step that moves on its own breathes. The rest are waiting on the
  // reader, and a segment pulsing at them would promise progress nobody is
  // making until they tap.
  const live = status === 'setting-up';
  return (
    <div className="steps" role="progressbar" aria-label={`Setup step ${stage + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < stage ? 'done' : i === stage ? (live ? 'now live' : 'now') : undefined} />
      ))}
    </div>
  );
}
