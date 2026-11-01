import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import {
  InMemoryGitPullRequestStorage,
  nextPullRequestNumber,
} from '../../services/git-pr-storage.js';
import { GitHostClient } from '../../services/git-host-client.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import {
  MAX_PR_BODY_LENGTH,
  validateBranchName,
  validatePullRequestBody,
  validatePullRequestTitle,
} from '../../types/git-pr.js';
import type { GitPullRequestDocument } from '../../types/git-pr.js';
import {
  COMMENT_AUTHOR_USER,
  COMMENT_MAX_LENGTH,
  MAX_COMMENTS,
  newMarginComment,
} from '../../types/comment.js';

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

function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post' | 'patch',
): (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
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

const COMPARE_OK = {
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseExists: true,
  diffStat: { files: 3, insertions: 40, deletions: 5 },
  commits: [{ sha: 'a'.repeat(40), subject: 'Rewrite checkout' }],
  patch: 'diff --git a/x b/x\n',
  patchTruncated: false,
};

async function buildDeps(compareResult: unknown = COMPARE_OK) {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: { 'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
    },
  });
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const repo = await gitRepoStorage.create({
    userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
  });
  const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
  const quickNoteStorage = new InMemoryQuickNoteStorage();
  const gitHostClient = new GitHostClient({
    baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's',
    fetchImpl: (async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(compareResult),
    })) as unknown as typeof fetch,
  });
  const asks: unknown[] = [];
  const deps: Partial<RouteDeps> = {
    userStorage,
    gitRepoStorage,
    gitPullRequestStorage,
    quickNoteStorage,
    gitHostClient,
    gitHostSecret: 'secret',
    requestPullRequestApproval: vi.fn(async (args) => { asks.push(args); return true; }),
  };
  return { deps, token, repo, gitPullRequestStorage, quickNoteStorage, asks };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

async function claimNote(notes: InMemoryQuickNoteStorage, number = 1) {
  const note = await notes.create({
    userId: 'user-1',
    html: `<h2>Request ${number}</h2><p>Implement this once.</p>`,
    createdByAgentId: 'agent-a',
    createdByUserId: 'user-1',
    updatedByAgentId: 'agent-a',
    updatedByUserId: 'user-1',
  });
  await notes.claim(note.id, {
    agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
  }, new Date());
  return note;
}

describe('proposal validation', () => {
  it('accepts idiomatic branch names and rejects git-unsafe ones', () => {
    for (const branch of ['main', 'feat/checkout', 'fix-2.1', 'a_b']) {
      expect(validateBranchName(branch)).toBeNull();
    }
    for (const branch of ['-x', 'a..b', 'ends/', 'x.lock', '', 'has space', '--upload-pack=evil']) {
      expect(validateBranchName(branch)).not.toBeNull();
    }
  });

  it('keeps titles short enough for a Telegram card', () => {
    expect(validatePullRequestTitle('Rewrite checkout')).toBeNull();
    expect(validatePullRequestTitle('hi')).not.toBeNull();
    expect(validatePullRequestTitle('x'.repeat(200))).not.toBeNull();
  });

  it('tells the author a write-up is too long instead of cutting it (note #320)', () => {
    expect(validatePullRequestBody('')).toBeNull();
    expect(validatePullRequestBody('x'.repeat(MAX_PR_BODY_LENGTH))).toBeNull();
    const over = validatePullRequestBody('x'.repeat(MAX_PR_BODY_LENGTH + 1));
    expect(over).not.toBeNull();
    // The author cannot cut what they cannot measure: the message says the
    // limit AND how far over this one is, the way a margin comment does.
    expect(over).toContain(String(MAX_PR_BODY_LENGTH));
    expect(over).toContain(String(MAX_PR_BODY_LENGTH + 1));
  });

  it('leaves room for a real write-up — the old 2000 did not', () => {
    // The bodies that were being cut ran 2000–2600 characters, which is what
    // opened note #320. A guard, so nobody lowers this back under them.
    expect(MAX_PR_BODY_LENGTH).toBeGreaterThanOrEqual(4000);
  });

  it('numbers proposals by max+1, so a withdrawn number is never reused', () => {
    const docs = [{ number: 1 }, { number: 2 }, { number: 3 }] as GitPullRequestDocument[];
    expect(nextPullRequestNumber(docs)).toBe(4);
    // #3 withdrawn and gone from the list: the next is still 4, because "PR #3"
    // is already in the chat history and must stay unambiguous.
    expect(nextPullRequestNumber([docs[0], docs[2]] as GitPullRequestDocument[])).toBe(4);
    expect(nextPullRequestNumber([])).toBe(1);
  });
});

describe('POST /repos/:name/prs', () => {
  it('records the proposal QUIETLY — nothing is asked of the user yet (note #293)', async () => {
    const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), res);

    expect(res.statusCode).toBe(201);
    // Creating used to BE the ask. It is not any more: the agent is very
    // likely still working, and the owner asked never to be shown that.
    expect(asks).toEqual([]);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc).toMatchObject({
      number: 1, status: 'open', draft: true, sourceBranch: 'feat/checkout', targetBranch: 'main',
      headSha: COMPARE_OK.headSha, diffStat: COMPARE_OK.diffStat,
    });
    expect(doc.readyAt).toBeUndefined();
    const body = res.body as { askedUser: boolean; pr: { draft?: boolean }; message: string };
    expect(body.askedUser).toBe(false);
    expect(body.pr.draft).toBe(true);
    // The message names the step that is still owed, and says the user has
    // seen nothing — an agent that reads "recorded" as "sent" ends its turn
    // on a proposal nobody will ever be asked about.
    expect(body.message).toContain('agentbuilt pr ready 1');
    expect(body.message).toContain('not been shown');
  });

  it('records a squash request, and only an explicit true', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout', squash: true },
    }), res);

    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc.squash).toBe(true);
    // `pr list`/`pr show` say so — the agent that squashes should see it took.
    expect((res.body as { pr: { squash?: boolean } }).pr.squash).toBe(true);

    // Anything that is not the literal boolean stays a plain merge.
    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/other', title: 'Another change', squash: 'yes' },
    }), createMockResponse());
    const other = (await gitPullRequestStorage.listByRepo(repo.id))[1];
    expect(other.squash).toBeUndefined();
  });

  it('links a claimed note and refuses an unclaimed or changed snapshot', async () => {
    const { deps, token, quickNoteStorage, gitPullRequestStorage, repo } = await buildDeps();
    const note = await quickNoteStorage.create({
      userId: 'user-1', html: '<p>Implement once</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const request = () => mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/note', title: 'Implement the request', notes: [note.number] },
    });

    const unclaimed = createMockResponse();
    await handler(request(), unclaimed);
    expect(unclaimed.statusCode).toBe(409);
    expect((unclaimed.body as { error: string }).error).toContain(`note start ${note.number}`);

    await quickNoteStorage.claim(note.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date());
    await quickNoteStorage.addComment(note.id, {
      id: 'new-request', authorId: 'user', userId: 'user-1',
      text: 'Please include the new edge case.', createdAt: new Date().toISOString(),
    });
    const changed = createMockResponse();
    await handler(request(), changed);
    expect(changed.statusCode).toBe(409);
    expect((changed.body as { error: string }).error).toContain('changed after you claimed');

    // Starting again is the explicit reread/commit point.
    await quickNoteStorage.claim(note.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date());
    const accepted = createMockResponse();
    await handler(request(), accepted);
    expect(accepted.statusCode).toBe(201);
    expect((await gitPullRequestStorage.listByRepo(repo.id))[0]!.quickNoteNumbers).toEqual([note.number]);
    expect((accepted.body as { pr: { quickNoteNumbers: number[] } }).pr.quickNoteNumbers).toEqual([note.number]);
  });

  it('links the workplace\'s note on a workplace repository, and names no room to any reader (note #566)', async () => {
    const { deps, token, repo, quickNoteStorage, gitPullRequestStorage } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    // No share step: the repository lives at the workplace's address and the
    // agent reaches it because it is the workplace's.
    await deps.gitRepoStorage!.update(repo.id, { orgId: org.orgId });

    const note = await quickNoteStorage.create({
      userId: 'user-1',
      html: '<p>Implement the workplace request once</p>',
      createdByAgentId: 'agent-a',
      updatedByAgentId: 'agent-a',
    });
    await quickNoteStorage.claim(note.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date());

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'workplace/change', title: 'Implement the workplace request', note: note.number },
    }), res);

    expect(res.statusCode).toBe(201);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    expect(doc).toMatchObject({
      userId: 'user-1',
      quickNoteNumbers: [note.number],
      quickNoteNamespaceId: 'user-1',
    });
    expect(await gitPullRequestStorage.listByQuickNoteNamespace('user-1')).toEqual([doc]);

    // A note number names one note in the workplace (note #741), so the
    // list reads the link bare: there is no room to say it belongs to.
    const list = getRouteHandler(deps, '/repos/:name/prs', 'get');
    const listed = createMockResponse();
    await list(mockRequest({ headers: authHeader(token), params: { name: 'api' }, query: {} }), listed);
    const row = (listed.body as { prs: Array<Record<string, unknown>> }).prs[0]!;
    expect(row).toMatchObject({ quickNoteNumbers: [note.number] });
    expect(row).not.toHaveProperty('quickNoteRoom');
  });

  it('links a note still standing at an old room\'s namespace, recording where the note lives (note #741)', async () => {
    const { deps, token, repo, quickNoteStorage, gitPullRequestStorage } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // An old room's namespace, kept on the workplace when rooms went (note #843).
    await orgStorage.updateOrg(org.orgId, {
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-growth'] },
    });
    await deps.userStorage!.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    await deps.gitRepoStorage!.update(repo.id, { orgId: org.orgId });

    // The note stands at the old namespace; Ben is handed it by number alone.
    const note = await quickNoteStorage.create({
      userId: 'ns-growth', html: '<p>Number notes across the workplace</p>',
      createdByAgentId: 'agent-w', updatedByAgentId: 'agent-w',
    }, { series: `org:${org.orgId}`, namespaces: ['user-1', 'ns-growth'] });
    await quickNoteStorage.claim(note.id, { agentId: 'agent-a', userId: 'user-1', agentName: 'Ben' }, new Date());

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/numbers', title: 'Number notes across the workplace', note: note.number },
    }), res);
    expect(res.statusCode).toBe(201);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    // The link is recorded where the NOTE is, so the note finds its proposal.
    expect(doc).toMatchObject({
      quickNoteNumbers: [note.number],
      quickNoteNamespaceId: 'ns-growth',
    });
    expect(await gitPullRequestStorage.listByQuickNoteNamespace('ns-growth')).toEqual([doc]);
    const unknown = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/numbers', title: 'Nothing', note: 99 },
    }), unknown);
    expect(unknown.statusCode).toBe(404);
    expect((unknown.body as { error: string }).error).toBe('No note #99 in this workplace.');
  });

  it('rejects malformed note links and applies the ten-note ceiling to explicit links', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const send = async (body: Record<string, unknown>) => {
      const res = createMockResponse();
      await handler(mockRequest({
        headers: authHeader(token), params: { name: 'api' },
        body: { from: 'feat/note', title: 'Implement requests', ...body },
      }), res);
      return res;
    };

    expect((await send({ notes: 99 })).statusCode).toBe(400);
    const eleven = await send({ notes: Array.from({ length: 11 }, (_, index) => index + 1) });
    expect(eleven.statusCode).toBe(400);
    expect((eleven.body as { error: string }).error).toContain('at most 10 notes');
  });

  it('prose naming a note links nothing — only the explicit flag links, and it fences', async () => {
    // The create path once inferred links from “note #N” in titles, bodies
    // and commit subjects as a bridge for CLIs that could not send the flag.
    // That made every mention a claim: a body whose EXAMPLE said “note #12”
    // was refused over an archived note nobody was working from. The flag is
    // the whole link now, and prose is safe for examples and cross-references.
    const { deps, token, quickNoteStorage, gitPullRequestStorage, repo } = await buildDeps();
    const note = await claimNote(quickNoteStorage);
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const make = (from: string, body: Record<string, unknown> = {}) => mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from, title: `Implement it (note #${note.number})`, ...body },
    });

    // Two proposals whose titles NAME the note: neither links, neither fences.
    const first = createMockResponse();
    await handler(make('feat/first'), first);
    expect(first.statusCode).toBe(201);
    expect((await gitPullRequestStorage.listByRepo(repo.id))[0]!.quickNoteNumbers).toBeUndefined();
    const second = createMockResponse();
    await handler(make('feat/second'), second);
    expect(second.statusCode).toBe(201);

    // The explicit flag links the record…
    const explicit = createMockResponse();
    await handler(make('feat/third', { note: note.number }), explicit);
    expect(explicit.statusCode).toBe(201);
    const linked = (await gitPullRequestStorage.listByRepo(repo.id))
      .find((doc) => doc.quickNoteNumbers?.length)!;
    expect(linked.quickNoteNumbers).toEqual([note.number]);

    // …and only that link fences a second implementation, open or merged.
    const duplicate = createMockResponse();
    await handler(make('feat/fourth', { note: note.number }), duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.body as { error: string }).error).toContain('second implementation');

    await gitPullRequestStorage.update(linked.id, { status: 'merged', mergeCommitSha: 'c'.repeat(40) });
    const afterMerge = createMockResponse();
    await handler(make('feat/fifth', { note: note.number }), afterMerge);
    expect(afterMerge.statusCode).toBe(409);
    expect((afterMerge.body as { error: string }).error).toMatch(/already (implemented|has merged)/i);
  });

  it('refuses a second implementation after the note moved away from its first proposal', async () => {
    const { deps, token, quickNoteStorage, gitPullRequestStorage } = await buildDeps();
    const note = await quickNoteStorage.create({
      userId: 'old-room', html: '<p>Implement once, then move me</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
    });
    await gitPullRequestStorage.create({
      repoId: 'old-repo', userId: 'old-room', title: 'First implementation',
      sourceBranch: 'first', targetBranch: 'main', headSha: 'd'.repeat(40),
      diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['First implementation'],
      quickNoteNumbers: [note.number], createdByAgentId: 'agent-a', status: 'open',
    });
    const moved = (await quickNoteStorage.move(note.id, 'user-1'))!;
    await quickNoteStorage.claim(moved.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date());

    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/duplicate', title: 'Second implementation', notes: [moved.number] },
    }), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('already has open PR #1');
  });

  it('targets the PROTECTED branch, not whatever HEAD happens to point at', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    // The repo's recorded default is a feature branch — which is the normal
    // state before the first approved merge, since `main` cannot exist yet.
    await (deps.gitRepoStorage as InMemoryGitRepoStorage).update(repo.id, { defaultBranch: 'from-leo' });
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), createMockResponse());

    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc.targetBranch).toBe('main');
  });

  it('stores a long write-up whole, and refuses one over the cap without proposing (note #320)', async () => {
    const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');

    // What used to be silently sliced. It lands intact now, to the character.
    const long = `${'why this change matters. '.repeat(240)}The last sentence survives.`;
    expect(long.length).toBeGreaterThan(2000);
    expect(long.length).toBeLessThanOrEqual(MAX_PR_BODY_LENGTH);
    const ok = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout', body: long },
    }), ok);
    expect(ok.statusCode).toBe(201);
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    expect(doc?.body).toBe(long);
    expect(doc?.body).toMatch(/The last sentence survives\.$/);

    // Over the cap: the author is TOLD, and no half-written proposal exists
    // for the user to be asked about.
    const over = createMockResponse();
    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/other', title: 'Another change', body: 'x'.repeat(MAX_PR_BODY_LENGTH + 1) },
    }), over);
    expect(over.statusCode).toBe(400);
    expect((over.body as { error: string }).error).toContain(String(MAX_PR_BODY_LENGTH));
    expect(await gitPullRequestStorage.listByRepo(repo.id)).toHaveLength(1);
    // Recorded, and — since note #293 — still quiet: nothing asked yet.
    expect(asks).toHaveLength(0);
  });

  it('refuses a proposal with nothing in it', async () => {
    const { deps, token } = await buildDeps({ ...COMPARE_OK, commits: [] });
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/empty', title: 'Nothing at all' },
    }), res);

    // Better here than as a user tapping Approve on an empty diff.
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('no commits');
  });

  it('rejects a branch name that could smuggle a git flag', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: '--upload-pack=touch /tmp/x', title: 'Sneaky proposal' },
    }), res);

    expect(res.statusCode).toBe(400);
  });

  it('404s a repo owned by someone else', async () => {
    const { deps, token } = await buildDeps();
    const handler = getRouteHandler(deps, '/repos/:name/prs', 'post');
    const res = createMockResponse();

    await handler(mockRequest({
      headers: authHeader(token), params: { name: 'not-mine' },
      body: { from: 'feat/x', title: 'Should not exist' },
    }), res);

    expect(res.statusCode).toBe(404);
  });
});

