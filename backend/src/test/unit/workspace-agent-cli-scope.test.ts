import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { workspaceAssistantId, workspaceBriefingId } from '../../types/user.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { MailOutboxService } from '../../services/mail-outbox.js';
import { MailApprovalService } from '../../services/mail-approval.js';
import { InMemoryMailApprovalStorage } from '../../services/mail-approval-storage.js';
import { AgentScheduleService } from '../../services/agent-schedules.js';
import { InMemoryAgentScheduleStorage } from '../../services/agent-schedule-storage.js';

/**
 * The Workspace Agent's credential is an ordinary agentbuilt token whose
 * record carries `purpose`. What that buys and what it refuses lives in the
 * routes' `authenticate`: the verbs the owner allowed, and the receipts the
 * conversation shows. Rooms are gone (note #843): one workplace, and the
 * `--room` an older CLI still sends is read by nothing.
 */
interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }
function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}
function handler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post' | 'put' | 'delete') {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}
/** A request as express hands it to a router: method and router-relative path included. */
function request(args: { token: string; method: string; path: string; room?: string; params?: Record<string, string>; query?: Record<string, string>; body?: unknown }): Partial<Request> {
  const headers: Record<string, string> = { authorization: `Bearer ${args.token}`, ...(args.room ? { 'x-agentbuilt-room': args.room } : {}) };
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    method: args.method, path: args.path,
    params: args.params ?? {}, query: args.query ?? {}, body: args.body,
  };
}

/** One workplace: the person's Workspace Agent and briefing credentials, and
 *  Ben, an ordinary agent of theirs. */
