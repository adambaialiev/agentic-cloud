/**
 * One hostname for the product and its front door (knowledge page
 * "public-addresses", 2026-09-26).
 *
 * The stateful Workspace runs on the control-plane backend. Cloudflare Pages
 * invokes this function for every address on agenticcloudcomputer.com except
 * the static files _routes.json excludes, and it decides between two things:
 * the landing site (`context.next()`, the asset server) and the backend
 * (a byte-for-byte proxy to one fixed origin, so the browser keeps this
 * hostname in its address bar and receives host-only session cookies).
 *
 * What stays on the landing site: its pages (`/docs`, `/terms`, the
 * variants) and its files, which _routes.json keeps off this function
 * altogether. EVERYTHING ELSE goes to the backend — `/workspace` and what
 * is under it, every word the Workspace registry owns, and, since slice 5
 * of public-addresses, every word nobody owns: `/adam` is a person's public
 * page, and the backend answers a word nobody holds with the shell's own
 * "nothing at this address", so the landing site's catch-all never gets to
 * 301 a public address home. The root `/` itself is the landing page for a
 * visitor and the Workspace for a signed-in browser, told apart by the
 * CSRF cookie the backend sets beside the HttpOnly session one (the same
 * signal index.html reads).
 *
 * The fixed upstream is also the SSRF boundary: no request header, query
 * parameter or route segment can choose a host.
 */
const WORKSPACE_UPSTREAM_ORIGIN = 'https://api.agenticcloudcomputer.com';

/**
 * The first path segments that belong to the LANDING SITE: its pages, and
 * the retired addresses public/_redirects still forwards. Kept as a literal
 * because this file runs at the edge, built apart from the backend; the
 * test in src/lib/workspace-proxy.test.ts pins it to LANDING_FIRST_SEGMENTS
 * (backend/src/shared/handles.ts), so a landing route added there fails
 * that test until its word is added here — and the same list is what keeps
 * a person from taking the word as their name.
 */
export const LANDING_FIRST_SEGMENTS = [
  'terms', 'privacy', 'claude-code-in-the-cloud', 'codex-in-the-cloud', 'ai-agents-for-your-team',
  'four-phases', 'docs', 'teams', 'og-preview', 'product', 'own-cloud', 'why-fly',
  // Retired, still redirected at the edge.
  'pricing', 'tour', 'guides', 'refunds', 'shots', 'en', 'ru', 'open-source', 'request-access',
  'leaderboard', 'private-copy',
];

const LANDING_WORDS = new Set(LANDING_FIRST_SEGMENTS);

/** The signed-in signal: either Workspace cookie, under either name — the
 *  HttpOnly session or the CSRF half beside it (index.html reads only the
 *  latter, having no access to the former; the edge sees both). */
const SIGNED_IN_COOKIE = /(?:^|;\s*)(?:__Host-acc_session|acc_session|__Host-acc_csrf|acc_csrf)=[^;\s]/;

export function routesToBackend(pathname, cookie, search = '') {
  const first = pathname.split('/').filter(Boolean)[0];
  if (first === undefined) {
    // `?stay` opens the front page anyway (note #526): the one way a
    // signed-in person reads the landing page.
    if (new URLSearchParams(search).has('stay')) return false;
    return SIGNED_IN_COOKIE.test(cookie || '');
  }
  return !LANDING_WORDS.has(first);
}

export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  if (!routesToBackend(incoming.pathname, context.request.headers.get('cookie'), incoming.search)) {
    return context.next();
  }
  // Build from the fixed origin rather than mutating `host`: the URL standard
  // keeps an incoming non-default port when a host setter omits one, which
  // made local :8799 previews try the production host on :8799 too.
  const upstream = new URL(`${incoming.pathname}${incoming.search}`, WORKSPACE_UPSTREAM_ORIGIN);

  // Preserve method, streaming body, cookies, CSRF/Origin headers, ranges and
  // conditional reads explicitly. A Request is valid as the FIRST constructor
  // argument, but not as RequestInit; passing it second silently turns a POST
  // back into GET in standards implementations. `duplex` is required by Node's
  // test implementation for a streamed body and accepted by the Workers
  // runtime. The subrequest URL supplies Host; the browser never learns it.
  const hasBody = context.request.method !== 'GET' && context.request.method !== 'HEAD';
  const init = {
    method: context.request.method,
    headers: context.request.headers,
    redirect: 'manual',
    ...(hasBody ? { body: context.request.body, duplex: 'half' } : {}),
  };
  return fetch(new Request(upstream.toString(), init));
}
