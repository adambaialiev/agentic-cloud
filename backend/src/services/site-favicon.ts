/**
 * A site's own favicon, for the Sites rows in the Workspace Mini App.
 *
 * Every site row wore the same globe, which said "this is a website" to a
 * person who had just read the site's name and already knew that. The mark a
 * site is actually recognised by is its favicon — the one in the browser tab
 * of the thing they built — so the row wears that instead, and the globe
 * becomes what it should always have been: the fallback for a site that has
 * no icon yet.
 *
 * Fetched HERE rather than by the page, for three reasons. The Mini App's
 * webview would otherwise announce the user to every site in the list on every
 * open; a `<link rel=icon href=/logo.png>` is invisible to an `<img>` tag, so
 * the page could only ever guess `/favicon.ico`; and a static host that answers
 * a missing path with its own index.html would hand that `<img>` a page of HTML
 * to render as a picture. The bytes are sniffed here and anything that is not
 * an image is a miss, which is the only way to tell those two apart.
 *
 * SSRF is bounded by the caller, not by this file: the route looks the name up
 * in deployment storage first, so the only hosts ever fetched are live sites of
 * ours on our own apps domain. Inside a fetch, the rules are same-origin
 * (redirects included), https only, capped bodies, one short timeout.
 */

import { createHash } from 'node:crypto';

export interface SiteIcon {
  body: Buffer;
  contentType: string;
  /** Strong ETag over the bytes, so a re-opened Workspace re-sends nothing. */
  etag: string;
}

type FetchLike = typeof globalThis.fetch;

/**
 * A favicon changes about as often as a logo, and a stale one for a few hours
 * is invisible. A MISS is remembered too, and that is the load-bearing half:
 * without it, every open of the Workspace would re-fetch two URLs per site
 * that has no icon, forever.
 */
const ICON_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 60 * 1000;
/** The row shows a globe while this runs, so a slow site costs nothing. */
const REQUEST_TIMEOUT_MS = 4_000;
const PAGE_LIMIT_BYTES = 192 * 1024;
const ICON_LIMIT_BYTES = 256 * 1024;
/** Declared icons to try before `/favicon.ico`. Real pages list one or two. */
const MAX_DECLARED_CANDIDATES = 3;
const MAX_REDIRECTS = 2;
/** Entries kept across all accounts; oldest evicted. Sites per account are few. */
const CACHE_LIMIT = 200;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes ARE, which is not what the server said they are. A static
 * host serving index.html for a missing /favicon.ico labels it `text/html`
 * (caught by the header check) but plenty label it `application/octet-stream`
 * or nothing at all, and a `.ico` is routinely served as `text/plain`. Sniffing
 * is what makes "no icon" distinguishable from "an icon we cannot read".
 */
export function sniffImageType(body: Buffer, declared?: string): string | null {
  if (body.length < 4) return null;
  if (body.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  const head6 = body.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (body.length >= 12
    && body.subarray(0, 4).toString('latin1') === 'RIFF'
    && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // ICO: a 2-byte zero, then type 1 (icon). Type 2 is a cursor, which is not
  // a favicon however it was served.
  if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return 'image/x-icon';
  // SVG is text and has no magic number, so it is the one type that has to be
  // taken on the server's word — a bare `<svg…>` check would also accept an
  // HTML error page that happens to contain an inline icon.
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml' && /<svg[\s>]/i.test(body.subarray(0, 2048).toString('utf8'))) {
    return 'image/svg+xml';
  }
  return null;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/**
 * The icons a page declares, best first.
 *
 * "Best" is the largest one, and an SVG beats every raster: the row draws it
 * at about 22 CSS px, which is 66 real pixels on a phone, so a 16px .ico is
 * the one thing that genuinely looks worse than the glyph it replaced.
 */
export function declaredIcons(html: string, pageUrl: string): string[] {
  const head = html.split(/<\/head\s*>/i)[0] ?? html;
  const found: { href: string; rank: number; order: number }[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    // `mask-icon` is a flat monochrome silhouette for Safari's pinned tabs —
    // it is an icon, and it is never the one a person recognises.
    const wanted = rel.includes('icon')
      || rel.includes('apple-touch-icon')
      || rel.includes('apple-touch-icon-precomposed');
    if (!wanted) continue;
    const href = decodeEntities((attribute(tag, 'href') ?? '').trim());
    if (!href) continue;
    const type = (attribute(tag, 'type') ?? '').toLowerCase();
    const sizes = (attribute(tag, 'sizes') ?? '').toLowerCase();
    let rank: number;
    if (type === 'image/svg+xml' || /\.svg([?#]|$)/i.test(href) || /\bany\b/.test(sizes)) {
      rank = 4096;
    } else {
      const declared = [...sizes.matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1]));
      // An apple-touch-icon without a `sizes` is 180×180 by convention, and in
      // practice it is the biggest, cleanest icon most pages ship.
      rank = declared.length ? Math.max(...declared) : (rel.includes('icon') ? 32 : 180);
    }
    found.push({ href, rank, order: found.length });
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of found.sort((a, b) => b.rank - a.rank || a.order - b.order)) {
    const resolved = resolveIconUrl(item.href, pageUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    urls.push(resolved);
    if (urls.length >= MAX_DECLARED_CANDIDATES) break;
  }
  return urls;
}

/**
 * An href from the page, as an absolute URL we are willing to fetch — or
 * nothing. Same origin only: a favicon on someone else's CDN is a URL a site
 * we host chose, and following it would make this backend fetch whatever a
 * page tells it to. A `data:` icon needs no fetch at all and is kept as-is.
 */
function resolveIconUrl(href: string, pageUrl: string): string | null {
  if (/^data:image\//i.test(href)) return href;
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.host !== new URL(pageUrl).host) return null;
  url.hash = '';
  return url.toString();
}

/** `data:image/png;base64,…` → the bytes, checked like any other candidate. */
function decodeDataUrl(url: string): { body: Buffer; declared: string } | null {
  const match = url.match(/^data:([^;,]+)(;[^,]*)?,(.*)$/is);
  if (!match) return null;
  const declared = match[1]!.toLowerCase();
  const payload = match[3]!;
  const body = /;base64/i.test(match[2] ?? '')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return body.length ? { body, declared } : null;
}

interface Fetched {
  body: Buffer;
  declared?: string;
}

/**
 * One GET, bounded on every axis that could hurt: same-origin redirects only
 * (checked BEFORE each hop, so nothing off-domain is ever contacted), a hard
 * byte cap enforced while streaming rather than after, and one timeout across
 * the whole chain.
 */
async function fetchBounded(
  startUrl: string,
  limit: number,
  accept: string,
  fetchImpl: FetchLike,
): Promise<Fetched | null> {
  const origin = new URL(startUrl).host;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: { accept, 'user-agent': 'agentbuilt-workspace/1.0 (+favicon)' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return null;
      }
      if (next.protocol !== 'https:' || next.host !== origin) return null;
      url = next.toString();
      // The body of a redirect is nothing anyone wants, and undici holds the
      // connection until it is read or cancelled.
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok || !response.body) return null;
    const declared = response.headers.get('content-type') ?? undefined;
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks);
    return declared === undefined ? { body } : { body, declared };
  }
  return null;
}

