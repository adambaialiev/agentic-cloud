import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../../services/knowledge-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { workspaceAssistantId } from '../../types/user.js';

/**
 * `agentbuilt forward` (note #724): the Chief of Staff puts proposals in
 * front of its person as cards in its own conversation. The route finds each
 * number across the workplace — PR numbers are per repository, knowledge
 * proposal numbers one series for the workplace (they were per room before
 * 12 Oct 2026, and old rooms' records may still stand at their namespaces) —
 * stores pointers only, and refuses anything the person could not act on,
 * all-or-nothing.
 */
interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }
function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}
function forwardRoute(deps: Partial<RouteDeps>) {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((candidate) => candidate.route?.path === '/forward' && candidate.route.methods.post);
  if (!layer?.route) throw new Error('No POST /forward route');
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

/** One workplace with no rooms (note #923). Its own namespace is its
 *  founder's; `formerNamespaces` are its old rooms', recorded on it when they
 *  were merged (note #843), where records numbered per room may still stand. */
async function build(options: { formerNamespaces?: string[] } = {}) {
  const userStorage = new InMemoryUserStorage();
  const orgStorage = new InMemoryOrgStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const org = await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'user-1' });
  if (options.formerNamespaces) await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: org.createdAt, namespaces: options.formerNamespaces } });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
  const workplace = 'user-1';
  const assistantId = workspaceAssistantId('user-1', org.orgId);
  const workspace = mintAgentbuiltToken('user-1', assistantId);
  const agent = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        [assistantId]: { id: assistantId, name: 'Workspace Agent', purpose: 'workspace-recap', orgId: org.orgId, cli: 'claude', agentbuiltTokenHash: workspace.tokenHash } as never,
        'agent-a': { id: 'agent-a', name: 'Oscar', cli: 'claude', orgId: org.orgId, agentbuiltTokenHash: agent.tokenHash } as never,
      },
    },
  });
  const repos = new InMemoryGitRepoStorage();
  const prs = new InMemoryGitPullRequestStorage();
  const kps = new InMemoryKnowledgeProposalStorage();
  const repo = (name: string, namespace: string) => repos.create({ userId: namespace, name, createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1 } as never);
  const change = (repoId: string, namespace: string, title: string, over: Record<string, unknown> = {}) => prs.create({
    repoId, userId: namespace, roomNamespaceId: namespace, createdByUserId: 'user-1', createdByAgentId: 'agent-a',
    sourceBranch: 'agent/x', targetBranch: 'main', headSha: 'a'.repeat(40), title, commitSubjects: [], status: 'open', ...over,
  } as never);
  const page = (namespace: string, title: string, over: Record<string, unknown> = {}) => kps.create({
    userId: namespace, createdByUserId: 'user-1', createdByAgentId: 'agent-a', title,
    changes: [{ page: 'deploys', action: 'edit', title: 'Deploys', html: '<p>x</p>' }], status: 'open', ...over,
  } as never);
  const workspaceAgent = {
    forwardProposals: vi.fn(async (args: { proposals: Array<{ kind: 'pr' | 'knowledge'; id: string }>; text: string | ((added: Array<{ kind: 'pr' | 'knowledge'; id: string }>) => string) }) => ({ landed: true, added: args.proposals, alreadyShown: [] })),
  };
  /** What the row would say: the route hands the words as a function of what landed (note #752). */
  const rowText = (call = 0) => {
    const args = workspaceAgent.forwardProposals.mock.calls[call]![0];
    return typeof args.text === 'function' ? args.text(args.proposals) : args.text;
  };
  const deps: Partial<RouteDeps> = {
    userStorage, orgStorage, orgGit: new OrgGitService({ orgStorage }),
    gitRepoStorage: repos, gitPullRequestStorage: prs, knowledgeProposalStorage: kps,
    workspaceAgent: workspaceAgent as never,
  };
  const call = async (token: string, body: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const res = createMockResponse();
    await forwardRoute(deps)({
      get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
      method: 'POST', path: '/forward', params: {}, query: {}, body,
    }, res);
    return res;
  };
  return { deps, org: org.orgId, workplace, workspaceToken: workspace.token, agentToken: agent.token, workspaceAgent, rowText, repo, change, page, call };
}

