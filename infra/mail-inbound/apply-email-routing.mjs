#!/usr/bin/env node
/**
 * Point the zone's catch-all at the `mail-inbound` Worker — the one change
 * that makes every address on agenticcloudcomputer.com real (note #509).
 *
 * The zone change is scripted rather than clicked for the same reason the
 * preview-router's cache rules are: what production's mail does has to be
 * readable in the repo, and reversible by whoever finds it at 3am.
 *
 *   node apply-email-routing.mjs            # show what is configured now
 *   node apply-email-routing.mjs --on       # catch-all → the mail-inbound Worker
 *   node apply-email-routing.mjs --off      # catch-all → disabled + drop (the
 *                                           # state before slice 2)
 *
 * Needs CLOUDFLARE_API_TOKEN with Zone:Zone:Read + Zone:Email Routing
 * Rules:Edit on this zone (CLOUDFLARE_MAIL_TOKEN carries both):
 *   CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-email-routing.mjs --on
 *
 * WHAT IT WILL NOT TOUCH: the individual address rules, and hello@ in
 * particular. Those are matched before the catch-all, so the platform's own
 * forwarding keeps working exactly as it did; the script prints them and
 * stops if the one it knows about has disappeared, because that means
 * somebody has been editing this zone by hand and the rest of this script's
 * assumptions are worth re-reading.
 */

const ZONE_NAME = 'agenticcloudcomputer.com';
const WORKER = 'mail-inbound';
/** Rules that must survive a catch-all change, by the local part they match. */
const KNOWN_ADDRESS_RULES = ['hello'];

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('Set CLOUDFLARE_API_TOKEN (CLOUDFLARE_MAIL_TOKEN has the right scopes).');
  process.exit(1);
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const reason = (body.errors ?? []).map((error) => `${error.code} ${error.message}`).join('; ');
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${reason || ''}`.trim());
  }
  return body.result;
}

function describe(rule) {
  const matcher = (rule.matchers ?? [])
    .map((m) => (m.type === 'all' ? 'everything else' : `${m.field}=${m.value}`)).join(', ');
  const action = (rule.actions ?? [])
    .map((a) => `${a.type}${a.value?.length ? ` → ${a.value.join(', ')}` : ''}`).join(', ');
  return `${rule.enabled ? 'on ' : 'off'}  ${matcher || '(no matcher)'}  ⇒  ${action || '(no action)'}`;
}

const [zone] = await api(`/zones?name=${ZONE_NAME}`);
if (!zone) throw new Error(`This token cannot see the ${ZONE_NAME} zone.`);
const settings = await api(`/zones/${zone.id}/email/routing`);
const rules = await api(`/zones/${zone.id}/email/routing/rules`);
const catchAll = await api(`/zones/${zone.id}/email/routing/rules/catch_all`);

console.log(`zone ${ZONE_NAME} (${zone.id})`);
console.log(`email routing: ${settings.enabled ? 'enabled' : 'DISABLED'}`
  + `, plus-addressing ${settings.support_subaddress ? 'on' : 'off'}`);
console.log('address rules:');
for (const rule of rules) console.log(`  ${describe(rule)}`);
console.log(`catch-all:\n  ${describe(catchAll)}`);

const missing = KNOWN_ADDRESS_RULES.filter((local) => !rules.some(
  (rule) => (rule.matchers ?? []).some((m) => String(m.value ?? '').startsWith(`${local}@`)),
));
if (missing.length) {
  console.error(`\nExpected address rules are gone: ${missing.join(', ')}.`);
  console.error('Somebody has edited this zone by hand. Look before changing the catch-all.');
  process.exit(2);
}

const wanted = process.argv.includes('--on') ? 'on' : process.argv.includes('--off') ? 'off' : null;
if (!wanted) {
  console.log('\nNothing changed. Pass --on or --off.');
  process.exit(0);
}

const body = wanted === 'on'
  ? {
    name: 'Every address → the mail-inbound Worker (note #509)',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [WORKER] }],
  }
  : {
    // The state this zone was in before slice 2: no catch-all, so an address
    // nobody holds is refused by Email Routing itself.
    name: 'Catch-all (off)',
    enabled: false,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'drop' }],
  };

const updated = await api(`/zones/${zone.id}/email/routing/rules/catch_all`, {
  method: 'PUT',
  body: JSON.stringify(body),
});
console.log(`\ncatch-all now:\n  ${describe(updated)}`);
