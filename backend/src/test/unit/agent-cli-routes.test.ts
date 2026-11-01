import { describe, expect, it, vi } from 'vitest';
import { workspaceAssistantId } from '../../types/user.js';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import type { DeploymentService } from '../../services/deployment-service.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { UserSecretsService, agentUserSecretScope } from '../../services/user-secrets.js';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';

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
  response.type = (() => response as Response) as never;
  response.send = ((payload: unknown) => {
    response.body = payload;
    return response as Response;
  }) as Response['send'];
  return response;
}

/** The route's FINAL handler (skipping body-parser middleware layers). */
function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post' | 'put',
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

async function buildDeps() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        'agent-a': {
          id: 'agent-a', name: 'Ben', cli: 'claude',
          agentbuiltTokenHash: tokenHash,
        } as never,
      },
    },
  });
  const deploymentStorage = new InMemoryDeploymentStorage();
  const staged = new Map<string, Buffer>();
  const deploymentService = {
    url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`,
    createPending: vi.fn(async (args: never) => deploymentStorage.create({
      ...(args as object), status: 'pending-payment',
    } as never)),
    stageTarball: vi.fn(async (id: string, tarGz: Buffer) => { staged.set(id, tarGz); }),
    syncTarball: vi.fn(async () => {}),
    readLogs: vi.fn(async () => 'the logs'),
    restart: vi.fn(async () => {}),
    // The real one adds a certificate and a CNAME; what the ROUTE owes is
    // ownership, a name to move to, and the old address in the answer.
    rename: vi.fn(async (id: string, to: string) => {
      const before = (await deploymentStorage.get(id))!;
      await deploymentStorage.update(id, {
        name: to,
        formerNames: [...(before.formerNames ?? []), before.name],
      });
      return {
        deployment: (await deploymentStorage.get(id))!,
        url: `https://${to}.agentbuilt.app`,
        previousUrl: `https://${before.name}.agentbuilt.app`,
      };
    }),
  };
  // The real one marks the record and builds in the background; what the
  // ROUTE owes is starting it, so the mock reports what it was asked to do.
  const hostingFulfilment = {
    startBringUp: vi.fn(async (id: string) => {
      const doc = await deploymentStorage.get(id);
      return doc?.status === 'payment-lapsed' ? 'resuming' as const : 'provisioning' as const;
    }),
    startResize: vi.fn(async () => true),
  };
  const deps: Partial<RouteDeps> = {
    userStorage,
    deploymentStorage,
    deploymentService: deploymentService as unknown as DeploymentService,
    hostingFulfilment,
  };
  return { deps, token, deploymentStorage, deploymentService, staged, userStorage, hostingFulfilment };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const gzBody = Buffer.from('fake-tarball');

describe('agent-cli auth', () => {
  it('rejects missing, malformed, and rotated tokens', async () => {
    const { deps, token, userStorage } = await buildDeps();
    const list = getRouteHandler(deps, '/deployments', 'get');

    let res = createMockResponse();
    await list(mockRequest({}), res);
    expect(res.statusCode).toBe(401);

    res = createMockResponse();
    await list(mockRequest({ headers: authHeader('agb1.garbage.x') }), res);
    expect(res.statusCode).toBe(401);

    // Rotation: a NEW mint replaces the stored hash, so the old token dies.
    const rotated = mintAgentbuiltToken('user-1', 'agent-a');
    await userStorage.updateAgentFields('user-1', 'agent-a', {
      agentbuiltTokenHash: rotated.tokenHash,
    });
    res = createMockResponse();
    await list(mockRequest({ headers: authHeader(token) }), res);
    expect(res.statusCode).toBe(401);

    res = createMockResponse();
    await list(mockRequest({ headers: authHeader(rotated.token) }), res);
    expect(res.statusCode).toBe(200);
  });

  it('a REAL agent presenting a mismatched token flags the record for a forced identity rewrite', async () => {
    // The deploy-interrupted-write wedge (live, 2026-08-26): machine and
    // record hold different tokens, identityVersion already current, so
    // WITHOUT this flag no rewrite ever fires and the machine is locked out
    // of the CLI forever while every health check reads fine.
    const { deps, token, userStorage } = await buildDeps();
    const list = getRouteHandler(deps, '/deployments', 'get');

    const rotated = mintAgentbuiltToken('user-1', 'agent-a');
    await userStorage.updateAgentFields('user-1', 'agent-a', {
      agentbuiltTokenHash: rotated.tokenHash,
    });
    const res = createMockResponse();
    await list(mockRequest({ headers: authHeader(token) }), res);
    expect(res.statusCode).toBe(401);
    const agent = (await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!;
    expect(agent.agentbuiltTokenStale).toBe(true);

    // A MALFORMED or unknown-agent token never flags anyone — only the
    // real-agent-wrong-hash shape is the wedge.
    const stranger = mintAgentbuiltToken('user-1', 'agent-zz');
    const res2 = createMockResponse();
    await list(mockRequest({ headers: authHeader(stranger.token) }), res2);
    expect(res2.statusCode).toBe(401);
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-zz']).toBeUndefined();

    // The identity writer's stamp clears the flag with `null` — proven at
    // the storage layer here, wired in writeTelegramAgentIdentity.
    await userStorage.updateAgentFields('user-1', 'agent-a', { agentbuiltTokenStale: null });
    const cleared = (await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!;
    expect(cleared.agentbuiltTokenStale).toBeUndefined();
  });

  it('503s when hosting is not configured, but only after auth passes', async () => {
    const { deps, token } = await buildDeps();
    delete deps.deploymentService;
    const list = getRouteHandler(deps, '/deployments', 'get');
    const res = createMockResponse();
    await list(mockRequest({ headers: authHeader(token) }), res);
    expect(res.statusCode).toBe(503);
  });
});

describe('deploy --secret (note #661)', () => {
  async function secretWorld() {
    const built = await buildDeps();
    const secretStorage = new InMemorySecretStorage();
    // No org layer here: the agent's secrets live under its user id, and it is its own admin.
    await new UserSecretsService(secretStorage).setSecret('user-1', 'TELEGRAM_BOT_TOKEN', 'tg-value');
    await new UserSecretsService(secretStorage).setSecret('user-1', 'OTHER_AGENT_KEY', 'x', agentUserSecretScope('agent-b'));
    built.deps.secretStorage = secretStorage;
    const setSecretEnv = vi.fn(async () => true);
    (built.deploymentService as Record<string, unknown>).setSecretEnv = setSecretEnv;
    return { ...built, secretStorage, setSecretEnv };
  }
  const deployAs = async (deps: Partial<RouteDeps>, token: string, headers: Record<string, string>) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(mockRequest({
      headers: { ...authHeader(token), ...headers }, body: gzBody,
    }), res);
    return res;
  };

  it('records the names on a new service, never a value, and says how the app reads them', async () => {
    const { deps, token, deploymentStorage } = await secretWorld();
    const res = await deployAs(deps, token, {
      'x-agentbuilt-name': 'air-bot', 'x-agentbuilt-preset': 'service', 'x-agentbuilt-line': 'What%20it%20does', 'x-agentbuilt-secrets': 'TELEGRAM_BOT_TOKEN',
    });
    expect(res.statusCode).toBe(200);
    const doc = (await deploymentStorage.getByName('air-bot'))!;
    expect(doc.secretNames).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(JSON.stringify(doc)).not.toContain('tg-value');
    expect(JSON.stringify(res.body)).not.toContain('tg-value');
    expect((res.body as { message: string }).message).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('refuses a key the deploying agent is not handed, before anything is created or synced', async () => {
    const { deps, token, deploymentStorage, deploymentService } = await secretWorld();
    const res = await deployAs(deps, token, {
      'x-agentbuilt-name': 'air-bot', 'x-agentbuilt-preset': 'service', 'x-agentbuilt-line': 'What%20it%20does', 'x-agentbuilt-secrets': 'OTHER_AGENT_KEY',
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { missingSecrets: string[] }).missingSecrets).toEqual(['OTHER_AGENT_KEY']);
    expect(await deploymentStorage.getByName('air-bot')).toBeNull();
    expect(deploymentService.createPending).not.toHaveBeenCalled();
  });

  it('refuses secrets on a static site', async () => {
    const { deps, token } = await secretWorld();
    const res = await deployAs(deps, token, {
      'x-agentbuilt-name': 'air-page', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does', 'x-agentbuilt-secrets': 'TELEGRAM_BOT_TOKEN',
    });
    expect(res.statusCode).toBe(400);
  });

  it('a redeploy keeps the list and re-reads its values, --no-secrets clears it', async () => {
    const { deps, token, deploymentStorage, deploymentService, setSecretEnv } = await secretWorld();
    const live = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'air-bot', preset: 'service', status: 'live', secretNames: ['TELEGRAM_BOT_TOKEN'],
    });

    const kept = await deployAs(deps, token, { 'x-agentbuilt-name': 'air-bot' });
    expect(kept.statusCode).toBe(200);
    expect(deploymentService.syncTarball).toHaveBeenCalledWith(live.id, gzBody);
    expect(setSecretEnv).toHaveBeenLastCalledWith(live.id, { TELEGRAM_BOT_TOKEN: 'tg-value' }, ['TELEGRAM_BOT_TOKEN']);
    expect((await deploymentStorage.get(live.id))!.secretNames).toEqual(['TELEGRAM_BOT_TOKEN']);

    const cleared = await deployAs(deps, token, { 'x-agentbuilt-name': 'air-bot', 'x-agentbuilt-no-secrets': 'true' });
    expect(cleared.statusCode).toBe(200);
    expect(setSecretEnv).toHaveBeenLastCalledWith(live.id, {}, ['TELEGRAM_BOT_TOKEN']);
    expect((await deploymentStorage.get(live.id))!.secretNames).toBeUndefined();

    // Nothing to set and nothing to take off: the machine is not touched.
    setSecretEnv.mockClear();
    await deployAs(deps, token, { 'x-agentbuilt-name': 'air-bot' });
    expect(setSecretEnv).not.toHaveBeenCalled();
  });

  it('refuses a redeploy by an agent that is not handed the keys the site runs with', async () => {
    const { deps, token, deploymentStorage, deploymentService } = await secretWorld();
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'air-bot', preset: 'service', status: 'live', secretNames: ['OTHER_AGENT_KEY'],
    });
    const res = await deployAs(deps, token, { 'x-agentbuilt-name': 'air-bot' });
    expect(res.statusCode).toBe(400);
    expect(deploymentService.syncTarball).not.toHaveBeenCalled();
  });
});