describe('agentbuilt forward (note #724)', () => {
  it('finds a PR and a knowledge proposal across the workplace and lands them as pointers on one row', async () => {
    const x = await build();
    const site = await x.repo('site', x.workplace);
    const pr = await x.change(site.id, x.workplace, 'Checkout');
    const kp = await x.page(x.workplace, 'Deploys page');
    const res = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: pr.number }, { kind: 'knowledge', number: kp.number }] });
    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain('Forwarded 2 cards');
    expect(x.workspaceAgent.forwardProposals).toHaveBeenCalledWith({
      userId: 'user-1', orgId: x.org,
      proposals: [{ kind: 'pr', id: pr.id }, { kind: 'knowledge', id: kp.id }],
      text: expect.any(Function),
    });
    // Named by no room (note #923): there is none to name.
    expect(x.rowText()).toBe(`Forwarded PR #${pr.number} in site — Checkout; knowledge proposal #${kp.number} — Deploys page`);
  });

  it('adds no second card for a proposal already in front of the person, and says so (note #752)', async () => {
    const x = await build();
    const site = await x.repo('site', x.workplace);
    const pr = await x.change(site.id, x.workplace, 'Checkout');
    const kp = await x.page(x.workplace, 'Deploys page');
    // The conversation already shows the PR — `pr ready` landed it.
    x.workspaceAgent.forwardProposals.mockImplementationOnce(async (args) => ({
      landed: true, added: args.proposals.filter((ref) => ref.kind === 'knowledge'), alreadyShown: args.proposals.filter((ref) => ref.kind === 'pr'),
    }));
    const res = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: pr.number }, { kind: 'knowledge', number: kp.number }] });
    expect(res.statusCode).toBe(200);
    const message = (res.body as { message: string }).message;
    expect(message).toContain(`Forwarded a card into your conversation: knowledge proposal #${kp.number} — Deploys page.`);
    expect(message).toContain(`Already in front of the person in this conversation, so no second card: PR #${pr.number} in site — Checkout.`);
    // The row names only what it carries.
    const args = x.workspaceAgent.forwardProposals.mock.calls[0]![0];
    expect(typeof args.text === 'function' ? args.text([{ kind: 'knowledge', id: kp.id }]) : args.text).toBe(`Forwarded knowledge proposal #${kp.number} — Deploys page`);

    x.workspaceAgent.forwardProposals.mockImplementationOnce(async (args) => ({ landed: true, added: [], alreadyShown: args.proposals }));
    const none = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: pr.number }] });
    expect(none.statusCode).toBe(200);
    expect((none.body as { message: string }).message).toMatch(/^No new card\. Already in front of the person in this conversation, so no second card: PR #\d+ in site — Checkout\. A proposal lands in this conversation by itself when its agent runs `pr ready`/);
  });

  it('is the Workspace Agent\'s alone: any other agent is told how its own proposals reach its user', async () => {
    const x = await build();
    const res = await x.call(x.agentToken, { items: [{ kind: 'pr', number: 1 }] });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toContain('pr ready');
    expect(x.workspaceAgent.forwardProposals).not.toHaveBeenCalled();
  });

  it('asks for --repo only when a PR number matches twice; a knowledge number is the workplace\'s first, and one held twice at old rooms\' namespaces is the person\'s to name', async () => {
    const x = await build({ formerNamespaces: ['platform-ns', 'growth-ns'] });
    // PR numbers are per repository, so two repositories both hold a #1.
    const [site, app] = [await x.repo('site', x.workplace), await x.repo('app', x.workplace)];
    await x.change(site.id, x.workplace, 'Checkout');
    await x.change(app.id, x.workplace, 'Signup');
    const ambiguous = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: 1 }] });
    expect(ambiguous.statusCode).toBe(409);
    expect((ambiguous.body as { error: string }).error).toMatch(/PR #1 exists in (site, app|app, site) — say which with --repo/);
    const named = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: 1 }], repo: 'app' });
    expect(named.statusCode).toBe(200);
    expect((named.body as { message: string }).message).toContain('PR #1 in app — Signup');

    // Knowledge proposals numbered per room before 12 Oct 2026, still
    // standing at two old rooms' namespaces: no --room to narrow it any more,
    // so the person says which was meant.
    await x.page('platform-ns', 'Deploys page');
    await x.page('growth-ns', 'Pricing page');
    const twice = await x.call(x.workspaceToken, { items: [{ kind: 'knowledge', number: 1 }] });
    expect(twice.statusCode).toBe(409);
    expect((twice.body as { error: string }).error).toBe('Knowledge proposal #1 is held twice in this workplace (numbers were per room before 12 Oct 2026). Ask your user which one was meant.');
    expect((twice.body as { error: string }).error).not.toContain('--room');
    // Only the PR named with --repo landed; the refusal landed nothing.
    expect(x.workspaceAgent.forwardProposals).toHaveBeenCalledTimes(1);
    // The workplace's own #1 wins over the old rooms' records.
    await x.page(x.workplace, 'Onboarding page');
    const own = await x.call(x.workspaceToken, { items: [{ kind: 'knowledge', number: 1 }] });
    expect(own.statusCode).toBe(200);
    expect((own.body as { message: string }).message).toContain('knowledge proposal #1 — Onboarding page');
  });

  it('refuses all-or-nothing: an unknown number, a quiet proposal, or a turn that already ended', async () => {
    const x = await build();
    const site = await x.repo('site', x.workplace);
    const pr = await x.change(site.id, x.workplace, 'Checkout');
    const quiet = await x.change(site.id, x.workplace, 'Still on it', { draft: true });
    const missing = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: pr.number }, { kind: 'knowledge', number: 9 }] });
    expect(missing.statusCode).toBe(404);
    expect((missing.body as { error: string }).error).toBe('No knowledge proposal #9 in this workplace.');
    const draft = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: quiet.number }] });
    expect(draft.statusCode).toBe(409);
    expect((draft.body as { error: string }).error).toContain('still quiet');
    expect(x.workspaceAgent.forwardProposals).not.toHaveBeenCalled();
    const bad = await x.call(x.workspaceToken, { items: [{ kind: 'issue', number: 1 }] });
    expect(bad.statusCode).toBe(400);
    x.workspaceAgent.forwardProposals.mockResolvedValueOnce({ landed: false, added: [], alreadyShown: [] });
    const ended = await x.call(x.workspaceToken, { items: [{ kind: 'pr', number: pr.number }] });
    expect(ended.statusCode).toBe(409);
    expect((ended.body as { error: string }).error).toContain('running request');
  });
});
