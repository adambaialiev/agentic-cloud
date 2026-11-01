/**
 * The decision, pinned to the bottom of the screen rather than stacked above
 * the reading. Both orders keep it one thumb away; only this one lets the
 * change reach the reader first.
 *
 * Nothing at all once there is no decision left to make: a decided proposal's
 * screen is a record, and the pill in its header is what says so.
 *
 * A failed check INFORMS the button, it never disables it: the gate exists for
 * the human, and CI does not get a vote. The one exception is a repo that
 * OPTED INTO required checks — there the owner already gave CI its vote, and
 * the button says so; the backend enforces the same rule, so this is honesty
 * about what a tap would do, not the enforcement itself.
 *
 * Each decision is ONE tap. A rejection used to ask for a reason in a box here
 * first, which is a form to fill in on the way out — and the wrong place for
 * it: the agent is already a chat, the user is already in it, and "no,
 * because…" said there reaches the same agent in their own words.
 */

export type Decision = 'approve' | 'reject';

export function DecideBar({ approveLabel, approveRunning = 'Merging', blocked, failed, busy, onDecide }: {
  approveLabel: string;
  /** The word for what the tap started, while it runs. */
  approveRunning?: string;
  /** The repository, or the page underneath, will refuse this — say so on the
   *  button rather than letting the tap discover it. */
  blocked?: boolean;
  /** Something went red. The green goes, and the label says "anyway". */
  failed?: boolean;
  /** Which verb is in flight, if either. */
  busy?: Decision | null;
  onDecide: (decision: Decision) => void;
}) {
  const label = (decision: Decision, resting: string, running: string) => (
    busy === decision
      ? <><span className="spinner" /><span>{running}</span></>
      : resting
  );
  return (
    <div className="decidebar" id="prDecide">
      <div className="actions">
        <button
          className={`save${failed ? '' : ' go'}${busy === 'approve' ? ' busy' : ''}`}
          type="button"
          disabled={Boolean(blocked) || Boolean(busy)}
          onClick={() => onDecide('approve')}
        >
          {label('approve', approveLabel, approveRunning)}
        </button>
        <button
          className={`save reject${busy === 'reject' ? ' busy' : ''}`}
          type="button"
          disabled={Boolean(busy)}
          onClick={() => onDecide('reject')}
        >
          {label('reject', 'Reject', 'Rejecting')}
        </button>
      </div>
    </div>
  );
}

/** Why there is no bar: this reader is not the one being asked. */
export function NotYoursToDecide({ what }: { what: 'change' | 'page' }) {
  return (
    <div id="prDecide">
      <div className="hintline">
        Only the owner of the agent that proposed this {what} can approve or reject it.
      </div>
    </div>
  );
}

/**
 * Why there is no bar: the agent has not asked yet (note #293). The proposal
 * exists — the reader may have arrived from the agent's own history or a
 * saved link — but it was never sent as a card, and the agent is still
 * working on it. No verb, on purpose: this screen becomes decidable only when
 * the agent runs `pr ready`, and the queue row appears at the same moment.
 */
export function NotReadyToDecide({ agentName }: { agentName?: string | null }) {
  return (
    <div id="prDecide">
      <div className="hintline">
        {agentName || 'The agent'} is still working on this and has not asked for a decision yet. It will invite you when it is ready.
      </div>
    </div>
  );
}
