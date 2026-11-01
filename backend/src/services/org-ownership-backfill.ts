import { listAgents } from '../types/user.js';
import type { DeploymentStorage } from './deployment-storage.js';
import type { OrgStorage } from './org-storage.js';
import type { UserStorage } from './user-storage.js';

/**
 * Stamp immutable workplace ownership onto records created before users
 * could join more than one workplace. At that time a user could have at
 * most one membership, so their oldest membership is the historical owner;
 * the mutable active Workspace choice must never be used after this cutover.
 *
 * Idempotent and deliberately boring: a restart can run it forever, and any
 * record already stamped is left exactly alone.
 */
export async function backfillLegacyOrgOwnership(deps: {
  userStorage: Pick<UserStorage, 'getAllUsers' | 'updateAgentFields'>;
  orgStorage: Pick<OrgStorage, 'listMembershipsByUser'>;
  deploymentStorage: Pick<DeploymentStorage, 'listAll' | 'update'>;
}): Promise<{ agents: number; deployments: number }> {
  const users = await deps.userStorage.getAllUsers();
  const historicalOrgByUser = new Map<string, string | null>();
  const agentOrg = new Map<string, string>();
  let agents = 0;

  const historicalOrg = async (userId: string): Promise<string | null> => {
    if (historicalOrgByUser.has(userId)) return historicalOrgByUser.get(userId) ?? null;
    const memberships = await deps.orgStorage.listMembershipsByUser(userId);
    const orgId = [...memberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
      ?.orgId ?? null;
    historicalOrgByUser.set(userId, orgId);
    return orgId;
  };

  for (const profile of users) {
    const fallbackOrgId = await historicalOrg(profile.userId);
    for (const agent of listAgents(profile.telegram)) {
      const orgId = agent.orgId ?? fallbackOrgId;
      if (!orgId) continue;
      agentOrg.set(`${profile.userId}/${agent.id}`, orgId);
      if (!agent.orgId && await deps.userStorage.updateAgentFields(profile.userId, agent.id, { orgId })) {
        agents += 1;
      }
    }
  }

  let deployments = 0;
  for (const deployment of await deps.deploymentStorage.listAll()) {
    if (deployment.orgId) continue;
    const orgId = agentOrg.get(`${deployment.userId}/${deployment.agentId}`)
      ?? await historicalOrg(deployment.userId);
    if (orgId && await deps.deploymentStorage.update(deployment.id, { orgId })) {
      deployments += 1;
    }
  }
  return { agents, deployments };
}
