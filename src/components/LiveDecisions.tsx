import { useState } from 'react';
import type { WorkspaceProposalRow } from '../../backend/src/shared/workspace-api';
import { Decisions } from '../../backend/workspace-ui/src/screens/home/Decisions';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HOUR, ago } from './live/fixture';

/**
 * Home's decision queue, live: the app's own `Decisions` section, whole,
 * with a full queue of the things that wait on a reader: code proposals.
 * Since note #746 a knowledge change is live at once, with nothing to
 * decide, so since note #1016 (Adam, 6 Nov 2026: "knowledge changes do not
 * wait for a decision") the queue carries none. Each change carries its green checks and diff;
 * one proposal per service of the platform, and Ruby's #41 is the one the
 * decision section opens.
 */
export default function LiveDecisions({ className = '' }: { className?: string }) {
  const [prs] = useState<WorkspaceProposalRow[]>(() => [
    {
      id: 'pr_44',
      number: 44,
      repoName: 'northstar-api',
      title: 'Usage-based invoicing: meter completed stops per account',
      body: null,
      from: 'usage-invoicing',
      to: 'main',
      diffStat: { insertions: 612, deletions: 140 },
      status: 'open',
      createdAt: ago(2 * HOUR),
      decidedAt: null,
      agentName: 'Milo',
      agentAvatarUrl: FACES.milo,
      agentId: 'agent_milo',
      userName: 'James',
      canDecide: true,
      checks: { total: 3, failing: 0, pending: 0, worst: 'success' },
    },
    {
      id: 'pr_41',
      number: 41,
      repoName: 'northstar-routing',
      title: 'Batch route optimiser for the routing service',
      body: null,
      from: 'batch-optimiser',
      to: 'main',
      diffStat: { insertions: 1240, deletions: 86 },
      status: 'open',
      createdAt: ago(3 * HOUR),
      decidedAt: null,
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      agentId: 'agent_ruby',
      userName: 'James',
      canDecide: true,
      checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
    },
    {
      id: 'pr_39',
      number: 39,
      repoName: 'northstar-pipeline',
      title: 'Partition the GPS pings table by month',
      body: null,
      from: 'pings-partitions',
      to: 'main',
      diffStat: { insertions: 233, deletions: 41 },
      status: 'open',
      createdAt: ago(4 * HOUR),
      decidedAt: null,
      agentName: 'Otis',
      agentAvatarUrl: FACES.otis,
      agentId: 'agent_otis',
      userName: 'James',
      canDecide: true,
      checks: { total: 3, failing: 0, pending: 0, worst: 'success' },
    },
    {
      id: 'pr_43',
      number: 43,
      repoName: 'northstar-dispatch',
      title: 'Live van map with ETAs on the dispatcher screen',
      body: null,
      from: 'live-van-map',
      to: 'main',
      diffStat: { insertions: 498, deletions: 57 },
      status: 'open',
      createdAt: ago(6 * HOUR),
      decidedAt: null,
      agentName: 'Ada',
      agentAvatarUrl: FACES.ada,
      agentId: 'agent_ada',
      userName: 'James',
      canDecide: true,
      checks: { total: 2, failing: 0, pending: 0, worst: 'success' },
    },
  ]);
  return (
    <LivePanel
      size="tile"
      className={className}
      says="Waiting for your decision: four code proposals across the platform’s services, all ready for approval with their checks passed."
    >
      <LiveWorkspace prs={prs}>
        <Decisions />
      </LiveWorkspace>
    </LivePanel>
  );
}