describe('member-agent workplace permissions', () => {
  async function memberWorld() {
    const built = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'member' });
    await built.userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    built.deps.orgStorage = orgStorage;
    built.deps.orgSpend = { report: vi.fn(async () => ({ orgId: org.orgId })) } as never;
    return { ...built, orgStorage, org };
  }

  it('can redeploy an existing live org site, but cannot create, revive, resize or delete infrastructure', async () => {
    const { deps, token, deploymentStorage, deploymentService, org } = await memberWorld();
    const live = await deploymentStorage.create({
      orgId: org.orgId, userId: 'user-1', agentId: 'agent-a', name: 'live-site', preset: 'static', status: 'live',
    });
    await deploymentStorage.create({
      orgId: org.orgId, userId: 'user-1', agentId: 'agent-a', name: 'paused-site', preset: 'static', status: 'payment-lapsed',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');

    const update = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'live-site' }, body: gzBody,
    }), update);
    expect(update.statusCode).toBe(200);
    expect(deploymentService.syncTarball).toHaveBeenCalledWith(live.id, gzBody);

    for (const name of ['new-site', 'paused-site']) {
      const denied = createMockResponse();
      await deploy(mockRequest({
        headers: {
          ...authHeader(token), 'x-agentbuilt-name': name, 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does',
        },
        body: gzBody,
      }), denied);
      expect(denied.statusCode).toBe(403);
    }

    const upgrade = createMockResponse();
    await getRouteHandler(deps, '/deployments/:name/upgrade', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'live-site' } }), upgrade);
    expect(upgrade.statusCode).toBe(403);
    const deletion = createMockResponse();
    await getRouteHandler(deps, '/deployments/:name/delete', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'live-site' } }), deletion);
    expect(deletion.statusCode).toBe(403);
  });

  it('refuses every command while an admin’s deletion of the workplace stands (2026-09-22)', async () => {
    const { deps, token, deploymentService, org, orgStorage } = await memberWorld();
    await orgStorage.updateOrg(org.orgId, {
      deletion: {
        requestedAt: '2026-09-22T10:00:00Z', requestedByUserId: 'admin', requestedByName: 'Saddam',
        purgeAt: '2026-09-29T10:00:00Z',
      },
    });
    const listed = createMockResponse();
    await getRouteHandler(deps, '/deployments', 'get')(mockRequest({ headers: authHeader(token) }), listed);
    expect(listed.statusCode).toBe(403);
    expect(listed.body).toEqual({ error: 'Acme is being deleted, so its agents are stopped.' });
    const deploy = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'new-site', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' }, body: gzBody,
    }), deploy);
    expect(deploy.statusCode).toBe(403);
    expect(deploymentService.syncTarball).not.toHaveBeenCalled();

    // Kept: the same agent works again.
    await orgStorage.updateOrg(org.orgId, { deletion: undefined });
    const again = createMockResponse();
    await getRouteHandler(deps, '/deployments', 'get')(mockRequest({ headers: authHeader(token) }), again);
    expect(again.statusCode).toBe(200);
  });

  it('cannot inspect workplace spending', async () => {
    const { deps, token } = await memberWorld();
    const res = createMockResponse();
    await getRouteHandler(deps, '/org/spend', 'get')(mockRequest({ headers: authHeader(token) }), res);
    expect(res.statusCode).toBe(403);
  });

  /**
   * `agentbuilt usage` (note #719) is the owner's subscription usage, and an
   * agent owned by a plain member reads it: the figures are its owner's
   * own, read on the credential's user, and nobody else's row or key rides
   * along.
   */
  it('reads its own owner\'s subscription usage — the ledger split by agent and the seats\' readings, never a key', async () => {
    const { deps, token, orgStorage, org } = await memberWorld();
    const ledger = new InMemoryAgentTokenLedger();
    const day = new Date().toISOString().slice(0, 10);
    const base = { userId: 'user-1', orgId: org.orgId, day, provider: 'claude' as const, model: 'claude-opus-5-5', input: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    ledger.credit({ ...base, agentId: 'agent-a', agentName: 'Ben (old name)', output: 500 });
    ledger.credit({ ...base, agentId: 'agent-gone', agentName: 'Theo', output: 40 });
    ledger.credit({ ...base, userId: 'admin', agentId: 'agent-x', agentName: 'Zed', output: 9999 });
    deps.agentTokenLedger = ledger;
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude', token: 'sk-ant-oat01-SECRET', label: 'my Max', status: 'active',
      usageRefreshedAt: new Date().toISOString(),
      usage: { capturedAt: new Date().toISOString(), planType: 'max_5x', windows: { five_hour: { id: 'five_hour', usedPercent: 33, resetsAt: 1_791_727_200 } } },
    });
    const refreshSeatUsage = vi.fn(async () => {});
    deps.refreshSeatUsage = refreshSeatUsage;

    const res = createMockResponse();
    await getRouteHandler(deps, '/usage', 'get')(mockRequest({ headers: authHeader(token), query: { weeks: '2' } }), res);
    expect(res.statusCode).toBe(200);
    const answer = res.body as { weeks: Array<{ providers: Array<{ models: Array<{ agents: Array<Record<string, unknown>> }> }> }>; plans: Array<Record<string, unknown>> };
    const agents = answer.weeks[0]!.providers[0]!.models[0]!.agents;
    expect(agents).toEqual([
      expect.objectContaining({ agentId: 'agent-a', name: 'Ben', output: 500 }),
      expect.objectContaining({ agentId: 'agent-gone', name: 'Theo', deleted: true, output: 40 }),
    ]);
    // Rooms are gone (note #843): a live agent is named by its name alone.
    expect(agents[0]).not.toHaveProperty('room');
    expect(answer.plans).toEqual([expect.objectContaining({
      provider: 'claude', label: 'my Max', planText: 'Max 5x', inThisWorkplace: true, primary: true,
      windows: [expect.objectContaining({ label: '5 hours', percentText: '33', resetsText: 'Oct 11, 14:00 UTC' })],
    })]);
    // Fresh reading: nothing to refresh. Another owner's agent: not here. The seat's credential: never.
    expect(refreshSeatUsage).not.toHaveBeenCalled();
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain('Zed');
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('token');
  });
});

/**
 * The retired row-line verbs (agent-row-recap-design, 2026-08-25). The row's
 * recap is written by a post-turn summarizer now, so these routes are quiet
 * no-ops for the CLIs still fielded on machines that have not taken a turn
 * since the bump: auth still counts, nothing is stored, and the reply carries
 * the message old CLIs print, so a stale agent learns the change from words
 * rather than an error.
 */
