#!/usr/bin/env node
/**
 * Move hosted sites off their one-CNAME-each DNS records (note #766).
 *
 * Until 2026-10-16 every `agentbuilt deploy` site had a grey-cloud CNAME in
 * the agentbuilt.app zone (`<name>` → `<token>.<iapp-app>.fly.dev`), which
 * Cloudflare's Free plan caps at 200 records — a ceiling on how many sites
 * the platform could ever have. A site's name now reaches its machine the
 * way an agent's preview link does: the proxied wildcard record sends it to
 * the preview-router Worker, which asks the backend (GET /api/preview-map/
 * <name>, answered from the deployment records) and forwards to the app. An
 * explicit CNAME takes precedence over the wildcard, so each of these records
 * is what keeps its site OFF the new path — and routes nothing the new path
 * does not, once the backend and the Worker both know about sites.
 *
 * One site at a time, old record kept until the check passes:
 *   1. the backend's map must answer the name with the SAME app the record
 *      points at (a differing or missing answer stops that site);
 *   2. the Worker path must already serve the site: the request goes to a
 *      Cloudflare edge address with the site's hostname as SNI and Host —
 *      which bypasses the record, so the proof is made while it still
 *      exists — and must come back from Fly (`fly-request-id`) below 500;
 *   3. only then is the record deleted, and the same probe is repeated
 *      after the delete.
 * A failure at any step leaves that site's record where it was, and the run
 * goes on to the next site; the summary names what was left.
 *
 * Redirect records (a renamed site's old name, CNAMEd to the backend host,
 * which 301s it) are listed but left alone unless `--include-redirects`: the
 * Worker answers those names with the same 301 from the map, so they can go
 * the same way, each checked to redirect to the same address first.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/drop-site-cnames.mjs                     # dry run: plan + probes, no delete
 *   node scripts/drop-site-cnames.mjs --apply --only school
 *   node scripts/drop-site-cnames.mjs --apply             # every site, one by one
 *
 * Resolvers that cached a record keep answering it for up to its TTL (300 s)
 * after the delete; the probe here goes to the edge directly, so it does not
 * wait on that.
 */
