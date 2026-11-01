#!/usr/bin/env node
/**
 * Operator tool for the platform credential pool (the `platform_credentials`
 * table — Claude setup-tokens and Codex auth.json blobs) and the per-user
 * platform-plan flag.
 *
 * Reads and writes the backend's SQLite file, so run it on the backend host
 * from /opt/infinite-agents/current with backend.env loaded:
 *
 *   node backend/scripts/platform-credentials.mjs list
 *   node backend/scripts/platform-credentials.mjs add --label max-1 --token sk-ant-oat01-…
 *   node backend/scripts/platform-credentials.mjs add --provider codex --label gpt-1 --auth-file ./auth.json
 *   node backend/scripts/platform-credentials.mjs usage-auth --id cred_… --from-file ./.credentials.json
 *   node backend/scripts/platform-credentials.mjs usage-auth --id cred_… --clear
 *   node backend/scripts/platform-credentials.mjs disable --id cred_… [--enable]
 *   node backend/scripts/platform-credentials.mjs remove --id cred_…
 *   node backend/scripts/platform-credentials.mjs user --user tg_123 --platform on|off
 *
 * `list` never prints tokens — only a masked tail for identification.
 */
import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
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

const TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

/**
 * Open the backend's SQLite file through the compiled sqlite-db module, so
 * documents are encoded/decoded exactly the way the backend does (needs
 * `dist/` built — true on the prod host; run `npm run build` first locally).
 */
async function openStore() {
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const { openSqliteDb, serializeDoc, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const db = openSqliteDb(sqlitePath);
  return {
    listCredentials: () => db.prepare('SELECT doc FROM platform_credentials').all()
      .map((row) => deserializeDoc(row.doc)),
    putCredential: (doc) => {
      db.prepare(
        'INSERT INTO platform_credentials (credential_id, doc) VALUES (?, ?)'
        + ' ON CONFLICT(credential_id) DO UPDATE SET doc = excluded.doc',
      ).run(doc.credentialId, serializeDoc(doc));
    },
    updateCredential: (id, updates) => {
      const row = db.prepare('SELECT doc FROM platform_credentials WHERE credential_id = ?').get(id);
      if (!row) throw new Error(`No credential ${id}.`);
      const doc = { ...deserializeDoc(row.doc), ...updates };
      db.prepare('UPDATE platform_credentials SET doc = ? WHERE credential_id = ?')
        .run(serializeDoc(doc), id);
    },
    removeCredential: (id) => {
      const result = db.prepare('DELETE FROM platform_credentials WHERE credential_id = ?').run(id);
      if (result.changes === 0) throw new Error(`No credential ${id}.`);
    },
    // Read-modify-write of the profile doc: only `platformPlan` is replaced.
    setUserPlatformPlan: (userId, platformPlan) => {
      const row = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId);
      if (!row) throw new Error(`No user ${userId}.`);
      const doc = { ...deserializeDoc(row.doc), platformPlan };
      db.prepare('UPDATE users SET doc = ? WHERE user_id = ?').run(serializeDoc(doc), userId);
    },
  };
}

function getFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function maskToken(token) {
  return token ? `…${token.slice(-6)}` : '(none)';
}

