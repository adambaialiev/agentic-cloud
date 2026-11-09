import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { workspaceRoutes } from '../../routes/workspace.js';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { RemoteDirectMessageStorage } from '../../services/remote-direct-message-storage.js';
import { SqliteDirectMessageUnreadStore } from '../../services/sqlite/sqlite-direct-message-unread-store.js';
import { SqliteDirectMessageStorage } from '../../services/sqlite/sqlite-direct-message-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { OrgMsgHostOpening } from '../../services/org-msg-host.js';
import {
  DirectMessageApprovalService,
  InMemoryDirectMessageApprovalStorage,
  SqliteDirectMessageApprovalStorage,
  resolveTeammate,
} from '../../services/direct-message-approval.js';
import { DIRECT_MESSAGE_VIA_PREFIX, sentViaChiefOfStaff } from '../../shared/direct-messages.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { startMsgHost, type MsgHostProcess } from './msg-host-process.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Note #1090: the Chief of Staff drafts a direct message to a teammate, the
 * person's tap on its card sends it. Three promises are tested rather than
 * read: only the tap sends, and as the person, marked; the agent's side is
 * write-only (a status, never words); and once decided, the platform keeps
 * no words of it — the message lives on the messaging machine alone.
 */
describe('a Chief of Staff draft released by the person, through the real router and messaging host', () => {
  let server: Server, origin: string, orgId: string, otherOrgId: string;
  let db: SqliteDb, hosts: Map<string, MsgHostProcess>, approvals: DirectMessageApprovalService, orgs: InMemoryOrgStorage;
  const api = (who: number, path: string, method = 'GET', body?: unknown, org?: string) => fetch(`${origin}/workspace/api/${path}?org=${org ?? orgId}`, {
    method, headers: { ...workspaceTestHeaders(who), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const draft = (text = 'Aigerim, the board meets at 3.') => approvals.request({
    userId: 'alice', orgId, agentId: 'wa-alice', to: { userId: 'bob', name: 'Bob Builder' }, text,
  });
  beforeEach(async () => {
    const users = new InMemoryUserStorage(); orgs = new InMemoryOrgStorage();
    db = openSqliteDb(':memory:');
    for (const name of ['alice', 'bob', 'carol']) await users.createProfile(name, { email: `${name}@example.test`, displayName: name });
    orgId = (await orgs.createOrg({ name: 'Studio', createdByUserId: 'alice' })).orgId;
    otherOrgId = (await orgs.createOrg({ name: 'Elsewhere', createdByUserId: 'alice' })).orgId;
    for (const name of ['alice', 'bob', 'carol']) await orgs.addMember({ orgId, userId: name, role: name === 'alice' ? 'admin' : 'member' });
    for (const name of ['alice', 'bob']) await orgs.addMember({ orgId: otherOrgId, userId: name, role: 'member' });
    hosts = new Map();
    for (const id of [orgId, otherOrgId]) hosts.set(id, await startMsgHost({ orgId: id }));
    const storage = new RemoteDirectMessageStorage({ call: (id, operation, body) => hosts.get(id)!.call(id, operation, body) }, new SqliteDirectMessageUnreadStore(db));
    approvals = new DirectMessageApprovalService(new SqliteDirectMessageApprovalStorage(db), () => storage,
      async (org, user) => Boolean(await orgs.getMembership(org, user)));
    const deps: Partial<RouteDeps> = { userStorage: users, orgStorage: orgs, directMessageStorage: storage, directMessageApprovals: approvals };
    await addWorkspaceTestAuth(deps, users, { 1: 'alice', 2: 'bob', 3: 'carol' });
    const app = express(); app.use(express.json()); app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await Promise.all([...hosts.values()].map(host => host.stop())); });

  it('sends nothing until the tap, then lands once in the teammate\'s conversation as the person, marked', async () => {
    const doc = await draft();
    // Waiting: the card shows the words; the teammate has nothing.
    const waiting = await (await api(1, `message-approvals/${doc.id}`)).json();
    expect(waiting.approval).toMatchObject({ status: 'pending', to: { userId: 'bob', name: 'Bob Builder' }, text: 'Aigerim, the board meets at 3.' });
    expect((await (await api(2, 'messages')).json()).threads).toEqual([]);

    const tap = await api(1, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' });
    expect(tap.status).toBe(200);
    const sent = (await tap.json()).approval;
    expect(sent.status).toBe('sent');
    expect(sent.text).toBeUndefined();

    const page = await (await api(2, 'messages/alice')).json();
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ senderId: 'alice', text: 'Aigerim, the board meets at 3.' });
    expect(page.messages[0].clientId.startsWith(DIRECT_MESSAGE_VIA_PREFIX)).toBe(true);
    expect(sentViaChiefOfStaff(page.messages[0])).toBe(true);
    expect((await (await api(2, 'messages/unread')).json()).unread).toBe(1);

    // A second tap (another tab) sends nothing more.
    expect((await (await api(1, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' })).json()).approval.status).toBe('sent');
    expect((await (await api(2, 'messages/alice')).json()).messages).toHaveLength(1);
  });

  it('keeps no words on the platform once decided, whichever way', async () => {
    const one = await draft('A sentence only the messaging machine may keep.');
    const two = await draft('A sentence nobody sent.');
    await api(1, `message-approvals/${one.id}/decision`, 'POST', { decision: 'approve' });
    await api(1, `message-approvals/${two.id}/decision`, 'POST', { decision: 'reject' });
    const rows = db.prepare('SELECT status, doc FROM workspace_message_approvals ORDER BY created_at').all() as Array<{ status: string; doc: string }>;
    expect(rows.map(row => row.status).sort()).toEqual(['rejected', 'sent']);
    for (const row of rows) expect(row.doc).not.toMatch(/sentence/);
    // The refused one reached nobody.
    expect((await (await api(2, 'messages/alice')).json()).messages.map((m: { text: string }) => m.text)).toEqual(['A sentence only the messaging machine may keep.']);
  });

  it('is answered only by its own person, in its own workplace', async () => {
    const doc = await draft();
    expect((await api(2, `message-approvals/${doc.id}`)).status).toBe(404);
    expect((await api(2, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' })).status).toBe(404);
    expect((await api(3, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' })).status).toBe(404);
    expect((await api(1, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' }, otherOrgId)).status).toBe(404);
    expect((await api(1, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'maybe' })).status).toBe(400);
    expect((await (await api(1, `message-approvals/${doc.id}`)).json()).approval.status).toBe('pending');
  });

  it('a browser cannot wear the mark: its own Send refuses the prefix', async () => {
    const forged = await api(1, 'messages/bob', 'POST', { text: 'I am the agent', clientId: `${DIRECT_MESSAGE_VIA_PREFIX}0123456789abcdef` });
    expect(forged.status).toBe(400);
    expect((await (await api(2, 'messages')).json()).threads).toEqual([]);
  });

  it('a teammate who left before the tap gets nothing, and the card says why', async () => {
    const doc = await draft();
    await orgs.removeMember(orgId, 'bob');
    const answer = (await (await api(1, `message-approvals/${doc.id}/decision`, 'POST', { decision: 'approve' })).json()).approval;
    expect(answer.status).toBe('rejected');
    expect(answer.error).toMatch(/no longer in this workplace/);
    expect(answer.text).toBeUndefined();
  });
});

describe('the approval service on its own', () => {
  const build = (send = vi.fn(async () => ({ message: {} as never, created: true })), member = true) => {
    let now = new Date('2026-11-09T12:00:00Z');
    const service = new DirectMessageApprovalService(new InMemoryDirectMessageApprovalStorage(), () => ({ send }),
      async () => member, () => now);
    return { service, send, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
  };
  const ask = (service: DirectMessageApprovalService, text = 'Hello') => service.request({
    userId: 'alice', orgId: 'o1', agentId: 'wa', to: { userId: 'bob', name: 'Bob' }, text,
  });

  it('refuses empty words, overlong words and the person themself', async () => {
    const { service } = build();
    await expect(ask(service, '  ')).rejects.toThrow(/up to 8,000/);
    await expect(ask(service, 'x'.repeat(8001))).rejects.toThrow(/up to 8,000/);
    await expect(service.request({ userId: 'alice', orgId: 'o1', agentId: 'wa', to: { userId: 'alice', name: 'Alice' }, text: 'Hi' })).rejects.toThrow(/teammate/);
  });

  it('a draft nobody answered in a day expires and takes its words with it', async () => {
    const { service, send, tick } = build();
    const doc = await ask(service);
    tick(24 * 60 * 60_000);
    const answer = await service.decide({ userId: 'alice', orgId: 'o1', id: doc.id, decision: 'approve' });
    expect(answer).toMatchObject({ status: 'expired' });
    expect(answer!.text).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('a sleeping messaging machine reopens the card with words to try again, and the retry sends once under the same id', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new OrgMsgHostOpening())
      .mockResolvedValue({ message: {} as never, created: true });
    const { service } = build(send);
    const doc = await ask(service);
    const first = await service.decide({ userId: 'alice', orgId: 'o1', id: doc.id, decision: 'approve' });
    expect(first).toMatchObject({ status: 'pending', text: 'Hello' });
    expect(first!.error).toMatch(/waking up/);
    const second = await service.decide({ userId: 'alice', orgId: 'o1', id: doc.id, decision: 'approve' });
    expect(second).toMatchObject({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![4]).toBe(send.mock.calls[1]![4]);
    expect(String(send.mock.calls[0]![4]).startsWith(DIRECT_MESSAGE_VIA_PREFIX)).toBe(true);
    expect(send.mock.calls[0]!.slice(0, 4)).toEqual(['o1', 'alice', 'bob', 'Hello']);
  });

  it('a card in another workplace is not this one\'s to answer', async () => {
    const { service, send } = build();
    const doc = await ask(service);
    expect(await service.decide({ userId: 'alice', orgId: 'o2', id: doc.id, decision: 'approve' })).toBeNull();
    expect(await service.decide({ userId: 'bob', orgId: 'o1', id: doc.id, decision: 'approve' })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('resolveTeammate', () => {
  const people = [{ userId: 'u1', name: 'Aigerim Sadykova' }, { userId: 'u2', name: 'Ben Ross' }, { userId: 'u3', name: 'Ben Stone' }];
  it('finds a full name in any case, a unique first name, or an id', () => {
    expect(resolveTeammate(people, 'aigerim  sadykova')).toEqual(people[0]);
    expect(resolveTeammate(people, 'Aigerim')).toEqual(people[0]);
    expect(resolveTeammate(people, 'u2')).toEqual(people[1]);
  });
  it('refuses an ambiguous first name and a stranger, naming who is there', () => {
    expect(resolveTeammate(people, 'Ben')).toEqual({ error: expect.stringMatching(/More than one teammate.*"Ben Ross"/) });
    expect(resolveTeammate(people, 'Zara')).toEqual({ error: expect.stringMatching(/not a member of this workplace.*"Aigerim Sadykova"/) });
  });
});

// ── The agent's side: `agentbuilt member` ──────────────────────────────────

interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }
function mockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}
function handler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post') {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}
function call(deps: Partial<RouteDeps>, token: string, method: 'get' | 'post', path: string, args: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const res = mockResponse();
  const req: Partial<Request> = {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {}, query: {}, body: args.body, method: method.toUpperCase(), path,
  };
  return handler(deps, path, method)(req, res).then(() => res);
}

describe('agentbuilt member: the Chief of Staff\'s verb, write-only', () => {
  async function build(opts: { alone?: boolean; cardLands?: boolean } = {}) {
    const users = new InMemoryUserStorage(), orgs = new InMemoryOrgStorage();
    await users.createProfile('alice', { email: 'a@example.test', displayName: 'Alice' });
    await users.createProfile('bob', { email: 'b@example.test', displayName: 'bob' });
    await users.updateProfile('bob', { person: { firstName: 'Bob', lastName: 'Builder' } as never });
    const orgId = (await orgs.createOrg({ name: 'Studio', createdByUserId: 'alice' })).orgId;
    await orgs.addMember({ orgId, userId: 'alice', role: 'admin' });
    if (!opts.alone) await orgs.addMember({ orgId, userId: 'bob', role: 'member' });
    const wa = mintAgentbuiltToken('alice', 'wa-alice'), plain = mintAgentbuiltToken('alice', 'agent-a');
    await users.updateProfile('alice', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true,
        agents: {
          'wa-alice': { id: 'wa-alice', name: 'Workspace Agent', cli: 'claude', orgId, purpose: 'workspace-recap', agentbuiltTokenHash: wa.tokenHash } as never,
          'agent-a': { id: 'agent-a', name: 'Kai', cli: 'claude', orgId, agentbuiltTokenHash: plain.tokenHash } as never,
        },
      },
    });
    const db = openSqliteDb(':memory:');
    const storage = new SqliteDirectMessageStorage(db);
    const approvals = new DirectMessageApprovalService(new InMemoryDirectMessageApprovalStorage(), () => storage,
      async (org, user) => Boolean(await orgs.getMembership(org, user)));
    const requestMessageApproval = vi.fn(async () => opts.cardLands ?? true);
    const deps: Partial<RouteDeps> = {
      userStorage: users, orgStorage: orgs, directMessageStorage: storage, directMessageApprovals: approvals,
      workspaceAgent: { requestMessageApproval } as never,
    };
    return { deps, orgId, wa: wa.token, plain: plain.token, approvals, storage, requestMessageApproval };
  }

  it('is refused to every agent but the Chief of Staff', async () => {
    const { deps, plain, requestMessageApproval } = await build();
    const res = await call(deps, plain, 'post', '/members/message', { body: { name: 'Bob', text: 'Hi' } });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/Chief of Staff's verb alone/);
    expect((await call(deps, plain, 'get', '/members')).statusCode).toBe(403);
    expect(requestMessageApproval).not.toHaveBeenCalled();
  });

  it('is refused in a workplace of one, and for a name that is not a member', async () => {
    const alone = await build({ alone: true });
    const solo = await call(alone.deps, alone.wa, 'post', '/members/message', { body: { name: 'Bob', text: 'Hi' } });
    expect(solo.statusCode).toBe(409);
    expect((solo.body as { error: string }).error).toMatch(/only person in this workplace/);
    const { deps, wa } = await build();
    const stranger = await call(deps, wa, 'post', '/members/message', { body: { name: 'Zara', text: 'Hi' } });
    expect(stranger.statusCode).toBe(404);
    expect((stranger.body as { error: string }).error).toMatch(/not a member of this workplace.*"Bob Builder".*Nothing was sent/);
  });

  it('places the card and sends nothing; the status answers a word and never the words', async () => {
    const { deps, wa, orgId, approvals, storage, requestMessageApproval } = await build();
    const listed = await call(deps, wa, 'get', '/members');
    expect(listed.body).toEqual({ members: [{ id: 'bob', name: 'Bob Builder' }] });

    const res = await call(deps, wa, 'post', '/members/message', { body: { name: 'bob', text: 'The board meets at 3.' } });
    expect(res.statusCode).toBe(202);
    const { approval, said } = res.body as { approval: { id: string; to: string }; said: string };
    expect(approval.to).toBe('Bob Builder');
    expect(said).toMatch(/Nothing was sent/);
    expect(requestMessageApproval).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', orgId, approvalId: approval.id }));
    expect(await storage.inbox(orgId, 'bob')).toEqual([]);

    const waiting = await call(deps, wa, 'get', '/members/message/:id', { params: { id: approval.id } });
    expect(waiting.body).toEqual({ id: approval.id, to: 'Bob Builder', status: 'waiting' });

    await approvals.decide({ userId: 'alice', orgId, id: approval.id, decision: 'approve' });
    const sent = await call(deps, wa, 'get', '/members/message/:id', { params: { id: approval.id } });
    expect(sent.body).toEqual({ id: approval.id, to: 'Bob Builder', status: 'sent' });
    expect(JSON.stringify(sent.body)).not.toMatch(/board/);
    expect((await storage.page(orgId, 'bob', 'alice', 10)).messages[0]).toMatchObject({ senderId: 'alice', text: 'The board meets at 3.' });
  });

  it('a declined draft reads "declined"; a card that cannot be placed withdraws the request', async () => {
    const { deps, wa, orgId, approvals } = await build();
    const res = await call(deps, wa, 'post', '/members/message', { body: { name: 'Bob Builder', text: 'Hi' } });
    const id = (res.body as { approval: { id: string } }).approval.id;
    await approvals.decide({ userId: 'alice', orgId, id, decision: 'reject' });
    expect((await call(deps, wa, 'get', '/members/message/:id', { params: { id } })).body).toMatchObject({ status: 'declined' });

    const failing = await build({ cardLands: false });
    const refused = await call(failing.deps, failing.wa, 'post', '/members/message', { body: { name: 'Bob', text: 'Hi' } });
    expect(refused.statusCode).toBe(503);
    expect((refused.body as { error: string }).error).toMatch(/Nothing was sent/);
  });
});
