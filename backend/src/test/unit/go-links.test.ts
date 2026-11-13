import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forwardGoLink, goLinkRoutes } from '../../routes/go-links.js';
import { isReservedHandle } from '../../shared/handles.js';
import { SITE_PREVIEW_IMAGE } from '../../shared/site-image.js';

/**
 * The landing's /go/<code> links (notes #1106, #1178): the address stays the
 * platform's, because letters that went carry it; the app that made a code
 * says where it leads. Never off the landing, home when anything fails.
 */
const SITE = 'https://outreach.agentbuilt.app';

describe('the /go/ forwarder (note #1178)', () => {
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('takes a path on the landing or a preview card, and nothing else', async () => {
    const reader = { userAgent: 'Mozilla/5.0', method: 'GET' };
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { location: '/?utm_source=outreach' }))).toEqual({ location: '/?utm_source=outreach' });
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { html: '<!doctype html><title>x</title>' }))).toEqual({ html: '<!doctype html><title>x</title>' });
    for (const location of ['//evil.test/', 'https://evil.test/', '/\\evil.test', 'relative', '/a\r\nSet-Cookie: x=1']) {
      expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { location }))).toBeNull();
    }
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(500, { location: '/' }))).toBeNull();
    const slow = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await forwardGoLink(SITE, 'abc234', reader, slow, 50)).toBeNull();
  });

  it('asks the app with the reader\'s word, and lands the reader on the landing, home when the app fails', async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    let reply: () => Response = () => new Response(JSON.stringify({ location: '/workplace.md?utm_content=northwind' }), { status: 200 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      asked.push({ url, headers: init.headers as Record<string, string> });
      return reply();
    }) as unknown as typeof fetch;
    const app = express();
    app.use(goLinkRoutes({ forwardTo: () => SITE, fetchImpl }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const go = await fetch(`${base}/go/ABC234`, { redirect: 'manual', headers: { 'user-agent': 'Claude-User/1.0' } });
      expect(go.status).toBe(302);
      expect(go.headers.get('location')).toBe('https://agenticcloudcomputer.com/workplace.md?utm_content=northwind');
      expect(go.headers.get('cache-control')).toBe('no-store');
      expect(asked[0]).toMatchObject({ url: `${SITE}/api/go/abc234`, headers: { 'x-go-user-agent': 'Claude-User/1.0', 'x-go-method': 'GET' } });
      reply = () => new Response(JSON.stringify({ html: '<!doctype html><title>card</title>' }), { status: 200 });
      const card = await fetch(`${base}/go/abc234`, { redirect: 'manual' });
      expect(card.status).toBe(200);
      expect(await card.text()).toBe('<!doctype html><title>card</title>');
      reply = () => new Response('down', { status: 503 });
      const home = await fetch(`${base}/go/abc234`, { redirect: 'manual' });
      expect(home.status).toBe(302);
      expect(home.headers.get('location')).toBe('https://agenticcloudcomputer.com/');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the /go/ word and the site picture (notes #1106, #1178)', () => {
  it('lands every code home, never cached, when no app answers /go/; and keeps the word from anyone\'s address', async () => {
    const app = express();
    app.use(goLinkRoutes({ forwardTo: () => '' }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const go = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/go/abc234`, { redirect: 'manual' });
      expect(go.status).toBe(302);
      expect(go.headers.get('location')).toBe('https://agenticcloudcomputer.com/');
      expect(go.headers.get('cache-control')).toBe('no-store');
      expect(go.headers.get('set-cookie')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(isReservedHandle('go')).toBe(true);
  });

  it('keeps the site picture equal to the home page\'s own', () => {
    const indexHtml = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'index.html'), 'utf8');
    const meta = (key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(indexHtml)?.[1];
    expect(SITE_PREVIEW_IMAGE.url).toBe(meta('og:image'));
    expect(SITE_PREVIEW_IMAGE.alt).toBe(meta('og:image:alt'));
    expect(String(SITE_PREVIEW_IMAGE.width)).toBe(meta('og:image:width'));
  });
});
