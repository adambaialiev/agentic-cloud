import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Request, Response } from 'express';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteGitRepoStorage } from '../../services/sqlite/sqlite-git-repo-storage.js';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryGitCommitStatusStorage } from '../../services/git-commit-status-storage.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { mintHumanGitToken } from '../../services/human-git-token.js';
import {
  validateGitRepoName, GIT_USER_MAX_BYTES, GIT_VOLUME_USABLE_PERCENT, gitUserMaxBytesForVolume,
} from '../../types/git-repo.js';

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
  query?: Record<string, string>;
  body?: unknown;
}): Partial<Request> {
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: args.query ?? {},
    body: args.body,
  };
}

const HOST_SECRET = 'host-secret-value';
/** A per-org host's own secret — see `gitHostCallerOk`. */
const ORG_HOST_SECRET = 'org-host-secret-value';

async function buildDeps(args?: { orgVolumeGb?: number; agentOrgId?: string }) {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        'agent-a': {
          id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: tokenHash,
          // A token belongs to its agent's immutable org: verify refuses one
          // presented to a host that names a different org, so a test about
          // an org host has to put the agent IN that org.
          ...(args?.agentOrgId ? { orgId: args.agentOrgId } : {}),
        } as never,
      },
    },
  });
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const created: Array<{ userId: string; name: string }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    created.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  }) as unknown as typeof fetch;
  const gitHostClient = new GitHostClient({
    baseUrl: 'https://git.example.test',
    controlUrl: 'http://127.0.0.1:3002',
    secret: HOST_SECRET,
    fetchImpl,
  });
  const deps: Partial<RouteDeps> = {
    userStorage, gitRepoStorage, gitHostClient, gitHostSecret: HOST_SECRET,
  };
  // The org git layer, only when a test is about it (note #62): the ceiling
  // the host is handed depends on WHICH host is asking, and the plain harness
  // has no org layer at all — which is itself the shared-box case.
  if (args?.orgVolumeGb) {
    const volumeGb = args.orgVolumeGb;
    deps.orgGitHost = {
      clientFor: async () => gitHostClient,
      userMaxBytesFor: async (orgId: string | null | undefined) => (
        orgId ? gitUserMaxBytesForVolume(volumeGb) : GIT_USER_MAX_BYTES
      ),
    } as never;
    // A per-org host authenticates with the ORG's secret, not the platform's
    // — one backend serves N hosts, each holding its own. Without this the
    // call is a 401 long before any quota is computed.
    deps.orgSecrets = {
      getOrgSecret: async (orgId: string, name: string) => (
        orgId === args.agentOrgId && name === 'GIT_HOST_SECRET' ? ORG_HOST_SECRET : null
      ),
    } as never;
  }
  return { deps, token, gitRepoStorage, created, fetchImpl };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('git repo names', () => {
  it('accepts ordinary repo names', () => {
    for (const name of ['api', 'my-shop', 'infra_v2', 'site.dev', 'a1']) {
      expect(validateGitRepoName(name)).toBeNull();
    }
  });

  it('rejects names that would escape the namespace or confuse the URL', () => {
    // `..` climbs out of <userId>/ the moment a path is built from it, and a
    // trailing `.git` collides with how every repo path already ends.
    expect(validateGitRepoName('../etc')).not.toBeNull();
    expect(validateGitRepoName('a..b')).not.toBeNull();
    expect(validateGitRepoName('api.git')).not.toBeNull();
    expect(validateGitRepoName('UPPER')).not.toBeNull();
    expect(validateGitRepoName('-lead')).not.toBeNull();
    expect(validateGitRepoName('a')).not.toBeNull();
  });
});

describe('gitUserMaxBytesForVolume (note #62)', () => {
  const GIB = 1024 * 1024 * 1024;

  it('gives a volume’s repos 80% of it — the host’s own disk headroom, not a second number', () => {
    expect(gitUserMaxBytesForVolume(10)).toBe(8 * GIB);
    expect(gitUserMaxBytesForVolume(100)).toBe(80 * GIB);
    expect(GIT_VOLUME_USABLE_PERCENT).toBe(80);
  });

  // The fifth left over is doing work: a push writes its packfile before the
  // hook measures it, `gc` repacks into a second copy before dropping the
  // first, and a deleted repo sits in the trash still holding its bytes.
  it('never promises the whole disk, and always beats the shared box’s fair share', () => {
    for (const gb of [10, 20, 50, 100]) {
      expect(gitUserMaxBytesForVolume(gb)).toBeLessThan(gb * GIB);
      expect(gitUserMaxBytesForVolume(gb)).toBeGreaterThan(GIT_USER_MAX_BYTES);
    }
  });

  it('answers a whole number of bytes — this rides an env var into a shell hook', () => {
    // The quota reaches the pre-receive hook as a decimal string; a fraction
    // there would be compared by a shell that does integer arithmetic.
    expect(Number.isInteger(gitUserMaxBytesForVolume(3))).toBe(true);
    expect(Number.isInteger(gitUserMaxBytesForVolume(7))).toBe(true);
  });
});