describe('agent-cli retired row-line verbs', () => {
  const call = async (deps: Partial<RouteDeps>, token: string, route: string, method: 'get' | 'put', body?: unknown) => {
    const handler = getRouteHandler(deps, route, method);
    const res = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), ...(body !== undefined ? { body } : {}) }), res);
    return res;
  };

  it('accepts PUT /about without storing anything, and says why', async () => {
    const { deps, token, userStorage } = await buildDeps();
    const res = await call(deps, token, '/about', 'put', { about: 'Keeps the garden game' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { retired: boolean }).retired).toBe(true);
    expect((res.body as { message: string }).message).toContain('Retired');
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.about).toBeUndefined();
  });

  it('accepts PUT /task without storing anything — the platform-written NOW line survives', async () => {
    const { deps, token, userStorage } = await buildDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', {
      tasks: [{ text: 'Read the site. We should make it professional', at: '2026-08-16T09:00:00.000Z' }],
    });
    const res = await call(deps, token, '/task', 'put', { text: 'Rewriting the header links' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { retired: boolean }).retired).toBe(true);
    // The turn-start line is untouched: it is still what feeds the NOW row.
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a']?.tasks).toEqual([
      { text: 'Read the site. We should make it professional', at: '2026-08-16T09:00:00.000Z' },
    ]);
  });

  it('answers GET /task with the empty shape old CLIs print as "no job yet"', async () => {
    const { deps, token, userStorage } = await buildDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', {
      tasks: [{ text: 'Rewriting the header links', at: '2026-08-16T09:00:00.000Z' }],
    });
    const res = await call(deps, token, '/task', 'get');
    expect(res.statusCode).toBe(200);
    // Deliberately NOT the stored entries: an old CLI that reads a line here
    // would tell its agent the verb still works.
    expect(res.body).toEqual({ ok: true, tasks: [], retired: true });
  });

  it('still authenticates — a bad token is a 401, not a polite no-op', async () => {
    const { deps } = await buildDeps();
    for (const [route, method] of [['/about', 'put'], ['/task', 'put'], ['/task', 'get']] as const) {
      const res = await call(deps, 'not-a-token', route, method, {});
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('agent-cli deploy', () => {
  it('a new name is built straight away, with its content staged first', async () => {
    const { deps, token, deploymentStorage, staged, hostingFulfilment } = await buildDeps();
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      deployment: { status: string; kind: string; priceUsdPerMonth?: number };
      checkoutUrl?: unknown;
      message: string;
    };
    expect(body.deployment.status).toBe('provisioning');
    expect(body.deployment.kind).toBe('static');
    // The two things that used to be here, and must never come back: a price
    // for the site, and a link for the user to pay it with.
    expect(body.deployment.priceUsdPerMonth).toBeUndefined();
    expect(body.checkoutUrl).toBeUndefined();
    expect(body.message).not.toContain('$');
    const doc = await deploymentStorage.getByName('ember');
    expect(doc?.userId).toBe('user-1');
    expect(doc?.agentId).toBe('agent-a');
    // Staged BEFORE the build starts, so the address never serves an empty
    // machine — provisioning picks the tarball up on its way to live.
    expect(staged.get(doc!.id)).toEqual(gzBody);
    expect(hostingFulfilment.startBringUp).toHaveBeenCalledWith(doc!.id);
  });

  it('counts sites per kind on the wire, with no limit to hit', async () => {
    // Per-plan allowances retired with the pricing ladder (org-layer-design):
    // the wire still carries the counts an agent plans around, and `limit`
    // is always null — "no limit" — never a number to trip over.
    const { deps, token, deploymentStorage } = await buildDeps();
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'first', preset: 'static', status: 'live',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');

    let res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'app', 'x-agentbuilt-preset': 'service', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    // Counted AFTER the deploy it just made, exactly as before.
    expect((res.body as { quota: unknown }).quota).toEqual({
      static: { used: 1, limit: null },
      service: { used: 1, limit: null },
    });

    // A second static site simply deploys — there is no allowance to refuse it.
    res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'second', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    expect(await deploymentStorage.getByName('second')).not.toBeNull();
  });

  it('reports no limit and keeps going at any count', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    for (const name of ['one', 'two', 'three']) {
      await deploymentStorage.create({
        userId: 'user-1', agentId: 'agent-a', name, preset: 'static', status: 'live',
      });
    }
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'four', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    // Infinity is not JSON; null is how "no limit" survives the wire.
    expect((res.body as { quota: { static: unknown } }).quota.static).toEqual({ used: 4, limit: null });
  });

  it('a paused name stages the new content and starts the site back up', async () => {
    const { deps, token, deploymentStorage, deploymentService, staged, hostingFulfilment } = await buildDeps();
    const doc = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'payment-lapsed',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    // Nothing to sync to yet — the content waits and the resume delivers it.
    expect(deploymentService.syncTarball).not.toHaveBeenCalled();
    expect(staged.get(doc.id)).toEqual(gzBody);
    expect(hostingFulfilment.startBringUp).toHaveBeenCalledWith(doc.id);
    expect((res.body as { message: string }).message).toContain('starting back up');
  });

  it('a paused site revives beside other live sites — there is no allowance to block it', async () => {
    // The plan-era refusal ("bringing it back would put the account over")
    // retired with the allowances: content stages and the bring-up runs.
    const { deps, token, deploymentStorage, hostingFulfilment } = await buildDeps();
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'kept', preset: 'static', status: 'live',
    });
    const doc = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'payment-lapsed',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    expect(hostingFulfilment.startBringUp).toHaveBeenCalledWith(doc.id);
  });

  it('a live name owned by the caller redeploys immediately', async () => {
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    const doc = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'live',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    expect(deploymentService.syncTarball).toHaveBeenCalledWith(doc.id, gzBody);
    expect((res.body as { message: string }).message).toContain('https://ember.agentbuilt.app');
  });

  it("someone else's name is a conflict, and a preset can't change on redeploy", async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    await deploymentStorage.create({
      userId: 'user-2', agentId: 'x', name: 'taken', preset: 'static', status: 'live',
    });
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'live',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');

    let res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'taken', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(409);
    // The conflict answer carries live alternatives, so the agent can resolve
    // it in one reply instead of guessing.
    const conflict = res.body as { error: string; suggestions: string[] };
    expect(conflict.suggestions[0]).toBe('taken-2');
    expect(conflict.error).toContain('taken-2');

    res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember', 'x-agentbuilt-preset': 'service', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('preset');
  });

  it('rejects denylisted names, empty bodies, and a missing preset on first deploy', async () => {
    const { deps, token } = await buildDeps();
    const deploy = getRouteHandler(deps, '/deploy', 'post');

    let res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'my-login', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(400);

    res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: Buffer.alloc(0),
    }), res);
    expect(res.statusCode).toBe(400);

    res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('--preset');
  });
});

describe('agent-cli upgrade', () => {
  const seed = async (
    storage: InMemoryDeploymentStorage,
    overrides: Record<string, unknown> = {},
  ) => storage.create({
    userId: 'user-1', agentId: 'agent-a', name: 'app-1', preset: 'service',
    status: 'live', flyApp: 'iapp-abc', machineId: 'm1',
    ...overrides,
  } as never);

  it('a live service moves to the bigger machine itself — no card, no charge', async () => {
    const { deps, token, deploymentStorage, hostingFulfilment } = await buildDeps();
    const doc = await seed(deploymentStorage);
    const upgrade = getRouteHandler(deps, '/deployments/:name/upgrade', 'post');

    const res = createMockResponse();
    await upgrade(mockRequest({ headers: authHeader(token), params: { name: 'app-1' } }), res);

    expect(res.statusCode).toBe(200);
    expect(hostingFulfilment.startResize).toHaveBeenCalledWith(doc.id, 'service-pro');
    const message = (res.body as { message: string }).message;
    expect(message).toContain('1 GB');
    expect(message).toContain('nothing extra');
    // No price anywhere, and nobody was asked to tap anything.
    expect(message).not.toContain('$');
    expect(message).not.toContain('confirmation');
  });

  it('a service-pro machine counts as a service, not a kind of its own', async () => {
    // The whole point of counting KINDS: a bigger machine is not another app.
    const { deps, token, deploymentStorage } = await buildDeps();
    await seed(deploymentStorage, { name: 'app-1', preset: 'service-pro' });
    const list = getRouteHandler(deps, '/deployments', 'get');
    const res = createMockResponse();
    await list(mockRequest({ headers: authHeader(token) }), res);
    expect((res.body as { quota: { service: unknown } }).quota.service).toEqual({ used: 1, limit: null });
  });

  it('a site that was never built just changes size', async () => {
    const { deps, token, deploymentStorage, hostingFulfilment } = await buildDeps();
    const doc = await seed(deploymentStorage, { status: 'pending-payment', flyApp: undefined, machineId: undefined });
    const upgrade = getRouteHandler(deps, '/deployments/:name/upgrade', 'post');

    const res = createMockResponse();
    await upgrade(mockRequest({ headers: authHeader(token), params: { name: 'app-1' } }), res);

    expect(res.statusCode).toBe(200);
    expect((await deploymentStorage.get(doc.id))?.preset).toBe('service-pro');
    // Nothing is running, so there is nothing to resize.
    expect(hostingFulfilment.startResize).not.toHaveBeenCalled();
  });

  it('static sites and already-pro sites have nowhere to go', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    await seed(deploymentStorage, { name: 'site-1', preset: 'static' });
    await seed(deploymentStorage, { name: 'app-pro', preset: 'service-pro' });
    const upgrade = getRouteHandler(deps, '/deployments/:name/upgrade', 'post');

    let res = createMockResponse();
    await upgrade(mockRequest({ headers: authHeader(token), params: { name: 'site-1' } }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('static');

    res = createMockResponse();
    await upgrade(mockRequest({ headers: authHeader(token), params: { name: 'app-pro' } }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('already');
  });

  it('a backend that cannot build is a 503, not a silent no-op', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    delete deps.hostingFulfilment;
    await seed(deploymentStorage);
    const upgrade = getRouteHandler(deps, '/deployments/:name/upgrade', 'post');

    const res = createMockResponse();
    await upgrade(mockRequest({ headers: authHeader(token), params: { name: 'app-1' } }), res);
    expect(res.statusCode).toBe(503);
  });

  it('deploy accepts --preset service-pro for a new name, on the service allowance', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    const deploy = getRouteHandler(deps, '/deploy', 'post');
    const res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'big-app', 'x-agentbuilt-preset': 'service-pro', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { deployment: { preset: string; kind: string } }).deployment).toMatchObject({
      preset: 'service-pro', kind: 'service',
    });
    expect((await deploymentStorage.getByName('big-app'))?.preset).toBe('service-pro');
  });
});