import dotenv from 'dotenv';
import dns from 'node:dns/promises';
import https from 'node:https';
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
const includeRedirects = args.includes('--include-redirects');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const token = process.env.CLOUDFLARE_APPS_DNS_TOKEN?.trim();
const zoneId = process.env.CLOUDFLARE_APPS_ZONE_ID?.trim();
const appsDomain = process.env.APPS_DOMAIN?.trim() || 'agentbuilt.app';
const backend = (process.env.PREVIEW_MAP_ORIGIN?.trim() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
if (!token || !zoneId) {
  console.error('Need CLOUDFLARE_APPS_DNS_TOKEN and CLOUDFLARE_APPS_ZONE_ID (run with backend.env loaded).');
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

/**
 * One request to a Cloudflare edge address with `hostname` as SNI and Host:
 * what a visitor gets once the name has no record of its own, provable while
 * it still has one.
 */
function probeEdge(edgeIp, hostname, pathname = '/') {
  return new Promise((resolve) => {
    const req = https.request({
      host: edgeIp,
      servername: hostname,
      headers: { Host: hostname, 'User-Agent': 'drop-site-cnames' },
      path: pathname,
      method: 'GET',
      timeout: 15_000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({
        status: res.statusCode,
        fly: Boolean(res.headers['fly-request-id']),
        location: res.headers.location ?? null,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ error: error.message }));
    req.end();
  });
}

function describe(probe) {
  if (probe.error) return `error: ${probe.error}`;
  return `${probe.status}${probe.fly ? ' from Fly' : ''}${probe.location ? ` → ${probe.location}` : ''}`;
}

// The wildcard's answer is a Cloudflare edge: any name nobody holds resolves
// to it.
const [edgeIp] = await dns.resolve4(`drop-site-cnames-probe-${Date.now()}.${appsDomain}`);
if (!edgeIp) {
  console.error(`Could not resolve the wildcard record of ${appsDomain}.`);
  process.exit(1);
}

const records = [];
for (let page = 1; ; page += 1) {
  const body = await cloudflare(`/dns_records?type=CNAME&per_page=100&page=${page}`);
  records.push(...(body.result ?? []));
  if (page >= (body.result_info?.total_pages ?? 1)) break;
}

const suffix = `.${appsDomain}`;
const sites = [];
const redirects = [];
for (const record of records) {
  if (!record.name.endsWith(suffix) || record.name === appsDomain) continue;
  const name = record.name.slice(0, -suffix.length);
  if (name.includes('.')) continue;
  const target = String(record.content ?? '');
  const flyApp = target.match(/^(?:[a-z0-9]+\.)?(iapp-[0-9a-f]+)\.fly\.dev$/)?.[1];
  if (flyApp) sites.push({ record, name, flyApp });
  else if (!target.endsWith('.fly.dev')) redirects.push({ record, name, target });
}

const usage = await cloudflare('/dns_records/usage').catch(() => null);
console.log(`${sites.length} site record(s), ${redirects.length} redirect record(s); edge ${edgeIp}`
  + (usage?.result ? `; the zone holds ${usage.result.record_usage} of ${usage.result.record_quota} records` : ''));
console.log(apply ? 'APPLY: each record is deleted once its checks pass.\n' : 'DRY RUN: checks only, nothing deleted.\n');

const outcome = { moved: [], left: [], skipped: [] };

async function mapAnswer(name) {
  const res = await fetch(`${backend}/api/preview-map/${encodeURIComponent(name)}`).catch((error) => error);
  if (res instanceof Error) return { error: res.message };
  if (res.status === 404) return { missing: true };
  if (res.status !== 200) return { error: `backend answered ${res.status}` };
  return await res.json();
}

for (const site of [...sites, ...(includeRedirects ? redirects : [])]) {
  const { record, name } = site;
  const label = name.padEnd(28);
  if (only && name !== only) { outcome.skipped.push(name); continue; }

  // 1. The map must say what the record says.
  const answer = await mapAnswer(name);
  const wantRedirect = 'target' in site;
  let mapOk = false;
  if (answer.error) console.log(`${label} map: ${answer.error}`);
  else if (answer.missing) console.log(`${label} map: no answer — the backend does not route this name`);
  else if (!wantRedirect && answer.app === site.flyApp) mapOk = true;
  else if (wantRedirect && typeof answer.redirect === 'string') mapOk = true;
  else console.log(`${label} map: answers ${JSON.stringify(answer)}, record says ${wantRedirect ? site.target : site.flyApp}`);
  if (!mapOk) { outcome.left.push(name); continue; }

  // 2. The Worker path must already serve it — probed around the record.
  const before = await probeEdge(edgeIp, record.name);
  let pathOk;
  if (wantRedirect) {
    pathOk = !before.error && before.status === 301 && before.location === `${answer.redirect}/`;
  } else {
    pathOk = !before.error && before.fly && before.status < 500;
  }
  if (!pathOk) {
    console.log(`${label} worker path: ${describe(before)} — record kept`);
    outcome.left.push(name);
    continue;
  }
  if (!apply) {
    console.log(`${label} ok: map ${wantRedirect ? `→ ${answer.redirect}` : `→ ${answer.app}`}, worker path ${describe(before)} (dry run, record kept)`);
    outcome.skipped.push(name);
    continue;
  }

  // 3. Delete, then prove it again.
  try {
    await cloudflare(`/dns_records/${record.id}`, { method: 'DELETE' });
  } catch (error) {
    console.log(`${label} delete failed: ${error.message} — record kept`);
    outcome.left.push(name);
    continue;
  }
  const after = await probeEdge(edgeIp, record.name);
  const afterOk = wantRedirect
    ? !after.error && after.status === 301 && after.location === `${answer.redirect}/`
    : !after.error && after.fly && after.status < 500;
  console.log(`${label} moved: before ${describe(before)}, record deleted, after ${describe(after)}${afterOk ? '' : '  <-- CHECK THIS ONE'}`);
  (afterOk ? outcome.moved : outcome.left).push(name);
}

const after = await cloudflare('/dns_records/usage').catch(() => null);
console.log(`\nmoved ${outcome.moved.length}, left as they were ${outcome.left.length}${outcome.left.length ? ` (${outcome.left.join(', ')})` : ''}, not attempted ${outcome.skipped.length}`
  + (after?.result ? `; the zone now holds ${after.result.record_usage} of ${after.result.record_quota} records` : ''));
process.exit(outcome.left.length === 0 ? 0 : 1);