/**
 * `pr ready` (Owner, note #293): the invitation, as its own verb. What is
 * pinned here is the contract the note asked for — the ask happens only when
 * the agent says so, and not over a build that is running or red — and the
 * re-pin, because the card must describe the branch as it stands.
 */
describe('POST /repos/:name/prs/:number/ready', () => {
  const quiet = async (deps: Partial<RouteDeps>, token: string) => {
    await getRouteHandler(deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), createMockResponse());
  };
  const ready = (deps: Partial<RouteDeps>, token: string, number = '1') => {
    const res = createMockResponse();
    return getRouteHandler(deps, '/repos/:name/prs/:number/ready', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api', number } }), res,
    ).then(() => res);
  };

  it('shows the proposal and asks the user — once', async () => {
    const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
    await quiet(deps, token);

    const res = await ready(deps, token);
    expect(res.statusCode).toBe(200);
    expect(asks).toEqual([expect.objectContaining({ userId: 'user-1', agentId: 'agent-a', repoName: 'api' })]);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc.draft).toBeUndefined();
    expect(doc.readyAt).toBeTruthy();
    expect((res.body as { message: string }).message).toContain('Do not wait');

    // A retry after a CLI timeout must not fire a second card at the same person.
    const again = await ready(deps, token);
    expect(again.statusCode).toBe(200);
    expect(asks).toHaveLength(1);
    expect((again.body as { message: string }).message).toContain('already with your user');
  });

  /** Note #684: a reviewing agent of the same owner can send the card, and
   *  the proposal remembers who did — that is the chat the decision must
   *  reach besides the author's. */
  it('records which agent sent the card when it is not the proposer', async () => {
    const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
    await quiet(deps, token);
    const reviewer = mintAgentbuiltToken('user-1', 'agent-b');
    const userStorage = deps.userStorage!;
    const profile = await userStorage.getProfile('user-1');
    await userStorage.updateProfile('user-1', {
      telegram: {
        ...profile!.telegram!,
        agents: {
          ...profile!.telegram!.agents,
          'agent-b': { id: 'agent-b', name: 'Juno', cli: 'claude', agentbuiltTokenHash: reviewer.tokenHash } as never,
        },
      },
    });

    const res = await ready(deps, reviewer.token);
    expect(res.statusCode).toBe(200);
    expect(asks).toEqual([expect.objectContaining({ agentId: 'agent-b' })]);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc.createdByAgentId).toBe('agent-a');
    expect(doc.readyByAgentId).toBe('agent-b');
  });

  it('re-pins to the branch as it stands, so the card and the anchor describe what is asked', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    await quiet(deps, token);
    const moved = {
      ...COMPARE_OK,
      headSha: 'e'.repeat(40),
      diffStat: { files: 4, insertions: 50, deletions: 6 },
      commits: [{ sha: 'e'.repeat(40), subject: 'Fix what the screenshot showed' }, ...COMPARE_OK.commits],
    };
    deps.gitHostClient = new GitHostClient({
      baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's',
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(moved) })) as unknown as typeof fetch,
    });

    const res = await ready(deps, token);
    expect(res.statusCode).toBe(200);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    expect(doc).toMatchObject({
      headSha: 'e'.repeat(40), diffStat: moved.diffStat,
      commitSubjects: ['Fix what the screenshot showed', 'Rewrite checkout'],
    });
  });

  it('refuses while the checks on that head are running, and while they are red', async () => {
    const { deps, token, asks } = await buildDeps();
    await quiet(deps, token);
    const statuses: Array<Record<string, unknown>> = [];
    deps.gitCommitStatusStorage = { listBySha: async () => statuses } as never;

    statuses.push({ state: 'pending', startedAt: new Date().toISOString() });
    const running = await ready(deps, token);
    expect(running.statusCode).toBe(409);
    expect((running.body as { error: string }).error).toContain('still running');
    expect((running.body as { error: string }).error).toContain('agentbuilt repo checks --wait');

    statuses.splice(0, 1, { state: 'failure', startedAt: new Date().toISOString() });
    const red = await ready(deps, token);
    expect(red.statusCode).toBe(409);
    expect((red.body as { error: string }).error).toContain('not passing');
    expect(asks).toEqual([]);

    // Green lets it through; so does a sha CI has not spoken about (below).
    statuses.splice(0, 1, { state: 'success', startedAt: new Date().toISOString() });
    expect((await ready(deps, token)).statusCode).toBe(200);
    expect(asks).toHaveLength(1);
  });

  it('is not held by a repo with no checks at all — that is the card it always sent', async () => {
    const { deps, token, asks } = await buildDeps();
    await quiet(deps, token);
    deps.gitCommitStatusStorage = { listBySha: async () => [] } as never;
    expect((await ready(deps, token)).statusCode).toBe(200);
    expect(asks).toHaveLength(1);
  });

  it('refuses a decided proposal, a foreign one, and one that no longer differs from its target', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    await quiet(deps, token);
    expect((await ready(deps, token, '9')).statusCode).toBe(404);

    const { token: stranger } = mintAgentbuiltToken('user-2', 'agent-b');
    const foreign = await ready(deps, stranger);
    expect(foreign.statusCode).not.toBe(200);

    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0];
    await gitPullRequestStorage.update(doc.id, { status: 'withdrawn' });
    const decided = await ready(deps, token);
    expect(decided.statusCode).toBe(409);
    expect((decided.body as { error: string }).error).toContain('withdrawn');

    await gitPullRequestStorage.update(doc.id, { status: 'open' });
    deps.gitHostClient = new GitHostClient({
      baseUrl: 'https://git.example.test', controlUrl: 'http://x', secret: 's',
      fetchImpl: (async () => ({
        ok: true, status: 200, text: async () => JSON.stringify({ ...COMPARE_OK, commits: [] }),
      })) as unknown as typeof fetch,
    });
    const empty = await ready(deps, token);
    expect(empty.statusCode).toBe(409);
    expect((empty.body as { error: string }).error).toContain('no commits');
  });

  /**
   * Note #752 (Adam, 2026-10-14): he gave Ada note #750 himself, her PR
   * became ready, and nothing reached the Chief of Staff chat he reads
   * proposals in. Now `pr ready` lands the card there at once, whoever asked
   * for the work — the same pointer row `agentbuilt forward` writes — and
   * never twice.
   */
  describe('the card in the owner\'s Chief of Staff chat (note #752)', () => {
    const inWorkplace = async (deps: Partial<RouteDeps>, agentId = 'agent-a', orgId = 'org-1') => {
      const userStorage = deps.userStorage!;
      const profile = await userStorage.getProfile('user-1');
      await userStorage.updateProfile('user-1', {
        telegram: { ...profile!.telegram!, agents: { ...profile!.telegram!.agents, [agentId]: { ...profile!.telegram!.agents![agentId]!, orgId } as never } },
      });
    };

    it('puts one card in the owner\'s Chief of Staff chat the moment the proposal is ready — and a retry adds none', async () => {
      const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
      await inWorkplace(deps);
      const proposalReady = vi.fn(async () => 'added' as const);
      deps.workspaceAgent = { proposalReady } as never;
      await quiet(deps, token);

      const res = await ready(deps, token);
      expect(res.statusCode).toBe(200);
      const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
      expect(proposalReady).toHaveBeenCalledTimes(1);
      expect(proposalReady).toHaveBeenCalledWith({
        userId: 'user-1', orgId: 'org-1',
        proposal: { kind: 'pr', id: doc.id },
        text: 'Ben\'s PR #1 in api — Rewrite checkout — is ready for the person\'s decision; its card is in this conversation.',
      });
      expect((res.body as { message: string }).message).toContain('its card is in their Chief of Staff chat too');
      expect(asks).toHaveLength(1);

      // The CLI retry after a timeout: the proposal is already with the
      // person, so neither chat hears again.
      const again = await ready(deps, token);
      expect(again.statusCode).toBe(200);
      expect(proposalReady).toHaveBeenCalledTimes(1);
      expect(asks).toHaveLength(1);
    });

    it('is written to the conversation of the agent\'s owner only, in the agent\'s own workplace', async () => {
      // A teammate's agent readying a proposal in the same workplace writes
      // to the TEAMMATE's conversation: the hook is keyed by the owner, so
      // user-1's Chief of Staff chat never hears of it (asserted in
      // workspace-recap-chat.test.ts where the conversation is real).
      const { deps } = await buildDeps();
      const teammate = mintAgentbuiltToken('user-2', 'agent-z');
      await deps.userStorage!.createProfile('user-2', { email: 'two@example.com', displayName: 'Two' });
      await deps.userStorage!.updateProfile('user-2', {
        telegram: { chatId: '2', linkedAt: 't', notificationsEnabled: true, agents: { 'agent-z': { id: 'agent-z', name: 'Zed', cli: 'claude', orgId: 'org-1', agentbuiltTokenHash: teammate.tokenHash } as never } },
      });
      await deps.gitRepoStorage!.create({ userId: 'user-2', name: 'api', createdByAgentId: 'agent-z', sizeBytes: 0, protectDefaultBranch: true });
      const proposalReady = vi.fn(async () => 'added' as const);
      deps.workspaceAgent = { proposalReady } as never;
      await quiet(deps, teammate.token);
      expect((await ready(deps, teammate.token)).statusCode).toBe(200);
      expect(proposalReady).toHaveBeenCalledTimes(1);
      expect(proposalReady.mock.calls[0]![0]).toMatchObject({ userId: 'user-2', orgId: 'org-1', proposal: { kind: 'pr' } });
    });

    it('a legacy agent in no workplace has no Chief of Staff chat to write to, and a failed write never fails the invitation', async () => {
      const { deps, token, asks } = await buildDeps();
      const proposalReady = vi.fn(async () => 'added' as const);
      deps.workspaceAgent = { proposalReady } as never;
      await quiet(deps, token);
      const legacy = await ready(deps, token);
      expect(legacy.statusCode).toBe(200);
      expect(proposalReady).not.toHaveBeenCalled();
      expect((legacy.body as { message: string }).message).not.toContain('Chief of Staff');

      const failing = await buildDeps();
      await inWorkplace(failing.deps);
      failing.deps.workspaceAgent = { proposalReady: vi.fn(async () => { throw new Error('conversation store down'); }) } as never;
      await quiet(failing.deps, failing.token);
      const res = await ready(failing.deps, failing.token);
      expect(res.statusCode).toBe(200);
      expect((res.body as { message: string }).message).toContain('Do not wait');
      expect((res.body as { message: string }).message).not.toContain('Chief of Staff');
      expect(asks).toHaveLength(1);
    });
  });

  /**
   * Note #944 (Adam, 2026-11-01): auto-merge, each person's own. With the
   * proposal owner's switch on, `pr ready` merges a proposal whose checks passed instead of
   * asking; red or missing checks still wait; off changes nothing; and a
   * merge that fails leaves the ordinary ask, with the reason.
   */
  describe('auto-merge (note #944)', () => {
    const withMode = async (deps: Partial<RouteDeps>, on: boolean | null, opts: { ci?: boolean } = {}) => {
      const orgStorage = new InMemoryOrgStorage();
      const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
      await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
      if (on !== null) {
        // The proposal owner's OWN switch, on their membership.
        await orgStorage.touchMember(org.orgId, 'user-1', {
          autoApprove: { on, changedAt: '2026-11-01T15:02:00.000Z', changedByUserId: 'user-1', changedByName: 'Adam' },
        });
      }
      deps.orgStorage = orgStorage;
      const userStorage = deps.userStorage!;
      const profile = await userStorage.getProfile('user-1');
      await userStorage.updateProfile('user-1', {
        telegram: { ...profile!.telegram!, agents: { ...profile!.telegram!.agents, 'agent-a': { ...profile!.telegram!.agents!['agent-a']!, orgId: org.orgId } as never } },
      });
      if (opts.ci) {
        const repo = (await deps.gitRepoStorage!.listByUser('user-1'))[0]!;
        await deps.gitRepoStorage!.update(repo.id, { ci: true });
      }
      const proposalReady = vi.fn(async () => 'added' as const);
      deps.workspaceAgent = { proposalReady } as never;
      return { org, proposalReady };
    };
    const green = (deps: Partial<RouteDeps>) => {
      deps.gitCommitStatusStorage = { listBySha: async () => [{ state: 'success', startedAt: new Date().toISOString() }] } as never;
    };

    it('on, with green checks: merged at once, nobody asked, and every word says it was automatic', async () => {
      const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
      const { proposalReady } = await withMode(deps, true);
      green(deps);
      const autoApprovePullRequest = vi.fn(async () => ({ status: 'merged' as const, mergeCommitSha: 'c'.repeat(40) }));
      deps.autoApprovePullRequest = autoApprovePullRequest;
      await quiet(deps, token);

      const res = await ready(deps, token);
      expect(res.statusCode).toBe(200);
      const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
      expect(autoApprovePullRequest).toHaveBeenCalledWith({
        pullRequestId: doc.id,
        mode: { onAt: '2026-11-01T15:02:00.000Z', byUserId: 'user-1', byName: 'Adam' },
      });
      // Nothing is asked of a person: no "awaits your decision" card.
      expect(asks).toEqual([]);
      const body = res.body as { askedUser: boolean; autoApproved: boolean; message: string };
      expect(body).toMatchObject({ askedUser: false, autoApproved: true });
      expect(body.message).toContain('approved AUTOMATICALLY');
      expect(body.message).toContain('Auto-merge is on for your user (turned on by Adam at 1 Nov 2026, 15:02 UTC)');
      expect(body.message).toContain('never that your user approved it');
      // The Chief of Staff's card says the same, so nobody takes it for a
      // human decision.
      expect(proposalReady).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Ben\'s PR #1 in api — Rewrite checkout — was approved automatically and merged into main (auto-merge on, turned on by Adam at 1 Nov 2026, 15:02 UTC); no person read it first. Its card is in this conversation.',
      }));
    });

    it('a teammate\'s switch never merges your agents\' work — each person\'s is their own', async () => {
      const { deps, token, asks } = await buildDeps();
      const { org } = await withMode(deps, null);
      green(deps);
      await deps.orgStorage!.addMember({ orgId: org.orgId, userId: 'user-2', role: 'admin' });
      await deps.orgStorage!.touchMember(org.orgId, 'user-2', {
        autoApprove: { on: true, changedAt: '2026-11-01T15:02:00.000Z', changedByUserId: 'user-2', changedByName: 'Teammate' },
      });
      const autoApprovePullRequest = vi.fn();
      deps.autoApprovePullRequest = autoApprovePullRequest as never;
      await quiet(deps, token);

      expect((await ready(deps, token)).statusCode).toBe(200);
      expect(autoApprovePullRequest).not.toHaveBeenCalled();
      expect(asks).toHaveLength(1);
    });

    it('on, with red or running checks: refused exactly as before — nothing merges', async () => {
      const { deps, token, asks } = await buildDeps();
      await withMode(deps, true);
      const autoApprovePullRequest = vi.fn();
      deps.autoApprovePullRequest = autoApprovePullRequest as never;
      const statuses: Array<Record<string, unknown>> = [{ state: 'failure', startedAt: new Date().toISOString() }];
      deps.gitCommitStatusStorage = { listBySha: async () => statuses } as never;
      await quiet(deps, token);

      expect((await ready(deps, token)).statusCode).toBe(409);
      statuses.splice(0, 1, { state: 'pending', startedAt: new Date().toISOString() });
      expect((await ready(deps, token)).statusCode).toBe(409);
      expect(autoApprovePullRequest).not.toHaveBeenCalled();
      expect(asks).toEqual([]);
    });

    it('on, with no verdict on a repo whose CI is on: waits for its owner, and says why', async () => {
      const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
      const { proposalReady } = await withMode(deps, true, { ci: true });
      deps.gitCommitStatusStorage = { listBySha: async () => [] } as never;
      const autoApprovePullRequest = vi.fn();
      deps.autoApprovePullRequest = autoApprovePullRequest as never;
      await quiet(deps, token);

      const res = await ready(deps, token);
      expect(res.statusCode).toBe(200);
      expect(autoApprovePullRequest).not.toHaveBeenCalled();
      expect(asks).toHaveLength(1);
      const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
      expect(doc.status).toBe('open');
      expect(doc.autoApproveFallback).toMatchObject({ reason: 'no checks have reported on it yet' });
      expect((res.body as { message: string }).message).toContain('NOT merged automatically: no checks have reported on it yet');
      expect(proposalReady).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('was not merged automatically because no checks have reported on it yet'),
      }));
    });

    it('on, on a repo with CI off: merges with no verdict, as an owner\'s Approve would', async () => {
      const { deps, token, asks } = await buildDeps();
      await withMode(deps, true);
      deps.gitCommitStatusStorage = { listBySha: async () => [] } as never;
      const autoApprovePullRequest = vi.fn(async () => ({ status: 'merged' as const, mergeCommitSha: 'c'.repeat(40) }));
      deps.autoApprovePullRequest = autoApprovePullRequest;
      await quiet(deps, token);

      expect((await ready(deps, token)).statusCode).toBe(200);
      expect(autoApprovePullRequest).toHaveBeenCalledTimes(1);
      expect(asks).toEqual([]);
    });

    it('off, or never set: today\'s behaviour exactly — the ask, and no automatic anything', async () => {
      for (const on of [false, null]) {
        const { deps, token, asks, gitPullRequestStorage, repo } = await buildDeps();
        await withMode(deps, on);
        green(deps);
        const autoApprovePullRequest = vi.fn();
        deps.autoApprovePullRequest = autoApprovePullRequest as never;
        await quiet(deps, token);

        const res = await ready(deps, token);
        expect(res.statusCode).toBe(200);
        expect(autoApprovePullRequest).not.toHaveBeenCalled();
        expect(asks).toHaveLength(1);
        expect((res.body as { message: string }).message).not.toContain('uto-merge');
        expect((await gitPullRequestStorage.listByRepo(repo.id))[0]!.autoApproveFallback).toBeUndefined();
      }
    });

    it('on, when the merge fails: falls back to the ordinary ask with the reason, so nothing is stuck', async () => {
      const { deps, token, asks } = await buildDeps();
      const { proposalReady } = await withMode(deps, true);
      green(deps);
      deps.autoApprovePullRequest = vi.fn(async () => ({ status: 'fallback' as const, reason: 'feat/checkout conflicts with main' }));
      await quiet(deps, token);

      const res = await ready(deps, token);
      expect(res.statusCode).toBe(200);
      expect(asks).toHaveLength(1);
      const body = res.body as { askedUser: boolean; autoApproveFallback: string; message: string };
      expect(body.askedUser).toBe(true);
      expect(body.autoApproveFallback).toBe('feat/checkout conflicts with main');
      expect(body.message).toContain('NOT merged automatically: feat/checkout conflicts with main');
      expect(body.message).toContain('is with your user now');
      expect(proposalReady).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('is ready for the person\'s decision: auto-merge is on, but it was not merged automatically because feat/checkout conflicts with main'),
      }));

      // A merge that throws is a fallback too, never a failed invitation.
      const thrown = await buildDeps();
      await withMode(thrown.deps, true);
      green(thrown.deps);
      thrown.deps.autoApprovePullRequest = vi.fn(async () => { throw new Error('host down'); });
      await quiet(thrown.deps, thrown.token);
      const answered = await ready(thrown.deps, thrown.token);
      expect(answered.statusCode).toBe(200);
      expect(thrown.asks).toHaveLength(1);
      expect((answered.body as { message: string }).message).toContain('the merge failed (host down)');
    });
  });

  it('lists a quiet proposal as such, so the agent can see what it still owes', async () => {
    const { deps, token } = await buildDeps();
    await quiet(deps, token);
    const res = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'get')(
      mockRequest({ headers: authHeader(token), params: { name: 'api' } }), res,
    );
    expect((res.body as { prs: Array<{ number: number; status: string; draft?: boolean }> }).prs)
      .toEqual([expect.objectContaining({ number: 1, status: 'open', draft: true })]);
  });
});

