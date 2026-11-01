import { randomInt } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { CloudflareAppsDns } from './deployment-service.js';
import { parseFlyServerRecordTarget } from './fly-sandbox-id.js';
import { PREVIEW_ADJECTIVES, PREVIEW_NOUNS } from './preview-name-words.js';

/**
 * How long the slug index may be reused before the agent records are read
 * again — the bound on how long a name can keep routing to an app its agent
 * has moved off by a path that does not come through here (none today).
 */
export const MAP_MAX_AGE_MS = 30_000;

/**
 * A slug the index does not know is looked up again once the index is this
 * old: a brand-new agent's record is written just AFTER {@link
 * PreviewDomainService.provision} returns, so its first visitor may arrive
 * before the index has it. Bounds a stream of unknown slugs (scanners) to one
 * read of the records per this interval.
 */
export const MISS_RECHECK_MS = 5_000;

/**
 * Branded preview hostnames for agent machines: `brave-otter-427.agentbuilt.app`
 * instead of the unmarketable `ia-<16 hex>.fly.dev` — with INSTANT TLS.
 *
 * Names are word-based (2026-08-09) because a preview link is a SHARED link;
 * see generateName. Slugs minted before that are 6 random characters and keep
 * working untouched — nothing here parses a name, and both shapes are valid
 * DNS labels. The preview-router Worker had to learn to accept the hyphen,
 * though, so a name change is not deployed until that Worker is.
 *
 * How a preview URL works (the Worker model, 2026-08-06 — replaced the
 * per-name Fly-certificate model the same day it shipped, killing its
 * ~5-minute certificate wait):
 *
 *   visitor → Cloudflare edge (proxied wildcard `*.agentbuilt.app`, TLS by
 *   the zone's universal cert — nothing to issue, live in ~1s) →
 *   `infra/preview-router` Worker (asks the backend which Fly app holds
 *   the slug, and caches the answer) → `<app>.fly.dev` (Fly's own wildcard cert secures the
 *   hop; Fly's edge wakes stopped machines exactly as before).
 *
 * The slug→app mapping is NOT stored in DNS any more (2026-10-13). It
 * used to be one `_map.<slug>` TXT record per agent, and the zone is on
 * Cloudflare's Free plan, which holds 200 records: at 2–4 agents per person
 * that capped the platform at a few dozen more people, with the overflow
 * silently falling back to fly.dev URLs. The agent records already hold the
 * answer (`previewHostname` + `serverId`), so the Worker now asks the backend
 * (`GET /api/preview-map/<slug>`, answered by {@link resolve}) and caches it at
 * the edge. One source of truth: a deleted agent's name stops resolving the
 * moment its record goes, and no record can be left behind. Provisioning is
 * therefore only choosing a free name. No certificates, no dedicated IPs,
 * no polling.
 *
 * HOSTED SITES TAKE THE SAME ROAD (2026-10-16, note #766). Until then each
 * `agentbuilt deploy` site had a grey-cloud CNAME of its own, which bypassed
 * the proxy — and spent one of the zone's 200 records per site, so a few
 * hundred sites would have been the ceiling. Now the same map answers for a
 * site's name (→ its `iapp-` app) and for every name it was renamed away
 * from (→ a redirect to its current address, which the Worker serves as a
 * 301), and a deploy, a rename and a delete write nothing to DNS at all. A
 * site's entry comes before an agent's with the same name, as its CNAME used
 * to take precedence over the wildcard record.
 *
 * The name belongs to the AGENT, not the machine: recycles and rebuilds mint
 * a fresh Fly app, and the record keeps its name while its `serverId` moves —
 * so the branded link outlives the machine, which the fly.dev URL never did.
 */
export class PreviewDomainService {
  constructor(
    private readonly opts: {
      /**
       * The Cloudflare zone, kept only to clear what older models left in it
       * and to step over names a record still holds. Null where there is no
       * zone at all — a private copy (note #804), whose own router answers
       * every name on its domain from this map and nothing else.
       */
      dns: CloudflareAppsDns | null;
      appsDomain: string;
      /**
       * Extra taken-name check beyond the DNS zone (the deployments table:
       * a pending-payment hosting site has no DNS record yet, but its name is
       * spoken for). Optional — a word name always carries a numeric suffix,
       * so overlap with a user-chosen site name stays vanishingly rare.
       */
      isNameTaken?: (name: string) => Promise<boolean>;
      /**
       * Every name on the apps domain and where it goes: a site's name and an
       * agent's slug → the Fly app that holds it, a site's former name → the
       * name it redirects to. First entry for a name wins, so the caller
       * lists sites before agents. The index behind {@link resolve} is rebuilt
       * from it at most once per {@link MAP_MAX_AGE_MS} (and at once after a
       * provision or release here, or when {@link invalidate} is called), so
       * a stream of unknown names costs map lookups, never a table scan each.
       */
      loadMappings?: () => Promise<Iterable<readonly [string, NameTarget]>>;
      log?: (message: string) => void;
      now?: () => number;
    },
  ) {}

