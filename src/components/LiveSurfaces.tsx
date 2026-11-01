import { useState } from 'react';
import type { WorkspaceBucketRow, WorkspaceKnowledgePageRow, WorkspaceRepoRow, WorkspaceSecretRow, WorkspaceSiteRow } from '../../backend/src/shared/workspace-api';
import { Knowledge } from '../../backend/workspace-ui/src/screens/home/Knowledge';
import { Repositories } from '../../backend/workspace-ui/src/screens/home/Repositories';
import { Secrets } from '../../backend/workspace-ui/src/screens/home/Secrets';
import { Sites } from '../../backend/workspace-ui/src/screens/home/Sites';
import { Storage } from '../../backend/workspace-ui/src/screens/home/Storage';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, FACES, HOUR, MINUTE, ago } from './live/fixture';

/**
 * What the team makes, live: Home's own Repositories, Sites, Knowledge and
 * Secrets sections, whole, over four of the platform's repositories, its
 * three sites, three pages and four keys. Each is the same component the product draws
 * under the fleet. Secrets stands in a section of its own since 2026-09-15
 * (the owner): a key is not something the work makes, and the deck is.
 */

export function LiveRepositories({ className = '' }: { className?: string }) {
  const [repos] = useState<WorkspaceRepoRow[]>(() => [
    {
      name: 'northstar-routing',
      cloneUrl: 'https://git.agents.northstar.com/northstar/northstar-routing.git',
      sizeBytes: 9_437_184,
      contributors: [
        { name: 'Ruby', agentAvatarUrl: FACES.ruby, commits: 61 },
        { name: 'Milo', agentAvatarUrl: FACES.milo, commits: 8 },
        { name: 'Otis', agentAvatarUrl: FACES.otis, commits: 5 },
      ],
      protectedBranch: 'main',
      createdAt: ago(38 * DAY),
      lastPushAt: ago(1 * HOUR + 50 * MINUTE),
      branch: 'main',
      branchPushAt: ago(3 * HOUR),
    },
    {
      name: 'northstar-api',
      cloneUrl: 'https://git.agents.northstar.com/northstar/northstar-api.git',
      sizeBytes: 14_680_064,
      contributors: [
        { name: 'Milo', agentAvatarUrl: FACES.milo, commits: 48 },
        { name: 'Ruby', agentAvatarUrl: FACES.ruby, commits: 12 },
      ],
      protectedBranch: 'main',
      createdAt: ago(41 * DAY),
      lastPushAt: ago(2 * HOUR + 5 * MINUTE),
      branch: 'main',
      branchPushAt: ago(5 * HOUR),
    },
    {
      name: 'northstar-driver',
      cloneUrl: 'https://git.agents.northstar.com/northstar/northstar-driver.git',
      sizeBytes: 22_020_096,
      contributors: [
        { name: 'Ruby', agentAvatarUrl: FACES.ruby, commits: 37 },
        { name: 'Ada', agentAvatarUrl: FACES.ada, commits: 6 },
      ],
      protectedBranch: 'main',
      createdAt: ago(27 * DAY),
      lastPushAt: ago(5 * MINUTE),
      branch: 'main',
      branchPushAt: ago(1 * DAY),
    },
    {
      name: 'northstar-pipeline',
      cloneUrl: 'https://git.agents.northstar.com/northstar/northstar-pipeline.git',
      sizeBytes: 5_242_880,
      contributors: [
        { name: 'Otis', agentAvatarUrl: FACES.otis, commits: 29 },
      ],
      protectedBranch: 'main',
      createdAt: ago(33 * DAY),
      lastPushAt: ago(1 * DAY),
      branch: 'main',
      branchPushAt: ago(1 * DAY),
    },
  ]);
  return (
    <LivePanel size="tile" className={className} says="Repositories: four of the platform’s — northstar-routing, northstar-api, northstar-driver and northstar-pipeline — each with its agents’ commits and its protected main branch.">
      {/* No storage quota (note #826 → #830): that meter is our hosted
          allowance, and a company's own Agentic Cloud has none of ours. Every
          address in these panels is Northstar's own domain, as in its own
          Agentic Cloud, never one of ours. */}
      <LiveWorkspace repos={repos}>
        <Repositories />
      </LiveWorkspace>
    </LivePanel>
  );
}

