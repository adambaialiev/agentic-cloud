import type { AgentLoopDeps } from './agent-loop.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { HarnessTurnAttachInfo, UserInputPayload } from '../types/agent.js';
import { DetachedTurnRestartSafetyError } from './harness-turn-output.js';

export type QueueMessageResult =
  | { status: 'queued'; queuePosition: number }
  | { status: 'not_running'; queuePosition: 0 };

export type SteerMessageResult =
  | { status: 'steering'; queuePosition: number; steeringStarted: boolean }
  | { status: 'not_running'; queuePosition: 0 };

export type StartAgentResult =
  | { status: 'started' }
  | { status: 'already_running' };

export type StopAgentResult =
  | { status: 'stopped'; queuedMessages: UserInputPayload[] }
  | { status: 'not_running'; queuedMessages: [] };

/**
 * The shape BackgroundRunner drives: one turn of an agent harness. Written out
 * rather than derived from a concrete loop so no single harness owns the
 * contract that every other one has to match.
 */
export type AgentLoopFn = (
  sessionId: string,
  userId: string,
  userMessage: string | UserInputPayload | null,
  deps: AgentLoopDeps,
  signal?: AbortSignal,
) => Promise<void>;

export class BackgroundRunnerShuttingDownError extends Error {
  override readonly name = 'BackgroundRunnerShuttingDownError';
}

/**
 * Added to the ONE replacement turn created after a user steers an active
 * run. The old process may have been stopped in the middle of a command, so
 * continuing as if the workspace were pristine is unsafe.
 */
export const STEERING_RESUME_NOTICE = [
  '[Platform] The previous turn was interrupted because the user changed direction.',
  'Inspect the current workspace and any partially completed files or commands before proceeding.',
  'Then follow the merged user messages below.',
].join(' ');

type RunInterruptionIntent = 'recover' | 'steer' | 'stop';

class AgentSteeringInterrupt extends Error {
  override readonly name = 'AgentSteeringInterrupt';
}

function addSteeringResumeNotice(payload: UserInputPayload): UserInputPayload {
  if (
    payload.content === STEERING_RESUME_NOTICE
    || payload.content.startsWith(`${STEERING_RESUME_NOTICE}\n\n`)
  ) return payload;
  return {
    ...payload,
    content: payload.content
      ? `${STEERING_RESUME_NOTICE}\n\n${payload.content}`
      : STEERING_RESUME_NOTICE,
  };
}

/**
 * Plain user input — text the person typed, plus any files they sent. These
 * are the only payloads safe to merge: everything else carries per-turn
 * bookkeeping (a resumed remote turn, a relayed session, a synthetic event, a
 * history row already written with its own `seq`) whose meaning is tied to
 * running as ONE turn on its own.
 */
function isPlainUserPayload(payload: UserInputPayload): boolean {
  return !payload.harnessAttach
    && !payload.harnessTermination
    && !payload.relay
    && !payload.syntheticEvent
    && !payload.persistedMessage
    && !payload.historyAlreadyPersisted;
}

/**
 * Everything a user typed while the agent was busy is ONE next turn, not one
 * turn each.
 *
 * Telegram splits any paste over 4096 characters into separate messages, so a
 * pasted document arrives as N messages that are one instruction. Running them
 * one at a time makes the agent answer the first fragment as though it were
 * the whole thing — and then answer each remaining fragment out of context.
 * Observed live 2026-08-11: a user's 20 KB brief arrived in 3 fragments and
 * again in 5, all of them already queued before the first turn had finished,
 * and every fragment bought its own reply and its own tokens.
 *
 * Merges the LEADING RUN of plain user payloads and returns the rest
 * untouched, so a special payload behind them still runs as its own turn in
 * order.
 *
 * Joined with a BLANK line, because by the time a message reaches this queue
 * it is a separate thing the person sent: the fragments of one paste are
 * already stitched at the front door by the split-paste buffer, and arrive
 * here as a single payload. "run the tests" and, four minutes later,
 * "actually, cancel that" are two instructions, and a bare newline made them
 * read as one document.
 */
