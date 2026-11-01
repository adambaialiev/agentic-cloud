import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import {
  CLAUDE_NOT_CONNECTED_MESSAGE,
  CLAUDE_PLATFORM_CAPACITY_MESSAGE,
  CLAUDE_PLATFORM_HICCUP_MESSAGE,
  CLAUDE_TURN_STALLED_MESSAGE,
  CLAUDE_WORKSPACE_UNAVAILABLE_MESSAGE,
  buildClaudeExecCommand,
  createClaudeHarnessRunner,
  dedicatedLimitMessage,
} from '../../agent/claude/claude-harness.js';
import { PROCESS_SHUTDOWN_ABORT_REASON } from '../../agent/abort-reason.js';
import {
  clearActiveDetachedTurn,
  getActiveDetachedTurn,
} from '../../agent/harness-turn-output.js';
import { modelLimitMessage, NO_SEAT_MESSAGE, paymentRequiredMessage } from '../../agent/platform-turn-policy.js';
import { InMemorySessionStorage } from '../../services/session-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { EventCapture } from '../helpers/event-capture.js';
import {
  FakeTurnOutputFiles,
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
  makeTerminalSnapshot,
} from '../mocks/fake-workspace-runtime-client.js';

const SESSION_ID = '02f545d2-f37f-46c1-bd93-bd720ce07ccd';

function jsonlLines(...events: object[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

async function setupHarness(options: {
  /** The CLI install running on the machine when the turn arrives. */
  cliInstallInFlight?: (sandboxId: string) => Promise<void> | undefined;
  claudeSessionId?: string;
  loggedIn?: boolean;
  /** Scripted turn-output files (JSONL lines), one per turn attempt. */
  turnFiles?: string[][];
  /** Per-attempt CLI exit codes (default 0 each). */
  turnExitCodes?: number[];
  /** Per-attempt stderr sidecar contents (error tails). */
  turnStderrs?: string[];
  /** Per-attempt polls to hold the turn open, so mid-turn behaviour can run. */
  keepRunningPolls?: number[];
  /** When set, secret storage holds this stored OAuth token. */
  oauthToken?: string;
  /** Provider profile state returned while classifying a failed runtime turn. */
  profileSubscriptionStatus?: string;
  model?: string;
  /** The subscription the agent was given (note #773). */
  seatId?: string;
  /** A window fill already on the agent's record, as the previous turn left it. */
  contextUsage?: { tokens: number; model?: string; at: string };
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
        'agent-claude': {
          id: 'agent-claude',
          name: 'Claude Code',
          cli: 'claude',
          createdAt: '2026-01-01T00:00:00.000Z',
          ...(options.model ? { model: options.model } : {}),
          ...(options.seatId ? { seatId: options.seatId } : {}),
          ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
        },
      },
    },
  });
  if (options.claudeSessionId) {
    await userStorage.updateTelegramHarnessConversation('user-1', {
      claudeSessionId: options.claudeSessionId,
    }, { agentId: 'agent-claude' });
  }

  const turnFiles = new FakeTurnOutputFiles(
    options.turnFiles ?? [], options.turnExitCodes ?? [], options.turnStderrs ?? [], options.keepRunningPolls ?? [],
  );
  client.execSyncHandler = (command) => turnFiles.answer(command)
    ?? (command.startsWith('if [ -f ')
      ? makeExecSyncResult({ stdout: 'running\n' })
      : command.includes('test -s')
      ? makeExecSyncResult({ stdout: options.loggedIn === false ? '' : 'CLAUDE_LOGGED_IN' })
      : makeExecSyncResult());

  const secretStorage = options.oauthToken
    ? {
      getSecretByKey: async () => ({ secretId: 's1', userId: 'user-1', key: 'claude-oauth-token', value: options.oauthToken }),
    } as unknown as AgentLoopDeps['secretStorage']
    : undefined;

  const deps = {
    sessionStorage,
    eventEmitter,
    toolExecutor: {} as AgentLoopDeps['toolExecutor'],
    aiModel: 'mock-model',
    notifyAssistantResponse,
    userStorage,
    // Every real caller pins the turn to the agent it was dispatched for.
    telegramTargetAgentId: 'agent-claude',
    ...(secretStorage ? { secretStorage } : {}),
  } as AgentLoopDeps;

  const runner = createClaudeHarnessRunner({
    sandboxClient: client,
    resolveDefaultSandboxId: async () => 'sb-1',
    ...(options.cliInstallInFlight ? { cliInstallInFlight: options.cliInstallInFlight } : {}),
    fetchImpl: vi.fn().mockImplementation(async () => (options.profileSubscriptionStatus
      ? new Response(JSON.stringify({
        organization: { subscription_status: options.profileSubscriptionStatus },
      }), { status: 200 })
      : new Response('unavailable', { status: 503 }))) as unknown as typeof fetch,
  });
  const events = new EventCapture().subscribe(eventEmitter, 'session-1');
  return { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse, events };
}

