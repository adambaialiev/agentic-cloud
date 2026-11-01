#!/usr/bin/env node
/**
 * Tear down ONE client org: its rows, its WireGuard peer, and — only when
 * asked — the agent machines living in the org's OWN Fly account.
 *
 * This exists because `delete-user-profile.mjs` cannot reach those machines.
 * That script builds its Fly client on the PLATFORM's `FLY_ORG`, and a client
 * org's apps are invisible to the platform token (403 on an app that exists,
 * 404 only when it truly does not). Run it alone on a client-org member and
 * it deletes the record while the machine keeps billing in the client's
 * account, named by nothing. So machines go FIRST, from here, while the agent
 * records that attribute each app to this org still exist.
 *
 * Run ON the backend host from /opt/infinite-agents/current with the host env
 * loaded (root: the env file is root-only and the WireGuard teardown shells
 * to systemctl):
 *
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/teardown-org.mjs --org <orgId>                        # dry run
 *   node scripts/teardown-org.mjs --org <orgId> --apply
 *   node scripts/teardown-org.mjs --org <orgId> --apply --destroy-machines
 *
 * TWO DIFFERENT OPERATIONS, and the flag is which one you mean:
 *   OFF-BOARDING a real client (`--apply`): we remove our peer and forget
 *     their token; every machine they own KEEPS RUNNING in their own account.
 *     That is the promise byo-fly-design makes, made mechanical.
 *   WIPING a test account (`--apply --destroy-machines`): their machines,
 *     volumes and apps are destroyed too. Never point this at a paying client.
 *
 * What it does NOT do, printed as reminders at the end: the member profiles
 * (`delete-user-profile.mjs` owns those, and it is the RIGHT order to run it
 * after this), any git repositories those members own, and the client's Fly
 * organization itself — only its owner can delete that.
 *
 * Production guard: when FLY_ORG does not end in "-dev", --apply additionally
 * requires --production-i-am-sure.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');
for (const envPath of [
  path.join(backendRoot, '.env.local'),
  path.join(backendRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}

const dist = (rel) => new URL(path.join('..', 'dist', rel), import.meta.url);
const { openSqliteDb } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
// Without this wrapper getOrgSecret hands back the stored "enc:v1…" ciphertext
// and Fly answers 401 "token validation error" — which reads exactly like a
// revoked token and sends you asking the client for a new one.
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { OrgSecretsService } = await import(dist('services/org-secrets.js'));
const { OrgFlyService } = await import(dist('services/org-fly.js'));
const { OrgWireGuardService } = await import(dist('services/org-wireguard.js'));
const { FlyClient } = await import(dist('services/fly-client.js'));
const { parseFlyServerRecordId, parseFlySandboxId } = await import(dist('services/fly-sandbox-id.js'));
const { orgGitAppName } = await import(dist('services/org-git-host.js'));
const { orgMsgAppName } = await import(dist('services/org-msg-host.js'));
/** The CI runner's app, built inline in org-ci.ts on the same shape as every org-scoped app. */
const orgCiAppName = (id) => `iaci-${id.replace(/-/g, '').slice(0, 12)}`;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const orgId = flag('org');
const apply = hasFlag('apply');
const destroyMachines = hasFlag('destroy-machines');
if (!orgId) {
  console.error('Usage: teardown-org.mjs --org <orgId> [--apply] [--destroy-machines] [--production-i-am-sure]');
  process.exit(1);
}

