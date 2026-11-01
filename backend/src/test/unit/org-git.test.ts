import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { OrgGitService } from '../../services/org-git.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { mintHumanGitToken } from '../../services/human-git-token.js';
import { workspaceAssistantId } from '../../types/user.js';

/**
 * The org → git namespace binding (byo-git-design slice 1): members of a
 * stamped org share one namespace — one company, one `api` repo — while an
 * org-less user resolves to their own userId, which is the pre-org behavior
 * byte for byte. An unstamped org's members share its founder's namespace,
 * where its one knowledge shelf stands (note #923).
 */

async function orgWithMembers() {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin-1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'admin-1', role: 'admin' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'member-1', role: 'member' });
  return { orgStorage, org };
}

describe('OrgGitService.resolveNamespace', () => {
  it('answers the user their own id when they are in no org', async () => {
    const service = new OrgGitService({ orgStorage: new InMemoryOrgStorage() });
    expect(await service.resolveNamespace('u1')).toEqual({ namespaceId: 'u1', orgId: null, role: null });
  });

  it('answers every member of an UNSTAMPED org its founder\'s namespace — the workplace\'s one shelf (note #923)', async () => {
    // A workplace is one place with no rooms: a member stands where its
    // knowledge shelf stands, which for an org never stamped is its
    // founder's own namespace — never each member's own id.
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({ orgStorage });
    const resolved = await service.resolveNamespace('member-1');
    expect(resolved).toEqual({ namespaceId: 'admin-1', orgId: org.orgId, role: 'member' });
  });

  it('answers every member of a stamped org the SAME namespace, with their own role', async () => {
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({ orgStorage });
    await service.stampOrgGitNamespace(org.orgId, 'admin-1');

    expect(await service.resolveNamespace('admin-1')).toEqual({
      namespaceId: 'admin-1', orgId: org.orgId, role: 'admin',
    });
    expect(await service.resolveNamespace('member-1')).toEqual({
      namespaceId: 'admin-1', orgId: org.orgId, role: 'member',
    });
  });
});

describe('OrgGitService.namespacesForOrg', () => {
  it('answers the workplace\'s own namespace plus wherever its repositories live, deduplicated', async () => {
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({
      orgStorage, repoNamespacesForOrg: async () => ['admin-1', 'lessons-ns'],
    });
    await service.stampOrgGitNamespace(org.orgId, 'admin-1');

    expect(await service.namespacesForOrg('member-1', org.orgId)).toEqual(['admin-1', 'lessons-ns']);
  });

  it('keeps the namespaces the merge recorded once the room rows are gone (note #843)', async () => {
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({ orgStorage });
    await service.stampOrgGitNamespace(org.orgId, 'admin-1');
    // The first room adopted the workplace's own stamp, so the merge may
    // record it too; it is listed once.
    await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['admin-1', 'math-ns', 'growth-ns'] } });

    expect(await service.namespacesForOrg('member-1', org.orgId)).toEqual(['admin-1', 'math-ns', 'growth-ns']);
  });
});

describe('OrgGitService.adminsForNamespace', () => {
  it('a personal namespace decides for itself', async () => {
    const service = new OrgGitService({ orgStorage: new InMemoryOrgStorage() });
    expect(await service.adminsForNamespace({ namespaceId: 'u1', orgId: null, role: null }))
      .toEqual(['u1']);
  });

  it('an org namespace is decided by its admins', async () => {
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({ orgStorage });
    expect(await service.adminsForNamespace({ namespaceId: 'admin-1', orgId: org.orgId, role: 'member' }))
      .toEqual(['admin-1']);
  });
});

describe('OrgGitService.stampOrgGitNamespace', () => {
  it('is idempotent for the same value and refuses a different one', async () => {
    const { orgStorage, org } = await orgWithMembers();
    const service = new OrgGitService({ orgStorage });
    await service.stampOrgGitNamespace(org.orgId, 'admin-1');
    await service.stampOrgGitNamespace(org.orgId, 'admin-1'); // no throw
    await expect(service.stampOrgGitNamespace(org.orgId, 'somewhere-else'))
      .rejects.toThrow(/refusing to move/);
  });

  it('refuses an unknown org', async () => {
    const service = new OrgGitService({ orgStorage: new InMemoryOrgStorage() });
    await expect(service.stampOrgGitNamespace('nope', 'u1')).rejects.toThrow(/does not exist/);
  });
});

