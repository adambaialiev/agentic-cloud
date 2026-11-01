#!/usr/bin/env node
// Read the conversation between a Telegram user and their connected CLI agent.
//
// Connected-harness turns are NOT stored on the platform (see
// docs/firestore-agent-session-removal.md — "there is no platform transcript to
// archive for connected-harness turns"). The conversation lives only in the
// CLI's native session file on the agent's Fly machine, under the durable
// /home/agent volume:
//   Claude → ~/.claude/projects/-home-agent/<claudeSessionId>.jsonl
//   Codex  → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<codexThreadId>.jsonl
//
// The machine's sshd (port 2222, key-only, user `agent`) is reachable only from
// the Fly WireGuard peer — the backend host — because of the image firewall, so
// this script jumps through that host to reach the machine over 6PN. A stopped
// (idle-reaped) machine is started automatically first.
//
// Usage:
//   npm --prefix backend run read-agent-conversation -- --user-id <uid> [options]
//
// Options:
//   --user-id <uid>       (required) the Telegram user (e.g. tg_...).
//   --agent-id <id>       Read this exact agent. Default: the user's active agent.
//   --cli <claude|codex>  Read the user's agent for this CLI instead of --agent-id.
//   --all                 Read every connected agent the user has.
//   --limit <n>           Only show the last N turns. Default: all.
//   --role <user|assistant|all>   Filter turns by role. Default: all.
//   --include-injected    Show injected instruction/environment blocks (collapsed by default).
//   --no-start            Do NOT auto-start a stopped machine; fail instead.
//   --json                Emit parsed turns as JSON instead of pretty text.
//   --raw                 Print the raw CLI session JSONL (no parsing).
//   --server-id <id>      Bypass the profile lookup; read this fly_<app>.<machine> directly
//                         (requires --cli and --conversation-id).
//   --conversation-id <id>  With --server-id: the claudeSessionId / codexThreadId.
//   --help
//
// Environment:
//   SQLITE_DB_PATH       The backend's SQLite file (not needed with --server-id).
//   IA_BACKEND_HOST      Jump host on the Fly WireGuard net. Required.
//   IA_BACKEND_SSH_KEY   Local SSH key for the jump host. Default ~/.ssh/hetzner_backend.
//   IA_BACKEND_ENV_PATH  File on the host holding FLY_SSH_PRIVATE_KEY.
//                        Default /etc/infinite-agents/backend.env.
//   IA_MACHINE_SSH_PORT  Machine sshd port. Default 2222.
//   IA_MACHINE_SSH_USER  Machine ssh user. Default agent.
//   FLYCTL               flyctl binary. Default "flyctl".

import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');

const HOST = process.env.IA_BACKEND_HOST || (() => { throw new Error('Set IA_BACKEND_HOST to the backend host'); })();
const HOST_KEY = process.env.IA_BACKEND_SSH_KEY || path.join(homedir(), '.ssh', 'hetzner_backend');
const ENV_PATH = process.env.IA_BACKEND_ENV_PATH || '/etc/infinite-agents/backend.env';
const MACHINE_PORT = process.env.IA_MACHINE_SSH_PORT || '2222';
const MACHINE_USER = process.env.IA_MACHINE_SSH_USER || 'agent';
const FLYCTL = process.env.FLYCTL || 'flyctl';

const COLOR = process.stdout.isTTY;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const cyan = (s) => c('36', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);

