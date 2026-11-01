import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { workspaceAssistantId } from '../../types/user.js';

/**
 * Note #753, the owner: "As a user, I can create multiple workplaces with
 * each own chief of staff. Chief of staff should be able to send message to
 * another chief of staff, if user asks." The routes' half: who may call the
 * two verbs, and which workplaces exist for them — only the person's own.
 * What the conversation does with a message is workspace-recap-chat-
 * workplaces.test.ts.
 */
interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }
function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}
function handler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post') {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}
function request(args: { token: string; method: string; path: string; body?: unknown }): Partial<Request> {
  const headers: Record<string, string> = { authorization: `Bearer ${args.token}` };
  return { get: ((name: string) => headers[name.toLowerCase()]) as Request['get'], method: args.method, path: args.path, params: {}, query: {}, body: args.body };
}

async function build() {
  const userStorage = new InMemoryUserStorage();
  const orgStorage = new InMemoryOrgStorage();
  await userStorage.createProfile('user-1', { email: 'adam@example.com', displayName: 'Adam' });
  await userStorage.createProfile('user-2', { email: 'dana@example.com', displayName: 'Dana' });
  // Adam's two workplaces, a teammate's workplace he was never in, and one he left.
  const studio = await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'user-1' });
  const bakery = await orgStorage.createOrg({ name: 'Bakery', createdByUserId: 'user-1' });
  const rival = await orgStorage.createOrg({ name: 'Rival', createdByUserId: 'user-2' });
  const old = await orgStorage.createOrg({ name: 'Old Shop', createdByUserId: 'user-2' });
  await orgStorage.addMember({ orgId: studio.orgId, userId: 'user-1', role: 'admin' });
  await orgStorage.addMember({ orgId: bakery.orgId, userId: 'user-1', role: 'admin' });
  await orgStorage.addMember({ orgId: rival.orgId, userId: 'user-2', role: 'admin' });
  await orgStorage.addMember({ orgId: old.orgId, userId: 'user-2', role: 'admin' });
  await orgStorage.addMember({ orgId: old.orgId, userId: 'user-1', role: 'member' });
  await orgStorage.removeMember(old.orgId, 'user-1');
  const assistantId = workspaceAssistantId('user-1', studio.orgId);
  const workspace = mintAgentbuiltToken('user-1', assistantId);
  const room = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        [assistantId]: { id: assistantId, name: 'Workspace Agent', purpose: 'workspace-recap', orgId: studio.orgId, cli: 'claude', agentbuiltTokenHash: workspace.tokenHash } as never,
        'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', orgId: studio.orgId, agentbuiltTokenHash: room.tokenHash } as never,
      },
    },
  });
  const messageWorkplace = vi.fn(async (_args: unknown): Promise<
    | { ok: true; name: string; queued: boolean }
    | { ok: false; code: 'refused' | 'busy' | 'unavailable'; reason: string }
  > => ({ ok: true, name: 'Chief of Staff in Bakery', queued: false }));
  const deps: Partial<RouteDeps> = { userStorage, orgStorage, workspaceAgent: { messageWorkplace } as never };
  return { deps, studio: studio.orgId, bakery: bakery.orgId, rival: rival.orgId, old: old.orgId, workspaceToken: workspace.token, roomToken: room.token, messageWorkplace };
}
const send = async (x: Awaited<ReturnType<typeof build>>, workplace: string, token = x.workspaceToken) => {
  const res = createMockResponse();
  await handler(x.deps, '/workplaces/messages', 'post')(request({ token, method: 'POST', path: '/workplaces/messages', body: { workplace, message: 'How many orders came in today?' } }), res);
  return res;
};

describe('the Chief of Staff reaching the person’s other workplaces (note #753)', () => {
  it('lists only the person’s own other workplaces — never this one, a teammate’s, or one they left', async () => {
    const x = await build();
    const list = createMockResponse();
    await handler(x.deps, '/workplaces', 'get')(request({ token: x.workspaceToken, method: 'GET', path: '/workplaces' }), list);
    expect(list.statusCode).toBe(200);
    expect(list.body).toMatchObject({ current: { orgId: x.studio, name: 'Studio' }, workplaces: [{ orgId: x.bakery, name: 'Bakery' }] });
    expect(JSON.stringify(list.body)).not.toMatch(/Rival|Old Shop/);
  });

  it('passes a message to the same person’s Chief of Staff in another workplace, by name or id', async () => {
    const x = await build();
    const sent = await send(x, 'bakery');
    expect(sent.statusCode).toBe(202);
    expect(x.messageWorkplace).toHaveBeenLastCalledWith({ userId: 'user-1', orgId: x.studio, orgName: 'Studio', toOrgId: x.bakery, toName: 'Bakery', message: 'How many orders came in today?' });
    expect(String((sent.body as { message: string }).message)).toContain('comes back into this conversation by itself');
    expect((await send(x, x.bakery)).statusCode).toBe(202);
    // The conversation's refusals keep their words under a status the CLI can show.
    x.messageWorkplace.mockResolvedValueOnce({ ok: false, code: 'refused', reason: 'The person did not write this turn.' });
    const refused = await send(x, 'Bakery');
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({ error: 'The person did not write this turn.', code: 'refused' });
  });

  it('answers "not found" alike for a teammate’s workplace, one the person left and a name nobody uses', async () => {
    const x = await build();
    const answers = await Promise.all(['Rival', x.rival, 'Old Shop', x.old, 'Nowhere'].map(async (name) => {
      const res = await send(x, name);
      return { name, status: res.statusCode, error: (res.body as { error: string }).error.replace(`"${name}"`, '"…"') };
    }));
    for (const answer of answers) expect(answer).toEqual({ name: answer.name, status: 404, error: 'No workplace of your user\'s is called "…". `agentbuilt workplace list` names them.' });
    expect(x.messageWorkplace).not.toHaveBeenCalled();
  });

  it('refuses this workplace, and refuses a room agent before resolving anything', async () => {
    const x = await build();
    const self = await send(x, 'Studio');
    expect(self.statusCode).toBe(400);
    expect(String((self.body as { error: string }).error)).toContain('is this workplace');
    for (const [path, method] of [['/workplaces', 'get'], ['/workplaces/messages', 'post']] as const) {
      const res = createMockResponse();
      await handler(x.deps, path, method)(request({ token: x.roomToken, method: method.toUpperCase(), path, body: { workplace: 'Bakery', message: 'hi' } }), res);
      expect(res.statusCode).toBe(403);
      expect(String((res.body as { error: string }).error)).toContain('Workspace Agent\'s verb alone');
    }
    expect(x.messageWorkplace).not.toHaveBeenCalled();
  });
});
