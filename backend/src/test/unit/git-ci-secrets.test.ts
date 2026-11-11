import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import {
  agentUserSecretScope,
  SHARED_USER_SECRET_SCOPE,
  UserSecretsService,
} from '../../services/user-secrets.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';

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

const CI_SECRET = 'runner-status-secret';

/**
 * The host, as the routes see it: `stat` answers protection, everything else
 * is unused here. Built per-deps so a test can make stat FAIL.
 */
function hostClient(statResult: unknown | 'throw', opts: { ciCalls?: unknown[]; ciFails?: boolean } = {}) {
  return new GitHostClient({
    baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's',
    fetchImpl: (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/internal/repos/stat')) {
        if (statResult === 'throw') return { ok: false, status: 500, text: async () => '{"error":"down"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify(statResult) };
      }
      if (String(url).endsWith('/internal/repos/ci')) {
        const body = JSON.parse(init?.body ?? '{}');
        opts.ciCalls?.push(body);
        if (opts.ciFails) {
          return { ok: false, status: 409, text: async () => '{"error":"this host has no CI dispatcher configured"}' };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ci: body.enabled }) };
      }
      throw new Error(`unexpected host call: ${url}`);
    }) as unknown as typeof fetch,
  });
}

async function buildDeps(opts: { stat?: unknown | 'throw'; ciFails?: boolean } = {}) {
  const ciCalls: unknown[] = [];
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
  const repo = await gitRepoStorage.create({
    userId: 'user-1', name: 'site', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
  });
  const scratch = await gitRepoStorage.create({
    userId: 'user-1', name: 'scratch', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: false,
  });
  const secretStorage = new InMemorySecretStorage();
  const secrets = new UserSecretsService(secretStorage);
  await secrets.setSecret('user-1', 'CF_TOKEN', 'cf-live-value', SHARED_USER_SECRET_SCOPE, 'Cloudflare token');
  await secrets.setSecret('user-1', 'HETZ_KEY', 'hetz-value', SHARED_USER_SECRET_SCOPE, 'Hetzner key');
  await secrets.setSecret('user-1', 'PRIVATE_ONE', 'agent-own', agentUserSecretScope('agent-b'), 'One agent\'s own');
  const asks: unknown[] = [];
  const deps: Partial<RouteDeps> = {
    userStorage,
    gitRepoStorage,
    gitHostClient: hostClient(
      opts.stat ?? { exists: true, sizeBytes: 1, protectedBranches: ['main', 'dev'] },
      { ciCalls, ...(opts.ciFails ? { ciFails: true } : {}) },
    ),
    secretStorage,
    ciStatusSecret: CI_SECRET,
    tellOwnerCiSecretsGranted: vi.fn(async (args) => { asks.push(args); return true; }),
  };
  return { deps, token, repo, scratch, gitRepoStorage, asks, ciCalls };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /repos/:name/ci — self-serve, both directions', () => {
  it('enables through the host, records the flag, and never sends a URL', async () => {
    const { deps, token, repo, gitRepoStorage, ciCalls } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/ci', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { enabled: true },
    }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { ci: boolean }).ci).toBe(true);
    // The product's copy of the host's truth — written only after it agreed.
    expect((await gitRepoStorage.get(repo.id))?.ci).toBe(true);
    // The whole SSRF argument, asserted: a boolean crossed the wire, and
    // nothing that could name a destination.
    expect(ciCalls).toEqual([{ userId: 'user-1', name: 'site', enabled: true }]);
    expect(JSON.stringify(ciCalls)).not.toMatch(/http|webhook/i);
  });

  it('disables again — CI grants no authority, so it is reversible', async () => {
    const { deps, token, repo, gitRepoStorage } = await buildDeps();
    await gitRepoStorage.update(repo.id, { ci: true });
    const handler = getRouteHandler(deps, '/repos/:name/ci', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { enabled: false },
    }), res);

    expect((res.body as { ci: boolean }).ci).toBe(false);
    expect((await gitRepoStorage.get(repo.id))?.ci).toBe(false);
  });

  it('needs a real boolean', async () => {
    const { deps, token, ciCalls } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/ci', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' },
      body: { enabled: 'http://169.254.169.254/' },
    }), res);

    expect(res.statusCode).toBe(400);
    expect(ciCalls).toHaveLength(0);
  });

  it('hands the host\'s "no dispatcher here" refusal to the agent, and records nothing', async () => {
    const { deps, token, repo, gitRepoStorage } = await buildDeps({ ciFails: true });
    const handler = getRouteHandler(deps, '/repos/:name/ci', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { enabled: true },
    }), res);

    expect(res.statusCode).toBe(502);
    expect((res.body as { error: string }).error).toContain('no CI dispatcher');
    expect((await gitRepoStorage.get(repo.id))?.ci).toBeUndefined();
  });
});

