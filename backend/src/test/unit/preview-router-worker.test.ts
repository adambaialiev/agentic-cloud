import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PreviewDomainService } from '../../services/preview-domain-service.js';

/**
 * The preview-router Worker (`infra/preview-router/worker.js`) is the other
 * half of PreviewDomainService: the service answers `GET /api/preview-map/<slug>`
 * from the agent records and the Worker asks it. It is deployed separately with wrangler and cannot import
 * backend code, so the two agree only by convention — and the convention that
 * bites is the slug pattern. When names became hyphenated words, a Worker
 * still rejecting hyphens would 404 EVERY new preview link while every test
 * on the service side stayed green. Hence this test, which loads the real
 * worker file rather than a copy of its rules.
 *
 * Loaded through a computed specifier so `tsc` (rootDir: src) never pulls the
 * .js file into the backend program.
 */
const WORKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/preview-router/worker.js',
);

let worker: { fetch: (request: Request) => Promise<Response> };

beforeAll(async () => {
  worker = (await import(/* @vite-ignore */ pathToFileURL(WORKER_PATH).href)).default;
});

/**
 * The edge the Worker runs on: a Cache API (a Map, so what the Worker stores
 * is really there on the next request) and fetch, which answers the backend
 * lookup with `lookup` and anything else as the origin.
 */
