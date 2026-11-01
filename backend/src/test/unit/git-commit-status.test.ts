import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteGitCommitStatusStorage } from '../../services/sqlite/sqlite-git-commit-status-storage.js';
import {
  InMemoryGitCommitStatusStorage,
  type GitCommitStatusStorage,
} from '../../services/git-commit-status-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import {
  effectiveStatusState,
  GIT_COMMIT_STATUS_NOT_PASSING,
  GIT_COMMIT_STATUS_STALE_PENDING_MS,
  worstCheckState,
} from '../../types/git-commit-status.js';

const SHA = 'a'.repeat(40);

function statusDoc(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    repoId: 'repo-1',
    sha: SHA,
    context: 'ci/checks',
    state: 'pending' as const,
    description: 'Running',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The storage contract, run against BOTH implementations (repo convention). */
function storageContract(name: string, make: () => GitCommitStatusStorage, cleanup?: () => void) {
  describe(`${name}`, () => {
    afterEach(() => cleanup?.());

    it('latest write wins for the same (repo, sha, context)', async () => {
      const storage = make();
      await storage.upsert(statusDoc());
      await storage.upsert(statusDoc({ state: 'success', description: 'Passed in 2.3m' }));
      const rows = await storage.listBySha('repo-1', SHA);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('success');
      expect(rows[0]!.description).toBe('Passed in 2.3m');
    });

    it('keeps contexts separate under one sha, ordered by name', async () => {
      const storage = make();
      await storage.upsert(statusDoc({ context: 'deploy/prod', state: 'skipped' }));
      await storage.upsert(statusDoc({ context: 'ci/checks', state: 'success' }));
      const rows = await storage.listBySha('repo-1', SHA);
      expect(rows.map((r) => r.context)).toEqual(['ci/checks', 'deploy/prod']);
    });

    it('listRecentByRepo returns the repo’s latest runs newest-first, capped, its own only', async () => {
      const storage = make();
      const [a, b, c] = ['a', 'b', 'c'].map((ch) => ch.repeat(40));
      await storage.upsert(statusDoc({ sha: a, startedAt: '2026-08-13T10:00:00.000Z' }));
      await storage.upsert(statusDoc({ sha: b, startedAt: '2026-08-13T12:00:00.000Z', state: 'success' }));
      await storage.upsert(statusDoc({ sha: c, context: 'deploy/prod', startedAt: '2026-08-13T11:00:00.000Z' }));
      // Another repo's run, newer than everything — it must not leak in.
      await storage.upsert(statusDoc({ repoId: 'repo-2', startedAt: '2026-08-13T13:00:00.000Z' }));
      const rows = await storage.listRecentByRepo('repo-1', 2);
      expect(rows.map((r) => r.sha)).toEqual([b, c]);
    });

    it('listByReposSince returns the month’s runs across repos, by start time, and nothing for no repos', async () => {
      const storage = make();
      const [a, b, c] = ['a', 'b', 'c'].map((ch) => ch.repeat(40));
      await storage.upsert(statusDoc({ sha: a, startedAt: '2026-08-31T23:59:59.000Z', state: 'success' }));
      await storage.upsert(statusDoc({ sha: b, startedAt: '2026-09-01T00:00:00.000Z', state: 'success' }));
      await storage.upsert(statusDoc({ repoId: 'repo-2', sha: c, startedAt: '2026-09-02T00:00:00.000Z' }));
      await storage.upsert(statusDoc({ repoId: 'repo-3', sha: c, startedAt: '2026-09-02T00:00:00.000Z' }));
      const rows = await storage.listByReposSince(['repo-1', 'repo-2'], '2026-09-01T00:00:00.000Z');
      expect(rows.map((r) => `${r.repoId}:${r.sha[0]}`).sort()).toEqual(['repo-1:b', 'repo-2:c']);
      expect(await storage.listByReposSince([], '2026-09-01T00:00:00.000Z')).toEqual([]);
    });

    it('keeps the machine shape a run was filed with', async () => {
      const storage = make();
      await storage.upsert(statusDoc({ machine: { cpuKind: 'performance', cpus: 4, memoryMb: 8192 } }));
      expect((await storage.get('repo-1', SHA, 'ci/checks'))!.machine).toEqual({ cpuKind: 'performance', cpus: 4, memoryMb: 8192 });
    });

    it('listByShas joins many commits and ignores unknown shas', async () => {
      const storage = make();
      const other = 'b'.repeat(40);
      await storage.upsert(statusDoc());
      await storage.upsert(statusDoc({ sha: other, state: 'failure' }));
      const rows = await storage.listByShas('repo-1', [SHA, other, 'c'.repeat(40)]);
      expect(rows).toHaveLength(2);
      expect(await storage.listByShas('repo-1', [])).toEqual([]);
    });
  });
}

storageContract('InMemoryGitCommitStatusStorage', () => new InMemoryGitCommitStatusStorage());

{
  let dir: string;
  let db: SqliteDb;
  storageContract(
    'SqliteGitCommitStatusStorage',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'git-statuses-'));
      db = openSqliteDb(join(dir, 'test.db'));
      return new SqliteGitCommitStatusStorage(db);
    },
    () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );
}