describe('POST /repos/:name/ci-secrets — granted at once, the owner is told (note #739)', () => {
  it('writes the grant, clears any legacy ask, and tells the owner which names', async () => {
    const { deps, token, repo, gitRepoStorage, asks } = await buildDeps();
    // An ask from before grants applied at once: this grant answers it.
    await gitRepoStorage.update(repo.id, { ciSecretsAsk: { names: ['CF_TOKEN'], byAgentId: 'agent-a', at: 't' } });
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' },
      body: { names: ['CF_TOKEN', 'HETZ_KEY'] },
    }), res);

    expect(res.statusCode).toBe(200);
    const message = (res.body as { message: string }).message;
    // Nothing to wait for, and the agent is told to say what it granted.
    expect(message).toContain('Granted');
    expect(message).toContain('nothing waits for their approval');
    expect(message).not.toContain('Do not wait');
    const doc = await gitRepoStorage.get(repo.id);
    expect(doc?.ciSecrets).toEqual(['CF_TOKEN', 'HETZ_KEY']);
    expect(doc?.ciSecretsNamespaceId).toBe('user-1');
    expect(doc?.ciSecretsAsk).toBeUndefined();
    expect(asks).toEqual([{ userId: 'user-1', agentId: 'agent-a', repoId: repo.id, names: ['CF_TOKEN', 'HETZ_KEY'] }]);
  });

  it('says so when the chat line could not be written, so the agent tells the owner itself', async () => {
    const { deps, token, repo, gitRepoStorage } = await buildDeps();
    deps.tellOwnerCiSecretsGranted = vi.fn(async () => false);
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { names: ['CF_TOKEN'] },
    }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain('say in your reply which names');
    expect((await gitRepoStorage.get(repo.id))?.ciSecrets).toEqual(['CF_TOKEN']);
  });

  it('refuses a name that is not a saved SHARED secret, and grants nothing', async () => {
    const { deps, token, repo, gitRepoStorage, asks } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');

    for (const name of ['NOPE', 'PRIVATE_ONE']) {
      const res = createMockResponse();
      await handler(mockRequest({
        headers: authHeader(token), params: { name: 'site' }, body: { names: [name] },
      }), res);
      expect(res.statusCode).toBe(404);
      expect((res.body as { error: string }).error).toContain(name);
    }
    expect((await gitRepoStorage.get(repo.id))?.ciSecrets).toBeUndefined();
    expect(asks).toHaveLength(0);
  });

  it('refuses CI_* names — the runner contract is not grantable', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { names: ['CI_JOB_TOKEN'] },
    }), res);

    expect(res.statusCode).toBe(400);
  });

  it('an --unprotected repo has nothing safe to grant to', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'scratch' }, body: { names: ['CF_TOKEN'] },
    }), res);

    expect(res.statusCode).toBe(409);
  });

  it('remove narrows directly, and tells nobody', async () => {
    const { deps, token, repo, gitRepoStorage, asks } = await buildDeps();
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN', 'HETZ_KEY'] });
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' },
      body: { names: ['CF_TOKEN'], remove: true },
    }), res);

    expect(res.statusCode).toBe(200);
    expect((await gitRepoStorage.get(repo.id))?.ciSecrets).toEqual(['HETZ_KEY']);
    expect(asks).toHaveLength(0);
  });

  it('names already granted are not re-granted or re-told', async () => {
    const { deps, token, repo, gitRepoStorage, asks } = await buildDeps();
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN'] });
    const handler = getRouteHandler(deps, '/repos/:name/ci-secrets', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'site' }, body: { names: ['CF_TOKEN'] },
    }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain('Already granted');
    expect(asks).toHaveLength(0);
    expect((await gitRepoStorage.get(repo.id))?.ciSecretsAsk).toBeUndefined();
  });
});

