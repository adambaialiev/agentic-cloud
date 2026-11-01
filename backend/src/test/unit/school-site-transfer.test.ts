import { describe, expect, it } from 'vitest';
import {
  SCHOOL_SITE_TRANSFER_PLAN as PLAN,
  transferSchoolSiteToPersonal,
  type SchoolSiteTransferDeps,
} from '../../services/school-site-transfer.js';
import { FlyAppOrgContextResolver } from '../../services/fly-app-org-context.js';
import type { DeploymentDocument } from '../../types/deployment.js';
import type { OrgDocument, OrgMembershipDocument } from '../../types/org.js';

const OWNER = 'tg_1000000000000_0wner0000000';

function siteDoc(over: Partial<DeploymentDocument> = {}): DeploymentDocument {
  return {
    id: PLAN.deploymentId,
    userId: OWNER,
    agentId: 'felix',
    name: PLAN.siteName,
    preset: 'service',
    status: 'live',
    createdAt: '2026-08-07T08:24:06.861Z',
    flyApp: PLAN.flyApp,
    machineId: '825999b75e5308',
    volumeId: 'vol_rkgj9dmm0kwp73o4',
    orgId: PLAN.sourceOrgId,
    formerNames: ['eldiyar-math'],
    ...over,
  } as DeploymentDocument;
}

