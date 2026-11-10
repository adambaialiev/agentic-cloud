/**
 * Guests' own agents (note #1038): the machine's runner and lock, the model
 * door, and the service between the public routes and the agent layer —
 * the build from nothing and its steps (note #1055: no spares, no line, no
 * ceiling at once), the limits, turns, Stop, deletion, the sweeper and the
 * transcripts — against a scripted machine, pool and seat.
 *
 * The lock itself is proven on a real machine with the real Claude Code
 * binary by scripts/probe-guest-agent.mts (a shell, the network, the token).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { OrgSeatDocument } from '../../types/org.js';
import type { AgentRecord } from '../../types/user.js';
import type { ExecSyncResult } from '../../services/sandbox-types.js';
import {
  GUEST_CHECKOUT,
  GUEST_USER,
  GUEST_TURN_KEY_ENV,
  buildGuestClaudeCommand,
  buildGuestFirewall,
  buildGuestRunnerScript,
  buildGuestSetupScript,
  guestEgressAllowList,
  guestInstructionsFor,
  readGuestStream,
} from '../../services/guest-agent-machine.js';
import { GuestModelDoor, GUEST_DOOR_MAX_REQUESTS_PER_TURN } from '../../services/guest-model-door.js';
import { GUEST_NO_ANSWER_TEXT, GuestAgentService, hashGuestKey } from '../../services/guest-agent-service.js';
import { GUEST_JOBS_ALLOWED, buildGuestReapScript, guestJobLabel } from '../../services/guest-agent-jobs.js';
import { InMemoryGuestAgentStorage, SqliteGuestAgentStorage } from '../../services/guest-agent-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { GUEST_AGENT_LIMITS, GUEST_BUILD_ESTIMATE_SECONDS, GUEST_DECLINED_TEXT, type GuestStatus } from '../../shared/guest-agent.js';

const SEAT_TOKEN = 'sk-ant-oat01-SEAT-TOKEN-guest-agent';
const SOURCE = { cloneUrl: 'https://git.example.com/acme/agentic-cloud.git', branch: 'main', doorUrl: 'https://api.example.com/api/guest-model', agentName: 'Juno' };

// ── The machine ─────────────────────────────────────────────────────────────

/** The installed runner, with the identity check off and `claude` replaced by a printer. */
function runRunner(args: string[], env: Record<string, string> = {}) {
  const script = buildGuestRunnerScript(SOURCE.doorUrl)
    .replace(/^if \[ "\$\(id -un\)".*$/m, '')
    .replace(/^cd '.*' \|\| \{.*$/m, '')
    .replace(/^exec claude /m, 'env; echo ---; printf "%s\\n" ');
  const dir = mkdtempSync(join(tmpdir(), 'guest-runner-'));
  const path = join(dir, 'turn');
  writeFileSync(path, script);
  return spawnSync('bash', [path, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
}

describe('the guest runner (behaviour, run in bash)', () => {
  it('refuses any flag outside its allow-list', () => {
    for (const flag of ['--dangerously-skip-permissions', '--tools', '--mcp-config', '--settings', '--add-dir', '--system-prompt']) {
      const run = runRunner([flag, 'x']);
      expect(run.status, flag).toBe(64);
    }
  });

  it('keeps one variable of its environment — the per-turn key, as the CLI\'s credential — and points it at the door through the proxy', () => {
    const run = runRunner(['-p', 'hi'], { [GUEST_TURN_KEY_ENV]: 'acc-guest-KEY', CLAUDE_CODE_OAUTH_TOKEN: SEAT_TOKEN, WORKPLACE_SECRET: 'leak' });
    const [envBlock] = run.stdout.split('---\n');
    expect(envBlock).toContain('CLAUDE_CODE_OAUTH_TOKEN=acc-guest-KEY');
    expect(envBlock).toContain(`ANTHROPIC_BASE_URL=${SOURCE.doorUrl}`);
    expect(envBlock).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(envBlock).not.toContain(SEAT_TOKEN);
    expect(envBlock).not.toContain('WORKPLACE_SECRET');
    expect(envBlock).not.toContain(GUEST_TURN_KEY_ENV);
  });

  it('sets no command cap of its own: Claude Code\'s defaults (2 min, 10 at most) apply (note #1054)', () => {
    const run = runRunner(['-p', 'hi']);
    const [envBlock] = run.stdout.split('---\n');
    expect(envBlock).not.toContain('BASH_DEFAULT_TIMEOUT_MS');
    expect(envBlock).not.toContain('BASH_MAX_TIMEOUT_MS');
  });

  it('adds every tool but the web ones, no settings, no MCP, and the guest\'s instructions', () => {
    const run = runRunner(['-p', 'hi']);
    const args = run.stdout.split('---\n')[1]!;
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('WebFetch,WebSearch');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--append-system-prompt-file');
  });
});

describe('the guest\'s instructions', () => {
  it('name the install that works under the network lock (note #1050)', async () => {
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('npm ci --ignore-scripts');
    expect(GUEST_AGENT_INSTRUCTIONS).not.toMatch(/"npm ci --no-audit/);
  });
});

describe('the guest\'s instructions: product terms (note #1133)', () => {
  it('grounds answers in the code but never quotes its internals back to a visitor', async () => {
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Answer questions about the product in product terms.');
    expect(GUEST_AGENT_INSTRUCTIONS).toMatch(/no file paths, folder names, function or variable names, flags or setting names, endpoints, and no names of internal docs/);
    expect(GUEST_AGENT_INSTRUCTIONS).toMatch(/Never remark that a doc is old, stale or disagrees with the code/);
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Nothing in the Agentic Cloud is built on MCP.');
    // Asked-for code work still names its files.
    expect(GUEST_AGENT_INSTRUCTIONS).toMatch(/name the files you read or changed/);
  });
});

describe('the guest helps the visitor find out whether it fits (note #1136)', () => {
  it('opens on the visitor\'s own situation: their coding agents, where they run, and what gets in the way', async () => {
    const { guestGreeting } = await import('../../shared/guest-agent.js');
    const greeting = guestGreeting('Juno');
    expect(greeting).toMatch(/^Hi, I'm Juno, a Claude Code agent/);
    expect(greeting).toContain('whether it fits your team');
    expect(greeting).toContain('Which coding agents does your team use today, and where do they run?');
    expect(greeting).toContain('And what gets in the way?');
    // At most two questions: the visitor is not interviewed.
    expect(greeting.match(/\?/g)).toHaveLength(2);
  });

  it('answers with that situation in mind and says plainly when it fits and when it does not, without selling', async () => {
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Answer every question with their situation in mind');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Say plainly whether the Agentic Cloud fits what they described');
    expect(GUEST_AGENT_INSTRUCTIONS).toMatch(/When it does not fit, or fits only in part, say so just as plainly/);
    expect(GUEST_AGENT_INSTRUCTIONS).toMatch(/No selling: no pressure, no urgency/);
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('A need the Agentic Cloud does not cover is not off-topic');
    // The product-terms rule of note #1133 stays.
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Answer questions about the product in product terms.');
  });

  it('gives Adam\'s address, and only his, and promises nothing on his behalf', async () => {
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Adam, the founder of the Agentic Cloud, reads every guest conversation.');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('It is the only address you ever give');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('Never promise what Adam will do, build or charge');
    const addresses = GUEST_AGENT_INSTRUCTIONS.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    expect(addresses).toEqual(['adam@agenticcloudcomputer.com']);
    // The outgoing check lets it through, so the visitor actually sees it.
    const { guideAnswerLeak } = await import('../../services/public-guide-machine.js');
    expect(guideAnswerLeak('Write to Adam at adam@agenticcloudcomputer.com with what you need.')).toBeNull();
  });

  it('carries the same exact claims as the guide, from one copy', async () => {
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    const { PUBLIC_GUIDE_INSTRUCTIONS } = await import('../../config/public-guide-instructions.js');
    const { PUBLIC_AGENT_EXACT_CLAIMS } = await import('../../config/public-agent-claims.js');
    expect(GUEST_AGENT_INSTRUCTIONS).toContain(PUBLIC_AGENT_EXACT_CLAIMS);
    expect(PUBLIC_GUIDE_INSTRUCTIONS).toContain(PUBLIC_AGENT_EXACT_CLAIMS);
    expect(PUBLIC_AGENT_EXACT_CLAIMS).toContain('free for now: no licence, no key and no charge from us');
    expect(PUBLIC_AGENT_EXACT_CLAIMS).toContain('Never offer a hosted sign-up');
  });
});

describe('the guest machine\'s setup', () => {
  const script = buildGuestSetupScript(SOURCE);
  it('fails closed: no nftables, no turn; the lock must load', () => {
    expect(script).toContain('command -v nft');
    expect(script).toContain('exit 71');
    expect(script).toContain('nft list table inet acc_guest');
  });

  it('closes the guide\'s network to loopback, and loopback ssh and 8080 too', () => {
    const rules = buildGuestFirewall();
    expect(rules).toMatch(/meta skuid "guide" oif "lo" tcp dport \{ 22, 8080 \} reject/);
    expect(rules).toMatch(/meta skuid "guide" reject/);
  });

  it('lets the proxy reach the repository, the door and the package registries only', () => {
    expect(guestEgressAllowList(SOURCE)).toEqual([
      'api.example.com:443', 'files.pythonhosted.org:443', 'git.example.com:443', 'pypi.org:443', 'registry.npmjs.org:443', 'registry.yarnpkg.com:443',
    ]);
  });

  it('clones the public copy once, anonymously, onto the volume, and gives it to the guide', () => {
    expect(script).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(script).toContain(`git clone --quiet --depth 1 --single-branch --branch 'main' 'https://git.example.com/acme/agentic-cloud.git' ${GUEST_CHECKOUT}.new`);
    expect(script).toContain('remote remove origin');
    expect(script).not.toContain('git fetch');
    expect(GUEST_CHECKOUT.startsWith('/data/')).toBe(true);
  });

  it('reinstalls the runner whenever it is missing, whatever the marker says, and refuses to finish without it (note #1045)', () => {
    expect(script).toContain('cat /usr/local/lib/acc-guest/.setup-version');
    expect(script).not.toContain('/data/guest/.setup-version');
    expect(script).toContain('[ ! -x /usr/local/lib/acc-guest/turn ]');
    expect(script).toContain('exit 74');
  });

  it('keeps the agent\'s home closed and other processes hidden', () => {
    expect(script).toContain('chmod 0750 /home/agent');
    expect(script).toContain('hidepid');
    expect(script).toContain('rm -f /etc/sudoers.d/$__u');
  });
});

describe('a guest turn\'s command', () => {
  it('reads the per-turn key from a file and removes it; no key in any argument; reaps the guide afterwards', () => {
    const command = buildGuestClaudeCommand({ prompt: 'hi', sessionId: 's', keyFile: '/home/agent/.guest-turns/t.key', streamFile: '/home/agent/.guest-turns/t.jsonl', timeoutSeconds: 180 });
    expect(command).toContain(`${GUEST_TURN_KEY_ENV}="$(cat '/home/agent/.guest-turns/t.key')"`);
    expect(command).toContain("rm -f '/home/agent/.guest-turns/t.key'");
    expect(command).toContain('--model sonnet --effort high');
    expect(command).toContain('ps -u guide -o pid=,sid=');
    expect(command).toContain('kill -$1');
    expect(command).toContain('__reap KILL');
    expect(command).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  });
});

describe('reading a guest turn\'s stream', () => {
  it('lists what it read, changed, searched and ran; streams partial text; reads the answer and cost', () => {
    const reading = readGuestStream([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me ' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'look.' } } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: `${GUEST_CHECKOUT}/README.md` } },
        { type: 'tool_use', name: 'Edit', input: { file_path: `${GUEST_CHECKOUT}/src/App.tsx` } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'idle' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- src/App.test.tsx' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.2, usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n'));
    expect(reading.activity).toEqual([
      { kind: 'read', label: 'README.md' }, { kind: 'edit', label: 'src/App.tsx' }, { kind: 'search', label: 'idle' }, { kind: 'run', label: 'npm test -- src/App.test.tsx' },
    ]);
    expect(reading.files).toEqual(['README.md', 'src/App.tsx']);
    expect(reading.partial).toBe('Let me look.');
    expect(reading).toMatchObject({ answer: 'Done.', costUsd: 0.2, sessionId: 's1' });
  });
});

// ── The model door ──────────────────────────────────────────────────────────

async function doorWorld() {
  const upstream: Array<{ url: string; auth: string | null; body: string }> = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    upstream.push({ url: String(url), auth: headers.get('authorization'), body: Buffer.from(init?.body as Uint8Array).toString() });
    return new Response('event: message_stop\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'set-cookie': 'x=1' } });
  });
  const door = new GuestModelDoor({ fetch: fakeFetch as never, upstream: 'https://upstream.test' });
  const app = express();
  app.use('/api/guest-model', express.raw({ type: () => true }), (req, res) => { void door.handle(req, res); });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const call = (path: string, key: string, model = 'claude-sonnet-4-5-20250929') => fetch(`http://127.0.0.1:${port}/api/guest-model${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }, body: JSON.stringify({ model, messages: [] }),
  });
  return { door, upstream, call, close: () => server.close() };
}

describe('the model door', () => {
  it('swaps an open per-turn key for the seat token and passes the stream back', async () => {
    const x = await doorWorld();
    const key = x.door.open('agent-1', SEAT_TOKEN, 60_000);
    const res = await x.call('/v1/messages?beta=true', key);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('message_stop');
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(x.upstream[0]).toMatchObject({ url: 'https://upstream.test/v1/messages?beta=true', auth: `Bearer ${SEAT_TOKEN}` });
    x.close();
  });

  it('refuses a key it did not open, a closed key and an expired one', async () => {
    const x = await doorWorld();
    expect((await x.call('/v1/messages', 'acc-guest-made-up')).status).toBe(401);
    const key = x.door.open('agent-1', SEAT_TOKEN, 60_000);
    x.door.close(key);
    expect((await x.call('/v1/messages', key)).status).toBe(401);
    const short = x.door.open('agent-1', SEAT_TOKEN, -1);
    expect((await x.call('/v1/messages', short)).status).toBe(401);
    expect(x.upstream).toHaveLength(0);
    x.close();
  });

  it('thinks with Sonnet and Haiku only, on the messages routes only, up to a budget', async () => {
    const x = await doorWorld();
    const key = x.door.open('agent-1', SEAT_TOKEN, 60_000);
    expect((await x.call('/v1/messages', key, 'claude-opus-4-1')).status).toBe(403);
    expect((await x.call('/v1/messages', key, 'claude-haiku-4-5-20251001')).status).toBe(200);
    expect((await x.call('/v1/models', key)).status).toBe(404);
    expect((await x.call('/v1/messages/count_tokens', key)).status).toBe(200);
    for (let i = 0; i < GUEST_DOOR_MAX_REQUESTS_PER_TURN; i += 1) x.door['turns'].get(key)!.requests += 1;
    expect((await x.call('/v1/messages', key)).status).toBe(429);
    x.close();
  });

  it('closes every key of an agent at once (Stop, deletion)', async () => {
    const x = await doorWorld();
    const key = x.door.open('agent-1', SEAT_TOKEN, 60_000);
    x.door.open('agent-2', SEAT_TOKEN, 60_000);
    x.door.closeAgent('agent-1');
    expect((await x.call('/v1/messages', key)).status).toBe(401);
    expect(x.door.openKeys()).toBe(1);
    x.close();
  });
});

// ── The service ─────────────────────────────────────────────────────────────

function stream(answer: string, session = 'session-from-claude'): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: session }),
    JSON.stringify({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, total_cost_usd: 0.12, usage: { input_tokens: 5, output_tokens: 150 } }),
  ].join('\n');
}
function ok(stdout = ''): ExecSyncResult { return { stdout, stderr: '', exitCode: 0, timedOut: false }; }

function world(options: {
  answer?: (command: string) => ExecSyncResult | Promise<ExecSyncResult>;
  seat?: Partial<OrgSeatDocument> | null;
  limits?: Partial<typeof GUEST_AGENT_LIMITS>;
  enabled?: boolean;
  turnstile?: boolean;
  turnstileSays?: boolean;
  createFails?: boolean;
  /** Each build command (setup, wake) takes this long on the fake clock. */
  stepMs?: number;
  /** Holds a build command until the test lets it go. */
  hold?: (command: string) => Promise<void> | undefined;
  /** A build command that fails. */
  fails?: (command: string) => boolean;
} = {}) {
  let clock = Date.parse('2026-11-06T18:00:00Z');
  const storage = new InMemoryGuestAgentStorage();
  const commands: string[] = [];
  const uploads: Array<{ path: string; content: string; mode?: number }> = [];
  const agents = new Map<string, AgentRecord>();
  const deleted: string[] = [];
  let made = 0;
  const names = ['Juno', 'Milo', 'Iris', 'Otis', 'Ruby', 'Leo'];
  const client = {
    execSync: vi.fn(async (_sandbox: string, command: string) => {
      commands.push(command);
      if (command.includes('GUEST_SETUP_EOF') || command.includes('claude --version')) {
        await options.hold?.(command);
        clock += options.stepMs ?? 0;
        return options.fails?.(command) ? { stdout: '', stderr: 'no', exitCode: 1, timedOut: false } : ok(command.includes('claude --version') ? '2.1.316 (Claude Code)' : '');
      }
      if (command.startsWith('cat ')) return ok('');
      if (command.includes('--output-format stream-json')) return options.answer ? options.answer(command) : ok(stream('Every agent gets its own computer.'));
      return ok();
    }),
    uploadToSandbox: vi.fn(async (_sandbox: string, files: Array<{ path: string; content: Buffer; mode?: number }>) => {
      for (const file of files) uploads.push({ path: file.path, content: file.content.toString(), ...(file.mode !== undefined ? { mode: file.mode } : {}) });
    }),
  };
  const seat: OrgSeatDocument = {
    seatId: 's1', provider: 'claude', status: 'active', selected: true,
    usage: { capturedAt: 'x', windows: { five_hour: { id: 'five_hour', usedPercent: 20 }, seven_day: { id: 'seven_day', usedPercent: 30 } } },
    ...(options.seat ?? {}),
  } as OrgSeatDocument;
  const pool = {
    leaseForUser: vi.fn(async () => ({ kind: 'dedicated' as const, lease: { credentialId: 'seat_s1', token: SEAT_TOKEN } })),
    releaseCredential: vi.fn(async () => undefined),
  };
  const door = new GuestModelDoor();
  const fetchTurnstile = vi.fn(async () => new Response(JSON.stringify({ success: options.turnstileSays ?? true })));
  const service = new GuestAgentService({
    storage,
    host: {
      createRecord: async () => {
        if (options.createFails) return { error: 'no machine for you' };
        const name = names[made % names.length]!;
        made += 1;
        const id = `guest-${made}`;
        agents.set(id, { id, name, cli: 'claude', sealed: 'guest', orgId: 'org-1', serverId: `fly_ia-${id}.m1`, createdAt: 'x' } as AgentRecord);
        return { id, name };
      },
      agent: async (_user, id) => agents.get(id) ?? null,
      sandbox: async (_user, id) => (agents.has(id) ? `fly_ia-${id}.m1` : null),
      source: async () => ({ cloneUrl: SOURCE.cloneUrl, branch: 'main' }),
      deleteAgent: async (_user, id) => { deleted.push(id); agents.delete(id); return true; },
      guestAgentIds: async () => [...agents.keys()],
    },
    door,
    doorUrl: SOURCE.doorUrl,
    pool: pool as never,
    seats: {
      getSeat: async () => (options.seat === null ? null : seat),
      listSeatsByMember: async () => (options.seat === null ? [] : [seat]),
    },
    sandboxClient: () => client as never,
    turnstile: options.turnstile ? { secretKey: 'secret', siteKey: 'site' } : null,
    fetch: fetchTurnstile as never,
    now: () => clock,
    sweepEveryMs: null,
    jobsEveryMs: null,
    buildRetryMs: 0,
    limits: options.limits ?? {},
  });
  if (options.enabled !== false) void service.setEnabled('owner-1', 'org-1', true);
  return {
    service, storage, commands, uploads, pool, client, door, agents, deleted, fetchTurnstile,
    advance: (ms: number) => { clock += ms; },
    turns: () => commands.filter((c) => c.includes('--output-format stream-json')),
  };
}

async function makeAgent(x: ReturnType<typeof world>, address = '203.0.113.9') {
  const made = await x.service.create({ address });
  await x.service.idle();
  const key = (made.answer as { key?: string }).key!;
  return { made, key };
}

describe('GuestAgentService — making one', () => {
  it('makes an agent for a visitor from nothing: a key, five real steps in order with their times, then ready with the fixed greeting (note #1055)', async () => {
    const x = world({ stepMs: 4_000 });
    const made = await x.service.create({ address: 'a' });
    expect(made.httpStatus).toBe(201);
    const key = (made.answer as { key: string }).key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = (made.answer as { status: GuestStatus }).status;
    expect(first).toMatchObject({ state: 'creating', step: 'machine', estimateSeconds: GUEST_BUILD_ESTIMATE_SECONDS, createdAt: '2026-11-06T18:00:00.000Z' });
    expect(first).not.toHaveProperty('linePosition');
    expect(first.steps).toEqual([
      { id: 'machine', done: false, startedAt: '2026-11-06T18:00:00.000Z', doneAt: null },
      { id: 'agent', done: false, startedAt: null, doneAt: null },
      { id: 'code', done: false, startedAt: null, doneAt: null },
      { id: 'waking', done: false, startedAt: null, doneAt: null },
      { id: 'ready', done: false, startedAt: null, doneAt: null },
    ]);
    await x.service.idle();
    const status = await x.service.status(key);
    expect(status).toMatchObject({ state: 'ready', agent: { name: 'Juno' }, machine: { cores: 2, memoryGb: 4, dedicated: true }, messagesLeft: 40, steps: null, step: null });
    expect(status.messages).toEqual([expect.objectContaining({ role: 'agent', text: expect.stringContaining("Hi, I'm Juno, a Claude Code agent") })]);
    // Each step a real command, in order: the seal (no copy), the copy, Claude Code started once.
    const build = x.commands.filter((c) => c.includes('GUEST_SETUP_EOF') || c.includes('claude --version'));
    expect(build).toHaveLength(3);
    expect(build[0]).toContain('GUEST_SETUP_EOF');
    expect(build[0]).not.toContain('git clone');
    expect(build[1]).toContain('git clone');
    expect(build[2]).toContain(`sudo -n -u ${GUEST_USER} env -i`);
    const row = (await x.storage.byKeyHash(hashGuestKey(key)))!;
    expect(row.steps).toEqual([
      { id: 'machine', done: true, startedAt: '2026-11-06T18:00:00.000Z', doneAt: '2026-11-06T18:00:00.000Z' },
      { id: 'agent', done: true, startedAt: '2026-11-06T18:00:00.000Z', doneAt: '2026-11-06T18:00:04.000Z' },
      { id: 'code', done: true, startedAt: '2026-11-06T18:00:04.000Z', doneAt: '2026-11-06T18:00:08.000Z' },
      { id: 'waking', done: true, startedAt: '2026-11-06T18:00:08.000Z', doneAt: '2026-11-06T18:00:12.000Z' },
      { id: 'ready', done: true, startedAt: '2026-11-06T18:00:12.000Z', doneAt: '2026-11-06T18:00:12.000Z' },
    ]);
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
  });

  it('the status names the step running now, and when it began, while the build is under way', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const x = world({ stepMs: 3_000, hold: (command) => (command.includes('git clone') ? gate : undefined) });
    const made = await x.service.create({ address: 'a' });
    const key = (made.answer as { key: string }).key;
    for (let i = 0; i < 50 && (await x.service.status(key)).step !== 'code'; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const during = await x.service.status(key);
    expect(during).toMatchObject({ state: 'creating', step: 'code' });
    expect(during.steps!.map((s) => [s.id, s.done, s.startedAt])).toEqual([
      ['machine', true, '2026-11-06T18:00:00.000Z'],
      ['agent', true, '2026-11-06T18:00:00.000Z'],
      ['code', false, '2026-11-06T18:00:03.000Z'],
      ['waking', false, null],
      ['ready', false, null],
    ]);
    release();
    await x.service.idle();
    expect((await x.service.status(key)).state).toBe('ready');
  });

  it('a build that fails at a step says failed and deletes what it made', async () => {
    const x = world({ fails: (command) => command.includes('claude --version') });
    const { key } = await makeAgent(x, 'a');
    expect((await x.service.status(key)).state).toBe('failed');
    expect(x.deleted).toEqual(['guest-1']);
  });

  // Note #1073: Sadie's build failed at waking on one Fly 404 for a machine
  // that was there a second later. Every step now gets one more try.
  it('a step that fails once is tried again, and the build still reaches ready', async () => {
    let wakes = 0;
    const x = world({ fails: (command) => command.includes('claude --version') && (wakes += 1) === 1 });
    const { key } = await makeAgent(x, 'a');
    expect((await x.service.status(key)).state).toBe('ready');
    expect(x.commands.filter((c) => c.includes('claude --version'))).toHaveLength(2);
    expect(x.deleted).toEqual([]);
  });

  it('a setup step that fails once is tried again too', async () => {
    let setups = 0;
    const x = world({ fails: (command) => command.includes('GUEST_SETUP_EOF') && (setups += 1) === 1 });
    const { key } = await makeAgent(x, 'a');
    expect((await x.service.status(key)).state).toBe('ready');
    expect(x.deleted).toEqual([]);
  });

  it('no slots and no line: a third, fourth and fifth visitor at the same moment each get an agent built, never a place in line (note #1055)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const x = world({ hold: () => gate });
    const answers = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((address) => x.service.create({ address })));
    expect(answers.map((a) => a.httpStatus)).toEqual([201, 201, 201, 201, 201]);
    const statuses = answers.map((a) => (a.answer as { status: GuestStatus }).status);
    expect(statuses.map((st) => st.state)).toEqual(['creating', 'creating', 'creating', 'creating', 'creating']);
    expect(statuses.every((st) => !('linePosition' in st) && (st.state as string) !== 'waiting')).toBe(true);
    // Five records, five machines, all being built side by side.
    expect([...x.agents.keys()]).toEqual(['guest-1', 'guest-2', 'guest-3', 'guest-4', 'guest-5']);
    expect((await x.storage.listByPhase(['creating'])).length).toBe(5);
    release();
    await x.service.idle();
    const keys = answers.map((a) => (a.answer as { key: string }).key);
    expect(await Promise.all(keys.map(async (key) => (await x.service.status(key)).state))).toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);
    expect((await x.service.listForOwner()).live).toHaveLength(5);
  });

  it('no spare is ever prepared or claimed: the sweeper makes none, and each visitor\'s agent is a new record made at the tap (note #1055)', async () => {
    const x = world();
    await x.service.tick();
    await x.service.idle();
    x.advance(60 * 60_000);
    await x.service.tick();
    await x.service.idle();
    expect(x.agents.size).toBe(0);
    expect(await x.storage.listByPhase(['spare', 'preparing'])).toEqual([]);
    const { key } = await makeAgent(x, 'a');
    await x.service.tick();
    await x.service.idle();
    expect([...x.agents.keys()]).toEqual(['guest-1']);
    const row = (await x.storage.byKeyHash(hashGuestKey(key)))!;
    expect(row.fromSpare).toBeUndefined();
    expect(row.preparedAt).toBe(row.claimedAt);
    expect(await x.storage.listByPhase(['spare', 'preparing'])).toEqual([]);
  });

  it('a spare left from before (Zoe, Nina) is deleted with its machine on the first sweep, and never handed to a visitor', async () => {
    const x = world();
    x.agents.set('old-spare', { id: 'old-spare', name: 'Nina', cli: 'claude', sealed: 'guest', serverId: 'fly_ia-old.m1' } as AgentRecord);
    await x.storage.put({
      agentId: 'old-spare', userId: 'owner-1', orgId: 'org-1', phase: 'spare', keyHash: null, preparedAt: '2026-11-06T17:00:00.000Z',
      claimedAt: null, lastActiveAt: null, messagesUsed: 0, claudeSessionId: null, steps: null, removedAt: null, removedReason: null,
      transcript: { agentId: 'old-spare', name: 'Nina', avatarUrl: null, createdAt: '2026-11-06T17:00:00.000Z', removedAt: null, removedReason: null, messages: [] },
    });
    const { key } = await makeAgent(x, 'a');
    expect((await x.service.status(key)).agent!.name).toBe('Juno');
    await x.service.tick();
    expect(x.deleted).toEqual(['old-spare']);
    expect((await x.storage.get('old-spare'))!.phase).toBe('removed');
    expect((await x.service.listForOwner()).past).toEqual([]);
  });

  it('a build a restart cut off resumes from the top; a row with the four old steps reads as the five', async () => {
    const x = world();
    x.agents.set('mid', { id: 'mid', name: 'Iris', cli: 'claude', sealed: 'guest', serverId: 'fly_ia-mid.m1' } as AgentRecord);
    await x.storage.put({
      agentId: 'mid', userId: 'owner-1', orgId: 'org-1', phase: 'creating', keyHash: hashGuestKey('k'.repeat(43)), preparedAt: '2026-11-06T17:59:00.000Z',
      claimedAt: '2026-11-06T17:59:00.000Z', lastActiveAt: null, messagesUsed: 0, claudeSessionId: null,
      steps: [{ id: 'computer', done: true }, { id: 'code', done: false }, { id: 'claude', done: false }, { id: 'hello', done: false }],
      removedAt: null, removedReason: null,
      transcript: { agentId: 'mid', name: 'Iris', avatarUrl: null, createdAt: '2026-11-06T17:59:00.000Z', removedAt: null, removedReason: null, messages: [] },
    });
    expect((await x.service.status('k'.repeat(43))).steps!.map((s) => s.id)).toEqual(['machine', 'agent', 'code', 'waking', 'ready']);
    await x.service.tick();
    await x.service.idle();
    expect((await x.service.status('k'.repeat(43))).state).toBe('ready');
  });

  it('one live agent per address, and three a day', async () => {
    const x = world();
    const first = await makeAgent(x, 'a');
    const again = await x.service.create({ address: 'a' });
    expect((again.answer as { status: { state: string } }).status.state).toBe('limited');
    await x.service.deleteByVisitor(first.key);
    const second = await makeAgent(x, 'a');
    await x.service.deleteByVisitor(second.key);
    const third = await makeAgent(x, 'a');
    await x.service.deleteByVisitor(third.key);
    const fourth = await x.service.create({ address: 'a' });
    expect((fourth.answer as { status: { state: string; until: string } }).status).toMatchObject({ state: 'limited', until: '2026-11-07T00:00:00.000Z' });
  });

  it('a key that already has an agent gets it back instead of a second one', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    const again = await x.service.create({ key, address: 'b' });
    expect(again.httpStatus).toBe(200);
    expect((again.answer as { status: { state: string } }).status.state).toBe('ready');
  });

  it('rests when guests are off, when the seat is benched, and after 40 a day', async () => {
    expect((await world({ enabled: false }).service.status(undefined)).state).toBe('resting');
    const benched = world({ seat: { status: 'cooldown', cooldownUntil: '2026-11-06T20:00:00.000Z' } as never });
    expect(await benched.service.status(undefined)).toMatchObject({ state: 'resting', until: '2026-11-06T20:00:00.000Z' });
    const busy = world({ limits: { globalPerDay: 1 } });
    await makeAgent(busy, 'a');
    const second = await busy.service.create({ address: 'b' });
    expect((second.answer as { status: { state: string } }).status.state).toBe('resting');
  });

  it('never rests on the seat\'s share: 99% of the 5-hour window and the week still makes and answers (note #1048)', async () => {
    const resetsAt = Date.parse('2026-11-09T08:00:00Z') / 1000;
    const x = world({ seat: { usage: { capturedAt: 'x', windows: {
      five_hour: { id: 'five_hour', usedPercent: 99, resetsAt },
      seven_day: { id: 'seven_day', usedPercent: 99, resetsAt },
    } } } as never });
    expect(await x.service.status(undefined)).toMatchObject({ state: 'none', until: null });
    const { key } = await makeAgent(x, 'a');
    expect((await x.service.status(key)).state).toBe('ready');
    const sent = await x.service.message(key, 'What is this?');
    expect(sent).toMatchObject({ httpStatus: 202, answer: { state: 'accepted' } });
    await x.service.idle();
    const turnId = (sent.answer as { turnId: string }).turnId;
    expect(await x.service.turnStatus(key, turnId)).toMatchObject({ state: 'answered' });
  });

  it('checks Turnstile when it is configured', async () => {
    const x = world({ turnstile: true, turnstileSays: false });
    expect((await x.service.create({ address: 'a', turnstileToken: 'tok' })).httpStatus).toBe(400);
    expect((await x.service.create({ address: 'a' })).httpStatus).toBe(400);
    const y = world({ turnstile: true, turnstileSays: true });
    expect((await y.service.create({ address: 'a', turnstileToken: 'tok' })).httpStatus).toBe(201);
    expect((await y.service.status(undefined)).turnstileSiteKey).toBe('site');
  });

  it('a failed reservation says failed', async () => {
    const x = world({ createFails: true });
    const made = await x.service.create({ address: 'a' });
    expect((made.answer as { status: { state: string } }).status.state).toBe('failed');
  });
});

describe('GuestAgentService — talking', () => {
  it('a message runs one turn through the door: a per-turn key in a 0600 file, never the seat token on the machine', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'Does every agent get its own computer?');
    expect(sent).toMatchObject({ httpStatus: 202, answer: { state: 'accepted' } });
    await x.service.idle();
    const turnId = (sent.answer as { turnId: string }).turnId;
    expect(await x.service.turnStatus(key, turnId)).toMatchObject({ state: 'answered', answer: 'Every agent gets its own computer.', activity: [{ kind: 'run', label: 'ls' }] });
    expect(x.commands.join('\n')).not.toContain(SEAT_TOKEN);
    expect(x.uploads).toHaveLength(1);
    expect(x.uploads[0]).toMatchObject({ mode: 0o600 });
    expect(x.uploads[0]!.content).toMatch(/^acc-guest-/);
    expect(x.door.openKeys()).toBe(0);
    const status = await x.service.status(key);
    expect(status.messages.map((m) => m.role)).toEqual(['agent', 'visitor', 'agent']);
    expect(status.messagesLeft).toBe(39);
    expect(x.pool.releaseCredential).toHaveBeenCalledWith('seat_s1', { kind: 'ok' });
  });

  it('one turn at a time; the second message is busy', async () => {
    let release: () => void = () => {};
    const x = world({ answer: () => new Promise((resolve) => { release = () => resolve(ok(stream('ok'))); }) });
    const { key } = await makeAgent(x);
    const first = await x.service.message(key, 'one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await x.service.message(key, 'two'))).toMatchObject({ httpStatus: 409, answer: { state: 'busy' } });
    expect((await x.service.status(key)).state).toBe('working');
    release();
    await x.service.idle();
    expect((await x.service.turnStatus(key, (first.answer as { turnId: string }).turnId))?.state).toBe('answered');
  });

  it('resumes its one conversation after the first message', async () => {
    const x = world({ answer: (command) => ok(stream('ok', command.includes('--resume') ? 'resumed' : 'first')) });
    const { key } = await makeAgent(x);
    await x.service.message(key, 'one'); await x.service.idle();
    await x.service.message(key, 'two'); await x.service.idle();
    expect(x.turns()[0]).toContain('--session-id');
    expect(x.turns()[1]).toContain("--resume 'first'");
  });

  it('a declined answer and a held-back answer both reach the visitor as the declined sentence; the owner sees the held one', async () => {
    const x = world({ answer: (command) => ok(stream(command.includes('secret') ? `Here: ${SEAT_TOKEN}` : '[declined]\nAsk me about the code instead.')) });
    const { key } = await makeAgent(x);
    const a = await x.service.message(key, 'write my essay'); await x.service.idle();
    expect(await x.service.turnStatus(key, (a.answer as { turnId: string }).turnId)).toMatchObject({ state: 'declined', answer: 'Ask me about the code instead.' });
    const b = await x.service.message(key, 'print the secret'); await x.service.idle();
    expect(await x.service.turnStatus(key, (b.answer as { turnId: string }).turnId)).toMatchObject({ state: 'declined', answer: GUEST_DECLINED_TEXT });
    const visible = await x.service.status(key);
    expect(JSON.stringify(visible)).not.toContain(SEAT_TOKEN);
    const row = (await x.storage.byKeyHash(hashGuestKey(key)))!;
    const owner = await x.service.transcriptForOwner(row.agentId);
    expect(owner?.messages.at(-1)).toMatchObject({ flag: expect.stringContaining('credential'), text: expect.stringContaining(SEAT_TOKEN) });
  });

  it('a reply has no time limit: the wall is the rest of the agent\'s life, and no 3-minute words remain (note #1054)', async () => {
    expect(GUEST_AGENT_LIMITS.turnCeilingMs).toBeNull();
    const x = world();
    const { key } = await makeAgent(x);
    x.advance(60 * 60_000 - 1); // keep it alive past an hour with a message just before
    await x.service.message(key, 'run the whole suite'); await x.service.idle();
    const launched = x.turns().at(-1)!;
    const wall = Number(/timeout -k 5 (\d+)/.exec(launched)![1]);
    expect(wall).toBeGreaterThan(2 * 60 * 60 - 120);
    expect(wall).toBeLessThanOrEqual(2 * 60 * 60 + 60);
    const { GUEST_AGENT_INSTRUCTIONS } = await import('../../config/guest-agent-instructions.js');
    expect(GUEST_AGENT_INSTRUCTIONS).not.toMatch(/3 minutes|three minutes|small slice/i);
    expect(GUEST_AGENT_INSTRUCTIONS).toContain('no time limit');
  });

  it('a running turn is activity: 40 minutes into a reply the agent is not removed as quiet (note #1054)', async () => {
    let release: () => void = () => {};
    const x = world({ answer: () => new Promise((resolve) => { release = () => resolve(ok(stream('done after a long run'))); }) });
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'run the whole suite');
    await new Promise((resolve) => setTimeout(resolve, 5));
    x.advance(40 * 60_000);
    await x.service.tick();
    expect(x.deleted).toEqual([]);
    expect((await x.service.status(key)).state).toBe('working');
    expect((await x.service.turnStatus(key, (sent.answer as { turnId: string }).turnId))?.elapsedSeconds).toBeGreaterThanOrEqual(2400);
    release();
    await x.service.idle();
    expect((await x.service.turnStatus(key, (sent.answer as { turnId: string }).turnId))?.state).toBe('answered');
    x.advance(29 * 60_000);
    await x.service.tick();
    expect(x.deleted).toEqual([]); // the quiet clock starts at the end of the turn
  });

  it('when the agent\'s life ends mid-reply the visitor reads why, and it is not counted; a set ceiling says its minutes (notes #1047, #1054)', async () => {
    const timedOut = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd backend && npx vitest run --coverage' } }] } }),
    ].join('\n');
    const x = world({ answer: () => ({ stdout: timedOut, stderr: '', exitCode: 124, timedOut: true }) });
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'can you measure it?'); await x.service.idle();
    const turn = await x.service.turnStatus(key, (sent.answer as { turnId: string }).turnId);
    expect(turn?.state).toBe('answered');
    expect(turn?.answer).toContain('end of my time (3 hours');
    expect(turn?.answer).toContain('`cd backend && npx vitest run --coverage`');
    expect(turn?.answer).not.toMatch(/went wrong/i);
    expect((await x.service.status(key)).messagesLeft).toBe(40);
    const y = world({ limits: { turnCeilingMs: 20 * 60_000 }, answer: () => ({ stdout: timedOut, stderr: '', exitCode: 124, timedOut: true }) });
    const other = await makeAgent(y);
    const again = await y.service.message(other.key, 'go'); await y.service.idle();
    expect(y.turns()[0]).toContain('timeout -k 5 1200 ');
    expect((await y.service.turnStatus(other.key, (again.answer as { turnId: string }).turnId))?.answer).toContain('longer than the 20 minutes one reply may take');
  });

  it('a build installs no packages; the instructions tell the agent to, with --ignore-scripts (note #1055)', async () => {
    const x = world();
    await makeAgent(x);
    expect(x.commands.some((c) => c.includes('npm ci'))).toBe(false);
    expect(guestInstructionsFor('Juno')).toContain('packages are not installed when you start');
  });

  it('a failure on our side gives the message back', async () => {
    const x = world({ answer: () => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }) });
    const { key } = await makeAgent(x);
    await x.service.message(key, 'one'); await x.service.idle();
    expect((await x.service.status(key)).messagesLeft).toBe(40);
  });

  it('Stop ends the turn: the door key closes and the guide\'s processes are signalled', async () => {
    let release: () => void = () => {};
    const x = world({ answer: () => new Promise((resolve) => { release = () => resolve(ok(stream('late'))); }) });
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'build everything');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const turnId = (sent.answer as { turnId: string }).turnId;
    expect(x.door.openKeys()).toBe(1);
    expect(await x.service.stopTurn(key, turnId)).toBe('stopped');
    expect(x.door.openKeys()).toBe(0);
    expect(x.commands.some((c) => c.includes('__reap TERM'))).toBe(true);
    release();
    await x.service.idle();
    expect((await x.service.turnStatus(key, turnId))?.state).toBe('stopped');
    expect((await x.service.status(key)).messagesLeft).toBe(40); // a Stop is not counted (note #1054)
  });

  it('another key cannot read or stop someone else\'s turn', async () => {
    const x = world();
    const mine = await makeAgent(x, 'a');
    const theirs = await makeAgent(x, 'b');
    const sent = await x.service.message(mine.key, 'hi');
    await x.service.idle();
    const turnId = (sent.answer as { turnId: string }).turnId;
    expect(await x.service.turnStatus(theirs.key, turnId)).toBeNull();
    expect(await x.service.stopTurn(theirs.key, turnId)).toBeNull();
  });

  it('rejects an empty or too-long message and an unknown key', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    expect((await x.service.message(key, '   ')).httpStatus).toBe(400);
    expect((await x.service.message(key, 'x'.repeat(1001))).httpStatus).toBe(400);
    expect((await x.service.message('A'.repeat(43), 'hi')).httpStatus).toBe(401);
  });
});

describe('GuestAgentService — background jobs (note #1063)', () => {
  /** A world whose first visitor turn holds until released, so a job can be started "inside the reply". */
  function jobWorld(readings: () => Array<{ id: string; result: { state: string; exitCode: number | null; finishedAt: string } | null; alive: boolean; stopped: boolean; tail: string }>) {
    let release!: () => void;
    let held = 0;
    const prompts: string[] = [];
    const x = world({
      answer: async (command) => {
        prompts.push(command);
        if (held++ === 0) await new Promise<void>((resolve) => { release = resolve; });
        return ok(stream(command.includes('A background job') ? 'Coverage is 71% of lines.' : 'I started this as a background job; I will tell you when it finishes.'));
      },
    });
    x.client.execSync.mockImplementation(async (_sandbox: string, command: string) => {
      x.commands.push(command);
      if (command.includes('sudo -n node -e')) return ok(JSON.stringify(readings()));
      if (command.includes('--output-format stream-json')) {
        prompts.push(command);
        if (held++ === 0) await new Promise<void>((resolve) => { release = resolve; });
        return ok(stream(command.includes('A background job') ? 'Coverage is 71% of lines.' : 'I started this as a background job; I will tell you when it finishes.'));
      }
      return ok();
    });
    return { x, prompts, release: () => release() };
  }
  function call(service: GuestAgentService, key: string, body: unknown) {
    const res = { code: 0, body: null as unknown, status(code: number) { this.code = code; return this; }, json(b: unknown) { this.body = b; return this; } };
    return service.handleJobsDoor({ method: 'POST', path: '/start', headers: { authorization: `Bearer ${key}` }, body } as never, res as never).then(() => res);
  }
  const JOB = 'j_0123456789abcdef01234567';
  async function startJob(readings: Parameters<typeof jobWorld>[0]) {
    const w = jobWorld(readings);
    const { key } = await makeAgent(w.x);
    const sent = await w.x.service.message(key, 'measure test coverage');
    for (let i = 0; i < 50 && !w.x.uploads.some((u) => u.path.endsWith('.key')); i++) await new Promise((r) => setTimeout(r, 0));
    const turnKey = w.x.uploads.find((u) => u.path.endsWith('.key'))!.content;
    return { ...w, key, turnKey, turnId: (sent.answer as { turnId: string }).turnId };
  }

  it('the door registers a job only with an open per-turn key, labels it redacted, and lists it for the reaper', async () => {
    let finished = false;
    const s = await startJob(() => [{ id: JOB, result: finished ? { state: 'succeeded', exitCode: 0, finishedAt: '2026-11-06T18:20:00.000Z' } : null, alive: !finished, stopped: false, tail: 'All files | 71.2' }]);
    expect((await call(s.x.service, 'acc-guest-not-a-key', { id: JOB, argv: ['ls'] })).code).toBe(401);
    const res = await call(s.x.service, s.turnKey, { id: JOB, argv: ['npx', 'vitest', 'run', '--coverage', 'API_TOKEN=abc123'], timeoutSeconds: 600 });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ label: 'npx vitest run --coverage API_TOKEN=[REDACTED]', timeoutSeconds: 600 });
    const allowed = s.x.uploads.filter((u) => u.path === GUEST_JOBS_ALLOWED);
    expect(allowed.at(-1)).toMatchObject({ content: `${JOB}\n`, mode: 0o600 });
    // The status carries it for the pill: id, label, start; never argv, cwd or output.
    const status = await s.x.service.status(s.key);
    expect(status.jobs).toEqual([{ id: JOB, label: 'npx vitest run --coverage API_TOKEN=[REDACTED]', startedAt: '2026-11-06T18:00:00.000Z' }]);
    expect(JSON.stringify(status)).not.toContain('abc123');
    s.release();
    await s.x.service.idle();
    // The reply ended; the job runs on: awake, never asleep, no quiet clock, not removed after 40 quiet minutes.
    s.x.advance(40 * 60_000);
    await s.x.service.tick();
    const later = await s.x.service.status(s.key);
    expect(later).toMatchObject({ state: 'ready', machine: { awake: true }, quietUntil: null });
    expect(s.x.deleted).toEqual([]);
    // A job's key died with its turn.
    expect((await call(s.x.service, s.turnKey, { id: 'j_aaaaaaaaaaaaaaaaaaaaaaaa', argv: ['ls'] })).code).toBe(401);
    // It finishes: the guest answers in a quiet turn, the visitor gets a new message, not counted.
    finished = true;
    const used = (await s.x.storage.byKeyHash(hashGuestKey(s.key)))!.messagesUsed;
    await s.x.service.pollJobs();
    await s.x.service.idle();
    const jobTurn = s.prompts.find((p) => p.includes('A background job you started has finished'))!;
    expect(jobTurn).toContain(`job ${JOB} — succeeded, exit 0`);
    expect(jobTurn).toContain('| All files | 71.2');
    const done = await s.x.service.status(s.key);
    expect(done.jobs).toEqual([]);
    expect(done.messages.at(-1)).toMatchObject({ role: 'agent', text: 'Coverage is 71% of lines.', fromJob: true });
    expect(done.messages.filter((m) => m.role === 'visitor')).toHaveLength(1);
    expect((await s.x.storage.byKeyHash(hashGuestKey(s.key)))!.messagesUsed).toBe(used);
    expect(s.x.uploads.filter((u) => u.path === GUEST_JOBS_ALLOWED).at(-1)!.content).toBe('');
    // Once: a second read finds nothing owed.
    await s.x.service.pollJobs();
    await s.x.service.idle();
    expect(s.prompts.filter((p) => p.includes('A background job'))).toHaveLength(1);
  });

  it('at most four at once, and only while the reply runs', async () => {
    const s = await startJob(() => []);
    for (let i = 0; i < 4; i++) expect((await call(s.x.service, s.turnKey, { id: `j_${String(i).repeat(24)}`, argv: ['sleep', '600'] })).code).toBe(200);
    const fifth = await call(s.x.service, s.turnKey, { id: 'j_ffffffffffffffffffffffff', argv: ['sleep', '600'] });
    expect(fifth).toMatchObject({ code: 429 });
    expect((await s.x.service.status(s.key)).jobs).toHaveLength(4);
    s.release();
    await s.x.service.idle();
  });

  it('a job the guest stopped, or a quiet one, starts no turn; a lost one is interrupted and does', async () => {
    const s = await startJob(() => [
      { id: 'j_111111111111111111111111', result: { state: 'stopped', exitCode: null, finishedAt: '2026-11-06T18:01:00.000Z' }, alive: false, stopped: true, tail: '' },
      { id: 'j_222222222222222222222222', result: { state: 'succeeded', exitCode: 0, finishedAt: '2026-11-06T18:01:00.000Z' }, alive: false, stopped: false, tail: '' },
    ]);
    await call(s.x.service, s.turnKey, { id: 'j_111111111111111111111111', argv: ['sleep', '600'] });
    await call(s.x.service, s.turnKey, { id: 'j_222222222222222222222222', argv: ['true'], quiet: true });
    await call(s.x.service, s.turnKey, { id: 'j_333333333333333333333333', argv: ['make'] });
    s.release();
    await s.x.service.idle();
    s.x.advance(60_000);
    await s.x.service.pollJobs();
    await s.x.service.idle();
    const receipts = s.prompts.filter((p) => p.includes('[Platform]'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('job j_333333333333333333333333 — interrupted');
    expect(receipts[0]).not.toContain('j_111111111111111111111111');
    expect(receipts[0]).not.toContain('j_222222222222222222222222');
  });

  it('a job that finishes while a reply runs is told when that reply ends, as one turn', async () => {
    let finished = false;
    const s = await startJob(() => [{ id: JOB, result: finished ? { state: 'failed', exitCode: 1, finishedAt: '2026-11-06T18:00:30.000Z' } : null, alive: !finished, stopped: false, tail: 'FAIL' }]);
    await call(s.x.service, s.turnKey, { id: JOB, argv: ['npm', 'test'] });
    finished = true;
    await s.x.service.pollJobs(); // the reply is still running: owed, not started
    expect(s.prompts.filter((p) => p.includes('[Platform]'))).toHaveLength(0);
    s.release();
    await s.x.service.idle();
    expect(s.prompts.filter((p) => p.includes('[Platform]'))).toHaveLength(1);
    expect(s.prompts.find((p) => p.includes('[Platform]'))).toContain('failed, exit 1');
  });

  it('the reaper spares only the registered jobs\' sessions; the turn launch reaps with it', () => {
    const script = buildGuestReapScript('guide', 'KILL');
    expect(script).toContain(GUEST_JOBS_ALLOWED);
    expect(script).toContain('result.json');
    expect(script).toContain('ps -u guide -o pid=,sid=');
    expect(buildGuestClaudeCommand({ prompt: 'p', sessionId: 's', keyFile: '/k', streamFile: '/s', timeoutSeconds: 60 })).toContain(GUEST_JOBS_ALLOWED);
  });

  it('the runner puts the guest\'s own agentbuilt first and hands it the jobs door', () => {
    const runner = buildGuestRunnerScript(SOURCE.doorUrl);
    expect(runner).toContain("PATH='/usr/local/lib/acc-guest/bin:/usr/local/bin:/usr/bin:/bin'");
    expect(runner).toContain("ACC_GUEST_JOBS_URL='https://api.example.com/api/guest-model/jobs'");
    expect(buildGuestSetupScript(SOURCE)).toContain('/usr/local/lib/acc-guest/bin/agentbuilt');
  });

  it('labels: credentials, the per-turn key and long commands never reach the page', () => {
    expect(guestJobLabel(['curl', '-H', 'Authorization: Bearer sekrit', 'https://u:p@x.y/z'])).toBe('curl -H Authorization: Bearer [REDACTED] https://[REDACTED]@x.y/z');
    expect(guestJobLabel(['echo', 'acc-guest-abcdefghijklmnop'])).toBe('echo [REDACTED]');
    expect(guestJobLabel(['x'.repeat(300)])).toHaveLength(120);
  });
});

describe('GuestAgentService — an empty answer (note #1063)', () => {
  it('is not a refusal: the visitor reads that it stopped without an answer, and it is not counted', async () => {
    const x = world({ answer: () => ok(stream('')) });
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'measure test coverage');
    await x.service.idle();
    const turn = await x.service.turnStatus(key, (sent.answer as { turnId: string }).turnId);
    expect(turn).toMatchObject({ state: 'answered', answer: GUEST_NO_ANSWER_TEXT });
    expect(turn!.answer).not.toBe(GUEST_DECLINED_TEXT);
    expect((await x.service.status(key)).messagesLeft).toBe(40);
  });

  it('the instructions keep short code-work asks in scope and name the job runner', () => {
    const text = guestInstructionsFor('Oscar');
    expect(text).toContain('measure its coverage');
    expect(text).toContain('Declining is only for asks that are clearly about something else');
    expect(text).toContain('agentbuilt job start');
    expect(text).toContain('I started this as a background job; I will tell you when it finishes');
  });
});

describe('GuestAgentService — going', () => {
  it('the visitor deletes it: the agent and its machine go, the key answers removed, the owner keeps the transcript', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    await x.service.message(key, 'hello'); await x.service.idle();
    const status = await x.service.deleteByVisitor(key);
    expect(status).toMatchObject({ state: 'removed', removedReason: 'visitor' });
    expect(x.deleted).toEqual(['guest-1']);
    expect((await x.service.status(key)).state).toBe('removed');
    const list = await x.service.listForOwner();
    expect(list.past[0]).toMatchObject({ agentId: 'guest-1', removedReason: 'visitor', messages: 1, costUsd: 0.12 });
    expect((await x.service.transcriptForOwner('guest-1'))?.messages).toHaveLength(3);
  });

  it('30 quiet minutes and it is deleted with its machine; an open tab where nobody types counts as quiet', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    x.advance(29 * 60_000);
    await x.service.status(key); // a poll is not activity
    await x.service.tick();
    expect(x.deleted).toEqual([]);
    x.advance(60_000);
    await x.service.tick();
    expect(x.deleted).toEqual(['guest-1']);
    expect(await x.service.status(key)).toMatchObject({ state: 'removed', removedReason: 'quiet' });
  });

  it('3 hours is the end even for a busy one', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    for (let i = 0; i < 8; i += 1) {
      x.advance(25 * 60_000);
      await x.service.message(key, `message ${i}`); await x.service.idle();
      await x.service.tick();
    }
    expect(await x.service.status(key)).toMatchObject({ state: 'removed', removedReason: 'lifetime' });
  });

  it('after 40 messages it takes no more, and goes after 5 quiet minutes', async () => {
    const x = world({ limits: { messagesMax: 2 } });
    const { key } = await makeAgent(x);
    await x.service.message(key, 'one'); await x.service.idle();
    await x.service.message(key, 'two'); await x.service.idle();
    expect((await x.service.message(key, 'three')).answer).toMatchObject({ state: 'status', status: { state: 'limited' } });
    x.advance(5 * 60_000);
    await x.service.tick();
    expect(await x.service.status(key)).toMatchObject({ state: 'removed', removedReason: 'messages' });
  });

  it('the leak guard: a deletion that failed is tried again, and a guest record nobody knows is deleted', async () => {
    const x = world();
    const { key } = await makeAgent(x);
    const host = (x.service as unknown as { deps: { host: { deleteAgent: (u: string, id: string) => Promise<boolean> } } }).deps.host;
    const real = host.deleteAgent;
    host.deleteAgent = async () => false;
    await x.service.deleteByVisitor(key);
    expect((await x.storage.listByPhase(['removing'])).length).toBe(1);
    host.deleteAgent = real;
    x.advance(11 * 60_000);
    await x.service.tick();
    expect((await x.storage.listByPhase(['removing'])).length).toBe(0);
    x.agents.set('stray', { id: 'stray', name: 'Stray', sealed: 'guest' } as AgentRecord);
    x.advance(61 * 60_000);
    await x.service.tick();
    expect(x.deleted).toContain('stray');
  });

});

describe('guest agent storage (SQLite)', () => {
  it('round-trips a row, finds it by key, counts claims, prunes old keys and old transcripts', async () => {
    const storage = new SqliteGuestAgentStorage(openSqliteDb(':memory:'));
    const base = {
      agentId: 'g1', userId: 'u', orgId: 'o', phase: 'removed' as const, keyHash: 'h1', preparedAt: '2026-08-01T00:00:00.000Z', claimedAt: '2026-08-01T00:01:00.000Z',
      lastActiveAt: null, messagesUsed: 1, claudeSessionId: null, steps: null, removedAt: '2026-08-01T00:30:00.000Z', removedReason: 'quiet' as const,
      transcript: { agentId: 'g1', name: 'Juno', avatarUrl: null, createdAt: 'x', removedAt: null, removedReason: null, messages: [] },
    };
    await storage.put(base);
    await storage.put({ ...base, agentId: 'g2', keyHash: 'h2', preparedAt: '2026-11-06T00:00:00.000Z', claimedAt: '2026-11-06T00:01:00.000Z', removedAt: '2026-11-06T00:30:00.000Z' });
    expect((await storage.byKeyHash('h2'))?.agentId).toBe('g2');
    expect(await storage.countClaimedSince(Date.parse('2026-11-06T00:00:00Z'))).toBe(1);
    expect(await storage.prune(Date.parse('2026-11-06T12:00:00Z'), Date.parse('2026-08-08T00:00:00Z'))).toBe(1);
    expect(await storage.get('g1')).toBeNull();
    expect((await storage.get('g2'))?.keyHash).toBeNull();
    await storage.setSettings({ enabled: true, userId: 'u', orgId: 'o', changedAt: 'x' });
    expect((await storage.getSettings())?.enabled).toBe(true);
  });
});
