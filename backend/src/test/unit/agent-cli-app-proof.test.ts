import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';

/**
 * An agent proves who it is to one of its workplace's sites (note #1178):
 * `agentbuilt app-proof <site>` against the real route, and the CLI itself.
 */

interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  response.setHeader = (() => response as Response) as Response['setHeader'];
  return response;
}

type Stack = Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;

function routes(deps: Partial<RouteDeps>): Stack {
  return (agentCliRoutes(deps as RouteDeps) as unknown as { stack: Stack }).stack;
}

function handler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post') {
  const layer = routes(deps).find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

async function call(deps: Partial<RouteDeps>, token: string, path: string, method: 'get' | 'post', args: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const req: Partial<Request> = {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: {},
    body: args.body,
  };
  const res = createMockResponse();
  await handler(deps, path, method)(req, res);
  return res;
}

async function world() {
  const userStorage = new InMemoryUserStorage();
  const agent = async (userId: string, agentId: string, name: string) => {
    if (!(await userStorage.getProfile(userId))) await userStorage.createProfile(userId, { email: `${userId}@example.com`, displayName: userId });
    const { token, tokenHash } = mintAgentbuiltToken(userId, agentId);
    const profile = await userStorage.getProfile(userId);
    await userStorage.updateProfile(userId, {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true,
        agents: { ...(profile?.telegram?.agents ?? {}), [agentId]: { id: agentId, name, cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
      },
    });
    return token;
  };
  const rowan = await agent('user-adam', 'agent-rowan', 'Rowan');
  const stranger = await agent('user-other', 'agent-zed', 'Zed');
  await userStorage.updateProfile('user-adam', { roles: { admin: true } } as never);
  const deps: Partial<RouteDeps> = { userStorage };
  return { deps, rowan, stranger };
}

describe('agentbuilt app-proof (note #1178)', () => {
  it('gives the operator\'s agent a proof for a live site of his, and nobody else one', async () => {
    const { deps, rowan, stranger } = await world();
    const { AppDoors, InMemoryAppDoorStore } = await import('../../services/app-doors.js');
    const { InMemoryDeploymentStorage } = await import('../../services/deployment-storage.js');
    const deployments = new InMemoryDeploymentStorage();
    await deployments.create({ userId: 'user-adam', agentId: 'agent-rowan', name: 'outreach', status: 'live' } as never);
    await deployments.create({ userId: 'user-other', agentId: 'agent-zed', name: 'theirs', status: 'live' } as never);
    const doors = new AppDoors(new InMemoryAppDoorStore());
    Object.assign(deps, { appDoors: doors, deploymentStorage: deployments });
    const minted = await call(deps, rowan, '/apps/proof', 'post', { body: { site: 'outreach' } });
    expect(minted.statusCode).toBe(200);
    const proof = (minted.body as { proof: string }).proof;
    expect(proof).toMatch(/^sp_/);
    expect(await doors.read(proof)).toMatchObject({ kind: 'agent', userId: 'user-adam', site: 'outreach', agentId: 'agent-rowan', agentName: 'Rowan' });
    expect((await call(deps, rowan, '/apps/proof', 'post', { body: { site: 'theirs' } })).statusCode).toBe(404);
    expect((await call(deps, rowan, '/apps/proof', 'post', { body: {} })).statusCode).toBe(400);
    // Not the operator's agent: the doors are shut to it (note #1178, operator first).
    expect((await call(deps, stranger, '/apps/proof', 'post', { body: { site: 'theirs' } })).statusCode).toBe(403);
    Object.assign(deps, { privateCopy: true });
    expect((await call(deps, rowan, '/apps/proof', 'post', { body: { site: 'outreach' } })).statusCode).toBe(404);
  });
});

describe('agentbuilt app-proof, the real CLI against the real route (note #1178)', () => {
  const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('prints the proof and nothing else, for a site of his; refuses in words otherwise', async () => {
    const { deps, rowan } = await world();
    const { AppDoors, InMemoryAppDoorStore } = await import('../../services/app-doors.js');
    const { InMemoryDeploymentStorage } = await import('../../services/deployment-storage.js');
    const deployments = new InMemoryDeploymentStorage();
    await deployments.create({ userId: 'user-adam', agentId: 'agent-rowan', name: 'outreach', status: 'live' } as never);
    const doors = new AppDoors(new InMemoryAppDoorStore());
    Object.assign(deps, { appDoors: doors, deploymentStorage: deployments });
    const app = express();
    app.use(express.json());
    app.use('/api/agent-cli', agentCliRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [SOURCE_CLI, 'app-proof', ...args], {
        env: { ...process.env, HOME: '/nonexistent-agentbuilt-app-proof-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: rowan },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const ok = await run(['outreach']);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^sp_[A-Za-z0-9_-]{43}\n$/);
    expect(await doors.read(ok.stdout.trim())).toMatchObject({ kind: 'agent', site: 'outreach', agentName: 'Rowan' });
    const theirs = await run(['nosuchsite']);
    expect(theirs.status).not.toBe(0);
    expect(theirs.stderr).toContain('nosuchsite is not a live site of your workplace');
  });
});

describe('agentbuilt outreach, after Outreach moved into its own app (note #1178)', () => {
  it('says where it went and the app\'s own command, calls nothing, and exits 1', async () => {
    const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [SOURCE_CLI, 'outreach', 'list'], {
        env: { ...process.env, HOME: '/nonexistent-agentbuilt-outreach-test', AGENTBUILT_API_URL: 'http://127.0.0.1:9', AGENTBUILT_TOKEN: 'x' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Outreach moved into its own app (note #1178): https://outreach.agentbuilt.app');
    expect(run.stderr).toContain('curl -s https://outreach.agentbuilt.app/outreach.mjs -o /tmp/outreach.mjs && node /tmp/outreach.mjs list');
  });

  it('has no Outreach route left in the agents\' door', () => {
    const paths = routes({}).flatMap((layer) => (layer.route ? [layer.route.path] : []));
    expect(paths.filter((one) => one.includes('outreach'))).toEqual([]);
  });
});
