/**
 * The guest's own agent's machine (note #1038): what is on it, who may reach
 * what from it, and the one way a turn is launched there.
 *
 * A guest's agent has EVERY Claude Code tool, a shell included (Adam, 6 Nov
 * 2026, decision 3), so the seal of note #1010 cannot rest on "read-only
 * tools" any more. It rests on these, none of them a sentence in a prompt:
 *
 *  1. NOTHING TO TAKE — now stronger than the guide's. The machine is never
 *     given a platform token, a workplace secret or a preview address
 *     (agent-service and the harness check `isSealedAgent`), and the Claude
 *     SEAT TOKEN NEVER REACHES IT EITHER. A turn gets a per-turn key instead,
 *     and Claude Code is pointed at the platform's model door
 *     (services/guest-model-door.ts), which swaps that key for the seat
 *     token on the backend. The per-turn key works only while its turn runs,
 *     only for Sonnet and Haiku, only up to a request budget. A shell that
 *     prints its environment prints that, and nothing else.
 *  2. A SEPARATE USER. Every turn runs as `guide`: no group of the agent's,
 *     no sudo, no login shell. The agent's home is 0750 and closed to it,
 *     /proc hides every other user's processes, and every process the guide
 *     left running is killed when a turn ends.
 *  3. A CLOSED NETWORK. An nftables rule rejects every packet the guide's
 *     processes send except to this machine's own loopback (and not to its
 *     ssh or 8080 there). Its only way out is a forward proxy on loopback,
 *     run as another user, that connects only to an allow-list: the public
 *     repository's host, the model door's host, and the npm and PyPI
 *     registries. No 6PN (so no other agent's machine), no DNS, no metadata,
 *     no web. The runner also turns off Claude Code's WebFetch and WebSearch.
 *
 * The work lives on the machine's volume (/data/guest), so a sleep, a
 * restart or an image roll keeps the visitor's conversation and changes.
 * The setup below runs as root before every turn; it is idempotent and
 * repairs rather than trusts, and it FAILS CLOSED: no nftables, no turn.
 *
 * Knowledge page: sealed-public-agent. Proof: scripts/probe-guest-agent.mts.
 */
import { createHash } from 'node:crypto';
import { quoteShellArg } from '../utils/shell-quote.js';
import { GUEST_AGENT_EFFORT, GUEST_AGENT_LIMITS, GUEST_AGENT_MODEL, type GuestActivity } from '../shared/guest-agent.js';
import { GUEST_AGENT_INSTRUCTIONS } from '../config/guest-agent-instructions.js';
import { GUIDE_USER } from './public-guide-machine.js';

export const GUEST_USER = GUIDE_USER;
/** The user the egress proxy runs as: the one that may reach the network for the guide, by the allow-list only. */
export const GUEST_EGRESS_USER = 'guidenet';
export const GUEST_ROOT = '/data/guest';
export const GUEST_HOME = `${GUEST_ROOT}/home`;
export const GUEST_CHECKOUT = `${GUEST_ROOT}/agentic-cloud`;
export const GUEST_INSTRUCTIONS_PATH = `${GUEST_ROOT}/instructions.md`;
export const GUEST_LIB = '/usr/local/lib/acc-guest';
export const GUEST_RUNNER_PATH = `${GUEST_LIB}/turn`;
export const GUEST_EGRESS_PATH = `${GUEST_LIB}/egress.mjs`;
export const GUEST_EGRESS_ALLOW_PATH = `${GUEST_LIB}/egress-allow`;
export const GUEST_EGRESS_LOG_DIR = '/var/lib/acc-guest-egress';
export const GUEST_EGRESS_PORT = 3128;
/** Where a turn's stream and per-turn key wait: the AGENT's home, which the guide cannot read. */
export const GUEST_TURN_DIR = '/home/agent/.guest-turns';
/** The env var the launch hands the per-turn key to the runner in. */
export const GUEST_TURN_KEY_ENV = 'ACC_GUEST_TURN_KEY';
/** Package registries a guest's agent may install from. */
export const GUEST_PACKAGE_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org'] as const;
/** Claude Code tools turned off: the network is closed to them anyway, and WebSearch would run on Anthropic's side. */
export const GUEST_DISALLOWED_TOOLS = 'WebFetch,WebSearch';
/** Processes one guide may have at once (a fork bomb ends here, not in the machine). */
export const GUEST_MAX_PROCESSES = 512;

