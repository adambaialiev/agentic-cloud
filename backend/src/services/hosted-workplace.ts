import { HOSTED_AGENT_LIMIT, HOSTED_SITE_LIMIT } from '../config/access.js';
import type { OrgDocument } from '../types/org.js';
import { listAgents } from '../types/user.js';
import type { DeploymentStorage } from './deployment-storage.js';
import type { OrgStorage } from './org-storage.js';
import type { UserStorage } from './user-storage.js';

/**
 * HOSTED workplaces (note #664, the owner, 2026-09-25): a workplace with no
 * cloud account of its own runs its agents and sites on the platform's Fly
 * account, which we pay for, up to HOSTED_AGENT_LIMIT agents and
 * HOSTED_SITE_LIMIT sites across the whole workplace. Workplaces that
 * connected their own cloud before then keep it, and their own bill.
 *
 * "Hosted" is not a stored flag: it is the absence of `OrgDocument.fly`, the
 * same fact every Fly resolution already reads (org-fly.ts
 * `resolveHostingContext`), so the two can never disagree.
 */
export function isHostedWorkplace(org: Pick<OrgDocument, 'fly'>): boolean {
  return !org.fly;
}

export interface HostedUsage {
  agents: { used: number; limit: number };
  sites: { used: number; limit: number };
}

/**
 * Room agents that belong to this workplace, across every member: the ones a
 * person made and sees on Home. A half-made reservation (`pending`) is not an
 * agent anyone has, and the Workspace Agent and Recap machines (`purpose`)
 * are the platform's own helpers rather than the team — the same rules the
 * workplace screen counts by. An unstamped legacy agent stands in its owner's
 * oldest workplace, as everywhere else.
 */
export async function workplaceAgentCount(
  deps: {
    orgStorage: Pick<OrgStorage, 'listMembers' | 'listMembershipsByUser'>;
    userStorage: Pick<UserStorage, 'getProfile'>;
  },
  orgId: string,
): Promise<number> {
  let count = 0;
  for (const member of await deps.orgStorage.listMembers(orgId)) {
    const profile = await deps.userStorage.getProfile(member.userId);
    const agents = listAgents(profile?.telegram);
    if (agents.length === 0) continue;
    let legacyOrgId: string | null | undefined;
    for (const agent of agents) {
      if (agent.orgId) {
        if (agent.orgId === orgId) count += 1;
        continue;
      }
      if (legacyOrgId === undefined) {
        const memberships = await deps.orgStorage.listMembershipsByUser(member.userId);
        legacyOrgId = [...memberships]
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
      }
      if (legacyOrgId === orgId) count += 1;
    }
  }
  return count;
}

/** Sites that hold a machine right now — the ones the deploy ceiling counts. */
export async function workplaceSiteCount(
  deploymentStorage: Pick<DeploymentStorage, 'listByOrg'>,
  orgId: string,
): Promise<number> {
  return (await deploymentStorage.listByOrg(orgId))
    .filter((site) => site.status === 'live' || site.status === 'provisioning').length;
}

/** What a hosted workplace is using of what it may, for its Cloud card. */
export async function hostedUsage(
  deps: {
    orgStorage: Pick<OrgStorage, 'listMembers' | 'listMembershipsByUser'>;
    userStorage: Pick<UserStorage, 'getProfile'>;
    deploymentStorage?: Pick<DeploymentStorage, 'listByOrg'>;
  },
  orgId: string,
): Promise<HostedUsage> {
  return {
    agents: { used: await workplaceAgentCount(deps, orgId), limit: HOSTED_AGENT_LIMIT },
    sites: {
      used: deps.deploymentStorage ? await workplaceSiteCount(deps.deploymentStorage, orgId) : 0,
      limit: HOSTED_SITE_LIMIT,
    },
  };
}

/**
 * What the spending views answer for a hosted workplace. They walk a
 * workplace's OWN cloud account and price it; a hosted one has no account and
 * no bill, and walking ours instead would list everybody else's machines.
 */
export function hostedSpendRefusal(usage: HostedUsage): string {
  return 'This workplace runs on the cloud, free of charge, so there is no bill to show. '
    + `It has ${usage.agents.used} of its ${usage.agents.limit} agents and `
    + `${usage.sites.used} of its ${usage.sites.limit} sites.`;
}

/**
 * What of this workplace already runs in the PLATFORM's account (note #801):
 * every machine its members' agent records point at or are building — the
 * Workspace Agent and Recap included, which are machines in our account like
 * any other — every site holding one, and every bucket made there. That is
 * what connecting an account of its own would strand where nothing could
 * reach it, so a marked workplace may connect only while all of them are
 * zero. Its messaging machine counts too (29 Oct 2026): built on our account
 * while it had none of its own, it holds the people's conversations.
 */
export async function hostedFootprint(
  deps: {
    orgStorage: Pick<OrgStorage, 'listMembers' | 'listMembershipsByUser'> & Partial<Pick<OrgStorage, 'getOrg'>>;
    userStorage: Pick<UserStorage, 'getProfile'>;
    deploymentStorage?: Pick<DeploymentStorage, 'listByOrg'>;
    listPlatformBuckets?: (orgId: string) => Promise<number>;
  },
  orgId: string,
): Promise<{ machines: number; sites: number; buckets: number; messages: number }> {
  let machines = 0;
  for (const member of await deps.orgStorage.listMembers(orgId)) {
    const profile = await deps.userStorage.getProfile(member.userId);
    const agents = listAgents(profile?.telegram, true);
    let legacyOrgId: string | null | undefined;
    for (const agent of agents) {
      if (!agent.serverId && !agent.provisioningAppName) continue;
      let belongs = agent.orgId === orgId;
      if (!agent.orgId) {
        if (legacyOrgId === undefined) {
          const memberships = await deps.orgStorage.listMembershipsByUser(member.userId);
          legacyOrgId = [...memberships]
            .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
        }
        belongs = legacyOrgId === orgId;
      }
      if (belongs) machines += 1;
    }
  }
  // A record that reserved a name and built nothing (`pending-payment`)
  // holds no machine; every other living status does.
  const sites = (await deps.deploymentStorage?.listByOrg(orgId) ?? [])
    .filter((site) => site.status !== 'destroyed' && site.status !== 'pending-payment').length;
  const buckets = await deps.listPlatformBuckets?.(orgId) ?? 0;
  const org = await deps.orgStorage.getOrg?.(orgId);
  const messages = org && !org.fly && org.messages?.host ? 1 : 0;
  return { machines, sites, buckets, messages };
}