function stubEdge(lookup: string | null | 'down' | { redirect: string }, store = new Map<string, Response>()) {
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn(async (key: Request) => store.get(key.url)?.clone()),
      put: vi.fn(async (key: Request, response: Response) => { store.set(key.url, response.clone()); }),
      delete: vi.fn(async (key: Request) => store.delete(key.url)),
    },
  });
  const fetchMock = vi.fn(async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.agenticcloudcomputer.com/api/preview-map/')) {
      if (lookup === 'down') throw new Error('connect ECONNREFUSED');
      if (lookup === null) return new Response(JSON.stringify({ error: 'No such preview.' }), { status: 404 });
      const body = typeof lookup === 'string' ? { app: lookup } : lookup;
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(`origin:${new URL(url).hostname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preview-router worker', () => {
  it('routes a word-based slug to the mapped Fly app', async () => {
    const { fetchMock } = stubEdge('ia-emma');

    const response = await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/page'));

    expect(await response.text()).toBe('origin:ia-emma.fly.dev');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.agenticcloudcomputer.com/api/preview-map/brave-otter-427');
  });

  it('still routes the older random slugs', async () => {
    stubEdge('ia-legacy');

    const response = await worker.fetch(new Request('https://zs35w3.agentbuilt.app/'));

    expect(await response.text()).toBe('origin:ia-legacy.fly.dev');
  });

  it('accepts every name the generator can mint', async () => {
    for (let i = 0; i < 100; i += 1) {
      stubEdge('ia-app');
      const name = PreviewDomainService.generateName();
      const response = await worker.fetch(new Request(`https://${name}.agentbuilt.app/`));
      expect(response.status, `rejected ${name}`).toBe(200);
    }
  });

  it('404s a slug that is not a DNS label, without asking the backend', async () => {
    const { fetchMock } = stubEdge('ia-app');

    // Case is not in this list on purpose: the URL parser lowercases the
    // hostname before the Worker ever sees it, as DNS itself does.
    for (const bad of ['-leading', 'trailing-', 'has_underscore', 'dotted%2eslug']) {
      const response = await worker.fetch(new Request(`https://${bad}.agentbuilt.app/`));
      expect(response.status, `accepted ${bad}`).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unmapped slug', async () => {
    stubEdge(null);

    const response = await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));

    expect(response.status).toBe(404);
  });

  it('answers repeat visits from the edge, without asking again', async () => {
    const { fetchMock } = stubEdge('ia-emma');

    await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));
    await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/other'));

    const lookups = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/preview-map/'));
    expect(lookups).toHaveLength(1);
  });

  it('keeps a known link working while the backend is down', async () => {
    const { store } = stubEdge('ia-emma');
    await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));
    // The fresh copy has expired; only the long-lived one is left.
    store.delete('https://api.agenticcloudcomputer.com/api/preview-map/brave-otter-427');

    stubEdge('down', store);
    const response = await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));

    expect(await response.text()).toBe('origin:ia-emma.fly.dev');
  });

  it('says "try again" rather than "no such preview" when the backend is down and the name is new here', async () => {
    const { fetchMock } = stubEdge('down');

    const response = await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));

    expect(response.status).toBe(503);
    // The Worker's own 503 is built before any forward: no origin ask, no
    // wake retry (Rosa's review).
    expect(fetchMock.mock.calls.filter(([input]) => !String(typeof input === 'string' ? input : input.url).includes('/api/preview-map/'))).toHaveLength(0);
  });

  it('forgets a deleted agent: its long-lived copy goes when the backend says the name is free', async () => {
    const { store } = stubEdge('ia-emma');
    await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));
    store.delete('https://api.agenticcloudcomputer.com/api/preview-map/brave-otter-427');

    stubEdge(null, store);
    expect((await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'))).status).toBe(404);

    // Even if the backend then goes down, the name stays dead.
    stubEdge('down', store);
    expect((await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'))).status).toBe(503);
  });

  it('routes a hosted site exactly like an agent, and tells the app the name it was reached by', async () => {
    // Since note #766 a site has no DNS record of its own: its name comes
    // through the wildcard like every other, and the map says `iapp-…`.
    const { fetchMock } = stubEdge('iapp-756ba29a608f');

    const response = await worker.fetch(new Request('https://school.agentbuilt.app/pupils?year=3'));

    expect(await response.text()).toBe('origin:iapp-756ba29a608f.fly.dev');
    const forwarded = fetchMock.mock.calls.find(([input]) => typeof input !== 'string')?.[0] as Request;
    expect(forwarded.url).toBe('https://iapp-756ba29a608f.fly.dev/pupils?year=3');
    expect(forwarded.headers.get('x-forwarded-host')).toBe('school.agentbuilt.app');
  });

  it('asks a waking site again instead of handing the visitor Fly\'s 502 (adam-baialiev, 2026-10-16)', async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock } = stubEdge('iapp-0c709e977024');
      // Fly's edge answers 502 while the machine boots, then the page.
      let originAsks = 0;
      fetchMock.mockImplementation(async (input: Request | string) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://api.agenticcloudcomputer.com/api/preview-map/')) {
          return new Response(JSON.stringify({ app: 'iapp-0c709e977024' }), { headers: { 'Content-Type': 'application/json' } });
        }
        originAsks += 1;
        if (originAsks <= 3) return new Response('Bad Gateway', { status: 502, headers: { 'Retry-After': '60' } });
        return new Response('<h1>Adam</h1>', { status: 200 });
      });
      const pending = worker.fetch(new Request('https://adam-baialiev.agentbuilt.app/cv.pdf'));
      await vi.advanceTimersByTimeAsync(12_000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<h1>Adam</h1>');
      expect(originAsks).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuts a slow retry off at the budget, so the whole wait stays bounded even when Fly itself is slow (Rosa\'s review)', async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock } = stubEdge('iapp-0c709e977024');
      let originAsks = 0;
      // Every ask at Fly hangs 36 s before its 502 — the incident's shape, on
      // every attempt. Without a cut-off three asks would hold the visitor 114 s.
      fetchMock.mockImplementation(async (input: Request | string, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://api.agenticcloudcomputer.com/api/preview-map/')) {
          return new Response(JSON.stringify({ app: 'iapp-0c709e977024' }), { headers: { 'Content-Type': 'application/json' } });
        }
        originAsks += 1;
        const signal = init?.signal ?? (typeof input === 'string' ? undefined : input.signal);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('Bad Gateway', { status: 502 })), 36_000);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'TimeoutError')); });
        });
      });
      const begun = Date.now();
      let answeredAt = 0;
      const pending = worker.fetch(new Request('https://adam-baialiev.agentbuilt.app/')).then((r) => { answeredAt = Date.now(); return r; });
      await vi.advanceTimersByTimeAsync(120_000);
      const response = await pending;
      expect(response.status).toBe(502);
      // First ask 36 s, one retry cut off at the 30 s budget: about 69 s, never 114.
      expect(originAsks).toBe(2);
      expect(answeredAt - begun).toBeLessThanOrEqual(70_000);
      expect(answeredAt - begun).toBeGreaterThanOrEqual(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a site that stays down after the budget, and never repeats a request with a body', async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock } = stubEdge('iapp-0c709e977024');
      let originAsks = 0;
      fetchMock.mockImplementation(async (input: Request | string) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://api.agenticcloudcomputer.com/api/preview-map/')) {
          return new Response(JSON.stringify({ app: 'iapp-0c709e977024' }), { headers: { 'Content-Type': 'application/json' } });
        }
        originAsks += 1;
        return new Response('Service Unavailable', { status: 503 });
      });
      const pending = worker.fetch(new Request('https://adam-baialiev.agentbuilt.app/'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await pending).status).toBe(503);
      // One first ask plus one every three seconds for thirty seconds.
      expect(originAsks).toBeGreaterThanOrEqual(10);
      expect(originAsks).toBeLessThanOrEqual(11);

      originAsks = 0;
      const post = worker.fetch(new Request('https://adam-baialiev.agentbuilt.app/api', { method: 'POST', body: 'x' }));
      await vi.advanceTimersByTimeAsync(70_000);
      expect((await post).status).toBe(503);
      expect(originAsks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a renamed site\'s old name as a 301 to the new address, path and query kept', async () => {
    stubEdge({ redirect: 'https://school.agentbuilt.app' });

    const response = await worker.fetch(new Request('https://eldiyar-math.agentbuilt.app/grade/5?tab=homework'));

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://school.agentbuilt.app/grade/5?tab=homework');
  });

  it('remembers a redirect at the edge like any other answer', async () => {
    const { fetchMock } = stubEdge({ redirect: 'https://school.agentbuilt.app' });

    await worker.fetch(new Request('https://eldiyar-math.agentbuilt.app/'));
    const second = await worker.fetch(new Request('https://eldiyar-math.agentbuilt.app/other'));

    expect(second.status).toBe(301);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/preview-map/'))).toHaveLength(1);
  });

  it('never redirects off this domain, whatever the backend says', async () => {
    for (const bad of ['https://evil.example.com', 'http://school.agentbuilt.app', 'https://a.b.agentbuilt.app', 'https://school.agentbuilt.app/path']) {
      stubEdge({ redirect: bad });
      const response = await worker.fetch(new Request('https://eldiyar-math.agentbuilt.app/'));
      expect(response.status, bad).toBe(404);
    }
  });

  it('never forwards to an app name that is not a plain label', async () => {
    const { fetchMock } = stubEdge('evil.example.com/x');

    const response = await worker.fetch(new Request('https://brave-otter-427.agentbuilt.app/'));

    expect(response.status).toBe(404);
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith('https://api.agenticcloudcomputer.com/'))).toBe(true);
  });
});