describe('git repo storage', () => {
  it('scopes names to the user, so two users may both own "api"', async () => {
    const storage = new InMemoryGitRepoStorage();
    await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    });
    await expect(storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a2', sizeBytes: 0, protectDefaultBranch: true,
    })).rejects.toThrow(/already exists/);

    const other = await storage.create({
      userId: 'u2', name: 'api', createdByAgentId: 'b1', sizeBytes: 0, protectDefaultBranch: true,
    });
    expect(other.userId).toBe('u2');
    expect((await storage.getByName('u1', 'api'))?.createdByAgentId).toBe('a1');
  });

  it('totals the bytes of one user for the quota check', async () => {
    const storage = new InMemoryGitRepoStorage();
    const one = await storage.create({
      userId: 'u1', name: 'a', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    });
    await storage.create({
      userId: 'u1', name: 'b', createdByAgentId: 'a1', sizeBytes: 40, protectDefaultBranch: true,
    });
    await storage.create({
      userId: 'u2', name: 'c', createdByAgentId: 'b1', sizeBytes: 1000, protectDefaultBranch: true,
    });
    await storage.update(one.id, { sizeBytes: 60 });
    expect(await storage.totalBytesForUser('u1')).toBe(100);
  });

  it('looks up only a live repository by its opaque public id', async () => {
    const storage = new InMemoryGitRepoStorage();
    const repo = await storage.create({
      userId: 'u1', name: 'open', createdByAgentId: 'a1', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: { id: 'public-1', publishedAt: '2026-09-25T00:00:00.000Z', publishedByUserId: 'owner' },
    });
    expect((await storage.getPublicById('public-1'))?.id).toBe(repo.id);
    expect(await storage.getPublicById('missing')).toBeNull();
    await storage.update(repo.id, { deletedAt: '2026-09-25T01:00:00.000Z' });
    expect(await storage.getPublicById('public-1')).toBeNull();
  });

  it('reads a workplace\'s repositories across its namespaces, and nothing outside them (note #566)', async () => {
    const storage = new InMemoryGitRepoStorage();
    const api = await storage.create({
      userId: 'main-room', name: 'api', createdByAgentId: 'a1', sizeBytes: 50, protectDefaultBranch: true,
    });
    await storage.create({
      userId: 'school-room', name: 'lessons', createdByAgentId: 'a2', sizeBytes: 7, protectDefaultBranch: true,
    });
    await storage.create({
      userId: 'other-workplace', name: 'api', createdByAgentId: 'a3', sizeBytes: 1, protectDefaultBranch: true,
    });
    const workplace = ['main-room', 'school-room', 'sales-room'];
    // Whichever room asks, the answer is the workplace's — and the bytes
    // stay at the one address they were created at.
    expect(await storage.getLiveByNameIn(workplace, 'api')).toEqual(api);
    expect((await storage.listLiveIn(workplace)).map((doc) => doc.name)).toEqual(['api', 'lessons']);
    expect(await storage.getByName('school-room', 'api')).toBeNull();
    expect(await storage.totalBytesForUser('main-room')).toBe(50);
    // A retired share list opens no door: only the address counts.
    await storage.update(api.id, { sharedWithNamespaceIds: ['elsewhere'] });
    expect(await storage.getLiveByNameIn(['elsewhere'], 'api')).toBeNull();
  });

  it('keeps a name unique across the namespaces it is told to, and the trash with them', async () => {
    const storage = new InMemoryGitRepoStorage();
    const workplace = ['main-room', 'school-room'];
    const first = await storage.create({
      userId: 'main-room', name: 'api', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    }, workplace);
    await expect(storage.create({
      userId: 'school-room', name: 'api', createdByAgentId: 'a2', sizeBytes: 0, protectDefaultBranch: true,
    }, workplace)).rejects.toThrow(/already exists/);
    await storage.update(first.id, { deletedAt: '2026-09-19T00:00:00.000Z', trashedAs: 'api.1.git' });
    expect(await storage.getLiveByNameIn(workplace, 'api')).toBeNull();
    expect((await storage.getTrashedByNameIn(['school-room', 'main-room'], 'api'))?.id).toBe(first.id);
    expect((await storage.listTrashedIn(['school-room'])).length).toBe(0);
  });
});

/**
 * The SQLite implementation has to agree with the in-memory one on every
 * answer the routes rely on — the two are chosen by env at boot, so a
 * divergence only ever shows up in production.
 */