async function build() {
  const userStorage = new InMemoryUserStorage();
  const orgStorage = new InMemoryOrgStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const org = await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'user-1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
  const assistantId = workspaceAssistantId('user-1', org.orgId);
  const briefingId = workspaceBriefingId('user-1', org.orgId);
  const workspace = mintAgentbuiltToken('user-1', assistantId);
  const briefing = mintAgentbuiltToken('user-1', briefingId);
  const agent = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        [assistantId]: { id: assistantId, name: 'Workspace Agent', purpose: 'workspace-recap', orgId: org.orgId, cli: 'claude', agentbuiltTokenHash: workspace.tokenHash } as never,
        [briefingId]: { id: briefingId, name: 'Workspace Recap', purpose: 'workspace-briefing', orgId: org.orgId, cli: 'claude', agentbuiltTokenHash: briefing.tokenHash } as never,
        'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', orgId: org.orgId, agentbuiltTokenHash: agent.tokenHash } as never,
      },
    },
  });
  const mailDb = openSqliteDb(':memory:');
  const mailboxStorage = new SqliteMailboxStorage(mailDb);
  const mailMessages = new SqliteMailMessageStorage(mailDb);
  await new MailboxService(mailboxStorage).claim('user-1', 'adam');
  const sendMail = vi.fn(async () => ({}));
  const mailOutbox = new MailOutboxService({ mailboxes: mailboxStorage, messages: mailMessages, sender: { send: sendMail } });
  const mailApprovals = new MailApprovalService(new InMemoryMailApprovalStorage(), mailOutbox);
  const workspaceAgent = { receipt: vi.fn(async () => {}), requestMailApproval: vi.fn(async () => true), messageAgent: vi.fn(async () => ({ ok: true as const, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' } })), agentHistory: vi.fn(async () => ({ ok: true as const, agent: { id: 'agent-a', name: 'Ben' }, steps: [{ role: 'agent' as const, author: 'Ben', at: '2026-09-10T09:00:00.000Z', text: 'Working on it.' }] })), resetConversation: vi.fn(async () => ({ ok: true as const })), receiveFromAgent: vi.fn(async () => ({ ok: true as const, name: 'Workspace Agent' })), stopAgent: vi.fn(async () => ({ ok: true as const, name: 'Ben', idle: true })), resetAgent: vi.fn(async () => ({ ok: true as const, name: 'Ben' })), askRemoveAgent: vi.fn(async () => ({ ok: true as const, name: 'Ben' })), changeAgentRuntime: vi.fn(async () => ({ ok: true as const, name: 'Ben', cli: 'claude' as const, model: 'sonnet', effort: 'high', was: { model: 'opus', effort: 'high' }, changed: true, working: false })) };
  const createAgent = vi.fn(async () => ({ ok: true as const, agent: { id: 'agent-new', name: 'Mia' } }));
  const requestMailApproval = vi.fn(async () => true);
  const scheduleRows: string[] = [];
  const agentSchedules = new AgentScheduleService({
    storage: new InMemoryAgentScheduleStorage(),
    getAgent: async (userId, agentId) => (await userStorage.getProfile(userId))?.telegram?.agents?.[agentId] ?? null,
    listAgents: async (userId) => Object.values((await userStorage.getProfile(userId))?.telegram?.agents ?? {}),
    isAgentWorking: () => false, contextPercent: () => null,
    startScheduledTurn: async () => 'delivered', resetChat: async () => ({ ok: true }), subscriptionHasRoom: async () => null, tokensSpent: () => 0,
    latestChatRow: async () => null, tellOwner: async () => undefined, recordRow: async ({ text }) => { scheduleRows.push(text); }, notifyAgent: async () => undefined, log: () => undefined,
  });
  const deps: Partial<RouteDeps> = {
    userStorage, orgStorage, orgGit: new OrgGitService({ orgStorage }), quickNoteStorage: new InMemoryQuickNoteStorage(), workspaceAgent,
    mailApprovals, mailOutbox, mailMessages, agentSchedules,
    agentLifecycle: { messagePeer: vi.fn(async () => ({ ok: true as const, recipient: { id: 'x', name: 'X', cli: 'claude' } })), requestMailApproval, createAgent } as never,
  };
  return { deps, org: org.orgId, workspaceToken: workspace.token, briefingToken: briefing.token, agentToken: agent.token, workspaceAgent, assistantId, requestMailApproval, sendMail, createAgent, agentSchedules, scheduleRows };
}

describe('the Workspace Agent credential', () => {
  it('refuses a token that names the briefing machine, which is never given one (note #437)', async () => {
    const x = await build();
    const list = createMockResponse();
    await handler(x.deps, '/notes', 'get')(request({ token: x.briefingToken, method: 'GET', path: '/notes' }), list);
    expect(list.statusCode).toBe(403);
    expect(String((list.body as { error: string }).error)).toContain('holds no agent credential');
  });
  it('is accepted for ordinary agent verbs as well as its coordinator verbs', async () => {
    const x = await build();
    const list = createMockResponse();
    await handler(x.deps, '/notes', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/notes' }), list);
    expect(list.statusCode).toBe(200);
    expect(list.body).toMatchObject({ notes: [] });
    const sites = createMockResponse();
    await handler(x.deps, '/deployments', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/deployments' }), sites);
    // The route dependencies are deliberately absent in this small fixture:
    // 503 proves authentication passed instead of the former purpose 403.
    expect(sites.statusCode).toBe(503);
    const repos = createMockResponse();
    await handler(x.deps, '/repos', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/repos' }), repos);
    expect(repos.statusCode).toBe(503);
  });
  it('puts each mail request in the calling chat, for the Workspace Agent and an ordinary agent alike', async () => {
    const x = await build();
    const route = handler(x.deps, '/mail/send', 'post');
    const body = { to: 'ada@example.com', subject: 'Tuesday', text: 'Four?' };
    const workspace = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/mail/send', body }), workspace);
    expect(workspace.statusCode).toBe(202);
    expect(x.workspaceAgent.requestMailApproval).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', orgId: x.org, approvalId: expect.stringMatching(/^ma_/),
    }));
    expect(x.sendMail).not.toHaveBeenCalled();

    const ordinary = createMockResponse();
    await route(request({ token: x.agentToken, method: 'POST', path: '/mail/send', body }), ordinary);
    expect(ordinary.statusCode).toBe(202);
    expect(x.requestMailApproval).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', agentId: 'agent-a', approvalId: expect.stringMatching(/^ma_/),
    }));
    expect(x.workspaceAgent.requestMailApproval).toHaveBeenCalledTimes(1);
    expect(x.sendMail).not.toHaveBeenCalled();
  });
  it('reads recent Home briefings only for the Workspace Agent, the workplace\'s newest first, within the requested limit', async () => {
    const x = await build();
    // One briefing log per workplace (note #843), kept on the membership.
    await x.deps.orgStorage!.updateOrg(x.org, { roomsMerged: { mergedAt: '2026-09-13T00:00:00.000Z' } });
    await x.deps.orgStorage!.touchMember(x.org, 'user-1', { workspaceRecapHistory: [
      { text: 'Earlier overview.', at: '2026-09-13T09:00:00.000Z' },
      { text: 'Newest overview.', at: '2026-09-13T10:00:00.000Z' },
      { text: 'Oldest overview.', at: '2026-09-13T08:00:00.000Z' },
      // Written before the rooms were merged, when briefings were per room: read by nothing.
      { text: 'OLD WORKPLACE BRIEFING', at: '2026-09-12T23:00:00.000Z' },
    ] });
    const route = handler(x.deps, '/briefings', 'get');
    const read = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/briefings', query: { limit: '2' } }), read);
    expect(read.statusCode).toBe(200);
    expect(read.body).toEqual({ briefings: [
      { text: 'Newest overview.', at: '2026-09-13T10:00:00.000Z' },
      { text: 'Earlier overview.', at: '2026-09-13T09:00:00.000Z' },
    ] });
    const all = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/briefings', query: { limit: '10' } }), all);
    expect((all.body as { briefings: Array<{ text: string }> }).briefings.map((one) => one.text))
      .toEqual(['Newest overview.', 'Earlier overview.', 'Oldest overview.']);
    const invalid = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/briefings', query: { limit: '11' } }), invalid);
    expect(invalid.statusCode).toBe(400);
    const fromAgent = createMockResponse();
    await route(request({ token: x.agentToken, method: 'GET', path: '/briefings' }), fromAgent);
    expect(fromAgent.statusCode).toBe(403);
    expect(String((fromAgent.body as { error: string }).error)).toContain("Workspace Agent's verb alone");
  });
  it('its notes are the workplace\'s: linked like any agent\'s, read by every agent alike, and --room changes nothing (notes #493, #843)', async () => {
    const x = await build();
    const created = createMockResponse();
    await handler(x.deps, '/notes', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/notes', body: { html: '<h2>Call the printer</h2>' } }), created);
    expect(created.statusCode).toBe(200);
    // The workplace's address, and no room in it: the person can open it.
    expect((created.body as { note: { href?: string } }).note.href).toBe(`/notes/1?org=${x.org}`);
    expect(String((created.body as { message: string }).message)).toContain('Your user can read it');
    for (const ask of [
      request({ token: x.workspaceToken, method: 'GET', path: '/notes' }),
      request({ token: x.workspaceToken, method: 'GET', path: '/notes', room: 'Sales' }),
      request({ token: x.agentToken, method: 'GET', path: '/notes' }),
      request({ token: x.agentToken, method: 'GET', path: '/notes', room: 'Kitchen' }),
    ]) {
      const listed = createMockResponse();
      await handler(x.deps, '/notes', 'get')(ask, listed);
      expect(listed.statusCode).toBe(200);
      expect((listed.body as { notes: Array<{ title: string }> }).notes.map((note) => note.title)).toEqual(['Call the printer']);
    }
    // Archived from the same shelf, and no row in the conversation.
    const archived = createMockResponse();
    await handler(x.deps, '/notes/:number/archive', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/notes/1/archive', params: { number: '1' } }), archived);
    expect(archived.statusCode).toBe(200);
    expect(x.workspaceAgent.receipt).not.toHaveBeenCalled();
  });
  it('sends agent messages through the conversation, which owns the reply cursor', async () => {
    const x = await build();
    const sent = createMockResponse();
    await handler(x.deps, '/agents/messages', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/messages', body: { recipient: 'Ben', message: 'Status?' } }), sent);
    expect(sent.statusCode).toBe(202);
    expect(x.workspaceAgent.messageAgent).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, senderAgentId: x.assistantId, recipient: 'Ben', message: 'Status?' });
    expect((x.deps.agentLifecycle as { messagePeer: ReturnType<typeof vi.fn> }).messagePeer).not.toHaveBeenCalled();
    // An ordinary agent's answer TO the Workspace Agent (note #457) lands in the
    // conversation directly: no roster lookup, no turn started.
    const fromAgent = createMockResponse();
    await handler(x.deps, '/agents/messages', 'post')(request({ token: x.agentToken, method: 'POST', path: '/agents/messages', body: { recipient: 'Workspace Agent', message: 'Done: PR #842 is ready.' } }), fromAgent);
    expect(fromAgent.statusCode).toBe(202);
    expect(x.workspaceAgent.receiveFromAgent).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, senderAgentId: expect.any(String), message: 'Done: PR #842 is ready.' });
    expect((x.deps.agentLifecycle as { messagePeer: ReturnType<typeof vi.fn> }).messagePeer).not.toHaveBeenCalled();
    expect(x.workspaceAgent.messageAgent).toHaveBeenCalledTimes(1);
  });
  it('reads a bounded history through the conversation, while an ordinary agent is refused before resolution (note #466)', async () => {
    const x = await build();
    const route = handler(x.deps, '/agents/history', 'get');
    const defaultWindow = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/agents/history', query: { agent: ' Ben ' } }), defaultWindow);
    expect(defaultWindow.statusCode).toBe(200);
    expect(x.workspaceAgent.agentHistory).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben', limit: 4 });
    expect(defaultWindow.body).toMatchObject({ ok: true, agent: { id: 'agent-a', name: 'Ben' } });

    for (const limit of ['1', '4']) {
      const accepted = createMockResponse();
      await route(request({ token: x.workspaceToken, method: 'GET', path: '/agents/history', query: { agent: 'agent-a', limit } }), accepted);
      expect(accepted.statusCode).toBe(200);
      expect(x.workspaceAgent.agentHistory).toHaveBeenLastCalledWith({ userId: 'user-1', orgId: x.org, agent: 'agent-a', limit: Number(limit) });
    }
    for (const limit of ['0', '5', '1.5', 'many']) {
      const refused = createMockResponse();
      await route(request({ token: x.workspaceToken, method: 'GET', path: '/agents/history', query: { agent: 'Ben', limit } }), refused);
      expect(refused.statusCode).toBe(400);
      expect(String((refused.body as { error: string }).error)).toContain('whole number from 1 to 4');
    }
    expect(x.workspaceAgent.agentHistory).toHaveBeenCalledTimes(3);

    x.workspaceAgent.agentHistory.mockResolvedValueOnce({ ok: false, code: 'not_own', reason: "Other is a teammate's agent." } as never);
    const notOwn = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/agents/history', query: { agent: 'Other' } }), notOwn);
    expect(notOwn.statusCode).toBe(403);
    x.workspaceAgent.agentHistory.mockResolvedValueOnce({ ok: false, code: 'not_found', reason: 'No such agent.' } as never);
    const missing = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'GET', path: '/agents/history', query: { agent: 'Nobody' } }), missing);
    expect(missing.statusCode).toBe(404);

    const fromAgent = createMockResponse();
    await route(request({ token: x.agentToken, method: 'GET', path: '/agents/history', query: { agent: 'Ben' } }), fromAgent);
    expect(fromAgent.statusCode).toBe(403);
    expect(String((fromAgent.body as { error: string }).error)).toContain("Workspace Agent's verb alone");
    expect(x.workspaceAgent.agentHistory).toHaveBeenCalledTimes(5);
  });
  it('stops an agent through the conversation (note #462): the Workspace Agent’s verb alone, refused to an ordinary agent in words that say so', async () => {
    const x = await build();
    const stopped = createMockResponse();
    await handler(x.deps, '/agents/stop', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/stop', body: { agent: 'Ben', reason: '  the note text changed  ' } }), stopped);
    expect(stopped.statusCode).toBe(200);
    expect(x.workspaceAgent.stopAgent).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben', reason: 'the note text changed' });
    expect(stopped.body).toMatchObject({ ok: true, name: 'Ben', idle: true });
    expect(String((stopped.body as { message: string }).message)).toContain('It is idle now');
    // Not unwound within the wait: the answer says so, and what to do before messaging.
    x.workspaceAgent.stopAgent.mockResolvedValueOnce({ ok: true, name: 'Ben', idle: false } as never);
    const unwinding = createMockResponse();
    await handler(x.deps, '/agents/stop', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/stop', body: { agent: 'Ben' } }), unwinding);
    expect(unwinding.statusCode).toBe(200);
    expect(x.workspaceAgent.stopAgent).toHaveBeenLastCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben' });
    expect(String((unwinding.body as { message: string }).message)).toContain('still reads as working');
    // Every refusal keeps the conversation's words under a status the CLI can tell apart.
    for (const [code, status] of [['idle', 409], ['not_found', 404], ['not_own', 403], ['ambiguous', 400], ['self', 400], ['unavailable', 503]] as const) {
      x.workspaceAgent.stopAgent.mockResolvedValueOnce({ ok: false, code, reason: `because ${code}` } as never);
      const refused = createMockResponse();
      await handler(x.deps, '/agents/stop', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/stop', body: { agent: 'Ben' } }), refused);
      expect([code, refused.statusCode]).toEqual([code, status]);
      expect(refused.body).toEqual({ error: `because ${code}`, code });
    }
    // Bad input never reaches the conversation.
    const empty = createMockResponse();
    await handler(x.deps, '/agents/stop', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/stop', body: {} }), empty);
    expect(empty.statusCode).toBe(400);
    const long = createMockResponse();
    await handler(x.deps, '/agents/stop', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/agents/stop', body: { agent: 'Ben', reason: 'x'.repeat(501) } }), long);
    expect(long.statusCode).toBe(400);
    expect(String((long.body as { error: string }).error)).toContain('keep it under 500');
    expect(x.workspaceAgent.stopAgent).toHaveBeenCalledTimes(8);
    // An ordinary agent is refused before any name is resolved, in words that say whose verb it is.
    const fromAgent = createMockResponse();
    await handler(x.deps, '/agents/stop', 'post')(request({ token: x.agentToken, method: 'POST', path: '/agents/stop', body: { agent: 'Ben' } }), fromAgent);
    expect(fromAgent.statusCode).toBe(403);
    expect(String((fromAgent.body as { error: string }).error)).toContain('Workspace Agent\'s verb alone');
    expect(x.workspaceAgent.stopAgent).toHaveBeenCalledTimes(8);
  });
  it('starts a fresh chat through the conversation, without a handoff, and leaves an ordinary agent’s reset alone', async () => {
    const x = await build();
    const requestChatReset = vi.fn(async () => ({ ok: true as const }));
    x.deps.requestChatReset = requestChatReset;
    const fresh = createMockResponse();
    await handler(x.deps, '/chat/new', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/chat/new', body: {} }), fresh);
    expect(fresh.statusCode).toBe(200);
    expect(String((fresh.body as { message: string }).message)).toContain('resets right after this reply');
    expect(x.workspaceAgent.resetConversation).toHaveBeenCalledWith('user-1', x.org);
    expect(requestChatReset).not.toHaveBeenCalled();
    const handoff = createMockResponse();
    await handler(x.deps, '/chat/new', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/chat/new', body: { handoff: 'Continue with the sweep' } }), handoff);
    expect(handoff.statusCode).toBe(400);
    expect(x.workspaceAgent.resetConversation).toHaveBeenCalledTimes(1);
    x.workspaceAgent.resetConversation.mockResolvedValueOnce({ ok: false, reason: 'A fresh chat is started from a running request.' } as never);
    const idle = createMockResponse();
    await handler(x.deps, '/chat/new', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/chat/new', body: {} }), idle);
    expect(idle.statusCode).toBe(409);
    const ordinary = createMockResponse();
    await handler(x.deps, '/chat/new', 'post')(request({ token: x.agentToken, method: 'POST', path: '/chat/new', body: {} }), ordinary);
    expect(ordinary.statusCode).toBe(200);
    expect(requestChatReset).toHaveBeenCalledWith({ userId: 'user-1', agentId: 'agent-a' });
  });
  it('is never woken by a job on its own machine, and is told so rather than left retrying (note #532)', async () => {
    const x = await build();
    const deliverFinishedJobs = vi.fn(async (args: { receipts: Array<{ id: string }> }) => ({
      accepted: args.receipts.map((one) => one.id),
    }));
    (x.deps.agentLifecycle as unknown as Record<string, unknown>).deliverFinishedJobs = deliverFinishedJobs;
    const body = {
      jobs: [{
        id: 'j_0123456789abcdef01234567',
        status: 'succeeded',
        command: 'node build.mjs',
        durationMs: 1_000,
        exitCode: 0,
        signal: null,
        outputBytes: 0,
        outputTruncated: false,
      }],
    };
    const workspace = createMockResponse();
    await handler(x.deps, '/jobs/finished', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/jobs/finished', body }), workspace);
    // Its conversation is platform-owned and starts from the person, never
    // from a machine event. 409 and not 5xx: the receipt is settled for good,
    // so the machine stops asking instead of retrying forever.
    expect(workspace.statusCode).toBe(409);
    expect(deliverFinishedJobs).not.toHaveBeenCalled();

    const ordinary = createMockResponse();
    await handler(x.deps, '/jobs/finished', 'post')(request({ token: x.agentToken, method: 'POST', path: '/jobs/finished', body }), ordinary);
    expect(ordinary.statusCode).toBe(202);
    expect(deliverFinishedJobs).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', agentId: 'agent-a' }));
  });
});

describe('the orchestrator verbs (note #710)', () => {
  it('room verbs answer gone for every agent, and change nothing (note #843)', async () => {
    const x = await build();
    // An older agentbuilt still calls them for one more release, and hears so.
    for (const token of [x.workspaceToken, x.agentToken]) {
      for (const [path, body] of [['/rooms', { name: 'Kitchen' }], ['/rooms/rename', { room: 'Sales', name: 'Revenue' }], ['/rooms/order', { rooms: ['Sales'] }], ['/rooms/remove', { room: 'Sales' }]] as const) {
        const gone = createMockResponse();
        await handler(x.deps, path, 'post')(request({ token, method: 'POST', path, body }), gone);
        expect(gone.statusCode).toBe(410);
        expect(String((gone.body as { error: string }).error)).toContain('Rooms are gone');
      }
    }
    expect(x.workspaceAgent.receipt).not.toHaveBeenCalled();
  });

  it('brings an agent into the workplace through the person\'s own lifecycle call, names who is arriving and no room, and keeps an ordinary agent out', async () => {
    const x = await build();
    const route = handler(x.deps, '/agents', 'post');
    const created = createMockResponse();
    // A stale --room from an older CLI is read by nothing (note #843).
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', room: 'sales', body: { cli: 'codex' } }), created);
    expect(created.statusCode).toBe(202);
    // `concurrent` (note #726): a team brought in together is not a double
    // tap, so the call stands outside the person's one-at-a-time lock.
    expect(x.createAgent).toHaveBeenCalledWith('user-1', 'codex', x.org, { awaitName: true, concurrent: true });
    expect(created.body).toMatchObject({ ok: true, agent: { id: 'agent-new', name: 'Mia' } });
    expect(created.body).not.toHaveProperty('room');
    expect(String((created.body as { message: string }).message)).toMatch(/^Mia is arriving \[agent-new\]/);
    // …and the receipt row in the Chief of Staff's conversation (note #726).
    expect(x.workspaceAgent.receipt).toHaveBeenCalledWith('user-1', x.org, 'Brought in Mia.');
    // Claude by default with no plan signed in; an older backend's bare ok
    // still gets a sentence, and no receipt names nobody.
    x.createAgent.mockResolvedValueOnce({ ok: true as const } as never);
    const bare = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: {} }), bare);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true });
    expect(String((bare.body as { message: string }).message)).toContain('A new agent is being set up');
    expect(x.workspaceAgent.receipt).toHaveBeenCalledTimes(1);
    // The lifecycle's refusal, written for a human, passes through whole.
    x.createAgent.mockResolvedValueOnce({ ok: false as const, reason: 'This workplace has 20 agents, its ceiling.' });
    const full = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: {} }), full);
    expect(full.statusCode).toBe(400);
    expect(full.body).toEqual({ error: 'This workplace has 20 agents, its ceiling.' });
    const badCli = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: { cli: 'gemini' } }), badCli);
    expect(badCli.statusCode).toBe(400);
    expect(x.createAgent).toHaveBeenCalledTimes(3);
    const fromAgent = createMockResponse();
    await route(request({ token: x.agentToken, method: 'POST', path: '/agents', body: {} }), fromAgent);
    expect(fromAgent.statusCode).toBe(403);
    expect(String((fromAgent.body as { error: string }).error)).toContain("Workspace Agent's verb alone");
    expect(x.createAgent).toHaveBeenCalledTimes(3);
    // A refusal writes no receipt: only the create that named an agent did.
    expect(x.workspaceAgent.receipt).toHaveBeenCalledTimes(1);
  });
  it('without --cli, brings the agent in on the plan the person signed in: ChatGPT alone means Codex, Claude wins when both are in (note #726)', async () => {
    const x = await build();
    const route = handler(x.deps, '/agents', 'post');
    const orgStorage = x.deps.orgStorage!;
    // A ChatGPT-only person used to be refused unless the agent asked for
    // Codex by name — the one plan they have is the default now.
    const codex = await orgStorage.addSeat({ orgId: x.org, userId: 'user-1', provider: 'codex', token: 'oai-x', label: 'plus', status: 'active' });
    const onCodex = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: {} }), onCodex);
    expect(onCodex.statusCode).toBe(202);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'codex', x.org, { awaitName: true, concurrent: true });
    // Both plans in: Claude, as before.
    await orgStorage.addSeat({ orgId: x.org, userId: 'user-1', provider: 'claude', token: 'sk-ant-oat-x', label: 'max', status: 'active' });
    const onBoth = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: {} }), onBoth);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true });
    // An explicit --cli is never second-guessed by the seats.
    const explicit = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: { cli: 'codex' } }), explicit);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'codex', x.org, { awaitName: true, concurrent: true });
    // A dead seat is not a plan: Codex disabled and no Claude falls back to Claude, whose refusal the lifecycle writes.
    for (const seat of await orgStorage.listSeatsByMember(x.org, 'user-1')) {
      if (seat.provider === 'claude') await orgStorage.removeSeat(seat.seatId);
    }
    await orgStorage.updateSeat(codex.seatId, { status: 'disabled' });
    const dead = createMockResponse();
    await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body: {} }), dead);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true });
    expect(x.createAgent).toHaveBeenCalledTimes(4);
  });
  it('brings an agent in on the model and effort the person asked for, from the picker\'s own catalog, and says the pair either way (note #757)', async () => {
    const x = await build();
    const route = handler(x.deps, '/agents', 'post');
    const create = async (body: Record<string, unknown>) => {
      const response = createMockResponse();
      await route(request({ token: x.workspaceToken, method: 'POST', path: '/agents', body }), response);
      return response as { statusCode: number; body: { message?: string; error?: string; runtime?: unknown } };
    };
    // Both halves asked: judged case-blind against the catalog, passed on as
    // the pick the record keeps, and named in the answer.
    const both = await create({ cli: 'claude', model: 'Sonnet', effort: ' medium ' });
    expect(both.statusCode).toBe(202);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true, model: 'sonnet', effort: 'medium' });
    expect(both.body.runtime).toEqual({ cli: 'claude', model: 'sonnet', effort: 'medium' });
    expect(both.body.message).toContain('Mia is arriving [agent-new], a Claude Code agent on sonnet at medium effort (as asked):');
    // Neither: the call carries nothing, exactly as before, and the answer
    // still says what the agent will run on.
    const neither = await create({});
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true });
    expect(neither.body.runtime).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    expect(neither.body.message).toContain('a Claude Code agent on opus at high effort (the defaults)');
    // One half: the other is the default, resolved as the first turn will.
    const modelOnly = await create({ cli: 'codex', model: 'gpt-5.5' });
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'codex', x.org, { awaitName: true, concurrent: true, model: 'gpt-5.5' });
    expect(modelOnly.body.message).toContain('a Codex agent on gpt-5.5 at high effort (model as asked, default effort)');
    // GPT-6.1 Terra (note #930), case-blind, at the top of its ladder.
    const terra = await create({ cli: 'codex', model: 'GPT-6.1-Terra', effort: 'ultra' });
    expect(terra.statusCode).toBe(202);
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'codex', x.org, { awaitName: true, concurrent: true, model: 'gpt-6.1-terra', effort: 'ultra' });
    expect(terra.body.runtime).toEqual({ cli: 'codex', model: 'gpt-6.1-terra', effort: 'ultra' });
    const effortOnly = await create({ effort: 'max' });
    expect(x.createAgent).toHaveBeenLastCalledWith('user-1', 'claude', x.org, { awaitName: true, concurrent: true, effort: 'max' });
    expect(effortOnly.body.message).toContain('a Claude Code agent on opus at max effort (default model, effort as asked)');
    expect(x.createAgent).toHaveBeenCalledTimes(5);

    // Outside the catalog: refused in words that name what IS offered, and
    // nothing is created.
    const otherHarness = await create({ model: 'gpt-6-sol' });
    expect(otherHarness.statusCode).toBe(400);
    expect(otherHarness.body.error).toBe('No agent was created: "gpt-6-sol" is not a model a Claude Code agent can use. Choose one of: fable, opus, sonnet. (It is a Codex model: add --cli codex for an agent on it.)');
    const unknown = await create({ cli: 'codex', model: 'haiku' });
    expect(unknown.body.error).toBe('No agent was created: "haiku" is not a model a Codex agent can use. Choose one of: gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5.');
    // `low` is withdrawn from both pickers, so creation cannot store it either.
    const low = await create({ model: 'opus', effort: 'low' });
    expect(low.statusCode).toBe(400);
    expect(low.body.error).toBe('No agent was created: "low" is not an effort opus offers. Choose one of: medium, high, xhigh, max.');
    // Effort is per model: gpt-5.5 stops at xhigh.
    const perModel = await create({ cli: 'codex', model: 'gpt-5.5', effort: 'max' });
    expect(perModel.body.error).toBe('No agent was created: "max" is not an effort gpt-5.5 offers. Choose one of: medium, high, xhigh.');
    // An effort alone is judged against the harness's default model.
    const noModel = await create({ cli: 'codex', effort: 'ultracode' });
    expect(noModel.body.error).toBe('No agent was created: "ultracode" is not an effort gpt-6.1-sol offers. Choose one of: medium, high, xhigh, max, ultra.');
    expect(x.createAgent).toHaveBeenCalledTimes(5);
  });
  it('changes an own agent\'s model and effort through the conversation (note #776): the Workspace Agent\'s verb alone, answered with the pair and from when', async () => {
    const x = await build();
    const change = handler(x.deps, '/agents/model', 'post');
    const idle = createMockResponse();
    await change(request({ token: x.workspaceToken, method: 'POST', path: '/agents/model', body: { agent: ' Ben ', model: ' Sonnet ' } }), idle);
    expect(idle.statusCode).toBe(200);
    expect(x.workspaceAgent.changeAgentRuntime).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben', model: 'Sonnet' });
    expect(idle.body).toMatchObject({ ok: true, name: 'Ben', runtime: { cli: 'claude', model: 'sonnet', effort: 'high' }, changed: true, working: false });
    expect((idle.body as { message: string }).message).toBe('Ben now runs on sonnet at high effort (Claude Code), from its next turn. Its chat shows that you changed it, and its next turn is told. Tell the person what it runs on now — they can change it back with the picker on its screen.');
    // A working agent finishes its turn on the old pair, and the answer says so.
    x.workspaceAgent.changeAgentRuntime.mockResolvedValueOnce({ ok: true, name: 'Ben', cli: 'claude', model: 'opus', effort: 'max', was: { model: 'opus', effort: 'high' }, changed: true, working: true });
    const working = createMockResponse();
    await change(request({ token: x.workspaceToken, method: 'POST', path: '/agents/model', body: { agent: 'Ben', effort: 'max' } }), working);
    expect((working.body as { message: string }).message).toContain('Ben now runs on opus at max effort (Claude Code), from its next turn. It is working right now: this turn finishes on opus at high effort, and the new setting starts with the turn after it.');
    x.workspaceAgent.changeAgentRuntime.mockResolvedValueOnce({ ok: true, name: 'Ben', cli: 'claude', model: 'opus', effort: 'high', was: { model: 'opus', effort: 'high' }, changed: false, working: false });
    const same = createMockResponse();
    await change(request({ token: x.workspaceToken, method: 'POST', path: '/agents/model', body: { agent: 'Ben', model: 'opus' } }), same);
    expect((same.body as { message: string }).message).toBe('Ben already runs on opus at high effort (Claude Code), so nothing was changed.');
    for (const [code, status] of [['refused', 400], ['not_found', 404], ['not_own', 403], ['ambiguous', 400], ['self', 400], ['unavailable', 503]] as const) {
      x.workspaceAgent.changeAgentRuntime.mockResolvedValueOnce({ ok: false, code, reason: `because ${code}` } as never);
      const refused = createMockResponse();
      await change(request({ token: x.workspaceToken, method: 'POST', path: '/agents/model', body: { agent: 'Ben', model: 'haiku' } }), refused);
      expect([code, refused.statusCode]).toEqual([code, status]);
      expect(refused.body).toEqual({ error: `because ${code}`, code });
    }
    // Nothing asked, or not words: refused before the conversation is asked.
    for (const body of [{ agent: 'Ben' }, { agent: 'Ben', model: '  ' }, { model: 'opus' }, { agent: 'Ben', model: 4 }]) {
      const bad = createMockResponse();
      await change(request({ token: x.workspaceToken, method: 'POST', path: '/agents/model', body }), bad);
      expect(bad.statusCode).toBe(400);
    }
    const fromAgent = createMockResponse();
    await change(request({ token: x.agentToken, method: 'POST', path: '/agents/model', body: { agent: 'Ben', model: 'opus' } }), fromAgent);
    expect(fromAgent.statusCode).toBe(403);
    expect((fromAgent.body as { error: string }).error).toContain('the Workspace Agent\'s verb alone');
    expect(x.workspaceAgent.changeAgentRuntime).toHaveBeenCalledTimes(9);
  });
  it('asks an agent for a fresh chat and asks the person for a removal through the conversation, each the Workspace Agent\'s verb alone', async () => {
    const x = await build();
    const reset = handler(x.deps, '/agents/reset', 'post');
    const asked = createMockResponse();
    await reset(request({ token: x.workspaceToken, method: 'POST', path: '/agents/reset', body: { agent: ' Ben ' } }), asked);
    expect(asked.statusCode).toBe(200);
    expect(x.workspaceAgent.resetAgent).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben' });
    expect(String((asked.body as { message: string }).message)).toContain('Asked Ben for a fresh chat');
    for (const [code, status] of [['busy', 409], ['awaited', 409], ['not_found', 404], ['not_own', 403], ['ambiguous', 400], ['self', 400], ['unavailable', 503]] as const) {
      x.workspaceAgent.resetAgent.mockResolvedValueOnce({ ok: false, code, reason: `because ${code}` } as never);
      const refused = createMockResponse();
      await reset(request({ token: x.workspaceToken, method: 'POST', path: '/agents/reset', body: { agent: 'Ben' } }), refused);
      expect([code, refused.statusCode]).toEqual([code, status]);
      expect(refused.body).toEqual({ error: `because ${code}`, code });
    }
    const empty = createMockResponse();
    await reset(request({ token: x.workspaceToken, method: 'POST', path: '/agents/reset', body: {} }), empty);
    expect(empty.statusCode).toBe(400);
    const resetFromAgent = createMockResponse();
    await reset(request({ token: x.agentToken, method: 'POST', path: '/agents/reset', body: { agent: 'Ben' } }), resetFromAgent);
    expect(resetFromAgent.statusCode).toBe(403);
    expect(x.workspaceAgent.resetAgent).toHaveBeenCalledTimes(8);

    const remove = handler(x.deps, '/agents/remove', 'post');
    const pending = createMockResponse();
    await remove(request({ token: x.workspaceToken, method: 'POST', path: '/agents/remove', body: { agent: 'Ben', reason: '  its work is finished  ' } }), pending);
    expect(pending.statusCode).toBe(202);
    expect(x.workspaceAgent.askRemoveAgent).toHaveBeenCalledWith({ userId: 'user-1', orgId: x.org, agent: 'Ben', reason: 'its work is finished' });
    expect(pending.body).toMatchObject({ pending: true, name: 'Ben' });
    expect(String((pending.body as { message: string }).message)).toContain('Nothing is removed until they do');
    for (const [code, status] of [['not_found', 404], ['not_own', 403], ['ambiguous', 400], ['self', 400], ['unavailable', 503]] as const) {
      x.workspaceAgent.askRemoveAgent.mockResolvedValueOnce({ ok: false, code, reason: `because ${code}` } as never);
      const refused = createMockResponse();
      await remove(request({ token: x.workspaceToken, method: 'POST', path: '/agents/remove', body: { agent: 'Ben' } }), refused);
      expect([code, refused.statusCode]).toEqual([code, status]);
    }
    const long = createMockResponse();
    await remove(request({ token: x.workspaceToken, method: 'POST', path: '/agents/remove', body: { agent: 'Ben', reason: 'x'.repeat(501) } }), long);
    expect(long.statusCode).toBe(400);
    const removeFromAgent = createMockResponse();
    await remove(request({ token: x.agentToken, method: 'POST', path: '/agents/remove', body: { agent: 'Ben' } }), removeFromAgent);
    expect(removeFromAgent.statusCode).toBe(403);
    expect(String((removeFromAgent.body as { error: string }).error)).toContain("Workspace Agent's verb alone");
    expect(x.workspaceAgent.askRemoveAgent).toHaveBeenCalledTimes(6);
  });
});

