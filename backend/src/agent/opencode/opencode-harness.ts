/**
 * Agent harness backed by the OpenCode CLI (note #780) running inside the
 * agent's machine, on the member's own OpenCode Go subscription: one API key
 * from the OpenCode console, held as a seat and handed to each turn in its
 * environment.
 *
 * The same shape as the Codex harness, on purpose — it implements
 * `AgentLoopFn`, so BackgroundRunner's queueing, steering, Stop and restart
 * recovery are reused unchanged. Each turn is one `opencode run --format
 * json`, launched DETACHED on the machine (harness-turn-output.ts) so a deploy
 * does not kill it; its JSONL stream is redirected to a per-turn file and
 * polled back. See opencode-events.ts for what that stream says and
 * opencode-command.ts for how the command is built.
 *
 * Usage is billed to the member's OpenCode subscription — deliberately no
 * model-usage billing here.
 */

import type { AgentLoopDeps } from '../agent-loop.js';
import { dedicatedLimitMessage, modelLimitMessage, NO_SEAT_MESSAGE, paymentRequiredMessage } from '../platform-turn-policy.js';
import { NonRecoverableAgentError, type AgentLoopFn } from '../background-runner.js';
import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { HarnessTurnAttachInfo, UserInputPayload, WSMessage, WSMessageType } from '../../types/agent.js';
import { buildRuntimeChangeNote, modelCatalogForCli, resolveEffectiveEffort, resolveEffectiveModel } from '../harness-models.js';
import {
  DEFAULT_DEVELOPMENT_SSH_USER,
  getDefaultDevelopmentRootForSshUser,
} from '../../services/development-root.js';
import {
  DetachedTurnContinuityError,
  type DetachedTurnHandle,
  DetachedTurnRestartSafetyError,
  DetachedTurnTerminationError,
  TurnOutputReader,
  buildTurnOutputPath,
  clearActiveDetachedTurn,
  getActiveDetachedTurn,
  isHarnessShutdownInProgress,
  inspectDetachedTurnUntilKnown,
  killDetachedTurnUntilGone,
  redactHarnessSecrets,
  registerActiveDetachedTurn,
  sleepUnlessAborted,
  startDetachedTurn,
  terminateDetachedTurnBeforeRestart,
  updateActiveDetachedTurn,
} from '../harness-turn-output.js';
import { isProcessShutdownAbort } from '../abort-reason.js';
import { resolveUserSecretEnv } from '../../services/user-secrets.js';
import { stripAnsiEscapes } from '../codex/codex-exec-events.js';
import {
  openCodeErrorBody,
  openCodeErrorMessage,
  openCodeErrorStatus,
  openCodePromptTokens,
  openCodeSessionId,
  openCodeStepTokens,
  openCodeText,
  openCodeToolSummary,
  parseOpenCodeEventLine,
  type OpenCodeRunEvent,
} from './opencode-events.js';
import { buildOpenCodeRunCommand, OPENCODE_API_KEY_ENV, OPENCODE_TURN_ENV_DEFAULTS } from './opencode-command.js';
import { buildContextUsageNote } from '../../utils/context-window.js';
import { isOpenCodeAuthFailureText, isOpenCodeUsageLimitText, usageLimitCooldownSeconds } from '../harness-auth-failure.js';
import type {
  PlatformUserLease,
  PlatformCredentialLease,
  PlatformCredentialLeaseOutcome,
} from '../../types/platform-credential.js';
import {
  extractOutboundAttachments,
  fetchOutboundAttachment,
  outboundFileOf,
  type OutboundFile,
  getStageableHarnessAttachments,
  stageHarnessAttachments,
} from '../harness-attachments.js';
import { creditTurnTokens, OpenCodeTurnTokens } from '../turn-tokens.js';
import type { TokenCounts } from '../../services/agent-token-ledger.js';

export interface OpenCodeHarnessDeps {
  sandboxClient: WorkspaceRuntimeClient;
  /** Resolves the user's sandbox when the session doc doesn't carry one. */
  resolveDefaultSandboxId: (userId: string) => Promise<string | null>;
  /**
   * The CLI install running on this machine right now, if any
   * (`HarnessCliUpdater.installInFlight`) — a turn waits it out rather than
   * start a binary that is half-replaced (2026-10-15).
   */
  cliInstallInFlight?: (sandboxId: string) => Promise<void> | undefined;
}

// The non-root `agent` user, in its home: where AGENTS.md is, which OpenCode
// reads from the directory it runs in, and where its sessions live
// (~/.local/share/opencode/opencode.db — the durable home, so a session
// survives the machine sleeping).
const HARNESS_SSH_USER = DEFAULT_DEVELOPMENT_SSH_USER;
const HARNESS_CWD = getDefaultDevelopmentRootForSshUser(HARNESS_SSH_USER);

// Killed for silence, not for length — the twin constants in the other two
// harnesses say why. OpenCode's own retries are not silence the member should
// wait out: the platform plugin ends a turn at a limit long before this.
const STALL_TIMEOUT_MS = 15 * 60_000;
const POLL_TIMEOUT_MS = 2_500;
const ERROR_TAIL_CHARS = 600;

function harnessLog(sessionId: string, message: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.info(`[opencode-harness] [${sessionId}] ${message}${suffix}`);
}

export const OPENCODE_WORKSPACE_UNAVAILABLE_MESSAGE = [
  "Couldn't start your workspace.",
  'Try again in a moment.',
].join('\n');

export const OPENCODE_PLATFORM_CAPACITY_MESSAGE =
  'All hands are busy right now — please send that again in a few minutes.';
