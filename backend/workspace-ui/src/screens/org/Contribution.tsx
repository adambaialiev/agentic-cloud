/**
 * A person's contribution to the workplace (note #925, tidied on note #928, Adam, 31 Oct 2026:
 * "people see each other's contribution made by their agent … some people
 * will have bigger contribution, some less"): what their agents did HERE —
 * agent hours, changes merged, tokens written per provider — and what the
 * changes were. Facts only: no rank, no medal, and every figure said even at
 * zero. Drawn on every person's card (`PersonRow`) and, whole, on the
 * member's own screen (`OrgMemberScreen`).
 */

import type { WorkspaceContributionNumbers, WorkspaceMemberContribution } from '../../../../src/shared/workspace-api.js';
import { CONTRIBUTION_TOKENS_HINT, contributionStats, weekIsEmpty } from './people-words.js';

/** The figures: equal cells in one grid, each the number over what it
 *  counts, the same size and weight for every one (note #928). */
export function ContributionStats({ numbers }: { numbers: WorkspaceContributionNumbers }) {
  return (
    <div className="pcstats">
      {contributionStats(numbers).map((stat) => (
        <div key={stat.key} data-stat={stat.key} title={stat.key === 'hours' || stat.key === 'merged' ? undefined : CONTRIBUTION_TOKENS_HINT}>
          <b>{stat.value}</b>
          <span>{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The card's block: this week's figures and, when something was merged this
 * week, the latest change's title — what their agents shipped, not only how
 * much. Under the latest line, before the agents.
 */
export function PersonContribution({ contribution }: { contribution: WorkspaceMemberContribution; now?: number }) {
  // A week with nothing in it is one line, not six zeros (note #960). The
  // latest merged change is the card's one latest line, above (note #960).
  if (weekIsEmpty(contribution.week)) {
    return <div className="pcontrib pcempty" aria-label="This week"><div className="pchead">Nothing this week</div></div>;
  }
  return (
    <div className="pcontrib" aria-label="This week">
      <div className="pchead">This week</div>
      <ContributionStats numbers={contribution.week} />
    </div>
  );
}
