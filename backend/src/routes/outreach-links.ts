import { Router } from 'express';
import { OUTREACH_LINK_ORIGIN, OUTREACH_LINK_PATH } from '../shared/outreach.js';
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
 * Whatever happens, the answer is a redirect: an unknown code, a private
 * copy (which has no Outreach) or a store that fails all land on the home
 * page, because a link in a letter must never show an error. 302, never
 * cached, so every visit reaches us; no cookie is read or set.
 */
export function outreachLinkRoutes(outreach: () => Pick<OutreachService, 'visit'> | null): Router {
  const router = Router();
  router.get(`${OUTREACH_LINK_PATH}:code`, async (req, res) => {
    const service = outreach();
    let location = `${OUTREACH_LINK_ORIGIN}/`;
    if (service) {
      try {
        location = (await service.visit(String(req.params.code ?? ''), { userAgent: req.get('user-agent') ?? null, method: req.method })).location;
      } catch (error) {
        console.warn('[outreach] a link visit was not recorded:', error instanceof Error ? error.message : error);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, location);
  });
  return router;
}