export function mergeQueuedUserPayloads(
  payloads: UserInputPayload[],
): { merged: UserInputPayload; remaining: UserInputPayload[] } {
  let mergeCount = 0;
  while (mergeCount < payloads.length && isPlainUserPayload(payloads[mergeCount])) {
    mergeCount++;
  }
  // A special payload at the head runs alone, exactly as it did before.
  if (mergeCount <= 1) {
    const [first, ...rest] = payloads;
    return { merged: first, remaining: rest };
  }

  const head = payloads.slice(0, mergeCount);
  const attachments = head.flatMap((payload) => payload.attachments ?? []);
  return {
    merged: {
      content: head.map((payload) => payload.content).filter((text) => text.length > 0).join('\n\n'),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(head.some((payload) => payload.preserveAfterUserStop)
        ? { preserveAfterUserStop: true }
        : {}),
    },
    remaining: payloads.slice(mergeCount),
  };
}

/** A failed run that must wait for fresh user input instead of generic recovery. */
export class NonRecoverableAgentError extends Error {
  override readonly name = 'NonRecoverableAgentError';
  /**
   * True when a recovery flow already sent the user its own message for this
   * failure (e.g. the harness auth-failure handler's pause-and-reconnect
   * text). The runner then skips the user-facing error delivery — repeating
   * the raw turn error after the guided message only confuses (observed
   * live 2026-07-29). Internal bookkeeping (status, lastError) still runs.
   */
  readonly userNotified: boolean;

  constructor(message: string, opts?: { userNotified?: boolean }) {
    super(message);
    this.userNotified = opts?.userNotified ?? false;
  }
}

/**
 * Manages background execution of agent loops.
 * Agent loops continue running even if the WebSocket disconnects.
 *
 * Runs are tracked by a **run key**. By default the run key IS the session id
 * (one loop per session, the historical behavior). A caller may pass an
 * explicit `runKey` to `startAgent` to give one session several independent
 * turn slots — Telegram uses `sessionId::agent:<agentId>` so each of a user's
 * agents runs (and queues) independently, letting two agents work
 * concurrently instead of contending for a single per-user slot. Every method
 * whose first parameter used to be a session id takes the run key.
 */
export class BackgroundRunner {
  private acceptingWork = true;
  private running = new Map<string, Promise<void>>();
  private loopFns = new Map<string, AgentLoopFn>();
  private abortControllers = new Map<string, AbortController>();
  private messageQueues = new Map<string, UserInputPayload[]>();
  /** Mutable because Stop must be able to override an already-aborted steer. */
  private interruptionIntents = new Map<string, RunInterruptionIntent>();
  /** What each running loop is working on, for the shutdown snapshot. */
  private runContexts = new Map<string, {
    sessionId: string;
    userId: string;
    message: UserInputPayload | null;
    deps: AgentLoopDeps;
  }>();
  /**
   * When each run slot was CLAIMED (note #644). A slot outlives the loops it
   * restarts for queued messages, and `onAgentRunComplete` fires once when
   * it finally settles — so this is the start the completion hook and the
   * working-time meter measure from, kept across those restarts.
   */
  private runStartedAt = new Map<string, number>();

  /** Close the intake gate before a process-shutdown snapshot is taken. */
  beginShutdown(): void {
    this.acceptingWork = false;
  }

  private assertAcceptingWork(): void {
    if (!this.acceptingWork) {
      throw new BackgroundRunnerShuttingDownError(
        'The backend is restarting; retry this message on the next process.',
      );
    }
  }