  private index: { map: Map<string, NameTarget>; builtAt: number } | null = null;
  private building: Promise<Map<string, NameTarget>> | null = null;

  private log(message: string): void {
    (this.opts.log ?? ((m: string) => console.log(`[preview-domains] ${m}`)))(message);
  }

  url(name: string): string {
    return `https://${name}.${this.opts.appsDomain}`;
  }

  /**
   * `brave-otter-427` — an adjective, a noun and a number.
   *
   * Preview links get SHARED: forwarded in chat, read down a phone, typed
   * into someone else's browser. `zs35w3` survived none of that — it cannot
   * be dictated, remembered, or checked for typos, and it tells a stranger
   * receiving the link nothing about what it is. Two words do all three.
   *
   * `randomInt` is uniform by rejection sampling, so no modulo bias skews
   * which words appear (`% list.length` would, since 256 is not a multiple of
   * either list's length).
   *
   * The number is 100–999, never zero-padded: a leading zero is the digit a
   * listener drops, and `brave-otter-7` would be a dead link rather than a
   * wrong one. ~180 × ~185 × 900 ≈ 30 million names — see pickFreeName for
   * what happens on a collision.
   */
  static generateName(): string {
    const adjective = PREVIEW_ADJECTIVES[randomInt(PREVIEW_ADJECTIVES.length)];
    const noun = PREVIEW_NOUNS[randomInt(PREVIEW_NOUNS.length)];
    return `${adjective}-${noun}-${randomInt(100, 1000)}`;
  }

  /**
   * Choose the branded hostname for `appName`'s machine and return the short
   * name. Pass `existingName` on rebuild/recycle to keep the agent's name;
   * the new app is picked up from the agent record once the caller writes
   * its `serverId`. Nothing is written anywhere here: the agent record IS the
   * mapping (see the class comment).
   */
  async provision(appName: string, existingName?: string): Promise<string> {
    const name = existingName ?? (await this.pickFreeName());
    this.invalidate();
    this.log(`${name}.${this.opts.appsDomain} → ${appName}`);
    return name;
  }

  /**
   * Forget the name. The agent record's removal is what stops it resolving;
   * this clears what agents provisioned under the older models left in the
   * zone: the `_map.<slug>` TXT mapping (until 2026-10-13) and a grey-cloud
   * CNAME (the certificate era) — harmless no-ops otherwise.
   */
  async release(name: string): Promise<void> {
    this.invalidate();
    if (!this.opts.dns) return;
    await this.opts.dns.deleteTxt(`_map.${name}`);
    await this.opts.dns.deleteCname(name);
  }

  /**
   * Where a name on the apps domain goes — the Fly app that holds it, or the
   * name it redirects to — or null when nobody holds it. What the
   * preview-router Worker asks for every name it has not cached.
   */
  async resolve(slug: string): Promise<NameTarget | null> {
    const hit = (await this.mappings()).get(slug);
    if (hit) return hit;
    const builtAt = this.index?.builtAt ?? 0;
    if ((this.opts.now ?? Date.now)() - builtAt < MISS_RECHECK_MS) return null;
    this.invalidate();
    return (await this.mappings()).get(slug) ?? null;
  }

  /**
   * Drop the index so the next {@link resolve} reads the records afresh. The
   * deployment service calls this whenever a site's name or status changes,
   * so a new site answers on its first visit and a rename or delete is seen
   * at once rather than at the index's next rebuild.
   */
  invalidate(): void {
    this.index = null;
  }

