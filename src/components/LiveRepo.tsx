import { useState } from 'react';
import type { WorkspaceCheckRow, WorkspaceProposalRow } from '../../backend/src/shared/workspace-api';
import { CheckRow } from '../../backend/workspace-ui/src/screens/decisions/Checks';
import { ProposalRow } from '../../backend/workspace-ui/src/screens/home/Decisions';
import { Icon } from '../../backend/workspace-ui/src/ui/icons';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HOUR, MINUTE, ago } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * A repository, live: the repository screen's Overview over northstar-routing —
 * the work happening AROUND the code, which is what the platform's own git
 * hosting adds to git. Its proposals, states mixed, the way only this list
 * mixes them: one merged, one waiting on James, one rejected. The checks
 * `.agentbuilt/ci.sh` ran on the last pushes. Who has written it.
 *
 * Composed from the screen's own pieces — `ProposalRow` and `CheckRow` are
 * the app's, the cards and heads are the screen's own ids and classes —
 * rather than mounted, for the reason LiveRepoFiles gives: the Overview
 * reads each section through the API in an effect, on a route of its own,
 * and an effect never runs on the build machine. The tab strip is hidden
 * by the same rule that hides it on the files tile. No ids: the files tile
 * above already carries the screen's, and one page holds one of each.
 */

const REPO = 'northstar-routing';

const base = {
  repoName: REPO,
  to: 'main',
  body: null,
  userName: 'James',
  canDecide: true,
} as const;

function proposals(): WorkspaceProposalRow[] {
  return [
    {
      ...base,
      id: 'pr_41',
      number: 41,
      title: 'Batch route optimiser for the routing service',
      from: 'batch-optimiser',
      diffStat: { insertions: 1240, deletions: 86 },
      status: 'open',
      createdAt: ago(3 * HOUR),
      decidedAt: null,
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      agentId: 'agent_ruby',
      checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
    },
    {
      ...base,
      id: 'pr_38',
      number: 38,
      title: 'The routing service answers on its own address',
      from: 'own-address',
      diffStat: { insertions: 64, deletions: 9 },
      status: 'merged',
      createdAt: ago(DAY + 5 * HOUR),
      decidedAt: ago(DAY + 3 * HOUR),
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      agentId: 'agent_ruby',
      checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
    },
    {
      ...base,
      id: 'pr_36',
      number: 36,
      title: 'Cache a day’s routes for 24 hours',
      from: 'route-cache',
      diffStat: { insertions: 120, deletions: 12 },
      status: 'rejected',
      createdAt: ago(2 * DAY + 7 * HOUR),
      decidedAt: ago(2 * DAY + 6 * HOUR),
      agentName: 'Milo',
      agentAvatarUrl: FACES.milo,
      agentId: 'agent_milo',
      checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
    },
  ];
}

/** The last runs of `.agentbuilt/ci.sh`, newest first; `side` is the
 *  relative time the screen puts at the row's edge, fixed words so the
 *  build's HTML and the client's first paint agree. */
const RUNS: Array<{ run: WorkspaceCheckRow; side: string }> = [
  { run: { context: 'checks', state: 'success', description: 'Tests, clippy and build · 4m 02s', startedAt: ago(3 * HOUR + 4 * MINUTE) }, side: '3h ago' },
  { run: { context: 'deploy', state: 'success', description: 'Published routing · 58s', startedAt: ago(DAY + 3 * HOUR) }, side: '1d ago' },
];

const PEOPLE = [
  { name: 'Ruby', face: FACES.ruby },
  { name: 'Milo', face: FACES.milo },
  { name: 'Otis', face: FACES.otis },
];

export default function LiveRepo({ className = '' }: { className?: string }) {
  const [prs] = useState(proposals);
  return (
    <LivePanel
      size="tile"
      className={`landing-files ${className}`}
      says="The northstar-routing repository’s overview: three proposals against main — one awaiting James’s approval, one merged, one rejected — the checks and the deploy its last pushes ran, and its three contributors, Ruby, Milo and Otis."
    >
      <LiveWorkspace prs={prs}>
        <div className="screen">
          <div className="phead">
            <div className="pname"><PanelTitle>{REPO}</PanelTitle></div>
          </div>
          <div className="segtabs" role="tablist" aria-label="Repository view">
            <button className="segtab" type="button" role="tab" aria-selected tabIndex={0}>Overview</button>
            <button className="segtab" type="button" role="tab" aria-selected={false} tabIndex={-1}>Content</button>
          </div>
          <div role="tabpanel">
            <h2>Proposals</h2>
            <div className="card landing-repo-prs">
              {prs.map((pr) => <ProposalRow key={pr.id} pr={pr} branch={pr.from} outcome />)}
            </div>
            <h2>Actions</h2>
            <div className="card landing-repo-checks">
              {RUNS.map(({ run, side }) => <CheckRow check={run} side={side} startClosed key={run.context} />)}
            </div>
            <div className="card landing-repo-people">
              <div className="crow open" role="button" tabIndex={-1}>
                <span className="faces">
                  {PEOPLE.map((person) => <img className="face" key={person.name} src={person.face} alt="" />)}
                </span>
                <div className="main">
                  <div className="name plain">3 contributors</div>
                  <div className="cline"><span className="ctext">{PEOPLE.map((person) => person.name).join(', ')}</span></div>
                </div>
                <Icon name="chev" size={17} className="icon chev" />
              </div>
            </div>
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