  /**
   * Queue a user message for a running agent run.
   * Returns whether the message was queued, plus the 1-based queue position
   * when queued.
   */
  queueMessage(runKey: string, message: string | UserInputPayload): QueueMessageResult {
    this.assertAcceptingWork();
    if (!this.running.has(runKey)) {
      return { status: 'not_running', queuePosition: 0 };
    }
    let queue = this.messageQueues.get(runKey);
    if (!queue) {
      queue = [];
      this.messageQueues.set(runKey, queue);
    }
    queue.push(typeof message === 'string' ? { content: message } : message);
    return { status: 'queued', queuePosition: queue.length };
  }

  /**
   * Mark the exact boundary where an orphaned CLI has been proven dead. Before
   * this call, new directions merge with the saved recovery payload; after it,
   * that payload is ordinary current work and a new direction may replace it.
   */
  completeHarnessTerminationRecovery(runKey: string): void {
    if (this.interruptionIntents.get(runKey) === 'recover') {
      this.interruptionIntents.delete(runKey);
    }
    const context = this.runContexts.get(runKey);
    if (context?.message?.harnessTermination || context?.message?.harnessAttach) {
      const {
        harnessTermination: _termination,
        harnessAttach: _attach,
        ...message
      } = context.message;
      this.runContexts.set(runKey, { ...context, message });
    }
  }

  /**
   * Mark the in-flight payload delivered before slower post-turn bookkeeping.
   * A SIGTERM in that tail must checkpoint only queued work, never replay the
   * already-finished prompt whose assistant output the user has received.
   */
  completeCurrentPayload(runKey: string): void {
    const context = this.runContexts.get(runKey);
    if (context) this.runContexts.set(runKey, { ...context, message: null });
  }

  /**
   * Save a user's new direction and interrupt the active turn as one
   * synchronous operation.
   *
   * The queue write happens BEFORE abort, so even a loop whose abort listener
   * finishes immediately cannot outrun the message. Further calls while the
   * process is stopping only append; the finalizer keeps owning the run slot,
   * merges the whole queue, and creates exactly one replacement turn.
   */
  steerAgent(runKey: string, message: string | UserInputPayload): SteerMessageResult {
    this.assertAcceptingWork();
    const controller = this.abortControllers.get(runKey);
    if (!controller || !this.running.has(runKey)) {
      return { status: 'not_running', queuePosition: 0 };
    }
    // Stop/delete/clear/shutdown already won this run. AbortController cannot
    // change reasons, and a later message must not flip that terminal intent
    // back into an automatic restart. The caller can wait for the stop to
    // finish and start the new message on the now-free slot.
    const currentIntent = this.interruptionIntents.get(runKey);
    if (
      currentIntent === 'stop'
      || (controller.signal.aborted && currentIntent !== 'steer')
    ) {
      return { status: 'not_running', queuePosition: 0 };
    }

    let queue = this.messageQueues.get(runKey);
    if (!queue) {
      queue = [];
      this.messageQueues.set(runKey, queue);
    }
    if (currentIntent === 'recover') {
      // The saved correction is not in-flight yet: the harness is still
      // terminating the abandoned pre-restart CLI. A later user message must
      // merge WITH that correction, not replace it. Move the current recovery
      // payload to the front exactly once; after this call intent becomes
      // `steer`, so subsequent messages simply append.
      const recoveryPayload = this.runContexts.get(runKey)?.message;
      if (recoveryPayload) {
        const { harnessTermination: _termination, ...preserved } = recoveryPayload;
        if (preserved.content || (preserved.attachments?.length ?? 0) > 0) {
          queue.unshift(preserved);
        }
      }
    }
    queue.push(typeof message === 'string' ? { content: message } : message);

    // Mutable intent, rather than AbortSignal.reason alone: AbortController
    // ignores every abort after the first, while a later Manual Stop must be
    // able to change "restart" into "discard and remain stopped".
    const steeringStarted = this.interruptionIntents.get(runKey) !== 'steer';
    this.interruptionIntents.set(runKey, 'steer');
    if (!controller.signal.aborted) {
      controller.abort(new AgentSteeringInterrupt('Agent turn steered by the user'));
      console.log(`Steering agent loop for ${runKey}`);
    }
    return { status: 'steering', queuePosition: queue.length, steeringStarted };
  }