const platformOrgSlug = process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '';
const isProd = platformOrgSlug !== '' && !platformOrgSlug.endsWith('-dev');
if (apply && isProd && !hasFlag('production-i-am-sure')) {
  console.error(`FLY_ORG=${platformOrgSlug} looks like PRODUCTION. Re-run with --production-i-am-sure if you really mean it.`);
  process.exit(1);
}

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const cipher = secretCipherFromEnv();
if (!sqlitePath || !cipher) {
  console.error('Need SQLITE_DB_PATH and SECRETS_MASTER_KEY (run on the backend host with backend.env loaded).');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const orgStorage = new SqliteOrgStorage(db);
const orgSecrets = new OrgSecretsService(new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher));
const orgFly = new OrgFlyService({ orgStorage, orgSecrets });
const exec = (argv, opts = {}) => new Promise((resolve) => {
  const child = execFile(argv[0], argv.slice(1), (error, stdout, stderr) => {
    resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (error.code ?? 1) : 0 });
  });
  child.stdin.end(opts.stdin ?? undefined);
});
const wireguard = new OrgWireGuardService({ orgStorage, orgSecrets, orgFly, exec });

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
const org = await orgStorage.getOrg(orgId);
if (!org) {
  console.error(`No org with id ${orgId}.`);
  process.exit(1);
}
// Org #0 is the PLATFORM's own org: its Fly org is the one this backend runs
// in, so a teardown here would delete our rows and, with --destroy-machines,
// every agent machine we own — including the one running this script. No
// override: this is never the right tool for it.
if (org.fly?.orgSlug && platformOrgSlug && org.fly.orgSlug === platformOrgSlug) {
  console.error(`Org ${org.orgId} points at the PLATFORM's own Fly org (${platformOrgSlug}). Refusing.`);
  process.exit(1);
}

const members = await orgStorage.listMembers(orgId);
console.log(`org:       ${org.name} (${org.orgId})`);
console.log(`fly org:   ${org.fly?.orgSlug ?? '(not connected)'}`);
console.log(`peer:      ${org.fly?.wireguard?.peerName ?? '(none registered)'}`);
console.log(`members:   ${members.length}`);

// Apps this org's own member records claim. Nothing else is ever touched:
// an app nobody here claims is another org's machine or an unclaimed leak,
// and both want a human, not this script.
const claimed = [];
const memberRepos = [];
let seatCount = 0;
for (const member of members) {
  seatCount += (await orgStorage.listSeatsByMember(orgId, member.userId)).length;
  const row = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(member.userId);
  const profile = row ? JSON.parse(row.doc) : null;
  const agents = Object.entries(profile?.telegram?.agents ?? {});
  console.log(`  - ${member.userId} (${member.role})`
    + `${profile ? '' : '  [no user row]'}  agents=${agents.length}`);
  for (const [agentId, agent] of agents) {
    const sandboxId = parseFlyServerRecordId(agent.serverId);
    const target = sandboxId ? parseFlySandboxId(sandboxId) : null;
    const appName = target?.appName ?? agent.provisioningAppName?.trim();
    console.log(`      ${agent.name} (${agentId}) cli=${agent.cli} app=${appName ?? 'none yet'}`);
    if (appName) claimed.push({ appName, agentName: agent.name, userId: member.userId });
  }
  const repos = db.prepare('SELECT COUNT(*) c FROM git_repos WHERE user_id = ?').get(member.userId).c;
  if (repos) memberRepos.push(`${member.userId}: ${repos}`);
}
console.log(`seats:     ${seatCount}`);

// The org's own infrastructure apps: its git host and CI runner. No agent
// record names them — they belong to the ORG — so without this they read as
// "unclaimed" and a wipe leaves two machines billing in the client's account.
// Off-boarding leaves them standing on purpose (byo-git-design: the git host
// is what a leaving client keeps).
const infra = [
  { appName: orgGitAppName(orgId), agentName: 'org git host' },
  { appName: orgCiAppName(orgId), agentName: 'org CI runner' },
  // The messaging machine (note #608): the people's direct messages live on
  // its volume and nowhere else, so destroying it IS deleting them.
  { appName: orgMsgAppName(orgId), agentName: 'org messaging machine' },
];

let fly = null;
let flyContext = null;
// Everything this teardown may destroy: agent machines the member records
// name, plus the org's own infrastructure apps when they were ever built.
let targets = [...claimed];
if (org.fly) {
  flyContext = await orgFly.resolveOrgFlyContext(orgId).catch((error) => {
    console.log(`\nCANNOT REACH THIS ORG'S FLY ACCOUNT: ${error.message}`);
    return null;
  });
  if (flyContext?.source === 'org') {
    fly = new FlyClient(flyContext.apiToken);
    const visible = await fly.listApps(flyContext.orgSlug).catch((error) => {
      console.log(`  listApps failed: ${error.message}`);
      return [];
    });
    console.log(`\napps in ${flyContext.orgSlug}: ${visible.map((a) => a.name).join(', ') || '(none)'}`);
    targets = [...claimed, ...infra.filter((app) => visible.some((v) => v.name === app.appName))];
    for (const app of visible) {
      if (!targets.some((c) => c.appName === app.name)) {
        console.log(`  UNCLAIMED: ${app.name} — in this Fly org but no record here names it; left alone`);
      }
    }
  }
}

