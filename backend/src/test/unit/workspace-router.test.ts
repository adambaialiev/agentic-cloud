import { OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { InMemoryOutreachPassStore, OutreachPasses } from '../../services/outreach-pass.js';
import { fixtureOutreachWrite } from '../../shared/outreach-fixtures.js';
import { parseOutreachWrite } from '../../shared/outreach.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryMediaStorage } from '../../services/memory-media-storage.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { workspaceRoutes } from '../../routes/workspace.js';
import { OrgSpendError } from '../../services/org-spend.js';
import { workspaceShellPathPatterns } from '../../shared/workspace-routes.js';
import { AGENT_MACHINE_SIZES, DEFAULT_AGENT_MACHINE_SIZE_ID } from '../../config/agent-machine-sizes.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryAgentWorkLedger } from '../../services/agent-work-ledger.js';
import { InMemoryAgentTokenLedger, tokenDayKey } from '../../services/agent-token-ledger.js';
import type {
  WorkspaceMemberContributionAnswer,
  WorkspacePeopleAnswer,
  WorkspacePeopleLiveAnswer,
  WorkspacePublicPersonAnswer,
  WorkspaceTokenUsageAnswer,
} from '../../shared/workspace-api.js';
import type { WorkspaceRecapSettingsAnswer } from '../../shared/workspace-recap.js';
import { LEADERBOARD_DAYS_FROM, leaderboardDayAt, leaderboardWeekStart } from '../../shared/leaderboard.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { GIT_TRASH_KEEP_DAYS } from '../../types/git-repo.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { InMemoryGitCommitStatusStorage } from '../../services/git-commit-status-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../../services/knowledge-storage.js';
import { InMemoryKnowledgePageCommentStorage } from '../../services/knowledge-page-comments.js';
import { newMarginComment } from '../../types/comment.js';
import type { GitHostClient } from '../../services/git-host-client.js';
import { fakeKnowledgeHost } from '../helpers/fake-knowledge-host.js';
import { KnowledgeService } from '../../services/knowledge-service.js';
import {
  UserSecretsService,
  SHARED_USER_SECRET_SCOPE,
  agentUserSecretScope,
} from '../../services/user-secrets.js';
import { SiteFavicons } from '../../services/site-favicon.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgHandleService } from '../../services/org-handles.js';
import { WorkplaceDeletionService } from '../../services/workplace-deletion.js';
import { OrgGitService, orgKnowledgeShelfNamespace } from '../../services/org-git.js';
import { PLATFORM_CREDENTIAL_USAGE_REFRESH_MS } from '../../services/platform-credential-pool.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { QUICK_NOTES_MAX_PER_USER } from '../../types/quick-note.js';
import { VoiceTranscriptionError, voicePauseReasonFor } from '../../services/voice-transcription-service.js';
import { VOICE_KEY_SECRET_NAME, WorkplaceVoiceService } from '../../services/workplace-voice.js';
import { OrgSecretsService } from '../../services/org-secrets.js';
import { DEFAULT_VOICE_MODEL } from '../../shared/voice.js';

const VOICE_TEST_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef01234567';
import { VOICE_ERROR_SENTENCES } from '../../shared/voice-transcription.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
  type WorkspaceWebSessionDocument,
} from '../../services/workspace-web-auth.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { hashOpaqueToken } from '../../utils/totp.js';

/** Enough of a PNG to be sniffed as one; the rest of the file is not read. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

/**
 * The Workspace routes — the browser-facing sibling of agent-cli's secrets
 * surface. Identity comes only from an opaque browser session, plaintext
 * never travels back over HTTP, and caller-supplied resource IDs are trusted
 * only after ownership is proven.
 */

const WORKSPACE_ORIGIN = 'https://workspace.test';

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
  sentText?: string;
  /** The payload as it was passed, for the routes that send real bytes. */
  sentBody?: string | Buffer;
  contentType?: string;
  headers: Record<string, string>;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined, headers: {} };
  response.set = ((name: string, value: string) => {
    response.headers[name.toLowerCase()] = value;
    return response as Response;
  }) as Response['set'];
  response.status = ((code: number) => {
    response.statusCode = code;
    return response as Response;
  }) as Response['status'];
  response.json = ((payload: unknown) => {
    response.body = payload;
    return response as Response;
  }) as Response['json'];
  response.type = ((value: string) => {
    response.contentType = value;
    return response as Response;
  }) as Response['type'];
  response.redirect = ((code: number, location: string) => {
    response.statusCode = code;
    response.headers.location = location;
  }) as Response['redirect'];
  response.setHeader = ((name: string, value: string) => {
    response.headers[name.toLowerCase()] = String(value);
    return response as Response;
  }) as never;
  response.send = ((payload: string | Buffer) => {
    // The page is sent as bytes (it is served pre-encoded); everything else is
    // a string. Either way these tests read it as text.
    response.sentText = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
    response.sentBody = payload;
    return response as Response;
  }) as Response['send'];
  return response;
}

function getRouteHandler(
  deps: Partial<RouteDeps>,
  path: string,
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
): (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = workspaceRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
      };
    }>;
  };
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === path && candidate.route.methods[method]
  ));
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

/** Handlers off ONE router, for state it holds in memory between two routes:
 *  a recap being written is known only to the router whose press started it. */
function routesOf(deps: Partial<RouteDeps>): (path: string, method: 'get' | 'post') => (req: Partial<Request>, res: MockResponse) => Promise<unknown> {
  const router = workspaceRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  return (path, method) => {
    const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
    if (!layer?.route) throw new Error(`No ${method} ${path} route`);
    return layer.route.stack[layer.route.stack.length - 1]!.handle;
  };
}

function mockRequest(args: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** The address as asked for, mount and query included — what a redirect
   *  has to carry forward. */
  originalUrl?: string;
}): Partial<Request> {
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    // A real request always carries `headers`; handlers are entitled to read
    // it directly (content negotiation does).
    headers,
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    ...(args.originalUrl ? { originalUrl: args.originalUrl } : {}),
    query: (args.query ?? {}) as Request['query'],
    body: args.body,
  };
}

const sessionToken = (identity: number) => `workspace-session-${identity}`;
const csrfToken = (identity: number) => `workspace-csrf-${identity}`;
const authHeader = (identity: number) => ({
  Cookie: `__Host-acc_session=${sessionToken(identity)}; __Host-acc_csrf=${csrfToken(identity)}`,
  Origin: WORKSPACE_ORIGIN,
  'X-CSRF-Token': csrfToken(identity),
});

function testSession(userId: string, sessionId: string): WorkspaceWebSessionDocument {
  return {
    sessionId,
    userId,
    authMethod: 'totp',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    idleExpiresAt: '2099-01-01T00:00:00.000Z',
    absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
  };
}

async function buildDeps() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      telegramUserId: '42',
      agents: {
        'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: 'x' } as never,
        'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', agentbuiltTokenHash: 'x' } as never,
      },
    } as never,
  });
  const secretStorage = new InMemorySecretStorage();
  const webAuthStorage = new InMemoryWorkspaceWebAuthStorage();
  await webAuthStorage.createSession(
    hashOpaqueToken(sessionToken(42)),
    testSession('user-1', 'session-42'),
  );
  await webAuthStorage.createSession(
    hashOpaqueToken(sessionToken(43)),
    testSession('user-2', 'session-43'),
  );
  const workspaceWebAuth = new WorkspaceWebAuthService(
    webAuthStorage,
    userStorage,
    new SecretCipher(randomBytes(32).toString('base64')),
  );
  const deps: Partial<RouteDeps> = {
    userStorage,
    secretStorage,
    workspaceWebAuth,
    workspaceWebOrigin: WORKSPACE_ORIGIN,
  };
  return { deps, secretStorage, userStorage, workspaceWebAuth, webAuthStorage };
}


describe('telegram mini app routes', () => {
  // The React shell, as `vite build` leaves it: an index.html with no inline
  // script and hashed assets. What is served, and where, is covered on real
  // sockets in workspace-ui-delivery.test.ts; these hold the router's shape.
  const SHELL_HTML = '<!doctype html><html><head><title>Your workspace</title>'
    + '<script type="module" crossorigin src="/workspace/app/assets/index-abc123.js"></script></head>'
    + '<body class="web-mode"><div id="root"></div></body></html>';
  let shellDir: string;
  beforeAll(() => {
    shellDir = mkdtempSync(path.join(tmpdir(), 'workspace-shell-'));
    mkdirSync(path.join(shellDir, 'assets'));
    writeFileSync(path.join(shellDir, 'index.html'), SHELL_HTML);
  });
  afterAll(() => { rmSync(shellDir, { recursive: true, force: true }); });

  it('redirects every shell address under /workspace to the root of the domain, query intact', async () => {
    const { deps } = await buildDeps();
    // The registry (shared/workspace-routes.ts) is the one list of paths the
    // shell answers on — at the root now (routes/workspace-root.ts); here each
    // one is a permanent redirect, so a link copied before the move arrives.
    const destinations = workspaceShellPathPatterns();
    expect(destinations).toContain('/login');
    expect(destinations).toContain('/agents/:id');
    expect(destinations).toContain('/repositories/:id/commits/:sha');
    for (const [path, originalUrl, target] of [
      ['/notes/:id', '/workspace/notes/12?org=o1&room=r1', '/notes/12?org=o1&room=r1'],
      ['/public/repositories/:id', '/public/repositories/abc?path=src', '/public/repositories/abc?path=src'],
      ['/organization/people', '/workspace/organization/people?org=o1', '/workplace/people?org=o1'],
      ['/login', '/workspace/login', '/login'],
    ] as const) {
      const res = createMockResponse();
      await getRouteHandler({ ...deps, workspaceUiDir: shellDir }, path, 'get')(mockRequest({ originalUrl }), res);
      expect(res.statusCode, path).toBe(301);
      expect(res.headers.location, path).toBe(target);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('sends the bare /workspace to Home for a signed-in browser and to the login door for anyone else', async () => {
    const { deps } = await buildDeps();
    const anonymous = createMockResponse();
    await getRouteHandler({ ...deps, workspaceUiDir: shellDir }, '/', 'get')(mockRequest({ originalUrl: '/workspace' }), anonymous);
    expect(anonymous.statusCode).toBe(301);
    expect(anonymous.headers.location).toBe('/login');
    const signedIn = createMockResponse();
    await getRouteHandler({ ...deps, workspaceUiDir: shellDir }, '/', 'get')(
      mockRequest({ originalUrl: '/workspace/?org=o1', headers: { Cookie: 'acc_csrf=t; __Host-acc_csrf=t' } }), signedIn);
    expect(signedIn.statusCode).toBe(301);
    expect(signedIn.headers.location).toBe('/?org=o1');
  });

  it('still answers the cloud screen\u2019s old address, workplace and all (note #355)', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler({ ...deps, workspaceUiDir: shellDir }, '/organization/spending', 'get')(
      mockRequest({ originalUrl: '/workspace/organization/spending?org=o1' }),
      res,
    );
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/workplace/cloud?org=o1');
  });

  it('refuses API calls without a valid browser session', async () => {
    const { deps } = await buildDeps();
    for (const headers of [
      {},
      { Authorization: 'tma retired-launch-data' },
      { Cookie: '__Host-acc_session=not-a-session' },
    ]) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers }), res);
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuses a browser session whose account no longer exists', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(999) }), res);
    expect(res.statusCode).toBe(401);
  });

  /** A workplace user-1 belongs to, with voice-to-text on its own key
   *  (note #1026) when `key` is set. */
  async function withVoice(deps: Partial<RouteDeps>, opts: {
    role?: 'admin' | 'member';
    key?: boolean;
    transcribe?: ReturnType<typeof vi.fn>;
    checkKey?: ReturnType<typeof vi.fn>;
  } = {}) {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: opts.role ?? 'admin' });
    const orgSecrets = new OrgSecretsService(new InMemorySecretStorage());
    if (opts.key) await orgSecrets.setOrgSecret(org.orgId, VOICE_KEY_SECRET_NAME, VOICE_TEST_KEY, 'test');
    const transcribe = opts.transcribe ?? vi.fn().mockResolvedValue({ text: 'Ship the new onboarding flow.', costUsd: 0.001, seconds: 3 });
    const checkKey = opts.checkKey ?? vi.fn().mockResolvedValue('ok');
    deps.orgStorage = orgStorage;
    deps.workplaceVoice = new WorkplaceVoiceService({
      orgStorage,
      orgSecrets,
      openRouter: { checkKey: checkKey as never, creditLeft: vi.fn().mockResolvedValue(3), transcriptionModels: vi.fn().mockResolvedValue([]) },
      transcriber: { transcribe: transcribe as never },
      pauseReasonFor: voicePauseReasonFor,
    });
    return { orgId: org.orgId, orgStorage, orgSecrets, transcribe, checkKey };
  }

  const recording = (headers: Record<string, string> = {}) => mockRequest({
    headers: { ...authHeader(42), 'Content-Type': 'audio/webm;codecs=opus', ...headers },
    body: Buffer.from('recorded-audio'),
  });

  it('transcribes on the workplace key and model without returning provider metadata', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { key: true });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ text: 'Ship the new onboarding flow.' });
    expect(voice.transcribe).toHaveBeenCalledWith({
      apiKey: VOICE_TEST_KEY,
      model: DEFAULT_VOICE_MODEL,
      audio: Buffer.from('recorded-audio'),
      contentType: 'audio/webm',
      fileName: 'workspace-recording',
    });
  });

  it('keeps Workspace transcription behind the session, and says "not set up" with no workplace key', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps);
    const unauthenticated = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(mockRequest({
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('audio'),
    }), unauthenticated);
    expect(unauthenticated.statusCode).toBe(401);

    const noKey = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), noKey);
    expect(noKey.statusCode).toBe(503);
    expect(noKey.body).toEqual({ error: VOICE_ERROR_SENTENCES.voice_not_configured, code: 'voice_not_configured' });
    expect(voice.transcribe).not.toHaveBeenCalled();

    delete deps.workplaceVoice;
    const off = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), off);
    expect(off.statusCode).toBe(200);
    expect(off.body).toMatchObject({ state: 'off', canChange: false });
    const unavailable = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), unavailable);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).toEqual({ error: VOICE_ERROR_SENTENCES.voice_not_configured, code: 'voice_not_configured' });
  });

  it('keeps transcription provider failures private and preserves safe audio refusals', async () => {
    const { deps } = await buildDeps();
    await withVoice(deps, {
      key: true,
      transcribe: vi.fn()
        .mockRejectedValueOnce(new VoiceTranscriptionError('Voice transcription expects an audio recording.', 'invalid_audio', 400))
        .mockRejectedValueOnce(new Error('upstream key and gateway details')),
    });

    const invalid = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording({ 'Content-Type': 'text/plain' }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toEqual({ error: 'Voice transcription expects an audio recording.' });

    const upstream = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), upstream);
    expect(upstream.statusCode).toBe(502);
    expect(upstream.body).toEqual({ error: 'Could not transcribe that recording. Try again.', code: 'voice_failed' });
    expect(JSON.stringify(upstream.body)).not.toContain('key');
  });

  // Note #1023: a provider that is out of credit or refuses the key is
  // configuration, so the route answers 503 with a stable code and a sentence
  // that says who can fix it — never the provider's own words. Note #1026:
  // the workplace pauses, and the next recording is refused without asking
  // OpenRouter at all.
  it.each([
    ['out of credit', 'out_of_credit', 402, 'voice_out_of_credit', 'run out of credit'],
    ['a rejected key', 'key_rejected', 401, 'voice_key_rejected', 'key no longer works'],
  ] as const)('answers 503 with a stable code for %s, and pauses the workplace', async (_case, serviceCode, upstreamStatus, code, words) => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, {
      key: true,
      transcribe: vi.fn().mockRejectedValue(new VoiceTranscriptionError(
        'OpenRouter transcription request failed: This request\u2019s maximum cost exceeds your available credits.',
        serviceCode, 503, upstreamStatus,
      )),
    });
    for (let i = 0; i < 2; i++) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), res);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: VOICE_ERROR_SENTENCES[code], code });
      expect((res.body as { error: string }).error).toContain(words);
      expect(JSON.stringify(res.body)).not.toMatch(/OpenRouter|credits\.|40[12]/);
    }
    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    expect((await voice.orgStorage.getOrg(voice.orgId))?.voicePaused?.reason).toBe(serviceCode);
  });

  it('keeps a passing upstream fault a plain 502 with the voice_failed code', async () => {
    const { deps } = await buildDeps();
    await withVoice(deps, {
      key: true,
      transcribe: vi.fn().mockRejectedValue(new VoiceTranscriptionError(
        'OpenRouter transcription request failed: 503 Service Unavailable', 'upstream_error', 502, 503,
      )),
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/transcribe', 'post')(recording(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: VOICE_ERROR_SENTENCES.voice_failed, code: 'voice_failed' });
  });

  it('shows a member who pays and who can change voice-to-text, and refuses their changes', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { role: 'member', key: true });
    const read = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), read);
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ state: 'on', canChange: false, model: { id: DEFAULT_VOICE_MODEL } });
    expect(read.body).not.toHaveProperty('admin');
    expect(JSON.stringify(read.body)).not.toContain(VOICE_TEST_KEY.slice(-6));

    for (const [path, method, body] of [
      ['/api/voice/key', 'put', { key: 'sk-or-v1-another-key-entirely-0000000000' }],
      ['/api/voice/key', 'delete', undefined],
      ['/api/voice/model', 'put', { model: 'openai/whisper-large-v3' }],
    ] as const) {
      const res = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ headers: authHeader(42), body }), res);
      expect(res.statusCode).toBe(403);
    }
    expect(voice.checkKey).not.toHaveBeenCalled();
    expect(await voice.orgSecrets.getOrgSecret(voice.orgId, VOICE_KEY_SECRET_NAME)).toBe(VOICE_TEST_KEY);
  });

  it('lets an admin save a key OpenRouter accepts, choose a model and remove the key', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { role: 'admin' });
    const before = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), before);
    expect(before.body).toMatchObject({ state: 'off', canChange: true, admin: { key: null } });

    const saved = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key', 'put')(mockRequest({ headers: authHeader(42), body: { key: VOICE_TEST_KEY } }), saved);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toMatchObject({ state: 'on', admin: { key: { preview: `sk-or-v1-…${VOICE_TEST_KEY.slice(-4)}` }, creditLeftUsd: 3 } });
    expect(JSON.stringify(saved.body)).not.toContain(VOICE_TEST_KEY);
    expect(voice.checkKey).toHaveBeenCalledWith(VOICE_TEST_KEY);

    const model = createMockResponse();
    await getRouteHandler(deps, '/api/voice/model', 'put')(mockRequest({ headers: authHeader(42), body: { model: 'openai/whisper-large-v3-turbo' } }), model);
    expect(model.body).toMatchObject({ model: { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo' } });

    const removed = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key', 'delete')(mockRequest({ headers: authHeader(42) }), removed);
    expect(removed.body).toMatchObject({ state: 'off' });
  });

  it('answers "off" to an account in no workplace, and refuses its changes', async () => {
    const { deps } = await buildDeps();
    await withVoice(deps);
    deps.orgStorage = new InMemoryOrgStorage();
    const read = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), read);
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ state: 'off', canChange: false, admins: [] });
    const write = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key', 'put')(mockRequest({ headers: authHeader(42), body: { key: VOICE_TEST_KEY } }), write);
    expect(write.statusCode).toBe(403);
  });

  it('refuses a key OpenRouter does not accept, keeping nothing', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { checkKey: vi.fn().mockResolvedValue('rejected') });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key', 'put')(mockRequest({ headers: authHeader(42), body: { key: VOICE_TEST_KEY } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'voice_key_rejected' });
    expect(await voice.orgSecrets.getOrgSecret(voice.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();
  });

  // Note #1116 (Adam: "if I am admin for both of course"): an admin with no
  // key here is offered the key they already saved in another workplace they
  // run, copied on the server in one tap, names only on the wire.
  it('offers and copies the key from another workplace this person also runs as an admin', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { role: 'admin' });
    const other = await voice.orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: 'user-1' });
    await voice.orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'admin' });
    await voice.orgSecrets.setOrgSecret(other.orgId, VOICE_KEY_SECRET_NAME, VOICE_TEST_KEY, 'test');
    const keyless = await voice.orgStorage.createOrg({ name: 'Studio', createdByUserId: 'user-1' });
    await voice.orgStorage.addMember({ orgId: keyless.orgId, userId: 'user-1', role: 'admin' });

    const before = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), before);
    expect(before.body).toMatchObject({ state: 'off', admin: { key: null, copyFrom: [{ orgId: other.orgId, name: 'Eldiiar' }] } });
    expect(JSON.stringify(before.body)).not.toContain(VOICE_TEST_KEY.slice(-6));

    const copied = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key/copy', 'post')(mockRequest({ headers: authHeader(42), body: { fromOrgId: other.orgId } }), copied);
    expect(copied.statusCode).toBe(200);
    expect(copied.body).toMatchObject({ state: 'on', admin: { key: { copiedFromName: 'Eldiiar' } } });
    expect(copied.body).not.toHaveProperty('admin.copyFrom');
    expect(JSON.stringify(copied.body)).not.toContain(VOICE_TEST_KEY);
    expect(voice.checkKey).toHaveBeenCalledWith(VOICE_TEST_KEY);
    expect(await voice.orgSecrets.getOrgSecret(voice.orgId, VOICE_KEY_SECRET_NAME)).toBe(VOICE_TEST_KEY);

    // A second copy over a key that is now here is refused, not a silent swap.
    const again = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key/copy', 'post')(mockRequest({ headers: authHeader(42), body: { fromOrgId: other.orgId } }), again);
    expect(again.statusCode).toBe(409);
  });

  it('refuses to copy a key from a workplace where this person is not an admin, and offers none', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { role: 'admin' });
    const other = await voice.orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: 'user-9' });
    await voice.orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'member' });
    await voice.orgSecrets.setOrgSecret(other.orgId, VOICE_KEY_SECRET_NAME, VOICE_TEST_KEY, 'test');
    const stranger = await voice.orgStorage.createOrg({ name: 'Elsewhere', createdByUserId: 'user-9' });
    await voice.orgSecrets.setOrgSecret(stranger.orgId, VOICE_KEY_SECRET_NAME, VOICE_TEST_KEY, 'test');

    const read = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), read);
    expect(read.body).toMatchObject({ state: 'off', admin: { key: null } });
    expect(read.body).not.toHaveProperty('admin.copyFrom');

    for (const fromOrgId of [other.orgId, stranger.orgId]) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/voice/key/copy', 'post')(mockRequest({ headers: authHeader(42), body: { fromOrgId } }), res);
      expect(res.statusCode).toBe(403);
    }
    expect(voice.checkKey).not.toHaveBeenCalled();
    expect(await voice.orgSecrets.getOrgSecret(voice.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();
  });

  it('never lets a member of this workplace copy a key in, even one they hold elsewhere', async () => {
    const { deps } = await buildDeps();
    const voice = await withVoice(deps, { role: 'member' });
    const other = await voice.orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: 'user-1' });
    await voice.orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'admin' });
    await voice.orgSecrets.setOrgSecret(other.orgId, VOICE_KEY_SECRET_NAME, VOICE_TEST_KEY, 'test');
    const read = createMockResponse();
    await getRouteHandler(deps, '/api/voice', 'get')(mockRequest({ headers: authHeader(42) }), read);
    expect(read.body).not.toHaveProperty('admin');
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/voice/key/copy', 'post')(mockRequest({ headers: authHeader(42), body: { fromOrgId: other.orgId } }), res);
    expect(res.statusCode).toBe(403);
    expect(await voice.orgSecrets.getOrgSecret(voice.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();
  });

  it('puts the landing agent\u2019s name and face on a knowledge page', async () => {
    // A page belongs to the ACCOUNT and six agents write into one base, so the
    // row carries who wrote it — the same pair a site's and a note's row do
    // (Owner, 2026-08-17). Ids never reach the screen: the workspace resolves
    // the name, and the face is the picture that agent's own row wears.
    const { deps } = await buildDeps();
    deps.knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.gitHostClient = {
      knowledgeList: async () => ({
        pages: [
          { name: 'deploy-runbook', sha: 'a1', sizeBytes: 120 },
          { name: 'old-page', sha: 'b2', sizeBytes: 90 },
        ],
        index: JSON.stringify({
          pages: {
            'deploy-runbook': {
              title: 'Deploying the site', description: 'The steps, and what to check after.',
              updatedAt: '2026-08-16T10:00:00.000Z', bytes: 120, updatedByAgentId: 'agent-a',
            },
            // Landed before attribution was recorded — the row keeps its words
            // and wears no face, which is also what a deleted agent leaves.
            'old-page': {
              title: 'Old page', description: 'Written before any of this.',
              updatedAt: '2026-08-01T10:00:00.000Z', bytes: 90,
            },
          },
        }),
      }),
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const knowledge = (res.body as { knowledge: Array<Record<string, unknown>> }).knowledge;
    expect(knowledge).toEqual([
      expect.objectContaining({
        name: 'deploy-runbook', agentName: 'Ben', agentAvatarUrl: '/workspace/avatars/ben',
      }),
      expect.objectContaining({ name: 'old-page', description: 'Written before any of this.' }),
    ]);
    expect(knowledge[1]!.agentName).toBeUndefined();
    expect(knowledge[1]!.agentAvatarUrl).toBeUndefined();
  });

  it('shows a knowledge page\u2019s history and puts it back in one tap (note #746)', async () => {
    const { deps } = await buildDeps();
    const host = fakeKnowledgeHost();
    const proposals = new InMemoryKnowledgeProposalStorage();
    deps.knowledgeProposalStorage = proposals;
    deps.gitHostClient = host.client;
    const service = new KnowledgeService(host.client, proposals);
    const page = (body: string) => `<!doctype html>\n<html lang="en"><head><title>Deploys</title><meta name="description" content="How."></head><body><h1>Deploys</h1><p>${body}</p></body></html>\n`;
    const write = (html: string, note: string) => service.apply({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "Deploys"', note,
      changes: [{ page: 'deploys', action: host.files.has('pages/deploys.html') ? 'edit' : 'create', html, title: 'Deploys', description: 'How.', baseSha: host.files.has('pages/deploys.html') ? null : null }],
    });
    expect((await write(page('First.'), 'first')).status).toBe('applied');
    // An edit pins the current blob, as the route would.
    const current = (await service.currentShas('user-1')).get('deploys')!;
    const second = await service.apply({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Update "Deploys"', note: 'second',
      changes: [{ page: 'deploys', action: 'edit', html: page('Second.'), title: 'Deploys', description: 'How.', baseSha: current }],
    });
    expect(second.status).toBe('applied');

    const read = createMockResponse();
    await getRouteHandler(deps, '/api/knowledge/pages/:name', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'deploys' } }), read);
    expect(read.statusCode).toBe(200);
    const record = (read.body as { page: { html: string; history: Array<Record<string, unknown>> } }).page;
    expect(record.html).toContain('Second.');
    expect(record.history).toEqual([
      expect.objectContaining({ number: 2, action: 'edit', note: 'second', agentName: 'Ben', agentId: 'agent-a', canRestore: true }),
      expect.objectContaining({ number: 1, action: 'create', note: 'first', canRestore: true }),
    ]);

    // Put back: the person's own one step, no agent asked.
    const restored = createMockResponse();
    await getRouteHandler(deps, '/api/knowledge/pages/:name/restore', 'post')(
      mockRequest({ headers: authHeader(42), params: { name: 'deploys' }, body: {} }), restored);
    expect(restored.statusCode).toBe(200);
    const answer = restored.body as { ok: true; number: number; page: { html: string; history: Array<Record<string, unknown>> } };
    expect(answer.number).toBe(3);
    expect(answer.page.html).toContain('First.');
    expect(host.files.get('pages/deploys.html')).toContain('First.');
    expect(answer.page.history[0]).toMatchObject({ number: 3, restore: true, agentName: null });
    // And back to exactly an earlier version.
    const again = createMockResponse();
    await getRouteHandler(deps, '/api/knowledge/pages/:name/restore', 'post')(
      mockRequest({ headers: authHeader(42), params: { name: 'deploys' }, body: { to: 2 } }), again);
    expect(again.statusCode).toBe(200);
    expect(host.files.get('pages/deploys.html')).toContain('Second.');
  });

  it('refuses API calls when browser authentication is not configured', async () => {
    const { deps } = await buildDeps();
    delete deps.workspaceWebAuth;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(401);
  });

  it('lists every scope masked, with agent names resolved — and never a plaintext value', async () => {
    const { deps, secretStorage } = await buildDeps();
    const service = new UserSecretsService(secretStorage);
    await service.setSecret('user-1', 'GH_TOKEN', 'ghp_supersecret_value');
    await service.setSecret('user-1', 'NPM_TOKEN', 'npm_private_value', agentUserSecretScope('agent-a'));

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { secrets: Array<Record<string, unknown>>; repos: unknown };
    expect(body.secrets).toEqual([
      expect.objectContaining({ name: 'GH_TOKEN', scope: 'shared' }),
      expect.objectContaining({ name: 'NPM_TOKEN', scope: 'agent', agentId: 'agent-a', agentName: 'Ben' }),
    ]);
    // The load-bearing assertion: the wire never carries a value.
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
    expect(JSON.stringify(res.body)).not.toContain('npm_private_value');
    // No git deps wired → the section reads as unavailable, not as empty.
    expect(body.repos).toBeNull();
  });

  it('summarises each value by length and shape, and names who overrides a shared key', async () => {
    const { deps, secretStorage } = await buildDeps();
    const service = new UserSecretsService(secretStorage);
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    await service.setSecret('user-1', 'HETZNER_SSH_PRIVATE_KEY', key);
    await service.setSecret('user-1', 'GH_TOKEN', 'ghp_averyordinarylookingtoken');
    await service.setSecret('user-1', 'GH_TOKEN', 'ghp_leos_own_token', agentUserSecretScope('agent-a'));

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const secrets = (res.body as { secrets: Array<Record<string, unknown>> }).secrets;
    const pem = secrets.find((s) => s.name === 'HETZNER_SSH_PRIVATE_KEY');
    const shared = secrets.find((s) => s.name === 'GH_TOKEN' && s.scope === 'shared');
    // A PEM masks to "---…--" and identifies nothing; its format's name does.
    expect(pem).toMatchObject({ valueKind: 'OpenSSH private key', valueLength: [...key].length });
    // Ids never reach the screen — the workspace names the agent.
    expect(shared).toMatchObject({ valueLength: 29, maskedPreview: 'ghp…en', shadowedBy: ['Ben'] });
    expect(secrets.find((s) => s.scope === 'agent')?.shadowedBy).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('leos_own_token');
    expect(JSON.stringify(res.body)).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('writes what a secret is for, scoped, without touching the value', async () => {
    const { deps, secretStorage } = await buildDeps();
    const service = new UserSecretsService(secretStorage);
    await service.setSecret('user-1', 'ELDIYAR_PASS', 'barbarian32');

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/description', 'patch')(mockRequest({
      headers: authHeader(42),
      params: { name: 'ELDIYAR_PASS' },
      body: { description: '  Eldiyar’s   school portal login  ' },
    }), res);
    expect(res.statusCode).toBe(200);

    const listed = await service.listSecrets('user-1');
    // Whitespace collapsed by the validator; the value is exactly as it was.
    expect(listed[0]).toMatchObject({ name: 'ELDIYAR_PASS', description: 'Eldiyar’s school portal login' });
    expect(await service.getSecretValue('user-1', 'ELDIYAR_PASS')).toBe('barbarian32');
  });

  it('refuses to describe a secret that is not there in that scope, or an agent not the caller’s', async () => {
    const { deps, secretStorage } = await buildDeps();
    await new UserSecretsService(secretStorage).setSecret('user-1', 'GH_TOKEN', 'ghp_shared_value');

    // Right name, wrong scope: the shared row must not be annotated instead.
    const missing = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/description', 'patch')(mockRequest({
      headers: authHeader(42),
      params: { name: 'GH_TOKEN' },
      query: { agent: 'agent-a' },
      body: { description: 'not mine to write' },
    }), missing);
    expect(missing.statusCode).toBe(404);

    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/description', 'patch')(mockRequest({
      headers: authHeader(42),
      params: { name: 'GH_TOKEN' },
      query: { agent: 'someone-elses-agent' },
      body: { description: 'still not mine' },
    }), foreign);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toEqual({ error: 'No such agent on this account' });

    const empty = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/description', 'patch')(mockRequest({
      headers: authHeader(42),
      params: { name: 'GH_TOKEN' },
      body: { description: '   ' },
    }), empty);
    expect(empty.statusCode).toBe(400);

    // Through all of that, nothing was written.
    const listed = await new UserSecretsService(secretStorage).listSecrets('user-1');
    expect(listed[0]?.description).toBeUndefined();
  });

  it('includes repos and quota when git hosting is wired', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    // A landing the push report observed on the home branch travels to the
    // page — that is the only source the "pushed … to main" line may cite.
    await gitRepoStorage.update(doc.id, { defaultBranchPushAt: '2026-08-07T00:00:00.000Z' });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const body = res.body as { repos: Array<Record<string, unknown>>; quota: Record<string, number> };
    expect(body.repos).toEqual([expect.objectContaining({
      name: 'my-site',
      cloneUrl: 'https://git.test/user-1/my-site.git',
      sizeBytes: 2048,
      protectedBranch: 'main',
      branch: 'main',
      branchPushAt: '2026-08-07T00:00:00.000Z',
    })]);
    expect(body.quota.userUsedBytes).toBe(2048);
  });

  /**
   * Contributors. Git knows authors by email; the workspace knows agents by
   * name — and the join between them is the part that can be quietly wrong,
   * because a near-miss just shows a bare name where a face belongs.
   */
  it('GET /api/state puts a repo\'s top contributors, as agents, on its row', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    await gitRepoStorage.update(doc.id, {
      contributors: {
        sha: 'a'.repeat(40),
        countedAt: '2026-08-16T00:00:00.000Z',
        authors: [
          { name: 'Ruby', email: 'ruby@agentbuilt.app', commits: 40, insertions: 900, deletions: 100 },
          // The owner's own commits: real work, counted, but no agent and so
          // no face — the row has room for pictures, not names.
          { name: 'Owner', email: 'owner@example.com', commits: 30, insertions: 800, deletions: 90 },
          { name: 'Ben', email: 'ben@agentbuilt.app', commits: 5, insertions: 50, deletions: 5 },
        ],
      },
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const repo = (res.body as { repos: Array<Record<string, unknown>> }).repos[0]!;
    // Agents only, in the order they were counted in, each with a face — and
    // no address: a row has no room for one and no question it answers.
    expect(repo.contributors).toEqual([
      { name: 'Ruby', commits: 40, agentAvatarUrl: '/workspace/avatars/ruby' },
      { name: 'Ben', commits: 5, agentAvatarUrl: '/workspace/avatars/ben' },
    ]);
  });

  it('GET /api/repos/:name/contributors counts everyone, and backfills the record', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const asked: Array<string | undefined> = [];
    deps.gitHostClient = {
      cloneUrl: () => 'x',
      contributors: async (_u: string, _n: string, since?: string) => {
        asked.push(since);
        return {
          branch: 'main',
          tipSha: 'b'.repeat(40),
          from: null,
          authors: [
            { name: 'Ruby', email: 'ruby@agentbuilt.app', commits: 40, insertions: 900, deletions: 100 },
            { name: 'Owner', email: 'owner@example.com', commits: 30, insertions: 800, deletions: 90 },
          ],
        };
      },
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/contributors', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' } }), res,
    );
    // Everyone, not just the agents: the owner's own commits are the work of
    // this repository too, and this screen has room to name them.
    expect((res.body as { contributors: unknown[] }).contributors).toEqual([
      { name: 'Ruby', email: 'ruby@agentbuilt.app', commits: 40, insertions: 900, deletions: 100, agentId: 'agent-b', agentAvatarUrl: '/workspace/avatars/ruby' },
      // The address is what identifies this one at all — no agent, and a
      // display name anybody could share.
      { name: 'Owner', email: 'owner@example.com', commits: 30, insertions: 800, deletions: 90 },
    ]);
    // Nothing was stored before, so it asked for the whole history…
    expect(asked).toEqual([undefined]);
    // …and wrote the answer down, which is what puts faces on the row for a
    // repository nobody has pushed to since this shipped.
    expect((await gitRepoStorage.get(doc.id))?.contributors?.sha).toBe('b'.repeat(40));
  });

  it('GET /api/repos/:name/contributors shows the last count when the host is down', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const doc = await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
    });
    await gitRepoStorage.update(doc.id, {
      contributors: {
        sha: 'a'.repeat(40),
        countedAt: '2026-08-16T00:00:00.000Z',
        authors: [{ name: 'Ruby', email: 'ruby@agentbuilt.app', commits: 4, insertions: 9, deletions: 1 }],
      },
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: () => 'x',
      contributors: async () => { throw new Error('host unreachable'); },
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/contributors', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' } }), res,
    );
    // A summary is worth showing slightly stale; it is not worth an error.
    expect(res.statusCode).toBe(200);
    expect((res.body as { contributors: Array<{ name: string }> }).contributors[0]!.name).toBe('Ruby');
  });

  it('browses a repository the caller owns, passing the path through to the host', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const calls: Array<{ kind: string; user: string; name: string; path: string }> = [];
    deps.gitHostClient = {
      tree: async (user: string, name: string, path: string) => {
        calls.push({ kind: 'tree', user, name, path });
        return { branch: 'main', entries: [{ name: 'src', type: 'dir' }] };
      },
      file: async (user: string, name: string, path: string) => {
        calls.push({ kind: 'file', user, name, path });
        return { branch: 'main', sizeBytes: 12, content: 'hello world\n' };
      },
    } as unknown as GitHostClient;

    const treeRes = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/tree', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' }, query: { path: 'src' } }),
      treeRes,
    );
    expect(treeRes.statusCode).toBe(200);
    expect(treeRes.body).toMatchObject({ branch: 'main' });

    const fileRes = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/file', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' }, query: { path: 'src/app.js' } }),
      fileRes,
    );
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.body).toMatchObject({ content: 'hello world\n' });

    // The host is always addressed with the AUTHENTICATED user, never a
    // client-supplied one, and the browse path travels through untouched.
    expect(calls).toEqual([
      { kind: 'tree', user: 'user-1', name: 'my-site', path: 'src' },
      { kind: 'file', user: 'user-1', name: 'my-site', path: 'src/app.js' },
    ]);
  });

  it('opens a repository whose bytes live at an old room’s address — it belongs to the workplace (note #566)', async () => {
    // The School room screenshot of 2026-08-29 was a room-scoped lookup saying
    // "No such repository" over a healthy repo reached from another room. A
    // repository is the workplace's, so there is no room to miss it from —
    // and one whose bytes stayed at an old room's namespace when rooms went
    // (note #843) is still the workplace's. A stale `?room=` changes nothing.
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.updateOrg(org.orgId, {
      git: { namespaceId: org.orgId },
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-school'] },
    });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    deps.orgGit = new OrgGitService({ orgStorage });
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: 'ns-school', name: 'eldiyar-math', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    // Another workplace's repository stays invisible.
    await gitRepoStorage.create({
      userId: 'someone-else', name: 'theirs', createdByAgentId: 'agent-z',
      defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const asked: string[] = [];
    deps.gitHostClient = {
      tree: async (userId: string) => { asked.push(userId); return { branch: 'main', entries: [] }; },
    } as unknown as GitHostClient;
    const tree = getRouteHandler(deps, '/api/repos/:name/tree', 'get');

    for (const query of [{}, { room: 'room-from-an-old-link' }] as Array<Record<string, string>>) {
      const opened = createMockResponse();
      await tree(mockRequest({ headers: authHeader(42), params: { name: 'eldiyar-math' }, query }), opened);
      expect(opened.statusCode).toBe(200);
    }
    // The host is always asked at the address the bytes live at.
    expect(asked).toEqual(['ns-school', 'ns-school']);

    for (const name of ['theirs', 'never-was']) {
      const absent = createMockResponse();
      await tree(mockRequest({ headers: authHeader(42), params: { name }, query: {} }), absent);
      expect(absent.statusCode).toBe(404);
      expect(absent.body).toEqual({ error: 'No such repository here', code: 'no_such_repository' });
    }
  });

  it('reads a repository’s history, passing a sane limit and swallowing a junk one', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const limits: Array<number | undefined> = [];
    deps.gitHostClient = {
      log: async (_user: string, _name: string, limit?: number) => {
        limits.push(limit);
        return { branch: 'main', commits: [{ sha: 'abc123', authorName: 'Ruby', at: '2026-08-10T12:00:00Z', subject: 'first' }] };
      },
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/commits', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' }, query: { limit: '20' } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ branch: 'main' });

    // Junk in the query is not an error the screen has to render: the host's
    // own default answers instead.
    for (const limit of ['abc', '-3', '2.5', '']) {
      const junk = createMockResponse();
      await getRouteHandler(deps, '/api/repos/:name/commits', 'get')(
        mockRequest({ headers: authHeader(42), params: { name: 'my-site' }, query: { limit } }),
        junk,
      );
      expect(junk.statusCode, `limit ${JSON.stringify(limit)}`).toBe(200);
    }
    expect(limits).toEqual([20, undefined, undefined, undefined, undefined]);
  });

  /**
   * ONE commit's own diff. The sha is the other thing the client chose, so it
   * is checked the same way the repository name is — before the host is asked
   * anything at all.
   */
  it('reads one commit, and lets nothing but a sha through to the host', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 2048, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const asked: string[] = [];
    deps.gitHostClient = {
      commit: async (_user: string, _name: string, sha: string) => {
        asked.push(sha);
        return {
          sha: 'a'.repeat(40), authorName: 'Ruby', at: '2026-08-13T05:00:00Z',
          subject: 'Add the commit route', body: 'And why.', parents: ['b'.repeat(40)],
          diffStat: { files: 1, insertions: 3, deletions: 1 },
          patch: 'diff --git a/x b/x\n', patchTruncated: false,
        };
      },
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/commit/:sha', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site', sha: 'a'.repeat(40) } }), res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      subject: 'Add the commit route', diffStat: { files: 1, insertions: 3, deletions: 1 }, checks: [],
    });

    // Anything that is not a sha is refused here, so the host is never asked.
    for (const sha of ['main', 'HEAD', `${'a'.repeat(40)}^`, '../../etc/passwd', 'abc', '']) {
      const bad = createMockResponse();
      await getRouteHandler(deps, '/api/repos/:name/commit/:sha', 'get')(
        mockRequest({ headers: authHeader(42), params: { name: 'my-site', sha } }), bad,
      );
      expect(bad.statusCode, `sha ${JSON.stringify(sha)}`).toBe(400);
    }
    expect(asked).toEqual(['a'.repeat(40)]);

    // A repository that is not the caller's is not read, whatever the sha.
    const other = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/commit/:sha', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'someone-elses', sha: 'a'.repeat(40) } }), other,
    );
    expect(other.statusCode).toBe(404);
    expect(asked).toEqual(['a'.repeat(40)]);
  });

  it('refuses a history read for a repo the caller does not own — without asking the host', async () => {
    const { deps } = await buildDeps();
    deps.gitRepoStorage = new InMemoryGitRepoStorage(); // empty: user owns nothing
    let hostCalled = false;
    deps.gitHostClient = {
      log: async () => { hostCalled = true; return { branch: null, commits: [] }; },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/commits', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'someone-elses' }, query: {} }),
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(hostCalled).toBe(false);
  });

  it('refuses to browse a repo name the caller does not own — without asking the host', async () => {
    const { deps } = await buildDeps();
    deps.gitRepoStorage = new InMemoryGitRepoStorage(); // empty: user owns nothing
    let hostCalled = false;
    deps.gitHostClient = {
      tree: async () => { hostCalled = true; return { branch: null, entries: [] }; },
      file: async () => { hostCalled = true; return { branch: 'main', sizeBytes: 0 }; },
    } as unknown as GitHostClient;

    for (const path of ['/api/repos/:name/tree', '/api/repos/:name/file'] as const) {
      const res = createMockResponse();
      await getRouteHandler(deps, path, 'get')(
        mockRequest({ headers: authHeader(42), params: { name: 'someone-elses' }, query: { path: 'x' } }),
        res,
      );
      expect(res.statusCode).toBe(404);
    }
    expect(hostCalled).toBe(false);
  });

  it('needs a path to read a file', async () => {
    const { deps } = await buildDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: 'user-1', name: 'my-site', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = { file: async () => ({ branch: 'main', sizeBytes: 0 }) } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/file', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'my-site' }, query: {} }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('writes a secret at SHARED scope — the concierge surface means every agent', async () => {
    const { deps, secretStorage } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'GH_TOKEN', value: 'ghp_new' } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: true, name: 'GH_TOKEN' });
    const service = new UserSecretsService(secretStorage);
    expect(await service.getSecretEnv('user-1', 'agent-a')).toEqual({ GH_TOKEN: 'ghp_new' });
  });

  it('passes the service refusal through for an invalid name', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'PATH', value: 'x' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBeTruthy();
  });

  it('deletes by scope, never falling through between shared and agent copies', async () => {
    const { deps, secretStorage } = await buildDeps();
    const service = new UserSecretsService(secretStorage);
    await service.setSecret('user-1', 'GH_TOKEN', 'shared-copy');
    await service.setSecret('user-1', 'GH_TOKEN', 'agent-copy', agentUserSecretScope('agent-a'));

    const sharedRes = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' } }),
      sharedRes,
    );
    expect(sharedRes.statusCode).toBe(200);
    // The agent's own copy must survive a shared delete.
    expect(await service.getSecretEnv('user-1', 'agent-a')).toEqual({ GH_TOKEN: 'agent-copy' });

    const agentRes = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' }, query: { agent: 'agent-a' } }),
      agentRes,
    );
    expect(agentRes.statusCode).toBe(200);
    expect(await service.getSecretEnv('user-1', 'agent-a')).toEqual({});
  });

  it('hands the owner one value back by scope, uncacheable, for the copy button', async () => {
    const { deps, secretStorage } = await buildDeps();
    const service = new UserSecretsService(secretStorage);
    await service.setSecret('user-1', 'GH_TOKEN', 'shared-copy');
    await service.setSecret('user-1', 'GH_TOKEN', 'agent-copy', agentUserSecretScope('agent-a'));

    const sharedRes = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' } }),
      sharedRes,
    );
    expect(sharedRes.statusCode).toBe(200);
    expect(sharedRes.body).toEqual({ name: 'GH_TOKEN', value: 'shared-copy' });
    // The response body IS the secret: no cache may keep a copy of it.
    expect(sharedRes.headers['cache-control']).toBe('no-store');

    // Same name, other scope — the agent's private copy, not the shared one.
    const agentRes = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' }, query: { agent: 'agent-a' } }),
      agentRes,
    );
    expect(agentRes.body).toEqual({ name: 'GH_TOKEN', value: 'agent-copy' });
  });

  it('404s a value read for a scope that has no such secret, rather than falling through', async () => {
    const { deps, secretStorage } = await buildDeps();
    await new UserSecretsService(secretStorage).setSecret('user-1', 'GH_TOKEN', 'shared-copy');

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' }, query: { agent: 'agent-b' } }),
      res,
    );
    expect(res.statusCode).toBe(404);
    // Never the shared value as a consolation prize.
    expect(JSON.stringify(res.body)).not.toContain('shared-copy');
  });

  it('refuses a value read without a valid launch signature, and one scoped to a foreign agent', async () => {
    const { deps, secretStorage } = await buildDeps();
    await new UserSecretsService(secretStorage).setSecret('user-1', 'GH_TOKEN', 'shared-copy');

    const anonymous = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ params: { name: 'GH_TOKEN' } }),
      anonymous,
    );
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toHaveProperty('value');

    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' }, query: { agent: 'someone-elses-agent' } }),
      foreign,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('refuses a delete scoped to an agent the user does not own', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'GH_TOKEN' }, query: { agent: 'someone-elses-agent' } }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('telegram mini app routes — the Workspace agents surface', () => {
  function lifecycleMock() {
    return {
      createAgent: vi.fn().mockResolvedValue({ ok: true }),
      deleteAgent: vi.fn().mockResolvedValue({ ok: true, name: 'Ben', machine: 'destroyed', remaining: 1 }),
    };
  }

  async function buildAgentOrgDeps() {
    const built = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    built.deps.orgStorage = orgStorage;
    return { ...built, orgStorage, org };
  }

  it('a machine-ready agent whose member owner has no live seat says needs-seat, not setting-up', async () => {
    // The first real founder's shape: machine landed in their org in
    // seconds, then the row said "Setting up — a minute or two" for ten
    // minutes while the system waited for THEIR seat sign-in.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Alex', cli: 'claude', createdAt: '2026-08-24',
            serverId: 'fly_ia-bb.aa11', botStatus: 'pending',
          } as never,
        },
      } as never,
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;

    const before = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), before);
    expect((before.body as { agents: Array<{ status: string }> }).agents[0]!.status).toBe('needs-seat');
    // The New-agent chooser reads the same fact off the org card: no live
    // seat of the caller's → no provider offered without a sign-in first.
    expect((before.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual([]);

    // The seat lands → the same record reads as genuinely setting up (the
    // connect hook is what flips it to ready moments later).
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-x', label: 'max', status: 'active',
    });
    const after = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), after);
    expect((after.body as { agents: Array<{ status: string }> }).agents[0]!.status).toBe('setting-up');
    expect((after.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual(['claude']);
  });

  it('an established agent never falls back to setting-up while its failed seat still looks active', async () => {
    // Live shape from note #147: the harness has cleared connectedAt after an
    // auth failure, but the independently refreshed seat record still says
    // active. The recap proves Alex completed setup and worked before; a
    // spinning creation ring would claim progress that is not happening.
    const { deps, userStorage, orgStorage, org } = await buildAgentOrgDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', orgId: org.orgId, name: 'Alex', cli: 'claude',
            createdAt: '2026-08-01', serverId: 'fly_ia-alex.aa11',
            recap: { text: 'Finished the proposal cards.', at: '2026-08-29T10:00:00Z' },
          } as never,
        },
      } as never,
    });
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-stale', label: 'Max', status: 'active',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<{ status: string }> }).agents[0]!.status).toBe('needs-seat');
    // The seat list may still lag behind the harness failure; the agent row
    // must not inherit that lag and become a live setup animation.
    expect((res.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual(['claude']);
  });

  it('a dead seat outranks an established agent’s stale connected stamp', async () => {
    const { deps, userStorage, orgStorage, org } = await buildAgentOrgDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', orgId: org.orgId, name: 'Alex', cli: 'claude',
            createdAt: '2026-08-01', serverId: 'fly_ia-alex.aa11', connectedAt: 'old',
          } as never,
        },
      } as never,
    });
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-dead', label: 'Max', status: 'dead',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<{ status: string }> }).agents[0]!.status).toBe('needs-seat');
  });

  it('a billing-paused seat makes the agent and workplace say payment, not sign-in', async () => {
    const { deps, userStorage, orgStorage, org } = await buildAgentOrgDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', orgId: org.orgId, name: 'Alex', cli: 'claude',
            createdAt: '2026-08-01', serverId: 'fly_ia-alex.aa11', connectedAt: 'old',
          } as never,
        },
      } as never,
    });
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude', token: 'still-valid',
      label: 'Max 20x', status: 'payment_required', subscriptionStatus: 'past_due',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<{ status: string }> }).agents[0]!.status)
      .toBe('payment-required');
    expect((res.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual([]);
    expect((res.body as { org: { paymentRequiredSeatProviders: string[] } })
      .org.paymentRequiredSeatProviders).toEqual(['claude']);
  });

  it('names every seat on the org card with its own reading, ignoring dead seats’ stale ones', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;

    // No seats at all → the card says nothing about usage.
    const before = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), before);
    expect((before.body as { org: Record<string, unknown> }).org).not.toHaveProperty('seatUsage');

    // Two live seats and a dead one: every seat is named, each live one with
    // the tightest of its own windows — and the dead seat's ancient 99 must
    // not ride along as if it were a live reading.
    const low = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-a', label: 'max-a', status: 'active',
    });
    await orgStorage.updateSeat(low.seatId, {
      usage: { capturedAt: 't', windows: { five_hour: { id: 'five_hour', usedPercent: 12, windowDurationMins: 300 } } },
    });
    const high = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-b', label: 'max-b', status: 'active',
    });
    await orgStorage.updateSeat(high.seatId, {
      usage: { capturedAt: 't', windows: { five_hour: { id: 'five_hour', usedPercent: 40, windowDurationMins: 300 } } },
      modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 88.25, windowDurationMins: 10080 } },
    });
    const dead = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-c', label: 'max-c', status: 'dead',
    });
    await orgStorage.updateSeat(dead.seatId, {
      usage: { capturedAt: 't', windows: { five_hour: { id: 'five_hour', usedPercent: 99, windowDurationMins: 300 } } },
    });

    const after = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), after);
    // Each row also carries the stamp of the server's last change to that
    // subscription and its windows' full names, which the subscription's own
    // page reads to draw Home's reading instead of an older one (note #697).
    const stamp = async (seatId: string) => (await orgStorage.getSeat(seatId))!.updatedAt;
    expect((after.body as { org: { seatUsage: unknown } }).org.seatUsage).toEqual([
      // One window, nothing to tell apart: no track name (note #86).
      { seatId: low.seatId, provider: 'claude', label: 'max-a', selected: false, updatedAt: await stamp(low.seatId),
        windows: [{ label: '5 hours', usedPercent: 12, percentText: '12', windowMins: 300 }] },
      // Two tracks, so both are named — and a 88% Fable window can no longer
      // be mistaken for the whole subscription being spent.
      { seatId: high.seatId, provider: 'claude', label: 'max-b', selected: false, updatedAt: await stamp(high.seatId), windows: [
        { label: '5 hours', usedPercent: 40, percentText: '40', trackText: '5 hours', windowMins: 300 },
        { label: '7 days · Fable', usedPercent: 88.25, percentText: '88.3', trackText: 'Fable', windowMins: 10080 },
      ] },
      { seatId: dead.seatId, provider: 'claude', label: 'max-c', status: 'dead', selected: true, updatedAt: await stamp(dead.seatId), windows: [] },
    ]);
  });

  it('sends the member’s active briefing seat on the first read and live ticks', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    const seat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'codex',
      token: 'test-auth', label: 'codex-1', status: 'active',
    });
    let inUse = [seat.seatId];
    deps.agentLifecycle = {
      workspaceSeatIdsInUse: (userId, orgId) => userId === 'user-1' && orgId === org.orgId ? inUse : [],
    } as RouteDeps['agentLifecycle'];
    const request = mockRequest({ headers: authHeader(42) });
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(request, state);
    expect((state.body as { org: { activeSeatIds: string[] } }).org.activeSeatIds).toEqual([seat.seatId]);
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(request, live);
    expect((live.body as { activeSeatIds: string[] }).activeSeatIds).toEqual([seat.seatId]);
    inUse = [];
    const settled = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(request, settled);
    expect((settled.body as { activeSeatIds: string[] }).activeSeatIds).toEqual([]);
  });

  it('refreshes a stale Home usage cache once, then reuses the fresh reading', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    const seat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-a', label: 'max-a', status: 'active',
    });
    const refresh = vi.fn(async () => {
      await orgStorage.updateSeat(seat.seatId, {
        usageRefreshedAt: new Date().toISOString(),
        usage: {
          capturedAt: new Date().toISOString(),
          windows: { five_hour: { id: 'five_hour', usedPercent: 27, windowDurationMins: 300 } },
        },
      });
    });
    deps.refreshSeatUsage = refresh;
    const state = getRouteHandler(deps, '/api/state', 'get');

    const first = createMockResponse();
    await state(mockRequest({ headers: authHeader(42) }), first);
    expect((first.body as { org: { seatUsage: Array<{ windows: unknown[] }> } }).org.seatUsage[0]!.windows)
      .toEqual([{ label: '5 hours', usedPercent: 27, percentText: '27', windowMins: 300 }]);

    const second = createMockResponse();
    await state(mockRequest({ headers: authHeader(42) }), second);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('tells two Claude sign-ins apart on the card by naming each one’s plan', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    // Both seats are titled "Claude" on home, so without the plan the card
    // shows the same word twice for subscriptions four sizes apart (#142).
    const big = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-a', label: 'max-a', status: 'active',
    });
    await orgStorage.updateSeat(big.seatId, {
      usage: { capturedAt: 't', planType: 'max_20x', windows: {} },
    });
    const small = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-b', label: 'max-b', status: 'active',
    });
    await orgStorage.updateSeat(small.seatId, {
      usage: { capturedAt: 't', planType: 'max_5x', windows: {} },
    });
    // A seat read through the header probe has no plan to report — the row
    // simply says less rather than guessing at one.
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-c', label: 'max-c', status: 'active',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(((res.body as { org: { seatUsage: Array<{ planText?: string }> } }).org.seatUsage)
      .map((seat) => seat.planText)).toEqual(['Max 20x', 'Max 5x', undefined]);
  });

  it('names the all-models weekly “other models” only when a Fable track sits beside it', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    const seat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-x', label: 'solo weekly', status: 'active',
    });
    await orgStorage.updateSeat(seat.seatId, {
      usage: { capturedAt: 't', windows: {
        five_hour: { id: 'five_hour', usedPercent: 5, windowDurationMins: 300 },
        seven_day: { id: 'seven_day', usedPercent: 50, windowDurationMins: 10080 },
      } },
    });
    const alone = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), alone);
    expect(((alone.body as { org: { seatUsage: Array<{ windows: Array<{ trackText?: string }> }> } })
      .org.seatUsage)[0]!.windows.map((w) => w.trackText)).toEqual(['5 hours', 'this week']);

    // Add the Fable track and the same window becomes "other models" — the
    // name only means something in contrast to it.
    await orgStorage.updateSeat(seat.seatId, {
      modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 100, windowDurationMins: 10080 } },
    });
    const paired = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), paired);
    expect(((paired.body as { org: { seatUsage: Array<{ windows: Array<{ trackText?: string }> }> } })
      .org.seatUsage)[0]!.windows.map((w) => w.trackText)).toEqual(['5 hours', 'other models', 'Fable']);
  });

  it('GET /api/state lists the fleet with an honest status per agent, next tap included', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          // Readiness is now entirely about the agent connection. Historical
          // bot fields on a persisted record must not affect the browser UI.
          'agent-a': {
            id: 'agent-a', name: 'Ben', cli: 'claude', createdAt: '2026-01-01',
            connectedAt: 'c', botStatus: 'active', botUsername: 'ben_bot',
            model: 'fable', effort: 'medium',
          } as never,
          // A custom (renamed) name: no dog in the avatar set, so no avatarUrl.
          'agent-b': { id: 'agent-b', name: 'Rocket', cli: 'codex', createdAt: '2026-01-02', connectedAt: 'c', botStatus: 'pending' } as never,
          // Kimi is the one retired CLI left — Codex returned 2026-08-19 and
          // rides the normal status ladder like claude.
          'agent-c': { id: 'agent-c', name: 'Ada', cli: 'kimi', createdAt: '2026-01-03', connectedAt: 'c' } as never,
          'agent-d': { id: 'agent-d', name: 'Ivy', cli: 'claude', createdAt: '2026-01-04', serverId: 'fly_ia-1.aa11', oauthPendingAt: 'o', botStatus: 'pending' } as never,
          'agent-e': { id: 'agent-e', name: 'Kai', cli: 'claude', createdAt: '2026-01-05', botStatus: 'pending' } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
    };

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect(res.statusCode).toBe(200);
    // Oldest first: not one of these five has ever taken a turn, so they are
    // all in the never-used tier the list ends with, ordered by when they were
    // MADE (the ordering tests above cover the rest of that ladder). This test
    // is about the status per row, not the order.
    expect((res.body as { agents: unknown }).agents).toEqual([
      { id: 'agent-a', name: 'Ben', cli: 'claude', model: 'fable', effort: 'medium', status: 'ready', createdAt: '2026-01-01', avatarUrl: '/workspace/avatars/ben' },
      { id: 'agent-b', name: 'Rocket', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', status: 'ready', createdAt: '2026-01-02' },
      { id: 'agent-c', name: 'Ada', cli: 'kimi', status: 'retired', createdAt: '2026-01-03', avatarUrl: '/workspace/avatars/ada' },
      { id: 'agent-d', name: 'Ivy', cli: 'claude', model: 'opus', effort: 'high', status: 'needs-sign-in', createdAt: '2026-01-04', avatarUrl: '/workspace/avatars/ivy' },
      { id: 'agent-e', name: 'Kai', cli: 'claude', model: 'opus', effort: 'high', status: 'setting-up', createdAt: '2026-01-05', avatarUrl: '/workspace/avatars/kai' },
    ]);
  });

  it('GET /api/state derives what each agent is about from records that name it', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          // Two open proposals — the row leads with the ask aimed at the user.
          'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
          // A proposal AND a live site: the open question outranks the standing fact.
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
          // A live site and a served preview: the paid, named site wins.
          'agent-c': { id: 'agent-c', name: 'Leo', cli: 'claude', createdAt: '3', connectedAt: 'c', botStatus: 'active', exposedUrl: 'https://x.fly.dev' } as never,
          // Only a preview off its own machine.
          'agent-d': { id: 'agent-d', name: 'Kai', cli: 'claude', createdAt: '4', connectedAt: 'c', botStatus: 'active', exposedUrl: 'https://y.fly.dev' } as never,
          // No artifact on record at all — recency is the only honest fact.
          // (The conversation pointer is what makes the stamp count: creation
          // stamps activity too, so a stamp alone is not a use — notes #227/#264.)
          'agent-e': { id: 'agent-e', name: 'Ivy', cli: 'claude', createdAt: '5', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-e' } } as never,
        },
      } as never,
    });

    const gitRepoStorage = new InMemoryGitRepoStorage();
    const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    const repo = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a',
      sizeBytes: 0, protectDefaultBranch: true,
    });
    const proposal = (agentId: string, status = 'open' as const) => gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'T', sourceBranch: 's', targetBranch: 'main',
      headSha: 'h', diffStat: { files: 1, insertions: 1, deletions: 0 },
      commitSubjects: ['T'], createdByAgentId: agentId, status,
    });
    await proposal('agent-a');            // #1
    await proposal('agent-a');            // #2 — the newest is the one the row names
    await proposal('agent-b');            // #3
    await proposal('agent-b', 'merged' as never);  // decided: not "about" anything any more

    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-b', name: 'shop', preset: 'static', status: 'live' });
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-c', name: 'garden', preset: 'service', status: 'live' });
    // Unpaid and destroyed sites are not "runs" — nothing is serving.
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-d', name: 'draft', preset: 'static', status: 'pending-payment' });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitPullRequestStorage = gitPullRequestStorage;
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; doing?: unknown; lastActiveAt?: string }> }).agents;
    expect(Object.fromEntries(rows.map((row) => [row.name, row.doing ?? null]))).toEqual({
      Ben: { kind: 'proposal', count: 2, number: 2 },
      Ruby: { kind: 'proposal', count: 1, number: 3 },
      Leo: { kind: 'site', count: 1, host: 'garden.agentbuilt.app' },
      Kai: { kind: 'preview' },
      Ivy: null,
    });
    expect(rows.find((row) => row.name === 'Ivy')?.lastActiveAt).toBe('2026-08-15T08:00:00Z');
  });

  it('GET /api/state orders the fleet most-recently-used first, not oldest-made first', async () => {
    // The list is read to find the agent you were just talking to. In creation
    // order that agent sat wherever it was made — the screenshot that started
    // this had an agent last used four days ago holding the top row and the
    // daily driver fifth.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          // Made first, used four days ago: the row that used to be on top.
          // All three carry a turn's own trace (the native conversation the CLI
          // opened) as well as a stamp — that is what tells a used agent from
          // one whose only stamp came from being created (notes #227/#264).
          'agent-a': { id: 'agent-a', name: 'Felix', cli: 'claude', createdAt: '2026-01-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-11T09:00:00Z', conversation: { claudeSessionId: 's-a' } } as never,
          'agent-b': { id: 'agent-b', name: 'Ben', cli: 'claude', createdAt: '2026-02-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-b' } } as never,
          'agent-c': { id: 'agent-c', name: 'Leo', cli: 'claude', createdAt: '2026-03-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T17:00:00Z', conversation: { claudeSessionId: 's-c' } } as never,
          // Never took a turn, made moments ago — and it goes LAST (note #79),
          // not first. Its birthday used to stand in for a use, which made
          // "just created" the strongest claim on the top row: creating an
          // agent pushed the whole working fleet down a place for the one row
          // that could do nothing yet.
          'agent-d': { id: 'agent-d', name: 'Nova', cli: 'claude', createdAt: '2026-08-15T18:00:00Z', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<{ name: string }> }).agents.map((row) => row.name))
      .toEqual(['Leo', 'Ben', 'Felix', 'Nova']);
  });

  /**
   * Note #79, the other half: a fleet where NOBODY has taken a turn still has
   * an order, and it is the one the person watching expects — the agent made
   * first at the top, the one made moments ago on the last row, so a create
   * always appears where the placeholder that stood in for it was.
   */
  it('GET /api/state puts the newest never-used agent on the last row', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-c': { id: 'agent-c', name: 'Third', cli: 'claude', createdAt: '2026-08-15T18:00:02Z', connectedAt: 'c', botStatus: 'active' } as never,
          'agent-a': { id: 'agent-a', name: 'First', cli: 'claude', createdAt: '2026-08-15T18:00:00Z', connectedAt: 'c', botStatus: 'active' } as never,
          // Still being built — no machine yet, so its row says "Setting up".
          'agent-d': { id: 'agent-d', name: 'Newest', cli: 'claude', createdAt: '2026-08-15T18:00:03Z' } as never,
          'agent-b': { id: 'agent-b', name: 'Second', cli: 'claude', createdAt: '2026-08-15T18:00:01Z', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; status: string }> }).agents;
    expect(rows.map((row) => row.name)).toEqual(['First', 'Second', 'Third', 'Newest']);
    // The one at the bottom is the one that cannot be talked to yet.
    expect(rows[3]!.status).toBe('setting-up');
  });

  /**
   * Notes #227/#264, and the reason note #79's rule stopped holding in
   * production: creation STAMPS activity, on purpose — the idle reaper reads
   * that field and without the stamp it stops the brand-new machine at its
   * first sweep, mid sign-in. So the agent being made carries the freshest
   * stamp in the fleet, and ordering on the stamp alone put it top of the
   * list: the row that could do nothing yet, above every agent that works,
   * while the placeholder it replaced had been drawn LAST.
   *
   * Both fixtures below are the real shape — every agent has a stamp — and
   * what separates them is a turn's own trace.
   */
  it('GET /api/state keeps the agent being created last, stamped by creation though it is', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Felix', cli: 'claude', createdAt: '2026-01-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T09:00:00Z', tasks: [{ text: 'ship it', at: '2026-08-15T09:00:00Z' }] } as never,
          'agent-b': { id: 'agent-b', name: 'Ben', cli: 'claude', createdAt: '2026-02-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T17:00:00Z', recap: { text: 'merged the fix', at: '2026-08-15T17:00:00Z' } } as never,
          // Made a minute ago and stamped a minute ago BY ITS OWN CREATION.
          'agent-c': { id: 'agent-c', name: 'Nova', cli: 'claude', createdAt: '2026-08-15T18:00:00Z', lastActivityAt: '2026-08-15T18:00:30Z' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; status: string }> }).agents;
    expect(rows.map((row) => row.name)).toEqual(['Ben', 'Felix', 'Nova']);
    expect(rows[2]!.status).toBe('setting-up');
  });

  it('GET /api/state keeps a brand-new agent last once it is ready, and calls it Ready not active', async () => {
    // The other half of the same complaint: the plate does not stop being new
    // when the machine finishes. Until somebody uses it, it stays where its
    // placeholder was — last in the fleet, and last in the row a note is
    // handed from, which reads that same order.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Felix', cli: 'claude', createdAt: '2026-01-01', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T09:00:00Z', conversation: { claudeSessionId: 's-a' } } as never,
          // Signed in and idle — and never spoken to.
          'agent-c': { id: 'agent-c', name: 'Nova', cli: 'claude', createdAt: '2026-08-15T18:00:00Z', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T18:00:30Z' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; status: string; lastActiveAt?: string }> }).agents;
    expect(rows.map((row) => row.name)).toEqual(['Felix', 'Nova']);
    expect(rows[1]!.status).toBe('ready');
    // No stamp travels with it, so its line says "Ready" rather than claiming
    // it was active a minute ago — the sort and the row text agree.
    expect(rows[1]!.lastActiveAt).toBeUndefined();
    expect(rows[0]!.lastActiveAt).toBe('2026-08-15T09:00:00Z');
  });

  it('GET /api/state puts a mid-turn agent on top, and beats the hourly stamp with the live clock', async () => {
    // Two failure modes of ordering on the persisted stamp alone, which is
    // throttled to one write an hour BY DESIGN (it feeds the recycler, which
    // works in days):
    //   1. an agent mid-turn is the most recent thing there is, however old
    //      its stamp — the same rule its own row text follows;
    //   2. two agents used inside the same hour carry stamps that cannot tell
    //      them apart, and that hour is exactly the one being asked about.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-11T09:00:00Z', conversation: { claudeSessionId: 's-a' } } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-b' } } as never,
          'agent-c': { id: 'agent-c', name: 'Ivy', cli: 'claude', createdAt: '3', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-c' } } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      // Stella's stamp is four days old and she is typing right now.
      isAgentWorking: (_userId: string, agentId: string) => agentId === 'agent-a',
      // Ruby and Ivy share a stamp; only the in-memory clock knows Ivy is the
      // one that was just used.
      lastActiveAtMs: (_userId: string, agentId: string) => (
        agentId === 'agent-c' ? Date.parse('2026-08-15T08:55:00Z') : undefined
      ),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<{ name: string }> }).agents.map((row) => row.name))
      .toEqual(['Stella', 'Ivy', 'Ruby']);
  });

  it('GET /api/state lists the account’s sites — every state except destroyed, newest first', async () => {
    // The Sites section is the only place in the product where a paid site
    // can be SEEN. So it carries the ones that are not serving too: a site
    // waiting on its checkout link and one whose payment lapsed are exactly
    // the two nothing else in the app will ever mention again.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Felix', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const deploymentStorage = new InMemoryDeploymentStorage();
    const shop = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    const math = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'eldiyar-math', preset: 'service', status: 'live' });
    const draft = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'draft', preset: 'service-pro', status: 'pending-payment' });
    // Gone means gone: a tombstone is not a row.
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'old', preset: 'static', status: 'destroyed' });
    // Another account's site never appears on this one.
    await deploymentStorage.create({ userId: 'user-2', agentId: 'agent-z', name: 'stranger', preset: 'static', status: 'live' });
    // The deploy stamp is what orders the list, falling back to creation for a
    // site that has never deployed (`draft` — nothing has been uploaded to a
    // site nobody has paid for yet).
    await deploymentStorage.update(shop.id, { lastDeployAt: '2026-08-15T09:00:00Z' });
    await deploymentStorage.update(math.id, { lastDeployAt: '2026-08-15T11:00:00Z' });
    await deploymentStorage.update(draft.id, { createdAt: '2026-08-15T08:00:00Z' });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const sites = (res.body as { sites: Array<Record<string, unknown>> }).sites;
    expect(sites.map((s) => s.name)).toEqual(['eldiyar-math', 'shop', 'draft']);
    // No room field: a site is the workplace's (note #923).
    expect(sites[0]).toEqual({
      name: 'eldiyar-math',
      url: 'https://eldiyar-math.agentbuilt.app',
      iconUrl: '/workspace/site-icon/eldiyar-math',
      preset: 'service',
      status: 'live',
      kind: 'service',
      agentName: 'Felix',
      // The deploying agent's face, beside the name the row already carried,
      // and the door behind that face (note #640).
      agentAvatarUrl: '/workspace/avatars/felix',
      agentId: 'agent-a',
      createdAt: expect.any(String),
      lastDeployAt: '2026-08-15T11:00:00Z',
    });
    // Only a serving site is offered one: there is nothing behind the address
    // of a site that has not been built, so asking for its icon is a fetch
    // that can only fail.
    expect(sites[2]!.iconUrl).toBeUndefined();
    // The KIND rides with the row — which of the plan's two allowances the
    // site sits in. There is no price here at all since hosting joined the
    // plan: the Workspace inventing a monthly charge would be worse than the
    // two surfaces disagreeing about one, which is what this used to guard.
    expect(sites.map((s) => s.kind)).toEqual(['service', 'static', 'service']);
    expect(sites[2]).toMatchObject({ name: 'draft', status: 'pending-payment' });
  });

  it('an agent\'s delete ask rides the site row, with the name of who asked', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Felix', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
      deleteAsk: { byAgentId: 'agent-a', at: '2026-08-17T10:00:00Z' },
    });
    // Asked by an agent the account no longer has: the ask still stands, and
    // the screen says "An agent" rather than an id nobody can read.
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'garden', preset: 'service', status: 'live',
      deleteAsk: { byAgentId: 'agent-vanished', at: '2026-08-17T11:00:00Z' },
    });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const sites = (res.body as { sites: Array<Record<string, unknown>> }).sites;
    const shop = sites.filter((s) => s.name === 'shop')[0]!;
    expect(shop.deleteAsk).toEqual({ at: '2026-08-17T10:00:00Z', byAgentName: 'Felix', canDecide: true });
    const garden = sites.filter((s) => s.name === 'garden')[0]!;
    expect(garden.deleteAsk).toEqual({ at: '2026-08-17T11:00:00Z', canDecide: false });
  });

  it('DELETE /api/sites takes it down, frees the slot, and tells the agent that asked', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    const shop = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
      deleteAsk: { byAgentId: 'agent-a', at: '2026-08-17T10:00:00Z' },
    });
    const destroy = vi.fn(async (id: string) => {
      await deploymentStorage.update(id, { status: 'destroyed', destroyedAt: '2026-08-17T12:00:00Z' });
    });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = {
      url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`, destroy,
    } as never;
    const notify = vi.fn(async () => {});
    deps.notifySiteDeleteDecision = notify;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'shop' } }), res);

    expect(res.statusCode).toBe(200);
    expect(destroy).toHaveBeenCalledWith(shop.id);
    // A tombstone, not a deletion: the record is what keeps the address
    // reserved to this account.
    const after = (await deploymentStorage.get(shop.id))!;
    expect(after.status).toBe('destroyed');
    expect(after.name).toBe('shop');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-a', siteName: 'shop', decision: 'deleted',
    }));
  });

  it('DELETE /api/sites refuses another account\'s site and an already-dead one', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-2', agentId: 'agent-z', name: 'stranger', preset: 'static', status: 'live' });
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'gone', preset: 'static', status: 'destroyed' });
    const destroy = vi.fn(async () => {});
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`, destroy } as never;

    for (const name of ['stranger', 'gone']) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/sites/:name', 'delete')(
        mockRequest({ headers: authHeader(42), params: { name } }), res);
      expect(res.statusCode).toBe(404);
    }
    expect(destroy).not.toHaveBeenCalled();
  });

  it('a host that will not answer deletes nothing and says so', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    const shop = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
    });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = {
      url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`,
      destroy: vi.fn(async () => { throw new Error('fly is down'); }),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'shop' } }), res);

    expect(res.statusCode).toBe(502);
    // Still serving, and still on the list — the screen must not report a
    // delete that did not happen.
    expect((await deploymentStorage.get(shop.id))!.status).toBe('live');
  });

  it('GET /api/sites/costs prices each site from its machine and disks (note #993)', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'service', status: 'live',
      flyApp: 'iapp-shop', machineId: 'm1', volumeId: 'v1',
    });
    await deploymentStorage.create({ userId: 'user-2', agentId: 'agent-z', name: 'stranger', preset: 'static', status: 'live', flyApp: 'iapp-x', machineId: 'm9' });
    const readInfrastructure = vi.fn(async () => ({
      machines: [{ id: 'm1', state: 'started', config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, mounts: [{ volume: 'v1' }] } }],
      volumes: [{ id: 'v1', size_gb: 3 }, { id: 'v2', size_gb: 3 }],
    }));
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`, readInfrastructure } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/sites/costs', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { sites: Array<Record<string, unknown>>; monthlyUsd: number; unread: number; disclaimer: string };
    // Only this account's site, and nothing read for anybody else's.
    expect(body.sites.map((s) => s.name)).toEqual(['shop']);
    expect(readInfrastructure).toHaveBeenCalledTimes(1);
    expect(body.sites[0]).toMatchObject({ read: true, preset: 'service', spareDisks: [{ sizeGb: 3 }] });
    expect(body.monthlyUsd).toBe(body.sites[0]!.monthlyUsd);
    expect(body.unread).toBe(0);
    expect(body.disclaimer).toMatch(/estimate/i);
  });

  it('POST /api/sites/:name/keep clears the ask and tells the agent', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    const shop = await deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
      deleteAsk: { byAgentId: 'agent-a', at: '2026-08-17T10:00:00Z' },
    });
    deps.deploymentStorage = deploymentStorage;
    const notify = vi.fn(async () => {});
    deps.notifySiteDeleteDecision = notify;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name/keep', 'post')(
      mockRequest({ headers: authHeader(42), params: { name: 'shop' } }), res);

    expect(res.statusCode).toBe(200);
    expect((await deploymentStorage.get(shop.id))!.deleteAsk).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ decision: 'kept' }));

    // A second tap on a slow connection answers the state rather than an
    // error, and wakes nobody twice.
    notify.mockClear();
    const again = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name/keep', 'post')(
      mockRequest({ headers: authHeader(42), params: { name: 'shop' } }), again);
    expect(again.statusCode).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it('GET /site-icon serves the site\'s own favicon, cached and sandboxed', async () => {
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://shop.agentbuilt.app/favicon.ico'
        ? new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response('<html><head><title>Shop</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    ));
    deps.siteFavicons = new SiteFavicons({ fetchImpl: fetchImpl as never });

    const res = createMockResponse();
    await getRouteHandler(deps, '/site-icon/:name', 'get')(mockRequest({ params: { name: 'shop' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('image/png');
    expect(Buffer.isBuffer(res.sentBody) && res.sentBody.equals(PNG_BYTES)).toBe(true);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers.etag).toMatch(/^".+"$/);
    // An icon is someone else's file served from this backend's origin, so it
    // is served as something that cannot be anything but a picture.
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Unauthenticated on purpose — an <img> cannot carry initData — so it is
    // reached with no Authorization header at all, as above.
  });

  it('GET /site-icon fetches nothing at all for a name that is not a live site', async () => {
    // The whole reason this route is safe to leave unauthenticated: the name
    // is resolved against deployment storage FIRST, so it can never be talked
    // into making a request on someone's behalf.
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    const shop = await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'draft', preset: 'static', status: 'pending-payment' });
    await deploymentStorage.update(shop.id, { name: 'bazaar', formerNames: ['shop'] });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;
    const fetchImpl = vi.fn(async () => new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
    deps.siteFavicons = new SiteFavicons({ fetchImpl: fetchImpl as never });

    for (const name of [
      'draft', // paid for but not serving yet
      'shop', // a former name: an address that redirects, not a site
      'never-deployed',
      '../../etc/passwd',
      'UPPER',
    ]) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/site-icon/:name', 'get')(mockRequest({ params: { name } }), res);
      expect(res.statusCode, name).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GET /site-icon answers 404 when the site has no icon we can use', async () => {
    // A miss must not become a broken image in the row: the page only swaps
    // the globe out when real pixels arrive.
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;
    deps.siteFavicons = new SiteFavicons({
      fetchImpl: (async () => new Response('not found', { status: 404 })) as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/site-icon/:name', 'get')(mockRequest({ params: { name: 'shop' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/state sends sites: null when the backend has no deployment storage', async () => {
    // Null, not [] — "this backend cannot host" and "you have no sites" are
    // different facts, and the section is silent either way.
    const { deps } = await buildDeps();
    delete deps.deploymentStorage;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect((res.body as { sites: unknown }).sites).toBeNull();
  });

  it('GET /api/state names no agent on a site whose agent is gone', async () => {
    // An id on screen says less than silence, and an agent can be deleted
    // while the site it deployed keeps serving.
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-deleted', name: 'orphan', preset: 'static', status: 'live' });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const sites = (res.body as { sites: Array<Record<string, unknown>> }).sites;
    expect(sites).toHaveLength(1);
    expect(sites[0]!.agentName).toBeUndefined();
    // And no face either: an agent the account no longer has leaves the row
    // its name and its address, and nothing pointing at a picture.
    expect(sites[0]!.agentAvatarUrl).toBeUndefined();
    expect(sites[0]!.url).toBe('https://orphan.agentbuilt.app');
  });

  it('GET /api/state keeps the site row nameless of a URL when no deployment service is wired', async () => {
    // The apps domain lives in the service. Without it the row still has the
    // site's name — what it must never have is half a link.
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({ userId: 'user-1', agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live' });
    deps.deploymentStorage = deploymentStorage;
    delete deps.deploymentService;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const sites = (res.body as { sites: Array<Record<string, unknown>> }).sites;
    expect(sites[0]).toMatchObject({ name: 'shop', status: 'live' });
    expect(sites[0]!.url).toBeUndefined();
  });

  it('GET /api/state asks the run registry who is working, rather than reading the stamp', async () => {
    // The stamp is written at most once an HOUR (it was built for the
    // recycler), so it cannot answer "now" — an agent mid-turn showed
    // "Active 35m ago". The live signal is a synchronous in-memory lookup,
    // asked once per agent while the list is built.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-a' } } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active', lastActivityAt: '2026-08-15T08:00:00Z', conversation: { claudeSessionId: 's-b' } } as never,
        },
      } as never,
    });
    const isAgentWorking = vi.fn((_userId: string, agentId: string) => agentId === 'agent-a');
    deps.agentLifecycle = { ...(deps.agentLifecycle ?? {}), isAgentWorking } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; working?: boolean; lastActiveAt?: string }> }).agents;
    expect(rows.find((row) => row.name === 'Stella')?.working).toBe(true);
    // Absent, not `false`: a row that is not working says nothing extra.
    expect(rows.find((row) => row.name === 'Ruby')?.working).toBeUndefined();
    // The stamp still travels — it is what an idle row falls back to.
    expect(rows.find((row) => row.name === 'Ruby')?.lastActiveAt).toBe('2026-08-15T08:00:00Z');
    expect(isAgentWorking).toHaveBeenCalledWith('user-1', 'agent-a');
  });

  it('GET /api/state says WHAT the running turn is doing, from the first paint', async () => {
    // The same pair the agent chat puts on its newest message. Sent with the
    // state rather than left to the live poll: an app that opens saying
    // "Working now" and only names the job five seconds later was guessing.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (_userId: string, agentId: string) => agentId === 'agent-a',
      // Ruby is idle, and the registry says so with a null — a row that is not
      // working must never carry a tool line from a turn that already ended.
      agentActivity: (_userId: string, agentId: string) => (agentId === 'agent-a'
        ? { activity: 'Bash: npm run build', startedAt: Date.parse('2026-08-16T09:00:00Z') }
        : null),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows.find((row) => row.name === 'Stella')).toMatchObject({
      working: true,
      activity: 'Bash: npm run build',
      // ISO, not epoch millis: the page's stopwatch parses dates.
      activitySince: '2026-08-16T09:00:00.000Z',
    });
    expect(rows.find((row) => row.name === 'Ruby')?.activity).toBeUndefined();
  });

  it('GET /api/state carries each agent version card, so its screen opens already drawn', async () => {
    // Note #102. The agent screen used to open on "Checking…" every time the
    // Workspace was opened, because the only cache lived in a page that
    // reloads. The facts ride the state read the app already makes.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const agentVersionSeeds = vi.fn().mockResolvedValue({
      'agent-a': {
        cliLabel: 'Claude Code', installed: '2.1.219', cliUpdateAvailable: false,
        busy: false, turnCount: 7,
      },
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}), agentVersionSeeds,
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows[0]!.version).toEqual({
      cliLabel: 'Claude Code', installed: '2.1.219', cliUpdateAvailable: false,
      busy: false, turnCount: 7,
    });
    // ONE call for the whole fleet, handed the records this request already
    // read — not one round trip per agent row.
    expect(agentVersionSeeds).toHaveBeenCalledTimes(1);
    expect(agentVersionSeeds.mock.calls[0]![0]).toBe('user-1');
    expect((agentVersionSeeds.mock.calls[0]![1] as Array<{ id: string }>).map((a) => a.id))
      .toEqual(['agent-a']);
  });

  it('GET /api/state names each agent’s machine off the record, and omits an unread one', async () => {
    // Note #356. The fleet list says what every agent runs ON. It comes off
    // the record because this read's standing rule is that it costs no
    // machine reads — and it is OMITTED rather than filled in from the fleet
    // default, so a blank line means "nobody has looked", never "standard".
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c',
            machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
            machineSizeAt: '2026-09-06T07:00:00.000Z',
          } as never,
          'agent-b': { id: 'agent-b', name: 'Nova', cli: 'claude', createdAt: '2', connectedAt: 'c' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('agent-a')!.machineSize).toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 4096 });
    expect(byId.get('agent-b')).not.toHaveProperty('machineSize');
    // The stamp is bookkeeping, not something any screen shows.
    expect(byId.get('agent-a')).not.toHaveProperty('machineSizeAt');
  });

  it('GET /api/state seeds each agent’s last reply too, and survives without it', async () => {
    // Note #155. The details screen's Last reply used to be fetched on every
    // open, and the Mini App reloads every time it is opened — so the open
    // that happens most, the first tap after opening the Workspace, always
    // showed the gap before the words. This is the same bargain the version
    // card makes: paint on open, refresh underneath.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const agentChatReplySeeds = vi.fn().mockResolvedValue({
      'agent-a': { text: 'Deployed and checked.', at: '2026-08-30T12:00:00.000Z' },
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}), agentChatReplySeeds,
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('agent-a')!.lastReply)
      .toEqual({ text: 'Deployed and checked.', at: '2026-08-30T12:00:00.000Z' });
    // An agent with nothing to seed carries no field at all rather than an
    // empty one: absence is what tells the screen to read for itself.
    expect(byId.get('agent-b')!.lastReply).toBeUndefined();
    // ONE call for the whole fleet, on the records this request already read.
    expect(agentChatReplySeeds).toHaveBeenCalledTimes(1);
    expect(agentChatReplySeeds.mock.calls[0]![0]).toBe('user-1');
    expect((agentChatReplySeeds.mock.calls[0]![1] as Array<{ id: string }>).map((a) => a.id).sort())
      .toEqual(['agent-a', 'agent-b']);

    // And a seed that throws is not the account's Workspace failing to load.
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      agentChatReplySeeds: vi.fn().mockRejectedValue(new Error('chat store unreadable')),
    } as never;
    const second = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), second);
    const after = (second.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(after.find((row) => row.id === 'agent-a')!.lastReply).toBeUndefined();
    expect(after.find((row) => row.id === 'agent-a')!.name).toBe('Stella');
  });

  it('GET /api/state carries the recorded count of running background jobs, absent at zero', async () => {
    // Note #564: the count is read off the record — the state read never
    // reaches into a machine for it.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active', activeJobs: { count: 2, at: 't' } } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows.find((row) => row.id === 'agent-a')!.activeJobs).toBe(2);
    expect(rows.find((row) => row.id === 'agent-b')).not.toHaveProperty('activeJobs');
  });

  it('GET /api/state carries each agent’s last-message files, and survives without them', async () => {
    // Note #553: the plate shows the pictures an agent just sent, so the
    // state read seeds them the way it seeds the last reply — one call for
    // the fleet, absent rather than empty, never a reason to fail.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    const files = [{ id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 10, width: 4, height: 3 }];
    const agentChatLastFiles = vi.fn().mockResolvedValue({ 'agent-a': files, 'agent-b': [] });
    deps.agentLifecycle = { ...(deps.agentLifecycle ?? {}), agentChatLastFiles } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('agent-a')!.lastFiles).toEqual(files);
    expect(byId.get('agent-b')).not.toHaveProperty('lastFiles');
    expect(agentChatLastFiles).toHaveBeenCalledTimes(1);
    expect((agentChatLastFiles.mock.calls[0]![1] as Array<{ id: string }>).map((a) => a.id).sort())
      .toEqual(['agent-a', 'agent-b']);

    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      agentChatLastFiles: vi.fn().mockRejectedValue(new Error('chat store unreadable')),
    } as never;
    const second = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), second);
    const after = (second.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(after.find((row) => row.id === 'agent-a')).not.toHaveProperty('lastFiles');
    expect(after.find((row) => row.id === 'agent-a')!.name).toBe('Stella');
  });

  it('GET /api/state still answers when the version seeds cannot be built', async () => {
    // A seed is an optimisation. If it throws, the account's whole Workspace
    // must not fail to load with it — the screen falls back to asking for
    // itself, which is exactly what it did before there were seeds.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': { id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      agentVersionSeeds: vi.fn().mockRejectedValue(new Error('pins unreadable')),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows[0]!.name).toBe('Stella');
    expect(rows[0]!.version).toBeUndefined();
  });

  it('GET /api/agents/live answers the tick without re-reading the whole account', async () => {
    // The tail on a working row changes by the second; the state payload
    // behind it carries every repo, secret, proposal and CI verdict the
    // account has. This endpoint exists so the first can be refreshed without
    // paying for the second — one profile read and an in-memory lookup.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active',
            recap: { text: 'Investigating the failed backup.', at: '2026-08-16T09:01:00Z' },
          } as never,
          'agent-b': {
            id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active',
            recap: { text: 'Restored and verified the backup.', at: '2026-08-16T09:02:00Z' },
            sessionLimit: {
              hitAt: '2026-08-16T09:03:00.000Z',
              resetAt: '2099-01-01T12:34:00.000Z',
            },
          } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (_userId: string, agentId: string) => agentId === 'agent-a',
      // Started, but no tool called yet: working with nothing to name, which
      // the row shows as the clock alone.
      agentActivity: () => ({ startedAt: Date.parse('2026-08-16T09:00:00Z') }),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), res);

    // Only the working ones travel in `agents` — anything absent there is
    // idle, and the page reads a change in that SET as "re-read the whole
    // state once". Recaps travel separately for every agent: the final one is
    // written after an agent has already left the working set.
    expect(res.body).toEqual({
      agents: [{ id: 'agent-a', working: true, activitySince: '2026-08-16T09:00:00.000Z' }],
      recaps: [
        { id: 'agent-a', recap: 'Investigating the failed backup.', recapAt: '2026-08-16T09:01:00Z' },
        { id: 'agent-b', recap: 'Restored and verified the backup.', recapAt: '2026-08-16T09:02:00Z' },
      ],
      sessionLimits: [{
        id: 'agent-b',
        hitAt: '2026-08-16T09:03:00.000Z',
        resetAt: '2099-01-01T12:34:00.000Z',
        resetsText: 'Jan 1, 12:34 UTC',
        resumeReady: false,
      }],
      jobs: [],
      finished: [],
    });
  });

  it('GET /api/agents/live carries the durable job count, so a plate follows it with no full read', async () => {
    // Note #588: the count is recorded whenever the backend looks at a
    // machine — at the end of every turn — but an open room list only ever
    // re-read it on a navigation, which is why a running job seemed to exist
    // only once its chat had been opened. It rides the tick now, off the same
    // record, touching no machine.
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active',
            activeJobs: { count: 2, at: '2026-09-20T09:00:00Z' },
          } as never,
          'agent-b': {
            id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active',
          } as never,
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: () => false,
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), res);

    // Absent at zero, exactly as the full state read has it: an agent running
    // nothing is not a row saying nothing is running.
    expect((res.body as { jobs: unknown }).jobs).toEqual([{ id: 'agent-a', count: 2 }]);
  });

  /**
   * Note #707: the summarizer's FINISHED verdict reaches the page only while it
   * is newer than the agent's last turn end — a summary that failed leaves the
   * previous turn's verdict on the record, and it says nothing about the turn
   * after — and never while a turn runs. Both reads say the same.
   */
  it('GET /api/state carries the Workspace Agent\'s ask to remove an agent, and POST /api/agents/:id/keep takes it off (note #710)', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          asked: { id: 'asked', name: 'Oscar', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active', removeAsk: { byAgentId: 'workspace-x', byUserId: 'user-1', at: '2026-10-09T10:00:00.000Z', reason: 'its work is finished' } },
          plain: { id: 'plain', name: 'Noah', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active' },
        },
      } as never,
    });
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const rows = (state.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows.find((row) => row.id === 'asked')!.removeAsk).toEqual({
      at: '2026-10-09T10:00:00.000Z', canDecide: true, byAgentName: 'Workspace Agent', reason: 'its work is finished',
    });
    expect(rows.find((row) => row.id === 'plain')!.removeAsk).toBeUndefined();

    const kept = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/keep', 'post')(mockRequest({ headers: authHeader(42), params: { id: 'asked' } }), kept);
    expect(kept.statusCode).toBe(200);
    expect(kept.body).toEqual({ ok: true, name: 'Oscar' });
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!.asked!.removeAsk).toBeUndefined();
    const again = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), again);
    expect((again.body as { agents: Array<Record<string, unknown>> }).agents.find((row) => row.id === 'asked')!.removeAsk).toBeUndefined();
    // Somebody else's id: refused before anything is written.
    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/keep', 'post')(mockRequest({ headers: authHeader(42), params: { id: 'agent-of-someone-else' } }), foreign);
    expect(foreign.statusCode).toBe(404);
  });

  it('GET /api/state and /api/agents/live carry `finished` only while the verdict outdates the last turn', async () => {
    const { deps, userStorage } = await buildDeps();
    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active', ...extra,
    });
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          fresh: agent('fresh', 'Oscar', { lastTurnEndedAt: '2026-10-08T10:00:00Z', workFinishedAt: '2026-10-08T10:00:30Z' }),
          stale: agent('stale', 'Noah', { lastTurnEndedAt: '2026-10-08T11:00:00Z', workFinishedAt: '2026-10-08T10:00:30Z' }),
          busy: agent('busy', 'Iris', { lastTurnEndedAt: '2026-10-08T10:00:00Z', workFinishedAt: '2026-10-08T10:00:30Z' }),
          never: agent('never', 'Ada', { lastTurnEndedAt: '2026-10-08T10:00:00Z' }),
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (_user: string, id: string) => id === 'busy',
    } as never;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const rows = (state.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(rows.filter((row) => row.finished).map((row) => row.id)).toEqual(['fresh']);
    expect(rows.find((row) => row.id === 'fresh')!.finished).toBe(true);

    const live = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), live);
    expect((live.body as { finished: unknown }).finished).toEqual(['fresh']);
  });

  /**
   * Note #707: the room's "Reset finished agents". The page names the agents
   * it showed; each is judged again here and only the ones still safe are
   * sent the owner's own "reset chat" — the rest come back by name, with the
   * reason, and nothing is sent to them.
   */
  describe('POST /api/agents/fresh-chats', () => {
    const reading = { tokens: 300_000, window: 1_000_000, at: '2026-10-08T10:00:00Z' };
    const finished = { lastTurnEndedAt: '2026-10-08T10:00:00Z', workFinishedAt: '2026-10-08T10:00:30Z' };
    const setup = async (extra: { prsFail?: boolean } = {}) => {
      const { deps, userStorage } = await buildDeps();
      const agent = (id: string, name: string, more: Record<string, unknown> = {}) => ({
        id, name, cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active',
        contextUsage: reading, ...finished, ...more,
      });
      await userStorage.updateProfile('user-1', {
        telegram: {
          chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
          agents: {
            oscar: agent('oscar', 'Oscar'),
            ada: agent('ada', 'Ada'),
            iris: agent('iris', 'Iris'),
            noah: agent('noah', 'Noah', { workFinishedAt: undefined }),
            rosa: agent('rosa', 'Rosa'),
            theo: agent('theo', 'Theo'),
            alex: agent('alex', 'Alex', { contextUsage: undefined }),
            clara: agent('clara', 'Clara', { activeJobs: { count: 1, at: 't' } }),
          },
        } as never,
      });
      const gitRepoStorage = new InMemoryGitRepoStorage();
      const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
      const repo = await gitRepoStorage.create({
        userId: 'user-1', name: 'api', createdByAgentId: 'rosa', sizeBytes: 0, protectDefaultBranch: true,
      });
      // A DRAFT counts too: the agent has not finished proposing.
      await gitPullRequestStorage.create({
        repoId: repo.id, userId: 'user-1', title: 'T', sourceBranch: 's', targetBranch: 'main',
        headSha: 'h', diffStat: { files: 1, insertions: 1, deletions: 0 },
        commitSubjects: ['T'], createdByAgentId: 'rosa', status: 'open', draft: true,
      } as never);
      // Decided: not waiting on anything any more.
      await gitPullRequestStorage.create({
        repoId: repo.id, userId: 'user-1', title: 'T', sourceBranch: 's2', targetBranch: 'main',
        headSha: 'h', diffStat: { files: 1, insertions: 1, deletions: 0 },
        commitSubjects: ['T'], createdByAgentId: 'oscar', status: 'merged',
      } as never);
      deps.gitRepoStorage = gitRepoStorage;
      deps.gitPullRequestStorage = extra.prsFail
        ? { listOpenByUser: vi.fn().mockRejectedValue(new Error('down')) } as never
        : gitPullRequestStorage;
      const notes = new InMemoryQuickNoteStorage();
      const note = await notes.create({
        userId: 'user-1', html: '<p>Work</p>', createdByAgentId: 'user', updatedByAgentId: 'user',
      });
      await notes.claim(note.id, { agentId: 'theo', userId: 'user-1', agentName: 'Theo' }, new Date());
      deps.quickNoteStorage = notes;
      const messageAgentFromUser = vi.fn(async ({ agentId }: { agentId: string }) => (agentId === 'ada'
        ? { ok: false, code: 'busy', reason: 'Ada is working right now.' }
        : { ok: true, recipient: { id: agentId, name: agentId === 'oscar' ? 'Oscar' : agentId, cli: 'claude' } }));
      deps.agentLifecycle = {
        ...lifecycleMock(),
        messageAgentFromUser,
        isAgentWorking: (_user: string, id: string) => id === 'iris',
      } as never;
      const press = async (body: unknown) => {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/fresh-chats', 'post')(mockRequest({ headers: authHeader(42), body }), res);
        return res;
      };
      return { press, messageAgentFromUser };
    };

    it('asks only the agents still safe, with the owner\'s own words, and names the rest with a reason', async () => {
      const { press, messageAgentFromUser } = await setup();
      const res = await press({
        agentIds: ['oscar', 'ada', 'iris', 'noah', 'rosa', 'theo', 'alex', 'clara', 'agent-of-someone-else'],
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        asked: [{ id: 'oscar', name: 'Oscar' }],
        skipped: [
          // Safe when the page drew it, busy by the time the message went.
          { id: 'ada', name: 'Ada', reason: 'is working right now' },
          { id: 'iris', name: 'Iris', reason: 'is working right now' },
          { id: 'noah', name: 'Noah', reason: 'has work that is not finished' },
          { id: 'rosa', name: 'Rosa', reason: 'has a proposal waiting' },
          { id: 'theo', name: 'Theo', reason: 'is holding a note it works from' },
          { id: 'alex', name: 'Alex', reason: 'has no conversation to clear' },
          { id: 'clara', name: 'Clara', reason: 'has a background job running' },
          { id: 'agent-of-someone-else', reason: 'is no longer on this account' },
        ],
      });
      // Nothing reached an agent the records said to leave alone.
      expect(messageAgentFromUser.mock.calls.map(([args]) => args)).toEqual([
        { userId: 'user-1', agentId: 'oscar', message: 'reset chat' },
        { userId: 'user-1', agentId: 'ada', message: 'reset chat' },
      ]);
    });

    it('refuses a body that names nobody', async () => {
      const { press, messageAgentFromUser } = await setup();
      for (const body of [{}, { agentIds: [] }, { agentIds: 'oscar' }, { agentIds: [42] }, { agentIds: [''] }]) {
        expect((await press(body)).statusCode).toBe(400);
      }
      expect(messageAgentFromUser).not.toHaveBeenCalled();
    });

    it('resets nobody on a guess when the open proposals cannot be read', async () => {
      const { press, messageAgentFromUser } = await setup({ prsFail: true });
      const res = await press({ agentIds: ['oscar'] });
      expect(res.statusCode).toBe(503);
      expect((res.body as { error: string }).error).toContain('Nothing was sent');
      expect(messageAgentFromUser).not.toHaveBeenCalled();
    });
  });

  it('GET /api/agents/live carries active note claims without sending note contents', async () => {
    const { deps } = await buildDeps();
    const notes = new InMemoryQuickNoteStorage();
    const note = await notes.create({
      userId: 'user-1', html: '<p>Private request words</p>',
      createdByAgentId: 'user', updatedByAgentId: 'user',
    });
    const claimed = await notes.claim(note.id, {
      agentId: 'agent-a', userId: 'user-1', agentName: 'Ben',
    }, new Date());
    deps.quickNoteStorage = notes;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), res);

    // The same shape the full read puts on the row, face included, so a
    // tick with nothing new compares equal to it (2026-09-23).
    expect((res.body as { noteClaims: unknown }).noteClaims).toEqual([{
      id: note.id,
      work: {
        state: 'working', agentName: 'Ben', agentAvatarUrl: '/workspace/avatars/ben', agentId: 'agent-a',
        expiresAt: claimed!.claim.expiresAt,
      },
    }]);
    // The tick carries ownership, never the note's private body.
    expect(JSON.stringify((res.body as { noteClaims: unknown }).noteClaims)).not.toContain('Private request words');
  });

  it('GET /api/agents/live keeps an unstamped legacy agent in its historical org', async () => {
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Historical', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (_userId: string, agentId: string) => agentId === 'agent-a',
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect(res.body).toEqual({
      agents: [{ id: 'agent-a', working: true }],
      recaps: [],
      sessionLimits: [],
      jobs: [],
      finished: [],
      teamWorking: [],
      workplaceDeleting: false,
    });
  });

  it('GET /api/state derives an actionable session-limit view once resetAt has passed', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Stella', cli: 'claude', createdAt: '1', connectedAt: 'c',
            botStatus: 'active',
            sessionLimit: {
              hitAt: '2000-01-01T11:30:00.000Z',
              resetAt: '2000-01-01T12:34:00.000Z',
            },
          } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const agent = (res.body as { agents: Array<Record<string, unknown>> }).agents[0]!;
    expect(agent.sessionLimit).toEqual({
      hitAt: '2000-01-01T11:30:00.000Z',
      resetAt: '2000-01-01T12:34:00.000Z',
      resetsText: 'Jan 1, 12:34 UTC',
      resumeReady: true,
    });
  });

  it('GET /api/state sends the recap, seeding only a legacy task until the summarizer visits', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          // A summarizer-visited agent: the stored recap wins, stamped.
          'agent-a': {
            id: 'agent-a', name: 'Ben', cli: 'claude', createdAt: '1', connectedAt: 'c',
            botStatus: 'active', about: 'Keeps the garden game', exposedUrl: 'https://x.fly.dev',
            recap: { text: 'Keeps the garden game — shipped the watering timer.', at: '2026-08-25T08:00:00Z' },
          } as never,
          // A legacy agent: its own last task line seeds the recap; the old
          // description is no longer useful now that agents live in rooms.
          'agent-b': {
            id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active',
            about: 'Prices the ladders',
            tasks: [
              { text: 'Read the site again', at: '2026-08-16T09:00:00Z' },
              { text: 'rewrote the pricing hero — proposed as #36', at: '2026-08-16T08:00:00Z', byAgent: true },
            ],
          } as never,
          // Nothing at all: no recap key, and the page falls back to facts.
          'agent-c': { id: 'agent-c', name: 'Kai', cli: 'claude', createdAt: '3', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; recap?: string; recapAt?: string; doing?: unknown }> }).agents;
    const ben = rows.find((row) => row.name === 'Ben');
    expect(ben?.recap).toBe('Keeps the garden game — shipped the watering timer.');
    expect(ben?.recapAt).toBe('2026-08-25T08:00:00Z');
    expect(ben?.doing).toEqual({ kind: 'preview' });
    // The seed carries the authored task but not the description, and has no
    // stamp — a composed line has no honest "when", so the page shows none.
    const ruby = rows.find((row) => row.name === 'Ruby');
    expect(ruby?.recap).toBe('rewrote the pricing hero — proposed as #36');
    expect(ruby?.recapAt).toBeUndefined();
    expect(rows.find((row) => row.name === 'Kai')?.recap).toBeUndefined();
  });

  it('GET /api/state sends the newest job as the NOW line, stamped', async () => {
    const { deps, userStorage } = await buildDeps();
    const task = (text: string, at: string) => ({ text, at });
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-a': {
            id: 'agent-a', name: 'Ben', cli: 'claude', createdAt: '1', connectedAt: 'c', botStatus: 'active',
            tasks: [
              task('Find out why the backup failed', '2026-08-16T08:00:00Z'),
              task('Put the sale banner back', '2026-08-15T08:00:00Z'),
            ],
          } as never,
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2', connectedAt: 'c', botStatus: 'active' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const rows = (res.body as { agents: Array<{ name: string; now?: string; nowAt?: string }> }).agents;
    const ben = rows.find((row) => row.name === 'Ben');
    // Only the newest travels: the page shows it while `working` and drops it
    // after, so the older entries have no reader anymore.
    expect(ben?.now).toBe('Find out why the backup failed');
    expect(ben?.nowAt).toBe('2026-08-16T08:00:00Z');
    // Never given anything: no key at all, and the row is a line shorter.
    expect(rows.find((row) => row.name === 'Ruby')?.now).toBeUndefined();
  });

  it('GET /api/state ignores historical bot state when reporting agent readiness', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-b': { id: 'agent-b', name: 'Ruby', cli: 'claude', createdAt: '2026-01-02', connectedAt: 'c', botStatus: 'pending' } as never,
        },
      } as never,
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect((res.body as { agents: Array<Record<string, unknown>> }).agents[0]).toEqual(
      { id: 'agent-b', name: 'Ruby', cli: 'claude', model: 'opus', effort: 'high', status: 'ready', createdAt: '2026-01-02', avatarUrl: '/workspace/avatars/ruby' },
    );
  });

  it('serves the avatar set publicly, wrap-around names included, and 404s the rest', async () => {
    const { deps } = await buildDeps();
    const handler = getRouteHandler(deps, '/avatars/:name', 'get');

    // No Authorization header on purpose: an <img> tag cannot send one.
    const res = createMockResponse();
    await handler(mockRequest({ params: { name: 'ben' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.sentText?.length).toBeGreaterThan(1000);

    // "Ben 21" (pool wrap) reuses Ben's dog.
    const wrapped = createMockResponse();
    await handler(mockRequest({ params: { name: 'Ben 21' } }), wrapped);
    expect(wrapped.statusCode).toBe(200);

    const missing = createMockResponse();
    await handler(mockRequest({ params: { name: 'rocket' } }), missing);
    expect(missing.statusCode).toBe(404);

    // Traversal-shaped names never reach the filesystem (the slug rule).
    const hostile = createMockResponse();
    await handler(mockRequest({ params: { name: '../../package' } }), hostile);
    expect(hostile.statusCode).toBe(404);
  });

  it('POST /api/agents starts a creation for the verified user and answers at once', async () => {
    const { deps, org } = await buildAgentOrgDeps();
    const lifecycle = lifecycleMock();
    deps.agentLifecycle = lifecycle;

    const res = createMockResponse();
    // A page from before rooms went (note #923) may still send a roomId;
    // nothing reads it.
    await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({
      headers: authHeader(42), body: { roomId: 'room-from-an-old-page' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The harness may still default; the workplace never does.
    expect(lifecycle.createAgent).toHaveBeenCalledWith('user-1', 'claude', org.orgId);
  });

  it('POST /api/agents carries the harness pick through, and refuses one it does not offer', async () => {
    const { deps, org } = await buildAgentOrgDeps();
    const lifecycle = lifecycleMock();
    deps.agentLifecycle = lifecycle;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({
      headers: authHeader(42),
      body: { cli: 'codex' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(lifecycle.createAgent).toHaveBeenCalledWith('user-1', 'codex', org.orgId);

    // Kimi is retired and everything else is noise — refused before the
    // lifecycle ever hears about it.
    for (const cli of ['kimi', 'gpt', 42]) {
      const bad = createMockResponse();
      await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({
        headers: authHeader(42),
        body: { cli },
      }), bad);
      expect(bad.statusCode).toBe(400);
    }
    expect(lifecycle.createAgent).toHaveBeenCalledTimes(1);
  });

  it('POST /api/agents passes the human-written refusal through as a 400', async () => {
    const { deps } = await buildAgentOrgDeps();
    const lifecycle = lifecycleMock();
    lifecycle.createAgent.mockResolvedValue({ ok: false, reason: 'The Free plan includes 2 agents, and you have 2.' });
    deps.agentLifecycle = lifecycle;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({
      headers: authHeader(42), body: {},
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'The Free plan includes 2 agents, and you have 2.' });
  });

  it('POST /api/agents answers 503 when the lifecycle is not wired', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /api/agents/:id deletes the user\'s own agent and reports the teardown', async () => {
    const { deps } = await buildDeps();
    const lifecycle = lifecycleMock();
    deps.agentLifecycle = lifecycle;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id', 'delete')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, name: 'Ben', machine: 'destroyed', remaining: 1 });
    expect(lifecycle.deleteAgent).toHaveBeenCalledWith('user-1', 'agent-a');
  });

  // Note #983: an agent paused for want of a sign-in is deleted the way an
  // idle one is. Nothing on the way out asks for its seat or a turn.
  it('DELETE /api/agents/:id deletes an agent paused for a lapsed sign-in (needs-seat) like any other', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true, telegramUserId: '42',
        agents: {
          'agent-h': {
            id: 'agent-h', name: 'Hazel', cli: 'codex', createdAt: '2026-10-01',
            serverId: 'fly_ia-hh.aa11', connectedAt: '2026-10-01T10:00:00.000Z',
          } as never,
        },
      } as never,
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Big Bang', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    const lifecycle = lifecycleMock();
    deps.agentLifecycle = lifecycle;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    expect((state.body as { agents: Array<{ status: string }> }).agents[0]!.status).toBe('needs-seat');

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id', 'delete')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-h' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(lifecycle.deleteAgent).toHaveBeenCalledWith('user-1', 'agent-h');
  });

  it('DELETE /api/agents/:id refuses an agent that is not on the caller\'s profile', async () => {
    const { deps } = await buildDeps();
    const lifecycle = lifecycleMock();
    deps.agentLifecycle = lifecycle;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id', 'delete')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-of-someone-else' },
    }), res);

    expect(res.statusCode).toBe(404);
    expect(lifecycle.deleteAgent).not.toHaveBeenCalled();
  });

  it('GET /api/agents/:id/version serves the version card for the caller\'s own agent only', async () => {
    const { deps } = await buildDeps();
    const agentVersion = vi.fn().mockResolvedValue({
      cliLabel: 'Claude Code', installed: '2.1.219', pinned: '2.1.223',
      cliUpdateAvailable: true, busy: false,
    });
    deps.agentLifecycle = { ...lifecycleMock(), agentVersion };

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/version', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ cliLabel: 'Claude Code', cliUpdateAvailable: true });
    expect(agentVersion).toHaveBeenCalledWith('user-1', 'agent-a');

    // Someone else's agent 404s before the collector runs.
    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/version', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-of-someone-else' },
    }), foreign);
    expect(foreign.statusCode).toBe(404);
    expect(agentVersion).toHaveBeenCalledTimes(1);
  });

  it('reads and changes an agent model + model-aware effort from the Workspace (note #148)', async () => {
    const { deps, userStorage } = await buildDeps();
    const profile = (await userStorage.getProfile('user-1'))!;
    await userStorage.updateProfile('user-1', {
      telegram: {
        ...profile.telegram,
        agents: {
          ...profile.telegram!.agents,
          'agent-a': {
            ...profile.telegram!.agents!['agent-a'],
            cli: 'codex', model: 'gpt-6-sol', effort: 'ultra',
          },
        },
      } as never,
    });
    const read = getRouteHandler(deps, '/api/agents/:id/runtime', 'get');
    const change = getRouteHandler(deps, '/api/agents/:id/runtime', 'post');

    const before = createMockResponse();
    await read(mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), before);
    expect(before.statusCode).toBe(200);
    expect(before.body).toMatchObject({
      cli: 'codex', model: 'gpt-6-sol', effort: 'ultra',
      models: expect.arrayContaining([
        // The heavy flag rides the level all the way to the picker (note
        // #482): the page never works out from a name which rungs cost more.
        expect.objectContaining({
          value: 'gpt-6-astra',
          efforts: [
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
            { value: 'xhigh', label: 'xhigh', heavy: true },
            { value: 'max', label: 'max', heavy: true },
            { value: 'ultra', label: 'ultra', heavy: true },
          ],
        }),
        expect.objectContaining({
          value: 'gpt-6-luna',
          efforts: [
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
            { value: 'xhigh', label: 'xhigh', heavy: true },
            { value: 'max', label: 'max', heavy: true },
          ],
        }),
      ]),
    });

    // `ultra` is valid on Sol but not Luna. The model switch clears that
    // stored override atomically and returns Luna's effective default, which
    // is `high`: the one rung every model offers.
    const model = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { model: 'gpt-6-luna' },
    }), model);
    expect(model.statusCode).toBe(200);
    expect(model.body).toMatchObject({ ok: true, model: 'gpt-6-luna', effort: 'high' });
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a'])
      .toMatchObject({ model: 'gpt-6-luna' });
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!.effort)
      .toBeUndefined();

    const effort = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { effort: 'max' },
    }), effort);
    expect(effort.statusCode).toBe(200);
    expect(effort.body).toMatchObject({ model: 'gpt-6-luna', effort: 'max' });
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!.effort)
      .toBe('max');

    // A value not offered by the selected model never reaches storage.
    const invalid = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { effort: 'ultra' },
    }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!.effort)
      .toBe('max');
    // Nor does `low`, which no ChatGPT model offers since 2026-10-12 (the owner).
    const low = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { effort: 'low' },
    }), low);
    expect(low.statusCode).toBe(400);
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!.effort)
      .toBe('max');

    // Astra is selectable with the CLI-only ultra effort advertised by
    // codex-cli 0.153.4, and both fields are saved together for the next turn.
    const astra = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
      body: { model: 'gpt-6-astra', effort: 'ultra' },
    }), astra);
    expect(astra.statusCode).toBe(200);
    expect(astra.body).toMatchObject({ ok: true, model: 'gpt-6-astra', effort: 'ultra' });
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a'])
      .toMatchObject({ model: 'gpt-6-astra', effort: 'ultra' });

    const foreign = createMockResponse();
    await change(mockRequest({
      headers: authHeader(42), params: { id: 'agent-of-someone-else' }, body: { effort: 'low' },
    }), foreign);
    expect(foreign.statusCode).toBe(404);

    // The person's own pick after the Workspace Agent changed it (note #776):
    // what it runs on is theirs now, so the agent's next turn is not told
    // about the Workspace Agent's change any more.
    await userStorage.updateAgentFields('user-1', 'agent-a', { runtimeChange: { by: 'workspace-agent', at: '2026-10-18T09:00:00.000Z' } });
    const own = createMockResponse();
    await change(mockRequest({ headers: authHeader(42), params: { id: 'agent-a' }, body: { effort: 'high' } }), own);
    expect(own.statusCode).toBe(200);
    expect((await userStorage.getProfile('user-1'))!.telegram!.agents!['agent-a']!.runtimeChange).toBeUndefined();
  });

  /**
   * Note #87: the Send under a note's row of faces. The route is thin on
   * purpose — the idle-only rule lives in the service, shared with
   * `agentbuilt agent message` — so what is asserted here is the boundary it
   * owns: whose agent this is, what a message may be, and that a refusal
   * reaches the page as a status a person can act on rather than a 500.
   */
  describe('POST /api/agents/:id/message', () => {
    const messaged = () => vi.fn().mockResolvedValue({
      ok: true, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
    });

    it('hands the message to the caller\'s own agent and answers 202', async () => {
      const { deps } = await buildDeps();
      const messageAgentFromUser = messaged();
      deps.agentLifecycle = { ...lifecycleMock(), messageAgentFromUser };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
        body: { message: '  read the note #87  ' },
      }), res);

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ ok: true, name: 'Ben' });
      // Trimmed here, so the prompt the agent reads never opens on whitespace.
      expect(messageAgentFromUser).toHaveBeenCalledWith({
        userId: 'user-1', agentId: 'agent-a', message: 'read the note #87',
      });
    });

    it('refuses an agent that is not on the caller\'s profile, before the service hears about it', async () => {
      const { deps } = await buildDeps();
      const messageAgentFromUser = messaged();
      deps.agentLifecycle = { ...lifecycleMock(), messageAgentFromUser };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else' },
        body: { message: 'read the note #87' },
      }), res);

      expect(res.statusCode).toBe(404);
      expect(messageAgentFromUser).not.toHaveBeenCalled();
    });

    it('refuses an empty message and one past the cap', async () => {
      const { deps } = await buildDeps();
      const messageAgentFromUser = messaged();
      deps.agentLifecycle = { ...lifecycleMock(), messageAgentFromUser };

      for (const message of ['', '   ', 42, undefined, 'x'.repeat(10_001)]) {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' }, body: { message },
        }), res);
        expect(res.statusCode).toBe(400);
      }
      // The cap itself is fine — it is the character AFTER it that is not.
      const ok = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { message: 'x'.repeat(10_000) },
      }), ok);
      expect(ok.statusCode).toBe(202);
      expect(messageAgentFromUser).toHaveBeenCalledTimes(1);
    });

    it('reports a busy agent as 409 with the service\'s own words — nothing was sent', async () => {
      const { deps } = await buildDeps();
      const messageAgentFromUser = vi.fn().mockResolvedValue({
        ok: false,
        code: 'busy',
        reason: 'Ben is working right now. Nothing was sent — try another agent, or wait for it to finish.',
      });
      deps.agentLifecycle = { ...lifecycleMock(), messageAgentFromUser };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { message: 'read the note #87' },
      }), res);

      // 409, not 400: the page's row was right when it was drawn, and the
      // reader's recovery is another agent rather than different words.
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'busy' });
      expect((res.body as { error: string }).error).toContain('Nothing was sent');
    });

    it('reports a shutdown-gate refusal as a retriable 503, not a dropped 502', async () => {
      const { deps } = await buildDeps();
      const messageAgentFromUser = vi.fn().mockResolvedValue({
        ok: false,
        code: 'restarting',
        reason: 'The platform is restarting. Nothing was sent. Try again in a moment.',
      });
      deps.agentLifecycle = { ...lifecycleMock(), messageAgentFromUser };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
        body: { message: 'pick up the note #168' },
      }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        error: 'The platform is restarting. Nothing was sent. Try again in a moment.',
        code: 'restarting',
      });
    });

    it('answers 503 when this backend cannot start agents at all', async () => {
      const { deps } = await buildDeps();
      deps.agentLifecycle = lifecycleMock();

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/message', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { message: 'read the note #87' },
      }), res);
      expect(res.statusCode).toBe(503);
    });
  });

  /**
   * The agent's chat screen (inhouse-chat-design, note #131). Same thin-route
   * philosophy as the one-shot Send above: ownership and message shape are
   * decided here, the steering contract lives in the service. What is pinned:
   * the incremental cursor reaches the service as a number, the working flag
   * and activity ride the same response as the rows, and a send reports
   * whether it steered.
   */
  describe('agent chat routes', () => {
    const chatRows = [
      { seq: 1, role: 'owner', text: 'hello', at: '2026-08-29T10:00:00.000Z' },
      { seq: 2, role: 'agent', text: 'hi back', at: '2026-08-29T10:00:05.000Z' },
    ];
    const legacyAttachmentEnvelope = (message: string, file: Buffer) => {
      const words = Buffer.from(message, 'utf8');
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(words.byteLength);
      return Buffer.concat([prefix, words, file]);
    };
    const attachmentEnvelope = (
      message: string,
      files: Array<{ fileName: string; contentType: string; data: Buffer }>,
    ) => {
      const manifest = Buffer.from(JSON.stringify({
        message,
        files: files.map(({ fileName, contentType, data }) => ({
          fileName, contentType, sizeBytes: data.byteLength,
        })),
      }), 'utf8');
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(manifest.byteLength);
      return Buffer.concat([prefix, manifest, ...files.map((file) => file.data)]);
    };

    it('GET returns the rows after the cursor with the live working state', async () => {
      const { deps } = await buildDeps();
      const agentChatMessages = vi.fn().mockResolvedValue(chatRows);
      deps.agentLifecycle = {
        ...lifecycleMock(),
        agentChatMessages,
        isAgentWorking: vi.fn().mockReturnValue(true),
        agentActivity: vi.fn().mockReturnValue({ activity: 'Bash: npm test', startedAt: 123 }),
      };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, query: { after: '7' },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ messages: chatRows, working: true });
      expect(agentChatMessages).toHaveBeenCalledWith('user-1', 'agent-a', 7);
    });

    it('GET says the machine is being rebuilt while a send waits on it, and only then (note #658)', async () => {
      const { deps } = await buildDeps();
      let working = false;
      let preparing = true;
      const isAgentPreparing = vi.fn(() => preparing);
      deps.agentLifecycle = {
        ...lifecycleMock(),
        agentChatMessages: vi.fn().mockResolvedValue([]),
        isAgentWorking: vi.fn(() => working),
        isAgentPreparing,
      };
      const read = async () => {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' }, query: {},
        }), res);
        return res.body as Record<string, unknown>;
      };

      expect(await read()).toMatchObject({ working: false, preparing: true });
      expect(isAgentPreparing).toHaveBeenCalledWith('user-1', 'agent-a');
      // Once the turn runs, the turn is the news.
      working = true;
      expect(await read()).not.toHaveProperty('preparing');
      // Absent rather than false when nothing is being built.
      working = false;
      preparing = false;
      expect(await read()).not.toHaveProperty('preparing');
    });

    it('GET jobs returns only this owned agent\'s durable work, outcomes beside the running', async () => {
      const { deps } = await buildDeps();
      const running = {
        id: 'j_111111111111111111111111',
        label: 'npm run build:workspace-ui',
        startedAt: '2026-09-18T10:00:00.000Z',
      };
      const settled = {
        id: 'j_222222222222222222222222',
        label: 'node migrate.mjs',
        startedAt: '2026-09-18T09:00:00.000Z',
        finishedAt: '2026-09-18T09:01:00.000Z',
        status: 'failed' as const,
      };
      const listManagedJobs = vi.fn()
        .mockResolvedValueOnce({ jobs: [running], recent: [] })
        .mockResolvedValueOnce({ jobs: [running], recent: [settled] });
      deps.agentLifecycle = { ...lifecycleMock(), listManagedJobs };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/jobs', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), res);
      expect(res.statusCode).toBe(200);
      // No outcomes → no key: the answer an older page reads is unchanged.
      expect(res.body).toEqual({ jobs: [running] });
      expect(listManagedJobs).toHaveBeenCalledWith('user-1', 'agent-a');

      const again = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/jobs', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), again);
      expect(again.body).toEqual({ jobs: [running], recent: [settled] });

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/jobs', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'someone-elses-agent' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);
      expect(listManagedJobs).toHaveBeenCalledTimes(2);
    });

    it('gives a peer’s message the sender’s face, old rows included', async () => {
      const { deps } = await buildDeps();
      deps.agentLifecycle = {
        ...lifecycleMock(),
        agentChatMessages: vi.fn().mockResolvedValue([
          { seq: 1, role: 'platform', text: '[Platform] Message from agent Zoe: Take the rebase.', at: 'now' },
          // The wording the platform used before note #183, which is what is
          // sitting in every chat already. Resolving at READ time is what
          // gives those rows a face rather than only the ones written next.
          { seq: 2, role: 'platform', text: 'Handoff from agent Ivy: Older row.', at: 'now' },
          // Not a peer at all — an event, and events wear no sender.
          { seq: 3, role: 'platform', text: 'Turn stopped by the user.', at: 'now' },
          // A name the avatar pool has no picture for. The field is dropped
          // rather than pointing at a URL that would 404: the page draws the
          // name alone, never a broken image.
          { seq: 4, role: 'platform', text: 'Message from agent Rosterhall: No dog here.', at: 'now' },
          // The agent's own words are not somebody else's message.
          { seq: 5, role: 'agent', text: 'Message from agent Zoe: quoting, not receiving.', at: 'now' },
          // Without an org record this narrow fixture takes the legacy
          // reserved fallback. In a real workplace the saved note #582 pick
          // is passed explicitly; its two-word display name never decides it.
          { seq: 6, role: 'platform', text: '[Platform] Message from agent Workspace Agent: Owner direction.', at: 'now' },
        ]),
        isAgentWorking: vi.fn().mockReturnValue(false),
      };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, query: {},
      }), res);

      const faces = (res.body as { messages: Array<{ fromAvatarUrl?: string }> }).messages
        .map((message) => message.fromAvatarUrl);
      expect(faces).toEqual([
        '/workspace/avatars/zoe',
        '/workspace/avatars/ivy',
        undefined,
        undefined,
        undefined,
        '/workspace/avatars/workspace-agent',
      ]);
    });

    it('GET latest returns one exact agent reply without opening the transcript', async () => {
      const { deps } = await buildDeps();
      const latestAgentChatMessage = vi.fn().mockResolvedValue({
        text: 'Done — the details page now carries my actual reply.',
        at: '2026-08-30T12:00:00.000Z',
      });
      deps.agentLifecycle = { ...lifecycleMock(), latestAgentChatMessage };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/latest', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ message: {
        text: 'Done — the details page now carries my actual reply.',
        at: '2026-08-30T12:00:00.000Z',
      } });
      expect(latestAgentChatMessage).toHaveBeenCalledWith('user-1', 'agent-a');

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/latest', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'someone-elses-agent' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);
      expect(latestAgentChatMessage).toHaveBeenCalledTimes(1);
    });

    /**
     * The ring around the face in the chat's header (note #145) rides the
     * transcript's own read. It has to: the measurement is written when a turn
     * ENDS, and the screen open at that moment is usually this one — waiting
     * for the next full state read would leave the header a turn behind the
     * conversation under it. Same refusal as everywhere else when there is no
     * honest percentage to draw.
     */
    it('GET carries the agent’s context fill, and omits it when there is none', async () => {
      const { deps, userStorage } = await buildDeps();
      deps.agentLifecycle = {
        ...lifecycleMock(),
        agentChatMessages: vi.fn().mockResolvedValue(chatRows),
      };
      const read = async () => {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' },
        }), res);
        expect(res.statusCode).toBe(200);
        return res.body as Record<string, unknown>;
      };

      // Nothing has measured this agent yet: no field, never a nought.
      expect(await read()).not.toHaveProperty('context');

      await userStorage.updateAgentFields('user-1', 'agent-a', {
        contextUsage: { tokens: 710_000, model: 'claude-sonnet-5-20260320', at: '2026-08-30T09:00:00.000Z' },
      } as never);
      // The same arithmetic the fleet list is drawn from, not a second copy.
      expect((await read()).context).toEqual({
        usedPercent: 71, tokens: 710_000, window: 1_000_000, at: '2026-08-30T09:00:00.000Z',
      });

      // A model this backend holds no window for has no percentage to state.
      await userStorage.updateAgentFields('user-1', 'agent-a', {
        contextUsage: { tokens: 710_000, model: 'some/model-we-never-priced', at: 't' },
      } as never);
      expect(await read()).not.toHaveProperty('context');
    });

    /**
     * Note #945: the recap line under the latest completed turn rides the
     * same read as the rows and the ring — the row recap and the turn's own
     * stamps off the one record, never a second summary.
     */
    it('GET carries the latest completed turn, with its recap once this turn\'s summary has arrived (note #945)', async () => {
      const { deps, userStorage } = await buildDeps();
      deps.agentLifecycle = { ...lifecycleMock(), agentChatMessages: vi.fn().mockResolvedValue(chatRows) };
      const read = async () => {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' },
        }), res);
        expect(res.statusCode).toBe(200);
        return res.body as Record<string, unknown>;
      };
      // No turn on record: no line.
      expect(await read()).not.toHaveProperty('lastTurn');
      await userStorage.updateAgentFields('user-1', 'agent-a', {
        lastTurnStartedAt: '2026-11-01T20:38:00.000Z',
        lastTurnEndedAt: '2026-11-01T20:38:12.000Z',
        recap: { text: 'Shipped the pricing page.', at: '2026-11-01T19:00:00.000Z' },
      });
      // The recap on record is the turn before's: the facts alone.
      expect((await read()).lastTurn).toEqual({ startedAt: '2026-11-01T20:38:00.000Z', endedAt: '2026-11-01T20:38:12.000Z' });
      await userStorage.updateAgentFields('user-1', 'agent-a', {
        recap: { text: 'Paused on DNS. Next, add the 17 records.', at: '2026-11-01T20:38:30.000Z' },
      });
      expect((await read()).lastTurn).toEqual({
        startedAt: '2026-11-01T20:38:00.000Z', endedAt: '2026-11-01T20:38:12.000Z', recap: 'Paused on DNS. Next, add the 17 records.',
      });
    });

    it('GET treats a missing or garbled cursor as the full window', async () => {
      const { deps } = await buildDeps();
      const agentChatMessages = vi.fn().mockResolvedValue([]);
      deps.agentLifecycle = { ...lifecycleMock(), agentChatMessages };

      for (const query of [{}, { after: 'NaN' }, { after: '-3' }]) {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' }, query,
        }), res);
        expect(res.statusCode).toBe(200);
      }
      expect(agentChatMessages).toHaveBeenCalledTimes(3);
      for (const call of agentChatMessages.mock.calls) expect(call[2]).toBe(0);
    });

    it('GET refuses an agent that is not on the caller\'s profile', async () => {
      const { deps } = await buildDeps();
      const agentChatMessages = vi.fn().mockResolvedValue(chatRows);
      deps.agentLifecycle = { ...lifecycleMock(), agentChatMessages };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else' },
      }), res);
      expect(res.statusCode).toBe(404);
      expect(agentChatMessages).not.toHaveBeenCalled();
    });

    it('GET files answers a signed URL for the caller\'s own agent, 404 otherwise', async () => {
      const { deps } = await buildDeps();
      const agentChatFileAccess = vi.fn().mockResolvedValue({
        url: 'https://media.example/signed', fileName: 'report.pdf', expiresAt: '2026-08-29T11:00:00.000Z',
      });
      deps.agentLifecycle = { ...lifecycleMock(), agentChatFileAccess };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-1' },
      }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ url: 'https://media.example/signed', fileName: 'report.pdf' });
      expect(agentChatFileAccess).toHaveBeenCalledWith('user-1', 'agent-a', 'f-1', false);

      const preview = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-1' }, query: { preview: '1' },
      }), preview);
      expect(preview.statusCode).toBe(200);
      expect(agentChatFileAccess).toHaveBeenLastCalledWith('user-1', 'agent-a', 'f-1', true);

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else', fileId: 'f-1' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);

      // A file the chat no longer holds is a 404 in the service's words.
      agentChatFileAccess.mockResolvedValueOnce(null);
      const gone = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-gone' },
      }), gone);
      expect(gone.statusCode).toBe(404);
    });

    it('GET a file\'s text hands a Markdown file\'s words to the caller\'s own agent chat, 404 otherwise (note #677)', async () => {
      const { deps } = await buildDeps();
      const agentChatFileText = vi.fn().mockResolvedValue({ kind: 'markdown', fileName: 'plan.md', content: '# Plan' });
      deps.agentLifecycle = { ...lifecycleMock(), agentChatFileText };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId/text', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-1' },
      }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ kind: 'markdown', fileName: 'plan.md', content: '# Plan' });
      expect(agentChatFileText).toHaveBeenCalledWith('user-1', 'agent-a', 'f-1');

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId/text', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else', fileId: 'f-1' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);
      expect(agentChatFileText).toHaveBeenCalledTimes(1);

      agentChatFileText.mockResolvedValueOnce(null);
      const gone = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId/text', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-gone' },
      }), gone);
      expect(gone.statusCode).toBe(404);

      // A backend without the read says so rather than pretending the file is gone.
      deps.agentLifecycle = { ...lifecycleMock(), agentChatFileText: undefined };
      const off = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files/:fileId/text', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', fileId: 'f-1' },
      }), off);
      expect(off.statusCode).toBe(503);
    });

    it('POST hands the trimmed message to the service and says whether it steered', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, steered: true, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
        body: { message: '  actually, use the staging table  ' },
      }), res);

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ ok: true, name: 'Ben', steered: true });
      expect(chatMessageAgentFromUser).toHaveBeenCalledWith({
        userId: 'user-1', agentId: 'agent-a', message: 'actually, use the staging table',
      });
    });

    it('POST files admits multiple selected bytes and optional text as one chat message', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, steered: false, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };
      const brief = Buffer.from([1, 2, 3, 4, 5]);
      const screenshot = Buffer.from([6, 7, 8]);
      const res = createMockResponse();

      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42),
        params: { id: 'agent-a' },
        body: attachmentEnvelope('  проверь это  ', [
          { fileName: 'brief.pdf', contentType: 'application/pdf', data: brief },
          { fileName: 'screen.png', contentType: 'image/png', data: screenshot },
        ]),
      }), res);

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ ok: true, name: 'Ben', steered: false });
      expect(chatMessageAgentFromUser).toHaveBeenCalledTimes(1);
      const sent = chatMessageAgentFromUser.mock.calls[0]![0];
      expect(sent).toMatchObject({
        userId: 'user-1', agentId: 'agent-a', message: 'проверь это',
        attachments: [
          { fileName: 'brief.pdf', contentType: 'application/pdf' },
          { fileName: 'screen.png', contentType: 'image/png' },
        ],
      });
      expect(Buffer.from(sent.attachments[0].data).equals(brief)).toBe(true);
      expect(Buffer.from(sent.attachments[1].data).equals(screenshot)).toBe(true);
    });

    it('POST files carries any number of files, held only to the bytes one request gets through (note #672)', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, steered: false, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };
      const shots = Array.from({ length: 12 }, (_, i) => ({ fileName: `shot-${i + 1}.png`, contentType: 'image/png', data: Buffer.from([i + 1]) }));

      const many = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: attachmentEnvelope('twelve', shots),
      }), many);
      expect(many.statusCode).toBe(202);
      expect(chatMessageAgentFromUser.mock.calls[0]![0].attachments.map((file: { fileName: string }) => file.fileName))
        .toEqual(shots.map((shot) => shot.fileName));

      // Four files of 24 MB inline are 96 MB together: past what one request
      // carries, refused with words rather than the edge's 413. (The screen
      // sends such files in parts first and names them — note #943.)
      const big = Buffer.alloc(24 * 1024 * 1024, 1);
      const heavy = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
        body: attachmentEnvelope('', [1, 2, 3, 4].map((n) => ({ fileName: `video-${n}.mp4`, contentType: 'video/mp4', data: big }))),
      }), heavy);
      expect(heavy.statusCode).toBe(400);
      expect((heavy.body as { error: string }).error).toContain('up to 95 MB of files inline');

      const none = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: attachmentEnvelope('words only', []),
      }), none);
      expect(none.statusCode).toBe(400);
      expect(chatMessageAgentFromUser).toHaveBeenCalledTimes(1);
    });

    it('takes a file past 25 MB in parts and a message that names it (note #943)', async () => {
      const { deps } = await buildDeps();
      const media = new MemoryMediaStorage();
      deps.mediaStorage = media;
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, steered: false, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };
      // The owner's own 38.4 MB file: five parts, never one request.
      const film = Buffer.alloc(40_265_318, 5);
      const start = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/uploads', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { fileName: 'film.mp4', sizeBytes: film.length, contentType: 'video/mp4' },
      }), start);
      expect(start.statusCode).toBe(201);
      const started = start.body as { id: string; uploadId: string; partBytes: number; parts: number };
      expect(started.parts).toBe(5);
      const parts = [];
      for (let n = 1; n <= started.parts; n += 1) {
        const part = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat/uploads/:upload/parts/:part', 'put')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a', upload: started.id, part: String(n) },
          query: { upload: started.uploadId, name: 'film.mp4' },
          body: film.subarray((n - 1) * started.partBytes, n * started.partBytes),
        }), part);
        expect(part.statusCode).toBe(200);
        parts.push(part.body);
      }
      const done = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/uploads/:upload/complete', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a', upload: started.id },
        body: { uploadId: started.uploadId, fileName: 'film.mp4', parts },
      }), done);
      expect(done.body).toEqual({ id: started.id, fileName: 'film.mp4', sizeBytes: film.length });
      const [key] = [...media.objects.keys()];
      expect(key).toMatch(new RegExp(`/agent-chats/agent-a/${started.id}/film\\.mp4$`));
      expect(media.objects.get(key!)!.data.equals(film)).toBe(true);

      // The message carries a small file inline and names the big one.
      const manifest = Buffer.from(JSON.stringify({ message: 'cut this', files: [
        { fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: 2 },
        { fileName: 'film.mp4', contentType: 'video/mp4', upload: started.id },
      ] }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(manifest.byteLength);
      const sent = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: Buffer.concat([prefix, manifest, Buffer.from('hi')]),
      }), sent);
      expect(sent.statusCode).toBe(202);
      const attachments = chatMessageAgentFromUser.mock.calls[0]![0].attachments;
      expect(attachments).toHaveLength(2);
      expect(Buffer.from(attachments[0].data).toString()).toBe('hi');
      expect(attachments[1]).toEqual({ fileName: 'film.mp4', contentType: 'video/mp4', uploadId: started.id });

      // An id that is not one the doors could have minted is refused outright,
      // and someone else's agent has no doors here.
      const forged = Buffer.from(JSON.stringify({ message: '', files: [{ fileName: 'x.mp4', upload: '../other' }] }));
      const forgedPrefix = Buffer.alloc(4); forgedPrefix.writeUInt32BE(forged.byteLength);
      const bad = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: Buffer.concat([forgedPrefix, forged]),
      }), bad);
      expect(bad.statusCode).toBe(400);
      const stranger = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/uploads', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'nobody' }, body: { fileName: 'a.bin', sizeBytes: 10 },
      }), stranger);
      expect(stranger.statusCode).toBe(404);
    });

    it('POST files still accepts the one-file envelope from a page open across the deploy', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };
      const data = Buffer.from('old-page-file');
      const res = createMockResponse();

      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: {
          ...authHeader(42),
          'x-chat-file-name': 'legacy.txt',
          'x-chat-file-type': 'text/plain',
        },
        params: { id: 'agent-a' },
        body: legacyAttachmentEnvelope('still open', data),
      }), res);

      expect(res.statusCode).toBe(202);
      const sent = chatMessageAgentFromUser.mock.calls[0]![0];
      expect(sent).toMatchObject({
        message: 'still open',
        attachments: [{ fileName: 'legacy.txt', contentType: 'text/plain' }],
      });
      expect(Buffer.from(sent.attachments[0].data).equals(data)).toBe(true);
    });

    it('POST files refuses malformed, empty, and foreign uploads before the service', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn();
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };

      const malformed = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: { ...authHeader(42), 'x-chat-file-name': 'x.txt' },
        params: { id: 'agent-a' },
        body: Buffer.from([0, 0, 1, 0, 7]),
      }), malformed);
      expect(malformed.statusCode).toBe(400);

      const empty = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: { ...authHeader(42), 'x-chat-file-name': 'x.txt' },
        params: { id: 'agent-a' },
        body: legacyAttachmentEnvelope('', Buffer.alloc(0)),
      }), empty);
      expect(empty.statusCode).toBe(400);

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat/files', 'post')(mockRequest({
        headers: { ...authHeader(42), 'x-chat-file-name': 'x.txt' },
        params: { id: 'agent-of-someone-else' },
        body: legacyAttachmentEnvelope('', Buffer.from('x')),
      }), foreign);
      expect(foreign.statusCode).toBe(404);
      expect(chatMessageAgentFromUser).not.toHaveBeenCalled();
    });

    it('POST refuses a foreign agent, an empty message, and one past the cap — and takes the cap itself', async () => {
      const { deps } = await buildDeps();
      const chatMessageAgentFromUser = vi.fn().mockResolvedValue({
        ok: true, recipient: { id: 'agent-a', name: 'Ben', cli: 'claude' },
      });
      deps.agentLifecycle = { ...lifecycleMock(), chatMessageAgentFromUser };

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else' }, body: { message: 'hi' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);

      for (const message of ['', '   ', 'x'.repeat(10_001)]) {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/agents/:id/chat', 'post')(mockRequest({
          headers: authHeader(42), params: { id: 'agent-a' }, body: { message },
        }), res);
        expect(res.statusCode).toBe(400);
      }
      expect(chatMessageAgentFromUser).not.toHaveBeenCalled();
      // The cap itself goes (note #704): a long brief is one message.
      const long = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { message: 'x'.repeat(10_000) },
      }), long);
      expect(long.statusCode).toBe(202);
      expect(chatMessageAgentFromUser).toHaveBeenCalledTimes(1);
    });

    it('POST stop interrupts the caller\'s own agent and reports the honest outcome', async () => {
      const { deps } = await buildDeps();
      const stopAgentTurn = vi.fn().mockResolvedValue({ ok: true, stopped: true, name: 'Ben' });
      deps.agentLifecycle = { ...lifecycleMock(), stopAgentTurn };

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/stop', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, stopped: true, name: 'Ben' });
      expect(stopAgentTurn).toHaveBeenCalledWith({ userId: 'user-1', agentId: 'agent-a' });

      // A turn that beat the tap is still a 200 — the screen's next poll
      // shows the same truth; only a foreign agent is a refusal.
      stopAgentTurn.mockResolvedValueOnce({ ok: true, stopped: false, name: 'Ben' });
      const late = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/stop', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), late);
      expect(late.statusCode).toBe(200);
      expect(late.body).toMatchObject({ stopped: false });

      const foreign = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/stop', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-of-someone-else' },
      }), foreign);
      expect(foreign.statusCode).toBe(404);
    });

    it('both routes answer 503 when this backend has no chat', async () => {
      const { deps } = await buildDeps();
      deps.agentLifecycle = lifecycleMock();

      const get = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'get')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' },
      }), get);
      expect(get.statusCode).toBe(503);

      const post = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/chat', 'post')(mockRequest({
        headers: authHeader(42), params: { id: 'agent-a' }, body: { message: 'hi' },
      }), post);
      expect(post.statusCode).toBe(503);
    });
  });

  it('POST update-cli and update-machine act for the owner and pass refusals through as 400', async () => {
    const { deps } = await buildDeps();
    const updateAgentCli = vi.fn().mockResolvedValue({ ok: true });
    const updateAgentMachine = vi.fn().mockResolvedValue({ ok: false, reason: 'Ben is busy — update when this task finishes.' });
    deps.agentLifecycle = { ...lifecycleMock(), updateAgentCli, updateAgentMachine };

    const cliRes = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/update-cli', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), cliRes);
    expect(cliRes.statusCode).toBe(200);
    expect(updateAgentCli).toHaveBeenCalledWith('user-1', 'agent-a');

    // The human-written refusal travels as-is; the app shows it verbatim.
    const machineRes = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/update-machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), machineRes);
    expect(machineRes.statusCode).toBe(400);
    expect((machineRes.body as { error: string }).error).toContain('busy');
  });

  /**
   * Note #268 — the machine screen. The write answers with the machine READ
   * BACK, so a change that half happened cannot leave the screen claiming the
   * size it asked for.
   */
  it('GET/POST machine reads the shape, writes the chosen size, and answers with what Fly then said', async () => {
    const { deps } = await buildDeps();
    const machine = { awake: false, cpuKind: 'shared', cpus: 2, memoryMb: 4096, current: 'shared-2x', sizes: [], canResize: true, disclaimer: 'Estimates.' };
    const agentMachine = vi.fn().mockResolvedValue(machine);
    const resizeAgentMachine = vi.fn().mockResolvedValue({ ok: true, changed: true, awake: false });
    deps.agentLifecycle = { ...lifecycleMock(), agentMachine, resizeAgentMachine };

    const read = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), read);
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ current: 'shared-2x', canResize: true });

    const write = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { size: 'performance-4x' },
    }), write);
    expect(write.statusCode).toBe(200);
    expect(resizeAgentMachine).toHaveBeenCalledWith('user-1', 'agent-a', 'performance-4x');
    // `restarted` comes from the WRITE — a machine rebooting onto its new
    // size reads as neither awake nor asleep for a few seconds, so the read
    // back cannot say which of the two things just happened.
    expect(write.body).toMatchObject({ ok: true, changed: true, restarted: false, current: 'shared-2x' });
    // Read back rather than assumed: the answer is the second read's, not the
    // size the caller asked for.
    expect(agentMachine).toHaveBeenCalledTimes(2);

    resizeAgentMachine.mockResolvedValueOnce({ ok: true, changed: true, awake: true });
    const rebooted = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { size: 'performance-4x' },
    }), rebooted);
    expect(rebooted.body).toMatchObject({ ok: true, changed: true, restarted: true });
  });

  it('the machine routes refuse a foreign agent, a missing size, and pass refusals through as 400', async () => {
    const { deps } = await buildDeps();
    const resizeAgentMachine = vi.fn().mockResolvedValue({
      ok: false, reason: 'Ben is busy — change the machine when this turn finishes.',
    });
    deps.agentLifecycle = {
      ...lifecycleMock(),
      agentMachine: vi.fn().mockResolvedValue({ awake: false, sizes: [], canResize: true, disclaimer: '' }),
      resizeAgentMachine,
    };

    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-of-someone-else' },
    }), foreign);
    expect(foreign.statusCode).toBe(404);

    const empty = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: {},
    }), empty);
    expect(empty.statusCode).toBe(400);
    expect(resizeAgentMachine).not.toHaveBeenCalled();

    // The human-written refusal travels as-is; the app shows it verbatim.
    const busy = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { size: 'shared-2x' },
    }), busy);
    expect(busy.statusCode).toBe(400);
    expect((busy.body as { error: string }).error).toContain('busy');
  });

  it('the machine routes answer 503 when this backend cannot read or move a machine', async () => {
    const { deps } = await buildDeps();
    deps.agentLifecycle = lifecycleMock();

    const read = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), read);
    expect(read.statusCode).toBe(503);

    const write = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'post')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' }, body: { size: 'shared-2x' },
    }), write);
    expect(write.statusCode).toBe(503);
  });

  it('version endpoints answer 503 when the collectors are not wired', async () => {
    const { deps } = await buildDeps();
    deps.agentLifecycle = lifecycleMock();

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/version', 'get')(mockRequest({
      headers: authHeader(42), params: { id: 'agent-a' },
    }), res);
    expect(res.statusCode).toBe(503);
  });
});

describe('telegram mini app routes — retired account screens', () => {
  it('GET /api/state carries no redundant account card, and the old Usage endpoint is gone', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('account');
    expect(() => getRouteHandler(deps, '/api/usage', 'get')).toThrow('No get /api/usage route');
  });
});

/**
 * The PR surface: the queue rides /api/state, the screen fetches a LIVE
 * compare, and the decision route is a thin shell around the shared decision
 * flow — the assertions that matter are ownership (a foreign proposal 404s
 * without the host hearing about it) and that the route adds no decision
 * logic of its own.
 */
describe('mini app pull requests', () => {
  const seedPr = async (deps: Partial<RouteDeps>, overrides: Record<string, unknown> = {}) => {
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const repo = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    const pr = await gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'Rewrite checkout',
      body: 'What changed and why.',
      sourceBranch: 'feat/checkout', targetBranch: 'main',
      headSha: 'a'.repeat(40), diffStat: { files: 1, insertions: 2, deletions: 0 },
      commitSubjects: ['Rewrite checkout'], createdByAgentId: 'agent-a', status: 'open',
      ...overrides,
    } as never);
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitPullRequestStorage = gitPullRequestStorage;
    return { pr, repo, gitPullRequestStorage };
  };

  it('lists open proposals in state, named by repo and proposing agent', async () => {
    const { deps } = await buildDeps();
    await seedPr(deps);
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const body = res.body as { prs: Array<Record<string, unknown>> };
    expect(body.prs).toEqual([expect.objectContaining({
      number: 1, repoName: 'api', title: 'Rewrite checkout',
      from: 'feat/checkout', to: 'main', status: 'open', agentName: 'Ben',
      // The proposing agent's own face, the same picture its row on home
      // wears — the proposal screen puts it beside "Ben proposed this".
      agentAvatarUrl: '/workspace/avatars/ben',
      // …and WHICH agent that is, so the face can be a way in to it. The name
      // is not enough: two agents may share one, and the screen it opens is
      // found by id in the fleet the page already holds.
      agentId: 'agent-a',
      // The header also names the concrete runtime the agent will use on its
      // next turn, not the absent stored overrides on this defaulted record.
      agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
    })]);
  });

  /**
   * Note #80: a proposal says WHOSE agent asked, not just which one — the
   * screen signs "Ben (Owner Example) proposed this", the same pair a note's
   * author line and every margin remark have carried since note #57.
   */
  it('a proposal names the human driving the proposing agent', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', {
      person: { firstName: 'Owner', lastName: 'Example' },
    } as never);
    const { pr: seeded } = await seedPr(deps);
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      compare: () => Promise.resolve({ files: [], diffStat: { files: 0, insertions: 0, deletions: 0 } }),
    } as unknown as GitHostClient;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    expect((state.body as { prs: Array<Record<string, unknown>> }).prs[0])
      .toMatchObject({ agentName: 'Ben', userName: 'Owner Example' });

    // …and on the proposal's own screen, which is where the note's screenshot
    // was taken and where the decision is actually made.
    const one = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: seeded.id } }), one,
    );
    expect((one.body as { pr: Record<string, unknown> }).pr)
      .toMatchObject({
        agentName: 'Ben', userName: 'Owner Example',
        agentRuntime: { cli: 'claude', model: 'opus', effort: 'high' },
      });
  });

  /**
   * An agent the account no longer has: the proposal keeps every fact that
   * was ever true of it and loses the four that point at something gone —
   * so the page has nothing to build a door out of, which is the point, and
   * nothing to sign with either.
   */
  it('a proposal from a deleted agent carries no agent to open', async () => {
    const { deps } = await buildDeps();
    await seedPr(deps, { createdByAgentId: 'agent-gone' });
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const [pr] = (res.body as { prs: Array<Record<string, unknown>> }).prs;
    expect(pr.agentName).toBeNull();
    expect(pr).not.toHaveProperty('agentId');
    expect(pr).not.toHaveProperty('agentAvatarUrl');
    expect(pr).not.toHaveProperty('userName');
  });

  /**
   * A repository's own proposal list. `/api/state` carries the open queue
   * only, so this is the one route that can answer "what has ever been
   * proposed here" — and the decided ones are most of that answer.
   */
  it('lists every proposal on a repository, decided ones included, newest first', async () => {
    const { deps } = await buildDeps();
    const { gitPullRequestStorage, repo } = await seedPr(deps, { status: 'merged' });
    await gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'Second thoughts',
      sourceBranch: 'feat/two', targetBranch: 'main', headSha: 'b'.repeat(40),
      diffStat: { files: 1, insertions: 1, deletions: 1 }, commitSubjects: ['Second thoughts'],
      createdByAgentId: 'agent-a', status: 'open',
    } as never);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { prs: Array<Record<string, unknown>> };
    expect(body.prs.map((pr) => [pr.number, pr.status, pr.title])).toEqual([
      [2, 'open', 'Second thoughts'],
      [1, 'merged', 'Rewrite checkout'],
    ]);
    // The row needs the same things home's queue does, plus what became of it.
    expect(body.prs[0]).toMatchObject({ repoName: 'api', from: 'feat/two', to: 'main', agentName: 'Ben' });
  });

  it('lists every proposal an agent made across repositories, including decided history', async () => {
    const { deps } = await buildDeps();
    const { pr: first, repo, gitPullRequestStorage } = await seedPr(deps, { status: 'merged' });
    const repos = deps.gitRepoStorage as InMemoryGitRepoStorage;
    const workspace = await repos.create({
      userId: 'user-1', name: 'workspace', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    const newest = await gitPullRequestStorage.create({
      repoId: workspace.id, userId: 'user-1', title: 'Show proposal history',
      sourceBranch: 'agent/proposals', targetBranch: 'main', headSha: 'b'.repeat(40),
      diffStat: { files: 2, insertions: 8, deletions: 1 }, commitSubjects: ['Show proposal history'],
      createdByAgentId: 'agent-a', status: 'open',
    } as never);
    // A proposal from another agent in the same repository is not the first
    // agent's history just because the owner shares both agents.
    await gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'Ruby’s change',
      sourceBranch: 'ruby/work', targetBranch: 'main', headSha: 'c'.repeat(40),
      diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['Ruby’s change'],
      createdByAgentId: 'agent-b', status: 'open',
    } as never);
    await gitPullRequestStorage.update(first.id, { createdAt: '2026-08-01T00:00:00.000Z' });
    await gitPullRequestStorage.update(newest.id, { createdAt: '2026-08-02T00:00:00.000Z' });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { prs: Array<Record<string, unknown>> };
    expect(body.prs.map((pr) => [pr.title, pr.status, pr.repoName])).toEqual([
      ['Show proposal history', 'open', 'workspace'],
      ['Rewrite checkout', 'merged', 'api'],
    ]);
    expect(body.prs[0]).toMatchObject({ agentId: 'agent-a', agentName: 'Ben' });
  });

  /**
   * The same history has a second half (note #276). A knowledge proposal is
   * work this agent did just as a change is, and until now the only place it
   * appeared was Home's queue — which drops it the moment it is decided, so
   * an agent that had written the whole knowledge base looked as though it
   * had never proposed one.
   */
  it('keeps a quiet knowledge proposal out of the queue and out of reach of a decision (note #293)', async () => {
    const { deps } = await buildDeps();
    const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.knowledgeProposalStorage = knowledgeProposalStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;
    const quiet = await knowledgeProposalStorage.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      title: 'Write down how a deploy reaches production',
      changes: [{ page: 'deploys', action: 'create', title: 'Deploys', html: '<p>x</p>' }],
      status: 'open', draft: true,
    } as never);

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const body = state.body as { knowledgeProposals: unknown[] };
    expect(body.knowledgeProposals).toEqual([]);
    // Nor in the workplace queue the agents picker reads (note #721).
    const everywhere = createMockResponse();
    await getRouteHandler(deps, '/api/decisions', 'get')(mockRequest({ headers: authHeader(42) }), everywhere);
    expect((everywhere.body as { knowledgeProposals: unknown[] }).knowledgeProposals).toEqual([]);

    // The agent's own history still lists it, as what it is.
    const history = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), history,
    );
    expect((history.body as { knowledgeProposals: Array<Record<string, unknown>> }).knowledgeProposals[0])
      .toMatchObject({ status: 'open', draft: true });

    const decide = vi.fn(async () => ({ status: 'approved' as const, note: null }));
    deps.decideKnowledgeProposal = decide;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/knowledge/proposals/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: quiet.id }, body: { decision: 'approve' } }), res,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('not ready yet');
    expect(decide).not.toHaveBeenCalled();

    // Shown, it is the proposal it always was.
    await knowledgeProposalStorage.update(quiet.id, { draft: undefined, readyAt: new Date().toISOString() });
    const shown = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), shown);
    expect((shown.body as { knowledgeProposals: Array<Record<string, unknown>> }).knowledgeProposals)
      .toEqual([expect.objectContaining({ number: 1, status: 'open', canDecide: true })]);
  });

  it('lists the knowledge proposals an agent made beside its changes', async () => {
    const { deps } = await buildDeps();
    const { pr: change, gitPullRequestStorage } = await seedPr(deps, { status: 'merged' });
    await gitPullRequestStorage.update(change.id, { createdAt: '2026-08-01T00:00:00.000Z' });
    const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.knowledgeProposalStorage = knowledgeProposalStorage;
    const landed = await knowledgeProposalStorage.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      title: 'Write down how a deploy reaches production',
      changes: [{ page: 'deploys', action: 'create', title: 'Deploys', html: '<p>x</p>' }],
      status: 'approved',
    } as never);
    await knowledgeProposalStorage.update(landed.id, {
      createdAt: '2026-08-02T00:00:00.000Z',
      decidedAt: '2026-08-02T09:00:00.000Z',
    });
    // Another agent's page is not this agent's history, exactly as another
    // agent's change is not.
    await knowledgeProposalStorage.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-b',
      title: 'Ruby’s page',
      changes: [{ page: 'rooms', action: 'create', title: 'Rooms', html: '<p>y</p>' }],
      status: 'open',
    } as never);

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      prs: Array<Record<string, unknown>>;
      knowledgeProposals: Array<Record<string, unknown>>;
    };
    expect(body.prs.map((pr) => pr.title)).toEqual(['Rewrite checkout']);
    expect(body.knowledgeProposals.map((proposal) => proposal.title))
      .toEqual(['Write down how a deploy reaches production']);
    // What the row draws: which pages it would change, what became of it and
    // when — a decided one is most of a history, and the queue never carries
    // that stamp because every row in it is still open.
    expect(body.knowledgeProposals[0]).toMatchObject({
      number: 1, status: 'approved', pages: ['deploys'],
      decidedAt: '2026-08-02T09:00:00.000Z', agentId: 'agent-a', agentName: 'Ben',
    });
  });

  /** The knowledge base needs no git host to say what has been PROPOSED to
   *  it, so a backend with no repositories still answers for its agents. */
  it('answers with the knowledge half alone when this backend has no repositories', async () => {
    const { deps } = await buildDeps();
    const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.knowledgeProposalStorage = knowledgeProposalStorage;
    await knowledgeProposalStorage.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      title: 'Write down how a deploy reaches production',
      changes: [{ page: 'deploys', action: 'create', title: 'Deploys', html: '<p>x</p>' }],
      status: 'open',
    } as never);

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { prs: unknown[]; knowledgeProposals: Array<Record<string, unknown>> };
    expect(body.prs).toEqual([]);
    expect(body.knowledgeProposals.map((proposal) => proposal.title))
      .toEqual(['Write down how a deploy reaches production']);
  });

  it('says the whole history is unavailable only when NEITHER store is there', async () => {
    const { deps } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: 'agent-a' } }), res,
    );
    expect(res.statusCode).toBe(503);
  });

  it('refuses a proposal list for a repository that is not the caller’s', async () => {
    const { deps } = await buildDeps();
    await seedPr(deps);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/prs', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'someone-elses' } }), res,
    );
    expect(res.statusCode).toBe(404);
  });

  /**
   * The repo screen's CI activity list: every run the daemon has filed on
   * this repository, newest first, whatever commit it ran against — with the
   * sha, so a run can be traced back to its landing.
   */
  it('lists a repository’s recent CI runs, newest first, each with its commit sha', async () => {
    const { deps } = await buildDeps();
    const { repo } = await seedPr(deps);
    const statuses = new InMemoryGitCommitStatusStorage();
    deps.gitCommitStatusStorage = statuses;
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'a'.repeat(40), context: 'ci/checks',
      state: 'success', description: 'Passed in 1.2m',
      startedAt: '2026-08-13T10:00:00.000Z', completedAt: '2026-08-13T10:01:12.000Z',
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'b'.repeat(40), context: 'deploy/prod',
      state: 'skipped', description: 'Nothing to deploy',
      startedAt: '2026-08-13T11:00:00.000Z',
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/checks', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );
    expect(res.statusCode).toBe(200);
    const runs = (res.body as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs.map((r) => [r.context, r.state, r.sha])).toEqual([
      ['deploy/prod', 'skipped', 'b'.repeat(40)],
      ['ci/checks', 'success', 'a'.repeat(40)],
    ]);
  });

  it('says a stored screenshot is a PICTURE, even one filed before we knew', async () => {
    // `agentbuilt pr attach` sends the file as the whole request body, so the
    // only header it can set is `application/octet-stream` — and that used to
    // be stored as the file's type, which no screen will draw. Alex's PNG on
    // proposal #167 came out as a grey document row saying "kpage-files.png"
    // (Owner, note #22). Storage now ignores that header, and the payload
    // re-reads through the same inference so the ones ALREADY filed that way
    // heal on read rather than needing a migration to rewrite them.
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, {
      attachments: [
        {
          id: 'f1', fileName: 'kpage-files.png', contentType: 'application/octet-stream',
          sizeBytes: 437_000, storagePath: 'p/1', addedByAgentId: 'agent-a',
          addedAt: '2026-08-18T13:19:00.000Z',
        },
        // A real claim is left exactly as it was filed.
        {
          id: 'f2', fileName: 'notes.pdf', contentType: 'application/pdf',
          sizeBytes: 1_000, storagePath: 'p/2', addedByAgentId: 'agent-a',
          addedAt: '2026-08-18T13:19:00.000Z',
        },
      ],
    });
    deps.gitHostClient = {
      compare: async () => ({
        headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), baseExists: true,
        diffStat: { files: 1, insertions: 1, deletions: 0 }, commits: [],
        patch: '', patchTruncated: false,
      }),
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(res.statusCode).toBe(200);
    const files = (res.body as { pr: { attachments: Array<{ fileName: string; contentType: string }> } })
      .pr.attachments;
    expect(files.map((f) => [f.fileName, f.contentType])).toEqual([
      ['kpage-files.png', 'image/png'],
      ['notes.pdf', 'application/pdf'],
    ]);
  });

  /**
   * Note #403. `?preview=1` is the Workspace saying it is about to DRAW the
   * file, and only then does the object go out inline — a link signed to be
   * saved is downloaded by the browser rather than rendered in a frame, which
   * is the whole difference between a PDF that opens over the decision and
   * one that lands in Downloads. What may pass is the shell's own list, not
   * whatever the caller put in the query.
   */
  it('signs a proposal file to be DRAWN only when the Workspace can draw it', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, {
      attachments: [
        { id: 'f1', fileName: 'audit.pdf', contentType: 'application/pdf', sizeBytes: 9, storagePath: 'p/1', addedByAgentId: 'agent-a', addedAt: 't' },
        { id: 'f2', fileName: 'export.zip', contentType: 'application/zip', sizeBytes: 9, storagePath: 'p/2', addedByAgentId: 'agent-a', addedAt: 't' },
      ],
    });
    const createReadAccess = vi.fn().mockResolvedValue({ url: 'https://media.example/signed', expiresAt: 't' });
    deps.mediaStorage = { createReadAccess } as never;
    const read = async (file: string, query: Record<string, string> = {}) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/prs/:id/files/:file', 'get')(
        mockRequest({ headers: authHeader(42), params: { id: pr.id, file }, query }), res,
      );
      expect(res.statusCode).toBe(200);
      return createReadAccess.mock.calls.at(-1)![0] as Record<string, unknown>;
    };

    expect(await read('f1', { preview: '1' })).toMatchObject({ responseDisposition: 'inline' });
    // Without the flag it is the download it has always been…
    expect(await read('f1')).toMatchObject({ promptSaveAs: 'audit.pdf' });
    // …and asking for a preview of a kind no screen draws changes nothing:
    // this flag is the one place that decides whether a browser is invited to
    // interpret a stored object instead of filing it away.
    expect(await read('f2', { preview: '1' })).toMatchObject({ promptSaveAs: 'export.zip' });
  });

  /**
   * Note #825. On a phone the sheet's pictures waited for the words, then
   * for one more round trip per picture to mint a URL, and drew as grey
   * blocks of no particular shape. The detail now carries each picture's
   * size and a signed, cacheable, STABLE URL — the same one the fallback
   * mint hands out — and a picture attached before sizes were recorded is
   * measured once from its header and written back.
   */
  it('carries each picture’s shape and a stable signed URL in the proposal’s own answer', async () => {
    const { deps } = await buildDeps();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'),
      Buffer.from([0, 0, 0x03, 0x0c]), Buffer.from([0, 0, 0x06, 0x98]),
      Buffer.alloc(5),
    ]);
    const { pr } = await seedPr(deps, {
      attachments: [
        { id: 'f1', fileName: 'home-desk.png', contentType: 'image/png', sizeBytes: 9, storagePath: 'p/1', addedByAgentId: 'agent-a', addedAt: 't', width: 1440, height: 900 },
        // Attached before sizes were recorded: measured from its bytes.
        { id: 'f2', fileName: 'home-phone.png', contentType: 'image/png', sizeBytes: 9, storagePath: 'p/2', addedByAgentId: 'agent-a', addedAt: 't' },
        { id: 'f3', fileName: 'audit.pdf', contentType: 'application/pdf', sizeBytes: 9, storagePath: 'p/3', addedByAgentId: 'agent-a', addedAt: 't' },
      ],
    });
    let minted = 0;
    const createReadAccess = vi.fn(async (args: { storagePath: string }) => {
      minted += 1;
      return { url: `https://media.example/${args.storagePath}?sig=${minted}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    });
    const downloadObject = vi.fn(async () => png);
    deps.mediaStorage = { createReadAccess, downloadObject } as never;
    deps.gitHostClient = {
      compare: async () => ({
        headSha: 'a'.repeat(40), baseSha: 'a'.repeat(40), baseExists: true,
        diffStat: { files: 1, insertions: 2, deletions: 0 }, commits: [], patch: '', patchTruncated: false,
      }),
    } as unknown as GitHostClient;
    // One router: the stable signature is held in its memory.
    const route = routesOf(deps);
    const read = async () => {
      const res = createMockResponse();
      await route('/api/prs/:id', 'get')(mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { pr: { attachments: Array<Record<string, unknown>> } }).pr.attachments;
    };

    const first = await read();
    expect(first[0]).toMatchObject({ fileName: 'home-desk.png', width: 1440, height: 900, preview: { url: 'https://media.example/p/1?sig=1' } });
    expect(first[1]).toMatchObject({ fileName: 'home-phone.png', width: 780, height: 1688, preview: { url: expect.stringContaining('https://media.example/p/2?sig=') } });
    // A document is a row, not a picture: nothing minted, nothing measured.
    expect(first[2]).toEqual(expect.not.objectContaining({ preview: expect.anything() }));
    expect(first[2]).toEqual(expect.not.objectContaining({ width: expect.anything() }));
    // Signed to be DRAWN, and to be cached for the life of the signature.
    expect(createReadAccess.mock.calls[0]![0]).toMatchObject({ storagePath: 'p/1', responseDisposition: 'inline', responseCacheControl: expect.stringContaining('max-age=') });
    expect(downloadObject).toHaveBeenCalledTimes(1);

    // The second read hands out the SAME URL — the browser's cache serves
    // the bytes — and measures nothing again: the size was written back.
    const second = await read();
    expect(second[0]!.preview).toEqual(first[0]!.preview);
    expect(second[1]!.preview).toEqual(first[1]!.preview);
    expect(downloadObject).toHaveBeenCalledTimes(1);
    expect((await deps.gitPullRequestStorage!.get(pr.id))!.attachments![1]).toMatchObject({ width: 780, height: 1688 });

    // And the fallback mint, asked to DRAW the same picture, agrees on it.
    const file = createMockResponse();
    await route('/api/prs/:id/files/:file', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id, file: 'f1' }, query: { preview: '1' } }), file,
    );
    expect((file.body as { url: string }).url).toBe('https://media.example/p/1?sig=1');
  });

  /**
   * Follow-up to note #825. The git host's compare (110–230 ms measured from
   * production) is the slowest thing a proposal's answer waits on, and used
   * to start only after every other read. It now starts as soon as the
   * repository is known and runs while the rest is read; the answer says
   * where its time went.
   */
  it('starts the git compare before the other reads, not after them, and says where the time went', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    deps.gitHostClient = {
      compare: async () => {
        order.push('compare started');
        await held;
        order.push('compare done');
        return {
          headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseExists: true,
          diffStat: { files: 1, insertions: 2, deletions: 0 }, commits: [], patch: '', patchTruncated: false,
        };
      },
    } as unknown as GitHostClient;
    const statuses = new InMemoryGitCommitStatusStorage();
    const listBySha = statuses.listBySha.bind(statuses);
    statuses.listBySha = async (...args: Parameters<typeof listBySha>) => {
      order.push('checks read');
      release();
      return listBySha(...args);
    };
    deps.gitCommitStatusStorage = statuses;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res);
    expect(res.statusCode).toBe(200);
    // The compare was already under way when the checks were read — before
    // this change it could not start until they had been.
    expect(order.indexOf('compare started')).toBeLessThan(order.indexOf('checks read'));
    expect(order).toContain('compare done');
    expect((res.body as { diffStat: unknown }).diffStat).toEqual({ files: 1, insertions: 2, deletions: 0 });
    expect(res.headers['server-timing']).toMatch(/^rest;dur=\d+, compare;dur=\d+, total;dur=\d+$/);
  });

  it('still answers from the stored record when the compare fails, wherever it failed', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    deps.gitHostClient = { compare: async () => { throw new Error('host is down'); } } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ patch: null, compareError: 'host is down', commits: [{ subject: 'Rewrite checkout' }] });
  });

  it('refuses the CI runs of a repository that is not the caller’s', async () => {
    const { deps } = await buildDeps();
    await seedPr(deps);
    deps.gitCommitStatusStorage = new InMemoryGitCommitStatusStorage();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/checks', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'someone-elses' } }), res,
    );
    expect(res.statusCode).toBe(404);
  });

  it('shows a proposal with a LIVE compare — what an approval would merge', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    const compares: unknown[] = [];
    deps.gitHostClient = {
      compare: async (...args: unknown[]) => {
        compares.push(args);
        return {
          headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), baseExists: true,
          diffStat: { files: 2, insertions: 5, deletions: 1 },
          commits: [
            { sha: 'b'.repeat(40), subject: 'Newer subject', at: '2026-08-16T08:00:00.000Z' },
            // A host that predates the date field, which every deploy briefly
            // is: the row it feeds simply says no age.
            { sha: 'c'.repeat(40), subject: 'Older subject' },
          ],
          patch: 'diff --git a/x b/x\n', patchTruncated: false,
        };
      },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(res.statusCode).toBe(200);
    // Base and head come from the RECORDED proposal, addressed as the
    // authenticated user — nothing client-supplied reaches the host.
    expect(compares).toEqual([['user-1', 'api', 'main', 'feat/checkout']]);
    expect(res.body).toMatchObject({
      pr: expect.objectContaining({ title: 'Rewrite checkout', body: 'What changed and why.' }),
      patch: 'diff --git a/x b/x\n',
      // Subject, sha AND date: the sha is the half a reader takes to a
      // terminal, the date is what its row says happened when.
      commits: [
        { sha: 'b'.repeat(40), subject: 'Newer subject', at: '2026-08-16T08:00:00.000Z' },
        { sha: 'c'.repeat(40), subject: 'Older subject' },
      ],
      diffStat: { files: 2, insertions: 5, deletions: 1 },
    });
    // …and no `at: undefined` key smuggled onto the dateless one, which is
    // what `toMatchObject` alone would let through.
    expect(Object.keys((res.body as { commits: object[] }).commits[1]!)).toEqual(['sha', 'subject']);
  });

  /**
   * After the merge the source branch IS an ancestor of the target, so the
   * live compare is empty and the screen lost the diff at the exact moment it
   * became a record of what landed. A decided proposal therefore compares its
   * own frozen shas — the diff the user was shown when they decided.
   */
  it('shows a merged proposal its frozen diff, not the empty live compare', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, {
      status: 'merged', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
    });
    const compares: unknown[] = [];
    deps.gitHostClient = {
      compare: async (...args: unknown[]) => {
        compares.push(args);
        return {
          headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseExists: true,
          diffStat: { files: 1, insertions: 2, deletions: 0 },
          commits: [{ sha: 'a'.repeat(40), subject: 'Rewrite checkout' }],
          patch: 'diff --git a/x b/x\n', patchTruncated: false,
        };
      },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(compares).toEqual([['user-1', 'api', 'b'.repeat(40), 'a'.repeat(40)]]);
    expect(res.body).toMatchObject({ patch: 'diff --git a/x b/x\n' });
  });

  it('joins post-merge actions by the landing sha, separately from the approved branch checks', async () => {
    const { deps } = await buildDeps();
    // Keep the pending runs recent: production deliberately turns abandoned
    // pending rows into errors after 30 minutes, so fixed wall-clock fixtures
    // would make this test expire as soon as that date passed.
    const deliveryStartedMs = Date.now() - 5 * 60_000;
    const deliveryAt = (offsetMs: number) => new Date(deliveryStartedMs + offsetMs).toISOString();
    const deliveryStartedAt = deliveryAt(0);
    const { pr, repo } = await seedPr(deps, {
      status: 'merged', baseSha: 'c'.repeat(40), headSha: 'a'.repeat(40),
      mergeCommitSha: 'b'.repeat(40), deliveryStartedAt,
      decidedAt: deliveryAt(2_000),
    });
    const statuses = new InMemoryGitCommitStatusStorage();
    deps.gitCommitStatusStorage = statuses;
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'a'.repeat(40), context: 'ci/checks',
      state: 'success', description: 'Passed on feat/checkout',
      startedAt: deliveryAt(-5 * 60_000), completedAt: deliveryAt(-2 * 60_000),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'b'.repeat(40), context: 'ci/checks',
      state: 'pending', description: 'Checking main', startedAt: deliveryAt(3_000),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'b'.repeat(40), context: 'deploy/prod',
      state: 'pending', description: 'Delivering', startedAt: deliveryAt(4_000),
    });
    deps.gitHostClient = {
      compare: async () => ({
        headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), baseExists: true,
        diffStat: { files: 1, insertions: 2, deletions: 0 },
        commits: [{ sha: 'a'.repeat(40), subject: 'Rewrite checkout' }],
        patch: 'diff --git a/x b/x\n', patchTruncated: false,
      }),
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    const body = res.body as {
      checks: Array<{ context: string; state: string }>;
      delivery: { sha: string; branch: string; live: boolean; checks: Array<{ context: string; state: string }> };
    };
    expect(body.checks).toEqual([expect.objectContaining({
      context: 'ci/checks', state: 'success',
    })]);
    expect(body.delivery).toMatchObject({
      sha: 'b'.repeat(40), branch: 'main', live: false,
      checks: [
        expect.objectContaining({ context: 'ci/checks', state: 'pending' }),
        expect.objectContaining({ context: 'deploy/prod', state: 'pending' }),
      ],
    });
  });

  it('a fast-forward does not mistake the old branch pass for an instant main pass', async () => {
    const { deps } = await buildDeps();
    const deliveryStartedMs = Date.now() - 5 * 60_000;
    const deliveryAt = (offsetMs: number) => new Date(deliveryStartedMs + offsetMs).toISOString();
    const deliveryStartedAt = deliveryAt(0);
    const { pr, repo } = await seedPr(deps, {
      status: 'merged', headSha: 'a'.repeat(40), mergeCommitSha: 'a'.repeat(40),
      deliveryStartedAt, decidedAt: deliveryAt(2_000),
    });
    const statuses = new InMemoryGitCommitStatusStorage();
    deps.gitCommitStatusStorage = statuses;
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'a'.repeat(40), context: 'ci/checks',
      state: 'success', description: 'Passed on feat/checkout',
      startedAt: deliveryAt(-5 * 60_000), completedAt: deliveryAt(-2 * 60_000),
    });

    const first = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/delivery', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), first,
    );
    expect(first.body).toMatchObject({
      status: 'merged', delivery: { sha: 'a'.repeat(40), live: false, checks: [] },
    });

    // The protected-branch run overwrites ci/checks under the reused sha and
    // adds its deploy contexts. The lightweight endpoint advances in place.
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'a'.repeat(40), context: 'ci/checks',
      state: 'success', description: 'Passed on main',
      startedAt: deliveryAt(3_000), completedAt: deliveryAt(2 * 60_000),
    });
    await statuses.upsert({
      userId: 'user-1', repoId: repo.id, sha: 'a'.repeat(40), context: 'deploy/prod',
      state: 'success', description: 'Live',
      startedAt: deliveryAt(2 * 60_000 + 1_000), completedAt: deliveryAt(3 * 60_000),
    });
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/delivery', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), live,
    );
    expect(live.body).toMatchObject({
      status: 'merged',
      delivery: {
        live: true,
        checks: [
          expect.objectContaining({ context: 'ci/checks', state: 'success' }),
          expect.objectContaining({ context: 'deploy/prod', state: 'success' }),
        ],
      },
    });
  });

  it('carries the repository\'s CI switch on the proposal and on every landing poll (note #662)', async () => {
    const { deps } = await buildDeps();
    const { pr, repo } = await seedPr(deps, {
      status: 'merged', headSha: 'a'.repeat(40), mergeCommitSha: 'b'.repeat(40),
      decidedAt: new Date().toISOString(),
    });
    deps.gitCommitStatusStorage = new InMemoryGitCommitStatusStorage();
    deps.gitHostClient = {
      compare: async () => ({
        headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), baseExists: true,
        diffStat: { files: 1, insertions: 2, deletions: 0 },
        commits: [], patch: '', patchTruncated: false,
      }),
    } as unknown as GitHostClient;
    const read = async () => {
      const detail = createMockResponse();
      await getRouteHandler(deps, '/api/prs/:id', 'get')(
        mockRequest({ headers: authHeader(42), params: { id: pr.id } }), detail,
      );
      const poll = createMockResponse();
      await getRouteHandler(deps, '/api/prs/:id/delivery', 'get')(
        mockRequest({ headers: authHeader(42), params: { id: pr.id } }), poll,
      );
      return [detail.body, poll.body] as Array<{ ci?: boolean; delivery: { ci: boolean } }>;
    };

    // Never switched on: off, on the proposal and on both landings.
    const [detail, poll] = await read();
    expect(detail.ci).toBe(false);
    expect(detail.delivery.ci).toBe(false);
    expect(poll.delivery.ci).toBe(false);

    await deps.gitRepoStorage!.update(repo.id, { ci: true });
    const [onDetail, onPoll] = await read();
    expect(onDetail.ci).toBe(true);
    expect(onDetail.delivery.ci).toBe(true);
    expect(onPoll.delivery.ci).toBe(true);
  });

  /**
   * Every repo's FIRST proposal has no base: `git init --bare` leaves the
   * protected branch with no commits, so there was nothing to branch from.
   * The empty tree is that proposal's base — the host cannot peel it to a
   * commit and falls back to diffing from the empty tree, which is the
   * intended reading: all of it is new.
   */
  it('compares a decided first proposal against the empty tree', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, { status: 'merged', headSha: 'a'.repeat(40) });
    const compares: unknown[] = [];
    deps.gitHostClient = {
      compare: async (...args: unknown[]) => {
        compares.push(args);
        return {
          headSha: 'a'.repeat(40), baseSha: null, baseExists: false,
          diffStat: { files: 1, insertions: 2, deletions: 0 },
          commits: [], patch: 'diff --git a/x b/x\n', patchTruncated: false,
        };
      },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(compares).toEqual([['user-1', 'api', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'a'.repeat(40)]]);
  });

  it('still shows the proposal when the live compare fails, and says why', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    deps.gitHostClient = {
      compare: async () => { throw new Error('unknown branch feat/checkout'); },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      patch: null,
      compareError: 'unknown branch feat/checkout',
      // The frozen half of the record: the shas of a compare that just failed
      // are exactly what this branch does not have.
      commits: [{ subject: 'Rewrite checkout' }],
      diffStat: { files: 1, insertions: 2, deletions: 0 },
    });
  });

  it('404s a proposal that is not the caller’s own — without asking the host', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, { userId: 'user-9' });
    let hostCalled = false;
    deps.gitHostClient = {
      compare: async () => { hostCalled = true; throw new Error('never'); },
    } as unknown as GitHostClient;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res,
    );
    expect(res.statusCode).toBe(404);
    expect(hostCalled).toBe(false);
  });

  /**
   * A quiet proposal (Owner, note #293) — recorded by `pr create`, not yet
   * made ready by its agent — is invisible to every decision surface: not
   * in Home's queue, not in the agents picker's, and the decision route refuses it
   * before the shared flow is even asked. Its own screen still opens and
   * says so, with nothing to tap.
   */
  it('keeps a quiet proposal out of the queue and out of reach of a decision', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps, { draft: true });
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      compare: () => Promise.resolve({ files: [], diffStat: { files: 0, insertions: 0, deletions: 0 }, commits: [] }),
    } as unknown as GitHostClient;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const body = state.body as { prs: unknown[]; agents: Array<Record<string, unknown>> };
    expect(body.prs).toEqual([]);
    // Nor in the workplace queue the agents picker reads (note #721).
    const everywhere = createMockResponse();
    await getRouteHandler(deps, '/api/decisions', 'get')(mockRequest({ headers: authHeader(42) }), everywhere);
    expect((everywhere.body as { prs: unknown[] }).prs).toEqual([]);
    // The agent's row must not say "waiting on you" over it either.
    expect(body.agents.find((agent) => agent.id === 'agent-a')?.doing).toBeUndefined();

    const one = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id } }), one,
    );
    expect(one.statusCode).toBe(200);
    expect((one.body as { pr: Record<string, unknown> }).pr)
      .toMatchObject({ status: 'open', draft: true, canDecide: false });

    const decide = vi.fn(async () => ({ status: 'merged' as const, note: null }));
    deps.decidePullRequest = decide;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id }, body: { decision: 'approve' } }), res,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('not ready yet');
    expect(decide).not.toHaveBeenCalled();

    // Shown, it is the proposal it always was.
    await deps.gitPullRequestStorage!.update(pr.id, { draft: undefined, readyAt: new Date().toISOString() });
    const shown = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), shown);
    expect((shown.body as { prs: Array<Record<string, unknown>> }).prs)
      .toEqual([expect.objectContaining({ number: 1, status: 'open', canDecide: true })]);
    expect((shown.body as { prs: Array<Record<string, unknown>> }).prs[0]).not.toHaveProperty('draft');
  });

  it('hands a decision to the shared flow verbatim and returns its outcome', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    const decisions: unknown[] = [];
    deps.decidePullRequest = vi.fn(async (args) => {
      decisions.push(args);
      return { status: 'merged' as const, note: null };
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({
        headers: authHeader(42),
        params: { id: pr.id },
        // headSha: what the screen rendered — the flow re-asks on a mismatch,
        // so the route must hand it through untouched.
        body: { decision: 'approve', headSha: 'a'.repeat(40) },
      }), res,
    );
    expect(res.statusCode).toBe(200);
    expect(decisions).toEqual([{
      userId: 'user-1', pullRequestId: pr.id, decision: 'approve', shownHeadSha: 'a'.repeat(40),
    }]);
    expect(res.body).toEqual({ ok: true, status: 'merged', note: null });
  });

  it('hands a rejection reason through, trimmed — and never on an approval', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    const decisions: Array<Record<string, unknown>> = [];
    deps.decidePullRequest = vi.fn(async (args) => {
      decisions.push(args as Record<string, unknown>);
      return { status: 'rejected' as const, note: null };
    });

    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({
        headers: authHeader(42), params: { id: pr.id },
        body: { decision: 'reject', note: '  fix the error handling  ' },
      }), createMockResponse(),
    );
    expect(decisions[0]?.note).toBe('fix the error handling');

    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({
        headers: authHeader(42), params: { id: pr.id },
        // An approval explains itself — a note riding one is dropped here.
        body: { decision: 'approve', note: 'should not travel' },
      }), createMockResponse(),
    );
    expect(decisions[1]?.note).toBeUndefined();
  });

  it('rejects a decision verb it does not know', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    deps.decidePullRequest = vi.fn(async () => ({ status: null, note: null }));
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id }, body: { decision: 'merge' } }), res,
    );
    expect(res.statusCode).toBe(400);
    expect(deps.decidePullRequest).not.toHaveBeenCalled();
  });

  it('503s the decision when the flow is not wired', async () => {
    const { deps } = await buildDeps();
    const { pr } = await seedPr(deps);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: pr.id }, body: { decision: 'approve' } }), res,
    );
    expect(res.statusCode).toBe(503);
  });

  /**
   * The proposal's margin (note #66): the person writes in the same thread
   * the agents do. What travels up is plain TEXT — the markup is the
   * server's job, exactly as the note box works — and what comes back is
   * the whole thread, stamped as the person's own.
   */
  it('takes the user’s remark as text, stamps it theirs, and answers the whole thread', async () => {
    const { deps } = await buildDeps();
    const { pr, gitPullRequestStorage } = await seedPr(deps);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/comments', 'post')(
      mockRequest({
        headers: authHeader(42), params: { id: pr.id },
        body: { text: 'Why this table?\nAnd why now?' },
      }), res,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; comments: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    // A person's remark, signed as one: the viewer's own name, and `self` so
    // the screen can offer their own page behind the face.
    expect(body.comments).toEqual([expect.objectContaining({
      byPerson: true, self: true, userName: 'U', authorUserId: 'user-1',
    })]);
    // The line break typed in the box became markup the margin renders — the
    // text was converted server-side, never stored raw.
    expect(body.comments[0]!.text).toBe('<p>Why this table?<br>And why now?</p>');
    // And the stored remark says a PERSON wrote it: the sentinel author plus
    // WHICH person, which is what survives for every later reader.
    const stored = (await gitPullRequestStorage.get(pr.id))!.comments!;
    expect(stored).toEqual([expect.objectContaining({ authorId: 'user', userId: 'user-1' })]);
  });

  it('replaces only the user’s own remark, marks the edit, and never wakes an @mention again', async () => {
    const { deps } = await buildDeps();
    const { pr, gitPullRequestStorage } = await seedPr(deps);
    const own = newMarginComment('user', '<p>Before.</p>', 'user-1');
    const agent = newMarginComment('agent-a', '<p>The agent said this.</p>', 'user-1');
    const teammate = newMarginComment('user', '<p>A teammate said this.</p>', 'user-2');
    await gitPullRequestStorage.addComment(pr.id, own);
    await gitPullRequestStorage.addComment(pr.id, agent);
    await gitPullRequestStorage.addComment(pr.id, teammate);
    const messageAgentFromUser = vi.fn();
    deps.agentLifecycle = { messageAgentFromUser } as never;
    const edit = getRouteHandler(deps, '/api/prs/:id/comments/:commentId', 'put');

    const saved = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(42),
      params: { id: pr.id, commentId: own.id },
      body: { text: '@Ben corrected this.\nAnd kept the second line.' },
    }), saved);

    expect(saved.statusCode).toBe(200);
    const answer = saved.body as { ok: boolean; comments: Array<Record<string, unknown>> };
    expect(answer.ok).toBe(true);
    expect(answer.comments).toHaveLength(3);
    expect(answer.comments[0]).toMatchObject({
      id: own.id,
      text: '<p>@Ben corrected this.<br>And kept the second line.</p>',
      createdAt: own.createdAt,
      editedAt: expect.any(String),
      byPerson: true,
      self: true,
      editableText: '@Ben corrected this.\nAnd kept the second line.',
    });
    for (const comment of answer.comments.slice(1)) {
      expect(comment).not.toHaveProperty('self');
      expect(comment).not.toHaveProperty('editableText');
    }
    const stored = (await gitPullRequestStorage.get(pr.id))!.comments!;
    expect(stored.map((comment) => comment.text)).toEqual([
      '<p>@Ben corrected this.<br>And kept the second line.</p>',
      '<p>The agent said this.</p>',
      '<p>A teammate said this.</p>',
    ]);
    expect(stored[0]).toMatchObject({ id: own.id, createdAt: own.createdAt, editedAt: expect.any(String) });
    expect(messageAgentFromUser).not.toHaveBeenCalled();

    for (const comment of [agent, teammate]) {
      const refused = createMockResponse();
      await edit(mockRequest({
        headers: authHeader(42),
        params: { id: pr.id, commentId: comment.id },
        body: { text: 'Rewritten.' },
      }), refused);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toEqual({ error: 'Only your own comments can be edited.' });
    }

    const missing = createMockResponse();
    await edit(mockRequest({
      headers: authHeader(42), params: { id: pr.id, commentId: 'missing' }, body: { text: 'No.' },
    }), missing);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ error: 'No such comment.' });
  });

  /**
   * Note #647: the author of a remark may take it back. The thread that comes
   * back is the whole margin without it — a withdrawn remark leaves nothing
   * behind, because a margin says what stands now rather than what was once
   * said. Everybody else's words, the agent's included, are untouchable.
   */
  it('takes back only the user’s own remark and answers with the thread left standing', async () => {
    const { deps } = await buildDeps();
    const { pr, gitPullRequestStorage } = await seedPr(deps);
    const own = newMarginComment('user', '<p>Before.</p>', 'user-1');
    const agent = newMarginComment('agent-a', '<p>The agent said this.</p>', 'user-1');
    const teammate = newMarginComment('user', '<p>A teammate said this.</p>', 'user-2');
    await gitPullRequestStorage.addComment(pr.id, own);
    await gitPullRequestStorage.addComment(pr.id, agent);
    await gitPullRequestStorage.addComment(pr.id, teammate);
    const remove = getRouteHandler(deps, '/api/prs/:id/comments/:commentId', 'delete');

    // Somebody else's words first: a refusal must not depend on the reader's
    // own remark still being there.
    for (const comment of [agent, teammate]) {
      const refused = createMockResponse();
      await remove(mockRequest({
        headers: authHeader(42), params: { id: pr.id, commentId: comment.id },
      }), refused);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toEqual({ error: 'Only your own comments can be deleted.' });
    }
    expect((await gitPullRequestStorage.get(pr.id))!.comments).toHaveLength(3);

    const gone = createMockResponse();
    await remove(mockRequest({ headers: authHeader(42), params: { id: pr.id, commentId: own.id } }), gone);
    expect(gone.statusCode).toBe(200);
    const answer = gone.body as { ok: boolean; comments: Array<Record<string, unknown>> };
    expect(answer.ok).toBe(true);
    expect(answer.comments.map((comment) => comment.text)).toEqual([
      '<p>The agent said this.</p>',
      '<p>A teammate said this.</p>',
    ]);
    const stored = (await gitPullRequestStorage.get(pr.id))!.comments!;
    expect(stored.map((comment) => comment.id)).toEqual([agent.id, teammate.id]);

    // Gone is gone: a second tap from a stale screen is a plain 404, not a
    // second removal of whatever now stands in that place.
    const again = createMockResponse();
    await remove(mockRequest({ headers: authHeader(42), params: { id: pr.id, commentId: own.id } }), again);
    expect(again.statusCode).toBe(404);
    expect(again.body).toEqual({ error: 'No such comment.' });
  });

  it('registers the same own-comment edit and delete verbs on every Workspace margin', async () => {
    const { deps } = await buildDeps();
    for (const path of [
      '/api/prs/:id/comments/:commentId',
      '/api/knowledge/proposals/:id/comments/:commentId',
      '/api/knowledge/pages/:name/comments/:commentId',
      '/api/notes/:number/comments/:commentId',
    ]) {
      expect(() => getRouteHandler(deps, path, 'put'), path).not.toThrow();
      expect(() => getRouteHandler(deps, path, 'delete'), path).not.toThrow();
    }
  });

  /**
   * Note #518: a comment is a WRITE and nothing else. Nothing in the words
   * picks a recipient — an `@Name` is prose and a `mentions` list an old
   * client still sends is ignored — and nothing in the DOCUMENT picks one
   * either: the agent that opened this very proposal, idle and standing in
   * its room, is left alone too. The remark waits on the record for whoever
   * opens the proposal next.
   */
  it('starts nobody at all, and keeps the words exactly as written', async () => {
    const { deps } = await buildDeps();
    // Seeded so every door that ever opened is standing open: agent-a (Ben)
    // is this account's own agent, in this proposal's room, and its author.
    const { pr, gitPullRequestStorage } = await seedPr(deps);
    const messageAgentFromUser = vi.fn();
    deps.agentLifecycle = { messageAgentFromUser } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/comments', 'post')(
      mockRequest({
        headers: authHeader(42), params: { id: pr.id },
        body: {
          text: '@Ben why this table? Ask @Ruby too.',
          mentions: ['agent-a', 'agent-b'],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    // The remark is the primary write, saved as the person's own, untouched.
    expect((await gitPullRequestStorage.get(pr.id))!.comments).toEqual([
      expect.objectContaining({
        authorId: 'user',
        text: '<p>@Ben why this table? Ask @Ruby too.</p>',
      }),
    ]);
    expect(messageAgentFromUser).not.toHaveBeenCalled();
    // And the screen is told nothing about a delivery, because there is none.
    expect(res.body).not.toHaveProperty('authorDelivery');
    expect(res.body).not.toHaveProperty('mentionDelivery');
  });

  /** The same rule on the other decision queue, where the author path also
   *  used to run (note #239, removed in #518). */
  it('starts nobody on a knowledge proposal either', async () => {
    const { deps } = await buildDeps();
    const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.knowledgeProposalStorage = knowledgeProposalStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
    } as unknown as GitHostClient;
    // Opened by agent-a again — this account's own agent, and the one the
    // author path would have started.
    const proposal = await knowledgeProposalStorage.create({
      userId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      title: 'Write down how a deploy reaches production',
      changes: [{ page: 'deploys', action: 'create', title: 'Deploys', html: '<p>x</p>' }],
      status: 'open',
    } as never);
    const messageAgentFromUser = vi.fn();
    deps.agentLifecycle = { messageAgentFromUser } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/knowledge/proposals/:id/comments', 'post')(
      mockRequest({
        headers: authHeader(42), params: { id: proposal.id },
        body: { text: '@Ben why this wording?' },
      }), res,
    );

    expect(res.statusCode).toBe(200);
    expect((await knowledgeProposalStorage.get(proposal.id))!.comments).toHaveLength(1);
    expect(messageAgentFromUser).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('authorDelivery');
  });

  it('carries the thread on the proposal screen, naming the agent behind a remark', async () => {
    const { deps } = await buildDeps();
    const { pr, gitPullRequestStorage } = await seedPr(deps);
    deps.gitHostClient = {
      compare: async () => ({
        headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), baseExists: true,
        diffStat: { files: 1, insertions: 1, deletions: 0 }, commits: [],
        patch: '', patchTruncated: false,
      }),
    } as unknown as GitHostClient;
    const handler = getRouteHandler(deps, '/api/prs/:id', 'get');

    // Before anyone speaks the margin is an EMPTY ARRAY, not absent — the
    // screen keys the whole Comments card off the field being there.
    const bare = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { id: pr.id } }), bare);
    expect((bare.body as { pr: { comments: unknown[] } }).pr.comments).toEqual([]);

    await gitPullRequestStorage.addComment(pr.id, newMarginComment('agent-a', '<p>Checks are green.</p>'));
    const res = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { id: pr.id } }), res);
    expect((res.body as { pr: { comments: unknown[] } }).pr.comments).toEqual([
      expect.objectContaining({ text: '<p>Checks are green.</p>', agentName: 'Ben' }),
    ]);
  });

  it('closes the margin with the decision, caps the thread, and refuses empty words', async () => {
    const { deps } = await buildDeps();
    const closedComment = newMarginComment('user', '<p>Already decided.</p>', 'user-1');
    const { pr } = await seedPr(deps, { status: 'merged', comments: [closedComment] });
    const handler = getRouteHandler(deps, '/api/prs/:id/comments', 'post');

    // Decided means decided: the question the margin was for is answered.
    const decided = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { id: pr.id }, body: { text: 'Too late?' } }), decided);
    expect(decided.statusCode).toBe(409);
    const editDecided = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id/comments/:commentId', 'put')(
      mockRequest({
        headers: authHeader(42), params: { id: pr.id, commentId: closedComment.id }, body: { text: 'Too late.' },
      }),
      editDecided,
    );
    expect(editDecided.statusCode).toBe(409);

    // A fresh seed replaces the storage on deps, so the open proposal's
    // thread is filled on the storage the route now reads.
    const { pr: open, gitPullRequestStorage } = await seedPr(deps);
    // Nothing typed is not a remark, in the units the person typed in.
    const empty = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { id: open.id }, body: { text: '   ' } }), empty);
    expect(empty.statusCode).toBe(400);
    expect((empty.body as { error: string }).error).toBe('Write something first.');

    // The fiftieth remark is the last one a proposal holds.
    for (let i = 0; i < 50; i++) {
      await gitPullRequestStorage.addComment(open.id, newMarginComment('agent-a', `<p>${i}</p>`));
    }
    const full = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { id: open.id }, body: { text: 'One more.' } }), full);
    expect(full.statusCode).toBe(400);
    expect((await gitPullRequestStorage.get(open.id))!.comments).toHaveLength(50);
  });
});

describe('a person’s public page (public-addresses, slice 5)', () => {
  const seed = async () => {
    const built = await buildDeps();
    const { deps, userStorage } = built;
    await userStorage.updateProfile('user-1', {
      telegram: { ...(await userStorage.getProfile('user-1'))!.telegram, firstName: 'Adam', lastName: 'Reyes' } as never,
      person: { firstName: 'Adam', lastName: 'Reyes' },
    } as never);
    await userStorage.createProfile('user-2', { email: 'dana@example.com', displayName: 'Dana' });
    deps.mailboxes = {
      holderOf: async (address: string) => (address === 'adam@agenticcloudcomputer.com' ? 'user-1' : null),
      forUser: async () => null,
    } as never;
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'user-1' });
    await orgStorage.claimHandle(org.orgId, 'acme-trading');
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const counted = (email: string) => ({
      sha: 'abc', countedAt: '2026-09-26T00:00:00.000Z',
      authors: [{ name: 'someone', email, commits: 4, insertions: 10, deletions: 2 }],
    });
    await gitRepoStorage.create({
      userId: 'user-1', orgId: org.orgId, name: 'site', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: { id: '11111111-1111-4111-8111-111111111111', publishedAt: 't', publishedByUserId: 'user-1' },
      contributors: counted('adam@agenticcloudcomputer.com'),
    } as never);
    // Counted under the sign-in email, the other address git may know them by.
    await gitRepoStorage.create({
      userId: 'user-1', orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: { id: '22222222-2222-4222-8222-222222222222', publishedAt: 't', publishedByUserId: 'user-1' },
      contributors: counted('U@EXAMPLE.COM'),
    } as never);
    // Private, and somebody else's: neither is theirs to show.
    await gitRepoStorage.create({
      userId: 'user-1', orgId: org.orgId, name: 'secret', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
      contributors: counted('adam@agenticcloudcomputer.com'),
    } as never);
    await gitRepoStorage.create({
      userId: 'user-1', orgId: org.orgId, name: 'other', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
      publicAccess: { id: '33333333-3333-4333-8333-333333333333', publishedAt: 't', publishedByUserId: 'user-1' },
      contributors: counted('dana@example.com'),
    } as never);
    deps.gitRepoStorage = gitRepoStorage;
    return { ...built, org, orgStorage };
  };
  const read = async (deps: Partial<RouteDeps>, handle: string, headers?: Record<string, string>) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/public/people/:handle', 'get')(mockRequest({ params: { handle }, ...(headers ? { headers } : {}) }), res);
    return res;
  };

  it('tells a stranger the name, the address and the public repositories git counts them in — and nothing else', async () => {
    const { deps } = await seed();
    const res = await read(deps, 'adam');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      handle: 'adam',
      name: 'Adam Reyes',
      repos: [
        { name: 'site', workplace: 'Acme Trading', workplaceHandle: 'acme-trading', publicUrl: 'https://workspace.test/acme-trading/site', commits: 4 },
        { name: 'api', workplace: 'Acme Trading', workplaceHandle: 'acme-trading', publicUrl: 'https://workspace.test/acme-trading/api', commits: 4 },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/example\.com|user-1|secret|other/);
  });

  it('answers a handle nobody holds, a reserved word and a malformed one with the same 404', async () => {
    const { deps } = await seed();
    for (const handle of ['nobody', 'support', 'login', 'Adam', 'ab', 'adam_x']) {
      const res = await read(deps, handle);
      expect(res.statusCode, handle).toBe(404);
      expect(res.body, handle).toEqual({ error: 'Nothing at this address.' });
    }
  });

  it('sends a signed-in colleague on to the member screen of the workplace they share, and nobody else', async () => {
    const { deps, org, orgStorage } = await seed();
    // Signed in, but sharing no workplace: the public page, as for a stranger.
    const stranger = await read(deps, 'adam', authHeader(43));
    expect(stranger.statusCode).toBe(200);
    expect((stranger.body as { colleague?: unknown }).colleague).toBeUndefined();
    // The person reading their own page sees it as a stranger would.
    const self = await read(deps, 'adam', authHeader(42));
    expect((self.body as { colleague?: unknown }).colleague).toBeUndefined();

    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member' });
    const colleague = await read(deps, 'adam', authHeader(43));
    expect(colleague.statusCode).toBe(200);
    expect((colleague.body as { colleague?: unknown }).colleague).toEqual({ orgId: org.orgId, userId: 'user-1' });
  });
});

describe('a builder’s numbers (note #200), on their own page since the Leaderboard went (note #824)', () => {
  const seed = async () => {
    const built = await buildDeps();
    const { deps, userStorage } = built;
    await userStorage.updateProfile('user-1', { person: { firstName: 'Adam', lastName: 'Reyes' } } as never);
    await userStorage.createProfile('user-2', { email: 'dana@example.com', displayName: 'Dana' });
    await userStorage.createProfile('user-3', { email: 'team@example.com', displayName: 'Team test', roles: { internal: true } } as never);
    deps.mailboxes = {
      holderOf: async (address: string) => ({ 'adam@agenticcloudcomputer.com': 'user-1', 'dana@agenticcloudcomputer.com': 'user-2' } as Record<string, string>)[address] ?? null,
      forUser: async (userId: string) => ({ 'user-1': { address: 'adam@agenticcloudcomputer.com' }, 'user-2': { address: 'dana@agenticcloudcomputer.com' } } as Record<string, { address: string }>)[userId] ?? null,
    } as never;
    const ledger = new InMemoryAgentWorkLedger();
    const today = new Date().toISOString().slice(0, 10);
    ledger.credit({ userId: 'user-1', agentId: 'agent-a', orgId: null, agentName: 'Ben', month: today.slice(0, 7), day: today, ms: 7_200_000 });
    ledger.credit({ userId: 'user-2', agentId: 'agent-z', orgId: null, agentName: 'Zed', month: today.slice(0, 7), day: today, ms: 3_600_000 });
    deps.agentWorkLedger = ledger;
    const tokens = new InMemoryAgentTokenLedger();
    tokens.credit({ userId: 'user-1', agentId: 'agent-a', orgId: null, agentName: 'Ben', day: today, provider: 'claude', model: 'opus', input: 5, output: 4_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    deps.agentTokenLedger = tokens;
    deps.gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    deps.agentLifecycle = { isAgentWorking: (_userId: string, agentId: string) => agentId === 'agent-b' } as never;
    return built;
  };
  const call = async (deps: Partial<RouteDeps>, route: string, method: 'get' | 'put', init: { headers?: Record<string, string>; params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) => {
    const res = createMockResponse();
    await getRouteHandler(deps, route, method)(mockRequest(init), res);
    return res;
  };

  it('has no public board any more (note #824), nor its Settings switch', async () => {
    const { deps } = await seed();
    expect(() => getRouteHandler(deps, '/api/public/leaderboard', 'get')).toThrow();
    expect(() => getRouteHandler(deps, '/api/profile/leaderboard', 'get')).toThrow();
    expect(() => getRouteHandler(deps, '/api/profile/leaderboard', 'put')).toThrow();
  });

  it('keeps the X profile Settings saves, however it was pasted, and clears it', async () => {
    const { deps, userStorage } = await seed();
    expect((await call(deps, '/api/profile/x', 'get', { headers: authHeader(42) })).body).toEqual({});
    const saved = await call(deps, '/api/profile/x', 'put', { headers: authHeader(42), body: { x: 'https://x.com/AdamBuilds' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toEqual({ x: 'AdamBuilds' });
    expect((await userStorage.getProfile('user-1'))!.person).toMatchObject({ x: 'AdamBuilds', firstName: 'Adam' });
    const cleared = await call(deps, '/api/profile/x', 'put', { headers: authHeader(42), body: { x: '' } });
    expect(cleared.body).toEqual({});
  });

  it('refuses what cannot be an X handle, and anyone signed out', async () => {
    const { deps } = await seed();
    const badX = await call(deps, '/api/profile/x', 'put', { headers: authHeader(42), body: { x: 'not a handle' } });
    expect(badX.statusCode).toBe(400);
    const anonymous = await call(deps, '/api/profile/x', 'put', { body: { x: 'adam' } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('shows a builder their own numbers, and nobody else, whatever the old switch said', async () => {
    const { deps, userStorage } = await seed();
    // Dana once turned the Leaderboard off: read by nothing now.
    await userStorage.updatePersonFields('user-2', { x: 'dana', leaderboard: false } as never);
    const own = await call(deps, '/api/public/people/:handle', 'get', { params: { handle: 'dana' }, headers: authHeader(43) });
    expect(own.body).toMatchObject({
      handle: 'dana',
      x: 'dana',
      board: { agents: 0, working: 0, week: { workingMs: 3_600_000, merged: 0 } },
    });
    expect((own.body as WorkspacePublicPersonAnswer).board).not.toHaveProperty('place');
    // A stranger, and someone else signed in, read the page as it always was.
    for (const headers of [undefined, authHeader(42)]) {
      const other = await call(deps, '/api/public/people/:handle', 'get', { params: { handle: 'dana' }, ...(headers ? { headers } : {}) });
      expect(other.statusCode).toBe(200);
      expect(other.body).not.toHaveProperty('board');
      expect(other.body).not.toHaveProperty('x');
    }
  });

  it('shows the founder’s numbers to anyone, as the front page does (note #786), and never a team account’s', async () => {
    const { deps, userStorage } = await seed();
    await userStorage.updatePersonFields('user-1', { x: 'AdamBuilds' });
    const adam = await call(deps, '/api/public/people/:handle', 'get', { params: { handle: 'adam' } });
    expect(adam.body).toMatchObject({
      handle: 'adam',
      name: 'Adam Reyes',
      x: 'AdamBuilds',
      board: { agents: 2, working: 1, week: { workingMs: 7_200_000, merged: 0, claude: 4_000 } },
    });
    const address = await call(deps, '/api/public/addresses/:handle', 'get', { params: { handle: 'adam' } });
    expect(address.body).toMatchObject({ kind: 'person', person: { board: { week: { workingMs: 7_200_000 } } } });
    expect(JSON.stringify(adam.body)).not.toMatch(/Dana|Team test|example\.com|user-1|Ben/);
  });

  it('opens each day of their grid with that day’s counts, as the ledgers hold them (note #208)', async () => {
    const { deps } = await seed();
    const now = Date.now();
    const today = tokenDayKey(now);
    const merge = (decidedAt: string, createdByUserId = 'user-1') => deps.gitPullRequestStorage!.create({
      repoId: 'r', userId: createdByUserId, title: 'T', body: 'B', sourceBranch: 'f', targetBranch: 'main',
      headSha: 'h', baseSha: 'g', diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['S'],
      createdByAgentId: 'agent-a', createdByUserId, status: 'merged', decidedAt,
    } as never);
    await merge(new Date(now).toISOString());
    await merge(new Date(now).toISOString());
    await merge(new Date(now - 86_400_000).toISOString());
    await merge(new Date(now).toISOString(), 'user-2'); // Dana's: not Adam's day
    deps.agentWorkLedger!.credit({ userId: 'user-1', agentId: 'agent-b', orgId: null, agentName: 'Ivy', month: today.slice(0, 7), day: today, ms: 600_000 });
    deps.agentTokenLedger!.credit({ userId: 'user-1', agentId: 'agent-b', orgId: null, agentName: 'Ivy', day: today, provider: 'codex', model: 'gpt', input: 1, output: 900, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

    const res = await call(deps, '/api/public/people/:handle', 'get', { params: { handle: 'adam' } });
    const board = (res.body as WorkspacePublicPersonAnswer).board!;
    expect(board.days).toHaveLength(board.grid.length);
    const square = board.days.at(-1)!;
    // Today's square is exactly the ledgers' today for this person.
    const worked = deps.agentWorkLedger!.daysSince(today).filter((row) => row.userId === 'user-1');
    const wrote = deps.agentTokenLedger!.userDays('user-1', today);
    const merged = (await deps.gitPullRequestStorage!.listMergedSince(`${today}T00:00:00.000Z`)).filter((pr) => pr.createdByUserId === 'user-1');
    expect(square).toEqual({
      workingMs: worked.reduce((sum, row) => sum + row.ms, 0),
      merged: merged.length,
      claude: wrote.filter((row) => row.provider === 'claude').reduce((sum, row) => sum + row.output, 0),
      codex: wrote.filter((row) => row.provider === 'codex').reduce((sum, row) => sum + row.output, 0),
    });
    expect(square).toEqual({ workingMs: 7_800_000, merged: 2, claude: 4_000, codex: 900 });
    expect(board.days.at(-2)).toMatchObject({ merged: 1 });
    // No hours before the ledger kept days: null, never a zero.
    board.days.forEach((day, index) => {
      const date = leaderboardDayAt(board.gridStart, index);
      if (date < LEADERBOARD_DAYS_FROM) expect(day.workingMs, date).toBeNull();
      else expect(day.workingMs, date).toEqual(expect.any(Number));
    });
  });

  it('gives a builder’s page their totals over every day the ledgers hold (note #209)', async () => {
    const { deps } = await seed();
    const today = tokenDayKey(Date.now());
    const earlier = leaderboardDayAt(today, -20);
    deps.agentWorkLedger!.credit({ userId: 'user-1', agentId: 'agent-b', orgId: null, agentName: 'Ivy', month: earlier.slice(0, 7), day: earlier, ms: 1_800_000 });
    deps.agentTokenLedger!.credit({ userId: 'user-1', agentId: 'agent-b', orgId: null, agentName: 'Ivy', day: earlier, provider: 'claude', model: 'opus', input: 1, output: 6_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    const res = await call(deps, '/api/public/people/:handle', 'get', { params: { handle: 'adam' } });
    const board = (res.body as WorkspacePublicPersonAnswer).board!;
    const worked = deps.agentWorkLedger!.daysSince('0000-01-01').filter((row) => row.userId === 'user-1');
    const wrote = deps.agentTokenLedger!.userDays('user-1', '0000-01-01');
    expect(board.allTime).toEqual({
      workingMs: worked.reduce((sum, row) => sum + row.ms, 0),
      claude: wrote.filter((row) => row.provider === 'claude').reduce((sum, row) => sum + row.output, 0),
    });
    expect(board.allTime).toEqual({ workingMs: 9_000_000, claude: 10_000 });
  });
});

describe('a workplace’s word and its repositories at their address (slice 6, note #748)', () => {
  const seed = async () => {
    const built = await buildDeps();
    const { deps, userStorage } = built;
    await userStorage.createProfile('user-2', { email: 'dana@example.com', displayName: 'Dana' });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'user-1' });
    await orgStorage.claimHandle(org.orgId, 'acme');
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    deps.orgStorage = orgStorage;
    deps.mailboxes = { holderOf: async () => null, forUser: async () => null } as never;
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const base = { userId: 'user-1', orgId: org.orgId, createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true };
    await gitRepoStorage.create({ ...base, name: 'site', publicAccess: { id: '11111111-1111-4111-8111-111111111111', publishedAt: '2026-09-01T00:00:00.000Z', publishedByUserId: 'user-1' } } as never);
    await gitRepoStorage.create({ ...base, name: 'secret' } as never);
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      tree: async (_userId: string, _name: string, path: string) => ({ branch: 'main', entries: path ? [] : [{ name: 'README.md', type: 'file', sizeBytes: 10 }] }),
      file: async () => ({ branch: 'main', sizeBytes: 7, content: 'hello\n' }),
    } as unknown as GitHostClient;
    return { ...built, org, orgStorage };
  };
  const call = async (deps: Partial<RouteDeps>, route: string, params: Record<string, string>, headers?: Record<string, string>, query: Record<string, string> = {}) => {
    const res = createMockResponse();
    await getRouteHandler(deps, route, 'get')(mockRequest({ params, query, ...(headers ? { headers } : {}) }), res);
    return res;
  };

  it('has no public page: a stranger gets "Nothing at this address" for a workplace’s handle, exactly as for a word nobody holds (note #748)', async () => {
    const { deps } = await seed();
    const nobody = await call(deps, '/api/public/addresses/:handle', { handle: 'nobody' });
    expect(nobody.statusCode).toBe(404);
    expect(nobody.body).toEqual({ error: 'Nothing at this address.' });
    // Signed out, and signed in to somebody else's account: the same answer
    // as the word nobody holds, on both doors.
    for (const headers of [undefined, authHeader(43)]) {
      for (const route of ['/api/public/addresses/:handle', '/api/public/workplaces/:handle']) {
        const res = await call(deps, route, { handle: 'acme' }, headers);
        expect(res.statusCode, route).toBe(404);
        expect(res.headers['cache-control'], route).toBe('no-store');
        expect(res.body, route).toEqual(nobody.body);
      }
    }
  });

  it('tells a member which workplace it is and nothing more, and the shell opens the workplace’s own screen', async () => {
    const { deps, org } = await seed();
    const member = await call(deps, '/api/public/workplaces/:handle', { handle: 'acme' }, authHeader(42));
    expect(member.statusCode).toBe(200);
    expect(member.body).toEqual({ member: { orgId: org.orgId } });
    const one = await call(deps, '/api/public/addresses/:handle', { handle: 'acme' }, authHeader(42));
    expect(one.body).toEqual({ kind: 'workplace', workplace: { member: { orgId: org.orgId } } });
  });

  it('answers a public repository at its address as the token door does, a private one as nothing, and a member with the workplace', async () => {
    const { deps, org } = await seed();
    const tree = await call(deps, '/api/public/workplaces/:handle/repos/:repo/tree', { handle: 'acme', repo: 'site' });
    expect(tree.statusCode).toBe(200);
    expect(tree.headers['x-robots-tag']).toContain('noindex');
    expect(tree.body).toMatchObject({ name: 'site', cloneUrl: 'https://git.test/user-1/site.git', branch: 'main', path: '' });
    const file = await call(deps, '/api/public/workplaces/:handle/repos/:repo/file', { handle: 'acme', repo: 'site' }, undefined, { path: 'README.md' });
    expect(file.body).toMatchObject({ name: 'site', path: 'README.md', content: 'hello\n' });

    for (const [handle, repo] of [['acme', 'secret'], ['acme', 'nothing'], ['nobody', 'site'], ['Acme', 'site']]) {
      const res = await call(deps, '/api/public/workplaces/:handle/repos/:repo/tree', { handle: handle!, repo: repo! });
      expect(res.statusCode, `${handle}/${repo}`).toBe(404);
      expect(res.body, `${handle}/${repo}`).toEqual({ error: 'Nothing at this address.' });
    }
    // A member is sent to the real screen — for the private one too.
    for (const repo of ['site', 'secret']) {
      const res = await call(deps, '/api/public/workplaces/:handle/repos/:repo/tree', { handle: 'acme', repo }, authHeader(42));
      expect(res.statusCode, repo).toBe(200);
      expect(res.body, repo).toEqual({ member: { orgId: org.orgId } });
    }
    // A signed-in stranger reads the public one and nothing of the private one.
    const stranger = await call(deps, '/api/public/workplaces/:handle/repos/:repo/tree', { handle: 'acme', repo: 'secret' }, authHeader(43));
    expect(stranger.statusCode).toBe(404);
  });

  it('serves one text file at one exact commit as its own bytes, to anyone, for the own-cloud guide (note #941)', async () => {
    const { deps } = await seed();
    const asked: unknown[] = [];
    (deps.gitHostClient as unknown as { file: unknown }).file = async (...args: unknown[]) => {
      asked.push(args);
      return { branch: 'main', sizeBytes: 12, content: 'export {};\n' };
    };
    const sha = 'a'.repeat(40);
    for (const headers of [undefined, authHeader(42)]) {
      const res = await call(deps, '/api/public/workplaces/:handle/repos/:repo/raw/:sha', { handle: 'acme', repo: 'site', sha }, headers, { path: 'infra/install.mjs' });
      expect(res.statusCode).toBe(200);
      expect(res.contentType).toBe('text/plain; charset=utf-8');
      expect(res.sentText).toBe('export {};\n');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(asked[0]).toEqual(['user-1', 'site', 'infra/install.mjs', sha]);
    // Never a branch name or an expression, and never a private repository.
    const branch = await call(deps, '/api/public/workplaces/:handle/repos/:repo/raw/:sha', { handle: 'acme', repo: 'site', sha: 'main' }, undefined, { path: 'infra/install.mjs' });
    expect(branch.statusCode).toBe(404);
    const secret = await call(deps, '/api/public/workplaces/:handle/repos/:repo/raw/:sha', { handle: 'acme', repo: 'secret', sha }, undefined, { path: 'x' });
    expect(secret.statusCode).toBe(404);
    expect(secret.body).toEqual({ error: 'Nothing at this address.' });
    // A binary or too-large file is not served as text.
    (deps.gitHostClient as unknown as { file: unknown }).file = async () => ({ branch: 'main', sizeBytes: 4, binary: true });
    const bin = await call(deps, '/api/public/workplaces/:handle/repos/:repo/raw/:sha', { handle: 'acme', repo: 'site', sha }, undefined, { path: 'blob.bin' });
    expect(bin.statusCode).toBe(404);
  });

  describe('what happened in it: history, one commit, proposals (the owner, 2026-09-27)', () => {
    const seedHistory = async () => {
      const built = await seed();
      const { deps } = built;
      const commits = [
        { sha: 'b'.repeat(40), authorName: 'Willow', at: '2026-09-27T10:00:00.000Z', subject: 'Second' },
        { sha: 'a'.repeat(40), authorName: 'Saddam', at: '2026-09-26T10:00:00.000Z', subject: 'First' },
      ];
      const logCalls: unknown[] = [];
      deps.gitHostClient = {
        ...deps.gitHostClient,
        cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
        log: async (_userId: string, _name: string, limit?: number) => { logCalls.push(limit); return { branch: 'main', commits: limit ? commits.slice(0, limit) : commits }; },
        commit: async (_userId: string, _name: string, sha: string) => {
          if (sha !== 'b'.repeat(40) && sha !== 'bbbbbbb') throw new Error('unknown revision');
          return { ...commits[0]!, body: 'Why.', parents: ['a'.repeat(40)], diffStat: { files: 1, insertions: 2, deletions: 1 }, patch: 'diff --git a/x b/x\n', patchTruncated: false };
        },
        compare: async (_userId: string, _name: string, base: string, head: string) => ({
          headSha: head, baseSha: base, baseExists: true,
          diffStat: { files: 1, insertions: 3, deletions: 0 },
          commits: [{ sha: 'c'.repeat(40), subject: 'Add it', at: '2026-09-27T11:00:00.000Z' }],
          patch: `diff ${base}..${head}\n`, patchTruncated: false,
        }),
      } as unknown as GitHostClient;
      const prs = new InMemoryGitPullRequestStorage();
      deps.gitPullRequestStorage = prs;
      const repo = (await deps.gitRepoStorage!.getLiveByNameIn(['user-1'], 'site'))!;
      const secret = (await deps.gitRepoStorage!.getLiveByNameIn(['user-1'], 'secret'))!;
      const make = (repoId: string, extra: Record<string, unknown>) => prs.create({
        repoId, userId: 'user-1', title: 'T', body: 'Because.', sourceBranch: 'feature', targetBranch: 'main',
        headSha: 'h', baseSha: 'g', diffStat: { files: 1, insertions: 1, deletions: 0 },
        commitSubjects: ['Add it'], createdByAgentId: 'agent-a', status: 'open', ...extra,
      } as never);
      await make(repo.id, { title: 'Shown' });                                                    // #1 open
      await make(repo.id, { title: 'Landed', status: 'merged', decidedAt: '2026-09-20T00:00:00.000Z', decisionNote: 'private words' }); // #2
      await make(repo.id, { title: 'Quiet', draft: true });                                       // #3 never shown
      await make(secret.id, { title: 'Private' });                                                // the private repository's
      // The agent's name (Ben, in the seed) comes off its owner's profile; the owner is a member.
      return { ...built, logCalls, repo };
    };

    it('lists the default branch’s history, capped, and one commit with its diff — without checks', async () => {
      const { deps, logCalls } = await seedHistory();
      const history = await call(deps, '/api/public/workplaces/:handle/repos/:repo/commits', { handle: 'acme', repo: 'site' });
      expect(history.statusCode).toBe(200);
      expect(history.headers['cache-control']).toBe('no-store');
      expect(history.body).toEqual({
        name: 'site', branch: 'main',
        commits: [
          { sha: 'b'.repeat(40), authorName: 'Willow', at: '2026-09-27T10:00:00.000Z', subject: 'Second' },
          { sha: 'a'.repeat(40), authorName: 'Saddam', at: '2026-09-26T10:00:00.000Z', subject: 'First' },
        ],
      });
      expect(logCalls).toEqual([500]);
      const one = await call(deps, '/api/public/workplaces/:handle/repos/:repo/commits', { handle: 'acme', repo: 'site' }, undefined, { limit: '1' });
      expect((one.body as { commits: unknown[] }).commits).toHaveLength(1);
      expect(logCalls).toEqual([500, 1]);

      const commit = await call(deps, '/api/public/workplaces/:handle/repos/:repo/commits/:sha', { handle: 'acme', repo: 'site', sha: 'bbbbbbb' });
      expect(commit.statusCode).toBe(200);
      expect(commit.body).toEqual({
        name: 'site', sha: 'b'.repeat(40), authorName: 'Willow', at: '2026-09-27T10:00:00.000Z', subject: 'Second',
        body: 'Why.', parents: ['a'.repeat(40)], diffStat: { files: 1, insertions: 2, deletions: 1 }, patch: 'diff --git a/x b/x\n', patchTruncated: false,
      });
      for (const sha of ['zzzzzzz', 'aaaaaaa', 'b^', '']) {
        const res = await call(deps, '/api/public/workplaces/:handle/repos/:repo/commits/:sha', { handle: 'acme', repo: 'site', sha });
        expect(res.statusCode, sha).toBe(404);
      }
    });

    it('lists every proposal ever shown — never a quiet one, never a decision note, never the person — and one whole with its diff', async () => {
      const { deps } = await seedHistory();
      const list = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals', { handle: 'acme', repo: 'site' });
      expect(list.statusCode).toBe(200);
      expect(list.body).toMatchObject({
        name: 'site',
        prs: [
          { number: 2, title: 'Landed', status: 'merged', from: 'feature', to: 'main', decidedAt: '2026-09-20T00:00:00.000Z', agentName: 'Ben' },
          { number: 1, title: 'Shown', status: 'open', decidedAt: null, agentName: 'Ben' },
        ],
      });
      expect((list.body as { prs: unknown[] }).prs).toHaveLength(2);
      expect(JSON.stringify(list.body)).not.toMatch(/Quiet|private words|user-1|agent-a|example\.com|Dana|Private/);

      // Open: compared live, branch to branch. Decided: the frozen shas.
      const open = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals/:number', { handle: 'acme', repo: 'site', number: '1' });
      expect(open.statusCode).toBe(200);
      expect(open.body).toMatchObject({
        name: 'site',
        pr: { number: 1, title: 'Shown', body: 'Because.', diffStat: { files: 1, insertions: 3, deletions: 0 } },
        commits: [{ sha: 'c'.repeat(40), subject: 'Add it', at: '2026-09-27T11:00:00.000Z' }],
        patch: 'diff main..feature\n', patchTruncated: false,
      });
      const decided = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals/:number', { handle: 'acme', repo: 'site', number: '2' });
      expect((decided.body as { patch: string }).patch).toBe('diff g..h\n');
      expect(JSON.stringify(decided.body)).not.toMatch(/private words/);

      for (const [repo, number] of [['site', '3'], ['site', '9'], ['site', 'x'], ['secret', '1'], ['nothing', '1']]) {
        const res = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals/:number', { handle: 'acme', repo: repo!, number: number! });
        expect(res.statusCode, `${repo}#${number}`).toBe(404);
        expect(res.body, `${repo}#${number}`).toEqual({ error: 'Nothing at this address.' });
      }
      const none = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals', { handle: 'acme', repo: 'secret' });
      expect(none.statusCode).toBe(404);
    });

    it('answers the About strip: description, licence, size, dates, counts and contributors by name — never by address', async () => {
      const { deps } = await seedHistory();
      deps.gitHostClient = {
        ...deps.gitHostClient,
        tree: async () => ({ branch: 'main', entries: [
          { name: 'LICENSE', type: 'file', sizeBytes: 1072 }, { name: 'README.md', type: 'file', sizeBytes: 300 }, { name: 'src', type: 'dir' },
        ] }),
        file: async (_u: string, _n: string, path: string) => ({
          branch: 'main', sizeBytes: 300,
          content: path === 'LICENSE'
            ? 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy'
            : '# Site\n\nThe workplace’s **public** site.\n\n## More\n',
        }),
        contributors: async () => ({ branch: 'main', tipSha: 'b'.repeat(40), from: null, authors: [
          { name: 'Willow', email: 'willow@agentbuilt.app', commits: 5, insertions: 100, deletions: 20 },
          { name: 'ben', email: 'ben@agents.test', commits: 3, insertions: 30, deletions: 3 },
          { name: 'Saddam', email: 'saddam@example.com', commits: 2, insertions: 10, deletions: 1 },
        ] }),
      } as unknown as GitHostClient;
      const about = await call(deps, '/api/public/workplaces/:handle/repos/:repo/about', { handle: 'acme', repo: 'site' });
      expect(about.statusCode).toBe(200);
      expect(about.body).toMatchObject({
        name: 'site', branch: 'main', description: 'The workplace’s public site.', license: { name: 'MIT', file: 'LICENSE' },
        sizeBytes: 1, publishedAt: '2026-09-01T00:00:00.000Z', commits: 10, proposals: 2,
        contributors: [
          { name: 'Willow', commits: 5, insertions: 100, deletions: 20 },
          // The workplace's agent, by its current name and with its own face.
          { name: 'Ben', avatarUrl: expect.stringMatching(/avatars\//), commits: 3, insertions: 30, deletions: 3 },
          { name: 'Saddam', commits: 2, insertions: 10, deletions: 1 },
        ],
      });
      const faces = (about.body as { contributors: Array<{ avatarUrl?: string }> }).contributors.map((c) => c.avatarUrl ?? null);
      expect(faces[0]).toBeNull();
      expect(faces[2]).toBeNull();
      expect(JSON.stringify(about.body)).not.toMatch(/@|agent-a|Quiet/);
      // The count is stored, as the member's screen stores it.
      expect((await deps.gitRepoStorage!.getLiveByNameIn(['user-1'], 'site'))?.contributors?.authors).toHaveLength(3);
      const none = await call(deps, '/api/public/workplaces/:handle/repos/:repo/about', { handle: 'acme', repo: 'secret' });
      expect(none.statusCode).toBe(404);
    });

    it('sends a member on — to the repository, and to the proposal by its id', async () => {
      const { deps, org } = await seedHistory();
      for (const route of ['/api/public/workplaces/:handle/repos/:repo/commits', '/api/public/workplaces/:handle/repos/:repo/proposals', '/api/public/workplaces/:handle/repos/:repo/about']) {
        const res = await call(deps, route, { handle: 'acme', repo: 'secret' }, authHeader(42));
        expect(res.body, route).toEqual({ member: { orgId: org.orgId } });
      }
      const commit = await call(deps, '/api/public/workplaces/:handle/repos/:repo/commits/:sha', { handle: 'acme', repo: 'site', sha: 'bbbbbbb' }, authHeader(42));
      expect(commit.body).toEqual({ member: { orgId: org.orgId } });
      const proposal = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals/:number', { handle: 'acme', repo: 'site', number: '3' }, authHeader(42));
      expect(proposal.body).toMatchObject({ member: { orgId: org.orgId, id: expect.any(String) } });
      // A signed-in stranger is a stranger.
      const stranger = await call(deps, '/api/public/workplaces/:handle/repos/:repo/proposals/:number', { handle: 'acme', repo: 'site', number: '3' }, authHeader(43));
      expect(stranger.statusCode).toBe(404);
    });
  });
});

describe('open-sourcing a repository', () => {
  const seedPublicRepo = async (deps: Partial<RouteDeps>, entries: Array<{ name: string; type: 'file'; sizeBytes: number }>) => {
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const repo = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 4096, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      tree: async (_userId: string, _name: string, path: string) => ({
        branch: 'main',
        entries: path ? [{ name: 'index.ts', type: 'file', sizeBytes: 7 }] : entries,
      }),
      file: async () => ({ branch: 'main', sizeBytes: 7, content: 'hello\n' }),
    } as unknown as GitHostClient;
    return { gitRepoStorage, repo };
  };

  it('requires a root licence, then mints one stable link with anonymous browse access', async () => {
    const { deps } = await buildDeps();
    const entries: Array<{ name: string; type: 'file'; sizeBytes: number }> = [{ name: 'README.md', type: 'file', sizeBytes: 10 }];
    const { gitRepoStorage, repo } = await seedPublicRepo(deps, entries);
    const publish = getRouteHandler(deps, '/api/repos/:name/public-access', 'post');

    const unlicensed = createMockResponse();
    await publish(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), unlicensed);
    expect(unlicensed.statusCode).toBe(409);
    expect(String((unlicensed.body as { error: string }).error)).toContain('LICENSE');
    expect((await gitRepoStorage.get(repo.id))?.publicAccess).toBeUndefined();

    entries.push({ name: 'LICENSE', type: 'file', sizeBytes: 1072 });
    const published = createMockResponse();
    await publish(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), published);
    expect(published.statusCode).toBe(200);
    const first = published.body as { public: true; publicUrl: string; publishedAt: string };
    expect(first.publicUrl).toMatch(/^https:\/\/workspace\.test\/public\/repositories\/[0-9a-f-]{36}$/);
    const publicId = first.publicUrl.split('/').at(-1)!;
    expect((await gitRepoStorage.getPublicById(publicId))?.id).toBe(repo.id);

    // Retrying the same human action returns the same link, never a second
    // public identity for one repository.
    const again = createMockResponse();
    await publish(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), again);
    expect((again.body as { publicUrl: string }).publicUrl).toBe(first.publicUrl);

    const tree = createMockResponse();
    await getRouteHandler(deps, '/api/public/repos/:id/tree', 'get')(
      mockRequest({ params: { id: publicId }, query: { path: '' } }), tree,
    );
    expect(tree.statusCode).toBe(200);
    expect(tree.headers['cache-control']).toBe('no-store');
    expect(tree.headers['x-robots-tag']).toContain('noindex');
    expect(tree.body).toMatchObject({
      name: 'api', cloneUrl: 'https://git.test/user-1/api.git', branch: 'main', path: '',
    });

    const file = createMockResponse();
    await getRouteHandler(deps, '/api/public/repos/:id/file', 'get')(
      mockRequest({ params: { id: publicId }, query: { path: 'README.md' } }), file,
    );
    expect(file.statusCode).toBe(200);
    expect(file.body).toMatchObject({ name: 'api', path: 'README.md', content: 'hello\n' });

    // The signed-in shelf carries the same link, so private and public views
    // never invent separate publication state.
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    expect((state.body as { repos: Array<{ publicUrl?: string }> }).repos[0]?.publicUrl).toBe(first.publicUrl);
  });

  it('withdraws access, kills the old link, and publishes later under a new one', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, repo } = await seedPublicRepo(deps, [{ name: 'LICENSE.md', type: 'file', sizeBytes: 20 }]);
    const change = getRouteHandler(deps, '/api/repos/:name/public-access', 'post');
    const first = createMockResponse();
    await change(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), first);
    const oldId = (first.body as { publicUrl: string }).publicUrl.split('/').at(-1)!;

    const privateAgain = createMockResponse();
    await change(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: false } }), privateAgain);
    expect(privateAgain.body).toEqual({ public: false });
    expect((await gitRepoStorage.get(repo.id))?.publicAccess).toBeUndefined();
    const gone = createMockResponse();
    await getRouteHandler(deps, '/api/public/repos/:id/tree', 'get')(
      mockRequest({ params: { id: oldId } }), gone,
    );
    expect(gone.statusCode).toBe(404);

    const republished = createMockResponse();
    await change(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), republished);
    expect((republished.body as { publicUrl: string }).publicUrl).not.toContain(oldId);
  });

  it('keeps publication an admin decision on a shared workplace repository', async () => {
    const { deps, userStorage } = await buildDeps();
    await seedPublicRepo(deps, [{ name: 'COPYING', type: 'file', sizeBytes: 20 }]);
    await userStorage.createProfile('user-2', { email: 'm@example.com', displayName: 'M' });
    await userStorage.updateProfile('user-2', { telegram: { agents: {} } as never });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    const publish = getRouteHandler(deps, '/api/repos/:name/public-access', 'post');

    const member = createMockResponse();
    await publish(mockRequest({ headers: authHeader(43), params: { name: 'api' }, body: { public: true } }), member);
    expect(member.statusCode).toBe(403);

    const admin = createMockResponse();
    await publish(mockRequest({ headers: authHeader(42), params: { name: 'api' }, body: { public: true } }), admin);
    expect(admin.statusCode).toBe(200);
  });
});

describe('the workspace is the only place a repository can be deleted', () => {
  /**
   * Slice 5 (docs/agent-git-project-repos.md). No agent-reachable route
   * removes a repo and there is no chat card for it either, so these handlers
   * are the whole of the verb: they move the bytes to the host's trash, and
   * they are what tells the agent that asked.
   */
  const seedRepos = async (deps: Partial<RouteDeps>, opts: { asked?: boolean } = {}) => {
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const repo = await gitRepoStorage.create({
      userId: 'user-1', name: 'api', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 4096, protectDefaultBranch: true,
    });
    if (opts.asked) {
      await gitRepoStorage.update(repo.id, { deleteAsk: { byAgentId: 'agent-a', at: '2026-08-13T00:00:00.000Z' } });
    }
    const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    const pr = await gitPullRequestStorage.create({
      repoId: repo.id, userId: 'user-1', title: 'A change',
      sourceBranch: 'x', targetBranch: 'main', headSha: 'b'.repeat(40),
      diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['x'],
      createdByAgentId: 'agent-a', status: 'open',
    } as never);
    const hostCalls: Array<{ userId: string; name: string }> = [];
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitPullRequestStorage = gitPullRequestStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      deleteRepo: async (userId: string, name: string) => {
        hostCalls.push({ userId, name });
        return { deleted: true, trashedAs: `${name}.20260813T041500Z.git` };
      },
      restoreRepo: async () => {},
    } as unknown as GitHostClient;
    const told: unknown[] = [];
    deps.notifyRepoDeleteDecision = vi.fn(async (args) => { told.push(args); });
    return { gitRepoStorage, gitPullRequestStorage, repo, pr, hostCalls, told };
  };

  it('deletes: bytes to the trash, proposals withdrawn, and the agent that asked is told', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, gitPullRequestStorage, repo, pr, hostCalls, told } = await seedRepos(deps, { asked: true });
    await gitRepoStorage.update(repo.id, {
      publicAccess: { id: 'public-before-delete', publishedAt: '2026-09-25T00:00:00.000Z', publishedByUserId: 'user-1' },
    });
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(hostCalls).toEqual([{ userId: 'user-1', name: 'api' }]);
    expect((await gitRepoStorage.get(repo.id))?.deletedAt).toBeTruthy();
    expect((await gitRepoStorage.get(repo.id))?.publicAccess).toBeUndefined();
    expect(await gitRepoStorage.getByName('user-1', 'api')).toBeNull();
    expect((await gitPullRequestStorage.get(pr.id))?.status).toBe('withdrawn');
    expect(told).toEqual([expect.objectContaining({
      userId: 'user-1', agentId: 'agent-a', repoName: 'api', decision: 'deleted', withdrawnPrs: 1,
    })]);
  });

  it('deletes a repo nobody asked about, and wakes no agent for it', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, told } = await seedRepos(deps);
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(await gitRepoStorage.getByName('user-1', 'api')).toBeNull();
    expect(told).toEqual([]);
  });

  it('keeps: clears the request, leaves the repo, and tells the agent no', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, repo, hostCalls, told } = await seedRepos(deps, { asked: true });
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/repos/:name/keep', 'post')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(hostCalls).toEqual([]);
    const after = await gitRepoStorage.get(repo.id);
    expect(after?.deleteAsk).toBeUndefined();
    expect(after?.deletedAt).toBeUndefined();
    expect(told).toEqual([expect.objectContaining({ repoName: 'api', decision: 'kept' })]);
  });

  it('a second Keep on the same repo says ok and wakes nobody twice', async () => {
    const { deps } = await buildDeps();
    const { told } = await seedRepos(deps, { asked: true });
    const handler = getRouteHandler(deps, '/api/repos/:name/keep', 'post');

    await handler(mockRequest({ headers: authHeader(42), params: { name: 'api' } }), createMockResponse());
    const second = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), params: { name: 'api' } }), second);

    expect(second.statusCode).toBe(200);
    expect(told).toHaveLength(1);
  });

  it('a host that will not answer leaves the repo alone', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, repo, told } = await seedRepos(deps, { asked: true });
    (deps.gitHostClient as unknown as { deleteRepo: () => Promise<never> }).deleteRepo = async () => {
      throw new Error('host down');
    };
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), res,
    );

    expect(res.statusCode).toBe(502);
    expect((await gitRepoStorage.get(repo.id))?.deletedAt).toBeUndefined();
    expect(told).toEqual([]);
  });

  it('another account cannot name its way to this repo', async () => {
    const { deps } = await buildDeps();
    const { gitRepoStorage, hostCalls } = await seedRepos(deps, { asked: true });
    const res = createMockResponse();

    // A name the caller does not own resolves to nothing — the same rule the
    // explorer routes use, because the name in the URL proves nothing.
    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'someone-elses' } }), res,
    );

    expect(res.statusCode).toBe(404);
    expect(hostCalls).toEqual([]);
    expect(await gitRepoStorage.getByName('user-1', 'api')).not.toBeNull();
  });

  it('on a shared org repo, deleting is an ADMIN verb: a member is refused, the admin deletes', async () => {
    const { deps, userStorage } = await buildDeps();
    const { gitRepoStorage, hostCalls } = await seedRepos(deps, { asked: true });
    // user-1 is the org's admin and the namespace; user-2
    // shares the namespace through the stamp but holds the member role.
    await userStorage.createProfile('user-2', { email: 'm@example.com', displayName: 'M' });
    await userStorage.updateProfile('user-2', {
      telegram: { agents: {} } as never,
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    deps.orgGit = orgGit;

    // The member REACHES the shared repo (not 404) and is refused (403).
    const memberRes = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(43), params: { name: 'api' } }), memberRes,
    );
    expect(memberRes.statusCode).toBe(403);
    expect(hostCalls).toEqual([]);
    expect(await gitRepoStorage.getByName('user-1', 'api')).not.toBeNull();

    const adminRes = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'api' } }), adminRes,
    );
    expect(adminRes.statusCode).toBe(200);
    expect(hostCalls).toEqual([{ userId: 'user-1', name: 'api' }]);
    expect(await gitRepoStorage.getByName('user-1', 'api')).toBeNull();
  });

  it('state carries the pending request, named by the agent that made it', async () => {
    const { deps } = await buildDeps();
    await seedRepos(deps, { asked: true });
    const res = createMockResponse();

    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);

    const body = res.body as { repos: Array<Record<string, unknown>> };
    expect(body.repos[0]!.deleteAsk).toEqual({
      at: '2026-08-13T00:00:00.000Z', byAgentName: 'Ben', canDecide: true,
    });
    // Nobody has been counted on this one, so the row carries an empty list
    // rather than a missing field — a row that has never been counted and a
    // row nobody has written must not be told apart by the page.
    expect(body.repos[0]!.contributors).toEqual([]);
  });

});

describe('the laptop key (git access)', () => {
  it('mints once per tap: hash on the profile, plaintext only in the response, no-store', async () => {
    const { deps, userStorage } = await buildDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/git-access', 'post')(
      mockRequest({ headers: authHeader(42) }), res,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { token: string; createdAt: string };
    expect(body.token.startsWith('hum1.')).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    const profile = await userStorage.getProfile('user-1');
    // Only the hash lands; the token itself must not be derivable from a read.
    expect(profile?.gitAccess?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(profile)).not.toContain(body.token);
  });

  it('reports only whether a key exists, never anything usable', async () => {
    const { deps } = await buildDeps();
    const before = createMockResponse();
    await getRouteHandler(deps, '/api/git-access', 'get')(
      mockRequest({ headers: authHeader(42) }), before,
    );
    expect(before.body).toEqual({ createdAt: null });

    await getRouteHandler(deps, '/api/git-access', 'post')(
      mockRequest({ headers: authHeader(42) }), createMockResponse(),
    );
    const after = createMockResponse();
    await getRouteHandler(deps, '/api/git-access', 'get')(
      mockRequest({ headers: authHeader(42) }), after,
    );
    expect((after.body as { createdAt: string }).createdAt).toBeTruthy();
  });

  it('revoke clears the profile; revoking nothing is a 404', async () => {
    const { deps, userStorage } = await buildDeps();
    await getRouteHandler(deps, '/api/git-access', 'post')(
      mockRequest({ headers: authHeader(42) }), createMockResponse(),
    );
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/git-access', 'delete')(
      mockRequest({ headers: authHeader(42) }), res,
    );
    expect(res.statusCode).toBe(200);
    expect((await userStorage.getProfile('user-1'))?.gitAccess).toBeUndefined();

    const empty = createMockResponse();
    await getRouteHandler(deps, '/api/git-access', 'delete')(
      mockRequest({ headers: authHeader(42) }), empty,
    );
    expect(empty.statusCode).toBe(404);
  });

  it('every verb requires a valid launch signature', async () => {
    const { deps } = await buildDeps();
    for (const method of ['get', 'post', 'delete'] as const) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/git-access', method)(mockRequest({}), res);
      expect(res.statusCode).toBe(401);
    }
  });
});

/**
 * Note #8: how full an agent's context window has got, on its detail screen.
 * The backend's half is a percentage the page can render without knowing a
 * single model id — and, more importantly, NO percentage where one would be
 * invented.
 */
describe('an agent’s context window', () => {
  const stateFor = async (contextUsage: unknown) => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', { contextUsage } as never);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const agents = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    return agents.find((a) => a.id === 'agent-a')!;
  };

  it('reports the fill as a percentage of that model’s own window', async () => {
    const agent = await stateFor({
      tokens: 420_000, model: 'claude-sonnet-5-20260320', at: '2026-08-17T09:00:00.000Z',
    });
    expect(agent.context).toEqual({
      usedPercent: 42, tokens: 420_000, window: 1_000_000, at: '2026-08-17T09:00:00.000Z',
    });
  });

  it('says nothing at all before anything has measured it', async () => {
    // A brand-new agent, and every agent that existed before this shipped:
    // absent, never "0%", which would claim an empty window as a reading.
    expect(await stateFor(undefined)).not.toHaveProperty('context');
    expect(await stateFor({ tokens: 0, model: 'claude-sonnet-5-20260320', at: 't' })).not.toHaveProperty('context');
  });

  it('says nothing for a model whose window this backend does not know', async () => {
    // A percentage needs a denominator. Guessing one produces a bar that looks
    // exactly as authoritative as a real one and is not.
    expect(await stateFor({ tokens: 400_000, model: 'some/model-we-never-priced', at: 't' }))
      .not.toHaveProperty('context');
    expect(await stateFor({ tokens: 400_000, at: 't' })).not.toHaveProperty('context');
  });

  it('is per agent — six agents share one session and must not share this', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', {
      contextUsage: { tokens: 900_000, model: 'claude-sonnet-5-20260320', at: 't' },
    } as never);
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const agents = (res.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents.find((a) => a.id === 'agent-a')!.context).toMatchObject({ usedPercent: 90 });
    expect(agents.find((a) => a.id === 'agent-b')!).not.toHaveProperty('context');
  });
});

describe('the workplace screens (members, seats, invites)', () => {
  /**
   * Org #N in miniature: user-1 (telegram 42) is the admin, user-2
   * (telegram 43) a member who was invited by them, each with a seat. The
   * assertions that carry weight: the role gate reads the MEMBERSHIP (never
   * roles.admin), seat secret material never travels, and every seat verb is
   * pinned to its owner.
   */
  async function buildOrgDeps() {
    const built = await buildDeps();
    const { deps, userStorage } = built;
    await userStorage.updatePersonFields('user-1', { firstName: 'Owner' });
    await userStorage.createProfile('user-2', { email: 'd@example.com', displayName: 'Dana Legacy' });
    await userStorage.updateProfile('user-2', {
      person: { firstName: 'Dana', lastName: 'Ives' },
      telegram: {
        chatId: '2', linkedAt: 't', notificationsEnabled: true,
        telegramUserId: '43',
        agents: {
          'agent-c': { id: 'agent-c', name: 'Leo', cli: 'codex', agentbuiltTokenHash: 'x' } as never,
          // A Workspace helper rides the member's record but is nobody's agent.
          'agent-d': { id: 'agent-d', name: 'Kit', cli: 'codex', purpose: 'workspace-recap' } as never,
        },
      } as never,
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member', invitedByUserId: 'user-1' });
    // Production stamps every pre-multi-org agent during startup before a
    // second workplace can be created. Keep this fixture on that same side
    // of the migration boundary; legacy fallback itself has dedicated tests.
    for (const [userId, agentIds] of [
      ['user-1', ['agent-a', 'agent-b']],
      ['user-2', ['agent-c', 'agent-d']],
    ] as const) {
      for (const agentId of agentIds) {
        await userStorage.updateAgentFields(userId, agentId, { orgId: org.orgId });
      }
    }
    const adminSeat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-admin-secret', label: 'max-1', status: 'active',
    });
    const memberSeat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-2', provider: 'codex',
      token: '{"tokens":{"access_token":"member-secret"}}', label: 'work ChatGPT', status: 'active',
    });
    deps.orgStorage = orgStorage;
    deps.agentLifecycle = {
      deleteAgent: vi.fn(async () => ({ ok: true })),
    } as never;
    deps.telegramBotUsername = 'AcmeFactoryBot';
    return { ...built, orgStorage, org, adminSeat, memberSeat };
  }
  /**
   * The briefing is the workplace's one (note #843), kept per reader on
   * their membership with the log of the ones already given.
   */
  const savedBriefing = async (orgStorage: InMemoryOrgStorage, orgId: string, userId: string) => {
    const member = await orgStorage.getMembership(orgId, userId);
    return member?.workspaceRecap ? { recap: member.workspaceRecap, history: member.workspaceRecapHistory } : undefined;
  };

  it('refuses the org screen to an account in no org, and 503s when the layer is absent', async () => {
    const { deps } = await buildDeps();   // linked, but no org anywhere
    const bare = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), bare);
    expect(bare.statusCode).toBe(503);

    deps.orgStorage = new InMemoryOrgStorage();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invite/);
  });

  it('gives the admin names, roles and agent counts — never another member’s sign-ins', async () => {
    const { deps } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const org = (res.body as { org: { name: string; role: string; members: Array<Record<string, unknown>>; invites: unknown[] } }).org;
    expect(org.name).toBe('Acme Trading');
    expect(org.role).toBe('admin');
    expect(org.members).toHaveLength(2);
    const [first, second] = org.members;
    // Oldest first — the founder leads the list they founded.
    expect(first).toMatchObject({ name: 'Owner', you: true, role: 'admin', agents: 2 });
    // The profile's own name beats the sign-up displayName, and the Workspace
    // helper does not count.
    expect(second).toMatchObject({
      name: 'Dana Ives', you: false, role: 'member', agents: 1, invitedByName: 'Owner',
    });
    expect(first).not.toHaveProperty('seatProviders');
    expect(second).not.toHaveProperty('seatProviders');
    // Admins see the invites block (empty), members' secret material nobody.
    expect(org.invites).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/admin-secret|member-secret/);
  });

  it('gives everyone in the workplace everyone’s email, admin or member (notes #626, #632)', async () => {
    const { deps } = await buildOrgDeps();
    // Dana signs in with an email; the owner has only their own address.
    vi.spyOn(deps.workspaceWebAuth!, 'identityForUser').mockImplementation(async (userId: string) => (userId === 'user-2'
      ? { kind: 'email', email: 'dana@example.com', username: 'dana@example.com' } as never
      : null));
    deps.mailboxes = {
      forUser: async (userId: string) => (userId === 'user-1' ? { address: 'owner@mail.example' } : null),
    } as never;
    const read = async (telegramId: number) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(telegramId) }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { org: { members: Array<Record<string, unknown>> } }).org.members;
    };
    const [owner, dana] = await read(42);
    expect(owner).toMatchObject({ name: 'Owner', email: 'owner@mail.example' });
    expect(dana).toMatchObject({ name: 'Dana Ives', email: 'dana@example.com' });

    // A member reads the admin's address too (note #632): where to reach
    // a colleague is not the admin's alone to know.
    const [ownerAsMember, danaAsMember] = await read(43);
    expect(ownerAsMember).toMatchObject({ name: 'Owner', email: 'owner@mail.example' });
    expect(danaAsMember).toMatchObject({ you: true, email: 'dana@example.com' });

    // The People list is drawn from the same rows, by the same rule.
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(43) }), people);
    expect(JSON.stringify(people.body)).toContain('owner@mail.example');
  });

  it('gives a workplace its public address, read off its name, and carries it on every read', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgHandles = new OrgHandleService({ orgStorage });
    const create = getRouteHandler(deps, '/api/org', 'post');

    const first = createMockResponse();
    await create(mockRequest({ headers: authHeader(42), body: { name: 'Northstar Studio' } }), first);
    expect(first.statusCode).toBe(200);
    expect((first.body as { handle?: string }).handle).toBe('northstar-studio');
    // A second workplace with the same name takes the next free word; a
    // handle in the body is not a thing anyone can ask for.
    const second = createMockResponse();
    await create(mockRequest({ headers: authHeader(42), body: { name: 'Northstar Studio', handle: 'chosen' } }), second);
    expect((second.body as { handle?: string }).handle).toBe('northstar-studio-2');

    // The fixture workplace was born before handles: the boot backfill names it.
    await deps.orgHandles.backfill();
    expect((await orgStorage.getOrg(org.orgId))?.handle).toBe('acme-trading');

    // A rename does not move the address.
    const rename = createMockResponse();
    await getRouteHandler(deps, '/api/org/name', 'post')(mockRequest({
      headers: authHeader(42), query: { org: org.orgId }, body: { name: 'Acme Holdings' },
    }), rename);
    expect(rename.statusCode).toBe(200);
    expect((await orgStorage.getOrg(org.orgId))?.handle).toBe('acme-trading');

    // Every read carries it: the state's workplace, the picker rows, the detail.
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), state);
    const body = state.body as { org: { handle?: string }; organizations: Array<{ orgId: string; handle?: string }> };
    expect(body.org.handle).toBe('acme-trading');
    expect(body.organizations.find((row) => row.orgId === org.orgId)?.handle).toBe('acme-trading');
    const detail = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), detail);
    expect((detail.body as { org: { handle?: string } }).org.handle).toBe('acme-trading');
  });

  it('lets an admin rename the workplace for every member and refuses a member', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const rename = getRouteHandler(deps, '/api/org/name', 'post');

    const written = createMockResponse();
    await rename(mockRequest({
      headers: authHeader(42), query: { org: org.orgId },
      body: { name: '  Northstar   Studio  ' },
    }), written);
    expect(written.statusCode).toBe(200);
    expect(written.body).toEqual({ ok: true, orgId: org.orgId, name: 'Northstar Studio' });
    expect((await orgStorage.getOrg(org.orgId))?.name).toBe('Northstar Studio');

    // It is one shared name, not an admin-only preference: the member's next
    // ordinary state read carries it too.
    const memberState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(
      mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), memberState);
    expect((memberState.body as { org: { name: string } }).org.name).toBe('Northstar Studio');

    const refused = createMockResponse();
    await rename(mockRequest({
      headers: authHeader(43), query: { org: org.orgId },
      body: { name: 'Member picked this' },
    }), refused);
    expect(refused.statusCode).toBe(403);
    expect((refused.body as { error: string }).error).toBe('Renaming the workplace is an admin action.');
    expect((await orgStorage.getOrg(org.orgId))?.name).toBe('Northstar Studio');
  });

  /**
   * The backups block (note #357). The screen used to show backup facts only
   * to an org hosting its own git, which left every org on the central host —
   * the great majority — looking at a page that said nothing about backups at
   * all. These fix what the org record is allowed to claim on its behalf.
   */
  describe('what the org record says about backups', () => {
    const heartbeats = (rows: Record<string, { at: string; ok: boolean }>) =>
      (job: string) => rows[job];

    async function readOrg(deps: Parameters<typeof getRouteHandler>[0], userId = 42) {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(userId) }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { org: { platformBackup?: { code?: unknown; workspace?: unknown } } }).org;
    }

    it('tells an org on the central host that the platform holds both its code and its chats', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { git: { namespaceId: 'ns-1' } } as never);
      deps.readBackupHeartbeat = heartbeats({
        git: { at: '2026-09-06T03:40:00.000Z', ok: true },
        db: { at: '2026-09-06T03:46:00.000Z', ok: true },
      });
      expect((await readOrg(deps)).platformBackup).toEqual({
        code: { at: '2026-09-06T03:40:00.000Z', ok: true },
        workspace: { at: '2026-09-06T03:46:00.000Z', ok: true },
      });
    });

    // The nightly bundles run against the CENTRAL host and touch none of an
    // own-host org's repos. Reporting them as its code's backup would be the
    // one lie this block must never tell.
    it('never credits the platform’s git nightly with code kept on the org’s own host', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, {
        git: { namespaceId: 'ns-1', host: { app: 'iagit-x', volumeId: 'vol-1' } },
      } as never);
      deps.readBackupHeartbeat = heartbeats({
        git: { at: '2026-09-06T03:40:00.000Z', ok: true },
        db: { at: '2026-09-06T03:46:00.000Z', ok: true },
      });
      const backup = (await readOrg(deps)).platformBackup;
      expect(backup).not.toHaveProperty('code');
      expect(backup).toMatchObject({ workspace: { at: '2026-09-06T03:46:00.000Z', ok: true } });
    });

    // An org with no namespace has no code anywhere yet; its chats still do.
    it('claims nothing about the code of an org that has none', async () => {
      const { deps } = await buildOrgDeps();
      deps.readBackupHeartbeat = heartbeats({
        git: { at: '2026-09-06T03:40:00.000Z', ok: true },
        db: { at: '2026-09-06T03:46:00.000Z', ok: true },
      });
      expect((await readOrg(deps)).platformBackup).toEqual({
        workspace: { at: '2026-09-06T03:46:00.000Z', ok: true },
      });
    });

    it('passes a failed run through rather than reporting it as a backup', async () => {
      const { deps } = await buildOrgDeps();
      deps.readBackupHeartbeat = heartbeats({ db: { at: '2026-09-06T03:46:00.000Z', ok: false } });
      expect((await readOrg(deps)).platformBackup)
        .toEqual({ workspace: { at: '2026-09-06T03:46:00.000Z', ok: false } });
    });

    // A job that has never reported, and a backend with no store behind it,
    // are both "nothing is known" — which the screen draws as no block at all
    // rather than as an assurance nobody can stand behind.
    it('says nothing at all when no backup job has ever reported', async () => {
      const { deps } = await buildOrgDeps();
      deps.readBackupHeartbeat = heartbeats({});
      expect(await readOrg(deps)).not.toHaveProperty('platformBackup');
    });

    it('says nothing at all on a backend with no backup monitor behind it', async () => {
      const { deps } = await buildOrgDeps();
      delete deps.readBackupHeartbeat;
      expect(await readOrg(deps)).not.toHaveProperty('platformBackup');
    });
  });

  it('hides the invites block from a plain member', async () => {
    const { deps } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(43) }), res);
    expect(res.statusCode).toBe(200);
    const org = (res.body as { org: { role: string; invites: unknown } }).org;
    expect(org.role).toBe('member');
    expect(org.invites).toBeNull();
  });

  it('answers the Chief of Staff\'s latest request and its recap from its own record (note #945)', async () => {
    const { deps, userStorage } = await buildOrgDeps();
    const read = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(43) }), res);
      expect(res.statusCode).toBe(200);
      return res.body as Record<string, unknown>;
    };
    expect(await read()).not.toHaveProperty('lastTurn');
    await userStorage.updateAgentFields('user-2', 'agent-d', {
      lastTurnStartedAt: '2026-11-01T20:38:00.000Z',
      lastTurnEndedAt: '2026-11-01T20:39:04.000Z',
      recap: { text: 'Theo is shipping the booking page.', at: '2026-11-01T20:39:20.000Z' },
    });
    expect((await read()).lastTurn).toEqual({
      startedAt: '2026-11-01T20:38:00.000Z', endedAt: '2026-11-01T20:39:04.000Z', recap: 'Theo is shipping the booking page.',
    });
  });

  it('answers the Chief of Staff\'s forwarded proposals as they stand now, and never one outside the workplace (note #724)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    // The workplace's own namespace: its founder's, as it was never stamped.
    const workplace = 'user-1';
    const repos = new InMemoryGitRepoStorage();
    const prs = new InMemoryGitPullRequestStorage();
    const kps = new InMemoryKnowledgeProposalStorage();
    Object.assign(deps, { gitRepoStorage: repos, gitPullRequestStorage: prs, knowledgeProposalStorage: kps });
    const change = (repoId: string, namespace: string, title: string) => prs.create({
      repoId, userId: namespace, roomNamespaceId: namespace, createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      sourceBranch: 'agent/checkout', targetBranch: 'main', headSha: 'a'.repeat(40), title, body: 'A long write-up', commitSubjects: [], status: 'open',
    } as never);
    const repo = await repos.create({ userId: workplace, name: 'site', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1 } as never);
    const pr = await change(repo.id, workplace, 'Checkout');
    const kp = await kps.create({
      userId: workplace, createdByUserId: 'user-1', createdByAgentId: 'agent-a', title: 'Deploys page',
      changes: [{ page: 'deploys', action: 'edit', title: 'Deploys', html: '<p>x</p>' }], status: 'open',
    } as never);
    // A pointer into somebody else's namespace: never described, whatever a row holds.
    const elsewhere = await repos.create({ userId: 'stranger-ns', name: 'theirs', createdByAgentId: 'z', defaultBranch: 'main', sizeBytes: 1 } as never);
    const foreign = await change(elsewhere.id, 'stranger-ns', 'Not yours');
    await orgStorage.touchMember(org.orgId, 'user-1', {
      workspaceRecapChat: {
        messages: [{
          id: 'f1', role: 'action', at: '2026-10-11T08:00:00.000Z', text: 'Forwarded PR #1 in site — Checkout',
          proposals: [{ kind: 'pr', id: pr.id }, { kind: 'knowledge', id: kp.id }, { kind: 'pr', id: foreign.id }],
        }],
        receipts: [], pending: [],
      },
    } as never);
    const read = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { messages: Array<{ forwarded?: Array<Record<string, any>>; proposals?: unknown }> }).messages[0]!;
    };
    let row = await read();
    expect(row.forwarded).toHaveLength(3);
    expect(row.forwarded![0]).toMatchObject({
      kind: 'pr', id: pr.id,
      pr: { title: 'Checkout', status: 'open', repoName: 'site', canDecide: true, body: null, agentName: 'Ben' },
    });
    expect(row.forwarded![1]).toMatchObject({ kind: 'knowledge', id: kp.id, knowledge: { title: 'Deploys page', status: 'open', canDecide: true } });
    // A card names no room: every proposal is the workplace's (note #923).
    for (const card of row.forwarded!) expect(card).not.toHaveProperty('roomName');
    expect(row.forwarded![2]).toEqual({ kind: 'pr', id: foreign.id });
    expect(JSON.stringify(row)).not.toContain('Not yours');
    expect(JSON.stringify(row)).not.toContain('A long write-up');
    // Merged later: the next read says so, though the stored row never moved.
    await prs.update(pr.id, { status: 'merged', decidedAt: '2026-10-11T09:00:00.000Z' } as never);
    row = await read();
    expect(row.forwarded![0]!.pr).toMatchObject({ status: 'merged', decidedAt: '2026-10-11T09:00:00.000Z' });
    // A teammate reads none of it: the conversation is the owner's.
    const teammate = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), teammate);
    expect(JSON.stringify(teammate.body)).not.toContain('Checkout');
  });

  it('answers the conversation as an object naming its workplace, or a JSON error with a status — never an empty success (note #1069)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const get = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), res);
      return res;
    };
    const fresh = await get();
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body).toMatchObject({ orgId: org.orgId, working: false, waiting: [] });
    expect(Array.isArray((fresh.body as { messages: unknown }).messages)).toBe(true);
    // The record cannot be read: a status and a sentence, which the page
    // counts as a miss, rather than a 200 it would have to guess about.
    const getMembership = orgStorage.getMembership.bind(orgStorage);
    orgStorage.getMembership = vi.fn(async (orgId: string, userId: string) => {
      if (userId === 'user-1') throw new Error('database is locked');
      return getMembership(orgId, userId);
    }) as typeof orgStorage.getMembership;
    const broken = await get();
    expect(broken.statusCode).toBe(503);
    expect(broken.body).toEqual({ error: 'Workspace Agent could not be reached.' });
    orgStorage.getMembership = getMembership;
  });

  it('answers only what changed since the version the reader names, and the whole conversation for a version it does not know (note #1071)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    const repos = new InMemoryGitRepoStorage();
    const prs = new InMemoryGitPullRequestStorage();
    Object.assign(deps, { gitRepoStorage: repos, gitPullRequestStorage: prs, knowledgeProposalStorage: new InMemoryKnowledgeProposalStorage() });
    const repo = await repos.create({ userId: 'user-1', name: 'site', createdByAgentId: 'agent-a', defaultBranch: 'main', sizeBytes: 1 } as never);
    const pr = await prs.create({
      repoId: repo.id, userId: 'user-1', roomNamespaceId: 'user-1', createdByUserId: 'user-1', createdByAgentId: 'agent-a',
      sourceBranch: 'agent/checkout', targetBranch: 'main', headSha: 'a'.repeat(40), title: 'Checkout', body: '', commitSubjects: [], status: 'open',
    } as never);
    const rows = [
      { id: 'r1', role: 'owner', at: '2026-11-08T11:00:00.000Z', text: 'Ship the checkout' },
      { id: 'r2', role: 'action', at: '2026-11-08T11:01:00.000Z', text: 'Forwarded PR #1 in site — Checkout', proposals: [{ kind: 'pr', id: pr.id }] },
      { id: 'r3', role: 'assistant', at: '2026-11-08T11:02:00.000Z', text: 'It waits for you.' },
    ];
    const store = (messages: unknown[]) => orgStorage.touchMember(org.orgId, 'user-1', { workspaceRecapChat: { messages, receipts: [], pending: [] } } as never);
    await store(rows);
    // ONE router, as in production: its version store is the router's own.
    const built = workspaceRoutes(deps as RouteDeps) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }> };
    const get = async (router: typeof built, since?: string) => {
      const layer = router.stack.find((candidate) => candidate.route?.path === '/api/recap/chat' && candidate.route.methods.get)!;
      const res = createMockResponse();
      await layer.route!.stack.at(-1)!.handle(mockRequest({ headers: authHeader(42), query: { org: org.orgId, ...(since ? { since } : {}) } }), res);
      expect(res.statusCode).toBe(200);
      return res.body as Record<string, any>;
    };
    const whole = await get(built);
    expect(whole.messages.map((m: { id: string }) => m.id)).toEqual(['r1', 'r2', 'r3']);
    expect(typeof whole.version).toBe('string');
    expect(whole).not.toHaveProperty('delta');
    // Nothing new: no rows, the small state only.
    const quiet = await get(built, whole.version);
    expect(quiet).not.toHaveProperty('messages');
    expect(quiet).toMatchObject({ orgId: org.orgId, working: false, version: whole.version, delta: { since: whole.version, rows: [], removed: [] } });
    // The card's proposal merged — its stored row never moved — and a reply arrived.
    await prs.update(pr.id, { status: 'merged', decidedAt: '2026-11-08T11:03:00.000Z' } as never);
    await store([...rows, { id: 'r4', role: 'assistant', at: '2026-11-08T11:04:00.000Z', text: 'Merged.' }]);
    const moved = await get(built, whole.version);
    expect(moved.delta.rows.map((m: { id: string }) => m.id)).toEqual(['r2', 'r4']);
    expect(moved.delta.rows[0].forwarded[0].pr.status).toBe('merged');
    expect(moved.delta.removed).toEqual([]);
    // A row that leaves the screen (a quiet event's row hidden) says so by id.
    await store([rows[0], { ...rows[1], hidden: true }, rows[2], { id: 'r4', role: 'assistant', at: '2026-11-08T11:04:00.000Z', text: 'Merged.' }]);
    expect((await get(built, moved.version)).delta).toEqual({ since: moved.version, rows: [], removed: ['r2'] });
    // A version this router never answered — a restarted backend is a new
    // router — or no version at all: the whole conversation.
    const restarted = workspaceRoutes(deps as RouteDeps) as unknown as typeof built;
    const fresh = await get(restarted, moved.version);
    expect(fresh).not.toHaveProperty('delta');
    expect(fresh.messages.map((m: { id: string }) => m.id)).toEqual(['r1', 'r3', 'r4']);
    expect((await get(built, 'x'.repeat(65))).messages).toHaveLength(3);
  });

  it('stops, steers and takes files for the Workspace Agent by the room chat\'s routes (note #423)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const model = vi.fn(async (...args: unknown[]) => new Promise<{ failure: 'interrupted' }>((resolve) => {
      (args[5] as { signal: AbortSignal }).signal.addEventListener('abort', () => resolve({ failure: 'interrupted' }), { once: true });
    }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, converseWorkspaceRecap: model };
    // ONE router: the conversation's running turn lives in the router's own
    // WorkspaceRecapChat, and a handler from a second router would not know it.
    const built = workspaceRoutes(deps as RouteDeps) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }> };
    const handler = (path: string, method: 'get' | 'post') => {
      const layer = built.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
      if (!layer?.route) throw new Error(`No ${method} ${path} route`);
      return layer.route.stack[layer.route.stack.length - 1]!.handle;
    };
    const objects = new Map<string, Buffer>();
    deps.mediaStorage = {
      uploadObject: async (args: { storagePath: string; data: Buffer }) => { objects.set(args.storagePath, args.data); },
      createReadAccess: async (args: { storagePath: string }) => ({ url: `https://signed.example/${args.storagePath}`, expiresAt: 't' }),
      downloadObject: async () => Buffer.alloc(0),
      deleteObject: async () => {},
    } as never;
    const stop = handler('/api/recap/chat/stop', 'post');
    const idle = createMockResponse();
    await stop(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), idle);
    expect(idle.body).toEqual({ ok: true, stopped: false, name: 'Workspace Agent' });
    // Files ride the room chat's envelope; the request id rides a header.
    const manifest = Buffer.from(JSON.stringify({ message: 'Put this on note 3', files: [{ fileName: 'brief.pdf', contentType: 'application/pdf', sizeBytes: 3 }] }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(manifest.byteLength);
    const sent = createMockResponse();
    await handler('/api/recap/chat/files', 'post')(mockRequest({
      headers: { ...authHeader(42), 'x-recap-client-id': 'request-files-1' }, query: { org: org.orgId }, body: Buffer.concat([prefix, manifest, Buffer.from([1, 2, 3])]),
    }), sent);
    expect(sent.statusCode).toBe(202);
    const row = (sent.body as { messages: Array<{ text: string; files?: Array<{ id: string; fileName: string }> }>; working: boolean }).messages[0]!;
    expect(row.text).toBe('Put this on note 3');
    expect(row.files?.[0]?.fileName).toBe('brief.pdf');
    expect(JSON.stringify(sent.body)).not.toContain('storagePath');
    expect(objects.size).toBe(1);
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    // The file's URL comes from the reserved agent id the row renderer is given.
    const file = createMockResponse();
    await handler('/api/agents/workspace-agent/chat/files/:fileId', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, params: { fileId: row.files![0]!.id } }), file);
    expect(file.statusCode).toBe(200);
    expect((file.body as { url: string }).url).toContain('https://signed.example/');
    const foreign = createMockResponse();
    await handler('/api/agents/workspace-agent/chat/files/:fileId', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId }, params: { fileId: row.files![0]!.id } }), foreign);
    expect(foreign.statusCode).toBe(404);
    // A second message while the turn runs steers it rather than being refused.
    const steer = createMockResponse();
    await handler('/api/recap/chat', 'post')(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: { clientId: 'request-steer-1', text: 'Actually note 4' } }), steer);
    expect(steer.statusCode).toBe(202);
    expect((steer.body as { steered?: boolean }).steered).toBe(true);
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(2));
    // Stop ends the replacement turn; the transcript says the person did.
    const stopped = createMockResponse();
    await stop(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), stopped);
    expect(stopped.body).toEqual({ ok: true, stopped: true, name: 'Workspace Agent' });
    await vi.waitFor(async () => expect((await orgStorage.getRecapChat(org.orgId, 'user-1'))?.running).toBeUndefined());
    const read = createMockResponse();
    await handler('/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), read);
    const texts = (read.body as { messages: Array<{ text: string }> }).messages.map(m => m.text);
    expect(texts).toEqual(['Put this on note 3', 'Actually note 4', 'Turn stopped by the user.']);
    // A malformed envelope is refused before anything is stored.
    const bad = createMockResponse();
    await handler('/api/recap/chat/files', 'post')(mockRequest({ headers: { ...authHeader(42), 'x-recap-client-id': 'request-files-2' }, query: { org: org.orgId }, body: Buffer.from([0, 0]) }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('keeps the recap conversation private and applies browser authentication and workplace access', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const model = vi.fn(async () => ({ text: '{"reply":"Your private answer."}' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, converseWorkspaceRecap: model };
    const post = getRouteHandler(deps, '/api/recap/chat', 'post');
    const foreign = createMockResponse();
    await post(mockRequest({ headers: authHeader(42), query: { org: 'foreign' }, body: { clientId: 'request-399', text: 'Hi' } }), foreign);
    expect(foreign.statusCode).toBe(403);
    const anonymous = createMockResponse();
    await post(mockRequest({ query: { org: org.orgId }, body: { clientId: 'request-399', text: 'Hi' } }), anonymous);
    expect(anonymous.statusCode).toBe(401);
    const accepted = createMockResponse();
    await post(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: { clientId: 'request-399', text: 'Hi' } }), accepted);
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await orgStorage.getRecapChat(org.orgId, 'user-1'))?.running).toBeUndefined());
    const own = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), own);
    expect(JSON.stringify(own.body)).toContain('Your private answer');
    const other = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), other);
    // Dana's own conversation: only her welcome as a teammate who joined (note #820).
    expect((other.body as { messages: Array<{ kind?: string }> }).messages.map((m) => m.kind)).toEqual(['welcome']);
    expect(JSON.stringify(other.body)).not.toContain('Your private answer');
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), people);
    expect(JSON.stringify(people.body)).not.toContain('Your private answer');
    expect(JSON.stringify(people.body)).not.toContain('workspaceRecapChat');
    // The conversation is not briefing material (note #688): no briefing
    // reads it, the reader's own included.
    const recap = createMockResponse();
    await getRouteHandler(deps, '/api/recap', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), recap);
    expect(recap.statusCode).toBe(200);
    expect(JSON.stringify((recap.body as { sources: unknown[] }).sources)).not.toContain('Your private answer');
    const otherRecap = createMockResponse();
    await getRouteHandler(deps, '/api/recap', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), otherRecap);
    expect(JSON.stringify(otherRecap.body)).not.toContain('Your private answer');
  });

  it('puts a newly created proposal into the Workspace Agent model input', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.orgGit = new OrgGitService({ orgStorage });
    const repos = new InMemoryGitRepoStorage();
    const repo = await repos.create({
      userId: org.orgId, orgId: org.orgId, name: 'storefront', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    const proposals = new InMemoryGitPullRequestStorage();
    await proposals.create({
      repoId: repo.id, userId: org.orgId, orgId: org.orgId, title: 'Publish the new checkout',
      body: 'Replaces the old payment step.', sourceBranch: 'checkout-v2', targetBranch: 'main',
      headSha: 'a'.repeat(40), diffStat: { files: 2, insertions: 18, deletions: 4 },
      commitSubjects: ['Publish the new checkout'], createdByAgentId: 'agent-a', status: 'open',
    } as never);
    deps.gitRepoStorage = repos;
    deps.gitPullRequestStorage = proposals;
    const model = vi.fn(async () => ({ text: 'The checkout proposal is ready for you.' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, converseWorkspaceRecap: model };

    const response = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'post')(
      mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: { clientId: 'proposal-context', text: 'What changed?' } }),
      response,
    );
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const prompt = String(model.mock.calls[0]![2]);
    expect(prompt).toContain('"activity"');
    expect(prompt).toContain('"kind":"proposal"');
    expect(prompt).toContain('"title":"Proposal #1: Publish the new checkout"');
    expect(prompt).toContain('"status":"Awaiting your decision"');
    // The workplace's activity, with no room to file it under (note #923).
    expect(prompt).not.toContain('"roomActivity"');
    expect(prompt).not.toContain('"room":');
  });

  it('reads and changes the Chief of Staff\'s event turns and standing permissions, privately, field by field (note #716)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const headers = authHeader(42), query = { org: org.orgId };
    const read = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/proactive', 'get')(mockRequest({ headers, query }), read);
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ orgId: org.orgId, recent: [], settings: { events: false, quietFrom: 23, quietTo: 8, timeZone: 'UTC', thresholds: { proposalHours: 24, reportHours: 24, noteHours: 48 } } });
    const on = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/proactive', 'put')(mockRequest({ headers, query, body: { events: true, timeZone: 'Asia/Bishkek', permissions: { 'reset-finished-agent': true } } }), on);
    expect(on.statusCode).toBe(200);
    expect(on.body).toMatchObject({ settings: { events: true, timeZone: 'Asia/Bishkek', permissions: { 'reset-finished-agent': true, 'hand-unclaimed-note': false } } });
    // A field left out keeps its value; a bad one is refused and changes nothing.
    const wait = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/proactive', 'put')(mockRequest({ headers, query, body: { thresholds: { noteHours: 72 } } }), wait);
    expect(wait.body).toMatchObject({ settings: { events: true, thresholds: { noteHours: 72, proposalHours: 24 }, permissions: { 'reset-finished-agent': true } } });
    const bad = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/proactive', 'put')(mockRequest({ headers, query, body: { permissions: { 'send-mail': true } } }), bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toEqual({ error: 'There is no permission called send-mail.' });
    expect((await orgStorage.getMembership(org.orgId, 'user-1'))?.workspaceAgentProactive).toMatchObject({ events: true, thresholds: { noteHours: 72 } });
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers, query }), people);
    expect(JSON.stringify(people.body)).not.toContain('workspaceAgentProactive');
  });

  it('stores the Workspace Agent and recap runtimes independently, including a pre-split membership (note #447)', async () => {
    const { deps, orgStorage, org, userStorage } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', { cli: 'codex', connectedAt: 't', serverId: 'fly_own.machine' });
    const headers = authHeader(42), query = { org: org.orgId };
    const oldShared = { cli: 'codex' as const, model: 'gpt-6-astra', effort: 'ultra' };
    await orgStorage.touchMember(org.orgId, 'user-1', { workspaceRecapSettings: oldShared });

    // The first recap change after the split freezes the value the Agent was
    // already using before it writes the new recap value. Merely changing the
    // recap can therefore never move the Agent again.
    const recap = { cli: 'codex', model: 'gpt-5.6-luna', effort: 'medium' };
    await getRouteHandler(deps, '/api/recap/settings', 'post')(mockRequest({ headers, query, body: recap }), createMockResponse());
    const agentRead = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/settings', 'get')(mockRequest({ headers, query }), agentRead);
    expect(agentRead.body).toMatchObject({ settings: oldShared });

    // The reverse direction is independent too: its own picker moves only
    // the Workspace Agent, while the recap keeps its own stored pair.
    const own = { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' };
    const picked = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/settings', 'post')(mockRequest({ headers, query, body: own }), picked);
    expect(picked.statusCode).toBe(200);
    expect(picked.body).toMatchObject({ settings: own });
    const member = await orgStorage.getMembership(org.orgId, 'user-1');
    expect(member?.workspaceAgentSettings).toEqual(own);
    expect(member?.workspaceRecapSettings).toEqual(recap);
    const recapRead = createMockResponse();
    await getRouteHandler(deps, '/api/recap/settings', 'get')(mockRequest({ headers, query }), recapRead);
    expect(recapRead.body).toMatchObject({ settings: recap });

    const model = vi.fn(async () => ({ text: 'I used my own setting.' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, converseWorkspaceRecap: model };
    const sent = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'post')(
      mockRequest({ headers, query, body: { clientId: 'independent-runtime', text: 'Which model are you?' } }),
      sent,
    );
    expect(sent.statusCode).toBe(202);
    await vi.waitFor(() => expect(model).toHaveBeenCalled());
    expect(model.mock.calls[0]![3]).toEqual(own);

    const invalid = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent/settings', 'post')(mockRequest({ headers, query, body: { cli: 'codex', model: 'gpt-6-luna', effort: 'ultra' } }), invalid);
    expect(invalid.statusCode).toBe(400);
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers, query }), people);
    expect(JSON.stringify(people.body)).not.toContain('workspaceAgentSettings');
  });
  /**
   * Note #439: the Workspace Agent's own screen. Its state must come from the
   * SAME place Home's plate reads, and its machine off its record rather than
   * from a live Fly read, so opening the screen mid-thread costs one query.
   */
  it('serves the Workspace Agent\'s own details: its state, model, context, and machine off its record', async () => {
    const { deps, org, userStorage } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', { cli: 'codex', connectedAt: 't', serverId: 'fly_own.machine' });
    const workspaceAgent = await userStorage.reserveWorkspaceAssistant('user-1', org.orgId);
    await userStorage.updateAgentFields('user-1', workspaceAgent!.id, {
      contextUsage: { tokens: 207_100, window: 828_400, model: 'gpt-5.6-luna', at: '2026-09-10T03:00:00.000Z' },
    });
    const headers = authHeader(42), query = { org: org.orgId };
    const settings = { cli: 'codex', model: 'gpt-5.6-luna', effort: 'medium' };
    await getRouteHandler(deps, '/api/recap/agent/settings', 'post')(mockRequest({ headers, query, body: settings }), createMockResponse());
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent', 'get')(mockRequest({ headers, query }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ orgId: org.orgId, agentId: workspaceAgent!.id, settings, agent: {
      name: 'Workspace Agent', working: false,
      avatarUrl: `/workspace/avatars/${org.workspaceAgentAvatarSlug}`,
      context: { usedPercent: 25, tokens: 207_100, window: 828_400, at: '2026-09-10T03:00:00.000Z' },
    } });
    // No machine until one is reserved — the screen says so rather than
    // inventing a size for a machine that does not exist yet.
    expect((res.body as { machine?: unknown }).machine).toBeUndefined();
    const agentMachine = vi.fn(async () => ({ awake: false, sizes: [], canResize: true, disclaimer: 'Estimate.' }));
    const resizeAgentMachine = vi.fn(async () => ({ ok: true as const, changed: true, awake: false }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentMachine, resizeAgentMachine };
    const machine = createMockResponse();
    await getRouteHandler(deps, '/api/agents/:id/machine', 'get')(mockRequest({
      headers, query, params: { id: workspaceAgent!.id },
    }), machine);
    expect(machine.statusCode).toBe(200);
    expect(agentMachine).toHaveBeenCalledWith('user-1', workspaceAgent!.id);
    // ...and nobody else reaches it: this conversation and its machine are
    // one person's, so a reader the workplace does not know gets no answer.
    const outsider = createMockResponse();
    await getRouteHandler(deps, '/api/recap/agent', 'get')(mockRequest({ headers: authHeader(99), query }), outsider);
    expect(outsider.statusCode).not.toBe(200);
    expect(JSON.stringify(outsider.body)).not.toContain('Workspace Agent');
  });
  it('carries the Workspace Agent context ring on Home and its open conversation read', async () => {
    const { deps, org, userStorage } = await buildOrgDeps();
    const workspaceAgent = await userStorage.reserveWorkspaceAssistant('user-1', org.orgId);
    await userStorage.updateAgentFields('user-1', workspaceAgent!.id, {
      contextUsage: { tokens: 710_000, model: 'claude-sonnet-5-20260320', at: '2026-09-10T03:00:00.000Z' },
    });
    const request = mockRequest({ headers: authHeader(42), query: { org: org.orgId } });
    const chat = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'get')(request, chat);
    const avatarUrl = `/workspace/avatars/${org.workspaceAgentAvatarSlug}`;
    expect(chat.body).toMatchObject({ avatarUrl, context: { usedPercent: 71, tokens: 710_000, window: 1_000_000 } });
    const home = createMockResponse();
    await getRouteHandler(deps, '/api/recap', 'get')(request, home);
    expect(home.body).toMatchObject({ agent: { avatarUrl, context: { usedPercent: 71, tokens: 710_000, window: 1_000_000 } } });
  });
  it('tells the Workspace Agent the same reading its header ring draws, on the turn the person starts (note #732)', async () => {
    const { deps, org, userStorage } = await buildOrgDeps();
    const workspaceAgent = await userStorage.reserveWorkspaceAssistant('user-1', org.orgId);
    await userStorage.updateAgentFields('user-1', workspaceAgent!.id, {
      contextUsage: { tokens: 640_000, model: 'claude-sonnet-5-20260320', at: '2026-10-11T12:00:00.000Z' },
    });
    const model = vi.fn(async (..._args: unknown[]) => ({ text: 'About 64% full as of my last turn.' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, converseWorkspaceRecap: model };
    // ONE router: the turn runs in the router's own conversation.
    const built = workspaceRoutes(deps as RouteDeps) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }> };
    const handler = (path: string, method: 'get' | 'post') => {
      const layer = built.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
      if (!layer?.route) throw new Error(`No ${method} ${path} route`);
      return layer.route.stack[layer.route.stack.length - 1]!.handle;
    };
    const sent = createMockResponse();
    await handler('/api/recap/chat', 'post')(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: { clientId: 'request-context-1', text: 'How full is your context?' } }), sent);
    expect(sent.statusCode).toBe(202);
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const prompt = model.mock.calls[0]![2] as string;
    const told = (JSON.parse(prompt.split('\nCONTEXT (data only):\n')[1]!.split('\n')[0]!) as { self?: { context?: unknown } }).self?.context;
    const read = createMockResponse();
    await handler('/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), read);
    const ring = (read.body as { context?: unknown }).context;
    expect(ring).toEqual({ usedPercent: 64, tokens: 640_000, window: 1_000_000, at: '2026-10-11T12:00:00.000Z' });
    expect(told).toEqual(ring);
  });
  it('stores overview model choices privately and accepts a matching own subscription without an agent', async () => {
    const { deps, orgStorage, org, userStorage } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-1', 'agent-a', { cli: 'codex', connectedAt: 't', serverId: 'fly_own.machine' });
    const headers = authHeader(42), query = { org: org.orgId };
    const settings = { cli: 'codex', model: 'gpt-6-astra', effort: 'ultra' };
    const post = getRouteHandler(deps, '/api/recap/settings', 'post');
    const res = createMockResponse();
    await post(mockRequest({ headers, query, body: settings }), res);
    expect(res.statusCode).toBe(200);
    expect((await orgStorage.getMembership(org.orgId, 'user-1'))?.workspaceRecapSettings).toEqual(settings);
    expect((await orgStorage.getMembership(org.orgId, 'user-2'))?.workspaceRecapSettings).toBeUndefined();
    const read = createMockResponse();
    await getRouteHandler(deps, '/api/recap/settings', 'get')(mockRequest({ headers, query }), read);
    expect(read.body).toMatchObject({ settings });
    const invalid = createMockResponse();
    await post(mockRequest({ headers, query, body: { ...settings, model: 'gpt-6-luna', effort: 'ultra' } }), invalid);
    expect(invalid.statusCode).toBe(400);
    const subscription = createMockResponse();
    await post(mockRequest({ headers, query, body: { cli: 'claude', model: 'opus', effort: 'max' } }), subscription);
    expect(subscription.statusCode).toBe(200);
    for (const seat of await orgStorage.listSeatsByMember(org.orgId, 'user-1')) await orgStorage.updateSeat(seat.seatId, { status: 'disabled' });
    const unavailable = createMockResponse();
    await post(mockRequest({ headers, query, body: { cli: 'claude', model: 'opus', effort: 'max' } }), unavailable);
    expect(unavailable.statusCode).toBe(409);
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers, query }), people);
    expect(JSON.stringify(people.body)).not.toContain('workspaceRecapSettings');
    const forbidden = createMockResponse();
    await post(mockRequest({ headers, query: { org: 'not-my-org' }, body: settings }), forbidden);
    expect(forbidden.statusCode).toBe(403);
  });

  /**
   * Note #747, the owner testing as a fresh user: "picker should show models
   * and default should be set as opus high, even if subscription is not yet
   * connected", then "model picker screen should be disabled if user hasn't
   * yet connected the subscription". So: every model shown, Opus at high
   * set, nothing pickable; nothing is written down until somebody picks, so
   * the default keeps following their sign-ins.
   */
  it('shows every model and Opus at high to a member with nothing connected, read-only until a sign-in', async () => {
    const { deps, orgStorage, org, adminSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(adminSeat.seatId, { status: 'disabled' });
    const headers = authHeader(42), query = { org: org.orgId };
    const read = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/agent/settings', 'get')(mockRequest({ headers, query }), res);
      return res.body as WorkspaceRecapSettingsAnswer;
    };
    const pick = async (body: unknown) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/agent/settings', 'post')(mockRequest({ headers, query, body }), res);
      return res;
    };
    const fresh = await read();
    expect(fresh.settings).toEqual({ cli: 'claude', model: 'opus', effort: 'high' });
    expect(fresh.models.length).toBeGreaterThan(3);
    expect(new Set(fresh.models.map((m) => m.cli))).toEqual(new Set(['codex', 'claude']));
    expect(fresh.models.every((m) => !m.available && m.efforts.length > 0)).toBe(true);
    // Nothing is pickable yet, and a pick is refused rather than saved.
    const early = await pick({ cli: 'claude', model: 'fable', effort: 'max' });
    expect(early.statusCode).toBe(409);
    expect((await orgStorage.getMembership(org.orgId, 'user-1'))?.workspaceAgentSettings).toBeUndefined();
    // Read, not written: a ChatGPT plan alone then moves the default to its
    // own, and its models open up.
    await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'codex',
      token: '{"tokens":{"access_token":"owner-secret"}}', label: 'own ChatGPT', status: 'active',
    });
    const signedIn = await read();
    expect(signedIn.settings).toEqual({ cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(signedIn.models.every((m) => m.cli === 'codex' && m.available)).toBe(true);
    const chosen = { cli: 'codex', model: 'gpt-6-astra', effort: 'max' };
    expect((await pick(chosen)).statusCode).toBe(200);
    expect((await orgStorage.getMembership(org.orgId, 'user-1'))?.workspaceAgentSettings).toEqual(chosen);
  });

  /**
   * Note #607, the owner: "AI generation should happen only on demand. On
   * button click." Reading the card writes nothing, an activity event writes
   * nothing, and a model change writes nothing — while recent activity is
   * still collected on every event, so the press summarizes the week as it
   * stands at that moment.
   */
  it('writes a briefing only when the reader presses, while recent activity keeps being collected', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    let messages = [{ seq: 1, role: 'owner' as const, text: 'Build the booking page', at: new Date().toISOString() }];
    // Held open, as a real run is for half a minute or more, so the press's
    // own answer can be read while it is still writing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const summarize = vi.fn(async () => { await held; return { text: `Overview over ${messages.length} messages.` }; });
    const listeners: Array<(event: { userId: string; agentId: string; kind: string }) => void> = [];
    deps.agentLifecycle = {
      ...deps.agentLifecycle!, agentChatMessages: vi.fn(async () => messages), summarizeWorkspaceRecap: summarize,
      onWorkspaceActivity: (listener: (event: { userId: string; agentId: string; kind: string }) => void) => { listeners.push(listener); return () => {}; },
    } as never;
    const headers = authHeader(42), query = { org: org.orgId };
    const route = routesOf(deps);
    const recap = route('/api/recap', 'get');
    const write = route('/api/recap/write', 'post');

    // A reader who has never pressed: the card reads, and nothing is written.
    const first = createMockResponse(); await recap(mockRequest({ headers, query }), first);
    expect(first.body).toMatchObject({ orgId: org.orgId, summary: null, updating: false });
    // One briefing for the workplace: no room on the answer (note #923).
    expect(first.body).not.toHaveProperty('roomId');
    expect(first.body).not.toHaveProperty('enabled');
    expect(first.body).not.toHaveProperty('nextAt');
    expect(JSON.stringify((first.body as { sources: unknown[] }).sources)).toContain('Build the booking page');

    // Activity arrives through the event path, which re-reads past the
    // one-minute source cache — and still writes nothing.
    messages = [...messages, { seq: 2, role: 'agent' as never, text: 'The booking page is live.', at: new Date(Date.now() + 1000).toISOString() }];
    listeners[0]!({ userId: 'user-1', agentId: 'agent-a', kind: 'turn-ended' });
    await vi.waitFor(async () => {
      const read = createMockResponse(); await recap(mockRequest({ headers, query }), read);
      expect(JSON.stringify((read.body as { sources: unknown[] }).sources)).toContain('The booking page is live.');
    });
    // A model change is a choice for the next press, not a request for one.
    const picked = createMockResponse();
    await route('/api/recap/settings', 'post')(mockRequest({ headers, query, body: { cli: 'claude', model: 'opus', effort: 'max' } }), picked);
    expect(picked.statusCode).toBe(200);
    expect(picked.body).not.toHaveProperty('enabled');
    expect(picked.body).not.toHaveProperty('cadence');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summarize).not.toHaveBeenCalled();
    expect(await savedBriefing(orgStorage, org.orgId, 'user-1')).toBeUndefined();

    // The press: answered at once with the card saying it is being written,
    // over everything collected so far, with the model just picked.
    const pressed = createMockResponse(); await write(mockRequest({ headers, query, body: {} }), pressed);
    expect(pressed.statusCode).toBe(202);
    expect(pressed.body).toMatchObject({ orgId: org.orgId, updating: true });
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]![2]).toContain('The booking page is live.');
    expect(summarize.mock.calls[0]![3]).toEqual({ cli: 'claude', model: 'opus', effort: 'max' });
    // A second press while it writes joins that run rather than starting one.
    const again = createMockResponse(); await write(mockRequest({ headers, query, body: {} }), again);
    expect(again.body).toMatchObject({ updating: true });
    expect(summarize).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(async () => expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.recap?.text).toBe('Overview over 2 messages.'));
    expect(await savedBriefing(orgStorage, org.orgId, 'user-2')).toBeUndefined();

    // Reading it back is still only a read.
    const after = createMockResponse(); await recap(mockRequest({ headers, query }), after);
    expect(after.body).toMatchObject({ updating: false, stale: false, summary: { text: 'Overview over 2 messages.' } });
    expect(after.body).not.toHaveProperty('refreshFailed');
    expect(summarize).toHaveBeenCalledOnce();

    // The routes that paused it and rationed it are gone with it.
    expect(() => route('/api/recap/enabled', 'post')).toThrow();
    expect(() => route('/api/recap/cadence', 'post')).toThrow();
    const forbidden = createMockResponse();
    await write(mockRequest({ headers, query: { org: 'not-my-org' }, body: {} }), forbidden);
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses a press over an empty week or a partial read, and writes nothing', async () => {
    const { deps, org } = await buildOrgDeps();
    const summarize = vi.fn(async () => ({ text: 'Must not run.' }));
    let chat: () => Promise<unknown> = async () => [];
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentChatMessages: vi.fn(async () => chat()), summarizeWorkspaceRecap: summarize } as never;
    const headers = authHeader(42), query = { org: org.orgId };
    const write = getRouteHandler(deps, '/api/recap/write', 'post');
    const empty = createMockResponse(); await write(mockRequest({ headers, query, body: {} }), empty);
    expect(empty.statusCode).toBe(409);
    expect(empty.body).toEqual({ error: 'Nothing happened in the last seven days to write about.' });
    // A recap over part of the week would leave the rest out without saying so.
    chat = async () => { throw new Error('machine asleep'); };
    const partial = createMockResponse(); await write(mockRequest({ headers, query, body: {} }), partial);
    expect(partial.statusCode).toBe(503);
    expect((partial.body as { error: string }).error).toMatch(/could not be read, so no recap was written/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summarize).not.toHaveBeenCalled();
  });

  /**
   * Note #688, as the workplace's one briefing (note #843): the workplace's
   * notes and the chats of the reader's own agents in it are its material;
   * a teammate's chats, an agent in another workplace and another
   * workplace's notes are not.
   */
  it('recaps the workplace with the reader’s own chats and subscription capacity, persists privately, and rechecks access', async () => {
    const { deps, orgStorage, org, userStorage, adminSeat, memberSeat } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.orgGit = new OrgGitService({ orgStorage });
    const foreign = await orgStorage.createOrg({ name: 'Other workplace', createdByUserId: 'user-1' });
    await userStorage.updateAgentFields('user-1', 'agent-b', { orgId: foreign.orgId });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    await notes.create({ userId: org.orgId, html: '<p>Build the booking page</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    await notes.create({ userId: 'foreign-namespace', html: '<p>SECRET OTHER ORG</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    const usageNow = Date.now();
    const resetAt = (windowMins: number, elapsed: number) => Math.floor(
      (usageNow + windowMins * 60_000 * (1 - elapsed)) / 1000,
    );
    await orgStorage.updateSeat(adminSeat.seatId, {
      usage: {
        capturedAt: new Date().toISOString(), planType: 'max_20x', windows: {
          five_hour: { id: 'five_hour', usedPercent: 75, windowDurationMins: 300, resetsAt: resetAt(300, 0.2) },
          seven_day: { id: 'seven_day', usedPercent: 64, windowDurationMins: 10_080, resetsAt: resetAt(10_080, 0.5) },
        },
      },
      modelWindows: {
        fable: { id: 'seven_day_fable', usedPercent: 67, windowDurationMins: 10_080, resetsAt: resetAt(10_080, 0.8) },
      },
    });
    const codexSeat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'codex',
      token: '{"tokens":{"access_token":"admin-codex-secret"}}', label: 'codex-1', status: 'active',
    });
    await orgStorage.updateSeat(codexSeat.seatId, {
      usage: { capturedAt: new Date().toISOString(), planType: 'pro', windows: {
        primary: { id: 'primary', usedPercent: 58, windowDurationMins: 300, resetsAt: resetAt(300, 0.58) },
      } },
    });
    const chat = vi.fn(async (_user: string, id: string) => [{ seq: 1, role: 'owner' as const, text: `PRIVATE REQUEST ${id}`, at: new Date().toISOString() }]);
    const summarize = vi.fn(async () => ({ text: 'Private overview for this reader.' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentChatMessages: chat, summarizeWorkspaceRecap: summarize };
    const route = routesOf(deps);
    const handler = route('/api/recap', 'get');
    const req = mockRequest({ headers: authHeader(42), query: { org: org.orgId } });
    const res = createMockResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ orgId: org.orgId });
    expect(res.body).not.toHaveProperty('roomId');
    expect(JSON.stringify(res.body)).toContain('Build the booking page');
    expect(JSON.stringify(res.body)).toContain('PRIVATE REQUEST agent-a');
    expect(JSON.stringify(res.body)).not.toMatch(/agent-b|agent-c|SECRET OTHER ORG/);
    // A `?room=` from an old link is read by nothing: the same card.
    const stale = createMockResponse();
    await handler(mockRequest({ headers: authHeader(42), query: { org: org.orgId, room: 'room-from-an-old-link' } }), stale);
    expect(stale.statusCode).toBe(200);
    expect(JSON.stringify(stale.body)).toContain('Build the booking page');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith('user-1', 'agent-a', 0);
    // The read writes nothing (note #607); the press does, over a fresh read.
    expect(summarize).not.toHaveBeenCalled();
    const write = route('/api/recap/write', 'post');
    await write(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), createMockResponse());
    expect(chat).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const prompt = summarize.mock.calls[0]![2] as string;
    expect(prompt).not.toContain('SECRET OTHER ORG');
    expect(prompt).not.toContain('in one room of it');
    const material = JSON.parse(prompt.split('\n').at(-1)!);
    expect(material).not.toHaveProperty('room');
    expect(material.subscriptions).toEqual([
      { provider: 'Claude Code', label: 'max-1', plan: 'Max 20x', status: 'active', primary: true, usage: [
        { track: '5 hours', used: '75%', paceComparedWithEvenConsumption: 'ahead' },
        { track: 'other models', used: '64%', paceComparedWithEvenConsumption: 'ahead' },
        { track: 'Fable', used: '67%', paceComparedWithEvenConsumption: 'under' },
      ] },
      { provider: 'Codex', label: 'codex-1', plan: 'Pro', status: 'active', primary: true,
        usage: [{ track: 'usage', used: '58%', paceComparedWithEvenConsumption: 'even' }] },
    ]);
    expect(prompt).not.toMatch(new RegExp(`${adminSeat.seatId}|${codexSeat.seatId}|${memberSeat.seatId}|work ChatGPT|admin-codex-secret|member-secret`));
    await vi.waitFor(async () => expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.recap?.text).toBe('Private overview for this reader.'));
    expect(await savedBriefing(orgStorage, org.orgId, 'user-2')).toBeUndefined();
    const next = createMockResponse(); await handler(req, next);
    expect((next.body as { summary: { text: string } }).summary.text).toBe('Private overview for this reader.');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledTimes(1);
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(req, people);
    expect(JSON.stringify(people.body)).not.toContain('Private overview');
    await orgStorage.removeMember(org.orgId, 'user-1');
    const denied = createMockResponse(); await handler(req, denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toHaveProperty('summary');
    const refused = createMockResponse();
    await write(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), refused);
    expect(refused.statusCode).toBe(403);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  /**
   * Note #389: an attempt that has already failed must not read as one that
   * is about to happen. Since note #607 there is no retry behind it either,
   * so the card is owed the reason until the reader presses again.
   */
  it('tells the reader a press FAILED, and why, beside the briefing it did not replace', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const chat = vi.fn(async () => [{ seq: 1, role: 'owner' as const, text: 'Build the booking page', at: new Date().toISOString() }]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const summarize = vi.fn(async () => { await held; return { failure: 'model' as const }; });
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentChatMessages: chat, summarizeWorkspaceRecap: summarize };
    await orgStorage.touchMember(org.orgId, 'user-1', {
      workspaceRecap: { text: 'The overview from two hours ago.', at: new Date(Date.now() - 7_200_000).toISOString(), fingerprint: 'no-longer-matches' },
    });
    const route = routesOf(deps);
    const handler = route('/api/recap', 'get');
    const req = mockRequest({ headers: authHeader(42), query: { org: org.orgId } });

    // Stale words with nothing asked for are only stale: not "updating".
    const idle = createMockResponse(); await handler(req, idle);
    expect(idle.body).toMatchObject({ updating: false, stale: true });
    expect(idle.body).not.toHaveProperty('refreshFailed');

    // The press is honestly "updating" while it runs...
    const pressed = createMockResponse();
    await route('/api/recap/write', 'post')(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), pressed);
    expect(pressed.body).toMatchObject({ updating: true, stale: true });
    expect(pressed.body).not.toHaveProperty('refreshFailed');

    // ...and once it has come back empty, the card is owed the reason.
    release();
    await vi.waitFor(async () => {
      const after = createMockResponse(); await handler(req, after);
      expect(after.body).toMatchObject({ updating: false, stale: true, refreshFailed: 'model' });
      expect((after.body as { summary: { text: string } }).summary.text).toBe('The overview from two hours ago.');
    });
    expect(summarize).toHaveBeenCalledOnce();
  });

  /**
   * Note #392 made a turn ending re-read the week for a member who read Home
   * recently, past the one-minute cache. That collection stays; since note
   * #607 it is ALL that an event does.
   */
  it('re-reads the week when an agent\'s turn ends, for members who read Home recently, and writes nothing', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    let messages = [{ seq: 1, role: 'owner' as const, text: 'Build the booking page', at: new Date().toISOString() }];
    const chat = vi.fn(async () => messages);
    const summarize = vi.fn(async () => ({ text: `Overview over ${messages.length} messages.` }));
    const listeners: Array<(event: { userId: string; agentId: string; kind: string }) => void> = [];
    deps.agentLifecycle = {
      ...deps.agentLifecycle!, agentChatMessages: chat, summarizeWorkspaceRecap: summarize,
      onWorkspaceActivity: (listener: (event: { userId: string; agentId: string; kind: string }) => void) => { listeners.push(listener); return () => {}; },
    } as never;
    const route = routesOf(deps);
    const handler = route('/api/recap', 'get');
    expect(listeners).toHaveLength(1);
    // Nobody has read Home yet: an event summarizes nothing on anyone's machine.
    listeners[0]!({ userId: 'user-1', agentId: 'agent-a', kind: 'turn-ended' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summarize).not.toHaveBeenCalled();
    // A read stamps the member.
    const req = mockRequest({ headers: authHeader(42), query: { org: org.orgId } });
    const first = createMockResponse(); await handler(req, first);
    expect((await orgStorage.getMembership(org.orgId, 'user-1'))?.workspaceRecapReadAt).toBeTruthy();
    expect(JSON.stringify((first.body as { sources: unknown[] }).sources)).not.toContain('The booking page is live.');
    // The turn ends with a reply on the record: the week is re-read at once,
    // past the one-minute cache the card's own reads are served from.
    messages = [...messages, { seq: 2, role: 'agent' as never, text: 'The booking page is live.', at: new Date(Date.now() + 1000).toISOString() }];
    listeners[0]!({ userId: 'user-1', agentId: 'agent-a', kind: 'turn-ended' });
    const next = createMockResponse();
    await vi.waitFor(async () => {
      await handler(req, next);
      expect(JSON.stringify((next.body as { sources: unknown[] }).sources)).toContain('The booking page is live.');
    });
    expect(next.body).toMatchObject({ summary: null, updating: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summarize).not.toHaveBeenCalled();
    expect(await savedBriefing(orgStorage, org.orgId, 'user-1')).toBeUndefined();
  });

  it('the Workspace Agent has the same version card and updates as a room agent — and only the caller\'s own, in this workplace', async () => {
    const { deps, userStorage, org } = await buildOrgDeps();
    const agentVersion = vi.fn().mockResolvedValue({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 3, docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true }, image: { current: true, canUpdate: false } });
    const updateAgentCli = vi.fn().mockResolvedValue({ ok: true });
    const updateAgentMachine = vi.fn().mockResolvedValue({ ok: true });
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentVersion, updateAgentCli, updateAgentMachine };
    await userStorage.updateProfile('user-1', { telegram: { ...(await userStorage.getProfile('user-1'))!.telegram, agents: {
      ...(await userStorage.getProfile('user-1'))!.telegram!.agents,
      wa: { id: 'wa', name: 'Workspace Agent', purpose: 'workspace-recap', orgId: org.orgId, cli: 'claude' },
      brief: { id: 'brief', name: 'Workspace Recap', purpose: 'workspace-briefing', orgId: org.orgId, cli: 'codex' },
      elsewhere: { id: 'elsewhere', name: 'Workspace Agent', purpose: 'workspace-recap', orgId: 'another-org', cli: 'codex' },
    } } as never });
    const ask = async (route: string, method: 'get' | 'post', id: string) => {
      const res = createMockResponse();
      await getRouteHandler(deps, route, method)(mockRequest({ headers: authHeader(42), params: { id }, query: { org: org.orgId } }), res);
      return res;
    };

    const version = await ask('/api/agents/:id/version', 'get', 'wa');
    expect(version.statusCode).toBe(200);
    expect(version.body).toMatchObject({ cliLabel: 'Claude Code', docs: { version: 129 } });
    expect(agentVersion).toHaveBeenCalledWith('user-1', 'wa');
    expect((await ask('/api/agents/:id/update-cli', 'post', 'wa')).statusCode).toBe(200);
    expect(updateAgentCli).toHaveBeenCalledWith('user-1', 'wa');
    expect((await ask('/api/agents/:id/update-machine', 'post', 'wa')).statusCode).toBe(200);
    expect(updateAgentMachine).toHaveBeenCalledWith('user-1', 'wa');

    // Not the briefing machine (it has no screen), and not the caller's
    // Workspace Agent in another workplace.
    for (const id of ['brief', 'elsewhere']) {
      for (const [route, method] of [['/api/agents/:id/version', 'get'], ['/api/agents/:id/update-cli', 'post'], ['/api/agents/:id/update-machine', 'post']] as const) {
        expect((await ask(route, method, id)).statusCode).toBe(404);
      }
    }
    expect(agentVersion).toHaveBeenCalledTimes(1);
    expect(updateAgentCli).toHaveBeenCalledTimes(1);
    expect(updateAgentMachine).toHaveBeenCalledTimes(1);
  });

  it('saves Home briefings without starting an automatic Workspace Agent turn', async () => {
    const { deps, orgStorage, userStorage, org } = await buildOrgDeps();
    const chat = vi.fn(async () => [{ seq: 1, role: 'owner' as const, text: 'Build the booking page', at: new Date().toISOString() }]);
    const summarize = vi.fn(async () => ({ text: 'The booking page is ready.' }));
    const model = vi.fn(async () => ({ text: 'This must not run.' }));
    deps.agentLifecycle = { ...deps.agentLifecycle!, agentChatMessages: chat, summarizeWorkspaceRecap: summarize, converseWorkspaceRecap: model };
    // Even an already-created Workspace Agent is not woken by the recap.
    await userStorage.updateProfile('user-1', { telegram: { ...(await userStorage.getProfile('user-1'))!.telegram, agents: {
      ...(await userStorage.getProfile('user-1'))!.telegram!.agents, wa: { id: 'wa', name: 'Workspace Agent', purpose: 'workspace-recap', orgId: org.orgId, cli: 'codex' },
    } } as never });
    const write = getRouteHandler(deps, '/api/recap/write', 'post');
    await write(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), createMockResponse());
    await vi.waitFor(async () => expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.recap?.text).toBe('The booking page is ready.'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(model).not.toHaveBeenCalled();
    expect(await orgStorage.getRecapChat(org.orgId, 'user-1')).toBeNull();
  });

  /**
   * Note #413: the briefing is rewritten every minute or so and had no idea
   * what it had already told the reader, so it restated the same three
   * paragraphs in fresh wording all afternoon. It is now written against the
   * briefings already given — kept per member, as private as the overview.
   */
  it('writes each briefing against the ones already given, and keeps that log private', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    let messages = [{ seq: 1, role: 'owner' as const, text: 'Build the booking page', at: new Date().toISOString() }];
    const chat = vi.fn(async () => messages);
    const summarize = vi.fn(async () => ({ text: `Overview over ${messages.length} messages.` }));
    const listeners: Array<(event: { userId: string; agentId: string; kind: string }) => void> = [];
    deps.agentLifecycle = {
      ...deps.agentLifecycle!, agentChatMessages: chat, summarizeWorkspaceRecap: summarize,
      onWorkspaceActivity: (listener: (event: { userId: string; agentId: string; kind: string }) => void) => { listeners.push(listener); return () => {}; },
    } as never;
    // A reader who has been here since before the log existed: one standing
    // overview and no history. It is a briefing they were given, so it seeds.
    const standing = { text: 'The overview they have been reading.', at: new Date(Date.now() - 7_200_000).toISOString(), fingerprint: 'older' };
    await orgStorage.touchMember(org.orgId, 'user-1', { workspaceRecap: standing });
    const route = routesOf(deps);
    const handler = route('/api/recap', 'get');
    const press = () => route('/api/recap/write', 'post')(mockRequest({ headers: authHeader(42), query: { org: org.orgId }, body: {} }), createMockResponse());
    const req = mockRequest({ headers: authHeader(42), query: { org: org.orgId } });

    const first = createMockResponse(); await handler(req, first);
    await press();
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const opening = JSON.parse((summarize.mock.calls[0]![2] as string).split('\n').at(-1)!);
    expect(opening.briefingsAlreadyGiven).toEqual([{ at: standing.at, text: standing.text }]);
    await vi.waitFor(async () => expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.recap?.text).toBe('Overview over 1 messages.'));
    expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.history)
      .toEqual([{ at: expect.any(String), text: 'Overview over 1 messages.' }, { at: standing.at, text: standing.text }]);

    // The next turn ends seconds later and the reader presses again. That
    // briefing is written against both, newest first — and REPLACES the one
    // it rewrites rather than spending a second slot on the same minute of
    // the same afternoon.
    messages = [...messages, { seq: 2, role: 'agent' as never, text: 'The booking page is live.', at: new Date(Date.now() + 1000).toISOString() }];
    listeners[0]!({ userId: 'user-1', agentId: 'agent-a', kind: 'turn-ended' });
    await vi.waitFor(async () => {
      const read = createMockResponse(); await handler(req, read);
      expect(JSON.stringify((read.body as { sources: unknown[] }).sources)).toContain('The booking page is live.');
      expect(read.body).toMatchObject({ updating: false });
    });
    await press();
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    const second = JSON.parse((summarize.mock.calls[1]![2] as string).split('\n').at(-1)!);
    expect(second.briefingsAlreadyGiven.map((b: { text: string }) => b.text))
      .toEqual(['Overview over 1 messages.', standing.text]);
    expect(summarize.mock.calls[1]![2]).toContain('You have briefed them before');
    await vi.waitFor(async () => expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.recap?.text).toBe('Overview over 2 messages.'));
    expect((await savedBriefing(orgStorage, org.orgId, 'user-1'))?.history)
      .toEqual([{ at: expect.any(String), text: 'Overview over 2 messages.' }, { at: standing.at, text: standing.text }]);

    // Remembering a briefing is not activity: the card is settled, not stale.
    const settled = createMockResponse(); await handler(req, settled);
    expect(settled.body).toMatchObject({ updating: false, stale: false });
    expect(summarize).toHaveBeenCalledTimes(2);

    // Nobody else's, and never on a list anyone else reads.
    expect(await savedBriefing(orgStorage, org.orgId, 'user-2')).toBeUndefined();
    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(req, people);
    expect(JSON.stringify(people.body)).not.toContain('workspaceRecapHistory');
    expect(JSON.stringify(people.body)).not.toContain('The overview they have been reading');
  });

  it('says how long each person\'s agents have worked here, deleted ones by name, and the workplace\'s whole (note #644)', async () => {
    const { deps, org, userStorage } = await buildOrgDeps();
    const ledger = new InMemoryAgentWorkLedger();
    deps.agentWorkLedger = ledger;
    // The Workspace Agent is a record with a purpose: never counted among
    // the agents, always counted among the hours.
    await userStorage.updateProfile('user-1', {
      telegram: {
        ...(await userStorage.getProfile('user-1'))!.telegram,
        agents: {
          ...(await userStorage.getProfile('user-1'))!.telegram!.agents,
          'agent-ws': { id: 'agent-ws', name: 'Workspace Agent', cli: 'claude', botStatus: 'active', orgId: org.orgId, purpose: 'workspace-briefing' } as never,
        },
      } as never,
    });
    // Owner: two living agents, one deleted one (its record is gone, the
    // ledger still names it), one Workspace Agent, and hours in another
    // workplace that must not show here.
    ledger.credit({ userId: 'user-1', agentId: 'agent-a', orgId: org.orgId, agentName: 'Ben', month: '2026-09', ms: 3_600_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-a', orgId: org.orgId, agentName: 'Ben', month: '2026-10', ms: 600_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-gone', orgId: org.orgId, agentName: 'Ruby', month: '2026-09', ms: 1_800_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-older', orgId: org.orgId, agentName: 'Max', month: '2026-08', ms: 60_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-ws', orgId: org.orgId, agentName: 'Workspace Agent', month: '2026-09', ms: 120_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-elsewhere', orgId: 'other-org', agentName: 'Elsewhere', month: '2026-09', ms: 999_000 });
    // Member: a legacy row with no workplace on it belongs here by the same
    // fallback the agent count uses. Someone who has since left the
    // workplace still counts toward its whole.
    ledger.credit({ userId: 'user-2', agentId: 'agent-c', orgId: null, agentName: 'Leo', month: '2026-09', ms: 300_000 });
    ledger.credit({ userId: 'user-left', agentId: 'agent-x', orgId: org.orgId, agentName: 'Gone', month: '2026-09', ms: 30_000 });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { org: { workedMs: number }; people: Array<Record<string, unknown>> };
    expect(body.people[0]).toMatchObject({
      name: 'Owner',
      agents: 2,
      workedMs: 3_600_000 + 600_000 + 1_800_000 + 60_000 + 120_000,
      formerAgents: [{ name: 'Ruby', workedMs: 1_800_000 }, { name: 'Max', workedMs: 60_000 }],
    });
    expect(body.people[1]).toMatchObject({ name: 'Dana Ives', agents: 1, workedMs: 300_000 });
    expect(body.people[1]).not.toHaveProperty('formerAgents');
    expect(body.org.workedMs).toBe(3_600_000 + 600_000 + 1_800_000 + 60_000 + 120_000 + 300_000 + 30_000);
    expect(JSON.stringify(body)).not.toContain('Elsewhere');
  });

  it('answers the people lists with the rows alone — same people, no workplace record', async () => {
    const { deps } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      org: { orgId: string; name: string; role: string };
      people: Array<Record<string, unknown>>;
    };
    expect(body.org).toMatchObject({ role: 'admin' });
    expect(body.people).toHaveLength(2);
    expect(body.people[0]).toMatchObject({ name: 'Owner', you: true, role: 'admin', agents: 2 });
    expect(body.people[1]).toMatchObject({ name: 'Dana Ives', you: false, role: 'member', agents: 1 });
    // HOW MANY agents, on every people surface there is (note #346) —
    // no list names one any more, here or on the member's own screen.
    expect(body.people[0]).not.toHaveProperty('agentsList');
    expect(body.people[1]).not.toHaveProperty('agentsList');
    expect(JSON.stringify(res.body)).not.toMatch(/admin-secret|member-secret/);
    // Nothing of the workplace's record rides along.
    expect(body).not.toHaveProperty('org.invites');
    expect(body).not.toHaveProperty('org.git');

    const outsider = createMockResponse();
    deps.orgStorage = new InMemoryOrgStorage();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(42) }), outsider);
    expect(outsider.statusCode).toBe(403);
  });

  it('keeps agent-private secrets with their owner and makes shared-secret administration admin-only', async () => {
    const { deps, secretStorage, orgStorage, org } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.orgGit = new OrgGitService({ orgStorage });
    const secrets = new UserSecretsService(secretStorage);
    await secrets.setSecret(org.orgId, 'SHARED_KEY', 'shared-value', SHARED_USER_SECRET_SCOPE, 'for the org');
    await secrets.setSecret(org.orgId, 'ADMIN_ONLY_AGENT', 'admin-private', agentUserSecretScope('agent-a'), 'admin agent');
    await secrets.setSecret(org.orgId, 'MEMBER_ONLY_AGENT', 'member-private', agentUserSecretScope('agent-c'), 'member agent');

    const adminState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), adminState);
    const adminNames = (adminState.body as { secrets: Array<{ name: string }> }).secrets.map((row) => row.name);
    expect(adminNames).toContain('SHARED_KEY');
    expect(adminNames).toContain('ADMIN_ONLY_AGENT');
    expect(adminNames).not.toContain('MEMBER_ONLY_AGENT');

    const memberState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), memberState);
    const memberNames = (memberState.body as { secrets: Array<{ name: string }> }).secrets.map((row) => row.name);
    expect(memberNames).toContain('SHARED_KEY');
    expect(memberNames).toContain('MEMBER_ONLY_AGENT');
    expect(memberNames).not.toContain('ADMIN_ONLY_AGENT');

    const addShared = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(43), body: { name: 'NOPE', value: 'x' } }), addShared);
    expect(addShared.statusCode).toBe(403);
    const copyShared = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({ headers: authHeader(43), params: { name: 'SHARED_KEY' } }), copyShared);
    expect(copyShared.statusCode).toBe(403);

    // A member still owns their own agent-private secret.
    const copyPrivate = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/value', 'get')(
      mockRequest({
        headers: authHeader(43), params: { name: 'MEMBER_ONLY_AGENT' }, query: { agent: 'agent-c' },
      }), copyPrivate);
    expect(copyPrivate.statusCode).toBe(200);
    expect((copyPrivate.body as { value: string }).value).toBe('member-private');
  });

  // Note #655: whose agents a shared key reaches, and a member's own way in.
  it('carries each shared secret\'s audience and the agents it reaches; admins switch it, members save private keys', async () => {
    const { deps, secretStorage, orgStorage, org } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.orgGit = new OrgGitService({ orgStorage });
    const secrets = new UserSecretsService(secretStorage);
    await secrets.setSecret(org.orgId, 'FLY_TOKEN', 'fly', SHARED_USER_SECRET_SCOPE, 'platform');
    await secrets.setSecret(org.orgId, 'TEAM_KEY', 'team', SHARED_USER_SECRET_SCOPE, 'shared', 'everyone');

    type Row = { name: string; audience?: string; reaches?: string[] };
    const adminState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), adminState);
    const adminRows = (adminState.body as { secrets: Row[] }).secrets;
    // Admin-only: the admin's two agents. Everyone: Leo (the member's live
    // agent) joins; Kit is a Workspace helper and is nobody's.
    expect(adminRows.find((row) => row.name === 'FLY_TOKEN')).toMatchObject({ audience: 'admins', reaches: ['Ben', 'Ruby'] });
    expect(adminRows.find((row) => row.name === 'TEAM_KEY')).toMatchObject({ audience: 'everyone', reaches: ['Ben', 'Leo', 'Ruby'] });
    // The member sees the same facts — out of reach is visible, not hidden.
    const memberState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), memberState);
    const memberRows = (memberState.body as { secrets: Row[] }).secrets;
    expect(memberRows.find((row) => row.name === 'FLY_TOKEN')).toMatchObject({ audience: 'admins', reaches: ['Ben', 'Ruby'] });

    // Only an admin flips the switch.
    const memberFlip = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/audience', 'patch')(
      mockRequest({ headers: authHeader(43), params: { name: 'FLY_TOKEN' }, body: { audience: 'everyone' } }), memberFlip);
    expect(memberFlip.statusCode).toBe(403);
    const adminFlip = createMockResponse();
    await getRouteHandler(deps, '/api/secrets/:name/audience', 'patch')(
      mockRequest({ headers: authHeader(42), params: { name: 'FLY_TOKEN' }, body: { audience: 'everyone' } }), adminFlip);
    expect(adminFlip.statusCode).toBe(200);
    expect(await secrets.getSecretEnv(org.orgId, 'agent-c', { ownerIsAdmin: false })).toEqual({ FLY_TOKEN: 'fly', TEAM_KEY: 'team' });

    // An admin's add form chooses the audience; a member's add is refused for
    // shared but lands for one of their OWN agents — never somebody else's.
    const adminAdd = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'OPEN_KEY', value: 'o', audience: 'everyone' } }), adminAdd);
    expect(adminAdd.statusCode).toBe(200);
    expect((await secrets.listSecrets(org.orgId)).find((row) => row.name === 'OPEN_KEY')).toMatchObject({ audience: 'everyone' });
    const memberShared = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(43), body: { name: 'NOPE', value: 'x' } }), memberShared);
    expect(memberShared.statusCode).toBe(403);
    const memberForeign = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(43), query: { agent: 'agent-a' }, body: { name: 'NOPE', value: 'x' } }), memberForeign);
    expect(memberForeign.statusCode).toBe(404);
    const memberOwn = createMockResponse();
    await getRouteHandler(deps, '/api/secrets', 'post')(
      mockRequest({ headers: authHeader(43), query: { agent: 'agent-c' }, body: { name: 'MY_GH', value: 'ghp' } }), memberOwn);
    expect(memberOwn.statusCode).toBe(200);
    expect(await secrets.getSecretEnv(org.orgId, 'agent-c', { ownerIsAdmin: false })).toMatchObject({ MY_GH: 'ghp' });
    expect(await secrets.getSecretEnv(org.orgId, 'agent-a', { ownerIsAdmin: true })).not.toHaveProperty('MY_GH');
  });

  it('answers the tokens the caller’s own agents spent, by week, and nobody else’s', async () => {
    const { deps } = await buildOrgDeps();
    const ledger = new InMemoryAgentTokenLedger();
    deps.agentTokenLedger = ledger;
    const today = tokenDayKey(Date.now());
    const credit = (userId: string, agentId: string, provider: 'claude' | 'codex', output: number) => ledger.credit({
      userId, agentId, orgId: null, agentName: agentId, day: today, provider, model: `${provider}-model`,
      input: 10, output, cacheRead: 100, cacheWrite: 0, reasoning: 0,
    });
    credit('user-2', 'agent-c', 'claude', 500);
    credit('user-2', 'agent-d', 'claude', 250);
    credit('user-2', 'agent-d', 'codex', 40);
    credit('user-1', 'agent-a', 'claude', 9_999);

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/tokens', 'get')(mockRequest({ headers: authHeader(43) }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as WorkspaceTokenUsageAnswer;
    expect(body.weeks).toHaveLength(1);
    // Both of the member's agents summed per provider; the two providers apart;
    // the admin's 9,999 nowhere.
    expect(body.weeks[0]!.providers).toEqual([
      expect.objectContaining({ provider: 'claude', output: 750, input: 20, cacheRead: 200 }),
      expect.objectContaining({ provider: 'codex', output: 40 }),
    ]);
    expect(JSON.stringify(body)).not.toContain('9999');
  });

  it('lists only the caller’s own seats, with the facts and without the token', async () => {
    const { deps, memberSeat } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), res);
    expect(res.statusCode).toBe(200);
    const seats = (res.body as { seats: Array<Record<string, unknown>> }).seats;
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      seatId: memberSeat.seatId, provider: 'codex', label: 'work ChatGPT',
      status: 'active', selected: true,
    });
    expect(seats[0]).not.toHaveProperty('token');
    expect(JSON.stringify(res.body)).not.toMatch(/member-secret|admin-secret/);
  });

  it('carries each seat’s usage as the Usage screen’s own window views — sorted, labelled, formatted', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      usage: {
        capturedAt: '2026-08-22T13:00:00Z',
        windows: {
          // Deliberately out of order: the 7-day window first, so the sort
          // (shortest window leads, as on the Usage screen) is exercised.
          seven_day: { id: 'seven_day', usedPercent: 68.55, windowDurationMins: 10080, resetsAt: 1756500000 },
          five_hour: { id: 'five_hour', usedPercent: 33, windowDurationMins: 300 },
        },
      },
      usageRefreshedAt: '2026-08-22T13:05:00Z',
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), res);
    const seat = (res.body as { seats: Array<Record<string, unknown>> }).seats[0]!;
    expect(seat.windows).toEqual([
      { label: '5 hours', usedPercent: 33, percentText: '33', trackText: '5 hours', windowMins: 300 },
      // Both halves travel: the UTC sentence for whoever renders words, and
      // the instant itself, which is the only form a browser can put on its
      // reader's own clock and count down from (note #245). The window's own
      // LENGTH rides along beside them, because the instant alone cannot say
      // how much of the week has gone by (note #279).
      { label: '7 days', usedPercent: 68.55, percentText: '68.6', trackText: 'this week', windowMins: 10_080,
        resetAt: '2025-08-29T20:40:00.000Z', resetsText: expect.stringContaining('UTC') },
    ]);
    expect(seat.usageRefreshedAt).toBe('2026-08-22T13:05:00Z');
    expect(seat).not.toHaveProperty('usageNotice');
  });

  it('shows the full picture on a grant seat: the Fable row joins the list, extra usage carries amounts', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      usage: {
        capturedAt: '2026-08-23T06:00:00Z',
        windows: {
          five_hour: { id: 'five_hour', usedPercent: 6, windowDurationMins: 300 },
          seven_day: { id: 'seven_day', usedPercent: 7, windowDurationMins: 10080 },
          overage: { id: 'overage', usedPercent: 70.4 },
        },
        spend: { usedMinor: 5632, limitMinor: 8000, currency: 'USD', exponent: 2 },
      },
      modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 13, windowDurationMins: 10080 } },
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), res);
    const seat = (res.body as { seats: Array<{ windows: Array<Record<string, unknown>> }> }).seats[0]!;
    // The two weekly rows are told apart by name (note #86): a bare "7 days"
    // beside "7 days \u00b7 Fable" left the reader guessing which was which.
    expect(seat.windows.map((w) => w.label))
      .toEqual(['5 hours', '7 days \u00b7 other models', '7 days \u00b7 Fable', 'Extra usage']);
    expect(seat.windows.map((w) => w.trackText))
      .toEqual(['5 hours', 'other models', 'Fable', 'extra usage']);
    expect(seat.windows[2]).toMatchObject({ usedPercent: 13 });
    // Amounts, not just a percent: what the member's own Claude app shows.
    expect(seat.windows[3]).toMatchObject({ usedPercent: 70.4, detailText: '$56.32 of $80.00' });
  });

  // Note #697: the subscription page opened on an older reading than the plate
  // just tapped on Home. The two reads now stamp a subscription alike and name
  // and measure each window alike, so the browser can keep one copy — the
  // newer — and the page can draw Home's reading while its own read is out.
  it('stamps a subscription alike on Home’s row and its own record, with the same words for each window', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      usage: {
        capturedAt: '2026-10-04T13:00:00Z',
        windows: {
          five_hour: { id: 'five_hour', usedPercent: 65, windowDurationMins: 300, resetsAt: 1759590000 },
          seven_day: { id: 'seven_day', usedPercent: 44, windowDurationMins: 10080, resetsAt: 1759900000 },
          overage: { id: 'overage', usedPercent: 70.4 },
        },
        spend: { usedMinor: 5632, limitMinor: 8000, currency: 'USD', exponent: 2 },
      },
      modelWindows: { fable: { id: 'seven_day_fable', usedPercent: 34, windowDurationMins: 10080 } },
      usageRefreshedAt: '2026-10-04T13:00:00Z',
    });
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), state);
    const seats = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), seats);
    const row = (state.body as { org: { seatUsage: Array<Record<string, unknown> & { windows: Array<Record<string, unknown>> }> } })
      .org.seatUsage.find((entry) => entry.seatId === memberSeat.seatId)!;
    const record = (seats.body as { seats: Array<Record<string, unknown> & { windows: Array<Record<string, unknown>> }> })
      .seats.find((entry) => entry.seatId === memberSeat.seatId)!;
    const updatedAt = (await orgStorage.getSeat(memberSeat.seatId))!.updatedAt;
    expect(row.updatedAt).toBe(updatedAt);
    expect(record.updatedAt).toBe(updatedAt);
    expect(row.usageRefreshedAt).toBe('2026-10-04T13:00:00Z');
    expect(record.usageRefreshedAt).toBe('2026-10-04T13:00:00Z');
    // Every window Home shows, word for word as the page draws it. Extra
    // usage is a spend cap, so Home's row leaves it to the page (note #86).
    const words = ({ label, usedPercent, percentText, trackText, windowMins, resetAt }: Record<string, unknown>) =>
      ({ label, usedPercent, percentText, trackText, windowMins, resetAt });
    expect(row.windows.map(words)).toEqual(record.windows.filter((window) => !window.spend).map(words));
    expect(row.windows.map((window) => window.label)).toEqual(['5 hours', '7 days · other models', '7 days · Fable']);
  });

  it('names the subscription itself, and keeps naming it once the seat stops reading', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      usage: {
        capturedAt: '2026-08-30T06:00:00Z',
        planType: 'max_20x',
        planReadAt: '2026-08-30T06:00:00Z',
        windows: { five_hour: { id: 'five_hour', usedPercent: 6, windowDurationMins: 300 } },
      },
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), res);
    expect((res.body as { seats: Array<{ planText?: string }> }).seats[0]!.planText).toBe('Max 20x');

    // A dead seat's READINGS are stale; which subscription it is, is not.
    await orgStorage.updateSeat(memberSeat.seatId, { status: 'dead' });
    const dead = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), dead);
    expect((dead.body as { seats: Array<{ planText?: string }> }).seats[0]!.planText).toBe('Max 20x');
  });

  it('projects billing attention separately from dead OAuth and marks saved usage historical', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      status: 'payment_required',
      subscriptionStatus: 'past_due',
      subscriptionStatusReadAt: '2026-08-30T16:35:00.000Z',
      usage: {
        capturedAt: '2026-08-30T16:25:00.000Z',
        planType: 'max_20x',
        windows: { five_hour: { id: 'five_hour', usedPercent: 26, windowDurationMins: 300 } },
      },
      usageRefreshedAt: '2026-08-30T16:25:00.000Z',
    });
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), res);
    const seat = (res.body as { seats: Array<Record<string, unknown>> }).seats[0]!;
    expect(seat).toMatchObject({
      status: 'payment_required',
      attention: 'payment_required',
      subscriptionStatus: 'past_due',
      subscriptionCheckedAt: '2026-08-30T16:35:00.000Z',
      usageIsLastKnown: true,
      planText: 'Max 20x',
      usageRefreshedAt: '2026-08-30T16:25:00.000Z',
    });
    expect(seat.windows).toEqual([
      { label: '5 hours', usedPercent: 26, percentText: '26', windowMins: 300 },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');
  });

  it('rechecks a billing seat authoritatively, wakes agents only after proven recovery, and surfaces outages', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    await orgStorage.updateSeat(memberSeat.seatId, {
      status: 'payment_required',
      subscriptionStatus: 'past_due',
      subscriptionStatusReadAt: '2026-08-30T16:35:00.000Z',
    });
    const wake = vi.fn().mockResolvedValue(undefined);
    (deps.agentLifecycle as { connectAgentsForSeat?: typeof wake }).connectAgentsForSeat = wake;
    deps.refreshSeatUsage = async () => {
      await orgStorage.updateSeat(memberSeat.seatId, {
        status: 'active',
        subscriptionStatus: 'active',
        subscriptionStatusReadAt: '2026-08-30T16:40:00.000Z',
      });
    };
    const check = getRouteHandler(deps, '/api/org/seats/:seatId/check', 'post');
    const ready = createMockResponse();
    await check(mockRequest({
      headers: authHeader(43), params: { seatId: memberSeat.seatId },
    }), ready);
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toMatchObject({ check: 'ready', seat: { status: 'active' } });
    expect(wake).toHaveBeenCalledWith('user-2', 'codex', expect.any(String));

    await orgStorage.updateSeat(memberSeat.seatId, {
      status: 'payment_required',
      subscriptionStatus: 'past_due',
      subscriptionStatusReadAt: '2026-08-30T16:45:00.000Z',
    });
    deps.refreshSeatUsage = async () => { /* provider timed out; storage did not move */ };
    const outage = createMockResponse();
    await check(mockRequest({
      headers: authHeader(43), params: { seatId: memberSeat.seatId },
    }), outage);
    expect(outage.statusCode).toBe(503);
    expect((outage.body as { error: string }).error).toContain('Couldn’t check');
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('refreshes stale subscription readings before rows are read, then reuses a fresh cache', async () => {
    const { deps, orgStorage, memberSeat } = await buildOrgDeps();
    // The probe lands a reading the stored row does not have yet: only a
    // refresh that runs BEFORE the read can put it in the response.
    const refresh = vi.fn(async () => {
      await orgStorage.updateSeat(memberSeat.seatId, {
        usageRefreshedAt: new Date().toISOString(),
        usage: {
          capturedAt: '2026-08-22T14:00:00Z',
          windows: { five_hour: { id: 'five_hour', usedPercent: 41, windowDurationMins: 300 } },
        },
      });
    });
    deps.refreshSeatUsage = refresh;
    const seats = getRouteHandler(deps, '/api/org/seats', 'get');
    const res = createMockResponse();
    await seats(mockRequest({ headers: authHeader(43) }), res);
    expect((res.body as { seats: Array<{ windows?: unknown[] }> }).seats[0]!.windows)
      .toEqual([{ label: '5 hours', usedPercent: 41, percentText: '41', windowMins: 300 }]);

    const fresh = createMockResponse();
    await seats(mockRequest({ headers: authHeader(43) }), fresh);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Once the saved timestamp ages out, a provider outage must cost the
    // reader nothing but freshness.
    await orgStorage.updateSeat(memberSeat.seatId, {
      usageRefreshedAt: new Date(Date.now() - PLATFORM_CREDENTIAL_USAGE_REFRESH_MS - 1).toISOString(),
    });
    deps.refreshSeatUsage = async () => { throw new Error('provider down'); };
    const stale = createMockResponse();
    await seats(mockRequest({ headers: authHeader(43) }), stale);
    expect(stale.statusCode).toBe(200);
    expect((stale.body as { seats: unknown[] }).seats).toHaveLength(1);
  });

  it('says why a seat has no reading, in the provider’s own words', async () => {
    const { deps } = await buildOrgDeps();
    // user-2's codex seat has no snapshot: codex usage lands after the first
    // turn. user-1's claude seat has none either: a plain "no reading yet".
    const codexRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(43) }), codexRes);
    expect((codexRes.body as { seats: Array<Record<string, unknown>> }).seats[0]!.usageNotice)
      .toBe('Usage appears after this subscription completes its first message.');
    const claudeRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats', 'get')(mockRequest({ headers: authHeader(42) }), claudeRes);
    expect((claudeRes.body as { seats: Array<Record<string, unknown>> }).seats[0]!.usageNotice)
      .toBe('No reading yet.');
  });

  it('refuses to select or remove a seat that is not the caller’s own — as a 404, not a 403', async () => {
    const { deps, adminSeat } = await buildOrgDeps();
    // Whose seats exist is nobody's business but their owner's: the refusal
    // must not confirm the seat is real.
    const select = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId/select', 'post')(
      mockRequest({ headers: authHeader(43), params: { seatId: adminSeat.seatId } }), select);
    expect(select.statusCode).toBe(404);
    const remove = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(43), params: { seatId: adminSeat.seatId } }), remove);
    expect(remove.statusCode).toBe(404);
    expect(await deps.orgStorage!.getSeat(adminSeat.seatId)).not.toBeNull();
  });

  it('moves the pick per org, then unassigns without deleting the private sign-in', async () => {
    const { deps, orgStorage, org, adminSeat } = await buildOrgDeps();
    const wake = vi.fn().mockResolvedValue(undefined);
    (deps.agentLifecycle as { connectAgentsForSeat?: typeof wake }).connectAgentsForSeat = wake;
    const second = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-1', provider: 'claude',
      token: 'sk-ant-oat-second', label: 'max-2', status: 'active',
    });
    // Adding selected the newer seat; move the pick back to the first.
    const select = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId/select', 'post')(
      mockRequest({ headers: authHeader(42), params: { seatId: adminSeat.seatId } }), select);
    expect(select.statusCode).toBe(200);
    expect((await orgStorage.getSeat(adminSeat.seatId))!.selected).toBe(true);
    expect(wake).toHaveBeenCalledWith('user-1', 'claude', org.orgId);
    // Unassigning the selected seat must not leave this org pickless, and it
    // must not delete the user's private credential.
    const remove = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { seatId: adminSeat.seatId } }), remove);
    expect(remove.statusCode).toBe(200);
    expect(await orgStorage.getSeat(adminSeat.seatId)).not.toBeNull();
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-1', adminSeat.seatId)).toBe(false);
    expect((await orgStorage.listSeatsByMember(org.orgId, 'user-1'))
      .find((seat) => seat.seatId === second.seatId)?.selected).toBe(true);

    const erase = createMockResponse();
    await getRouteHandler(deps, '/api/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { seatId: adminSeat.seatId } }), erase);
    expect(erase.statusCode).toBe(200);
    expect(await orgStorage.getSeat(adminSeat.seatId)).toBeNull();
  });

  it('refuses unavailable underlying sign-ins with the remedy that matches their state', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'admin' });
    const dead = await orgStorage.addSeat({
      orgId: other.orgId, userId: 'user-1', provider: 'claude',
      token: 'expired', label: 'expired sign-in', status: 'dead',
    });

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId/assign', 'post')(
      mockRequest({ headers: authHeader(42), params: { seatId: dead.seatId } }), res);
    expect(res.statusCode).toBe(409);
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-1', dead.seatId)).toBe(false);
    expect(await orgStorage.isSeatAssigned(other.orgId, 'user-1', dead.seatId)).toBe(true);

    const paused = await orgStorage.addSeat({
      orgId: other.orgId, userId: 'user-1', provider: 'claude',
      token: 'still-valid', label: 'invoice-paused', status: 'payment_required',
    });
    const billing = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId/assign', 'post')(
      mockRequest({ headers: authHeader(42), params: { seatId: paused.seatId } }), billing);
    expect(billing.statusCode).toBe(409);
    expect((billing.body as { error: string }).error).toContain('Restore access in your Claude account');
    expect((billing.body as { error: string }).error).not.toContain('sign in');
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-1', paused.seatId)).toBe(false);
  });

  it('a newcomer waiting on a join request is told so on state, and approval opens them into the team with their subscription', async () => {
    const { deps, orgStorage, org, memberSeat } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' },
    });
    await orgStorage.removeMember(org.orgId, 'user-2');
    // The workplace every new account comes with: unnamed, theirs, active.
    const spare = await orgStorage.createOrg({ name: 'Pat’s workplace', createdByUserId: 'user-2', setupRequired: true, unnamed: true, foundingPending: true });
    await orgStorage.addMember({ orgId: spare.orgId, userId: 'user-2', role: 'admin' });
    await orgStorage.setActiveOrg('user-2', spare.orgId);
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    // (No read before the request: this newcomer already holds a live
    // subscription, and since note #664 a founder with one and an unfounded
    // workplace of their own gets its team on their next read. A real
    // newcomer has no subscription until they are in; what matters here is
    // that WAITING to join never founds the spare.)
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 43, { params: { token: invite.token } });
    const requestId = (filed.body as { requestId: string }).requestId;
    const waiting = await invoke('/api/state', 'get', 43);
    expect(waiting.body).toMatchObject({
      org: { orgId: spare.orgId, unnamed: true },
      joining: { requestId, inviteToken: invite.token, orgName: org.name },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await orgStorage.getOrg(spare.orgId)).toMatchObject({ foundingPending: true, unnamed: true });
    // The admin never sees somebody else's request on their own state.
    expect((await invoke('/api/state', 'get', 42)).body).not.toHaveProperty('joining');
    await invoke('/api/org/join-requests/:id/decision', 'post', 42, { params: { id: requestId }, body: { decision: 'approve' }, query: { org: org.orgId } });
    expect((await orgStorage.getMembershipByUser('user-2'))?.orgId).toBe(org.orgId);
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-2', memberSeat.seatId)).toBe(true);
    const inside = await invoke('/api/state', 'get', 43);
    expect(inside.body).toMatchObject({ org: { orgId: org.orgId, seatProviders: ['codex'] } });
    expect((inside.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');
    expect(inside.body).not.toHaveProperty('joining');
  });

  it('approval leaves a joiner in a workplace they have made their own', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await orgStorage.removeMember(org.orgId, 'user-2');
    const own = await orgStorage.createOrg({ name: 'Okafor Design', createdByUserId: 'user-2' });
    await orgStorage.addMember({ orgId: own.orgId, userId: 'user-2', role: 'admin' });
    await orgStorage.setActiveOrg('user-2', own.orgId);
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 43, { params: { token: invite.token } });
    // A named workplace is a real one: its gate (if any) is theirs to finish.
    expect((await invoke('/api/state', 'get', 43)).body).not.toHaveProperty('joining');
    await invoke('/api/org/join-requests/:id/decision', 'post', 42, { params: { id: (filed.body as { requestId: string }).requestId }, body: { decision: 'approve' }, query: { org: org.orgId } });
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toMatchObject({ role: 'member' });
    expect((await orgStorage.getMembershipByUser('user-2'))?.orgId).toBe(own.orgId);
  });

  it('a reusable link admits nobody until an admin decides each individual request', async () => {
    const { deps, orgStorage, org, userStorage, webAuthStorage } = await buildOrgDeps();
    await orgStorage.removeMember(org.orgId, 'user-2');
    await userStorage.createProfile('user-3', { displayName: 'Pat', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    const preview = await invoke('/auth/invite/:token', 'get', 43, { params: { token: invite.token } });
    expect(preview.body).toMatchObject({ status: 'available' });
    expect(preview.body).not.toHaveProperty('name');
    // The preview promises no expiry either — there is none to promise.
    expect(preview.body).not.toHaveProperty('expiresAt');
    const [first, second, duplicate] = await Promise.all([43, 44, 43].map((identity) => invoke('/api/org/invites/:token/redeem', 'post', identity, { params: { token: invite.token } })));
    expect(first.body).toMatchObject({ status: 'pending' });
    expect(second.body).toMatchObject({ status: 'pending' });
    expect(duplicate.body).toEqual(first.body);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toBeNull();
    expect(await orgStorage.getMembership(org.orgId, 'user-3')).toBeNull();
    expect((await orgStorage.getInvite(invite.token))?.usedAt).toBeUndefined();
    expect((await invoke('/api/org', 'get', 43)).statusCode).toBe(403);
    const list = await invoke('/api/org', 'get', 42);
    expect((list.body as { org: { joinRequests: unknown[] } }).org.joinRequests).toHaveLength(2);
    const firstId = (first.body as { requestId: string }).requestId;
    const secondId = (second.body as { requestId: string }).requestId;
    const approve = { params: { id: firstId }, body: { decision: 'approve' }, query: { org: org.orgId } };
    expect((await invoke('/api/org/join-requests/:id/decision', 'post', 43, approve)).statusCode).toBe(403);
    expect((await invoke('/api/org/join-requests/:id/decision', 'post', 42, approve)).body).toMatchObject({ status: 'approved' });
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toMatchObject({ role: 'member' });
    expect(await orgStorage.getMembership(org.orgId, 'user-3')).toBeNull();
    expect((await invoke('/api/org/join-requests/:id/decision', 'post', 42, approve)).statusCode).toBe(409);
    expect((await invoke('/api/org/join-requests/:id/decision', 'post', 43, { ...approve, params: { id: secondId } })).statusCode).toBe(403);
    expect((await invoke('/api/org/join-requests/:id/decision', 'post', 42, { ...approve, params: { id: secondId }, body: { decision: 'reject' } })).body).toMatchObject({ status: 'rejected' });
    expect(await orgStorage.getMembership(org.orgId, 'user-3')).toBeNull();
    const again = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    expect(again.body).toMatchObject({ status: 'pending' });
    expect((again.body as { requestId: string }).requestId).not.toBe(secondId);
  });

  it('with invites closed (owner, 2026-10-11) every door refuses, the state says so, and members still walk in', async () => {
    const { deps, orgStorage, org, userStorage, webAuthStorage } = await buildOrgDeps();
    await userStorage.createProfile('user-3', { displayName: 'Pat', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    // A link made while the door was open, still out there in somebody's chat.
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    (deps as { invitesClosed?: boolean }).invitesClosed = true;
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    // The state carries the switch, so the menu and Home can hide their doors.
    expect((await invoke('/api/state', 'get', 42)).body).toMatchObject({ invitesClosed: true });
    // The signed-out preview and the signed-in one both say closed, and no more.
    expect((await invoke('/auth/invite/:token', 'get', 44, { params: { token: invite.token } })).body).toEqual({ status: 'closed' });
    expect((await invoke('/api/org/invites/:token', 'get', 44, { params: { token: invite.token } })).body).toMatchObject({ status: 'closed', name: 'Acme Trading' });
    // A member meets no door at all.
    expect((await invoke('/api/org/invites/:token', 'get', 43, { params: { token: invite.token } })).body).toMatchObject({ status: 'member' });
    // Asking to join is refused, and nothing is filed.
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    expect(filed.statusCode).toBe(403);
    expect(filed.body).toMatchObject({ reason: 'closed', error: 'Inviting people to a workplace is switched off for now.' });
    expect(await orgStorage.getJoinRequestByUser(org.orgId, 'user-3')).toBeNull();
    // An admin can make no new link, and the workplace record lists neither doors nor queue.
    expect((await invoke('/api/org/invites', 'post', 42, { query: { org: org.orgId } })).statusCode).toBe(403);
    const record = (await invoke('/api/org', 'get', 42)).body as { org: { invites: unknown; joinRequests: unknown; members: unknown[] } };
    expect(record.org.invites).toBeNull();
    expect(record.org.joinRequests).toBeNull();
    expect(record.org.members).toHaveLength(2);
  });

  it('a workplace marked to invite (note #805) keeps every door open while the backend shuts the rest', async () => {
    const { deps, orgStorage, org, userStorage, webAuthStorage } = await buildOrgDeps();
    (deps as { invitesClosed?: boolean }).invitesClosed = true;
    await orgStorage.updateOrg(org.orgId, { invitesAllowed: { at: '2026-10-26T16:00:00.000Z', by: 'test' } });
    // A second workplace of the same admin, not marked: it stays as it was.
    const solo = await orgStorage.createOrg({ name: 'Solo Lab', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: solo.orgId, userId: 'user-1', role: 'admin' });
    const soloLink = await orgStorage.createInvite({ orgId: solo.orgId, createdByUserId: 'user-1' });
    // A newcomer, standing in the spare workplace every new account comes with.
    await userStorage.createProfile('user-3', { displayName: 'Pat', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    const spare = await orgStorage.createOrg({ name: 'Pat’s workplace', createdByUserId: 'user-3', unnamed: true, foundingPending: true });
    await orgStorage.addMember({ orgId: spare.orgId, userId: 'user-3', role: 'admin' });
    await orgStorage.setActiveOrg('user-3', spare.orgId);
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    // The state of the marked workplace offers the doors; each row of the
    // switcher says for itself.
    const state = (await invoke('/api/state', 'get', 42, { query: { org: org.orgId } })).body as {
      organizations: Array<{ orgId: string; invitesClosed?: true }>;
    };
    expect(state).not.toHaveProperty('invitesClosed');
    expect(state.organizations.find((row) => row.orgId === org.orgId)).not.toHaveProperty('invitesClosed');
    expect(state.organizations.find((row) => row.orgId === solo.orgId)).toMatchObject({ invitesClosed: true });
    expect((await invoke('/api/state', 'get', 42, { query: { org: solo.orgId } })).body).toMatchObject({ invitesClosed: true });
    // The unmarked one makes no link, and its old link opens on closed.
    expect((await invoke('/api/org/invites', 'post', 42, { query: { org: solo.orgId } })).statusCode).toBe(403);
    expect((await invoke('/auth/invite/:token', 'get', 44, { params: { token: soloLink.token } })).body).toEqual({ status: 'closed' });
    expect((await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: soloLink.token } })).statusCode).toBe(403);
    // A link that is nobody's is simply not valid.
    expect((await invoke('/auth/invite/:token', 'get', 44, { params: { token: 'no-such-link' } })).statusCode).toBe(404);
    // The marked one makes its link, and a stranger can ask through it.
    const made = await invoke('/api/org/invites', 'post', 42, { query: { org: org.orgId } });
    expect(made.statusCode).toBe(200);
    const token = (made.body as { invite: { token: string } }).invite.token;
    expect((await invoke('/auth/invite/:token', 'get', 44, { params: { token } })).body).toEqual({ status: 'available' });
    expect((await invoke('/api/org/invites/:token', 'get', 44, { params: { token } })).body).toMatchObject({ status: 'available', name: 'Acme Trading' });
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token } });
    expect(filed.body).toMatchObject({ status: 'pending' });
    const requestId = (filed.body as { requestId: string }).requestId;
    expect((await invoke('/api/state', 'get', 44)).body).toMatchObject({ invitesClosed: true, joining: { requestId, orgName: 'Acme Trading' } });
    const record = (await invoke('/api/org', 'get', 42, { query: { org: org.orgId } })).body as { org: { invites: unknown[]; joinRequests: unknown[] } };
    expect(record.org.invites).toHaveLength(1);
    expect(record.org.joinRequests).toHaveLength(1);
    // Approved, the newcomer opens into the team rather than their spare.
    await invoke('/api/org/join-requests/:id/decision', 'post', 42, { params: { id: requestId }, body: { decision: 'approve' }, query: { org: org.orgId } });
    expect(await orgStorage.getMembership(org.orgId, 'user-3')).toMatchObject({ role: 'member' });
    expect((await orgStorage.getMembershipByUser('user-3'))?.orgId).toBe(org.orgId);
    const inside = await invoke('/api/state', 'get', 44);
    expect(inside.body).toMatchObject({ org: { orgId: org.orgId } });
    expect(inside.body).not.toHaveProperty('invitesClosed');
    expect(inside.body).not.toHaveProperty('joining');
  });

  it('taking the invite mark off (note #805) shuts the door on links and waiting requests, and keeps everyone in', async () => {
    const { deps, orgStorage, org, userStorage, webAuthStorage } = await buildOrgDeps();
    (deps as { invitesClosed?: boolean }).invitesClosed = true;
    await orgStorage.updateOrg(org.orgId, { invitesAllowed: { at: '2026-10-26T16:00:00.000Z', by: 'test' } });
    await userStorage.createProfile('user-3', { displayName: 'Pat', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    const spare = await orgStorage.createOrg({ name: 'Pat’s workplace', createdByUserId: 'user-3', unnamed: true, foundingPending: true });
    await orgStorage.addMember({ orgId: spare.orgId, userId: 'user-3', role: 'admin' });
    await orgStorage.setActiveOrg('user-3', spare.orgId);
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    const requestId = (filed.body as { requestId: string }).requestId;
    await orgStorage.updateOrg(org.orgId, { invitesAllowed: undefined });
    expect((await invoke('/auth/invite/:token', 'get', 44, { params: { token: invite.token } })).body).toEqual({ status: 'closed' });
    expect((await invoke('/api/org/join-requests/:id', 'get', 44, { params: { id: requestId } })).body).toMatchObject({ status: 'closed' });
    expect((await invoke('/api/state', 'get', 44)).body).not.toHaveProperty('joining');
    expect((await invoke('/api/state', 'get', 42, { query: { org: org.orgId } })).body).toMatchObject({ invitesClosed: true });
    // A member still walks in.
    expect((await invoke('/api/org/invites/:token', 'get', 43, { params: { token: invite.token } })).body).toMatchObject({ status: 'member' });
  });

  it('a newcomer with no workplace is held on the request (note #949), and a private copy (note #808) offers no founder door', async () => {
    const { deps, orgStorage, org, userStorage, webAuthStorage } = await buildOrgDeps();
    // A newcomer who came in through the link: an account, a pending request, no workplace.
    await userStorage.createProfile('user-3', { displayName: 'Pat', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    const filed = await orgStorage.requestToJoin(invite.token, 'user-3');
    const requestId = filed.ok ? filed.request.requestId : '';
    const read = async (identity: number) => {
      const response = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(identity) }), response);
      return response.body as Record<string, unknown>;
    };
    // Our own platform holds such a person on the request too, since note
    // #949 (an invited account has no spare workplace there either). With
    // sign-up open, the founder door stays theirs, as for any new account.
    expect(await read(44)).toMatchObject({ org: null, canCreateOrg: true, joining: { requestId, orgName: 'Acme Trading' } });
    (deps as { privateCopy?: boolean }).privateCopy = true;
    expect(await read(44)).toMatchObject({ org: null, canCreateOrg: false, joining: { requestId, orgName: 'Acme Trading' } });
    // Anyone already in a workplace of the copy still may found another.
    expect(await read(42)).toMatchObject({ canCreateOrg: true });
    expect(await read(42)).not.toHaveProperty('joining');
    // Approved: in the company's workplace, and nothing holds her at the door.
    await orgStorage.decideJoinRequest(requestId, 'user-1', 'approve');
    const inside = await read(44);
    expect(inside).toMatchObject({ org: { orgId: org.orgId }, canCreateOrg: true });
    expect(inside).not.toHaveProperty('joining');
  });

  /**
   * The September 5 simulations found the whole membership request flow
   * silent: a new request reached no admin inbox, and the applicant was told
   * neither yes nor no unless they happened to still be sitting on the
   * pending page. Both events now leave a durable record.
   */
  async function orgWithApplicant() {
    const built = await buildOrgDeps();
    const { orgStorage, org, userStorage, webAuthStorage } = built;
    await orgStorage.setMemberRole(org.orgId, 'user-2', 'admin');
    await userStorage.createProfile('user-3', { displayName: 'Pat Quinn', email: 'p@example.com' });
    await webAuthStorage.createSession(hashOpaqueToken(sessionToken(44)), testSession('user-3', 'session-44'));
    const invite = await orgStorage.createInvite({
      orgId: org.orgId, createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const notifications: Array<Record<string, unknown>> = [];
    built.deps.workspaceNotifications = {
      notify: vi.fn(async (input: Record<string, unknown>) => { notifications.push(input); return input; }),
    } as never;
    const invoke = async (path: string, method: 'get' | 'post', identity: number, args: Parameters<typeof mockRequest>[0] = {}) => {
      const response = createMockResponse();
      await getRouteHandler(built.deps, path, method)(mockRequest({ ...args, headers: authHeader(identity) }), response);
      return response;
    };
    return { ...built, invite, notifications, invoke };
  }

  it('tells every admin that somebody is waiting, and nobody else', async () => {
    const { org, invite, notifications, invoke } = await orgWithApplicant();
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    expect(filed.body).toMatchObject({ status: 'pending' });

    expect(notifications.map((entry) => entry.userId).sort()).toEqual(['user-1', 'user-2']);
    expect(notifications[0]).toMatchObject({
      kind: 'approval_required',
      title: 'Pat Quinn asked to join Acme Trading',
      url: `/workplace?org=${org.orgId}`,
    });
    expect(String(notifications[0]!.body)).toContain('approve or decline');
    // Per admin AND per request: two admins get their own copies, and one
    // admin never gets the same request twice.
    expect(new Set(notifications.map((entry) => entry.dedupeKey)).size).toBe(2);
  });

  it('tells the applicant what was decided, either way', async () => {
    const { org, orgStorage, invite, notifications, invoke } = await orgWithApplicant();
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    const requestId = (filed.body as { requestId: string }).requestId;
    notifications.length = 0;

    const declined = await invoke('/api/org/join-requests/:id/decision', 'post', 42, {
      params: { id: requestId }, body: { decision: 'reject' }, query: { org: org.orgId },
    });
    expect(declined.body).toMatchObject({ status: 'rejected' });
    expect(notifications).toEqual([expect.objectContaining({
      userId: 'user-3',
      title: 'Acme Trading declined your request',
      // They are not a member, so the workplace screen would refuse them.
      url: '/',
      dedupeKey: `org-join-decision:${requestId}`,
    })]);

    notifications.length = 0;
    const retry = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    const retryId = (retry.body as { requestId: string }).requestId;
    notifications.length = 0;
    await invoke('/api/org/join-requests/:id/decision', 'post', 42, {
      params: { id: retryId }, body: { decision: 'approve' }, query: { org: org.orgId },
    });
    expect(await orgStorage.getMembership(org.orgId, 'user-3')).toMatchObject({ role: 'member' });
    expect(notifications).toEqual([expect.objectContaining({
      userId: 'user-3',
      title: 'You joined Acme Trading',
      url: `/workplace?org=${org.orgId}`,
    })]);
  });

  it('never turns a silent inbox into a failed membership decision', async () => {
    const { org, invite, deps, invoke } = await orgWithApplicant();
    deps.workspaceNotifications = {
      notify: vi.fn(async () => { throw new Error('the inbox is unreachable'); }),
    } as never;
    // The decision is made by the route, not by its delivery. A notification
    // that cannot be written must not take the membership down with it.
    const filed = await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    expect(filed.statusCode).toBe(200);
    const decided = await invoke('/api/org/join-requests/:id/decision', 'post', 42, {
      params: { id: (filed.body as { requestId: string }).requestId },
      body: { decision: 'approve' }, query: { org: org.orgId },
    });
    expect(decided.statusCode).toBe(200);
  });

  it('lets an admin tick the waiting list without re-reading the whole record', async () => {
    const { org, orgStorage, invite, invoke } = await orgWithApplicant();
    const empty = await invoke('/api/org/join-requests', 'get', 42);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toEqual({ joinRequests: [] });

    await invoke('/api/org/invites/:token/redeem', 'post', 44, { params: { token: invite.token } });
    const listed = await invoke('/api/org/join-requests', 'get', 42);
    expect((listed.body as { joinRequests: Array<{ name: string }> }).joinRequests)
      .toMatchObject([{ userId: 'user-3', name: 'Pat Quinn' }]);

    // The same gate the record itself keeps: the waiting list is admin-only.
    await orgStorage.setMemberRole(org.orgId, 'user-2', 'member');
    const asMember = await invoke('/api/org/join-requests', 'get', 43);
    expect(asMember.statusCode).toBe(403);
  });

  it('keeps a submitted request private and readable after its link is revoked', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await orgStorage.removeMember(org.orgId, 'user-2');
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    const filed = await orgStorage.requestToJoin(invite.token, 'user-2');
    if (!filed.ok) throw new Error('fixture did not file');
    await orgStorage.revokeInvite(invite.token);
    const own = createMockResponse();
    await getRouteHandler(deps, '/api/org/join-requests/:id', 'get')(mockRequest({ headers: authHeader(43), params: { id: filed.request.requestId } }), own);
    expect(own.body).toMatchObject({ status: 'pending', orgId: org.orgId });
    const other = createMockResponse();
    await getRouteHandler(deps, '/api/org/join-requests/:id', 'get')(mockRequest({ headers: authHeader(42), params: { id: filed.request.requestId } }), other);
    expect(other.statusCode).toBe(404);
    const readLink = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites/:token', 'get')(mockRequest({ headers: authHeader(43), params: { token: invite.token } }), readLink);
    expect(readLink.statusCode).toBe(404);
    expect((await orgStorage.decideJoinRequest(filed.request.requestId, 'user-1', 'approve')).ok).toBe(true);
  });

  it('targets the viewed workplace for creation, revocation and approval after another tab switches', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const other = await orgStorage.createOrg({ name: 'Other team', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.setActiveOrg('user-1', other.orgId);
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), create);
    const token = (create.body as { invite: { token: string } }).invite.token;
    expect((await orgStorage.getInvite(token))?.orgId).toBe(org.orgId);
    await orgStorage.removeMember(org.orgId, 'user-2');
    const filed = await orgStorage.requestToJoin(token, 'user-2');
    if (!filed.ok) throw new Error('fixture did not file');
    const wrongOrg = createMockResponse();
    await getRouteHandler(deps, '/api/org/join-requests/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: filed.request.requestId }, query: { org: other.orgId }, body: { decision: 'approve' } }), wrongOrg);
    expect(wrongOrg.statusCode).toBe(404);
    const approve = createMockResponse();
    await getRouteHandler(deps, '/api/org/join-requests/:id/decision', 'post')(
      mockRequest({ headers: authHeader(42), params: { id: filed.request.requestId }, query: { org: org.orgId }, body: { decision: 'approve' } }), approve);
    expect(approve.statusCode).toBe(200);
    const revoke = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites/:token', 'delete')(mockRequest({ headers: authHeader(42), params: { token }, query: { org: org.orgId } }), revoke);
    expect(revoke.statusCode).toBe(200);
    const unauthorized = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(43), query: { org: other.orgId } }), unauthorized);
    expect(unauthorized.statusCode).toBe(403);
  });

  it('a revoked link no longer blocks deletion, but a pending request does', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    const empty = await orgStorage.createOrg({ name: 'Empty test', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: empty.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.setActiveOrg('user-1', empty.orgId);
    const live = await orgStorage.createInvite({ orgId: empty.orgId, createdByUserId: 'user-1' });
    const filed = await orgStorage.requestToJoin(live.token, 'user-2');
    if (!filed.ok) throw new Error('fixture did not file');
    await orgStorage.revokeInvite(live.token);
    const blocked = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), blocked);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toMatchObject({ holds: { invites: 0, joinRequests: 1 } });
    await orgStorage.decideJoinRequest(filed.request.requestId, 'user-1', 'reject');
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), deleted);
    expect(deleted.statusCode).toBe(200);
  });

  it('opening or requesting through a link preserves an existing member role and active org', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const other = await orgStorage.createOrg({ name: 'Elsewhere', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.setActiveOrg('user-1', other.orgId);
    const invite = await orgStorage.createInvite({ orgId: org.orgId, createdByUserId: 'user-1' });
    for (const [path, method] of [['/api/org/invites/:token', 'get'], ['/api/org/invites/:token/redeem', 'post']] as const) {
      const response = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ headers: authHeader(42), params: { token: invite.token } }), response);
      expect(response.body).toMatchObject({ status: 'member' });
      expect((await orgStorage.getMembershipByUser('user-1'))?.orgId).toBe(other.orgId);
      expect(await orgStorage.getMembership(org.orgId, 'user-1')).toMatchObject({ role: 'admin' });
    }
  });

  it('mints a Workspace invite link for admins, and refuses members', async () => {
    const { deps } = await buildOrgDeps();
    const forbidden = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(43) }), forbidden);
    expect(forbidden.statusCode).toBe(403);

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    const invite = (res.body as { invite: Record<string, unknown> }).invite;
    expect(invite.link).toBe(`https://workspace.test/invite/${invite.token as string}`);
    // No expiry, anywhere: the link lives until an admin revokes it.
    expect(Object.keys(invite)).toEqual(['token', 'link', 'createdAt']);
    // The link is a credential: it must not land in a shared cache.
    expect(res.headers['cache-control']).toBe('no-store');
    // And it now shows on the org screen as an open invite.
    const orgRes = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), orgRes);
    expect((orgRes.body as { org: { invites: Array<{ token: string }> } }).org.invites)
      .toMatchObject([{ token: invite.token }]);
  });

  it('one link per workplace: asking again hands back the one that exists', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const mint = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(42) }), res);
      return (res.body as { invite: { token: string } }).invite.token;
    };
    const first = await mint();
    expect(await mint()).toBe(first);
    expect(await mint()).toBe(first);
    expect((await orgStorage.listInvites(org.orgId)).map((row) => row.token)).toEqual([first]);

    // Revoked, the workplace has none again — and the next ask makes a new one
    // rather than resurrecting the link the admin just killed.
    expect(await orgStorage.revokeInvite(first)).toBe('revoked');
    const second = await mint();
    expect(second).not.toBe(first);
    expect((await orgStorage.listInvites(org.orgId)).map((row) => row.token)).toEqual([second]);

    // A used legacy link is history, not the workplace's live link: it does
    // not stand in the way of minting one.
    await orgStorage.redeemInvite(second, 'user-9');
    const third = await mint();
    expect(third).not.toBe(second);
  });

  it('revokes an open invite, refuses a used one, and does not know other orgs’ tokens', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const open = await orgStorage.createInvite({
      orgId: org.orgId, createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const used = await orgStorage.createInvite({
      orgId: org.orgId, createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // user-3 joins through it, so it becomes history.
    await orgStorage.removeMember(org.orgId, 'user-2');   // free the one-org rule for the redeem below
    await orgStorage.redeemInvite(used.token, 'user-2');

    const usedRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites/:token', 'delete')(
      mockRequest({ headers: authHeader(42), params: { token: used.token } }), usedRes);
    expect(usedRes.statusCode).toBe(400);
    const unknownRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites/:token', 'delete')(
      mockRequest({ headers: authHeader(42), params: { token: 'not-a-token' } }), unknownRes);
    expect(unknownRes.statusCode).toBe(404);
    const okRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites/:token', 'delete')(
      mockRequest({ headers: authHeader(42), params: { token: open.token } }), okRes);
    expect(okRes.statusCode).toBe(200);
    expect(await orgStorage.getInvite(open.token)).toBeNull();
  });

  it('lets an admin remove a member or peer admin, retiring only that org’s agents and preserving private sign-ins', async () => {
    const { deps, orgStorage, org, memberSeat } = await buildOrgDeps();
    const asMember = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(43), params: { userId: 'user-1' } }), asMember);
    expect(asMember.statusCode).toBe(403);
    const self = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-1' } }), self);
    expect(self.statusCode).toBe(400);
    await orgStorage.setMemberRole(org.orgId, 'user-2', 'admin');
    const peer = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' } }), peer);
    expect(peer.statusCode).toBe(200);
    expect(peer.body).toEqual({ ok: true, retiredAgents: 2 });
    expect(await orgStorage.getMembershipByUser('user-2')).toBeNull();
    expect(await orgStorage.getSeat(memberSeat.seatId)).not.toBeNull();
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-2', memberSeat.seatId)).toBe(false);
  });

  it('withdraws only the departing member’s unanswered requests so owner-only decisions cannot be orphaned', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.orgGit = new OrgGitService({ orgStorage });

    const repos = new InMemoryGitRepoStorage();
    const memberRepo = await repos.create({
      userId: org.orgId, orgId: org.orgId, name: 'member-work', createdByAgentId: 'agent-c',
      sizeBytes: 10, protectDefaultBranch: true,
      deleteAsk: { byAgentId: 'agent-c', byUserId: 'user-2', at: '2026-08-26T01:00:00Z' },
      ciSecretsAsk: {
        names: ['DEPLOY_KEY'], byAgentId: 'agent-c', byUserId: 'user-2', at: '2026-08-26T01:01:00Z',
      },
    });
    const adminRepo = await repos.create({
      userId: org.orgId, orgId: org.orgId, name: 'admin-work', createdByAgentId: 'agent-a',
      sizeBytes: 10, protectDefaultBranch: true,
      deleteAsk: { byAgentId: 'agent-a', byUserId: 'user-1', at: '2026-08-26T02:00:00Z' },
      ciSecretsAsk: {
        names: ['ADMIN_KEY'], byAgentId: 'agent-a', byUserId: 'user-1', at: '2026-08-26T02:01:00Z',
      },
    });

    const prs = new InMemoryGitPullRequestStorage();
    const createPr = (createdByAgentId: string, createdByUserId?: string) => prs.create({
      repoId: memberRepo.id, userId: org.orgId, createdByAgentId,
      ...(createdByUserId ? { createdByUserId } : {}),
      title: 'Change', sourceBranch: `work-${createdByAgentId}`, targetBranch: 'main', headSha: 'a'.repeat(40),
      diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['Change'], status: 'open',
    });
    const memberPr = await createPr('agent-c', 'user-2');
    const legacyMemberPr = await createPr('agent-d');
    const adminPr = await createPr('agent-a', 'user-1');

    const knowledge = new InMemoryKnowledgeProposalStorage();
    const createKnowledge = (createdByAgentId: string, createdByUserId?: string) => knowledge.create({
      userId: org.orgId, createdByAgentId,
      ...(createdByUserId ? { createdByUserId } : {}),
      title: 'Document the change',
      changes: [{
        page: `change-${createdByAgentId}`, action: 'create', html: '<title>Change</title>',
        title: 'Change', description: 'What changed.',
      }],
      status: 'open',
    } as never);
    const memberKnowledge = await createKnowledge('agent-c', 'user-2');
    const adminKnowledge = await createKnowledge('agent-a', 'user-1');

    const deployments = new InMemoryDeploymentStorage();
    const memberSite = await deployments.create({
      userId: 'user-2', orgId: org.orgId, agentId: 'agent-c', name: 'member-site',
      preset: 'static', status: 'live',
      deleteAsk: { byAgentId: 'agent-c', byUserId: 'user-2', at: '2026-08-26T03:00:00Z' },
    });
    const adminSite = await deployments.create({
      userId: 'user-1', orgId: org.orgId, agentId: 'agent-a', name: 'admin-site',
      preset: 'static', status: 'live',
      deleteAsk: { byAgentId: 'agent-a', byUserId: 'user-1', at: '2026-08-26T03:01:00Z' },
    });
    deps.gitRepoStorage = repos;
    deps.gitPullRequestStorage = prs;
    deps.knowledgeProposalStorage = knowledge;
    deps.deploymentStorage = deployments;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' } }), res);
    expect(res.statusCode).toBe(200);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toBeNull();

    for (const id of [memberPr.id, legacyMemberPr.id]) {
      expect(await prs.get(id)).toMatchObject({ status: 'withdrawn', decidedAt: expect.any(String) });
    }
    expect(await prs.get(adminPr.id)).toMatchObject({ status: 'open' });
    expect(await knowledge.get(memberKnowledge.id))
      .toMatchObject({ status: 'withdrawn', decidedAt: expect.any(String) });
    expect(await knowledge.get(adminKnowledge.id)).toMatchObject({ status: 'open' });
    expect(await repos.get(memberRepo.id)).toMatchObject({
      name: 'member-work', deleteAsk: undefined, ciSecretsAsk: undefined,
    });
    expect(await repos.get(adminRepo.id)).toMatchObject({
      name: 'admin-work',
      deleteAsk: expect.objectContaining({ byUserId: 'user-1' }),
      ciSecretsAsk: expect.objectContaining({ byUserId: 'user-1' }),
    });
    expect(await deployments.get(memberSite.id)).toMatchObject({ name: 'member-site', deleteAsk: undefined });
    expect(await deployments.get(adminSite.id)).toMatchObject({
      name: 'admin-site', deleteAsk: expect.objectContaining({ byUserId: 'user-1' }),
    });
  });

  it('keeps the membership and its agents when pending-request cleanup fails', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.gitPullRequestStorage = {
      listOpenByUser: vi.fn(async () => { throw new Error('storage unavailable'); }),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' } }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: 'Pending requests could not be closed, so the membership was kept.',
    });
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).not.toBeNull();
    expect(deps.agentLifecycle?.deleteAgent).not.toHaveBeenCalled();
  });

  it('lets a member leave one org, retires only its agents, preserves private sign-ins, and activates a remaining org', async () => {
    const { deps, userStorage, orgStorage, org, memberSeat } = await buildOrgDeps();
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'user-2' });
    await orgStorage.addMember({ orgId: other.orgId, userId: 'user-2', role: 'admin' });
    await orgStorage.setActiveOrg('user-2', org.orgId);
    await userStorage.updateAgentFields('user-2', 'agent-c', { orgId: org.orgId });
    await userStorage.updateAgentFields('user-2', 'agent-d', { orgId: org.orgId });
    const retired: string[] = [];
    deps.agentLifecycle = {
      deleteAgent: vi.fn(async (userId: string, agentId: string) => {
        retired.push(agentId);
        await userStorage.removeTelegramAgent(userId, agentId);
        return { ok: true };
      }),
    } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(43) }), res);
    expect(res.statusCode).toBe(200);
    expect(retired.sort()).toEqual(['agent-c', 'agent-d']);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toBeNull();
    expect((await orgStorage.getMembershipByUser('user-2'))?.orgId).toBe(other.orgId);
    expect(await orgStorage.getSeat(memberSeat.seatId)).not.toBeNull();
    expect(await orgStorage.isSeatAssigned(org.orgId, 'user-2', memberSeat.seatId)).toBe(false);
  });

  it('keeps a last admin in place until another member is promoted', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const blocked = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), blocked);
    expect(blocked.statusCode).toBe(409);
    expect(await orgStorage.getMembership(org.orgId, 'user-1')).not.toBeNull();

    const promote = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId/role', 'post')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' }, body: { role: 'admin' } }), promote);
    expect(promote.statusCode).toBe(200);
    const left = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), left);
    expect(left.statusCode).toBe(200);
    expect(await orgStorage.getMembership(org.orgId, 'user-1')).toBeNull();
  });

  /**
   * The two races the September 5 membership simulations reproduced against
   * a real backend (docs/membership-simulation-2026-09-05.md). Both hinge on
   * the same window: an admin's row stays in storage while their agents are
   * retired, so a second transition reading that row still counts them.
   *
   * `deleteAgent` is held open here at exactly the boundary the simulation
   * delayed, which is the only way to get two requests inside that window
   * deterministically.
   */
  async function twoAdminsOneRetiring() {
    const built = await buildOrgDeps();
    await built.orgStorage.setMemberRole(built.org.orgId, 'user-2', 'admin');
    let open!: () => void;
    const retiring = new Promise<void>((resolve) => { open = resolve; });
    // Only user-1's retirement is held open, exactly as the simulation
    // delayed the departing admin's and nobody else's.
    built.deps.agentLifecycle = {
      deleteAgent: vi.fn(async (userId: string) => {
        if (userId === 'user-1') await retiring;
        return { ok: true };
      }),
    } as never;
    const adminsIn = async () => (await built.orgStorage.listMembers(built.org.orgId))
      .filter((member) => member.role === 'admin').length;
    return { ...built, open, adminsIn };
  }

  it('refuses the second admin’s departure while the first is still retiring', async () => {
    const { deps, orgStorage, org, open, adminsIn } = await twoAdminsOneRetiring();

    const first = createMockResponse();
    const leaving = getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), first);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // user-1 is mid-retirement and still listed as an admin. Without the
    // reservation, user-2 reads two admins and leaves as well — both 200,
    // and nobody is left to run the workplace.
    const second = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(43) }), second);
    expect(second.statusCode).toBe(409);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).not.toBeNull();

    open();
    await leaving;
    expect(first.statusCode).toBe(200);
    expect(await orgStorage.getMembership(org.orgId, 'user-1')).toBeNull();
    expect(await adminsIn()).toBe(1);
  });

  it('refuses an admin’s self-demotion while the other admin is retiring out', async () => {
    const { deps, orgStorage, org, open, adminsIn } = await twoAdminsOneRetiring();

    const first = createMockResponse();
    const leaving = getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), first);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const demote = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId/role', 'post')(
      mockRequest({ headers: authHeader(43), params: { userId: 'user-2' }, body: { role: 'member' } }), demote);
    expect(demote.statusCode).toBe(409);
    expect((await orgStorage.getMembership(org.orgId, 'user-2'))?.role).toBe('admin');

    open();
    await leaving;
    expect(first.statusCode).toBe(200);
    expect(await adminsIn()).toBe(1);
  });

  it('refuses removing the second admin while the first is retiring out', async () => {
    const { deps, orgStorage, org, open, adminsIn } = await twoAdminsOneRetiring();

    const first = createMockResponse();
    const leaving = getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), first);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The departing admin is the only one left to count, so user-2 cannot be
    // removed either — by user-1 on the way out or by anyone else.
    const removal = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' } }), removal);
    expect(removal.statusCode).toBe(409);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).not.toBeNull();

    open();
    await leaving;
    expect(await adminsIn()).toBe(1);
  });

  it('lets an ordinary member leave while an admin is retiring out', async () => {
    const { deps, orgStorage, org, open } = await twoAdminsOneRetiring();
    await orgStorage.setMemberRole(org.orgId, 'user-2', 'member');
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-3', role: 'admin' });

    const first = createMockResponse();
    const leaving = getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), first);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // user-2 holds no admin seat, so the invariant has no opinion about them
    // and their departure must not queue behind a stalled retirement.
    const second = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(43) }), second);
    expect(second.statusCode).toBe(200);

    open();
    await leaving;
    expect(first.statusCode).toBe(200);
  });

  it('gives the admin seat back when a departure fails, so the next one can proceed', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    await orgStorage.setMemberRole(org.orgId, 'user-2', 'admin');
    deps.agentLifecycle = {
      deleteAgent: vi.fn(async () => ({ ok: false, reason: 'the machine could not be reached' })),
    } as never;

    const failed = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(42) }), failed);
    expect(failed.statusCode).toBe(502);
    expect(await orgStorage.getMembership(org.orgId, 'user-1')).not.toBeNull();

    // A failed departure gives nothing up, so the other admin is still free
    // to leave — the reservation must not outlive the request that took it.
    deps.agentLifecycle = { deleteAgent: vi.fn(async () => ({ ok: true })) } as never;
    const second = createMockResponse();
    await getRouteHandler(deps, '/api/org/membership', 'delete')(
      mockRequest({ headers: authHeader(43) }), second);
    expect(second.statusCode).toBe(200);
    expect(await orgStorage.getMembership(org.orgId, 'user-2')).toBeNull();
  });

  it('quick-deletes only a genuinely unused org, then returns to the previous active org', async () => {
    const { deps, orgStorage, org: first } = await buildOrgDeps();
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Disposable' } }), create);
    const disposableId = (create.body as { orgId: string }).orgId;
    expect((await orgStorage.getOrg(disposableId))?.firstRun).toBe(true);
    await orgStorage.updateOrg(disposableId, {
      media: { addOnName: 'bucket-addon', bucket: 'bucket', endpoint: 'https://bucket.test' },
    });
    const populated = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), populated);
    expect(populated.statusCode).toBe(409);
    expect(await orgStorage.getOrg(disposableId)).not.toBeNull();

    await orgStorage.updateOrg(disposableId, { media: undefined });
    const invite = await orgStorage.createInvite({
      orgId: disposableId,
      createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const invited = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), invited);
    expect(invited.statusCode).toBe(409);
    await orgStorage.revokeInvite(invite.token);

    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), deleted);
    expect(deleted.statusCode).toBe(200);
    expect(await orgStorage.getOrg(disposableId)).toBeNull();
    expect((await orgStorage.getMembershipByUser('user-1'))?.orgId).toBe(first.orgId);
  });

  it('offers the delete door to every admin, never on the platform’s own workplace (2026-09-22)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const admin = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), admin);
    // Two people and agents in it: a door all the same.
    expect(admin.body).toMatchObject({ org: { canDelete: true } });
    const member = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(43) }), member);
    expect((member.body as { org: Record<string, unknown> }).org.canDelete).toBeUndefined();

    await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'platform-fly' } });
    deps.workplaceDeletion = new WorkplaceDeletionService(deps, { platformFlyOrgSlug: 'platform-fly' });
    const platform = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), platform);
    expect(platform.body).toMatchObject({ org: { canDelete: false } });
    const refused = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Acme Trading' } }), refused);
    expect(refused.statusCode).toBe(403);
    expect((await orgStorage.getOrg(org.orgId))?.deletion).toBeUndefined();
  });

  it('locks a populated workplace behind its exact name, holds it for three days, and any admin keeps it (2026-09-22; note #654 shortened the week)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const byMember = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(43), body: { name: 'Acme Trading' } }), byMember);
    expect(byMember.statusCode).toBe(403);
    const misnamed = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'acme trading' } }), misnamed);
    expect(misnamed.statusCode).toBe(400);

    const preview = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'get')(mockRequest({ headers: authHeader(42) }), preview);
    expect(preview.body).toMatchObject({ name: 'Acme Trading', immediate: false, holds: { people: 2 } });

    const asked = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: ' Acme Trading ' } }), asked);
    expect(asked.statusCode).toBe(200);
    const deletion = (await orgStorage.getOrg(org.orgId))?.deletion;
    expect(deletion?.requestedByUserId).toBe('user-1');
    expect(Date.parse(deletion!.purgeAt) - Date.parse(deletion!.requestedAt)).toBe(3 * 24 * 3600_000);
    expect(asked.body).toMatchObject({ ok: true, deletion: { purgeAt: deletion!.purgeAt, canKeep: true } });

    // Every member's Workspace reads the lock; only an admin's may keep it.
    const adminState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), adminState);
    expect(adminState.body).toMatchObject({ org: { deletion: { purgeAt: deletion!.purgeAt, canKeep: true } } });
    const memberState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), memberState);
    expect(memberState.body).toMatchObject({
      org: { deletion: { canKeep: false } },
      organizations: [expect.objectContaining({ orgId: org.orgId, deletingAt: deletion!.purgeAt })],
    });
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(43) }), live);
    expect(live.body).toMatchObject({ workplaceDeleting: true });

    // Nothing new starts in a locked workplace.
    const agent = createMockResponse();
    await getRouteHandler(deps, '/api/agents', 'post')(mockRequest({ headers: authHeader(42), body: { cli: 'claude' } }), agent);
    expect(agent.statusCode).toBe(409);
    expect((agent.body as { error: string }).error).toBe('Acme Trading is being deleted, so no new agent can start there.');
    const invite = createMockResponse();
    await getRouteHandler(deps, '/api/org/invites', 'post')(mockRequest({ headers: authHeader(42) }), invite);
    expect(invite.statusCode).toBe(409);

    const byMemberKeep = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'delete')(mockRequest({ headers: authHeader(43) }), byMemberKeep);
    expect(byMemberKeep.statusCode).toBe(403);
    const kept = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'delete')(mockRequest({ headers: authHeader(42) }), kept);
    expect(kept.statusCode).toBe(200);
    expect((await orgStorage.getOrg(org.orgId))?.deletion).toBeUndefined();
    const liveAfter = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(43) }), liveAfter);
    expect(liveAfter.body).toMatchObject({ workplaceDeleting: false });
  });

  it('once the three days are up nobody is offered Keep, and a Keep is refused (2026-09-22)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const asked = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Acme Trading' } }), asked);
    const deletion = (await orgStorage.getOrg(org.orgId))!.deletion!;
    await orgStorage.updateOrg(org.orgId, { deletion: { ...deletion, purgeAt: new Date(Date.now() - 1000).toISOString() } });
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    expect(state.body).toMatchObject({ org: { deletion: { canKeep: false } } });
    const kept = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'delete')(mockRequest({ headers: authHeader(42) }), kept);
    expect(kept.statusCode).toBe(409);
    expect((await orgStorage.getOrg(org.orgId))?.deletion).toBeDefined();
  });

  it('an unused workplace goes at once through the same door (2026-09-22)', async () => {
    const { deps, orgStorage, org: first } = await buildOrgDeps();
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Disposable' } }), create);
    const disposableId = (create.body as { orgId: string }).orgId;
    const preview = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'get')(mockRequest({ headers: authHeader(42) }), preview);
    expect(preview.body).toMatchObject({ name: 'Disposable', immediate: true });
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Disposable' } }), deleted);
    expect(deleted.body).toMatchObject({ ok: true, deleted: true, activeOrgId: first.orgId });
    expect(await orgStorage.getOrg(disposableId)).toBeNull();
  });

  it('names a workplace once a subscription is in, and builds nothing: no agents, no arriving screen (notes #144, #656, #726)', async () => {
    const { deps, orgStorage, userStorage } = await buildOrgDeps();
    await userStorage.updatePersonFields('user-1', { firstName: 'Aigerim', lastName: 'Baialieva' });
    // Until note #726 the founding furnished two rooms and four planned
    // agents behind an arriving screen. The agents are the Chief of Staff's
    // to bring in now, for the work the person names in its chat — so the
    // founding writes records only, and starts no machine, not even the
    // Chief of Staff's own.
    const setUpPlannedAgents = vi.fn(async () => undefined);
    const converseWorkspaceRecap = vi.fn(async () => ({ text: 'Hi Aigerim, I’m your Chief of Staff.' }));
    deps.agentLifecycle = {
      ...(deps.agentLifecycle as object),
      setUpPlannedAgents,
      converseWorkspaceRecap,
    } as never;
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Northstar Studio' } }), create);
    const made = create.body as { orgId: string };
    expect(await orgStorage.getOrg(made.orgId)).toMatchObject({ foundingPending: true, firstRun: true });

    // Not yet: no subscription. The stamp stays.
    await deps.workplaceFounding!.foundIfReady('user-1', made.orgId);
    expect((await orgStorage.getOrg(made.orgId))?.foundingPending).toBe(true);

    // The subscription lands: the stamp comes off, once, and nothing else is written.
    await orgStorage.addSeat({ orgId: made.orgId, userId: 'user-1', provider: 'claude', token: 'sk-ant-oat-x', label: 'max', status: 'active' });
    await deps.workplaceFounding!.foundIfReady('user-1', made.orgId);
    await deps.workplaceFounding!.foundIfReady('user-1', made.orgId);
    const named = (await orgStorage.getOrg(made.orgId))!;
    expect(named.foundingPending).toBe(false);
    expect(named.arriving).toBeUndefined();
    expect(Object.values((await userStorage.getProfile('user-1'))!.telegram!.agents!)
      .filter((agent) => agent.orgId === made.orgId)).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setUpPlannedAgents).not.toHaveBeenCalled();
    expect(converseWorkspaceRecap).not.toHaveBeenCalled();

    // Home is the Chief of Staff's chat, which opens on the fixed greeting
    // (note #726) — a row the platform wrote in its voice, no turn run.
    const chat = createMockResponse();
    await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(42), query: { org: made.orgId } }), chat);
    expect(chat.body).toMatchObject({
      working: false,
      messages: [{ role: 'assistant', kind: 'greeting', text: 'Hi Aigerim, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.' }],
    });
    expect(converseWorkspaceRecap).not.toHaveBeenCalled();

    // The state read: founded, nobody planned, and NO gate — not for the
    // subscription, not for the name, not for an arriving team.
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42), query: { org: made.orgId } }), state);
    expect((state.body as { agents: Array<{ status: string }> }).agents.filter((row) => row.status === 'planned')).toHaveLength(0);
    const open = (state.body as { org: { setupRequired?: boolean; unnamed?: boolean; arriving?: boolean; founded?: boolean } }).org;
    expect([open.setupRequired, open.unnamed, open.arriving, open.founded]).toEqual([undefined, undefined, undefined, true]);

    // The arriving screen's button still answers, idempotently, for a tab
    // that was on it at the deploy.
    const arrived = createMockResponse();
    await getRouteHandler(deps, '/api/org/arrived', 'post')(mockRequest({ headers: authHeader(42), query: { org: made.orgId } }), arrived);
    expect(arrived.body).toEqual({ ok: true, orgId: made.orgId });
    const again = createMockResponse();
    await getRouteHandler(deps, '/api/org/arrived', 'post')(mockRequest({ headers: authHeader(42), query: { org: made.orgId } }), again);
    expect(again.statusCode).toBe(200);

    // Untouched, the workplace is not a holding: the founder can still
    // quick-delete it.
    for (const seat of await orgStorage.listSeatsByMember(made.orgId, 'user-1')) await orgStorage.removeSeat(seat.seatId).catch(() => undefined);
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), deleted);
    expect(deleted.statusCode).toBe(200);
    expect(await orgStorage.getOrg(made.orgId)).toBeNull();
  });

  it('accepts the account workplace’s default name when its subscription is in, and opens no gate while it waits', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    const setUpPlannedAgents = vi.fn(async () => undefined);
    deps.agentLifecycle = { setUpPlannedAgents } as never;
    const org = await orgStorage.createOrg({ name: 'Aigerim’s workplace', createdByUserId: 'user-1', setupRequired: true, unnamed: true, foundingPending: true, firstRun: true });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addSeat({ orgId: org.orgId, userId: 'user-1', provider: 'claude', token: 'sk-ant-oat-y', label: 'max', status: 'active' });
    await orgStorage.setActiveOrg('user-1', org.orgId);
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), state);
    // Still unnamed on this read — and the Workspace is open all the same
    // (note #726): `setupRequired` is never said of any workplace.
    const before = (state.body as { org: Record<string, unknown> }).org;
    expect(before).toMatchObject({ unnamed: true });
    expect(before).not.toHaveProperty('setupRequired');

    // No naming request: readiness turns the first-name-based placeholder
    // into the real default. Nothing is furnished behind it.
    await deps.workplaceFounding!.foundIfReady('user-1', org.orgId);
    expect(await orgStorage.getOrg(org.orgId)).toMatchObject({ name: 'Aigerim’s workplace', unnamed: false, foundingPending: false });
    expect((await orgStorage.getOrg(org.orgId))?.arriving).toBeUndefined();
    expect(setUpPlannedAgents).not.toHaveBeenCalled();
    const after = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), after);
    const summary = (after.body as { org: { setupRequired?: boolean; unnamed?: boolean; arriving?: boolean; founded?: boolean; name: string } }).org;
    expect([summary.setupRequired, summary.unnamed, summary.arriving, summary.founded]).toEqual([undefined, undefined, undefined, true]);
    expect(summary.name).toBe('Aigerim’s workplace');
  });

  it('welcomes a person who joined a workplace with work in it: by name, one list of agents, its latest notes, no starters (notes #820, #843)', async () => {
    const { deps, org, userStorage } = await buildOrgDeps();
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    deps.agentLifecycle = { ...deps.agentLifecycle, isAgentWorking: (_u: string, agentId: string) => agentId === 'agent-b' } as never;
    await userStorage.updateAgentFields('user-1', 'agent-a', { recap: { text: 'Put the pricing page live and checked it on a phone. Waiting on Adam for the copy.', at: '2026-10-27T10:00:00.000Z' } } as never);
    // Every note stands at the workplace's namespace (note #843).
    await notes.create({ userId: 'user-1', html: '<h2>Launch checklist</h2><p>Ten things.</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    await notes.create({ userId: 'user-1', html: '<p>Pricing ideas</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    const chat = async (identity: number) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(identity), query: { org: org.orgId } }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { messages: Array<{ role: string; kind?: string; text: string }> }).messages;
    };
    // Dana joined through an invite (the membership names who let her in).
    const [welcome, ...rest] = await chat(43);
    expect(rest).toEqual([]);
    expect(welcome).toMatchObject({ role: 'assistant', kind: 'welcome' });
    const lines = welcome!.text.split('\n');
    expect(lines[0]).toBe('Hi Dana, welcome to Acme Trading. I\'m your Chief of Staff here. Here\'s what\'s already going on.');
    // Every agent under one heading, the working one first, each with the
    // first sentence of what it last did.
    expect(welcome!.text).toContain('**Agents**\n- **Ruby**, Owner\'s agent: working on its first job now.\n- **Ben**, Owner\'s agent: Put the pricing page live and checked it on a phone.');
    // Each note once, with no room after it.
    const latest = welcome!.text.split('**Latest notes**\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(latest).toHaveLength(2);
    expect(latest.every((line) => /^- \[(Pricing ideas|Launch checklist)\]\(\/notes\/\d+\?org=[^&)]+\)$/.test(line))).toBe(true);
    expect(welcome!.text).not.toContain('room=');
    expect(welcome!.text).not.toContain('Waiting on Adam');
    expect(welcome!.text).not.toContain('Leo'); // her own agent is not news to her
    expect(lines.at(-1)).toBe('Ask me about any of it, or tell me what you\'d like to work on.');
    expect(welcome!.text).not.toContain('Put a waitlist page live');
    // Written once: a second read is the same row, not a fresh one.
    expect(await chat(43)).toEqual([welcome]);
    // The founder of an old workplace (no first-run mark) is not welcomed to it.
    expect(await chat(42)).toEqual([]);
  });

  it('keeps the old empty chat for a member who joined before the hello shipped, or who was never invited (note #820)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    const read = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/recap/chat', 'get')(mockRequest({ headers: authHeader(43), query: { org: org.orgId } }), res);
      return (res.body as { messages: unknown[] }).messages;
    };
    await orgStorage.touchMember(org.orgId, 'user-2', { joinedAt: '2026-10-01T00:00:00.000Z' } as never);
    expect(await read()).toEqual([]);
    await orgStorage.touchMember(org.orgId, 'user-2', { joinedAt: new Date().toISOString(), invitedByUserId: undefined } as never);
    expect(await read()).toEqual([]);
  });

  it('a fresh workplace someone has written a note in is a holding — its name alone is not', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    // Quick delete reads a name as no content and a note as content.
    const found = async () => {
      const create = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(
        mockRequest({ headers: authHeader(42), body: { name: 'Northstar Studio' } }), create);
      return (create.body as { orgId: string }).orgId;
    };
    // A rename alone is not content...
    const first = await found();
    const renamed = createMockResponse();
    await getRouteHandler(deps, '/api/org/name', 'post')(
      mockRequest({ headers: authHeader(42), query: { org: first }, body: { name: 'Marketing' } }), renamed);
    expect(renamed.statusCode).toBe(200);
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), deleted);
    expect(deleted.statusCode).toBe(200);
    expect(await orgStorage.getOrg(first)).toBeNull();
    // ...a note in the workplace is.
    const second = await found();
    await notes.create({ userId: orgKnowledgeShelfNamespace((await orgStorage.getOrg(second))!), html: '<p>Launch plan</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    const refused = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), refused);
    expect(refused.statusCode).toBe(409);
    expect((refused.body as { holds: { notes: number } }).holds.notes).toBe(1);
    expect(await orgStorage.getOrg(second)).not.toBeNull();
  });

  /**
   * Note #246. The refusal used to fold eleven findings into one sentence —
   * "This workplace has resources or history" — which is true of all of
   * them and actionable for none, on a screen that says 0 repositories.
   */
  it('names what is in the way instead of saying only that something is', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Big Time Corp' } }), create);
    const orgId = (create.body as { orgId: string }).orgId;
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    await notes.create({ userId: orgKnowledgeShelfNamespace((await orgStorage.getOrg(orgId))!), html: '<p>Math school plan</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    await orgStorage.createInvite({
      orgId,
      createdByUserId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const refused = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), refused);
    expect(refused.statusCode).toBe(409);
    const body = refused.body as { error: string; holds: Record<string, number> };
    // Both, by name and in the app's own words — a note is not "history".
    expect(body.error).toBe(
      'Big Time Corp still has 1 note and 1 active invite link.'
      + ' Clear them first, or use the offboarding flow.',
    );
    expect(body.holds).toMatchObject({ notes: 1, invites: 1, agents: 0, repos: 0 });
    // Rooms are no holding: they are gone (note #923).
    expect(body.holds).not.toHaveProperty('rooms');
  });

  /**
   * The workplace from the note's own screenshot, as production actually
   * held it: one Codex agent and the Codex sign-in assigned to it, and
   * nothing else at all. The old answer was "resources or history"; this is
   * the sentence that would have ended the note on the day it was written.
   */
  it('answers the case from the note: one agent and the sign-in it uses', async () => {
    const { deps, orgStorage, userStorage } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Big Time Corp' } }), create);
    const orgId = (create.body as { orgId: string }).orgId;
    await userStorage.updateAgentFields('user-1', 'agent-a', { orgId });
    await orgStorage.addSeat({
      orgId, userId: 'user-1', provider: 'codex', token: '{}', label: 'codex-1', status: 'active',
    });

    const refused = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), refused);
    expect(refused.statusCode).toBe(409);
    // "assigned", not "sign-in": unassigning is what clears it, and deleting
    // the credential would take it out of every other workplace too.
    expect((refused.body as { error: string }).error).toBe(
      'Big Time Corp still has 1 agent and 1 assigned sign-in.'
      + ' Clear them first, or use the offboarding flow.',
    );
  });

  /**
   * Note #246, and the reason the note exists. The git host purges a deleted
   * repo's bytes after GIT_TRASH_KEEP_DAYS; the tombstone row is never swept.
   * Counting it forever meant a workplace that EVER held a repository
   * could never be deleted — while the Workspace, which stopped showing the
   * trash at all, reported 0 repositories.
   */
  it('counts a repository in the trash only while Restore can still reach it', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    const repos = new InMemoryGitRepoStorage();
    deps.gitRepoStorage = repos;
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Big Time Corp' } }), create);
    const orgId = (create.body as { orgId: string }).orgId;

    const repo = await repos.create({ userId: orgId, orgId, name: 'scratch' } as never);
    await repos.update(repo.id, { deletedAt: new Date(Date.now() - 86_400_000).toISOString() });
    const fresh = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), fresh);
    expect(fresh.statusCode).toBe(409);
    expect((fresh.body as { error: string }).error)
      .toContain('still has 1 repository in the trash');

    // A day past the window: the bytes are gone, the trash is empty on every
    // screen a person can open, and the row must stop refusing the delete.
    await repos.update(repo.id, {
      deletedAt: new Date(Date.now() - (GIT_TRASH_KEEP_DAYS + 1) * 86_400_000).toISOString(),
    });
    expect((await repos.listTrashedByUser(orgId)).length).toBe(1);
    const lapsed = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'delete')(mockRequest({ headers: authHeader(42) }), lapsed);
    expect(lapsed.statusCode).toBe(200);
    expect(await orgStorage.getOrg(orgId)).toBeNull();
  });

  /** The screen must be able to say it BEFORE the tap, as the room screen has
   *  since note #100 — otherwise the button is a trap and the words under it
   *  are a promise the backend does not keep. */
  it('tells the delete screen whether the workplace goes at once or waits out its three days', async () => {
    const { deps, orgStorage } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    const create = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'post')(
      mockRequest({ headers: authHeader(42), body: { name: 'Big Time Corp' } }), create);
    const orgId = (create.body as { orgId: string }).orgId;

    const empty = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'get')(mockRequest({ headers: authHeader(42) }), empty);
    expect(empty.body).toMatchObject({ immediate: true, holds: { people: 1, notes: 0 } });
    // Rooms are no holding: they are gone (note #923).
    expect((empty.body as { holds: Record<string, number> }).holds).not.toHaveProperty('rooms');

    // A note is somebody's work: the same door, but the three days.
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    await notes.create({ userId: orgKnowledgeShelfNamespace((await orgStorage.getOrg(orgId))!), html: '<p>Math school plan</p>', createdByAgentId: 'user', updatedByAgentId: 'user' });
    const held = createMockResponse();
    await getRouteHandler(deps, '/api/org/deletion', 'get')(mockRequest({ headers: authHeader(42) }), held);
    expect(held.body).toMatchObject({ immediate: false, holds: { notes: 1 } });
    // The details screen offers the door either way, and names no blocker.
    const detail = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), detail);
    expect((detail.body as { org: Record<string, unknown> }).org).toMatchObject({ canDelete: true });
    expect((detail.body as { org: Record<string, unknown> }).org).not.toHaveProperty('blocked');
  });

  /**
   * Rooms are gone (note #923): every screen and verb that opened, ordered,
   * renamed, described, kept or deleted one, or moved an agent or a note
   * into one, went with them. A page from before that asks finds nothing.
   */
  it('has no room routes left (note #923)', async () => {
    const { deps } = await buildOrgDeps();
    for (const [path, method] of [
      ['/api/rooms', 'post'], ['/api/rooms/order', 'post'],
      ['/api/rooms/:id', 'get'], ['/api/rooms/:id', 'delete'],
      ['/api/rooms/:id/name', 'post'], ['/api/rooms/:id/keep', 'post'],
      ['/api/agents/:id/room', 'post'], ['/api/notes/:number/room', 'post'],
    ] as const) {
      expect(() => getRouteHandler(deps, path, method), `${method} ${path}`).toThrow();
    }
  });

  it('pins one of the caller’s own seats to their agent, and clears the pin (note #129)', async () => {
    const { deps, userStorage, orgStorage, org, adminSeat, memberSeat } = await buildOrgDeps();
    const wake = vi.fn().mockResolvedValue(undefined);
    (deps.agentLifecycle as { connectAgentsForSeat?: typeof wake }).connectAgentsForSeat = wake;
    const pin = getRouteHandler(deps, '/api/agents/:id/seat', 'post');

    // In: the owner pins their own matching seat, and the state row says so.
    const pinned = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId: memberSeat.seatId },
    }), pinned);
    expect(pinned.statusCode).toBe(200);
    expect((await userStorage.getProfile('user-2'))?.telegram?.agents?.['agent-c']?.seatId)
      .toBe(memberSeat.seatId);
    expect(wake).toHaveBeenCalledWith('user-2', 'codex', org.orgId);
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), state);
    const row = (state.body as { agents: Array<{ id: string; seatId?: string }> }).agents
      .find((candidate) => candidate.id === 'agent-c');
    expect(row?.seatId).toBe(memberSeat.seatId);

    // Somebody else's seat is "no such seat" — never "not yours", which
    // would confirm it exists — and somebody else's agent is not pinnable.
    const notYourSeat = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId: adminSeat.seatId },
    }), notYourSeat);
    expect(notYourSeat.statusCode).toBe(404);
    const notYourAgent = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-a' }, body: { seatId: memberSeat.seatId },
    }), notYourAgent);
    expect(notYourAgent.statusCode).toBe(404);

    // A seat of the wrong provider is refused with the reason: Leo runs Codex.
    const claudeSeat = await orgStorage.addSeat({
      orgId: org.orgId, userId: 'user-2', provider: 'claude',
      token: 'sk-ant-oat-member-claude', label: 'own Claude', status: 'active',
    });
    const mismatched = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId: claudeSeat.seatId },
    }), mismatched);
    expect(mismatched.statusCode).toBe(400);
    expect((mismatched.body as { error: string }).error).toMatch(/Claude subscription/);
    expect((await userStorage.getProfile('user-2'))?.telegram?.agents?.['agent-c']?.seatId)
      .toBe(memberSeat.seatId);

    // A stale client cannot pin a billing-blocked seat and claim success.
    await orgStorage.updateSeat(memberSeat.seatId, {
      status: 'payment_required', subscriptionStatus: 'past_due',
    });
    const paymentBlocked = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId: memberSeat.seatId },
    }), paymentBlocked);
    expect(paymentBlocked.statusCode).toBe(409);
    expect((paymentBlocked.body as { error: string }).error).toMatch(/restore access/i);
    await orgStorage.updateSeat(memberSeat.seatId, { status: 'active' });

    // Out: an empty seatId returns the agent to the org's own selection.
    const cleared = createMockResponse();
    await pin(mockRequest({
      headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId: '' },
    }), cleared);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toEqual({ ok: true, seatId: null });
    expect((await userStorage.getProfile('user-2'))?.telegram?.agents?.['agent-c']?.seatId)
      .toBeUndefined();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('a chosen subscription that is unlinked or deleted puts its agents back on the default (note #773)', async () => {
    const { deps, userStorage, memberSeat } = await buildOrgDeps();
    const pin = getRouteHandler(deps, '/api/agents/:id/seat', 'post');
    const pinTo = async (seatId: string) => {
      const answer = createMockResponse();
      await pin(mockRequest({ headers: authHeader(43), params: { id: 'agent-c' }, body: { seatId } }), answer);
      expect(answer.statusCode).toBe(200);
    };
    const pinned = async () => (await userStorage.getProfile('user-2'))?.telegram?.agents?.['agent-c']?.seatId;

    // Unlinked from this workplace: the agent follows the default again, so
    // the day that sign-in is linked back it does not silently rule again.
    await pinTo(memberSeat.seatId);
    expect(await pinned()).toBe(memberSeat.seatId);
    const unlinked = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(43), params: { seatId: memberSeat.seatId } }),
      unlinked,
    );
    expect(unlinked.statusCode).toBe(200);
    expect(await pinned()).toBeUndefined();

    // Deleted everywhere: the same.
    await getRouteHandler(deps, '/api/org/seats/:seatId/assign', 'post')(
      mockRequest({ headers: authHeader(43), params: { seatId: memberSeat.seatId } }),
      createMockResponse(),
    );
    await pinTo(memberSeat.seatId);
    expect(await pinned()).toBe(memberSeat.seatId);
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(43), params: { seatId: memberSeat.seatId } }),
      deleted,
    );
    expect(deleted.statusCode).toBe(200);
    expect(await pinned()).toBeUndefined();
  });

  it('Outreach (notes #1089, #1093, #1103): with the owner\'s pass, the store read live and his own letter saved; no import; no pass, a member\'s pass, the session alone or a private copy are refused', async () => {
    const { deps, userStorage } = await buildOrgDeps();
    deps.outreach = new OutreachService({ store: new InMemoryOutreachStore(), outbox: () => undefined });
    const passes = new OutreachPasses(new InMemoryOutreachPassStore());
    deps.outreachPasses = passes;
    const ownerPass = (await passes.mint('user-1', { sessionId: 'session-42', absoluteExpiresAt: '2099-01-01T00:00:00.000Z' })).token;
    const memberPass = (await passes.mint('user-2', { sessionId: 'session-43', absoluteExpiresAt: '2099-01-01T00:00:00.000Z' })).token;
    const call = async (headers: Record<string, string>, path: string, method: 'get' | 'post', body: Record<string, unknown> = {}, params: Record<string, string> = {}) => {
      const res = createMockResponse();
      await getRouteHandler(deps, path, method)(mockRequest({ headers, body, params }), res);
      return res;
    };
    const as = (pass: string) => ({ authorization: `Bearer ${pass}` });

    // There is no import any more: the words arrive from the agents' door.
    expect(() => getRouteHandler(deps, '/api/outreach/import', 'post')).toThrow();
    // The Workspace session alone opens nothing: the routes take a pass.
    expect((await call(authHeader(42), '/api/outreach', 'get')).statusCode).toBe(401);
    // A pass of somebody who is not the operator: refused.
    expect((await call(as(ownerPass), '/api/outreach', 'get')).statusCode).toBe(403);
    await userStorage.updateProfile('user-1', { roles: { admin: true } } as never);
    // Nothing written yet: an empty list, nothing to press.
    const empty = await call(as(ownerPass), '/api/outreach', 'get');
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toMatchObject({ lastWrite: null, rows: [] });
    // An agent writes; the very next read shows it, profile and all.
    const parsed = parseOutreachWrite(fixtureOutreachWrite());
    if (!parsed.ok) throw new Error(parsed.error);
    await deps.outreach.write('user-1', { agentId: 'agent-rowan', name: 'Rowan' }, parsed.write);
    const list = await call(as(ownerPass), '/api/outreach', 'get');
    expect(list.statusCode).toBe(200);
    expect((list.body as { lastWrite: { by: string } }).lastWrite.by).toBe('Rowan');
    expect((list.body as { rows: Array<{ id: string; zone: string | null }> }).rows.find((row) => row.id === 'northwind-health')?.zone).toBe('America/Los_Angeles');
    const one = await call(as(ownerPass), '/api/outreach/targets/:id', 'get', {}, { id: 'northwind-health' });
    expect((one.body as { seed: { profile: { fundingRound: string } } }).seed.profile.fundingRound).toMatch(/Seed, 2025/);
    // His own letter, saved through his pass.
    const saved = await call(as(ownerPass), '/api/outreach/targets/:id/letter', 'post', { action: 'save', subject: 'Mine', text: 'My words.' }, { id: 'northwind-health' });
    expect(saved.statusCode).toBe(200);
    expect((saved.body as { draft: { from: string; text: string } }).draft).toMatchObject({ from: 'yours', text: 'My words.' });
    expect((await call(as(ownerPass), '/api/outreach/targets/:id/letter', 'post', { action: 'shout' }, { id: 'northwind-health' })).statusCode).toBe(400);
    // The member of the same workplace sees nothing: no list, no profile, no letter, no Send.
    expect((await call(as(memberPass), '/api/outreach', 'get')).statusCode).toBe(403);
    expect((await call(as(memberPass), '/api/outreach/targets/:id/letter', 'post', { action: 'save', subject: 's', text: 't' }, { id: 'northwind-health' })).statusCode).toBe(403);
    expect((await call(as(memberPass), '/api/outreach/targets/:id/send', 'post', { step: 'first', subject: 's', text: 't' }, { id: 'northwind-health' })).statusCode).toBe(403);
    expect((await call({}, '/api/outreach', 'get')).statusCode).toBe(401);
    // A Send with no mail service is refused, and nothing changes.
    expect((await call(as(ownerPass), '/api/outreach/targets/:id/send', 'post', { step: 'first', subject: 's', text: 't' }, { id: 'northwind-health' })).statusCode).toBe(503);
    // In a private copy there is no Outreach at all.
    deps.privateCopy = true;
    expect((await call(as(ownerPass), '/api/outreach', 'get')).statusCode).toBe(404);
    deps.privateCopy = false;
    // The pass dies with the sign-in it was given to.
    await deps.workspaceWebAuth!.revokeSession('user-1', 'session-42');
    expect((await call(as(ownerPass), '/api/outreach', 'get')).statusCode).toBe(401);
  });

  it('signs a note file to be DRAWN only when the Workspace can draw it', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const note = await notes.create({
      userId: org.orgId, html: '<p>The autumn menu</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
      attachments: [
        { id: 'a1', fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 9, storagePath: 'n/1', addedByAgentId: 'agent-a', addedAt: 't' },
        { id: 'a2', fileName: 'plan.svg', contentType: 'image/svg+xml', sizeBytes: 9, storagePath: 'n/2', addedByAgentId: 'agent-a', addedAt: 't' },
        { id: 'a3', fileName: 'walkthrough.mp4', contentType: 'video/mp4', sizeBytes: 9, storagePath: 'n/3', addedByAgentId: 'agent-a', addedAt: 't' },
      ],
    } as never);
    const createReadAccess = vi.fn().mockResolvedValue({ url: 'https://media.example/signed', expiresAt: 't' });
    deps.mediaStorage = { createReadAccess } as never;
    const read = async (id: string, query: Record<string, string> = {}) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/notes/:number/files/:id', 'get')(mockRequest({
        headers: authHeader(42), params: { number: String(note.number), id }, query,
      }), res);
      expect(res.statusCode).toBe(200);
      return createReadAccess.mock.calls.at(-1)![0] as Record<string, unknown>;
    };

    expect(await read('a1', { preview: '1' })).toMatchObject({ responseDisposition: 'inline' });
    expect(await read('a1')).toMatchObject({ promptSaveAs: 'menu.pdf' });
    // An SVG is a document that can carry script, not a picture — the reason
    // the shell has never drawn one, and it is not signed to be opened here
    // however the query asks.
    expect(await read('a2', { preview: '1' })).toMatchObject({ promptSaveAs: 'plan.svg' });
    // A video PLAYS on its slide (note #693's follow-up): signed to be
    // played for the player, and to be saved for its Download.
    expect(await read('a3', { preview: '1' })).toMatchObject({ responseDisposition: 'inline' });
    expect(await read('a3')).toMatchObject({ promptSaveAs: 'walkthrough.mp4' });
  });

  /**
   * Note #741 (Adam, 12 Oct 2026): "I remember you referenced a note, gave
   * me a link, but that note didn't exist. Because note is per room. And
   * there was wrong room in the link."
   *
   * Numbers are ONE series for the workplace, and since rooms went (note
   * #843) the room in an old link is read by nothing: the note opens from a
   * link with any room, or none. The old per-room numbers were kept at the
   * old rooms' namespaces, so the one thing a link cannot do is choose
   * between two of them that both still hold a legacy number.
   */
  it('opens a note from a link with a stale room, or none, and numbers new notes across the workplace (note #741)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    // Two old rooms' namespaces, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      git: { namespaceId: org.orgId },
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-platform', 'ns-growth'] },
    });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    // The world before: each room counted its own, so both hold a "#1".
    const jot = (userId: string, html: string) => notes.create({
      userId, html, createdByAgentId: 'user', createdByUserId: 'user-1', updatedByAgentId: 'user', updatedByUserId: 'user-1',
    });
    const platformOne = await jot('ns-platform', '<p>Platform one</p>');
    const growthOne = await jot('ns-growth', '<p>Growth one</p>');
    expect([platformOne.number, growthOne.number]).toEqual([1, 1]);

    // A note written now takes the next number of the WORKPLACE, and lands
    // at the workplace's own namespace whatever room the page still names.
    const wrote = createMockResponse();
    await getRouteHandler(deps, '/api/notes', 'post')(mockRequest({
      headers: authHeader(42), query: { room: 'room-from-an-old-link' }, body: { text: 'Workplace-numbered' },
    }), wrote);
    expect(wrote.statusCode).toBe(200);
    expect((wrote.body as { note: { number: number } }).note.number).toBe(2);
    expect((await notes.getByNumber(org.orgId, 2))?.html).toBe('<p>Workplace-numbered</p>');

    const open = async (number: number, query: Record<string, string>) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/notes/:number', 'get')(
        mockRequest({ headers: authHeader(42), query, params: { number: String(number) } }), res);
      return res;
    };
    // Any room, a room that is not there, no room: all open the workplace's #2.
    for (const query of [{ room: 'room-platform' }, { room: 'room-that-was-deleted' }, {}] as Array<Record<string, string>>) {
      const res = await open(2, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(200);
      const note = (res.body as { note: Record<string, unknown> }).note;
      expect(note).toMatchObject({ title: 'Workplace-numbered' });
      // A note's margin is the workplace's: no room to file a remark under.
      expect(note).not.toHaveProperty('commentRoomId');
    }
    // A legacy number held twice is the one thing that cannot be guessed.
    const shared = await open(1, {});
    expect(shared.statusCode).toBe(404);
    expect((shared.body as { error: string }).error).toContain('held twice');
    expect((await open(9, {})).statusCode).toBe(404);

    // Every note verb goes through the same door: archiving #2 from a stale
    // room's address archives the workplace's #2, nothing else.
    const archived = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number/archive', 'post')(
      mockRequest({ headers: authHeader(42), query: { room: 'room-platform' }, params: { number: '2' } }), archived);
    expect(archived.statusCode).toBe(200);
    expect((await notes.getByNumber(org.orgId, 2))?.archivedAt).toBeTruthy();
    expect((await notes.getByNumber('ns-platform', 1))?.archivedAt).toBeUndefined();
  });

  /**
   * Note #637: "If user is not author of a note, user should not be able to
   * move or archive note."
   *
   * A workplace shares its notes, so every one of these verbs used to reach
   * every note anybody could see — and the member who wrote one would find it
   * filed with nothing but a timestamp to say why. The wall is drawn at the
   * HUMAN behind the note: their own jottings and the ones their agents keep
   * for them. (Moving a note between rooms went with the rooms, note #923.)
   */
  it('lets no member file or delete a note that is not theirs (note #637)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    // One workplace, three notes: the teammate's own hand, the teammate's agent,
    // and the reader's own agent — the last of which stays entirely theirs to
    // file, because a note an agent keeps is kept FOR somebody.
    const wrote = await notes.create({
      userId: org.orgId, html: '<p>Dana wrote this</p>',
      createdByAgentId: 'user', createdByUserId: 'user-2',
      updatedByAgentId: 'user', updatedByUserId: 'user-2',
    });
    const kept = await notes.create({
      userId: org.orgId, html: '<p>Leo keeps this</p>',
      createdByAgentId: 'agent-c', updatedByAgentId: 'agent-c', updatedByUserId: 'user-2',
    });
    const mine = await notes.create({
      userId: org.orgId, html: '<p>My own agent keeps this</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a', updatedByUserId: 'user-1',
    });

    // The screen is told the same thing the routes will enforce, which is
    // what keeps the buttons and the answers from drifting apart.
    const read = async (number: number) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/notes/:number', 'get')(
        mockRequest({ headers: authHeader(42), params: { number: String(number) } }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { note: { yours?: true; byMember?: true } }).note;
    };
    expect(await read(wrote.number)).toMatchObject({ byMember: true });
    expect((await read(wrote.number)).yours).toBeUndefined();
    expect((await read(kept.number)).yours).toBeUndefined();
    expect(await read(mine.number)).toMatchObject({ yours: true });

    const archive = getRouteHandler(deps, '/api/notes/:number/archive', 'post');
    const refused = async (number: number) => {
      const res = createMockResponse();
      await archive(mockRequest({ headers: authHeader(42), params: { number: String(number) } }), res);
      return res;
    };
    const byHand = await refused(wrote.number);
    expect(byHand.statusCode).toBe(403);
    expect(String((byHand.body as { error: string }).error))
      .toBe('Another workplace member wrote this note, so only they and their agents can archive it. Leave a comment on it instead.');
    expect((await notes.get(wrote.id))?.archivedAt).toBeUndefined();
    const byAgent = await refused(kept.number);
    expect(byAgent.statusCode).toBe(403);
    expect(String((byAgent.body as { error: string }).error))
      .toContain('Another workplace member’s agent keeps this note');
    expect((await notes.get(kept.id))?.archivedAt).toBeUndefined();

    // …and the reader's own agent's note files exactly as it always did.
    const own = createMockResponse();
    await archive(mockRequest({ headers: authHeader(42), params: { number: String(mine.number) } }), own);
    expect(own.statusCode).toBe(200);
    expect((await notes.get(mine.id))?.archivedAt).toBeTruthy();

    // The archive is not a way around it either way: a teammate's note that
    // is already filed cannot be pulled back out, and cannot be deleted for
    // good — the one irreversible verb in this store.
    await notes.update(wrote.id, { archivedAt: '2026-09-01T09:00:00.000Z' });
    const restored = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number/archive', 'delete')(
      mockRequest({ headers: authHeader(42), params: { number: String(wrote.number) } }), restored);
    expect(restored.statusCode).toBe(403);
    expect(String((restored.body as { error: string }).error)).toContain('bring it back from the archive');
    expect((await notes.get(wrote.id))?.archivedAt).toBe('2026-09-01T09:00:00.000Z');
    const deleted = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number', 'delete')(
      mockRequest({ headers: authHeader(42), params: { number: String(wrote.number) } }), deleted);
    expect(deleted.statusCode).toBe(403);
    expect(await notes.get(wrote.id)).toBeTruthy();

    // What the reader DOES have on a teammate's note: the margin, which
    // leaves the note standing where its author put it.
    const said = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number/comments', 'post')(mockRequest({
      headers: authHeader(42), params: { number: String(kept.number) }, body: { text: 'This one is done, worth filing.' },
    }), said);
    expect(said.statusCode).toBe(200);
    expect((await notes.get(kept.id))?.comments).toHaveLength(1);
  });

  /**
   * Note #647: the margin under a note follows the same rule as every other
   * margin — the author of a remark can take it back — and the ARCHIVE keeps
   * following the rule it already had: a filed note is read-only whole, so
   * the way to withdraw a remark on one is to bring the note back first.
   */
  it('lets the author take back a remark on a live note, but not on an archived one', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const note = await notes.create({
      userId: org.orgId, html: '<p>Typed in the Workspace</p>',
      createdByAgentId: 'user', createdByUserId: 'user-1',
      updatedByAgentId: 'user', updatedByUserId: 'user-1',
    });
    const mine = newMarginComment('user', '<p>Mine.</p>', 'user-1');
    const theirs = newMarginComment('agent-a', '<p>The agent’s.</p>', 'user-1');
    await notes.addComment(note.id, mine);
    await notes.addComment(note.id, theirs);
    const remove = getRouteHandler(deps, '/api/notes/:number/comments/:commentId', 'delete');

    const filed = createMockResponse();
    await notes.update(note.id, { archivedAt: '2026-09-23T09:00:00.000Z' });
    await remove(mockRequest({
      headers: authHeader(42), params: { number: String(note.number), commentId: mine.id },
    }), filed);
    expect(filed.statusCode).toBe(400);
    expect(String((filed.body as { error: string }).error)).toContain('This note is archived.');
    expect((await notes.get(note.id))!.comments).toHaveLength(2);

    await notes.update(note.id, { archivedAt: undefined });
    const gone = createMockResponse();
    await remove(mockRequest({
      headers: authHeader(42), params: { number: String(note.number), commentId: mine.id },
    }), gone);
    expect(gone.statusCode).toBe(200);
    expect((gone.body as { comments: Array<{ text: string }> }).comments.map((comment) => comment.text))
      .toEqual(['<p>The agent’s.</p>']);
    expect((await notes.get(note.id))!.comments!.map((comment) => comment.id)).toEqual([theirs.id]);

    // The agent's own words stay the agent's, on a note the reader owns.
    const refused = createMockResponse();
    await remove(mockRequest({
      headers: authHeader(42), params: { number: String(note.number), commentId: theirs.id },
    }), refused);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({ error: 'Only your own comments can be deleted.' });
    expect((await notes.get(note.id))!.comments).toHaveLength(1);
  });

  /**
   * Note #638: "Why if a note is created by another account, the buttons UI
   * table looks different".
   *
   * It was not another account. The note was the reader's own, kept by an
   * agent they had since deleted — and with no name left to print, both the
   * card and this route fell back to one sentence about "its owner's agents",
   * which is how a note of your own comes to read as somebody else's. What the
   * screen needs is the other half of the fact: whether any agent of theirs
   * can still rewrite it, which is the rule the agent CLI's editor applies.
   */
  it('says whether the reader’s own agents can still rewrite a note (note #638)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const gone = await notes.create({
      userId: org.orgId, html: '<p>Written by an agent that has since been deleted</p>',
      createdByAgentId: 'agent-gone', updatedByAgentId: 'agent-gone', updatedByUserId: 'user-1',
    });
    const kept = await notes.create({
      userId: org.orgId, html: '<p>Leo keeps this</p>',
      createdByAgentId: 'agent-c', updatedByAgentId: 'agent-c', updatedByUserId: 'user-2',
    });
    const mine = await notes.create({
      userId: org.orgId, html: '<p>Typed in the Workspace</p>',
      createdByAgentId: 'user', createdByUserId: 'user-1',
      updatedByAgentId: 'user', updatedByUserId: 'user-1',
    });

    const read = async (number: number) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/notes/:number', 'get')(
        mockRequest({ headers: authHeader(42), params: { number: String(number) } }), res);
      expect(res.statusCode).toBe(200);
      return (res.body as { note: { yours?: true; agentName?: string; agentsCanEdit?: true } }).note;
    };
    // Still theirs, still nobody to name — and still rewritable, by any agent
    // of theirs, which is the whole difference the card has to draw.
    expect(await read(gone.number)).toMatchObject({ yours: true, agentsCanEdit: true });
    expect((await read(gone.number)).agentName).toBeUndefined();
    // A teammate's agent keeps this one: naming it changes nothing about who
    // may rewrite it.
    expect(await read(kept.number)).toMatchObject({ agentName: 'Leo' });
    expect((await read(kept.number)).agentsCanEdit).toBeUndefined();
    // The reader's own hand: the Workspace edits this one itself, so the
    // question the flag answers never comes up.
    expect((await read(mine.number)).agentsCanEdit).toBeUndefined();

    // And the route says the same thing the card does when a stale page sends
    // the edit anyway.
    const edit = getRouteHandler(deps, '/api/notes/:number', 'put');
    const refused = async (number: number) => {
      const res = createMockResponse();
      await edit(mockRequest({
        headers: authHeader(42), params: { number: String(number) }, body: { text: 'Rewritten' },
      }), res);
      expect(res.statusCode).toBe(403);
      return String((res.body as { error: string }).error);
    };
    const orphan = await refused(gone.number);
    expect(orphan).toContain('no longer in this workplace');
    expect(orphan).toContain('ask any of your agents');
    expect(orphan).not.toContain('owner’s agents');
    expect(await refused(kept.number)).toContain('Another workplace member’s agent wrote this note');
    expect((await notes.get(gone.id))?.html).toContain('has since been deleted');
  });

  it('the workplace shows its whole self whatever room an old link names: one notes list, one queue (note #843)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    // An old room's namespace, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      git: { namespaceId: org.orgId },
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-growth'] },
    });
    const quickNoteStorage = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = quickNoteStorage;
    const gitRepoStorage = new InMemoryGitRepoStorage();
    deps.gitRepoStorage = gitRepoStorage;
    const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
    deps.gitPullRequestStorage = gitPullRequestStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      knowledgeList: async () => ({ pages: [], index: '{"pages":{}}' }),
    } as unknown as GitHostClient;
    const mainRepo = await gitRepoStorage.create({ userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true });
    const roomRepo = await gitRepoStorage.create({ userId: 'ns-growth', orgId: org.orgId, name: 'site', createdByAgentId: 'agent-a', sizeBytes: 0, protectDefaultBranch: true });
    await gitPullRequestStorage.create({
      userId: org.orgId, repoId: mainRepo.id, title: 'Repair API', body: '',
      sourceBranch: 'repair', targetBranch: 'main', createdByAgentId: 'agent-a', status: 'open',
      headSha: 'a'.repeat(40), commitSubjects: ['Repair API'], diffStat: { files: 1, insertions: 2, deletions: 1 },
    } as never);
    // Recorded in Growth before rooms went, at Growth's own namespace.
    const roomPr = await gitPullRequestStorage.create({
      userId: 'ns-growth', repoId: roomRepo.id, roomNamespaceId: 'ns-growth', title: 'Home page drawing', body: '',
      sourceBranch: 'work', targetBranch: 'main', createdByAgentId: 'agent-a', status: 'open',
      headSha: 'b'.repeat(40), commitSubjects: ['Drawing'], diffStat: { files: 1, insertions: 1, deletions: 0 },
    } as never);

    // A note written with or without an old room in the address lands with
    // the workplace's.
    for (const [text, query] of [['from home', {}], ['from an old link', { room: 'room-growth' }]] as const) {
      const made = createMockResponse();
      await getRouteHandler(deps, '/api/notes', 'post')(mockRequest({ headers: authHeader(42), query, body: { text } }), made);
      expect(made.statusCode).toBe(200);
    }
    expect((await quickNoteStorage.listByUser(org.orgId)).map((doc) => doc.number).sort()).toEqual([1, 2]);
    expect(await quickNoteStorage.listByUser('ns-growth')).toEqual([]);

    for (const query of [{}, { room: 'room-growth' }] as Array<Record<string, string>>) {
      const state = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42), query }), state);
      expect(state.statusCode).toBe(200);
      const body = state.body as Record<string, unknown> & {
        repos: Array<{ name: string }>; notes: Array<{ number: number }>; prs: Array<{ title: string }>;
      };
      // No room chips, no viewed room: the state is the workplace's.
      expect(body).not.toHaveProperty('rooms');
      expect(body).not.toHaveProperty('room');
      expect(body.repos.map((repo) => repo.name).sort()).toEqual(['api', 'site']);
      expect(body.notes.map((note) => note.number).sort()).toEqual([1, 2]);
      expect(body.prs.map((pr) => pr.title).sort()).toEqual(['Home page drawing', 'Repair API']);
    }

    // The agents picker's queue (note #721) is the same whole workplace.
    const everywhere = createMockResponse();
    await getRouteHandler(deps, '/api/decisions', 'get')(mockRequest({ headers: authHeader(42) }), everywhere);
    expect(everywhere.statusCode).toBe(200);
    expect((everywhere.body as { prs: Array<{ title: string }> }).prs.map((pr) => pr.title).sort())
      .toEqual(['Home page drawing', 'Repair API']);

    // The card sent to chat carries the proposal id and opens as it is, with
    // no room to file its margin under.
    const deepLink = createMockResponse();
    await getRouteHandler(deps, '/api/prs/:id', 'get')(
      mockRequest({ headers: authHeader(42), params: { id: roomPr.id } }), deepLink);
    expect(deepLink.statusCode).toBe(200);
    expect((deepLink.body as { pr: Record<string, unknown> }).pr).toMatchObject({ title: 'Home page drawing' });
    expect((deepLink.body as { pr: Record<string, unknown> }).pr).not.toHaveProperty('commentRoomId');
  });

  it('carries the org summary on the state payload, and null for an account in none', async () => {
    const { deps, org } = await buildOrgDeps();
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { org: unknown }).org).toEqual({
      orgId: expect.any(String), name: 'Acme Trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'],
      // The Workspace Agent's face rides the state (note #627), the same URL
      // api/recap resolves, so the gate and Home paint it with the team.
      workspaceAgentAvatarUrl: `/workspace/avatars/${org.workspaceAgentAvatarSlug}`,
      // A live subscription is all it needs: with no cloud of its own it is
      // hosted on ours (note #664), so nothing else locks it.
      // Named on the home row (note #82); this fixture's seat has no reading
      // yet, so it rides as a name alone rather than a percent of nothing.
      // Home opens the seat that was tapped and marks the primary assignment
      // on that item, so each entry carries its identity and item-level state.
      seatUsage: [{ seatId: expect.any(String), provider: 'claude', label: 'max-1', selected: true, windows: [], updatedAt: expect.any(String) }],
    });
    expect((res.body as { canCreateOrg: boolean }).canCreateOrg).toBe(true);
    // What the picker's rows say about each workplace (note #196): its people,
    // and the VIEWER's own agents standing there. Dana is the second member
    // and owns two agents of her own; neither is Owner's to count.
    expect((res.body as { organizations: unknown }).organizations).toEqual([
      {
        orgId: expect.any(String), name: 'Acme Trading', role: 'admin', active: true,
        members: 2, agents: 2,
      },
    ]);

    const { deps: bare } = await buildDeps();
    bare.orgStorage = new InMemoryOrgStorage();
    const none = createMockResponse();
    await getRouteHandler(bare, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), none);
    expect((none.body as { org: unknown }).org).toBeNull();
    // No membership anywhere and the layer is wired: the founder door shows.
    expect((none.body as { canCreateOrg: boolean }).canCreateOrg).toBe(true);

    // Layer not wired: org is null but the door must NOT show — the create
    // would only 503.
    const { deps: unwired } = await buildDeps();
    const off = createMockResponse();
    await getRouteHandler(unwired, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), off);
    expect((off.body as { org: unknown }).org).toBeNull();
    expect((off.body as { canCreateOrg: boolean }).canCreateOrg).toBe(false);
  });

  it('never locks the Workspace behind a missing subscription: the plan is asked for inside the Chief of Staff’s chat (note #726)', async () => {
    const { deps, orgStorage, org, adminSeat } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' },
    });

    const complete = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), complete);
    expect((complete.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');

    // Until note #726 a workplace with no live seat answered `setupRequired`
    // and the gate stood in front of the whole shell. The seat's absence is
    // still said — `seatProviders` is what the New-agent chooser and the
    // chat's sign-in card read — but nothing is locked.
    await orgStorage.updateSeat(adminSeat.seatId, { status: 'disabled' });
    const missingSubscription = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(
      mockRequest({ headers: authHeader(42) }),
      missingSubscription,
    );
    const unseated = (missingSubscription.body as { org: Record<string, unknown> }).org;
    expect(unseated).not.toHaveProperty('setupRequired');
    expect(unseated.seatProviders).toEqual([]);
    // A record still carrying the old stored marker is cleared on the read,
    // and never answers with it.
    await orgStorage.updateOrg(org.orgId, { setupRequired: true });
    const stale = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), stale);
    expect((stale.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');
    expect((await orgStorage.getOrg(org.orgId))?.setupRequired).toBe(false);
  });

  it('opens an already-joined workplace with the reader’s existing subscription on its first read', async () => {
    const { deps, orgStorage, adminSeat } = await buildOrgDeps();
    const joined = await orgStorage.createOrg({ name: 'Other Team', createdByUserId: 'user-2' });
    await orgStorage.updateOrg(joined.orgId, {
      fly: { orgSlug: 'other-team', tokenSecretName: 'FLY_ORG_TOKEN' },
    });
    await orgStorage.addMember({ orgId: joined.orgId, userId: 'user-1', role: 'member' });
    // This is the live note #602 shape after the approval happened on the old
    // release: the target is already active, but has no seat assignment yet.
    await orgStorage.setActiveOrg('user-1', joined.orgId);

    const first = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), first);
    expect(first.body).toMatchObject({
      org: { orgId: joined.orgId, seatProviders: ['claude'] },
    });
    expect((first.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');
    expect(await orgStorage.isSeatAssigned(joined.orgId, 'user-1', adminSeat.seatId)).toBe(true);
    expect((await orgStorage.getMembership(joined.orgId, 'user-1'))?.inheritedSeatsAt).toBeTruthy();

    await orgStorage.unassignSeat(joined.orgId, 'user-1', adminSeat.seatId);
    const later = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), later);
    expect((later.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual([]);
    expect(await orgStorage.isSeatAssigned(joined.orgId, 'user-1', adminSeat.seatId)).toBe(false);
  });

  it('persists an active-org switch, carries the reader’s subscription once, and shows only that workplace’s agents', async () => {
    const { deps, userStorage, orgStorage, org: first, adminSeat } = await buildOrgDeps();
    const second = await orgStorage.createOrg({ name: 'Side Venture', createdByUserId: 'user-1' });
    await orgStorage.updateOrg(second.orgId, { git: { namespaceId: second.orgId } });
    await orgStorage.addMember({ orgId: second.orgId, userId: 'user-1', role: 'admin' });
    const profile = (await userStorage.getProfile('user-1'))!;
    await userStorage.updateProfile('user-1', {
      telegram: {
        ...profile.telegram,
        agents: {
          ...profile.telegram!.agents,
          'agent-side': {
            id: 'agent-side', name: 'Sidekick', cli: 'claude', orgId: second.orgId,
            agentbuiltTokenHash: 'x', botStatus: 'active', createdAt: '2026-08-26T10:00:00Z',
          } as never,
        },
      },
    });

    const switchRes = createMockResponse();
    await getRouteHandler(deps, '/api/org/active', 'post')(
      mockRequest({ headers: authHeader(42), body: { orgId: second.orgId } }), switchRes);
    expect(switchRes.statusCode).toBe(200);
    expect(await orgStorage.isSeatAssigned(second.orgId, 'user-1', adminSeat.seatId)).toBe(true);
    expect((await orgStorage.getMembership(second.orgId, 'user-1'))?.inheritedSeatsAt).toBeTruthy();

    const sideState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), sideState);
    const sideBody = sideState.body as {
      org: { orgId: string; seatProviders: string[] };
      organizations: Array<{ orgId: string; name: string; active: boolean; members: number; agents: number }>;
      agents: Array<{ id: string }>;
    };
    expect(sideBody.org.orgId).toBe(second.orgId);
    expect(sideBody.org.seatProviders).toEqual(['claude']);
    expect(sideBody.agents.map((agent) => agent.id)).toEqual(['agent-side']);
    expect(sideBody.organizations.find((entry) => entry.orgId === second.orgId)?.active).toBe(true);
    // The agent list is filtered to the active workplace; the picker's rows
    // are not, and each says what its own workplace holds (note #196).
    expect(sideBody.organizations.map((entry) => [entry.name, entry.members, entry.agents])).toEqual(
      expect.arrayContaining([['Acme Trading', 2, 2], ['Side Venture', 1, 1]]),
    );

    // The first-entry welcome is not a policy loop. Removing this workplace's
    // link is still a durable choice, even though the underlying sign-in stays
    // in the person's private library.
    const unassign = createMockResponse();
    await getRouteHandler(deps, '/api/org/seats/:seatId', 'delete')(
      mockRequest({ headers: authHeader(42), params: { seatId: adminSeat.seatId } }), unassign);
    expect(unassign.statusCode).toBe(200);
    const afterUnassign = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), afterUnassign);
    expect(await orgStorage.isSeatAssigned(second.orgId, 'user-1', adminSeat.seatId)).toBe(false);
    expect((afterUnassign.body as { org: { seatProviders: string[] } }).org.seatProviders).toEqual([]);

    const back = createMockResponse();
    await getRouteHandler(deps, '/api/org/active', 'post')(
      mockRequest({ headers: authHeader(42), body: { orgId: first.orgId } }), back);
    const firstState = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), firstState);
    const firstAgents = (firstState.body as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id);
    expect(firstAgents).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    expect(firstAgents).not.toContain('agent-side');
  });

  it('counts an unstamped agent for the picker in the workplace it actually appears in', async () => {
    // The count on a picker row is a promise about what the reader will find
    // after the switch, so it must resolve an agent's workplace by the same
    // rule the fleet list does — including the legacy fallback for an agent
    // that predates multi-org and carries no orgId of its own.
    const { deps } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    deps.orgStorage = orgStorage;
    const historical = await orgStorage.createOrg({ name: 'Historical', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: historical.orgId, userId: 'user-1', role: 'admin' });
    const newer = await orgStorage.createOrg({ name: 'Newer', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: newer.orgId, userId: 'user-1', role: 'admin' });

    const readState = async () => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
      return res.body as {
        organizations: Array<{ orgId: string; agents: number; members: number }>;
        agents: Array<{ id: string }>;
      };
    };
    const switchTo = async (orgId: string) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/active', 'post')(
        mockRequest({ headers: authHeader(42), body: { orgId } }), res);
      expect(res.statusCode).toBe(200);
    };

    const first = await readState();
    // Both unstamped agents belong to one workplace, and every workplace this
    // account is in is one person.
    expect(first.organizations.map((entry) => entry.agents).sort()).toEqual([0, 2]);
    expect(first.organizations.map((entry) => entry.members)).toEqual([1, 1]);
    const holder = first.organizations.find((entry) => entry.agents === 2)!.orgId;
    const empty = first.organizations.find((entry) => entry.agents === 0)!.orgId;

    await switchTo(holder);
    const inside = await readState();
    expect(inside.agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    expect(inside.organizations.find((entry) => entry.orgId === holder)?.agents).toBe(2);

    // And the row for the other one keeps saying nothing is there — which is
    // exactly what the reader finds after that switch.
    await switchTo(empty);
    const other = await readState();
    expect(other.agents).toEqual([]);
    expect(other.organizations.find((entry) => entry.orgId === empty)?.agents).toBe(0);
    expect(other.organizations.find((entry) => entry.orgId === holder)?.agents).toBe(2);
  });

  it('pins agent creation to the authenticated workplace context', async () => {
    const { deps, orgStorage, org: first } = await buildOrgDeps();
    const second = await orgStorage.createOrg({ name: 'Second', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: second.orgId, userId: 'user-1', role: 'admin' });
    const createAgent = vi.fn().mockResolvedValue({ ok: true });
    deps.agentLifecycle = {
      createAgent,
      deleteAgent: vi.fn().mockResolvedValue({ ok: true, name: 'x', machine: 'none', remaining: 0 }),
    } as never;

    await getRouteHandler(deps, '/api/agents', 'post')(
      mockRequest({ headers: authHeader(42), body: { cli: 'claude' } }),
      createMockResponse(),
    );
    expect(createAgent).toHaveBeenLastCalledWith('user-1', 'claude', first.orgId);

    await orgStorage.setActiveOrg('user-1', second.orgId);
    await getRouteHandler(deps, '/api/agents', 'post')(
      mockRequest({ headers: authHeader(42), body: { cli: 'codex' } }),
      createMockResponse(),
    );
    expect(createAgent).toHaveBeenLastCalledWith('user-1', 'codex', second.orgId);
  });

  /**
   * Note #640: "why, if knowledge items were created by not my own agent but
   * by my teammates' agents, do I not see avatars?"
   *
   * Because this one row resolved its writer in the READER's own fleet, where
   * every teammate's agent misses — while a note's row, a site's and a
   * margin's remark have all read the workplace-wide directory since note
   * #57. One shelf holds every room's pages (note #566), so on a teammate's
   * screen most rows are somebody else's agent's: the card came up half
   * signed and half anonymous, which reads as the pages being different
   * rather than the reader being.
   */
  it('names a teammate\u2019s agent on a knowledge page (note #640)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    deps.knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      knowledgeList: async () => ({
        pages: [
          { name: 'mine', sha: 'a1', sizeBytes: 10 },
          { name: 'theirs', sha: 'b2', sizeBytes: 10 },
          { name: 'gone', sha: 'c3', sizeBytes: 10 },
        ],
        index: JSON.stringify({
          pages: {
            mine: {
              title: 'Mine', description: 'Landed by an agent of the reader\u2019s.',
              updatedAt: '2026-09-03T10:00:00.000Z', bytes: 10, updatedByAgentId: 'agent-a',
            },
            theirs: {
              title: 'Theirs', description: 'Landed by a teammate\u2019s agent.',
              updatedAt: '2026-09-02T10:00:00.000Z', bytes: 10, updatedByAgentId: 'agent-c',
            },
            gone: {
              title: 'Gone', description: 'Landed by an agent no fleet has any more.',
              updatedAt: '2026-09-01T10:00:00.000Z', bytes: 10, updatedByAgentId: 'agent-zz',
            },
          },
        }),
      }),
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const knowledge = (res.body as {
      knowledge: Array<{ name: string; agentName?: string; agentAvatarUrl?: string }>;
    }).knowledge;
    const row = (name: string) => knowledge.find((page) => page.name === name)!;
    // The reader\u2019s own agent, as before.
    expect(row('mine')).toMatchObject({ agentName: 'Ben', agentAvatarUrl: '/workspace/avatars/ben' });
    // Dana\u2019s agent, named and faced the same way \u2014 the row says who wrote
    // the page, which is the whole of what it is for.
    expect(row('theirs')).toMatchObject({ agentName: 'Leo', agentAvatarUrl: '/workspace/avatars/leo' });
    // And an agent nobody in the workplace has any more still leaves the row
    // as it was: an id on screen says less than silence.
    expect(row('gone').agentName).toBeUndefined();
    expect(row('gone').agentAvatarUrl).toBeUndefined();
  });


  /**
   * Note #640, the owner: "when user presses on not own agent's avatar, it
   * should open agent's detail page."
   *
   * Every face in a workplace is a door now, and most of them are somebody
   * else's agent — so there has to be something behind one. This is that
   * something: the facts the workplace can already see, and no controls,
   * because what an agent is asked to do belongs to the person driving it
   * (note #346).
   */
  it('opens a teammate\u2019s agent as a read-only card (note #640)', async () => {
    const { deps, userStorage, org } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-2', 'agent-c', {
      connectedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-20T09:00:00.000Z',
      recap: { text: 'Rewrote the landing page copy', at: '2026-09-20T09:05:00.000Z' },
    } as never);
    const card = async (id: string, who = 42) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/agents/:id/card', 'get')(
        mockRequest({ headers: authHeader(who), params: { id } }), res);
      return res;
    };

    const theirs = await card('agent-c');
    expect(theirs.statusCode).toBe(200);
    const body = theirs.body as {
      agent: Record<string, unknown>;
      owner: Record<string, unknown>;
      yours?: true;
    };
    expect(body.agent).toMatchObject({
      id: 'agent-c',
      name: 'Leo',
      cli: 'codex',
      avatarUrl: '/workspace/avatars/leo',
      status: 'ready',
      recap: 'Rewrote the landing page copy',
      lastActiveAt: '2026-09-20T09:00:00.000Z',
    });
    // An agent is the workplace's: the card names no room (note #923).
    expect(body.agent).not.toHaveProperty('roomId');
    expect(body.agent).not.toHaveProperty('roomName');
    // Who to ask about it, and the door to their member page.
    expect(body.owner.userId).toBe('user-2');
    expect(typeof body.owner.name).toBe('string');
    expect(body.yours).toBeUndefined();
    // And NOT a single control's worth of data: no machine, no version, no
    // seat, no chat. A read-only page cannot leak what it never carries.
    for (const absent of ['machine', 'machineSize', 'version', 'seatId', 'context', 'lastReply']) {
      expect(body.agent[absent]).toBeUndefined();
    }

    // The reader's own is answered too, flagged — the screen sends them to
    // its control room rather than drawing a read-only copy of their own.
    const mine = await card('agent-a');
    expect(mine.statusCode).toBe(200);
    expect((mine.body as { yours?: true }).yours).toBe(true);

    // A Workspace helper is not an agent anyone has.
    expect((await card('agent-d')).statusCode).toBe(404);
    // Nor is one nobody in this workplace owns.
    expect((await card('agent-nobody')).statusCode).toBe(404);

    // A member's private Workspace Agent is nobody else's to open — the one
    // agent in the workplace that answers to one person only.
    await userStorage.updateProfile('user-2', {
      telegram: {
        ...(await userStorage.getProfile('user-2'))!.telegram,
        agents: {
          ...(await userStorage.getProfile('user-2'))!.telegram!.agents,
          'workspace-2': {
            id: 'workspace-2', name: 'Workspace Agent', cli: 'claude', orgId: org.orgId,
            purpose: 'workspace-recap', botStatus: 'active',
          },
        },
      } as never,
    });
    expect((await card('workspace-2')).statusCode).toBe(404);
  });

  /**
   * The other half of note #640: the id that MAKES a face a door, on every
   * row that draws one. It used to ride along only for the reader's own
   * agent, because a teammate's had nothing to open.
   */
  it('marks a teammate\u2019s face as a door on notes, margins and pages (note #640)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const kept = await notes.create({
      userId: org.orgId, html: '<p>Leo keeps this</p>',
      createdByAgentId: 'agent-c', updatedByAgentId: 'agent-c', updatedByUserId: 'user-2',
    });
    await notes.addComment(kept.id, newMarginComment('agent-c', '<p>Still true.</p>'));
    deps.knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      knowledgeList: async () => ({
        pages: [{ name: 'theirs', sha: 'b2', sizeBytes: 10 }],
        index: JSON.stringify({
          pages: {
            theirs: {
              title: 'Theirs', description: 'Landed by a teammate\u2019s agent.',
              updatedAt: '2026-09-02T10:00:00.000Z', bytes: 10, updatedByAgentId: 'agent-c',
            },
          },
        }),
      }),
    } as unknown as GitHostClient;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const body = state.body as {
      knowledge: Array<{ name: string; agentId?: string }>;
      notes: Array<{ number: number; agentId?: string }>;
    };
    expect(body.knowledge[0]).toMatchObject({ name: 'theirs', agentId: 'agent-c' });
    expect(body.notes[0]).toMatchObject({ agentId: 'agent-c' });

    // And the note's own screen, where the margin is read.
    const note = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number', 'get')(
      mockRequest({ headers: authHeader(42), params: { number: String(kept.number) } }), note);
    const detail = note.body as {
      note: { agentId?: string; comments?: Array<{ agentId?: string; agentName?: string }> };
    };
    expect(detail.note.agentId).toBe('agent-c');
    expect(detail.note.comments?.[0]).toMatchObject({ agentName: 'Leo', agentId: 'agent-c' });
  });

  /**
   * Note #705, the owner: "how is it possible that comment was created by
   * Adam B? Is it me? I didn't create the comment, agent created." The agent
   * that wrote it had been deleted, and its driver's stamp alone signed the
   * remark. Now a deleted agent's remark says an agent wrote it — by the name
   * the work ledger last credited it under, with that name's face — and the
   * driver stays beside it, never in its place.
   */
  it('signs a deleted agent’s remark as that agent, never as its person (note #705)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const ledger = new InMemoryAgentWorkLedger();
    ledger.credit({ userId: 'user-1', agentId: 'agent-willow', orgId: org.orgId, agentName: 'Willow', month: '2026-09', ms: 60_000 });
    deps.agentWorkLedger = ledger;
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const note = await notes.create({
      userId: org.orgId, html: '<p>Redirect the apex</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a', updatedByUserId: 'user-1',
    });
    await notes.addComment(note.id, newMarginComment('agent-a', '<p>Looking now.</p>', 'user-1'));
    // Deleted before the ledger began: nothing remembers its name.
    await notes.addComment(note.id, newMarginComment('agent-forgotten', '<p>An older remark.</p>', 'user-1'));
    await notes.addComment(note.id, newMarginComment('agent-willow', '<p>Done and live. — Willow</p>', 'user-1'));

    const opened = createMockResponse();
    await getRouteHandler(deps, '/api/notes/:number', 'get')(
      mockRequest({ headers: authHeader(42), params: { number: String(note.number) } }), opened);
    const comments = (opened.body as { note: { comments: Array<Record<string, unknown>> } }).note.comments;
    // A live agent's remark is exactly what it was.
    expect(comments[0]).toMatchObject({ agentName: 'Ben', agentId: 'agent-a', userName: 'Owner' });
    expect(comments[0]).not.toHaveProperty('formerAgent');
    // The forgotten one is still an AGENT's: flagged, unnamed, its person
    // beside it — and no person's face or door on it.
    expect(comments[1]).toMatchObject({ formerAgent: true, userName: 'Owner' });
    for (const field of ['agentName', 'agentAvatarUrl', 'agentId', 'byPerson', 'authorUserId']) {
      expect(comments[1]).not.toHaveProperty(field);
    }
    // Willow, by name and face, with nothing that points at an agent gone.
    expect(comments[2]).toMatchObject({
      formerAgent: true, agentName: 'Willow', agentAvatarUrl: '/workspace/avatars/willow', userName: 'Owner',
    });
    for (const field of ['agentId', 'agentRuntime', 'byPerson', 'authorUserId']) {
      expect(comments[2]).not.toHaveProperty(field);
    }

    // The note list's row previews the newest remark, signed the same way.
    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const row = (state.body as { notes: Array<{ number: number; lastComment?: Record<string, unknown> }> }).notes
      .find((n) => n.number === note.number);
    expect(row?.lastComment).toMatchObject({ agentName: 'Willow', agentAvatarUrl: '/workspace/avatars/willow' });
    expect(row?.lastComment).not.toHaveProperty('byPerson');
  });

  /**
   * 2026-09-23, the owner: "in a workspace human's agents work. Those agents
   * should not be hidden from other humans … Except agents tab in rooms …
   * But even there, we should make some compact UI showing avatars of other
   * humans' agents existing and working in the room."
   *
   * The state carries the OTHER members' agents for that strip — the whole
   * workplace's, as the reader's own fleet travels — and nothing that is not
   * an agent of THIS workplace: not a Workspace helper, not a member's
   * private Workspace Agent, not an agent they keep in another workplace.
   * The live tick then says which of them are mid-turn.
   */
  it('sends the workplace the agents its teammates drive, and the tick says which are working (2026-09-23)', async () => {
    const { deps, userStorage, org } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-2', 'agent-c', {
      connectedAt: '2026-09-01T09:00:00.000Z', lastActivityAt: '2026-09-20T09:00:00.000Z',
    } as never);
    const dana = (await userStorage.getProfile('user-2'))!;
    await userStorage.updateProfile('user-2', {
      telegram: {
        ...dana.telegram,
        agents: {
          ...dana.telegram!.agents,
          'agent-elsewhere': {
            id: 'agent-elsewhere', name: 'Rex', cli: 'claude', orgId: 'another-workplace',
            botStatus: 'active',
          },
          'workspace-2': {
            id: 'workspace-2', name: 'Workspace Agent', cli: 'claude', orgId: org.orgId,
            purpose: 'workspace-recap', botStatus: 'active',
          },
        },
      } as never,
    });
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (userId: string, agentId: string) => userId === 'user-2' && agentId === 'agent-c',
    } as never;

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const body = state.body as { teamAgents: unknown[]; agents: Array<{ id: string }> };
    // No room on the row: every agent is the workplace's (note #923).
    expect(body.teamAgents).toEqual([{
      id: 'agent-c',
      name: 'Leo',
      avatarUrl: '/workspace/avatars/leo',
      status: 'ready',
      working: true,
      lastActiveAt: '2026-09-20T09:00:00.000Z',
      owner: { userId: 'user-2', name: 'Dana Ives' },
    }]);
    // The reader's own fleet is where it always was, and not in this list.
    expect(body.agents.map((row) => row.id)).not.toContain('agent-c');

    const live = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), live);
    expect((live.body as { teamWorking?: string[] }).teamWorking).toEqual(['agent-c']);

    // Dana reads the other half: the owner's agents, and none of her own.
    const theirs = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), theirs);
    expect((theirs.body as { teamAgents: Array<{ id: string; owner: { name?: string } }> }).teamAgents
      .map((row) => [row.id, row.owner.name])).toEqual([['agent-a', 'Owner'], ['agent-b', 'Owner']]);
  });

  /**
   * The live tick used to build its own, smaller "Working by …" — no face,
   * and a door only on the reader's own agent — so every five seconds it
   * repainted a teammate's claim without the picture or the door the full
   * read had just drawn (note #640's door, undone by the tick).
   */
  it('keeps a teammate’s face and door on a note claim through the live tick (2026-09-23)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const notes = new InMemoryQuickNoteStorage();
    deps.quickNoteStorage = notes;
    const note = await notes.create({
      userId: org.orgId, html: '<p>Fix the footer</p>', createdByAgentId: 'user', updatedByAgentId: 'user',
    });
    await notes.claim(note.id, { agentId: 'agent-c', userId: 'user-2', agentName: 'Leo' }, new Date());

    const state = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
    const row = (state.body as { notes: Array<{ id: string; work?: unknown }> }).notes.find((n) => n.id === note.id)!;
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/agents/live', 'get')(mockRequest({ headers: authHeader(42) }), live);
    const claim = (live.body as { noteClaims: Array<{ id: string; work: unknown }> }).noteClaims
      .find((c) => c.id === note.id)!;
    expect(claim.work).toMatchObject({ agentName: 'Leo', agentAvatarUrl: '/workspace/avatars/leo', agentId: 'agent-c' });
    // Byte for byte what the row already says, so the page repaints nothing.
    expect(JSON.stringify(claim.work)).toBe(JSON.stringify(row.work));
  });

  /**
   * Note #346 took the list of a member's agents off their page, with its
   * latest-work lines; the owner's rule of 2026-09-23 put back which agents,
   * by name and face; and on 2026-10-28 Adam asked to see "what their agents
   * cooking" — whether each is working, and its recap line. (Where each
   * stood went with the rooms, note #923.)
   */
  it('names each member’s agents, whether they work, and their recap lines (2026-10-28)', async () => {
    const { deps, userStorage } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-2', 'agent-c', {
      recap: { text: 'Shipping the footer fix; checks running.', at: '2026-10-28T10:00:00.000Z' },
    } as never);
    deps.agentLifecycle = {
      ...(deps.agentLifecycle ?? {}),
      isAgentWorking: (userId: string, agentId: string) => userId === 'user-2' && agentId === 'agent-c',
    } as never;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const members = (res.body as { org: { members: Array<{ agents: number; agentFaces?: unknown[] }> } }).org.members;
    expect(members[1]).toMatchObject({ agents: 1 });
    expect(members[1]!.agentFaces).toEqual([{
      id: 'agent-c', name: 'Leo', avatarUrl: '/workspace/avatars/leo',
      working: true, recap: 'Shipping the footer fix; checks running.', recapAt: '2026-10-28T10:00:00.000Z',
    }]);

    // The tick carries the two facts that move, for every agent, and the
    // Workspace helper (agent-d) is nobody's agent here either.
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/org/people/live', 'get')(mockRequest({ headers: authHeader(42) }), live);
    const ticked = (live.body as { people: Array<{ userId: string; agents?: unknown[] }> }).people;
    expect(ticked.find((person) => person.userId === 'user-2')!.agents).toEqual([{
      id: 'agent-c', working: true, recap: 'Shipping the footer fix; checks running.', recapAt: '2026-10-28T10:00:00.000Z',
    }]);
    expect(ticked.find((person) => person.userId === 'user-1')!.agents!.map((agent) => (agent as { id: string }).id))
      .toEqual(['agent-a', 'agent-b']);
    // Never the chat's words: nothing of the conversation rides either answer.
    expect(JSON.stringify(live.body)).not.toMatch(/lastReply|messages|activity/);
  });

  it('keeps another workplace’s agents off the people tick (2026-10-28)', async () => {
    const { deps, userStorage, org } = await buildOrgDeps();
    await userStorage.updateAgentFields('user-2', 'agent-c', {
      orgId: 'another-workplace', recap: { text: 'Elsewhere work', at: '2026-10-28T10:00:00.000Z' },
    } as never);
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/org/people/live', 'get')(mockRequest({ headers: authHeader(42), query: { org: org.orgId } }), live);
    expect(JSON.stringify(live.body)).not.toContain('Elsewhere work');
    expect((live.body as { people: Array<{ userId: string; agents?: unknown[] }> }).people
      .find((person) => person.userId === 'user-2')!.agents).toEqual([]);
  });

  /**
   * Note #925 (Adam, 31 Oct 2026): "people see each other's contribution
   * made by their agent". Every card carries the person's week in THIS
   * workplace — hours, changes merged, tokens written per provider, the
   * latest merged title — on the full read and on the tick alike, and the
   * member's screen reads the whole of it. Another workplace's agents and
   * repositories never count, and nobody outside the workplace can ask.
   */
  it('gives every person’s card their week here, and their screen the whole contribution (note #925)', async () => {
    const { deps, orgStorage, org, userStorage } = await buildOrgDeps();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    // Dana's second agent works for another workplace of hers.
    await userStorage.updateProfile('user-2', {
      telegram: {
        ...(await userStorage.getProfile('user-2'))!.telegram!,
        agents: {
          ...(await userStorage.getProfile('user-2'))!.telegram!.agents,
          'agent-e': { id: 'agent-e', name: 'Elsewhere', cli: 'claude', orgId: 'another-workplace', agentbuiltTokenHash: 'y' } as never,
        },
      } as never,
    });
    const work = new InMemoryAgentWorkLedger();
    const tokens = new InMemoryAgentTokenLedger();
    const prs = new InMemoryGitPullRequestStorage();
    const repos = new InMemoryGitRepoStorage();
    deps.agentWorkLedger = work;
    deps.agentTokenLedger = tokens;
    deps.gitPullRequestStorage = prs;
    deps.gitRepoStorage = repos;
    const now = Date.now();
    const today = tokenDayKey(now);
    const monday = leaderboardWeekStart(now);
    const lastWeek = leaderboardDayAt(monday, -3);
    const credit = (agentId: string, orgId: string, day: string, ms: number) => work.credit({
      userId: 'user-2', agentId, orgId, agentName: agentId === 'agent-c' ? 'Leo' : 'Elsewhere', month: day.slice(0, 7), day, ms,
    });
    credit('agent-c', org.orgId, today, 2 * 3_600_000);
    credit('agent-c', org.orgId, lastWeek, 3_600_000);
    credit('agent-e', 'another-workplace', today, 9 * 3_600_000);
    const wrote = (agentId: string, orgId: string, day: string, provider: 'claude' | 'codex', output: number) => tokens.credit({
      userId: 'user-2', agentId, orgId, agentName: 'x', day, provider, model: 'm', input: 5, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    });
    wrote('agent-c', org.orgId, today, 'codex', 41_000);
    wrote('agent-c', org.orgId, lastWeek, 'codex', 1_000);
    wrote('agent-e', 'another-workplace', today, 'claude', 900_000);
    const shop = await repos.create({
      userId: org.orgId, orgId: org.orgId, name: 'shop', createdByAgentId: 'agent-c',
      defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
    });
    const merge = (title: string, decidedAt: string, namespace = org.orgId, createdByAgentId = 'agent-c') => prs.create({
      repoId: shop.id, userId: namespace, title, body: 'B', sourceBranch: 'f', targetBranch: 'main',
      headSha: 'h', baseSha: 'g', diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['S'],
      createdByAgentId, createdByUserId: 'user-2', status: 'merged', decidedAt,
    } as never);
    // Inside this week even when the suite runs in Monday's first hour.
    await merge('Footer links fixed', new Date(Math.max(now - 3_600_000, Date.parse(`${monday}T00:00:00.000Z`))).toISOString());
    const latest = await merge('Live van map with ETAs on the dispatcher screen', new Date(now).toISOString());
    await merge('Old checkout copy', `${lastWeek}T12:00:00.000Z`);
    await merge('Elsewhere change', new Date(now).toISOString(), 'another-namespace', 'agent-e');

    const people = createMockResponse();
    await getRouteHandler(deps, '/api/org/people', 'get')(mockRequest({ headers: authHeader(42) }), people);
    const rows = (people.body as WorkspacePeopleAnswer).people;
    const dana = rows.find((row) => row.userId === 'user-2')!;
    expect(dana.contribution).toEqual({
      week: { workingMs: 2 * 3_600_000, merged: 2, tokens: { codex: 41_000 } },
      latest: {
        id: latest.id, title: 'Live van map with ETAs on the dispatcher screen', at: expect.any(String),
        number: latest.number, repo: 'shop', agentName: 'Leo',
      },
    });
    // Zero is said, never left out: the owner's agents did nothing here.
    expect(rows.find((row) => row.userId === 'user-1')!.contribution).toEqual({ week: { workingMs: 0, merged: 0, tokens: {} } });
    expect(JSON.stringify(people.body)).not.toMatch(/Elsewhere change|900000/);

    // The tick says the same, so the card moves without a reload.
    const live = createMockResponse();
    await getRouteHandler(deps, '/api/org/people/live', 'get')(mockRequest({ headers: authHeader(42) }), live);
    expect((live.body as WorkspacePeopleLiveAnswer).people.find((row) => row.userId === 'user-2')!.contribution)
      .toEqual(dana.contribution);

    // Her screen: this week, all time, and this week's changes newest first.
    const screen = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId/contribution', 'get')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-2' } }), screen,
    );
    const answer = screen.body as WorkspaceMemberContributionAnswer;
    expect(answer).toMatchObject({
      weekStart: monday,
      tokensFrom: LEADERBOARD_DAYS_FROM,
      week: { workingMs: 2 * 3_600_000, merged: 2, tokens: { codex: 41_000 } },
      allTime: { workingMs: 3 * 3_600_000, merged: 3, tokens: { codex: 42_000 } },
    });
    expect(answer.merged.map((change) => change.title))
      .toEqual(['Live van map with ETAs on the dispatcher screen', 'Footer links fixed']);

    // Somebody who is not in the workplace is not there to read.
    const stranger = createMockResponse();
    await getRouteHandler(deps, '/api/org/members/:userId/contribution', 'get')(
      mockRequest({ headers: authHeader(42), params: { userId: 'user-9' } }), stranger,
    );
    expect(stranger.statusCode).toBe(404);
  });

  /**
   * A teammate's agent on a site: who last deployed it, named and faced like
   * the agent that first did (it was "A teammate’s agent"), and whose agent
   * asked to take it down — the person the request waits on.
   */
  it('names a teammate’s agent as a site’s last deployer and as the one who asked (2026-09-23)', async () => {
    const { deps, org } = await buildOrgDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    await deploymentStorage.create({
      userId: 'user-1', orgId: org.orgId, agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
      lastDeployAt: '2026-09-18T10:00:00.000Z',
      lastDeployBy: { agentId: 'agent-c', userId: 'user-2', agentName: 'Leo' },
      deleteAsk: { byAgentId: 'agent-c', at: '2026-09-19T10:00:00.000Z' },
    });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), res);
    const shop = (res.body as { sites: Array<Record<string, unknown>> }).sites.find((site) => site.name === 'shop')!;
    // By name alone: there is no room to say it stood in (note #923).
    expect(shop.lastDeployedBy).toBe('Leo');
    expect(shop.lastDeployer).toEqual({
      agentName: 'Leo', agentAvatarUrl: '/workspace/avatars/leo', agentId: 'agent-c',
    });
    expect(shop.deleteAsk).toEqual({
      at: '2026-09-19T10:00:00.000Z', canDecide: false, byAgentName: 'Leo', byOwnerName: 'Dana Ives',
    });
  });

  /**
   * The same directory, one surface further out (note #640): a repository is
   * the WORKPLACE's, so most of its commits are somebody else's agent's — and
   * those rows carried the raw git name and no face, matched against the
   * reader's own fleet alone.
   */
  it('names a teammate\u2019s agent among a repository\u2019s contributors (note #640)', async () => {
    const { deps, orgStorage, org } = await buildOrgDeps();
    deps.orgGit = new OrgGitService({ orgStorage });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const repos = new InMemoryGitRepoStorage();
    const doc = await repos.create({
      userId: org.orgId, orgId: org.orgId, name: 'shop', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 1, protectDefaultBranch: true,
    });
    await repos.update(doc.id, {
      contributors: {
        sha: 'a'.repeat(40),
        countedAt: '2026-09-20T00:00:00.000Z',
        authors: [
          { name: 'Leo', email: 'leo@agentbuilt.app', commits: 12, insertions: 90, deletions: 10 },
          { name: 'Ben', email: 'ben@agentbuilt.app', commits: 3, insertions: 9, deletions: 1 },
        ],
      },
    });
    deps.gitRepoStorage = repos;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      contributors: async () => { throw new Error('host down'); },
    } as unknown as GitHostClient;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/contributors', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'shop' } }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { contributors: unknown[] }).contributors).toEqual([
      // Dana's agent, named and faced and openable, exactly like the
      // reader's own below it.
      {
        name: 'Leo', email: 'leo@agentbuilt.app', commits: 12, insertions: 90, deletions: 10,
        agentId: 'agent-c', agentAvatarUrl: '/workspace/avatars/leo',
      },
      {
        name: 'Ben', email: 'ben@agentbuilt.app', commits: 3, insertions: 9, deletions: 1,
        agentId: 'agent-a', agentAvatarUrl: '/workspace/avatars/ben',
      },
    ]);
  });

  describe('the founder door (POST /api/org)', () => {
    it('creates the org, makes the caller its admin, and the state flips whole', async () => {
      const { deps, userStorage } = await buildDeps();
      const orgStorage = new InMemoryOrgStorage();
      deps.orgStorage = orgStorage;
      await userStorage.updateProfile('user-1', {
        telegram: { ...(await userStorage.getProfile('user-1'))!.telegram, firstName: 'Vera' } as never,
      });

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(
        mockRequest({ headers: authHeader(42), body: { name: '  Vera   Capital ' } }),
        res,
      );
      expect(res.statusCode).toBe(200);
      // Whitespace arrives collapsed — the name is display text everywhere.
      expect(res.body).toMatchObject({ ok: true, name: 'Vera Capital', orgId: expect.any(String) });

      const membership = await orgStorage.getMembershipByUser('user-1');
      expect(membership?.role).toBe('admin');

      const state = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), state);
      // No `setupRequired` (note #726): the new workplace opens straight onto
      // Home with no plan signed in; `founded` is absent while the naming
      // edge is still owed.
      expect((state.body as { org: unknown }).org).toEqual({
        orgId: membership!.orgId,
        name: 'Vera Capital', role: 'admin', members: 1, seats: 0, seatProviders: [],
        workspaceAgentAvatarUrl: expect.stringMatching(/^\/workspace\/avatars\//),
      });
      expect((state.body as { canCreateOrg: boolean }).canCreateOrg).toBe(true);
      // Stamped for the Chief of Staff's first run.
      expect(await orgStorage.getOrg(membership!.orgId)).toMatchObject({ foundingPending: true, firstRun: true });

      // And the org screen answers the founder as it would any admin.
      const orgRes = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), orgRes);
      expect(orgRes.statusCode).toBe(200);
      expect((orgRes.body as { org: { fly: unknown } }).org.fly).toMatchObject({ connected: false, hosted: true });
    });

    it('a founder whose subscription is carried in is named on their next read, with no gate and no team (notes #664, #726)', async () => {
      const { deps, orgStorage } = await buildOrgDeps();
      const created = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(mockRequest({ headers: authHeader(42), body: { name: 'Second Shop' } }), created);
      const orgId = (created.body as { orgId: string }).orgId;

      // The read carries Owner's Claude sign-in in, and settles the naming
      // it was owed from the read itself. Two reads land together, as a
      // phone's first paint does: one edge, and nothing furnished by either.
      const first = createMockResponse();
      const second = createMockResponse();
      await Promise.all([
        getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), first),
        getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), second),
      ]);
      expect((first.body as { org: Record<string, unknown> }).org).toMatchObject({ orgId, seatProviders: ['claude'] });
      expect((first.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');
      await vi.waitFor(async () => {
        expect(await orgStorage.getOrg(orgId)).toMatchObject({ foundingPending: false });
      });
      expect((await orgStorage.getOrg(orgId))?.arriving).toBeUndefined();
      const settled = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), settled);
      expect((settled.body as { org: Record<string, unknown> }).org).toMatchObject({ orgId, founded: true });
      expect((settled.body as { org: Record<string, unknown> }).org).not.toHaveProperty('setupRequired');
    });

    it('creates another org for an existing member and makes it active', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(
        mockRequest({ headers: authHeader(43), body: { name: 'Side Venture' } }),
        res,
      );
      expect(res.statusCode).toBe(200);
      const createdOrgId = (res.body as { orgId: string }).orgId;
      expect(createdOrgId).not.toBe(org.orgId);
      expect((await orgStorage.listMembershipsByUser('user-2')).map((membership) => membership.orgId))
        .toEqual([createdOrgId, org.orgId]);
      expect((await orgStorage.getMembershipByUser('user-2'))?.orgId).toBe(createdOrgId);
    });

    it('refuses a blank name, an over-long name, and a backend without the layer', async () => {
      const { deps } = await buildDeps();
      deps.orgStorage = new InMemoryOrgStorage();

      const blank = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(
        mockRequest({ headers: authHeader(42), body: { name: '   ' } }),
        blank,
      );
      expect(blank.statusCode).toBe(400);
      expect((blank.body as { error: string }).error).toContain('name');

      const long = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'post')(
        mockRequest({ headers: authHeader(42), body: { name: 'x'.repeat(81) } }),
        long,
      );
      expect(long.statusCode).toBe(400);
      expect((long.body as { error: string }).error).toContain('80');

      const { deps: unwired } = await buildDeps();
      const off = createMockResponse();
      await getRouteHandler(unwired, '/api/org', 'post')(
        mockRequest({ headers: authHeader(42), body: { name: 'Acme' } }),
        off,
      );
      expect(off.statusCode).toBe(503);
    });
  });

  describe('connect-your-cloud (byo-fly slice 7)', () => {
    it('reports the cloud block on the org screen: absent, then connected with tunnel state', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const before = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), before);
      // No cloud of its own: HOSTED on ours (note #664), with its allowance.
      expect((before.body as any).org.fly).toEqual({
        connected: false, hosted: true,
        agents: { used: expect.any(Number), limit: 20 },
        sites: { used: 0, limit: 30 },
      });

      await orgStorage.updateOrg(org.orgId, {
        fly: {
          orgSlug: 'acme-agents',
          tokenSecretName: 'FLY_ORG_TOKEN',
          wireguard: { peerName: 'p', peerIp: 'fdaa:1:2:a7b::2', endpoint: 'ams1.gateway.6pn.dev', gatewayPubkey: 'G=' },
        },
      });
      const after = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), after);
      expect((after.body as any).org.fly).toEqual({ connected: true, orgSlug: 'acme-agents', peer: 'up' });
    });

    /**
     * Note #642. The tunnel line used to be `wireguard ? 'up' : 'pending'`,
     * and "pending" was a promise three different situations wore: one
     * genuinely mid-setup, one that had failed, and org #0's — whose network
     * the host already routes, so its peer is rolled back on every attempt
     * and "coming up" was a forecast that could never come true.
     */
    it('states the tunnel from the recorded outcome, and says nothing when there is none', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const fly = { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' };
      const peerOf = async () => {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
        return (res.body as any).org.fly.peer;
      };
      const at = new Date().toISOString();

      // Connected, nobody has looked: a silence, not a reassurance.
      await orgStorage.updateOrg(org.orgId, { fly });
      expect(await peerOf()).toBe('unknown');

      // Org #0's case: the machines ARE reachable, over a route we did not lay.
      await orgStorage.updateOrg(org.orgId, {
        fly: { ...fly, peerCheck: { status: 'routed-elsewhere', at, detail: 'fdaa:1:2::/48 dev wg-legacy' } },
      });
      expect(await peerOf()).toBe('routed-elsewhere');

      // The one worth acting on, and the one that used to be invisible.
      await orgStorage.updateOrg(org.orgId, { fly: { ...fly, peerCheck: { status: 'failed', at } } });
      expect(await peerOf()).toBe('failed');

      // A REGISTERED peer whose last attempt failed is not up: the check wins,
      // because peer-recorded-but-never-installed is the exact shape of the
      // connect-time failure `ensureUpIfMissing` exists to heal.
      await orgStorage.updateOrg(org.orgId, {
        fly: {
          ...fly,
          wireguard: { peerName: 'p', peerIp: 'fdaa:1:2:a7b::2', endpoint: 'e', gatewayPubkey: 'G=' },
          peerCheck: { status: 'failed', at },
        },
      });
      expect(await peerOf()).toBe('failed');

      // And a peer recorded before outcomes were kept still reads as up —
      // every workplace connected before this landed is in that state.
      await orgStorage.updateOrg(org.orgId, {
        fly: {
          ...fly,
          wireguard: { peerName: 'p', peerIp: 'fdaa:1:2:a7b::2', endpoint: 'e', gatewayPubkey: 'G=' },
          peerCheck: undefined,
        },
      });
      expect(await peerOf()).toBe('up');
    });

    it('api/org/cloud states the same tunnel as the workplace record', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, {
        fly: {
          orgSlug: 'acme-agents',
          tokenSecretName: 'FLY_ORG_TOKEN',
          peerCheck: { status: 'routed-elsewhere', at: new Date().toISOString() },
        },
      });
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/cloud', 'get')(
        mockRequest({ headers: authHeader(42), query: { inventory: '0' } }), res,
      );
      expect((res.body as any).fly).toEqual({ connected: true, orgSlug: 'acme-agents', peer: 'routed-elsewhere' });
    });

    it('a hosted workplace has no cloud to connect — the paste is refused before Fly is asked (note #664)', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const connectOrgFly = vi.fn();
      deps.orgFly = { connectOrgFly } as never;
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { token: 'fo1_secret' } }),
        res,
      );
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: string }).error).toBe('This workplace runs on the cloud, so there is no cloud account to connect.');
      expect(connectOrgFly).not.toHaveBeenCalled();
      expect((await orgStorage.getOrg(org.orgId))!.fly).toBeUndefined();
    });

    describe('a workplace the platform marked may bring its own Fly account (note #801)', () => {
      /** Nothing of the workplace in our account: no agent machine, no site, no bucket. */
      async function marked() {
        const built = await buildOrgDeps();
        const { orgStorage, org, userStorage } = built;
        await orgStorage.updateOrg(org.orgId, { ownCloudAllowed: { at: '2026-10-26T11:30:00.000Z', by: 'test' } });
        for (const [userId, agentId] of [['user-1', 'agent-a'], ['user-1', 'agent-b'], ['user-2', 'agent-c'], ['user-2', 'agent-d']] as const) {
          await userStorage.updateAgentFields(userId, agentId, { serverId: null, provisioningAppName: null });
        }
        return built;
      }

      it('connects while nothing of it runs on our cloud', async () => {
        const { deps, org } = await marked();
        const connectOrgFly = vi.fn().mockResolvedValue({ connected: true, orgSlug: 'customer-co', appCount: 0, moved: false });
        deps.orgFly = { connectOrgFly } as never;
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/org/fly', 'post')(
          mockRequest({ headers: authHeader(42), body: { token: 'fo1_customer' } }), res,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ ok: true, orgSlug: 'customer-co' });
        expect(connectOrgFly).toHaveBeenCalledWith({ orgId: org.orgId, token: 'fo1_customer' });
      });

      it('refuses while a machine of it already runs on ours — the Workspace Agent and Recap count too', async () => {
        const { deps, userStorage } = await marked();
        await userStorage.updateAgentFields('user-2', 'agent-d', { serverId: 'fly_ia-0123456789abcdef.m1' });
        const connectOrgFly = vi.fn();
        deps.orgFly = { connectOrgFly } as never;
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/org/fly', 'post')(
          mockRequest({ headers: authHeader(42), body: { token: 'fo1_customer' } }), res,
        );
        expect(res.statusCode).toBe(409);
        expect((res.body as { error: string }).error).toBe(
          'This workplace already has 1 agent machine on our cloud, and connecting your own Fly account '
          + 'would leave them where nothing could reach them. Ask us to move them first.',
        );
        expect(connectOrgFly).not.toHaveBeenCalled();
      });

      it('refuses while its direct messages live on a machine of ours (29 Oct 2026)', async () => {
        const { deps, orgStorage, org } = await marked();
        await orgStorage.updateOrg(org.orgId, { messages: { host: { app: 'iamsg-x', machineId: 'm', privateIp: 'fdaa::2', volumeId: 'v' } } });
        const connectOrgFly = vi.fn();
        deps.orgFly = { connectOrgFly } as never;
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/org/fly', 'post')(
          mockRequest({ headers: authHeader(42), body: { token: 'fo1_customer' } }), res,
        );
        expect(res.statusCode).toBe(409);
        expect((res.body as { error: string }).error).toBe(
          'This workplace already has its direct messages on our cloud, and connecting your own Fly account '
          + 'would leave them where nothing could reach them. Ask us to move them first.',
        );
        expect(connectOrgFly).not.toHaveBeenCalled();
      });

      it('the workplace record tells the screen it may connect, and an unmarked one says nothing', async () => {
        const { deps, orgStorage, org } = await marked();
        const read = async () => {
          const res = createMockResponse();
          await getRouteHandler(deps, '/api/org/cloud', 'get')(mockRequest({ headers: authHeader(42), query: { inventory: '0' } }), res);
          return (res.body as { fly: Record<string, unknown> }).fly;
        };
        expect(await read()).toMatchObject({ connected: false, hosted: true, ownCloudAllowed: true });
        await orgStorage.updateOrg(org.orgId, { ownCloudAllowed: undefined });
        expect(await read()).not.toHaveProperty('ownCloudAllowed');
      });
    });

    it('api/org/cloud carries a billing problem of a workplace\'s own account, in plain words (note #801)', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-trading', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const billing = { problem: 'Fly says the bill for your Fly organization "acme-trading" is past due.', fixUrl: 'https://fly.io/dashboard/acme-trading/billing' };
      const billingProblem = vi.fn().mockResolvedValue(billing);
      deps.orgFly = { billingProblem } as never;
      // One router, as in production: the five-minute memory lives in it.
      const handler = getRouteHandler(deps, '/api/org/cloud', 'get');
      const read = async () => {
        const res = createMockResponse();
        await handler(mockRequest({ headers: authHeader(42), query: { inventory: '0' } }), res);
        return res.body as { billing?: unknown };
      };
      expect((await read()).billing).toEqual(billing);
      // Kept, not re-asked every fifteen seconds.
      await read();
      expect(billingProblem).toHaveBeenCalledTimes(1);
    });

    it('admin re-connects a cloud of its own: validates, stores, brings the tunnel up — and the token never echoes', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      // Only a workplace that connected before note #664 still has one.
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const connectOrgFly = vi.fn().mockResolvedValue({ connected: true, orgSlug: 'acme-agents', appCount: 0, moved: false });
      const ensureOrgWireGuard = vi.fn().mockResolvedValue({ status: 'up', interfaceName: 'iaorg-x', peerIp: 'fdaa::2' });
      deps.orgFly = { connectOrgFly } as never;
      deps.orgWireGuard = { ensureOrgWireGuard } as never;

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { orgSlug: 'acme-agents', token: 'fo1_secret' } }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, orgSlug: 'acme-agents', appCount: 0, peer: 'up', moved: false });
      expect(JSON.stringify(res.body)).not.toContain('fo1_secret');
      expect(connectOrgFly).toHaveBeenCalledWith({
        orgId: org.orgId, orgSlug: 'acme-agents', token: 'fo1_secret',
      });
      expect(ensureOrgWireGuard).toHaveBeenCalledWith(org.orgId);
    });

    it('a token for another Fly org comes back as a question, and consent is what commits it', async () => {
      // Note #372. The refusal is not an error: the token is good, it simply
      // points somewhere else, and only Fly could say so. Nothing is written
      // until the same paste comes back carrying `replace`.
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const leaves = { gitHost: true, gitBackup: false, media: true };
      const connectOrgFly = vi.fn()
        .mockResolvedValueOnce({ connected: false, move: { fromSlug: 'acme-agents', toSlug: 'other-co', appCount: 4, leaves } })
        .mockResolvedValueOnce({
          connected: true, orgSlug: 'other-co', appCount: 4, previousSlug: 'acme-agents', moved: true,
        });
      const ensureOrgWireGuard = vi.fn().mockResolvedValue({ status: 'up', interfaceName: 'iaorg-x', peerIp: 'fdaa::2' });
      const ensureUpIfMissing = vi.fn();
      deps.orgFly = { connectOrgFly } as never;
      deps.orgWireGuard = { ensureOrgWireGuard, ensureUpIfMissing } as never;

      const asked = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { token: 'fo1_elsewhere' } }),
        asked,
      );
      expect(asked.statusCode).toBe(200);
      expect(asked.body).toEqual({
        ok: false, move: { fromSlug: 'acme-agents', toSlug: 'other-co', appCount: 4, leaves },
      });
      // No tunnel work on a question — nothing has moved to tunnel into.
      expect(ensureOrgWireGuard).not.toHaveBeenCalled();
      expect(ensureUpIfMissing).not.toHaveBeenCalled();

      const moved = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { token: 'fo1_elsewhere', replace: 'other-co' } }),
        moved,
      );
      expect(moved.body).toEqual({
        ok: true, orgSlug: 'other-co', appCount: 4, peer: 'up', previousSlug: 'acme-agents', moved: true,
      });
      // The slug that was SHOWN goes back, so the yes cannot be spent on an
      // org nobody was asked about.
      expect(connectOrgFly).toHaveBeenLastCalledWith({
        orgId: org.orgId, token: 'fo1_elsewhere', replace: 'other-co',
      });
      // A move has no peer into the new account yet: the full ensure mints one.
      expect(ensureOrgWireGuard).toHaveBeenCalledWith(org.orgId);
      expect(ensureUpIfMissing).not.toHaveBeenCalled();
    });

    it('a rotation converges the tunnel only if it is missing, rather than flapping a live one', async () => {
      // Same account, same network, same key — carried over by the service.
      // A full ensure is a down-then-up, and every SSH session on that tunnel
      // would pay for a credential swap that did not touch it.
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const ensureOrgWireGuard = vi.fn();
      const ensureUpIfMissing = vi.fn().mockResolvedValue({ status: 'up', interfaceName: 'iaorg-x', peerIp: 'fdaa::2' });
      deps.orgFly = {
        connectOrgFly: vi.fn().mockResolvedValue({
          connected: true, orgSlug: 'acme-agents', appCount: 2, previousSlug: 'acme-agents', moved: false,
        }),
      } as never;
      deps.orgWireGuard = { ensureOrgWireGuard, ensureUpIfMissing } as never;

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { token: 'fo1_fresh' } }),
        res,
      );
      expect(res.body).toEqual({
        ok: true, orgSlug: 'acme-agents', appCount: 2, peer: 'up', previousSlug: 'acme-agents', moved: false,
      });
      expect(ensureUpIfMissing).toHaveBeenCalledWith(org.orgId);
      expect(ensureOrgWireGuard).not.toHaveBeenCalled();
    });

    it('a member may not connect; a bad token is refused with the honest reason and commits nothing', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const connectOrgFly = vi.fn().mockRejectedValue(new Error('the offered token could not list apps in Fly org "acme-agents"'));
      deps.orgFly = { connectOrgFly } as never;

      const member = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(43), body: { orgSlug: 'x', token: 'y' } }),
        member,
      );
      expect(member.statusCode).toBe(403);
      expect(connectOrgFly).not.toHaveBeenCalled();

      const bad = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { orgSlug: 'acme-agents', token: 'typo' } }),
        bad,
      );
      expect(bad.statusCode).toBe(400);
      expect((bad.body as { error: string }).error).toMatch(/could not list apps/);
    });

    it('a tunnel failure leaves the account connected with the peer pending, never a refused connect', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      deps.orgFly = {
        connectOrgFly: vi.fn().mockResolvedValue({ connected: true, orgSlug: 'acme-agents', appCount: 2, moved: false }),
      } as never;
      deps.orgWireGuard = { ensureOrgWireGuard: vi.fn().mockRejectedValue(new Error('wg exploded')) } as never;

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/fly', 'post')(
        mockRequest({ headers: authHeader(42), body: { orgSlug: 'acme-agents', token: 'fo1_x' } }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect((res.body as { peer: string }).peer).toBe('pending');
    });

    it('cloud facts require membership; disconnected orgs skip Fly and preflight skips inventory', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const liveMachines = vi.fn().mockResolvedValue({ active: 2, sleeping: 3, checkedAt: 'now' });
      deps.orgSpend = { liveMachines } as never;
      const route = getRouteHandler(deps, '/api/org/cloud', 'get');
      const before = createMockResponse();
      await route(mockRequest({ headers: authHeader(43) }), before);
      // Hosted (note #664): its machines are in our account beside everybody
      // else's, so that account is never walked for its counts.
      expect(before.body).toEqual({
        orgId: org.orgId, role: 'member',
        fly: { connected: false, hosted: true, agents: { used: expect.any(Number), limit: 20 }, sites: { used: 0, limit: 30 } },
        machines: null,
      });
      expect(liveMachines).not.toHaveBeenCalled();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme', tokenSecretName: 'PRIVATE_SECRET' } });
      const preflight = createMockResponse();
      await route(mockRequest({ headers: authHeader(42), query: { inventory: '0' } }), preflight);
      expect((preflight.body as any).fly.connected).toBe(true);
      expect(liveMachines).not.toHaveBeenCalled();
      const member = createMockResponse();
      await route(mockRequest({ headers: authHeader(43) }), member);
      expect((member.body as any).machines).toEqual({ active: 2, sleeping: 3, checkedAt: 'now' });
      expect(liveMachines).toHaveBeenCalledWith(org.orgId);
      expect(JSON.stringify(member.body)).not.toContain('PRIVATE_SECRET');
      const outsider = createMockResponse();
      await route(mockRequest({ headers: authHeader(43), query: { org: 'someone-elses-org' } }), outsider);
      expect(outsider.statusCode).toBe(403);
    });

    it('unavailable inventory preserves connected state and reveals no upstream error details', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme', tokenSecretName: 'PRIVATE_SECRET' } });
      deps.orgSpend = { liveMachines: vi.fn().mockRejectedValue(new Error('sensitive upstream detail')) } as never;
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/cloud', 'get')(mockRequest({ headers: authHeader(42) }), res);
      expect((res.body as any).fly.connected).toBe(true);
      expect((res.body as any).machines).toBeNull();
      expect((res.body as any).inventoryError).toContain('unavailable');
      expect(JSON.stringify(res.body)).not.toContain('sensitive');
    });

    /**
     * NOTE #355. The workplace chooses what a NEW agent's machine is built
     * on; the choice is one field on its own record and touches no machine,
     * which is why it needs none of the refusals a resize keeps.
     */
    it('offers the machine ladder to a member, and lets only an admin choose', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const read = getRouteHandler(deps, '/api/org/agent-machine', 'get');
      const write = getRouteHandler(deps, '/api/org/agent-machine', 'post');

      // Nobody has chosen: what is in force is the platform's own default,
      // and the answer says which of the two it is.
      const before = createMockResponse();
      await read(mockRequest({ headers: authHeader(43) }), before);
      const first = before.body as { current: string; chosen: boolean; canChoose: boolean; sizes: unknown[] };
      expect(first.current).toBe(DEFAULT_AGENT_MACHINE_SIZE_ID);
      expect(first.chosen).toBe(false);
      // A member reads the ladder — it is what their next agent will get —
      // and is told they may not set it.
      expect(first.canChoose).toBe(false);
      expect(first.sizes).toHaveLength(AGENT_MACHINE_SIZES.length);

      const refused = createMockResponse();
      await write(mockRequest({ headers: authHeader(43), body: { size: 'performance-8x' } }), refused);
      expect(refused.statusCode).toBe(403);
      expect((await orgStorage.getOrg(org.orgId))!.agentMachineSizeId).toBeUndefined();

      // A rung this catalog does not offer never reaches the record.
      const nonsense = createMockResponse();
      await write(mockRequest({ headers: authHeader(42), body: { size: 'performance-64x' } }), nonsense);
      expect(nonsense.statusCode).toBe(400);
      expect((await orgStorage.getOrg(org.orgId))!.agentMachineSizeId).toBeUndefined();

      const written = createMockResponse();
      await write(mockRequest({ headers: authHeader(42), body: { size: 'performance-8x' } }), written);
      expect(written.statusCode).toBe(200);
      expect(written.body).toMatchObject({ ok: true, changed: true, current: 'performance-8x', chosen: true });
      expect((await orgStorage.getOrg(org.orgId))!.agentMachineSizeId).toBe('performance-8x');

      // Chosen again is not a change: `changed` reports what a reader would
      // see move, not whether a write happened.
      const again = createMockResponse();
      await write(mockRequest({ headers: authHeader(42), body: { size: 'performance-8x' } }), again);
      expect(again.body).toMatchObject({ ok: true, changed: false });

      const after = createMockResponse();
      await read(mockRequest({ headers: authHeader(43) }), after);
      expect(after.body).toMatchObject({ current: 'performance-8x', chosen: true });
    });

    /** A rung that has since left the ladder reads as no choice at all — a
     *  stale id must never be able to fail a provision. */
    it('falls back to the platform default when the stored rung is gone', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { agentMachineSizeId: 'performance-256x' });
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/agent-machine', 'get')(mockRequest({ headers: authHeader(42) }), res);
      expect(res.body).toMatchObject({ current: DEFAULT_AGENT_MACHINE_SIZE_ID, chosen: false });
    });

    /**
     * NOTE #944. Auto-merge is each person's own ("Each user should enable
     * disable for itself", Adam, 1 Nov 2026): any member turns theirs on and
     * off, nobody reaches a teammate's, every flip is recorded, and off is
     * the default. The state read carries it for the header and the window.
     */
    it('auto-merge is each member\'s own switch: off by default, theirs to flip, on the record, and on the state read', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const read = getRouteHandler(deps, '/api/org/auto-approve', 'get');
      const write = getRouteHandler(deps, '/api/org/auto-approve', 'put');

      const before = createMockResponse();
      await read(mockRequest({ headers: authHeader(43) }), before);
      expect(before.body).toEqual({ on: false });

      const nonsense = createMockResponse();
      await write(mockRequest({ headers: authHeader(43), body: { on: 'yes' } }), nonsense);
      expect(nonsense.statusCode).toBe(400);

      // A MEMBER turns their own on — no admin needed.
      const on = createMockResponse();
      await write(mockRequest({ headers: authHeader(43), body: { on: true } }), on);
      expect(on.statusCode).toBe(200);
      expect(on.body).toMatchObject({ ok: true, changed: true, on: true });
      const mine = (await orgStorage.getMembership(org.orgId, 'user-2'))!.autoApprove!;
      expect(mine).toMatchObject({ on: true, changedByUserId: 'user-2' });
      expect(mine.history).toEqual([expect.objectContaining({ on: true, byUserId: 'user-2' })]);
      expect((await orgStorage.getMembership(org.orgId, 'user-2'))!.recap?.text).toContain('auto-merge on');
      // …and the admin's stays exactly as it was: off, untouched.
      expect((await orgStorage.getMembership(org.orgId, 'user-1'))!.autoApprove).toBeUndefined();
      const admins = createMockResponse();
      await read(mockRequest({ headers: authHeader(42) }), admins);
      expect(admins.body).toEqual({ on: false });

      // The same answer twice is not a flip: the history keeps meaning flips.
      const again = createMockResponse();
      await write(mockRequest({ headers: authHeader(43), body: { on: true } }), again);
      expect(again.body).toMatchObject({ ok: true, changed: false });
      expect((await orgStorage.getMembership(org.orgId, 'user-2'))!.autoApprove!.history).toHaveLength(1);

      // The state read carries the reader's own, for the header and the window.
      const memberState = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(43) }), memberState);
      expect((memberState.body as { org: { autoMerge?: { on: boolean } } }).org.autoMerge).toMatchObject({ on: true });
      const adminState = createMockResponse();
      await getRouteHandler(deps, '/api/state', 'get')(mockRequest({ headers: authHeader(42) }), adminState);
      expect((adminState.body as { org: { autoMerge?: unknown } }).org.autoMerge).toBeUndefined();

      const off = createMockResponse();
      await write(mockRequest({ headers: authHeader(43), body: { on: false } }), off);
      expect(off.body).toMatchObject({ ok: true, changed: true, on: false });
      const after = createMockResponse();
      await read(mockRequest({ headers: authHeader(43) }), after);
      expect((after.body as { history: Array<{ on: boolean }> }).history.map((change) => change.on)).toEqual([false, true]);
    });

    it('a hosted workplace has no bill: spend answers that, and never walks our account (note #664)', async () => {
      const { deps } = await buildOrgDeps();
      const report = vi.fn();
      deps.orgSpend = { report } as never;
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/spend', 'get')(mockRequest({ headers: authHeader(42) }), res);
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: string }).error).toMatch(/^This workplace runs on the cloud, free of charge, so there is no bill to show\. It has \d+ of its 20 agents and 0 of its 30 sites\.$/);
      expect(report).not.toHaveBeenCalled();
    });

    it("a private copy shows a hosted workplace its bill: the account is the customer's own (note #804)", async () => {
      const { deps, org } = await buildOrgDeps();
      const report = vi.fn().mockResolvedValue({ orgSlug: 'theirco-fly', machines: [], totals: {} });
      deps.orgSpend = { report } as never;
      deps.privateCopy = true;
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/spend', 'get')(mockRequest({ headers: authHeader(42) }), res);
      expect(res.statusCode).toBe(200);
      expect(report).toHaveBeenCalledWith(org.orgId);
      expect(res.body).toMatchObject({ orgSlug: 'theirco-fly' });
    });

    it('spend is admin-only and rides the active org report', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
      const row = (agent?: { id: string; name: string; driver?: string }) => ({
        app: 'ia-x', machineId: 'm', kind: 'agent', state: 'started', size: 'performance-4x 8GB',
        estimatedMonthlyUsd: 124, runningMonthlyUsd: 124, hourlyUsd: 0.1722, ...(agent ? { agent } : {}),
      });
      const report = vi.fn().mockResolvedValue({
        orgSlug: 'acme-agents',
        machines: [row({ id: 'a1', name: 'Ada', driver: 'Mira Vale' }), row({ id: 'a2', name: 'Zaphod' }), row()],
        totals: { estimatedMonthlyUsd: 0, runningMonthlyUsd: 0, running: 0, stopped: 0 },
        disclaimer: 'estimate',
      });
      deps.orgSpend = { report } as never;

      const member = createMockResponse();
      await getRouteHandler(deps, '/api/org/spend', 'get')(mockRequest({ headers: authHeader(43) }), member);
      expect(member.statusCode).toBe(403);

      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/spend', 'get')(mockRequest({ headers: authHeader(42) }), res);
      expect(res.statusCode).toBe(200);
      const body = res.body as { orgSlug: string; machines: { agent?: { name: string; avatarUrl?: string } }[] };
      expect(body.orgSlug).toBe('acme-agents');
      // An agent's row wears the same face its fleet row wears (note #319);
      // a name the pool has no picture for, and a machine with no agent, wear none.
      // The human the agent works for travels with it (note #336) — the face
      // is added to the agent the report named, never rebuilt from its parts.
      expect(body.machines[0]!.agent).toEqual({ id: 'a1', name: 'Ada', driver: 'Mira Vale', avatarUrl: '/workspace/avatars/ada' });
      expect(body.machines[1]!.agent).toEqual({ id: 'a2', name: 'Zaphod' });
      expect(body.machines[2]!.agent).toBeUndefined();
    });

    /**
     * Removing a leftover (note #375). The route is the thinnest possible
     * thing on purpose — a name in, a service call, a status back — because
     * everything that makes the name safe to act on is a walk of the account
     * and of every agent record, which cannot be done here and must never be
     * taken from the browser. What IS this route's own is the gate: an
     * workplace's machines are its admins' to remove.
     */
    it('removing a machine is admin-only, and answers the service’s refusal', async () => {
      const { deps } = await buildOrgDeps();
      const removeLeftoverMachine = vi.fn().mockResolvedValue({ app: 'ia-leftover', machines: 1 });
      deps.orgSpend = { removeLeftoverMachine } as never;
      const remove = getRouteHandler(deps, '/api/org/machines/:app', 'delete');

      const member = createMockResponse();
      await remove(mockRequest({ headers: authHeader(43), params: { app: 'ia-leftover' } }), member);
      expect(member.statusCode).toBe(403);
      expect(removeLeftoverMachine).not.toHaveBeenCalled();

      const res = createMockResponse();
      await remove(mockRequest({ headers: authHeader(42), params: { app: 'ia-leftover' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, app: 'ia-leftover', machines: 1 });
      expect(removeLeftoverMachine).toHaveBeenCalledWith(expect.any(String), 'ia-leftover');

      // A refusal keeps its own status and its own words: "Ada is on that
      // machine" is the answer, not a 502 about the cloud.
      removeLeftoverMachine.mockRejectedValueOnce(new OrgSpendError(409, 'Ada is on that machine.'));
      const claimed = createMockResponse();
      await remove(mockRequest({ headers: authHeader(42), params: { app: 'ia-adas' } }), claimed);
      expect(claimed.statusCode).toBe(409);
      expect(claimed.body).toEqual({ error: 'Ada is on that machine.' });

      // Anything else is the cloud failing, and says so as one.
      removeLeftoverMachine.mockRejectedValueOnce(new Error('Fly is unreachable'));
      const broken = createMockResponse();
      await remove(mockRequest({ headers: authHeader(42), params: { app: 'ia-leftover' } }), broken);
      expect(broken.statusCode).toBe(502);
    });
  });

  describe('the code block (byo-git slice 6)', () => {
    const repoStub = () => ({
      listByUser: vi.fn(async () => [{}, {}] as never[]),
      totalBytesForUser: vi.fn(async () => 2048),
    });

    it('absent without git ground; repo facts, keyed by the NAMESPACE, for an org on the central host', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      const repos = repoStub();
      deps.gitRepoStorage = repos as never;
      const before = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), before);
      expect((before.body as any).org.git).toBeUndefined();

      // Org #0's shape: stamped with the admin's userId, no host of its own.
      await orgStorage.updateOrg(org.orgId, { git: { namespaceId: 'user-1' } });
      const after = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(43) }), after);
      expect((after.body as any).org.git).toEqual({ repoCount: 2, totalSizeBytes: 2048 });
      // The org's shelf, never the caller's own id — a member sees the org.
      expect(repos.listByUser).toHaveBeenCalledWith('user-1');
      expect(repos.totalBytesForUser).toHaveBeenCalledWith('user-1');
    });

    it('an org with its own host carries health, the grow price, and the last backup', async () => {
      const { deps, orgStorage, org } = await buildOrgDeps();
      deps.gitRepoStorage = repoStub() as never;
      const describeHost = vi.fn(async () => ({ app: 'iagit-x', health: 'ok' as const, diskUsedPercent: 34, volumeSizeGb: 10, snapshotRetentionDays: 14 }));
      deps.orgGitHost = { describeHost } as never;
      await orgStorage.updateOrg(org.orgId, {
        git: {
          namespaceId: org.orgId,
          host: { app: 'iagit-x', flycastIp: 'fdaa::2', volumeId: 'vol_1' },
          backup: {
            addOnName: 'iagit-x-bk', bucket: 'iagit-x-bk', endpoint: 'https://t3.storage.dev',
            last: { at: '2026-08-23T12:00:00Z', ok: true, detail: '2 repos · 1 uploaded' },
          },
        },
      });
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org', 'get')(mockRequest({ headers: authHeader(42) }), res);
      const git = (res.body as any).org.git;
      expect(git.host).toEqual({
        app: 'iagit-x', health: 'ok', diskUsedPercent: 34, volumeSizeGb: 10, snapshotRetentionDays: 14,
        growByGb: 10, growMonthlyUsd: 1.5,
        // What the repos may fill now, and after one grow (note #62). The
        // second is what makes the grow tap able to say what it BUYS — it
        // used to buy disk the flat 1 GB ceiling would not let anyone use.
        repoMaxBytes: 8 * 1024 * 1024 * 1024,
        repoMaxBytesAfterGrow: 16 * 1024 * 1024 * 1024,
      });
      // WHEN and WHETHER, never the run's own detail line: on the failure path
      // that string is a raw `error.message` from the sweep, which no screen
      // renders and which can name whatever the failure happened to touch.
      expect(git.backup).toEqual({
        bucket: 'iagit-x-bk',
        everyHours: 6,
        last: { at: '2026-08-23T12:00:00Z', ok: true },
      });
      expect(describeHost).toHaveBeenCalledWith(org.orgId);
    });

    it('growing the volume is admin-only, rides the service, and refuses with the honest reason', async () => {
      const { deps } = await buildOrgDeps();
      const growVolume = vi.fn(async () => ({ sizeGb: 20 }));
      deps.orgGitHost = { growVolume } as never;

      const member = createMockResponse();
      await getRouteHandler(deps, '/api/org/git/volume', 'post')(mockRequest({ headers: authHeader(43) }), member);
      expect(member.statusCode).toBe(403);
      expect(growVolume).not.toHaveBeenCalled();

      const admin = createMockResponse();
      await getRouteHandler(deps, '/api/org/git/volume', 'post')(mockRequest({ headers: authHeader(42) }), admin);
      expect(admin.statusCode).toBe(200);
      expect(admin.body).toEqual({ ok: true, sizeGb: 20 });

      growVolume.mockRejectedValueOnce(new Error('the volume is already 95 GB — growing past 100 GB is a conversation with the platform, not a tap'));
      const refused = createMockResponse();
      await getRouteHandler(deps, '/api/org/git/volume', 'post')(mockRequest({ headers: authHeader(42) }), refused);
      expect(refused.statusCode).toBe(400);
      expect((refused.body as { error: string }).error).toMatch(/conversation with the platform/);
    });
  });

  describe('seat sign-in from the Workspace', () => {
    function signInStub() {
      const calls: Record<string, unknown[]> = { start: [], poll: [], submitCode: [], cancel: [] };
      const status = { provider: 'codex', startedAt: 'x', state: { phase: 'starting' } };
      return {
        calls,
        stub: {
          start: async (args: unknown) => { calls.start.push(args); return status; },
          poll: async (userId: unknown) => { calls.poll.push(userId); return status; },
          submitCode: async (userId: unknown, code: unknown) => { calls.submitCode.push([userId, code]); return status; },
          cancel: async (userId: unknown) => { calls.cancel.push(userId); },
        } as never,
      };
    }

    it('503s without the flow wired, 400s a nonsense provider', async () => {
      const { deps } = await buildOrgDeps();
      const no = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'post')(
        mockRequest({ headers: authHeader(43), body: { provider: 'claude' } }), no);
      expect(no.statusCode).toBe(503);

      deps.seatSignIn = signInStub().stub;
      const bad = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'post')(
        mockRequest({ headers: authHeader(43), body: { provider: 'kimi' } }), bad);
      expect(bad.statusCode).toBe(400);
    });

    it('starts either provider with no machine in the loop — the backend is the OAuth client for both', async () => {
      const { deps } = await buildOrgDeps();
      // Dana's agents carry no serverId in the fixture: no machine anywhere.
      const { stub, calls } = signInStub();
      deps.seatSignIn = stub;
      for (const provider of ['codex', 'claude'] as const) {
        const res = createMockResponse();
        await getRouteHandler(deps, '/api/org/signin', 'post')(
          mockRequest({ headers: authHeader(43), body: { provider } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('signin.state.phase', 'starting');
      }
      expect(calls.start).toEqual([
        { userId: 'user-2', orgId: expect.any(String), provider: 'codex' },
        { userId: 'user-2', orgId: expect.any(String), provider: 'claude' },
      ]);
    });

    it('builds the Chief of Staff\'s machine when the tap came from its sign-in card, and not from the Seats screen (note #726)', async () => {
      const { deps, orgStorage } = await buildOrgDeps();
      deps.seatSignIn = signInStub().stub;
      const prepare = vi.fn(async (_userId: string, _orgId: string, _cli: 'claude' | 'codex') => {});
      deps.agentLifecycle = { ...(deps.agentLifecycle ?? {}), prepareWorkspaceAgent: prepare } as never;
      const membership = (await orgStorage.getMembershipByUser('user-2'))!;
      // From the Seats screen: nothing written, nothing waiting — no machine ahead.
      const plain = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'post')(
        mockRequest({ headers: authHeader(43), body: { provider: 'claude' } }), plain);
      expect(plain.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(prepare).not.toHaveBeenCalled();
      // From the card: the first message is waiting for the plan.
      await orgStorage.touchMember(membership.orgId, 'user-2', { workspaceRecapChat: { messages: [], receipts: [], pending: [], awaitingSeat: true } });
      const card = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'post')(
        mockRequest({ headers: authHeader(43), body: { provider: 'codex' } }), card);
      expect(card.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(prepare).toHaveBeenCalledWith('user-2', membership.orgId, 'codex');
    });

    it('poll, code, and cancel all speak for the CALLER, never a body-named user', async () => {
      const { deps } = await buildOrgDeps();
      const { stub, calls } = signInStub();
      deps.seatSignIn = stub;

      const polled = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'get')(
        mockRequest({ headers: authHeader(43) }), polled);
      expect(polled.statusCode).toBe(200);
      expect(calls.poll).toEqual(['user-2']);

      const coded = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin/code', 'post')(
        mockRequest({ headers: authHeader(43), body: { code: '  aaaa#bbbb  ' } }), coded);
      expect(calls.submitCode).toEqual([['user-2', 'aaaa#bbbb']]);

      const emptyCode = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin/code', 'post')(
        mockRequest({ headers: authHeader(43), body: { code: '   ' } }), emptyCode);
      expect(emptyCode.statusCode).toBe(400);

      const cancelled = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'delete')(
        mockRequest({ headers: authHeader(43) }), cancelled);
      expect(calls.cancel).toEqual(['user-2']);
    });

    it('is a members-only door, like every other org surface', async () => {
      const { deps } = await buildDeps();
      deps.orgStorage = new InMemoryOrgStorage();
      deps.seatSignIn = signInStub().stub;
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/org/signin', 'post')(
        mockRequest({ headers: authHeader(42), body: { provider: 'claude' } }), res);
      expect(res.statusCode).toBe(403);
    });
  });
});

/**
 * Note #88 made keys and sites follow the ROOM; notes #566 and #783 took
 * repositories and keys back to the workplace, and stage 3 of note #843
 * (note #923) took the rooms away. What stands: a site, a repository and a
 * key are the workplace's, every screen carries all of them, and a `?room=`
 * left in an old page's address is read by nothing.
 */
describe('keys, sites and repositories are the workplace’s (notes #88, #566, #923)', () => {
  async function buildWorkplaceDeps() {
    const built = await buildDeps();
    // A second, LINKED human: the role gate has to be what refuses them, not
    // the sign-in check — a 403 that only proves they are a stranger tests
    // nothing about who may delete a repository.
    await built.userStorage.createProfile('user-2', { email: 'd@example.com', displayName: 'Dana' });
    await built.userStorage.updateProfile('user-2', {
      telegram: {
        chatId: '2', linkedAt: 't', notificationsEnabled: true, telegramUserId: '43', agents: {},
      } as never,
    });
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    // An old room's namespace, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      git: { namespaceId: org.orgId },
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-school'] },
    });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    for (const agentId of ['agent-a', 'agent-b']) {
      await built.userStorage.updateAgentFields('user-1', agentId, { orgId: org.orgId });
    }
    const deploymentStorage = new InMemoryDeploymentStorage();
    built.deps.orgStorage = orgStorage;
    built.deps.orgGit = new OrgGitService({ orgStorage });
    built.deps.deploymentStorage = deploymentStorage;
    built.deps.deploymentService = {
      url: (d: { name: string }) => `https://${d.name}.agentbuilt.app`,
    } as never;
    return { ...built, orgStorage, deploymentStorage, org };
  }

  const stateIn = async (deps: Partial<RouteDeps>, query?: Record<string, string>) => {
    const res = createMockResponse();
    await getRouteHandler(deps, '/api/state', 'get')(
      mockRequest({ headers: authHeader(42), ...(query ? { query } : {}) }), res,
    );
    return res;
  };

  // A repository belongs to the workplace (note #566), wherever its bytes
  // were first put: one made in a room before that keeps its address.
  it('lists and opens a repository whose bytes stayed at an old room’s address (note #566)', async () => {
    const { deps, orgStorage, org } = await buildWorkplaceDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    // Made before repositories were the workplace's: bytes at the ROOM's
    // namespace, and — like some old records — no orgId of its own.
    await gitRepoStorage.create({
      userId: 'ns-school', name: 'lessons', createdByAgentId: 'agent-a', defaultBranch: 'main',
      sizeBytes: 5, protectDefaultBranch: true, ciSecrets: ['DEPLOY_TOKEN'],
    });
    await gitRepoStorage.create({
      userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a', sizeBytes: 1,
      protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.orgGit = new OrgGitService({
      orgStorage, repoNamespacesForOrg: (orgId) => gitRepoStorage.listNamespacesByOrg(orgId),
    });
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      knowledgeList: async () => ({ pages: [], index: null }),
      tree: async () => ({ branch: 'main', entries: [] }),
    } as unknown as GitHostClient;

    // The screens list it and open it, at the unchanged address.
    const state = await stateIn(deps);
    const rows = (state.body as { repos: Array<{ name: string; cloneUrl: string; ciSecrets?: unknown }> }).repos;
    expect(rows.map((row) => row.name).sort()).toEqual(['api', 'lessons']);
    expect(rows.find((row) => row.name === 'lessons')!.cloneUrl).toBe('https://git.test/ns-school/lessons.git');
    // Its CI grant names the workplace's keys (note #783), and no room.
    expect(rows.find((row) => row.name === 'lessons')!.ciSecrets).toEqual({ names: ['DEPLOY_TOKEN'] });
    const opened = createMockResponse();
    await getRouteHandler(deps, '/api/repos/:name/tree', 'get')(
      mockRequest({ headers: authHeader(42), params: { name: 'lessons' }, query: {} }), opened);
    expect(opened.statusCode).toBe(200);
  });

  it('has no move route for a site, and every view carries it', async () => {
    const { deps, deploymentStorage, org } = await buildWorkplaceDeps();
    await deploymentStorage.create({
      userId: 'user-1', orgId: org.orgId, agentId: 'agent-a', name: 'school',
      preset: 'static', status: 'live',
    });
    expect(() => getRouteHandler(deps, '/api/sites/:name/room', 'post')).toThrow();
    for (const query of [undefined, { room: 'room-from-an-old-link' }]) {
      const view = await stateIn(deps, query);
      const sites = (view.body as { sites: Array<Record<string, unknown>> }).sites;
      expect(sites.map((site) => site.name)).toEqual(['school']);
      expect(sites[0]).not.toHaveProperty('roomId');
    }
  });

  // A repository belongs to the workplace (note #566). The per-repository
  // sharing of note #108 and the move between rooms of note #88 are gone:
  // there is nothing to share with and nowhere to move to.
  it('has no share or move route for a repository, and its row names no room', async () => {
    const { deps, org } = await buildWorkplaceDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      knowledgeList: async () => ({ pages: [], index: '{"pages":{}}' }),
    } as unknown as GitHostClient;
    expect(() => getRouteHandler(deps, '/api/repos/:name/rooms', 'post')).toThrow();
    expect(() => getRouteHandler(deps, '/api/repos/:name/room', 'post')).toThrow();

    const state = await stateIn(deps, { room: 'room-from-an-old-link' });
    const repos = (state.body as { repos: Array<Record<string, unknown>> }).repos;
    expect(repos).toEqual([expect.objectContaining({
      name: 'api',
      // The address is unchanged — it never named a room the reader is in.
      cloneUrl: `https://git.test/${org.orgId}/api.git`,
    })]);
    // Nothing on the row says "room" any more: there is no room to be in.
    for (const gone of ['roomIds', 'homeRoomId', 'canUnlinkFromRoom']) expect(repos[0]).not.toHaveProperty(gone);
  });

  it('deletes a repository for real, and only for an admin', async () => {
    const { deps, orgStorage, org } = await buildWorkplaceDeps();
    const gitRepoStorage = new InMemoryGitRepoStorage();
    const repo = await gitRepoStorage.create({
      userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'agent-a',
      defaultBranch: 'main', sizeBytes: 0, protectDefaultBranch: true,
    });
    deps.gitRepoStorage = gitRepoStorage;
    const deleted: string[] = [];
    deps.gitHostClient = {
      cloneUrl: (userId: string, name: string) => `https://git.test/${userId}/${name}.git`,
      deleteRepo: async (userId: string, name: string) => { deleted.push(`${userId}/${name}`); return { trashedAs: `${name}.1.git` }; },
    } as unknown as GitHostClient;
    const remove = getRouteHandler(deps, '/api/repos/:name', 'delete');

    // A room's creator could once close "their room's door" on a shared
    // repository. There is no door: a plain member is simply refused.
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-2', role: 'member', invitedByUserId: 'user-1' });
    const member = createMockResponse();
    await remove(mockRequest({
      headers: authHeader(43), params: { name: 'api' }, body: { confirm: 'api' },
    }), member);
    expect(member.statusCode).toBe(403);
    expect(deleted).toEqual([]);

    const admin = createMockResponse();
    await remove(mockRequest({
      headers: authHeader(42), params: { name: 'api' }, body: { confirm: 'api' },
    }), admin);
    expect(admin.statusCode).toBe(200);
    expect(admin.body).not.toHaveProperty('unlinked');
    expect(deleted).toEqual([`${org.orgId}/api`]);
    expect((await gitRepoStorage.get(repo.id))?.deletedAt).toBeTruthy();
  });

  it('every view carries every site, takes one down whoever deployed it, and says who deployed it last', async () => {
    const { deps, deploymentStorage, org } = await buildWorkplaceDeps();
    await deploymentStorage.create({
      userId: 'user-1', orgId: org.orgId, agentId: 'agent-a', name: 'shop', preset: 'static', status: 'live',
      lastDeployAt: '2026-09-18T10:00:00.000Z',
      lastDeployBy: { agentId: 'agent-a', userId: 'user-1', agentName: 'Ben' },
    });
    await deploymentStorage.create({
      userId: 'user-2', orgId: org.orgId, agentId: 'agent-theirs',
      name: 'tutor', preset: 'static', status: 'live',
      lastDeployBy: { agentId: 'agent-theirs', userId: 'user-2', agentName: 'Leo' },
    });
    await deploymentStorage.create({
      userId: 'stranger', orgId: 'another-workplace', agentId: 'agent-z', name: 'theirs', preset: 'static', status: 'live',
    });

    for (const query of [undefined, { room: 'room-from-an-old-link' }]) {
      const view = await stateIn(deps, query);
      const sites = (view.body as { sites: Array<{ name: string; lastDeployedBy?: string }> }).sites;
      expect(sites.map((site) => site.name).sort()).toEqual(['shop', 'tutor']);
      const by = new Map(sites.map((site) => [site.name, site.lastDeployedBy]));
      // The viewer's own agent is named, and so is a teammate's (2026-09-23),
      // by name alone: there is no room to say they stood in.
      expect(by.get('shop')).toBe('Ben');
      expect(by.get('tutor')).toBe('Leo');
    }

    // Taken down by the admin although another member's agent deployed it:
    // the workplace's site, the admin's decision.
    const destroy = vi.fn(async () => {});
    deps.deploymentService = { ...deps.deploymentService!, destroy } as never;
    const removed = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'tutor' } }), removed,
    );
    expect(removed.statusCode).toBe(200);
    // Another workplace's site is still nobody's here.
    const foreign = createMockResponse();
    await getRouteHandler(deps, '/api/sites/:name', 'delete')(
      mockRequest({ headers: authHeader(42), params: { name: 'theirs' } }), foreign,
    );
    expect(foreign.statusCode).toBe(404);
    expect((await deploymentStorage.getByName('theirs'))?.status).toBe('live');
  });
});

/**
 * The app catalogue (note #756), anonymous: every live, listed site, newest
 * first, with its maker named as their public page names them — and
 * nothing about the agent or the workplace.
 */
describe('the app catalogue (note #756): /api/public/apps', () => {
  it('lists live, listed sites newest first, with the maker and the picture, and nothing else', async () => {
    const { deps, userStorage } = await buildDeps();
    await userStorage.updateProfile('user-1', { person: { firstName: 'Adam', lastName: 'Reyes' } } as never);
    await userStorage.createProfile('user-2', { email: 'dana@example.com', displayName: 'Dana' });
    deps.mailboxes = {
      forUser: async (userId: string) => ({ 'user-1': { address: 'adam@agenticcloudcomputer.com' } } as Record<string, { address: string }>)[userId] ?? null,
      holderOf: async () => null,
    } as never;
    deps.mediaStorage = {
      createReadAccess: async ({ storagePath }: { storagePath: string }) => ({ url: `https://media.example/${storagePath}?signed`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    } as never;
    const deploymentStorage = new InMemoryDeploymentStorage();
    const make = (over: Record<string, unknown>) => deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', preset: 'static', status: 'live', ...over,
    } as never);
    const oldest = await make({ name: 'first', listing: { line: 'The first app.', picture: { storagePath: 'users/user-1/sites/x/catalogue/p.png', sizeBytes: 3, takenAt: 't' } } });
    await deploymentStorage.update(oldest.id, { createdAt: '2026-10-01T00:00:00.000Z' } as never);
    await make({ name: 'newest', listing: { line: 'The newest app.' }, lastDeployBy: { agentId: 'agent-x', userId: 'user-2', agentName: 'Zed' } });
    await make({ name: 'unlisted', listing: { line: 'Hidden on request.', listed: false } });
    await make({ name: 'no-line' });
    await make({ name: 'paused', status: 'payment-lapsed', listing: { line: 'Paused.' } });
    await make({ name: 'hidden', listing: { line: 'Moderated.', hiddenByOperator: true } });
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/public/apps', 'get')(mockRequest({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ apps: [
      {
        name: 'newest', url: 'https://newest.agentbuilt.app', line: 'The newest app.',
        // Whoever deployed it last is the maker; a person with no address is named only.
        builder: { name: 'Dana' },
        publishedAt: expect.any(String),
        createdAt: expect.any(String),
      },
      {
        name: 'first', url: 'https://first.agentbuilt.app', line: 'The first app.',
        builder: { name: 'Adam Reyes', handle: 'adam' },
        pictureUrl: 'https://media.example/users/user-1/sites/x/catalogue/p.png?signed',
        // Never redeployed: published when it was first deployed.
        publishedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ] });
    const words = JSON.stringify(res.body);
    // The picture's signed URL carries the opaque owner id in its path, as a
    // profile photo's does; names of agents never cross.
    for (const leak of ['agent-a', 'agent-x', 'Zed', 'user-2']) expect(words).not.toContain(leak);
  });

  it('in a company\'s own Agentic Cloud: nothing for a stranger, and a member reads only their own workplaces\' sites (note #1014)', async () => {
    // Adam, 6 Nov 2026: "workplace's apps directory should not be public".
    // Ours stays the public showcase (the test above); a copy's is the
    // workplace's own.
    const { deps, userStorage } = await buildDeps();
    await userStorage.createProfile('user-2', { email: 'ben@example.com', displayName: 'Ben' });
    deps.privateCopy = true;
    const orgStorage = new InMemoryOrgStorage();
    await orgStorage.addMember({ orgId: 'org-a', userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: 'org-b', userId: 'user-2', role: 'admin' });
    deps.orgStorage = orgStorage;
    const deploymentStorage = new InMemoryDeploymentStorage();
    const make = (name: string, over: Record<string, unknown>) => deploymentStorage.create({
      userId: 'user-1', agentId: 'agent-a', preset: 'static', status: 'live', name, listing: { line: `${name}.` }, ...over,
    } as never);
    await make('acme-crm', { orgId: 'org-a' });
    await make('bravo-wiki', { orgId: 'org-b', userId: 'user-2' });
    await make('no-workplace', {});
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agents.example.com` } as never;
    const ask = async (headers: Record<string, string>) => {
      const res = createMockResponse();
      await getRouteHandler(deps, '/api/public/apps', 'get')(mockRequest({ headers }), res);
      return res;
    };

    // A stranger: refused, and not one name, line or picture in the answer.
    const stranger = await ask({});
    expect(stranger.statusCode).toBe(401);
    expect(stranger.headers['cache-control']).toBe('no-store');
    expect(stranger.headers['x-robots-tag']).toContain('noindex');
    for (const name of ['acme-crm', 'bravo-wiki', 'no-workplace']) expect(JSON.stringify(stranger.body)).not.toContain(name);

    // Signed in: their own workplace's sites only; a site with no workplace is nobody's to see.
    const ada = await ask(authHeader(42));
    expect(ada.statusCode).toBe(200);
    expect((ada.body as { apps: Array<{ name: string }> }).apps.map((a) => a.name)).toEqual(['acme-crm']);
    const ben = await ask(authHeader(43));
    expect((ben.body as { apps: Array<{ name: string }> }).apps.map((a) => a.name)).toEqual(['bravo-wiki']);
  });

  it('puts the most recently PUBLISHED site on top: a redeployed old site outranks a newer one (note #767)', async () => {
    // "Recent" to a visitor is the latest deploy, not the day the name was
    // first taken. A record from before lastDeployAt was kept orders by its
    // first deploy, which is the only date it has.
    const { deps } = await buildDeps();
    const deploymentStorage = new InMemoryDeploymentStorage();
    const make = async (name: string, createdAt: string, lastDeployAt?: string) => {
      const doc = await deploymentStorage.create({
        userId: 'user-1', agentId: 'agent-a', preset: 'static', status: 'live', name, listing: { line: `${name}.` },
      } as never);
      await deploymentStorage.update(doc.id, { createdAt, ...(lastDeployAt ? { lastDeployAt } : {}) } as never);
    };
    await make('veteran', '2026-08-07T08:24:06.861Z', '2026-10-16T15:12:24.659Z');   // old name, redeployed today
    await make('newcomer', '2026-10-15T17:30:52.914Z', '2026-10-15T17:31:00.000Z');  // newer name, not touched since
    await make('untouched', '2026-10-16T09:00:00.000Z');                             // never redeployed: first deploy counts
    await make('ancient', '2026-07-01T00:00:00.000Z');
    deps.deploymentStorage = deploymentStorage;
    deps.deploymentService = { url: (d: { name: string }) => `https://${d.name}.agentbuilt.app` } as never;

    const res = createMockResponse();
    await getRouteHandler(deps, '/api/public/apps', 'get')(mockRequest({}), res);
    expect(res.statusCode).toBe(200);
    const apps = (res.body as { apps: Array<{ name: string; publishedAt: string; createdAt: string }> }).apps;
    expect(apps.map((a) => a.name)).toEqual(['veteran', 'untouched', 'newcomer', 'ancient']);
    expect(apps.map((a) => a.publishedAt)).toEqual([
      '2026-10-16T15:12:24.659Z', '2026-10-16T09:00:00.000Z', '2026-10-15T17:31:00.000Z', '2026-07-01T00:00:00.000Z',
    ]);
    // The first-deploy date still travels, unchanged, for anything that shows it.
    expect(apps[0]!.createdAt).toBe('2026-08-07T08:24:06.861Z');
  });
});

describe('the guests\' public door (notes #1038, #1043)', () => {
  const status = vi.fn(async () => ({ state: 'none', agent: null }));
  const turnStatus = vi.fn(async () => ({ turnId: 't-1', state: 'working' }));
  const create = vi.fn(async () => ({ httpStatus: 201, answer: { key: 'k', status: { state: 'creating', agent: null } } }));
  const deps = (): Partial<RouteDeps> => ({
    workspaceWebOrigin: WORKSPACE_ORIGIN,
    guestAgents: { status, turnStatus, create } as never,
  });

  it('answers the page\'s own GETs, which a browser sends with no Origin', async () => {
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'get')(mockRequest({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ state: 'none' });
    const same = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest/turns/:turnId', 'get')(mockRequest({ headers: { 'Sec-Fetch-Site': 'same-origin' }, params: { turnId: 't-1' } }), same);
    expect(same.statusCode).toBe(200);
  });

  it('still refuses a GET from another site, and a POST without the site\'s Origin', async () => {
    const foreign = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'get')(mockRequest({ headers: { Origin: 'https://evil.example' } }), foreign);
    expect(foreign.statusCode).toBe(403);
    const crossSite = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest/turns/:turnId', 'get')(mockRequest({ headers: { 'Sec-Fetch-Site': 'cross-site' }, params: { turnId: 't-1' } }), crossSite);
    expect(crossSite.statusCode).toBe(403);
    const bare = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'post')(mockRequest({ body: {} }), bare);
    expect(bare.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
    const ok = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'post')(mockRequest({ headers: { Origin: WORKSPACE_ORIGIN }, body: {} }), ok);
    expect(ok.statusCode).toBe(201);
  });
  // Note #1139: the edge hands Cloudflare's country on in its own header; the page's tags arrive cleaned.
  it('passes the visitor\'s country and cleaned link tags to the build, never the address', async () => {
    create.mockClear();
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'post')(mockRequest({
      headers: { Origin: WORKSPACE_ORIGIN, 'x-acc-visitor-country': 'nl', 'cf-ipcountry': 'US' },
      body: { arrival: { utm: { utm_source: 'outreach', utm_content: 'test-co', other: 'x' }, referrerHost: 'mail.google.com' } },
    }), res);
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      arrival: { country: 'NL', utm: { utm_source: 'outreach', utm_content: 'test-co' }, referrerHost: 'mail.google.com' },
    }));
    // A request that reached Cloudflare directly still has its CF-IPCountry.
    const direct = createMockResponse();
    await getRouteHandler(deps(), '/api/public/guest', 'post')(mockRequest({ headers: { Origin: WORKSPACE_ORIGIN, 'cf-ipcountry': 'DE' }, body: {} }), direct);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ arrival: { country: 'DE', utm: {}, referrerHost: null } }));
  });
});

describe('the public guide\'s door (note #1010)', () => {
  const ask = vi.fn();
  const status = vi.fn();
  const deps = (): Partial<RouteDeps> => ({
    workspaceWebOrigin: WORKSPACE_ORIGIN,
    publicGuide: { ask, status, overview, listVisits: vi.fn(), getVisit: vi.fn() } as never,
  });
  const overview = vi.fn();

  it('says on load who answers, with its face, and whether it rests; resting with no agent when nothing is wired', async () => {
    overview.mockResolvedValueOnce({ state: 'open', until: null, agentName: 'Nina' });
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask/status', 'get')(mockRequest({}), res);
    expect(res.body).toEqual({ state: 'open', until: null, agent: { name: 'Nina', avatarUrl: expect.stringMatching(/^\/workspace\/avatars\//) } });
    expect(res.headers['cache-control']).toBe('no-store');
    overview.mockResolvedValueOnce({ state: 'resting', until: '2026-11-05T22:00:00.000Z', agentName: null });
    const none = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask/status', 'get')(mockRequest({}), none);
    expect(none.body).toEqual({ state: 'resting', until: '2026-11-05T22:00:00.000Z', agent: null });
    const bare = createMockResponse();
    await getRouteHandler({ workspaceWebOrigin: WORKSPACE_ORIGIN }, '/api/public/ask/status', 'get')(mockRequest({}), bare);
    expect(bare.body).toEqual({ state: 'resting', until: null, agent: null });
  });

  it('takes a question signed out from the site, passes the visitor\'s address, and answers 202 with the question id', async () => {
    ask.mockResolvedValueOnce({ state: 'accepted', questionId: 'q-1', position: 2 });
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask', 'post')(mockRequest({
      headers: { Origin: WORKSPACE_ORIGIN, 'CF-Connecting-IP': '203.0.113.7' },
      body: { visitId: 'visit-12345678', question: 'Does every agent get its own computer?' },
    }), res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ state: 'accepted', questionId: 'q-1', position: 2 });
    expect(ask).toHaveBeenLastCalledWith({ visitId: 'visit-12345678', question: 'Does every agent get its own computer?', address: '203.0.113.7' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a question from another site', async () => {
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask', 'post')(mockRequest({
      headers: { Origin: 'https://evil.example' }, body: { visitId: 'visit-12345678', question: 'q' },
    }), res);
    expect(res.statusCode).toBe(403);
    expect(ask).not.toHaveBeenCalledWith(expect.objectContaining({ question: 'q', address: expect.anything() }));
  });

  it('draws limited, resting and busy as 200 states, invalid as 400, and rests when nothing is wired', async () => {
    for (const [answer, code] of [[{ state: 'limited', until: 'x' }, 200], [{ state: 'resting', until: null }, 200], [{ state: 'busy' }, 200], [{ state: 'invalid', error: 'e' }, 400]] as const) {
      ask.mockResolvedValueOnce(answer);
      const res = createMockResponse();
      await getRouteHandler(deps(), '/api/public/ask', 'post')(mockRequest({ headers: { Origin: WORKSPACE_ORIGIN }, body: {} }), res);
      expect(res.statusCode).toBe(code);
      expect(res.body).toEqual(answer);
    }
    const bare = createMockResponse();
    await getRouteHandler({ workspaceWebOrigin: WORKSPACE_ORIGIN }, '/api/public/ask', 'post')(mockRequest({ headers: { Origin: WORKSPACE_ORIGIN }, body: {} }), bare);
    expect(bare.body).toEqual({ state: 'resting', until: null });
  });

  it('answers a poll, and 404 for a question it does not know', async () => {
    status.mockResolvedValueOnce({ questionId: 'q-1', state: 'reading', position: 0, files: ['README.md'], answer: null, elapsedSeconds: 4 });
    const res = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask/:questionId', 'get')(mockRequest({ params: { questionId: 'q-1' } }), res);
    expect(res.body).toMatchObject({ state: 'reading', files: ['README.md'] });
    status.mockResolvedValueOnce(null);
    const missing = createMockResponse();
    await getRouteHandler(deps(), '/api/public/ask/:questionId', 'get')(mockRequest({ params: { questionId: 'nope' } }), missing);
    expect(missing.statusCode).toBe(404);
  });
});
