import { Router } from 'express';

/**
 * The landing's short links, `agenticcloudcomputer.com/go/<code>` (notes
 * #1106, #1178). Letters that already went carry them, so the address never
 * changes; since note #1178 the codes, the visits and the preview cards are
 * the app's that made them (GO_LINKS_APP), and the platform only asks it.
 *
 * What never breaks: every answer is a 302 (or a preview card) with
 * Cache-Control: no-store, no cookie and no Referer; an unknown code, an app
 * that does not answer, or no app set all land on the home page.
 */
export const GO_LINK_ORIGIN = 'https://agenticcloudcomputer.com';
export const GO_LINK_PATH = '/go/';
/** How long the platform waits for the app that answers /go/. */
export const GO_FORWARD_TIMEOUT_MS = 2_500;

/**
 * Ask the app where a code leads: it records the visit and answers
 * `{ location: "/path" }` or `{ html }` (a chat app's preview card). A
 * location must be a path on the landing itself, so the platform's address
 * never sends anybody elsewhere. Anything else, a slow answer included, is
 * null: the reader goes home.
 */
export async function forwardGoLink(app: string, code: string, reader: { userAgent: string | null; method: string },
  fetchImpl: typeof fetch = fetch, timeoutMs = GO_FORWARD_TIMEOUT_MS): Promise<{ location: string } | { html: string } | null> {
  try {
    const response = await fetchImpl(`${app}/api/go/${encodeURIComponent(code.toLowerCase())}`, {
      headers: { 'x-go-user-agent': (reader.userAgent ?? '').slice(0, 512), 'x-go-method': reader.method, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return null;
    const answer = await response.json() as { location?: unknown; html?: unknown };
    if (typeof answer.location === 'string' && answer.location.startsWith('/') && !answer.location.startsWith('//') && !/[\\\r\n]/.test(answer.location)) {
      return { location: answer.location };
    }
    if (typeof answer.html === 'string' && answer.html.length > 0 && answer.html.length <= 64_000) return { html: answer.html };
    return null;
  } catch {
    return null;
  }
}

export function goLinkRoutes(opts: { forwardTo: () => string; fetchImpl?: typeof fetch; timeoutMs?: number }): Router {
  const router = Router();
  router.get(`${GO_LINK_PATH}:code`, async (req, res) => {
    const code = String(req.params.code ?? '');
    const app = opts.forwardTo();
    const answer = app ? await forwardGoLink(app, code, { userAgent: req.get('user-agent') ?? null, method: req.method }, opts.fetchImpl, opts.timeoutMs) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (answer && 'html' in answer) { res.type('html').status(200).send(answer.html); return; }
    res.redirect(302, `${GO_LINK_ORIGIN}${answer ? answer.location : '/'}`);
  });
  return router;
}
