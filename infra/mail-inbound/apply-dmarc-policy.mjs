#!/usr/bin/env node
/**
 * What the rest of the internet does with mail that only CLAIMS to be us
 * (note #509, follow-up to slice 4).
 *
 * `p=none` is monitoring: a receiving server notices the forgery and delivers
 * it anyway. `p=quarantine` asks it to put the forgery in spam. The record is
 * one TXT on the zone, and it governs EVERY sender on the domain at once —
 * the replies (root) and the sign-in links (updates.) included — which is why
 * tightening it runs a preflight first instead of just writing the record.
 *
 *   node apply-dmarc-policy.mjs               # show what is published now
 *   node apply-dmarc-policy.mjs --quarantine  # forgeries go to spam
 *   node apply-dmarc-policy.mjs --none        # back to monitoring (rollback)
 *
 * Needs CLOUDFLARE_API_TOKEN with Zone:DNS:Edit on this zone
 * (CLOUDFLARE_MAIL_TOKEN carries it):
 *   CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-dmarc-policy.mjs
 *
 * The preflight: DMARC passes when SPF or DKIM passes *and* aligns with the
 * From domain, so every sender of ours needs its DKIM key and its envelope
 * SPF published here. Both Resend senders do. Forwarding (hello@ → Gmail)
 * breaks SPF by design and keeps DKIM, which is enough — that is why a
 * forwarded address does not appear in this list.
 */

const ZONE_NAME = 'agenticcloudcomputer.com';
const DMARC_NAME = `_dmarc.${ZONE_NAME}`;

/** Every From domain we legitimately send as, and the records that align it. */
const SENDERS = [
  { domain: ZONE_NAME, what: 'replies to inbound mail (slice 4)' },
  { domain: `updates.${ZONE_NAME}`, what: 'sign-in links' },
];

const POLICIES = {
  none: 'v=DMARC1; p=none;',
  // rua= is where Gmail and the rest post their daily aggregate reports, so
  // tightening the policy is also the moment we start seeing who forges us.
  quarantine: `v=DMARC1; p=quarantine; rua=mailto:hello@${ZONE_NAME};`,
};

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

const [zone] = await api(`/zones?name=${ZONE_NAME}`);
if (!zone) throw new Error(`This token cannot see the ${ZONE_NAME} zone.`);
const txt = await api(`/zones/${zone.id}/dns_records?type=TXT&per_page=100`);
const byName = new Map(txt.map((record) => [record.name, record]));
const current = byName.get(DMARC_NAME);

console.log(`zone ${ZONE_NAME} (${zone.id})`);
console.log(`_dmarc: ${current ? current.content : '(no record — DMARC is off entirely)'}`);
console.log('senders:');
const unaligned = [];
for (const sender of SENDERS) {
  const dkim = byName.get(`resend._domainkey.${sender.domain}`);
  const spf = byName.get(`send.${sender.domain}`);
  if (!dkim || !spf) unaligned.push(sender.domain);
  console.log(`  ${sender.domain}  DKIM ${dkim ? 'published' : 'MISSING'}`
    + `, envelope SPF ${spf ? 'published' : 'MISSING'}  — ${sender.what}`);
}

const wanted = process.argv.includes('--quarantine') ? 'quarantine'
  : process.argv.includes('--none') ? 'none' : null;
if (!wanted) {
  console.log('\nNothing changed. Pass --quarantine or --none.');
  process.exit(0);
}

// Loosening is always safe; tightening is what can send our own mail to spam.
if (wanted === 'quarantine' && unaligned.length) {
  console.error(`\n${unaligned.join(', ')} cannot satisfy DMARC on its own.`);
  console.error('Publish its DKIM key and envelope SPF before asking receivers to');
  console.error('quarantine what fails — otherwise the first thing quarantined is us.');
  process.exit(2);
}

// Records written years apart differ in whether the quotes are part of the
// stored content, so compare what the record MEANS, not how it is spelled.
const unquote = (value) => String(value ?? '').trim().replace(/^"(.*)"$/s, '$1');
const content = POLICIES[wanted];
if (unquote(current?.content) === content) {
  console.log(`\nAlready ${wanted}. Nothing to do.`);
  process.exit(0);
}

const body = { type: 'TXT', name: '_dmarc', content, ttl: 300 };
const updated = current
  ? await api(`/zones/${zone.id}/dns_records/${current.id}`, { method: 'PUT', body: JSON.stringify(body) })
  : await api(`/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
console.log(`\n_dmarc now: ${updated.content}`);
console.log('Rollback is this script with --none; the TTL is 300s.');