describe('agent-cli rename', () => {
  const seed = async (storage: InMemoryDeploymentStorage, overrides: Record<string, unknown> = {}) =>
    storage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'eldiyar-math', preset: 'service',
      status: 'live', flyApp: 'iapp-abc', machineId: 'm1', ...overrides,
    } as never);

  it('an agent renames its own site, and is told the old address still serves', async () => {
    // No confirmation card, unlike `upgrade`: a rename moves no money and
    // breaks no link, so there is nothing for the user to rescue. What the
    // answer must carry is the old URL — an agent that does not know the old
    // address survived will go and warn its user about nothing.
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    const doc = await seed(deploymentStorage);
    const rename = getRouteHandler(deps, '/deployments/:name/rename', 'post');

    const res = createMockResponse();
    await rename(mockRequest({
      headers: authHeader(token), params: { name: 'eldiyar-math' }, body: { to: 'school' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      name: 'school',
      url: 'https://school.agentbuilt.app',
      previousUrl: 'https://eldiyar-math.agentbuilt.app',
      formerNames: ['eldiyar-math'],
    });
    expect(deploymentService.rename).toHaveBeenCalledWith(doc.id, 'school');
    expect((await deploymentStorage.get(doc.id))?.name).toBe('school');
  });

  it('will not rename a site the caller does not own, and asks for a name when none is given', async () => {
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    await deploymentStorage.create({ userId: 'user-2', agentId: 'x', name: 'theirs', preset: 'static', status: 'live' });
    await seed(deploymentStorage);
    const rename = getRouteHandler(deps, '/deployments/:name/rename', 'post');

    let res = createMockResponse();
    await rename(mockRequest({ headers: authHeader(token), params: { name: 'theirs' }, body: { to: 'mine-now' } }), res);
    expect(res.statusCode).toBe(404);

    res = createMockResponse();
    await rename(mockRequest({ headers: authHeader(token), params: { name: 'eldiyar-math' }, body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('rename <name> <new-name>');

    expect(deploymentService.rename).not.toHaveBeenCalled();
  });

  it('passes the service’s refusal through as a 409 rather than a 500', async () => {
    // Taken names, phishing-shaped names and destroyed sites all arrive here
    // as an Error from the service; the agent needs to read the reason.
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    await seed(deploymentStorage);
    deploymentService.rename.mockRejectedValueOnce(new Error('"shop" is already taken.'));
    const rename = getRouteHandler(deps, '/deployments/:name/rename', 'post');

    const res = createMockResponse();
    await rename(mockRequest({
      headers: authHeader(token), params: { name: 'eldiyar-math' }, body: { to: 'shop' },
    }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('already taken');
  });
});

describe('deleting a site', () => {
  it('records the ask and never removes anything itself', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    const site = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'live',
    });
    const ask = getRouteHandler(deps, '/deployments/:name/delete', 'post');

    const res = createMockResponse();
    await ask(mockRequest({ headers: authHeader(token), params: { name: 'ember' } }), res);

    expect(res.statusCode).toBe(202);
    // The site is untouched: an agent may ask and nothing more, exactly as
    // with a repository. The owner's workspace is the only place it goes.
    const after = (await deploymentStorage.get(site.id))!;
    expect(after.status).toBe('live');
    expect(after.deleteAsk?.byAgentId).toBe('agent-a');
    // And the answer tells the agent the two things it cannot work out from
    // the record: the slot comes back, and the address stays reserved.
    const body = res.body as { message: string };
    expect(body.message).toContain('slot');
    expect(body.message).toContain('reserved');
  });

  it('refuses to ask about somebody else’s site', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    await deploymentStorage.create({
      userId: 'someone-else', agentId: 'agent-z', name: 'theirs', preset: 'static', status: 'live',
    });
    const ask = getRouteHandler(deps, '/deployments/:name/delete', 'post');

    const res = createMockResponse();
    await ask(mockRequest({ headers: authHeader(token), params: { name: 'theirs' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('a deleted site keeps its name', () => {
  it('lets the former owner redeploy to it and refuses everybody else', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    // The tombstone a delete leaves behind: infra gone, record kept.
    await deploymentStorage.create({
      userId: 'someone-else', agentId: 'agent-z', name: 'shop', preset: 'static',
      status: 'destroyed', destroyedAt: '2026-08-17T00:00:00Z',
    });
    const deploy = getRouteHandler(deps, '/deploy', 'post');

    // A stranger must never inherit the address: every link its owner handed
    // out would start answering with somebody else's site.
    let res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'shop', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('already taken');

    // Its own owner deploys over their tombstone as a normal first deploy —
    // which is what makes a delete something you can undo by rebuilding.
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'mine', preset: 'static',
      status: 'destroyed', destroyedAt: '2026-08-17T00:00:00Z',
    });
    res = createMockResponse();
    await deploy(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'mine', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does' },
      body: gzBody,
    }), res);
    expect(res.statusCode).toBe(200);
  });

  it('never suggests a name whose tombstone belongs to somebody else', async () => {
    const { suggestAlternateNames } = await import('../../routes/agent-cli.js');
    const storage = new InMemoryDeploymentStorage();
    await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'live' });
    // ember-2 is a stranger's deleted site. Offering it would send the agent
    // straight into the 409 the deploy path now raises.
    await storage.create({
      userId: 'stranger', agentId: 'a', name: 'ember-2', preset: 'static', status: 'destroyed',
    });
    // ember-3 is the asker's own, which they may have back.
    await storage.create({
      userId: 'u', agentId: 'a', name: 'ember-3', preset: 'static', status: 'destroyed',
    });

    const suggestions = await suggestAlternateNames(storage, 'ember', 3, 'u');
    expect(suggestions).not.toContain('ember-2');
    expect(suggestions[0]).toBe('ember-3');
  });
});

describe('suggestAlternateNames', () => {
  it('prefers numbered variants and falls back to random suffixes when those are taken too', async () => {
    const { suggestAlternateNames } = await import('../../routes/agent-cli.js');
    const storage = new InMemoryDeploymentStorage();
    await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'live' });
    for (let n = 2; n <= 9; n += 1) {
      await storage.create({ userId: 'u', agentId: 'a', name: `ember-${n}`, preset: 'static', status: 'live' });
    }
    const suggestions = await suggestAlternateNames(storage, 'ember');
    expect(suggestions.length).toBeGreaterThan(0);
    // All numbered slots taken → every suggestion is a random-suffix variant,
    // and each is genuinely free and valid.
    for (const s of suggestions) {
      expect(s).toMatch(/^ember-[0-9a-f]{4}$/);
      expect(await storage.getByName(s)).toBeNull();
    }
  });
});

/**
 * Sites belong to the WORKPLACE (note #566), as repositories and Drive do.
 * Three facts carry it: every agent lists and reaches every site of its
 * workplace; the public address is still ONE global namespace, so another
 * WORKPLACE's name stays a blind "taken"; and because a redeploy is public at
 * once with no approval, taking over a live site another agent deployed needs
 * one deliberate word.
 */
