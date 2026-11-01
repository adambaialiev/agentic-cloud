#!/usr/bin/env node
/**
 * Delete the `_map.<slug>` TXT records agent previews USED to be routed by.
 *
 * Until 2026-10-13 every agent's branded preview name was one TXT record in
 * the agentbuilt.app zone, which Cloudflare's Free plan caps at 200 records —
 * a ceiling on how many agents the platform could ever have. The
 * preview-router Worker now asks the backend instead (GET /api/preview-map/
 * <slug>, answered from the agent records), so these records route nothing
 * and only use up the zone. Run this ONCE, after that Worker is deployed and
 * a preview link has been seen working through it: before then, the TXT
 * records are still what the old Worker reads, and deleting them takes every
 * agent's preview link down.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/drop-preview-txt-mappings.mjs                     # dry run
 *   node scripts/drop-preview-txt-mappings.mjs --apply --worker-is-live
 *
 * The dry run lists every record beside what the backend answers for its
 * slug: `same` (the backend routes it to the same app), `no agent` (a mapping
 * left behind by an agent that is gone — the new Worker already 404s it) or
 * `differs` (the backend wins under the new Worker). A slug the backend
 * cannot answer stops the run before anything is deleted: the lookup has to
 * be working for these records to be safe to lose.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
for (const envPath of [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const token = process.env.CLOUDFLARE_APPS_DNS_TOKEN?.trim();
const zoneId = process.env.CLOUDFLARE_APPS_ZONE_ID?.trim();
const backend = (process.env.PREVIEW_MAP_ORIGIN?.trim() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
if (!token || !zoneId) {
  console.error('Need CLOUDFLARE_APPS_DNS_TOKEN and CLOUDFLARE_APPS_ZONE_ID (run with backend.env loaded).');
  process.exit(1);
}
if (apply && !args.includes('--worker-is-live')) {
  console.error('--apply also needs --worker-is-live: deploy infra/preview-router first and see a preview link'
    + ' answer through it. Until then these records are what routes every agent\'s link.');
  process.exit(1);
}

async function cloudflare(pathAndQuery, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${pathAndQuery} failed (${res.status}): ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body;
}

const records = [];
for (let page = 1; ; page += 1) {
  const body = await cloudflare(`/dns_records?type=TXT&per_page=100&page=${page}`);
  records.push(...(body.result ?? []).filter((r) => r?.name?.startsWith('_map.')));
  if (page >= (body.result_info?.total_pages ?? 1)) break;
}

const plan = [];
for (const record of records) {
  const slug = record.name.slice('_map.'.length).split('.')[0];
  const txtApp = String(record.content ?? '').replace(/^"|"$/g, '').trim();
  const res = await fetch(`${backend}/api/preview-map/${encodeURIComponent(slug)}`).catch((error) => error);
  if (res instanceof Error || (res.status !== 200 && res.status !== 404)) {
    console.error(`The backend could not answer for ${slug} (${res instanceof Error ? res.message : res.status}).`
      + ' Nothing deleted: the lookup that replaces these records has to work first.');
    process.exit(1);
  }
  const backendApp = res.status === 200 ? (await res.json()).app : null;
  const verdict = backendApp === null ? 'no agent' : backendApp === txtApp ? 'same' : `differs (backend: ${backendApp})`;
  plan.push({ record, slug, txtApp, verdict });
  console.log(`${slug.padEnd(28)} ${txtApp.padEnd(22)} ${verdict}`);
}

const usage = await cloudflare('/dns_records/usage').catch(() => null);
console.log(`\n${plan.length} TXT mapping(s)`
  + (usage?.result ? `; the zone holds ${usage.result.record_usage} of ${usage.result.record_quota} records` : ''));

if (!apply) {
  console.log('DRY RUN — nothing deleted. Re-run with --apply --worker-is-live once the new Worker is deployed.');
  process.exit(0);
}

let deleted = 0;
for (const { record, slug } of plan) {
  try {
    await cloudflare(`/dns_records/${record.id}`, { method: 'DELETE' });
    deleted += 1;
  } catch (error) {
    console.warn(`could not delete _map.${slug}: ${error.message}`);
  }
}
const after = await cloudflare('/dns_records/usage').catch(() => null);
console.log(`deleted ${deleted} of ${plan.length}`
  + (after?.result ? `; the zone now holds ${after.result.record_usage} of ${after.result.record_quota} records` : ''));
process.exit(deleted === plan.length ? 0 : 1);
