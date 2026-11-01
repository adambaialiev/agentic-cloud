import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import {
  OPENCODE_KEY_REFUSED_MESSAGE,
  OPENCODE_TURN_STALLED_MESSAGE,
  createOpenCodeHarnessRunner,
  openCodeFailureOf,
} from '../../agent/opencode/opencode-harness.js';
import { modelLimitMessage, NO_SEAT_MESSAGE } from '../../agent/platform-turn-policy.js';
import { InMemorySessionStorage } from '../../services/session-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { EventCapture } from '../helpers/event-capture.js';
import {
  FakeTurnOutputFiles,
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
} from '../mocks/fake-workspace-runtime-client.js';

const SESSION = 'ses_ea5226a60ffek9ajcoCMVfSLqR';

/** Lines shaped exactly as `opencode run --format json` printed them (1.19.3, stub provider). */
const line = {
  stepStart: () => ({ type: 'step_start', timestamp: 1, sessionID: SESSION, part: { type: 'step-start', sessionID: SESSION } }),
  tool: (command: string) => ({
    type: 'tool_use', timestamp: 2, sessionID: SESSION,
    part: { type: 'tool', tool: 'bash', sessionID: SESSION, state: { status: 'completed', input: { command, description: 'x' }, output: 'ok\n', title: command } },
  }),
  stepFinish: (tokens: { input: number; output: number; reasoning: number; read: number; write?: number }, reason = 'stop') => ({
    type: 'step_finish', timestamp: 3, sessionID: SESSION,
    part: {
      type: 'step-finish', reason, sessionID: SESSION, cost: 0.0001,
      tokens: { total: 0, input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.read, write: tokens.write ?? 0 } },
    },
  }),
  text: (text: string) => ({ type: 'text', timestamp: 4, sessionID: SESSION, part: { type: 'text', text, sessionID: SESSION } }),
  error: (message: string, statusCode: number, responseBody = '') => ({
    type: 'error', timestamp: 5, sessionID: SESSION,
    error: { name: 'APIError', data: { message, statusCode, isRetryable: statusCode === 429, responseBody } },
  }),
  goLimit: (retryAt: number) => ({
    type: 'platform_limit', timestamp: 6, sessionID: SESSION, reason: 'account_rate_limit', provider: 'opencode-go',
    message: '5-hour usage limit reached. It will reset in 2 hours 13 minutes. To continue using this model now, enable usage from your available balance',
    retryAt,
  }),
};
const jsonl = (...events: object[]) => events.map((event) => JSON.stringify(event));