describe('agent-cli sites belong to the workplace (note #566)', () => {
  /** The fixture above, with the agent in a stamped org. */
  async function buildWorkplaceDeps() {
    const built = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await built.userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    built.deps.orgStorage = orgStorage;
    built.deps.orgGit = new OrgGitService({ orgStorage });
    return { ...built, orgId: org.orgId };
  }

  const deploy = async (
    deps: Partial<RouteDeps>, token: string, name: string, extra: Record<string, string> = {},
  ) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(
      mockRequest({
        headers: { ...authHeader(token), 'x-agentbuilt-name': name, 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does', ...extra },
        body: gzBody,
      }), res,
    );
    return res;
  };

  it('a hosted workplace holds thirty live sites: the list says so, and the thirty-first is refused (notes #664, #771)', async () => {
    const { deps, token, deploymentStorage, orgId } = await buildWorkplaceDeps();
    for (let i = 0; i < 29; i += 1) {
      await deploymentStorage.create({
        userId: 'user-1', orgId, agentId: 'agent-a', name: `site-${i}`, preset: i < 27 ? 'static' : 'service', status: 'live',
      });
    }
    // A site that no longer holds a machine is not one of the thirty.
    await deploymentStorage.create({ userId: 'user-1', orgId, agentId: 'agent-a', name: 'gone', preset: 'static', status: 'destroyed' });

    const listed = createMockResponse();
    await getRouteHandler(deps, '/deployments', 'get')(mockRequest({ headers: authHeader(token) }), listed);
    expect((listed.body as { quota: unknown }).quota).toEqual({
      static: { used: 27, limit: null }, service: { used: 2, limit: null }, sites: { used: 29, limit: 30 },
    });

    const thirtieth = await deploy(deps, token, 'thirtieth');
    expect(thirtieth.statusCode).toBe(200);
    // The answer counts the site it just made.
    expect((thirtieth.body as { quota: { sites: unknown } }).quota.sites).toEqual({ used: 30, limit: 30 });
    await deploymentStorage.update((await deploymentStorage.getByName('thirtieth'))!.id, { status: 'live' });

    const thirtyFirst = await deploy(deps, token, 'thirty-first');
    expect(thirtyFirst.statusCode).toBe(403);
    expect((thirtyFirst.body as { error: string }).error).toMatch(/already runs 30 sites, which is as many as a workplace can run/);
  });

  it('a workplace on its own cloud counts its sites against the looser backstop', async () => {
    const { deps, token, orgId } = await buildWorkplaceDeps();
    await deps.orgStorage!.updateOrg(orgId, { fly: { orgSlug: 'their-fly', tokenSecretName: 'FLY_ORG_TOKEN' } });
    const listed = createMockResponse();
    await getRouteHandler(deps, '/deployments', 'get')(mockRequest({ headers: authHeader(token) }), listed);
    expect((listed.body as { quota: { sites: unknown } }).quota.sites).toEqual({ used: 0, limit: 50 });
  });

  it('lists and reaches every site of the workplace, and none of another workplace', async () => {
    const { deps, token, deploymentStorage, orgId } = await buildWorkplaceDeps();
    await deploymentStorage.create({
      userId: 'user-1', orgId, agentId: 'agent-a', name: 'tutor', preset: 'static', status: 'live',
    });
    // Same workplace, deployed by another agent.
    await deploymentStorage.create({
      userId: 'user-1', orgId, agentId: 'agent-main', name: 'shop', preset: 'static', status: 'live',
    });
    await deploymentStorage.create({
      userId: 'stranger', orgId: 'another-workplace', agentId: 'agent-z', name: 'theirs', preset: 'static', status: 'live',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/deployments', 'get')(mockRequest({ headers: authHeader(token) }), res);
    expect((res.body as { deployments: Array<{ name: string }> }).deployments.map((d) => d.name))
      .toEqual(['tutor', 'shop']);

    for (const [path, method] of [
      ['/deployments/:name', 'get'],
      ['/deployments/:name/logs', 'get'],
      ['/deployments/:name/restart', 'post'],
    ] as const) {
      const reached = createMockResponse();
      await getRouteHandler(deps, path, method)(
        mockRequest({ headers: authHeader(token), params: { name: 'shop' }, query: {} }), reached,
      );
      expect(reached.statusCode).toBe(200);
      // The workplace is the wall: a stranger's site is a name nobody holds.
      const denied = createMockResponse();
      await getRouteHandler(deps, path, method)(
        mockRequest({ headers: authHeader(token), params: { name: 'theirs' }, query: {} }), denied,
      );
      expect(denied.statusCode).toBe(404);
    }
  });

  it('will not replace a live site another agent deployed without --replace, and says who and when', async () => {
    const { deps, token, deploymentStorage, deploymentService, orgId } = await buildWorkplaceDeps();
    const shop = await deploymentStorage.create({
      userId: 'user-1', orgId, agentId: 'agent-main', name: 'shop', preset: 'static', status: 'live',
      lastDeployAt: '2026-09-18T10:00:00.000Z',
      lastDeployBy: { agentId: 'agent-main', userId: 'user-1', agentName: 'Ruby' },
    });

    // The accident: an agent that only wanted a NAME. It used to hear
    // "already taken"; it must not now silently replace a public site.
    const refused = await deploy(deps, token, 'shop');
    expect(refused.statusCode).toBe(409);
    const said = (refused.body as { error: string; replaceRequired?: boolean });
    expect(said.replaceRequired).toBe(true);
    expect(said.error).toContain('LIVE site of this workplace');
    expect(said.error).toContain('Ruby on 2026-09-18');
    expect(said.error).toContain('--replace');
    expect(deploymentService.syncTarball).not.toHaveBeenCalled();

    // On purpose, it is one word — and the site remembers the new deployer.
    const replaced = await deploy(deps, token, 'shop', { 'x-agentbuilt-replace': 'true' });
    expect(replaced.statusCode).toBe(200);
    expect(deploymentService.syncTarball).toHaveBeenCalledTimes(1);
    expect((await deploymentStorage.get(shop.id))?.lastDeployBy)
      .toEqual({ agentId: 'agent-a', userId: 'user-1', agentName: 'Ben' });

    // Having deployed it last, this agent never meets the fence again.
    const again = await deploy(deps, token, 'shop');
    expect(again.statusCode).toBe(200);
    expect((again.body as { deployment: { lastDeployBy?: string } }).deployment.lastDeployBy).toBe('you');
  });

  it('names a teammate’s agent as a teammate’s, and keeps another workplace’s name a blind "taken"', async () => {
    const { deps, token, deploymentStorage, deploymentService, orgId } = await buildWorkplaceDeps();
    await deploymentStorage.create({
      userId: 'user-2', orgId, agentId: 'agent-theirs', name: 'handbook', preset: 'static', status: 'live',
      lastDeployBy: { agentId: 'agent-theirs', userId: 'user-2', agentName: 'Leo' },
    });
    await deploymentStorage.create({
      userId: 'stranger', orgId: 'another-workplace', agentId: 'agent-z', name: 'theirs', preset: 'static', status: 'live',
    });
    const teammate = await deploy(deps, token, 'handbook');
    expect(teammate.statusCode).toBe(409);
    // A teammate's agent is never hidden (2026-09-23): named, and said to be
    // a teammate's.
    expect((teammate.body as { error: string }).error).toContain("last deployed by Leo, a teammate's agent on ");

    const stranger = await deploy(deps, token, 'theirs', { 'x-agentbuilt-replace': 'true' });
    expect(stranger.statusCode).toBe(409);
    expect((stranger.body as { error: string }).error).toContain('already taken');
    expect(stranger.body).not.toHaveProperty('replaceRequired');
    expect(deploymentService.syncTarball).not.toHaveBeenCalled();
  });

  it('treats a site from before the stamp as deployed by the agent that created it', async () => {
    const { deps, token, deploymentStorage, orgId } = await buildWorkplaceDeps();
    await deploymentStorage.create({
      userId: 'user-1', orgId, agentId: 'agent-a', name: 'tutor', preset: 'static', status: 'live',
    });
    expect((await deploy(deps, token, 'tutor')).statusCode).toBe(200);
  });

  it('stamps a new site with the deploying agent, and no room', async () => {
    const { deps, token, deploymentStorage } = await buildWorkplaceDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(
      mockRequest({
        headers: {
          ...authHeader(token), 'x-agentbuilt-name': 'tutor', 'x-agentbuilt-preset': 'static', 'x-agentbuilt-line': 'What%20it%20does',
        },
        body: gzBody,
      }), res,
    );
    expect(res.statusCode).toBe(200);
    // Who deployed it is what the --replace fence reads; rooms are gone (note #843).
    const site = await deploymentStorage.getByName('tutor');
    expect(site).not.toHaveProperty('roomId');
    expect(site?.lastDeployBy).toEqual({ agentId: 'agent-a', userId: 'user-1', agentName: 'Ben' });
  });
});

describe('agent-cli reads', () => {
  it('lists only the caller’s non-destroyed deployments', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'mine', preset: 'static', status: 'live' });
    const gone = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'old', preset: 'static', status: 'live' });
    await deploymentStorage.update(gone.id, { status: 'destroyed' });
    await deploymentStorage.create({ userId: 'user-2', agentId: 'x', name: 'theirs', preset: 'static', status: 'live' });

    const list = getRouteHandler(deps, '/deployments', 'get');
    const res = createMockResponse();
    await list(mockRequest({ headers: authHeader(token) }), res);
    const body = res.body as { deployments: Array<{ name: string; url: string }> };
    expect(body.deployments.map((d) => d.name)).toEqual(['mine']);
    expect(body.deployments[0]!.url).toBe('https://mine.agentbuilt.app');
  });

  it("status, logs, and restart answer 404 for names the caller doesn't own", async () => {
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    await deploymentStorage.create({ userId: 'user-2', agentId: 'x', name: 'theirs', preset: 'static', status: 'live' });
    for (const [path, method] of [
      ['/deployments/:name', 'get'],
      ['/deployments/:name/logs', 'get'],
      ['/deployments/:name/restart', 'post'],
    ] as const) {
      const handler = getRouteHandler(deps, path, method);
      const res = createMockResponse();
      await handler(mockRequest({ headers: authHeader(token), params: { name: 'theirs' } }), res);
      expect(res.statusCode).toBe(404);
    }
    expect(deploymentService.readLogs).not.toHaveBeenCalled();
    expect(deploymentService.restart).not.toHaveBeenCalled();
  });

  it('logs pass through with the line count', async () => {
    const { deps, token, deploymentStorage, deploymentService } = await buildDeps();
    const doc = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'mine', preset: 'service', status: 'live' });
    const logs = getRouteHandler(deps, '/deployments/:name/logs', 'get');
    const res = createMockResponse();
    await logs(mockRequest({
      headers: authHeader(token), params: { name: 'mine' }, query: { lines: '250' },
    }), res);
    expect(deploymentService.readLogs).toHaveBeenCalledWith(doc.id, 250);
    expect((res.body as { logs: string }).logs).toBe('the logs');
  });
});

/**
 * The heartbeat ingest. Every assertion here is about the route staying out of
 * the way: it is called by a bash script at 03:45 that ignores the answer, so
 * the only outcomes that matter are "the run got recorded" and "nothing was
 * recorded, loudly".
 */
describe('POST /ops/backup-heartbeat', () => {
  function heartbeatDeps() {
    const recorded: Array<{ job: string; status: string; detail?: string }> = [];
    const deps: Partial<RouteDeps> = {
      backupHeartbeatSecret: 'right-secret',
      recordBackupHeartbeat: (job, status, detail) => { recorded.push({ job, status, detail }); },
    };
    return { deps, recorded };
  }

  it('records a successful run', async () => {
    const { deps, recorded } = heartbeatDeps();
    const handler = getRouteHandler(deps, '/ops/backup-heartbeat', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-backup-heartbeat-secret': 'right-secret' },
      body: { job: 'git', status: 'ok', detail: '11 repos, 0 failures' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual([{ job: 'git', status: 'ok', detail: '11 repos, 0 failures' }]);
  });

  it('refuses a bad secret and records nothing', async () => {
    const { deps, recorded } = heartbeatDeps();
    const handler = getRouteHandler(deps, '/ops/backup-heartbeat', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-backup-heartbeat-secret': 'wrong' },
      body: { job: 'git', status: 'ok' },
    }), res);

    expect(res.statusCode).toBe(401);
    expect(recorded).toEqual([]);
  });

  it('503s when nothing is watching, rather than accepting and dropping', async () => {
    const handler = getRouteHandler({}, '/ops/backup-heartbeat', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ body: { job: 'git', status: 'ok' } }), res);

    // The honest degraded state: a 200 here would tell the job it is monitored
    // when no alert could ever fire.
    expect(res.statusCode).toBe(503);
  });

  it('rejects a junk job id', async () => {
    const { deps, recorded } = heartbeatDeps();
    const handler = getRouteHandler(deps, '/ops/backup-heartbeat', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-backup-heartbeat-secret': 'right-secret' },
      body: { job: '../../etc/passwd', status: 'ok' },
    }), res);

    expect(res.statusCode).toBe(400);
    expect(recorded).toEqual([]);
  });

  it('treats anything that is not "fail" as a success, and caps the detail', async () => {
    const { deps, recorded } = heartbeatDeps();
    const handler = getRouteHandler(deps, '/ops/backup-heartbeat', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: { 'x-backup-heartbeat-secret': 'right-secret' },
      body: { job: 'db', status: 'weird', detail: 'x'.repeat(5000) },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(recorded[0]?.status).toBe('ok');
    expect(recorded[0]?.detail).toHaveLength(500);
  });
});

/**
 * The agent's own "new chat" (`agentbuilt chat new`). The route only records
 * the ask — the reset itself waits for the calling turn to end, which is the
 * service's job — so what is owed here is the identity (the token names the
 * caller), the handoff's shape, and an honest message about WHEN things land.
 */