  /**
   * Take one accepted payload back out of a run's queue before it is drained —
   * a queued peer message that expired, or that its sender withdrew. Matched
   * by identity: the caller holds the exact object it queued. `false` when it
   * is no longer there, which is how "already delivered" reads to the caller.
   */
  removeQueuedMessage(runKey: string, message: UserInputPayload): boolean {
    const queue = this.messageQueues.get(runKey);
    if (!queue) return false;
    const index = queue.indexOf(message);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  }

  /**
   * Drain all queued messages for a run. Returns and clears the queue.
   */
  drainMessages(runKey: string): UserInputPayload[] {
    const queue = this.messageQueues.get(runKey);
    if (!queue || queue.length === 0) return [];
    const messages = [...queue];
    queue.length = 0;
    return messages;
  }

  /**
   * Start an agent loop in the background.
   * The loop runs independently and continues even if the client disconnects.
   * Pass message=null to resume a previously interrupted session without
   * adding a new user message (e.g. after guest-to-auth migration).
   */
  startAgent(
    sessionId: string,
    userId: string,
    message: string | UserInputPayload | null,
    deps: AgentLoopDeps,
    loopFn: AgentLoopFn,
    opts?: { runKey?: string },
  ): StartAgentResult {
    this.assertAcceptingWork();
    const runKey = opts?.runKey ?? sessionId;
    // If this run slot is already busy, don't start again
    if (this.running.has(runKey)) {
      console.log(`Agent loop already running for ${runKey}`);
      return { status: 'already_running' };
    }

    this.interruptionIntents.delete(runKey);
    if (!this.runStartedAt.has(runKey)) this.runStartedAt.set(runKey, Date.now());
    const normalizedMessage = message === null
      ? null
      : (typeof message === 'string' ? { content: message } : message);
    if (normalizedMessage?.harnessTermination) {
      // This run owns an abandoned CLI that must be terminated before its
      // user payload can launch. Exposing that disposition here (rather than
      // only inside the harness) makes a coincident process-shutdown snapshot
      // persist terminate-then-replay semantics instead of re-attaching it.
      this.interruptionIntents.set(runKey, 'recover');
    }

    // Create AbortController for this run
    const abortController = new AbortController();
    this.abortControllers.set(runKey, abortController);
    this.loopFns.set(runKey, loopFn);
    this.runContexts.set(runKey, {
      sessionId,
      userId,
      message: normalizedMessage,
      deps,
    });

    let suppressQueuedMessageRestart = false;
    let unsafeToRestart = false;
    const loopDeps: AgentLoopDeps = {
      ...deps,
      backgroundRunner: this,
      suppressQueuedMessageRestart: () => {
        suppressQueuedMessageRestart = true;
        this.interruptionIntents.set(runKey, 'stop');
        this.drainMessages(runKey);
      },
    };

    // Fire and forget - don't await
    const promise = loopFn(sessionId, userId, message, loopDeps, abortController.signal)
      .catch((error) => {
        if (error instanceof DetachedTurnRestartSafetyError) {
          // We could not prove the old detached CLI is gone. Starting queued
          // work now could overlap it in the same native conversation and
          // workspace, so fail closed and ask for a later fresh message.
          unsafeToRestart = true;
          this.interruptionIntents.set(runKey, 'stop');
        }
        console.error(`Agent loop error for session ${sessionId}:`, error);
        const errorMsg = getErrorMessage(error, 'Unknown agent error');
        const userAlreadyNotified = error instanceof NonRecoverableAgentError && error.userNotified;
        // Notify connected clients
        try {
          if (!userAlreadyNotified) {
            deps.eventEmitter.emit(sessionId, {
              type: 'error',
              sessionId,
              data: { message: `Agent error: ${errorMsg}` },
              timestamp: new Date().toISOString(),
            });
          }
          deps.eventEmitter.emit(sessionId, {
            type: 'agent_complete',
            sessionId,
            data: {},
            timestamp: new Date().toISOString(),
          });
          if (!userAlreadyNotified) {
            void deps.notifyAssistantResponse?.({
              userId,
              sessionId,
              content: [
                'The delegated session encountered an error.',
                '',
                errorMsg,
              ].join('\n'),
            });
          }
        } catch { /* ignore emit failures */ }
        // Persist error status
        const lastErrorType = error instanceof NonRecoverableAgentError ? undefined : 'generic';
        deps.sessionStorage.updateSession(userId, sessionId, {
          status: 'error',
          lastError: errorMsg,
          lastErrorType,
        }).catch(() => {});
      })
      .finally(async () => {
        // Keep this run claimed while resolving the route for ANY accepted
        // follow-up, not just steering. A shutdown snapshot can then still see
        // and persist the queue, and an inbound request cannot take a free slot
        // between the old promise settling and the replacement starting.
        while (!suppressQueuedMessageRestart && !unsafeToRestart) {
          const intent = this.interruptionIntents.get(runKey);
          const steeringRestart = abortController.signal.aborted && intent === 'steer';
          const normalRestart = !abortController.signal.aborted && intent !== 'stop';
          if (!steeringRestart && !normalRestart) break;

          const previewMessages = [...(this.messageQueues.get(runKey) ?? [])];
          if (previewMessages.length === 0) break;
          const { merged: previewMessage } = mergeQueuedUserPayloads(previewMessages);

          // The old loop has settled. During the asynchronous route lookup a
          // process-shutdown snapshot must persist only the accepted queue,
          // never replay the payload that just completed or failed.
          if (!steeringRestart) this.completeCurrentPayload(runKey);

          let restartLoopFn = loopFn;
          let restartDeps = deps;
          if (deps.resolveRestartLoop) {
            try {
              const resolved = await deps.resolveRestartLoop(previewMessage);
              restartLoopFn = resolved.loopFn;
              restartDeps = resolved.loopDeps;
            } catch (error) {
              console.error(
                `Failed to re-resolve ${steeringRestart ? 'steering ' : ''}restart route for ${runKey}; restarting with the original loop:`,
                error,
              );
            }
          }

          const finalIntent = this.interruptionIntents.get(runKey);
          // A user can steer during a normal route lookup. Re-run the lookup
          // under steering semantics so the final merged payload receives the
          // interruption notice and Manual Stop still gets the last word.
          if (!steeringRestart && abortController.signal.aborted && finalIntent === 'steer') {
            continue;
          }
          const restartStillAllowed = steeringRestart
            ? abortController.signal.aborted && finalIntent === 'steer'
            : !abortController.signal.aborted && finalIntent !== 'stop';
          if (!restartStillAllowed || suppressQueuedMessageRestart || unsafeToRestart) break;

          // Nothing asynchronous below this point until startAgent has claimed
          // the same run key. Drain at the last possible moment so every
          // message received during shutdown joins this one replacement.
          const queuedMessages = this.drainMessages(runKey);
          this.running.delete(runKey);
          this.abortControllers.delete(runKey);
          this.loopFns.delete(runKey);
          this.messageQueues.delete(runKey);
          this.runContexts.delete(runKey);
          this.interruptionIntents.delete(runKey);
          if (queuedMessages.length === 0) break;

          const { merged, remaining } = mergeQueuedUserPayloads(queuedMessages);
          const nextMessage = steeringRestart ? addSteeringResumeNotice(merged) : merged;
          const mergedCount = queuedMessages.length - remaining.length;
          console.log(
            steeringRestart
              ? `Restarting agent loop for ${runKey} after steering with ${queuedMessages.length} message(s)`
                + (mergedCount > 1 ? ` (${mergedCount} merged into one turn)` : '')
              : `Restarting agent loop for ${runKey} to process ${queuedMessages.length} queued message(s) accepted during completion`
                + (mergedCount > 1 ? ` (${mergedCount} merged into one turn)` : ''),
          );
          const restartResult = this.startAgent(
            sessionId, userId, nextMessage, restartDeps, restartLoopFn, { runKey },
          );
          if (restartResult.status === 'started') {
            for (const queued of remaining) this.queueMessage(runKey, queued);
            return;
          }

          // startAgent is synchronous and the slot was removed immediately
          // above, so this is only possible through re-entrant code. Preserve
          // every accepted payload with whoever claimed the slot.
          const undelivered = [nextMessage, ...remaining];
          if (this.queueMessage(runKey, undelivered[0]).status === 'queued') {
            for (const queued of undelivered.slice(1)) this.queueMessage(runKey, queued);
            return;
          }
          console.warn(
            `Failed to restart agent loop for ${runKey}; queued messages need external recovery`,
          );
          break;
        }

        // Stop, process shutdown, and restart-safety failures deliberately do
        // not launch queued work in this process. A graceful shutdown already
        // froze it above; Manual Stop handed its queue back to the caller.
        if (abortController.signal.aborted || suppressQueuedMessageRestart || unsafeToRestart) {
          this.drainMessages(runKey);
        }
        this.running.delete(runKey);
        this.abortControllers.delete(runKey);
        this.loopFns.delete(runKey);
        this.messageQueues.delete(runKey);
        this.runContexts.delete(runKey);
        this.interruptionIntents.delete(runKey);
        const startedAtMs = this.runStartedAt.get(runKey) ?? Date.now();
        this.runStartedAt.delete(runKey);
        // Let go because THIS PROCESS is restarting (note #734), not because
        // the turn ended: the CLI is left running on its machine and the next
        // process re-attaches it, or replays the checkpointed message, and
        // that run's completion is the turn's end. Every shutdown abort lands
        // after the intake gate closed, so an aborted slot settling past it
        // was cut by the restart; one that ends on its own still completes.
        const processShutdown = abortController.signal.aborted && !this.acceptingWork;
        try {
          await loopDeps.onAgentRunComplete?.({ userId, sessionId, startedAtMs, ...(processShutdown ? { processShutdown: true } : {}) });
        } catch (error) {
          console.error(`Agent completion hook failed for session ${sessionId}:`, error);
        }
        console.log(processShutdown ? `Agent loop left to the next process for ${runKey}` : `Agent loop completed for ${runKey}`);
      });

    this.running.set(runKey, promise);
    console.log(`Started agent loop for ${runKey}`);
    return { status: 'started' };
  }

