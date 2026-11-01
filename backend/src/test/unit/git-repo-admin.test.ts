import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteGitRepoStorage } from '../../services/sqlite/sqlite-git-repo-storage.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { deleteRepoNow } from '../../services/git-repo-admin.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';

/**
 * Slice 5, the admin surface (docs/agent-git-project-repos.md): delete,
 * restore, rename, show — as an AGENT sees it. The property every test in the
 * delete block defends is a negative one: there is no agent-reachable route
 * that removes a repo. `repo delete` records a request and stops; the owner
 * deletes it in the workspace (workspace-router.test.ts covers that
 * side), and the bytes wait in the host's trash either way.
 */

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}

function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post',
): (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
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

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Every control call the host receives, so a test can assert what did NOT
 *  happen — the point of the ask path is that no bytes move. */
type HostCall = { path: string; body: Record<string, unknown> };

function hostClient(calls: HostCall[], opts: { deleteFails?: boolean; restoreFails?: boolean; renameFails?: boolean } = {}) {
  return new GitHostClient({
    baseUrl: 'https://git.example.test',
    controlUrl: 'http://host.test',
    secret: 's',
    fetchImpl: (async (url: string, init?: { body?: string }) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      calls.push({ path, body });
      if (path === '/internal/repos/delete') {
        if (opts.deleteFails) return { ok: false, status: 500, text: async () => '{"error":"disk down"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ deleted: true, trashedAs: `${body.name}.20260813T041500Z.git` }) };
      }
      if (path === '/internal/repos/restore') {
        if (opts.restoreFails) return { ok: false, status: 409, text: async () => '{"error":"that repo is no longer in the trash"}' };
        return { ok: true, status: 200, text: async () => '{"restored":true}' };
      }
      if (path === '/internal/repos/rename') {
        if (opts.renameFails) return { ok: false, status: 409, text: async () => '{"error":"a repo named \\"taken\\" already exists"}' };
        return { ok: true, status: 200, text: async () => '{"renamed":true}' };
      }
      if (path === '/internal/repos/stat') {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          exists: true, sizeBytes: 4096, defaultBranch: 'main', protectedBranches: ['main'], ci: true,
        }) };
      }
      throw new Error(`unexpected host call: ${path}`);
    }) as unknown as typeof fetch,
  });
}

async function buildDeps(opts: { deleteFails?: boolean; restoreFails?: boolean; renameFails?: boolean } = {}) {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: { 'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
    },
  });
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const site = await gitRepoStorage.create({
    userId: 'user-1', name: 'site', createdByAgentId: 'agent-a', sizeBytes: 2048, protectDefaultBranch: true,
  });
  const scratch = await gitRepoStorage.create({
    userId: 'user-1', name: 'scratch', createdByAgentId: 'agent-a', sizeBytes: 512, protectDefaultBranch: false,
  });
  const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
  const calls: HostCall[] = [];
  const deps: Partial<RouteDeps> = {
    userStorage,
    gitRepoStorage,
    gitPullRequestStorage,
    gitHostClient: hostClient(calls, opts),
  };
  return { deps, token, site, scratch, gitRepoStorage, gitPullRequestStorage, calls };
}