describe('the agent-facing surface', () => {
  it('has no approve route at all — not restricted, absent', () => {
    const router = agentCliRoutes({} as RouteDeps) as unknown as {
      stack: Array<{ route?: { path: string } }>;
    };
    const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean) as string[];
    // The whole security story of phase 2: an agent cannot approve its own
    // work even if it is compromised, because the verb does not exist here.
    expect(paths.some((path) => /approve|merge/i.test(path))).toBe(false);
    expect(paths).toContain('/repos/:name/prs');
  });
});

describe('withdrawing', () => {
  it('lets an agent withdraw its own open proposal, once', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    const create = getRouteHandler(deps, '/repos/:name/prs', 'post');
    await create(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), createMockResponse());

    const close = getRouteHandler(deps, '/repos/:name/prs/:number/close', 'post');
    const first = createMockResponse();
    await close(mockRequest({ headers: authHeader(token), params: { name: 'api', number: '1' } }), first);
    expect(first.statusCode).toBe(200);
    expect((await gitPullRequestStorage.getByNumber(repo.id, 1))?.status).toBe('withdrawn');

    const second = createMockResponse();
    await close(mockRequest({ headers: authHeader(token), params: { name: 'api', number: '1' } }), second);
    expect(second.statusCode).toBe(409);
  });

  it('does not let a teammate mutate a proposal merely because the repo is shared', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    const create = getRouteHandler(deps, '/repos/:name/prs', 'post');
    await create(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), createMockResponse());
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    await gitPullRequestStorage.update(doc.id, { createdByUserId: 'another-member' });

    const close = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs/:number/close', 'post')(
      mockRequest({ headers: authHeader(token), params: { name: 'api', number: '1' } }),
      close,
    );
    expect(close.statusCode).toBe(403);

    const edit = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs/:number', 'patch')(
      mockRequest({
        headers: authHeader(token), params: { name: 'api', number: '1' },
        body: { title: 'Someone else rewrote this' },
      }),
      edit,
    );
    expect(edit.statusCode).toBe(403);
    expect((await gitPullRequestStorage.get(doc.id))?.status).toBe('open');
    expect((await gitPullRequestStorage.get(doc.id))?.title).toBe('Rewrite checkout');
  });
});

