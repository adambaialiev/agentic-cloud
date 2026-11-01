import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { SHARED_USER_SECRET_SCOPE, UserSecretsService } from '../../services/user-secrets.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { ShelfMappedSecretStorage } from '../../services/shelf-mapped-secret-storage.js';

/**
 * `agentbuilt secret` — the machine-side surface of docs/user-secrets.md.
 *
 * The assertions that carry weight here are the ones about SCOPE and about
 * plaintext never coming back over HTTP. Everything else is plumbing.
 */

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
  method: 'get' | 'post' | 'patch' | 'delete',
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
    query: (args.query ?? {}) as Request['query'],
    body: args.body,
  };
}

/** Two agents on one account: the second is what proves scoping bites. */
async function buildDeps() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const agentA = mintAgentbuiltToken('user-1', 'agent-a');
  const agentB = mintAgentbuiltToken('user-1', 'agent-b');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: agentA.tokenHash } as never,
        'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', agentbuiltTokenHash: agentB.tokenHash } as never,
      },
    },
  });
  const secretStorage = new InMemorySecretStorage();
  const deps: Partial<RouteDeps> = { userStorage, secretStorage };
  return { deps, secretStorage, tokenA: agentA.token, tokenB: agentB.token };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setSecret(
  deps: Partial<RouteDeps>,
  token: string,
  body: { name: string; value: string; description?: string; agentOnly?: boolean; shared?: boolean },
): Promise<MockResponse> {
  const res = createMockResponse();
  await getRouteHandler(deps, '/secrets', 'post')(
    mockRequest({ headers: authHeader(token), body }),
    res,
  );
  return res;
}

