import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { MailOutboxService } from '../../services/mail-outbox.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import type { OutboundMail } from '../../services/mail-sender.js';
import { MailApprovalService } from '../../services/mail-approval.js';
import { InMemoryMailApprovalStorage } from '../../services/mail-approval-storage.js';

/**
 * An agent reading and writing its owner's mail (note #509, slice 6).
 *
 * Two promises are worth tests rather than reading. First, WHOSE mail this is:
 * every route is keyed on the human the agent belongs to, so a message of
 * somebody else's is not merely hidden, it is absent. Second, what the
 * recipient sees: the person, because the address is theirs — while the row
 * their owner reads afterwards says which agent actually wrote it.
 */

interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}

function getRouteHandler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post') {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

/** Where a path sits in the router's own order — Express matches top-down. */
function routeIndex(deps: Partial<RouteDeps>, path: string): number {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string } }>;
  };
  return router.stack.findIndex((c) => c.route?.path === path);
}

function mockRequest(args: { headers?: Record<string, string>; params?: Record<string, string>; query?: Record<string, string>; body?: unknown }): Partial<Request> {
  const headers = Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: args.query ?? {},
    body: args.body,
  };
}

const arrived = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => ({
  id: 'mm_in',
  userId: 'user-1',
  address: 'adam@agenticcloudcomputer.com',
  envelopeFrom: 'bounces@example.com',
  receivedAt: '2026-09-15T09:00:00.000Z',
  messageId: 'abc-123@example.com',
  from: { name: 'Ada Lovelace', address: 'ada@example.com' },
  to: [{ address: 'adam@agenticcloudcomputer.com' }],
  cc: [],
  replyTo: [],
  subject: 'The engine',
  snippet: 'It weaves algebraic patterns.',
  text: 'It weaves algebraic patterns.',
  attachments: [],
  raw: { storagePath: 'users/user-1/mail/mm_in/raw.eml', size: 2048 },
  ...over,
});

