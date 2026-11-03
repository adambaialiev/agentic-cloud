/**
 * The pulse at the head of the Workplace half (note #614): how much of the
 * reader's OWN work is happening in parallel, across every room. The Home
 * room panel gives the same counts for ONE room.
 *
 * The reader's agents only — never their teammates'. It counted the whole
 * workplace for a few hours on 2026-09-23, and the owner took it back the
 * same day: "It should show only information about my agents, not my
 * teammates agents." Teammates' agents are shown where they work (the
 * room's strip, a person's page), not folded into this number.
 *
 * It needs no poll of its own. WorkspaceProvider folds the five-second live
 * tick into `agents`, and buys a full state read whenever the working set
 * changes, so these two numbers move with the fleet rows that explain them.
 */

import { useFleet } from '../../workspace/useFleet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

const agentNoun = (count: number): string => count === 1 ? 'agent' : 'agents';

export function AgentActivity() {
  const { agents } = useWorkspace();
  const { removed } = useFleet();
  const fleet = (agents ?? []).filter((agent) => !removed.has(agent.id));
  const total = fleet.length;
  const working = fleet.filter((agent) => Boolean(agent.working)).length;
  const label = `${working} of your ${agentNoun(working)} working now; ${total} ${agentNoun(total)} of yours in this workplace`;

  return (
    <section id="agentActivity" aria-label="Agent activity">
      <h2 className="homehead">Agent activity</h2>
      <div className="card agentactivitycard" role="status" aria-label={label}>
        <div className={`agentactivitymetric${working ? ' active' : ''}`}>
          <strong className="agentactivitynumber">{working}</strong>
          {/* Whose: the reader's own, never their teammates' (2026-09-23) —
              said on the band, since the cards under it list teammates'
              agents too (note #960). */}
          <span className="agentactivitylabel">{working === 1 ? 'of your agents is working' : 'of your agents working'}</span>
        </div>
        <div className="agentactivitymetric">
          <strong className="agentactivitynumber">{total}</strong>
          <span className="agentactivitylabel">{total === 1 ? 'agent of yours' : 'agents of yours'}</span>
        </div>
      </div>
    </section>
  );
}