function formatUsage(doc) {
  const windows = doc.usage?.windows;
  const unified = windows
    ? Object.values(windows).map((w) => `${w.id}=${w.usedPercent}%`).join(' ')
    : 'usage: unknown';
  const model = Object.values(doc.modelWindows ?? {})
    .map((w) => `${w.id}=${w.usedPercent}%`)
    .join(' ');
  // Which source produced these matters when a number looks wrong: the
  // endpoint reports per-model windows, the header probe cannot.
  const source = doc.usageAuth?.accessToken && !doc.usageAuth.failedAt
    ? 'endpoint'
    : (doc.usageAuth?.failedAt ? `probe (usage token failed: ${doc.usageAuth.failedReason ?? 'unknown'})` : 'probe');
  return `${unified}${model ? `  ${model}` : ''}  via=${source}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const store = await openStore();

  switch (command) {
    case 'list': {
      const credentials = store.listCredentials();
      if (credentials.length === 0) {
        console.log('Pool is empty.');
        return;
      }
      for (const data of credentials) {
        const cooldown = data.status === 'cooldown' && data.cooldownUntil
          ? ` until ${data.cooldownUntil}`
          : '';
        const dead = data.status === 'dead' && data.deadReason ? ` (${data.deadReason})` : '';
        console.log(
          `${data.credentialId}  [${data.provider}] ${data.label}  token=${maskToken(data.token)}\n`
          + `  status=${data.status}${cooldown}${dead}  inFlight=${data.inFlightCount}  leases=${data.totalLeases}  authFailStreak=${data.authFailureStreak}\n`
          + `  ${formatUsage(data)}  refreshed=${data.usageRefreshedAt ?? 'never'}`,
        );
      }
      return;
    }
    case 'add': {
      const label = getFlag(args, 'label');
      const provider = getFlag(args, 'provider') ?? 'claude';
      if (!['claude', 'codex'].includes(provider)) throw new Error('--provider must be claude or codex');
      let token;
      if (provider === 'claude') {
        token = getFlag(args, 'token')?.trim();
        if (!label || !token) throw new Error('claude add requires --label and --token');
        if (!TOKEN_PATTERN.test(token)) throw new Error('Token does not look like an sk-ant-… setup-token.');
      } else {
        // Codex credential = the full auth.json a `codex login` left behind.
        const authFile = getFlag(args, 'auth-file');
        if (!label || !authFile) throw new Error('codex add requires --label and --auth-file <path to auth.json>');
        token = (await readFile(path.resolve(authFile), 'utf8')).trim();
        try {
          JSON.parse(token);
        } catch {
          throw new Error(`${authFile} is not valid JSON — expected a codex auth.json file.`);
        }
      }
      const now = new Date().toISOString();
      const credentialId = `cred_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const doc = {
        credentialId,
        provider,
        token,
        label,
        status: 'active',
        inFlightCount: 0,
        authFailureStreak: 0,
        totalLeases: 0,
        createdAt: now,
        updatedAt: now,
      };
      store.putCredential(doc);
      console.log(provider === 'claude'
        ? `Added ${credentialId} (${label}). The backend's refresher will probe usage within ~5 minutes.`
        : `Added ${credentialId} (${label}). Usage appears after the credential's first turn (machine-side probe).`);
      return;
    }
    case 'usage-auth': {
      // Attaches a SECOND credential to an existing pool account: an OAuth
      // token carrying `user:profile`, which is the only way to read the
      // per-model (Fable) window — a setup-token gets a 403 there. It never
      // runs a turn, so clearing it degrades the pool to the header probe
      // rather than taking the account out of service.
      const id = getFlag(args, 'id');
      if (!id) throw new Error('usage-auth requires --id');
      if (args.includes('--clear')) {
        store.updateCredential(id, { usageAuth: undefined, updatedAt: new Date().toISOString() });
        console.log(`${id} usage token cleared — usage falls back to the header probe.`);
        return;
      }
      const file = getFlag(args, 'from-file');
      if (!file) throw new Error('usage-auth requires --from-file <path> (a claude .credentials.json) or --clear');
      const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
      const oauth = parsed.claudeAiOauth ?? parsed;
      const accessToken = oauth.accessToken ?? oauth.access_token;
      if (typeof accessToken !== 'string' || !accessToken.trim()) {
        throw new Error(`${file} has no accessToken — expected a claude .credentials.json.`);
      }
      const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : undefined;
      if (scopes && !scopes.includes('user:profile')) {
        throw new Error(`That token lacks user:profile (${scopes.join(' ')}) — it cannot read the usage endpoint.`);
      }
      store.updateCredential(id, {
        usageAuth: {
          accessToken: accessToken.trim(),
          ...(oauth.refreshToken ? { refreshToken: oauth.refreshToken } : {}),
          ...(oauth.expiresAt ? { expiresAt: oauth.expiresAt } : {}),
          ...(scopes ? { scopes } : {}),
        },
        updatedAt: new Date().toISOString(),
      });
      console.log(`${id} usage token attached${oauth.expiresAt ? ` (expires ${new Date(oauth.expiresAt).toISOString()})` : ''}.`);
      return;
    }
    case 'disable': {
      const id = getFlag(args, 'id');
      if (!id) throw new Error('disable requires --id');
      const enable = args.includes('--enable');
      store.updateCredential(id, {
        status: enable ? 'active' : 'disabled',
        updatedAt: new Date().toISOString(),
      });
      console.log(`${id} → ${enable ? 'active' : 'disabled'}`);
      return;
    }
    case 'remove': {
      const id = getFlag(args, 'id');
      if (!id) throw new Error('remove requires --id');
      store.removeCredential(id);
      console.log(`${id} removed.`);
      return;
    }
    case 'user': {
      const userId = getFlag(args, 'user');
      const mode = getFlag(args, 'platform');
      if (!userId || !['on', 'off'].includes(mode ?? '')) {
        throw new Error('user requires --user <id> --platform on|off');
      }
      const enabled = mode === 'on';
      store.setUserPlatformPlan(userId, {
        enabled,
        ...(enabled ? { enabledAt: new Date().toISOString() } : {}),
      });
      console.log(`${userId} platformPlan.enabled=${enabled}`);
      return;
    }
    default:
      console.error('Usage: platform-credentials.mjs <list|add|usage-auth|disable|remove|user> [flags]');
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
