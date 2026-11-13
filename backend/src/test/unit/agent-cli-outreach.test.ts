import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { fixtureOutreachWrite } from '../../shared/outreach-fixtures.js';

/**
 * `agentbuilt outreach` (note #1103): the platform operator's own agents
 * write the companies, profiles and letters straight into his Outreach, and
 * his site reads them live. Two promises are worth tests rather than reading:
 * WHO may write (his agents, nobody else's, never in a private copy), and
 * WHAT the door can do — write drafts and facts, signed, and nothing else: no
 * route here sends, sets a state, or reads a reply.
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
  const store = new InMemoryOutreachStore();
  const outreach = new OutreachService({ store, outbox: () => undefined });
  const deps: Partial<RouteDeps> = { userStorage, outreach };
  return { deps, rowan, stranger, outreach, store };
}

describe('agentbuilt outreach', () => {
  it('lets the operator\'s agent write a batch, signed with its name, and read it back', async () => {
    const { deps, rowan, outreach } = await world();
    const wrote = await call(deps, rowan, '/outreach', 'post', { body: fixtureOutreachWrite() });
    expect(wrote.statusCode).toBe(200);
    expect(wrote.body).toMatchObject({ refused: [], unchanged: [], words: 'written' });
    expect((wrote.body as { added: string[] }).added).toHaveLength(14);
    // What his site reads is what the agent wrote, signed.
    const detail = await outreach.detail('user-adam', 'northwind-health');
    expect(detail?.row).toMatchObject({ writtenBy: 'Rowan', written: true });
    expect(detail?.touches[0]).toMatchObject({ kind: 'written', by: { agentId: 'agent-rowan', name: 'Rowan' }, added: true });
    const list = await call(deps, rowan, '/outreach', 'get');
    expect((list.body as { targets: Array<{ id: string }> }).targets).toHaveLength(14);
    const show = await call(deps, rowan, '/outreach/targets/:id', 'get', { params: { id: 'Northwind Health' } });
    expect(show.statusCode).toBe(200);
    expect(show.body).toMatchObject({ target: { id: 'northwind-health', written: { profile: { fundingRound: expect.stringMatching(/Seed/) } }, writes: [{ by: 'Rowan', added: true }] } });
    expect((await call(deps, rowan, '/outreach/targets/:id', 'get', { params: { id: 'nobody' } })).statusCode).toBe(404);
  });

  it('writes one company on its own, and refuses a file that is not of the shape, writing nothing', async () => {
    const { deps, rowan, outreach } = await world();
    const one = (fixtureOutreachWrite().targets as unknown[])[0];
    expect((await call(deps, rowan, '/outreach', 'post', { body: one })).body).toMatchObject({ added: ['Northwind Health'], words: null });
    const bad = await call(deps, rowan, '/outreach', 'post', { body: { targets: [{ company: 'X', fit: 'fit' }, { company: 'Y' }] } });
    expect(bad.statusCode).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/^Nothing was written: Y: fit is neither/);
    expect((await outreach.list('user-adam')).rows.map((row) => row.company)).toEqual(['Northwind Health']);
  });

  it('refuses anybody else\'s agent, and answers nothing in a private copy or where Outreach is not wired', async () => {
    const { deps, rowan, stranger } = await world();
    for (const [path, method, body] of [['/outreach', 'get', undefined], ['/outreach', 'post', fixtureOutreachWrite()]] as const) {
      const refused = await call(deps, stranger, path, method, { body });
      expect(refused.statusCode).toBe(403);
      expect((refused.body as { error: string }).error).toMatch(/platform operator's own/);
    }
    expect((await call(deps, 'not-a-token', '/outreach', 'get')).statusCode).toBe(401);
    expect((await call({ ...deps, privateCopy: true }, rowan, '/outreach', 'post', { body: fixtureOutreachWrite() })).statusCode).toBe(404);
    expect((await call({ ...deps, outreach: undefined }, rowan, '/outreach', 'get')).statusCode).toBe(404);
  });

  it('has no route that sends, sets a state, adds a note, edits the owner\'s letter or reads his timeline', () => {
    const paths = routes({}).flatMap((layer) => (layer.route && layer.route.path.startsWith('/outreach')
      ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []));
    expect(paths.sort()).toEqual(['GET /outreach', 'GET /outreach/targets/:id', 'POST /outreach']);
  });
});

describe('agentbuilt outreach, the real CLI against the real routes', () => {
  const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function serve(deps: Partial<RouteDeps>) {
    const app = express();
    app.use('/api/agent-cli/outreach', express.json({ limit: '2mb' }));
    app.use('/api/agent-cli', agentCliRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const run = (apiUrl: string, token: string, args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, 'outreach', ...args], {
      env: { ...process.env, HOME: '/nonexistent-agentbuilt-outreach-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: token },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  it('sets a batch from a file, lists it, shows one company, and says what it refused', async () => {
    const { deps, rowan, stranger, outreach, store } = await world();
    const apiUrl = await serve(deps);
    const dir = mkdtempSync(path.join(tmpdir(), 'outreach-cli-'));
    const file = path.join(dir, 'outreach-targets.json');
    writeFileSync(file, JSON.stringify(fixtureOutreachWrite()));
    const set = await run(apiUrl, rowan, ['set', '--file', file]);
    expect(set.stderr).toBe('');
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('Added 14: Northwind Health, Fernhill Labs');
    expect(set.stdout).toContain('Template and follow-ups: written');
    expect(set.stdout).toContain('Nothing was sent.');
    const list = await run(apiUrl, rowan, ['list']);
    expect(list.status).toBe(0);
    // The id first (note #1157), and a stored letter said to be kept, not shown.
    expect(list.stdout).toMatch(/^ID\s+COMPANY\s+STATE\s+PROFILE\s+FIRST LETTER\s+LAST WRITTEN/);
    expect(list.stdout).toMatch(/northwind-health\s+Northwind Health\s+not-contacted\s+yes\s+kept, not shown\s+Rowan, 20/);
    const plain = await run(apiUrl, rowan, ['show', 'northwind-health']);
    expect(plain.stdout).toContain('Northwind Health · id northwind-health · not-contacted');
    expect(plain.stdout).toContain('No letter waits here: give the owner the subject and body in the chat');
    const show = await run(apiUrl, rowan, ['show', 'northwind-health', '--json']);
    expect(JSON.parse(show.stdout)).toMatchObject({ company: 'Northwind Health', written: { profile: { builds: expect.any(String) } } });
    // A letter that has gone cannot be rewritten: refused, said, exit 1.
    const draft = (await outreach.detail('user-adam', 'northwind-health'))!.draft!;
    await store.addTouch('user-adam', { id: 'ot_sent', targetId: 'northwind-health', at: '2026-11-09T13:00:00.000Z', kind: 'sent', step: 'first', mailId: 'mm_1', to: draft.to, subject: draft.subject, text: draft.text });
    const changed = fixtureOutreachWrite();
    ((changed.targets as Array<{ firstEmail: { body: string } }>)[0]!).firstEmail.body = 'Too late.';
    writeFileSync(file, JSON.stringify({ targets: changed.targets }));
    const refused = await run(apiUrl, rowan, ['set', '--file', file]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('REFUSED Northwind Health: Its first letter went on 2026-11-09');
    // Somebody else's agent hears it is not theirs.
    const other = await run(apiUrl, stranger, ['list']);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("platform operator's own");
  });
});

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


describe('Outreach moved into its own app (note #1178)', () => {
  it('answers 410 with the new command, and writes nothing', async () => {
    const { deps, rowan, store } = await world();
    Object.assign(deps, { outreachMovedTo: 'https://outreach.agentbuilt.app' });
    const before = await store.allTargets();
    for (const [path, method, body] of [['/outreach', 'get', undefined], ['/outreach', 'post', fixtureOutreachWrite()], ['/outreach/targets/:id', 'get', undefined]] as const) {
      const answer = await call(deps, rowan, path, method, { body, params: { id: 'northwind-health' } });
      expect(answer.statusCode).toBe(410);
      expect((answer.body as { error: string; code: string }).code).toBe('outreach_moved');
      expect((answer.body as { error: string }).error).toContain('node /tmp/outreach.mjs list');
    }
    expect(await store.allTargets()).toEqual(before);
  });
});
