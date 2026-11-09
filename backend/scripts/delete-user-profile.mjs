#!/usr/bin/env node
/**
 * Delete one user's profile and everything attached to it. Run ON the
 * backend host from /opt/infinite-agents/current with the host env loaded:
 *
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/delete-user-profile.mjs --user tg_…            # dry run: inventory only
 *   node scripts/delete-user-profile.mjs --user tg_… --apply    # actually delete
 *
 * What --apply does, in order (each step best-effort so one failure doesn't
 * strand the rest, but the DB rows only go once infra teardown was attempted):
 *   1. .backup snapshot of the SQLite db next to it (delete-backups/).
 *   2. Every agent machine: Fly machines (force) → volumes → app, via the
 *      same client the backend uses — and every agent's branded preview name,
 *      whether or not a machine is still recorded (a recycled agent keeps its
 *      name in DNS long after its machine is gone).
 *   3. Every deployment: DeploymentService.destroy (machine, volume, app,
 *      DNS record, staged tarball).
 *   4. SQLite rows: session_messages, sessions, secrets, pending_turns,
 *      the user's deployment rows (a live user's destroyed deployments stay
 *      as tombstones, but a DELETED user leaves no rows at all — the names
 *      were already free either way, since tombstones never block a name),
 *      workplace memberships, usernames reservation, users row.
 *
 * What it can NOT reach (printed as reminders): a workplace the user was the
 * only member of (teardown-org.mjs owns that) and Paddle subscriptions (cancel
 * in the dashboard; the subscription ids are printed from the billing mirror).
 *
 * Production guard: when FLY_ORG does not end in "-dev", --apply additionally
 * requires --production-i-am-sure.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
for (const envPath of [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')]) {
  dotenv.config({ path: envPath, override: false });
}

const { openSqliteDb } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-db.js'));
const { SqliteDeploymentStorage } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-deployment-storage.js'));
const { DeploymentService, CloudflareAppsDns } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-service.js'));
const { FlyClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-client.js'));
const { FlySandboxClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-sandbox-client.js'));
const { SshClient } = await import(path.join(backendRoot, 'dist', 'services', 'ssh-client.js'));

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const userId = flag('user');
const apply = hasFlag('apply');
if (!userId) {
  console.error('Usage: delete-user-profile.mjs --user <userId> [--apply] [--production-i-am-sure]');
  process.exit(1);
}
const orgSlug = process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '';
const isProd = orgSlug !== '' && !orgSlug.endsWith('-dev');
if (apply && isProd && !hasFlag('production-i-am-sure')) {
  console.error(`FLY_ORG=${orgSlug} looks like PRODUCTION. Re-run with --production-i-am-sure if you really mean it.`);
  process.exit(1);
}

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!sqlitePath) {
  console.error('SQLITE_DB_PATH is not set — this script only speaks SQLite. (Pre-migration data: delete-user.mjs.)');
  process.exit(1);
}
const db = openSqliteDb(sqlitePath);

function decodeMultiline(value) {
  return value ? value.replace(/\\n/g, '\n') : value;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
const userRow = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId);
if (!userRow) {
  console.error(`No user ${userId} in ${sqlitePath}. Nothing to do.`);
  process.exit(1);
}
const profile = JSON.parse(userRow.doc);
const agents = Object.values(profile.telegram?.agents ?? {});
const secrets = db.prepare('SELECT secret_id, doc FROM secrets WHERE user_id = ?').all(userId)
  .map((row) => ({ secretId: row.secret_id, ...JSON.parse(row.doc) }));
const sessionCount = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(userId).c;
const messageCount = db.prepare('SELECT COUNT(*) c FROM session_messages WHERE user_id = ?').get(userId).c;
const deploymentStorage = new SqliteDeploymentStorage(db);
const deployments = (await deploymentStorage.listByUser(userId)).filter((d) => d.status !== 'destroyed');
const memberships = db.prepare('SELECT org_id FROM org_members WHERE user_id = ?').all(userId).map((row) => row.org_id);
const soleMemberOf = memberships.filter((orgId) => db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(orgId).c === 1);

console.log(`user:        ${userId} (username=${profile.username ?? '-'}, sign-in=${profile.authType ?? '-'})`);
console.log(`billing:     ${profile.billing ? `plan=${profile.billing.plan} status=${profile.billing.status} sub=${profile.billing.paddleSubscriptionId ?? '-'}` : 'none'}`);
console.log(`agents:      ${agents.length ? agents.map((a) => `${a.name} (${a.cli}, ${a.serverId ?? 'no machine'}${a.previewHostname ? `, ${a.previewHostname}` : ''})`).join('; ') : 'none'}`);
console.log(`secrets:     ${secrets.length}`);
console.log(`sessions:    ${sessionCount} (+${messageCount} messages)`);
console.log(`deployments: ${deployments.length ? deployments.map((d) => `${d.name} [${d.status}]`).join(', ') : 'none'}`);
console.log(`workplaces:  ${memberships.length}${soleMemberOf.length ? ` (only member of ${soleMemberOf.join(', ')} — teardown-org.mjs)` : ''}`);

if (!apply) {
  console.log('\nDRY RUN — nothing touched. Re-run with --apply to delete all of the above.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Snapshot
// ---------------------------------------------------------------------------
const backupDir = path.join(path.dirname(sqlitePath), 'delete-backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `pre-delete-${userId}-${stamp}.db`);
await import('node:fs/promises').then((fs) => fs.mkdir(backupDir, { recursive: true }));
await db.backup(backupPath);
console.log(`\nbackup: ${backupPath}`);

// ---------------------------------------------------------------------------
// 2. Destroy agent machines
// ---------------------------------------------------------------------------
const apiToken = process.env.FLY_API_TOKEN;
const flySandbox = apiToken
  ? new FlySandboxClient({
      apiToken,
      orgSlug: orgSlug || 'personal',
      region: process.env.FLY_REGION || 'ams',
      machineImage: process.env.FLY_MACHINE_IMAGE || 'unused',
      sshPublicKey: decodeMultiline(process.env.FLY_SSH_PUBLIC_KEY || process.env.HETZNER_SSH_PUBLIC_KEY),
      sshPrivateKey: decodeMultiline(process.env.FLY_SSH_PRIVATE_KEY || process.env.HETZNER_SSH_PRIVATE_KEY),
      sshClient: new SshClient(),
    })
  : null;
for (const agent of agents) {
  const match = /^fly_([^.]+)\.(.+)$/.exec(agent.serverId ?? '');
  if (!match) {
    if (agent.serverId) console.warn(`agent ${agent.name}: serverId ${agent.serverId} is not a Fly machine — skipped (legacy provider?)`);
  } else if (!flySandbox) {
    console.warn(`agent ${agent.name}: FLY_API_TOKEN unset — machine ${agent.serverId} NOT destroyed`);
  } else {
    try {
      await flySandbox.destroySandbox(`fly-sandbox-${match[1]}.${match[2]}`);
      console.log(`destroyed machine of ${agent.name} (${match[1]})`);
    } catch (error) {
      console.warn(`machine teardown for ${agent.name} failed (continuing): ${error.message}`);
    }
  }
  // Branded preview name: the CNAME lives in our zone, not on the Fly app,
  // so it needs its own delete or it orphans pointing at a dead app — and it
  // outlives the machine, so it is released even when no machine is recorded
  // (a recycled agent's `_map` TXT survived exactly that way, 2026-10-03).
  if (agent.previewHostname) {
    const dnsToken = process.env.CLOUDFLARE_APPS_DNS_TOKEN?.trim();
    const zoneId = process.env.CLOUDFLARE_APPS_ZONE_ID?.trim();
    if (dnsToken && zoneId) {
      try {
        const { CloudflareAppsDns } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-service.js'));
        const dns = new CloudflareAppsDns(dnsToken, zoneId);
        // Both record shapes older agents may still have: the `_map.<slug>`
        // TXT mapping (until 2026-10-13; newer agents have none, and the
        // record's deletion below is what stops their name resolving) AND any
        // legacy certificate-era CNAME at the slug. Missing the TXT
        // orphaned a mapping in production (jmuuav, 2026-08-06) — the in-app
        // delete path uses PreviewDomainService.release(), which does both.
        await dns.deleteTxt(`_map.${agent.previewHostname}`);
        await dns.deleteCname(agent.previewHostname);
        console.log(`released preview name ${agent.previewHostname} of ${agent.name}`);
      } catch (error) {
        console.warn(`preview-name release for ${agent.name} failed (continuing): ${error.message}`);
      }
    } else {
      console.warn(`CLOUDFLARE_APPS_* unset — preview name ${agent.previewHostname} NOT released`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Destroy deployments (machine + DNS + staged content; tombstone kept)
// ---------------------------------------------------------------------------
if (deployments.length > 0) {
  const runtimeImage = process.env.FLY_APP_RUNTIME_IMAGE;
  if (!apiToken || !runtimeImage || !flySandbox) {
    console.warn('FLY_API_TOKEN / FLY_APP_RUNTIME_IMAGE unset — deployments NOT destroyed');
  } else {
    const dnsToken = process.env.CLOUDFLARE_APPS_DNS_TOKEN;
    const dnsZone = process.env.CLOUDFLARE_APPS_ZONE_ID;
    const deploymentService = new DeploymentService({
      fly: new FlyClient(apiToken),
      sandboxClient: flySandbox,
      storage: deploymentStorage,
      dns: dnsToken && dnsZone ? new CloudflareAppsDns(dnsToken, dnsZone) : null,
      orgSlug: orgSlug || 'personal',
      region: process.env.FLY_REGION || 'ams',
      image: runtimeImage,
      appsDomain: process.env.APPS_DOMAIN || 'agentbuilt.app',
      stagingDir: process.env.DEPLOY_STAGING_DIR || '/var/lib/infinite-agents/deploy-staging',
    });
    for (const deployment of deployments) {
      try {
        await deploymentService.destroy(deployment.id);
        console.log(`destroyed deployment ${deployment.name}`);
      } catch (error) {
        console.warn(`deployment ${deployment.name} teardown failed (continuing): ${error.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Delete the rows
// ---------------------------------------------------------------------------
const del = (sql) => {
  const changes = db.prepare(sql).run(userId).changes;
  console.log(`${sql.split(' ')[2]}: ${changes} row(s)`);
};
db.transaction(() => {
  del('DELETE FROM session_messages WHERE user_id = ?');
  del('DELETE FROM sessions WHERE user_id = ?');
  del('DELETE FROM workspace_email_verifications WHERE user_id = ?');
  del('DELETE FROM workspace_second_factor_challenges WHERE json_extract(doc, \'$.userId\') = ?');
  del('DELETE FROM workspace_web_sessions WHERE user_id = ?');
  del('DELETE FROM workspace_email_identities WHERE user_id = ?');
  del('DELETE FROM workspace_totp_identities WHERE user_id = ?');
  del('DELETE FROM workspace_totp_enrollments WHERE json_extract(doc, \'$.userId\') = ?');
  del('DELETE FROM secrets WHERE user_id = ?');
  del("DELETE FROM pending_turns WHERE doc LIKE '%' || ? || '%'");
  del('DELETE FROM deployments WHERE user_id = ?');
  del('DELETE FROM org_member_recap_chats WHERE user_id = ?');
  del('DELETE FROM org_members WHERE user_id = ?');
  del('DELETE FROM usernames WHERE user_id = ?');
  del('DELETE FROM users WHERE user_id = ?');
})();

console.log('\nDone. Restart the backend to flush in-memory state:');
console.log('  systemctl restart infinite-agents-backend');
console.log('NOT deleted (out of reach here):');
for (const orgId of soleMemberOf) {
  console.log(`  - workplace ${orgId}, which now has no members — node scripts/teardown-org.mjs --org ${orgId}`);
}
if (profile.billing?.paddleSubscriptionId) {
  console.log(`  - Paddle subscription ${profile.billing.paddleSubscriptionId} (${profile.billing.status}) — cancel in the Paddle dashboard`);
}
process.exit(0);