describe('POST /repos/:name/delete — an agent can ask, and that is all', () => {
  const ask = async (deps: Partial<RouteDeps>, token: string, name: string) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/delete', 'post')(
      mockRequest({ headers: authHeader(token), params: { name }, body: {} }), res,
    );
    return res;
  };

  it('a protected repo is flagged for the workspace — no bytes move', async () => {
    const { deps, token, site, gitRepoStorage, calls } = await buildDeps();

    const res = await ask(deps, token, 'site');

    expect(res.statusCode).toBe(202);
    expect(calls).toHaveLength(0);
    const after = await gitRepoStorage.get(site.id);
    expect(after?.deletedAt).toBeUndefined();
    expect(after?.deleteAsk?.byAgentId).toBe('agent-a');
    // Still a repo in every sense: pushes, proposals and the quota are
    // untouched by an ask.
    expect(await gitRepoStorage.getByName('user-1', 'site')).not.toBeNull();
    expect(await gitRepoStorage.totalBytesForUser('user-1')).toBe(2560);
  });

  it('an --unprotected repo is flagged too — protection does not buy an agent a delete', async () => {
    const { deps, token, scratch, gitRepoStorage, calls } = await buildDeps();

    const res = await ask(deps, token, 'scratch');

    expect(res.statusCode).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await gitRepoStorage.get(scratch.id))?.deletedAt).toBeUndefined();
    expect((await gitRepoStorage.get(scratch.id))?.deleteAsk?.byAgentId).toBe('agent-a');
  });

  it('tells the agent that nothing will notify its user', async () => {
    const { deps, token } = await buildDeps();

    const res = await ask(deps, token, 'site');

    // The one thing an agent must not assume here: that asking is telling.
    const message = String((res.body as { message: string }).message);
    expect(message).toContain('workspace');
    expect(message).toMatch(/TELL THEM|tell them/);
  });

  it('a second ask replaces the first — newest wins, one at a time', async () => {
    const { deps, token, site, gitRepoStorage } = await buildDeps();

    await ask(deps, token, 'site');
    const first = (await gitRepoStorage.get(site.id))?.deleteAsk?.at;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ask(deps, token, 'site');

    const second = (await gitRepoStorage.get(site.id))?.deleteAsk?.at;
    expect(second).not.toBe(first);
  });

  it('404s for a repo this account does not have', async () => {
    const { deps, token } = await buildDeps();
    const res = await ask(deps, token, 'nope');
    expect(res.statusCode).toBe(404);
  });

  it('no route on the agent surface removes a repo', () => {
    // The absence is the feature — like the missing `pr approve` — so it is
    // asserted rather than assumed. Every DELETE here is something
    // recreatable in one command: a secret the agent holds, a quick note it
    // jotted, a file on a note (`note detach`, added 2026-08-17 with
    // attachments — same footing as the note itself, which any agent may
    // already delete whole), and a file on a PROPOSAL (`pr detach`, added
    // 2026-08-18 with notes #10/#18).
    //
    // That last one is the first DELETE under /repos, and it is worth saying
    // exactly why it does not breach the rule this test exists for. What it
    // removes is a picture the agent itself attached to its own ask — not a
    // repo, not a branch, not a commit, not a proposal. Re-attaching it is one
    // command. The rule is that nothing agent-facing destroys the WORK or the
    // gate around it, and a screenshot is neither; the assertion below keeps
    // the shape of that by naming what /repos is allowed to delete rather
    // than forbidding the prefix outright.
    //
    // A new entry in either list is a decision, not a detail.
    const router = agentCliRoutes({} as RouteDeps) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const routes = router.stack.map((layer) => layer.route).filter(Boolean);
    const deletes = routes.filter((route) => route!.methods.delete).map((route) => route!.path);
    // `DELETE /notes/:number/archive` is the odd one in this list and reads
    // like a third note delete; it is the RESTORE verb — DELETE on "the fact
    // that this note is archived", which puts the note back. It destroys
    // nothing. And its neighbour `/notes/:number` stopped destroying too:
    // since note #23 a plain DELETE archives, and only `?forever=1` on an
    // already-archived note really deletes.
    // `/deployments/:name/domains/:hostname` removes a custom-domain
    // CERTIFICATE, not the site: the site keeps serving on its
    // agentbuilt.app address, and re-adding the domain reprints the same
    // CNAME instruction — reversible in one command, so it stays an agent
    // verb where deleting the site itself never is.
    // `/agents/messages/:id` withdraws a message the agent ITSELF queued for
    // a working sibling and that has not been delivered yet (note #267,
    // `agentbuilt agent cancel`). Only the sender may, it removes nothing
    // but its own undelivered words, and sending again is one command.
    // `/drive/uploads/:id` and `/notes/:number/files/uploads/:id` cancel a
    // big file's UNFINISHED upload (note #784): they throw away parts the
    // agent itself sent and nothing was ever made of — no file exists until
    // an upload completes — so cancelling removes nothing anybody had.
    expect(deletes).toEqual([
      '/drive/uploads/:id',
      '/deployments/:name/domains/:hostname',
      '/repos/:name/prs/:number/files/:file',
      '/notes/:number/claim', '/notes/:number/archive', '/notes/:number',
      '/notes/:number/files/uploads/:id',
      '/notes/:number/files/:name', '/secrets/:name',
      '/agents/messages/:id',
    ]);
    // Under /repos, a file on a proposal and nothing else: no repo, no branch,
    // no proposal, no commit.
    expect(deletes.filter((path) => path.startsWith('/repos')))
      .toEqual(['/repos/:name/prs/:number/files/:file']);
  });
});

