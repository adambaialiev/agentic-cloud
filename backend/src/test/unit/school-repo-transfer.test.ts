import { describe, expect, it } from 'vitest';
import {
  SCHOOL_REPO_TRANSFER_PLAN as PLAN,
  transferSchoolReposToPersonal,
  type SchoolRepoTransferDeps,
} from '../../services/school-repo-transfer.js';
import { isLiveRepo, type GitRepoDocument } from '../../types/git-repo.js';
import type { OrgDocument, OrgMembershipDocument, OrgRoomDocument } from '../../types/org.js';

const OWNER = 'tg_1000000000000_0wner0000000';
/** The Personal workplace's own namespace — its School room stands here too. */
const TARGET_NS = PLAN.targetOrgId;

function org(orgId: string, extra: Partial<OrgDocument> = {}): OrgDocument {
  return {
    orgId,
    name: orgId === PLAN.sourceOrgId ? 'Org #0' : 'Personal',
    createdByUserId: OWNER,
    createdAt: '2026-01-01T00:00:00.000Z',
    git: { namespaceId: orgId === PLAN.sourceOrgId ? OWNER : orgId },
    ...extra,
  } as OrgDocument;
}

function repoDoc(id: string, name: string, over: Partial<GitRepoDocument> = {}): GitRepoDocument {
  return {
    id,
    name,
    userId: PLAN.sourceNamespaceId,
    orgId: PLAN.sourceOrgId,
    createdByAgentId: 'felix',
    createdAt: '2026-08-07T09:30:45.010Z',
    protectDefaultBranch: name === 'eldiyar-math',
    ...over,
  } as GitRepoDocument;
}

/** The two halves this migration touches, in memory: repo records, and a host
 *  whose "move" is the same one-place-or-the-other rename the real one is. */
