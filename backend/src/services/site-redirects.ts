import type { RequestHandler } from 'express';
import type { DeploymentStorage } from './deployment-storage.js';

/**
 * Old addresses, after a rename.
 *
 * A rename used to leave the old name serving the same site from the same
 * machine — two live addresses, forever. That kept every shared link working,
 * which was the point, but it meant the new name never actually became the
 * site's name: anyone arriving on the old one stayed there, saw the old
 * address in their bar, and forwarded it onward. A move that never finishes
 * moving.
 *
 * So the old address now REDIRECTS. It is still not deleted and still not
 * released — the guarantee that matters (every link already handed out keeps
 * arriving) is unchanged. What changes is where it lands: on the new address,
 * with the path and query it was asked for.
 *
 * The redirect is served here, by the backend, rather than by the site's own
 * machine — a `service` deployment runs the USER's code and there is nowhere
 * in it to put a redirect. `rename` repoints the old hostname's DNS at this
 * host, Caddy terminates TLS for it (on-demand, gated by `tlsAsk` below), and
 * these two handlers do the rest.
 */

/** `shop.agentbuilt.app` → `shop`, and nothing for any other domain. */
export function siteNameFromHost(host: string | undefined, appsDomain: string): string | null {
  if (!host) return null;
  // A Host header may carry a port, and is case-insensitive.
  const hostname = host.toLowerCase().split(':')[0]!;
  const suffix = `.${appsDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const name = hostname.slice(0, -suffix.length);
  // One label only: `a.b.agentbuilt.app` is not a site of ours.
  return name && !name.includes('.') ? name : null;
}

/**
 * Is this hostname one we are willing to hold a certificate for? Caddy asks
 * before issuing, and this is the whole security of on-demand TLS: without
 * it, anyone could point a DNS record at this host and have us mint them a
 * certificate (and answer on their hostname) on demand.
 *
 * Yes ONLY for a name some live deployment has been renamed away from. Not
 * for its current name — that resolves to the site's own machine and never
 * reaches us — and not for a name nobody has ever used.
 */
export function siteTlsAskHandler(opts: {
  storage: DeploymentStorage;
  appsDomain: string;
}): RequestHandler {
  return async (req, res) => {
    // Caddy sends `?domain=`; accept `host=` too so the endpoint can be
    // checked by hand without reading Caddy's source to remember which.
    const domain = String(req.query.domain ?? req.query.host ?? '');
    const name = siteNameFromHost(domain, opts.appsDomain);
    if (!name) return res.status(403).end();
    const doc = await opts.storage.getByName(name).catch(() => null);
    const isFormerName = Boolean(doc)
      && doc!.status !== 'destroyed'
      && doc!.name !== name
      && (doc!.formerNames ?? []).includes(name);
    return res.status(isFormerName ? 200 : 403).end();
  };
}

/**
 * 301 an old address to the site's current one, keeping the path and query.
 *
 * Permanent, not temporary: the site really has moved, and a browser that
 * remembers saves the hop. Renaming BACK undoes it at the DNS layer — the
 * name points at the machine again and never reaches this handler — which is
 * the one case where a cached 301 could bite, so `rename` repoints that
 * record itself rather than leaving it to expire.
 */
export function siteRedirectHandler(opts: {
  storage: DeploymentStorage;
  appsDomain: string;
}): RequestHandler {
  return async (req, res, next) => {
    const name = siteNameFromHost(req.headers.host, opts.appsDomain);
    if (!name) return next();
    const doc = await opts.storage.getByName(name).catch(() => null);
    // Only a live site with a different current name is a move. Anything else
    // falls through to the ordinary 404 rather than inventing a destination.
    if (!doc || doc.status === 'destroyed' || doc.name === name) return next();
    if (!(doc.formerNames ?? []).includes(name)) return next();
    const target = `https://${doc.name}.${opts.appsDomain}${req.originalUrl}`;
    return res.redirect(301, target);
  };
}
