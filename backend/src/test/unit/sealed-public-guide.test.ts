/**
 * The sealed public guide (note #1010): the seal, proved.
 *
 * The claim these tests hold the code to: a sealed agent's machine never
 * receives a workplace secret or a platform token — not in a turn of its
 * owner's chat, not at creation, not in a visitor's turn — and every turn
 * there runs as the `guide` user through the sealed runner, with read-only
 * tools. The one credential that reaches the machine is the seat token a
 * turn needs to think, and it rides the environment of the sudo call only.
 *
 * The runner itself is exercised for real (bash), with `claude` replaced by
 * a printer, so its flag allow-list and its environment scrub are tested as
 * behaviour, not as strings. The full end-to-end probe against the real
 * Claude Code binary and a stub model provider is backend/scripts/probe-sealed-guide.mts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import { createClaudeHarnessRunner } from '../../agent/claude/claude-harness.js';
import { AgentService } from '../../services/agent-service.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { InMemorySessionStorage } from '../../services/session-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { UserSecretsService } from '../../services/user-secrets.js';
import {
  GUIDE_RUNNER_PATH,
  buildGuideRunnerScript,
  buildGuideSetupScript,
  buildSealedClaudeCommand,
  guideAnswerLeak,
  guideRelativePath,
  readGuideStream,
} from '../../services/public-guide-machine.js';
import { FakeTurnOutputFiles, FakeWorkspaceRuntimeClient, makeExecSyncResult } from '../mocks/fake-workspace-runtime-client.js';

const SEAT_TOKEN = 'sk-ant-oat01-SEAT-TOKEN-0123456789';
const SECRETS = {
  GITHUB_TOKEN: 'ghp_WORKPLACESECRET0123456789abcdefABCDEF',
  OPENAI_API_KEY: 'sk-proj-WORKPLACE-SECRET-VALUE-42',
  DEPLOY_PASSWORD: 'correct-horse-battery-staple-1010',
};
const SESSION_ID = '02f545d2-f37f-46c1-bd93-bd720ce07ccd';

async function harnessWorld(sealed: boolean) {
  const client = new FakeWorkspaceRuntimeClient();
  const sessionStorage = new InMemorySessionStorage();
  const userStorage = new InMemoryUserStorage();
  const eventEmitter = new AgentEventEmitter();
  await sessionStorage.createSession('session-1', 'user-1', { sandboxId: 'sb-1' });
  await userStorage.createProfile('user-1', {
    email: 'owner@example.com',
    displayName: 'Owner',
    telegram: {
      agents: {
        'agent-1': {
          id: 'agent-1', name: 'Wren', cli: 'claude', createdAt: '2026-11-05T00:00:00.000Z',
          // Whatever a record says, a sealed agent runs on its kind's model.
          model: 'opus', effort: 'max',
          ...(sealed ? { sealed: 'public-guide' as const } : {}),
        },
      },
    },
  });
  // The workplace's shared keys, and the seat token, exactly where a real turn finds them.
  const secretStorage = new InMemorySecretStorage();
  const secrets = new UserSecretsService(secretStorage);
  for (const [name, value] of Object.entries(SECRETS)) {
    const set = await secrets.setSecret('user-1', name, value, undefined, 'A key for the seal test.');
    expect(set.ok).toBe(true);
  }
  await secretStorage.createSecret('user-1', { key: 'claude-oauth-token', value: SEAT_TOKEN });
  const turnFiles = new FakeTurnOutputFiles([[
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'It reads the code.' }] }, session_id: SESSION_ID }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'It reads the code.', session_id: SESSION_ID }),
  ]], [], [], []);
  client.execSyncHandler = (command) => turnFiles.answer(command)
    ?? (command.startsWith('if [ -f ') ? makeExecSyncResult({ stdout: 'running\n' }) : makeExecSyncResult());
  const runner = createClaudeHarnessRunner({
    sandboxClient: client,
    resolveDefaultSandboxId: async () => 'sb-1',
    sealedGuideSource: async () => ({ cloneUrl: 'https://git.example.com/acme/agentic-cloud.git', branch: 'main' }),
    fetchImpl: vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })) as unknown as typeof fetch,
  });
  const deps = {
    sessionStorage,
    eventEmitter,
    toolExecutor: {} as AgentLoopDeps['toolExecutor'],
    aiModel: 'mock-model',
    notifyAssistantResponse: vi.fn().mockResolvedValue(undefined),
    userStorage,
    telegramTargetAgentId: 'agent-1',
    secretStorage,
  } as unknown as AgentLoopDeps;
  return { client, runner, deps };
}

/** Everything the backend sent to the machine: every command, every launched script. */
function everythingSent(client: FakeWorkspaceRuntimeClient): string {
  return client.execSyncCalls.map((call) => call.command).join('\n----\n');
}