function loadEnvFiles() {
  for (const envPath of [
    path.join(backendRoot, '.env.local'),
    path.join(backendRoot, '.env'),
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
  ]) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

function printUsage() {
  console.log(`Usage:
  npm --prefix backend run read-agent-conversation -- --user-id <uid> [options]

See the header comment in ${path.relative(repoRoot, fileURLToPath(import.meta.url))} for all options.
Common:
  --user-id <uid>        the Telegram user (required unless --server-id)
  --agent-id <id>        a specific agent (default: active)
  --cli <claude|codex>   pick the user's agent by CLI
  --all                  every connected agent
  --limit <n>            last N turns
  --role <user|assistant|all>
  --include-injected     show injected instruction blocks
  --include-tools        show tool_use/tool_result turns (Claude)
  --no-start             don't auto-start a reaped machine
  --json | --raw`);
}

function parseArgs(argv) {
  const o = {
    userId: null, agentId: null, cli: null, all: false, limit: 0,
    role: 'all', includeInjected: false, includeTools: false, start: true, json: false, raw: false,
    serverId: null, conversationId: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case '--user-id': o.userId = next(); break;
      case '--agent-id': o.agentId = next(); break;
      case '--cli': o.cli = next(); break;
      case '--all': o.all = true; break;
      case '--limit': o.limit = Number.parseInt(next(), 10) || 0; break;
      case '--role': o.role = next(); break;
      case '--include-injected': o.includeInjected = true; break;
      case '--include-tools': o.includeTools = true; break;
      case '--no-start': o.start = false; break;
      case '--json': o.json = true; break;
      case '--raw': o.raw = true; break;
      case '--server-id': o.serverId = next(); break;
      case '--conversation-id': o.conversationId = next(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return o;
}

// ── User profile ───────────────────────────────────────────────────────────

/**
 * The profile is read from the backend's SQLite file through the compiled
 * sqlite-db module (needs `dist/` built — true on the prod host).
 */
async function loadProfile(userId) {
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const { openSqliteDb, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const db = openSqliteDb(sqlitePath);
  const row = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId);
  if (!row) throw new Error(`No user ${userId}`);
  return deserializeDoc(row.doc);
}

async function resolveAgents(opts) {
  const profile = await loadProfile(opts.userId);
  const tg = profile.telegram || {};
  const agents = tg.agents || {};
  const list = Object.values(agents);
  if (list.length === 0) throw new Error(`User ${opts.userId} has no agents.`);

  let targets;
  if (opts.all) {
    targets = list;
  } else if (opts.agentId) {
    const a = agents[opts.agentId];
    if (!a) throw new Error(`No agent ${opts.agentId} for this user.`);
    targets = [a];
  } else if (opts.cli) {
    const active = tg.activeAgentId ? agents[tg.activeAgentId] : undefined;
    targets = active?.cli === opts.cli
      ? [active]
      : list.filter((a) => a.cli === opts.cli);
    if (targets.length === 0) throw new Error(`No ${opts.cli} agent for this user.`);
  } else {
    const active = tg.activeAgentId ? agents[tg.activeAgentId] : undefined;
    if (!active) throw new Error('No active agent; pass --agent-id, --cli, or --all.');
    targets = [active];
  }
  return targets.map((a) => ({
    id: a.id,
    name: a.name,
    cli: a.cli,
    serverId: a.serverId,
    connectedAt: a.connectedAt,
    conversationId: a.cli === 'claude' ? a.conversation?.claudeSessionId : a.conversation?.codexThreadId,
  }));
}

// ── Fly + remote read ────────────────────────────────────────────────────────

function parseServerId(serverId) {
  const m = /^fly_(.+)\.([^.]+)$/.exec(serverId || '');
  if (!m) throw new Error(`serverId ${serverId} is not a Fly machine (fly_<app>.<machine>).`);
  return { app: m[1], machineId: m[2] };
}

function fly(args) {
  const res = spawnSync(FLYCTL, args, { encoding: 'utf8' });
  if (res.error) throw new Error(`Failed to run ${FLYCTL}: ${res.error.message}`);
  return res;
}

function getMachine(app, machineId) {
  const res = fly(['machines', 'list', '-a', app, '--json']);
  if (res.status !== 0) throw new Error(`flyctl machines list failed for ${app}: ${res.stderr}`);
  let arr;
  try { arr = JSON.parse(res.stdout); } catch { throw new Error(`Could not parse flyctl JSON for ${app}.`); }
  const m = arr.find((x) => x.id === machineId);
  if (!m) throw new Error(`Machine ${machineId} not found in app ${app}.`);
  const ip = m.private_ip || m.ips?.find?.((x) => x.family === 'v6')?.ip;
  return { state: m.state, ip };
}

// Run a bash script on the jump host (backend peer). Returns { status, stdout, stderr }.
function onHost(script, env = {}) {
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const res = spawnSync('ssh', [
    '-i', HOST_KEY, '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new',
    `root@${HOST}`, `${envPrefix} bash -s`,
  ], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`ssh to ${HOST} failed: ${res.error.message}`);
  return res;
}

// Extract FLY_SSH_PRIVATE_KEY on the host, ssh to the machine over 6PN, and run
// the base64-encoded remote command there. The command is base64 so neither the
// jump host nor the ssh arg parsing can evaluate the machine-side `$(find …)`,
// `~`, or `$f` — the machine decodes and runs it locally.
const MACHINE_WRAPPER = `
set -uo pipefail
line=$(grep -E '^(FLY_SSH_PRIVATE_KEY|HETZNER_SSH_PRIVATE_KEY)=' "$ENVPATH" | head -1 || true)
if [ -z "$line" ]; then echo "__NOKEY__" >&2; exit 3; fi
val=\${line#*=}; val=\${val%\\"}; val=\${val#\\"}
KEYF=$(mktemp); printf '%b\\n' "$val" > "$KEYF"; chmod 600 "$KEYF"
trap 'rm -f "$KEYF"' EXIT
ssh -6 -i "$KEYF" -p "$PORT" -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout="$CT" "$MUSER@$MC" "echo $RCMD_B64 | base64 -d | bash"
`;

function machineExec(ip, remoteCmd, connectTimeout = 15) {
  return onHost(MACHINE_WRAPPER, {
    ENVPATH: ENV_PATH, PORT: MACHINE_PORT, MUSER: MACHINE_USER, MC: ip,
    CT: String(connectTimeout), RCMD_B64: Buffer.from(remoteCmd, 'utf8').toString('base64'),
  });
}

function probe(ip) {
  return machineExec(ip, 'echo ok', 8).status === 0;
}

async function ensureStarted(app, machineId, opts) {
  let { state, ip } = getMachine(app, machineId);
  if (state === 'started') return ip;
  if (!opts.start) throw new Error(`Machine ${machineId} is ${state}; pass without --no-start to auto-start it.`);
  process.stderr.write(dim(`  machine ${machineId} is ${state} — starting…\n`));
  const res = fly(['machine', 'start', machineId, '-a', app]);
  if (res.status !== 0) throw new Error(`flyctl machine start failed: ${res.stderr}`);
  ip = getMachine(app, machineId).ip;
  for (let i = 0; i < 24; i += 1) {
    if (probe(ip)) { process.stderr.write(dim(`  reachable after ~${(i + 1) * 5}s\n`)); return ip; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Machine ${machineId} did not become SSH-reachable in time.`);
}

function findAndReadSession(ip, cli, conversationId) {
  const findDir = cli === 'claude' ? '~/.claude/projects' : '~/.codex/sessions';
  const findName = cli === 'claude' ? `${conversationId}.jsonl` : `*${conversationId}*.jsonl`;
  // Find the file, then base64 it back (safe transport for any content/size).
  const remote = `f=$(find ${findDir} -name '${findName}' 2>/dev/null | head -1); `
    + `if [ -z "$f" ]; then echo __NOFILE__; exit 0; fi; echo "__FILE__ $f"; base64 < "$f"`;
  const res = machineExec(ip, remote, 20);
  if (res.status !== 0) throw new Error(`Reading session on the machine failed: ${res.stderr || res.stdout}`);
  const out = res.stdout;
  if (out.includes('__NOFILE__')) return { file: null, jsonl: null };
  const nl = out.indexOf('\n');
  const first = out.slice(0, nl).trim();
  const file = first.startsWith('__FILE__') ? first.slice('__FILE__'.length).trim() : null;
  const b64 = out.slice(nl + 1);
  const jsonl = Buffer.from(b64, 'base64').toString('utf8');
  return { file, jsonl };
}

// ── Parsers ──────────────────────────────────────────────────────────────────

const INJECTED_RE = /^(#\s*(AGENTS|CLAUDE)\.md|<environment_context>|<user_instructions>|<INSTRUCTIONS>)/;

function classify(text) {
  const t = text.trimStart();
  if (INJECTED_RE.test(t) || t.includes('MACHINE-FACTS:START')) return 'injected';
  return 'text';
}

// Returns { text, hasText, hasTool } so pure tool_use/tool_result turns can be
// collapsed out of the default conversation view.
function claudeParts(content) {
  if (typeof content === 'string') return { text: content, hasText: Boolean(content), hasTool: false };
  if (!Array.isArray(content)) return { text: '', hasText: false, hasTool: false };
  const parts = [];
  let hasText = false; let hasTool = false;
  for (const b of content) {
    if (b?.type === 'text' && b.text) { parts.push(b.text); hasText = true; }
    else if (b?.type === 'tool_use') { parts.push(`[tool_use: ${b.name || '?'}]`); hasTool = true; }
    else if (b?.type === 'tool_result') { parts.push('[tool_result]'); hasTool = true; }
    else if (typeof b?.text === 'string') { parts.push(b.text); hasText = true; }
  }
  return { text: parts.join(' '), hasText, hasTool };
}

function codexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => b?.text || b?.input_text || b?.output_text || '').join('');
}

function parseTurns(jsonl, cli) {
  const turns = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (cli === 'claude') {
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      const msg = o.message;
      if (!msg) continue;
      const { text: raw, hasText, hasTool } = claudeParts(msg.content);
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const kind = classify(text) === 'injected' ? 'injected' : (!hasText && hasTool ? 'tool' : 'text');
      turns.push({ ts: o.timestamp || '', role: msg.role || o.type, text, kind });
    } else {
      const p = o.payload || o;
      if (p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue;
      const text = codexText(p.content).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      turns.push({ ts: o.timestamp || p.timestamp || '', role: p.role, text, kind: classify(text) });
    }
  }
  return turns;
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderTurn(t) {
  const ts = t.ts ? dim(t.ts.replace('T', ' ').replace(/\.\d+Z?$/, 'Z')) : '';
  if (t.kind === 'injected') {
    return `${ts} ${dim(`[injected ${t.role} context — ${t.text.slice(0, 48)}…]`)}`;
  }
  if (t.kind === 'tool') {
    return `${ts} ${dim(`[${t.role} ${t.text.slice(0, 80)}]`)}`;
  }
  const label = t.role === 'user' ? cyan('USER') : green('AGENT');
  return `${ts} ${bold(label)}: ${t.text}`;
}

async function readOne(target, opts) {
  const header = `${bold(target.name)} ${dim(`(${target.cli})`)}  agent=${target.id}  server=${target.serverId || '—'}`;
  process.stderr.write(`\n${yellow('━'.repeat(4))} ${header}\n`);
  if (!target.serverId) { process.stderr.write(dim('  no server recorded — skipping\n')); return { target, turns: [] }; }
  if (!target.conversationId) {
    process.stderr.write(dim('  no conversation started yet (no session/thread id) — skipping\n'));
    return { target, turns: [] };
  }
  const { app, machineId } = parseServerId(target.serverId);
  const ip = await ensureStarted(app, machineId, opts);
  const { file, jsonl } = findAndReadSession(ip, target.cli, target.conversationId);
  if (!jsonl) {
    process.stderr.write(dim(`  no session file on the machine for ${target.conversationId}\n`));
    return { target, turns: [] };
  }
  process.stderr.write(dim(`  file: ${file}\n`));
  if (opts.raw) { process.stdout.write(jsonl.endsWith('\n') ? jsonl : `${jsonl}\n`); return { target, turns: [] }; }

  let turns = parseTurns(jsonl, target.cli);
  if (!opts.includeInjected) turns = turns.filter((t) => t.kind !== 'injected');
  if (!opts.includeTools) turns = turns.filter((t) => t.kind !== 'tool');
  if (opts.role !== 'all') turns = turns.filter((t) => t.role === opts.role);
  if (opts.limit > 0) turns = turns.slice(-opts.limit);
  return { target, file, turns };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return; }

  let targets;
  if (opts.serverId) {
    if (!opts.cli || !opts.conversationId) {
      throw new Error('--server-id requires --cli and --conversation-id.');
    }
    targets = [{ id: '(manual)', name: '(manual)', cli: opts.cli, serverId: opts.serverId, conversationId: opts.conversationId }];
  } else {
    if (!opts.userId) { printUsage(); throw new Error('\n--user-id is required.'); }
    loadEnvFiles();
    targets = await resolveAgents(opts);
  }

  const results = [];
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await readOne(target, opts));
  }

  if (opts.json) {
    console.log(JSON.stringify(results.map((r) => ({
      agentId: r.target.id, cli: r.target.cli, serverId: r.target.serverId, file: r.file, turns: r.turns,
    })), null, 2));
    return;
  }
  if (opts.raw) return;

  for (const { target, turns } of results) {
    if (turns.length === 0) continue;
    console.log(`\n${bold('#')} ${target.name} (${target.cli}) — ${turns.length} turns`);
    for (const t of turns) console.log(renderTurn(t));
  }
}

main().then(() => process.exit(0)).catch((err) => {
  process.stderr.write(`${c('31', 'Error')}: ${err.message}\n`);
  process.exit(1);
});
