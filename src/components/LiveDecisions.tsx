import { useState } from 'react';
import type { WorkspaceKnowledgeProposalRow, WorkspaceProposalRow } from '../../backend/src/shared/workspace-api';
import { Decisions } from '../../backend/workspace-ui/src/screens/home/Decisions';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, HOUR, ago } from './live/fixture';

/**
 * Home's decision queue, live: the app's own `Decisions` section, whole,
 * with a full queue of things that wait on a reader — knowledge changes and
 * code proposals together. Each change carries its green checks and diff;
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
  const [knowledge] = useState<WorkspaceKnowledgeProposalRow[]>(() => [
    {
      id: 'kp_3',
      number: 3,
      title: 'Runbook: deploying the routing service and rolling it back',
      status: 'open',
      pages: ['deploying-routing'],
      createdAt: ago(5 * HOUR),
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      agentId: 'agent_ruby',
      canDecide: true,
    },
    {
      id: 'kp_4',
      number: 4,
      title: 'On-call for the pings pipeline',
      status: 'open',
      pages: ['pipeline-on-call'],
      createdAt: ago(3 * HOUR),
      agentName: 'Otis',
      agentAvatarUrl: FACES.otis,
      agentId: 'agent_otis',
      canDecide: true,
    },
    {
      id: 'kp_5',
      number: 5,
      title: 'What six dispatchers told us',
      status: 'open',
      pages: ['dispatcher-interviews'],
      createdAt: ago(7 * HOUR),
      agentName: 'Ada',
      agentAvatarUrl: FACES.ada,
      agentId: 'agent_ada',
      canDecide: true,
    },
  ]);
  return (
    <LivePanel
      size="tile"
      className={className}
      says="Waiting for your decision: three knowledge change requests and four code proposals across the platform’s services, all ready for approval with their checks passed."
    >
      <LiveWorkspace prs={prs} knowledgeProposals={knowledge}>
        <Decisions />
      </LiveWorkspace>
    </LivePanel>
  );
}