async function buildDeps(opts: { mailbox?: boolean } = {}) {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'Adam' });
  await userStorage.updateProfile('user-1', { person: { firstName: 'Adam', lastName: 'Baialiev' } as never });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: { 'agent-a': { id: 'agent-a', name: 'Alex', cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
    },
  });
  const db = openSqliteDb(':memory:');
  const mailboxStorage = new SqliteMailboxStorage(db);
  const mailboxes = new MailboxService(mailboxStorage);
  const mailMessages = new SqliteMailMessageStorage(db);
  if (opts.mailbox !== false) await mailboxes.claim('user-1', 'adam');
  const sent: OutboundMail[] = [];
  const sender = { send: vi.fn(async (mail: OutboundMail) => { sent.push(mail); return {}; }) };
  const mailOutbox = new MailOutboxService({ mailboxes: mailboxStorage, messages: mailMessages, sender });
  const mailApprovals = new MailApprovalService(new InMemoryMailApprovalStorage(), mailOutbox);
  const requestMailApproval = vi.fn(async () => true);
  const deps: Partial<RouteDeps> = {
    userStorage, mailboxes, mailMessages, mailOutbox, mailApprovals,
    agentLifecycle: { requestMailApproval } as never,
  };
  return { deps, token, mailMessages, sent, mailApprovals, requestMailApproval };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('agentbuilt mail', () => {
  it('declares the sent box before /mail/:id, or the parser reads "sent" as an id', async () => {
    const { deps } = await buildDeps();
    const sent = routeIndex(deps, '/mail/sent');
    const one = routeIndex(deps, '/mail/:id');
    expect(sent).toBeGreaterThan(-1);
    expect(sent).toBeLessThan(one);
  });

  it('declares the blocked list before /mail/:id too — in production, `mail blocked` answered "No such message" until it did', async () => {
    const { deps } = await buildDeps();
    const blocked = routeIndex(deps, '/mail/blocked');
    const one = routeIndex(deps, '/mail/:id');
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(one);
  });

  it('says where an address comes from when the user has not taken one', async () => {
    const { deps, token } = await buildDeps({ mailbox: false });
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail', 'get')(mockRequest({ headers: authHeader(token) }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('Settings → Your address');
  });

  it('lists the owner’s mail, and names the agent on a row the owner did not write', async () => {
    const { deps, token, mailMessages, mailApprovals } = await buildDeps();
    await mailMessages.store(arrived());
    const request = createMockResponse();
    await getRouteHandler(deps, '/mail/send', 'post')(
      mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'About Tuesday', text: 'Four?' } }),
      request,
    );
    await mailApprovals.decide({ userId: 'user-1', id: (request.body as { approval: { id: string } }).approval.id, decision: 'approve' });

    const res = createMockResponse();
    await getRouteHandler(deps, '/mail', 'get')(mockRequest({ headers: authHeader(token) }), res);
    const body = res.body as { address: string; messages: Array<Record<string, unknown>> };
    expect(body.address).toBe('adam@agenticcloudcomputer.com');
    expect(body.messages).toHaveLength(2);
    const written = body.messages.find((row) => row.direction === 'sent')!;
    expect(written.to).toEqual([{ address: 'ada@example.com' }]);
    // The point of the field: the owner can see they did not write this.
    expect(written.sentBy).toBe('Alex');
    expect(body.messages.find((row) => row.direction === 'in')!.sentBy).toBeUndefined();
  });

  it('asks in chat first, then a tap sends as the PERSON — the recipient never learns an agent wrote it', async () => {
    const { deps, token, sent, mailApprovals, requestMailApproval } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/send', 'post')(
      mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'Hello', text: 'Are you free at four?' } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
    expect(requestMailApproval).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', agentId: 'agent-a', approvalId: expect.stringMatching(/^ma_/),
    }));
    expect((res.body as { said: string }).said).toContain('Nothing was sent');
    await mailApprovals.decide({
      userId: 'user-1', id: (res.body as { approval: { id: string } }).approval.id, decision: 'approve',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toEqual({ address: 'adam@agenticcloudcomputer.com', name: 'Adam Baialiev' });
    expect(JSON.stringify(sent[0]!)).not.toContain('Alex');
  });

  it('keeps nothing approvable when the confirmation card cannot reach chat', async () => {
    const { deps, token, sent, mailApprovals, requestMailApproval } = await buildDeps();
    requestMailApproval.mockResolvedValueOnce(false);
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/send', 'post')(
      mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'Hello', text: 'Four?' } }),
      res,
    );
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toContain('Nothing was sent');
    const id = requestMailApproval.mock.calls[0]![0].approvalId;
    expect(await mailApprovals.get('user-1', id)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('answers whoever wrote, and cannot be aimed anywhere else', async () => {
    const { deps, token, mailMessages, sent, mailApprovals } = await buildDeps();
    await mailMessages.store(arrived());
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/:id/reply', 'post')(
      mockRequest({ headers: authHeader(token), params: { id: 'mm_in' }, body: { text: 'It does indeed.', to: 'somebody@else.com' } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
    await mailApprovals.decide({
      userId: 'user-1', id: (res.body as { approval: { id: string } }).approval.id, decision: 'approve',
    });
    // The `to` in the request body is not read by anything: the recipient came
    // off the message, on this side.
    expect(sent[0]!.to).toEqual([{ address: 'ada@example.com', name: 'Ada Lovelace' }]);
  });

  it('shows everything that has gone out — including the replies the list cannot show', async () => {
    const { deps, token, mailMessages, mailApprovals } = await buildDeps();
    await mailMessages.store(arrived());
    const reply = createMockResponse();
    await getRouteHandler(deps, '/mail/:id/reply', 'post')(
      mockRequest({ headers: authHeader(token), params: { id: 'mm_in' }, body: { text: 'It does indeed.' } }),
      reply,
    );
    await mailApprovals.decide({ userId: 'user-1', id: (reply.body as { approval: { id: string } }).approval.id, decision: 'approve' });
    const fresh = createMockResponse();
    await getRouteHandler(deps, '/mail/send', 'post')(
      mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'New', text: 'Hello' } }),
      fresh,
    );
    await mailApprovals.decide({ userId: 'user-1', id: (fresh.body as { approval: { id: string } }).approval.id, decision: 'approve' });

    // The list is what is in front of the reader: the arrived message and the
    // one they started. The reply sits under what it answers, not here.
    const list = createMockResponse();
    await getRouteHandler(deps, '/mail', 'get')(mockRequest({ headers: authHeader(token) }), list);
    const listed = (list.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(listed.map((row) => row.subject).sort()).toEqual(['New', 'The engine']);

    // The sent box is the other question, and it has all three answers.
    const sent = createMockResponse();
    await getRouteHandler(deps, '/mail/sent', 'get')(mockRequest({ headers: authHeader(token) }), sent);
    const rows = (sent.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.direction === 'sent')).toBe(true);
    const answer = rows.find((row) => row.subject === 'Re: The engine')!;
    // Which message it answers, so the agent can open the thread from here.
    expect(answer.answers).toBe('mm_in');
    expect(rows.find((row) => row.subject === 'New')!.answers).toBeUndefined();
  });

  it('tells a user with no address where one is chosen — on a reply as well as a send', async () => {
    const { deps, token, mailMessages } = await buildDeps({ mailbox: false });
    await mailMessages.store(arrived());
    for (const [path, req] of [
      ['/mail/send', mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', text: 'Hello' } })],
      ['/mail/:id/reply', mockRequest({ headers: authHeader(token), params: { id: 'mm_in' }, body: { text: 'Hello' } })],
    ] as const) {
      const res = createMockResponse();
      await getRouteHandler(deps, path, 'post')(req, res);
      expect(res.statusCode).toBe(409);
      // The sentence that says WHERE — not "this is not replyable", which
      // tells somebody without an address nothing they can act on.
      expect((res.body as { error: string }).error).toContain('Settings → Your address');
    }
  });

  it('cannot reach another person’s mail, even by knowing its id', async () => {
    const { deps, token, mailMessages } = await buildDeps();
    await mailMessages.store(arrived({ id: 'mm_theirs', userId: 'user-2', address: 'someone@agenticcloudcomputer.com' }));
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/:id', 'get')(
      mockRequest({ headers: authHeader(token), params: { id: 'mm_theirs' } }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  it('spends the same ceiling the person does — an agent is not a second allowance', async () => {
    const { deps, token, mailApprovals } = await buildDeps();
    const send = getRouteHandler(deps, '/mail/send', 'post');
    const write = async () => {
      const response = createMockResponse();
      await send(mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'x', text: 'y' } }), response);
      if (response.statusCode === 202) {
        await mailApprovals.decide({ userId: 'user-1', id: (response.body as { approval: { id: string } }).approval.id, decision: 'approve' });
      }
    };
    for (let i = 0; i < 10; i += 1) await write();
    const res = createMockResponse();
    await send(mockRequest({ headers: authHeader(token), body: { to: 'ada@example.com', subject: 'x', text: 'y' } }), res);
    expect(res.statusCode).toBe(429);
    expect((res.body as { code: string }).code).toBe('too_many');
  });

  it('asks to FORWARD in chat (slice 12): the card says so, Cc and all, and an approval sends Fwd: as the person', async () => {
    const { deps, token, sent, mailMessages, mailApprovals, requestMailApproval } = await buildDeps();
    await mailMessages.store(arrived());
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/:id/forward', 'post')(
      mockRequest({ headers: authHeader(token), params: { id: 'mm_in' }, body: { to: 'bob@example.com', cc: ['carol@example.com'], text: 'For you' } }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
    expect((res.body as { said: string }).said)
      .toBe('Approval requested in your chat for a forward to bob@example.com (Cc carol@example.com). Nothing was sent.');
    expect(requestMailApproval).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Alex wants to forward a letter to bob@example.com and 1 more. Nothing will be sent until you approve it here.',
    }));
    await mailApprovals.decide({ userId: 'user-1', id: (res.body as { approval: { id: string } }).approval.id, decision: 'approve' });
    expect(sent[0]!.subject).toBe('Fwd: The engine');
    expect(sent[0]!.cc).toEqual([{ address: 'carol@example.com' }]);
    expect(sent[0]!.from).toEqual({ address: 'adam@agenticcloudcomputer.com', name: 'Adam Baialiev' });
  });

  it('says plainly when files cannot be kept on this backend, and places no card', async () => {
    const { deps, token, requestMailApproval } = await buildDeps();
    const manifest = Buffer.from(JSON.stringify({ to: 'ada@example.com', text: 'hi', files: [{ fileName: 'a.txt', sizeBytes: 2 }] }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(manifest.length, 0);
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/send', 'post')(
      mockRequest({ headers: authHeader(token), body: Buffer.concat([prefix, manifest, Buffer.from('hi')]) }),
      res,
    );
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('files_unavailable');
    expect(requestMailApproval).not.toHaveBeenCalled();
  });

  it('hands `mail show` the letter’s other recipients for --all, read off the letter', async () => {
    const { deps, token, mailMessages } = await buildDeps();
    await mailMessages.store(arrived({ to: [{ address: 'adam@agenticcloudcomputer.com' }, { address: 'carol@example.com' }] }));
    const res = createMockResponse();
    await getRouteHandler(deps, '/mail/:id', 'get')(mockRequest({ headers: authHeader(token), params: { id: 'mm_in' } }), res);
    expect((res.body as { message: { answerAll: unknown } }).message.answerAll).toEqual([{ address: 'carol@example.com' }]);
  });
});
