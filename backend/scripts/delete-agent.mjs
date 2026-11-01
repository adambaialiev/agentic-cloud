#!/usr/bin/env node
/**
 * Delete ONE agent and everything attached to it, from the operator side.
 * The in-product path (roster Delete button → AgentService) is what
 * users have; this is the same teardown for an agent only an operator can
 * reach — someone else's, or one whose record and machine drifted apart.
 *
 * Run ON the backend host from /opt/infinite-agents/current with the host env
 * loaded (the env file is root-only, so run as root):
 *
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/delete-agent.mjs --user tg_… --agent <agentId>            # dry run
 *   node scripts/delete-agent.mjs --user tg_… --agent <agentId> --apply
 *
 * Order mirrors AgentService.deleteTelegramAgent, for the same reason:
 * the MACHINE goes first and a failure there aborts, because deleting the
 * record first leaves a billed machine nothing references and nobody can name.
 *
 *   1. .backup snapshot of the SQLite db (delete-backups/).
 *   2. Machine, volume and app (FlySandboxClient.destroySandbox — idempotent).
 *   3. The agent's bot: deleteWebhook, so a retired bot stops calling us.
 *   4. The agent record, then its agent-scoped secrets and pending-turn
 *      checkpoint. Shared secrets and the user's other agents are untouched.
 *
 * `--app <name>` destroys a machine the RECORD does not know about: the app
 * exists, but provisioning died before saving `serverId`, so the in-product
 * delete would tear down the record and leave the machine billing forever.
 * It refuses any app another agent claims, so a typo cannot take out a
 * bystander's machine.
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
const { secretCipherFromEnv, isEncryptedSecretValue } = await import(path.join(backendRoot, 'dist', 'services', 'secret-cipher.js'));
const { parseUserSecretStorageKey } = await import(path.join(backendRoot, 'dist', 'services', 'user-secrets.js'));
const { FlySandboxClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-sandbox-client.js'));
const { FlyClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-client.js'));
const { SshClient } = await import(path.join(backendRoot, 'dist', 'services', 'ssh-client.js'));

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const userId = flag('user');
const agentId = flag('agent');
const appOverride = flag('app');
const apply = hasFlag('apply');
if (!userId || !agentId) {
  console.error('Usage: delete-agent.mjs --user <userId> --agent <agentId> [--app <appName>] [--apply] [--production-i-am-sure]');
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
  console.error('SQLITE_DB_PATH is not set — this script only speaks SQLite.');
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
const agent = profile.telegram?.agents?.[agentId];
if (!agent) {
  console.error(`User ${userId} has no agent ${agentId}. Agents: ${Object.keys(profile.telegram?.agents ?? {}).join(', ') || 'none'}`);
  process.exit(1);
}

const secretCipher = secretCipherFromEnv();
const secretRows = db.prepare('SELECT secret_id, doc FROM secrets WHERE user_id = ?').all(userId)
  .map((row) => ({ secretId: row.secret_id, ...JSON.parse(row.doc) }));
const agentSecrets = secretRows.filter((secret) => {
  const parsed = parseUserSecretStorageKey(secret.key ?? '');
  return parsed?.scope?.kind === 'agent' && parsed.scope.agentId === agentId;
});
// The agent's own bot token, so the retired bot stops calling our webhook.
// Values are ciphertext at rest when SECRETS_MASTER_KEY is set.
const botTokens = agentSecrets
  .map((secret) => {
    const value = String(secret.value ?? '');
    if (!isEncryptedSecretValue(value)) return value;
    if (!secretCipher) {
      console.warn(`  secret ${secret.secretId} is encrypted but SECRETS_MASTER_KEY is not set — cannot check for a bot token`);
      return '';
    }
    return secretCipher.decrypt(value);
  })
  .filter((value) => /^\d+:[A-Za-z0-9_-]{30,}$/.test(value));
const pendingTurns = db.prepare('SELECT doc_id FROM pending_turns').all()
  .filter((row) => row.doc_id.includes(agentId));

// What the record says its machine is, and what --app was pointed at instead.
const recordedMachine = /^fly_([^.]+)\.(.+)$/.exec(agent.serverId ?? '');
const claimedElsewhere = [];
if (appOverride) {
  for (const row of db.prepare('SELECT user_id, doc FROM users').all()) {
    for (const [otherId, other] of Object.entries(JSON.parse(row.doc).telegram?.agents ?? {})) {
      if (otherId !== agentId && String(other.serverId ?? '').includes(appOverride)) {
        claimedElsewhere.push(`${row.user_id}/${otherId} (${other.name})`);
      }
    }
  }
}

console.log(`user:     ${userId} (tg=@${profile.telegram?.username ?? '-'})`);
console.log(`agent:    ${agent.name} [${agentId}] cli=${agent.cli} created=${agent.createdAt ?? '-'}`);
console.log(`machine:  ${agent.serverId ?? 'NONE on the record'}${appOverride ? `  (--app ${appOverride})` : ''}`);
console.log(`bot:      ${agent.botUsername ? `@${agent.botUsername} (${agent.botId ?? '-'})` : 'none'}, ${botTokens.length} token(s) to detach`);
console.log(`secrets:  ${agentSecrets.length} scoped to this agent (${secretRows.length} on the account)`);
console.log(`pending:  ${pendingTurns.length} checkpoint(s)`);
console.log(`siblings: ${Object.keys(profile.telegram?.agents ?? {}).filter((id) => id !== agentId).length} other agent(s), untouched`);

if (claimedElsewhere.length > 0) {
  console.error(`\nREFUSING: app ${appOverride} is claimed by ${claimedElsewhere.join(', ')} — that is someone's live machine.`);
  process.exit(1);
}
if (!apply) {
  console.log('\nDRY RUN — nothing touched. Re-run with --apply to delete all of the above.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Snapshot
// ---------------------------------------------------------------------------
const backupDir = path.join(path.dirname(sqlitePath), 'delete-backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `pre-agent-delete-${agentId}-${stamp}.db`);
await import('node:fs/promises').then((fs) => fs.mkdir(backupDir, { recursive: true }));
await db.backup(backupPath);
console.log(`\nbackup: ${backupPath}`);

// ---------------------------------------------------------------------------
// 2. Machine, volume, app — FIRST, and fatal if it fails
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

const sandboxIds = [];
if (recordedMachine) {
  sandboxIds.push(`fly-sandbox-${recordedMachine[1]}.${recordedMachine[2]}`);
} else if (agent.serverId) {
  console.warn(`serverId ${agent.serverId} is not a Fly machine — left running (legacy provider?)`);
}
if (appOverride) {
  if (!apiToken) {
    console.error('FLY_API_TOKEN unset — cannot reach the app named by --app. Aborting before the record is touched.');
    process.exit(1);
  }
  const flyClient = new FlyClient(apiToken);
  const machines = await flyClient.listMachines(appOverride).catch(() => []);
  console.log(`--app ${appOverride}: ${machines.length} machine(s) — ${machines.map((m) => `${m.id}/${m.state}`).join(', ') || 'app shell only'}`);
  for (const machine of machines) {
    const id = `fly-sandbox-${appOverride}.${machine.id}`;
    if (!sandboxIds.includes(id)) sandboxIds.push(id);
  }
  // No machines left but the app (and its volume) still bills: destroySandbox
  // sweeps volumes and the app shell even when the machine is already gone.
  if (machines.length === 0) sandboxIds.push(`fly-sandbox-${appOverride}.0`);
}

for (const sandboxId of sandboxIds) {
  if (!flySandbox) {
    console.error(`FLY_API_TOKEN unset — ${sandboxId} NOT destroyed. Aborting before the record is touched.`);
    process.exit(1);
  }
  try {
    await flySandbox.destroySandbox(sandboxId);
    console.log(`destroyed ${sandboxId} (machine, volume, app)`);
  } catch (error) {
    console.error(`machine teardown failed for ${sandboxId}: ${error.message}`);
    console.error('ABORTING with the record intact — a machine nothing references is worse than a retry.');
    process.exit(1);
  }
}
if (sandboxIds.length === 0) {
  console.log('no machine to destroy');
}

// ---------------------------------------------------------------------------
// 3. Detach the bot
// ---------------------------------------------------------------------------
for (const token of botTokens) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
    const body = await res.json().catch(() => ({}));
    console.log(`deleteWebhook bot ${token.split(':')[0]}: ${body.ok ? 'ok' : JSON.stringify(body)}`);
  } catch (error) {
    console.warn(`deleteWebhook failed (continuing): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Record, then what only the record could point at
// ---------------------------------------------------------------------------
const removeAgent = db.transaction(() => {
  const row = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId);
  const doc = JSON.parse(row.doc);
  const agents = { ...(doc.telegram?.agents ?? {}) };
  delete agents[agentId];
  doc.telegram = { ...doc.telegram, agents };
  // A dangling pointer at a deleted agent is how the roster ends up showing a
  // selection nothing owns.
  if (doc.telegram.activeAgentId === agentId) {
    delete doc.telegram.activeAgentId;
    console.log('cleared activeAgentId (it pointed at this agent)');
  }
  doc.updatedAt = new Date().toISOString();
  db.prepare('UPDATE users SET doc = ? WHERE user_id = ?').run(JSON.stringify(doc), userId);
});
removeAgent();
console.log(`removed agent record ${agentId}`);

for (const secret of agentSecrets) {
  db.prepare('DELETE FROM secrets WHERE user_id = ? AND secret_id = ?').run(userId, secret.secretId);
}
if (agentSecrets.length > 0) console.log(`dropped ${agentSecrets.length} agent-scoped secret(s)`);

for (const row of pendingTurns) {
  db.prepare('DELETE FROM pending_turns WHERE doc_id = ?').run(row.doc_id);
}
if (pendingTurns.length > 0) console.log(`dropped ${pendingTurns.length} pending-turn checkpoint(s)`);

const left = Object.keys(JSON.parse(db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId).doc).telegram?.agents ?? {}).length;
console.log(`\ndone — ${agent.name} is gone; ${left} agent(s) left on ${userId}.`);
console.log('NOT touched: the user\'s account, their other agents, their chat history, and the BotFather bot itself (only its owner can /deletebot).');