/** Where things come from and go to: the public copy, and the model door. */
export interface GuestMachineSource {
  /** An anonymous clone URL of the PUBLIC repository. */
  cloneUrl: string;
  branch: string;
  /** The model door's base URL (ANTHROPIC_BASE_URL), e.g. https://<backend>/api/guest-model. */
  doorUrl: string;
  /** The agent's name, for its instructions and its commits. */
  agentName: string;
}

/** host:port pairs the egress proxy may connect to. */
export function guestEgressAllowList(source: Pick<GuestMachineSource, 'cloneUrl' | 'doorUrl'>, extra: readonly string[] = []): string[] {
  const entries = new Set<string>();
  for (const raw of [source.cloneUrl, source.doorUrl]) {
    try {
      const url = new URL(raw);
      const port = url.port || (url.protocol === 'http:' ? '80' : '443');
      entries.add(`${url.hostname.toLowerCase()}:${port}`);
    } catch { /* not a URL: nothing allowed for it */ }
  }
  for (const host of GUEST_PACKAGE_HOSTS) entries.add(`${host}:443`);
  for (const entry of extra) entries.add(entry.toLowerCase());
  return [...entries].sort();
}

/**
 * The egress proxy: plain Node, no packages. CONNECT (HTTPS) and absolute
 * HTTP requests, to an allow-listed host:port only; everything else is 403
 * and one line in the deny log. Runs as GUEST_EGRESS_USER on loopback.
 */
export function buildGuestEgressScript(): string {
  return [
    '// Guest agent egress proxy (note #1038). Installed by the backend; do not edit by hand.',
    "import http from 'node:http';",
    "import net from 'node:net';",
    "import { readFileSync, appendFileSync } from 'node:fs';",
    `const allow = new Set(readFileSync('${GUEST_EGRESS_ALLOW_PATH}', 'utf8').split('\\n').map((s) => s.trim().toLowerCase()).filter(Boolean));`,
    `const LOG = '${GUEST_EGRESS_LOG_DIR}/denied.log';`,
    'function deny(what) { try { appendFileSync(LOG, new Date().toISOString() + " " + String(what).slice(0, 200).replace(/\\s+/g, " ") + "\\n"); } catch {} }',
    'function key(host, port) { return String(host || "").toLowerCase().replace(/^\\[|\\]$/g, "") + ":" + String(port); }',
    'const server = http.createServer((req, res) => {',
    '  let url;',
    '  try { url = new URL(req.url); } catch { deny(req.url); res.writeHead(403); res.end("closed"); return; }',
    '  const port = url.port || (url.protocol === "http:" ? "80" : "443");',
    '  if (url.protocol !== "http:" || !allow.has(key(url.hostname, port))) { deny(req.method + " " + url.host); res.writeHead(403); res.end("closed"); return; }',
    '  const headers = { ...req.headers, via: "1.1 acc-guest-egress" }; delete headers["proxy-connection"]; delete headers["proxy-authorization"];',
    '  const up = http.request({ host: url.hostname, port: Number(port), path: url.pathname + url.search, method: req.method, headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });',
    '  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });',
    '  req.pipe(up);',
    '});',
    'server.on("connect", (req, socket, head) => {',
    '  const m = /^\\[?([^\\]]+?)\\]?:(\\d+)$/.exec(String(req.url || ""));',
    '  if (!m || !allow.has(key(m[1], m[2]))) { deny("CONNECT " + req.url); socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }',
    '  const up = net.connect(Number(m[2]), m[1], () => { socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n"); if (head && head.length) up.write(head); up.pipe(socket); socket.pipe(up); });',
    '  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());',
    '});',
    'server.on("clientError", (_e, socket) => socket.destroy());',
    `server.listen(${GUEST_EGRESS_PORT}, '127.0.0.1');`,
    '',
  ].join('\n');
}

/**
 * The nftables table that closes the guide's network. Replaced atomically
 * on every setup (a recreated user can come back with another uid).
 */