for (const { appName, agentName } of targets) {
  if (!fly) break;
  const machines = await fly.listMachines(appName).catch(() => []);
  const volumes = await fly.listVolumes(appName).catch(() => []);
  console.log(`  ${appName} (${agentName}): machines=${machines.map((m) => `${m.id}/${m.state}`).join(',') || 'none'}`
    + ` volumes=${volumes.map((v) => `${v.id}/${v.size_gb}GB`).join(',') || 'none'}`);
}

if (!apply) {
  console.log('\nDRY RUN — nothing touched.');
  console.log('  --apply                    off-board: our peer and token go, THEIR MACHINES KEEP RUNNING');
  console.log('  --apply --destroy-machines wipe: destroy their machines, volumes and apps too');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Teardown. Machines first, while the records that name them still exist.
// ---------------------------------------------------------------------------
if (destroyMachines) {
  if (!fly) {
    console.error('\n--destroy-machines needs this org\'s own Fly token, and it could not be resolved. Stopping'
      + ' BEFORE any row is deleted — otherwise the machines would be left billing with nothing naming them.');
    process.exit(1);
  }
  for (const { appName, agentName } of targets) {
    console.log(`\n${appName} (${agentName}):`);
    for (const machine of await fly.listMachines(appName).catch(() => [])) {
      await fly.deleteMachine(appName, machine.id, { force: true });
      console.log(`  destroyed machine ${machine.id}`);
    }
    for (const volume of await fly.listVolumes(appName).catch(() => [])) {
      await fly.deleteVolume(appName, volume.id)
        .then(() => console.log(`  deleted volume ${volume.id}`))
        .catch((error) => console.log(`  volume ${volume.id} failed: ${error.message}`));
    }
    await fly.deleteApp(appName).catch((error) => console.log(`  app delete failed: ${error.message}`));
    const gone = await fly.getApp(appName).then(() => false).catch(() => true);
    console.log(`  app ${appName} gone: ${gone}`);
    if (!gone) {
      console.error('  app still answers — stopping before the rows go, so it stays findable.');
      process.exit(1);
    }
  }
}

// Interface down + disabled, conf deleted, Fly peer removed, key deleted.
// Needs the org's token and doc, so it runs BEFORE the rows go.
if (org.fly?.wireguard) {
  await wireguard.removeOrgWireGuard(orgId)
    .then(() => console.log('\nwireguard: interface down + disabled, conf deleted, Fly peer removed, key deleted'))
    .catch((error) => console.log(`\nwireguard teardown failed (finish by hand): ${error.message}`));
}

const owner = `org:${orgId}`;
const removed = db.transaction(() => ({
  secrets: db.prepare('DELETE FROM secrets WHERE user_id = ?').run(owner).changes,
  seats: db.prepare('DELETE FROM org_seats WHERE org_id = ?').run(orgId).changes,
  invites: db.prepare('DELETE FROM org_invites WHERE org_id = ?').run(orgId).changes,
  members: db.prepare('DELETE FROM org_members WHERE org_id = ?').run(orgId).changes,
  orgs: db.prepare('DELETE FROM orgs WHERE org_id = ?').run(orgId).changes,
}))();
console.log('\nrows deleted:', JSON.stringify(removed));

console.log('\nDone. NOT deleted here:');
for (const member of members) {
  console.log(`  - profile ${member.userId} — node scripts/delete-user-profile.mjs --user ${member.userId} --apply`);
}
if (memberRepos.length) console.log(`  - git repositories still owned by members: ${memberRepos.join(', ')}`);
if (!destroyMachines && targets.length) {
  console.log(`  - ${targets.length} app(s) STILL RUNNING in ${org.fly?.orgSlug ?? 'their Fly org'}`
    + ' — off-boarding leaves them, which is the promise; --destroy-machines is the wipe');
}
console.log(`  - the Fly organization ${org.fly?.orgSlug ?? ''} itself — only its owner can delete that`);
console.log('\nRestart the backend to flush in-memory state (app→org resolver cache, bot registry):');
console.log('  systemctl restart infinite-agents-backend');
