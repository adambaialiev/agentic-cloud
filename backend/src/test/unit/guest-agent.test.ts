/**
 * Guests' own agents (note #1038): the machine's runner and lock, the model
 * door, and the service between the public routes and the agent layer —
 * spares, the line, the ceilings, turns, Stop, deletion, the sweeper and the
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
  GUEST_TURN_KEY_ENV,
  buildGuestClaudeCommand,
  buildGuestFirewall,
  buildGuestRunnerScript,
  buildGuestSetupScript,
  guestEgressAllowList,
  readGuestStream,
} from '../../services/guest-agent-machine.js';
import { GuestModelDoor, GUEST_DOOR_MAX_REQUESTS_PER_TURN } from '../../services/guest-model-door.js';
import { GuestAgentService, hashGuestKey } from '../../services/guest-agent-service.js';
import { InMemoryGuestAgentStorage, SqliteGuestAgentStorage } from '../../services/guest-agent-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { GUEST_AGENT_LIMITS, GUEST_DECLINED_TEXT } from '../../shared/guest-agent.js';

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

  it('caps every shell command well inside a reply\'s minutes (note #1047)', () => {
    const run = runRunner(['-p', 'hi']);
    const [envBlock] = run.stdout.split('---\n');
    expect(envBlock).toContain('BASH_DEFAULT_TIMEOUT_MS=60000');
    expect(envBlock).toContain('BASH_MAX_TIMEOUT_MS=100000');
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
    expect(command).toContain('pkill -KILL -u guide');
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
      if (command.includes('GUEST_SETUP_EOF')) return ok();
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
    limits: { sparesTarget: 0, ...(options.limits ?? {}) },
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
  it('makes an agent for a visitor: a key, the four steps, then ready with the fixed greeting', async () => {
    const x = world();
    const made = await x.service.create({ address: 'a' });
    expect(made.httpStatus).toBe(201);
    const key = (made.answer as { key: string }).key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((made.answer as { status: { state: string; estimateSeconds: number } }).status).toMatchObject({ state: 'creating', estimateSeconds: 120 });
    await x.service.idle();
    const status = await x.service.status(key);
    expect(status).toMatchObject({ state: 'ready', agent: { name: 'Juno' }, machine: { cores: 2, memoryGb: 4, dedicated: true }, messagesLeft: 40 });
    expect(status.messages).toEqual([expect.objectContaining({ role: 'agent', text: expect.stringContaining("Hi, I'm Juno.") })]);
    expect(x.commands.some((c) => c.includes('GUEST_SETUP_EOF'))).toBe(true);
    const row = await x.storage.byKeyHash(hashGuestKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
  });

  it('claims a ready spare first and keeps one spare ready behind it', async () => {
    const x = world({ limits: { sparesTarget: 1 } });
    await x.service.tick();
    await x.service.idle();
    expect((await x.storage.listByPhase(['spare'])).map((r) => r.agentId)).toEqual(['guest-1']);
    const made = await x.service.create({ address: 'a' });
    const status = (made.answer as { status: { state: string; steps: Array<{ id: string; done: boolean }> } }).status;
    expect(status.steps?.filter((s) => s.done).map((s) => s.id)).toEqual(['computer', 'code']);
    expect((made.answer as { status: { estimateSeconds: number } }).status.estimateSeconds).toBe(15);
    await x.service.idle();
    expect(await x.service.status((made.answer as { key: string }).key)).toMatchObject({ state: 'ready', agent: { name: 'Juno' } });
    expect((await x.storage.listByPhase(['spare'])).map((r) => r.agentId)).toEqual(['guest-2']);
  });

  it('one live agent per address, and three a day', async () => {
    const x = world({ limits: { liveMax: 5 } });
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

  it('above the ceiling: a place in line, kept only while polled, started when a slot frees', async () => {
    const x = world({ limits: { liveMax: 1 } });
    const first = await makeAgent(x, 'a');
    const waiting = await x.service.create({ address: 'b' });
    const key = (waiting.answer as { key: string }).key;
    expect((waiting.answer as { status: { state: string; linePosition: number } }).status).toMatchObject({ state: 'waiting', linePosition: 1 });
    const gone = await x.service.create({ address: 'c' });
    const goneKey = (gone.answer as { key: string }).key;
    x.advance(50_000);
    expect((await x.service.status(key)).linePosition).toBe(1);
    x.advance(50_000); // c stopped polling 100 s ago; b polled 50 s ago (grace 90 s)
    await x.service.deleteByVisitor(first.key);
    await x.service.tick();
    await x.service.idle();
    expect((await x.service.status(key)).state).toBe('ready');
    expect((await x.service.status(goneKey)).state).toBe('none');
  });

  it('rests when guests are off, when the seat is benched, and after 40 a day', async () => {
    expect((await world({ enabled: false }).service.status(undefined)).state).toBe('resting');
    const benched = world({ seat: { status: 'cooldown', cooldownUntil: '2026-11-06T20:00:00.000Z' } as never });
    expect(await benched.service.status(undefined)).toMatchObject({ state: 'resting', until: '2026-11-06T20:00:00.000Z' });
    const busy = world({ limits: { globalPerDay: 1, liveMax: 5 } });
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

  it('a failed build says failed and leaves nothing behind', async () => {
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

  it('a reply that runs out of time says so in plain words, names the command, and is not counted (note #1047)', async () => {
    const timedOut = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd backend && npx vitest run --coverage' } }] } }),
    ].join('\n');
    const x = world({ answer: () => ({ stdout: timedOut, stderr: '', exitCode: 124, timedOut: true }) });
    const { key } = await makeAgent(x);
    const sent = await x.service.message(key, 'can you measure it?'); await x.service.idle();
    const turn = await x.service.turnStatus(key, (sent.answer as { turnId: string }).turnId);
    expect(turn?.state).toBe('answered');
    expect(turn?.answer).toContain('longer than the 3 minutes I have for one reply');
    expect(turn?.answer).toContain('`cd backend && npx vitest run --coverage`');
    expect(turn?.answer).not.toMatch(/went wrong/i);
    expect((await x.service.status(key)).messagesLeft).toBe(40);
  });

  it('a spare gets its packages installed as the guide, through the proxy; a failed install still leaves a spare (note #1047)', async () => {
    const x = world({ limits: { sparesTarget: 1 } });
    await x.service.tick(); await x.service.idle();
    const deps = x.commands.find((c) => c.includes('npm ci'));
    expect(deps).toContain('sudo -n -u guide env -i');
    expect(deps).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(deps).toContain('/data/guest/.deps-ready');
    expect(deps).toContain('npm ci --ignore-scripts');
    expect(deps).toContain('/data/guest/agentic-cloud/backend');
    expect((await x.storage.listByPhase(['spare'])).length).toBe(1);
    const y = world({ limits: { sparesTarget: 1 }, answer: () => ok() });
    y.client.execSync.mockImplementation(async (_s: string, command: string) => {
      y.commands.push(command);
      return command.includes('npm ci') ? { stdout: '', stderr: 'E404', exitCode: 1, timedOut: false } : ok();
    });
    await y.service.tick(); await y.service.idle();
    expect((await y.storage.listByPhase(['spare'])).length).toBe(1);
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
    expect(x.commands.some((c) => c.includes('pkill -TERM -u guide'))).toBe(true);
    release();
    await x.service.idle();
    expect((await x.service.turnStatus(key, turnId))?.state).toBe('stopped');
  });

  it('another key cannot read or stop someone else\'s turn', async () => {
    const x = world({ limits: { liveMax: 5 } });
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

  it('switching guests off deletes the spare', async () => {
    const x = world({ limits: { sparesTarget: 1 } });
    await x.service.tick(); await x.service.idle();
    await x.service.setEnabled('owner-1', 'org-1', false);
    await x.service.tick(); await x.service.idle();
    expect(x.deleted).toEqual(['guest-1']);
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