describe('effectiveStatusState', () => {
  it('a fresh pending is pending; a stale one reads as error; terminals pass through', () => {
    const now = new Date('2026-08-11T12:00:00Z');
    const fresh = { state: 'pending' as const, startedAt: '2026-08-11T11:50:00Z' };
    const stale = { state: 'pending' as const, startedAt: '2026-08-11T11:20:00Z' };
    const done = { state: 'success' as const, startedAt: '2026-08-11T10:00:00Z' };
    expect(effectiveStatusState(fresh, now)).toBe('pending');
    expect(effectiveStatusState(stale, now)).toBe('error');
    expect(effectiveStatusState(done, now)).toBe('success');
  });
});

// ── The ingest route ──

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

function ingestHandler(deps: Partial<RouteDeps>) {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === '/git/statuses' && c.route.methods.post);
  if (!layer?.route) throw new Error('No post /git/statuses route');
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function ingestRequest(body: Record<string, unknown>, secret = 'ci-secret'): Partial<Request> {
  return {
    get: ((name: string) => (name.toLowerCase() === 'x-ci-status-secret' ? secret : undefined)) as Request['get'],
    params: {},
    query: {},
    body,
  };
}

describe('POST /git/statuses (CI ingest)', () => {
  let statusStorage: InMemoryGitCommitStatusStorage;
  let repoStorage: InMemoryGitRepoStorage;
  let repoId: string;
  let handler: ReturnType<typeof ingestHandler>;

  beforeEach(async () => {
    statusStorage = new InMemoryGitCommitStatusStorage();
    repoStorage = new InMemoryGitRepoStorage();
    const repo = await repoStorage.create({
      userId: 'user-1', name: 'site', sizeBytes: 0, protectDefaultBranch: true,
    });
    repoId = repo.id;
    handler = ingestHandler({
      gitCommitStatusStorage: statusStorage,
      gitRepoStorage: repoStorage,
      ciStatusSecret: 'ci-secret',
    });
  });

  const goodBody = () => ({
    owner: 'user-1', repo: 'site', sha: SHA, context: 'ci/checks',
    state: 'pending', description: 'Running in an ephemeral VM',
  });

  it('refuses a wrong secret and records nothing', async () => {
    const res = createMockResponse();
    await handler(ingestRequest(goodBody(), 'not-the-secret'), res);
    expect(res.statusCode).toBe(401);
    expect(await statusStorage.listBySha(repoId, SHA)).toHaveLength(0);
  });

  it('accepts and silently drops a repo it does not host', async () => {
    const res = createMockResponse();
    await handler(ingestRequest({ ...goodBody(), owner: 'someone-else' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: false });
  });

  it('rejects a malformed sha and an unknown state', async () => {
    for (const body of [{ ...goodBody(), sha: 'abc' }, { ...goodBody(), state: 'green' }]) {
      const res = createMockResponse();
      await handler(ingestRequest(body), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('files pending then terminal, preserving startedAt and storing the log tail', async () => {
    await handler(ingestRequest(goodBody()), createMockResponse());
    const pending = (await statusStorage.listBySha(repoId, SHA))[0]!;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await handler(ingestRequest({
      ...goodBody(), state: 'failure', description: 'Failed (exit 1)',
      logTailB64: Buffer.from('=== npm test ===\n1 failing').toString('base64'),
    }), createMockResponse());
    const rows = await statusStorage.listBySha(repoId, SHA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failure');
    expect(rows[0]!.startedAt).toBe(pending.startedAt);
    expect(rows[0]!.completedAt).toBeDefined();
    expect(rows[0]!.logTail).toContain('1 failing');
  });

  it('keeps the job machine’s shape from the pending through the verdict, and drops a malformed one', async () => {
    await handler(ingestRequest({ ...goodBody(), machineGuest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } }), createMockResponse());
    expect((await statusStorage.get(repoId, SHA, 'ci/checks'))!.machine).toEqual({ cpuKind: 'performance', cpus: 4, memoryMb: 8192 });
    // The verdict without a shape (an older daemon, say) keeps the pending's.
    await handler(ingestRequest({ ...goodBody(), state: 'success', description: 'Passed in 5.5m in an ephemeral VM' }), createMockResponse());
    expect((await statusStorage.get(repoId, SHA, 'ci/checks'))!.machine).toEqual({ cpuKind: 'performance', cpus: 4, memoryMb: 8192 });
    // A shape that is not one is not stored, and does not fail the verdict.
    const other = 'e'.repeat(40);
    const res = createMockResponse();
    await handler(ingestRequest({ ...goodBody(), sha: other, machineGuest: { cpu_kind: 7, cpus: 'many' } }), res);
    expect(res.statusCode).toBe(200);
    expect((await statusStorage.get(repoId, other, 'ci/checks'))!.machine).toBeUndefined();
  });

  it('re-running a sha stamps the new pending now, so it cannot be born stale', async () => {
    // The same sha gets built twice: once on its branch, then again when it is
    // fast-forwarded onto main. Both runs write ONE document, keyed
    // (repo, sha, context). The second run's pending used to inherit the first
    // run's startedAt — arriving older than the stale-pending cutoff, so it
    // read as `error` the instant it was written: a red pip and a blocked
    // merge for a build that was running fine.
    // The branch run, finished well over the stale cutoff ago — seeded
    // directly so the age is exact rather than a function of test timing.
    const branchStartedAt = new Date(Date.now() - GIT_COMMIT_STATUS_STALE_PENDING_MS - 60_000);
    await statusStorage.upsert({
      userId: 'user-1', repoId, sha: SHA, context: 'ci/checks', state: 'success',
      description: 'Passed in 2.6m in an ephemeral VM',
      startedAt: branchStartedAt.toISOString(),
      completedAt: new Date(branchStartedAt.getTime() + 156_000).toISOString(),
      logTail: '=== npm test ===\nall good',
    });

    // The merge lands and lane A files a fresh pending for the same sha.
    await handler(ingestRequest(goodBody()), createMockResponse());
    const rerun = (await statusStorage.listBySha(repoId, SHA))[0]!;

    expect(rerun.state).toBe('pending');
    expect(new Date(rerun.startedAt).getTime())
      .toBeGreaterThan(branchStartedAt.getTime() + GIT_COMMIT_STATUS_STALE_PENDING_MS);
    // The whole point: fresh on arrival, on every surface that reads it.
    expect(effectiveStatusState(rerun, new Date())).toBe('pending');
    // Inheriting the branch run's start is precisely what made it read red.
    expect(effectiveStatusState(
      { state: 'pending', startedAt: branchStartedAt.toISOString() },
      new Date(),
    )).toBe('error');
  });

  it('the re-run terminal times itself from its own pending, not the first run', async () => {
    await handler(ingestRequest(goodBody()), createMockResponse());
    await handler(ingestRequest({ ...goodBody(), state: 'success' }), createMockResponse());
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await handler(ingestRequest(goodBody()), createMockResponse());
    const secondPending = (await statusStorage.listBySha(repoId, SHA))[0]!;
    await handler(ingestRequest({ ...goodBody(), state: 'success' }), createMockResponse());
    const rows = await statusStorage.listBySha(repoId, SHA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('success');
    expect(rows[0]!.startedAt).toBe(secondPending.startedAt);
  });

  it('accepts the skipped state — the one GitHub cannot carry', async () => {
    const res = createMockResponse();
    await handler(ingestRequest({
      ...goodBody(), context: 'deploy/prod', state: 'skipped',
      description: 'Skipped — nothing this job deploys changed in this commit',
    }), res);
    expect(res.statusCode).toBe(200);
    const rows = await statusStorage.listBySha(repoId, SHA);
    expect(rows[0]!.state).toBe('skipped');
  });
});

/**
 * Note #76: "broke" and "never reported" are both not-passing, and the gate is
 * right to stop on either — but they are not the same news, and this is what
 * decides which one the reader is shown. Collapsing them put a red dot on two
 * merged proposals whose leftover jobs were simply abandoned.
 */
describe('worstCheckState — what the reader is told', () => {
  const now = new Date();
  const at = now.toISOString();
  const of = (...states: string[]) => worstCheckState(
    states.map((state) => ({ state: state as never, startedAt: at })),
    now,
  );

  it('says superseded when nothing broke and nothing is running', () => {
    expect(of('superseded')).toBe('superseded');
    expect(of('success', 'superseded')).toBe('superseded');
    expect(of('skipped', 'superseded')).toBe('superseded');
  });

  it('still lets a real failure outrank an abandoned job', () => {
    expect(of('superseded', 'failure')).toBe('failure');
    expect(of('superseded', 'error')).toBe('failure');
  });

  it('still reports running before an abandoned job', () => {
    expect(of('superseded', 'pending')).toBe('pending');
  });

  it('keeps the plain verdicts exactly as they were', () => {
    expect(of('success')).toBe('success');
    expect(of('success', 'skipped')).toBe('success');
    expect(of('failure')).toBe('failure');
    expect(of('error')).toBe('failure');
    expect(of('pending')).toBe('pending');
    expect(of()).toBeNull();
  });

  // The merge gate reads the SET, not this function, and it must keep blocking
  // on a superseded check — nothing here is allowed to loosen that.
  it('leaves the merge gate’s not-passing set alone', () => {
    expect(GIT_COMMIT_STATUS_NOT_PASSING.has('superseded')).toBe(true);
    expect(GIT_COMMIT_STATUS_NOT_PASSING.has('failure')).toBe(true);
    expect(GIT_COMMIT_STATUS_NOT_PASSING.has('error')).toBe(true);
    expect(GIT_COMMIT_STATUS_NOT_PASSING.has('success')).toBe(false);
  });
});