describe('POST /repos/:name/restore — the undo IS an agent verb', () => {
  /** Delete the way the workspace does — the one shared path — then hand the
   *  test an account with something in its trash. */
  const deleteThen = async (opts: Parameters<typeof buildDeps>[0] = {}) => {
    const built = await buildDeps(opts);
    const repo = (await built.gitRepoStorage.getByName('user-1', 'scratch'))!;
    await deleteRepoNow(repo, null, {
      repos: built.gitRepoStorage,
      host: built.deps.gitHostClient!,
      prs: built.gitPullRequestStorage,
    });
    built.calls.length = 0;
    return built;
  };

  it('names the exact trash entry back, and the record is live again', async () => {
    const { deps, token, scratch, gitRepoStorage, calls } = await deleteThen();
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/restore', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'scratch' }, body: {} }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(calls[0]?.path).toBe('/internal/repos/restore');
    expect(calls[0]?.body.trashedAs).toBe('scratch.20260813T041500Z.git');
    const after = await gitRepoStorage.get(scratch.id);
    expect(after?.deletedAt).toBeUndefined();
    expect(after?.trashedAs).toBeUndefined();
    expect(await gitRepoStorage.getByName('user-1', 'scratch')).not.toBeNull();
    expect(await gitRepoStorage.listTrashedByUser('user-1')).toEqual([]);
  });

  it('refuses when a new repo has taken the name', async () => {
    const { deps, token, gitRepoStorage } = await deleteThen();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'scratch', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
    });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/restore', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'scratch' }, body: {} }), res,
    );

    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain('rename');
  });

  it('hands the host\'s "the window ran out" answer to the agent, and keeps the tombstone', async () => {
    const { deps, token, scratch, gitRepoStorage } = await deleteThen({ restoreFails: true });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/restore', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'scratch' }, body: {} }), res,
    );

    expect(res.statusCode).toBe(409);
    expect((await gitRepoStorage.get(scratch.id))?.deletedAt).toBeTruthy();
  });

  it('404s for a name that was never deleted', async () => {
    const { deps, token } = await buildDeps();
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/restore', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' }, body: {} }), res,
    );

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /repos/:name/rename', () => {
  it('moves the directory first, then the record, and says the clone URL changed', async () => {
    const { deps, token, site, gitRepoStorage, calls } = await buildDeps();
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/rename', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' }, body: { newName: 'shop' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(calls[0]).toEqual({ path: '/internal/repos/rename', body: { userId: 'user-1', name: 'site', newName: 'shop' } });
    expect((await gitRepoStorage.get(site.id))?.name).toBe('shop');
    expect(await gitRepoStorage.getByName('user-1', 'site')).toBeNull();
    const body = res.body as { cloneUrl: string; message: string };
    expect(body.cloneUrl).toContain('/user-1/shop.git');
    expect(body.message).toContain('remote set-url');
  });

  it('refuses a name this account already uses, before the host is asked', async () => {
    const { deps, token, calls } = await buildDeps();
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/rename', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' }, body: { newName: 'scratch' } }), res,
    );

    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('refuses a name that would escape the namespace', async () => {
    const { deps, token, calls } = await buildDeps();
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/rename', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' }, body: { newName: '../etc' } }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('keeps the record when the host refuses the move', async () => {
    const { deps, token, site, gitRepoStorage } = await buildDeps({ renameFails: true });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name/rename', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' }, body: { newName: 'shop' } }), res,
    );

    expect(res.statusCode).toBe(502);
    expect((await gitRepoStorage.get(site.id))?.name).toBe('site');
  });
});

describe('GET /repos/:name — the settings surface', () => {
  it('answers protection and CI from the host, the rest from the record', async () => {
    const { deps, token, gitRepoStorage, site } = await buildDeps();
    await gitRepoStorage.update(site.id, { requireChecks: true, ciSecrets: ['CF_TOKEN'], ci: true });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name', 'get')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' } }), res,
    );

    expect(res.statusCode).toBe(200);
    const repo = (res.body as { repo: Record<string, unknown> }).repo;
    expect(repo.protectedBranches).toEqual(['main']);
    expect(repo.sizeBytes).toBe(4096);
    expect(repo.requireChecks).toBe(true);
    expect(repo.ciSecrets).toEqual(['CF_TOKEN']);
    expect(repo.defaultBranch).toBe('main');
  });

  it('answers protection from the HOST, never the default branch beside it', async () => {
    // The record's list-shaped `protectedBranch` is the default branch, which
    // is whichever branch has commits — `main` can be the protected one while
    // the default reads `proof`. Two keys disagreeing on one screen is the
    // bug this asserts away.
    const { deps, token, gitRepoStorage, site } = await buildDeps();
    await gitRepoStorage.update(site.id, { defaultBranch: 'proof' });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name', 'get')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' } }), res,
    );

    const repo = (res.body as { repo: Record<string, unknown> }).repo;
    expect(repo.protectedBranches).toEqual(['main']);
    expect(repo.defaultBranch).toBe('main');
    expect(repo).not.toHaveProperty('protectedBranch');
  });

  it('falls back to the record when the host says nothing, and says so', async () => {
    const { deps, token, gitRepoStorage, site } = await buildDeps();
    await gitRepoStorage.update(site.id, { defaultBranch: 'main' });
    (deps.gitHostClient as unknown as { statRepo: () => Promise<never> }).statRepo = async () => {
      throw new Error('host down');
    };
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name', 'get')(
      mockRequest({ headers: authHeader(token), params: { name: 'site' } }), res,
    );

    const body = res.body as { repo: Record<string, unknown>; note?: string };
    expect(body.repo.protectedBranches).toEqual(['main']);
    expect(body.note).toContain('last known');
  });

  it('a trashed repo is not a repo: show 404s like any other name', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps();
    await deleteRepoNow((await gitRepoStorage.getByName('user-1', 'scratch'))!, null, {
      repos: gitRepoStorage, host: deps.gitHostClient!,
    });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos/:name', 'get')(
      mockRequest({ headers: authHeader(token), params: { name: 'scratch' } }), res,
    );

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /repos — the trash is listed, not hidden', () => {
  it('shows deleted repos separately, with the day they stop being restorable', async () => {
    const { deps, token, gitRepoStorage } = await buildDeps();
    await deleteRepoNow((await gitRepoStorage.getByName('user-1', 'scratch'))!, null, {
      repos: gitRepoStorage, host: deps.gitHostClient!,
    });
    const res = createMockResponse();

    await getRouteHandler(deps, '/repos', 'get')(mockRequest({ headers: authHeader(token) }), res);

    const body = res.body as { repos: Array<{ name: string }>; trash: Array<{ name: string; restorableUntil: string }> };
    expect(body.repos.map((r) => r.name)).toEqual(['site']);
    expect(body.trash).toHaveLength(1);
    expect(body.trash[0]!.name).toBe('scratch');
    // 14 days, the same number maintain-repos.sh purges on.
    const days = (Date.parse(body.trash[0]!.restorableUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });
});