describe('POST /git/ci-secrets — what the dispatcher is told', () => {
  const call = async (deps: Partial<RouteDeps>, body: unknown, secret = CI_SECRET) => {
    const handler = getRouteHandler(deps, '/git/ci-secrets', 'post');
    const res = createMockResponse();
    await handler(mockRequest({ headers: { 'x-ci-status-secret': secret }, body }), res);
    return res;
  };

  it('refuses a bad runner secret and an unknown repo', async () => {
    const { deps } = await buildDeps();
    expect((await call(deps, { owner: 'user-1', repo: 'site', ref: 'main' }, 'wrong')).statusCode).toBe(401);
    expect((await call(deps, { owner: 'user-1', repo: 'ghost', ref: 'main' })).statusCode).toBe(404);
  });

  it('answers {} for a repo that never opted in', async () => {
    const { deps } = await buildDeps();
    const res = await call(deps, { owner: 'user-1', repo: 'site', ref: 'main' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secrets: {} });
  });

  it('answers {} for a ref the host does not call protected', async () => {
    const { deps, repo, gitRepoStorage } = await buildDeps();
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN'] });
    const res = await call(deps, { owner: 'user-1', repo: 'site', ref: 'feature-x' });
    expect(res.body).toEqual({ secrets: {} });
  });

  it('hands granted names on a protected ref — shared values only, missing names skipped', async () => {
    const { deps, repo, gitRepoStorage } = await buildDeps();
    // GONE was granted then deleted from the cupboard; PRIVATE_ONE is one
    // agent's own key and must never ride CI even if granted somehow.
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN', 'GONE', 'PRIVATE_ONE'] });
    const res = await call(deps, { owner: 'user-1', repo: 'site', ref: 'dev' });
    expect(res.body).toEqual({ secrets: { CF_TOKEN: 'cf-live-value' } });
  });

  it('reads the store of the ROOM the grant names, not the address the repo lives at (note #566)', async () => {
    const { deps, repo, gitRepoStorage } = await buildDeps();
    const secrets = new UserSecretsService(deps.secretStorage!);
    await secrets.setSecret('room-growth', 'CF_TOKEN', 'growth-value', SHARED_USER_SECRET_SCOPE, 'Growth\'s token');
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN', 'HETZ_KEY'], ciSecretsNamespaceId: 'room-growth' });
    const res = await call(deps, { owner: 'user-1', repo: 'site', ref: 'main' });
    // Growth's CF_TOKEN, and NOT the address's HETZ_KEY: one room per grant.
    expect(res.body).toEqual({ secrets: { CF_TOKEN: 'growth-value' } });
  });

  it('fails CLOSED when the host cannot confirm protection', async () => {
    const { deps, repo, gitRepoStorage } = await buildDeps({ stat: 'throw' });
    await gitRepoStorage.update(repo.id, { ciSecrets: ['CF_TOKEN'] });
    const res = await call(deps, { owner: 'user-1', repo: 'site', ref: 'main' });
    expect(res.statusCode).toBe(502);
  });
});
