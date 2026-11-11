/**
 * Publishing on approval (`agentbuilt repo publish`): an approved change to a
 * linked repository goes live with nobody deploying it.
 *
 * Before this, the only key that could publish a site was an agent's own
 * `agb1.` token, re-minted on every identity write — so a copy saved as a CI
 * secret died within hours, and a merge reached the live site only when the
 * agent that proposed it was awake to deploy by hand. These tests hold the
 * four pieces that replace that: the ask (an agent may only ASK), the owner's
 * answer, the one-job key `/git/ci-secrets` mints, and `/deploy` taking that
 * key for exactly one redeploy of exactly one site, as the linking agent.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { SHARED_USER_SECRET_SCOPE, UserSecretsService } from '../../services/user-secrets.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { mintCiDeployToken, verifyCiDeployToken } from '../../services/ci-deploy-token.js';
import type { DeploymentService } from '../../services/deployment-service.js';

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

function handler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post') {
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

function request(args: { headers?: Record<string, string>; params?: Record<string, string>; body?: unknown }): Partial<Request> {
  const headers = Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: {},
    body: args.body,
  };
}

const CI_SECRET = 'runner-status-secret';
const SHA = 'a'.repeat(40);
const API = 'https://api.example.test';
const tarball = Buffer.from('fake-tarball');

async function world() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const juno = mintAgentbuiltToken('user-1', 'agent-juno');
  const leo = mintAgentbuiltToken('user-1', 'agent-leo');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        'agent-juno': { id: 'agent-juno', name: 'Juno', cli: 'claude', agentbuiltTokenHash: juno.tokenHash } as never,
        'agent-leo': { id: 'agent-leo', name: 'Leo', cli: 'claude', agentbuiltTokenHash: leo.tokenHash } as never,
      },
    },
  });
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const repo = await gitRepoStorage.create({
    userId: 'user-1', name: 'ship-it', createdByAgentId: 'agent-juno', sizeBytes: 0, protectDefaultBranch: true,
  });
  await gitRepoStorage.update(repo.id, { ci: true });
  const deploymentStorage = new InMemoryDeploymentStorage();
  const site = await deploymentStorage.create({
    userId: 'user-1', agentId: 'agent-juno', name: 'startup-game', preset: 'service', status: 'live',
    secretNames: ['GAME_KEY'],
  } as never);
  const other = await deploymentStorage.create({
    userId: 'user-1', agentId: 'agent-leo', name: 'blog', preset: 'static', status: 'live',
  } as never);
  const secretStorage = new InMemorySecretStorage();
  await new UserSecretsService(secretStorage)
    .setSecret('user-1', 'GAME_KEY', 'game-value', SHARED_USER_SECRET_SCOPE, 'The game backend key');
  const setSecretEnv = vi.fn(async () => false);
  const deploymentService = {
    url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`,
    syncTarball: vi.fn(async () => {}),
    stageTarball: vi.fn(async () => {}),
    createPending: vi.fn(),
    setSecretEnv,
  };
  const asks: unknown[] = [];
  const deps: Partial<RouteDeps> = {
    userStorage,
    gitRepoStorage,
    deploymentStorage,
    deploymentService: deploymentService as unknown as DeploymentService,
    secretStorage,
    ciStatusSecret: CI_SECRET,
    agentbuiltApiUrl: API,
    gitHostClient: new GitHostClient({
      baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's',
      fetchImpl: (async (url: string) => {
        if (String(url).endsWith('/internal/repos/stat')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ exists: true, sizeBytes: 1, protectedBranches: ['main'] }) };
        }
        throw new Error(`unexpected host call: ${url}`);
      }) as unknown as typeof fetch,
    }),
    tellOwnerPublishLinked: vi.fn(async (args) => { asks.push(args); return true; }),
  };
  /** A standing link, as `repo publish` writes it. */
  const link = async () => gitRepoStorage.update(repo.id, {
    publishTo: { siteId: site.id, site: site.name, byAgentId: 'agent-juno', byUserId: 'user-1', at: 't' },
  });
  return {
    deps, repo, site, other, gitRepoStorage, deploymentStorage, deploymentService, setSecretEnv, userStorage,
    asks, link, junoToken: juno.token, leoToken: leo.token,
  };
}