/**
 * The two storages are chosen by env at boot, so a divergence between them
 * only ever shows up in production. Tombstones are the newest place they
 * could disagree.
 */
describe('tombstones in SQLite match the in-memory contract', () => {
  let dir: string;
  let db: SqliteDb;
  let storage: SqliteGitRepoStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-admin-'));
    db = openSqliteDb(join(dir, 'test.db'));
    storage = new SqliteGitRepoStorage(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hides a deleted repo from every live answer and offers it in the trash', async () => {
    const repo = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 100, protectDefaultBranch: true,
    });
    await storage.update(repo.id, { deletedAt: '2026-08-13T00:00:00.000Z', trashedAs: 'api.20260813T000000Z.git' });

    expect(await storage.getByName('u1', 'api')).toBeNull();
    expect(await storage.listByUser('u1')).toEqual([]);
    expect(await storage.totalBytesForUser('u1')).toBe(0);
    expect((await storage.getTrashedByName('u1', 'api'))?.id).toBe(repo.id);
    expect((await storage.listTrashedByUser('u1')).map((r) => r.name)).toEqual(['api']);
    // And still addressable by id — the delete card holds one.
    expect((await storage.get(repo.id))?.deletedAt).toBeTruthy();
  });

  it('lets a new repo take a tombstoned name, and still refuses a live collision', async () => {
    const first = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 100, protectDefaultBranch: true,
    });
    await storage.update(first.id, { deletedAt: '2026-08-13T00:00:00.000Z' });

    const second = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a2', sizeBytes: 0, protectDefaultBranch: false,
    });
    expect(second.id).not.toBe(first.id);
    expect((await storage.getByName('u1', 'api'))?.id).toBe(second.id);

    await expect(storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a3', sizeBytes: 0, protectDefaultBranch: true,
    })).rejects.toThrow(/already exists/);
  });

  it('answers the NEWEST tombstone when a name was deleted twice', async () => {
    const older = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 1, protectDefaultBranch: true,
    });
    await storage.update(older.id, { deletedAt: '2026-08-01T00:00:00.000Z', trashedAs: 'api.20260801T000000Z.git' });
    const newer = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 2, protectDefaultBranch: true,
    });
    await storage.update(newer.id, { deletedAt: '2026-08-10T00:00:00.000Z', trashedAs: 'api.20260810T000000Z.git' });

    expect((await storage.getTrashedByName('u1', 'api'))?.id).toBe(newer.id);
    expect((await storage.listTrashedByUser('u1')).map((r) => r.trashedAs))
      .toEqual(['api.20260810T000000Z.git', 'api.20260801T000000Z.git']);
  });

  it('survives a reopen — a tombstone is on disk, not in the process', async () => {
    const repo = await storage.create({
      userId: 'u1', name: 'api', createdByAgentId: 'a1', sizeBytes: 5, protectDefaultBranch: true,
    });
    await storage.update(repo.id, { deletedAt: '2026-08-13T00:00:00.000Z', trashedAs: 'api.20260813T000000Z.git' });
    db.close();

    db = openSqliteDb(join(dir, 'test.db'));
    storage = new SqliteGitRepoStorage(db);
    expect(await storage.getByName('u1', 'api')).toBeNull();
    expect((await storage.getTrashedByName('u1', 'api'))?.trashedAs).toBe('api.20260813T000000Z.git');
  });
});