describe('claude harness runner — turn boundaries', () => {
  it('does not drain or inject messages while a turn is running, even with the retired env flag set', async () => {
    // A stale production setting must not silently restore streamed stdin.
    // The queued payload belongs to BackgroundRunner and becomes the next
    // turn after this process exits.
    vi.stubEnv('HARNESS_STREAM_INPUT', '1');
    try {
      const { client, deps, runner } = await setupHarness({
        turnFiles: [jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] }, session_id: SESSION_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
        )],
        // Hold the turn open for one poll, so the drain actually runs.
        keepRunningPolls: [1],
      });
      const drainQueuedMessages = vi.fn(() => [{ content: 'also the time?' }]);
      const queueMessage = vi.fn().mockReturnValue({ status: 'queued', queuePosition: 1 });

      await runner('session-1', 'user-1', 'start something slow', {
        ...deps,
        drainQueuedMessages,
        backgroundRunner: { isRunning: () => true, queueMessage },
      } as never, undefined);

      expect(drainQueuedMessages).not.toHaveBeenCalled();
      expect(queueMessage).not.toHaveBeenCalled();
      expect(client.detachedLaunchCalls[0]?.command).toContain("claude -p 'start something slow'");
      expect(client.detachedLaunchCalls[0]?.command).not.toContain('--input-format stream-json');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('claude harness runner', () => {
  it('starts the CLI only once an install of it in flight on the machine is done (2026-10-15)', async () => {
    // Iris's lost turn: the pre-sleep update was replacing the CLI when a
    // message arrived, and the turn ran into `claude: command not found`.
    let finish: () => void = () => {};
    const install = new Promise<void>((resolve) => { finish = resolve; });
    const asked: string[] = [];
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello there' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'hello there', session_id: SESSION_ID },
      )],
      cliInstallInFlight: (sandboxId) => { asked.push(sandboxId); return install; },
    });

    const turn = runner('session-1', 'user-1', 'hi claude', deps, undefined);
    await vi.waitFor(() => expect(asked).toEqual(['sb-1']));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(client.detachedLaunchCalls).toHaveLength(0);

    finish();
    await turn;
    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(client.detachedLaunchCalls[0]?.command).toContain('claude ');
  });

  it('runs a first turn: stores the session id and delivers assistant text without mirroring the transcript', async () => {
    const { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse, events } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            rate_limit_type: 'five_hour',
            utilization: 0.18,
            resets_at: 1_784_969_395,
          },
          session_id: SESSION_ID,
        },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello there' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'hello there', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'hi claude', deps, undefined);

    const startCall = client.detachedLaunchCalls[0];
    expect(startCall?.command).toContain('claude -p');
    expect(startCall?.command).toContain('--output-format stream-json');
    expect(startCall?.command).toContain('--permission-mode bypassPermissions');
    // An agent with no overrides runs the explicit CLI defaults, and the
    // effort default is `high` — outside the heavy band — since 2026-09-11.
    expect(startCall?.command).toContain("--model 'opus'");
    expect(startCall?.command).toContain("--effort 'high'");
    expect(startCall?.command).not.toContain('--resume');
    // stdout goes to the per-turn file; the PTY only supervises the process.
    expect(startCall?.command).toContain('{ claude -p');
    expect(startCall?.command).toMatch(/\} > '\/tmp\/infinite-agents-harness-turn-[0-9a-f-]+\.jsonl' < \/dev\/null 2> /);
    // Runs as the non-root agent user in its home, matching where sign-in happened.
    expect(startCall?.cwd).toBe('/home/agent');
    expect(startCall?.sshUser).toBe('agent');

    // The native Claude conversation on the VM owns the transcript; the
    // platform does not mirror it into session storage.
    expect(await sessionStorage.getHistory('user-1', 'session-1')).toEqual([]);
    expect(notifyAssistantResponse).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-1',
      content: 'hello there',
      source: 'claude-cli',
      model: 'claude-sonnet-5',
      // Unset overrides run as the explicit CLI defaults (opus · high).
      requestedModel: 'opus',
    });

    const session = await sessionStorage.getSession('user-1', 'session-1');
    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-claude']?.conversation?.claudeSessionId).toBe(SESSION_ID);
    expect(profile?.telegram?.providerUsage?.claude?.windows.five_hour).toEqual({
      id: 'five_hour',
      usedPercent: 18,
      resetsAt: 1_784_969_395,
    });
    expect(session?.status).toBe('completed');
    expect(events.getEventTypes()).toEqual(expect.arrayContaining(['agent_start', 'assistant_message', 'agent_complete']));
  });

  it('delivers the result summary when no assistant text streamed', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'summary only', session_id: SESSION_ID },
      )],
    });
    await runner('session-1', 'user-1', 'hi', deps, undefined);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'summary only' }));
  });

  it('resumes the stored session and skips the auth pre-check', async () => {
    const { client, deps, runner } = await setupHarness({
      claudeSessionId: SESSION_ID,
      turnFiles: [jsonlLines(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'resumed' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'resumed', session_id: SESSION_ID },
      )],
    });
    await runner('session-1', 'user-1', 'again', deps, undefined);
    expect(client.detachedLaunchCalls[0]?.command).toContain(`--resume '${SESSION_ID}'`);
    expect(client.execSyncCalls.filter((c) => c.command.includes('test -s'))).toEqual([]);
  });

  it('starts fresh after New chat even when a stale legacy session id remains', async () => {
    const NEW_ID = '11111111-2222-3333-4444-555555555555';
    const { client, sessionStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: NEW_ID },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] }, session_id: NEW_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'fresh', session_id: NEW_ID },
      )],
    });
    // Per-agent New chat has removed the agent pointer, while an old deployment
    // may still have left its pre-fleet fallback on the shared session record.
    await sessionStorage.updateSession('user-1', 'session-1', { claudeSessionId: SESSION_ID });

    await runner('session-1', 'user-1', 'start over', deps, undefined);

    expect(client.detachedLaunchCalls[0]?.command).not.toContain('--resume');
  });

  it('falls back to a fresh session when the stored session is missing', async () => {
    const NEW_ID = '11111111-2222-3333-4444-555555555555';
    const { client, sessionStorage, userStorage, deps, runner } = await setupHarness({
      claudeSessionId: SESSION_ID,
      // Resume attempt dies with the missing-session error; the retry succeeds.
      turnExitCodes: [1, 0],
      turnStderrs: ['No conversation found with session ID', ''],
      turnFiles: [
        [],
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: NEW_ID },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'recovered' }] }, session_id: NEW_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'recovered', session_id: NEW_ID },
        ),
      ],
    });
    await runner('session-1', 'user-1', 'hi again', deps, undefined);
    expect(client.detachedLaunchCalls).toHaveLength(2);
    expect(client.detachedLaunchCalls[0]?.command).toContain(`--resume '${SESSION_ID}'`);
    expect(client.detachedLaunchCalls[1]?.command).not.toContain('--resume');
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']?.conversation?.claudeSessionId).toBe(NEW_ID);
  });

  it('delivers a workspace-unavailable message when the sandbox cannot be provisioned', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const sessionStorage = new InMemorySessionStorage();
    const eventEmitter = new AgentEventEmitter();
    const notifyAssistantResponse = vi.fn().mockResolvedValue(undefined);
    await sessionStorage.createSession('session-1', 'user-1'); // no sandboxId

    const deps = {
      sessionStorage,
      eventEmitter,
      toolExecutor: {} as AgentLoopDeps['toolExecutor'],
      aiModel: 'mock-model',
      notifyAssistantResponse,
    } as AgentLoopDeps;

    const runner = createClaudeHarnessRunner({
      sandboxClient: client,
      resolveDefaultSandboxId: async () => { throw new Error('Usage limit reached'); },
    });

    await runner('session-1', 'user-1', 'hi', deps, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: CLAUDE_WORKSPACE_UNAVAILABLE_MESSAGE,
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('points the user at /harness when Claude is not connected', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({ loggedIn: false });
    await runner('session-1', 'user-1', 'hi', deps, undefined);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: CLAUDE_NOT_CONNECTED_MESSAGE }));
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('hands a dead sign-in to the recovery handler instead of the generic not-connected text', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({ loggedIn: false });
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);
    await runner('session-1', 'user-1', 'hi', { ...deps, onHarnessAuthFailure }, undefined);
    expect(onHarnessAuthFailure).toHaveBeenCalledWith({ cli: 'claude' });
    // The handler owns the user-facing message — no contradictory default.
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('injects the stored OAuth token into the turn command and skips the SSH auth pre-check', async () => {
    const TOKEN = 'sk-ant-oat01-stored-token';
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
      oauthToken: TOKEN,
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'authed' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'authed', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'hi', deps, undefined);

    expect(client.detachedLaunchCalls[0]?.command).toContain(`CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}' claude -p`);
    // The stored token is the credential; no credentials-file probe needed.
    expect(client.execSyncCalls.filter((c) => c.command.includes('test -s'))).toEqual([]);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'authed' }));
  });

  it('surfaces a result error as a thrown turn failure', async () => {
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: SESSION_ID },
      )],
    });
    await expect(runner('session-1', 'user-1', 'hi', deps, undefined)).rejects.toThrow(/Claude turn failed: boom/);
  });

  it('redacts the OAuth token from terminal failure output', async () => {
    const token = 'sk-ant-oat01-sensitive-token-value-1234567890';
    const { client, deps, runner } = await setupHarness({
      oauthToken: token,
      turnExitCodes: [1],
      turnStderrs: [`CLAUDE_CODE_OAUTH_TOKEN='${token}' permission denied`],
    });
    client.terminalStartResult = makeTerminalSnapshot({
      sessionId: 'turn-terminal',
      status: 'exited',
      exitCode: 1,
      output: [`CLAUDE_CODE_OAUTH_TOKEN='${token}' permission denied`],
    });

    const error = await runner('session-1', 'user-1', 'hi', deps, undefined)
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(token);
  });

  it('kills an aborted first turn, captures its native session id, and suppresses stale output', async () => {
    const {
      client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse,
    } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        {
          type: 'assistant',
          message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'stale answer' }] },
          session_id: SESSION_ID,
        },
      )],
    });
    const abort = new AbortController();
    const answer = client.execSyncHandler;
    client.execSyncHandler = (command) => {
      const result = answer(command);
      if (command.includes('nohup setsid')) abort.abort();
      return result;
    };

    await runner('session-1', 'user-1', 'hi', deps, abort.signal);

    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('interrupted');
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']
      ?.conversation?.claudeSessionId).toBe(SESSION_ID);
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(true);
  });

  it('does not deliver a batch whose output poll races with steering', async () => {
    const {
      client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse,
    } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        {
          type: 'assistant',
          message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'stale raced answer' }] },
          session_id: SESSION_ID,
        },
      )],
    });
    const abort = new AbortController();
    const answer = client.execSyncHandler;
    let abortedDuringPoll = false;
    client.execSyncHandler = (command) => {
      if (!abortedDuringPoll && command.startsWith('tail -n +')) {
        abortedDuringPoll = true;
        abort.abort();
      }
      return answer(command);
    };

    await runner('session-1', 'user-1', 'old direction', deps, abort.signal);

    expect(abortedDuringPoll).toBe(true);
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']
      ?.conversation?.claudeSessionId).toBe(SESSION_ID);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('interrupted');
  });

  it('does not launch a fresh CLI when steering arrived during preflight', async () => {
    const { client, sessionStorage, deps, runner } = await setupHarness();
    const abort = new AbortController();
    abort.abort();

    await runner('session-1', 'user-1', 'superseded direction', deps, abort.signal);

    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('interrupted');
  });

  it('checkpoints a provisional launch marker before the SSH PID reply arrives', async () => {
    const runKey = 'session-1::agent:agent-claude';
    const { client, deps, runner } = await setupHarness();
    const abort = new AbortController();
    const originalExecSync = client.execSync.bind(client);
    let releaseLaunch!: (value: ReturnType<typeof makeExecSyncResult>) => void;
    const launchReply = new Promise<ReturnType<typeof makeExecSyncResult>>((resolve) => {
      releaseLaunch = resolve;
    });
    client.execSync = async (sandboxId, command, cwd, options) => {
      if (command.includes('nohup setsid')) {
        client.execSyncCalls.push({ sandboxId, command, cwd, sshUser: options?.sshUser });
        return launchReply;
      }
      return originalExecSync(sandboxId, command, cwd, options);
    };

    try {
      const completion = runner('session-1', 'user-1', 'hi', deps, abort.signal);
      await vi.waitFor(() => {
        expect(getActiveDetachedTurn(runKey)).toEqual(expect.objectContaining({
          cli: 'claude', sandboxId: 'sb-1', pid: 0,
        }));
      });
      abort.abort(PROCESS_SHUTDOWN_ABORT_REASON);
      releaseLaunch(makeExecSyncResult({ stdout: '4242\n' }));
      await completion;

      expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(false);
      expect(getActiveDetachedTurn(runKey)).toEqual(expect.objectContaining({ pid: 4242 }));
    } finally {
      clearActiveDetachedTurn(runKey);
    }
  });

  it('leaves a detached turn reattachable only for a process-shutdown abort', async () => {
    const runKey = 'session-1::agent:agent-claude';
    const { client, deps, runner } = await setupHarness();
    const abort = new AbortController();
    const answer = client.execSyncHandler;
    client.execSyncHandler = (command) => {
      const result = answer(command);
      if (command.includes('nohup setsid')) abort.abort(PROCESS_SHUTDOWN_ABORT_REASON);
      return result;
    };

    try {
      await runner('session-1', 'user-1', 'hi', deps, abort.signal);

      expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(false);
      expect(getActiveDetachedTurn(runKey)).toEqual(expect.objectContaining({
        cli: 'claude',
        sandboxId: 'sb-1',
      }));
    } finally {
      clearActiveDetachedTurn(runKey);
    }
  });

  it('kills a cleanup-only checkpoint without launching replacement work', async () => {
    const { client, sessionStorage, deps, runner } = await setupHarness();

    await runner('session-1', 'user-1', {
      content: '',
      harnessTermination: {
        cli: 'claude', sandboxId: 'sb-1', outputPath: '/tmp/orphan-claude.jsonl', pid: 4242,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(true);
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('interrupted');
  });

  it('captures an orphaned first-turn session id before launching its correction', async () => {
    const { client, userStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines({ type: 'system', subtype: 'init', session_id: SESSION_ID })],
    });

    await runner('session-1', 'user-1', {
      content: 'saved correction',
      harnessTermination: {
        cli: 'claude', sandboxId: 'sb-1', outputPath: '/tmp/orphan-claude.jsonl', pid: 4242,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(client.detachedLaunchCalls[0]?.command).toContain(`--resume '${SESSION_ID}'`);
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']
      ?.conversation?.claudeSessionId).toBe(SESSION_ID);
  });

  // There is no wall-clock cap on a turn — a healthy run may go for hours.
  // The one thing that kills a turn is silence: a CLI that stops emitting
  // stream events for 15 minutes is wedged (its longest legal tool call is
  // 10), and the kill message must say the conversation survives.
  it('kills a turn for silence, not length: 15 quiet minutes ends it resumably', async () => {
    vi.useFakeTimers();
    try {
      const { client, deps, runner } = await setupHarness();
      // A CLI that launched fine and then never writes a single event: every
      // status poll reports running with no new lines, forever.
      const inner = client.execSyncHandler;
      client.execSyncHandler = (command) => (command.startsWith('tail -n +')
        ? makeExecSyncResult({ stdout: '', stderr: '__RUNNING__\n' })
        : inner(command));

      const outcome = runner('session-1', 'user-1', 'hi', deps, undefined)
        .then(() => null, (caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(16 * 60_000);

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(CLAUDE_TURN_STALLED_MESSAGE);
      // The wedged process group was killed on the machine.
      expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a healthy turn run past the old 30-minute mark as long as it streams', async () => {
    vi.useFakeTimers();
    try {
      const { client, sessionStorage, deps, runner, notifyAssistantResponse } = await setupHarness();
      const tick = JSON.stringify({ type: 'system', subtype: 'tick', session_id: SESSION_ID });
      const done = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'survived', session_id: SESSION_ID });
      // One new stream event per 2.5s poll for ~31 minutes of steady work,
      // then a clean success — under the old wall-clock cap this turn died.
      const TOTAL_TICKS = 750;
      let ticksServed = 0;
      const inner = client.execSyncHandler;
      client.execSyncHandler = (command) => {
        const match = /^tail -n \+(\d+) '/.exec(command);
        if (match && command.includes(".exit'")) {
          const from = Number(match[1]) - 1;
          const finished = ticksServed >= TOTAL_TICKS;
          const all = [...Array<string>(ticksServed).fill(tick), ...(finished ? [done] : [])];
          if (!finished) ticksServed += 1;
          return makeExecSyncResult({
            stdout: all.slice(from).map((line) => `${line}\n`).join(''),
            stderr: finished ? '0\n' : '__RUNNING__\n',
          });
        }
        return inner(command);
      };

      const outcome = runner('session-1', 'user-1', 'hi', deps, undefined);
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      await outcome;

      expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'survived' }));
      expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-attaches to a turn that survived a restart: no relaunch, only undelivered messages sent', async () => {
    const OUT = '/tmp/infinite-agents-harness-turn-attach-test.jsonl';
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
      claudeSessionId: SESSION_ID,
      // The full turn file as it exists ON THE MACHINE: init + two assistant
      // messages + result. Pre-restart, the first 2 lines were consumed and
      // message #1 delivered.
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'first half' }] }, session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'second half' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'second half', session_id: SESSION_ID },
      )],
      // A legacy streamed turn remains alive until its input keeper closes.
      keepRunningPolls: [1],
    });
    const drainQueuedMessages = vi.fn(() => [{ content: 'belongs to the next turn' }]);
    deps.drainQueuedMessages = drainQueuedMessages;
    const inner = client.execSyncHandler;
    client.execSyncHandler = (command) => {
      if (command.startsWith('if [ -f ')) {
        return makeExecSyncResult({ stdout: 'running\n' });
      }
      return inner(command);
    };

    await runner('session-1', 'user-1', {
      content: 'resumed payload (fallback only)',
      harnessAttach: {
        cli: 'claude',
        sandboxId: 'sb-1',
        outputPath: OUT,
        inputPath: '/tmp/infinite-agents-harness-turn-attach-test.input',
        pid: 777,
        consumedLines: 2,
        deliveredMessageCount: 1,
        // The backend may restart long after this CLI began. Reattach gets a
        // fresh quiet window; the original wall clock must not kill it before
        // its first recovered poll.
        turnStartedAt: Date.now() - 60 * 60_000,
      },
    }, deps, undefined);

    // No new CLI launch — the surviving process's stream was continued…
    expect(client.detachedLaunchCalls).toEqual([]);
    // …and only the message the user hadn't received yet was delivered.
    expect(notifyAssistantResponse).toHaveBeenCalledTimes(1);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'second half' }));
    // Rolling-deploy migration: close the old FIFO after its result, but do
    // not feed it newly queued work.
    expect(drainQueuedMessages).not.toHaveBeenCalled();
    expect(client.execSyncCalls.some((call) => (
      call.command.includes("kill \"$(cat '/tmp/infinite-agents-harness-turn-attach-test.input.keeper'")
    ))).toBe(true);
  });

  it('does not relaunch when the first reattach probe fails transiently', async () => {
    vi.useFakeTimers();
    try {
      const outputPath = '/tmp/transient-claude-attach.jsonl';
      const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
        loggedIn: false,
        turnFiles: [jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'survived' }] }, session_id: SESSION_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'survived', session_id: SESSION_ID },
        )],
      });
      const answer = client.execSyncHandler;
      let probes = 0;
      client.execSyncHandler = (command) => {
        if (command.startsWith('if [ -f ')) {
          probes += 1;
          if (probes === 1) throw new Error('machine waking');
          return makeExecSyncResult({ stdout: 'finished\n' });
        }
        return answer(command);
      };

      const completion = runner('session-1', 'user-1', {
        content: 'fallback only',
        harnessAttach: {
          cli: 'claude', sandboxId: 'sb-old', outputPath, pid: 777,
          consumedLines: 1, deliveredMessageCount: 0,
        },
      }, { ...deps, telegramTargetSandboxId: 'sb-new' }, undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await completion;

      expect(probes).toBe(2);
      expect(client.detachedLaunchCalls).toEqual([]);
      expect(client.execSyncCalls.some((call) => call.command.includes('test -s'))).toBe(false);
      expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'survived' }));
      expect(client.execSyncCalls.filter((call) => (
        call.command.startsWith('if [ -f ') || call.command.startsWith('tail -n +')
      )).every((call) => call.sandboxId === 'sb-old')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live recovery attached when running-status bookkeeping fails', async () => {
    const outputPath = '/tmp/claude-live-attach-preflight-failure.jsonl';
    const runKey = 'session-1::agent:agent-claude';
    const { client, deps, runner, sessionStorage } = await setupHarness({
      claudeSessionId: SESSION_ID,
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
      )],
    });
    const answer = client.execSyncHandler;
    client.execSyncHandler = (command) => command.startsWith('if [ -f ')
      ? makeExecSyncResult({ stdout: 'running:777\n' })
      : answer(command);

    const updateSession = sessionStorage.updateSession.bind(sessionStorage);
    vi.spyOn(sessionStorage, 'updateSession').mockImplementation(async (userId, sessionId, updates) => {
      if (updates.status === 'running') throw new Error('status storage unavailable');
      return updateSession(userId, sessionId, updates);
    });
    const acknowledge = vi.fn().mockResolvedValue(true);
    deps.acknowledgeHarnessRecovery = acknowledge;
    deps.backgroundRunner = { completeHarnessTerminationRecovery: vi.fn() } as AgentLoopDeps['backgroundRunner'];

    await expect(runner('session-1', 'user-1', {
      content: 'fallback only',
      harnessAttach: {
        cli: 'claude', sandboxId: 'sb-1', outputPath, pid: 777,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined)).resolves.toBeUndefined();

    expect(client.detachedLaunchCalls).toEqual([]);
    expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM -- -777'))).toBe(false);
    expect(getActiveDetachedTurn(runKey)).toBeUndefined();
    expect(acknowledge).toHaveBeenCalledWith(undefined);
    expect(deps.backgroundRunner?.completeHarnessTerminationRecovery).toHaveBeenCalledWith(runKey);
  });

  it('hydrates a boot-time pid=0 marker before acknowledging reattach', async () => {
    const outputPath = '/tmp/provisional-claude-attach.jsonl';
    const runKey = 'session-1::agent:agent-claude';
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
      )],
    });
    const answer = client.execSyncHandler;
    client.execSyncHandler = (command) => command.startsWith('if [ -f ')
      ? makeExecSyncResult({ stdout: 'running:4242\n' })
      : answer(command);
    const acknowledge = vi.fn(async () => {
      expect(getActiveDetachedTurn(runKey)).toEqual(expect.objectContaining({ pid: 4242 }));
      return true;
    });
    deps.acknowledgeHarnessRecovery = acknowledge;
    deps.backgroundRunner = { completeHarnessTerminationRecovery: vi.fn() } as AgentLoopDeps['backgroundRunner'];

    await runner('session-1', 'user-1', {
      content: 'fallback only',
      harnessAttach: {
        cli: 'claude', sandboxId: 'sb-1', outputPath, pid: 0,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('ATTACH: lines become native file uploads: text delivered stripped, bytes sent after', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Here is your report!\n\nATTACH: /home/agent/out/report.pdf' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
      )],
    });
    const sendUserFile = vi.fn().mockResolvedValue(undefined);
    deps.sendUserFile = sendUserFile;
    const inner = client.execSyncHandler;
    client.execSyncHandler = (command) => {
      if (command.startsWith('wc -c')) return makeExecSyncResult({ stdout: '9\n' });
      if (command.startsWith('base64 <')) return makeExecSyncResult({ stdout: Buffer.from('pdf bytes').toString('base64') });
      return inner(command);
    };

    await runner('session-1', 'user-1', 'make me a report', deps, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Here is your report!',
    }));
    expect(sendUserFile).toHaveBeenCalledTimes(1);
    const sent = sendUserFile.mock.calls[0][0] as { fileName: string; content: Uint8Array };
    expect(sent.fileName).toBe('report.pdf');
    expect(Buffer.from(sent.content).toString()).toBe('pdf bytes');
  });

  it('stages user attachments into ~/inbox and hands the CLI their paths in the prompt', async () => {
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'got it' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'got it', session_id: SESSION_ID },
      )],
    });
    deps.mediaStorage = {
      uploadObject: vi.fn(),
      createReadAccess: vi.fn().mockResolvedValue({ url: 'https://signed.example/report' }),
    } as unknown as AgentLoopDeps['mediaStorage'];

    await runner('session-1', 'user-1', {
      content: 'summarize this',
      attachments: [{
        fileId: 'file_1_abc',
        url: '',
        storagePath: 'users/user-1/sessions/session-1/file_1_abc/report.csv',
        fileName: 'file_1_abc.csv',
        displayName: 'report.csv',
        contentType: 'text/csv',
        mediaKind: 'document',
        renderAs: 'document',
        sizeBytes: 2_048,
        visibility: 'session',
        source: 'user_input',
        use: 'sandbox_input',
      }],
    }, deps, undefined);

    // The staging exec ran on the agent's machine as the harness user...
    const stagingCall = client.execSyncCalls.find((call) => call.command.includes('PATCH_TOOL_PAYLOAD_B64='));
    expect(stagingCall).toBeDefined();
    expect(stagingCall?.sshUser).toBe('agent');
    // ...and the CLI prompt carries both the user text and the inbox path.
    const dateDir = new Date().toISOString().slice(0, 10);
    const startCall = client.detachedLaunchCalls[0];
    expect(startCall?.command).toContain('summarize this');
    expect(startCall?.command).toContain(`/home/agent/inbox/${dateDir}/report.csv`);
  });

});