describe('agent-cli secrets', () => {
  it('lets a member agent manage its own private secret, but not workplace-shared secrets', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin' });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'member' });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = new OrgGitService({ orgStorage });
    await new UserSecretsService(secretStorage).setSecret(org.orgId, 'ORG_KEY', 'admin-set');

    const shared = await setSecret(deps, tokenA, { name: 'NOPE', value: 'x' });
    expect(shared.statusCode).toBe(403);
    const privateSecret = await setSecret(deps, tokenA, {
      name: 'MY_KEY', value: 'mine', agentOnly: true,
    });
    expect(privateSecret.statusCode).toBe(200);
    expect(await new UserSecretsService(secretStorage).getSecretEnv(org.orgId, 'agent-a'))
      .toMatchObject({ ORG_KEY: 'admin-set', MY_KEY: 'mine' });

    const describeShared = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({
        headers: authHeader(tokenA), params: { name: 'ORG_KEY' }, body: { description: 'changed' },
      }), describeShared);
    expect(describeShared.statusCode).toBe(403);
    const deleteShared = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'delete')(
      mockRequest({ headers: authHeader(tokenA), params: { name: 'ORG_KEY' } }), deleteShared);
    expect(deleteShared.statusCode).toBe(403);
  });

  // Note #655: whose agents a shared key reaches. Only an admin-owned agent
  // may open one; the listing tells every agent which rows are which.
  it('lets an admin agent choose a shared key\'s audience, and refuses a member agent', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin' });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = new OrgGitService({ orgStorage });
    const service = new UserSecretsService(secretStorage);

    const closed = await setSecret(deps, tokenA, { name: 'FLY', value: 'f', description: 'platform' });
    expect(closed.statusCode).toBe(200);
    expect((closed.body as { message: string }).message).toContain('admins');
    const open = await setSecret(deps, tokenA, { name: 'TEAM', value: 't', description: 'shared', audience: 'everyone' } as never);
    expect(open.statusCode).toBe(200);
    const bad = await setSecret(deps, tokenA, { name: 'X', value: 'x', description: 'd', audience: 'friends' } as never);
    expect(bad.statusCode).toBe(400);
    const privateWithAudience = await setSecret(deps, tokenA, { name: 'X', value: 'x', description: 'd', agentOnly: true, audience: 'everyone' } as never);
    expect(privateWithAudience.statusCode).toBe(400);

    const list = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), list);
    const rows = (list.body as { secrets: Array<{ name: string; audience?: string }> }).secrets;
    expect(rows.find((row) => row.name === 'FLY')).toMatchObject({ audience: 'admins' });
    expect(rows.find((row) => row.name === 'TEAM')).toMatchObject({ audience: 'everyone' });

    const share = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({ headers: authHeader(tokenA), params: { name: 'FLY' }, body: { audience: 'everyone' } }), share);
    expect(share.statusCode).toBe(200);
    expect(await service.getSecretEnv(org.orgId, 'agent-a', { ownerIsAdmin: false })).toEqual({ FLY: 'f', TEAM: 't' });

    // Demoted to member: the same agent may no longer open or close anything.
    await orgStorage.setMemberRole(org.orgId, 'user-1', 'member');
    const refused = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({ headers: authHeader(tokenA), params: { name: 'FLY' }, body: { audience: 'admins' } }), refused);
    expect(refused.statusCode).toBe(403);
  });

  it('defaults a write to every agent in the workplace', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();

    const res = await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'ghp_all' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: true, scope: 'shared' });

    // The product call behind the default: a key handed to one agent is almost
    // always a general-purpose credential the user's whole fleet needs.
    const service = new UserSecretsService(secretStorage);
    expect(await service.getSecretEnv('user-1', 'agent-b')).toEqual({ GH_TOKEN: 'ghp_all' });
  });

  it('keeps a key private only when --this-agent is explicit', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();

    const res = await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'ghp_private', agentOnly: true });
    expect(res.body).toMatchObject({ scope: 'agent' });

    const service = new UserSecretsService(secretStorage);
    expect(await service.getSecretEnv('user-1', 'agent-a')).toEqual({ GH_TOKEN: 'ghp_private' });
    // The whole point of scoping: agent-b's turns never see it.
    expect(await service.getSecretEnv('user-1', 'agent-b')).toEqual({});
  });

  it('tolerates the legacy shared flag, which now names the default', async () => {
    const { deps, tokenA } = await buildDeps();
    // Old CLI copies send `shared` explicitly; it must neither error nor
    // change the outcome.
    const res = await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'ghp_all', shared: true });
    expect(res.body).toMatchObject({ ok: true, scope: 'shared' });

    // `shared: false` from an old CLI meant "no flag typed", not "make it
    // private" — the flipped default applies to it too.
    const noFlag = await setSecret(deps, tokenA, { name: 'API_KEY', value: 'k', shared: false });
    expect(noFlag.body).toMatchObject({ ok: true, scope: 'shared' });
  });

  it('rotates in place rather than creating a second row', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();

    await setSecret(deps, tokenA, { name: 'API_KEY', value: 'old' });
    const rotated = await setSecret(deps, tokenA, { name: 'API_KEY', value: 'new' });
    expect(rotated.body).toMatchObject({ ok: true, created: false });

    expect(await new UserSecretsService(secretStorage).getSecretEnv('user-1', 'agent-a'))
      .toEqual({ API_KEY: 'new' });
    expect((await secretStorage.getUserSecrets('user-1')).length).toBe(1);
  });

  it('never returns a plaintext value from list', async () => {
    const { deps, tokenA } = await buildDeps();
    await setSecret(deps, tokenA, { name: 'API_KEY', value: 'super-secret-value-12345' });

    const res = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value-12345');
    expect((res.body as { secrets: unknown[] }).secrets).toEqual([
      expect.objectContaining({ name: 'API_KEY', scope: 'shared' }),
    ]);
  });

  it('identifies a PEM by its format, since every PEM masks to the same dashes', async () => {
    const { deps, tokenA } = await buildDeps();
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    await setSecret(deps, tokenA, { name: 'HETZNER_SSH_PRIVATE_KEY', value: key });

    const res = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), res);

    // What the CLI prints in its mask column: "---…--" told an agent nothing.
    expect((res.body as { secrets: Array<{ maskedValue: string }> }).secrets[0]?.maskedValue)
      .toBe(`OpenSSH private key (${[...key].length} chars)`);
    expect(JSON.stringify(res.body)).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('lists what this agent can see — its own plus shared, flagging an override', async () => {
    const { deps, tokenA, tokenB } = await buildDeps();
    await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'shared-one' });
    await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'agent-a-one', agentOnly: true });
    await setSecret(deps, tokenB, { name: 'B_ONLY', value: 'agent-b-one', agentOnly: true });

    const res = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), res);
    const secrets = (res.body as { secrets: Array<Record<string, unknown>> }).secrets;

    // Another agent's private secret is not this machine's business.
    expect(secrets.map((s) => s.name)).not.toContain('B_ONLY');
    // Both GH_TOKEN rows appear: the shared one is marked as overridden rather
    // than hidden, so "why is this agent using a different key?" is answerable.
    expect(secrets.filter((s) => s.name === 'GH_TOKEN')).toEqual([
      expect.objectContaining({ scope: 'agent' }),
      expect.objectContaining({ scope: 'shared', shadowedByAgentScope: true }),
    ]);
  });

  it('carries a description from set to list, and still accepts a bare legacy write', async () => {
    const { deps, tokenA } = await buildDeps();
    await setSecret(deps, tokenA, {
      name: 'CF_TOKEN', value: 'cf_x', description: 'Cloudflare token for deploying workers',
    });
    // A CLI from before descriptions existed sends no description — refusing
    // it would strand every machine still running the old install.
    await setSecret(deps, tokenA, { name: 'OLD_KEY', value: 'k' });

    const res = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), res);
    const secrets = (res.body as { secrets: Array<Record<string, unknown>> }).secrets;
    expect(secrets.find((s) => s.name === 'CF_TOKEN')?.description)
      .toBe('Cloudflare token for deploying workers');
    expect(secrets.find((s) => s.name === 'OLD_KEY')).not.toHaveProperty('description');
  });

  it('updates a description in place via PATCH, scope-specifically', async () => {
    const { deps, tokenA } = await buildDeps();
    await setSecret(deps, tokenA, { name: 'CF_TOKEN', value: 'cf_x', description: 'old purpose' });

    // No private copy exists: `--this-agent` must 404 rather than quietly
    // annotate the shared row.
    const missed = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({
        headers: authHeader(tokenA),
        params: { name: 'CF_TOKEN' },
        body: { description: 'private note', agentOnly: true },
      }),
      missed,
    );
    expect(missed.statusCode).toBe(404);

    const hit = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({
        headers: authHeader(tokenA),
        params: { name: 'CF_TOKEN' },
        body: { description: 'corrected purpose' },
      }),
      hit,
    );
    expect(hit.statusCode).toBe(200);

    const res = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenA) }), res);
    const secrets = (res.body as { secrets: Array<Record<string, unknown>> }).secrets;
    expect(secrets.find((s) => s.name === 'CF_TOKEN')?.description).toBe('corrected purpose');
  });

  it('rejects a PATCH without a usable description', async () => {
    const { deps, tokenA } = await buildDeps();
    await setSecret(deps, tokenA, { name: 'CF_TOKEN', value: 'cf_x', description: 'fine' });
    for (const body of [{}, { description: 42 }, { description: '   ' }, { description: 'x'.repeat(201) }]) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/secrets/:name', 'patch')(
        mockRequest({ headers: authHeader(tokenA), params: { name: 'CF_TOKEN' }, body }),
        res,
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a name that would collide with a platform credential or the runtime', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();
    await secretStorage.createSecret('user-1', { key: 'claude-oauth-token', value: 'platform-cred' });

    for (const name of ['claude-oauth-token', 'PATH', 'HOME', 'NODE_OPTIONS']) {
      const res = await setSecret(deps, tokenA, { name, value: 'attacker' });
      expect(res.statusCode, name).toBe(400);
    }

    // The harness's own credential is exactly as it was.
    expect((await secretStorage.getSecretByKey('user-1', 'claude-oauth-token'))?.value)
      .toBe('platform-cred');
  });

  it('rejects a malformed body before it reaches storage', async () => {
    const { deps, tokenA } = await buildDeps();
    for (const body of [{}, { name: 'A' }, { name: 'A', value: 42 }, { name: 'A', value: '' }]) {
      const res = await setSecret(deps, tokenA, body as never);
      expect(res.statusCode).toBe(400);
    }
  });

  it('deletes scope-specifically, and never falls back to the shared copy', async () => {
    const { deps, secretStorage, tokenA } = await buildDeps();
    await setSecret(deps, tokenA, { name: 'GH_TOKEN', value: 'shared-one' });

    // No private copy exists: `--this-agent` must 404 rather than quietly
    // delete the shared key every other agent depends on.
    const missed = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'delete')(
      mockRequest({
        headers: authHeader(tokenA),
        params: { name: 'GH_TOKEN' },
        query: { agentOnly: '1' },
      }),
      missed,
    );
    expect(missed.statusCode).toBe(404);
    expect(String((missed.body as { error: string }).error)).toContain('--this-agent');
    expect(await new UserSecretsService(secretStorage).getSecretEnv('user-1', 'agent-b'))
      .toEqual({ GH_TOKEN: 'shared-one' });

    const hit = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'delete')(
      mockRequest({ headers: authHeader(tokenA), params: { name: 'GH_TOKEN' } }),
      hit,
    );
    expect(hit.statusCode).toBe(200);
    expect(await new UserSecretsService(secretStorage).getSecretEnv('user-1', 'agent-b')).toEqual({});
  });

  it('requires a valid token, and 503s when the backend has no secret storage', async () => {
    const { deps, tokenA } = await buildDeps();

    const unauthenticated = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({}), unauthenticated);
    expect(unauthenticated.statusCode).toBe(401);

    const { userStorage } = deps as { userStorage: InMemoryUserStorage };
    const unconfigured = createMockResponse();
    await getRouteHandler({ userStorage }, '/secrets', 'get')(
      mockRequest({ headers: authHeader(tokenA) }),
      unconfigured,
    );
    expect(unconfigured.statusCode).toBe(503);
  });
});