describe('git repo storage (SQLite)', () => {
  let dir: string;
  let db: SqliteDb;
  let storage: SqliteGitRepoStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-repos-'));
    db = openSqliteDb(join(dir, 'test.db'));
    storage = new SqliteGitRepoStorage(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches the in-memory contract for uniqueness, lookup and totals', async () => {
    await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 10, protectDefaultBranch: true,
    });
    // Held by the UNIQUE(user_id, name) index, not by a read-then-write check.
    await expect(storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a2', sizeBytes: 0, protectDefaultBranch: true,
    })).rejects.toThrow(/already exists/);

    await storage.create({
      userId: 'u2', name: 'api', createdByAgentId: 'b1', sizeBytes: 7, protectDefaultBranch: false,
    });
    expect((await storage.getByName('u2', 'api'))?.protectDefaultBranch).toBe(false);
    expect(await storage.totalBytesForUser('u1')).toBe(10);
    expect((await storage.listByUser('u1')).map((d) => d.name)).toEqual(['api']);
  });

  it('survives a reopen — the record is on disk, not in the process', async () => {
    const created = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    });
    await storage.update(created.id, { sizeBytes: 2048, defaultBranch: 'main' });
    db.close();

    db = openSqliteDb(join(dir, 'test.db'));
    const reopened = new SqliteGitRepoStorage(db);
    const doc = await reopened.getByName('u1', 'api');
    expect(doc?.sizeBytes).toBe(2048);
    expect(doc?.defaultBranch).toBe('main');
  });

  it('persists a unique public id and excludes a deleted repository from public lookup', async () => {
    const access = { id: 'public-1', publishedAt: '2026-09-25T00:00:00.000Z', publishedByUserId: 'owner' };
    const repo = await storage.create({
      userId: 'u1', name: 'open', createdByAgentId: 'a1', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: access,
    });
    expect((await storage.getPublicById(access.id))?.id).toBe(repo.id);
    await expect(storage.create({
      userId: 'u2', name: 'also-open', createdByAgentId: 'a2', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: access,
    })).rejects.toThrow();
    await storage.update(repo.id, { deletedAt: '2026-09-25T01:00:00.000Z' });
    expect(await storage.getPublicById(access.id)).toBeNull();
  });

  it('agrees with the in-memory store on workplace-wide reads, names and trash (note #566)', async () => {
    const workplace = ['main-room', 'school-room'];
    const api = await storage.create({
      userId: 'main-room', name: 'api', createdByAgentId: 'a1', sizeBytes: 50, protectDefaultBranch: true,
    }, workplace);
    await storage.create({
      userId: 'other-workplace', name: 'api', createdByAgentId: 'a3', sizeBytes: 1, protectDefaultBranch: true,
    });
    await expect(storage.create({
      userId: 'school-room', name: 'api', createdByAgentId: 'a2', sizeBytes: 0, protectDefaultBranch: true,
    }, workplace)).rejects.toThrow(/already exists/);
    expect((await storage.listLiveIn(['school-room', 'main-room', 'main-room'])).map((doc) => doc.id)).toEqual([api.id]);
    expect((await storage.getLiveByNameIn(workplace, 'api'))?.userId).toBe('main-room');
    expect(await storage.getLiveByNameIn(['school-room'], 'api')).toBeNull();
    expect(await storage.totalBytesForUser('school-room')).toBe(0);
    await storage.update(api.id, { deletedAt: '2026-09-19T00:00:00.000Z', trashedAs: 'api.1.git' });
    expect(await storage.getLiveByNameIn(workplace, 'api')).toBeNull();
    expect((await storage.getTrashedByNameIn(workplace, 'api'))?.id).toBe(api.id);
    expect((await storage.listTrashedIn(['other-workplace'])).length).toBe(0);
  });

  it('names every namespace a workplace\'s repositories live at, trashed ones included (note #566)', async () => {
    const live = await storage.create({
      userId: 'school-room', orgId: 'org-1', name: 'lessons', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    });
    const gone = await storage.create({
      userId: 'old-room', orgId: 'org-1', name: 'archive', createdByAgentId: 'a1', sizeBytes: 0, protectDefaultBranch: true,
    });
    await storage.update(gone.id, { deletedAt: '2026-09-19T00:00:00.000Z', trashedAs: 'archive.1.git' });
    await storage.create({
      userId: 'theirs', orgId: 'org-2', name: 'lessons', createdByAgentId: 'a9', sizeBytes: 0, protectDefaultBranch: true,
    });
    await storage.create({
      userId: 'personal', name: 'mine', createdByAgentId: 'a5', sizeBytes: 0, protectDefaultBranch: true,
    });
    expect((await storage.listNamespacesByOrg('org-1')).sort()).toEqual(['old-room', 'school-room']);
    expect(await storage.listNamespacesByOrg('org-3')).toEqual([]);
    expect(live.orgId).toBe('org-1');
  });
});

describe('POST /repos', () => {
  it('creates the directory on the host before the record', async () => {
    const { deps, token, created, gitRepoStorage } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { name: 'api' } }), res);

    expect(res.statusCode).toBe(201);
    // The host is told which branches to protect, so it can write that into
    // the repo's own config where its pre-receive hook reads it. The singular
    // field rides along for a host that predates multi-branch protection.
    expect(created).toEqual([{ userId: 'user-1', name: 'api', protectedBranch: 'main', protectedBranches: ['main'] }]);
    const body = res.body as { repo: { cloneUrl: string; protectedBranch: string | null } };
    expect(body.repo.cloneUrl).toBe('https://git.example.test/user-1/api.git');
    // Protected by default: the phase-2 approval gate is opt-OUT.
    expect(body.repo.protectedBranch).toBe('main');
    expect(await gitRepoStorage.getByName('user-1', 'api')).not.toBeNull();
  });

  it('honours an explicit --unprotected', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { name: 'scratch', protect: false } }), res);

    expect((res.body as { repo: { protectedBranch: string | null } }).repo.protectedBranch).toBeNull();
  });

  it('is idempotent: a repeated create returns the same repo, not an error', async () => {
    const { deps, token, created } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos', 'post');

    const first = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), body: { name: 'api' } }), first);
    const second = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), body: { name: 'api' } }), second);

    expect(second.statusCode).toBe(200);
    expect((second.body as { created: boolean }).created).toBe(false);
    // And crucially the host was not asked to re-init a repo that has commits.
    expect(created).toHaveLength(1);
  });

  it('rejects a traversal name before the host is ever called', async () => {
    const { deps, token, created } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { name: '../../etc' } }), res);

    expect(res.statusCode).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('503s when git hosting is not configured, instead of pretending', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler({ ...deps, gitHostClient: undefined }, '/repos', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { name: 'api' } }), res);

    expect(res.statusCode).toBe(503);
  });
});