describe('a sealed agent\'s machine never receives a secret or a platform token (note #1010)', () => {
  it('control: an ordinary agent\'s turn IS handed the workplace\'s keys, so the test below can see them', async () => {
    const { client, runner, deps } = await harnessWorld(false);
    await runner('session-1', 'user-1', 'deploy it', deps, undefined);
    const sent = everythingSent(client);
    for (const value of Object.values(SECRETS)) expect(sent).toContain(value);
    expect(sent).toContain('bypassPermissions');
  });

  it('the owner\'s own chat with a sealed guide: no secret anywhere, run as guide through the sealed runner, on sonnet at medium', async () => {
    const { client, runner, deps } = await harnessWorld(true);
    await runner('session-1', 'user-1', 'what does the platform do?', deps, undefined);
    const sent = everythingSent(client);
    for (const value of Object.values(SECRETS)) expect(sent).not.toContain(value);
    for (const name of Object.keys(SECRETS)) expect(sent).not.toContain(`${name}=`);
    expect(sent).not.toMatch(/agb1\./);
    expect(sent).not.toContain('.agentbuilt');
    expect(sent).not.toContain('bypassPermissions');
    const launch = client.detachedLaunchCalls[0]?.command ?? '';
    expect(launch).toContain(`sudo -n --preserve-env=CLAUDE_CODE_OAUTH_TOKEN -u guide -- ${GUIDE_RUNNER_PATH}`);
    expect(launch).toContain("--model 'sonnet'");
    expect(launch).toContain("--effort 'medium'");
    expect(launch).not.toContain("'opus'");
    // The machine heals itself first: the setup runs before the turn.
    expect(launch).toContain('useradd --system');
    // The seat token rides the environment of the sudo call only — never an argument after it.
    const afterSudo = launch.slice(launch.indexOf('sudo -n --preserve-env'));
    expect(afterSudo).not.toContain(SEAT_TOKEN);
  });
});

function agentServiceWorld() {
  const userStorage = new InMemoryUserStorage();
  const client = new FakeWorkspaceRuntimeClient();
  const createAgentSandbox = vi.fn().mockResolvedValue({ appName: 'ia-wren', machineId: 'abc123', region: 'ams' });
  const provisionPreview = vi.fn().mockResolvedValue(undefined);
  const setGuide = vi.fn().mockResolvedValue(undefined);
  const clearGuide = vi.fn().mockResolvedValue(undefined);
  const service = new AgentService({
    sessionStorage: new InMemorySessionStorage(),
    secretStorage: new InMemorySecretStorage(),
    userStorage,
    sessionManager: { getSandboxClient: () => client } as never,
    eventEmitter: new AgentEventEmitter(),
    backgroundRunner: { isRunning: () => false, stop: vi.fn(), on: vi.fn() } as never,
    reminderScheduler: {} as never,
    userSandboxManager: { ensureDefaultSandboxForUser: vi.fn().mockResolvedValue({ sandboxId: 'sandbox-1' }) } as never,
    managedServerService: { buildRuntimeContext: vi.fn().mockResolvedValue(undefined) } as never,
    flySandboxClient: { createAgentSandbox, sandboxExists: vi.fn().mockResolvedValue(true) } as never,
    agentbuilt: { apiUrl: 'https://api.example.com', appsDomain: 'apps.example.com' },
    previewDomains: { provision: provisionPreview, ensure: provisionPreview } as never,
    publicGuide: { setGuide, clearGuide },
    aiModel: 'openai/gpt-5.4-mini',
  } as never);
  return { service, userStorage, client, createAgentSandbox, provisionPreview, setGuide };
}

async function ownerProfile(userStorage: InMemoryUserStorage, agents: Record<string, unknown> = {}) {
  await userStorage.createProfile('user-1', {
    email: '', displayName: 'Owner', username: 'owner', authType: 'telegram',
    telegram: { chatId: '1', telegramUserId: '2', username: 'owner', linkedAt: '2026-11-05T00:00:00.000Z', notificationsEnabled: true, agents },
  } as never);
  await userStorage.updateProfile('user-1', { roles: { admin: true } } as never);
}