describe('agent-cli chat new', () => {
  const chatNew = async (deps: Partial<RouteDeps>, token: string, body: unknown) => {
    const handler = getRouteHandler(deps, '/chat/new', 'post');
    const res = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), body }), res);
    return res;
  };

  it('records the ask for the calling agent, handoff trimmed, and says when the reset lands', async () => {
    const { deps, token } = await buildDeps();
    const requestChatReset = vi.fn().mockResolvedValue({ ok: true });
    deps.requestChatReset = requestChatReset;

    const res = await chatNew(deps, token, { handoff: '  Continue the pricing redesign — plan in ~/SCRATCHPAD.md  ' });

    expect(res.statusCode).toBe(200);
    expect(requestChatReset).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-a',
      handoff: 'Continue the pricing redesign — plan in ~/SCRATCHPAD.md',
    });
    // The CLI prints this to the agent mid-turn: it must say the reset comes
    // AFTER the reply, or the agent tells its user a lie about the timing.
    const message = (res.body as { message: string }).message;
    expect(message).toContain('after this turn ends');
    expect(message).toContain('first message of the fresh chat');
  });

  it('without a handoff: the ask carries none, and the message says the fresh chat waits', async () => {
    const { deps, token } = await buildDeps();
    const requestChatReset = vi.fn().mockResolvedValue({ ok: true });
    deps.requestChatReset = requestChatReset;

    const res = await chatNew(deps, token, {});

    expect(res.statusCode).toBe(200);
    expect(requestChatReset).toHaveBeenCalledWith({ userId: 'user-1', agentId: 'agent-a' });
    expect((res.body as { message: string }).message).toContain('waits for your user');
  });

  it('refuses a non-string handoff and one past the cap, without recording the ask', async () => {
    const { deps, token } = await buildDeps();
    const requestChatReset = vi.fn().mockResolvedValue({ ok: true });
    deps.requestChatReset = requestChatReset;

    for (const body of [{ handoff: 42 }, { handoff: 'x'.repeat(4001) }]) {
      const res = await chatNew(deps, token, body);
      expect(res.statusCode).toBe(400);
    }
    expect(requestChatReset).not.toHaveBeenCalled();

    // The boundary itself is fine — the cap is a length, not a taste.
    const ok = await chatNew(deps, token, { handoff: 'y'.repeat(4000) });
    expect(ok.statusCode).toBe(200);
  });

  it('503s without the dep, and surfaces the service refusal as a 409', async () => {
    const { deps, token } = await buildDeps();

    let res = await chatNew(deps, token, {});
    expect(res.statusCode).toBe(503);

    deps.requestChatReset = vi.fn().mockResolvedValue({
      ok: false, reason: 'This agent no longer exists on the account',
    });
    res = await chatNew(deps, token, {});
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('This agent no longer exists on the account');
  });
});

describe('agent-cli agent messaging', () => {
  function wireLifecycle(
    deps: Partial<RouteDeps>,
    listPeers = vi.fn().mockResolvedValue({ agents: [] }),
    messagePeer = vi.fn(),
  ) {
    deps.agentLifecycle = {
      createAgent: vi.fn(), deleteAgent: vi.fn(), listPeers, messagePeer,
    } as never;
    return { listPeers, messagePeer };
  }

  it('lists the live roster for the token-authenticated sender', async () => {
    const { deps, token } = await buildDeps();
    const peers = [
      { id: 'agent-a', name: 'Ben', cli: 'claude', self: true, state: 'working' },
      { id: 'agent-b', name: 'Ivy', cli: 'codex', self: false, state: 'idle' },
    ];
    const { listPeers } = wireLifecycle(deps, vi.fn().mockResolvedValue({ agents: peers }));
    const handler = getRouteHandler(deps, '/agents', 'get');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ agents: peers });
    expect(listPeers).toHaveBeenCalledWith('user-1', 'agent-a');
  });

  it('starts an idle peer with trimmed input and names where its answer appears', async () => {
    const { deps, token } = await buildDeps();
    const messagePeer = vi.fn().mockResolvedValue({
      ok: true, recipient: { id: 'agent-b', name: 'Ivy', cli: 'codex' },
    });
    wireLifecycle(deps, undefined, messagePeer);
    const handler = getRouteHandler(deps, '/agents/messages', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token),
      body: { recipient: '  Ivy ', message: '  Review branch fix-28.  ' },
    }), res);

    expect(res.statusCode).toBe(202);
    expect(messagePeer).toHaveBeenCalledWith({
      userId: 'user-1', senderAgentId: 'agent-a', recipient: 'Ivy', message: 'Review branch fix-28.',
    });
    expect((res.body as { message: string }).message).toContain('their Workspace conversation');
    expect((res.body as { message: string }).message).toContain('Workspace will notify');
  });

  it('delivers an agent\'s answer to the Workspace Agent\'s conversation by name or id, and says it reacts there (notes #457, #539)', async () => {
    const { deps, token, userStorage } = await buildDeps();
    const profile = (await userStorage.getProfile('user-1'))!;
    await userStorage.updateProfile('user-1', { telegram: { ...profile.telegram!, agents: { 'agent-a': { ...profile.telegram!.agents!['agent-a']!, orgId: 'org-1' } } } });
    const messagePeer = vi.fn();
    wireLifecycle(deps, undefined, messagePeer);
    const receiveFromAgent = vi.fn(async () => ({ ok: true as const, name: 'Workspace Agent', reacting: true }));
    deps.workspaceAgent = { receiveFromAgent } as never;
    const handler = getRouteHandler(deps, '/agents/messages', 'post');
    for (const recipient of ['workspace agent', 'Workspace Agent', workspaceAssistantId('user-1', 'org-1')]) {
      const res = createMockResponse();
      await handler(mockRequest({ headers: authHeader(token), body: { recipient, message: '  Note #454 is claimed; PR #842 is ready.  ' } }), res);
      expect(res.statusCode, recipient).toBe(202);
      expect((res.body as { message: string }).message).toContain('reacts there');
      expect((res.body as { message: string }).message).toContain('your final answer');
    }
    expect(receiveFromAgent).toHaveBeenCalledTimes(3);
    expect(receiveFromAgent).toHaveBeenLastCalledWith({ userId: 'user-1', orgId: 'org-1', senderAgentId: 'agent-a', message: 'Note #454 is claimed; PR #842 is ready.' });
    expect(messagePeer).not.toHaveBeenCalled();
    // A Workspace Agent the person never started takes the answer and starts
    // nothing: the sender is told only that it was delivered (note #539).
    receiveFromAgent.mockResolvedValueOnce({ ok: true as const, name: 'Workspace Agent', reacting: false });
    const quiet = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), body: { recipient: 'Workspace Agent', message: 'Done.' } }), quiet);
    expect(quiet.statusCode).toBe(202);
    expect((quiet.body as { message: string }).message).toContain('your final answer there');
    expect((quiet.body as { message: string }).message).not.toContain('reacts there');
    // A refusal from the conversation is the answer, not a fallback to a roster lookup.
    receiveFromAgent.mockResolvedValueOnce({ ok: false, reason: 'Workplace access changed.' } as never);
    const refused = createMockResponse();
    await handler(mockRequest({ headers: authHeader(token), body: { recipient: 'Workspace Agent', message: 'Done.' } }), refused);
    expect(refused.statusCode).toBe(409);
    expect(messagePeer).not.toHaveBeenCalled();
  });

  it('answers 202 with the queued outcome, its id, and how to withdraw it (note #267)', async () => {
    const { deps, token } = await buildDeps();
    const queued = {
      id: 'ab12cd34', recipient: { id: 'agent-b', name: 'Ivy' }, position: 2,
      queuedAt: '2026-09-05T10:00:00.000Z', expiresAt: '2026-09-05T11:00:00.000Z', message: 'Review it.',
    };
    const messagePeer = vi.fn().mockResolvedValue({
      ok: true, recipient: { id: 'agent-b', name: 'Ivy', cli: 'codex' }, queued,
    });
    wireLifecycle(deps, undefined, messagePeer);
    const handler = getRouteHandler(deps, '/agents/messages', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), body: { recipient: 'Ivy', message: 'Review it.' },
    }), res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued });
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/^Queued for Ivy, who is working now \(1 ahead of it\)/);
    expect(message).toContain('2026-09-05T11:00:00.000Z');
    expect(message).toContain('agentbuilt agent cancel ab12cd34');
    expect(message).not.toContain('Started');
  });

  it('lists and withdraws the sender\'s waiting messages', async () => {
    const { deps, token } = await buildDeps();
    const pending = [{
      id: 'ab12cd34', recipient: { id: 'agent-b', name: 'Ivy' }, position: 1,
      queuedAt: '2026-09-05T10:00:00.000Z', expiresAt: '2026-09-05T11:00:00.000Z', message: 'Review it.',
    }];
    wireLifecycle(deps);
    const listPending = vi.fn().mockReturnValue(pending);
    const cancel = vi.fn()
      .mockReturnValueOnce({ ok: true, recipient: { id: 'agent-b', name: 'Ivy' } })
      .mockReturnValueOnce({ ok: false, reason: 'No message of yours with id ab12cd34 is waiting.' });
    Object.assign(deps.agentLifecycle!, { listPendingPeerMessages: listPending, cancelPendingPeerMessage: cancel });

    const listRes = createMockResponse();
    await getRouteHandler(deps, '/agents/messages/pending', 'get')(mockRequest({ headers: authHeader(token) }), listRes);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).toEqual({ ok: true, pending });
    expect(listPending).toHaveBeenCalledWith('user-1', 'agent-a');

    const cancelRes = createMockResponse();
    await getRouteHandler(deps, '/agents/messages/:id', 'delete')(
      mockRequest({ headers: authHeader(token), params: { id: 'ab12cd34' } }), cancelRes,
    );
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.body).toEqual({
      ok: true, recipient: { id: 'agent-b', name: 'Ivy' },
      message: 'Withdrew the message waiting for Ivy. Nothing reaches them from it.',
    });
    expect(cancel).toHaveBeenCalledWith('user-1', 'agent-a', 'ab12cd34');

    const goneRes = createMockResponse();
    await getRouteHandler(deps, '/agents/messages/:id', 'delete')(
      mockRequest({ headers: authHeader(token), params: { id: 'ab12cd34' } }), goneRes,
    );
    expect(goneRes.statusCode).toBe(404);
    expect(goneRes.body).toEqual({ error: 'No message of yours with id ab12cd34 is waiting.' });
  });

  it('maps a busy race to 409 and never disguises it as accepted', async () => {
    const { deps, token } = await buildDeps();
    const messagePeer = vi.fn().mockResolvedValue({
      ok: false, code: 'busy', reason: 'Ivy became busy. Nothing was queued.',
    });
    wireLifecycle(deps, undefined, messagePeer);
    const handler = getRouteHandler(deps, '/agents/messages', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), body: { recipient: 'Ivy', message: 'Review it.' },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Ivy became busy. Nothing was queued.', code: 'busy' });
  });

  it('maps the shutdown intake gate to 503 so a caller may retry', async () => {
    const { deps, token } = await buildDeps();
    const messagePeer = vi.fn().mockResolvedValue({
      ok: false,
      code: 'restarting',
      reason: 'The platform is restarting. Nothing was queued. Try again in a moment.',
    });
    wireLifecycle(deps, undefined, messagePeer);
    const handler = getRouteHandler(deps, '/agents/messages', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), body: { recipient: 'Ivy', message: 'Review it.' },
    }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'The platform is restarting. Nothing was queued. Try again in a moment.',
      code: 'restarting',
    });
  });

  it('refuses blank or oversized messages before dispatch', async () => {
    const { deps, token } = await buildDeps();
    const { messagePeer } = wireLifecycle(deps);
    const handler = getRouteHandler(deps, '/agents/messages', 'post');

    for (const body of [
      { recipient: '', message: 'work' },
      { recipient: 'Ivy', message: '   ' },
      { recipient: 'Ivy', message: 'x'.repeat(4001) },
    ]) {
      const res = createMockResponse();
      await handler(mockRequest({ headers: authHeader(token), body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(messagePeer).not.toHaveBeenCalled();
  });
});

describe('a finished managed job wakes its agent (note #532)', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    id: 'j_0123456789abcdef01234567',
    status: 'succeeded',
    command: 'node simulations/all.mjs',
    cwd: '/home/agent/infinite-agents',
    startedAt: '2026-09-16T15:00:00.000Z',
    finishedAt: '2026-09-16T15:06:12.000Z',
    durationMs: 372_000,
    exitCode: 0,
    signal: null,
    outputBytes: 2_048,
    outputTruncated: false,
    tail: 'all nine scenarios passed',
    ...over,
  });

  function wireDelivery(deps: Partial<RouteDeps>) {
    const deliverFinishedJobs = vi.fn(async (args: { receipts: Array<{ id: string }> }) => ({
      accepted: args.receipts.map((one) => one.id),
    }));
    deps.agentLifecycle = { deliverFinishedJobs } as unknown as RouteDeps['agentLifecycle'];
    return { deliverFinishedJobs };
  }

  it('hands the receipt on and accepts it, which is what retires it on the machine', async () => {
    const { deps, token } = await buildDeps();
    const { deliverFinishedJobs } = wireDelivery(deps);
    const handler = getRouteHandler(deps, '/jobs/finished', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { jobs: [receipt()] } }), res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ ok: true, accepted: ['j_0123456789abcdef01234567'] });
    expect(deliverFinishedJobs).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      agentId: 'agent-a',
    }));
    const [args] = deliverFinishedJobs.mock.calls[0]!;
    expect(args.receipts).toHaveLength(1);
  });

  it('bounds the batch and drops receipts it cannot read, without failing the ones it can', async () => {
    const { deps, token } = await buildDeps();
    const { deliverFinishedJobs } = wireDelivery(deps);
    const handler = getRouteHandler(deps, '/jobs/finished', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token),
      body: {
        jobs: [
          receipt(),
          // A machine is not a thing to take a payload from on trust.
          { id: 'not-a-job-id', status: 'succeeded' },
          receipt({ id: 'j_ffffffffffffffffffffffff', status: 'stopped' }),
          ...Array.from({ length: 30 }, (_, index) => receipt({
            id: `j_${String(index).padStart(24, '0')}`,
          })),
        ],
      },
    }), res);

    expect(res.statusCode).toBe(202);
    const [args] = deliverFinishedJobs.mock.calls[0]!;
    // 20 of the 33 sent survive the cap, and the two unusable ones inside that
    // window (a bad id, a `stopped` state that never travels) are dropped.
    expect(args.receipts).toHaveLength(18);
    expect(args.receipts.every((one: { id: string }) => /^j_[a-f0-9]{24}$/.test(one.id))).toBe(true);
  });

  it('refuses an empty request and one with nothing usable in it', async () => {
    const { deps, token } = await buildDeps();
    const { deliverFinishedJobs } = wireDelivery(deps);
    const handler = getRouteHandler(deps, '/jobs/finished', 'post');

    for (const body of [{}, { jobs: [] }, { jobs: [{ id: 'nope' }] }]) {
      const res = createMockResponse();
      await handler(mockRequest({ headers: authHeader(token), body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(deliverFinishedJobs).not.toHaveBeenCalled();
  });

  it('503s when the turn could not be handed over, so the machine keeps the receipt owed', async () => {
    const { deps, token } = await buildDeps();
    const deliverFinishedJobs = vi.fn(async () => ({ accepted: [] as string[] }));
    deps.agentLifecycle = { deliverFinishedJobs } as unknown as RouteDeps['agentLifecycle'];
    const handler = getRouteHandler(deps, '/jobs/finished', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { jobs: [receipt()] } }), res);

    // A runner shutting down for a deploy is the usual cause, and it is not a
    // verdict on the receipt: 4xx would retire it for good.
    expect(res.statusCode).toBe(503);
  });

  it('503s when the backend has no delivery wired at all', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/jobs/finished', 'post');
    const res = createMockResponse();

    await handler(mockRequest({ headers: authHeader(token), body: { jobs: [receipt()] } }), res);

    // 5xx and not 4xx on purpose: a 4xx is what tells the machine to stop
    // asking, and a backend without the hook wired is a transient state.
    expect(res.statusCode).toBe(503);
  });
});

