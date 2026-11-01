import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentTokenLedger } from '../../services/agent-token-ledger.js';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import {
  CODEX_NOT_CONNECTED_MESSAGE,
  CODEX_TURN_STALLED_MESSAGE,
  CODEX_WORKSPACE_UNAVAILABLE_MESSAGE,
  buildCodexExecCommand,
  createCodexHarnessRunner,
} from '../../agent/codex/codex-harness.js';
import { PROCESS_SHUTDOWN_ABORT_REASON } from '../../agent/abort-reason.js';
import {
  clearActiveDetachedTurn,
  getActiveDetachedTurn,
} from '../../agent/harness-turn-output.js';
import { codexUsageCostMicros } from '../../agent/platform-usage-metering.js';
import { dedicatedLimitMessage } from '../../agent/platform-turn-policy.js';
import { InMemorySessionStorage } from '../../services/session-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { EventCapture } from '../helpers/event-capture.js';
import {
  FakeTurnOutputFiles,
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
  makeTerminalSnapshot,
} from '../mocks/fake-workspace-runtime-client.js';

const THREAD_ID = '019f4bb8-9cb1-77a1-87ba-32fde8cd5d6b';

function jsonlLines(...events: object[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

async function setupHarness(options: {
  /** The CLI install running on the machine when the turn arrives. */
  cliInstallInFlight?: (sandboxId: string) => Promise<void> | undefined;
  codexThreadId?: string;
  loggedIn?: boolean;
  /** Scripted turn-output files (JSONL lines), one per turn attempt. */
  turnFiles?: string[][];
  /** Per-attempt CLI exit codes (default 0 each). */
  turnExitCodes?: number[];
  /** Per-attempt stderr sidecar contents (error tails). */
  turnStderrs?: string[];
  model?: string;
  /** What the machine's rollout file answers when asked for the window fill. */
  rolloutTokenCount?: string;
  /** Answers per turn instead, in order (the token ledger's two-turn tests). */
  rolloutTokenCounts?: string[];
  /** A fill already on the agent record, as an earlier turn would have left it. */
  contextUsage?: { tokens: number; model?: string; window?: number; at: string };
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
        'agent-codex': {
          id: 'agent-codex',
          name: 'Codex',
          cli: 'codex',
          createdAt: '2026-01-01T00:00:00.000Z',
          ...(options.model ? { model: options.model } : {}),
        },
      },
    },
  });
  if (options.codexThreadId) {
    await userStorage.updateTelegramHarnessConversation('user-1', {
      codexThreadId: options.codexThreadId,
    }, { agentId: 'agent-codex' });
  }

  if (options.contextUsage) {
    await userStorage.updateAgentFields('user-1', 'agent-codex', { contextUsage: options.contextUsage });
  }

  const turnFiles = new FakeTurnOutputFiles(options.turnFiles ?? [], options.turnExitCodes ?? [], options.turnStderrs ?? []);
  client.execSyncHandler = (command) => turnFiles.answer(command)
    ?? (command.startsWith('if [ -f ')
      ? makeExecSyncResult({ stdout: 'running\n' })
      : command === 'codex login status'
      ? makeExecSyncResult({ exitCode: options.loggedIn === false ? 1 : 0 })
      : command.includes('"type":"token_count"')
        ? makeExecSyncResult({ stdout: options.rolloutTokenCounts?.shift() ?? options.rolloutTokenCount ?? '' })
        : makeExecSyncResult());

  const deps = {
    sessionStorage,
    eventEmitter,
    toolExecutor: {} as AgentLoopDeps['toolExecutor'],
    aiModel: 'mock-model',
    notifyAssistantResponse,
    userStorage,
    // Every real caller pins the turn to the agent it was dispatched for.
    telegramTargetAgentId: 'agent-codex',
  } as AgentLoopDeps;

  const runner = createCodexHarnessRunner({
    sandboxClient: client,
    resolveDefaultSandboxId: async () => 'sb-1',
    ...(options.cliInstallInFlight ? { cliInstallInFlight: options.cliInstallInFlight } : {}),
  });

  const events = new EventCapture().subscribe(eventEmitter, 'session-1');

  return { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse, events };
}