// Note #783: `agentbuilt secret rooms` limited a shared key to some rooms.
// Gone with rooms (note #843): what an older CLI that still asks meets now.
describe('agent-cli secret rooms (notes #783, #843)', () => {
  it('asking for a limit is told rooms are gone, and the key still reaches every agent (note #843)', async () => {
    const { deps, secretStorage, tokenA, tokenB } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin' });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = new OrgGitService({ orgStorage });
    // As wired in production: every namespace the workplace ever had maps to its one set.
    deps.secretStorage = new ShelfMappedSecretStorage(secretStorage, (namespaceId) => deps.orgGit!.secretShelfFor(namespaceId));
    const service = new UserSecretsService(secretStorage);
    await service.setSecret(org.orgId, 'GH', 'g', SHARED_USER_SECRET_SCOPE, 'github');

    // `secret rooms` from an older CLI, even from an admin's agent.
    const asked = createMockResponse();
    await getRouteHandler(deps, '/secrets/:name', 'patch')(
      mockRequest({ headers: authHeader(tokenA), params: { name: 'GH' }, body: { rooms: ['Platform'] } }), asked);
    expect(asked.statusCode).toBe(410);
    expect((asked.body as { error: string }).error).toContain('Rooms are gone');
    // Nothing changed: the other agent lists the key plainly and is handed it.
    const list = createMockResponse();
    await getRouteHandler(deps, '/secrets', 'get')(mockRequest({ headers: authHeader(tokenB) }), list);
    const rows = (list.body as { secrets: Array<Record<string, unknown>> }).secrets;
    expect(rows.map((row) => row.name)).toEqual(['GH']);
    for (const row of rows) {
      expect(row).not.toHaveProperty('rooms');
      expect(row).not.toHaveProperty('offRoom');
    }
    expect(await service.getSecretEnv(org.orgId, 'agent-b', { ownerIsAdmin: true })).toEqual({ GH: 'g' });
  });
});