function harness(options: {
  repos?: GitRepoDocument[];
  orgs?: OrgDocument[];
  members?: OrgMembershipDocument[];
  rooms?: OrgRoomDocument[];
  moveFails?: boolean;
  updateFails?: boolean;
} = {}) {
  const repos = new Map((options.repos ?? [
    repoDoc(PLAN.repos[0].id, PLAN.repos[0].name),
    repoDoc(PLAN.repos[1].id, PLAN.repos[1].name),
  ]).map((doc) => [doc.id, doc]));
  const orgs = new Map((options.orgs ?? [org(PLAN.sourceOrgId), org(PLAN.targetOrgId)])
    .map((doc) => [doc.orgId, doc]));
  const members = options.members ?? [
    { orgId: PLAN.sourceOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
    { orgId: PLAN.targetOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
  ];
  /** namespace -> repo names living there. */
  const onDisk = new Map<string, Set<string>>([
    [PLAN.sourceNamespaceId, new Set([...repos.values()].map((r) => r.name))],
  ]);
  const at = (ns: string) => {
    if (!onDisk.has(ns)) onDisk.set(ns, new Set());
    return onDisk.get(ns)!;
  };
  const moves: Array<{ from: string; name: string; to: string }> = [];

  const deps: SchoolRepoTransferDeps = {
    orgStorage: {
      getOrg: async (orgId: string) => orgs.get(orgId) ?? null,
      listMembers: async (orgId: string) => members.filter((m) => m.orgId === orgId),
      listRoomsByOrg: async (orgId: string) => (options.rooms ?? []).filter((r) => r.orgId === orgId),
      getWorkspaceRoom: async () => null,
    } as SchoolRepoTransferDeps['orgStorage'],
    gitRepoStorage: {
      get: async (id: string) => repos.get(id) ?? null,
      getLiveByNameIn: async (namespaceIds: readonly string[], name: string) =>
        [...repos.values()].find((d) => namespaceIds.includes(d.userId) && d.name === name && isLiveRepo(d)) ?? null,
      update: async (id: string, updates: Partial<GitRepoDocument>) => {
        if (options.updateFails) throw new Error('storage is down');
        const doc = repos.get(id);
        if (!doc) return false;
        repos.set(id, { ...doc, ...updates });
        return true;
      },
    } as SchoolRepoTransferDeps['gitRepoStorage'],
    hostFor: async () => ({
      moveRepo: async (userId: string, name: string, toUserId: string) => {
        if (options.moveFails) throw new Error('host is down');
        if (!at(userId).has(name)) throw new Error('no such repo');
        if (at(toUserId).has(name)) throw new Error('already exists there');
        at(userId).delete(name);
        at(toUserId).add(name);
        moves.push({ from: userId, name, to: toUserId });
      },
    }),
  };
  return { deps, repos, onDisk, moves };
}

describe('transferSchoolReposToPersonal', () => {
  it('moves both repositories to the Personal workplace, bytes and record together', async () => {
    const h = harness();
    const result = await transferSchoolReposToPersonal(h.deps);

    expect(result.moved.map((m) => m.name)).toEqual(['eldiyar-math', 'eldiyar-backups']);
    expect(result.deferred).toEqual([]);
    for (const pinned of PLAN.repos) {
      const doc = h.repos.get(pinned.id)!;
      // The namespace is what authorization actually reads, so it has to change.
      expect(doc.userId).toBe(TARGET_NS);
      expect(doc.orgId).toBe(PLAN.targetOrgId);
      expect(h.onDisk.get(TARGET_NS)!.has(pinned.name)).toBe(true);
    }
    // Nothing is left behind at School's namespace.
    expect([...h.onDisk.get(PLAN.sourceNamespaceId)!]).toEqual([]);
  });

  it('keeps protection, and never deletes a record', async () => {
    const h = harness();
    await transferSchoolReposToPersonal(h.deps);
    expect(h.repos.size).toBe(2);
    expect(h.repos.get(PLAN.repos[0].id)!.protectDefaultBranch).toBe(true);
    expect(h.repos.get(PLAN.repos[1].id)!.protectDefaultBranch).toBe(false);
  });

  it('is idempotent — a second run moves nothing', async () => {
    const h = harness();
    await transferSchoolReposToPersonal(h.deps);
    const again = await transferSchoolReposToPersonal(h.deps);
    expect(again.moved).toEqual([]);
    expect(again.deferred).toEqual([]);
    expect(again.alreadyDone).toEqual(['eldiyar-math', 'eldiyar-backups']);
    expect(h.moves).toHaveLength(2);
  });

  it('refuses when nobody administers both workplaces', async () => {
    const h = harness({
      members: [
        { orgId: PLAN.sourceOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
        { orgId: PLAN.targetOrgId, userId: 'someone-else', role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
      ],
    });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.moved).toEqual([]);
    expect(result.deferred.map((d) => d.reason)).toEqual([
      'no one is an admin of both workplaces',
      'no one is an admin of both workplaces',
    ]);
    expect(h.moves).toEqual([]);
  });

  it('refuses a member who is not an admin of the target', async () => {
    const h = harness({
      members: [
        { orgId: PLAN.sourceOrgId, userId: OWNER, role: 'admin', joinedAt: 'x' } as OrgMembershipDocument,
        { orgId: PLAN.targetOrgId, userId: OWNER, role: 'member', joinedAt: 'x' } as OrgMembershipDocument,
      ],
    });
    expect((await transferSchoolReposToPersonal(h.deps)).moved).toEqual([]);
    expect(h.moves).toEqual([]);
  });

  it('refuses to cross git hosts', async () => {
    const withHost = org(PLAN.targetOrgId);
    (withHost.git as { host?: unknown }).host = { app: 'ia-git-personal' };
    const h = harness({ orgs: [org(PLAN.sourceOrgId), withHost] });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.moved).toEqual([]);
    expect(result.deferred[0].reason).toContain('own git host');
    expect(h.moves).toEqual([]);
  });

  it('leaves a record that drifted exactly where it is', async () => {
    const h = harness({
      repos: [
        repoDoc(PLAN.repos[0].id, PLAN.repos[0].name, { userId: 'somewhere-else' }),
        repoDoc(PLAN.repos[1].id, PLAN.repos[1].name),
      ],
    });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.moved.map((m) => m.name)).toEqual(['eldiyar-backups']);
    expect(result.deferred[0]).toMatchObject({ name: 'eldiyar-math' });
    expect(result.deferred[0].reason).toContain('namespace is "somewhere-else"');
    expect(h.repos.get(PLAN.repos[0].id)!.userId).toBe('somewhere-else');
  });

  it('will not move a deleted repository', async () => {
    const h = harness({
      repos: [
        repoDoc(PLAN.repos[0].id, PLAN.repos[0].name, { deletedAt: '2026-09-01T00:00:00.000Z' }),
        repoDoc(PLAN.repos[1].id, PLAN.repos[1].name),
      ],
    });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.deferred[0].reason).toContain('deleted');
    expect(result.moved.map((m) => m.name)).toEqual(['eldiyar-backups']);
  });

  it('refuses when the target workplace already holds that name', async () => {
    const h = harness({
      repos: [
        repoDoc(PLAN.repos[0].id, PLAN.repos[0].name),
        repoDoc(PLAN.repos[1].id, PLAN.repos[1].name),
        repoDoc('other', 'eldiyar-math', { userId: TARGET_NS, orgId: PLAN.targetOrgId }),
      ],
    });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.deferred[0].reason).toContain('already in the target workplace');
    expect(result.moved.map((m) => m.name)).toEqual(['eldiyar-backups']);
  });

  it('puts the bytes back when the record will not update', async () => {
    const h = harness({ updateFails: true });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.moved).toEqual([]);
    expect(result.deferred[0].reason).toContain('moved back');
    // Both ends agree again: the record says School, and so does the disk.
    expect([...h.onDisk.get(PLAN.sourceNamespaceId)!].sort()).toEqual(['eldiyar-backups', 'eldiyar-math']);
    expect(h.onDisk.get(TARGET_NS)?.size ?? 0).toBe(0);
    expect(h.repos.get(PLAN.repos[0].id)!.userId).toBe(PLAN.sourceNamespaceId);
  });

  it('changes nothing when a workplace is missing', async () => {
    const h = harness({ orgs: [org(PLAN.sourceOrgId)] });
    const result = await transferSchoolReposToPersonal(h.deps);
    expect(result.moved).toEqual([]);
    expect(result.deferred[0].reason).toContain('does not exist');
    expect(h.moves).toEqual([]);
  });
});