describe('codex harness runner', () => {
  it('starts the CLI only once an install of it in flight on the machine is done (2026-10-15)', async () => {
    // Iris's lost turn: the pre-sleep update was replacing the CLI when a
    // message arrived, and the turn ran into `codex: command not found`.
    let finish: () => void = () => {};
    const install = new Promise<void>((resolve) => { finish = resolve; });
    const asked: string[] = [];
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hello there' } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      )],
      cliInstallInFlight: (sandboxId) => { asked.push(sandboxId); return install; },
    });

    const turn = runner('session-1', 'user-1', 'hi codex', deps, undefined);
    await vi.waitFor(() => expect(asked).toEqual(['sb-1']));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(client.detachedLaunchCalls).toHaveLength(0);

    finish();
    await turn;
    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(client.detachedLaunchCalls[0]?.command).toContain('codex ');
  });

  it('runs a first turn: stores the thread id and delivers the reply without mirroring the transcript', async () => {
    const { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse, events } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hello there' } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      )],
    });

    await runner('session-1', 'user-1', 'hi codex', deps, undefined);

    const startCall = client.detachedLaunchCalls[0];
    // The run always carries explicit defaults for an agent with no overrides
    // — `high`, outside the heavy band, since 2026-09-11.
    expect(startCall?.command).toContain(buildCodexExecCommand({ prompt: 'hi codex', model: 'gpt-6.1-sol', effort: 'high' }));
    expect(startCall?.command).toContain("-c 'model_reasoning_effort=high'");
    // stdout goes to the per-turn file; the PTY only supervises the process.
    expect(startCall?.command).toContain('{ codex exec');
    expect(startCall?.command).toMatch(/\} > '\/tmp\/infinite-agents-harness-turn-[0-9a-f-]+\.jsonl' < \/dev\/null 2> /);
    expect(startCall?.command).toContain('--json');
    expect(startCall?.command).toContain('--sandbox danger-full-access');
    expect(startCall?.command).not.toContain('resume');
    // Runs as the non-root agent user in its home, matching where sign-in happened.
    expect(startCall?.cwd).toBe('/home/agent');
    expect(startCall?.sshUser).toBe('agent');
    expect(startCall?.command).toContain('-C /home/agent');

    // The native Codex thread on the VM owns the conversation; the platform
    // does not mirror the transcript into session storage.
    expect(await sessionStorage.getHistory('user-1', 'session-1')).toEqual([]);

    expect(notifyAssistantResponse).toHaveBeenCalledTimes(1);
    expect(notifyAssistantResponse).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-1',
      content: 'hello there',
      source: 'codex-cli',
      model: 'gpt-6.1-sol',
      requestedModel: 'gpt-6.1-sol',
    });

    const session = await sessionStorage.getSession('user-1', 'session-1');
    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-codex']?.conversation?.codexThreadId).toBe(THREAD_ID);
    expect(session?.status).toBe('completed');
    expect(session?.lastAssistantMessage).toBe('hello there');

    expect(events.getEventTypes()).toContain('agent_start');
    expect(events.getEventTypes()).toContain('assistant_message');
    expect(events.getEventTypes()).toContain('agent_complete');
  });

  it('resumes the stored thread on later turns and skips the auth pre-check', async () => {
    const { client, deps, runner } = await setupHarness({
      codexThreadId: THREAD_ID,
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'resumed' } },
        { type: 'turn.completed' },
      )],
    });

    await runner('session-1', 'user-1', 'again', deps, undefined);

    const startCall = client.detachedLaunchCalls[0];
    expect(startCall?.command).toContain(`resume '${THREAD_ID}'`);
    expect(client.execSyncCalls.filter((call) => call.command === 'codex login status')).toEqual([]);
  });

  it('re-attaches after a transient probe failure without launching a second Codex CLI', async () => {
    vi.useFakeTimers();
    try {
      const outputPath = '/tmp/transient-codex-attach.jsonl';
      const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
        loggedIn: false,
        turnFiles: [jsonlLines(
          { type: 'thread.started', thread_id: THREAD_ID },
          { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'survived' } },
          { type: 'turn.completed' },
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
          cli: 'codex', sandboxId: 'sb-old', outputPath, pid: 777,
          consumedLines: 1, deliveredMessageCount: 0,
        },
      }, { ...deps, telegramTargetSandboxId: 'sb-new' }, undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await completion;

      expect(probes).toBe(2);
      expect(client.detachedLaunchCalls).toEqual([]);
      expect(client.execSyncCalls.filter((call) => call.command === 'codex login status')).toEqual([]);
      expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'survived' }));
      expect(client.execSyncCalls.filter((call) => (
        call.command.startsWith('if [ -f ') || call.command.startsWith('tail -n +')
      )).every((call) => call.sandboxId === 'sb-old')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live recovery attached when running-status bookkeeping fails', async () => {
    const outputPath = '/tmp/codex-live-attach-status-failure.jsonl';
    const runKey = 'session-1::agent:agent-codex';
    const { client, deps, runner, sessionStorage } = await setupHarness({
      codexThreadId: THREAD_ID,
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.completed' },
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
        cli: 'codex', sandboxId: 'sb-1', outputPath, pid: 777,
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
    const outputPath = '/tmp/provisional-codex-attach.jsonl';
    const runKey = 'session-1::agent:agent-codex';
    const { client, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.completed' },
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
        cli: 'codex', sandboxId: 'sb-1', outputPath, pid: 0,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  // A rollout line as codex-cli 0.148.0 writes one: the thread's running total
  // alongside the single request that just ran, and the window the CLI enforces.
  const rolloutLine = (last: number, total: number, window = 258400): string => JSON.stringify({
    timestamp: '2026-08-19T14:10:15.260Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, total_tokens: total },
        last_token_usage: { input_tokens: last, total_tokens: last },
        model_context_window: window,
      },
    },
  });

  it('records the window fill from the rollout, not from the turn stream running total', async () => {
    const { client, userStorage, deps, runner } = await setupHarness({
      model: 'gpt-5.6-terra',
      // What the stream says: 180,000 tokens, summed over every request this
      // THREAD has made. Reading the fill from it would report a comfortable
      // conversation as two thirds gone.
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hello there' } },
        { type: 'turn.completed', usage: { input_tokens: 180_000, output_tokens: 500 } },
      )],
      rolloutTokenCount: rolloutLine(64_600, 180_000),
    });

    await runner('session-1', 'user-1', 'hi codex', deps, undefined);

    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-codex']?.contextUsage).toEqual({
      tokens: 64_600,
      model: 'gpt-5.6-terra',
      window: 258_400,
      at: expect.any(String),
    });
    // The window is read once, on the machine, as the CLI user — after the
    // reply is already out.
    const contextCalls = client.execSyncCalls.filter((call) => call.command.includes('"type":"token_count"'));
    expect(contextCalls).toHaveLength(1);
    expect(contextCalls[0]?.sshUser).toBe('agent');
    expect(contextCalls[0]?.command).toContain(THREAD_ID);
  });

  // The thread's running total, in the shape codex-cli writes it.
  const totalLine = (input: number, cached: number, output: number, reasoning: number): string => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input, cached_input_tokens: cached, output_tokens: output,
          reasoning_output_tokens: reasoning, total_tokens: input + output,
        },
        last_token_usage: { input_tokens: 1_000, total_tokens: 1_000 },
        model_context_window: 258_400,
      },
    },
  });
  const answered = (text: string) => jsonlLines(
    { type: 'thread.started', thread_id: THREAD_ID },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
    { type: 'turn.completed' },
  );

  it('credits each turn the difference in the thread’s running total, a new thread from zero', async () => {
    const { userStorage, deps, runner } = await setupHarness({
      model: 'gpt-5.6-terra',
      turnFiles: [answered('one'), answered('two')],
      rolloutTokenCounts: [totalLine(10_000, 8_000, 300, 120), totalLine(25_000, 20_000, 700, 200)],
    });
    const ledger = new InMemoryAgentTokenLedger();
    deps.agentTokenLedger = ledger;

    await runner('session-1', 'user-1', 'first', deps, undefined);
    expect(ledger.userDays('user-1', '2000-01-01')).toEqual([expect.objectContaining({
      provider: 'codex', model: 'gpt-5.6-terra', input: 2_000, cacheRead: 8_000, output: 300, reasoning: 120,
    })]);
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']?.codexTokenBase)
      .toEqual({ threadId: THREAD_ID, input: 10_000, cachedInput: 8_000, output: 300, reasoning: 120 });

    // The second turn resumes the thread: only what it added is new.
    await runner('session-1', 'user-1', 'second', deps, undefined);
    expect(ledger.userDays('user-1', '2000-01-01')).toEqual([expect.objectContaining({
      input: 2_000 + 3_000, cacheRead: 8_000 + 12_000, output: 300 + 400, reasoning: 120 + 80,
    })]);
  });

  it('only sets the starting point on a thread that predates the ledger', async () => {
    const { userStorage, deps, runner } = await setupHarness({
      codexThreadId: THREAD_ID,
      turnFiles: [answered('hello')],
      rolloutTokenCount: totalLine(900_000, 800_000, 40_000, 9_000),
    });
    const ledger = new InMemoryAgentTokenLedger();
    deps.agentTokenLedger = ledger;

    await runner('session-1', 'user-1', 'hi again', deps, undefined);

    expect(ledger.userDays('user-1', '2000-01-01')).toEqual([]);
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']?.codexTokenBase)
      .toMatchObject({ threadId: THREAD_ID, input: 900_000 });
  });

  it('tells the agent once, on its next turn, that the Workspace Agent changed what it runs on (note #776), and clears the mark', async () => {
    const { client, userStorage, deps, runner } = await setupHarness({
      codexThreadId: THREAD_ID,
      model: 'gpt-6-luna',
      turnFiles: [answered('ok'), answered('ok again')],
    });
    await userStorage.updateAgentFields('user-1', 'agent-codex', { effort: 'max', runtimeChange: { by: 'workspace-agent', at: '2026-10-18T09:00:00.000Z' } });

    await runner('session-1', 'user-1', 'carry on', deps, undefined);

    const command = client.detachedLaunchCalls[0]?.command ?? '';
    expect(command).toContain('Since your last turn the Workspace Agent changed what you run on');
    expect(command).toContain('this turn runs on gpt-6-luna at max effort.');
    expect(command.indexOf('carry on')).toBeLessThan(command.indexOf('Since your last turn'));
    await vi.waitFor(async () => expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']?.runtimeChange).toBeUndefined());

    await runner('session-1', 'user-1', 'and again', deps, undefined);
    expect(client.detachedLaunchCalls[1]?.command ?? '').not.toContain('Since your last turn');
  });

  it('tells the agent how full its window is, after the user own words', async () => {
    const { client, deps, runner } = await setupHarness({
      codexThreadId: THREAD_ID,
      model: 'gpt-5.6-terra',
      // Half of the 258,400 window the CLI reported last turn.
      contextUsage: { tokens: 129_200, window: 258_400, at: '2026-08-19T10:00:00.000Z' },
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed' },
      )],
    });

    await runner('session-1', 'user-1', 'how are we doing', deps, undefined);

    const command = client.detachedLaunchCalls[0]?.command ?? '';
    expect(command).toContain('Context window: about 50% full as of your last turn');
    expect(command).toContain('(129k of 258k tokens)');
    // The platform speaks over the user shoulder, so it goes last.
    expect(command.indexOf('how are we doing')).toBeLessThan(command.indexOf('Context window'));
  });

  it('says nothing about the window on a first turn, and keeps the last reading when the rollout cannot be read', async () => {
    const { client, userStorage, deps, runner } = await setupHarness({
      codexThreadId: THREAD_ID,
      model: 'gpt-5.6-terra',
      contextUsage: { tokens: 100_000, window: 258_400, at: '2026-08-19T10:00:00.000Z' },
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed' },
      )],
      rolloutTokenCount: '', // the machine answers nothing
    });

    await runner('session-1', 'user-1', 'again', deps, undefined);

    // Stale by one turn beats overwritten with a guess.
    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-codex']?.contextUsage).toEqual({
      tokens: 100_000,
      window: 258_400,
      at: '2026-08-19T10:00:00.000Z',
    });

    const { client: freshClient, deps: freshDeps, runner: freshRunner } = await setupHarness({
      model: 'gpt-5.6-terra',
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi' } },
        { type: 'turn.completed' },
      )],
    });
    await freshRunner('session-1', 'user-1', 'first message', freshDeps, undefined);
    expect(freshClient.detachedLaunchCalls[0]?.command).not.toContain('Context window');
    expect(client.detachedLaunchCalls[0]?.command).toContain('Context window');
  });

  it('starts fresh after New chat even when a stale legacy thread id remains', async () => {
    const NEW_THREAD_ID = '11111111-2222-7333-8444-555555555555';
    const { client, sessionStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: NEW_THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'fresh' } },
        { type: 'turn.completed' },
      )],
    });
    // Per-agent New chat has removed the agent pointer, while an old deployment
    // may still have left its pre-fleet fallback on the shared session record.
    await sessionStorage.updateSession('user-1', 'session-1', { codexThreadId: THREAD_ID });

    await runner('session-1', 'user-1', 'start over', deps, undefined);

    expect(client.detachedLaunchCalls[0]?.command).not.toContain('resume');
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

    const runner = createCodexHarnessRunner({
      sandboxClient: client,
      resolveDefaultSandboxId: async () => { throw new Error('Usage limit reached'); },
    });

    await runner('session-1', 'user-1', 'hi', deps, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: CODEX_WORKSPACE_UNAVAILABLE_MESSAGE,
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('points the user at /harness when ChatGPT is not connected', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({ loggedIn: false });

    await runner('session-1', 'user-1', 'hi', deps, undefined);

    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: CODEX_NOT_CONNECTED_MESSAGE,
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('hands a dead sign-in to the recovery handler instead of the generic not-connected text', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({ loggedIn: false });
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);
    await runner('session-1', 'user-1', 'hi', { ...deps, onHarnessAuthFailure }, undefined);
    expect(onHarnessAuthFailure).toHaveBeenCalledWith({ cli: 'codex' });
    // The handler owns the user-facing message — no contradictory default.
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect(client.detachedLaunchCalls).toEqual([]);
  });

  it('falls back to a fresh thread when the stored thread has no rollout on the sandbox', async () => {
    const NEW_THREAD_ID = '11111111-2222-7333-8444-555555555555';
    const { client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse } = await setupHarness({
      codexThreadId: THREAD_ID,
      // Resume attempt dies with the missing-rollout error; the retry succeeds.
      turnExitCodes: [1, 0],
      turnStderrs: ['thread/resume failed: no rollout found for thread id', ''],
      turnFiles: [
        [],
        jsonlLines(
          { type: 'thread.started', thread_id: NEW_THREAD_ID },
          { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'recovered' } },
          { type: 'turn.completed' },
        ),
      ],
    });

    await runner('session-1', 'user-1', 'hi again', deps, undefined);

    expect(client.detachedLaunchCalls).toHaveLength(2);
    expect(client.detachedLaunchCalls[0]?.command).toContain(`resume '${THREAD_ID}'`);
    expect(client.detachedLaunchCalls[1]?.command).not.toContain('resume');

    const profile = await userStorage.getProfile('user-1');
    expect(profile?.telegram?.agents?.['agent-codex']?.conversation?.codexThreadId).toBe(NEW_THREAD_ID);
    const session = await sessionStorage.getSession('user-1', 'session-1');
    expect(session?.status).toBe('completed');
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: 'recovered',
    }));
  });

  it('does not retry a genuine failure that merely exits non-zero', async () => {
    const { client, deps, runner } = await setupHarness({ codexThreadId: THREAD_ID, turnExitCodes: [1], turnStderrs: ['some unrelated failure'] });

    await expect(runner('session-1', 'user-1', 'hi', deps, undefined))
      .rejects.toThrow(/Codex exited with code 1/);
    expect(client.detachedLaunchCalls).toHaveLength(1);
  });

  it('throws when codex exits non-zero without any reply', async () => {
    const { client, deps, runner } = await setupHarness({ turnExitCodes: [2] });

    await expect(runner('session-1', 'user-1', 'hi', deps, undefined))
      .rejects.toThrow(/Codex exited with code 2/);
  });

  it('respects historyAlreadyPersisted to avoid double-writing the user message', async () => {
    const { client, sessionStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } },
      )],
    });
    await sessionStorage.addToHistory('user-1', 'session-1', { role: 'user', content: 'queued input' });

    await runner(
      'session-1',
      'user-1',
      { content: 'queued input', historyAlreadyPersisted: true },
      deps,
      undefined,
    );

    const history = await sessionStorage.getHistory('user-1', 'session-1');
    expect(history.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('kills an aborted first turn, captures its native thread id, and suppresses stale output', async () => {
    const {
      client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse,
    } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'stale', type: 'agent_message', text: 'stale answer' } },
      )],
    });
    const abortController = new AbortController();
    const answer = client.execSyncHandler;
    client.execSyncHandler = (command) => {
      const result = answer(command);
      if (command.includes('nohup setsid')) abortController.abort();
      return result;
    };

    await runner('session-1', 'user-1', 'hi', deps, abortController.signal);

    const session = await sessionStorage.getSession('user-1', 'session-1');
    expect(session?.status).toBe('interrupted');
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']
      ?.conversation?.codexThreadId).toBe(THREAD_ID);
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(true);
  });

  it('does not deliver a batch whose output poll races with steering', async () => {
    const {
      client, sessionStorage, userStorage, deps, runner, notifyAssistantResponse,
    } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'item.completed', item: { id: 'stale', type: 'agent_message', text: 'stale raced answer' } },
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
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']
      ?.conversation?.codexThreadId).toBe(THREAD_ID);
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

  it('registers pid=0 before awaiting launch acknowledgement, then hydrates it', async () => {
    const runKey = 'session-1::agent:agent-codex';
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
          cli: 'codex', sandboxId: 'sb-1', pid: 0,
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

  it('leaves a detached Codex turn reattachable only for a process-shutdown abort', async () => {
    const runKey = 'session-1::agent:agent-codex';
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
        cli: 'codex',
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
        cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/orphan-codex.jsonl', pid: 4242,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(client.execSyncCalls.some((call) => call.command.includes('kill -TERM'))).toBe(true);
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('interrupted');
  });

  it('captures an orphaned first-turn thread id before launching its correction', async () => {
    const { client, userStorage, deps, runner } = await setupHarness({
      turnFiles: [jsonlLines({ type: 'thread.started', thread_id: THREAD_ID })],
    });

    await runner('session-1', 'user-1', {
      content: 'saved correction',
      harnessTermination: {
        cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/orphan-codex.jsonl', pid: 4242,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, undefined);

    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(client.detachedLaunchCalls[0]?.command).toContain(`resume '${THREAD_ID}'`);
    expect((await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-codex']
      ?.conversation?.codexThreadId).toBe(THREAD_ID);
  });

  // There is no wall-clock cap on a turn — a healthy run may go for hours.
  // The one thing that kills a turn is silence: a CLI that stops emitting
  // stream events for 15 minutes is wedged, and the kill message must say
  // the conversation survives.
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
      expect((error as Error).message).toContain(CODEX_TURN_STALLED_MESSAGE);
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
      const tick = JSON.stringify({ type: 'turn.started' });
      const finale = [
        JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'survived' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ];
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
          const all = [...Array<string>(ticksServed).fill(tick), ...(finished ? finale : [])];
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

  it('runs an attachment-only message (no caption) with the staged-file note as the whole prompt', async () => {
    const { client, deps, runner, notifyAssistantResponse } = await setupHarness({
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'nice photo' } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      )],
    });
    deps.mediaStorage = {
      uploadObject: vi.fn(),
      createReadAccess: vi.fn().mockResolvedValue({ url: 'https://signed.example/photo' }),
    } as unknown as AgentLoopDeps['mediaStorage'];

    await runner('session-1', 'user-1', {
      content: '',
      attachments: [{
        fileId: 'file_2_def',
        url: '',
        storagePath: 'users/user-1/sessions/session-1/file_2_def/photo.jpg',
        fileName: 'photo_def.jpg',
        displayName: 'photo.jpg',
        contentType: 'image/jpeg',
        mediaKind: 'image',
        renderAs: 'image',
        sizeBytes: 1_024,
        visibility: 'session',
        source: 'user_input',
        use: 'sandbox_input',
      }],
    }, deps, undefined);

    const stagingCall = client.execSyncCalls.find((call) => call.command.includes('PATCH_TOOL_PAYLOAD_B64='));
    expect(stagingCall).toBeDefined();
    const dateDir = new Date().toISOString().slice(0, 10);
    const startCall = client.detachedLaunchCalls[0];
    expect(startCall?.command).toContain(`/home/agent/inbox/${dateDir}/photo.jpg`);
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({ content: 'nice photo' }));
  });

  // Mirrors the Claude harness's seat gate: with the recovery handler wired,
  // a seatless owner is routed into the sign-in ceremony (workstream 2)
  // instead of being read a refusal it can do nothing about.
  it('routes a seatless owner into sign-in when the recovery handler is wired', async () => {
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness();
    const platformCredentialPool = {
      leaseForUser: vi.fn().mockResolvedValue({ kind: 'limbo', lease: null }),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];
    const onHarnessAuthFailure = vi.fn().mockResolvedValue(undefined);

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool, onHarnessAuthFailure,
    }, undefined);

    expect(onHarnessAuthFailure).toHaveBeenCalledWith({ cli: 'codex', reason: 'no_seat' });
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it("reports a cooling ChatGPT seat with the subscription's reset", async () => {
    const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const { client, deps, runner, notifyAssistantResponse, sessionStorage } = await setupHarness();
    const platformCredentialPool = {
      leaseForUser: vi.fn().mockResolvedValue({ kind: 'dedicated_exhausted', resetAt }),
      releaseCredential: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentLoopDeps['platformCredentialPool'];
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);

    await runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool, onHarnessUsageLimit,
    }, undefined);

    expect(onHarnessUsageLimit).toHaveBeenCalledWith({ cli: 'codex', resetAt });
    expect(notifyAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      content: dedicatedLimitMessage(new Date(Date.parse(resetAt))),
    }));
    expect(client.detachedLaunchCalls).toEqual([]);
    expect((platformCredentialPool as unknown as { releaseCredential: ReturnType<typeof vi.fn> }).releaseCredential)
      .not.toHaveBeenCalled();
    expect((await sessionStorage.getSession('user-1', 'session-1'))?.status).toBe('completed');
  });

  it('reports a dedicated ChatGPT limit discovered during the CLI turn', async () => {
    const { deps, runner } = await setupHarness({
      turnExitCodes: [1],
      turnFiles: [jsonlLines(
        { type: 'thread.started', thread_id: THREAD_ID },
        { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } },
      )],
    });
    const releaseCredential = vi.fn().mockResolvedValue(undefined);
    const platformCredentialPool = {
      leaseForUser: vi.fn().mockResolvedValue({
        kind: 'dedicated', lease: { credentialId: 'seat-codex', token: '{}' },
      }),
      releaseCredential,
    } as unknown as AgentLoopDeps['platformCredentialPool'];
    const onHarnessUsageLimit = vi.fn().mockResolvedValue(undefined);

    await expect(runner('session-1', 'user-1', 'hi', {
      ...deps, platformCredentialPool, onHarnessUsageLimit,
    }, undefined)).rejects.toThrow(dedicatedLimitMessage());

    expect(onHarnessUsageLimit).toHaveBeenCalledWith({ cli: 'codex' });
    expect(releaseCredential).toHaveBeenCalledWith(
      'seat-codex', { kind: 'rate_limited' }, expect.any(Object),
    );
  });

});