export function buildGuestFirewall(): string {
  return [
    'table inet acc_guest',
    'delete table inet acc_guest',
    'table inet acc_guest {',
    '  chain out {',
    '    type filter hook output priority 0; policy accept;',
    `    meta skuid "${GUEST_USER}" oif "lo" tcp dport { 22, 8080 } reject`,
    `    meta skuid "${GUEST_USER}" oif "lo" accept`,
    `    meta skuid "${GUEST_USER}" reject`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * The runner: root-owned, run as the guide through sudo. It keeps exactly one
 * variable of the environment it was started with — the per-turn key — and
 * accepts only the flags a turn needs, then adds the guest's fixed flags.
 * A flag it does not know is refused (exit 64).
 */
export function buildGuestRunnerScript(doorUrl: string): string {
  const proxy = `http://127.0.0.1:${GUEST_EGRESS_PORT}`;
  return `#!/bin/bash
# Guest agent runner (note #1038). Installed by the backend; do not edit by hand.
set -u
if [ "$(id -un)" != "${GUEST_USER}" ]; then echo "guest runner: must run as ${GUEST_USER}" >&2; exit 77; fi
__key="\${${GUEST_TURN_KEY_ENV}:-}"
for __name in $(compgen -e); do unset "$__name" 2>/dev/null || true; done
export HOME='${GUEST_HOME}' PATH='/usr/local/bin:/usr/bin:/bin' LANG='C.UTF-8' TERM='dumb'
export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_OAUTH_TOKEN="$__key" ANTHROPIC_BASE_URL=${quoteShellArg(doorUrl)}
export HTTPS_PROXY='${proxy}' HTTP_PROXY='${proxy}' https_proxy='${proxy}' http_proxy='${proxy}' NO_PROXY='localhost,127.0.0.1,::1' no_proxy='localhost,127.0.0.1,::1'
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
unset __key __name
ulimit -u ${GUEST_MAX_PROCESSES} 2>/dev/null || true
__args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--session-id|--resume|--model|--effort|--max-turns)
      [ "$#" -ge 2 ] || { echo "guest runner: $1 needs a value" >&2; exit 64; }
      __args+=("$1" "$2"); shift 2 ;;
    --output-format)
      [ "\${2:-}" = "stream-json" ] || { echo "guest runner: only stream-json output" >&2; exit 64; }
      __args+=("$1" "$2"); shift 2 ;;
    --verbose|--include-partial-messages) __args+=("$1"); shift ;;
    *) echo "guest runner: refused flag $1" >&2; exit 64 ;;
  esac
done
cd '${GUEST_CHECKOUT}' || { echo "guest runner: no public copy" >&2; exit 70; }
exec claude "\${__args[@]}" \\
  --permission-mode bypassPermissions \\
  --disallowedTools '${GUEST_DISALLOWED_TOOLS}' \\
  --setting-sources '' \\
  --strict-mcp-config \\
  --append-system-prompt-file '${GUEST_INSTRUCTIONS_PATH}' \\
  < /dev/null
`;
}

export function guestInstructionsFor(agentName: string): string {
  return GUEST_AGENT_INSTRUCTIONS.replaceAll('{name}', agentName);
}

/** A fingerprint of what the setup installs, so the machine knows when to reinstall. */
export function guestSetupVersion(source: GuestMachineSource, allow: readonly string[]): string {
  return createHash('sha256')
    .update(buildGuestRunnerScript(source.doorUrl))
    .update(buildGuestEgressScript())
    .update(allow.join('\n'))
    .update(guestInstructionsFor(source.agentName))
    .digest('hex').slice(0, 16);
}

/**
 * The machine's setup, run as root before every guest turn and once when a
 * spare is prepared. Cheap when everything is in place. The public copy is
 * cloned ONCE and never refreshed: it is the visitor's working copy.
 */
export function buildGuestSetupScript(source: GuestMachineSource, options: { extraAllow?: readonly string[] } = {}): string {
  const allow = guestEgressAllowList(source, options.extraAllow);
  const version = guestSetupVersion(source, allow);
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const install = (path: string, content: string, mode: string) =>
    `  printf %s '${b64(content)}' | base64 -d > ${path}.new && chown root:root ${path}.new && chmod ${mode} ${path}.new && mv -f ${path}.new ${path}`;
  const url = quoteShellArg(source.cloneUrl);
  const branch = quoteShellArg(source.branch);
  const anonymousGit = 'env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null';
  return [
    'set -eu',
    'umask 022',
    // Fail closed: without nftables there is no network lock, so no turn.
    'command -v nft >/dev/null 2>&1 || { echo "guest setup: nftables is missing; refusing to run a guest turn" >&2; exit 71; }',
    `[ -d /data ] || { echo "guest setup: no volume at /data" >&2; exit 72; }`,
    // The users: system accounts, own group only, no shell, no sudo.
    `if ! id -u ${GUEST_USER} >/dev/null 2>&1; then useradd --system --user-group --home-dir ${GUEST_HOME} --no-create-home --shell /usr/sbin/nologin ${GUEST_USER}; fi`,
    `if ! id -u ${GUEST_EGRESS_USER} >/dev/null 2>&1; then useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${GUEST_EGRESS_USER}; fi`,
    `for __u in ${GUEST_USER} ${GUEST_EGRESS_USER}; do for __group in $(id -nG $__u); do [ "$__group" = "$__u" ] || gpasswd -d $__u "$__group" >/dev/null 2>&1 || true; done; rm -f /etc/sudoers.d/$__u; done`,
    // The agent's home stays closed to everyone else, the durable copy too.
    'chmod 0750 /home/agent',
    'if [ -d /data/home/agent ]; then chmod 0750 /data/home/agent; fi',
    `install -d -m 0700 -o agent -g agent ${GUEST_TURN_DIR}`,
    // Other users' processes are invisible to the guide; the agent's group still sees all.
    `mount -o remount,hidepid=invisible,gid=$(id -g agent) /proc 2>/dev/null || mount -o remount,hidepid=2,gid=$(id -g agent) /proc 2>/dev/null || true`,
    // The network lock, replaced whole every time.
    `printf %s '${b64(buildGuestFirewall())}' | base64 -d | nft -f -`,
    `nft list table inet acc_guest >/dev/null 2>&1 || { echo "guest setup: the network lock did not load" >&2; exit 73; }`,
    // The folders: on the volume, so a sleep or an image roll keeps the work.
    `install -d -m 0755 -o root -g root ${GUEST_ROOT}`,
    `install -d -m 0700 -o ${GUEST_USER} -g ${GUEST_USER} ${GUEST_HOME}`,
    `[ "$(stat -c %U ${GUEST_HOME})" = "${GUEST_USER}" ] || chown -R ${GUEST_USER}:${GUEST_USER} ${GUEST_HOME}`,
    `install -d -m 0750 -o ${GUEST_EGRESS_USER} -g ${GUEST_EGRESS_USER} ${GUEST_EGRESS_LOG_DIR}`,
    // Runner, proxy, allow-list and instructions, reinstalled whenever their fingerprint moves.
    // The marker lives BESIDE what it vouches for (the root filesystem), and any missing
    // file reinstalls all of them: a fresh root filesystem under an old marker on the
    // volume once skipped the install and left no runner (note #1045).
    `if [ "$(cat ${GUEST_LIB}/.setup-version 2>/dev/null || true)" != "${version}" ] || [ ! -x ${GUEST_RUNNER_PATH} ] || [ ! -f ${GUEST_EGRESS_PATH} ] || [ ! -f ${GUEST_EGRESS_ALLOW_PATH} ] || [ ! -f ${GUEST_INSTRUCTIONS_PATH} ]; then`,
    `  install -d -m 0755 -o root -g root ${GUEST_LIB}`,
    install(GUEST_RUNNER_PATH, buildGuestRunnerScript(source.doorUrl), '0755'),
    install(GUEST_EGRESS_PATH, buildGuestEgressScript(), '0644'),
    install(GUEST_EGRESS_ALLOW_PATH, `${allow.join('\n')}\n`, '0644'),
    install(GUEST_INSTRUCTIONS_PATH, guestInstructionsFor(source.agentName), '0644'),
    `  pkill -u ${GUEST_EGRESS_USER} -f ${GUEST_EGRESS_PATH} 2>/dev/null || true`,
    `  echo '${version}' > ${GUEST_LIB}/.setup-version`,
    'fi',
    // The proxy: running, as its own user, or started.
    `if ! pgrep -u ${GUEST_EGRESS_USER} -f ${GUEST_EGRESS_PATH} >/dev/null 2>&1; then`,
    `  setsid sudo -n -u ${GUEST_EGRESS_USER} env -i PATH=/usr/local/bin:/usr/bin:/bin node ${GUEST_EGRESS_PATH} </dev/null >/dev/null 2>&1 &`,
    '  for __i in 1 2 3 4 5 6 7 8 9 10; do',
    `    if (exec 3<>/dev/tcp/127.0.0.1/${GUEST_EGRESS_PORT}) 2>/dev/null; then break; fi`,
    '    sleep 0.3',
    '  done',
    'fi',
    // The public copy: cloned once, anonymously, then the visitor's to change.
    `if [ ! -d ${GUEST_CHECKOUT}/.git ]; then`,
    `  rm -rf ${GUEST_CHECKOUT}.new`,
    `  ${anonymousGit} timeout 300 git clone --quiet --depth 1 --single-branch --branch ${branch} ${url} ${GUEST_CHECKOUT}.new`,
    `  ${anonymousGit} git -C ${GUEST_CHECKOUT}.new remote remove origin`,
    `  chown -R ${GUEST_USER}:${GUEST_USER} ${GUEST_CHECKOUT}.new`,
    `  mv ${GUEST_CHECKOUT}.new ${GUEST_CHECKOUT}`,
    'fi',
    `[ "$(stat -c %U ${GUEST_CHECKOUT})" = "${GUEST_USER}" ] || chown -R ${GUEST_USER}:${GUEST_USER} ${GUEST_CHECKOUT}`,
    `[ -x ${GUEST_RUNNER_PATH} ] || { echo "guest setup: the runner is missing after install" >&2; exit 74; }`,
    `sudo -n -u ${GUEST_USER} env -i HOME=${GUEST_HOME} PATH=/usr/local/bin:/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C ${GUEST_CHECKOUT} config user.name ${quoteShellArg(source.agentName)}`,
    `sudo -n -u ${GUEST_USER} env -i HOME=${GUEST_HOME} PATH=/usr/local/bin:/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C ${GUEST_CHECKOUT} config user.email guest-agent@agenticcloudcomputer.com`,
  ].join('\n');
}

/** Run the setup as root, its output on stderr so a stream on stdout stays clean. */
export function buildGuestSetupCommand(source: GuestMachineSource, options: { extraAllow?: readonly string[] } = {}): string {
  const delimiter = 'GUEST_SETUP_EOF';
  return `sudo -n bash -s >&2 <<'${delimiter}'\n${buildGuestSetupScript(source, options)}\n${delimiter}`;
}

/** Every process the guide left behind, ended (after each turn, and on Stop). */
export function buildGuestReapCommand(signal: 'TERM' | 'KILL' = 'KILL'): string {
  // pkill only sends the signal; wait (up to 3 s) until the processes are actually gone.
  return `sudo -n pkill -${signal} -u ${GUEST_USER} >/dev/null 2>&1; for __i in $(seq 1 30); do pgrep -u ${GUEST_USER} >/dev/null 2>&1 || break; sleep 0.1; done; true`;
}

export interface GuestTurnArgs {
  prompt: string;
  sessionId?: string;
  resumeSessionId?: string;
}

/**
 * The launch of one guest turn: as the guide, through the runner. The
 * per-turn key is read from a 0600 file in the agent's home and removed
 * before anything else runs, so it is never a command argument.
 */
export function buildGuestClaudeCommand(args: GuestTurnArgs & { keyFile: string; streamFile: string; timeoutSeconds: number }): string {
  const parts = [
    `timeout -k 5 ${args.timeoutSeconds}`,
    'sudo', '-n', `--preserve-env=${GUEST_TURN_KEY_ENV}`, '-u', GUEST_USER, '--', GUEST_RUNNER_PATH,
    '-p', quoteShellArg(args.prompt),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', GUEST_AGENT_MODEL,
    '--effort', GUEST_AGENT_EFFORT,
    '--max-turns', String(GUEST_AGENT_LIMITS.maxTurns),
  ];
  if (args.resumeSessionId) parts.push('--resume', quoteShellArg(args.resumeSessionId));
  else if (args.sessionId) parts.push('--session-id', quoteShellArg(args.sessionId));
  return [
    'set -o pipefail',
    `${GUEST_TURN_KEY_ENV}="$(cat ${quoteShellArg(args.keyFile)})"`,
    `rm -f ${quoteShellArg(args.keyFile)}`,
    `export ${GUEST_TURN_KEY_ENV}`,
    `${parts.join(' ')} | tee ${quoteShellArg(args.streamFile)}`,
    '__status=$?',
    `unset ${GUEST_TURN_KEY_ENV}`,
    buildGuestReapCommand('KILL'),
    `rm -f ${quoteShellArg(args.streamFile)}`,
    'exit $__status',
  ].join('\n');
}

/** What a guest turn's stream said so far, read line by line. */
export interface GuestStreamReading {
  activity: GuestActivity[];
  files: string[];
  /** The text of the message being written now (partial events), or the last assistant text. */
  partial: string | null;
  answer: string | null;
  isError: boolean;
  errorText?: string;
  sessionId?: string;
  costUsd?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A path as the page may show it: relative to the copy, or nothing. */
export function guestRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let path = raw.trim();
  if (path.startsWith(`${GUEST_CHECKOUT}/`)) path = path.slice(GUEST_CHECKOUT.length + 1);
  else if (path === GUEST_CHECKOUT || path === '.' || path === './') return null;
  else if (path.startsWith('/') || path.startsWith('~')) return null;
  path = path.replace(/^\.\/+/, '');
  const segments = path.split('/');
  if (!path || segments.some((segment) => segment === '..' || segment === '')) return null;
  if (segments[0] === '.git') return null;
  return path;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One tool call as the margin shows it, or null for one it does not. */
export function guestActivityOf(name: unknown, input: Record<string, unknown>): GuestActivity | null {
  const tool = typeof name === 'string' ? name : '';
  const path = (value: unknown) => guestRelativePath(value);
  switch (tool) {
    case 'Read': {
      const file = path(input.file_path);
      return file ? { kind: 'read', label: file } : null;
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const file = path(input.file_path ?? input.notebook_path);
      return file ? { kind: 'edit', label: file } : null;
    }
    case 'Grep': case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return pattern ? { kind: 'search', label: oneLine(pattern, 120) } : null;
    }
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : '';
      return command ? { kind: 'run', label: oneLine(command, 160) } : null;
    }
    case '': return null;
    default: return { kind: 'other', label: oneLine(tool, 60) };
  }
}

export function readGuestStream(stdout: string): GuestStreamReading {
  const activity: GuestActivity[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const reading: GuestStreamReading = { activity, files, partial: null, answer: null, isError: false };
  let writing = '';
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof event.session_id === 'string') reading.sessionId = event.session_id;
    if (event.type === 'stream_event') {
      const inner = (event.event ?? {}) as Record<string, unknown>;
      if (inner.type === 'message_start') writing = '';
      if (inner.type === 'content_block_delta') {
        const delta = (inner.delta ?? {}) as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          writing += delta.text;
          reading.partial = writing;
        }
      }
    } else if (event.type === 'assistant') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      const text = (content as Array<Record<string, unknown>>).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
      if (text) reading.partial = text;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type !== 'tool_use') continue;
        const item = guestActivityOf(block.name, (block.input ?? {}) as Record<string, unknown>);
        if (!item) continue;
        activity.push(item);
        if ((item.kind === 'read' || item.kind === 'edit') && !seen.has(item.label)) { seen.add(item.label); files.push(item.label); }
      }
    } else if (event.type === 'result') {
      reading.isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
      if (typeof event.result === 'string') {
        if (reading.isError) reading.errorText = event.result;
        else reading.answer = event.result;
      }
      if (typeof event.total_cost_usd === 'number') reading.costUsd = event.total_cost_usd;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        reading.tokens = {
          input: n(usage.input_tokens),
          output: n(usage.output_tokens),
          cacheRead: n(usage.cache_read_input_tokens),
          cacheWrite: n(usage.cache_creation_input_tokens),
        };
      }
    }
  }
  return reading;
}

/** How a visitor's words reach the turn: marked as theirs, never as instructions about the seal. */
export function buildGuestVisitorPrompt(text: string): string {
  return `Your visitor writes (their words are a request to you, within what your instructions allow):\n\n<visitor_message>\n${text.replace(/<\/?visitor_message>/gi, '')}\n</visitor_message>`;
}