describe('the event turn\'s fence and the Chief of Staff\'s hand-over (note #716)', () => {
  /** A note the person wrote on the workplace's shelf. */
  const wsNote = async (x: Awaited<ReturnType<typeof build>>, html = '<p>Make the booking page faster</p>') => {
    const { namespaceId } = await x.deps.orgGit!.resolveNamespace('user-1', x.org);
    return x.deps.quickNoteStorage!.create({ userId: namespaceId, html, createdByAgentId: 'user', createdByUserId: 'user-1', updatedByAgentId: 'user' });
  };
  it('refuses a change the conversation fences, in its words — reads pass, and an ordinary agent is never asked', async () => {
    const x = await build();
    const refusal = vi.fn(async (_u: string, _o: string, method: string, path: string) => method === 'POST' && path === '/notes' ? 'This is an event turn — the person did not write — so this waits for them.' : null);
    Object.assign(x.workspaceAgent, { eventTurnRefusal: refusal });
    const add = createMockResponse();
    await handler(x.deps, '/notes', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/notes', body: { html: '<p>x</p>' } }), add);
    expect(add.statusCode).toBe(403);
    expect(add.body).toEqual({ error: 'This is an event turn — the person did not write — so this waits for them.' });
    expect(refusal).toHaveBeenCalledWith('user-1', x.org, 'POST', '/notes');
    const list = createMockResponse();
    await handler(x.deps, '/notes', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/notes' }), list);
    expect(list.statusCode).toBe(200);
    refusal.mockClear();
    const agentAdd = createMockResponse();
    await handler(x.deps, '/notes', 'post')(request({ token: x.agentToken, method: 'POST', path: '/notes', body: { html: '<p>Ben\'s note</p>' } }), agentAdd);
    expect(agentAdd.statusCode).toBe(200);
    expect(refusal).not.toHaveBeenCalled();
  });
  it('hands an unclaimed note to any of the person\'s agents as the Workspace Agent\'s own message, and records the hand-over on the note', async () => {
    const x = await build();
    const note = await wsNote(x);
    const res = createMockResponse();
    await handler(x.deps, '/notes/:number/hand', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/notes/${note.number}/hand`, params: { number: String(note.number) }, body: { agent: 'Ben', message: 'It is the slow first paint.' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: 'Ben', message: `Handed note #${note.number} to Ben. The note says so, and Ben's answer comes back to this conversation.` });
    const call = (x.workspaceAgent.messageAgent.mock.calls[0] as unknown as [{ message: string; recipient: string; receipt: (name: string) => string }])[0];
    expect(call).toMatchObject({ userId: 'user-1', orgId: x.org, recipient: 'Ben' });
    expect(call.message).toBe(`Your user's note #${note.number}, "Make the booking page faster", is yours to pick up. Start with \`agentbuilt note start ${note.number}\`, work from what it says, and link a proposal with --note ${note.number}.\n\nIt is the slow first paint.`);
    expect(call.receipt('Ben')).toBe(`Handed note #${note.number} to Ben: Make the booking page faster`);
    // No room to keep the note inside (note #843): any of the person's agents may take it.
    expect(call).not.toHaveProperty('roomId');
    expect((await x.deps.quickNoteStorage!.get(note.id))!.handoff).toMatchObject({ agentId: 'agent-a', agentName: 'Ben', userId: 'user-1' });
    // Handed now: a second hand-over is refused, and so is an ordinary agent's.
    const again = createMockResponse();
    await handler(x.deps, '/notes/:number/hand', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/notes/${note.number}/hand`, params: { number: String(note.number) }, body: { agent: 'Ben' } }), again);
    expect(again.statusCode).toBe(409);
    expect((again.body as { error: string }).error).toContain('is not unclaimed (it is handed to Ben)');
    const byAgent = createMockResponse();
    await handler(x.deps, '/notes/:number/hand', 'post')(request({ token: x.agentToken, method: 'POST', path: '/notes/1/hand', params: { number: '1' }, body: { agent: 'Ben' } }), byAgent);
    expect(byAgent.statusCode).toBe(403);
  });
  it('passes a refused send through in its own words: a busy agent is 409 and nothing is recorded', async () => {
    const x = await build();
    const note = await wsNote(x);
    x.workspaceAgent.messageAgent.mockResolvedValueOnce({ ok: false, code: 'busy', reason: 'Ben is busy. Nothing was sent.' } as never);
    const res = createMockResponse();
    await handler(x.deps, '/notes/:number/hand', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/notes/${note.number}/hand`, params: { number: String(note.number) }, body: { agent: 'Ben' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Ben is busy. Nothing was sent.' });
    expect((await x.deps.quickNoteStorage!.get(note.id))!.handoff).toBeUndefined();
  });
  it('archives on its own only a note that is live, and says so where the person reads', async () => {
    const x = await build();
    const note = await wsNote(x);
    Object.assign(x.workspaceAgent, { isEventTurn: vi.fn(async () => true) });
    const refused = createMockResponse();
    await handler(x.deps, '/notes/:number/archive', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/notes/${note.number}/archive`, params: { number: String(note.number) } }), refused);
    expect(refused.statusCode).toBe(403);
    expect((refused.body as { error: string }).error).toBe(`This is an event turn, and note #${note.number} is unclaimed, not live: only a finished note is archived without asking. Nothing was done.`);
    expect((await x.deps.quickNoteStorage!.get(note.id))!.archivedAt).toBeUndefined();
    // Asked for by the person: archived as before, with no row.
    (x.workspaceAgent as unknown as { isEventTurn: ReturnType<typeof vi.fn> }).isEventTurn.mockResolvedValue(false);
    const archived = createMockResponse();
    await handler(x.deps, '/notes/:number/archive', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/notes/${note.number}/archive`, params: { number: String(note.number) } }), archived);
    expect(archived.statusCode).toBe(200);
    expect(x.workspaceAgent.receipt).not.toHaveBeenCalled();
  });
});

describe('schedules over the CLI (note #779)', () => {
  const body = { every: '8m', window: '07:00-23:00', timeZone: 'Europe/Amsterdam', capTurns: 120, message: 'Take the next beat.' };
  it('an ordinary agent proposes one for itself; the Workspace Agent is refused as creator, resumer and target', async () => {
    const x = await build();
    const refused = createMockResponse();
    await handler(x.deps, '/schedules', 'post')(request({ token: x.workspaceToken, method: 'POST', path: '/schedules', body }), refused);
    expect(refused.statusCode).toBe(403);
    expect(String((refused.body as { error: string }).error)).toContain('cannot create one');

    const asCos = createMockResponse();
    await handler(x.deps, '/schedules', 'post')(request({ token: x.agentToken, method: 'POST', path: '/schedules', body: { ...body, agent: 'Workspace Agent' } }), asCos);
    expect(asCos.statusCode).toBe(403);
    expect(String((asCos.body as { error: string }).error)).toContain('never be the target');

    const proposed = createMockResponse();
    await handler(x.deps, '/schedules', 'post')(request({ token: x.agentToken, method: 'POST', path: '/schedules', body }), proposed);
    expect(proposed.statusCode).toBe(202);
    const view = (proposed.body as { schedule: { id: string; status: string; agentName: string; summary: string } }).schedule;
    expect(view).toMatchObject({ status: 'proposed', agentName: 'Ben', summary: 'every 8 minutes, 07:00–23:00 Europe/Amsterdam, at most 120 turns a day' });
    expect(String((proposed.body as { message: string }).message)).toContain('Nothing ticks until your user approves it');
    expect(x.scheduleRows[0]).toMatch(/^Ben asked for a schedule/);

    // Approved by nobody: the sweep starts nothing, and an agent cannot approve its own.
    await x.agentSchedules.sweep();
    expect((await x.agentSchedules.get(view.id))!.status).toBe('proposed');

    // The Workspace Agent lists it, and may pause once approved — never resume.
    expect((await x.agentSchedules.decide({ userId: 'user-1', id: view.id, decision: 'approve' })).ok).toBe(true);
    const list = createMockResponse();
    await handler(x.deps, '/schedules', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/schedules' }), list);
    expect((list.body as { schedules: Array<{ id: string; status: string }> }).schedules).toEqual([expect.objectContaining({ id: view.id, status: 'active' })]);
    const paused = createMockResponse();
    await handler(x.deps, '/schedules/:id/pause', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/schedules/${view.id}/pause`, params: { id: view.id } }), paused);
    expect(paused.statusCode).toBe(200);
    expect((await x.agentSchedules.get(view.id))!.pause).toMatchObject({ reason: 'workspace-agent' });
    const resumed = createMockResponse();
    await handler(x.deps, '/schedules/:id/resume', 'post')(request({ token: x.workspaceToken, method: 'POST', path: `/schedules/${view.id}/resume`, params: { id: view.id } }), resumed);
    expect(resumed.statusCode).toBe(403);
    // Nor may the agent undo the Chief of Staff's pause.
    const agentResume = createMockResponse();
    await handler(x.deps, '/schedules/:id/resume', 'post')(request({ token: x.agentToken, method: 'POST', path: `/schedules/${view.id}/resume`, params: { id: view.id } }), agentResume);
    expect(agentResume.statusCode).toBe(403);
  });
});
