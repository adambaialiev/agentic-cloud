import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../../services/knowledge-storage.js';
import { moveMarginsForLandedChanges, InMemoryKnowledgePageCommentStorage } from '../../services/knowledge-page-comments.js';
import { KnowledgeService } from '../../services/knowledge-service.js';
import { COMMENT_AUTHOR_USER, newMarginComment } from '../../types/comment.js';
import { MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH, knowledgeProposalAwaitsDecision, type KnowledgeProposalDocument } from '../../types/knowledge.js';
import { fakeKnowledgeHost } from '../helpers/fake-knowledge-host.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';

/**
 * The agent's half of knowledge pages (docs/agent-knowledge-pages.md): list,
 * read, propose. The half that is NOT here is the point of the feature — there
 * is no route that writes a page, and the last test in this file is the one
 * that keeps it that way.
 */

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}

type Handler = (req: Partial<Request>, res: MockResponse) => Promise<unknown>;

function routeHandler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post'): Handler {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: Handler }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function mockRequest(args: {
  token: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}): Partial<Request> {
  return {
    get: ((name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${args.token}` : undefined)) as Request['get'],
    params: args.params ?? {},
    query: args.query ?? {},
    body: args.body,
  };
}

const PAGE = (title: string, description: string, body = '<p>Body.</p>') =>
  `<!doctype html>\n<html lang="en">\n<head>\n<title>${title}</title>\n<meta name="description" content="${description}">\n</head>\n<body>\n<h1>${title}</h1>\n${body}\n</body>\n</html>\n`;

async function buildDeps() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: { 'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
    },
  });
  const host = fakeKnowledgeHost();
  const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
  const knowledgePageCommentStorage = new InMemoryKnowledgePageCommentStorage();
  const asks: string[] = [];
  const deps: Partial<RouteDeps> = {
    userStorage,
    gitHostClient: host.client,
    knowledgeProposalStorage,
    knowledgePageCommentStorage,
    requestKnowledgeApproval: async ({ proposalId }) => { asks.push(proposalId); return true; },
  };
  return {
    deps,
    token,
    asks,
    files: host.files,
    proposals: knowledgeProposalStorage,
    pageComments: knowledgePageCommentStorage,
    service: new KnowledgeService(host.client, knowledgeProposalStorage),
  };
}

/**
 * Since note #746 a proposal is LANDED the moment it is recorded, so "the
 * open proposal just made" is now "the newest proposal", and landing one
 * again is a no-op that reports what already happened. Tests written for
 * the gate read through these two so the facts they check still hold.
 */
async function newest(store: { listByUser(userId: string): Promise<KnowledgeProposalDocument[]> }, userId = 'user-1') {
  const all = await store.listByUser(userId);
  return all.length ? [all[all.length - 1]!] : [];
}
async function landNow(service: KnowledgeService, id: string, by: string) {
  const store = (service as unknown as { proposals: { get(id: string): Promise<KnowledgeProposalDocument | null> } }).proposals;
  const doc = await store.get(id);
  if (doc?.status === 'approved') return { status: 'landed' as const, commitSha: doc.commitSha ?? '', proposal: doc, orphaned: [] };
  return service.land(id, by);
}

async function propose(deps: Partial<RouteDeps>, token: string, body: unknown): Promise<MockResponse> {
  const res = createMockResponse();
  await routeHandler(deps, '/knowledge/proposals', 'post')(mockRequest({ token, body }), res);
  return res;
}

describe('knowledge pages: the agent surface', () => {
  it('lists nothing on an account that has never had a page', async () => {
    const { deps, token } = await buildDeps();
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge', 'get')(mockRequest({ token }), res);
    expect(res.body).toEqual({ pages: [] });
  });

  it('applies a change the moment it is made — live, recorded, the owner told (note #746)', async () => {
    const { deps, token, asks, files, proposals } = await buildDeps();
    const told: string[] = [];
    deps.tellOwnerKnowledgeChanged = async ({ proposalId }) => { told.push(proposalId); return true; };
    const res = await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
      note: 'so the next agent does not guess',
    });

    expect(res.statusCode).toBe(201);
    const body = res.body as { proposal: { id: string; number: number; status: string; direct?: boolean; changes: Array<{ action: string }> }; applied: boolean; toldUser: boolean; message: string };
    expect(body.proposal.number).toBe(1);
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.direct).toBe(true);
    expect(body.applied).toBe(true);
    // The whole point: the page is readable NOW, and nobody was asked.
    expect(files.has('pages/deploy-runbook.html')).toBe(true);
    expect(asks).toHaveLength(0);
    expect(body.toldUser).toBe(true);
    expect(body.message).toContain('LIVE now');
    expect(body.message).toContain('agentbuilt knowledge restore deploy-runbook');
    // The record is the page's history: who, when, why — and the owner was
    // told about exactly it.
    const [doc] = await proposals.listByUser('user-1');
    expect(told).toEqual([doc!.id]);
    expect(doc).toMatchObject({ status: 'approved', direct: true, createdByAgentId: 'agent-a', note: 'so the next agent does not guess' });
    expect(doc!.decidedAt).toBeTruthy();

    const list = createMockResponse();
    await routeHandler(deps, '/knowledge', 'get')(mockRequest({ token }), list);
    expect((list.body as { pages: unknown[]; openProposals: number }).pages).toHaveLength(1);
    expect((list.body as { openProposals?: number }).openProposals ?? 0).toBe(0);
  });
  it('ready applies a proposal left over from before, and says a live change needs no invitation', async () => {
    const { deps, token, asks, proposals, files } = await buildDeps();
    // A proposal recorded before changes applied at once: open, never ready.
    const legacy = await proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Add "Deploying"', status: 'open', draft: true,
      changes: [{ page: 'deploy-runbook', action: 'create', html: PAGE('Deploying', 'How the site gets deployed.'), title: 'Deploying', description: 'x', baseSha: null }],
    });
    const ready = async (number = '1') => {
      const res = createMockResponse();
      await routeHandler(deps, '/knowledge/proposals/:number/ready', 'post')(
        mockRequest({ token, params: { number } }), res,
      );
      return res;
    };
    const first = await ready();
    expect(first.statusCode).toBe(201);
    expect(asks).toHaveLength(0);
    expect(files.has('pages/deploy-runbook.html')).toBe(true);
    expect((await proposals.get(legacy.id))).toMatchObject({ status: 'approved', direct: true });

    // Again: it is live, and there is nothing to invite anybody to.
    const again = await ready();
    expect(again.statusCode).toBe(200);
    expect((again.body as { message: string }).message).toContain('already LIVE');

    expect((await ready('9')).statusCode).toBe(404);
    await proposals.update(legacy.id, { status: 'withdrawn' });
    const decided = await ready();
    expect(decided.statusCode).toBe(409);
    expect((decided.body as { error: string }).error).toContain('withdrawn');
  });
  it('ready marks a left-over proposal conflict when its page moved, and lands nothing', async () => {
    const { deps, token, files, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'deploys', html: PAGE('Deploys', 'How the deploy goes.') }] });
    const legacy = await proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "Deploys"', status: 'open',
      changes: [{ page: 'deploys', action: 'edit', html: PAGE('Deploys', 'Stale.'), title: 'Deploys', description: 'x', baseSha: 'not-the-current-sha' }],
    });
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/proposals/:number/ready', 'post')(
      mockRequest({ token, params: { number: String(legacy.number) } }), res,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('"deploys" changed');
    expect((await proposals.get(legacy.id))?.status).toBe('conflict');
    expect(files.get('pages/deploys.html')).toContain('How the deploy goes.');
  });
  it('titles a proposal itself when the agent did not', async () => {
    const { deps, token } = await buildDeps();
    const res = await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying the site', 'How it gets deployed.') }],
    });
    expect((res.body as { proposal: { title: string } }).proposal.title).toBe('Add "Deploying the site" to knowledge');
  });

  it('refuses a note over the cap instead of slicing it, and proposes nothing (note #320)', async () => {
    const { deps, token, asks, proposals } = await buildDeps();
    const res = await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
      note: 'x'.repeat(MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH + 1),
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error))
      .toContain(String(MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH));
    // Nothing recorded, nobody asked — the same rule the body follows.
    expect(await proposals.listByUser('user-1')).toHaveLength(0);
    expect(asks).toHaveLength(0);

    // And one that fits still lands whole.
    const ok = await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
      note: 'y'.repeat(MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH),
    });
    expect(ok.statusCode).toBe(201);
    expect((await proposals.listByUser('user-1'))[0]!.note)
      .toHaveLength(MAX_KNOWLEDGE_PROPOSAL_NOTE_LENGTH);
  });

  it('refuses a page that carries CSS or JavaScript, naming the page', async () => {
    const { deps, token } = await buildDeps();
    const res = await propose(deps, token, {
      pages: [{ name: 'styled', html: PAGE('Styled', 'A page.', '<style>p{color:red}</style>') }],
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/"styled".*CSS/);
  });

  it('refuses a page with no description, since that is what a list shows', async () => {
    const { deps, token } = await buildDeps();
    const res = await propose(deps, token, {
      pages: [{ name: 'bare', html: '<title>Bare</title><p>hi</p>' }],
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/description/);
  });

  it('refuses an empty proposal and a page named twice in one', async () => {
    const { deps, token } = await buildDeps();
    expect((await propose(deps, token, {})).statusCode).toBe(400);
    const twice = await propose(deps, token, {
      pages: [
        { name: 'dup', html: PAGE('One', 'First.') },
        { name: 'dup', html: PAGE('Two', 'Second.') },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(String((twice.body as { error: string }).error)).toMatch(/twice/);
  });

  it('refuses removing a page that does not exist', async () => {
    const { deps, token } = await buildDeps();
    const res = await propose(deps, token, { deletes: ['ghost'] });
    expect(res.statusCode).toBe(404);
  });

  it('reads back the exact source once a proposal has landed', async () => {
    const { deps, token, service, proposals } = await buildDeps();
    const html = PAGE('Deploying', 'How the site gets deployed.');
    await propose(deps, token, { pages: [{ name: 'deploy-runbook', html }] });
    const [open] = await newest(proposals);
    const landed = await landNow(service, open!.id, 'user-1');
    expect(landed.status).toBe('landed');

    const list = createMockResponse();
    await routeHandler(deps, '/knowledge', 'get')(mockRequest({ token }), list);
    expect((list.body as { pages: Array<{ name: string; description: string }> }).pages).toEqual([
      expect.objectContaining({ name: 'deploy-runbook', description: 'How the site gets deployed.' }),
    ]);

    const page = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name', 'get')(
      mockRequest({ token, params: { name: 'deploy-runbook' } }),
      page,
    );
    // Byte-for-byte: the agent edits what it reads.
    expect((page.body as { page: { html: string } }).page.html).toBe(html);
  });

  it('records WHICH agent landed a page, so its row can wear that face', async () => {
    // A page belongs to the account, and six agents write into one knowledge
    // base — so without this, "who wrote this?" is unanswerable without
    // opening the page and guessing from its prose (Owner, 2026-08-17). The
    // proposal is the only record of it: the commit is authored by the
    // platform, not the agent.
    const { deps, token, service, proposals, files } = await buildDeps();
    await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
    });
    const [open] = await newest(proposals);
    expect(await landNow(service, open!.id, 'user-1')).toMatchObject({ status: 'landed' });

    const index = JSON.parse(files.get('index.json')!) as {
      pages: Record<string, { updatedByAgentId?: string }>;
    };
    expect(index.pages['deploy-runbook']!.updatedByAgentId).toBe('agent-a');
    // …and it survives the read the list is built from.
    const [summary] = await service.listPages('user-1');
    expect(summary).toMatchObject({ name: 'deploy-runbook', updatedByAgentId: 'agent-a' });
  });

  it('a page landed before attribution existed lists cleanly, with no agent', async () => {
    // Every index entry written before this shipped has no id, and the row it
    // feeds must keep its description and simply wear no face.
    const { deps, token, service, proposals, files } = await buildDeps();
    await propose(deps, token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
    });
    const [open] = await newest(proposals);
    await landNow(service, open!.id, 'user-1');
    const index = JSON.parse(files.get('index.json')!) as {
      pages: Record<string, Record<string, unknown>>;
    };
    delete index.pages['deploy-runbook']!.updatedByAgentId;
    files.set('index.json', JSON.stringify(index));

    const [summary] = await service.listPages('user-1');
    expect(summary).toMatchObject({ name: 'deploy-runbook', description: 'How the site gets deployed.' });
    expect(summary!.updatedByAgentId).toBeUndefined();
  });

  it('refuses a proposal that changes nothing', async () => {
    const { deps, token, service, proposals } = await buildDeps();
    const html = PAGE('Deploying', 'How the site gets deployed.');
    await propose(deps, token, { pages: [{ name: 'deploy-runbook', html }] });
    const [open] = await newest(proposals);
    await landNow(service, open!.id, 'user-1');

    const again = await propose(deps, token, { pages: [{ name: 'deploy-runbook', html }] });
    expect(again.statusCode).toBe(409);
    expect(String((again.body as { error: string }).error)).toMatch(/already says exactly this/);
  });

  it('refuses a change whose page moved underneath it, and marks the record conflict', async () => {
    const { deps, token, service, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'runbook', html: PAGE('One', 'First version.') }] });
    // Written against a version that is no longer there — the exact race the
    // baseSha pin exists for: the page is refused, never silently clobbered.
    const stale = await service.apply({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "One"',
      changes: [{ page: 'runbook', action: 'edit', html: PAGE('Two', 'Second version.'), title: 'Two', description: 'x', baseSha: 'stale' }],
    });
    expect(stale.status).toBe('conflict');
    expect(stale.status === 'conflict' && stale.pages).toEqual(['runbook']);
    expect(stale.proposal.status).toBe('conflict');
    expect((await proposals.get(stale.proposal.id))?.status).toBe('conflict');
    // And the page keeps what actually landed.
    const page = await service.readPage('user-1', 'runbook');
    expect(page?.content).toContain('First version.');
  });
  it('lets an agent withdraw a left-over open proposal once; a live change is not withdrawable', async () => {
    const { deps, token, proposals } = await buildDeps();
    await proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Add "Draft"', status: 'open', draft: true,
      changes: [{ page: 'draft', action: 'create', html: PAGE('Draft', 'A draft page.'), baseSha: null }],
    });
    const close = routeHandler(deps, '/knowledge/proposals/:number/close', 'post');

    const first = createMockResponse();
    await close(mockRequest({ token, params: { number: '1' } }), first);
    expect(first.statusCode).toBe(200);
    expect((await proposals.getByNumber('user-1', 1))!.status).toBe('withdrawn');

    const second = createMockResponse();
    await close(mockRequest({ token, params: { number: '1' } }), second);
    expect(second.statusCode).toBe(409);

    await propose(deps, token, { pages: [{ name: 'live', html: PAGE('Live', 'Landed at once.') }] });
    const live = createMockResponse();
    await close(mockRequest({ token, params: { number: '2' } }), live);
    expect(live.statusCode).toBe(409);
    expect((live.body as { error: string }).error).toContain('approved');
  });
  it('503s every knowledge route when the feature is not configured', async () => {
    const { deps, token } = await buildDeps();
    const bare = { userStorage: deps.userStorage };
    const res = createMockResponse();
    await routeHandler(bare, '/knowledge', 'get')(mockRequest({ token }), res);
    expect(res.statusCode).toBe(503);
  });

  /**
   * The gate is the ABSENCE: nothing an agent can call changes what the user
   * knows. The list is asserted whole so that adding to it is a decision.
   *
   * `post /knowledge/files` (2026-08-18, notes #10/#18) is the one entry that
   * has to argue for itself, because it does write something. What it writes
   * is BYTES INTO MEDIA STORAGE and nothing else: no page, no index entry, no
   * proposal. Until a landing puts the record in the index there is nothing
   * that addresses those bytes, so a staged file is not a thing the user knows
   * — it is a thing waiting to be proposed. The picture reaches the page
   * through `post /knowledge/proposals` and the same tap the words do.
   *
   * It is on the same footing as `note attach` and `pr attach`, which also
   * write bytes on an agent's own authority. What none of the three can do is
   * change a page.
   */
  it('the only routes that write a page are propose, ready and restore — and nothing approves (note #746)', async () => {
    const { deps } = await buildDeps();
    const router = agentCliRoutes(deps as RouteDeps) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const knowledgeRoutes = router.stack
      .map((layer) => layer.route)
      .filter((route): route is { path: string; methods: Record<string, boolean> } =>
        Boolean(route?.path.startsWith('/knowledge')))
      .map((route) => `${Object.keys(route.methods)[0]} ${route.path}`)
      .sort();
    expect(knowledgeRoutes).toEqual([
      'get /knowledge',
      'get /knowledge/pages/:name',
      'get /knowledge/pages/:name/history',
      'get /knowledge/proposals',
      'get /knowledge/proposals/:number',
      'post /knowledge/files',
      'post /knowledge/pages/:name/comments',
      'post /knowledge/pages/:name/restore',
      'post /knowledge/proposals',
      'post /knowledge/proposals/:number/close',
      'post /knowledge/proposals/:number/comments',
      'post /knowledge/proposals/:number/ready',
    ]);
    // Nothing here APPROVES: a page is written by its agent and put back by
    // anybody, and no verb hands a decision to a person.
    expect(knowledgeRoutes.filter((route) => /approve|decide|decision/.test(route))).toEqual([]);
  });
});

/**
 * Pictures on a page (Owner, notes #10 and #18).
 *
 * The point is not a download list — it is that a page can SHOW something.
 * Before this, a page's only ways to hold an image were a URL to somewhere
 * outside the account or a base64 `data:` URI inline, which puts a megabyte of
 * encoded bytes in the middle of the source every agent reads.
 *
 * Two properties carry the design, and both are asserted here: a file reaches
 * a page only through an APPROVAL, and a page whose words are already right
 * can still gain one.
 */
describe('files on a knowledge page', () => {
  class FakeMediaStorage {
    objects = new Map<string, { contentType: string; size: number }>();
    deleted: string[] = [];

    async uploadObject(args: { storagePath: string; contentType: string; data: Buffer }) {
      this.objects.set(args.storagePath, { contentType: args.contentType, size: args.data.length });
    }

    async createReadAccess(args: { storagePath: string }) {
      if (!this.objects.has(args.storagePath)) throw new Error('no such object');
      return { url: `https://signed.example/${args.storagePath}`, expiresAt: 'soon' };
    }

    async createUploadTarget() { return { uploadUrl: 'unused', expiresAt: 'soon' }; }
    async downloadObject() { return Buffer.alloc(0); }
    async setMetadata() {}
    async deleteObject(args: { storagePath: string }) {
      this.deleted.push(args.storagePath);
      this.objects.delete(args.storagePath);
    }
  }

  function stageRequest(args: {
    token: string; page: string; fileName: string; body?: Buffer; contentType?: string;
  }): Partial<Request> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${args.token}`,
      'x-page': args.page,
      'x-file-name': args.fileName,
      ...(args.contentType ? { 'content-type': args.contentType } : {}),
    };
    return {
      get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
      params: {}, query: {}, body: args.body ?? Buffer.from('png-bytes'),
    };
  }

  async function build() {
    const built = await buildDeps();
    const media = new FakeMediaStorage();
    (built.deps as Partial<RouteDeps>).mediaStorage = media as never;
    return { ...built, media };
  }

  const stage = (deps: Partial<RouteDeps>) => routeHandler(deps, '/knowledge/files', 'post');

  const PAGE_HTML = '<!doctype html><html><head><title>Wiring</title>'
    + '<meta name="description" content="How the shed is wired."></head>'
    + '<body><h1>Wiring</h1><img src="files/plan.png" alt="the plan"></body></html>';

  it('stages the bytes under the PAGE, and tells the agent how to point at them', async () => {
    const { deps, token, media } = await build();
    const res = createMockResponse();

    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), res);

    expect(res.statusCode).toBe(200);
    const [stored] = [...media.objects.keys()];
    // Keyed by the page, not by a proposal: a file outlives the change that
    // added it, and landing then moves nothing.
    expect(stored).toMatch(/^users\/user-1\/knowledge\/wiring\/.+\/plan\.png$/);
    expect(media.objects.get(stored!)?.contentType).toBe('image/png');
    // The message has to teach the reference, or a staged file is a file
    // nobody knows how to use.
    expect((res.body as { message: string }).message).toContain('<img src="files/plan.png">');
  });

  it('does not put the file on the page — only an approval does that', async () => {
    const { deps, token, service } = await build();
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);

    // Nothing has landed: no page, and nothing the base knows about.
    expect(await service.listPages('user-1')).toEqual([]);
  });

  it('carries the staged file into the proposal, and lands it with the page', async () => {
    const { deps, token, service, proposals, media } = await build();
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);
    const file = (staged.body as { file: { id: string; fileName: string; sizeBytes: number } }).file;

    const res = await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML, attach: [file] }],
    });
    expect(res.statusCode).toBe(201);

    const [proposal] = await proposals.listByUser('user-1');
    expect(proposal!.changes[0]!.attachments).toEqual([
      expect.objectContaining({ fileName: 'plan.png', storagePath: [...media.objects.keys()][0] }),
    ]);

    const landed = await landNow(service, proposal!.id, 'user-1');
    expect(landed.status).toBe('landed');
    const page = (await service.listPages('user-1')).find((p) => p.name === 'wiring');
    expect(page?.attachments).toEqual([expect.objectContaining({ fileName: 'plan.png' })]);
  });

  /**
   * The reason files are staged BEFORE the proposal rather than attached to
   * one. "Put the floor plan on the page" is a real request, and the words
   * of that page may already be perfect.
   */
  it('lets a page gain a picture without a word of it changing', async () => {
    const { deps, token, service, proposals } = await build();
    // Land the page first, with no files.
    const first = await propose(deps, token, { pages: [{ name: 'wiring', html: PAGE_HTML }] });
    expect(first.statusCode).toBe(201);
    await landNow(service, (await proposals.listByUser('user-1'))[0]!.id, 'user-1');

    // The same HTML again is refused — nothing to decide.
    const nothing = await propose(deps, token, { pages: [{ name: 'wiring', html: PAGE_HTML }] });
    expect(nothing.statusCode).toBe(409);

    // The same HTML WITH a file is a real change, and is accepted.
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);
    const withFile = await propose(deps, token, {
      pages: [{
        name: 'wiring',
        html: PAGE_HTML,
        attach: [(staged.body as { file: unknown }).file],
      }],
    });
    expect(withFile.statusCode).toBe(201);
  });

  it('leaves a page’s existing files alone when a change says nothing about them', async () => {
    const { deps, token, service, proposals } = await build();
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);
    await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML, attach: [(staged.body as { file: unknown }).file] }],
    });
    await landNow(service, (await proposals.listByUser('user-1'))[0]!.id, 'user-1');

    // An edit to the WORDS only.
    const edited = PAGE_HTML.replace('How the shed is wired.', 'How the shed is wired, in full.');
    await propose(deps, token, { pages: [{ name: 'wiring', html: edited }] });
    const [open] = await newest(proposals);
    await landNow(service, open!.id, 'user-1');

    // The picture is still on it: an edit to the text must never silently
    // strip what the page shows.
    const page = (await service.listPages('user-1')).find((p) => p.name === 'wiring');
    expect(page?.attachments).toEqual([expect.objectContaining({ fileName: 'plan.png' })]);
  });

  it('takes one off through the same gate, and clears the bytes when it lands', async () => {
    const { deps, token, service, proposals, media } = await build();
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);
    await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML, attach: [(staged.body as { file: unknown }).file] }],
    });
    await landNow(service, (await proposals.listByUser('user-1'))[0]!.id, 'user-1');

    const without = PAGE_HTML.replace('<img src="files/plan.png" alt="the plan">', '<p>No plan yet.</p>');
    await propose(deps, token, { pages: [{ name: 'wiring', html: without, detach: ['plan.png'] }] });
    expect((await service.listPages('user-1')).find((p) => p.name === 'wiring')?.attachments).toBeUndefined();
    // The landing reports the orphaned bytes and the route clears them at
    // once (note #746) — this service holds no media storage of its own.
    expect(media.objects.size).toBe(0);
  });

  it('refuses a detach of a file the page does not carry, and names what it has', async () => {
    const { deps, token, service, proposals } = await build();
    const staged = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), staged);
    await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML, attach: [(staged.body as { file: unknown }).file] }],
    });
    await landNow(service, (await proposals.listByUser('user-1'))[0]!.id, 'user-1');

    const res = await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML.replace('Wiring</h1>', 'Wiring!</h1>'), detach: ['nope.png'] }],
    });
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain('plan.png');
  });

  /** The path is rebuilt from the authenticated user, never taken from the
   *  caller — a storage path handed to us by the thing we are checking. */
  it('will not take a storage path from the agent', async () => {
    const { deps, token, proposals } = await build();
    const res = await propose(deps, token, {
      pages: [{
        name: 'wiring',
        html: PAGE_HTML,
        attach: [{
          id: '11111111-1111-4111-8111-111111111111',
          fileName: 'plan.png',
          sizeBytes: 10,
          storagePath: 'users/someone-else/knowledge/secrets/x/plan.png',
        }],
      }],
    });
    expect(res.statusCode).toBe(201);
    const [proposal] = await proposals.listByUser('user-1');
    expect(proposal!.changes[0]!.attachments![0]!.storagePath)
      .toBe('users/user-1/knowledge/wiring/11111111-1111-4111-8111-111111111111/plan.png');
  });

  it('refuses an id that was never staged by this backend', async () => {
    const { deps, token } = await build();
    const res = await propose(deps, token, {
      pages: [{ name: 'wiring', html: PAGE_HTML, attach: [{ id: '../../etc', fileName: 'plan.png' }] }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('staged');
  });

  it('refuses a name a page could not point at, and says why', async () => {
    const { deps, token } = await build();
    const res = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan (1).png' }), res);
    expect(res.statusCode).toBe(400);
    // The page refers to it BY NAME, which is why the rule is what it is.
    expect((res.body as { error: string }).error).toContain('points at it by this name');
  });

  it('says so plainly on a backend with no file store', async () => {
    const { deps, token } = await build();
    (deps as Partial<RouteDeps>).mediaStorage = undefined;
    const res = createMockResponse();
    await stage(deps)(stageRequest({ token, page: 'wiring', fileName: 'plan.png' }), res);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toContain('words-only');
  });
});

describe('knowledge on a shared org namespace (byo-git slice 3)', () => {
  it("one member proposes, the base is the ORG's, and the record remembers who asked", async () => {
    const { deps, proposals } = await buildDeps();
    // A second member joins the same stamped org as user-1.
    const userStorage = deps.userStorage as InMemoryUserStorage;
    await userStorage.createProfile('member-2', { email: 'm@example.com', displayName: 'M' });
    const minted = mintAgentbuiltToken('member-2', 'agent-b');
    await userStorage.updateProfile('member-2', {
      telegram: {
        chatId: '2', linkedAt: 't', notificationsEnabled: true,
        agents: { 'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', agentbuiltTokenHash: minted.tokenHash } as never },
      },
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'member-2', role: 'member' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    deps.orgGit = orgGit;

    const res = await propose(deps, minted.token, {
      pages: [{ name: 'wifi', html: PAGE('Wifi', 'The office wifi.') }],
    });
    expect(res.statusCode).toBe(201);

    // The proposal lives in the NAMESPACE (one base per org), and remembers
    // the asking member, so the outcome can wake the right chat.
    const [doc] = await proposals.listByUser('user-1');
    expect(doc?.userId).toBe('user-1');
    expect(doc?.createdByUserId).toBe('member-2');
    expect(await proposals.listByUser('member-2')).toEqual([]);
  });
});

/**
 * One series of proposal numbers for the workplace (note #741). Numbers
 * issued per room before that were kept, and the old rooms' namespaces stay
 * the workplace's as history (note #843, #923): a number held there once is
 * found, the workplace's own copy wins a clash, and a number held twice with
 * neither copy at the workplace is refused — the agent is told to ask.
 */
describe('knowledge proposal numbers are one series for the workplace (note #741)', () => {
  it('numbers a new proposal above every number held, and finds one by number across the old rooms’ namespaces', async () => {
    const { deps, token, proposals } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // Two old rooms' namespaces, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-growth', 'ns-ops'] },
    });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    deps.knowledgeShelf = (namespaceId) => orgGit.knowledgeShelfFor(namespaceId);
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    // Before the series, numbered room by room: #1 at the workplace, #1–#3
    // in Growth, #1–#2 in Ops.
    const legacy = (userId: string, page: string) => proposals.create({
      userId, title: `Add ${page}`, createdByAgentId: 'agent-z', status: 'open',
      changes: [{ page, action: 'create', html: '<p>x</p>', baseSha: null }],
    });
    await legacy('user-1', 'platform-page');
    await legacy('ns-growth', 'growth-page');
    await legacy('ns-growth', 'growth-two');
    await legacy('ns-growth', 'growth-three');
    await legacy('ns-ops', 'ops-page');
    await legacy('ns-ops', 'ops-two');

    const res = await propose(deps, token, { pages: [{ name: 'numbers', html: PAGE('Numbers', 'One series per workplace.') }] });
    expect(res.statusCode).toBe(201);
    expect((res.body as { proposal: { number: number } }).proposal.number).toBe(4);

    const show = async (number: string) => {
      const out = createMockResponse();
      await routeHandler(deps, '/knowledge/proposals/:number', 'get')(mockRequest({ token, params: { number } }), out);
      return out;
    };
    expect((await show('4')).body).toMatchObject({ proposal: { number: 4, title: 'Add "Numbers" to knowledge' } });
    // A number held once, in an old room's namespace, is found there…
    expect((await show('3')).body).toMatchObject({ proposal: { title: 'Add growth-three' } });
    // …#1, held three times, is the workplace's own…
    expect((await show('1')).body).toMatchObject({ proposal: { title: 'Add platform-page' } });
    // …and #2, held twice with neither at the workplace, is refused.
    const shared = await show('2');
    expect(shared.statusCode).toBe(409);
    expect(String((shared.body as { error: string }).error)).toContain('held twice');
    expect(String((shared.body as { error: string }).error)).toContain('Ask your user');
    expect((await show('8')).statusCode).toBe(404);
  });
});

/**
 * One shelf for the workplace (note #566). A page proposed by any member
 * lands on the workplace's one base, and so did a page an old room proposed
 * before rooms went (note #843): the shelf remembers that origin, but the
 * list names no room and never carries a namespace id.
 */
describe('knowledge belongs to the workplace (note #566)', () => {
  it('lands every page on the workplace shelf, and lists them with no room labels', async () => {
    const { deps, token, proposals } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // An old room's namespace, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-growth'] },
    });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    deps.knowledgeShelf = (namespaceId) => orgGit.knowledgeShelfFor(namespaceId);
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    const service = new KnowledgeService(deps.gitHostClient!, proposals, deps.knowledgeShelf);

    // A proposal Growth made before rooms went lands on the workplace's
    // shelf, remembering where it came from.
    const old = await proposals.create({
      userId: 'ns-growth', title: 'Add landing-copy-rules', createdByAgentId: 'agent-z', status: 'open',
      changes: [{ page: 'landing-copy-rules', action: 'create', html: PAGE('Copy rules', 'What the landing page may claim.'), baseSha: null }],
    });
    expect((await landNow(service, old.id, 'user-1')).status).toBe('landed');
    const [landed] = await service.listPages('user-1');
    expect(landed).toMatchObject({ name: 'landing-copy-rules', originNamespaceId: 'ns-growth' });

    // A page proposed now is the workplace's, and lands there too.
    const own = await propose(deps, token, { pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How a change ships.') }] });
    expect(own.statusCode).toBe(201);
    const ownDoc = (await proposals.listByUser('user-1')).find((p) => p.number === (own.body as { proposal: { number: number } }).proposal.number)!;
    expect((await landNow(service, ownDoc.id, 'user-1')).status).toBe('landed');

    const list = async () => {
      const out = createMockResponse();
      await routeHandler(deps, '/knowledge', 'get')(mockRequest({ token }), out);
      return (out.body as { pages: Array<Record<string, unknown>> }).pages;
    };
    const pages = await list();
    expect(pages.map((page) => page.name).sort()).toEqual(['deploy-runbook', 'landing-copy-rules']);
    for (const page of pages) {
      expect(page).not.toHaveProperty('room');
      // A namespace id is an internal address and never rides the answer.
      expect(page).not.toHaveProperty('originNamespaceId');
    }
    expect(pages.find((page) => page.name === 'deploy-runbook')).toMatchObject({ here: true });

    // An edit from the workplace lands on the same page and keeps its origin.
    const edit = await propose(deps, token, { pages: [{ name: 'landing-copy-rules', html: PAGE('Copy rules', 'What the landing page may claim, revised.') }] });
    expect(edit.statusCode).toBe(201);
    const editDoc = (await proposals.listByUser('user-1')).find((p) => p.number === (edit.body as { proposal: { number: number } }).proposal.number)!;
    expect((await landNow(service, editDoc.id, 'user-1')).status).toBe('landed');
    expect((await service.listPages('user-1')).find((page) => page.name === 'landing-copy-rules')).toMatchObject({
      description: 'What the landing page may claim, revised.', originNamespaceId: 'ns-growth',
    });
  });
});

/**
 * The margin on knowledge (Owner, note #66): a signed remark BESIDE a page
 * or under a proposal, never a change to the words above it. The page's
 * thread lives in a store of its own because the page lives in git and a
 * remark must not cost a commit; the proposal's rides the document, like a
 * note's. What both must get right is the signature — "you", a name, "your
 * user" — because an id tells the reading agent nothing.
 */
describe('the margin: comments on pages and proposals', () => {
  async function buildWithPage() {
    const built = await buildDeps();
    await propose(built.deps, built.token, {
      pages: [{ name: 'deploy-runbook', html: PAGE('Deploying', 'How the site gets deployed.') }],
    });
    const [open] = await newest(built.proposals);
    await landNow(built.service, open!.id, 'user-1');
    return built;
  }

  const commentOnPage = async (deps: Partial<RouteDeps>, token: string, name: string, body: unknown) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name/comments', 'post')(
      mockRequest({ token, params: { name }, body }),
      res,
    );
    return res;
  };

  const commentOnProposal = async (deps: Partial<RouteDeps>, token: string, number: string, body: unknown) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/proposals/:number/comments', 'post')(
      mockRequest({ token, params: { number }, body }),
      res,
    );
    return res;
  };

  it('signs a remark onto a page, and the page wears it on the next read', async () => {
    const { deps, token } = await buildWithPage();
    const res = await commentOnPage(deps, token, 'deploy-runbook', { text: 'Stale — the deploy moved to the new host.' });

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; message: string; comments: Array<{ text: string; by: string; createdAt: string }> };
    expect(body.ok).toBe(true);
    // The message names the page: it is the receipt the agent quotes.
    expect(body.message).toContain('"deploy-runbook"');
    // "you" — its own remark, from a turn it may no longer remember.
    expect(body.comments).toEqual([
      expect.objectContaining({ text: 'Stale — the deploy moved to the new host.', by: 'you' }),
    ]);

    // No second verb: the margin rides the read every agent already does.
    const page = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name', 'get')(
      mockRequest({ token, params: { name: 'deploy-runbook' } }),
      page,
    );
    expect((page.body as { page: { comments?: Array<{ text: string; by: string }> } }).page.comments).toEqual([
      expect.objectContaining({ text: 'Stale — the deploy moved to the new host.', by: 'you' }),
    ]);
  });

  it('refuses what a page margin cannot hold, one reason at a time', async () => {
    const { deps, token, pageComments } = await buildWithPage();
    // A page that does not exist has no margin to write in.
    expect((await commentOnPage(deps, token, 'ghost', { text: 'hello' })).statusCode).toBe(404);
    // No words, no comment.
    expect((await commentOnPage(deps, token, 'deploy-runbook', { text: '   ' })).statusCode).toBe(400);
    // The margin obeys the same HTML rules as the page beside it.
    expect((await commentOnPage(deps, token, 'deploy-runbook', { text: '<script>alert(1)</script>' })).statusCode).toBe(400);

    // The fiftieth remark is the last: past that, the margin's advice is to
    // put what everyone agrees on INTO the page.
    for (let i = 0; i < 50; i += 1) {
      await pageComments.add('user-1', 'deploy-runbook', newMarginComment('agent-a', `remark ${i}`, 'user-1'));
    }
    const full = await commentOnPage(deps, token, 'deploy-runbook', { text: 'one more' });
    expect(full.statusCode).toBe(400);
    expect(String((full.body as { error: string }).error)).toMatch(/50 comments/);
  });

  it('says plainly when the backend has no page-comment store', async () => {
    const { deps, token } = await buildDeps();
    deps.knowledgePageCommentStorage = undefined;
    const res = await commentOnPage(deps, token, 'deploy-runbook', { text: 'hello' });
    expect(res.statusCode).toBe(503);
  });

  it('appends to a landed change, stamped with the agent and its owner', async () => {
    const { deps, token, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'runbook', html: PAGE('Runbook', 'The deploy, step by step.') }] });

    const res = await commentOnProposal(deps, token, '1', { text: 'Found the missing rollback step.' });
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; proposal: { comments: Array<{ text: string; by: string }> } };
    expect(body.ok).toBe(true);
    expect(body.proposal.comments).toEqual([
      expect.objectContaining({ text: 'Found the missing rollback step.', by: 'you' }),
    ]);

    // The stamps in storage: the agent that spoke, and the human behind it —
    // the signature that survives the agent's retirement (note #57).
    const doc = (await proposals.getByNumber('user-1', 1))!;
    expect(doc.comments).toEqual([expect.objectContaining({ authorId: 'agent-a', userId: 'user-1' })]);
  });
  it('closes a proposal’s margin with the decision', async () => {
    const { deps, token, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'draft', html: PAGE('Draft', 'A draft page.') }] });
    const [doc] = await newest(proposals);
    await proposals.update(doc!.id, { status: 'rejected', decidedAt: new Date().toISOString() });

    const res = await commentOnProposal(deps, token, '1', { text: 'one more thought' });
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/rejected/);
  });

  it("reads a person's remark back as 'your user', never as an id", async () => {
    const { deps, token, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'draft', html: PAGE('Draft', 'A draft page.') }] });
    const [doc] = await newest(proposals);
    // Written from the Workspace: the sentinel author, the person's own id.
    await proposals.addComment(doc!.id, newMarginComment(COMMENT_AUTHOR_USER, '<p>please add the rollback step</p>', 'user-1'));

    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/proposals/:number', 'get')(
      mockRequest({ token, params: { number: '1' } }),
      res,
    );
    expect((res.body as { proposal: { comments: Array<{ by: string }> } }).proposal.comments).toEqual([
      expect.objectContaining({ by: 'your user' }),
    ]);
  });
});

/**
 * Renaming a page (our owner, 2026-09-06: "React migration is our past, it's
 * finished. Maybe we should rename that doc?").
 *
 * The name is the handle agents read the shelf by — there is no search, so
 * `knowledge list` is one column of names beside one line of description — and
 * five of this room's twenty-six pages were named after the Telegram Mini App
 * or the React migration, neither of which the product still has. Nobody had
 * fixed one, because the only way was delete-and-recreate and a delete takes
 * the page's whole margin with it.
 */
describe('renaming a knowledge page', () => {
  async function withPage(name = 'workspace-react-migration') {
    const built = await buildDeps();
    await propose(built.deps, built.token, {
      pages: [{ name, html: PAGE('Working on the shell', 'What to know before you change it.') }],
    });
    const [open] = await newest(built.proposals);
    await landNow(built.service, open!.id, 'user-1');
    return built;
  }

  it('moves the page and its words, and leaves nothing behind at the old name', async () => {
    const { deps, token, proposals, service, files } = await withPage();
    const before = files.get('pages/workspace-react-migration.html');

    const res = await propose(deps, token, {
      renames: [{ from: 'workspace-react-migration', to: 'workspace-shell' }],
    });
    expect(res.statusCode).toBe(201);
    const [open] = await newest(proposals);
    // The proposal says what it is doing in both addresses, because the words
    // are untouched — a title naming one page would read as nothing happening.
    expect(open!.title).toBe('Rename "workspace-react-migration" to "workspace-shell"');
    expect(open!.changes).toEqual([expect.objectContaining({
      page: 'workspace-react-migration',
      action: 'rename',
      renameTo: 'workspace-shell',
      title: 'Working on the shell',
    })]);

    const landed = await landNow(service, open!.id, 'user-1');
    expect(landed.status).toBe('landed');
    expect(files.get('pages/workspace-shell.html')).toBe(before);
    expect(files.has('pages/workspace-react-migration.html')).toBe(false);
    // Nothing is orphaned by a move: the page's files come with it.
    expect(landed.status === 'landed' && landed.orphaned).toEqual([]);

    // The listing — what `knowledge list` prints — answers under the new name
    // with the page's own title and description, not a rebuilt guess.
    const listed = await service.listPages('user-1');
    expect(listed.map((page) => page.name)).toEqual(['workspace-shell']);
    expect(listed[0]).toMatchObject({
      title: 'Working on the shell',
      description: 'What to know before you change it.',
    });
  });

  it('takes the page’s margin with it — the whole reason it is not a delete', async () => {
    const { deps, token, proposals, service, pageComments } = await withPage();
    await pageComments.add('user-1', 'workspace-react-migration', newMarginComment('agent-a', 'Slice 4 learned this.', 'user-1'));
    await pageComments.add('user-1', 'workspace-react-migration', newMarginComment('agent-a', 'Fold this in next edit.', 'user-1'));

    await propose(deps, token, { renames: [{ from: 'workspace-react-migration', to: 'workspace-shell' }] });
    const [open] = await newest(proposals);
    const landed = await landNow(service, open!.id, 'user-1');
    expect(landed.status).toBe('landed');
    // The route moves the margin beside the page the moment the change lands
    // (note #746) — by the same named rule `agent-service` calls for a
    // left-over proposal — so nothing here has to.

    expect((await pageComments.list('user-1', 'workspace-shell')).map((c) => c.text))
      .toEqual(['Slice 4 learned this.', 'Fold this in next edit.']);
    expect(await pageComments.list('user-1', 'workspace-react-migration')).toEqual([]);
  });

  /** The three rules in one place, since the difference between them is the
   *  point: a delete drops a margin, a rename moves it, an edit leaves it. */
  it('drops a margin on a delete, moves it on a rename, and leaves it on an edit', async () => {
    const { pageComments } = await buildDeps();
    for (const page of ['going', 'moving', 'edited']) {
      await pageComments.add('user-1', page, newMarginComment('agent-a', `about ${page}`, 'user-1'));
    }
    await moveMarginsForLandedChanges(pageComments, 'user-1', [
      { page: 'going', action: 'delete' },
      { page: 'moving', action: 'rename', renameTo: 'moved' },
      { page: 'edited', action: 'edit' },
    ]);
    expect(await pageComments.list('user-1', 'going')).toEqual([]);
    expect(await pageComments.list('user-1', 'moving')).toEqual([]);
    expect((await pageComments.list('user-1', 'moved')).map((c) => c.text)).toEqual(['about moving']);
    expect((await pageComments.list('user-1', 'edited')).map((c) => c.text)).toEqual(['about edited']);

    // No store configured is not a failure: the pages have landed either way.
    await expect(moveMarginsForLandedChanges(undefined, 'user-1', [{ page: 'x', action: 'delete' }]))
      .resolves.toBeUndefined();
  });

  it('refuses a rename onto a name that is already a page', async () => {
    const { deps, token, proposals, service } = await withPage();
    await propose(deps, token, { pages: [{ name: 'workspace-shell', html: PAGE('Taken', 'Already here.') }] });
    const [taken] = await newest(proposals);
    await landNow(service, taken!.id, 'user-1');

    const res = await propose(deps, token, {
      renames: [{ from: 'workspace-react-migration', to: 'workspace-shell' }],
    });
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/already a knowledge page/);
  });

  it('refuses renaming a page that is not there, and a move to nowhere new', async () => {
    const { deps, token } = await withPage();
    expect((await propose(deps, token, { renames: [{ from: 'ghost', to: 'phantom' }] })).statusCode).toBe(404);
    const same = await propose(deps, token, {
      renames: [{ from: 'workspace-react-migration', to: 'workspace-react-migration' }],
    });
    expect(same.statusCode).toBe(400);
    expect(String((same.body as { error: string }).error)).toMatch(/already its name/);
    // And a name that is not a page name at all.
    expect((await propose(deps, token, {
      renames: [{ from: 'workspace-react-migration', to: 'Not A Name' }],
    })).statusCode).toBe(400);
  });

  it('keeps its own default title inside the limit the route checks it against', async () => {
    const long = `${'a'.repeat(55)}-page`;
    const built = await buildDeps();
    await propose(built.deps, built.token, {
      pages: [{ name: long, html: PAGE('Long', 'A page with a long name.') }],
    });
    const [made] = await newest(built.proposals);
    await landNow(built.service, made!.id, 'user-1');

    // Two ordinary page names compose a title over the 120-character cap, and
    // the agent wrote no title of its own — so without the clamp the proposal
    // is refused for a line it never typed.
    const res = await propose(built.deps, built.token, {
      renames: [{ from: long, to: `${'b'.repeat(55)}-page` }],
    });
    expect(res.statusCode).toBe(201);
    const open = (await newest(built.proposals))[0]!;
    expect(open.title.length).toBeLessThanOrEqual(120);
    expect(open.title.startsWith('Rename "')).toBe(true);
  });

  it('refuses renaming a page the same proposal also rewrites', async () => {
    const { deps, token } = await withPage();
    const res = await propose(deps, token, {
      pages: [{ name: 'workspace-react-migration', html: PAGE('Edited', 'Edited in the same breath.') }],
      renames: [{ from: 'workspace-react-migration', to: 'workspace-shell' }],
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/renamed and also changed/);
  });

  it('will not land once the destination has been taken underneath it', async () => {
    const { deps, token, proposals, service } = await withPage();
    const current = (await service.currentShas('user-1')).get('workspace-react-migration')!;
    // A rename written before somebody else created that page, and landing after.
    const move = await proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Rename', status: 'open',
      changes: [{ page: 'workspace-react-migration', action: 'rename', renameTo: 'workspace-shell', baseSha: current }],
    });
    await propose(deps, token, { pages: [{ name: 'workspace-shell', html: PAGE('Mine', 'Got here first.') }] });
    // The source has not moved, so only the destination check catches this —
    // and without it the rename would overwrite a page that already landed.
    const blocked = await landNow(service, move.id, 'user-1');
    expect(blocked.status).toBe('conflict');
    expect(blocked.status === 'conflict' && blocked.pages).toEqual(['workspace-react-migration']);
  });
});

/**
 * Every change is restorable (note #746) — what makes the missing gate safe.
 * The landing keeps each page's words before the change, so the history is
 * on the record and "put it back" is one call, with no git archaeology.
 */
describe('every knowledge change is restorable (note #746)', () => {
  const history = async (deps: Partial<RouteDeps>, token: string, name: string) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name/history', 'get')(mockRequest({ token, params: { name } }), res);
    return (res.body as { versions: Array<Record<string, unknown>> }).versions;
  };
  const restore = async (deps: Partial<RouteDeps>, token: string, name: string, body: Record<string, unknown> = {}) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name/restore', 'post')(mockRequest({ token, params: { name }, body }), res);
    return res;
  };

  it('lists a page’s versions newest first, puts it back one step, and to any earlier version', async () => {
    const { deps, token, files, service } = await buildDeps();
    const told: string[] = [];
    deps.tellOwnerKnowledgeChanged = async ({ proposalId }) => { told.push(proposalId); return true; };
    await propose(deps, token, { pages: [{ name: 'deploys', html: PAGE('Deploys', 'First.') }], note: 'first draft' });
    await propose(deps, token, { pages: [{ name: 'deploys', html: PAGE('Deploys', 'Second.') }], note: 'rewrote it' });
    expect(files.get('pages/deploys.html')).toContain('Second.');

    expect(await history(deps, token, 'deploys')).toEqual([
      expect.objectContaining({ number: 2, action: 'edit', note: 'rewrote it', by: 'you', canRestore: true }),
      expect.objectContaining({ number: 1, action: 'create', note: 'first draft', canRestore: true }),
    ]);

    // One step back: the words before the last change.
    const undone = await restore(deps, token, 'deploys');
    expect(undone.statusCode).toBe(201);
    expect((undone.body as { proposal: { number: number; restoreOf: unknown } }).proposal).toMatchObject({ number: 3, restoreOf: { page: 'deploys' } });
    expect(files.get('pages/deploys.html')).toContain('First.');
    expect(told).toHaveLength(3);
    // The restore is itself a version: nothing in history was rewritten.
    expect((await history(deps, token, 'deploys')).map((v) => [v.number, v.action, v.restore ?? false])).toEqual([[3, 'edit', true], [2, 'edit', false], [1, 'create', false]]);

    // And to exactly what an earlier change landed.
    const back = await restore(deps, token, 'deploys', { to: 2 });
    expect(back.statusCode).toBe(201);
    expect(files.get('pages/deploys.html')).toContain('Second.');
    expect((await service.readPage('user-1', 'deploys'))?.content).toContain('Second.');
    // Already that version: nothing to do, said plainly.
    const same = await restore(deps, token, 'deploys', { to: 2 });
    expect(same.statusCode).toBe(409);
    expect((same.body as { error: string }).error).toContain('already is that version');
  });

  it('undoes a creation by removing the page, and a removal by writing it back', async () => {
    const { deps, token, files } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'oops', html: PAGE('Oops', 'Should not exist.') }] });
    expect(files.has('pages/oops.html')).toBe(true);
    expect((await restore(deps, token, 'oops')).statusCode).toBe(201);
    expect(files.has('pages/oops.html')).toBe(false);
    // The removal is the newest version; putting THAT back brings the page.
    expect((await restore(deps, token, 'oops')).statusCode).toBe(201);
    expect(files.get('pages/oops.html')).toContain('Should not exist.');

    await propose(deps, token, { deletes: ['oops'] });
    expect(files.has('pages/oops.html')).toBe(false);
    expect((await restore(deps, token, 'oops')).statusCode).toBe(201);
    expect(files.get('pages/oops.html')).toContain('Should not exist.');
    expect((await restore(deps, token, 'never-was')).statusCode).toBe(409);
  });
});

/**
 * What was still waiting for a tap when the gate went (note #746) is settled
 * once at boot: ready ones applied, quiet ones withdrawn, moved ones marked
 * conflict — each with a signed remark, and nothing left in a queue.
 */
describe('settling the proposals that were open when knowledge changes went live at once', () => {
  it('applies the ready, withdraws the quiet, marks the moved conflict', async () => {
    const { deps, token, files, proposals } = await buildDeps();
    const { settleOpenKnowledgeProposals } = await import('../../services/knowledge-direct-backfill.js');
    await propose(deps, token, { pages: [{ name: 'deploys', html: PAGE('Deploys', 'Current.') }] });
    const make = (title: string, change: Record<string, unknown>, draft?: true) => proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title, status: 'open', ...(draft ? { draft } : {}),
      changes: [change as never],
    });
    const ready = await make('Add "Runbook"', { page: 'runbook', action: 'create', html: PAGE('Runbook', 'Steps.'), title: 'Runbook', description: 'x', baseSha: null });
    const quiet = await make('Add "Half"', { page: 'half', action: 'create', html: PAGE('Half', 'Unfinished.'), baseSha: null }, true);
    const moved = await make('Update "Deploys"', { page: 'deploys', action: 'edit', html: PAGE('Deploys', 'Stale.'), baseSha: 'gone' });
    const told: string[] = [];

    const settled = await settleOpenKnowledgeProposals({
      proposals, hostFor: async () => deps.gitHostClient!, told: async ({ proposalId }) => { told.push(proposalId); return true; },
    });
    expect(settled).toMatchObject({ applied: [ready.number], withdrawn: [quiet.number], conflicts: [moved.number], deferred: [] });
    expect(files.has('pages/runbook.html')).toBe(true);
    expect(files.has('pages/half.html')).toBe(false);
    expect(files.get('pages/deploys.html')).toContain('Current.');
    expect(await proposals.get(ready.id)).toMatchObject({ status: 'approved', direct: true });
    expect((await proposals.get(ready.id))?.comments?.[0]?.text).toContain('Applied by the platform');
    expect(await proposals.get(quiet.id)).toMatchObject({ status: 'withdrawn' });
    expect(await proposals.get(moved.id)).toMatchObject({ status: 'conflict' });
    expect(told).toEqual([ready.id]);
    expect(await proposals.listAllOpen()).toEqual([]);
    // Once settled, a second boot finds nothing to do.
    expect(await settleOpenKnowledgeProposals({ proposals, hostFor: async () => deps.gitHostClient! })).toEqual({ applied: [], withdrawn: [], conflicts: [], deferred: [] });
  });
});

/** Rosa's review of note #746: the three places a direct change could go wrong. */
describe('direct knowledge changes under Rosa’s review (note #746)', () => {
  const restore = async (deps: Partial<RouteDeps>, token: string, name: string, body: Record<string, unknown> = {}) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name/restore', 'post')(mockRequest({ token, params: { name }, body }), res);
    return res;
  };
  const history = async (deps: Partial<RouteDeps>, token: string, name: string) => {
    const res = createMockResponse();
    await routeHandler(deps, '/knowledge/pages/:name/history', 'get')(mockRequest({ token, params: { name } }), res);
    return (res.body as { versions: Array<Record<string, unknown>> }).versions;
  };

  it('undoes a rename by renaming back, from the renamed page only, and never duplicates the page', async () => {
    const { deps, token, files, pageComments } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'old-name', html: PAGE('Shell', 'How the shell works.') }] });
    await pageComments.add('user-1', 'old-name', newMarginComment('agent-a', 'still true', 'user-1'));
    await propose(deps, token, { renames: [{ from: 'old-name', to: 'new-name' }] });
    expect(files.has('pages/new-name.html')).toBe(true);
    expect(files.has('pages/old-name.html')).toBe(false);

    // From the source name: no second copy — it points at the renamed page.
    const fromSource = await restore(deps, token, 'old-name');
    expect(fromSource.statusCode).toBe(409);
    expect((fromSource.body as { error: string }).error).toContain('agentbuilt knowledge restore new-name');
    expect(files.has('pages/old-name.html')).toBe(false);
    // The rename row is restorable only on the renamed page, and only while newest.
    expect((await history(deps, token, 'old-name')).find((v) => v.action === 'rename')).toMatchObject({ canRestore: false });
    expect((await history(deps, token, 'new-name'))[0]).toMatchObject({ action: 'rename', canRestore: true });
    // `--to` the rename says what to do instead.
    const toRename = await restore(deps, token, 'new-name', { to: 2 });
    expect(toRename.statusCode).toBe(409);
    expect((toRename.body as { error: string }).error).toContain('renamed');

    // From the renamed page: the rename is undone, words and margin travel back.
    const undone = await restore(deps, token, 'new-name');
    expect(undone.statusCode).toBe(201);
    expect(files.has('pages/old-name.html')).toBe(true);
    expect(files.has('pages/new-name.html')).toBe(false);
    expect((await pageComments.list('user-1', 'old-name')).map((c) => c.text)).toEqual(['still true']);
    expect(await pageComments.list('user-1', 'new-name')).toEqual([]);
    const all = await (deps.knowledgeProposalStorage!).listByUser('user-1');
    expect(all[all.length - 1]!.changes[0]).toMatchObject({ page: 'new-name', action: 'rename', renameTo: 'old-name' });
    expect(all[all.length - 1]!.restoreOf).toEqual({ page: 'new-name' });
  });

  it('says which files did not come back when a removed page is restored', async () => {
    const { deps, token, files, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'wiring', html: PAGE('Wiring', 'The plan.') }] });
    const [made] = await proposals.listByUser('user-1');
    // A page carrying a file, as the index records it after an attach landed.
    const index = JSON.parse(files.get('index.json')!) as { pages: Record<string, { attachments?: unknown[] }> };
    index.pages['wiring']!.attachments = [{ id: 'f1', fileName: 'plan.png', contentType: 'image/png', sizeBytes: 3, storagePath: 'users/user-1/knowledge/wiring/f1/plan.png', addedByAgentId: 'agent-a', addedAt: made!.createdAt }];
    files.set('index.json', JSON.stringify(index));
    await propose(deps, token, { deletes: ['wiring'] });
    expect((await proposals.listByUser('user-1'))[1]!.changes[0]).toMatchObject({ action: 'delete', previousFiles: ['plan.png'] });

    const back = await restore(deps, token, 'wiring');
    expect(back.statusCode).toBe(201);
    expect(files.get('pages/wiring.html')).toContain('The plan.');
    expect((back.body as { message: string }).message).toContain('plan.png');
    expect((back.body as { message: string }).message).toContain('did NOT come back');
  });

  it('a change caught between its record and its landing is nobody’s decision, and settling never applies it', async () => {
    const { deps, token, files, proposals } = await buildDeps();
    const { settleOpenKnowledgeProposals } = await import('../../services/knowledge-direct-backfill.js');
    await propose(deps, token, { pages: [{ name: 'deploys', html: PAGE('Deploys', 'Current.') }] });
    // What apply() writes first — and what a crash would leave behind.
    const midFlight = await proposals.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "Deploys"', status: 'open', direct: true, draft: true,
      changes: [{ page: 'deploys', action: 'edit', html: PAGE('Deploys', 'Half-landed.'), baseSha: (await deps.gitHostClient!.knowledgeList('user-1')).pages[0]!.sha }],
    });
    expect(knowledgeProposalAwaitsDecision(midFlight)).toBe(false);
    expect(knowledgeProposalAwaitsDecision({ ...midFlight, draft: undefined })).toBe(false);

    const settled = await settleOpenKnowledgeProposals({ proposals, hostFor: async () => deps.gitHostClient! });
    expect(settled.conflicts).toEqual([midFlight.number]);
    expect(settled.applied).toEqual([]);
    expect(files.get('pages/deploys.html')).toContain('Current.');
    expect((await proposals.get(midFlight.id))?.comments?.[0]?.text).toContain('interrupted');
  });

  it('pins a landing on the shelf head it read: a shelf that moved meanwhile is re-read once, and a moved page is never clobbered', async () => {
    const { deps, token, files, service, proposals } = await buildDeps();
    await propose(deps, token, { pages: [{ name: 'a', html: PAGE('A', 'A one.') }] });
    await propose(deps, token, { pages: [{ name: 'b', html: PAGE('B', 'B one.') }] });
    const client = deps.gitHostClient!;
    const original = client.knowledgeCommit.bind(client);

    // Another agent lands on a DIFFERENT page between this one's read and
    // its commit: stale once, re-read, landed — both changes survive.
    let interleaved = 0;
    client.knowledgeCommit = async (userId, args) => {
      if (interleaved === 0) {
        interleaved += 1;
        await original(userId, { writes: [{ path: 'pages/b.html', content: PAGE('B', 'B two.') }], message: 'other agent' });
      }
      return original(userId, args);
    };
    const shaA = (await service.currentShas('user-1')).get('a')!;
    const edited = await service.apply({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "A"',
      changes: [{ page: 'a', action: 'edit', html: PAGE('A', 'A two.'), title: 'A', description: 'x', baseSha: shaA }],
    });
    expect(edited.status).toBe('applied');
    expect(files.get('pages/a.html')).toContain('A two.');
    expect(files.get('pages/b.html')).toContain('B two.');
    expect(interleaved).toBe(1);

    // The other agent lands on the SAME page in that window: this change is
    // refused as a conflict, and what landed first is what stands — with its
    // own history entry intact, so nothing was overwritten silently.
    let again = 0;
    client.knowledgeCommit = async (userId, args) => {
      if (again === 0) {
        again += 1;
        await original(userId, { writes: [{ path: 'pages/a.html', content: PAGE('A', 'A three, by the other agent.') }], message: 'other agent' });
      }
      return original(userId, args);
    };
    const shaA2 = (await service.currentShas('user-1')).get('a')!;
    const lost = await service.apply({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "A" again',
      changes: [{ page: 'a', action: 'edit', html: PAGE('A', 'A three, by me.'), title: 'A', description: 'x', baseSha: shaA2 }],
    });
    expect(lost.status).toBe('conflict');
    expect(files.get('pages/a.html')).toContain('by the other agent');
    expect((await proposals.get(lost.proposal.id))?.status).toBe('conflict');
  });
});
