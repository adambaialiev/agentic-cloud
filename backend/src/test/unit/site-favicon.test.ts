import { describe, expect, it, vi } from 'vitest';
import { SiteFavicons, declaredIcons, sniffImageType } from '../../services/site-favicon.js';

/**
 * A site's favicon, for its row in the Workspace's Sites card.
 *
 * The assertions that carry weight are the ones about what this refuses to do:
 * it never leaves the site's own origin (href or redirect), it never believes
 * a content-type over the bytes — which is the only thing separating a real
 * icon from a static host answering /favicon.ico with its index.html — and a
 * miss is remembered, or every open of the Workspace re-runs the whole chase.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 3),
]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(16, 9)]);
const SITE = 'https://shop.agentbuilt.app';

const html = (body: string) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});
const image = (bytes: Buffer, type = 'image/png') => new Response(bytes, {
  status: 200,
  headers: { 'content-type': type },
});
const missing = () => new Response('nope', { status: 404 });

/** A fetch stub over a URL→Response table; anything unlisted 404s. */
function stubFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL) => (routes[String(input)] ?? missing)());
}

const favicons = (fetchImpl: ReturnType<typeof stubFetch>) => (
  new SiteFavicons({ fetchImpl: fetchImpl as never })
);

describe('site favicon: what the page declares', () => {
  it('prefers an SVG, then the biggest declared size', () => {
    const urls = declaredIcons(`
      <html><head>
        <link rel="icon" href="/small.png" sizes="16x16">
        <link rel="apple-touch-icon" href="/apple.png">
        <link rel="icon" type="image/svg+xml" href="/mark.svg">
        <link rel="icon" href="/big.png" sizes="192x192">
      </head></html>`, SITE);
    // The row draws this at ~22 CSS px, which is 66 real pixels on a phone —
    // a 16px .ico is the one thing that looks WORSE than the glyph it replaces.
    expect(urls).toEqual([
      'https://shop.agentbuilt.app/mark.svg',
      'https://shop.agentbuilt.app/big.png',
      'https://shop.agentbuilt.app/apple.png',
    ]);
  });

  it('takes `shortcut icon`, skips `mask-icon`, and reads a relative href', () => {
    // A mask-icon is a flat monochrome silhouette for Safari's pinned tabs: an
    // icon, and never the one a person recognises.
    const urls = declaredIcons(`
      <head>
        <link rel="mask-icon" href="/pinned.svg" color="#000">
        <link rel="shortcut icon" href="assets/fav.png?v=2">
      </head>`, `${SITE}/index.html`);
    expect(urls).toEqual(['https://shop.agentbuilt.app/assets/fav.png?v=2']);
  });

  it('drops an href that leaves the site, and anything below the head', () => {
    // A favicon on someone else's CDN is a URL a hosted site CHOSE. Following
    // it would make this backend fetch whatever a page tells it to.
    const urls = declaredIcons(`
      <head>
        <link rel="icon" href="https://cdn.example.com/logo.png" sizes="180x180">
        <link rel="icon" href="http://shop.agentbuilt.app/insecure.png">
        <link rel="icon" href="/own.png">
      </head>
      <body><link rel="icon" href="/late.png"></body>`, SITE);
    expect(urls).toEqual(['https://shop.agentbuilt.app/own.png']);
  });
});

describe('site favicon: what the bytes are', () => {
  it('reads the file, not the label', () => {
    expect(sniffImageType(PNG, 'application/octet-stream')).toBe('image/png');
    expect(sniffImageType(ICO, 'text/plain')).toBe('image/x-icon');
    // The static-host trap: a missing /favicon.ico answered with index.html,
    // status 200. Nothing about the response says "miss" except the bytes.
    expect(sniffImageType(Buffer.from('<!DOCTYPE html><html>…'), 'image/x-icon')).toBeNull();
  });

  it('takes an SVG on the server\'s word, and only its word', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(sniffImageType(svg, 'image/svg+xml')).toBe('image/svg+xml');
    // SVG has no magic number, so an unlabelled document is not one — an HTML
    // page containing an inline <svg> would otherwise qualify.
    expect(sniffImageType(svg, 'text/html')).toBeNull();
  });
});