/**
 * The app catalogue (note #756): every deployed site is listed, by a line
 * its deploying agent writes at deploy time, with a picture the deploying
 * machine takes; `unlist` and `relist` are the switch.
 */
describe('the app catalogue (note #756): the listing written at deploy', () => {
  const deploy = async (deps: Partial<RouteDeps>, token: string, name: string, headers: Record<string, string> = {}) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': name, 'x-agentbuilt-preset': 'static', ...headers }, body: gzBody,
    }), res);
    return res;
  };
  const listing = async (deps: Partial<RouteDeps>, token: string, name: string, body: Record<string, unknown>) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/deployments/:name/listing', 'post')(mockRequest({ headers: authHeader(token), params: { name }, body }), res);
    return res;
  };
  type Described = { deployment: { listing: { listed: boolean; line?: string; picture: boolean; unlisted: boolean } }; message: string };

  it('refuses a first deploy with no line (after the preset check), and takes --unlisted instead', async () => {
    const { deps, token, deploymentService } = await buildDeps();
    const bare = await deploy(deps, token, 'ember', { 'x-agentbuilt-line': '' });
    expect(bare.statusCode).toBe(400);
    const noLine = createMockResponse();
    await getRouteHandler(deps, '/deploy', 'post')(mockRequest({
      headers: { ...authHeader(token), 'x-agentbuilt-name': 'ember', 'x-agentbuilt-preset': 'static' }, body: gzBody,
    }), noLine);
    expect(noLine.statusCode).toBe(400);
    expect(noLine.body).toMatchObject({ listingLineRequired: true });
    expect((noLine.body as { error: string }).error).toMatch(/--line/);
    expect(deploymentService.createPending).not.toHaveBeenCalled();

    const tooLong = await deploy(deps, token, 'ember', { 'x-agentbuilt-line': 'x'.repeat(161) });
    expect(tooLong.statusCode).toBe(400);
    expect((tooLong.body as { error: string }).error).toMatch(/at most 160/);

    const unlisted = await deploy(deps, token, 'quiet', { 'x-agentbuilt-unlisted': 'true' });
    expect(unlisted.statusCode).toBe(200);
    expect((unlisted.body as Described).message).toMatch(/NOT in the public catalogue \(unlisted\)/);
  });

  it('stores the line URL-decoded, lists the site once it is live, and keeps the line across a redeploy', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    const first = await deploy(deps, token, 'ember', { 'x-agentbuilt-line': encodeURIComponent('Café orders, in one tap ☕') });
    expect(first.statusCode).toBe(200);
    expect((first.body as Described).message).toMatch(/will be in the public catalogue at https:\/\/agenticcloudcomputer\.com\/apps/);
    const doc = (await deploymentStorage.getByName('ember'))!;
    expect(doc.listing).toMatchObject({ line: 'Café orders, in one tap ☕', updatedByAgentId: 'agent-a' });

    // Not yet: the catalogue never shows a link that does not work.
    const status = createMockResponse();
    await getRouteHandler(deps, '/deployments/:name', 'get')(mockRequest({ headers: authHeader(token), params: { name: 'ember' } }), status);
    expect((status.body as Described).deployment.listing).toEqual({ listed: false, line: 'Café orders, in one tap ☕', picture: false, unlisted: false });

    await deploymentStorage.update(doc.id, { status: 'live' });
    const again = await deploy(deps, token, 'ember');
    expect(again.statusCode).toBe(200);
    expect((again.body as Described).deployment.listing).toMatchObject({ listed: true, line: 'Café orders, in one tap ☕' });
    expect((again.body as Described).message).toMatch(/is in the public catalogue/);
    const reworded = await deploy(deps, token, 'ember', { 'x-agentbuilt-line': 'Coffee%20orders' });
    expect((reworded.body as Described).deployment.listing.line).toBe('Coffee orders');
  });

  it('unlists and relists on the user’s word, and writes a line for a site from before the catalogue', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    const old = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    const status = createMockResponse();
    await getRouteHandler(deps, '/deployments/:name', 'get')(mockRequest({ headers: authHeader(token), params: { name: 'shop' } }), status);
    expect((status.body as Described).deployment.listing).toEqual({ listed: false, picture: false, unlisted: false });
    // A redeploy of such a site says how to get it listed, and deploys.
    const redeploy = await deploy(deps, token, 'shop');
    expect(redeploy.statusCode).toBe(200);
    expect((redeploy.body as Described).message).toMatch(/has no line.*agentbuilt listing shop --line/);

    const nothing = await listing(deps, token, 'shop', {});
    expect(nothing.statusCode).toBe(400);
    const lined = await listing(deps, token, 'shop', { line: 'A shop for hand-made mugs.' });
    expect(lined.statusCode).toBe(200);
    expect((lined.body as Described).deployment.listing).toMatchObject({ listed: true, line: 'A shop for hand-made mugs.' });
    expect((lined.body as Described).message).toMatch(/no picture yet/);

    const off = await listing(deps, token, 'shop', { listed: false });
    expect((off.body as Described).deployment.listing).toMatchObject({ listed: false, unlisted: true });
    expect((off.body as Described).message).toMatch(/out of the public catalogue/);
    expect((await deploymentStorage.get(old.id))!.listing).toMatchObject({ listed: false, line: 'A shop for hand-made mugs.' });
    const on = await listing(deps, token, 'shop', { listed: true });
    expect((on.body as Described).deployment.listing).toMatchObject({ listed: true, unlisted: false });
    const bad = await listing(deps, token, 'shop', { listed: 'yes' });
    expect(bad.statusCode).toBe(400);
    // A stranger's site is a name nobody holds.
    await deploymentStorage.create({ userId: 'stranger', agentId: 'agent-z', name: 'theirs', preset: 'static', status: 'live' });
    const denied = await listing(deps, token, 'theirs', { listed: false });
    expect(denied.statusCode).toBe(404);
  });

  it('takes a PNG as the picture, replaces the one before, and refuses anything else', async () => {
    const { deps, token, deploymentStorage } = await buildDeps();
    const objects = new Map<string, Buffer>();
    deps.mediaStorage = {
      uploadObject: async ({ storagePath, data }: { storagePath: string; data: Buffer }) => { objects.set(storagePath, data); },
      deleteObject: async ({ storagePath }: { storagePath: string }) => { objects.delete(storagePath); },
    } as never;
    const site = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'ember', preset: 'static', status: 'live', listing: { line: 'Coffee orders' },
    });
    const picture = async (body: Buffer) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/deployments/:name/listing/picture', 'post')(mockRequest({ headers: authHeader(token), params: { name: 'ember' }, body }), res);
      return res;
    };
    const notPng = await picture(Buffer.from('GIF89a...'));
    expect(notPng.statusCode).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('one')]);
    const first = await picture(png);
    expect(first.statusCode).toBe(200);
    expect((first.body as Described).deployment.listing).toMatchObject({ listed: true, picture: true });
    expect((first.body as Described).message).toMatch(/the catalogue at https:\/\/agenticcloudcomputer\.com\/apps shows it/);
    const firstPath = (await deploymentStorage.get(site.id))!.listing!.picture!.storagePath;
    expect(firstPath).toMatch(new RegExp(`^users/user-1/sites/${site.id}/catalogue/.+\\.png$`));
    expect(objects.get(firstPath)).toEqual(png);

    const second = await picture(Buffer.concat([png, Buffer.from('two')]));
    expect(second.statusCode).toBe(200);
    const secondPath = (await deploymentStorage.get(site.id))!.listing!.picture!.storagePath;
    expect(secondPath).not.toBe(firstPath);
    await vi.waitFor(() => expect(objects.has(firstPath)).toBe(false));
    expect(objects.has(secondPath)).toBe(true);
  });
});

