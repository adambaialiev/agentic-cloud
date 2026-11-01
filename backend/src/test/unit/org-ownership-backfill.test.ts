import { describe, expect, it } from 'vitest';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { backfillLegacyOrgOwnership } from '../../services/org-ownership-backfill.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

describe('legacy workplace ownership backfill', () => {
  it('pins old agents and sites to the oldest membership, never the mutable active org', async () => {
    const users = new InMemoryUserStorage();
    const orgs = new InMemoryOrgStorage();
    const deployments = new InMemoryDeploymentStorage();
    const historical = await orgs.createOrg({ name: 'Historical', createdByUserId: 'u1' });
    const active = await orgs.createOrg({ name: 'Active now', createdByUserId: 'u1' });
    await orgs.addMember({ orgId: historical.orgId, userId: 'u1', role: 'admin' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await orgs.addMember({ orgId: active.orgId, userId: 'u1', role: 'admin' });
    await orgs.setActiveOrg('u1', active.orgId);
    await users.createProfile('u1', {
      email: 'u1@example.com',
      telegram: {
        agents: {
          legacy: { id: 'legacy', name: 'Legacy', cli: 'claude', createdAt: '2026-08-20T00:00:00Z' },
          pinned: { id: 'pinned', name: 'Pinned', cli: 'codex', orgId: active.orgId, createdAt: '2026-08-25T00:00:00Z' },
        },
      } as never,
    });
    const legacySite = await deployments.create({
      userId: 'u1', agentId: 'legacy', name: 'legacy-site', preset: 'static', status: 'live',
    });
    const pinnedSite = await deployments.create({
      userId: 'u1', agentId: 'pinned', name: 'pinned-site', preset: 'service', status: 'live',
    });
    const ownerFallback = await deployments.create({
      userId: 'u1', agentId: 'missing-agent', name: 'owner-fallback', preset: 'static', status: 'live',
    });

    expect(await backfillLegacyOrgOwnership({
      userStorage: users, orgStorage: orgs, deploymentStorage: deployments,
    })).toEqual({ agents: 1, deployments: 3 });
    const profile = (await users.getProfile('u1'))!;
    expect(profile.telegram?.agents?.legacy?.orgId).toBe(historical.orgId);
    expect(profile.telegram?.agents?.pinned?.orgId).toBe(active.orgId);
    expect((await deployments.get(legacySite.id))?.orgId).toBe(historical.orgId);
    expect((await deployments.get(pinnedSite.id))?.orgId).toBe(active.orgId);
    expect((await deployments.get(ownerFallback.id))?.orgId).toBe(historical.orgId);

    expect(await backfillLegacyOrgOwnership({
      userStorage: users, orgStorage: orgs, deploymentStorage: deployments,
    })).toEqual({ agents: 0, deployments: 0 });
  });
});
