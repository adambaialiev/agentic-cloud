import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';
import { EventCapture, assertEventSubsequence } from '../helpers/event-capture.js';
import { PROCESS_SHUTDOWN_ABORT_REASON } from '../../agent/abort-reason.js';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BackgroundRunner', () => {
  let BackgroundRunnerClass: typeof import('../../agent/background-runner.js').BackgroundRunner;
  let NonRecoverableAgentErrorClass: typeof import('../../agent/background-runner.js').NonRecoverableAgentError;
  let mergeQueuedUserPayloads: typeof import('../../agent/background-runner.js').mergeQueuedUserPayloads;
  let steeringResumeNotice: string;
  let loopFnMock: ReturnType<typeof vi.fn>;
  let deps: AgentLoopDeps;
  let eventEmitter: AgentEventEmitter;
  let updateSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    loopFnMock = vi.fn();
    const mod = await import('../../agent/background-runner.js');
    BackgroundRunnerClass = mod.BackgroundRunner;
    NonRecoverableAgentErrorClass = mod.NonRecoverableAgentError;
    mergeQueuedUserPayloads = mod.mergeQueuedUserPayloads;
    steeringResumeNotice = mod.STEERING_RESUME_NOTICE;

    eventEmitter = new AgentEventEmitter();
    updateSessionMock = vi.fn().mockResolvedValue(undefined);

    deps = {
      sessionStorage: { updateSession: updateSessionMock } as unknown as AgentLoopDeps['sessionStorage'],
      eventEmitter,
      toolExecutor: {} as AgentLoopDeps['toolExecutor'],
      aiModel: 'mock-model',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('queues and drains messages only while a session is running', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValueOnce(deferred.promise);

    expect(runner.queueMessage('session-a', 'hello')).toEqual({
      status: 'not_running',
      queuePosition: 0,
    });
    expect(runner.drainMessages('session-a')).toEqual([]);

    expect(runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock)).toEqual({ status: 'started' });

    expect(runner.isRunning('session-a')).toBe(true);
    expect(runner.getRunningCount()).toBe(1);
    expect(runner.getRunningSessionIds()).toEqual(['session-a']);
    expect(runner.queueMessage('session-a', 'first')).toEqual({ status: 'queued', queuePosition: 1 });
    expect(runner.queueMessage('session-a', 'second')).toEqual({ status: 'queued', queuePosition: 2 });
    // A queued payload can be taken back by the exact object that was queued
    // (an expired or withdrawn peer message); a stranger or a drained one
    // reports false, which is what "already delivered" reads as.
    const third = { content: 'third' };
    expect(runner.queueMessage('session-a', third)).toEqual({ status: 'queued', queuePosition: 3 });
    expect(runner.removeQueuedMessage('session-a', third)).toBe(true);
    expect(runner.removeQueuedMessage('session-a', third)).toBe(false);
    expect(runner.removeQueuedMessage('session-a', { content: 'first' })).toBe(false);
    expect(runner.drainMessages('session-a')).toEqual([
      { content: 'first' },
      { content: 'second' },
    ]);
    expect(runner.drainMessages('session-a')).toEqual([]);
    expect(runner.removeQueuedMessage('missing', third)).toBe(false);

    deferred.resolve();
    await runner.waitForCompletion('session-a');
    expect(runner.isRunning('session-a')).toBe(false);
    expect(runner.getRunningCount()).toBe(0);
    expect(runner.getRunningSessionIds()).toEqual([]);
  });

  it('keeps the owner-stop marker when queued owner messages merge', () => {
    expect(mergeQueuedUserPayloads([
      { content: 'first', preserveAfterUserStop: true },
      { content: 'second', preserveAfterUserStop: true },
    ])).toEqual({
      merged: {
        content: 'first\n\nsecond',
        preserveAfterUserStop: true,
      },
      remaining: [],
    });
  });

  it('runs two run keys of the same session concurrently with independent queues', async () => {
    const runner = new BackgroundRunnerClass();
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    loopFnMock.mockReturnValueOnce(deferredA.promise).mockReturnValueOnce(deferredB.promise);

    const keyA = 'session-1::agent:agent-a';
    const keyB = 'session-1::agent:agent-b';
    expect(runner.startAgent('session-1', 'user-1', 'for A', deps, loopFnMock, { runKey: keyA }))
      .toEqual({ status: 'started' });
    // Same session, different agent slot → runs concurrently, not already_running.
    expect(runner.startAgent('session-1', 'user-1', 'for B', deps, loopFnMock, { runKey: keyB }))
      .toEqual({ status: 'started' });
    expect(runner.isRunning(keyA)).toBe(true);
    expect(runner.isRunning(keyB)).toBe(true);
    // The loop itself still receives the SESSION id, not the run key.
    expect(loopFnMock.mock.calls[0][0]).toBe('session-1');
    expect(loopFnMock.mock.calls[1][0]).toBe('session-1');

    // Queues are per run key.
    runner.queueMessage(keyA, 'queued for A');
    expect(runner.drainMessages(keyB)).toEqual([]);
    expect(runner.drainMessages(keyA)).toEqual([{ content: 'queued for A' }]);

    // Session-scoped views see both slots.
    expect(runner.getSessionRunKeys('session-1').sort()).toEqual([keyA, keyB]);
    expect(runner.hasSessionRuns('session-1')).toBe(true);
    expect(runner.getSessionRunKeys('session-2')).toEqual([]);

    // Completing A leaves B untouched.
    deferredA.resolve();
    await runner.waitForCompletion(keyA);
    expect(runner.isRunning(keyA)).toBe(false);
    expect(runner.isRunning(keyB)).toBe(true);

    // interruptSessionRuns stops the remaining slot.
    expect(runner.interruptSessionRuns('session-1')).toEqual([keyB]);
    deferredB.resolve();
    await runner.waitForCompletion(keyB);
    expect(runner.hasSessionRuns('session-1')).toBe(false);
  });

  it('atomically steers, coalesces shutdown messages, and restarts exactly once', async () => {
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    const replacementRun = createDeferred();
    const resolverEntered = createDeferred();
    const resolverGate = createDeferred();
    loopFnMock
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(replacementRun.promise);

    const steeringDeps = {
      ...deps,
      resolveRestartLoop: vi.fn(async () => {
        resolverEntered.resolve();
        await resolverGate.promise;
        return { loopFn: loopFnMock as never, loopDeps: steeringDeps };
      }),
    } as AgentLoopDeps;

    runner.startAgent('session-a', 'user-a', { content: 'old direction' }, steeringDeps, loopFnMock);
    const oldCompletion = runner.waitForCompletion('session-a');
    const firstSignal = loopFnMock.mock.calls[0]?.[4] as AbortSignal;
    let snapshotSeenByAbortListener: ReturnType<typeof runner.collectShutdownSnapshots> | undefined;
    firstSignal.addEventListener('abort', () => {
      // abort() dispatches synchronously. Seeing the correction here proves
      // steerAgent saved it before interruption could finish the old loop.
      snapshotSeenByAbortListener = runner.collectShutdownSnapshots();
    });

    expect(runner.steerAgent('session-a', {
      content: 'use Postgres instead',
      attachments: [{ id: 'att-1' }] as never,
    })).toEqual({ status: 'steering', queuePosition: 1, steeringStarted: true });
    expect(firstSignal.aborted).toBe(true);
    expect(snapshotSeenByAbortListener).toHaveLength(1);
    expect(snapshotSeenByAbortListener![0]?.includeActiveTurn).toBe(false);
    expect(snapshotSeenByAbortListener![0]?.payloads[0]).toEqual({
      content: `${steeringResumeNotice}\n\nuse Postgres instead`,
      attachments: [{ id: 'att-1' }],
    });
    expect(snapshotSeenByAbortListener![0]?.payloads[0]?.content).not.toContain('old direction');

    expect(runner.steerAgent('session-a', {
      content: 'and rename the migration',
      attachments: [{ id: 'att-2' }] as never,
    })).toEqual({ status: 'steering', queuePosition: 2, steeringStarted: false });

    firstRun.resolve();
    await resolverEntered.promise;
    // Route resolution is asynchronous, but the stopping run still owns the
    // slot. A competing start cannot create a second replacement.
    expect(runner.isRunning('session-a')).toBe(true);
    expect(runner.startAgent('session-a', 'user-a', 'competing', steeringDeps, loopFnMock))
      .toEqual({ status: 'already_running' });
    expect(runner.steerAgent('session-a', 'keep the old API shape'))
      .toEqual({ status: 'steering', queuePosition: 3, steeringStarted: false });

    resolverGate.resolve();
    await oldCompletion;

    expect(loopFnMock).toHaveBeenCalledTimes(2);
    expect(loopFnMock.mock.calls[1]?.[2]).toEqual({
      content: [
        steeringResumeNotice,
        'use Postgres instead',
        'and rename the migration',
        'keep the old API shape',
      ].join('\n\n'),
      attachments: [{ id: 'att-1' }, { id: 'att-2' }],
    });
    expect((steeringDeps.resolveRestartLoop as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(runner.isRunning('session-a')).toBe(true);

    replacementRun.resolve();
    await runner.waitForCompletion('session-a');
    expect(runner.isRunning('session-a')).toBe(false);
  });

  it('merges a checkpointed correction with messages received while its old PID is still terminating', async () => {
    const runner = new BackgroundRunnerClass();
    const recoveryRun = createDeferred();
    const replacementRun = createDeferred();
    loopFnMock
      .mockReturnValueOnce(recoveryRun.promise)
      .mockReturnValueOnce(replacementRun.promise);
    const termination = {
      cli: 'claude' as const,
      sandboxId: 'sb-1',
      outputPath: '/tmp/old.jsonl',
      pid: 42,
      consumedLines: 0,
      deliveredMessageCount: 0,
    };

    runner.startAgent('session-a', 'user-a', {
      content: `${steeringResumeNotice}\n\nfirst correction`,
      attachments: [{ id: 'att-a' }] as never,
      harnessTermination: termination,
    }, deps, loopFnMock);
    const recoveryCompletion = runner.waitForCompletion('session-a');

    expect(runner.collectShutdownSnapshots()[0]).toMatchObject({
      includeActiveTurn: false,
      terminateOnly: false,
      knownDetachedTurn: termination,
      payloads: [{
        content: `${steeringResumeNotice}\n\nfirst correction`,
        attachments: [{ id: 'att-a' }],
      }],
    });
    expect(runner.steerAgent('session-a', {
      content: 'second correction',
      attachments: [{ id: 'att-b' }] as never,
    })).toEqual({ status: 'steering', queuePosition: 2, steeringStarted: true });

    recoveryRun.resolve();
    await recoveryCompletion;

    expect(loopFnMock).toHaveBeenCalledTimes(2);
    expect(loopFnMock.mock.calls[1]?.[2]).toEqual({
      content: `${steeringResumeNotice}\n\nfirst correction\n\nsecond correction`,
      attachments: [{ id: 'att-a' }, { id: 'att-b' }],
    });

    replacementRun.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('forgets termination metadata at the proven-dead boundary', async () => {
    const runner = new BackgroundRunnerClass();
    const recoveryRun = createDeferred();
    loopFnMock.mockReturnValueOnce(recoveryRun.promise);

    runner.startAgent('session-a', 'user-a', {
      content: 'saved correction',
      harnessTermination: {
        cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/old.jsonl', pid: 42,
        consumedLines: 0, deliveredMessageCount: 0,
      },
    }, deps, loopFnMock);
    runner.completeHarnessTerminationRecovery('session-a');

    expect(runner.collectShutdownSnapshots()[0]).toMatchObject({
      includeActiveTurn: true,
      terminateOnly: false,
      payloads: [{ content: 'saved correction' }],
    });
    expect(runner.collectShutdownSnapshots()[0]?.knownDetachedTurn).toBeUndefined();
    expect(runner.collectShutdownSnapshots()[0]?.payloads[0]?.harnessTermination).toBeUndefined();

    recoveryRun.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('closes every work-intake operation before the shutdown snapshot boundary', () => {
    const runner = new BackgroundRunnerClass();
    runner.beginShutdown();

    expect(() => runner.startAgent('session-a', 'user-a', 'message', deps, loopFnMock))
      .toThrow(/backend is restarting/i);
    expect(() => runner.queueMessage('session-a', 'message')).toThrow(/backend is restarting/i);
    expect(() => runner.steerAgent('session-a', 'message')).toThrow(/backend is restarting/i);
    expect(() => runner.stopAgent('session-a')).toThrow(/backend is restarting/i);
    expect(() => runner.interruptAgent('session-a')).toThrow(/backend is restarting/i);
    expect(() => runner.interruptSessionRuns('session-a')).toThrow(/backend is restarting/i);
  });

  it('keeps the frozen shutdown disposition when a Manual Stop arrives too late', async () => {
    const runner = new BackgroundRunnerClass();
    const turn = createDeferred();
    loopFnMock.mockReturnValueOnce(turn.promise);
    runner.startAgent('session-a', 'user-a', { content: 'keep working' }, deps, loopFnMock);
    const signal = loopFnMock.mock.calls[0]?.[4] as AbortSignal;

    runner.beginShutdown();
    const frozen = runner.collectShutdownSnapshots();
    expect(frozen).toEqual([expect.objectContaining({
      runKey: 'session-a',
      includeActiveTurn: true,
      terminateOnly: false,
      payloads: [{ content: 'keep working' }],
    })]);

    // A callback that resumed after the one-and-only snapshot cannot mutate
    // reattach into Stop. The private process-shutdown path can still abort
    // every loop using the already-frozen disposition.
    expect(() => runner.stopAgent('session-a')).toThrow(/backend is restarting/i);
    expect(signal.aborted).toBe(false);
    expect(runner.interruptAllAgents(new Error('process shutdown'))).toEqual(['session-a']);
    expect(signal.aborted).toBe(true);

    turn.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('Manual Stop overrides an already-fired steer and remains stopped', async () => {
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    loopFnMock.mockReturnValueOnce(firstRun.promise);

    runner.startAgent('session-a', 'user-a', 'old direction', deps, loopFnMock);
    const completion = runner.waitForCompletion('session-a');
    runner.steerAgent('session-a', {
      content: 'new direction', preserveAfterUserStop: true,
    });

    // Stop atomically hands the queued direction back to the service, then
    // sets the mutable stop intent even though the signal is already aborted
    // and cannot accept a different reason. The service decides which queue
    // entries are owner messages to preserve.
    expect(runner.stopAgent('session-a')).toEqual({
      status: 'stopped',
      queuedMessages: [{ content: 'new direction', preserveAfterUserStop: true }],
    });
    expect(runner.collectShutdownSnapshots()).toEqual([expect.objectContaining({
      runKey: 'session-a',
      payloads: [],
      includeActiveTurn: false,
      terminateOnly: true,
    })]);

    firstRun.resolve();
    await completion;
    expect(loopFnMock).toHaveBeenCalledTimes(1);
    expect(runner.isRunning('session-a')).toBe(false);
  });

  it('fails closed when the old detached CLI cannot be proven stopped', async () => {
    const { DetachedTurnTerminationError } = await import('../../agent/harness-turn-output.js');
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    loopFnMock.mockReturnValueOnce(firstRun.promise);

    runner.startAgent('session-a', 'user-a', 'old direction', deps, loopFnMock);
    const completion = runner.waitForCompletion('session-a');
    runner.steerAgent('session-a', 'replacement direction');
    firstRun.reject(new DetachedTurnTerminationError('still alive'));
    await completion;

    // Starting a second CLI here could overlap the first one in the same
    // native conversation and workspace, so the accepted correction is not
    // auto-launched after an unverified kill.
    expect(loopFnMock).toHaveBeenCalledTimes(1);
    expect(runner.isRunning('session-a')).toBe(false);
  });

  it('snapshots in-flight + queued messages for the shutdown checkpoint', async () => {
    const runner = new BackgroundRunnerClass();
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    loopFnMock.mockReturnValueOnce(deferredA.promise).mockReturnValueOnce(deferredB.promise);

    const persistShutdownTurn = vi.fn().mockResolvedValue(undefined);
    runner.startAgent('session-a', 'user-a', 'in flight', { ...deps, persistShutdownTurn }, loopFnMock);
    runner.queueMessage('session-a', 'queued-1');
    runner.queueMessage('session-a', 'queued-2');
    // A second session without the dep — snapshotted but not persistable.
    runner.startAgent('session-b', 'user-b', { content: 'other' }, deps, loopFnMock);

    const snapshots = runner.collectShutdownSnapshots();
    expect(snapshots).toHaveLength(2);
    const a = snapshots.find((s) => s.sessionId === 'session-a')!;
    expect(a.userId).toBe('user-a');
    expect(a.payloads).toEqual([
      { content: 'in flight' },
      { content: 'queued-1' },
      { content: 'queued-2' },
    ]);
    expect(a.persistShutdownTurn).toBe(persistShutdownTurn);
    const b = snapshots.find((s) => s.sessionId === 'session-b')!;
    expect(b.payloads).toEqual([{ content: 'other' }]);
    expect(b.persistShutdownTurn).toBeUndefined();

    // Snapshotting does not consume the queue (interrupt handles teardown).
    expect(runner.collectShutdownSnapshots()).toHaveLength(2);

    // Drain so completion doesn't restart the loop for the queued messages.
    runner.drainMessages('session-a');
    deferredA.resolve();
    deferredB.resolve();
    await runner.waitForCompletion('session-a');
    await runner.waitForCompletion('session-b');
    expect(runner.collectShutdownSnapshots()).toEqual([]);
  });

  it('freezes the detached marker with the pre-abort payload boundary', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValueOnce(deferred.promise);
    let active = {
      cli: 'claude' as const,
      sandboxId: 'sb-1',
      outputPath: '/tmp/turn.jsonl',
      pid: 42,
      consumedLines: 3,
      deliveredMessageCount: 1,
      turnStartedAt: 1,
    };
    runner.startAgent('session-a', 'user-a', 'in flight', {
      ...deps,
      captureActiveDetachedTurn: () => active,
    }, loopFnMock);

    const [snapshot] = runner.collectShutdownSnapshots();
    active = { ...active, consumedLines: 8, deliveredMessageCount: 2 };

    expect(snapshot?.knownDetachedTurn).toEqual(expect.objectContaining({
      consumedLines: 3,
      deliveredMessageCount: 1,
    }));
    deferred.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('does not checkpoint a payload after its CLI output was fully delivered', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValueOnce(deferred.promise);
    runner.startAgent('session-a', 'user-a', 'already answered', deps, loopFnMock);

    runner.completeCurrentPayload('session-a');
    expect(runner.collectShutdownSnapshots()).toEqual([]);

    deferred.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('keeps terminal detached cleanup ahead of queued work after delivery', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValueOnce(deferred.promise);
    const active = {
      cli: 'codex' as const,
      sandboxId: 'sb-1',
      outputPath: '/tmp/turn.jsonl',
      pid: 42,
      consumedLines: 5,
      deliveredMessageCount: 1,
      turnStartedAt: 1,
    };
    runner.startAgent('session-a', 'user-a', 'already answered', {
      ...deps,
      captureActiveDetachedTurn: () => active,
    }, loopFnMock);
    runner.queueMessage('session-a', 'next task');
    runner.completeCurrentPayload('session-a');

    expect(runner.collectShutdownSnapshots()[0]).toEqual(expect.objectContaining({
      knownDetachedTurn: active,
      payloads: [{ content: '' }, { content: 'next task' }],
    }));

    runner.drainMessages('session-a');
    deferred.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('does not start duplicate loops for the same session', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValue(deferred.promise);

    expect(runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock)).toEqual({ status: 'started' });
    expect(runner.startAgent('session-a', 'user-a', 'start-again', deps, loopFnMock)).toEqual({ status: 'already_running' });

    expect(loopFnMock).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('hands the completion hook the moment the slot was claimed, kept across a queued restart (note #644)', async () => {
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    const onAgentRunComplete = vi.fn().mockResolvedValue(undefined);
    deps = { ...deps, onAgentRunComplete };
    loopFnMock.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    expect(runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock, { runKey: 'session-a::agent:agent-1' })).toEqual({ status: 'started' });
    expect(runner.listRunning()).toEqual([{ runKey: 'session-a::agent:agent-1', userId: 'user-a', startedAtMs: 1_700_000_000_000 }]);
    expect(runner.queueMessage('session-a::agent:agent-1', { content: 'again', historyAlreadyPersisted: true })).toMatchObject({ status: 'queued' });

    (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(1_700_000_060_000);
    firstRun.resolve();
    await vi.waitFor(() => expect(loopFnMock).toHaveBeenCalledTimes(2));
    // The slot restarted for the queued message: same start, still one turn.
    expect(runner.listRunning()).toEqual([{ runKey: 'session-a::agent:agent-1', userId: 'user-a', startedAtMs: 1_700_000_000_000 }]);

    secondRun.resolve();
    await runner.waitForCompletion('session-a::agent:agent-1');
    expect(onAgentRunComplete).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith({ userId: 'user-a', sessionId: 'session-a', startedAtMs: 1_700_000_000_000 });
    expect(runner.listRunning()).toEqual([]);
  });

  it('tells the completion hook when a restart, not the turn, let go of the slot (note #734)', async () => {
    const runner = new BackgroundRunnerClass();
    const cut = createDeferred();
    const finishing = createDeferred();
    const onAgentRunComplete = vi.fn().mockResolvedValue(undefined);
    deps = { ...deps, onAgentRunComplete };
    loopFnMock.mockReturnValueOnce(cut.promise).mockReturnValueOnce(finishing.promise);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    runner.startAgent('session-a', 'user-a', 'still working', deps, loopFnMock, { runKey: 'session-a::agent:mia' });
    runner.startAgent('session-a', 'user-a', 'about to end', deps, loopFnMock, { runKey: 'session-a::agent:theo' });

    // The deploy: intake closes, the snapshot is taken, every loop aborted.
    runner.beginShutdown();
    runner.collectShutdownSnapshots();
    // One turn happens to end on its own in the same moment: a real end.
    finishing.resolve();
    await runner.waitForCompletion('session-a::agent:theo');
    expect(runner.interruptAllAgents(PROCESS_SHUTDOWN_ABORT_REASON)).toEqual(['session-a::agent:mia']);
    cut.resolve();
    await runner.waitForCompletion('session-a::agent:mia');

    expect(onAgentRunComplete).toHaveBeenCalledTimes(2);
    expect(onAgentRunComplete).toHaveBeenNthCalledWith(1, { userId: 'user-a', sessionId: 'session-a', startedAtMs: 1_700_000_000_000 });
    expect(onAgentRunComplete).toHaveBeenNthCalledWith(2, { userId: 'user-a', sessionId: 'session-a', startedAtMs: 1_700_000_000_000, processShutdown: true });
  });

  it('restarts a finishing loop to process messages queued during completion', async () => {
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    const onAgentRunComplete = vi.fn().mockResolvedValue(undefined);
    deps = {
      ...deps,
      onAgentRunComplete,
    };
    const lateMessage = {
      content: 'Relayed child response',
      historyAlreadyPersisted: true,
    };

    loopFnMock
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(secondRun.promise);

    expect(runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock)).toEqual({ status: 'started' });
    expect(runner.queueMessage('session-a', lateMessage)).toEqual({
      status: 'queued',
      queuePosition: 1,
    });

    firstRun.resolve();
    await runner.waitForCompletion('session-a');

    expect(loopFnMock).toHaveBeenCalledTimes(2);
    expect(loopFnMock.mock.calls[1]?.[0]).toBe('session-a');
    expect(loopFnMock.mock.calls[1]?.[1]).toBe('user-a');
    expect(loopFnMock.mock.calls[1]?.[2]).toEqual(lateMessage);
    expect(onAgentRunComplete).not.toHaveBeenCalled();
    expect(runner.isRunning('session-a')).toBe(true);

    secondRun.resolve();
    await runner.waitForCompletion('session-a');

    expect(onAgentRunComplete).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith({
      userId: 'user-a',
      sessionId: 'session-a',
      startedAtMs: expect.any(Number),
    });
    expect(runner.isRunning('session-a')).toBe(false);
  });

  it('merges everything typed during a turn into ONE next turn', async () => {
    // Telegram cuts a paste over 4096 chars into several messages: one
    // instruction arriving as N updates. Running them one at a time made the
    // agent answer each fragment on its own (live, 2026-08-11).
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    loopFnMock
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(secondRun.promise);

    runner.startAgent('session-a', 'user-a', 'fragment one', deps, loopFnMock);
    runner.queueMessage('session-a', { content: 'fragment two' });
    runner.queueMessage('session-a', {
      content: 'fragment three',
      attachments: [{ id: 'att-1' }] as never,
    });
    runner.queueMessage('session-a', { content: 'fragment four' });

    firstRun.resolve();
    await runner.waitForCompletion('session-a');

    expect(loopFnMock).toHaveBeenCalledTimes(2);
    // A blank line between them: each one was a separate send, and a bare
    // newline made two instructions read as one document. True fragments of a
    // paste are stitched at the front door and arrive here as one payload.
    expect(loopFnMock.mock.calls[1]?.[2]).toEqual({
      content: 'fragment two\n\nfragment three\n\nfragment four',
      attachments: [{ id: 'att-1' }],
    });

    secondRun.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('merges only the plain user messages, leaving a special payload its own turn', async () => {
    const runner = new BackgroundRunnerClass();
    const firstRun = createDeferred();
    const secondRun = createDeferred();
    const thirdRun = createDeferred();
    loopFnMock
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(secondRun.promise)
      .mockReturnValueOnce(thirdRun.promise);
    // Carries per-turn bookkeeping (a history row already written with its own
    // seq), so merging it into someone else's turn would lose that meaning.
    const relayed = { content: 'Relayed child response', historyAlreadyPersisted: true };

    runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock);
    runner.queueMessage('session-a', { content: 'typed one' });
    runner.queueMessage('session-a', { content: 'typed two' });
    runner.queueMessage('session-a', relayed);

    firstRun.resolve();
    await runner.waitForCompletion('session-a');
    expect(loopFnMock.mock.calls[1]?.[2]).toEqual({ content: 'typed one\n\ntyped two' });

    secondRun.resolve();
    await runner.waitForCompletion('session-a');
    expect(loopFnMock.mock.calls[2]?.[2]).toEqual(relayed);

    thirdRun.resolve();
    await runner.waitForCompletion('session-a');
  });

  it('does not restart a finishing loop after queued-message restart is suppressed', async () => {
    const runner = new BackgroundRunnerClass();
    const run = createDeferred();
    const onAgentRunComplete = vi.fn().mockResolvedValue(undefined);
    deps = {
      ...deps,
      onAgentRunComplete,
    };

    loopFnMock.mockReturnValueOnce(run.promise);

    expect(runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock)).toEqual({ status: 'started' });
    expect(runner.queueMessage('session-a', 'queued before terminal completion')).toEqual({
      status: 'queued',
      queuePosition: 1,
    });

    const loopDeps = loopFnMock.mock.calls[0]?.[3] as AgentLoopDeps;
    expect(typeof loopDeps.suppressQueuedMessageRestart).toBe('function');
    loopDeps.suppressQueuedMessageRestart?.();

    expect(runner.queueMessage('session-a', 'queued after terminal completion')).toEqual({
      status: 'queued',
      queuePosition: 1,
    });

    run.resolve();
    await runner.waitForCompletion('session-a');

    expect(loopFnMock).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledTimes(1);
    expect(onAgentRunComplete).toHaveBeenCalledWith({
      userId: 'user-a',
      sessionId: 'session-a',
      startedAtMs: expect.any(Number),
    });
    expect(runner.isRunning('session-a')).toBe(false);
    expect(runner.drainMessages('session-a')).toEqual([]);
  });

  it('interrupts a running loop using AbortController and reports state correctly', async () => {
    const runner = new BackgroundRunnerClass();
    const deferred = createDeferred();
    loopFnMock.mockReturnValueOnce(deferred.promise);

    runner.startAgent('session-a', 'user-a', 'start', deps, loopFnMock);

    const call = loopFnMock.mock.calls[0] as [string, string, string | null, AgentLoopDeps, AbortSignal];
    const signal = call[4];
    expect(signal.aborted).toBe(false);

    expect(runner.interruptAgent('session-a')).toBe(true);
    expect(signal.aborted).toBe(true);

    deferred.resolve();
    await runner.waitForCompletion('session-a');

    expect(runner.interruptAgent('session-a')).toBe(false);
    expect(runner.interruptAgent('unknown')).toBe(false);
  });

  it('interrupts all running loops and waits for their completion', async () => {
    const runner = new BackgroundRunnerClass();
    const first = createDeferred();
    const second = createDeferred();
    loopFnMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    runner.startAgent('session-a', 'user-a', 'start-a', deps, loopFnMock);
    runner.startAgent('session-b', 'user-a', 'start-b', deps, loopFnMock);

    const interrupted = runner.interruptAllAgents();

    expect(interrupted.sort()).toEqual(['session-a', 'session-b']);
    const firstSignal = loopFnMock.mock.calls[0]?.[4] as AbortSignal;
    const secondSignal = loopFnMock.mock.calls[1]?.[4] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);

    const waitPromise = runner.waitForAllCompletions(interrupted);
    first.resolve();
    second.resolve();
    await waitPromise;

    expect(runner.getRunningCount()).toBe(0);
  });

  it('emits error and completion events and persists error state when the loop fn throws', async () => {
    const runner = new BackgroundRunnerClass();
    loopFnMock.mockRejectedValueOnce(new Error('boom'));

    const capture = new EventCapture();
    capture.subscribe(eventEmitter, 'session-err');

    runner.startAgent('session-err', 'user-a', 'start', deps, loopFnMock);
    await runner.waitForCompletion('session-err');
    capture.stop();

    const events = capture.getEvents();
    assertEventSubsequence(events, ['error', 'agent_complete']);

    const errorEvent = capture.getFirstEventOfType('error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('Agent error: boom');

    expect(updateSessionMock).toHaveBeenCalledWith('user-a', 'session-err', {
      status: 'error',
      lastError: 'boom',
      lastErrorType: 'generic',
    });
    expect(runner.isRunning('session-err')).toBe(false);
  });

  it('normalizes object-shaped thrown errors before emitting and persisting them', async () => {
    const runner = new BackgroundRunnerClass();
    loopFnMock.mockRejectedValueOnce({
      error: { message: 'structured boom' },
    });

    const capture = new EventCapture();
    capture.subscribe(eventEmitter, 'session-structured-err');

    runner.startAgent('session-structured-err', 'user-a', 'start', deps, loopFnMock);
    await runner.waitForCompletion('session-structured-err');
    capture.stop();

    const errorEvent = capture.getFirstEventOfType('error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('structured boom');

    expect(updateSessionMock).toHaveBeenCalledWith('user-a', 'session-structured-err', {
      status: 'error',
      lastError: 'structured boom',
      lastErrorType: 'generic',
    });
  });

  it('suppresses user-facing error delivery when recovery already notified the user', async () => {
    const runner = new BackgroundRunnerClass();
    loopFnMock.mockRejectedValueOnce(
      new NonRecoverableAgentErrorClass('Kimi exited with code 1', { userNotified: true }),
    );
    const notifyAssistantResponse = vi.fn().mockResolvedValue(undefined);

    const capture = new EventCapture();
    capture.subscribe(eventEmitter, 'session-quiet-err');

    runner.startAgent('session-quiet-err', 'user-a', 'start', { ...deps, notifyAssistantResponse }, loopFnMock);
    await runner.waitForCompletion('session-quiet-err');
    capture.stop();

    // No user-facing delivery: the recovery flow (e.g. the harness
    // auth-failure pause message) already told the user what happened.
    expect(capture.getFirstEventOfType('error')).toBeUndefined();
    expect(notifyAssistantResponse).not.toHaveBeenCalled();
    // Completion still signals, and internal bookkeeping still records the
    // failure for the journal/debugging.
    expect(capture.getFirstEventOfType('agent_complete')).toBeDefined();
    expect(updateSessionMock).toHaveBeenCalledWith('user-a', 'session-quiet-err', {
      status: 'error',
      lastError: 'Kimi exited with code 1',
      lastErrorType: undefined,
    });
  });

  it('does not mark explicitly non-recoverable failures for generic recovery', async () => {
    const runner = new BackgroundRunnerClass();
    loopFnMock.mockRejectedValueOnce(new NonRecoverableAgentErrorClass('harness failed'));

    runner.startAgent('session-harness-error', 'user-a', 'start', deps, loopFnMock);
    await runner.waitForCompletion('session-harness-error');

    expect(updateSessionMock).toHaveBeenCalledWith('user-a', 'session-harness-error', {
      status: 'error',
      lastError: 'harness failed',
      lastErrorType: undefined,
    });
  });

  it('keeps queued messages claimed and snapshot-visible while resolving their restart route', async () => {
    const runner = new BackgroundRunnerClass();
    const runKey = 'session-race::agent:ivy';
    const firstTurn = createDeferred();
    const secondTurn = createDeferred();
    const resolveGate = createDeferred();
    const seen: string[] = [];

    const loopFn = vi.fn(async (_sessionId: string, _userId: string, message: unknown) => {
      seen.push((message as { content: string }).content);
      if (seen.length === 1) await firstTurn.promise;
      if (seen.length === 2) await secondTurn.promise;
    });
    const raceDeps = {
      ...deps,
      resolveRestartLoop: async () => {
        await resolveGate.promise;
        return { loopFn, loopDeps: raceDeps };
      },
    } as unknown as AgentLoopDeps;

    runner.startAgent('session-race', 'user-a', { content: 'first' }, raceDeps, loopFn as never, { runKey });
    // The user types a correction while the turn runs.
    runner.queueMessage(runKey, { content: 'actually, use Postgres' });

    firstTurn.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The completed loop still owns the slot and queue through the async route
    // lookup. A concurrent start cannot jump ahead, and a graceful-shutdown
    // snapshot can persist the accepted follow-up while the lookup is blocked.
    expect(runner.isRunning(runKey)).toBe(true);
    expect(runner.startAgent(
      'session-race', 'user-a', { content: 'third' }, raceDeps, loopFn as never, { runKey },
    )).toEqual({ status: 'already_running' });
    expect(runner.queueMessage(runKey, { content: 'third' })).toEqual({ status: 'queued', queuePosition: 2 });
    expect(runner.collectShutdownSnapshots()).toEqual([
      expect.objectContaining({
        runKey,
        payloads: [
          { content: 'actually, use Postgres' },
          { content: 'third' },
        ],
      }),
    ]);

    resolveGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    secondTurn.resolve();
    await runner.waitForCompletion(runKey);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen).toEqual(['first', 'actually, use Postgres\n\nthird']);
  });

  it('waitForCompletion resolves immediately for unknown session', async () => {
    const runner = new BackgroundRunnerClass();
    await expect(runner.waitForCompletion('missing-session')).resolves.toBeUndefined();
  });
});