async function setupHarness(options: {
  turnFiles?: string[][];
  turnExitCodes?: number[];
  turnStderrs?: string[];
  model?: string;
  effort?: string;
  opencodeSessionId?: string;
  lease?: unknown;
} = {}) {
  const client = new FakeWorkspaceRuntimeClient();
  const sessionStorage = new InMemorySessionStorage();
  const userStorage = new InMemoryUserStorage();
  const eventEmitter = new AgentEventEmitter();
  const notifyAssistantResponse = vi.fn().mockResolvedValue(undefined);
  await sessionStorage.createSession('session-1', 'user-1', { sandboxId: 'sb-1' });
  await userStorage.createProfile('user-1', {
    email: 'user@example.com',
    displayName: 'Test User',
    telegram: {
      agents: {
        'agent-oc': {
          id: 'agent-oc',
          name: 'Ada',
          cli: 'opencode',
          createdAt: '2026-01-01T00:00:00.000Z',
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        },
      },
    },
  });
  if (options.opencodeSessionId) {
    await userStorage.updateTelegramHarnessConversation('user-1', { opencodeSessionId: options.opencodeSessionId }, { agentId: 'agent-oc' });
  }
  const turnFiles = new FakeTurnOutputFiles(options.turnFiles ?? [], options.turnExitCodes ?? [], options.turnStderrs ?? []);
  client.execSyncHandler = (command) => turnFiles.answer(command)
    ?? (command.startsWith('if [ -f ') ? makeExecSyncResult({ stdout: 'running\n' }) : makeExecSyncResult());
  const ledger = new InMemoryAgentTokenLedger();
  const releaseCredential = vi.fn().mockResolvedValue(undefined);
  const leaseForUser = vi.fn().mockResolvedValue(options.lease ?? {
    kind: 'dedicated', lease: { credentialId: 'seat-oc', token: 'sk-oc-test-key-123' },
  });
  const deps = {
    sessionStorage,
    eventEmitter,
    toolExecutor: {} as AgentLoopDeps['toolExecutor'],
    aiModel: 'mock-model',
    notifyAssistantResponse,
    userStorage,
    agentTokenLedger: ledger,
    platformCredentialPool: { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'],
    telegramTargetAgentId: 'agent-oc',
  } as AgentLoopDeps;
  const runner = createOpenCodeHarnessRunner({ sandboxClient: client, resolveDefaultSandboxId: async () => 'sb-1' });
  const events = new EventCapture().subscribe(eventEmitter, 'session-1');
  return { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse, events, ledger, leaseForUser, releaseCredential, turnFiles };
}

describe('opencode harness runner', () => {
  it('runs a first turn on the seat\'s key: delivers the reply, keeps the session, credits every step', async () => {
    const { client, userStorage, deps, runner, notifyAssistantResponse, ledger, leaseForUser, releaseCredential, sessionStorage } = await setupHarness({
      turnFiles: [jsonl(
        line.stepStart(),
        line.tool('ls'),
        line.stepFinish({ input: 900, output: 8, reasoning: 3, read: 100 }, 'tool-calls'),
        line.stepStart(),
        line.text('hello there'),
        line.stepFinish({ input: 1800, output: 18, reasoning: 4, read: 200, write: 50 }),
      )],
    });

    await runner('session-1', 'user-1', 'hi opencode', deps, undefined);

    // Leased by the agent's harness and model, so a model benched on the
    // seat is passed over (Go's limits are per model).
    expect(leaseForUser).toHaveBeenCalledWith('opencode', 'user-1', { model: 'glm-5.3' });
    const launch = client.detachedLaunchCalls[0]!;
    expect(launch.cwd).toBe('/home/agent');
    expect(launch.sshUser).toBe('agent');
    expect(launch.command).toContain("opencode run --format json --auto --model 'opencode-go/glm-5.3' --variant 'high' --title 'Ada' -- 'hi' 'opencode'");
    // The key rides the turn's environment, in the script body, never argv.
    expect(launch.command).toContain("export OPENCODE_API_KEY='sk-oc-test-key-123'");
    expect(launch.command).toContain("export OPENCODE_DISABLE_AUTOUPDATE='1'");
    expect(launch.command).not.toMatch(/opencode run[^\n]*sk-oc-test-key-123/);

    expect(notifyAssistantResponse).toHaveBeenCalledWith({
      userId: 'user-1', sessionId: 'session-1', content: 'hello there', source: 'opencode-cli', model: 'glm-5.3', requestedModel: 'glm-5.3',
    });
    const agent = (await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-oc'];
    expect(agent?.conversation?.opencodeSessionId).toBe(SESSION);
    // The window: the LAST request's prompt (fresh + cache), against the model's own window.
    expect(agent?.contextUsage).toMatchObject({ tokens: 2050, model: 'glm-5.3', window: 1_000_000 });
    // Per-request figures, summed; reasoning added back into output.
    const rows = ledger.userDays('user-1', '2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'opencode', model: 'glm-5.3' });
    const days = ledger.userAgentDays('user-1', '2026-01-01');
    expect(days[0]).toMatchObject({ provider: 'opencode', model: 'glm-5.3', input: 2700, output: 33, cacheRead: 300, cacheWrite: 50, reasoning: 7 });
    expect(releaseCredential).toHaveBeenCalledWith('seat-oc', { kind: 'ok' });
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('resumes the stored session and passes no title', async () => {
    const { client, deps, runner } = await setupHarness({
      opencodeSessionId: SESSION,
      turnFiles: [jsonl(line.stepStart(), line.text('resumed'), line.stepFinish({ input: 10, output: 2, reasoning: 0, read: 3000 }))],
    });
    await runner('session-1', 'user-1', 'again', deps, undefined);
    const command = client.detachedLaunchCalls[0]!.command;
    expect(command).toContain(`--session '${SESSION}'`);
    expect(command).not.toContain('--title');
  });

  it('runs a model with no effort setting without a variant', async () => {
    const { client, deps, runner } = await setupHarness({
      model: 'kimi-k3',
      turnFiles: [jsonl(line.stepStart(), line.text('k3'), line.stepFinish({ input: 10, output: 2, reasoning: 0, read: 0 }))],
    });
    await runner('session-1', 'user-1', 'hi', deps, undefined);
    const command = client.detachedLaunchCalls[0]!.command;
    expect(command).toContain("--model 'opencode-go/kimi-k3'");
    expect(command).not.toContain('--variant');
  });

  it('starts a fresh session when the stored one is gone from the machine', async () => {
    const { client, userStorage, deps, runner, notifyAssistantResponse } = await setupHarness({
      opencodeSessionId: 'ses_gonegonegone',
      turnFiles: [[], jsonl(line.stepStart(), line.text('fresh start'), line.stepFinish({ input: 10, output: 2, reasoning: 0, read: 0 }))],
      turnExitCodes: [1, 0],
      turnStderrs: ['\u001b[91m\u001b[1mError: \u001b[0mSession not found\n', ''],
    });
    await runner('session-1', 'user-1', 'hello', deps, undefined);
    expect(client.detachedLaunchCalls).toHaveLength(2);
    expect(client.detachedLaunchCalls[0]!.command).toContain("--session 'ses_gonegonegone'");
    expect(client.detachedLaunchCalls[1]!.command).not.toContain('--session');
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'fresh start' }));
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-oc']?.conversation?.opencodeSessionId).toBe(SESSION);
  });

  it('ends at a Go limit with the model named and benches that model on the seat until its reset', async () => {
    const retryAt = Date.now() + 2 * 3_600_000;
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);
    const { deps, runner, releaseCredential } = await setupHarness({
      turnFiles: [jsonl(line.stepStart(), line.goLimit(retryAt))],
    });
    await expect(runner('session-1', 'user-1', 'hi', { ...deps, onHarnessUsageLimit }, undefined))
      .rejects.toThrow(modelLimitMessage('glm-5.3', new Date(retryAt)));
    expect(onHarnessUsageLimit).toHaveBeenCalledWith({ cli: 'opencode', resetAt: new Date(retryAt).toISOString() });
    const [credentialId, outcome] = releaseCredential.mock.calls[0]!;
    expect(credentialId).toBe('seat-oc');
    expect(outcome).toMatchObject({ kind: 'rate_limited', model: 'glm-5.3', modelOnly: true });
    // Benched until the window OpenCode named, plus the usual minute of slack.
    expect(outcome.retryAfterSeconds).toBeGreaterThan(2 * 3600 - 5);
    expect(outcome.retryAfterSeconds).toBeLessThan(2 * 3600 + 120);
  });

  it('says plainly that OpenCode refused the key, and tells the pool', async () => {
    const { deps, runner, releaseCredential } = await setupHarness({
      turnExitCodes: [1],
      turnFiles: [jsonl(line.stepStart(), line.error('Invalid credential', 401, '{"error":{"type":"server_error","message":"Invalid credential"}}'))],
    });
    await expect(runner('session-1', 'user-1', 'hi', deps, undefined)).rejects.toThrow(OPENCODE_KEY_REFUSED_MESSAGE);
    expect(releaseCredential).toHaveBeenCalledWith('seat-oc', expect.objectContaining({ kind: 'auth_failed' }));
  });

  it('routes an owner with no OpenCode seat into the sign-in door', async () => {
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);
    const { client, deps, runner } = await setupHarness({ lease: { kind: 'limbo', lease: null } });
    await runner('session-1', 'user-1', 'hi', { ...deps, onHarnessAuthFailure }, undefined);
    expect(onHarnessAuthFailure).toHaveBeenCalledWith({ cli: 'opencode', reason: 'no_seat' });
    expect(client.detachedLaunchCalls).toHaveLength(0);
  });

  it('says the no-seat message when there is no recovery handler', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({ lease: { kind: 'limbo', lease: null } });
    await runner('session-1', 'user-1', 'hi', deps, undefined);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: NO_SEAT_MESSAGE }));
    expect(client.detachedLaunchCalls).toHaveLength(0);
  });

  it('keeps the key out of what it reports when OpenCode echoes it', async () => {
    const { deps, runner } = await setupHarness({
      turnExitCodes: [1],
      turnFiles: [jsonl(line.stepStart(), line.error('Bad request using key sk-oc-test-key-123', 400))],
    });
    const failure = await runner('session-1', 'user-1', 'hi', deps, undefined).catch((error: Error) => error);
    expect(String(failure)).toContain('[REDACTED]');
    expect(String(failure)).not.toContain('sk-oc-test-key-123');
  });

  it('stall message names OpenCode', () => {
    expect(OPENCODE_TURN_STALLED_MESSAGE).toMatch(/^OpenCode went quiet/);
  });
});

describe('openCodeFailureOf', () => {
  it('reads a Go window as that model\'s, the free tier as the whole key\'s', () => {
    expect(openCodeFailureOf(line.goLimit(123) as never)).toMatchObject({ kind: 'limit', modelOnly: true, retryAt: 123 });
    expect(openCodeFailureOf(line.error('Free usage exceeded, subscribe to Go', 429, '{"type":"error","error":{"type":"FreeUsageLimitError"}}') as never))
      .toEqual({ kind: 'limit', message: 'Free usage exceeded, subscribe to Go' });
    expect(openCodeFailureOf(line.error('Usage limit', 429, '{"error":{"type":"GoUsageLimitError"}}') as never)).toMatchObject({ kind: 'limit', modelOnly: true });
    expect(openCodeFailureOf(line.error('Invalid credential', 401) as never)).toEqual({ kind: 'auth', message: 'Invalid credential' });
    expect(openCodeFailureOf(line.error('Provider is overloaded', 503) as never)).toEqual({ kind: 'error', message: 'Provider is overloaded' });
    expect(openCodeFailureOf(line.text('hi') as never)).toBeNull();
  });
});
