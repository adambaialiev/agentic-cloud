import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryCopyPulseStore } from '../../services/copy-pulse-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { workspaceAssistantId } from '../../types/user.js';
import type { WorkspaceCopiesAnswer, WorkspaceCopyAnswer } from '../../shared/copy-pulse.js';
import { fixtureCopies, fixtureHistory } from '../../shared/copy-pulse-fixtures.js';
import type { WorkspaceStateAnswer } from '../../shared/workspace-api.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];

describe('the Copies screen\'s reads (note #1058)', () => {
  let server: Server;
  let origin: string;
  let token: string;
  let deps: Partial<RouteDeps>;
  let orgId: string;

  async function serve(opts: { operator?: boolean; privateCopy?: boolean; store?: boolean; seed?: boolean } = {}) {
    const users = new InMemoryUserStorage();
    const orgs = new InMemoryOrgStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    if (opts.operator) await users.updateProfile('alice', { roles: { admin: true } } as never);
    const org = await orgs.createOrg({ name: 'ACC', createdByUserId: 'alice' });
    orgId = org.orgId;
    await orgs.addMember({ orgId, userId: 'alice', role: 'admin' });
    const minted = mintAgentbuiltToken('alice', 'ada'); token = minted.token;
    const waId = workspaceAssistantId('alice', orgId);
    await users.updateProfile('alice', { telegram: { agents: {
      ada: { id: 'ada', name: 'Ada', cli: 'codex', orgId, agentbuiltTokenHash: minted.tokenHash },
      [waId]: { id: waId, name: 'Workspace Agent', cli: 'codex', orgId, purpose: 'workspace-recap', connectedAt: 't', createdAt: 't' },
    } } as never });
    const store = new InMemoryCopyPulseStore();
    if (opts.seed) {
      for (const copy of fixtureCopies(new Date())) {
        for (const day of fixtureHistory(copy.pulse, copy.receivedAt)) await store.record(day.pulse, day.receivedAt);
      }
    }
    deps = {
      userStorage: users, orgStorage: orgs,
      ...(opts.store === false ? {} : { copyPulses: store, copyReleaseList: async () => OFFERED }),
      ...(opts.privateCopy ? { privateCopy: true } : {}),
    };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    app.use('/api/agent-cli', agentCliRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (path: string) => fetch(`${origin}/workspace/api/${path}`, { headers: workspaceTestHeaders(42) });
  const agentGet = (path: string) => fetch(`${origin}/api/agent-cli/${path}`, { headers: { authorization: `Bearer ${token}` } });

  afterEach(async () => { deps?.copyAlerts?.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('is empty before the first pulse, and names the latest release', async () => {
    await serve({ operator: true });
    const response = await get('copies');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ copies: [], latestRelease: '2026.11.06.0' } satisfies WorkspaceCopiesAnswer);
  });

  it('lists every copy, heard from most recently first, and opens one with its days', async () => {
    await serve({ operator: true, seed: true });
    const list = await (await get('copies')).json() as WorkspaceCopiesAnswer;
    expect(list.copies.map((row) => [row.domain, row.standing, row.releasesBehind, row.health.state])).toEqual([
      ['agents.acme.example', 'live', 0, 'ok'],
      ['cloud.northwind.example', 'live', 3, 'trouble'],
      ['agents.initech.example', 'opted-out', 0, 'ok'],
      ['ai.globex.example', 'silent', 0, 'trouble'],
    ]);
    const one = await (await get('copies/fixture-acme-0001')).json() as WorkspaceCopyAnswer;
    expect(one.copy.contactEmail).toBe('dana@acme.example');
    expect(one.days).toHaveLength(21);
    expect(one.days[0]!.turns24h).toBe(171);
    expect(one.days.map((day) => day.day)).toEqual([...one.days.map((day) => day.day)].sort().reverse());
    expect((await get('copies/fixture-nobody')).status).toBe(404);
  });

  it('is the operator\'s alone: the menu offers it only to them, and the server refuses anyone else', async () => {
    await serve({ operator: false, seed: true });
    expect((await get('copies')).status).toBe(403);
    expect((await get('copies/fixture-acme-0001')).status).toBe(403);
    expect((await agentGet('platform/copies')).status).toBe(403);
    expect(((await (await get('state')).json()) as WorkspaceStateAnswer).copies).toBeUndefined();
  });

  it('opens to the operator\'s agents, for the Chief of Staff to read the copy an alert names', async () => {
    await serve({ operator: true, seed: true });
    expect(((await (await get('state')).json()) as WorkspaceStateAnswer).copies).toBe(true);
    const response = await agentGet('platform/copies');
    expect(response.status).toBe(200);
    expect(((await response.json()) as WorkspaceCopiesAnswer).copies).toHaveLength(4);
  });

  it('does not exist in a private copy, which keeps no pulses', async () => {
    await serve({ operator: true, privateCopy: true, seed: true });
    expect((await get('copies')).status).toBe(404);
    expect(((await (await get('state')).json()) as WorkspaceStateAnswer).copies).toBeUndefined();
    expect(deps.copyAlerts).toBeUndefined();
  });

  it('lands the alerts as rows in the operator\'s Chief of Staff chat, in the workplace they made', async () => {
    await serve({ operator: true, seed: true });
    expect(await deps.copyAlerts!.sweep()).toBeGreaterThanOrEqual(5);
    const chat = deps.workspaceAgent as unknown as { read(user: string, org: string): Promise<{ working: boolean; messages: Array<{ kind?: string; text: string; href?: string }> }> };
    const read = await chat.read('alice', orgId);
    expect(read.working).toBe(false);
    const rows = read.messages.filter((m) => m.kind === 'event');
    expect(rows.map((m) => m.href)).toContain('/copies/fixture-northwind-02');
    expect(rows.map((m) => m.text).join('\n')).toMatch(/cloud\.northwind\.example runs 2026\.11\.01\.1, 3 releases behind/);
    expect(rows.map((m) => m.text).join('\n')).toMatch(/agents\.initech\.example turned its daily pulse off/);
    expect(rows.map((m) => m.text).join('\n')).toMatch(/ai\.globex\.example has been silent for 4 days/);
    // Said once: a second look says nothing.
    expect(await deps.copyAlerts!.sweep()).toBe(0);
  });
});