async function fetchIcon(url: string, fetchImpl: FetchLike): Promise<SiteIcon | null> {
  const inline = url.startsWith('data:') ? decodeDataUrl(url) : null;
  const got = inline ?? await fetchBounded(url, ICON_LIMIT_BYTES, 'image/*', fetchImpl);
  if (!got) return null;
  const contentType = sniffImageType(got.body, got.declared);
  if (!contentType) return null;
  return {
    body: got.body,
    contentType,
    etag: `"${createHash('sha256').update(got.body).digest('base64url').slice(0, 27)}"`,
  };
}

/**
 * Resolve one site's icon: read what the page declares, then fall back to
 * `/favicon.ico`, which most sites have and few mention.
 */
async function resolveSiteIcon(siteUrl: string, fetchImpl: FetchLike): Promise<SiteIcon | null> {
  const origin = new URL(siteUrl).origin;
  let candidates: string[] = [];
  const page = await fetchBounded(siteUrl, PAGE_LIMIT_BYTES, 'text/html,*/*;q=0.5', fetchImpl)
    .catch(() => null);
  if (page) {
    const declared = (page.declared ?? '').toLowerCase();
    // A `service` site's root may answer with JSON, an image, anything — only
    // parse what says it is HTML.
    if (declared.includes('text/html') || declared.includes('application/xhtml')) {
      candidates = declaredIcons(page.body.toString('utf8'), siteUrl);
    }
  }
  const fallback = `${origin}/favicon.ico`;
  if (!candidates.includes(fallback)) candidates.push(fallback);
  for (const candidate of candidates) {
    const icon = await fetchIcon(candidate, fetchImpl).catch(() => null);
    if (icon) return icon;
  }
  return null;
}

/**
 * The icons, remembered. One fetch chain per site at a time (the Workspace
 * polls, and a cold list of five sites would otherwise start five chains per
 * poll), and a miss remembered as firmly as a hit.
 */
export class SiteFavicons {
  private readonly cache = new Map<string, { expires: number; icon: SiteIcon | null }>();
  private readonly inFlight = new Map<string, Promise<SiteIcon | null>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(opts: { fetchImpl?: FetchLike; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.now = opts.now ?? (() => Date.now());
  }

  /** The site's icon, or null when it has none we can use. Never throws. */
  async get(siteUrl: string): Promise<SiteIcon | null> {
    const hit = this.cache.get(siteUrl);
    if (hit && hit.expires > this.now()) return hit.icon;
    const running = this.inFlight.get(siteUrl);
    if (running) return running;

    const run = resolveSiteIcon(siteUrl, this.fetchImpl)
      .catch(() => null)
      .then((icon) => {
        this.remember(siteUrl, icon);
        return icon;
      })
      .finally(() => {
        if (this.inFlight.get(siteUrl) === run) this.inFlight.delete(siteUrl);
      });
    this.inFlight.set(siteUrl, run);
    return run;
  }

  private remember(siteUrl: string, icon: SiteIcon | null): void {
    // Re-inserting moves the key to the end of the Map's order, so the eviction
    // below drops the least recently REFRESHED entry.
    this.cache.delete(siteUrl);
    this.cache.set(siteUrl, { icon, expires: this.now() + (icon ? ICON_TTL_MS : MISS_TTL_MS) });
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