const ask = async (deps: Partial<RouteDeps>, token: string, name: string, body: unknown) => {
  const res = createMockResponse();
  await handler(deps, '/repos/:name/publish', 'post')(request({
    headers: { Authorization: `Bearer ${token}` }, params: { name }, body,
  }), res);
  return res;
};

const ciSecrets = async (deps: Partial<RouteDeps>, body: unknown) => {
  const res = createMockResponse();
  await handler(deps, '/git/ci-secrets', 'post')(request({ headers: { 'x-ci-status-secret': CI_SECRET }, body }), res);
  return res;
};

const deploy = async (deps: Partial<RouteDeps>, token: string, headers: Record<string, string>) => {
  const res = createMockResponse();
  await handler(deps, '/deploy', 'post')({
    ...request({ headers: { Authorization: `Bearer ${token}`, ...headers } }),
    body: tarball,
  }, res);
  return res;
};

describe('POST /repos/:name/publish — linked at once, the owner is told (note #739)', () => {
  it('writes the link for a live site, clears any legacy ask, and tells the agent how to use it', async () => {
    const w = await world();
    await w.gitRepoStorage.update(w.repo.id, {
      publishAsk: { siteId: w.site.id, site: 'startup-game', byAgentId: 'agent-juno', byUserId: 'user-1', at: 't' },
    });
    const res = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(res.statusCode).toBe(200);
    const after = await w.gitRepoStorage.get(w.repo.id);
    expect(after?.publishTo).toMatchObject({ siteId: w.site.id, site: 'startup-game', byAgentId: 'agent-juno', byUserId: 'user-1' });
    expect(after?.publishAsk).toBeUndefined();
    expect(w.asks).toEqual([{ userId: 'user-1', agentId: 'agent-juno', repoId: w.repo.id }]);
    const message = String((res.body as { message: string }).message);
    expect(message).toContain('Linked');
    expect(message).toContain('.agentbuilt/deploy.sh');
    expect(message).toContain('deploy/startup-game');
    expect(message).toContain('nothing waits for their approval');
    expect(message).not.toContain('Do not wait');
  });

  it('a link to another site is replaced, newest wins, and the reply names the old one', async () => {
    const w = await world();
    const first = await w.deploymentStorage.create({
      userId: 'user-1', orgId: w.site.orgId, agentId: 'agent-juno', name: 'old-home', preset: 'static', status: 'live',
    } as never);
    await w.gitRepoStorage.update(w.repo.id, {
      publishTo: { siteId: first.id, site: 'old-home', byAgentId: 'agent-juno', byUserId: 'user-1', at: 't' },
    });
    const res = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(res.statusCode).toBe(200);
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo?.siteId).toBe(w.site.id);
    expect(String((res.body as { message: string }).message)).toContain('instead of old-home');
  });

  it('refuses what could only put unreviewed or broken things live', async () => {
    const w = await world();
    await w.gitRepoStorage.update(w.repo.id, { protectDefaultBranch: false });
    expect((await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' })).statusCode).toBe(409);

    await w.gitRepoStorage.update(w.repo.id, { protectDefaultBranch: true, ci: false });
    const noCi = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(noCi.statusCode).toBe(409);
    expect(String((noCi.body as { error: string }).error)).toContain('agentbuilt repo ci enable ship-it');

    await w.gitRepoStorage.update(w.repo.id, { ci: true });
    await w.deploymentStorage.update(w.site.id, { status: 'payment-lapsed' } as never);
    const paused = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(paused.statusCode).toBe(409);
    expect(String((paused.body as { error: string }).error)).toContain('only ever REDEPLOYS a running site');

    expect((await ask(w.deps, w.junoToken, 'ship-it', { site: 'nobody-has-this' })).statusCode).toBe(404);
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo).toBeUndefined();
    expect(w.asks).toHaveLength(0);
  });

  it('in an own cloud, refuses a link plainly and records nothing; off still works (note #1161)', async () => {
    const w = await world();
    w.deps.orgCi = { runsChecksFor: async () => true } as never;
    const res = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain('Not available in your own Agentic Cloud yet');
    expect(String((res.body as { error: string }).error)).toContain('nothing was linked');
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo).toBeUndefined();
    expect(w.asks).toHaveLength(0);

    await w.link();
    const off = await ask(w.deps, w.leoToken, 'ship-it', { off: true });
    expect(off.statusCode).toBe(200);
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo).toBeUndefined();
  });

  it('links as before where our own lane runs the checks', async () => {
    const w = await world();
    w.deps.orgCi = { runsChecksFor: async () => false } as never;
    const res = await ask(w.deps, w.junoToken, 'ship-it', { site: 'startup-game' });
    expect(res.statusCode).toBe(200);
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo?.siteId).toBe(w.site.id);
  });

  it('turning it off is applied at once, by any agent', async () => {
    const w = await world();
    await w.link();
    const res = await ask(w.deps, w.leoToken, 'ship-it', { off: true });
    expect(res.statusCode).toBe(200);
    expect((await w.gitRepoStorage.get(w.repo.id))?.publishTo).toBeUndefined();
    expect(String((res.body as { message: string }).message)).toContain('publishes by hand again');
  });

  it('`repo show` names the linked site by its CURRENT name, so a rename is followed', async () => {
    const w = await world();
    await w.link();
    await w.deploymentStorage.update(w.site.id, { name: 'idle-startup' } as never);
    const res = createMockResponse();
    w.deps.gitHostClient = { ...w.deps.gitHostClient!, statRepo: async () => ({ exists: true, sizeBytes: 1, protectedBranches: ['main'] }), cloneUrl: () => 'https://git.example.test/user-1/ship-it.git' } as never;
    await handler(w.deps, '/repos/:name', 'get')(request({
      headers: { Authorization: `Bearer ${w.junoToken}` }, params: { name: 'ship-it' },
    }), res);
    expect((res.body as { repo: { publishesTo?: string } }).repo.publishesTo).toBe('idle-startup');
  });
});