describe('creating a sealed guide (note #1010)', () => {
  it('reserves a sealed Claude record on sonnet at medium, builds a shared-core machine, and never writes an identity, a token or a preview address', async () => {
    const world = agentServiceWorld();
    await ownerProfile(world.userStorage);
    const result = await world.service.startAgentCreationFromMiniApp('user-1', 'claude', undefined, {
      awaitName: true, sealed: 'public-guide', model: 'opus', effort: 'max',
    });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(world.createAgentSandbox).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const agents = Object.values((await world.userStorage.getProfile('user-1'))?.telegram?.agents ?? {});
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ sealed: 'public-guide', cli: 'claude', model: 'sonnet', effort: 'medium' });
    expect(world.createAgentSandbox.mock.calls[0]![0].size).toEqual({ cpuKind: 'shared', cpus: 2, memoryMb: 4096 });
    expect(world.setGuide).toHaveBeenCalledWith('user-1', agents[0]!.id);
    expect(world.provisionPreview).not.toHaveBeenCalled();
    const sent = everythingSent(world.client);
    expect(sent).not.toMatch(/agb1\./);
    expect(sent).not.toContain('.agentbuilt');
    expect(agents[0]!.agentbuiltTokenHash).toBeUndefined();
  });

  it('refuses a sealed guide on any harness but Claude Code', async () => {
    const world = agentServiceWorld();
    await ownerProfile(world.userStorage);
    await expect(world.service.startAgentCreationFromMiniApp('user-1', 'codex', undefined, { sealed: 'public-guide' }))
      .resolves.toMatchObject({ ok: false });
    expect(world.createAgentSandbox).not.toHaveBeenCalled();
  });

  it('the identity write — the one place a machine token is minted — does nothing at all for a sealed agent', async () => {
    const world = agentServiceWorld();
    await ownerProfile(world.userStorage, {
      'agent-1': { id: 'agent-1', name: 'Wren', cli: 'claude', createdAt: 'x', serverId: 'fly_ia-wren.abc123', sealed: 'public-guide' },
    });
    const agent = (await world.userStorage.getProfile('user-1'))!.telegram!.agents!['agent-1']!;
    await (world.service as unknown as { writeTelegramAgentIdentity(u: string, a: unknown): Promise<void> })
      .writeTelegramAgentIdentity('user-1', agent);
    expect(world.client.execSyncCalls).toHaveLength(0);
    expect((await world.userStorage.getProfile('user-1'))!.telegram!.agents!['agent-1']!.agentbuiltTokenHash).toBeUndefined();
  });
});

