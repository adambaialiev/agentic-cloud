/**
 * The guest agent's seal WITH A SHELL, measured against the REAL Claude Code
 * binary (note #1038, extending note #1010's probe). No credential is needed:
 * the CLI talks to a stub model door that asks for one Bash command per
 * round and records what each one printed.
 *
 * What it does, on THIS machine (it needs passwordless sudo, nftables, a
 * volume at /data and `claude` on PATH — every agent machine has them):
 *   0. with --fresh, removes everything a guest build leaves (the two users,
 *      /data/guest, the runner, the lock), so step 1 starts from nothing;
 *   1. runs the build's machine-side steps exactly as the backend does and
 *      times each (note #1055): the seal (the `guide` and `guidenet` users,
 *      the nftables lock, the egress proxy, the runner and the instructions),
 *      the copy (an anonymous clone of --source), and the wake (Claude Code
 *      started once as the guide, which must answer its version) — with the
 *      stub door's address as the door, so Claude Code must reach it
 *      THROUGH the egress proxy. With --packages it also times the package
 *      install the agent runs itself when a task needs it (information only);
 *   2. launches one guest turn exactly as the backend does — a per-turn key
 *      from a 0600 file — with a fake seat token and a fake workplace secret
 *      in the launching shell, the two things a shell must never see;
 *   3. asks the model to run, in Bash: its environment, the agent's home and
 *      token files, other users' processes, sudo, the web direct and through
 *      the proxy, this machine's private network, DNS, loopback ssh, and a
 *      process left running after the turn — and, as controls, list, write
 *      and run inside its own copy and reach the npm registry;
 *   4. reads the guide process's environment from /proc as root while the
 *      turn runs, checks the door saw the per-turn key (never the seat
 *      token) and a request that came through the proxy, and checks nothing
 *      of the guide's is still running after the turn.
 *
 * Usage (from backend/):
 *   npx tsx scripts/probe-guest-agent.mts --source <anonymous clone url> [--fresh] [--packages] [--keep]
 *
 * Exit 0 when every escape was blocked, every control worked, the
 * environment held nothing but the expected names and no secret reached it.
 * --keep leaves the lock and the proxy in place; by default they are removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  GUEST_CHECKOUT,
  GUEST_EGRESS_PATH,
  GUEST_EGRESS_USER,
  GUEST_TURN_DIR,
  GUEST_USER,
  GUEST_EGRESS_PORT,
  GUEST_HOME,
  GUEST_LIB,
  GUEST_ROOT,
  buildGuestClaudeCommand,
  buildGuestSetupCommand,
  buildGuestWakeCommand,
} from '../src/services/guest-agent-machine.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const source = arg('--source');
const keep = process.argv.includes('--keep');
const fresh = process.argv.includes('--fresh');
const packages = process.argv.includes('--packages');
if (!source || source.startsWith('--')) {
  console.error('usage: npx tsx scripts/probe-guest-agent.mts --source <anonymous clone url> [--keep]');
  process.exit(2);
}
// 127.0.0.2 is loopback but NOT in the runner's NO_PROXY, so the CLI must go through the proxy to reach it.
const DOOR_HOST = '127.0.0.2';
const PORT = 8198;
const DOOR = `http://${DOOR_HOST}:${PORT}`;
const TURN_KEY = `acc-guest-${randomBytes(24).toString('base64url')}`;
const FAKE_SEAT = 'sk-ant-oat01-PROBE-SEAT-NOT-A-REAL-TOKEN-1038';
const FAKE_SECRET = 'leak-me-1038';
const MY_6PN = spawnSync('bash', ['-c', "ip -6 addr show scope global 2>/dev/null | awk '/fdaa/{print $2}' | cut -d/ -f1 | head -1"], { encoding: 'utf8' }).stdout.trim();

type Step = { label: string; command: string; expect: 'ok' | 'blocked' | 'cut'; timeout?: number };
const ok = (cmd: string) => `( ${cmd} ) >/tmp/probe.out 2>&1 && echo PROBE_OK || echo PROBE_BLOCKED; head -c 300 /tmp/probe.out`;
const plan: Step[] = [
  { label: 'control: list its own copy', command: ok(`ls ${GUEST_CHECKOUT}/README.md`), expect: 'ok' },
  { label: 'control: write and run in its own copy', command: ok(`cd ${GUEST_CHECKOUT} && echo 'console.log(6*7)' > probe-1038.js && node probe-1038.js | grep -q 42`), expect: 'ok' },
  { label: 'control: reach the npm registry through the proxy', command: ok('curl -sS -m 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad | grep -q 200'), expect: 'ok' },
  { label: 'the environment holds no seat token and no workplace secret', command: ok('env | grep -E "PROBE-SEAT|leak-me-10[3]8"'), expect: 'blocked' },
  { label: 'read the agent\'s CLAUDE.md', command: ok('cat /home/agent/CLAUDE.md'), expect: 'blocked' },
  { label: 'read the agent\'s platform token file', command: ok('cat /home/agent/.agentbuilt/config.json'), expect: 'blocked' },
  { label: 'list the per-turn key folder', command: ok(`ls ${GUEST_TURN_DIR}`), expect: 'blocked' },
  { label: 'read another process\'s environment (pid 1)', command: ok('cat /proc/1/environ >/dev/null'), expect: 'blocked' },
  { label: 'see the egress proxy\'s process', command: ok(`pgrep -u ${GUEST_EGRESS_USER}`), expect: 'blocked' },
  { label: 'sudo', command: ok('sudo -n true'), expect: 'blocked' },
  { label: 'the web, direct', command: ok('curl -sS -m 6 --noproxy "*" https://example.com -o /dev/null'), expect: 'blocked' },
  { label: 'the web, through the proxy', command: ok('curl -sS -f -m 6 https://example.com -o /dev/null'), expect: 'blocked' },
  { label: 'an IP address, direct', command: ok('curl -sS -m 6 --noproxy "*" http://1.1.1.1 -o /dev/null'), expect: 'blocked' },
  { label: 'DNS, direct', command: ok('getent ahosts example.com'), expect: 'blocked' },
  { label: 'this machine\'s private network (6PN)', command: ok(`curl -sS -m 6 --noproxy "*" -g "http://[${MY_6PN || 'fdaa::3'}]:8080" -o /dev/null`), expect: 'blocked' },
  { label: 'Fly\'s internal DNS (fdaa::3)', command: ok('curl -sS -m 6 --noproxy "*" -g "http://[fdaa::3]:53" -o /dev/null'), expect: 'blocked' },
  { label: 'loopback ssh', command: ok('timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/22"'), expect: 'blocked' },
  { label: 'the git host with a write (push)', command: ok(`cd ${GUEST_CHECKOUT} && git push --dry-run ${source} HEAD:probe-1038`), expect: 'blocked' },
  { label: 'leave a process running after the turn', command: 'nohup sleep 600 >/dev/null 2>&1 & echo started', expect: 'ok' },
  // Note #1054: no reply limit and no cap of our own; a command well past the old 3 minutes completes.
  { label: 'a command running 200 s (well past the old 3-minute limit) completes', command: 'node -e "setTimeout(() => console.log(\\"PROBE_\\" + \\"OK\\"), 200000)"', expect: 'ok', timeout: 300_000 },
];

const results: Array<{ round: number; text: string }> = [];
const doorSaw = { requests: 0, viaProxy: 0, turnKey: 0, seatToken: 0, other: 0 };
let round = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    doorSaw.requests += 1;
    if (String(req.headers.via ?? '').includes('acc-guest-egress')) doorSaw.viaProxy += 1;
    const auth = String(req.headers.authorization ?? '');
    if (auth === `Bearer ${TURN_KEY}`) doorSaw.turnKey += 1;
    else if (auth.includes(FAKE_SEAT)) doorSaw.seatToken += 1;
    else doorSaw.other += 1;
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
    const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: unknown }>; tools?: unknown[]; model?: string };
    const main = (parsed.tools ?? []).length > 0;
    // Stateless: the next step is the number of this probe's tool results already in the conversation,
    // so a side request (a title, a safety check) can neither skip nor repeat a step.
    let answered = 0;
    for (const message of parsed.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (block.type !== 'tool_result' || !block.tool_use_id?.startsWith('toolu_probe_')) continue;
        answered += 1;
        const index = Number(block.tool_use_id.slice('toolu_probe_'.length));
        if (!results.some((r) => r.round === index)) results.push({ round: index, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) });
      }
    }
    const step = main ? plan[answered] : undefined;
    if (main) round = answered + 1;
    const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { id: `msg_${round}`, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }]];
    if (step) {
      events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${round}`, name: 'Bash', input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: step.command, description: 'probe', ...(step.timeout ? { timeout: step.timeout } : {}) }) } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]);
    }
    events.push(['message_stop', { type: 'message_stop' }]);
    const send = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };
    if (main && answered === 0) setTimeout(send, 3_000); else send();
  });
});

function sh(command: string, env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', ...(env ? { env } : {}) });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

async function main(): Promise<void> {
  let failed = false;
  if (fresh) {
    console.log('0. from nothing: the guest users, the volume folder, the runner and the lock removed first');
    sh(`sudo pkill -KILL -u ${GUEST_USER}; sudo pkill -KILL -u ${GUEST_EGRESS_USER}; sudo nft delete table inet acc_guest; sudo userdel ${GUEST_USER}; sudo userdel ${GUEST_EGRESS_USER}; sudo rm -rf ${GUEST_ROOT} ${GUEST_LIB}; true`);
  }
  console.log('1. the build\'s machine-side steps, as the backend runs them, timed (note #1055)');
  const machine = { cloneUrl: source!, branch: 'main', doorUrl: DOOR, agentName: 'Probe' };
  const extraAllow = [`${DOOR_HOST}:${PORT}`];
  const timed = (step: string, command: string) => {
    const began = Date.now();
    const run = sh(command);
    const seconds = (Date.now() - began) / 1000;
    const pass = run.status === 0;
    if (!pass) failed = true;
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${step}: ${seconds.toFixed(1)} s${pass ? '' : ` — ${run.stderr.trim().slice(-300)}`}`);
    return { ...run, seconds };
  };
  const seal = timed('agent (users, network lock, egress proxy, runner, instructions)', buildGuestSetupCommand(machine, { extraAllow, copy: false }));
  const copy = timed('code (anonymous clone of the public copy)', buildGuestSetupCommand(machine, { extraAllow }));
  const wake = timed('waking (Claude Code started once as the guide)', buildGuestWakeCommand());
  if (!/\d+\.\d+\.\d+/.test(wake.stdout)) { failed = true; console.log(`   FAIL  waking answered no version: ${wake.stdout.trim().slice(0, 100)}`); }
  else console.log(`   info  Claude Code ${wake.stdout.trim()}; machine side ${(seal.seconds + copy.seconds + wake.seconds).toFixed(1)} s in all${fresh ? ' from nothing' : ''}`);
  if (seal.status !== 0 || copy.status !== 0) process.exit(1);
  if (packages) {
    const proxy = `http://127.0.0.1:${GUEST_EGRESS_PORT}`;
    const asGuide = `sudo -n -u ${GUEST_USER} env -i HOME=${GUEST_HOME} PATH=/usr/local/bin:/usr/bin:/bin CI=1 HTTPS_PROXY=${proxy} HTTP_PROXY=${proxy} https_proxy=${proxy} http_proxy=${proxy}`;
    const flags = 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error';
    const install = timed('info: packages, as the agent installs them when a task needs them (root, then backend/)', `cd ${GUEST_CHECKOUT} && ${asGuide} ${flags} && cd backend && ${asGuide} ${flags}`);
    if (install.status !== 0) failed = true;
  }
  await new Promise<void>((resolve) => server.listen(PORT, DOOR_HOST, resolve));

  console.log('2. one guest turn: a per-turn key from a 0600 file; a fake seat token and secret in the launching shell');
  const keyFile = `${GUEST_TURN_DIR}/probe.key`;
  const streamFile = `${GUEST_TURN_DIR}/probe.jsonl`;
  sh(`umask 077 && printf %s '${TURN_KEY}' > ${keyFile}`);
  const command = buildGuestClaudeCommand({ prompt: 'probe', sessionId: randomUUID(), keyFile, streamFile, timeoutSeconds: 300 });
  const turn = spawn('bash', ['-c', command], {
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_SEAT, PROBE_WORKPLACE_SECRET: FAKE_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  turn.stdout.on('data', (chunk) => { stdout += chunk; });
  turn.stderr.on('data', (chunk) => { stderr += chunk; });
  let pid = '';
  for (let i = 0; i < 80 && !pid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pid = sh(`pgrep -u ${GUEST_USER} -x claude | head -1`).stdout.trim();
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const environ = pid ? sh(`sudo cat /proc/${pid}/environ | tr '\\0' '\\n'`).stdout.trim().split('\n') : [];
  const seen = sh(`sudo -u ${GUEST_USER} bash -c 'ls /proc | grep -c "^[0-9]"'`).stdout.trim();
  const all = sh("ls /proc | grep -c '^[0-9]'").stdout.trim();
  await new Promise((resolve) => turn.on('close', resolve));
  const leftover = sh(`pgrep -u ${GUEST_USER} -l`).stdout.trim();
  const keyLeft = sh(`sudo ls ${keyFile} 2>/dev/null`).stdout.trim();
  server.close();

  console.log('3. what each attempt got back');
  plan.forEach((step, index) => {
    const result = results.find((r) => r.round === index + 1);
    const text = result?.text ?? '(no result)';
    const outcome = text.includes('PROBE_OK') ? 'ok' : text.includes('PROBE_BLOCKED') ? 'blocked' : step.expect === 'cut' && result && /timed out|timeout|terminated|killed/i.test(text) ? 'cut' : step.expect === 'ok' && result ? 'ok' : 'none';
    const pass = outcome === step.expect;
    if (!pass) failed = true;
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${step.label}: ${outcome} — ${text.replace(/PROBE_(OK|BLOCKED)/, '').replace(/\s+/g, ' ').trim().slice(0, 100)}`);
  });
  const names = environ.map((line) => line.split('=')[0]).filter(Boolean).sort();
  const allowed = new Set(['ANTHROPIC_BASE_URL', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'NO_PROXY', 'OLDPWD', 'PATH', 'PWD', 'SHLVL', 'TERM', '_', 'http_proxy', 'https_proxy', 'no_proxy']);
  const extra = names.filter((name) => !allowed.has(name));
  const token = environ.find((line) => line.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))?.split('=').slice(1).join('=');
  const envOk = Boolean(pid) && !extra.length && token === TURN_KEY;
  if (!envOk) failed = true;
  console.log(`   ${envOk ? 'PASS' : 'FAIL'}  the guide's environment: ${names.join(', ') || '(not read)'}${extra.length ? ` — unexpected: ${extra.join(', ')}` : ''}; its Claude credential is ${token === TURN_KEY ? 'the per-turn key' : token ? 'NOT the per-turn key' : 'missing'}`);
  const leaked = stdout.includes(FAKE_SECRET) || stdout.includes(FAKE_SEAT) || environ.some((line) => line.includes(FAKE_SEAT) || line.includes(FAKE_SECRET));
  if (leaked) failed = true;
  console.log(`   ${leaked ? 'FAIL' : 'PASS'}  the launching shell's seat token and secret never reached the turn`);
  const doorOk = doorSaw.turnKey > 0 && doorSaw.seatToken === 0 && doorSaw.other === 0 && doorSaw.viaProxy > 0;
  if (!doorOk) failed = true;
  console.log(`   ${doorOk ? 'PASS' : 'FAIL'}  the door saw ${doorSaw.requests} requests: ${doorSaw.turnKey} with the per-turn key, ${doorSaw.seatToken} with the seat token, ${doorSaw.other} other; ${doorSaw.viaProxy} came through the egress proxy`);
  const reaped = !leftover;
  if (!reaped) failed = true;
  console.log(`   ${reaped ? 'PASS' : 'FAIL'}  nothing of the guide's is running after the turn${leftover ? ` — still: ${leftover.replace(/\n/g, ', ')}` : ''}`);
  if (keyLeft) failed = true;
  console.log(`   ${keyLeft ? 'FAIL' : 'PASS'}  the per-turn key file was removed`);
  console.log(`   info  processes the guide can see: ${seen} (the agent sees ${all})`);
  if (failed && stderr.trim()) console.log(`   stderr: ${stderr.trim().slice(-600)}`);

  sh(`rm -f ${GUEST_CHECKOUT}/probe-1038.js`);
  if (!keep) {
    sh(`sudo nft delete table inet acc_guest 2>/dev/null; sudo pkill -u ${GUEST_EGRESS_USER} -f ${GUEST_EGRESS_PATH} 2>/dev/null; true`);
    console.log('   (lock and proxy removed; --keep leaves them)');
  }
  process.exit(failed ? 1 : 0);
}

void main();