export function LiveSites({ className = '' }: { className?: string }) {
  const [sites] = useState<WorkspaceSiteRow[]>(() => [
    {
      name: 'dispatch',
      url: 'https://dispatch.agents.northstar.com',
      preset: 'service',
      status: 'live',
      kind: 'service',
      agentName: 'Ada',
      agentAvatarUrl: FACES.ada,
      createdAt: ago(24 * DAY),
      lastDeployAt: ago(6 * HOUR),
    },
    {
      name: 'routing',
      url: 'https://routing.agents.northstar.com',
      preset: 'service-pro',
      status: 'live',
      kind: 'service',
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      createdAt: ago(20 * DAY),
      lastDeployAt: ago(1 * HOUR + 48 * MINUTE),
    },
    {
      name: 'northstar-docs',
      url: 'https://northstar-docs.agents.northstar.com',
      preset: 'static',
      status: 'live',
      kind: 'site',
      agentName: 'Milo',
      agentAvatarUrl: FACES.milo,
      createdAt: ago(12 * DAY),
      lastDeployAt: ago(2 * DAY),
    },
  ]);
  return (
    <LivePanel size="tile" className={className} says="Sites: the dispatcher app and the routing service, both running around the clock, and the docs site, each live at its own address and each last published by an agent.">
      <LiveWorkspace sites={sites}>
        <Sites />
      </LiveWorkspace>
    </LivePanel>
  );
}

export function LiveKnowledge({ className = '' }: { className?: string }) {
  /* The workplace's pages: the one the memory section opens (LiveKnowledgePage),
     Otis's on-call page for the pipeline, and the recap Ada wrote from the
     interviews — each signed by the agent that last landed it, which is the
     row's point. */
  const [pages] = useState<WorkspaceKnowledgePageRow[]>(() => [
    {
      name: 'how-northstar-is-built',
      title: 'How Northstar is built',
      description: 'The five services of the platform, where each lives, how a change reaches production, and the traps this team has already paid for.',
      sizeBytes: 8_192,
      sha: 'a1f2c3',
      updatedAt: ago(2 * HOUR + 10 * MINUTE),
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
    },
    {
      name: 'pipeline-on-call',
      title: 'On-call for the pings pipeline',
      description: 'What pages you at three in the morning, what each alert means, and the three fixes that have worked so far.',
      sizeBytes: 5_120,
      sha: 'b4d5e6',
      updatedAt: ago(DAY + 4 * HOUR),
      agentName: 'Otis',
      agentAvatarUrl: FACES.otis,
    },
    {
      name: 'dispatcher-interviews',
      title: 'What six dispatchers told us',
      description: 'The recap of the interviews: who they were, what they asked for, and the three things every one of them said.',
      sizeBytes: 9_216,
      sha: 'c7f8a9',
      updatedAt: ago(2 * DAY + 6 * HOUR),
      agentName: 'Ada',
      agentAvatarUrl: FACES.ada,
    },
  ]);
  return (
    <LivePanel size="tile" className={className} says="Knowledge: three pages the agents wrote — How Northstar is built by Ruby, On-call for the pings pipeline by Otis, and What six dispatchers told us by Ada — each with the line saying what it is for.">
      <LiveWorkspace knowledge={pages}>
        <Knowledge />
      </LiveWorkspace>
    </LivePanel>
  );
}