  private async mappings(): Promise<Map<string, NameTarget>> {
    const now = (this.opts.now ?? Date.now)();
    if (this.index && now - this.index.builtAt < MAP_MAX_AGE_MS) return this.index.map;
    if (!this.opts.loadMappings) return new Map();
    // One rebuild at a time: concurrent misses share it.
    this.building ??= (async () => {
      try {
        const map = new Map<string, NameTarget>();
        for (const [slug, app] of await this.opts.loadMappings!()) {
          if (!map.has(slug)) map.set(slug, app);
        }
        this.index = { map, builtAt: now };
        return map;
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  private async pickFreeName(): Promise<string> {
    this.invalidate();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const name = PreviewDomainService.generateName();
      if (await this.opts.isNameTaken?.(name)) continue;
      // Another agent's name, or a CNAME at the slug (hosting site or
      // legacy preview), disqualifies it.
      if ((await this.mappings()).has(name)) continue;
      if (await this.opts.dns?.recordExists(name)) continue;
      return name;
    }
    throw new Error('Could not find a free preview name after 5 attempts.');
  }
}

/**
 * Where a name on the apps domain goes: the Fly app that serves it, or (a
 * site's former name) the name it now redirects to.
 */
export type NameTarget = { app: string } | { redirect: string };

/**
 * A preview slug: one DNS label, hyphens inside only. The same rule as the
 * preview-router Worker's, so nothing it forwards is refused here and nothing
 * else reaches a lookup.
 */
const PREVIEW_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Every hosted site's names, read from the deployment records: its name →
 * the `iapp-` app its machine runs in, and each name it was renamed away
 * from → its current name, which the Worker answers with a 301 (the old
 * address keeps arriving, as `rename` promises, with no DNS record and no
 * certificate for it anywhere).
 *
 * A site routes while it has a machine and is live or paused — a paused site
 * keeps its name and comes back on its own, so its address stays its own. A
 * site still being set up, stopped by an operator or destroyed is not in the
 * map: its name answers "No such preview." exactly as any name nobody holds,
 * which is also what a brand-new site's address answered before its record
 * existed under the CNAME model.
 */
export function siteMappingsFromDeployments(
  deployments: Iterable<{ name: string; status: string; flyApp?: string; formerNames?: string[] }>,
): Array<[string, NameTarget]> {
  const pairs: Array<[string, NameTarget]> = [];
  for (const site of deployments) {
    const app = site.flyApp?.trim();
    if (!app || (site.status !== 'live' && site.status !== 'payment-lapsed')) continue;
    pairs.push([site.name, { app }]);
    for (const former of site.formerNames ?? []) {
      if (former !== site.name) pairs.push([former, { redirect: site.name }]);
    }
  }
  return pairs;
}

/**
 * Every agent's preview mapping, read from the records: the slug it was
 * given and the Fly app its machine runs in now — the `serverId`, or the app
 * reserved for a machine still being built. An agent with no name or no app
 * has nothing to route to and is left out.
 */
export function previewMappingsFromProfiles(
  profiles: Iterable<{ telegram?: { agents?: Record<string, { previewHostname?: string; serverId?: string; provisioningAppName?: string }> } }>,
): Array<[string, NameTarget]> {
  const pairs: Array<[string, NameTarget]> = [];
  for (const profile of profiles) {
    for (const agent of Object.values(profile.telegram?.agents ?? {})) {
      const slug = agent.previewHostname?.trim();
      const app = parseFlyServerRecordTarget(agent.serverId)?.appName ?? agent.provisioningAppName?.trim();
      if (slug && app) pairs.push([slug, { app }]);
    }
  }
  return pairs;
}

/**
 * `GET /api/preview-map/:slug` — the preview-router Worker's question, "where
 * does `<slug>.agentbuilt.app` go?". `{ app }` names the Fly app that serves
 * it (an agent machine or a site's `iapp-`); `{ redirect: <url> }` is a
 * renamed site's old address, which the Worker answers with a 301. Public on
 * purpose: it tells nobody more than visiting the name does (the TXT records
 * it replaces were readable by anyone), and it cannot list names. `no-store`,
 * because the Worker keeps its own copy and decides how long.
 */
export function previewMapHandler(previews: Pick<PreviewDomainService, 'resolve' | 'url'>): RequestHandler {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const slug = String(req.params.slug ?? '').toLowerCase();
    if (!PREVIEW_SLUG.test(slug)) return res.status(404).json({ error: 'No such preview.' });
    try {
      const target = await previews.resolve(slug);
      if (!target) return res.status(404).json({ error: 'No such preview.' });
      if ('redirect' in target) return res.json({ redirect: previews.url(target.redirect) });
      return res.json({ app: target.app });
    } catch (error) {
      console.warn(`[preview-domains] lookup of ${slug} failed:`, error);
      return res.status(503).json({ error: 'Preview lookup unavailable.' });
    }
  };
}