// ── The routes, shared: two members of a stamped org see one repo shelf ──

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => {
    response.statusCode = code;
    return response as Response;
  }) as Response['status'];
  response.json = ((payload: unknown) => {
    response.body = payload;
    return response as Response;
  }) as Response['json'];
  return response;
}

function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post',
): (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
      };
    }>;
  };
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === path && candidate.route.methods[method]
  ));
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function mockRequest(args: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}): Partial<Request> {
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: {},
    body: args.body,
  };
}

const HOST_SECRET = 'host-secret-value';

async function buildOrgDeps() {
  const userStorage = new InMemoryUserStorage();
  const tokens: Record<string, string> = {};
  for (const [userId, agentId] of [['admin-1', 'agent-a'], ['member-1', 'agent-b']] as const) {
    await userStorage.createProfile(userId, { email: `${userId}@example.com`, displayName: userId });
    const { token, tokenHash } = mintAgentbuiltToken(userId, agentId);
    tokens[userId] = token;
    await userStorage.updateProfile(userId, {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true,
        agents: { [agentId]: { id: agentId, name: agentId, cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
      },
    });
  }
  const { orgStorage, org } = await orgWithMembers();
  await userStorage.updateAgentFields('admin-1', 'agent-a', { orgId: org.orgId });
  await userStorage.updateAgentFields('member-1', 'agent-b', { orgId: org.orgId });
  const orgGit = new OrgGitService({ orgStorage });
  await orgGit.stampOrgGitNamespace(org.orgId, 'admin-1');
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const fetchImpl = vi.fn(async () => (
    { ok: true, status: 200, text: async () => '{}' } as unknown as globalThis.Response
  )) as unknown as typeof fetch;
  const gitHostClient = new GitHostClient({
    baseUrl: 'https://git.example.test',
    controlUrl: 'http://127.0.0.1:3002',
    secret: HOST_SECRET,
    fetchImpl,
  });
  const deps: Partial<RouteDeps> = {
    userStorage, gitRepoStorage, gitHostClient, gitHostSecret: HOST_SECRET, orgGit, orgStorage,
  };
  return { deps, tokens, gitRepoStorage, orgStorage, org };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An old room's namespace — what the room merge (note #843) recorded on the
 *  workplace before the room rows were dropped. Records made there then
 *  still stand there, and are the workplace's. */
const OLD_ROOM = 'room-math';

async function recordOldRooms(orgStorage: InMemoryOrgStorage, orgId: string, namespaces: string[]) {
  await orgStorage.updateOrg(orgId, { roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces } });
}

describe('org-shared repos over the agent CLI routes', () => {
  it("one member creates, the other lists it — one company, one shelf", async () => {
    const { deps, tokens, gitRepoStorage, org } = await buildOrgDeps();

    const createRes = createMockResponse();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['member-1']!), body: { name: 'api' } }), createRes,
    );
    expect(createRes.statusCode).toBe(201);

    // The record lives in the ORG's namespace and carries the org.
    const doc = await gitRepoStorage.getByName('admin-1', 'api');
    expect(doc).not.toBeNull();
    expect(doc?.orgId).toBe(org.orgId);
    expect(doc?.createdByAgentId).toBe('agent-b');

    const listRes = createMockResponse();
    await getRouteHandler(deps, '/repos', 'get')(
      mockRequest({ headers: authHeader(tokens['admin-1']!) }), listRes,
    );
    const listed = (listRes.body as { repos: Array<{ name: string; cloneUrl: string }> }).repos;
    expect(listed.map((r) => r.name)).toEqual(['api']);
    // Both members clone the SAME URL — the namespace's, not their own id's.
    expect(listed[0]!.cloneUrl).toContain('/admin-1/api.git');
  });

  it('a repository belongs to the workplace: every agent lists it, and a new one lands at the workplace\'s address (note #566)', async () => {
    const { deps, tokens, gitRepoStorage, org } = await buildOrgDeps();

    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['admin-1']!), body: { name: 'api' } }), createMockResponse(),
    );
    const memberCreate = createMockResponse();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['member-1']!), body: { name: 'lessons' } }), memberCreate,
    );
    expect(memberCreate.statusCode).toBe(201);

    // Whoever asks, a new repository lands at the WORKPLACE's address: the
    // namespace in a clone URL is where bytes live, never a wall.
    const doc = await gitRepoStorage.getByName('admin-1', 'lessons');
    expect(doc?.orgId).toBe(org.orgId);

    // Both agents read one list.
    for (const who of ['member-1', 'admin-1'] as const) {
      const list = createMockResponse();
      await getRouteHandler(deps, '/repos', 'get')(mockRequest({ headers: authHeader(tokens[who]!) }), list);
      const repos = (list.body as { repos: Array<{ name: string; cloneUrl: string }> }).repos;
      expect(repos.map((repo) => repo.name)).toEqual(['api', 'lessons']);
      expect(repos[1]!.cloneUrl).toContain('/admin-1/lessons.git');
    }

    // One name per workplace: another agent asking for `api` is handed the
    // one that exists, exactly as a retried create always was.
    const again = createMockResponse();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['member-1']!), body: { name: 'api' } }), again,
    );
    expect(again.body).toMatchObject({ created: false, repo: { cloneUrl: expect.stringContaining('/admin-1/api.git') } });
  });

  it('a repository that already lives at an old room\'s address is reached by every agent of the workplace, URL unchanged (note #566)', async () => {
    const { deps, tokens, gitRepoStorage, orgStorage, org } = await buildOrgDeps();
    // Made in a room before rooms were merged (note #843): its bytes stay at
    // the room's old address, which the merge recorded on the workplace.
    await recordOldRooms(orgStorage, org.orgId, [OLD_ROOM]);
    await gitRepoStorage.create({
      userId: OLD_ROOM, orgId: org.orgId, name: 'lessons', createdByAgentId: 'agent-b',
      sizeBytes: 0, protectDefaultBranch: true,
    });
    // admin-1's agent never made it and was never "shared" anything.
    const show = createMockResponse();
    await getRouteHandler(deps, '/repos/:name', 'get')(
      mockRequest({ headers: authHeader(tokens['admin-1']!), params: { name: 'lessons' } }), show,
    );
    expect(show.statusCode).toBe(200);
    const renamed = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/rename', 'post')(
      mockRequest({ headers: authHeader(tokens['admin-1']!), params: { name: 'lessons' }, body: { newName: 'lessons' } }), renamed,
    );
    expect((renamed.body as { cloneUrl: string }).cloneUrl).toContain(`/${OLD_ROOM}/lessons.git`);
  });

  it("the org's ceiling bounds the SUM of its namespaces — an old room's address is not a fresh quota", async () => {
    const { deps, tokens, gitRepoStorage, orgStorage, org } = await buildOrgDeps();
    await recordOldRooms(orgStorage, org.orgId, [OLD_ROOM]);
    await gitRepoStorage.create({ userId: 'admin-1', orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a', sizeBytes: 1000, protectDefaultBranch: true });
    await gitRepoStorage.create({ userId: OLD_ROOM, orgId: org.orgId, name: 'lessons', createdByAgentId: 'agent-b', sizeBytes: 300, protectDefaultBranch: true });

    const verify = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: tokens['member-1'] },
    }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { userId: string; quota: { userUsedBytes: number } };
    // The agent authenticates the WORKPLACE's namespace…
    expect(body.userId).toBe('admin-1');
    // …but the bytes counted against the ceiling are the whole org's, its
    // old rooms' addresses included.
    expect(body.quota.userUsedBytes).toBe(1300);
  });

  it("a laptop key reaches an old room namespace of the owner's org on the central host — and nobody else's", async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await recordOldRooms(orgStorage, org.orgId, [OLD_ROOM]);
    const { token, tokenHash } = mintHumanGitToken('member-1');
    await deps.userStorage!.updateProfile('member-1', {
      gitAccess: { tokenHash, createdAt: '2026-08-26T12:00:00Z' },
    });
    const { token: strangerToken, tokenHash: strangerHash } = mintHumanGitToken('stranger');
    await deps.userStorage!.createProfile('stranger', { email: 's@example.com', displayName: 'stranger' });
    await deps.userStorage!.updateProfile('stranger', {
      gitAccess: { tokenHash: strangerHash, createdAt: '2026-08-26T12:00:00Z' },
    });
    const verify = getRouteHandler(deps, '/git/verify', 'post');

    // Humans see everything: the member's one key pushes at the old address too.
    const ok = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': OLD_ROOM }, body: { token },
    }), ok);
    expect(ok.statusCode).toBe(200);
    expect((ok.body as { userId: string }).userId).toBe(OLD_ROOM);

    // A non-member's key does not, however valid it is.
    const denied = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': OLD_ROOM }, body: { token: strangerToken },
    }), denied);
    expect(denied.statusCode).toBe(403);
  });

  it("an agent token opens every namespace of its own workplace, and none of another's (note #566)", async () => {
    const { deps, tokens, orgStorage, org } = await buildOrgDeps();
    await recordOldRooms(orgStorage, org.orgId, [OLD_ROOM]);
    const verify = getRouteHandler(deps, '/git/verify', 'post');

    const own = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': OLD_ROOM },
      body: { token: tokens['member-1'] },
    }), own);
    expect(own.statusCode).toBe(200);
    expect((own.body as { userId: string }).userId).toBe(OLD_ROOM);

    // The workplace's own address: the whole namespace, with no
    // per-repository scope — a member's laptop key has had this since note #85.
    const base = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'admin-1' },
      body: { token: tokens['member-1'] },
    }), base);
    expect(base.statusCode).toBe(200);
    expect(base.body).toMatchObject({ userId: 'admin-1' });
    expect(base.body).not.toHaveProperty('scope');

    // The workplace stays the wall — another's old rooms included.
    const foreign = await orgStorage.createOrg({ name: 'Foreign', createdByUserId: 'stranger' });
    await orgStorage.addMember({ orgId: foreign.orgId, userId: 'stranger', role: 'admin' });
    await recordOldRooms(orgStorage, foreign.orgId, ['room-private']);
    for (const namespace of ['room-private', 'stranger', 'nobody-at-all']) {
      const crossing = createMockResponse();
      await verify(mockRequest({
        headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': namespace },
        body: { token: tokens['member-1'] },
      }), crossing);
      expect(crossing.statusCode).toBe(403);
    }
  });

  it('keeps a repository listable, cloneable and pushable at an address only the repository still records (note #566)', async () => {
    const { deps, tokens, gitRepoStorage, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({
      orgStorage, repoNamespacesForOrg: (orgId) => gitRepoStorage.listNamespacesByOrg(orgId),
    });
    // A room deleted before the merge left no trace on the workplace — but a
    // repository made in it still lives at its address.
    await gitRepoStorage.create({
      userId: OLD_ROOM, orgId: org.orgId, name: 'lessons', createdByAgentId: 'agent-b',
      sizeBytes: 0, protectDefaultBranch: true,
    });

    const list = createMockResponse();
    await getRouteHandler(deps, '/repos', 'get')(mockRequest({ headers: authHeader(tokens['admin-1']!) }), list);
    expect((list.body as { repos: Array<{ name: string; cloneUrl: string }> }).repos)
      .toEqual([expect.objectContaining({ name: 'lessons', cloneUrl: expect.stringContaining(`/${OLD_ROOM}/lessons.git`) })]);

    const verify = getRouteHandler(deps, '/git/verify', 'post');
    const push = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': OLD_ROOM },
      body: { token: tokens['admin-1'] },
    }), push);
    expect(push.statusCode).toBe(200);
    expect((push.body as { userId: string }).userId).toBe(OLD_ROOM);
    // Only because a repository of THIS workplace lives there: an address
    // nothing of ours lives at is still nobody's.
    const nowhere = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'a-room-that-never-was' },
      body: { token: tokens['admin-1'] },
    }), nowhere);
    expect(nowhere.statusCode).toBe(403);
  });

  it('lets Workspace Agent clone at any namespace of its own workplace, but never cross the workplace boundary', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await recordOldRooms(orgStorage, org.orgId, ['room-project']);
    const agentId = workspaceAssistantId('member-1', org.orgId);
    const minted = mintAgentbuiltToken('member-1', agentId);
    const profile = await deps.userStorage!.getProfile('member-1');
    await deps.userStorage!.updateProfile('member-1', { telegram: {
      ...profile!.telegram!, agents: { ...profile!.telegram!.agents,
        [agentId]: { id: agentId, name: 'Workspace Agent', purpose: 'workspace-recap', cli: 'codex', orgId: org.orgId, agentbuiltTokenHash: minted.tokenHash },
      },
    } });
    const verify = getRouteHandler(deps, '/git/verify', 'post');

    const projectAccess = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'room-project' },
      body: { token: minted.token },
    }), projectAccess);
    expect(projectAccess.statusCode).toBe(200);
    expect((projectAccess.body as { userId: string }).userId).toBe('room-project');

    const foreign = await orgStorage.createOrg({ name: 'Foreign', createdByUserId: 'stranger' });
    await orgStorage.addMember({ orgId: foreign.orgId, userId: 'stranger', role: 'admin' });
    await recordOldRooms(orgStorage, foreign.orgId, ['room-private']);
    const crossing = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'room-private' },
      body: { token: minted.token },
    }), crossing);
    expect(crossing.statusCode).toBe(403);
  });

  it('records which admin agent asked for a delete, so only its owner can decide', async () => {
    const { deps, tokens, gitRepoStorage } = await buildOrgDeps();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['admin-1']!), body: { name: 'api' } }), createMockResponse(),
    );

    await getRouteHandler(deps, '/repos/:name/delete', 'post')(
      mockRequest({ headers: authHeader(tokens['admin-1']!), params: { name: 'api' } }), createMockResponse(),
    );

    const doc = await gitRepoStorage.getByName('admin-1', 'api');
    expect(doc?.deleteAsk).toEqual(expect.objectContaining({ byAgentId: 'agent-a', byUserId: 'admin-1' }));
  });

  it('lets a member-owned agent narrow CI secrets, but not request an expanded grant', async () => {
    const { deps, tokens, gitRepoStorage } = await buildOrgDeps();
    deps.secretStorage = new InMemorySecretStorage();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(tokens['member-1']!), body: { name: 'api' } }), createMockResponse(),
    );
    const repo = await gitRepoStorage.getByName('admin-1', 'api');
    expect(repo).not.toBeNull();
    await gitRepoStorage.update(repo!.id, { ciSecrets: ['CF_TOKEN', 'HETZ_KEY'] });
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');

    const remove = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(tokens['member-1']!), params: { name: 'api' },
      body: { names: ['CF_TOKEN'], remove: true },
    }), remove);

    expect(remove.statusCode).toBe(200);
    expect((await gitRepoStorage.get(repo!.id))?.ciSecrets).toEqual(['HETZ_KEY']);

    const expand = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(tokens['member-1']!), params: { name: 'api' },
      body: { names: ['CF_TOKEN'] },
    }), expand);

    expect(expand.statusCode).toBe(403);
    expect((expand.body as { error: string }).error).toContain('may narrow CI access');
    expect((await gitRepoStorage.get(repo!.id))?.ciSecrets).toEqual(['HETZ_KEY']);
  });

  it('verify answers the org namespace for a member token, so the host needs no org logic', async () => {
    const { deps, tokens } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: tokens['member-1'] } }), res,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { userId: string; agentId: string }).userId).toBe('admin-1');
    expect((res.body as { agentId: string }).agentId).toBe('agent-b');
  });

  it('one laptop key authenticates each URL namespace without changing the active org', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const second = await orgStorage.createOrg({ name: 'Second', createdByUserId: 'member-1' });
    await orgStorage.addMember({ orgId: second.orgId, userId: 'member-1', role: 'admin' });
    await orgStorage.updateOrg(second.orgId, { git: { namespaceId: second.orgId } });
    const { token, tokenHash } = mintHumanGitToken('member-1');
    await deps.userStorage!.updateProfile('member-1', {
      gitAccess: { tokenHash, createdAt: '2026-08-26T12:00:00Z' },
    });
    const verify = getRouteHandler(deps, '/git/verify', 'post');

    const first = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'admin-1' }, body: { token },
    }), first);
    expect(first.statusCode).toBe(200);
    expect((first.body as { userId: string }).userId).toBe('admin-1');

    const other = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': second.orgId }, body: { token },
    }), other);
    expect(other.statusCode).toBe(200);
    expect((other.body as { userId: string }).userId).toBe(second.orgId);
    // URL-based verification never mutates the Workspace selector.
    expect((await orgStorage.getMembershipByUser('member-1'))?.orgId).toBe(org.orgId);

    const foreign = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'somebody-elses-org' }, body: { token },
    }), foreign);
    expect(foreign.statusCode).toBe(403);
  });

  it('revokes a laptop key from a legacy user-id namespace when that human leaves its org', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const { token, tokenHash } = mintHumanGitToken('admin-1');
    await deps.userStorage!.updateProfile('admin-1', {
      gitAccess: { tokenHash, createdAt: '2026-08-26T12:00:00Z' },
    });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'replacement-admin', role: 'admin' });
    await orgStorage.removeMember(org.orgId, 'admin-1');

    const res = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({
        headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'admin-1' },
        body: { token },
      }),
      res,
    );

    // The namespace string happens to equal this former member's user id,
    // but the org still owns it. Personal credentials stop at membership.
    expect(res.statusCode).toBe(403);
  });

  it('requires membership before a laptop key can authenticate to an older per-org host', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const foreign = await orgStorage.createOrg({ name: 'Foreign', createdByUserId: 'outsider' });
    await orgStorage.addMember({ orgId: foreign.orgId, userId: 'outsider', role: 'admin' });
    await orgStorage.updateOrg(foreign.orgId, { git: { namespaceId: foreign.orgId } });
    deps.orgSecrets = {
      getOrgSecret: async (orgId: string) => (
        orgId === org.orgId ? 'acme-host-secret'
          : orgId === foreign.orgId ? 'foreign-host-secret'
            : null
      ),
    } as never;
    const { token, tokenHash } = mintHumanGitToken('member-1');
    await deps.userStorage!.updateProfile('member-1', {
      gitAccess: { tokenHash, createdAt: '2026-08-26T12:00:00Z' },
    });
    const verify = getRouteHandler(deps, '/git/verify', 'post');

    // Hosts deployed before URL-namespace verification send only their org
    // header. A real member still works through that compatibility path.
    const own = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': 'acme-host-secret', 'x-git-host-org': org.orgId }, body: { token },
    }), own);
    expect(own.statusCode).toBe(200);
    expect((own.body as { userId: string }).userId).toBe('admin-1');

    // Possessing a valid personal key is not membership in this other host.
    const denied = createMockResponse();
    await verify(mockRequest({
      headers: { 'x-git-host-secret': 'foreign-host-secret', 'x-git-host-org': foreign.orgId }, body: { token },
    }), denied);
    expect(denied.statusCode).toBe(403);
  });

  it("a per-org host authenticates with ITS org's secret — and only its own", async () => {
    const { deps, tokens, orgStorage, org } = await buildOrgDeps();
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'member-1' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'member-1', role: 'admin' });
    deps.orgSecrets = {
      getOrgSecret: async (orgId: string, name: string) => (
        name !== 'GIT_HOST_SECRET' ? null
          : orgId === org.orgId ? 'org-own-secret'
            : orgId === other.orgId ? 'other-org-secret'
              : null
      ),
    } as never;

    const okRes = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({
        headers: { 'x-git-host-secret': 'org-own-secret', 'x-git-host-org': org.orgId },
        body: { token: tokens['member-1'] },
      }), okRes,
    );
    expect(okRes.statusCode).toBe(200);

    // This human is also an admin in Other, but this TOKEN is agent-b's and
    // agent-b is permanently pinned to Acme. Membership alone cannot move it
    // across private git hosts.
    const otherHost = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({
        headers: { 'x-git-host-secret': 'other-org-secret', 'x-git-host-org': other.orgId },
        body: { token: tokens['member-1'] },
      }), otherHost,
    );
    expect(otherHost.statusCode).toBe(403);

    // The org header SELECTS the secret to compare — the platform secret
    // presented under an org name is a refusal, and vice versa.
    const crossRes = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({
        headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-host-org': org.orgId },
        body: { token: tokens['member-1'] },
      }), crossRes,
    );
    expect(crossRes.statusCode).toBe(401);

    const unknownOrg = createMockResponse();
    await getRouteHandler(deps, '/git/verify', 'post')(
      mockRequest({
        headers: { 'x-git-host-secret': 'org-own-secret', 'x-git-host-org': 'no-such-org' },
        body: { token: tokens['member-1'] },
      }), unknownOrg,
    );
    expect(unknownOrg.statusCode).toBe(401);
  });
});