/** The installed runner, with the identity check off and `claude` replaced by a printer. */
function runRunner(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const script = buildGuideRunnerScript()
    .replace(/^if \[ "\$\(id -un\)".*$/m, '')
    .replace(/^cd '.*' \|\| \{.*$/m, '')
    .replace('exec claude "${__args[@]}"', 'env | sort; echo ---; printf "%s\\n" "${__args[@]}"; true');
  const dir = mkdtempSync(join(tmpdir(), 'guide-runner-'));
  const path = join(dir, 'turn');
  writeFileSync(path, script, { mode: 0o755 });
  const result = spawnSync('bash', [path, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the sealed runner (behaviour, run in bash)', () => {
  it('refuses any flag outside its allow-list, so nothing can widen the tools', () => {
    for (const bad of [['--tools', 'Bash'], ['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--allowedTools', 'Bash'], ['--add-dir', '/home/agent'], ['--settings', '{}'], ['--mcp-config', 'x.json'], ['--output-format', 'text']]) {
      const run = runRunner(['-p', 'q', ...bad]);
      expect(run.status, bad.join(' ')).toBe(64);
    }
  });

  it('keeps exactly one variable of the environment it was started with — the seat credential', () => {
    const run = runRunner(['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'], {
      CLAUDE_CODE_OAUTH_TOKEN: SEAT_TOKEN,
      GITHUB_TOKEN: SECRETS.GITHUB_TOKEN,
      AGENTBUILT_TOKEN: 'agb1.leak.leak',
      SUDO_COMMAND: '/bin/bash -c x',
    });
    expect(run.status).toBe(0);
    const [envBlock, argBlock] = run.stdout.split('---\n');
    const names = envBlock!.trim().split('\n').map((line) => line.split('=')[0]).filter((name) => name && name !== '_' && name !== 'PWD' && name !== 'SHLVL' && name !== 'OLDPWD');
    expect(names.sort()).toEqual(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'LANG', 'PATH']);
    expect(run.stdout).not.toContain(SECRETS.GITHUB_TOKEN);
    expect(run.stdout).not.toContain('agb1');
    expect(argBlock).toContain('hello');
  });

  it('always adds the sealing flags itself', () => {
    const script = buildGuideRunnerScript();
    expect(script).toContain("--tools 'Read,Grep,Glob'");
    expect(script).toContain('--permission-mode dontAsk');
    expect(script).toContain("--setting-sources ''");
    expect(script).toContain('--strict-mcp-config');
    expect(script).toContain('--system-prompt-file');
    expect(script).not.toContain('bypassPermissions');
  });
});

describe('the sealed machine\'s setup', () => {
  const setup = buildGuideSetupScript({ cloneUrl: 'https://git.example.com/acme/agentic-cloud.git', branch: 'main' });
  it('makes a separate system user with no shell, no groups, no sudo, and closes the agent\'s home to it', () => {
    expect(setup).toContain('useradd --system --user-group --home-dir /srv/guide/home --no-create-home --shell /usr/sbin/nologin guide');
    expect(setup).toContain('gpasswd -d guide');
    expect(setup).toContain('rm -f /etc/sudoers.d/guide');
    expect(setup).toContain('chmod 0750 /home/agent');
    expect(setup).toContain('hidepid=invisible');
  });
  it('clones anonymously as the guide: no credential helper, no global config, no prompt', () => {
    expect(setup).toContain('sudo -n -u guide env -i HOME=/srv/guide/home');
    expect(setup).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(setup).toContain('GIT_TERMINAL_PROMPT=0');
    expect(setup).toContain("git clone --quiet --depth 1 --single-branch --branch 'main' 'https://git.example.com/acme/agentic-cloud.git'");
    expect(setup).not.toMatch(/token|password|agb1/i);
  });
});

describe('a sealed turn\'s command', () => {
  it('puts the seat token only in the environment of the sudo call', () => {
    const command = buildSealedClaudeCommand({ prompt: 'q', oauthToken: SEAT_TOKEN, sessionId: SESSION_ID, model: 'sonnet' });
    expect(command.startsWith(`CLAUDE_CODE_OAUTH_TOKEN='${SEAT_TOKEN}' sudo -n --preserve-env=CLAUDE_CODE_OAUTH_TOKEN -u guide -- ${GUIDE_RUNNER_PATH} `)).toBe(true);
    expect(command.split(SEAT_TOKEN)).toHaveLength(2);
    expect(command).toContain(`--session-id '${SESSION_ID}'`);
  });
});

describe('reading a visit turn\'s stream', () => {
  it('lists the files it opened relative to the public copy, drops anything outside it, and reads the answer and its cost', () => {
    const reading = readGuideStream([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Grep', input: { pattern: 'machine', path: 'src/docs' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/srv/guide/agentic-cloud/README.md' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/home/agent/.agentbuilt/config.json' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/srv/guide/agentic-cloud/../../etc/passwd' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/srv/guide/agentic-cloud/README.md' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.md' } },
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Every agent has its own machine.', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 4_000 } }),
    ].join('\n'));
    expect(reading.files).toEqual(['src/docs', 'README.md']);
    expect(reading.answer).toBe('Every agent has its own machine.');
    expect(reading.costUsd).toBe(0.12);
    expect(reading.tokens).toEqual({ input: 10, output: 200, cacheRead: 30_000, cacheWrite: 4_000 });
    expect(reading.sessionId).toBe(SESSION_ID);
  });
  it('keeps only paths a visitor could open', () => {
    expect(guideRelativePath('backend/src/index.ts')).toBe('backend/src/index.ts');
    expect(guideRelativePath('./README.md')).toBe('README.md');
    expect(guideRelativePath('/etc/passwd')).toBeNull();
    expect(guideRelativePath('~/.ssh/id_rsa')).toBeNull();
    expect(guideRelativePath('../x')).toBeNull();
    expect(guideRelativePath('.git/config')).toBeNull();
  });
});

describe('the outgoing check', () => {
  it('holds back anything shaped like a credential, a machine path, a private address or a stranger\'s email', () => {
    expect(guideAnswerLeak('Your token is sk-ant-oat01-abcdefghijk')).toBe('credential');
    expect(guideAnswerLeak('agb1.eyJ1c2VyIjoiYSJ9.c2VjcmV0')).toBe('credential');
    expect(guideAnswerLeak(`use ${SECRETS.GITHUB_TOKEN}`)).toBe('credential');
    expect(guideAnswerLeak('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('credential');
    expect(guideAnswerLeak('I am in /srv/guide/agentic-cloud')).toBe('machine path');
    expect(guideAnswerLeak('read /proc/self/environ')).toBe('machine path');
    expect(guideAnswerLeak('the backend is at fdaa:0:1::3')).toBe('private address');
    expect(guideAnswerLeak('mail adam@gmail.com')).toBe('email address');
  });
  it('lets an ordinary answer through, docs paths and the product\'s own addresses included', () => {
    expect(guideAnswerLeak('Each agent has its own machine; only /home/agent survives an image upgrade (src/docs/chapters/agents.tsx).')).toBeNull();
    expect(guideAnswerLeak('Write to hello@agenticcloudcomputer.com.')).toBeNull();
    expect(guideAnswerLeak('POST /api/public/ask with a question.')).toBeNull();
  });
});