/**
 * Words only, while the question is still being asked: an edit fixes the
 * wording without a second card, and a decided proposal keeps the wording
 * that was decided on (Owner, note #52).
 */
describe('rewording', () => {
  const setup = async () => {
    const built = await buildDeps();
    const create = getRouteHandler(built.deps, '/repos/:name/prs', 'post');
    await create(mockRequest({
      headers: authHeader(built.token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout', body: 'The old write-up' },
    }), createMockResponse());
    const edit = getRouteHandler(built.deps, '/repos/:name/prs/:number', 'patch');
    return { ...built, edit };
  };

  it('rewords an open proposal without asking the user again', async () => {
    const { edit, token, gitPullRequestStorage, repo, asks } = await setup();
    const response = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { title: 'Rewrite checkout flow', body: 'The corrected write-up' },
    }), response);
    expect(response.statusCode).toBe(200);
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    expect(doc?.title).toBe('Rewrite checkout flow');
    expect(doc?.body).toBe('The corrected write-up');
    // The whole point: the record moved, and no second card went out.
    // (Creating is quiet since note #293, so the count to hold is zero.)
    expect(asks).toHaveLength(0);
    // Nothing the decision anchors to moved either.
    expect(doc?.headSha).toBe('a'.repeat(40));
    expect(doc?.sourceBranch).toBe('feat/checkout');
  });

  it('edits one field and leaves the other alone', async () => {
    const { edit, token, gitPullRequestStorage, repo } = await setup();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { title: 'Rewrite checkout, carefully' },
    }), createMockResponse());
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    expect(doc?.title).toBe('Rewrite checkout, carefully');
    expect(doc?.body).toBe('The old write-up');
  });

  it('an empty body clears the write-up', async () => {
    const { edit, token, gitPullRequestStorage, repo } = await setup();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { body: '' },
    }), createMockResponse());
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    expect(doc?.body).toBeUndefined();
    expect(doc?.title).toBe('Rewrite checkout');
  });

  it('refuses an edit with nothing in it, and a title that fails validation', async () => {
    const { edit, token } = await setup();
    const empty = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' }, body: {},
    }), empty);
    expect(empty.statusCode).toBe(400);

    const short = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' }, body: { title: 'x' },
    }), short);
    expect(short.statusCode).toBe(400);
  });

  it('refuses a reword over the cap and leaves the old words standing (note #320)', async () => {
    const { edit, token, gitPullRequestStorage, repo } = await setup();
    const response = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { body: 'x'.repeat(MAX_PR_BODY_LENGTH + 1) },
    }), response);
    expect(response.statusCode).toBe(400);
    expect((response.body as { error: string }).error).toContain(String(MAX_PR_BODY_LENGTH));
    // A reword that half-lands is worse than one that does not: the proposal
    // still says what its author last chose to say.
    expect((await gitPullRequestStorage.getByNumber(repo.id, 1))?.body).toBe('The old write-up');
  });

  it('refuses once decided — the wording is part of what was approved', async () => {
    const { edit, token, gitPullRequestStorage, repo } = await setup();
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    await gitPullRequestStorage.update(doc!.id, { status: 'merged' });
    const response = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { title: 'A different history' },
    }), response);
    expect(response.statusCode).toBe(409);
    expect((await gitPullRequestStorage.getByNumber(repo.id, 1))?.title).toBe('Rewrite checkout');
  });
});

describe('listing', () => {
  it('shows open proposals by default and everything with ?all=true', async () => {
    const { deps, token, gitPullRequestStorage, repo } = await buildDeps();
    const create = getRouteHandler(deps, '/repos/:name/prs', 'post');
    await create(mockRequest({
      headers: authHeader(token), params: { name: 'api' }, body: { from: 'a', title: 'First one' },
    }), createMockResponse());
    await create(mockRequest({
      headers: authHeader(token), params: { name: 'api' }, body: { from: 'b', title: 'Second one' },
    }), createMockResponse());
    const second = await gitPullRequestStorage.getByNumber(repo.id, 2);
    await gitPullRequestStorage.update(second!.id, { status: 'merged' });

    const list = getRouteHandler(deps, '/repos/:name/prs', 'get');
    const open = createMockResponse();
    await list(mockRequest({ headers: authHeader(token), params: { name: 'api' } }), open);
    expect((open.body as { prs: unknown[] }).prs).toHaveLength(1);

    const all = createMockResponse();
    await list(mockRequest({ headers: authHeader(token), params: { name: 'api' }, query: { all: 'true' } }), all);
    expect((all.body as { prs: unknown[] }).prs).toHaveLength(2);
  });
});

/**
 * The gate, from the tap onwards: only these paths merge, and each one hands
 * the outcome back to the agent that proposed it.
 */
