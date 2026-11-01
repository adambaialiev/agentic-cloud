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
import { CONTRIBUTION_TOKENS_HINT, contributionChangeAgo, contributionStats } from './people-words.js';

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
export function PersonContribution({ contribution, now }: { contribution: WorkspaceMemberContribution; now: number }) {
  const latest = contribution.latest;
  return (
    <div className="pcontrib" aria-label="This week">
      <div className="pchead">This week</div>
      <ContributionStats numbers={contribution.week} />
      {latest
        ? (
          <div className="pclatest">
            {/* The person's latest line's own style (note #928): one weight,
                the stamp in grey riding the last word. */}
            Merged: <span className="pctitle">{latest.title}</span>
            <span className="csep" aria-hidden="true">{'\u00a0·\u00a0'}</span>
            <span className="cago">{contributionChangeAgo(latest, now).replace(/ /g, '\u00a0')}</span>
          </div>
        )
        : null}
    </div>
  );
}