export const OPENCODE_PLATFORM_HICCUP_MESSAGE =
  'Hit a brief hiccup on our side. Please send that message again — it should go through now.';

export const OPENCODE_TURN_STALLED_MESSAGE = 'OpenCode went quiet — no activity for 15 minutes, so the turn was stopped. The conversation is saved: send a message to pick up where it left off.';

/**
 * Said when the OpenCode key itself was refused. The seat is benched as dead
 * by the pool, so the member's next step is a new key on the Subscriptions
 * screen — never a retry of the same one.
 */
export const OPENCODE_KEY_REFUSED_MESSAGE = 'OpenCode refused this subscription\'s key — it may have been deleted or replaced in the OpenCode console. Add a fresh key under Subscriptions, then send your message again.';

/** The stored session id is OpenCode's, or nothing: an id of another harness never resumes here. */
function storedOpenCodeSessionId(value: string | undefined): string | undefined {
  return value && value.startsWith('ses_') ? value : undefined;
}

export function createOpenCodeHarnessRunner(harnessDeps: OpenCodeHarnessDeps): AgentLoopFn {
  return async function runOpenCodeHarness(
    sessionId: string,
    userId: string,
    message: string | UserInputPayload | null,
    deps: AgentLoopDeps,
    signal?: AbortSignal,
  ): Promise<void> {
    const payload: UserInputPayload | null = typeof message === 'string'
      ? { content: message }
      : message;
    const content = payload?.content?.trim() ?? '';
    const stageableAttachments = getStageableHarnessAttachments(payload?.attachments);
    if (
      !content
      && stageableAttachments.length === 0
      && !payload?.harnessTermination
      && !payload?.harnessAttach
    ) return;

    const emit = (type: WSMessageType, data: unknown): void => {
      const wsMessage: WSMessage = {
        type,
        sessionId,
        data,
        timestamp: new Date().toISOString(),
      };
      deps.eventEmitter.emit(sessionId, wsMessage);
    };

    const session = await deps.sessionStorage.getSession(userId, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for OpenCode harness run.`);
    }
    const profile = await deps.userStorage?.getProfile(userId);
    const targetAgent = deps.telegramTargetAgentId
      ? profile?.telegram?.agents?.[deps.telegramTargetAgentId]
      : undefined;
    // Always a concrete model: OpenCode's own default would be whatever its
    // config last named, which is not a choice anyone made here.
    const requestedModel = resolveEffectiveModel('opencode', targetAgent?.model);
    const requestedEffort = resolveEffectiveEffort('opencode', targetAgent?.model, targetAgent?.effort) || undefined;
    // Continuity lives on the agent record only — there is no legacy
    // session-document field for a harness that arrived after agents did.
    let storedSessionId = storedOpenCodeSessionId(targetAgent?.conversation?.opencodeSessionId);

    const runKey = deps.telegramTargetAgentId
      ? `${sessionId}::agent:${deps.telegramTargetAgentId}`
      : sessionId;
    let attachInfo = payload?.harnessAttach?.cli === 'opencode' ? payload.harnessAttach : undefined;
    const abandonedTurn = payload?.harnessTermination
      ?? (attachInfo ? undefined : getActiveDetachedTurn(runKey));
    let runStarted = false;
    const markRunStarted = async (): Promise<void> => {
      if (runStarted) return;
      runStarted = true;
      emit('agent_start', { runStartedAt: new Date().toISOString() });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'running' }).catch((error) => {
        console.warn(`[opencode-harness] Could not mark ${sessionId} running; continuing turn:`, error);
      });
    };
    const captureRecoveredContinuity = async (lines: string[]): Promise<void> => {
      for (const line of lines) {
        const event = parseOpenCodeEventLine(line);
        if (!event || event.type === 'platform_limit') continue;
        const recoveredId = openCodeSessionId(event);
        if (!recoveredId || recoveredId === storedSessionId) continue;
        await deps.userStorage?.updateTelegramHarnessConversation(
          userId,
          { opencodeSessionId: recoveredId },
          targetAgent ? { agentId: targetAgent.id } : undefined,
        );
        storedSessionId = recoveredId;
      }
    };
    let recoveryNeedsTerminalAcknowledgement = false;
    const acknowledgeTerminalRecovery = async (): Promise<void> => {
      if (!recoveryNeedsTerminalAcknowledgement) return;
      const acknowledged = await deps.acknowledgeHarnessRecovery?.(signal, true);
      if (acknowledged !== false) {
        deps.backgroundRunner?.completeHarnessTerminationRecovery?.(runKey);
        recoveryNeedsTerminalAcknowledgement = false;
      }
    };
    const finishWith = async (text: string): Promise<void> => {
      await deliverAssistantMessage({ deps, userId, sessionId, content: text, emit });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
      emit('agent_complete', {});
      await acknowledgeTerminalRecovery();
    };
    return await (async () => {
    if (abandonedTurn) {
      await markRunStarted();
      await terminateDetachedTurnBeforeRestart(
        harnessDeps.sandboxClient,
        runKey,
        abandonedTurn,
        captureRecoveredContinuity,
        HARNESS_SSH_USER,
      );
      recoveryNeedsTerminalAcknowledgement = true;
      if (signal?.aborted || (!content && stageableAttachments.length === 0)) {
        await acknowledgeTerminalRecovery();
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
        emit('agent_interrupted', {});
        return;
      }
    }

    let attachProbe: 'running' | 'finished' | 'unknown' | undefined;
    if (attachInfo) {
      // A surviving process already holds its key and is running: claim and
      // probe it before any fresh-launch-only gate can release its slot.
      registerActiveDetachedTurn(runKey, attachInfo);
      const inspected = await inspectDetachedTurnUntilKnown(
        harnessDeps.sandboxClient,
        attachInfo.sandboxId,
        attachInfo.outputPath,
        HARNESS_SSH_USER,
        attachInfo.pid <= 0 ? undefined : signal,
      );
      const state = inspected.state;
      if (state === 'gone') {
        await markRunStarted();
        await terminateDetachedTurnBeforeRestart(
          harnessDeps.sandboxClient,
          runKey,
          attachInfo,
          captureRecoveredContinuity,
          HARNESS_SSH_USER,
        );
        recoveryNeedsTerminalAcknowledgement = true;
        attachInfo = undefined;
      } else {
        if (state === 'running' && inspected.pid && inspected.pid !== attachInfo.pid) {
          attachInfo = { ...attachInfo, pid: inspected.pid };
          registerActiveDetachedTurn(runKey, attachInfo);
        } else if (state === 'running' && attachInfo.pid <= 0 && !inspected.pid) {
          throw new DetachedTurnTerminationError(
            `OpenCode turn ${attachInfo.outputPath} is running, but its launch PID is unresolved.`,
          );
        }
        attachProbe = state;
      }
    }
    if (recoveryNeedsTerminalAcknowledgement && !content && stageableAttachments.length === 0) {
      await acknowledgeTerminalRecovery();
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
      emit('agent_interrupted', {});
      return;
    }

    let sandboxId = attachInfo?.sandboxId ?? deps.telegramTargetSandboxId ?? session.sandboxId;
    if (!sandboxId) {
      try {
        sandboxId = (await harnessDeps.resolveDefaultSandboxId(userId)) ?? undefined;
      } catch (error) {
        console.error(`[opencode-harness] Failed to provision sandbox for ${userId}:`, error);
        sandboxId = undefined;
      }
    }
    if (!sandboxId) {
      await finishWith(OPENCODE_WORKSPACE_UNAVAILABLE_MESSAGE);
      return;
    }
    await markRunStarted();

    // The member's OpenCode seat: its key IS the auth, handed to this one
    // turn in its environment and never written to the machine's disk.
    // Wherever the pool is wired every turn leases; a backend without one
    // (local development) runs on whatever the machine's own OpenCode holds.
    const usePlatformCredentials = Boolean(deps.platformCredentialPool);
    let platformLease: PlatformCredentialLease | undefined;
    let platformLeaseKind: 'dedicated' | 'limbo' | undefined;
    let leaseOutcome: PlatformCredentialLeaseOutcome = { kind: 'error' };
    if (!attachInfo && usePlatformCredentials) {
      let userLease: PlatformUserLease | undefined;
      try {
        // Naming the model lets the pool pass over a seat whose cooldown is
        // that model's alone: Go's limits are per model, and the rest of the
        // subscription still runs.
        userLease = await deps.platformCredentialPool!.leaseForUser('opencode', userId, {
          ...(targetAgent?.orgId ? { orgId: targetAgent.orgId } : {}),
          model: requestedModel,
          ...(targetAgent?.seatId ? { seatId: targetAgent.seatId } : {}),
        });
      } catch (error) {
        console.error(`[opencode-harness] Platform credential lease failed for ${userId}:`, error);
      }
      if (userLease?.kind === 'payment_required') {
        await finishWith(paymentRequiredMessage('OpenCode'));
        return;
      }
      if (userLease?.kind === 'dedicated_exhausted') {
        const resetMs = userLease.resetAt ? Date.parse(userLease.resetAt) : Number.NaN;
        await Promise.resolve(deps.onHarnessUsageLimit?.({
          cli: 'opencode',
          ...(Number.isFinite(resetMs) ? { resetAt: new Date(resetMs).toISOString() } : {}),
        })).catch(() => {});
        const resetAt = Number.isFinite(resetMs) ? new Date(resetMs) : undefined;
        await finishWith(userLease.model ? modelLimitMessage(userLease.model, resetAt) : dedicatedLimitMessage(resetAt));
        return;
      }
      platformLease = (userLease?.kind === 'dedicated' || userLease?.kind === 'limbo')
        ? userLease.lease ?? undefined
        : undefined;
      platformLeaseKind = platformLease ? userLease?.kind as 'dedicated' | 'limbo' : undefined;
      if (!platformLease) {
        harnessLog(sessionId, 'no platform credential leasable', { userId });
        const noSeat = userLease?.kind === 'limbo' && !userLease.lease;
        if (noSeat && deps.onHarnessAuthFailure) {
          await deps.onHarnessAuthFailure({ cli: 'opencode', reason: 'no_seat' }).catch(() => {});
          await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
          emit('agent_complete', {});
          await acknowledgeTerminalRecovery();
          return;
        }
        await finishWith(noSeat ? NO_SEAT_MESSAGE : OPENCODE_PLATFORM_CAPACITY_MESSAGE);
        return;
      }
    }
    const apiKey = platformLease?.token;

    let prompt = content;
    if (!attachInfo && stageableAttachments.length > 0) {
      const attachmentNote = await stageHarnessAttachments({
        sandboxClient: harnessDeps.sandboxClient,
        sandboxId,
        sshUser: HARNESS_SSH_USER,
        homeDir: HARNESS_CWD,
        sessionId,
        attachments: stageableAttachments,
        mediaStorage: deps.mediaStorage,
      });
      if (attachmentNote) {
        prompt = content ? `${content}\n\n${attachmentNote}` : attachmentNote;
      }
    }

    const runtimeNote = attachInfo ? null : buildRuntimeChangeNote(targetAgent?.runtimeChange, requestedModel, requestedEffort);
    if (runtimeNote && targetAgent) {
      prompt = prompt ? `${prompt}\n\n${runtimeNote}` : runtimeNote;
      void deps.userStorage?.updateAgentFields(userId, targetAgent.id, { runtimeChange: null }).catch(() => {});
    }

    // The same one platform line the other two harnesses give their agents.
    const contextNote = buildContextUsageNote(targetAgent?.contextUsage);
    if (contextNote) {
      prompt = prompt ? `${prompt}\n\n${contextNote}` : contextNote;
    }

    const secretEnv = attachInfo
      ? {}
      : await resolveUserSecretEnv(deps.secretStorage, deps.userSecretOwnerId ?? userId, targetAgent?.id, deps.userSecretViewer ?? { ownerIsAdmin: true });
    const turnSecrets = [...Object.values(secretEnv), apiKey];

    try {
      const turnArgs = {
        harnessDeps,
        deps,
        userId,
        sessionId,
        sandboxId,
        prompt,
        signal,
        emit,
        requestedModel,
        requestedEffort,
        targetAgentId: deps.telegramTargetAgentId,
        title: targetAgent?.name,
        // The seat's key last, so a saved secret of the same name never
        // shadows the subscription this turn was leased.
        env: {
          ...secretEnv,
          ...OPENCODE_TURN_ENV_DEFAULTS,
          ...(apiKey ? { [OPENCODE_API_KEY_ENV]: apiKey } : {}),
        },
        turnSecrets,
      };
      let outcome = await attemptOpenCodeTurn({
        ...turnArgs,
        resumeSessionId: storedSessionId,
        attach: attachInfo,
        attachProbe,
      });
      recoveryNeedsTerminalAcknowledgement = false;

      // A rebuilt machine has an empty session store, orphaning the stored
      // id: OpenCode answers "Session not found" before it writes a line.
      // Nothing was delivered, so run the message once on a fresh session.
      if (storedSessionId && outcome.kind === 'finished' && isMissingSessionFailure(outcome)) {
        console.warn(
          `[opencode-harness] Session ${storedSessionId} is not on sandbox ${sandboxId}; starting a fresh one for ${sessionId}`,
        );
        await deps.userStorage?.updateTelegramHarnessConversation(
          userId,
          { opencodeSessionId: null },
          targetAgent ? { agentId: targetAgent.id } : undefined,
        ).catch(() => {});
        outcome = await attemptOpenCodeTurn({ ...turnArgs, resumeSessionId: undefined });
      }

      // What the turn spent, onto the owner's ledger — a stopped turn too,
      // since every request that finished is in its steps.
      if (targetAgent?.id && outcome.spent) {
        creditTurnTokens({
          ledger: deps.agentTokenLedger,
          userId,
          agent: targetAgent,
          provider: 'opencode',
          perModel: new Map([[requestedModel, outcome.spent]]),
        });
      }
      if (outcome.kind === 'interrupted') {
        return;
      }
      // The window fill, before the failure branch: a turn that answered and
      // then failed still measured something true. OpenCode never states a
      // window, so the catalog's figure rides along with the reading.
      if (targetAgent?.id && outcome.promptTokens) {
        const window = modelCatalogForCli('opencode').find((entry) => entry.value === requestedModel)?.contextWindow;
        await deps.userStorage?.updateAgentFields?.(userId, targetAgent.id, {
          contextUsage: {
            tokens: outcome.promptTokens,
            model: requestedModel,
            ...(window ? { window } : {}),
            at: new Date().toISOString(),
          },
        });
      }

      const { exitCode, failure, deliveredMessageCount, lastAssistantMessage, transcript } = outcome;
      if (failure || (exitCode !== null && exitCode !== 0 && deliveredMessageCount === 0)) {
        const tail = stripAnsiEscapes(transcript).trim().slice(-ERROR_TAIL_CHARS);
        throw new OpenCodeTurnError(
          failure?.message
            ? `OpenCode turn failed: ${failure.message}`
            : `OpenCode exited with code ${exitCode}. Output tail:\n${tail}`,
          failure,
        );
      }

      await deps.sessionStorage.updateSession(userId, sessionId, {
        status: 'completed',
        ...(lastAssistantMessage
          ? { lastAssistantMessage, lastAssistantMessageAt: new Date().toISOString() }
          : {}),
      });
      leaseOutcome = { kind: 'ok' };
      emit('agent_complete', {});
    } catch (error) {
      if (error instanceof DetachedTurnRestartSafetyError) throw error;
      await acknowledgeTerminalRecovery();
      const messageText = error instanceof Error ? error.message : String(error);
      const failure = error instanceof OpenCodeTurnError ? error.failure : undefined;
      const authFailure = failure?.kind === 'auth' || (!failure && isOpenCodeAuthFailureText(messageText));
      const usageLimit = failure?.kind === 'limit' || (!failure && isOpenCodeUsageLimitText(messageText));

      // The member's own seat: a refused key or a used-up window is the
      // SEAT's state, told to the pool (the finally benches it) and said in
      // words that name the way on.
      if (platformLease && (authFailure || usageLimit)) {
        const retryAfterSeconds = failure?.kind === 'limit' && failure.retryAt
          ? usageLimitCooldownSeconds(Math.floor(failure.retryAt / 1000), Date.now())
          : undefined;
        const modelOnly = failure?.kind === 'limit' && failure.modelOnly === true;
        leaseOutcome = authFailure
          ? { kind: 'auth_failed', detail: messageText.slice(-300) }
          : {
            kind: 'rate_limited',
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            model: requestedModel,
            ...(modelOnly ? { modelOnly: true } : {}),
          };
        console.warn(
          `[opencode-harness] Platform credential ${platformLease.credentialId} failed turn (${leaseOutcome.kind}):`,
          redactHarnessSecrets(messageText, turnSecrets),
        );
        if (authFailure) {
          throw new NonRecoverableAgentError(OPENCODE_KEY_REFUSED_MESSAGE);
        }
        if (platformLeaseKind === 'dedicated') {
          const resetAt = failure?.kind === 'limit' && failure.retryAt ? new Date(failure.retryAt) : undefined;
          await Promise.resolve(deps.onHarnessUsageLimit?.({
            cli: 'opencode',
            ...(resetAt ? { resetAt: resetAt.toISOString() } : {}),
          })).catch(() => {});
          throw new NonRecoverableAgentError(modelOnly
            ? modelLimitMessage(requestedModel, resetAt)
            : dedicatedLimitMessage(resetAt));
        }
        throw new NonRecoverableAgentError(OPENCODE_PLATFORM_HICCUP_MESSAGE);
      }

      const authDeath = Boolean(deps.onHarnessAuthFailure) && authFailure && !platformLease;
      if (authDeath) {
        await deps.onHarnessAuthFailure!({ cli: 'opencode' }).catch(() => {});
      }
      if (error instanceof NonRecoverableAgentError && !(error instanceof OpenCodeTurnError)) {
        if (authDeath && !error.userNotified) {
          throw new NonRecoverableAgentError(error.message, { userNotified: true });
        }
        throw error;
      }
      throw new NonRecoverableAgentError(redactHarnessSecrets(messageText, turnSecrets), { userNotified: authDeath });
    } finally {
      if (platformLease) {
        // Nothing to sync back: the key is not refreshed by the CLI, and Go
        // publishes no usage a key can read (note #780).
        await deps.platformCredentialPool!
          .releaseCredential(platformLease.credentialId, leaseOutcome)
          .catch((error) => {
            console.warn(`[opencode-harness] Failed to release platform credential ${platformLease!.credentialId}:`, error);
          });
      }
    }
    })().catch(async (error) => {
      if (!(error instanceof DetachedTurnRestartSafetyError)) {
        const liveAttach = attachInfo ? getActiveDetachedTurn(runKey) : undefined;
        if (liveAttach) {
          await terminateDetachedTurnBeforeRestart(
            harnessDeps.sandboxClient,
            runKey,
            liveAttach,
            captureRecoveredContinuity,
            HARNESS_SSH_USER,
          );
          recoveryNeedsTerminalAcknowledgement = true;
        }
        await acknowledgeTerminalRecovery();
      }
      throw error;
    });
  };
}

/** Why a turn failed, read off the stream's structure rather than its words. */
export type OpenCodeTurnFailure =
  | { kind: 'auth'; message: string }
  /** `retryAt` is epoch ms; `modelOnly` when the window is that model's (a Go window). */
  | { kind: 'limit'; message: string; retryAt?: number; modelOnly?: boolean }
  | { kind: 'error'; message: string };

class OpenCodeTurnError extends NonRecoverableAgentError {
  constructor(message: string, readonly failure?: OpenCodeTurnFailure) {
    super(message);
  }
}

/**
 * One `error` or `platform_limit` line as a failure. A Go window is per
 * model ("Limits are enforced per model and per window" — opencode.ai/docs/go),
 * so it benches that model on the seat and leaves the rest running; the free
 * tier's and an unexplained long wait are the whole seat's.
 */
export function openCodeFailureOf(event: OpenCodeRunEvent): OpenCodeTurnFailure | null {
  if (event.type === 'platform_limit') {
    const limit = event as Extract<OpenCodeRunEvent, { type: 'platform_limit' }>;
    const retryAt = typeof limit.retryAt === 'number' && Number.isFinite(limit.retryAt) ? limit.retryAt : undefined;
    return {
      kind: 'limit',
      message: (typeof limit.message === 'string' && limit.message.trim()) || 'OpenCode hit a usage limit.',
      ...(retryAt ? { retryAt } : {}),
      ...(limit.reason === 'account_rate_limit' ? { modelOnly: true } : {}),
    };
  }
  if (event.type !== 'error') return null;
  const message = openCodeErrorMessage(event) ?? 'OpenCode reported an error.';
  const status = openCodeErrorStatus(event);
  const body = openCodeErrorBody(event);
  if (status === 401) return { kind: 'auth', message };
  if (status === 429 && /GoUsageLimitError/.test(body)) return { kind: 'limit', message, modelOnly: true };
  if (status === 429 && /FreeUsageLimitError/.test(body)) return { kind: 'limit', message };
  return { kind: 'error', message };
}

type OpenCodeTurnOutcome =
  | { kind: 'interrupted'; spent?: TokenCounts }
  | {
    kind: 'finished';
    exitCode: number | null;
    failure?: OpenCodeTurnFailure;
    deliveredMessageCount: number;
    lastAssistantMessage?: string;
    transcript: string;
    /** The last request's prompt size — how full the window is now. */
    promptTokens?: number;
    spent?: TokenCounts;
  };

const MISSING_SESSION_PATTERN = /session not found/i;

function isMissingSessionFailure(outcome: Extract<OpenCodeTurnOutcome, { kind: 'finished' }>): boolean {
  return outcome.deliveredMessageCount === 0
    && outcome.exitCode !== null
    && outcome.exitCode !== 0
    && MISSING_SESSION_PATTERN.test(`${stripAnsiEscapes(outcome.transcript)}\n${outcome.failure?.message ?? ''}`);
}

async function attemptOpenCodeTurn(args: {
  harnessDeps: OpenCodeHarnessDeps;
  deps: AgentLoopDeps;
  userId: string;
  sessionId: string;
  sandboxId: string;
  prompt: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  emit: (type: WSMessageType, data: unknown) => void;
  attach?: HarnessTurnAttachInfo;
  attachProbe?: 'running' | 'finished' | 'unknown';
  /** The turn's whole environment: the member's secrets, the platform's flags, the seat's key. */
  env: Record<string, string>;
  /** Everything to keep out of a transcript, log or message. */
  turnSecrets: Array<string | undefined>;
  requestedModel: string;
  requestedEffort?: string;
  targetAgentId?: string;
  title?: string;
}): Promise<OpenCodeTurnOutcome> {
  const {
    harnessDeps,
    deps,
    userId,
    sessionId,
    sandboxId,
    prompt,
    resumeSessionId,
    signal,
    emit,
    attach,
    attachProbe,
    env,
    turnSecrets,
    requestedModel,
    requestedEffort,
    targetAgentId,
  } = args;
  const { sandboxClient } = harnessDeps;
  const runKey = targetAgentId ? `${sessionId}::agent:${targetAgentId}` : sessionId;

  let attached: HarnessTurnAttachInfo | undefined;
  if (attach) {
    const probed = attachProbe ?? (
      await inspectDetachedTurnUntilKnown(
        sandboxClient, attach.sandboxId, attach.outputPath, HARNESS_SSH_USER, signal,
        (failures) => {
          if (failures === 1) {
            harnessLog(sessionId, 'attach probe unavailable; retrying before any relaunch', { outputPath: attach.outputPath });
          }
        },
      )
    ).state;
    if (probed === 'gone') {
      console.warn(`[opencode-harness] [${sessionId}] attach target gone — re-running the turn`);
    } else {
      attached = attach;
      console.info(`[opencode-harness] [${sessionId}] RE-ATTACHED to detached turn pid=${attach.pid} (${probed})`);
    }
  }

  const outputPath = attached?.outputPath ?? buildTurnOutputPath();
  const turnStartedAt = attached?.turnStartedAt ?? Date.now();
  let handle: DetachedTurnHandle | undefined = attached ? { outputPath, pid: attached.pid } : undefined;
  if (!handle) {
    const install = harnessDeps.cliInstallInFlight?.(sandboxId);
    if (install) {
      console.info(`[opencode-harness] [${sessionId}] CLI install in flight on ${sandboxId}; the turn starts when it is done`);
      await install;
    }
    if (signal?.aborted) {
      const acknowledged = await deps.acknowledgeHarnessRecovery?.(signal, true);
      if (acknowledged !== false) {
        deps.backgroundRunner?.completeHarnessTerminationRecovery?.(runKey);
      }
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
      emit('agent_interrupted', {});
      return { kind: 'interrupted' };
    }
    const command = buildOpenCodeRunCommand({
      prompt,
      resumeSessionId,
      model: requestedModel,
      ...(requestedEffort ? { effort: requestedEffort } : {}),
      ...(args.title ? { title: args.title } : {}),
    });
    registerActiveDetachedTurn(runKey, {
      cli: 'opencode',
      sandboxId,
      outputPath,
      pid: 0,
      consumedLines: 0,
      deliveredMessageCount: 0,
      turnStartedAt,
    });
    try {
      handle = await startDetachedTurn(sandboxClient, sandboxId, command, outputPath, {
        cwd: HARNESS_CWD,
        sshUser: HARNESS_SSH_USER,
        env,
        signal,
      });
    } catch (error) {
      if (!(error instanceof DetachedTurnRestartSafetyError)) {
        clearActiveDetachedTurn(runKey);
      }
      throw error;
    }
    harnessLog(sessionId, 'detached turn started', {
      sandboxId,
      pid: handle.pid,
      resume: Boolean(resumeSessionId),
      model: requestedModel,
      ...(requestedEffort ? { effort: requestedEffort } : {}),
      hasKey: Boolean(env.OPENCODE_API_KEY),
      outputPath,
    });
  }
  const activeHandle: DetachedTurnHandle = handle;

  const reader = new TurnOutputReader(
    sandboxClient, sandboxId, outputPath, HARNESS_SSH_USER, attached?.consumedLines ?? 0,
  );
  let transcript = '';
  let openCodeSession = resumeSessionId;
  let deliveredMessageCount = attached?.deliveredMessageCount ?? 0;
  let currentActivity = attached?.currentActivity;
  registerActiveDetachedTurn(runKey, {
    cli: 'opencode',
    sandboxId,
    outputPath,
    pid: activeHandle.pid,
    consumedLines: reader.linesConsumed,
    deliveredMessageCount,
    ...(currentActivity ? { currentActivity } : {}),
    turnStartedAt,
  });
  const recoveryAcknowledged = await deps.acknowledgeHarnessRecovery?.(signal);
  if (recoveryAcknowledged !== false) {
    deps.backgroundRunner?.completeHarnessTerminationRecovery?.(runKey);
  }
  let leaveRunning = false;
  let terminationProven = activeHandle.alreadyFinished === true || attachProbe === 'finished';
  const terminateDetachedTurn = async (): Promise<void> => {
    if (terminationProven) return;
    try {
      if (activeHandle.pid <= 0) {
        const inspected = await inspectDetachedTurnUntilKnown(sandboxClient, sandboxId, outputPath, HARNESS_SSH_USER);
        if (inspected.state === 'finished' || inspected.state === 'gone') {
          terminationProven = true;
          return;
        }
        if (inspected.state !== 'running' || !inspected.pid) {
          throw new DetachedTurnTerminationError(
            `OpenCode turn ${outputPath} has no safely recoverable process id.`,
          );
        }
        activeHandle.pid = inspected.pid;
        updateActiveDetachedTurn(runKey, { pid: inspected.pid });
      }
      await killDetachedTurnUntilGone(
        sandboxClient,
        sandboxId,
        activeHandle.pid,
        HARNESS_SSH_USER,
        (failures) => {
          if (failures === 1) {
            harnessLog(sessionId, 'detached turn exit not yet verified; retrying', { pid: activeHandle.pid });
          }
        },
        outputPath,
      );
      terminationProven = true;
    } catch (error) {
      if (error instanceof DetachedTurnTerminationError) leaveRunning = true;
      throw error;
    }
  };
  let failure: OpenCodeTurnFailure | undefined;
  let lastAssistantMessage: string | undefined;
  let promptTokens: number | undefined;
  const tokens = new OpenCodeTurnTokens();

  const persistSessionId = async (id: string | null): Promise<void> => {
    if (!id || id === openCodeSession) return;
    let failures = 0;
    while (true) {
      try {
        await deps.userStorage?.updateTelegramHarnessConversation(
          userId,
          { opencodeSessionId: id },
          targetAgentId ? { agentId: targetAgentId } : undefined,
        );
        break;
      } catch (error) {
        failures += 1;
        if (signal?.aborted && !isProcessShutdownAbort(signal)) {
          await terminateDetachedTurn();
        }
        if (isHarnessShutdownInProgress()) {
          throw new DetachedTurnContinuityError(
            'OpenCode session id could not be persisted before backend shutdown.',
            { cause: error },
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(failures, 5) * 1_000);
        });
      }
    }
    openCodeSession = id;
  };

  // Every line names the session; the plugin's limit line can name a helper's
  // (a child session) and is never taken as the conversation.
  const captureContinuityFromLines = async (lines: string[]): Promise<void> => {
    for (const line of lines) {
      const event = parseOpenCodeEventLine(line);
      if (!event || event.type === 'platform_limit') continue;
      await persistSessionId(openCodeSessionId(event));
      // Tokens of a request that finished are spent whichever way the turn
      // goes from here.
      tokens.observe(openCodeStepTokens(event));
    }
  };

  const captureInterruptedContinuity = async (): Promise<void> => {
    const continuityOffset = reader.linesConsumed;
    let failures = 0;
    while (true) {
      const continuityReader = new TurnOutputReader(
        sandboxClient, sandboxId, outputPath, HARNESS_SSH_USER, continuityOffset,
      );
      try {
        await captureContinuityFromLines(await continuityReader.readNewLines({ final: true }));
        return;
      } catch (error) {
        failures += 1;
        if (isHarnessShutdownInProgress()) {
          throw new DetachedTurnContinuityError(
            'OpenCode exited, but its session id could not be safely captured.',
            { cause: error },
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(failures, 5) * 1_000);
        });
      }
    }
  };

  const handleLines = async (lines: string[]): Promise<void> => {
    for (let index = 0; index < lines.length; index++) {
      if (signal?.aborted) {
        await captureContinuityFromLines(lines.slice(index));
        return;
      }
      const event = parseOpenCodeEventLine(lines[index]!);
      if (!event) continue;
      if (event.type !== 'platform_limit') {
        await persistSessionId(openCodeSessionId(event));
      }
      const toolSummary = openCodeToolSummary(event);
      if (toolSummary) {
        currentActivity = redactHarnessSecrets(toolSummary, turnSecrets);
        continue;
      }
      const stepTokens = openCodeStepTokens(event);
      if (stepTokens) {
        tokens.observe(stepTokens);
        promptTokens = openCodePromptTokens(stepTokens) ?? promptTokens;
        continue;
      }
      const text = openCodeText(event)?.trim();
      if (text) {
        if (signal?.aborted) {
          await captureContinuityFromLines(lines.slice(index + 1));
          return;
        }
        lastAssistantMessage = text;
        deliveredMessageCount += 1;
        await deliverAssistantMessage({
          deps,
          userId,
          sessionId,
          content: redactHarnessSecrets(text, turnSecrets),
          emit,
          model: requestedModel,
          requestedModel,
          outbound: { sandboxClient, sandboxId },
        });
        continue;
      }
      const failed = openCodeFailureOf(event);
      // A limit outranks a later error: the abort that follows the plugin's
      // line is OpenCode's own `error` about being aborted.
      if (failed && failure?.kind !== 'limit') failure = failed;
    }
  };

  let lastProgressAt = Date.now();
  let exitCode: number | null = null;
  let running = true;

  try {
    while (running) {
      if (signal?.aborted) {
        if (isProcessShutdownAbort(signal)) {
          leaveRunning = true;
          return { kind: 'interrupted' };
        }
        await terminateDetachedTurn();
        try {
          await captureInterruptedContinuity();
        } catch (error) {
          if (error instanceof DetachedTurnContinuityError) leaveRunning = true;
          throw error;
        }
        const interruptedRecoveryAcknowledged = await deps.acknowledgeHarnessRecovery?.(signal, true);
        if (interruptedRecoveryAcknowledged !== false) {
          deps.backgroundRunner?.completeHarnessTerminationRecovery?.(runKey);
        }
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
        emit('agent_interrupted', {});
        const spent = tokens.spent();
        return { kind: 'interrupted', ...(spent ? { spent } : {}) };
      }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        harnessLog(sessionId, 'turn STALLED', {
          quietMs: Date.now() - lastProgressAt,
          linesConsumed: reader.linesConsumed,
          delivered: deliveredMessageCount,
        });
        await terminateDetachedTurn();
        throw new Error(OPENCODE_TURN_STALLED_MESSAGE);
      }
      const poll = await reader.readNewLinesWithStatus();
      running = poll.running;
      exitCode = poll.exitCode ?? exitCode;
      if (poll.lines.length > 0) {
        lastProgressAt = Date.now();
      }
      if (signal?.aborted) {
        await captureContinuityFromLines(poll.lines);
        updateActiveDetachedTurn(runKey, { consumedLines: reader.linesConsumed });
        running = true;
        continue;
      }
      await handleLines(poll.lines);
      updateActiveDetachedTurn(runKey, {
        consumedLines: reader.linesConsumed,
        deliveredMessageCount,
        ...(currentActivity ? { currentActivity } : {}),
      });
      if (signal?.aborted) {
        running = true;
        continue;
      }
      if (running) {
        await sleepUnlessAborted(POLL_TIMEOUT_MS, signal);
      }
    }
    if (exitCode !== 0 || failure) {
      transcript = await reader.readStderrTail(2000);
    }
    if (deliveredMessageCount > 0 || (!failure && (exitCode === null || exitCode === 0))) {
      deps.backgroundRunner?.completeCurrentPayload?.(runKey);
    }
  } catch (error) {
    if (error instanceof DetachedTurnRestartSafetyError) {
      leaveRunning = true;
      throw error;
    }
    if (running && !terminationProven) {
      await terminateDetachedTurn();
      try {
        await captureInterruptedContinuity();
      } catch (continuityError) {
        if (continuityError instanceof DetachedTurnRestartSafetyError) leaveRunning = true;
        throw continuityError;
      }
      const failedRecoveryAcknowledged = await deps.acknowledgeHarnessRecovery?.(signal, true);
      if (failedRecoveryAcknowledged !== false) {
        deps.backgroundRunner?.completeHarnessTerminationRecovery?.(runKey);
      }
    }
    throw error;
  } finally {
    if (!leaveRunning) {
      await reader.cleanup();
      clearActiveDetachedTurn(runKey);
    }
  }

  harnessLog(sessionId, 'turn finished', {
    exitCode,
    delivered: deliveredMessageCount,
    linesConsumed: reader.linesConsumed,
    ...(failure ? { failure: failure.kind, failureMessage: redactHarnessSecrets(failure.message, turnSecrets) } : {}),
  });

  const spent = tokens.spent();
  return {
    kind: 'finished',
    exitCode,
    ...(failure ? { failure: { ...failure, message: redactHarnessSecrets(failure.message, turnSecrets) } } : {}),
    deliveredMessageCount,
    lastAssistantMessage,
    transcript: redactHarnessSecrets(transcript, turnSecrets),
    ...(promptTokens ? { promptTokens } : {}),
    ...(spent ? { spent } : {}),
  };
}

async function deliverAssistantMessage(args: {
  deps: AgentLoopDeps;
  userId: string;
  sessionId: string;
  content: string;
  emit: (type: WSMessageType, data: unknown) => void;
  model?: string;
  requestedModel?: string;
  /** Machine context for the ATTACH: convention (agent → user files). */
  outbound?: { sandboxClient: WorkspaceRuntimeClient; sandboxId: string };
}): Promise<void> {
  const { deps, userId, sessionId, emit, model, requestedModel } = args;
  let { content } = args;

  const outboundFiles: OutboundFile[] = [];
  if (deps.sendUserFile && args.outbound) {
    const { text, paths } = extractOutboundAttachments(content);
    if (paths.length > 0) {
      const notes: string[] = [];
      for (const rawPath of paths) {
        const fetched = await fetchOutboundAttachment(args.outbound.sandboxClient, args.outbound.sandboxId, rawPath, {
          ...(deps.prepareUserFileUpload ? { upload: deps.prepareUserFileUpload } : {}),
          sshUser: HARNESS_SSH_USER,
          homeDir: HARNESS_CWD,
        });
        if (fetched.ok) {
          outboundFiles.push(outboundFileOf(fetched));
        } else {
          notes.push(`(couldn't attach ${fetched.fileName} — ${fetched.reason})`);
        }
      }
      content = [text, ...notes].filter(Boolean).join('\n\n')
        || `Sending ${outboundFiles.length} file${outboundFiles.length === 1 ? '' : 's'}…`;
    }
  }

  emit('assistant_message', {
    content,
    model: model ?? 'opencode',
    source: 'opencode-cli',
    ...(requestedModel ? { requestedModel } : {}),
  });
  await deps.notifyAssistantResponse?.({
    userId,
    sessionId,
    content,
    source: 'opencode-cli',
    ...(model ? { model } : {}),
    ...(requestedModel ? { requestedModel } : {}),
  });

  for (const file of outboundFiles) {
    try {
      await deps.sendUserFile!(file);
    } catch (error) {
      console.warn(`[opencode-harness] Failed to send outbound file ${file.fileName}:`, error);
    }
  }
}