  /**
   * Interrupt a running agent loop.
   * Returns true if the agent was running and interrupt was triggered.
   */
  interruptAgent(runKey: string, reason?: unknown): boolean {
    // Once the shutdown snapshot is frozen, a late user Stop must not rewrite
    // its disposition from reattach to discard. The process-wide shutdown
    // uses the private bypass below immediately after taking that snapshot.
    this.assertAcceptingWork();
    return this.interruptAgentAfterSnapshot(runKey, reason);
  }

  /**
   * Atomically remove queued work from this run and turn it into Manual Stop.
   * The caller owns the removed payloads: direct owner messages can be held
   * for a later turn while peer/platform work is settled as undelivered.
   */
  stopAgent(runKey: string, reason?: unknown): StopAgentResult {
    this.assertAcceptingWork();
    if (!this.running.has(runKey) || !this.abortControllers.has(runKey)) {
      return { status: 'not_running', queuedMessages: [] };
    }
    const queuedMessages = this.drainMessages(runKey);
    this.interruptAgentAfterSnapshot(runKey, reason);
    return { status: 'stopped', queuedMessages };
  }

  private interruptAgentAfterSnapshot(runKey: string, reason?: unknown): boolean {
    const controller = this.abortControllers.get(runKey);
    if (controller) {
      // Manual Stop/delete/clear/shutdown all use this operation. It overrides
      // a pending steer even though AbortController itself cannot be aborted a
      // second time with a new reason; the finalizer reads this mutable state.
      this.interruptionIntents.set(runKey, 'stop');
      controller.abort(reason);
      console.log(`Interrupted agent loop for ${runKey}`);
      return true;
    }
    return false;
  }