describe('claude harness runner — the context reading', () => {
  /**
   * Note #8. The measurement has to land on the AGENT: the agents of one
   * account share a session document and are told apart by run key, so a
   * session-scoped field would be six agents overwriting one number.
   */
  it('stores the last request’s window fill on the agent that ran the turn', async () => {
    const { userStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        // Two requests in one turn. The LAST one is the conversation's size;
        // summing them would report 640k for a 400k conversation.
        {
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5-20260320',
            content: [{ type: 'text', text: 'thinking' }],
            usage: { input_tokens: 8_000, cache_read_input_tokens: 232_000, output_tokens: 300 },
          },
          session_id: SESSION_ID,
        },
        {
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5-20260320',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 12_000, cache_read_input_tokens: 388_000, output_tokens: 400 },
          },
          session_id: SESSION_ID,
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'hi claude', deps, undefined);

    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-claude']?.contextUsage).toMatchObject({
      tokens: 400_000,
      model: 'claude-sonnet-5-20260320',
    });
  });

  /**
   * The token ledger. Claude Code's `result` reports a per-model RUNNING
   * TOTAL for the conversation, so each turn is credited the difference —
   * which is also the only place the helper agents a turn starts are counted.
   */
  it('credits each turn the difference in the conversation’s running total, helper agents included', async () => {
    const turn = (text: string, usage: object, modelUsage: object) => jsonlLines(
      { type: 'system', subtype: 'init', session_id: SESSION_ID },
      {
        type: 'assistant',
        // As the stream really carries it: the request's FIRST output count.
        message: { id: `msg_${text}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 6, output_tokens: 2 } },
        session_id: SESSION_ID,
      },
      { type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION_ID, usage, modelUsage },
    );
    const { userStorage, deps, runner } = await setupHarness({
      turnFiles: [
        turn('one',
          { input_tokens: 6, output_tokens: 400, cache_read_input_tokens: 90_000 },
          { 'claude-opus-5-5': { inputTokens: 6, outputTokens: 400, cacheReadInputTokens: 90_000, cacheCreationInputTokens: 0 } }),
        // The second run: the total has grown, and a Haiku helper appears.
        turn('two',
          { input_tokens: 4, output_tokens: 250, cache_read_input_tokens: 110_000 },
          {
            'claude-opus-5-5': { inputTokens: 10, outputTokens: 650, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 0 },
            'claude-haiku-5-5': { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 25_900 },
          }),
      ],
    });
    const ledger = new InMemoryAgentTokenLedger();
    deps.agentTokenLedger = ledger;
    const outputs = () => Object.fromEntries(ledger.userDays('user-1', '2000-01-01').map((row) => [row.model, row.output]));

    await runner('session-1', 'user-1', 'first', deps, undefined);
    expect(outputs()).toEqual({ 'claude-opus-5-5': 400 });

    await runner('session-1', 'user-1', 'second', deps, undefined);
    // 400 + 250 — not 400 + 650 — and the helper under its own model.
    expect(outputs()).toEqual({ 'claude-opus-5-5': 650, 'claude-haiku-5-5': 4 });
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']?.claudeTokenBase)
      .toMatchObject({ sessionId: SESSION_ID, models: { 'claude-opus-5-5': { output: 650 } } });
  });

  /**
   * The other half of note #8: the number is no use to the user on a screen
   * the AGENT cannot see. It rides the prompt — the only channel that carries
   * a per-turn value — and says when it was true.
   */
  it('tells the agent how full its window was, after the user\u2019s own message', async () => {
    const { client, deps, runner } = await setupHarness({
      contextUsage: { tokens: 402_000, model: 'claude-opus-5', at: '2026-08-17T10:00:00.000Z' },
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'what were we doing?', deps, undefined);

    const command = client.detachedLaunchCalls[0]?.command ?? '';
    expect(command).toContain('about 40% full');
    expect(command).toContain('402k of 1M tokens');
    // The user's words lead; the platform speaks over their shoulder, after.
    expect(command.indexOf('what were we doing?')).toBeLessThan(command.indexOf('Context window'));
  });

  it('tells the agent once, on its next turn, that the Workspace Agent changed what it runs on (note #776), and clears the mark', async () => {
    const turn = () => jsonlLines(
      { type: 'system', subtype: 'init', session_id: SESSION_ID },
      { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }] }, session_id: SESSION_ID },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID },
    );
    const { client, userStorage, deps, runner } = await setupHarness({ model: 'sonnet', turnFiles: [turn(), turn()] });
    await userStorage.updateAgentFields('user-1', 'agent-claude', { runtimeChange: { by: 'workspace-agent', at: '2026-10-18T09:00:00.000Z' } });

    await runner('session-1', 'user-1', 'carry on', deps, undefined);

    const command = client.detachedLaunchCalls[0]?.command ?? '';
    expect(command).toContain('Since your last turn the Workspace Agent changed what you run on');
    expect(command).toContain('this turn runs on sonnet at high effort.');
    expect(command.indexOf('carry on')).toBeLessThan(command.indexOf('Since your last turn'));
    await vi.waitFor(async () => expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-claude']?.runtimeChange).toBeUndefined());

    await runner('session-1', 'user-1', 'and again', deps, undefined);
    expect(client.detachedLaunchCalls[1]?.command ?? '').not.toContain('Since your last turn');
  });

  it('says nothing about the window on a fresh chat', async () => {
    // `agentbuilt chat new` clears the field, and an agent told "0% full"
    // would believe it. No reading, no sentence.
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'first message', deps, undefined);

    expect(client.detachedLaunchCalls[0]?.command ?? '').not.toContain('Context window');
  });

  it('says nothing when the stored model has no known window', async () => {
    const { client, deps, runner } = await setupHarness({
      contextUsage: { tokens: 402_000, model: 'someone/else-4', at: '2026-08-17T10:00:00.000Z' },
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] }, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'hello', deps, undefined);

    expect(client.detachedLaunchCalls[0]?.command ?? '').not.toContain('Context window');
  });

  it('writes nothing when the stream reported no usable size', async () => {
    // A turn that never reached the API reports all zeros. Storing that would
    // redraw a nearly-full window as empty, which is worse than no reading.
    const { userStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        {
          type: 'assistant',
          message: {
            model: '<synthetic>',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
          },
          session_id: SESSION_ID,
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: SESSION_ID },
      )],
    });

    await runner('session-1', 'user-1', 'hi claude', deps, undefined);

    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-claude']?.contextUsage).toBeUndefined();
  });
});

describe('claude harness runner — the seat gate', () => {
  // A turn whose owner has no seat has nothing to run on (org-layer-design:
  // "not a customer" is now "owner has no live seat"). No profile field
  // decides admission — the LEASE answers, and a limbo resolution with
  // nothing to lease is that answer, because a member's seats always answer
  // dedicated/exhausted and the shared pool retired with the org cutover.
  function poolStub() {
    return {
      leaseForUser: vi.fn().mockResolvedValue({ kind: 'limbo', lease: null }),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];
  }

  it('refuses a turn whose owner has no seat, spending nothing to say so', async () => {
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness();
    const platformCredentialPool = poolStub();

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool,
    }, undefined);

    const [{ content }] = notifyAssistantResponse.mock.calls.at(-1)!;
    expect(content).toContain(NO_SEAT_MESSAGE);
    // The lease is what answered — and no CLI was launched to say no.
    expect((platformCredentialPool as unknown as { leaseForUser: ReturnType<typeof vi.fn> }).leaseForUser)
      .toHaveBeenCalled();
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('stands down where there is no pool at all (dev, self-hosted)', async () => {
    const { deps, runner, notifyAssistantResponse } = await setupHarness();
    await runner('session-1', 'user-1', 'hi', deps, undefined);

    expect(notifyAssistantResponse).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(NO_SEAT_MESSAGE),
    }));
  });

  // With a recovery handler wired (Telegram), no-seat is a DOOR, not a dead
  // end: the handler pauses the owner's agents and routes their next message
  // into the seat sign-in ceremony (workstream 2), and it owns the
  // user-facing message — the harness saying NO_SEAT_MESSAGE too would
  // contradict the walk-through it announces.
  it('routes a seatless owner into sign-in when the recovery handler is wired', async () => {
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness();
    const platformCredentialPool = poolStub();
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool, onHarnessAuthFailure,
    }, undefined);

    expect(onHarnessAuthFailure).toHaveBeenCalledWith({ cli: 'claude', reason: 'no_seat' });
    expect(notifyAssistantResponse).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(NO_SEAT_MESSAGE),
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('keeps transient lease failures as capacity, never the sign-in door', async () => {
    const { deps, runner } = await setupHarness();
    // An ERROR resolution (not limbo-with-nothing): the pool threw.
    const platformCredentialPool = {
      leaseForUser: vi.fn().mockRejectedValue(new Error('storage hiccup')),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool, onHarnessAuthFailure,
    }, undefined);

    expect(onHarnessAuthFailure).not.toHaveBeenCalled();
  });
});

describe('buildClaudeExecCommand', () => {
  it('builds a base print command with bypass permissions', () => {
    const command = buildClaudeExecCommand({ prompt: 'go' });
    expect(command).toBe(
      "claude -p 'go' --output-format stream-json --verbose --permission-mode bypassPermissions",
    );
  });

  it('adds --resume for continued sessions', () => {
    expect(buildClaudeExecCommand({ prompt: 'go', resumeSessionId: SESSION_ID }))
      .toContain(`--resume '${SESSION_ID}'`);
  });

  it('pins an explicit model for first and resumed sessions', () => {
    expect(buildClaudeExecCommand({ prompt: 'go', model: 'fable' }))
      .toContain("--model 'fable'");
    expect(buildClaudeExecCommand({ prompt: 'go', resumeSessionId: SESSION_ID, model: 'fable' }))
      .toContain("--model 'fable'");
  });

  it('prefixes the OAuth token env assignment when a token is provided', () => {
    expect(buildClaudeExecCommand({ prompt: 'go', oauthToken: 'sk-ant-oat01-abc' }))
      .toBe("CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-abc' claude -p 'go' --output-format stream-json --verbose --permission-mode bypassPermissions");
  });

  it('appends --effort when a reasoning effort is set, for first and resumed turns', () => {
    expect(buildClaudeExecCommand({ prompt: 'go', effort: 'xhigh' }))
      .toContain("--effort 'xhigh'");
    expect(buildClaudeExecCommand({ prompt: 'go', resumeSessionId: SESSION_ID, effort: 'xhigh' }))
      .toContain("--effort 'xhigh'");
  });

  it('omits --effort when no reasoning effort is set', () => {
    expect(buildClaudeExecCommand({ prompt: 'go', model: 'fable' }))
      .not.toContain('--effort');
  });

});

describe('claude harness runner — dedicated credentials and limbo', () => {
  const LEASE = { credentialId: 'cred-1', token: 'sk-ant-oat01-pool-token' };

  function poolStub(lease: unknown) {
    return {
      leaseForUser: vi.fn().mockResolvedValue(lease),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];
  }

  async function paidSetup(options: { model?: string; withTurn?: boolean } = {}) {
    return setupHarness({
      ...(options.model ? { model: options.model } : {}),
      ...(options.withTurn
        ? {
          turnFiles: [jsonlLines(
            { type: 'system', subtype: 'init', session_id: SESSION_ID },
            { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }] }, session_id: SESSION_ID },
            { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
          )],
        }
        : {}),
    });
  }

  it('runs Fable on a seat lease — the seat\'s own subscription is the model gate now', async () => {
    // The rung gate retired with the pricing ladder (org-layer-design): what
    // a seat may run is its subscription\'s business, and a refusal comes
    // back as a runtime outcome like everyone else\'s.
    const { client, deps, runner } = await paidSetup({ model: 'fable', withTurn: true });
    const pool = poolStub({ kind: 'dedicated', lease: LEASE });

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined);

    expect(client.detachedLaunchCalls.length).toBeGreaterThan(0);
    expect((pool as unknown as { releaseCredential: ReturnType<typeof vi.fn> }).releaseCredential)
      .toHaveBeenCalledWith('cred-1', expect.objectContaining({ kind: 'ok' }));
  });

  it('lets a limbo turn with a real lease through to the CLI (legacy pool rows)', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await paidSetup({ model: 'opus', withTurn: true });
    const pool = poolStub({ kind: 'limbo', lease: LEASE });

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined);

    // No refusal — the turn reached the CLI launch with the pooled token.
    expect(notifyAssistantResponse).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(NO_SEAT_MESSAGE),
    }));
    expect(client.detachedLaunchCalls.length).toBeGreaterThan(0);
  });

  it("answers a cooling dedicated credential with the subscription's own reset, not a retry", async () => {
    const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await paidSetup({});
    const pool = poolStub({ kind: 'dedicated_exhausted', resetAt });
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool, onHarnessUsageLimit,
    }, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: dedicatedLimitMessage(new Date(Date.parse(resetAt))),
    }));
    // Nothing launched and nothing released — no lease was granted.
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((pool as unknown as { releaseCredential: ReturnType<typeof vi.fn> }).releaseCredential)
      .not.toHaveBeenCalled();
    expect(onHarnessUsageLimit).toHaveBeenCalledWith({ cli: 'claude', resetAt });
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('reports a dedicated subscription limit discovered during the CLI turn', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 2 * 3_600;
    const { deps, runner } = await setupHarness({
      turnExitCodes: [1],
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        {
          type: 'rate_limit_event',
          rate_limit_info: { rate_limit_type: 'five_hour', utilization: 1, resets_at: resetSeconds },
          session_id: SESSION_ID,
        },
        {
          type: 'result', subtype: 'error_during_execution', is_error: true,
          result: "You've reached your usage limit.", session_id: SESSION_ID,
        },
      )],
    });
    const pool = poolStub({ kind: 'dedicated', lease: LEASE });
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);

    await expect(runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool, onHarnessUsageLimit,
    }, undefined)).rejects.toThrow(dedicatedLimitMessage(new Date(resetSeconds * 1000)));

    expect(onHarnessUsageLimit).toHaveBeenCalledWith({
      cli: 'claude', resetAt: new Date(resetSeconds * 1000).toISOString(),
    });
    expect((pool as unknown as { releaseCredential: ReturnType<typeof vi.fn> }).releaseCredential)
      .toHaveBeenCalledWith('cred-1', expect.objectContaining({ kind: 'rate_limited' }));
  });

  // Adam's Demonstrations workplace, 2026-10-17 (note #772): the new seat ran
  // Fable only on usage credits, the old one had spent its Fable week, and
  // every "resume" died on the CLI's raw line with no seat ever benched.
  const FABLE_CREDITS_OUT = "You're out of usage credits. Switch to another model to continue.";
  const FABLE_WEEK_OUT = "You've reached your Fable limit. Switch to another model to continue.";
  function limitTurn(text: string) {
    return jsonlLines(
      { type: 'system', subtype: 'init', session_id: SESSION_ID },
      {
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text }] },
        error: 'rate_limit',
        is_api_error_message: true,
        session_id: SESSION_ID,
      },
      { type: 'result', subtype: 'success', is_error: true, result: text, session_id: SESSION_ID },
    );
  }

  it("moves a turn whose model is out on one seat onto the member's next seat, in the same turn", async () => {
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness({
      model: 'fable',
      turnExitCodes: [1, 0],
      turnFiles: [
        limitTurn(FABLE_CREDITS_OUT),
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'done on the other seat' }] }, session_id: SESSION_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
        ),
      ],
    });
    const leaseForUser = vi.fn()
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_new', token: 'sk-ant-oat01-new-seat' } })
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_old', token: 'sk-ant-oat01-old-seat' } });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await runner('session-1', 'user-1', 'resume', { ...deps, platformCredentialPool: pool }, undefined);

    expect(client.detachedLaunchCalls).toHaveLength(2);
    expect(client.detachedLaunchCalls[1]?.command).toContain('sk-ant-oat01-old-seat');
    expect(client.detachedLaunchCalls[1]?.command).toContain("--model 'fable'");
    // The tripped seat went back benched for Fable alone, before the re-lease
    // asked for Fable again — that order is what lets the pool skip it.
    expect(releaseCredential).toHaveBeenNthCalledWith(1, 'seat_new', expect.objectContaining({
      kind: 'rate_limited', model: 'fable', modelOnly: true,
    }));
    expect(leaseForUser).toHaveBeenLastCalledWith('claude', 'user-1', expect.objectContaining({ model: 'fable' }));
    expect(releaseCredential).toHaveBeenLastCalledWith('seat_old', expect.objectContaining({ kind: 'ok' }));
    expect(releaseCredential).toHaveBeenCalledTimes(2);
    const sent = notifyAssistantResponse.mock.calls.map(([{ content }]) => content).join('\n');
    expect(sent).toContain('done on the other seat');
    expect(sent).not.toContain('usage credits');
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('an agent given a subscription asks for it first, on the turn AND on the hop off it (note #773)', async () => {
    const { client, deps, runner } = await setupHarness({
      model: 'fable',
      seatId: 'chosen',
      turnExitCodes: [1, 0],
      turnFiles: [
        limitTurn(FABLE_CREDITS_OUT),
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, session_id: SESSION_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID },
        ),
      ],
    });
    const leaseForUser = vi.fn()
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_chosen', token: 'sk-ant-oat01-chosen' } })
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_primary', token: 'sk-ant-oat01-primary' } });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await runner('session-1', 'user-1', 'hi', { ...deps, platformCredentialPool: pool }, undefined);

    // The pin rides both leases: the pool puts the chosen seat first each
    // time, and skips it only while it is benched for this model.
    expect(leaseForUser).toHaveBeenCalledTimes(2);
    for (const call of leaseForUser.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ seatId: 'chosen', model: 'fable' }));
    }
    expect(client.detachedLaunchCalls[0]?.command).toContain('sk-ant-oat01-chosen');
    expect(client.detachedLaunchCalls[1]?.command).toContain('sk-ant-oat01-primary');
  });

  it('says the MODEL is out, and how to go on, when no seat can run it', async () => {
    const resetAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { client, deps, runner } = await setupHarness({
      model: 'fable',
      turnExitCodes: [1],
      turnFiles: [limitTurn(FABLE_WEEK_OUT)],
    });
    const leaseForUser = vi.fn()
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_old', token: 'sk-ant-oat01-old-seat' } })
      .mockResolvedValueOnce({ kind: 'dedicated_exhausted', resetAt, model: 'fable' });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);

    await expect(runner('session-1', 'user-1', 'resume', {
      ...deps, platformCredentialPool: pool, onHarnessUsageLimit,
    }, undefined)).rejects.toThrow(modelLimitMessage('fable', new Date(resetAt)));

    expect(client.detachedLaunchCalls).toHaveLength(1);
    // Released exactly once — by the hop, with the bench — never twice.
    expect(releaseCredential).toHaveBeenCalledTimes(1);
    expect(releaseCredential).toHaveBeenCalledWith('seat_old', expect.objectContaining({
      kind: 'rate_limited', model: 'fable', modelOnly: true,
    }));
    expect(onHarnessUsageLimit).toHaveBeenCalledWith({ cli: 'claude', resetAt });
  });

  it('answers a lease whose every seat is out of this model with the model, not the subscription', async () => {
    const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const { client, deps, runner, notifyAssistantResponse } = await paidSetup({ model: 'fable' });
    const pool = poolStub({ kind: 'dedicated_exhausted', resetAt, model: 'fable' });

    await runner('session-1', 'user-1', 'hi', { ...deps, platformCredentialPool: pool }, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: modelLimitMessage('fable', new Date(Date.parse(resetAt))),
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('names a billing pause without launching Claude or asking for sign-in', async () => {
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await paidSetup({});
    const pool = poolStub({ kind: 'payment_required' });

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: paymentRequiredMessage('Claude'),
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((pool as unknown as { releaseCredential: ReturnType<typeof vi.fn> }).releaseCredential)
      .not.toHaveBeenCalled();
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('reads an empty pool as a missing seat, not as capacity', async () => {
    const { deps, runner, notifyAssistantResponse } = await paidSetup({});
    const pool = poolStub({ kind: 'limbo', lease: null });

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: NO_SEAT_MESSAGE,
    }));
  });

  // Rotating the shared grant revokes the superseded access token IMMEDIATELY
  // (measured in prod 2026-08-29, note #104): any sibling's lease renewal
  // kills every turn still in flight on the old token, while the seat is
  // healthy and already holds the fresh one. The turn must survive that.
  it('survives a mid-turn token revocation: re-leases and resumes the conversation', async () => {
    const RETRY_ID = '99999999-8888-7777-6666-555555555555';
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness({
      turnExitCodes: [1, 0],
      turnFiles: [
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'half the work' }] }, session_id: SESSION_ID },
          {
            type: 'assistant',
            message: {
              model: '<synthetic>',
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' }],
            },
            error: 'authentication_failed',
            is_api_error_message: true,
            session_id: SESSION_ID,
          },
          // 2.1.251 calls this result subtype "success" even while the two
          // authoritative failure fields say it is an API error.
          { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 401,
            result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', session_id: SESSION_ID },
        ),
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: RETRY_ID },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'the rest of the work' }] }, session_id: RETRY_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: RETRY_ID },
        ),
      ],
    });
    const leaseForUser = vi.fn()
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_s1', token: 'sk-ant-oat01-rotated-away' } })
      .mockResolvedValueOnce({ kind: 'dedicated', lease: { credentialId: 'seat_s1', token: 'sk-ant-oat01-fresh' } });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await runner('session-1', 'user-1', 'do the thing', {
      ...deps, platformCredentialPool: pool,
    }, undefined);

    // Second launch rides the fresh token and CONTINUES the conversation the
    // failed attempt left on disk — no replayed prompt, no duplicate work.
    expect(client.detachedLaunchCalls).toHaveLength(2);
    expect(client.detachedLaunchCalls[1]?.command).toContain('sk-ant-oat01-fresh');
    expect(client.detachedLaunchCalls[1]?.command).toContain(`--resume '${SESSION_ID}'`);
    expect(client.detachedLaunchCalls[1]?.command).toContain('Continue exactly where you left off');
    expect(client.detachedLaunchCalls[1]?.command).not.toContain('do the thing');
    // The user never saw the 401 — both halves of the answer, nothing else.
    const sent = notifyAssistantResponse.mock.calls.map(([{ content }]) => content).join('\n');
    expect(sent).toContain('half the work');
    expect(sent).toContain('the rest of the work');
    expect(sent).not.toContain('revoked');
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
    // The stale lease went back as not-at-fault; the fresh one carried the ok.
    expect(releaseCredential).toHaveBeenNthCalledWith(1, 'seat_s1', { kind: 'error' });
    expect(releaseCredential).toHaveBeenLastCalledWith('seat_s1', expect.objectContaining({ kind: 'ok' }));
  });

  it('survives the same rotation after a deploy re-attaches to the running CLI', async () => {
    const OUT = '/tmp/infinite-agents-harness-turn-revoked-after-attach.jsonl';
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness({
      claudeSessionId: SESSION_ID,
      turnExitCodes: [1, 0],
      turnFiles: [
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          {
            type: 'assistant',
            message: {
              model: '<synthetic>',
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' }],
            },
            error: 'authentication_failed',
            is_api_error_message: true,
            session_id: SESSION_ID,
          },
          { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 401,
            result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', session_id: SESSION_ID },
        ),
        jsonlLines(
          { type: 'system', subtype: 'init', session_id: SESSION_ID },
          { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'continued after deploy' }] }, session_id: SESSION_ID },
          { type: 'result', subtype: 'success', is_error: false, result: 'continued after deploy', session_id: SESSION_ID },
        ),
      ],
    });
    const leaseForUser = vi.fn().mockResolvedValue({
      kind: 'dedicated',
      lease: { credentialId: 'seat_s1', token: 'sk-ant-oat01-current-after-deploy' },
    });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await runner('session-1', 'user-1', {
      content: 'original request already accepted by the old process',
      harnessAttach: {
        cli: 'claude', sandboxId: 'sb-1', outputPath: OUT, pid: 777,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, { ...deps, platformCredentialPool: pool, onHarnessAuthFailure }, undefined);

    // Reattach itself launches nothing. The ONE launch is recovery on the
    // seat's current token, continuing rather than duplicating the request.
    expect(client.detachedLaunchCalls).toHaveLength(1);
    const recoveryCommand = client.detachedLaunchCalls[0]!.command;
    expect(recoveryCommand).toContain('sk-ant-oat01-current-after-deploy');
    expect(recoveryCommand).toContain(`--resume '${SESSION_ID}'`);
    expect(recoveryCommand).toContain('Continue exactly where you left off');
    expect(recoveryCommand).not.toContain('original request already accepted');
    expect(leaseForUser).toHaveBeenCalledTimes(1);
    expect(onHarnessAuthFailure).not.toHaveBeenCalled();
    expect(notifyAssistantResponse.mock.calls.map(([{ content }]) => content).join('\n'))
      .toBe('continued after deploy');
    expect(releaseCredential).toHaveBeenLastCalledWith('seat_s1', expect.objectContaining({ kind: 'ok' }));
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('never pauses user auth when an attached platform turn cannot re-lease after a 401', async () => {
    const OUT = '/tmp/infinite-agents-harness-turn-revoked-reattach-no-lease.jsonl';
    const { deps, runner, notifyAssistantResponse } = await setupHarness({
      claudeSessionId: SESSION_ID,
      turnExitCodes: [1],
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' }] },
          error: 'authentication_failed', is_api_error_message: true, session_id: SESSION_ID },
        { type: 'result', subtype: 'success', is_error: true,
          result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', session_id: SESSION_ID },
      )],
    });
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);
    const pool = {
      leaseForUser: vi.fn().mockRejectedValue(new Error('seat storage temporarily unavailable')),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];

    await expect(runner('session-1', 'user-1', {
      content: 'already running',
      harnessAttach: {
        cli: 'claude', sandboxId: 'sb-1', outputPath: OUT, pid: 777,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, { ...deps, platformCredentialPool: pool, onHarnessAuthFailure }, undefined))
      .rejects.toThrow(CLAUDE_PLATFORM_HICCUP_MESSAGE);

    expect(onHarnessAuthFailure).not.toHaveBeenCalled();
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
  });

  it('does not retry when the re-lease returns the same token — the grant itself is dead', async () => {
    const { client, deps, runner } = await setupHarness({
      turnExitCodes: [1],
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', session_id: SESSION_ID },
      )],
    });
    const leaseForUser = vi.fn().mockResolvedValue(
      { kind: 'dedicated', lease: { credentialId: 'seat_s1', token: 'sk-ant-oat01-dead' } },
    );
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await expect(runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined)).rejects.toThrow(CLAUDE_PLATFORM_HICCUP_MESSAGE);

    // One CLI launch: an unchanged token has nothing new to run on.
    expect(client.detachedLaunchCalls).toHaveLength(1);
    // The probe lease went straight back without blame; the original lease
    // reported the auth death so the pool's streak can judge the grant.
    expect(releaseCredential).toHaveBeenNthCalledWith(1, 'seat_s1', { kind: 'error' });
    expect(releaseCredential).toHaveBeenLastCalledWith('seat_s1', expect.objectContaining({ kind: 'auth_failed' }));
  });

  it('turns the runtime revoked-token wording into billing only when the live profile confirms past_due', async () => {
    const { client, deps, runner } = await setupHarness({
      profileSubscriptionStatus: 'past_due',
      turnExitCodes: [1],
      turnFiles: [jsonlLines(
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'result', subtype: 'error_during_execution', is_error: true,
          result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', session_id: SESSION_ID },
      )],
    });
    const leaseForUser = vi.fn().mockResolvedValue(
      { kind: 'dedicated', lease: { credentialId: 'seat_s1', token: 'sk-ant-oat01-billing' } },
    );
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const pool = { leaseForUser, releaseCredential } as unknown as AgentLoopDeps['platformCredentialPool'];

    await expect(runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool: pool,
    }, undefined)).rejects.toThrow(paymentRequiredMessage('Claude'));

    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(releaseCredential).toHaveBeenLastCalledWith('seat_s1', expect.objectContaining({
      kind: 'payment_required', subscriptionStatus: 'past_due',
    }));
  });
});