describe('POST /repos/:name/protect', () => {
  const createRepo = async (deps: Partial<RouteDeps>, token: string, body: unknown) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/repos', 'post')(mockRequest({ headers: authHeader(token), body }), res);
    expect(res.statusCode).toBe(201);
  };

  it('adds branches through the host and answers the full list', async () => {
    const { deps, token, fetchImpl } = await buildDeps();
    await createRepo(deps, token, { name: 'api' });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ branches: ['main', 'dev'] }),
    }));

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/protect', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api' }, body: { branches: ['dev'] } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ protectedBranches: ['main', 'dev'], requireChecks: false });
  });

  it('refuses a repo created --unprotected, without asking the host', async () => {
    const { deps, token, fetchImpl } = await buildDeps();
    await createRepo(deps, token, { name: 'scratch', protect: false });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockClear();

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/protect', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'scratch' }, body: { branches: ['main'] } }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('permanent');
    // The record already knows: the host must not even be asked.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--require-checks alone flips the flag without touching the host protection', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps();
    await createRepo(deps, token, { name: 'api' });

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/protect', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api' }, body: { requireChecks: true } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { requireChecks: boolean }).requireChecks).toBe(true);
    expect((await gitRepoStorage.getByName('user-1', 'api'))?.requireChecks).toBe(true);

    // Add-only: `false` is not a thing this route can say, so a later call
    // without the flag reports the standing truth rather than resetting it.
    const again = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/protect', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api' }, body: { branches: ['dev'], requireChecks: false } }),
      again,
    );
    expect((again.body as { requireChecks: boolean }).requireChecks).toBe(true);
    expect((await gitRepoStorage.getByName('user-1', 'api'))?.requireChecks).toBe(true);
  });

  it('rejects an invalid branch name before it reaches the host', async () => {
    const { deps, token, fetchImpl } = await buildDeps();
    await createRepo(deps, token, { name: 'api' });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockClear();

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/protect', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api' }, body: { branches: ['-bad'] } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /git/verify (the host asking mid-push)', () => {
  it('grants an anonymous read-only scope only for the exact public repository', async () => {
    const { deps, gitRepoStorage } = await buildDeps();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'open', createdByAgentId: 'agent-a', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: { id: 'public-1', publishedAt: '2026-09-25T00:00:00.000Z', publishedByUserId: 'owner' },
    });
    await gitRepoStorage.create({
      userId: 'user-1', name: 'private', createdByAgentId: 'agent-a', sizeBytes: 1, protectDefaultBranch: true,
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');

    const open = createMockResponse();
    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET, 'x-git-namespace': 'user-1' },
      body: { token: '', repo: 'open' },
    }), open);
    expect(open.body).toEqual({
      userId: 'user-1', agentId: 'public', scope: { repo: 'open', readOnly: true },
    });

    for (const body of [{ token: '', repo: 'private' }, { token: '', repo: 'open' }]) {
      const refused = createMockResponse();
      await handler(mockRequest({
        headers: {
          'x-git-host-secret': HOST_SECRET,
          ...(body.repo === 'private' ? { 'x-git-namespace': 'user-1' } : {}),
        },
        body,
      }), refused);
      expect(refused.statusCode).toBe(401);
    }
  });

  it('answers identity, and the quota the host needs to enforce', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 512, protectDefaultBranch: true,
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token } }), res);

    expect(res.body).toEqual({
      userId: 'user-1',
      agentId: 'agent-a',
      quota: {
        repoMaxBytes: expect.any(Number),
        userMaxBytes: GIT_USER_MAX_BYTES,
        userUsedBytes: 512,
      },
    });
  });

  // Note #716: the event turn's fence reaches git. While the Workspace Agent
  // runs a turn nobody asked for, its token reads and never pushes; outside
  // one, or for any other agent, the answer is unchanged.
  it('answers the Workspace Agent read-only while an event turn runs', async () => {
    const { deps, token } = await buildDeps();
    const wa = mintAgentbuiltToken('user-1', 'workspace-1');
    const profile = (await deps.userStorage!.getProfile('user-1'))!;
    await deps.userStorage!.updateProfile('user-1', { telegram: { ...profile.telegram!, agents: { ...profile.telegram!.agents, 'workspace-1': { id: 'workspace-1', name: 'Workspace Agent', cli: 'claude', purpose: 'workspace-recap', orgId: 'org-1', agentbuiltTokenHash: wa.tokenHash } as never } } });
    const isEventTurn = vi.fn(async () => true);
    deps.workspaceAgent = { isEventTurn } as never;
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const during = createMockResponse();
    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: wa.token } }), during);
    expect(during.body).toMatchObject({ agentId: 'workspace-1', scope: { readOnly: true } });
    expect(isEventTurn).toHaveBeenCalledWith('user-1', 'org-1');
    isEventTurn.mockResolvedValue(false);
    const after = createMockResponse();
    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: wa.token } }), after);
    expect((after.body as { scope?: unknown }).scope).toBeUndefined();
    isEventTurn.mockResolvedValue(true);
    const roomAgent = createMockResponse();
    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token } }), roomAgent);
    expect((roomAgent.body as { scope?: unknown }).scope).toBeUndefined();
  });

  // Note #62. The host names the org it IS (`x-git-host-org`), which is the
  // only question the ceiling turns on: which disk these bytes land on. The
  // same push against the shared box keeps the fair share.
  it('hands an org host the ceiling of the volume that org pays for', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps({ orgVolumeGb: 40, agentOrgId: 'org-7' });
    await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 512,
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-git-host-secret': ORG_HOST_SECRET, 'x-git-host-org': 'org-7' },
      body: { token },
    }), res);

    const quota = (res.body as { quota: { userMaxBytes: number } }).quota;
    expect(quota.userMaxBytes).toBe(gitUserMaxBytesForVolume(40));
    // The number that used to come back here regardless of the disk.
    expect(quota.userMaxBytes).not.toBe(GIT_USER_MAX_BYTES);
  });

  it('keeps the fair share for a push landing on the shared box', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps({ orgVolumeGb: 40 });
    await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 512,
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    // No `x-git-host-org`: the central host does not set one, and that is
    // exactly how the backend knows the bytes are landing on a shared disk.
    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { token },
    }), res);

    expect((res.body as { quota: { userMaxBytes: number } }).quota.userMaxBytes)
      .toBe(GIT_USER_MAX_BYTES);
  });

  it('refuses a caller without the host secret, whatever token it presents', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/git/verify', 'post');

    const noSecret = createMockResponse();
    await handler(mockRequest({ body: { token } }), noSecret);
    expect(noSecret.statusCode).toBe(401);

    const wrongSecret = createMockResponse();
    await handler(mockRequest({ headers: { 'x-git-host-secret': 'nope' }, body: { token } }), wrongSecret);
    expect(wrongSecret.statusCode).toBe(401);
  });

  it('refuses a token whose hash no longer matches (rotation revokes immediately)', async () => {
    const { deps } = await buildDeps();
    const { token: stale } = mintAgentbuiltToken('user-1', 'agent-a');
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: stale } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('fails closed when the backend has no host secret configured', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler({ ...deps, gitHostSecret: undefined }, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token } }), res);

    expect(res.statusCode).toBe(503);
  });

  it('accepts the owner\'s laptop key: same namespace and quota, agentId "owner"', async () => {
    const { deps, gitRepoStorage } = await buildDeps();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 256, protectDefaultBranch: true,
    });
    const { token: human, tokenHash } = mintHumanGitToken('user-1');
    await deps.userStorage!.updateProfile('user-1', {
      gitAccess: { tokenHash, createdAt: '2026-08-13T00:00:00Z' },
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: human } }), res);

    expect(res.body).toEqual({
      userId: 'user-1',
      agentId: 'owner',
      quota: {
        repoMaxBytes: expect.any(Number),
        userMaxBytes: GIT_USER_MAX_BYTES,
        userUsedBytes: 256,
      },
    });
  });

  it('refuses a laptop key after re-minting replaced its hash — rotation revokes immediately', async () => {
    const { deps } = await buildDeps();
    const { token: stale } = mintHumanGitToken('user-1');
    const { tokenHash: freshHash } = mintHumanGitToken('user-1');
    await deps.userStorage!.updateProfile('user-1', {
      gitAccess: { tokenHash: freshHash, createdAt: '2026-08-13T00:00:00Z' },
    });
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: stale } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('refuses a laptop key when the user has none at all', async () => {
    const { deps } = await buildDeps();
    const { token: human } = mintHumanGitToken('user-1');
    const handler = getRouteHandler(deps, '/git/verify', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: { 'x-git-host-secret': HOST_SECRET }, body: { token: human } }), res);

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /git/pushed', () => {
  it('re-pins every open proposal on the repo to what its branch holds now', async () => {
    const { deps, token, fetchImpl } = await buildDeps();
    const prs = new InMemoryGitPullRequestStorage();
    (deps as { gitPullRequestStorage?: unknown }).gitPullRequestStorage = prs;
    const repoRes = createMockResponse();
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(token), body: { name: 'api' } }), repoRes,
    );
    const repo = (await (deps.gitRepoStorage as InMemoryGitRepoStorage).getByName('user-1', 'api'))!;
    const open = await prs.create({
      repoId: repo.id, userId: 'user-1', title: 'Rewrite checkout',
      sourceBranch: 'feat/x', targetBranch: 'main',
      headSha: 'a'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0 },
      commitSubjects: ['first'], createdByAgentId: 'agent-a', status: 'open',
    });
    const decided = await prs.create({
      repoId: repo.id, userId: 'user-1', title: 'Old work',
      sourceBranch: 'feat/y', targetBranch: 'main',
      headSha: 'e'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0 },
      commitSubjects: ['old'], createdByAgentId: 'agent-a', status: 'merged',
    });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        headSha: 'b'.repeat(40), baseSha: 'd'.repeat(40), baseExists: true,
        diffStat: { files: 2, insertions: 9, deletions: 3 },
        commits: [{ sha: 'b'.repeat(40), subject: 'second' }, { sha: 'a'.repeat(40), subject: 'first' }],
        patch: '', patchTruncated: false,
      }),
    }));

    await getRouteHandler(deps, '/git/pushed', 'post')(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'api', sizeBytes: 1 },
    }), createMockResponse());

    const refreshed = await prs.get(open.id);
    // The pin, the stats and the card's subjects all describe the branch NOW.
    expect(refreshed?.headSha).toBe('b'.repeat(40));
    expect(refreshed?.diffStat).toEqual({ files: 2, insertions: 9, deletions: 3 });
    expect(refreshed?.commitSubjects).toEqual(['second', 'first']);
    expect(refreshed?.refreshedAt).toBeTruthy();
    // A decided proposal is a record of what happened — never re-pinned.
    expect((await prs.get(decided.id))?.headSha).toBe('e'.repeat(40));
  });

  it('a failed compare leaves the proposal pin exactly as it was', async () => {
    const { deps, token, fetchImpl } = await buildDeps();
    const prs = new InMemoryGitPullRequestStorage();
    (deps as { gitPullRequestStorage?: unknown }).gitPullRequestStorage = prs;
    await getRouteHandler(deps, '/repos', 'post')(
      mockRequest({ headers: authHeader(token), body: { name: 'api' } }), createMockResponse(),
    );
    const repo = (await (deps.gitRepoStorage as InMemoryGitRepoStorage).getByName('user-1', 'api'))!;
    const open = await prs.create({
      repoId: repo.id, userId: 'user-1', title: 'Rewrite checkout',
      sourceBranch: 'feat/x', targetBranch: 'main',
      headSha: 'a'.repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0 },
      commitSubjects: ['first'], createdByAgentId: 'agent-a', status: 'open',
    });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: false, status: 409, text: async () => 'no such branch',
    }));

    const res = createMockResponse();
    await getRouteHandler(deps, '/git/pushed', 'post')(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'api', sizeBytes: 1 },
    }), res);

    // The report itself still lands — the refresh is a rider, never the ride.
    expect(res.statusCode).toBe(200);
    const untouched = await prs.get(open.id);
    expect(untouched?.headSha).toBe('a'.repeat(40));
    expect(untouched?.refreshedAt).toBeUndefined();
  });

  it('records size, branch and push time', async () => {
    const { deps, gitRepoStorage } = await buildDeps();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
    });
    const handler = getRouteHandler(deps, '/git/pushed', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'api', sizeBytes: 4096, defaultBranch: 'master' },
    }), res);

    const updated = await gitRepoStorage.get(doc.id);
    expect(updated?.sizeBytes).toBe(4096);
    // Recorded, not assumed: a CLI that inits `master` must be protectable.
    expect(updated?.defaultBranch).toBe('master');
    expect(updated?.lastPushAt).toBeTruthy();
  });

  it('stamps a home-branch landing only on observed facts, never a guess', async () => {
    const { deps, gitRepoStorage } = await buildDeps();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
    });
    const handler = getRouteHandler(deps, '/git/pushed', 'post');
    const report = (body: Record<string, unknown>) => handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'api', sizeBytes: 1, defaultBranch: 'main', ...body },
    }), createMockResponse());

    // The very first push created the branch: that IS a landing.
    await report({ defaultBranchTip: 'a'.repeat(40) });
    const first = await gitRepoStorage.get(doc.id);
    expect(first?.defaultBranchPushAt).toBeTruthy();
    expect(first?.defaultBranchTipSha).toBe('a'.repeat(40));

    // A feature-branch push: tip unchanged → the stamp must not move. (The
    // pauses keep each report in its own millisecond, so "same stamp" and
    // "new stamp" are distinguishable strings.)
    const stamp = first!.defaultBranchPushAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await report({ defaultBranchTip: 'a'.repeat(40) });
    const second = await gitRepoStorage.get(doc.id);
    expect(second?.defaultBranchPushAt).toBe(stamp);
    expect(second?.lastPushAt).toBeTruthy();

    // The tip moved → a real landing, stamped.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await report({ defaultBranchTip: 'b'.repeat(40) });
    const third = await gitRepoStorage.get(doc.id);
    expect(third?.defaultBranchTipSha).toBe('b'.repeat(40));
    expect(third?.defaultBranchPushAt).not.toBe(stamp);
  });

  it('a pre-existing repo gets its tip recorded without a stamp — the branch may not have moved', async () => {
    const { deps, gitRepoStorage } = await buildDeps();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
    });
    // The repo has push history from before tips were reported…
    await gitRepoStorage.update(doc.id, { lastPushAt: '2026-08-01T00:00:00.000Z' });
    const handler = getRouteHandler(deps, '/git/pushed', 'post');
    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: {
        userId: 'user-1', name: 'api', sizeBytes: 1, defaultBranch: 'main',
        defaultBranchTip: 'c'.repeat(40),
      },
    }), createMockResponse());
    const updated = await gitRepoStorage.get(doc.id);
    // …so this push proves nothing about the home branch: sha noted, no stamp.
    expect(updated?.defaultBranchTipSha).toBe('c'.repeat(40));
    expect(updated?.defaultBranchPushAt).toBeUndefined();

    // An old host that reports no tip changes nothing about the branch.
    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'api', sizeBytes: 1, defaultBranch: 'main' },
    }), createMockResponse());
    const after = await gitRepoStorage.get(doc.id);
    expect(after?.defaultBranchTipSha).toBe('c'.repeat(40));
    expect(after?.defaultBranchPushAt).toBeUndefined();
  });

  it('accepts a push to a repo with no record rather than failing it', async () => {
    const { deps } = await buildDeps();
    const handler = getRouteHandler(deps, '/git/pushed', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-git-host-secret': HOST_SECRET },
      body: { userId: 'user-1', name: 'ghost', sizeBytes: 10 },
    }), res);

    expect(res.body).toEqual({ ok: true, recorded: false });
  });
});