describe('buildCodexExecCommand', () => {
  it('quotes prompts containing single quotes safely', () => {
    const command = buildCodexExecCommand({ prompt: "it's a test" });
    expect(command).toContain(`'it'"'"'s a test'`);
  });

  it('places parent flags before the resume subcommand', () => {
    const command = buildCodexExecCommand({ prompt: 'go', resumeThreadId: THREAD_ID });
    expect(command).toBe(
      `codex exec --json --skip-git-repo-check --sandbox danger-full-access -C /home/agent resume '${THREAD_ID}' 'go'`,
    );
  });

  it('pins an explicit model before first and resumed turns', () => {
    expect(buildCodexExecCommand({ prompt: 'go', model: 'gpt-5.6-terra' }))
      .toContain("--model 'gpt-5.6-terra'");
    expect(buildCodexExecCommand({ prompt: 'go', resumeThreadId: THREAD_ID, model: 'gpt-5.6-terra' }))
      .toContain("--model 'gpt-5.6-terra' resume");
  });

  it('omits MCP wiring entirely when no setup is provided', () => {
    const command = buildCodexExecCommand({ prompt: 'go' });
    expect(command).not.toContain('mcp');
    expect(command).not.toContain('PLATFORM_MCP_TOKEN');
  });

  it('appends the effort config override before the resume subcommand', () => {
    expect(buildCodexExecCommand({ prompt: 'go', effort: 'xhigh' }))
      .toContain("-c 'model_reasoning_effort=xhigh'");
    expect(buildCodexExecCommand({ prompt: 'go', resumeThreadId: THREAD_ID, effort: 'xhigh' }))
      .toContain("-c 'model_reasoning_effort=xhigh' resume");
  });

  it('omits the effort override when no reasoning effort is set', () => {
    expect(buildCodexExecCommand({ prompt: 'go', model: 'gpt-5.6-terra' }))
      .not.toContain('model_reasoning_effort');
  });
});
