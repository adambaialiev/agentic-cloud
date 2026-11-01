/**
 * Auto-merge mode (note #944, Adam, 2026-11-01: "auto-approve mode. If it's
 * on, all proposals should be automatically approved" — then, the same day:
 * "Each user should enable disable for itself").
 *
 * One switch per PERSON in a workplace, in the Workplace window, flipped only
 * by that person — never by an agent, and never by anyone for a teammate: no
 * agent route writes it, and the route that does writes the caller's own.
 * While it is on, a code proposal one of that person's agents makes ready
 * (`agentbuilt pr ready`) whose checks passed is merged at once, through the
 * same merge path their Approve takes, and recorded as decided
 * AUTOMATICALLY — never in their name, because nobody read it. Off is the
 * default and today's behaviour. While it is on, the Chief of Staff's header
 * says "Auto-merge on".
 *
 * The words live here, once, because several surfaces say them and must
 * agree: the setting, the proposal's screen, the Chief of Staff's card and
 * the outcome the proposing agent is woken with.
 */

/** What the switch does, in its own words — shown on the setting itself. */
export const AUTO_APPROVE_SETTING_WORDS = 'Every code proposal your agents make ready is merged without asking you. Checks must still pass.';

/** The switch as one member holds it, and the record of every flip. */
export interface WorkplaceAutoApprove {
  on: boolean;
  /** When it was last turned on or off, and by whom (the member themselves). */
  changedAt: string;
  changedByUserId: string;
  /** Their name as it was then: a later rename must not rewrite the record. */
  changedByName: string;
  /** Every flip, newest last, capped at {@link AUTO_APPROVE_HISTORY_MAX}. */
  history?: WorkplaceAutoApproveChange[];
}

export interface WorkplaceAutoApproveChange {
  on: boolean;
  at: string;
  byUserId: string;
  byName: string;
}

export const AUTO_APPROVE_HISTORY_MAX = 50;

/**
 * The decision as a proposal carries it: which mode merged it — when that
 * mode was turned on and by whom — and when. This is the audit record a
 * reader of the proposal sees in place of a person's name.
 */
export interface PullRequestAutoApproval {
  at: string;
  modeOnAt: string;
  modeOnByUserId: string;
  modeOnByName: string;
}

/** Why auto-approve did not merge a proposal, which then waits for a person. */
export interface PullRequestAutoApproveFallback {
  at: string;
  reason: string;
}

/** "1 Nov 2026, 15:02 UTC" — one clock for every reader, agents included. */
export function autoApproveTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getUTCMonth()];
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${month} ${at.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** The line that stands where a person's name would: who decided — nobody. */
export function autoApprovedWords(approval: Pick<PullRequestAutoApproval, 'modeOnAt' | 'modeOnByName'>): string {
  return `Approved automatically (auto-merge on, turned on by ${approval.modeOnByName || 'its owner'} at ${autoApproveTime(approval.modeOnAt)})`;
}

/** The line a proposal auto-approve could not merge wears while it waits. */
export function autoApproveFallbackWords(fallback: Pick<PullRequestAutoApproveFallback, 'reason'>): string {
  return `Auto-merge is on, but this was not merged automatically: ${fallback.reason}. It waits for your decision.`;
}

/**
 * Whether a proposal's checks let auto-approve merge it. Green passes. Red,
 * running and superseded never do. No verdict at all passes only where CI is
 * off — the same thing an owner's Approve does there — because on a repo
 * with CI on, a sha nobody judged yet is exactly the one that must wait.
 */
export function autoApproveChecksBlocker(
  verdict: 'success' | 'pending' | 'failure' | 'superseded' | null,
  ciOn: boolean,
): string | null {
  switch (verdict) {
    case 'success': return null;
    case 'pending': return 'its checks are still running';
    case 'failure': return 'its checks are not passing';
    case 'superseded': return 'its checks were superseded by a newer commit';
    default: return ciOn ? 'no checks have reported on it yet' : null;
  }
}