describe('GitHostClient', () => {
  it('builds clone URLs that survive odd ids and names', () => {
    const client = new GitHostClient({
      baseUrl: 'https://git.example.test/', controlUrl: 'http://x', secret: 's',
    });
    expect(client.cloneUrl('user-1', 'api')).toBe('https://git.example.test/user-1/api.git');
    expect(client.cloneUrl('u/1', 'a b')).toBe('https://git.example.test/u%2F1/a%20b.git');
  });

  it('surfaces a host failure as an error the route can report', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'disk full',
    } as Response)) as unknown as typeof fetch;
    const client = new GitHostClient({
      baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's', fetchImpl,
    });
    await expect(client.createRepo('u1', 'api')).rejects.toThrow(/disk full/);
  });
});

describe('agent-cli repo checks', () => {
  const SHA = 'a'.repeat(40);

  const withStatuses = async () => {
    const built = await buildDeps();
    const repo = await built.gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0,
      protectDefaultBranch: true, ci: true,
    });
    const statuses = new InMemoryGitCommitStatusStorage();
    return {
      ...built,
      repo,
      statuses,
      deps: { ...built.deps, gitCommitStatusStorage: statuses } as Partial<RouteDeps>,
    };
  };

  const call = async (deps: Partial<RouteDeps>, token: string, query: Record<string, string>) => {
    const handler = getRouteHandler(deps, '/repos/:name/checks', 'get');
    const res = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), params: { name: 'api' }, query }), res);
    return res;
  };

  it('reports a settled green build, so the agent knows it may propose', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'success', description: 'all good',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ci: true, sha: SHA, settled: true });
    expect((res.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  // The whole point of the verb: `--wait` must keep waiting here, because
  // proposing now is exactly the bad card this change exists to prevent.
  it('is unsettled while any check is still pending', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'success', description: 'done', startedAt: new Date().toISOString(),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'deploy/prod',
      state: 'pending', description: 'running', startedAt: new Date().toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: false });
  });

  // A daemon that died mid-job leaves its pending forever. Waiting on that
  // would burn the agent's whole turn, so it reads as failed like everywhere else.
  it('reads a long-stranded pending as an error rather than as still running', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'pending', description: 'running',
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: true });
    expect((res.body as { runs: Array<{ state: string }> }).runs[0]!.state).toBe('error');
    // Settled: nothing to wait for, so no horizon is offered.
    expect(res.body).not.toHaveProperty('settlesWithinSeconds');
  });

  // The mirror job files and finishes in seconds; CI's own pending arrives
  // after it. In that gap every run on the list was terminal and the sha
  // read settled — `--wait` returned green on a suite that had not started
  // (2026-09-06, 2026-09-17). CI on means ci/checks is coming: wait for it.
  it('is not settled while CI is on and ci/checks has not been filed, whatever else has finished', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'deploy/mirror-github',
      state: 'success', description: 'Passed in 0.1m',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: false, awaitingContexts: ['ci/checks'] });
    const seconds = (res.body as { settlesWithinSeconds: number }).settlesWithinSeconds;
    expect(seconds).toBeGreaterThanOrEqual(30 * 60 - 5);
    expect(seconds).toBeLessThanOrEqual(30 * 60);
  });

  it('is settled on a repo without CI once whatever ran has finished', async () => {
    const { deps, token, gitRepoStorage, statuses } = await withStatuses();
    const quiet = await gitRepoStorage.create({
      userId: 'user-1', name: 'notes', createdByAgentId: 'agent-a', sizeBytes: 0,
      protectDefaultBranch: true,
    });
    await statuses.upsert({
      userId: 'user-1', repoId: quiet.id, sha: SHA, context: 'deploy/mirror-github',
      state: 'success', description: 'Passed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    const handler = getRouteHandler(deps, '/repos/:name/checks', 'get');
    const res = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), params: { name: 'notes' }, query: { sha: SHA } }), res);
    expect(res.body).toMatchObject({ ci: false, settled: true });
    expect(res.body).not.toHaveProperty('awaitingContexts');
  });

  // The CLI's wait used to stop at a fixed ten minutes on a suite that takes
  // eleven (note #549). The bound belongs to the host: a pending READS as an
  // error once it is older than the stale window, so the sha is guaranteed
  // to settle by then, and the route says exactly how long that is.
  it('says how many seconds until a pending check is guaranteed to read settled', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'pending', description: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    // A second pending, filed later: the LATEST pending decides the horizon.
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'deploy/prod',
      state: 'pending', description: 'running',
      startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: false });
    const seconds = (res.body as { settlesWithinSeconds: number }).settlesWithinSeconds;
    // 30-minute window minus the 2 minutes the newest pending has run.
    expect(seconds).toBeGreaterThanOrEqual(28 * 60 - 5);
    expect(seconds).toBeLessThanOrEqual(28 * 60);
  });

  it('counts the horizon from now for a known sha the runner has not filed on yet', async () => {
    const { deps, token } = await withStatuses();
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).toMatchObject({ runs: [], commitKnown: true });
    const seconds = (res.body as { settlesWithinSeconds: number }).settlesWithinSeconds;
    expect(seconds).toBeGreaterThanOrEqual(30 * 60 - 5);
    expect(seconds).toBeLessThanOrEqual(30 * 60);
  });

  it('offers no horizon for a sha the host has never seen — nothing will ever settle it', async () => {
    const { deps, token, fetchImpl } = await withStatuses();
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      ok: false, status: 404, text: async () => '{"error":"no such commit"}',
    }) as Response);
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).toMatchObject({ commitKnown: false });
    expect(res.body).not.toHaveProperty('settlesWithinSeconds');
  });

  // "The last run took 11 minutes" is the line an agent reads before going
  // quiet for that long — and the number it picks its own bound from. The
  // SLOWEST of this sha's contexts decides when the whole sha settles, so
  // that is the length reported; terminal states that never ran (skipped,
  // superseded) carry no length and are passed over.
  it('reports the last finished run of the slowest of this sha\'s checks', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    const older = 'b'.repeat(40);
    const t0 = Date.now() - 60 * 60_000;
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: older, context: 'ci/checks',
      state: 'success', description: 'done',
      startedAt: new Date(t0).toISOString(), completedAt: new Date(t0 + 648_000).toISOString(),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: older, context: 'deploy/prod',
      state: 'success', description: 'done',
      startedAt: new Date(t0).toISOString(), completedAt: new Date(t0 + 180_000).toISOString(),
    });
    // An even older, longer run of a context this sha does NOT have: not its
    // business.
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'c'.repeat(40), context: 'deploy/site',
      state: 'success', description: 'done',
      startedAt: new Date(t0 - 3_600_000).toISOString(), completedAt: new Date(t0 - 3_600_000 + 2_000_000).toISOString(),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'pending', description: 'running', startedAt: new Date().toISOString(),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'deploy/prod',
      state: 'superseded', description: 'Superseded by a newer commit.', startedAt: new Date().toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: false, lastRunSeconds: 648 });
  });

  it('carries no last-run length when nothing of these checks has ever finished', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'pending', description: 'running', startedAt: new Date().toISOString(),
    });
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).not.toHaveProperty('lastRunSeconds');
  });

  // "No runs" and "CI is off" are the same empty list and opposite orders:
  // wait for a verdict that is coming, versus never wait at all.
  it('says CI is off, so the agent proposes immediately instead of waiting', async () => {
    const { deps, token, gitRepoStorage } = await withStatuses();
    const quiet = await gitRepoStorage.create({
      userId: 'user-1', name: 'notes', createdByAgentId: 'agent-a', sizeBytes: 0,
      protectDefaultBranch: true,
    });
    expect(quiet.ci).toBeFalsy();
    const handler = getRouteHandler(deps, '/repos/:name/checks', 'get');
    const res = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'notes' }, query: {},
    }), res);

    expect(res.body).toMatchObject({ ci: false, runs: [] });
  });

  // A sha with no statuses is either "runner hasn't filed yet" (wait) or
  // "this commit never reached the host" (waiting is ten silent minutes for
  // a verdict that cannot come — the swallowed-rejected-push shape). The
  // route asks the host which, exactly once, only in the empty case.
  it('answers commitKnown:false for a sha the host has never seen, so --wait stops immediately', async () => {
    const { deps, token, fetchImpl } = await withStatuses();
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      ok: false, status: 404, text: async () => '{"error":"no such commit"}',
    }) as Response);
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).toMatchObject({ ci: true, runs: [], commitKnown: false, settled: false });
  });

  it('answers commitKnown:true for a known sha the runner has not reported on yet', async () => {
    const { deps, token } = await withStatuses();
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).toMatchObject({ runs: [], commitKnown: true });
  });

  it('stays silent about commitKnown when the host cannot be asked — a sleepy machine must not read as a lost push', async () => {
    const { deps, token, fetchImpl } = await withStatuses();
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('connect timeout');
    });
    const res = await call(deps, token, { sha: SHA });
    expect(res.body).toMatchObject({ runs: [] });
    expect(res.body).not.toHaveProperty('commitKnown');
  });

  it('never asks the host once any run exists', async () => {
    const { deps, token, repo, statuses, fetchImpl } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'success', description: 'done',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockClear();
    const res = await call(deps, token, { sha: SHA });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('commitKnown');
  });

  // The agent's gate asks "did MY build break". A job dropped because a newer
  // commit replaced it did not break — so it settles, and the CLI does not
  // read it as a red. (The merge gate answers a different question and still
  // blocks on it; see git-prs.test.ts.)
  it('returns superseded as its own settled state, not as a failure', async () => {
    const { deps, token, repo, statuses } = await withStatuses();
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: SHA, context: 'ci/checks',
      state: 'superseded', description: 'Superseded by a newer commit before running.',
      startedAt: new Date().toISOString(),
    });

    const res = await call(deps, token, { sha: SHA });

    expect(res.body).toMatchObject({ settled: true });
    const runs = (res.body as { runs: Array<{ state: string }> }).runs;
    expect(runs[0]!.state).toBe('superseded');
  });

  it('rejects a malformed sha instead of scanning for it', async () => {
    const { deps, token } = await withStatuses();
    const res = await call(deps, token, { sha: 'not-a-sha' });
    expect(res.statusCode).toBe(400);
  });

  it('does not read a repo the token does not own', async () => {
    const { deps, token, gitRepoStorage } = await withStatuses();
    await gitRepoStorage.create({
      userId: 'user-2', name: 'secrets', createdByAgentId: 'agent-z', sizeBytes: 0,
      protectDefaultBranch: true, ci: true,
    });
    const handler = getRouteHandler(deps, '/repos/:name/checks', 'get');
    const res = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'secrets' }, query: {},
    }), res);

    expect(res.statusCode).toBe(404);
  });
});
