import { describe, expect, it, vi } from 'vitest';
import { ANSWER_UNREADABLE_CODE, ANSWER_UNREADABLE_SENTENCE, WorkspaceApiError, cookieValue, createWorkspaceApi, jsonBody } from './client.js';

/**
 * The client is the legacy `api()` / `authApi()` pair as an importable
 * module. These pin the wire behaviour the backend's `authenticate()` relies
 * on: cookie credentials, the CSRF header read fresh per call, the workplace
 * parameter on ordinary calls only, and error bodies kept for the caller.
 * (Ordinary calls carried the viewed room as `?room=` too, until rooms left
 * the product — note #843.)
 */

function fetchStub(status: number, body: unknown, capture: Array<{ url: string; init: RequestInit }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('createWorkspaceApi', () => {
  it('calls under /workspace with cookie credentials and parses JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createWorkspaceApi({ fetch: fetchStub(200, { ok: true }, calls), cookies: () => '' });
    await expect(client.api('api/state')).resolves.toEqual({ ok: true });
    expect(calls[0]!.url).toBe('/workspace/api/state');
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });

  it('rides the named workplace on ordinary calls, never on auth calls', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createWorkspaceApi({ fetch: fetchStub(200, {}, calls), cookies: () => '' });
    const scope = { org: 'org a/b' };
    await client.api('api/notes', undefined, scope);
    await client.api('api/notes/search?q=x', undefined, scope);
    await client.api('api/state', undefined, { org: null });
    await client.authApi('auth/session');
    expect(calls.map((call) => call.url)).toEqual([
      '/workspace/api/notes?org=org%20a%2Fb',
      '/workspace/api/notes/search?q=x&org=org%20a%2Fb',
      '/workspace/api/state',
      '/workspace/auth/session',
    ]);
  });

  it('rides the workplace this tab stands in on every ordinary call that names none (note #628)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let standing: string | null = null;
    const client = createWorkspaceApi({ fetch: fetchStub(200, {}, calls), cookies: () => '', standingOrg: () => standing });
    await client.api('api/state', undefined, { org: null });
    standing = 'o-a';
    // Read at call time: the same client, the same call, now standing somewhere.
    await client.api('api/state');
    await client.api('api/agents/live');
    // A screen that names a workplace keeps it; one that names none inherits.
    await client.api('api/notes', undefined, { org: 'o-b' });
    await client.api('api/notes', undefined, { org: null });
    // Sign-in calls stand nowhere unless asked; the session read asks.
    await client.authApi('auth/logout', { method: 'POST' });
    await client.authApi('auth/session', undefined, { org: standing });
    // A path naming its own workplace keeps it — never a second copy.
    await client.api('api/drive?org=o-b&parent=');
    await client.api('api/drive/files?parent=&org=o-b', undefined, { org: 'o-c' });
    expect(calls.map((call) => call.url)).toEqual([
      '/workspace/api/state',
      '/workspace/api/state?org=o-a',
      '/workspace/api/agents/live?org=o-a',
      '/workspace/api/notes?org=o-b',
      '/workspace/api/notes?org=o-a',
      '/workspace/auth/logout',
      '/workspace/auth/session?org=o-a',
      '/workspace/api/drive?org=o-b&parent=',
      '/workspace/api/drive/files?parent=&org=o-b',
    ]);
  });

  it('reads the CSRF cookie on every call, production name first, dev name as fallback', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let jar = 'acc_csrf=dev-token; other=1';
    const client = createWorkspaceApi({ fetch: fetchStub(200, {}, calls), cookies: () => jar });
    await client.api('api/state');
    // The server rotates the token on sign-in: the next call must carry the
    // new one without anyone calling a refresh.
    jar = '__Host-acc_csrf=prod-token; acc_csrf=dev-token';
    await client.authApi('auth/logout', { method: 'POST' });
    const header = (index: number) => new Headers(calls[index]!.init.headers).get('X-CSRF-Token');
    expect(header(0)).toBe('dev-token');
    expect(header(1)).toBe('prod-token');
    expect(client.csrfToken()).toBe('prod-token');
  });

  it('sends no CSRF header when signed out, and keeps a caller-set one', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createWorkspaceApi({ fetch: fetchStub(200, {}, calls), cookies: () => '' });
    await client.api('api/state');
    await client.api('api/state', { headers: { 'X-CSRF-Token': 'explicit' } });
    expect(new Headers(calls[0]!.init.headers).has('X-CSRF-Token')).toBe(false);
    expect(new Headers(calls[1]!.init.headers).get('X-CSRF-Token')).toBe('explicit');
  });

  it('throws the server sentence with status, code and the whole body', async () => {
    const body = { error: 'Invalid username or one-time code.', code: 'invalid_credentials', retryAfterSeconds: 2 };
    const client = createWorkspaceApi({ fetch: fetchStub(401, body, []), cookies: () => '' });
    const error = await client.authApi('auth/login', jsonBody({ username: 'u', code: '1' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    const failure = error as WorkspaceApiError;
    expect(failure.message).toBe('Invalid username or one-time code.');
    expect(failure.status).toBe(401);
    expect(failure.code).toBe('invalid_credentials');
    expect(failure.body).toEqual(body);
  });

  it('describes a non-JSON failure by its status', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const client = createWorkspaceApi({ fetch: fetchImpl, cookies: () => '' });
    await expect(client.api('api/state')).rejects.toMatchObject({ message: 'Request failed (502)', status: 502, body: null });
  });

  // Note #1069: Adam's Chief of Staff chat on a phone read a successful
  // answer whose body never arrived whole as `null`, and crashed on `.orgId`.
  it('throws a success whose body was cut off on the way, rather than answering null (note #1069)', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"orgId":"o1","messa')); controller.error(new TypeError('Load failed')); },
    });
    const fetchImpl = vi.fn(async () => new Response(cut, { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const client = createWorkspaceApi({ fetch: fetchImpl, cookies: () => '' });
    const error = await client.api('api/recap/chat').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error).toMatchObject({ status: 200, code: ANSWER_UNREADABLE_CODE, message: ANSWER_UNREADABLE_SENTENCE });
  });

  it('throws a success that is not JSON — a truncated body or an edge page — as unreadable (note #1069)', async () => {
    for (const text of ['{"orgId":"o1","messages":[', '<html>please wait</html>']) {
      const fetchImpl = vi.fn(async () => new Response(text, { status: 200 })) as unknown as typeof fetch;
      const client = createWorkspaceApi({ fetch: fetchImpl, cookies: () => '' });
      await expect(client.api('api/recap/chat')).rejects.toMatchObject({ status: 200, code: ANSWER_UNREADABLE_CODE });
    }
  });

  it('still answers null for a success with no body at all, or a literal JSON null', async () => {
    for (const make of [() => new Response(null, { status: 204 }), () => new Response('', { status: 200 }), () => new Response('null', { status: 200 })]) {
      const client = createWorkspaceApi({ fetch: vi.fn(async () => make()) as unknown as typeof fetch, cookies: () => '' });
      await expect(client.api('api/thing')).resolves.toBeNull();
    }
  });

  it('jsonBody is a JSON POST', () => {
    const init = jsonBody({ a: 1 });
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('cookieValue decodes and tolerates a malformed neighbour', () => {
    expect(cookieValue('a=1; b=%7Bx%7D; c=%E0%A4%A', 'b')).toBe('{x}');
    expect(cookieValue('a=1; b=%7Bx%7D; c=%E0%A4%A', 'c')).toBe('');
    expect(cookieValue('', 'a')).toBe('');
  });
});