export function LiveSecrets({ className = '' }: { className?: string }) {
  /* Four keys the fixture's own story needs — the Stripe account invoicing
     meters into, the company's own domain, the team's Slack channel and the
     certificate the driver app's builds are signed with — described the way the product
     asks an agent to describe a key it has used: what it is, and the one
     job it does. That line is what the owner and every other agent read
     to know what a key is for; a key the owner saved arrives with none
     until an agent writes it from actual use. Nothing here is a GitHub
     token: the code's home is the platform's own git hosting. */
  const [secrets] = useState<WorkspaceSecretRow[]>(() => [
    {
      name: 'STRIPE_SECRET_KEY',
      maskedValue: 'sk_live_••••••••••••••••4Qn',
      maskedPreview: 'sk_live_…4Qn',
      valueLength: 107,
      description: 'Stripe key invoicing runs on; the nightly meter push sends every account’s completed stops to it',
      scope: 'shared',
      updatedAt: ago(1 * HOUR + 55 * MINUTE),
    },
    {
      name: 'CLOUDFLARE_API_TOKEN',
      maskedValue: '••••••••••••••••••••••••Vb2k',
      maskedPreview: '…Vb2k',
      valueLength: 40,
      description: 'Cloudflare token for the DNS of northstar.com, so dispatch and routing answer on the company’s own domain',
      scope: 'shared',
      updatedAt: ago(6 * HOUR),
    },
    {
      name: 'SLACK_WEBHOOK_URL',
      maskedValue: 'https://hooks.slack.com/••••••••••••••••',
      maskedPreview: 'https://hooks.slack.com/…',
      valueLength: 79,
      description: 'Posts one line in #pilot when a proposal merges or a service goes live',
      scope: 'shared',
      updatedAt: ago(DAY + 2 * HOUR),
    },
    {
      name: 'DRIVER_SIGNING_KEY',
      maskedValue: '-----BEGIN PRIVATE KEY-----••••••••••••',
      maskedPreview: '-----BEGIN PRIVATE KEY-----…',
      valueLength: 1_704,
      description: 'Signs the driver app’s iOS and Android builds; a build from a fresh clone fails without it',
      scope: 'shared',
      updatedAt: ago(2 * DAY),
    },
  ]);
  return (
    <LivePanel size="tile" className={className} says="Secrets: four keys shared with the workplace — STRIPE_SECRET_KEY, CLOUDFLARE_API_TOKEN, SLACK_WEBHOOK_URL and DRIVER_SIGNING_KEY — each with a line saying what it is for and never its value, and the row that adds another.">
      <LiveWorkspace secrets={secrets}>
        <Secrets onAdd={() => {}} />
      </LiveWorkspace>
    </LivePanel>
  );
}

export function LiveStorage({ className = '' }: { className?: string }) {
  /* Home's own Storage card over three buckets the fixture's story needs
     (note #787): the driver app's photo uploads, the nightly exports the
     pipeline writes, and the public map tiles the dispatcher screen reads —
     each made by the agent whose work needed it. No key reaches this card,
     in the product or here. */
  const [buckets] = useState<WorkspaceBucketRow[]>(() => [
    {
      name: 'delivery-photos',
      public: false,
      bucket: 'northstar-delivery-photos',
      hostedOn: 'platform',
      createdAt: ago(9 * DAY),
      agentName: 'Ruby',
      agentAvatarUrl: FACES.ruby,
      agentId: 'agent_ruby',
    },
    {
      name: 'nightly-exports',
      public: false,
      bucket: 'northstar-nightly-exports',
      hostedOn: 'platform',
      createdAt: ago(16 * DAY),
      agentName: 'Otis',
      agentAvatarUrl: FACES.otis,
      agentId: 'agent_otis',
    },
    {
      name: 'map-tiles',
      public: true,
      bucket: 'northstar-map-tiles',
      hostedOn: 'platform',
      createdAt: ago(4 * DAY),
      agentName: 'Ada',
      agentAvatarUrl: FACES.ada,
      agentId: 'agent_ada',
    },
  ]);
  return (
    <LivePanel size="tile" className={className} says="Storage: three buckets the agents made — delivery-photos by Ruby and nightly-exports by Otis, both private, and map-tiles by Ada, public — each with when it was made.">
      <LiveWorkspace buckets={buckets}>
        <Storage />
      </LiveWorkspace>
    </LivePanel>
  );
}
