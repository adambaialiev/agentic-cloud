#!/usr/bin/env node
/**
 * One-shot zone config: make origin Cache-Control authoritative on
 * *.agentbuilt.app (issue #966).
 *
 * Without this rule the zone defaults apply to everything the preview-router
 * Worker proxies: static extensions (.js/.css/…) are edge-cached and the
 * default Browser Cache TTL rewrites the response to `max-age=14400`, so a
 * machine that serves `Cache-Control: no-cache` still sees its deploys stale
 * for 4 hours in both the edge and every visitor's browser. One cache rule
 * (edge_ttl + browser_ttl = respect_origin) fixes both layers; machines that
 * send no Cache-Control at all keep today's default behavior.
 *
 * Scoped to `*.agentbuilt.app` subdomains — machine previews and hosted
 * sites. The apex is only a 301 to agenticcloudcomputer.com (infra/apex-redirect).
 *
 * Two layers, and the cache rule only fixes one (verified live 2026-08-06):
 * with the rule active the edge revalidates every asset against the origin
 * (cf-cache-status EXPIRED instead of HIT — content staleness gone), but the
 * zone-level "Browser Cache TTL" setting (default 4h) still stamps
 * `cache-control: max-age=14400` on Worker-proxied responses, overriding the
 * rule's browser_ttl. That is a zone SETTING, not a rule, so this script
 * also PATCHes it to 0 ("Respect Existing Headers"). The expression matches
 * `*.fly.dev` too because the cacheable request is the Worker's subrequest
 * to the machine's Fly origin (worker.js:68); the only fly.dev traffic in
 * this zone's cache is the router's own subrequests.
 *
 * Deploy (manual, like the Worker itself — see wrangler.toml):
 *   CLOUDFLARE_API_TOKEN=$(cat ~/.secrets/cloudflare_zone_token) \
 *     node apply-cache-rules.mjs [--purge]
 * The token needs Zone:Zone:Read + Zone:Cache Rules:Edit + Zone:Zone
 * Settings:Edit (agentbuilt.app); --purge additionally needs Zone:Cache
 * Purge:Purge and drops already-cached stale assets so the rule takes
 * effect immediately.
 *
 * Re-running is safe: the phase entrypoint is replaced wholesale, but the
 * script aborts if the zone has cache rules it doesn't own (edit RULES here
 * and re-run instead).
 */

const ZONE_NAME = 'agentbuilt.app';
const PHASE = 'http_request_cache_settings';
const OWNED = '[preview-router]';

const RULES = [
  {
    description: `${OWNED} machine previews + hosted sites: respect origin Cache-Control at edge and browser`,
    expression: `(http.host wildcard "*.${ZONE_NAME}") or (http.host wildcard "*.fly.dev")`,
    action: 'set_cache_settings',
    action_parameters: {
      // bypass_by_default, not respect_origin: a matching cache rule makes
      // responses cache-ELIGIBLE (HTML included), so respect_origin stored
      // headerless responses (naive `python3 -m http.server` origins) for
      // the zone default TTL and served them stale for hours — see #966
      // follow-up. Previews must default to FRESH: nothing is stored unless
      // the origin opts in with its own Cache-Control (e.g. fingerprinted
      // assets `max-age=...`), which is then fully honored.
      edge_ttl: { mode: 'bypass_by_default' },
      browser_ttl: { mode: 'respect_origin' },
    },
  },
];

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('Set CLOUDFLARE_API_TOKEN (Zone:Zone:Read + Zone:Cache Rules:Edit).');
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

const zones = await cf(`/zones?name=${ZONE_NAME}`);
if (zones.length !== 1) throw new Error(`zone ${ZONE_NAME} not found with this token`);
const zoneId = zones[0].id;

// The entrypoint 404s until the phase has ever had a rule — treat as empty.
const current = await cf(`/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`).catch(() => null);
const foreign = (current?.rules ?? []).filter((r) => !r.description?.startsWith(OWNED));
if (foreign.length > 0) {
  console.error(`Zone has ${foreign.length} cache rule(s) this script does not own — not replacing:`);
  for (const r of foreign) console.error(`  - ${r.description ?? r.expression}`);
  process.exit(1);
}

await cf(`/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`, {
  method: 'PUT',
  body: JSON.stringify({ rules: RULES }),
});
console.log(`Cache rule applied to ${ZONE_NAME}: respect origin Cache-Control on *.${ZONE_NAME}`);

// The cache rule alone cannot stop the zone-level Browser Cache TTL from
// stamping max-age=14400 on Worker-proxied responses — only the setting can.
try {
  await cf(`/zones/${zoneId}/settings/browser_cache_ttl`, {
    method: 'PATCH',
    body: JSON.stringify({ value: 0 }),
  });
  console.log('Browser Cache TTL set to "Respect Existing Headers".');
} catch (err) {
  console.error(`Browser Cache TTL NOT set — token lacks Zone Settings:Edit? (${err.message})`);
  console.error('Dashboard fallback: Caching → Configuration → Browser Cache TTL → Respect Existing Headers.');
  process.exitCode = 1;
}

if (process.argv.includes('--purge')) {
  await cf(`/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    body: JSON.stringify({ purge_everything: true }),
  });
  console.log('Edge cache purged — stale assets are gone now rather than at TTL expiry.');
}