  /**
   * Check if an agent loop is currently running for a run key.
   */
  isRunning(runKey: string): boolean {
    return this.running.has(runKey);
  }

  /** Every claimed run slot, with its owner and when it was claimed. */
  listRunning(): Array<{ runKey: string; userId: string; startedAtMs: number }> {
    const runs: Array<{ runKey: string; userId: string; startedAtMs: number }> = [];
    for (const runKey of this.running.keys()) {
      const context = this.runContexts.get(runKey);
      if (!context) continue;
      runs.push({ runKey, userId: context.userId, startedAtMs: this.runStartedAt.get(runKey) ?? Date.now() });
    }
    return runs;
  }

  /** Whether a run is currently running with this exact loop implementation. */
  isRunningWithLoopFn(runKey: string, loopFn: AgentLoopFn): boolean {
    return this.running.has(runKey) && this.loopFns.get(runKey) === loopFn;
  }

  /**
   * All run keys belonging to a session: the bare session key plus any
   * per-agent slots (`sessionId::agent:<id>`). Lets session-scoped operations
   * (/clear, the idle reaper's activity check) see every concurrent run.
   */
  getSessionRunKeys(sessionId: string): string[] {
    const prefix = `${sessionId}::`;
    return Array.from(this.running.keys()).filter(
      (key) => key === sessionId || key.startsWith(prefix),
    );
  }