describe('the pull-request approval flows', () => {
  const buildGate = async (mergeResult: unknown, opts: { squash?: boolean; disconnected?: boolean; reviewer?: boolean } = {}) => {
    const { InMemoryUserStorage } = await import('../../services/user-storage.js');
    const { InMemorySessionStorage } = await import('../../services/session-storage.js');
    const { AgentEventEmitter } = await import('../../agent/agent-event-emitter.js');
    const { AgentService } = await import('../../services/agent-service.js');
    const { InMemoryAgentChatStorage } = await import('../../services/agent-chat-storage.js');

    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', { email: 'u@e.com', displayName: 'U' });
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '555', linkedAt: 't', notificationsEnabled: true,
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Main', cli: 'claude', serverId: 'fly_x',
            ...(opts.disconnected ? {} : { connectedAt: 't' }),
          } as never,
          // A second agent of the same owner, which may send the card for
          // agent-a's proposal (note #684).
          ...(opts.reviewer
            ? { 'agent-b': { id: 'agent-b', name: 'Juno', cli: 'claude', serverId: 'fly_y', connectedAt: 't' } as never }
            : {}),
        },
      },
    });
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const repo = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true,
    });
    const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    const pr = await gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'Rewrite checkout',
      sourceBranch: 'feat/checkout', targetBranch: 'main',
      headSha: 'a'.repeat(40), diffStat: { files: 1, insertions: 2, deletions: 0 },
      commitSubjects: ['Rewrite checkout'], createdByAgentId: 'agent-a', status: 'open',
      ...(opts.squash ? { squash: true } : {}),
    });
    const merge = vi.fn(async () => mergeResult);
    const compare = vi.fn();
    // Verdicts for the pinned sha; tests push into it before tapping.
    const statuses: Array<{ state: string; startedAt: string }> = [];
    const listBySha = vi.fn(async () => statuses);
    const started: unknown[] = [];
    const agentChatStorage = new InMemoryAgentChatStorage();
    const workspaceNotifications: Array<Record<string, unknown>> = [];
    const backgroundRunner = {
      // Real runner semantics: not running until the decision starts the
      // agent's wake-up turn — the live-status updater's first tick relies
      // on seeing that turn as running.
      // Per run key, so a second agent woken by the same decision (note
      // #684) is started rather than queued into the first one's turn.
      isRunning: vi.fn((runKey: string) => started.some((args) => (
        (args as [unknown, unknown, unknown, unknown, unknown, { runKey?: string }])[5]?.runKey === runKey
      ))),
      startAgent: vi.fn((...args: unknown[]) => { started.push(args); return { status: 'started' }; }),
      queueMessage: vi.fn(() => ({ status: 'queued', queuePosition: 1 })),
      subscribe: vi.fn(),
    };
    const service = new AgentService({
      sessionStorage: new InMemorySessionStorage(),
      secretStorage: {} as never,
      userStorage,
      sessionManager: {
        getSandboxClient: () => ({}),
      } as never,
      eventEmitter: new AgentEventEmitter(),
      backgroundRunner: backgroundRunner as never,
      reminderScheduler: {} as never,
      userSandboxManager: { ensureDefaultSandboxForUser: vi.fn() } as never,
      managedServerService: { buildRuntimeContext: vi.fn() } as never,
      gitPullRequestStorage,
      gitRepoStorage,
      gitHostClient: { merge, compare } as never,
      gitCommitStatusStorage: { listBySha } as never,
      aiModel: 'openai/gpt-5.4-mini',
      agentChatStorage,
      notifyWorkspace: vi.fn(async (input: Record<string, unknown>) => {
        workspaceNotifications.push(input);
      }),
    } as never);
    return {
      service, pr, gitPullRequestStorage, gitRepoStorage, repo, merge, compare, statuses, started,
      backgroundRunner, agentChatStorage, workspaceNotifications,
    };
  };

  /**
   * A decision, in the shape the card's button data used to carry it:
   * `pr:ok:<id>[:<sha>]` / `pr:no:<id>`. The Telegram card is gone (note #313)
   * and the Workspace decision screen is the only door left, so this drives
   * `decidePullRequestFromMiniApp` — which builds that very string and runs
   * the SAME `handleTelegramPullRequestCallback` flow. The gating rules under
   * test are therefore unchanged; what moves is only where the refusal is
   * read. The card posted it as a chat message; the screen returns it as the
   * toast `note`.
   */
  const tap = async (service: unknown, data: string): Promise<string> => {
    const [kind, verdict, id, sha] = data.split(':');
    if (kind !== 'pr') throw new Error(`unsupported decision data: ${data}`);
    const { note } = await (service as {
      decidePullRequestFromMiniApp(args: {
        userId: string; pullRequestId: string; decision: 'approve' | 'reject'; shownHeadSha?: string;
      }): Promise<{ status: string | null; note: string | null }>;
    }).decidePullRequestFromMiniApp({
      userId: 'user-1',
      pullRequestId: id,
      decision: verdict === 'ok' ? 'approve' : 'reject',
      ...(sha ? { shownHeadSha: sha } : {}),
    });
    return note ?? '';
  };

  it('records the proposal request on the browser-native approval surfaces', async () => {
    const { service, pr, agentChatStorage, workspaceNotifications } = await buildGate({ status: 'merged' });

    expect(await service.requestPullRequestApproval({
      userId: 'user-1', agentId: 'agent-a', repoName: 'api', pullRequestId: pr.id,
    })).toBe(true);

    expect(workspaceNotifications).toContainEqual(expect.objectContaining({
      userId: 'user-1',
      kind: 'approval_required',
      url: `/decisions/pr/${pr.id}`,
      dedupeKey: `pr:${pr.id}`,
    }));
    await expect(agentChatStorage.getAfter('user-1', 'agent-a', 0)).resolves.toEqual([
      expect.objectContaining({ role: 'platform', open: { pr: pr.id } }),
    ]);
  });

  it('gives adjacent completed replies distinct durable browser notifications', async () => {
    const { service, agentChatStorage, workspaceNotifications } = await buildGate({ status: 'merged' });
    const sendCompletion = (service as unknown as {
      sendWorkspaceCompletionNotification(userId: string, agentId: string): Promise<void>;
    }).sendWorkspaceCompletionNotification.bind(service);

    await agentChatStorage.append('user-1', 'agent-a', {
      role: 'agent', text: 'First answer', at: '2026-08-30T10:00:00.000Z',
    });
    await sendCompletion('user-1', 'agent-a');
    await agentChatStorage.append('user-1', 'agent-a', {
      role: 'agent', text: 'Second answer', at: '2026-08-30T10:00:01.000Z',
    });
    await sendCompletion('user-1', 'agent-a');

    const completions = workspaceNotifications.filter((entry) => entry.kind === 'agent_completed');
    expect(completions).toEqual([
      expect.objectContaining({ url: '/chat/agent-a', dedupeKey: 'agent-reply:agent-a:1' }),
      expect.objectContaining({ url: '/chat/agent-a', dedupeKey: 'agent-reply:agent-a:2' }),
    ]);
  });

  /**
   * The in-house chat's copy of the ask (note #146): the request lands as a
   * platform row on the agent's chat record — plain text, no HTML tags, and
   * the proposal's id as the door the screen renders as its Review button.
   */
  it('puts the ask on the agent\'s chat record, with the door to the proposal screen', async () => {
    const { service, pr, statuses, agentChatStorage } = await buildGate({ status: 'merged' });
    statuses.push({ state: 'success', startedAt: '2026-08-30T08:00:00Z' });

    expect(await service.requestPullRequestApproval({
      userId: 'user-1', agentId: 'agent-a', repoName: 'api', pullRequestId: pr.id,
    })).toBe(true);

    const rows = await agentChatStorage.getAfter('user-1', 'agent-a', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'platform', open: { pr: pr.id } });
    expect(rows[0]!.text).toBe(
      `PR #${pr.number} ("Rewrite checkout") in api awaits your decision: feat/checkout → main. `
      + '1 file, +2 −0 · checks passed. Nothing lands on your protected branch until you approve.',
    );
    expect(rows[0]!.text).not.toContain('<b>');
  });

  it('merges on approve, and hands the outcome back to the proposing agent', async () => {
    const { service, pr, gitPullRequestStorage, merge, started } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });

    await tap(service, `pr:ok:${pr.id}`);

    // The approval is anchored to the sha the user was shown.
    expect(merge).toHaveBeenCalledWith('user-1', 'api', expect.objectContaining({
      base: 'main', head: 'feat/checkout', expectedHead: 'a'.repeat(40),
    }));
    const landed = await gitPullRequestStorage.get(pr.id);
    expect(landed?.status).toBe('merged');
    // Captured before the ref moves, so a fast-forward's second run under the
    // same sha can be separated from the source-branch verdict it replaces.
    expect(landed?.deliveryStartedAt).toBeTruthy();
    expect(landed?.decidedAt && landed.deliveryStartedAt! <= landed.decidedAt).toBe(true);
    // …and the agent is woken with the outcome, not left waiting. (The
    // "merged into main" sentence is written by the route's
    // notifyAgentOfPullRequestDecision, not by the decision itself, whose
    // receipt is the screen the tap happened on.)
    expect(started).toHaveLength(1);
    expect(JSON.stringify(started[0])).toContain('APPROVED');
  });

  /**
   * Note #181: the outcome row is a DOOR, like the ask that preceded it. The
   * ask card taught the reader that a proposal card opens the proposal; the
   * card that says it landed then went dead under the same thumb, on the one
   * screen that holds what landed and whether it has reached production. The
   * id travels the same way it does on the ask — handed over, never parsed
   * back out of the sentence.
   */
  it('puts the decision on the chat as a door to the same proposal', async () => {
    const approved = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    await tap(approved.service, `pr:ok:${approved.pr.id}`);
    const merged = (await approved.agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1);
    expect(merged).toMatchObject({ role: 'platform', open: { pr: approved.pr.id } });
    expect(merged!.text).toContain('is merged into main');

    // A refusal is a door too: the screen is where the reason and the diff
    // they turned down both are.
    const refused = await buildGate({ status: 'merged' });
    await tap(refused.service, `pr:no:${refused.pr.id}`);
    const rejected = (await refused.agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1);
    expect(rejected).toMatchObject({ role: 'platform', open: { pr: refused.pr.id } });
    expect(rejected!.text).toContain('REJECTED');
  });

  it('a squash proposal asks the host to squash — same anchor, same gate', async () => {
    const { service, pr, merge } = await buildGate(
      { status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40) },
      { squash: true },
    );

    await tap(service, `pr:ok:${pr.id}`);

    expect(merge).toHaveBeenCalledWith('user-1', 'api', expect.objectContaining({
      expectedHead: 'a'.repeat(40), squash: true,
    }));
  });

  it('records a rejection, merges nothing, and tells the agent why', async () => {
    const { service, pr, gitPullRequestStorage, merge, started } = await buildGate({ status: 'merged' });

    await tap(service, `pr:no:${pr.id}`);

    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('rejected');
    expect(JSON.stringify(started[0])).toContain('REJECTED');
  });

  it('a rejection reason is recorded and reaches the agent verbatim', async () => {
    const { service, pr, gitPullRequestStorage, started } = await buildGate({ status: 'merged' });

    await (service as unknown as {
      decidePullRequestFromMiniApp(args: unknown): Promise<unknown>;
    }).decidePullRequestFromMiniApp({
      userId: 'user-1', pullRequestId: pr.id, decision: 'reject',
      note: 'The retry loop swallows the original error — surface it first.',
    });

    const after = await gitPullRequestStorage.get(pr.id);
    expect(after?.status).toBe('rejected');
    // `pr show` prints this, the decided screen shows it, and the wake-up
    // turn carries it — one reason, three surfaces, no drift.
    expect(after?.decisionNote).toBe('The retry loop swallows the original error — surface it first.');
    expect(JSON.stringify(started[0])).toContain('surface it first');
    expect(JSON.stringify(started[0])).toContain('address exactly that');
  });

  const movedComparison = {
    headSha: 'b'.repeat(40),
    baseSha: 'd'.repeat(40),
    baseExists: true,
    diffStat: { files: 2, insertions: 5, deletions: 1 },
    commits: [{ sha: 'b'.repeat(40), subject: 'More checkout work' }],
    patch: '',
    patchTruncated: false,
  };

  it('a merge that finds the branch moved refreshes the proposal and asks again', async () => {
    // The host's own anchor check caught a push that raced the tap.
    const { service, pr, gitPullRequestStorage, compare, started, workspaceNotifications } = await buildGate({
      status: 'stale', headSha: 'b'.repeat(40),
    });
    compare.mockResolvedValue(movedComparison);

    const told = await tap(service, `pr:ok:${pr.id}`);

    const after = await gitPullRequestStorage.get(pr.id);
    // Still a question, not a dead end — and the pin now names the branch's
    // real state, so the re-ask card describes what a fresh tap would merge.
    expect(after?.status).toBe('open');
    expect(after?.headSha).toBe('b'.repeat(40));
    expect(after?.refreshedAt).toBeTruthy();
    expect(told).toContain('changed as you approved it');
    expect(workspaceNotifications).toContainEqual(expect.objectContaining({
      kind: 'approval_required', url: `/decisions/pr/${pr.id}`,
    }));
    // The agent did nothing wrong and is told nothing.
    expect(started).toHaveLength(0);
  });

  it('a tap naming an older sha than the pin merges nothing and re-asks', async () => {
    const { service, pr, gitPullRequestStorage, compare, merge } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    compare.mockResolvedValue(movedComparison);
    // A push refreshed the pin after the card was printed with sha a…
    await gitPullRequestStorage.update(pr.id, {
      headSha: 'b'.repeat(40), refreshedAt: new Date().toISOString(),
    });

    await tap(service, `pr:ok:${pr.id}:${'a'.repeat(12)}`);

    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
  });

  it('a pre-refresh tap (no sha) is honoured only while the pin never moved', async () => {
    const { service, pr, gitPullRequestStorage, compare, merge } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    compare.mockResolvedValue(movedComparison);
    await gitPullRequestStorage.update(pr.id, {
      headSha: 'b'.repeat(40), refreshedAt: new Date().toISOString(),
    });

    // An old card carries no sha; the pin has moved since it was printed, so
    // acting on it would merge commits that card never showed.
    await tap(service, `pr:ok:${pr.id}`);

    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
  });

  it('required checks hold an approval at the door — and let a green sha through', async () => {
    const { service, pr, gitRepoStorage, gitPullRequestStorage, repo, merge, statuses } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    await gitRepoStorage.update(repo.id, { requireChecks: true });
    const now = new Date().toISOString();

    // No checks at all: the unjudged sha is exactly what the flag holds.
    expect(await tap(service, `pr:ok:${pr.id}`)).toContain('no checks have run');
    expect(merge).not.toHaveBeenCalled();

    // Still running: same answer, different words.
    statuses.push({ state: 'pending', startedAt: now });
    expect(await tap(service, `pr:ok:${pr.id}`)).toContain('still running');
    expect(merge).not.toHaveBeenCalled();

    // Failing: held, and the proposal stays open for a fix-up push.
    statuses.length = 0;
    statuses.push({ state: 'failure', startedAt: now });
    await tap(service, `pr:ok:${pr.id}`);
    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');

    // Success plus skipped is green — a path filter's "nothing to do" is an
    // answer, not a gap — and the approval goes through.
    statuses.length = 0;
    statuses.push({ state: 'success', startedAt: now }, { state: 'skipped', startedAt: now });
    await tap(service, `pr:ok:${pr.id}`);
    expect(merge).toHaveBeenCalledTimes(1);
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
  });

  it('a superseded check holds the merge, but is not called a failure', async () => {
    // Superseded means no build of this sha ever ran, so the gate must hold —
    // it is the unjudged-sha case, not the broken-build case. Reusing
    // `skipped` here would have counted it as passing and merged unbuilt code.
    const { service, pr, gitRepoStorage, gitPullRequestStorage, repo, merge, statuses } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    await gitRepoStorage.update(repo.id, { requireChecks: true });
    statuses.push({ state: 'superseded', startedAt: new Date().toISOString() });

    const told = await tap(service, `pr:ok:${pr.id}`);

    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
    // The wording is the point: "checks are failing" would send the owner
    // hunting a bug that does not exist.
    expect(told).toContain('superseded');
    expect(told).not.toContain('checks are failing');
  });

  it('without the opt-in, failing checks still leave the decision to the human', async () => {
    const { service, pr, gitPullRequestStorage, merge, statuses } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    statuses.push({ state: 'failure', startedAt: new Date().toISOString() });

    await tap(service, `pr:ok:${pr.id}`);

    // "Approve anyway" is a real button: checks inform, they do not vote.
    expect(merge).toHaveBeenCalledTimes(1);
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
  });

  it('a tap naming the pinned sha merges, anchored to the full pin', async () => {
    const { service, pr, gitPullRequestStorage, merge } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });

    const told = await tap(service, `pr:ok:${pr.id}:${'a'.repeat(12)}`);

    expect(merge).toHaveBeenCalledWith('user-1', 'api', expect.objectContaining({
      expectedHead: 'a'.repeat(40),
    }));
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
  });

  it('leaves a conflicted proposal untouched and asks the agent to rebase', async () => {
    const { service, pr, gitPullRequestStorage, started } = await buildGate({ status: 'conflict' });

    const told = await tap(service, `pr:ok:${pr.id}`);

    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('conflict');
    // GAP, pre-existing and not introduced here: the conflict is explained
    // by `sendMessage`, which `decidePullRequestFromMiniApp` stubs out — so a
    // reader who approves from the Workspace gets an EMPTY toast and only the
    // status change to go on, where the card spelled out "can't merge cleanly
    // — ask your agent to update its branch". Pinned rather than dropped: if
    // that sentence is ever routed to the toast, this line fails and says so.
    expect(told).toBe('');
    expect(JSON.stringify(started[0])).toContain('Rebase');
  });

  it('a quiet proposal cannot be decided from anywhere its id leaked to (note #293)', async () => {
    const { service, pr, gitPullRequestStorage, merge, started } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });
    await gitPullRequestStorage.update(pr.id, { draft: true });

    const told = await tap(service, `pr:ok:${pr.id}:${'a'.repeat(12)}`);
    expect(told).toContain('not ready yet');
    expect(merge).not.toHaveBeenCalled();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
    // …and a rejection is refused the same way: no decision of either kind,
    // and no wake-up turn for the agent, which is still on it.
    expect(await tap(service, `pr:no:${pr.id}`)).toContain('not ready yet');
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
    expect(started).toHaveLength(0);
  });

  it('answers a second tap on an already-decided proposal instead of merging twice', async () => {
    const { service, pr, gitPullRequestStorage, merge } = await buildGate({
      status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
    });

    await tap(service, `pr:ok:${pr.id}`);
    await tap(service, `pr:ok:${pr.id}`);

    // The render can go stale in a chat; the handler must not act twice.
    expect(merge).toHaveBeenCalledTimes(1);
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
  });

  /**
   * The Mini App's decision buttons. What carries weight here: this path IS the
   * card-tap flow (same anchor, same hand-back, same chat message), and its
   * return value is the re-read status, never an inference.
   */
  /**
   * Note #944: auto-merge's merge. Same anchor and the same required-
   * checks gate as a person's Approve; recorded as automatic, never in the
   * owner's name; and anything that stops it leaves the proposal open.
   */
  describe('auto-merge\'s merge (note #944)', () => {
    const mode = { onAt: '2026-11-01T15:02:00.000Z', byUserId: 'user-1', byName: 'Adam' };
    const auto = (service: unknown, pullRequestId: string) => (service as {
      autoApprovePullRequest(args: { pullRequestId: string; mode: typeof mode }): Promise<{ status: string; reason?: string }>;
    }).autoApprovePullRequest({ pullRequestId, mode });

    it('merges through the owner\'s anchor and records it as automatic — no person named', async () => {
      const { service, pr, gitPullRequestStorage, gitRepoStorage, repo, merge, started, agentChatStorage } = await buildGate({
        status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
      });

      expect(await auto(service, pr.id)).toEqual({ status: 'merged', mergeCommitSha: 'c'.repeat(40) });

      expect(merge).toHaveBeenCalledWith('user-1', 'api', expect.objectContaining({
        base: 'main', head: 'feat/checkout', expectedHead: 'a'.repeat(40),
        message: expect.stringContaining('approved automatically (auto-merge, turned on by Adam at 1 Nov 2026, 15:02 UTC)'),
      }));
      const landed = (await gitPullRequestStorage.get(pr.id))!;
      expect(landed.status).toBe('merged');
      expect(landed.decidedBy).toBeUndefined();
      expect(landed.autoApproved).toMatchObject({ modeOnAt: mode.onAt, modeOnByUserId: 'user-1', modeOnByName: 'Adam' });
      expect(landed.deliveryStartedAt).toBeTruthy();
      expect((await gitRepoStorage.get(repo.id))!.defaultBranchTipSha).toBe('c'.repeat(40));

      // The agent is woken with an outcome that says it was automatic, and
      // its chat's card is that row — no "awaits your decision" ask.
      expect(started).toHaveLength(1);
      const wake = JSON.stringify(started[0]);
      expect(wake).toContain('was APPROVED AUTOMATICALLY');
      expect(wake).toContain('never that your user approved it');
      const rows = await agentChatStorage.getAfter('user-1', 'agent-a', 0);
      expect(rows.some((row) => row.text.includes('awaits your decision'))).toBe(false);
      expect(rows.at(-1)).toMatchObject({ role: 'platform', open: { pr: pr.id } });
      expect(rows.at(-1)!.text).toContain('PR #1 ("Rewrite checkout") in api was APPROVED AUTOMATICALLY: feat/checkout is merged into main. Auto-merge is on for your user (turned on by Adam at 1 Nov 2026, 15:02 UTC)');
    });

    for (const [result, reason] of [
      [{ status: 'conflict' }, 'feat/checkout conflicts with main'],
      [{ status: 'stale' }, 'feat/checkout moved after it was made ready'],
      [{ status: 'gone' }, 'feat/checkout is gone'],
    ] as const) {
      it(`a merge that answers ${result.status} leaves the proposal open, waiting for its owner, with the reason`, async () => {
        const { service, pr, gitPullRequestStorage, started } = await buildGate(result);
        expect(await auto(service, pr.id)).toEqual({ status: 'fallback', reason });
        const left = (await gitPullRequestStorage.get(pr.id))!;
        // Not the terminal `conflict` a person's Approve writes: nobody has
        // seen it yet, and the card they are about to get must be decidable.
        expect(left.status).toBe('open');
        expect(left.autoApproved).toBeUndefined();
        expect(left.autoApproveFallback).toMatchObject({ reason });
        expect(started).toHaveLength(0);
      });
    }

    it('a host that throws is a fallback too', async () => {
      const gate = await buildGate({ status: 'merged' });
      gate.merge.mockRejectedValueOnce(new Error('host down'));
      expect(await auto(gate.service, gate.pr.id)).toEqual({ status: 'fallback', reason: 'the merge failed (host down)' });
      expect((await gate.gitPullRequestStorage.get(gate.pr.id))!.status).toBe('open');
    });

    it('a repo that requires checks holds it at the same door a person\'s Approve meets', async () => {
      const { service, pr, gitPullRequestStorage, gitRepoStorage, repo, merge, statuses } = await buildGate({
        status: 'merged', fastForward: true, mergeCommitSha: 'c'.repeat(40),
      });
      await gitRepoStorage.update(repo.id, { requireChecks: true });
      statuses.push({ state: 'failure', startedAt: new Date().toISOString() });
      const answer = await auto(service, pr.id);
      expect(answer.status).toBe('fallback');
      expect(answer.reason).toContain('checks are failing on the proposed commit');
      expect(merge).not.toHaveBeenCalled();
      expect((await gitPullRequestStorage.get(pr.id))!.status).toBe('open');
    });

    it('never touches a quiet or already-decided proposal', async () => {
      const { service, pr, gitPullRequestStorage, merge } = await buildGate({ status: 'merged' });
      await gitPullRequestStorage.update(pr.id, { draft: true });
      expect((await auto(service, pr.id)).status).toBe('fallback');
      await gitPullRequestStorage.update(pr.id, { draft: undefined, status: 'rejected' });
      expect((await auto(service, pr.id)).status).toBe('fallback');
      expect(merge).not.toHaveBeenCalled();
      expect((await gitPullRequestStorage.get(pr.id))!.status).toBe('rejected');
      expect((await gitPullRequestStorage.get(pr.id))!.autoApproveFallback).toBeUndefined();
    });
  });

  describe('the Mini App decision path', () => {
    it('approve merges with the head-sha anchor and hands the outcome back', async () => {
      const { service, pr, gitPullRequestStorage, merge, started, agentChatStorage } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40),
      });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(out).toEqual({ status: 'merged', note: null });
      expect(merge).toHaveBeenCalledWith('user-1', 'api', expect.objectContaining({
        base: 'main', head: 'feat/checkout', expectedHead: 'a'.repeat(40),
      }));
      expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
      const outcome = (await agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1);
      expect(outcome).toMatchObject({ role: 'platform', open: { pr: pr.id } });
      expect(outcome!.text).toContain('merged into');
      // …and the proposing agent gets its wake-up turn, same as a card tap.
      expect(started).toHaveLength(1);
    });

    /**
     * Note #682: the owner approved, the merge happened, and the chat kept
     * saying "Awaiting approval". The agent's sign-in had lapsed since it
     * proposed, and the outcome row was written only after the "is there a
     * machine to wake" guard — from the Workspace there is no other receipt.
     * The row is the owner's; the wake is the agent's. Only the wake waits.
     */
    it('a merge for a signed-out agent still lands its outcome on the chat', async () => {
      const { service, pr, gitPullRequestStorage, started, agentChatStorage, backgroundRunner } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40),
      }, { disconnected: true });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(out).toEqual({ status: 'merged', note: null });
      expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('merged');
      const outcome = (await agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1);
      expect(outcome).toMatchObject({ role: 'platform', open: { pr: pr.id } });
      expect(outcome!.text).toContain('APPROVED PR #');
      // Nothing to wake, and no "Working on" line for an agent that is not.
      expect(started).toHaveLength(0);
      expect(backgroundRunner.queueMessage).not.toHaveBeenCalled();
      const agent = (await service['deps'].userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-a'];
      expect(agent?.tasks ?? []).toHaveLength(0);
    });

    /**
     * Note #684: Juno reviewed Freya's proposal and ran `pr ready`, so the
     * card sat in Juno's chat. The decision went to Freya alone: Juno's chat
     * kept the card at "Awaiting approval" and Juno never heard. Both chats
     * get the row and the wake now; Juno's says whose proposal it was.
     */
    it('a decision lands on the chat of the agent that sent the card, as well as the author', async () => {
      const { service, pr, gitPullRequestStorage, started, agentChatStorage } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40),
      }, { reviewer: true });
      await gitPullRequestStorage.update(pr.id, { readyByAgentId: 'agent-b' });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(out).toEqual({ status: 'merged', note: null });

      const author = (await agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1);
      expect(author).toMatchObject({ role: 'platform', open: { pr: pr.id } });
      expect(author!.text).toContain('the change proposal you opened');

      const sender = (await agentChatStorage.getAfter('user-1', 'agent-b', 0)).at(-1);
      expect(sender).toMatchObject({ role: 'platform', open: { pr: pr.id } });
      expect(sender!.text).toContain('APPROVED PR #');
      expect(sender!.text).toContain('you put in front of your user for Main');
      expect(sender!.text).toContain('not a proposal you opened');
      // Both are woken: the author to continue, the sender to close its review.
      expect(started).toHaveLength(2);
    });

    it('a card the author sent itself writes one row and wakes one agent', async () => {
      const { service, pr, gitPullRequestStorage, started, agentChatStorage } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40),
      }, { reviewer: true });
      await gitPullRequestStorage.update(pr.id, { readyByAgentId: 'agent-a' });
      await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(await agentChatStorage.getAfter('user-1', 'agent-b', 0)).toEqual([]);
      expect(started).toHaveLength(1);
    });

    it('a rejection reaches the card sender too, with the reason', async () => {
      const { service, pr, gitPullRequestStorage, started, agentChatStorage } = await buildGate({ status: 'merged' }, { reviewer: true });
      await gitPullRequestStorage.update(pr.id, { readyByAgentId: 'agent-b' });
      await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'reject', note: 'Wrong colour',
      });
      const sender = (await agentChatStorage.getAfter('user-1', 'agent-b', 0)).at(-1);
      expect(sender!.text).toContain('REJECTED PR #');
      expect(sender!.text).toContain('Wrong colour');
      expect(started).toHaveLength(2);
    });

    /** The other silent drop: a turn that began while the wake was being
     *  resolved answered "already running" and the note went nowhere. */
    it('a wake that finds a turn already running queues into it', async () => {
      const { service, pr, started, agentChatStorage, backgroundRunner } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'c'.repeat(40),
      });
      backgroundRunner.startAgent.mockImplementationOnce(() => ({ status: 'already_running' }));
      await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(started).toHaveLength(0);
      expect(backgroundRunner.queueMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(backgroundRunner.queueMessage.mock.calls[0])).toContain('APPROVED');
      expect((await agentChatStorage.getAfter('user-1', 'agent-a', 0)).at(-1)?.text).toContain('APPROVED PR #');
    });

    it('reject records the decision without ever touching the host', async () => {
      const { service, pr, gitPullRequestStorage, merge, started } = await buildGate({ status: 'merged' });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'reject',
      });
      expect(out).toEqual({ status: 'rejected', note: 'Rejected.' });
      expect(merge).not.toHaveBeenCalled();
      expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('rejected');
      expect(started).toHaveLength(1);
    });

    it('refuses someone else’s proposal: no status, no merge, an honest note', async () => {
      const { service, pr, gitPullRequestStorage, merge } = await buildGate({ status: 'merged' });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-2', pullRequestId: pr.id, decision: 'approve',
      });
      expect(out).toEqual({ status: null, note: 'Only the owner of the proposing agent can decide this proposal.' });
      expect(merge).not.toHaveBeenCalled();
      expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('open');
    });

    it('an approved merge stamps the landing on the repo’s home branch', async () => {
      // The merge moves the protected branch with no push, so the host's push
      // report never sees it — the decision flow itself must record that the
      // branch moved, or "pushed … to main" goes stale the moment it matters.
      const { service, pr, gitRepoStorage, repo } = await buildGate({
        status: 'merged', fastForward: false, mergeCommitSha: 'd'.repeat(40),
      });
      await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      const updated = await gitRepoStorage.get(repo.id);
      expect(updated?.defaultBranchTipSha).toBe('d'.repeat(40));
      expect(updated?.defaultBranchPushAt).toBeTruthy();
    });

    it('an already-decided proposal answers with its real status, acting zero times', async () => {
      const { service, pr, gitPullRequestStorage, merge } = await buildGate({ status: 'merged' });
      await gitPullRequestStorage.update(pr.id, { status: 'merged' });
      const out = await service.decidePullRequestFromMiniApp({
        userId: 'user-1', pullRequestId: pr.id, decision: 'approve',
      });
      expect(out).toEqual({ status: 'merged', note: `PR #${pr.number} is already merged.` });
      expect(merge).not.toHaveBeenCalled();
    });
  });
});

