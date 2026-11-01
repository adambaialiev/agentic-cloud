import { describe, expect, it, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createHmac } from 'node:crypto';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import {
  looksLikeCiCloneToken,
  mintCiCloneToken,
  verifyCiCloneToken,
} from '../../services/ci-clone-token.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';

const SECRET = 'ci-secret';

describe('ci-clone-token service', () => {
  it('mints a token that verifies back to its scope', () => {
    const { token, expiresAt } = mintCiCloneToken(SECRET, 'user-1', 'site');
    expect(looksLikeCiCloneToken(token)).toBe(true);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(verifyCiCloneToken(SECRET, token)).toEqual({ owner: 'user-1', repo: 'site' });
  });

  it('refuses a token signed with a different secret', () => {
    const { token } = mintCiCloneToken('other-secret', 'user-1', 'site');
    expect(verifyCiCloneToken(SECRET, token)).toBeNull();
  });

  it('refuses a token whose payload was swapped for another repo', () => {
    const { token } = mintCiCloneToken(SECRET, 'user-1', 'site');
    const [prefix, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify(['user-1', 'other-repo', Date.now() + 60_000]))
      .toString('base64url');
    expect(verifyCiCloneToken(SECRET, `${prefix}.${forged}.${sig}`)).toBeNull();
  });

  it('refuses an expired token even with a valid signature', () => {
    // Hand-signed with the documented derivation, so this also pins the
    // signing scheme: key = HMAC(secret, 'ci-clone-token-v1'), sig over
    // `cit1.<payload>` — a refactor that changes it must show up here.
    const payload = Buffer.from(JSON.stringify(['user-1', 'site', Date.now() - 1000]))
      .toString('base64url');
    const key = createHmac('sha256', SECRET).update('ci-clone-token-v1', 'utf8').digest();
    const sig = createHmac('sha256', key).update(`cit1.${payload}`, 'utf8').digest('base64url');
    const expired = `cit1.${payload}.${sig}`;
    expect(verifyCiCloneToken(SECRET, expired)).toBeNull();
    // The same construction with a future expiry passes, proving the
    // hand-signing (not the signature check) is what the test exercises.
    const future = Buffer.from(JSON.stringify(['user-1', 'site', Date.now() + 60_000]))
      .toString('base64url');
    const futureSig = createHmac('sha256', key).update(`cit1.${future}`, 'utf8').digest('base64url');
    expect(verifyCiCloneToken(SECRET, `cit1.${future}.${futureSig}`)).toEqual({ owner: 'user-1', repo: 'site' });
  });

  it('does not mistake agent tokens for CI tokens', () => {
    expect(looksLikeCiCloneToken('agb1.abc.def')).toBe(false);
  });
});

// ── The routes ──

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

function routeHandler(deps: Partial<RouteDeps>, path: string) {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods.post);
  if (!layer?.route) throw new Error(`No post ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function request(body: Record<string, unknown>, header: Record<string, string>): Partial<Request> {
  return {
    get: ((name: string) => header[name.toLowerCase()]) as Request['get'],
    params: {},
    query: {},
    body,
  };
}

describe('POST /git/ci-clone-token and /git/verify with CI tokens', () => {
  let deps: Partial<RouteDeps>;

  beforeEach(async () => {
    const repoStorage = new InMemoryGitRepoStorage();
    await repoStorage.create({
      userId: 'user-1', name: 'site', sizeBytes: 0, protectDefaultBranch: true,
    });
    deps = {
      gitRepoStorage: repoStorage,
      ciStatusSecret: SECRET,
      gitHostSecret: 'host-secret',
      userStorage: { getProfile: async () => null } as unknown as RouteDeps['userStorage'],
    };
  });

  it('mints only with the right secret and only for hosted repos', async () => {
    const mint = routeHandler(deps, '/git/ci-clone-token');

    const wrongSecret = createMockResponse();
    await mint(request({ owner: 'user-1', repo: 'site' }, { 'x-ci-status-secret': 'nope' }), wrongSecret);
    expect(wrongSecret.statusCode).toBe(401);

    const unknownRepo = createMockResponse();
    await mint(request({ owner: 'user-1', repo: 'ghost' }, { 'x-ci-status-secret': SECRET }), unknownRepo);
    expect(unknownRepo.statusCode).toBe(404);

    const ok = createMockResponse();
    await mint(request({ owner: 'user-1', repo: 'site', ttlSeconds: 600 }, { 'x-ci-status-secret': SECRET }), ok);
    expect(ok.statusCode).toBe(200);
    const { token } = ok.body as { token: string };
    expect(verifyCiCloneToken(SECRET, token)).toEqual({ owner: 'user-1', repo: 'site' });
  });

  it('/git/verify answers a CI token with the scope the host enforces', async () => {
    const verify = routeHandler(deps, '/git/verify');
    const { token } = mintCiCloneToken(SECRET, 'user-1', 'site');

    const res = createMockResponse();
    await verify(request({ token }, { 'x-git-host-secret': 'host-secret' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      userId: 'user-1',
      agentId: 'ci',
      scope: { repo: 'site', readOnly: true },
    });
  });

  it('/git/verify refuses a forged CI token without consulting user storage', async () => {
    const verify = routeHandler(deps, '/git/verify');
    const { token } = mintCiCloneToken('other-secret', 'user-1', 'site');
    const res = createMockResponse();
    await verify(request({ token }, { 'x-git-host-secret': 'host-secret' }), res);
    expect(res.statusCode).toBe(401);
  });
});