function harness(options: {
  site?: DeploymentDocument | null;
  members?: OrgMembershipDocument[];
  org?: OrgDocument | null;
  updateFails?: boolean;
} = {}) {
  let doc = options.site === undefined ? siteDoc() : options.site;
  const members = options.members ?? [
    { orgId: PLAN.sourceOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
    { orgId: PLAN.targetOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
  ];
  const deps: SchoolSiteTransferDeps = {
    orgStorage: {
      getOrg: async (orgId: string) => (options.org === undefined
        ? ({ orgId, name: 'Personal', createdByUserId: OWNER, createdAt: 'x' } as OrgDocument)
        : options.org),
      listMembers: async (orgId: string) => members.filter((m) => m.orgId === orgId),
    } as SchoolSiteTransferDeps['orgStorage'],
    deploymentStorage: {
      get: async (id: string) => (doc && doc.id === id ? doc : null),
      update: async (id: string, updates: Partial<DeploymentDocument>) => {
        if (options.updateFails) return false;
        if (!doc || doc.id !== id) return false;
        doc = { ...doc, ...updates };
        return true;
      },
    } as SchoolSiteTransferDeps['deploymentStorage'],
  };
  return { deps, current: () => doc };
}

describe('transferSchoolSiteToPersonal', () => {
  it('moves ownership and pins the hosting account in one update', async () => {
    const h = harness();
    const result = await transferSchoolSiteToPersonal(h.deps);
    expect(result).toEqual({
      state: 'moved', from: PLAN.sourceOrgId, to: PLAN.targetOrgId, flyOrgId: PLAN.sourceOrgId,
    });
    const doc = h.current()!;
    expect(doc.orgId).toBe(PLAN.targetOrgId);
    // Without this the site would be online and unmanageable by anyone.
    expect(doc.flyOrgId).toBe(PLAN.sourceOrgId);
  });

  it('touches no infrastructure: address, app, machine, volume and contents stand', async () => {
    const h = harness();
    const before = h.current()!;
    await transferSchoolSiteToPersonal(h.deps);
    const after = h.current()!;
    expect(after.name).toBe(before.name);
    expect(after.flyApp).toBe(before.flyApp);
    expect(after.machineId).toBe(before.machineId);
    expect(after.volumeId).toBe(before.volumeId);
    expect(after.preset).toBe(before.preset);
    expect(after.status).toBe('live');
    expect(after.formerNames).toEqual(['eldiyar-math']);
    expect(after.lastDeployAt).toBe(before.lastDeployAt);
  });

  it('is idempotent', async () => {
    const h = harness();
    await transferSchoolSiteToPersonal(h.deps);
    expect(await transferSchoolSiteToPersonal(h.deps)).toEqual({ state: 'already-done' });
  });

  it('repairs a half-done move that left no hosting pin', async () => {
    const h = harness({ site: siteDoc({ orgId: PLAN.targetOrgId }) });
    const result = await transferSchoolSiteToPersonal(h.deps);
    expect(result).toMatchObject({ state: 'moved' });
    expect(h.current()!.flyOrgId).toBe(PLAN.sourceOrgId);
  });

  it('refuses when nobody administers both workplaces', async () => {
    const h = harness({
      members: [
        { orgId: PLAN.sourceOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
        { orgId: PLAN.targetOrgId, userId: OWNER, role: 'member', joinedAt: 'x' } as OrgMembershipDocument,
      ],
    });
    expect(await transferSchoolSiteToPersonal(h.deps))
      .toEqual({ state: 'deferred', reason: 'no one is an admin of both workplaces' });
    expect(h.current()!.orgId).toBe(PLAN.sourceOrgId);
  });

  it.each([
    ['a different Fly app', siteDoc({ flyApp: 'iapp-somethingelse' }), 'Fly app'],
    ['a renamed site', siteDoc({ name: 'not-school' }), 'named'],
    ['another workplace', siteDoc({ orgId: 'someone-else' }), 'belongs to'],
    ['a destroyed site', siteDoc({ status: 'destroyed' }), 'destroyed'],
  ])('leaves %s alone', async (_label, site, expected) => {
    const h = harness({ site });
    const result = await transferSchoolSiteToPersonal(h.deps);
    expect(result.state).toBe('deferred');
    expect((result as { reason: string }).reason).toContain(expected);
    expect(h.current()!.orgId).toBe(site.orgId);
  });

  it('refuses a missing record or target workplace', async () => {
    expect((await transferSchoolSiteToPersonal(harness({ site: null }).deps)).state).toBe('deferred');
    expect((await transferSchoolSiteToPersonal(harness({ org: null }).deps)).state).toBe('deferred');
  });

  it('reports a refused update instead of claiming success', async () => {
    const h = harness({ updateFails: true });
    expect(await transferSchoolSiteToPersonal(h.deps))
      .toEqual({ state: 'deferred', reason: 'the site record refused the update' });
  });
});

describe('FlyAppOrgContextResolver honours the hosting pin', () => {
  const resolverFor = (deployment: DeploymentDocument) => {
    const seen: string[] = [];
    const resolver = new FlyAppOrgContextResolver({
      userStorage: { getAllUsers: async () => [] },
      deploymentStorage: { listAll: async () => [deployment] },
      orgStorage: {
        listMembershipsByUser: async () => [],
        getOrg: async (orgId: string) => ({ orgId } as OrgDocument),
        listOrgs: async () => [],
      },
      orgFly: {
        resolveHostingContext: async (orgId: string) => {
          seen.push(orgId);
          return { source: 'org', orgSlug: `slug-${orgId}`, apiToken: 'token' };
        },
      },
      makeFlyClient: () => ({} as never),
    } as never);
    return { resolver, seen };
  };

  it('uses the pinned hosting workplace, not the owning one', async () => {
    const { resolver, seen } = resolverFor(
      siteDoc({ orgId: PLAN.targetOrgId, flyOrgId: PLAN.sourceOrgId }),
    );
    const context = await resolver.resolve(PLAN.flyApp);
    expect(seen).toEqual([PLAN.sourceOrgId]);
    expect(context?.orgSlug).toBe(`slug-${PLAN.sourceOrgId}`);
  });

  it('is unchanged for an ordinary record with no pin', async () => {
    const { resolver, seen } = resolverFor(siteDoc());
    await resolver.resolve(PLAN.flyApp);
    expect(seen).toEqual([PLAN.sourceOrgId]);
  });
});