  /** Whether ANY run (setup loop or any agent slot) is active for a session. */
  hasSessionRuns(sessionId: string): boolean {
    return this.getSessionRunKeys(sessionId).length > 0;
  }

  /** Interrupt every run belonging to a session; returns the affected keys. */
  interruptSessionRuns(sessionId: string, reason?: unknown): string[] {
    this.assertAcceptingWork();
    const keys = this.getSessionRunKeys(sessionId);
    return keys.filter((key) => this.interruptAgent(key, reason));
  }

  /**
   * Get all currently running run keys.
   */
  getRunningSessionIds(): string[] {
    return Array.from(this.running.keys());
  }

  /**
   * Get the count of running agent loops.
   */
  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Wait for a specific session to complete (mainly for testing).
   */
  async waitForCompletion(sessionId: string): Promise<void> {
    const promise = this.running.get(sessionId);
    if (promise) {
      await promise;
    }
  }

  /**
   * Interrupt every running agent loop and return the affected session IDs.
   */
  interruptAllAgents(reason?: unknown): string[] {
    const sessionIds = this.getRunningSessionIds();
    return sessionIds.filter((sessionId) => this.interruptAgentAfterSnapshot(sessionId, reason));
  }

  /**
   * Snapshot every running session's in-flight message + queued messages, for
   * the graceful-shutdown handler. Must be called BEFORE interrupting: the
   * abort path clears the queues, and the in-flight message exists only here.
   * Sessions whose deps provide `persistShutdownTurn` can have their snapshot
   * persisted so the next boot resumes the turn instead of dropping it.
   */
  collectShutdownSnapshots(): Array<{
    runKey: string;
    sessionId: string;
    userId: string;
    payloads: UserInputPayload[];
    includeActiveTurn: boolean;
    terminateOnly: boolean;
    knownDetachedTurn?: HarnessTurnAttachInfo;
    persistShutdownTurn?: AgentLoopDeps['persistShutdownTurn'];
  }> {
    const snapshots: Array<{
      runKey: string;
      sessionId: string;
      userId: string;
      payloads: UserInputPayload[];
      includeActiveTurn: boolean;
      terminateOnly: boolean;
      knownDetachedTurn?: HarnessTurnAttachInfo;
      persistShutdownTurn?: AgentLoopDeps['persistShutdownTurn'];
    }> = [];
    for (const runKey of this.getRunningSessionIds()) {
      const context = this.runContexts.get(runKey);
      if (!context) continue;
      const intent = this.interruptionIntents.get(runKey);
      // Manual Stop/delete/clear has already decided this run must remain
      // stopped. If its remote kill is still being verified, persist a
      // cleanup-only checkpoint: the next backend may terminate the old CLI,
      // but must never replay the discarded user work.
      const terminateOnly = intent === 'stop';
      // A normal turn survives by re-attaching to its detached CLI and keeps
      // its in-flight payload for fallback if the machine lost the process.
      // A steered turn is the opposite: the old CLI is being abandoned, so
      // checkpoint only the new direction and explicitly omit its attach info.
      const includeActiveTurn = intent === undefined;
      const steeringQueue = intent === 'steer'
        ? [...(this.messageQueues.get(runKey) ?? [])]
        : [];
      const steeringPayloads = steeringQueue.length > 0
        ? (() => {
          const { merged, remaining } = mergeQueuedUserPayloads(steeringQueue);
          return [addSteeringResumeNotice(merged), ...remaining];
        })()
        : [];
      const recoveryMessage = context.message
        ? (() => {
          const { harnessTermination: _termination, ...payload } = context.message;
          return payload;
        })()
        : undefined;
      // Freeze the remote-turn marker at the same pre-abort boundary as the
      // payload queue. Reading the live registry later, while checkpoint I/O
      // is underway, can observe a poll that consumed output after shutdown
      // deliberately stopped delivery and make boot skip that output.
      const knownDetachedTurn = context.deps.captureActiveDetachedTurn?.()
        ?? context.message?.harnessTermination
        ?? context.message?.harnessAttach;
      let payloads = terminateOnly
        ? []
        : intent === 'steer'
          ? steeringPayloads
          : intent === 'recover'
            ? [
              ...(recoveryMessage ? [recoveryMessage] : []),
              ...(this.messageQueues.get(runKey) ?? []),
            ]
            : [
              ...(context.message ? [context.message] : []),
              ...(this.messageQueues.get(runKey) ?? []),
            ];
      if (
        !terminateOnly
        && intent === undefined
        && context.message === null
        && knownDetachedTurn
      ) {
        // The CLI completed and delivered its output, but its terminal
        // fence/sidecar cleanup was still in flight at the snapshot boundary.
        // Reattach with an empty cleanup payload; queued user work must stay
        // behind it or the harness would consume the first queued instruction
        // merely as fallback metadata for the already-finished turn.
        payloads = [{ content: '' }, ...payloads];
      }
      if (payloads.length === 0 && !terminateOnly) continue;
      snapshots.push({
        runKey,
        sessionId: context.sessionId,
        userId: context.userId,
        payloads,
        includeActiveTurn,
        terminateOnly,
        ...(knownDetachedTurn ? { knownDetachedTurn } : {}),
        persistShutdownTurn: context.deps.persistShutdownTurn,
      });
    }
    return snapshots;
  }

  /**
   * Wait for all currently tracked loops, or a provided snapshot of session IDs.
   */
  async waitForAllCompletions(sessionIds = this.getRunningSessionIds()): Promise<void> {
    await Promise.all(sessionIds.map((sessionId) => this.waitForCompletion(sessionId)));
  }
}

// Singleton instance for the application
export const globalBackgroundRunner = new BackgroundRunner();
