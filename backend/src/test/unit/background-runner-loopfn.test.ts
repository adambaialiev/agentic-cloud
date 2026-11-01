import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopDeps } from '../../agent/agent-loop.js';
import { AgentEventEmitter } from '../../agent/agent-event-emitter.js';

describe('BackgroundRunner custom loop functions', () => {
  let BackgroundRunnerClass: typeof import('../../agent/background-runner.js').BackgroundRunner;
  let otherLoopMock: ReturnType<typeof vi.fn>;
  let deps: AgentLoopDeps;

  beforeEach(async () => {
    vi.resetModules();

    otherLoopMock = vi.fn().mockResolvedValue(undefined);
    const mod = await import('../../agent/background-runner.js');
    BackgroundRunnerClass = mod.BackgroundRunner;

    deps = {
      sessionStorage: {
        updateSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentLoopDeps['sessionStorage'],
      eventEmitter: new AgentEventEmitter(),
      toolExecutor: {} as AgentLoopDeps['toolExecutor'],
      aiModel: 'mock-model',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('runs the loop function it was given and no other', async () => {
    const runner = new BackgroundRunnerClass();
    const customLoop = vi.fn().mockResolvedValue(undefined);

    runner.startAgent('session-a', 'user-1', 'hello', deps, customLoop);
    expect(runner.isRunningWithLoopFn('session-a', customLoop)).toBe(true);
    expect(runner.isRunningWithLoopFn('session-a', otherLoopMock)).toBe(false);
    await runner.waitForCompletion('session-a');

    expect(customLoop).toHaveBeenCalledTimes(1);
    expect(otherLoopMock).not.toHaveBeenCalled();
    expect(runner.isRunningWithLoopFn('session-a', customLoop)).toBe(false);
  });

  it('restarts with the same custom loop function for late-queued messages', async () => {
    const runner = new BackgroundRunnerClass();
    let firstRunFinished!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      firstRunFinished = resolve;
    });
    const customLoop = vi.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);

    runner.startAgent('session-a', 'user-1', 'first', deps, customLoop);
    expect(runner.queueMessage('session-a', 'second')).toMatchObject({ status: 'queued' });

    firstRunFinished();
    await runner.waitForCompletion('session-a');
    await vi.waitFor(() => {
      expect(customLoop).toHaveBeenCalledTimes(2);
    });

    expect(customLoop.mock.calls[1][2]).toEqual({ content: 'second' });
    expect(otherLoopMock).not.toHaveBeenCalled();
  });
});
