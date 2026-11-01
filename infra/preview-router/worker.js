/**
 * Preview router: gives every agent machine AND every hosted site an
 * instant-TLS branded URL on agentbuilt.app.
 *
 * Runs on the route `*.agentbuilt.app/*`. Cloudflare's universal wildcard
 * certificate terminates TLS (that is the whole point — no per-name
 * certificate issuance, no 5-minute wait), and this Worker forwards the
 * request to the Fly app that holds the name, whose `*.fly.dev` cert secures
 * the origin hop. Fly's edge still wakes stopped machines (autostart), so
 * wake-on-traffic is untouched.
 *
 * The name→app mapping lives in the backend, which reads it off the agent
 * and deployment records (`GET /api/preview-map/<name>`,
 * PreviewDomainService.resolve). It used to be a `_map.<slug>` TXT record
 * per agent, resolved over DNS-over-HTTPS — until the zone's 200-record
 * ceiling (Cloudflare Free) turned out to be a cap on how many agents the
 * platform could ever have (2026-10-13). Hosted sites followed on 2026-10-16
 * (note #766): each had a grey-cloud CNAME of its own, which bypassed this
 * Worker and spent a record per site. Now a site's name answers `{ app }`
 * like an agent's, and a name a site was renamed away from answers
 * `{ redirect }`, which this Worker serves as a 301 to the site's current
 * address with the path and query kept.
 *
 * Answers are cached at this edge: fresh for MAP_TTL_SECONDS, and kept far
 * longer as a fallback for while the backend restarts, so a link that worked
 * a minute ago keeps working through a deploy. Still no KV namespace and no
 * Cloudflare API credentials at runtime.
 *
 * The only names that do NOT come through here are the zone's few fixed
 * records (git, the apex) and whatever grey-cloud CNAMEs are still being
 * phased out: an explicit record takes precedence over the wildcard.
 */