describe('POST /git/ci-secrets — the one-job publish key', () => {
  it('mints a key for a protected-branch run of a linked repo: this site, this commit, an hour', async () => {
    const w = await world();
    await w.link();
    const res = await ciSecrets(w.deps, { owner: 'user-1', repo: 'ship-it', ref: 'main', sha: SHA });
    expect(res.statusCode).toBe(200);
    const body = res.body as { secrets: Record<string, string>; publish?: { site: string; token: string; apiUrl: string; expiresAt: string } };
    // No CI secrets were granted, and none ride along with the key.
    expect(body.secrets).toEqual({});
    expect(body.publish).toMatchObject({ site: 'startup-game', apiUrl: API });
    expect(verifyCiDeployToken(CI_SECRET, body.publish!.token)).toEqual({ repoId: w.repo.id, siteId: w.site.id, sha: SHA });
    const ttl = new Date(body.publish!.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
  });

  it('hands no key to any other run', async () => {
    const w = await world();
    // Not linked.
    expect((await ciSecrets(w.deps, { owner: 'user-1', repo: 'ship-it', ref: 'main', sha: SHA })).body).toEqual({ secrets: {} });
    await w.link();
    // A feature branch: code nobody approved yet.
    expect((await ciSecrets(w.deps, { owner: 'user-1', repo: 'ship-it', ref: 'feature', sha: SHA })).body).toEqual({ secrets: {} });
    // A runner from before the sha was sent: it would not know what it published.
    expect((await ciSecrets(w.deps, { owner: 'user-1', repo: 'ship-it', ref: 'main' })).body).toEqual({ secrets: {} });
    // A backend with no public address to point the CLI at.
    delete w.deps.agentbuiltApiUrl;
    expect((await ciSecrets(w.deps, { owner: 'user-1', repo: 'ship-it', ref: 'main', sha: SHA })).body).toEqual({ secrets: {} });
  });
});

describe('POST /deploy with a publish key — one redeploy, one site, as the linking agent', () => {
  const keyFor = (w: Awaited<ReturnType<typeof world>>, siteId = w.site.id) => (
    mintCiDeployToken(CI_SECRET, { repoId: w.repo.id, siteId, sha: SHA }).token
  );

  it('redeploys the linked site with the keys it runs with, read as Juno, and says it was CI', async () => {
    const w = await world();
    await w.link();
    const res = await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'startup-game' });
    expect(res.statusCode).toBe(200);
    expect(w.deploymentService.syncTarball).toHaveBeenCalledWith(w.site.id, tarball);
    // A service reads its saved keys from whoever deploys it: Juno's room
    // still hands GAME_KEY on, which a key with nobody behind it could not.
    expect(w.setSecretEnv).toHaveBeenCalledWith(w.site.id, { GAME_KEY: 'game-value' }, ['GAME_KEY']);
    const after = await w.deploymentStorage.get(w.site.id);
    expect(after?.lastDeployBy).toMatchObject({ agentId: 'agent-juno', ci: { repo: 'ship-it', sha: SHA } });
  });

  it('never meets the --replace fence: the owner’s Allow was the deliberate word', async () => {
    const w = await world();
    await w.link();
    await w.deploymentStorage.update(w.site.id, { lastDeployBy: { agentId: 'agent-leo', userId: 'user-1' } } as never);
    expect((await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'startup-game' })).statusCode).toBe(200);
  });

  it('publishes nothing else: another site, a new one, or a change of keys', async () => {
    const w = await world();
    await w.link();
    const elsewhere = await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'blog' });
    expect(elsewhere.statusCode).toBe(403);
    expect(String((elsewhere.body as { error: string }).error)).toContain('"startup-game" only');
    expect((await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'brand-new', 'x-agentbuilt-preset': 'static' })).statusCode).toBe(403);
    expect((await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'startup-game', 'x-agentbuilt-no-secrets': 'true' })).statusCode).toBe(400);
    expect(w.deploymentService.syncTarball).not.toHaveBeenCalled();
    expect(w.deploymentService.createPending).not.toHaveBeenCalled();
  });

  it('dies with the link: taking it off stops a key already handed out', async () => {
    const w = await world();
    await w.link();
    const key = keyFor(w);
    await w.gitRepoStorage.update(w.repo.id, { publishTo: undefined });
    const res = await deploy(w.deps, key, { 'x-agentbuilt-name': 'startup-game' });
    expect(res.statusCode).toBe(403);
    expect(w.deploymentService.syncTarball).not.toHaveBeenCalled();
  });

  it('refuses a forged or expired key without ever marking an agent’s own token stale', async () => {
    const w = await world();
    await w.link();
    const forged = mintCiDeployToken('some-other-secret', { repoId: w.repo.id, siteId: w.site.id, sha: SHA }).token;
    expect((await deploy(w.deps, forged, { 'x-agentbuilt-name': 'startup-game' })).statusCode).toBe(401);
    vi.useFakeTimers();
    try {
      const old = keyFor(w);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      expect((await deploy(w.deps, old, { 'x-agentbuilt-name': 'startup-game' })).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    // The flag that forces an identity rewrite — and with it a NEW agent
    // token — is for an agent's own token. This was never Juno's.
    const juno = (await w.userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-juno'];
    expect(juno?.agentbuiltTokenStale).toBeFalsy();
    expect(w.deploymentService.syncTarball).not.toHaveBeenCalled();
  });

  it('says plainly when the agent it publishes as is gone', async () => {
    const w = await world();
    await w.gitRepoStorage.update(w.repo.id, {
      publishTo: { siteId: w.site.id, site: 'startup-game', byAgentId: 'agent-gone', byUserId: 'user-1', at: 't' },
    });
    const res = await deploy(w.deps, keyFor(w), { 'x-agentbuilt-name': 'startup-game' });
    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error: string }).error)).toContain('no longer exists');
  });

  it('an agent’s own token still deploys exactly as before', async () => {
    const w = await world();
    await w.link();
    const res = await deploy(w.deps, w.junoToken, { 'x-agentbuilt-name': 'startup-game' });
    expect(res.statusCode).toBe(200);
    expect((await w.deploymentStorage.get(w.site.id))?.lastDeployBy?.ci).toBeUndefined();
  });
});