describe('site favicon: fetching one', () => {
  it('serves the icon a page declares', async () => {
    const fetchImpl = stubFetch({
      [SITE]: () => html('<head><link rel="icon" href="/logo.png" sizes="64x64"></head>'),
      [`${SITE}/logo.png`]: () => image(PNG),
    });
    const icon = await favicons(fetchImpl).get(SITE);
    expect(icon?.contentType).toBe('image/png');
    expect(icon?.body.equals(PNG)).toBe(true);
    expect(icon?.etag).toMatch(/^"[\w-]{27}"$/);
  });

  it('falls back to /favicon.ico, which most sites have and few mention', async () => {
    const fetchImpl = stubFetch({
      [SITE]: () => html('<head><title>Shop</title></head>'),
      [`${SITE}/favicon.ico`]: () => image(ICO, 'image/vnd.microsoft.icon'),
    });
    expect((await favicons(fetchImpl).get(SITE))?.contentType).toBe('image/x-icon');
  });

  it('keeps trying past a declared icon that is a 404 page', async () => {
    // Static hosts answer any missing path with index.html at status 200, so
    // "the file is there" is never the same question as "the fetch worked".
    const fetchImpl = stubFetch({
      [SITE]: () => html('<head><link rel="icon" href="/logo.png" sizes="64x64"></head>'),
      [`${SITE}/logo.png`]: () => html('<!DOCTYPE html><html>Not found</html>'),
      [`${SITE}/favicon.ico`]: () => image(ICO, 'image/x-icon'),
    });
    expect((await favicons(fetchImpl).get(SITE))?.contentType).toBe('image/x-icon');
  });

  it('takes an inline data: icon without a second request', async () => {
    const inline = `data:image/png;base64,${PNG.toString('base64')}`;
    const fetchImpl = stubFetch({
      [SITE]: () => html(`<head><link rel="icon" href="${inline}"></head>`),
    });
    const icon = await favicons(fetchImpl).get(SITE);
    expect(icon?.body.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect inside the site and refuses one that leaves it', async () => {
    const moved = (to: string) => new Response(null, { status: 301, headers: { location: to } });
    const inside = stubFetch({
      [SITE]: () => html('<head></head>'),
      [`${SITE}/favicon.ico`]: () => moved('/static/favicon.ico'),
      [`${SITE}/static/favicon.ico`]: () => image(PNG),
    });
    expect((await favicons(inside).get(SITE))?.body.equals(PNG)).toBe(true);

    const away = stubFetch({
      [SITE]: () => html('<head></head>'),
      [`${SITE}/favicon.ico`]: () => moved('https://evil.example.com/favicon.ico'),
      'https://evil.example.com/favicon.ico': () => image(PNG),
    });
    expect(await favicons(away).get(SITE)).toBeNull();
    // Not "fetched and discarded" — never contacted at all.
    expect(away.mock.calls.map(([url]) => String(url)))
      .not.toContain('https://evil.example.com/favicon.ico');
  });

  it('gives up on a body past the cap, however it is declared', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(512 * 1024, 1)]);
    const fetchImpl = stubFetch({
      [SITE]: () => html('<head></head>'),
      // No content-length, so the cap has to hold while the body streams.
      [`${SITE}/favicon.ico`]: () => new Response(huge, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    });
    expect(await favicons(fetchImpl).get(SITE)).toBeNull();
  });

  it('survives a site that is simply down', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await favicons(fetchImpl as never).get(SITE)).toBeNull();
  });
});

describe('site favicon: remembering', () => {
  it('fetches once for a hit, and once for a MISS', async () => {
    // The miss is the load-bearing half. Without it, every open of the
    // Workspace re-runs two requests per site that has no icon, forever.
    const found = stubFetch({
      [SITE]: () => html('<head><link rel="icon" href="/logo.png"></head>'),
      [`${SITE}/logo.png`]: () => image(PNG),
    });
    const hits = favicons(found);
    expect(await hits.get(SITE)).not.toBeNull();
    expect(await hits.get(SITE)).not.toBeNull();
    expect(found).toHaveBeenCalledTimes(2);

    const none = stubFetch({ [SITE]: () => html('<head></head>') });
    const misses = favicons(none);
    expect(await misses.get(SITE)).toBeNull();
    expect(await misses.get(SITE)).toBeNull();
    expect(none).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the entry has aged out', async () => {
    const fetchImpl = stubFetch({ [SITE]: () => html('<head></head>') });
    let clock = 1_000;
    const cache = new SiteFavicons({ fetchImpl: fetchImpl as never, now: () => clock });
    await cache.get(SITE);
    clock += 29 * 60 * 1000;
    await cache.get(SITE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += 2 * 60 * 1000;
    await cache.get(SITE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('runs one chase per site, however many callers arrive together', async () => {
    // The Workspace polls, and a cold list would otherwise start a fresh chain
    // per site on every poll while the first was still running.
    const fetchImpl = stubFetch({
      [SITE]: () => html('<head><link rel="icon" href="/logo.png"></head>'),
      [`${SITE}/logo.png`]: () => image(PNG),
    });
    const cache = favicons(fetchImpl);
    const [a, b, c] = await Promise.all([cache.get(SITE), cache.get(SITE), cache.get(SITE)]);
    expect(a?.etag).toBe(b?.etag);
    expect(b?.etag).toBe(c?.etag);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