const APPS_DOMAIN = 'agentbuilt.app';
const BACKEND = 'https://api.agenticcloudcomputer.com';
const MAP_TTL_SECONDS = 300;
const STALE_TTL_SECONDS = 7 * 24 * 3600;
const LOOKUP_TIMEOUT_MS = 5000;
// A site machine Fly's edge has just woken answers 502/503 for the seconds
// between "started" and its server listening — and a slow boot can take
// half a minute (adam-baialiev, 2026-10-16 19:20 UTC: the first request hung
// 35.8 s and came back 502 while Caddy started at 19:21:07). A visitor's first
// click must get a slow page, not an error page: a plain read (GET/HEAD) that
// meets one of these is asked again every WAKE_RETRY_DELAY_MS for up to
// WAKE_RETRY_TOTAL_MS after the first answer, each retry cut off at what is
// left of that budget, so the visitor's whole wait stays near a minute even
// when Fly itself takes 36 s to answer. Anything with a body is never repeated.
//
// A policy choice, not a detection (Rosa's review, 2026-10-16): Fly's own
// gateway error carries the same headers as an app's answer, so an app that
// answers 503 on purpose, or a preview whose server is simply not running,
// also makes its visitor wait this budget before seeing the same error.
const WAKE_RETRY_STATUSES = new Set([502, 503]);
const WAKE_RETRY_DELAY_MS = 3000;
const WAKE_RETRY_TOTAL_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cached(body, seconds) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` },
  });
}

/**
 * A DNS label: hyphens allowed INSIDE only. Word-based preview names
 * (`brave-otter-427`) are hyphenated; the older 6-character slugs and
 * user-chosen site names match too. The same rule as the backend's
 * `previewMapHandler`, and the slug is interpolated into the lookup URL, so
 * keeping this to label characters is also what makes that safe.
 */
const NAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Where a redirect may point: another name on this domain, nothing else. */
const REDIRECT_URL = new RegExp(`^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${APPS_DOMAIN.replace(/\./g, '\\.')}$`);

/**
 * The backend's answer, validated: `{ app }` for a name a Fly app holds, or
 * `{ redirect }` for a renamed site's old name. The app name goes into a URL
 * we fetch and the redirect into a Location header — never pass on either
 * unvalidated.
 */
function targetFrom(body) {
  const app = typeof body?.app === 'string' ? body.app.trim() : '';
  if (/^[a-z0-9-]{1,63}$/.test(app)) return { app };
  const redirect = typeof body?.redirect === 'string' ? body.redirect.trim() : '';
  if (REDIRECT_URL.test(redirect)) return { redirect };
  return null;
}

/**
 * `{ target }` for a mapped name — `{ app }` or `{ redirect }` — `{ target:
 * null }` for one nobody holds, and `{ target: null, unavailable: true }` when
 * the backend cannot say and this edge has never seen the name.
 */
async function resolveApp(slug) {
  // Cache API keyed on the lookup URL (a second key for the long-lived copy).
  // The URLs are only cache keys; nothing is ever served from them directly.
  const lookupUrl = `${BACKEND}/api/preview-map/${slug}`;
  const freshKey = new Request(lookupUrl);
  const staleKey = new Request(`${lookupUrl}?stale`);
  const cache = caches.default;
  const fresh = await cache.match(freshKey);
  if (fresh) return { target: targetFrom(await fresh.json().catch(() => null)) };

  const response = await fetch(lookupUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (response?.status === 404) {
    // The agent is gone (or never was): its old answer must not outlive it.
    // Misses are not cached — a brand-new agent's first visitor would
    // otherwise get a 404 for the whole TTL.
    await cache.delete(staleKey);
    return { target: null };
  }
  if (response?.ok) {
    const target = targetFrom(await response.json().catch(() => null));
    if (target) {
      await cache.put(freshKey, cached(target, MAP_TTL_SECONDS));
      await cache.put(staleKey, cached(target, STALE_TTL_SECONDS));
    }
    return { target };
  }
  // The backend is down or restarting: the last answer this edge had beats
  // a dead link.
  const stale = await cache.match(staleKey);
  if (stale) return { target: targetFrom(await stale.json().catch(() => null)) };
  return { target: null, unavailable: true };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const [slug, ...rest] = url.hostname.split('.');
    if (rest.join('.') !== APPS_DOMAIN || !NAME_LABEL.test(slug)) {
      return new Response('No such preview.\n', { status: 404 });
    }
    const { target, unavailable } = await resolveApp(slug);
    if (!target) {
      return unavailable
        ? new Response('This preview cannot be reached right now. Try again in a minute.\n', {
          status: 503,
          headers: { 'Retry-After': '30' },
        })
        : new Response('No such preview.\n', { status: 404 });
    }
    if (target.redirect) {
      // A renamed site's old address: permanent, keeping the path and query,
      // exactly what the backend's own site-redirects handler did when the
      // old name was CNAMEd to it.
      return Response.redirect(`${target.redirect}${url.pathname}${url.search}`, 301);
    }
    const originalHost = url.hostname;
    url.hostname = `${target.app}.fly.dev`;
    url.port = '';
    // Forward verbatim (method, headers, body, websocket upgrades). The Host
    // header follows the new URL, which is what Fly's edge routes on; the
    // name the visitor typed rides along for an app that builds links from
    // it (a Workers subrequest cannot carry a foreign Host).
    const forward = (signal) => {
      const forwarded = new Request(url, request);
      forwarded.headers.set('X-Forwarded-Host', originalHost);
      return signal ? fetch(forwarded, { signal }) : fetch(forwarded);
    };
    let response = await forward();
    const plainRead = (request.method === 'GET' || request.method === 'HEAD')
      && request.headers.get('Upgrade') === null;
    if (plainRead && WAKE_RETRY_STATUSES.has(response.status)) {
      const deadline = Date.now() + WAKE_RETRY_TOTAL_MS;
      while (Date.now() + WAKE_RETRY_DELAY_MS < deadline) {
        await sleep(WAKE_RETRY_DELAY_MS);
        // Cut this ask off at what is left of the budget (a timer-driven
        // abort, so the budget is one clock: the same one sleep() runs on).
        const cutoff = new AbortController();
        const timer = setTimeout(() => cutoff.abort(), Math.max(1, deadline - Date.now()));
        try {
          response = await forward(cutoff.signal);
        } catch {
          // The budget ran out mid-ask: the last answer Fly gave stands.
          break;
        } finally {
          clearTimeout(timer);
        }
        if (!WAKE_RETRY_STATUSES.has(response.status)) break;
      }
    }
    return response;
  },
};