describe('object storage (note #768): agentbuilt storage', () => {
  async function storageDeps() {
    const { deps, token } = await buildDeps();
    const saved = new Map<string, string>();
    const corsSets: number[] = [];
    const { InMemoryStorageBucketStorage } = await import('../../services/storage-bucket-storage.js');
    const { ObjectStorageService } = await import('../../services/object-storage.js');
    const fly = {
      resolveOrganizationId: async () => 'org-id',
      createTigrisBucket: vi.fn(async () => ({
        bucket: 'tigris-bucket-1', endpoint: 'https://fly.storage.tigris.dev', accessKeyId: 'AKIAXYZ', secretAccessKey: 'SECRETXYZ', region: 'auto',
      })),
      deleteAddOn: vi.fn(async () => {}),
    };
    const objectStorage = new ObjectStorageService({
      storage: new InMemoryStorageBucketStorage(),
      resolveHostingContext: async () => ({ source: 'platform', orgSlug: 'infinite-agents', apiToken: 't' }),
      platform: { orgSlug: 'infinite-agents', apiToken: 't' },
      makeFlyClient: () => fly,
      secrets: {
        save: async (ns, name, value) => { saved.set(`${ns}/${name}`, value); },
        remove: async (ns, name) => { saved.delete(`${ns}/${name}`); },
        read: async (ns, name) => saved.get(`${ns}/${name}`) ?? null,
      },
      makeObjects: () => ({ usage: async () => ({ bytes: 10, objects: 1, truncated: false }), empty: async () => {}, setCors: vi.fn(async () => { corsSets.push(1); }) }),
      caps: { hostedBucketLimit: 3, hostedBucketGb: 10 },
      log: () => undefined,
    });
    deps.objectStorage = objectStorage;
    return { deps, token, saved, fly, objectStorage, corsSets };
  }

  it('storage cors re-applies a public bucket\'s rule and refuses a private one (note #770)', async () => {
    const { deps, token, corsSets } = await storageDeps();
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'photos', public: true } }), createMockResponse());
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'drafts' } }), createMockResponse());
    expect(corsSets).toHaveLength(1); // set once, at the public bucket's creation
    const ok = createMockResponse();
    await getRouteHandler(deps, '/storage/:name/cors', 'post')(mockRequest({ headers: authHeader(token), params: { name: 'photos' } }), ok);
    expect(ok.statusCode).toBe(200);
    expect((ok.body as { message: string }).message).toMatch(/every origin, GET and HEAD/);
    expect(corsSets).toHaveLength(2);
    const no = createMockResponse();
    await getRouteHandler(deps, '/storage/:name/cors', 'post')(mockRequest({ headers: authHeader(token), params: { name: 'drafts' } }), no);
    expect(no.statusCode).toBe(400);
    expect((no.body as { error: string }).error).toMatch(/private/);
  });

  it('create mints a private bucket, names its four secrets in the reply, and never prints a value', async () => {
    const { deps, token, saved } = await storageDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/storage', 'post')(
      mockRequest({ headers: authHeader(token), body: { name: 'user-uploads' } }), res,
    );
    expect(res.statusCode).toBe(201);
    const body = res.body as { bucket: { name: string; public: boolean; secrets: Record<string, string> }; message: string };
    expect(body.bucket).toMatchObject({ name: 'user-uploads', public: false });
    expect(body.message).toContain('private');
    for (const name of ['USER_UPLOADS_S3_ENDPOINT', 'USER_UPLOADS_S3_BUCKET', 'USER_UPLOADS_S3_ACCESS_KEY_ID', 'USER_UPLOADS_S3_SECRET_ACCESS_KEY']) {
      expect(body.message).toContain(name);
      expect(saved.get(`user-1/${name}`)).toBeDefined();
    }
    expect(JSON.stringify(body)).not.toContain('AKIAXYZ');
    expect(JSON.stringify(body)).not.toContain('SECRETXYZ');
    expect(body.message).toContain('NEXT turn');
  });

  it('--public says so plainly, in the record and the words', async () => {
    const { deps, token } = await storageDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/storage', 'post')(
      mockRequest({ headers: authHeader(token), body: { name: 'photos', public: true } }), res,
    );
    expect(res.statusCode).toBe(201);
    const body = res.body as { bucket: { public: boolean }; message: string };
    expect(body.bucket.public).toBe(true);
    expect(body.message).toContain('PUBLIC');
    expect(body.message).toMatch(/anyone/i);
  });

  it('refuses past the ceiling in plain words', async () => {
    const { deps, token } = await storageDeps();
    for (const name of ['one', 'two', 'three']) {
      const ok = createMockResponse();
      await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name } }), ok);
      expect(ok.statusCode).toBe(201);
    }
    const res = createMockResponse();
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'four' } }), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/3 of 3 buckets/);
  });

  it('list and show read the workplace’s buckets, with the caps and what each holds', async () => {
    const { deps, token } = await storageDeps();
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'user-uploads', public: true } }), createMockResponse());
    const list = createMockResponse();
    await getRouteHandler(deps, '/storage', 'get')(mockRequest({ headers: authHeader(token) }), list);
    expect(list.statusCode).toBe(200);
    expect(list.body).toMatchObject({ buckets: [{ name: 'user-uploads', public: true }], caps: { hostedBucketLimit: 3, hostedBucketGb: 10 } });
    const show = createMockResponse();
    await getRouteHandler(deps, '/storage/:name', 'get')(mockRequest({ headers: authHeader(token), params: { name: 'user-uploads' } }), show);
    expect(show.statusCode).toBe(200);
    expect(show.body).toMatchObject({ bucket: { name: 'user-uploads' }, usage: { bytes: 10, objects: 1 } });
    const missing = createMockResponse();
    await getRouteHandler(deps, '/storage/:name', 'get')(mockRequest({ headers: authHeader(token), params: { name: 'nope' } }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('delete only ASKS: the bucket stays, its keys stay, and the reply says to tell the user', async () => {
    const { deps, token, fly, objectStorage, saved } = await storageDeps();
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'user-uploads' } }), createMockResponse());
    const res = createMockResponse();
    await getRouteHandler(deps, '/storage/:name/delete', 'post')(mockRequest({ headers: authHeader(token), params: { name: 'user-uploads' } }), res);
    expect(res.statusCode).toBe(202);
    expect((res.body as { message: string }).message).toContain('TELL THEM');
    expect(fly.deleteAddOn).not.toHaveBeenCalled();
    expect(saved.size).toBe(4);
    const doc = await objectStorage.getLive({ orgId: null, userId: 'user-1' }, 'user-uploads');
    expect(doc?.status).toBe('live');
    expect(doc?.deleteAsk).toMatchObject({ byAgentId: 'agent-a', byUserId: 'user-1' });
    // There is no route that destroys a bucket on this router.
    expect(() => getRouteHandler(deps, '/storage/:name', 'put')).toThrow();
  });

  it('503s plainly when this backend has no object storage', async () => {
    const { deps, token } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/storage', 'post')(mockRequest({ headers: authHeader(token), body: { name: 'x' } }), res);
    expect(res.statusCode).toBe(503);
  });
});
