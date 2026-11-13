import { Router } from 'express';
import { OUTREACH_LINK_ORIGIN, OUTREACH_LINK_PATH, outreachLinkPreviewPage, outreachPreviewApp, type OutreachLink } from '../shared/outreach.js';
import type { OutreachService } from '../services/outreach.js';

/**
 * The short links in the outreach letters (note #1106; Adam, 9 Nov 2026,
 * 17:48 UTC): agenticcloudcomputer.com/go/<code>. The front page's edge
 * function hands every first word it does not own to this backend, so the
 * link lives on our own domain with no new host. Each company has two codes
 * (OutreachService.withLinks): one for the home page, one for the page
 * written for agents, /workplace.md. A visit is a redirect with the UTM data
 * and a touch on that company's timeline (OutreachService.visit).
 *
 * Whatever happens, a person or an agent gets a redirect: an unknown code, a private
 * copy (which has no Outreach) or a store that fails all land on the home
 * page, because a link in a letter must never show an error. 302, never
 * cached, so every visit reaches us; no cookie is read or set. A link-preview
 * app (note #1148) gets a 200 page of preview tags for the same link instead.
 */
/** How long the platform waits for the app that answers /go/ (note #1178). */
export const GO_FORWARD_TIMEOUT_MS = 2_500;

/**
 * Ask the app that answers the landing's /go/ links where a code leads
 * (note #1178): it records the visit and answers `{ location: "/path" }` or
 * `{ html }` (a chat app's preview card). A location must be a path on the
 * landing itself, so the platform's address never sends anybody elsewhere.
 * Anything else, a slow answer included, is null: the reader goes home.
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

export function outreachLinkRoutes(outreach: () => Pick<OutreachService, 'visit'> | null,
  opts: { forwardTo?: () => string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Router {
  const router = Router();
  router.get(`${OUTREACH_LINK_PATH}:code`, async (req, res) => {
    const code = String(req.params.code ?? '');
    const app = opts.forwardTo?.() ?? '';
    if (app) {
      const answer = await forwardGoLink(app, code, { userAgent: req.get('user-agent') ?? null, method: req.method }, opts.fetchImpl, opts.timeoutMs);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (answer && 'html' in answer) { res.type('html').status(200).send(answer.html); return; }
      res.redirect(302, `${OUTREACH_LINK_ORIGIN}${answer ? answer.location : '/'}`);
      return;
    }
    const service = outreach();
    let location = `${OUTREACH_LINK_ORIGIN}/`;
    let link: OutreachLink = 'home';
    if (service) {
      try {
        const visit = await service.visit(code, { userAgent: req.get('user-agent') ?? null, method: req.method });
        location = visit.location;
        link = visit.link ?? 'home';
      } catch (error) {
        console.warn('[outreach] a link visit was not recorded:', error instanceof Error ? error.message : error);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // A chat or social app drawing a preview (note #1148) gets the link's
    // card instead of the redirect: workplace.md and own-cloud.md are plain
    // Markdown with no tags to draw from. Its fetch is on the timeline as a
    // `preview`, not a visit by a person.
    if (outreachPreviewApp(req.get('user-agent'))) {
      const shortUrl = `${OUTREACH_LINK_ORIGIN}${OUTREACH_LINK_PATH}${encodeURIComponent(code.toLowerCase())}`;
      res.type('html').status(200).send(outreachLinkPreviewPage(link, shortUrl));
      return;
    }
    res.redirect(302, location);
  });
  return router;
}