/**
 * Files ON a proposal (Owner, notes #10 and #18).
 *
 * The record and the routes are the note's, deliberately — two stores, one
 * shape — so what is worth pinning here is the part that is NOT a note's: a
 * proposal is a question with an answer, and a file is evidence for it, so the
 * window for adding one closes when the decision lands.
 */
describe('files on a proposal', () => {
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

  function routeHandler(deps: Partial<RouteDeps>, path: string, method: 'get' | 'post' | 'delete') {
    const router = agentCliRoutes(deps as RouteDeps) as unknown as {
      stack: Array<{ route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
      } }>;
    };
    const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
    if (!layer?.route) throw new Error(`No ${method} ${path} route`);
    return layer.route.stack[layer.route.stack.length - 1]!.handle;
  }

  function fileRequest(args: {
    token: string;
    params?: Record<string, string>;
    body?: Buffer;
    fileName?: string;
    contentType?: string;
  }): Partial<Request> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${args.token}`,
      ...(args.fileName ? { 'x-file-name': args.fileName } : {}),
      ...(args.contentType ? { 'content-type': args.contentType } : {}),
    };
    return {
      get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
      params: args.params ?? {},
      query: {},
      body: args.body,
    };
  }

  async function buildWithProposal() {
    const built = await buildDeps();
    const media = new FakeMediaStorage();
    (built.deps as Partial<RouteDeps>).mediaStorage = media as never;
    const res = createMockResponse();
    await getRouteHandler(built.deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(built.token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), res);
    const number = String((res.body as { pr: { number: number } }).pr.number);
    return { ...built, media, number };
  }

  const attach = (deps: Partial<RouteDeps>) => routeHandler(deps, '/repos/:name/prs/:number/files', 'post');

  it('stores the bytes under the proposal and starts listing the record', async () => {
    const { deps, token, media, number, gitPullRequestStorage, repo } = await buildWithProposal();
    const res = createMockResponse();

    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('png-bytes'), fileName: 'before-after.png',
    }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain('beside the decision');
    // Under the proposal's OWN prefix, typed by extension — so a cleanup can
    // clear one proposal without reading every record.
    const [stored] = [...media.objects.keys()];
    expect(stored).toMatch(/^users\/user-1\/prs\/.+\/before-after\.png$/);
    expect(media.objects.get(stored!)?.contentType).toBe('image/png');
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    expect(doc.attachments).toEqual([
      expect.objectContaining({ fileName: 'before-after.png', sizeBytes: 9, addedByAgentId: 'agent-a' }),
    ]);

    // And `pr show` says what it is carrying, without the storage paths.
    const shown = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs/:number', 'get')(mockRequest({
      headers: authHeader(token), params: { name: 'api', number },
    }), shown);
    expect((shown.body as { pr: { files: unknown[] } }).pr.files).toEqual([
      expect.objectContaining({ fileName: 'before-after.png', sizeBytes: 9 }),
    ]);
    expect(JSON.stringify(shown.body)).not.toContain('users/user-1');
  });

  it('records a picture’s pixel size from its header, so the sheet can frame it before the bytes arrive (note #825)', async () => {
    const { deps, token, number, gitPullRequestStorage, repo } = await buildWithProposal();
    // A PNG header: signature, then IHDR with width 1440 and height 900.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'),
      Buffer.from([0, 0, 0x05, 0xa0]), Buffer.from([0, 0, 0x03, 0x84]),
      Buffer.alloc(5),
    ]);
    const res = createMockResponse();
    await attach(deps)(fileRequest({ token, params: { name: 'api', number }, body: png, fileName: 'home-desk.png' }), res);
    expect(res.statusCode).toBe(200);
    const text = createMockResponse();
    await attach(deps)(fileRequest({ token, params: { name: 'api', number }, body: Buffer.from('plain words'), fileName: 'trace.txt' }), text);
    expect(text.statusCode).toBe(200);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    expect(doc.attachments).toEqual([
      expect.objectContaining({ fileName: 'home-desk.png', width: 1440, height: 900 }),
      expect.not.objectContaining({ width: expect.anything() }),
    ]);
  });

  it('refuses what it must, each with its own reason', async () => {
    const { deps, token, number } = await buildWithProposal();
    const tryAttach = async (fileName: string, body = Buffer.from('x')) => {
      const res = createMockResponse();
      await attach(deps)(fileRequest({ token, params: { name: 'api', number }, body, fileName }), res);
      return res;
    };

    expect((await tryAttach('résultat (1).pdf')).statusCode).toBe(400);
    expect((await tryAttach('empty.png', Buffer.alloc(0))).statusCode).toBe(400);
    expect((await tryAttach('shot.png')).statusCode).toBe(200);
    const duplicate = await tryAttach('shot.png');
    expect(duplicate.statusCode).toBe(400);
    expect((duplicate.body as { error: string }).error).toContain('already has a file named');
    for (const name of ['b.png', 'c.png', 'd.png', 'e.png']) expect((await tryAttach(name)).statusCode).toBe(200);
    const sixth = await tryAttach('f.png');
    expect(sixth.statusCode).toBe(400);
    expect((sixth.body as { error: string }).error).toContain('at most 5 files');
  });

  /** The one rule that is not a note's: evidence arrives before the verdict. */
  it('takes no file once the proposal has been decided', async () => {
    const { deps, token, number, gitPullRequestStorage, repo } = await buildWithProposal();
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    await gitPullRequestStorage.update(doc.id, { status: 'merged' });

    const res = createMockResponse();
    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('x'), fileName: 'late.png',
    }), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('already been made');
  });

  /** A conflicted proposal is still being worked on and re-proposed. */
  it('still takes a file while the proposal is in conflict', async () => {
    const { deps, token, number, gitPullRequestStorage, repo } = await buildWithProposal();
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    await gitPullRequestStorage.update(doc.id, { status: 'conflict' });

    const res = createMockResponse();
    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('x'), fileName: 'rebased.png',
    }), res);

    expect(res.statusCode).toBe(200);
  });

  it('hands the bytes back behind a short-lived signed URL, and names what it has when asked for the wrong one', async () => {
    const { deps, token, number } = await buildWithProposal();
    const res = createMockResponse();
    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('png'), fileName: 'shot.png',
    }), res);

    const got = createMockResponse();
    await routeHandler(deps, '/repos/:name/prs/:number/files/:file', 'get')(fileRequest({
      token, params: { name: 'api', number, file: 'shot.png' },
    }), got);
    expect((got.body as { url: string }).url).toContain('https://signed.example/');

    const missing = createMockResponse();
    await routeHandler(deps, '/repos/:name/prs/:number/files/:file', 'get')(fileRequest({
      token, params: { name: 'api', number, file: 'nope.png' },
    }), missing);
    expect(missing.statusCode).toBe(404);
    // The names it DOES have: an agent that guessed wrong should not have to
    // make a second call to find out what it should have asked for.
    expect((missing.body as { error: string }).error).toContain('shot.png');
  });

  it('detach drops the record and then the bytes', async () => {
    const { deps, token, number, media, gitPullRequestStorage, repo } = await buildWithProposal();
    const res = createMockResponse();
    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('png'), fileName: 'shot.png',
    }), res);

    const off = createMockResponse();
    await routeHandler(deps, '/repos/:name/prs/:number/files/:file', 'delete')(fileRequest({
      token, params: { name: 'api', number, file: 'shot.png' },
    }), off);

    expect(off.statusCode).toBe(200);
    const doc = (await gitPullRequestStorage.listByRepo(repo.id))[0]!;
    expect(doc.attachments).toEqual([]);
    expect(media.deleted).toHaveLength(1);
  });

  it('says so plainly on a backend with no file store, rather than failing oddly', async () => {
    const { deps, token, number } = await buildWithProposal();
    (deps as Partial<RouteDeps>).mediaStorage = undefined;
    const res = createMockResponse();
    await attach(deps)(fileRequest({
      token, params: { name: 'api', number }, body: Buffer.from('x'), fileName: 'shot.png',
    }), res);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toContain('words-only');
  });
});

/**
 * The margin on a proposal (Owner, note #66).
 *
 * The shared comment shape notes grew first, hung under a change proposal:
 * anyone in the workplace writes in the thread, nobody edits the proposal
 * through it, and the window closes with the files — a decided proposal is
 * not a question any more.
 */
describe('the margin on a proposal', () => {
  const setup = async () => {
    const built = await buildDeps();
    await getRouteHandler(built.deps, '/repos/:name/prs', 'post')(mockRequest({
      headers: authHeader(built.token), params: { name: 'api' },
      body: { from: 'feat/checkout', title: 'Rewrite checkout' },
    }), createMockResponse());
    const comment = getRouteHandler(built.deps, '/repos/:name/prs/:number/comments', 'post');
    return { ...built, comment };
  };

  it('appends the remark and stamps who said it — agent AND human behind it', async () => {
    const { comment, token, gitPullRequestStorage, repo } = await setup();
    const res = createMockResponse();

    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'The flaky test was the clock, not the code — fixed in the last push.' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain('PR #1');
    // The writing agent reads itself as "you": by its next turn this is a
    // remark from a turn it no longer remembers.
    expect((res.body as { pr: { comments: Array<{ by: string; text: string; createdAt: string }> } }).pr.comments)
      .toEqual([expect.objectContaining({
        by: 'you',
        text: 'The flaky test was the clock, not the code — fixed in the last push.',
        createdAt: expect.any(String),
      })]);
    // The record signs the agent and the human driving it (note #57), so the
    // signature survives the agent's retirement.
    const doc = await gitPullRequestStorage.getByNumber(repo.id, 1);
    expect(doc?.comments).toEqual([
      expect.objectContaining({ authorId: 'agent-a', userId: 'user-1' }),
    ]);
  });

  it('names the author for every reader: a teammate agent by name, the person as "your user"', async () => {
    const { deps, token, comment, gitPullRequestStorage, repo } = await setup();
    // Ben (agent-a) speaks first…
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'Rebased on main after the conflict.' },
    }), createMockResponse());
    // …and the user writes from their Workspace — the sentinel author, with
    // the human stamp naming them.
    const doc = (await gitPullRequestStorage.getByNumber(repo.id, 1))!;
    await gitPullRequestStorage.addComment(
      doc.id,
      newMarginComment(COMMENT_AUTHOR_USER, 'Hold this until Friday.', 'user-1'),
    );

    // A SECOND agent of the same user opens the proposal.
    const userStorage = deps.userStorage as InMemoryUserStorage;
    const profile = (await userStorage.getProfile('user-1'))!;
    const minted = mintAgentbuiltToken('user-1', 'agent-b');
    await userStorage.updateProfile('user-1', {
      telegram: {
        ...profile.telegram!,
        agents: {
          ...profile.telegram!.agents,
          'agent-b': { id: 'agent-b', name: 'Nina', cli: 'claude', agentbuiltTokenHash: minted.tokenHash } as never,
        },
      },
    });
    const shown = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs/:number', 'get')(mockRequest({
      headers: authHeader(minted.token), params: { name: 'api', number: '1' },
    }), shown);

    // Names, never ids: an id tells the reading agent nothing.
    const comments = (shown.body as { pr: { comments: Array<{ by: string }> } }).pr.comments;
    expect(comments.map((c) => c.by)).toEqual(['Ben', 'your user']);
    expect(JSON.stringify(comments)).not.toContain('agent-a');
  });

  it('rides every pr list row too — one describePr, so list and show can never drift', async () => {
    const { deps, token, comment } = await setup();
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'On the record: the tax rules are untouched.' },
    }), createMockResponse());

    const list = createMockResponse();
    await getRouteHandler(deps, '/repos/:name/prs', 'get')(mockRequest({
      headers: authHeader(token), params: { name: 'api' },
    }), list);

    const [row] = (list.body as { prs: Array<{ comments?: Array<{ by: string; text: string }> }> }).prs;
    expect(row?.comments).toEqual([
      expect.objectContaining({ by: 'you', text: 'On the record: the tax rules are untouched.' }),
    ]);
  });

  it('refuses empty words, an essay, and JavaScript — each before the record moves', async () => {
    const { comment, token, gitPullRequestStorage, repo } = await setup();
    const tryComment = async (text: unknown) => {
      const res = createMockResponse();
      await comment(mockRequest({
        headers: authHeader(token), params: { name: 'api', number: '1' }, body: { text },
      }), res);
      return res;
    };

    expect((await tryComment('   ')).statusCode).toBe(400);
    const essay = await tryComment('x'.repeat(COMMENT_MAX_LENGTH + 1));
    expect(essay.statusCode).toBe(400);
    expect((essay.body as { error: string }).error).toContain(String(COMMENT_MAX_LENGTH));
    // The same safe-HTML wall every margin has: a comment renders in the
    // Workspace, so nothing executable is ever appended.
    const script = await tryComment('<script>alert(1)</script>');
    expect(script.statusCode).toBe(400);
    expect((script.body as { error: string }).error).toContain('JavaScript');
    expect((await gitPullRequestStorage.getByNumber(repo.id, 1))?.comments).toBeUndefined();
  });

  /** The one rule that is not a note's: the margin closes with the decision. */
  it('closes with the decision — and stays open through a conflict', async () => {
    const { comment, token, gitPullRequestStorage, repo } = await setup();
    const doc = (await gitPullRequestStorage.getByNumber(repo.id, 1))!;
    await gitPullRequestStorage.update(doc.id, { status: 'merged' });

    const late = createMockResponse();
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'One more thing…' },
    }), late);
    expect(late.statusCode).toBe(409);
    // The refusal says WHERE the words belong now, not just "no".
    expect((late.body as { error: string }).error).toContain('margin closed with the decision');

    // A conflicted proposal is still being worked on and re-proposed — the
    // conversation about it is exactly what the margin is for.
    await gitPullRequestStorage.update(doc.id, { status: 'conflict' });
    const during = createMockResponse();
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'Rebasing now — the checkout rewrite collided with the tax fix.' },
    }), during);
    expect(during.statusCode).toBe(200);
  });

  it('holds the line at the cap, so no margin grows without bound', async () => {
    const { comment, token, gitPullRequestStorage, repo } = await setup();
    const doc = (await gitPullRequestStorage.getByNumber(repo.id, 1))!;
    for (let i = 0; i < MAX_COMMENTS; i += 1) {
      await gitPullRequestStorage.addComment(doc.id, newMarginComment('agent-a', `remark ${i}`, 'user-1'));
    }

    const res = createMockResponse();
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'one more' },
    }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain(String(MAX_COMMENTS));
    expect((await gitPullRequestStorage.getByNumber(repo.id, 1))?.comments).toHaveLength(MAX_COMMENTS);
  });

  /**
   * The margin wakes an agent only for a PERSON (note #239): the Workspace
   * route starts the proposal's author on the user's remark, and this one —
   * where every agent writes — starts nobody at all. That asymmetry is what
   * keeps a thread from talking to itself: the author woken by a comment can
   * answer here without waking anyone back.
   */
  it('starts nobody when an agent writes in the margin', async () => {
    const { comment, token, deps } = await setup();
    const messageAgentFromUser = vi.fn();
    deps.agentLifecycle = { messageAgentFromUser } as never;

    const res = createMockResponse();
    await comment(mockRequest({
      headers: authHeader(token), params: { name: 'api', number: '1' },
      body: { text: 'Checks are green — this is ready whenever you are.' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(messageAgentFromUser).not.toHaveBeenCalled();
  });

  it('arrived without bringing an approve verb with it', () => {
    const router = agentCliRoutes({} as RouteDeps) as unknown as {
      stack: Array<{ route?: { path: string } }>;
    };
    const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean) as string[];
    expect(paths).toContain('/repos/:name/prs/:number/comments');
    // The margin lets everyone SPEAK about a proposal; deciding one still
    // happens only in Telegram — the verb is as absent as it ever was.
    expect(paths.some((path) => /approve|merge/i.test(path))).toBe(false);
  });
});
