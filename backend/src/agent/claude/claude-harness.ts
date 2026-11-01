/**
 * Agent harness backed by the Claude Code CLI running inside the
 * user's sandbox VM, authenticated with the user's own Claude subscription.
 *
 * Structurally parallel to the Codex harness: implements `AgentLoopFn` so
 * BackgroundRunner plumbing is reused, and runs one
 * `claude -p ... --output-format stream-json` turn per user message. The PTY
 * supervises the process (status, exit code, abort) while the JSONL event
 * stream is redirected to a per-turn file and polled back byte-exact (see
 * harness-turn-output.ts); assistant text is delivered through
 * `notifyAssistantResponse`.
 *
 * Usage is billed to the user's Claude plan — deliberately no model-usage
 * billing here.
 */

import type { AgentLoopDeps } from '../agent-loop.js';
import { NonRecoverableAgentError, type AgentLoopFn } from '../background-runner.js';
import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { UserInputPayload, WSMessage, WSMessageType } from '../../types/agent.js';
import { buildRuntimeChangeNote, resolveEffectiveEffort, resolveEffectiveModel } from '../harness-models.js';
import {
  DEFAULT_DEVELOPMENT_SSH_USER,
  getDefaultDevelopmentRootForSshUser,
} from '../../services/development-root.js';
import { stripAnsiEscapes } from '../codex/codex-exec-events.js';
import { buildContextUsageNote } from '../../utils/context-window.js';
import { isProcessShutdownAbort } from '../abort-reason.js';
import {
  DetachedTurnContinuityError,
  type DetachedTurnHandle,
  DetachedTurnRestartSafetyError,
  DetachedTurnTerminationError,
  TurnOutputReader,
  buildTurnOutputPath,
  clearActiveDetachedTurn,
  closeTurnInput,
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
import type { HarnessTurnAttachInfo } from '../../types/agent.js';
import {
  getAssistantTextBlocks,
  getToolUseSummaries,
  getClaudeContextTokens,
  getClaudeApiErrorMessage,
  getClaudeModel,
  getClaudeRateLimitResetAt,
  getClaudeSessionId,
  getClaudeUsageWindows,
  getResultInfo,
  parseClaudeStreamEventLine,
} from './claude-exec-events.js';
import { CLAUDE_OAUTH_TOKEN_ENV, ensureClaudeAuth, getStoredClaudeOauthToken } from './claude-login.js';
import {
  claudeUsageLimitResetAtSeconds,
  isClaudeAuthFailureText,
  isClaudeBillingFailureText,
  isClaudeModelLimitText,
  isClaudeUsageLimitText,
  usageLimitCooldownSeconds,
} from '../harness-auth-failure.js';
import {
  CLAUDE_PAYMENT_REQUIRED_STATUSES,
  readClaudeProfileWithProfileToken,
} from './claude-usage.js';
import type {
  PlatformCredentialLease,
  PlatformCredentialLeaseOutcome,
  PlatformUserLease,
} from '../../types/platform-credential.js';
import {
  extractOutboundAttachments,
  fetchOutboundAttachment,
  outboundFileOf,
  type OutboundFile,
  getStageableHarnessAttachments,
  stageHarnessAttachments,
} from '../harness-attachments.js';
import type { ProviderUsageSnapshot } from '../../types/user.js';
import { dedicatedLimitMessage, modelLimitMessage, NO_SEAT_MESSAGE, paymentRequiredMessage } from '../platform-turn-policy.js';
import { resolveUserSecretEnv } from '../../services/user-secrets.js';
import { quoteShellArg } from '../../utils/shell-quote.js';
import { ClaudeTurnTokens, creditTurnTokens } from '../turn-tokens.js';
import type { AgentRecord } from '../../types/user.js';

export interface ClaudeHarnessDeps {
  sandboxClient: WorkspaceRuntimeClient;
  /** Resolves the user's sandbox when the session doc doesn't carry one. */
  resolveDefaultSandboxId: (userId: string) => Promise<string | null>;
  /**
   * The CLI install running on this machine right now, if any
   * (`HarnessCliUpdater.installInFlight`). A fresh turn waits for it before
   * it starts the CLI: mid-install the binary is half-replaced, and a turn
   * started then dies with `command not found` (2026-10-15).
   */
  cliInstallInFlight?: (sandboxId: string) => Promise<void> | undefined;
  /** Tests may replace the provider read used to disambiguate runtime billing failures. */
  fetchImpl?: typeof fetch;
}

// Run the CLI as the non-root `agent` user — the same user the setup agent
// signs in as, so ~/.claude (onboarding + credentials) is the one it populated.
// Running as root gave a fresh, unonboarded config that stalled the turn.
const HARNESS_SSH_USER = DEFAULT_DEVELOPMENT_SSH_USER;
const HARNESS_CWD = getDefaultDevelopmentRootForSshUser(HARNESS_SSH_USER);

// A turn is killed for silence, not for length. A healthy long turn (a test
// sweep, a migration) emits a stream event per message and per tool call; a
// wedged CLI stops emitting. The stream IS legitimately quiet during one long
// tool call — Claude Code caps a single Bash call at 10 minutes and the
// machine env doesn't raise it — so 15 minutes of no new events means stuck,
// not busy. There is deliberately no wall-clock cap: it killed healthy turns
// at minute 30 (observed live 2026-07-28, a turn killed seconds into its
// verification run), and a runaway loop that keeps producing output exhausts
// the user's own provider quota, goes quiet, and lands here anyway.
const STALL_TIMEOUT_MS = 15 * 60_000;
// With stdout redirected to the turn file, the PTY (stderr) is mostly quiet,
// so the waitForChange timeout is the effective pacing for turn-file polls.
const POLL_TIMEOUT_MS = 2_500;
const ERROR_TAIL_CHARS = 600;
// How often to emit a poll heartbeat while a turn is running, so a hung turn
// leaves a periodic breadcrumb trail in the logs instead of silence.
const HEARTBEAT_LOG_INTERVAL_MS = 30_000;
const DIAGNOSTIC_TAIL_CHARS = 1_500;
const MISSING_SESSION_PATTERN = /No conversation found with session ID/i;

function harnessLog(sessionId: string, message: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.info(`[claude-harness] [${sessionId}] ${message}${suffix}`);
}

/** Never log the OAuth token: strip its value from a command before logging. */
function redactCommand(command: string): string {
  return command.replace(new RegExp(`${CLAUDE_OAUTH_TOKEN_ENV}='[^']*'`, 'g'), `${CLAUDE_OAUTH_TOKEN_ENV}='***'`);
}

export const CLAUDE_NOT_CONNECTED_MESSAGE = [
  'The Claude harness is enabled, but no Claude account is connected yet.',
  'Open /harness and tap "Connect Claude" to sign in, or switch back to the default harness.',
].join('\n');

export const CLAUDE_WORKSPACE_UNAVAILABLE_MESSAGE = [
  "Couldn't start your workspace.",
  'Try again in a moment, or open /harness for options.',
].join('\n');

// Platform-credential turns: shown when the pool has nothing leasable (empty,
// or every credential dead/cooling down). Deliberately says nothing about
// credentials — to the user this is just momentary capacity.
export const CLAUDE_PLATFORM_CAPACITY_MESSAGE =
  'All hands are busy right now — please send that again in a few minutes.';

// Platform-credential turns: a leased credential failed auth or hit its
// limit mid-turn. The pool has already benched it, so a retry lands on a
// different credential.
export const CLAUDE_PLATFORM_HICCUP_MESSAGE =
  'Hit a brief hiccup on our side. Please send that message again — it should go through now.';

// What the retried CLI is told when a mid-turn token rotation killed its
// predecessor (see the revoked-lease retry below). The conversation on disk
// already carries the user's message and everything said so far, so this must
// move the turn forward without making the model repeat delivered work.
export const CLAUDE_TOKEN_ROTATED_RESUME_PROMPT =
  'Platform note: your previous process was cut off mid-turn by a routine credential rotation on our side — nothing in your work failed. Continue exactly where you left off. Everything you already said was delivered, so do not repeat it.';

// What the retried CLI is told when its subscription hit a limit mid-turn and
// the turn moved onto another of the member's subscriptions (note #772).
export const CLAUDE_SEAT_SWITCHED_RESUME_PROMPT =
  'Platform note: your previous process stopped mid-turn because that subscription hit its usage limit; you are now running on another of your owner\'s subscriptions. Continue exactly where you left off. Everything you already said was delivered, so do not repeat it.';

// Thrown on a stall kill; reaches the user via the background runner's error
// notification, so it has to say the conversation survives — the session id
// is persisted the moment the CLI emits it, and the next message resumes it.
export const CLAUDE_TURN_STALLED_MESSAGE = 'Claude went quiet — no activity for 15 minutes, so the turn was stopped. The conversation is saved: send a message to pick up where it left off.';

export { dedicatedLimitMessage } from '../platform-turn-policy.js';

/** How many of the member's other seats one turn may move onto after a usage limit (note #772). */
const MAX_SEAT_HOPS = 3;

/**
 * The pool outcome for a turn that died on a Claude usage limit: benched until
 * the tripped window actually resets — the epoch Anthropic glues into the 429
 * text, else the stream's last rate_limit_event (a model's own weekly window
 * resets days out; the default 30 minutes would flap against it, burning a
 * user turn every revival) — and scoped to the turn's model when the CLI says
 * the limit is that model's alone.
 */
function claudeLimitOutcome(
  message: string | undefined,
  lastRateLimitResetAt: number | undefined,
  model: string | undefined,
): Extract<PlatformCredentialLeaseOutcome, { kind: 'rate_limited' }> {
  const retryAfterSeconds = usageLimitCooldownSeconds(
    claudeUsageLimitResetAtSeconds(message) ?? lastRateLimitResetAt,
    Date.now(),
  );
  return {
    kind: 'rate_limited',
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(model ? { model } : {}),
    ...(model && isClaudeModelLimitText(message) ? { modelOnly: true } : {}),
  };
}

export function createClaudeHarnessRunner(harnessDeps: ClaudeHarnessDeps): AgentLoopFn {
  return async function runClaudeHarness(
    sessionId: string,
    userId: string,
    message: string | UserInputPayload | null,
    deps: AgentLoopDeps,
    signal?: AbortSignal,
  ): Promise<void> {
    const payload: UserInputPayload | null = typeof message === 'string' ? { content: message } : message;
    const content = payload?.content?.trim() ?? '';
    // Attachment-only messages (a photo with no caption) still run a turn:
    // the staged-file note becomes the whole prompt.
    const stageableAttachments = getStageableHarnessAttachments(payload?.attachments);
    if (
      !content
      && stageableAttachments.length === 0
      && !payload?.harnessTermination
      && !payload?.harnessAttach
    ) return;

    const emit = (type: WSMessageType, data: unknown): void => {
      const wsMessage: WSMessage = { type, sessionId, data, timestamp: new Date().toISOString() };
      deps.eventEmitter.emit(sessionId, wsMessage);
    };

    const session = await deps.sessionStorage.getSession(userId, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for Claude harness run.`);
    }
    const profile = await deps.userStorage?.getProfile(userId);
    // The turn is pinned to the agent it was dispatched for (per-agent
    // concurrency); every caller pins.
    const targetAgent = deps.telegramTargetAgentId
      ? profile?.telegram?.agents?.[deps.telegramTargetAgentId]
      : undefined;
    // Run with the EFFECTIVE model/effort — the same concrete values the
    // reply header advertises. Unset overrides resolve to the CLI defaults
    // (opus · high); effort resolution is model-aware.
    const requestedModel = targetAgent
      ? resolveEffectiveModel('claude', targetAgent.model)
      : undefined;
    const requestedEffort = targetAgent
      ? resolveEffectiveEffort('claude', targetAgent.model, targetAgent.effort)
      : undefined;
    // Continuity id lives on the agent record. Only callers without an agent
    // record may use the legacy session-document field: falling back to it for
    // an existing agent would resume stale context after that agent's New chat
    // action deliberately removed its conversation pointer.
    let storedSessionId = targetAgent
      ? targetAgent.conversation?.claudeSessionId
      : session.claudeSessionId;

    const runKey = deps.telegramTargetAgentId
      ? `${sessionId}::agent:${deps.telegramTargetAgentId}`
      : sessionId;
    let attachInfo = payload?.harnessAttach?.cli === 'claude' ? payload.harnessAttach : undefined;
    // A failed steering kill (same process) or a steering checkpoint (new
    // process) leaves metadata for the abandoned CLI. Prove it dead and save
    // any late first-turn session id before this runner may launch beside it.
    const abandonedTurn = payload?.harnessTermination
      ?? (attachInfo ? undefined : getActiveDetachedTurn(runKey));
    let runStarted = false;
    const markRunStarted = async (): Promise<void> => {
      if (runStarted) return;
      runStarted = true;
      // The managed VM's native Claude conversation is the source of truth;
      // the platform does not mirror the transcript into session storage.
      emit('agent_start', { runStartedAt: new Date().toISOString() });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'running' }).catch((error) => {
        // Status is observability, not ownership. A transient bookkeeping
        // failure must never kill a successfully reattached remote CLI and
        // discard output that is still arriving in its native conversation.
        console.warn(`[claude-harness] Could not mark ${sessionId} running; continuing turn:`, error);
      });
    };
    const captureRecoveredContinuity = async (lines: string[]): Promise<void> => {
      for (const line of lines) {
        const event = parseClaudeStreamEventLine(line);
        const recoveredId = event ? getClaudeSessionId(event) : undefined;
        if (!recoveredId || recoveredId === storedSessionId) continue;
        if (deps.userStorage) {
          await deps.userStorage.updateTelegramHarnessConversation(
            userId,
            { claudeSessionId: recoveredId },
            targetAgent ? { agentId: targetAgent.id } : undefined,
          );
        } else {
          await deps.sessionStorage.updateSession(userId, sessionId, { claudeSessionId: recoveredId });
        }
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
    return await (async () => {
    if (abandonedTurn) {
      // The marker itself names the authoritative sandbox. Cleanup must not
      // depend on provisioning the agent's current/default workspace first.
      await markRunStarted();
      await terminateDetachedTurnBeforeRestart(
        harnessDeps.sandboxClient,
        runKey,
        abandonedTurn,
        captureRecoveredContinuity,
        HARNESS_SSH_USER,
      );
      recoveryNeedsTerminalAcknowledgement = true;
      if (signal?.aborted) {
        await acknowledgeTerminalRecovery();
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
        emit('agent_interrupted', {});
        return;
      }
      if (!content && stageableAttachments.length === 0) {
        await acknowledgeTerminalRecovery();
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
        emit('agent_interrupted', {});
        return;
      }
    }

    let attachProbe: 'running' | 'finished' | 'unknown' | undefined;
    if (attachInfo) {
      // Register before the first remote probe. Auth/capacity/storage gates
      // are irrelevant to a process that is already running, and a failure in
      // any of them must never free this PID for a competing launch.
      registerActiveDetachedTurn(runKey, attachInfo);
      const inspected = await inspectDetachedTurnUntilKnown(
        harnessDeps.sandboxClient,
        attachInfo.sandboxId,
        attachInfo.outputPath,
        HARNESS_SSH_USER,
        // pid=0 is a provisional launch marker. A user abort must not let it
        // escape as "unknown" and flow into an attach/kill; keep resolving
        // until PID/finished/gone. Global backend shutdown still breaks the
        // helper via isHarnessShutdownInProgress and persists the marker.
        attachInfo.pid <= 0 ? undefined : signal,
      );
      const state = inspected.state;
      if (state === 'gone') {
        // Retire the old single-use launch key even when its recorded PID is
        // already gone: a delayed transparent SSH retry may not have reached
        // the machine yet, and the final drain can still carry the first
        // native conversation id written after the checkpoint.
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
        // Keep the boot document until the fallback launch has installed its
        // provisional/active marker. Deleting here would lose the saved user
        // payload if auth, staging, or the launch crashed in the gap.
      } else {
        if (state === 'running' && inspected.pid && inspected.pid !== attachInfo.pid) {
          attachInfo = { ...attachInfo, pid: inspected.pid };
          registerActiveDetachedTurn(runKey, attachInfo);
        } else if (state === 'running' && attachInfo.pid <= 0) {
          if (!inspected.pid) {
            throw new DetachedTurnTerminationError(
              `Claude turn ${attachInfo.outputPath} is running, but its launch PID is unresolved.`,
            );
          }
        }
        attachProbe = state;
      }
    }
    if (
      recoveryNeedsTerminalAcknowledgement
      && !content
      && stageableAttachments.length === 0
    ) {
      await acknowledgeTerminalRecovery();
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'interrupted' });
      emit('agent_interrupted', {});
      return;
    }

    // A normal re-attach also names its authoritative sandbox. Fresh work is
    // pinned to this agent's machine; session.sandboxId is only the legacy
    // fallback shared by the whole Telegram session.
    let sandboxId = attachInfo?.sandboxId ?? deps.telegramTargetSandboxId ?? session.sandboxId;
    if (!sandboxId) {
      try {
        sandboxId = (await harnessDeps.resolveDefaultSandboxId(userId)) ?? undefined;
      } catch (error) {
        console.error(`[claude-harness] Failed to provision sandbox for ${userId}:`, error);
        sandboxId = undefined;
      }
    }
    if (!sandboxId) {
      await deliverAssistantMessage({ deps, userId, sessionId, content: CLAUDE_WORKSPACE_UNAVAILABLE_MESSAGE, emit });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
      emit('agent_complete', {});
      await acknowledgeTerminalRecovery();
      return;
    }
    await markRunStarted();

    // Wherever the pool is wired (production), every turn runs on the
    // owner's own seats through the lease path — the leased token IS the
    // auth, so the pre-check and the secret-storage token load below are
    // skipped. Whether the owner HAS a seat is the lease's answer, not a
    // profile field's: a seatless owner gets the no-seat refusal below. In
    // dev, with no pool, the personal-sign-in path still runs — which is
    // what keeps a config problem from reading as a platform-wide outage.
    const usePlatformCredentials = Boolean(deps.platformCredentialPool);

    // Only pre-check auth on a session's first Claude turn; later turns rely
    // on runtime failures, sparing an SSH round-trip per message.
    if (!attachInfo && !storedSessionId && !usePlatformCredentials) {
      const authStatus = await ensureClaudeAuth({
        sandboxClient: harnessDeps.sandboxClient,
        sandboxId,
        secretStorage: deps.secretStorage,
        userId,
        sshUser: HARNESS_SSH_USER,
      });
      if (authStatus !== 'logged_in') {
        // With a recovery handler (Telegram), it owns the state reset AND the
        // user-facing message; the generic "not connected" text would just
        // contradict its instructions.
        if (deps.onHarnessAuthFailure) {
          await deps.onHarnessAuthFailure({ cli: 'claude' }).catch(() => {});
        } else {
          await deliverAssistantMessage({ deps, userId, sessionId, content: CLAUDE_NOT_CONNECTED_MESSAGE, emit });
        }
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
    }

    // The credential for this turn. BYO: the setup-token from onboarding in
    // per-user secret storage (absent for interactively signed-in users,
    // whose credentials file on the VM authenticates instead). Platform:
    // the user's own DEDICATED credential when the operator has attached one,
    // else a LIMBO lease from the shared pool — released with an outcome
    // after the turn so the pool can track health. There is no per-user
    // metering on either path: a dedicated subscription enforces its own
    // limits, and limbo is hours, not months.
    let oauthToken: string | undefined;
    let platformLease: PlatformCredentialLease | undefined;
    let platformLeaseKind: 'dedicated' | 'limbo' | undefined;
    let leaseOutcome: PlatformCredentialLeaseOutcome = { kind: 'error' };
    // Set once a seat hop below has already handed the tripped lease back
    // with its outcome — the finally must not release it a second time.
    let leaseReleased = false;
    // What the pool said when a hop found no other seat to run on: its reset
    // is the earliest across ALL the member's seats, and its `model` says
    // whether only this agent's model is out.
    let exhaustedAfterHop: Extract<PlatformUserLease, { kind: 'dedicated_exhausted' }> | undefined;
    let lastRateLimitResetAt: number | undefined;
    if (!attachInfo && usePlatformCredentials) {
      let userLease: PlatformUserLease | undefined;
      try {
        // Naming the model lets the pool skip credentials whose cooldown is
        // scoped to it (a Fable-exhausted account still serves opus/sonnet).
        userLease = await deps.platformCredentialPool!.leaseForUser('claude', userId, {
          ...(targetAgent?.orgId ? { orgId: targetAgent.orgId } : {}),
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(targetAgent?.seatId ? { seatId: targetAgent.seatId } : {}),
        });
      } catch (error) {
        console.error(`[claude-harness] Platform credential lease failed for ${userId}:`, error);
      }
      if (userLease?.kind === 'payment_required') {
        await deliverAssistantMessage({
          deps,
          userId,
          sessionId,
          content: paymentRequiredMessage('Claude'),
          emit,
        });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      // A dedicated user's subscription out of window: say when it's back.
      // Never a fall-through to the shared pool — that would put exactly the
      // heaviest users back on the capacity limbo depends on.
      if (userLease?.kind === 'dedicated_exhausted') {
        const resetMs = userLease.resetAt ? Date.parse(userLease.resetAt) : Number.NaN;
        await Promise.resolve(deps.onHarnessUsageLimit?.({
          cli: 'claude',
          ...(Number.isFinite(resetMs) ? { resetAt: new Date(resetMs).toISOString() } : {}),
        })).catch(() => {});
        const resetAt = Number.isFinite(resetMs) ? new Date(resetMs) : undefined;
        // Only this agent's model is out — another model runs now (note #772).
        const content = userLease.model
          ? modelLimitMessage(userLease.model, resetAt)
          : dedicatedLimitMessage(resetAt);
        await deliverAssistantMessage({ deps, userId, sessionId, content, emit });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      platformLease = (userLease?.kind === 'dedicated' || userLease?.kind === 'limbo')
        ? userLease.lease ?? undefined
        : undefined;
      platformLeaseKind = platformLease ? userLease?.kind as 'dedicated' | 'limbo' : undefined;
      if (!platformLease) {
        harnessLog(sessionId, 'no platform credential leasable', { userId });
        // A limbo resolution with nothing to lease means the owner has no
        // seat at all (a member's seats always answer dedicated/exhausted,
        // and the shared pool retired with the org cutover). Anything else
        // here is a transient lease failure, which is momentary capacity.
        // There is no model gate: what a seat may run is its own
        // subscription's business, and its refusals come back as runtime
        // outcomes like everyone else's.
        const noSeat = userLease?.kind === 'limbo' && !userLease.lease;
        if (noSeat && deps.onHarnessAuthFailure) {
          // The seat sign-in door (workstream 2): the recovery handler owns
          // the state reset AND the user-facing message — it pauses the
          // owner's agents of this CLI and routes their next message into
          // the sign-in ceremony, which is strictly more useful than a
          // message that can only describe the closed door.
          await deps.onHarnessAuthFailure({ cli: 'claude', reason: 'no_seat' }).catch(() => {});
          await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
          emit('agent_complete', {});
          await acknowledgeTerminalRecovery();
          return;
        }
        const content = noSeat ? NO_SEAT_MESSAGE : CLAUDE_PLATFORM_CAPACITY_MESSAGE;
        await deliverAssistantMessage({ deps, userId, sessionId, content, emit });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      oauthToken = platformLease.token;
    } else if (!attachInfo && deps.secretStorage) {
      try {
        oauthToken = await getStoredClaudeOauthToken(deps.secretStorage, userId) ?? undefined;
      } catch (error) {
        console.warn(`[claude-harness] Failed to load OAuth token for ${userId}; relying on VM credentials:`, error);
      }
    }

    // Stage user-sent files onto this agent's machine before the turn: the
    // CLI's own tools open them from ~/inbox (images included), keeping the
    // backend free of media AI. Failures degrade to a note in the prompt.
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

    // The Workspace Agent changed this agent's model or effort on the
    // person's behalf since it last spoke (note #776): said once, on the
    // turn that runs with the new pair, and then cleared. A re-attach sends
    // no prompt, so it neither says nor clears it.
    const runtimeNote = attachInfo ? null : buildRuntimeChangeNote(targetAgent?.runtimeChange, requestedModel, requestedEffort);
    if (runtimeNote && targetAgent) {
      prompt = prompt ? `${prompt}\n\n${runtimeNote}` : runtimeNote;
      void deps.userStorage?.updateAgentFields(userId, targetAgent.id, { runtimeChange: null }).catch(() => {});
    }

    // How full its own window is, told to the agent in the only place a
    // per-turn number can go. Written at the END of the last turn, so it
    // describes where the conversation stood when this agent last spoke —
    // which is what the sentence says, rather than implying it is live.
    //
    // LAST, after the user's words and any staged-file note: this is the
    // platform talking over the user's shoulder, and their message is what
    // the turn is actually about.
    //
    // Silent when there is nothing true to say — a fresh chat (the field is
    // cleared on reset) or a model whose window this backend does not know.
    // An agent told "0% full" at the start of a long conversation would trust
    // it exactly as far as a real number.
    const contextNote = buildContextUsageNote(targetAgent?.contextUsage);
    if (contextNote) {
      prompt = prompt ? `${prompt}\n\n${contextNote}` : contextNote;
    }

    // The user's saved secrets, exported into the turn so the CLI (and
    // anything it shells out to) can reach their own APIs. Scoped to THIS
    // agent: it gets the shared secrets plus its own, and another agent's
    // private keys are never exported here. Declared out here
    // rather than inside the try so the catch below can redact the same values
    // out of a failure message. A storage failure must not cost the user their
    // turn, so it degrades to no secrets rather than throwing.
    const secretEnv = attachInfo
      ? {}
      : await resolveUserSecretEnv(deps.secretStorage, deps.userSecretOwnerId ?? userId, targetAgent?.id, deps.userSecretViewer ?? { ownerIsAdmin: true });

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
        oauthToken,
        secretEnv,
        requestedModel,
        requestedEffort,
        targetAgentId: deps.telegramTargetAgentId,
        ...(targetAgent ? { tokenAgent: targetAgent } : {}),
        initialUsage: profile?.telegram?.providerUsage?.claude,
        // Platform turns run on a POOL account; its stream-reported windows
        // are shared state and must not land on the user's own usage record.
        suppressUserUsageCapture: usePlatformCredentials,
      };
      // A resumed payload can carry attach info for a turn that survived the
      // restart; only honor it for this CLI (stale cross-CLI info re-runs).
      let outcome = await attemptClaudeTurn({
        ...turnArgs,
        resumeSessionId: storedSessionId,
        attach: attachInfo,
        attachProbe,
      });
      recoveryNeedsTerminalAcknowledgement = false;

      // A sandbox reset wipes ~/.claude/projects, orphaning the stored session
      // id. When the resume fails because the conversation is gone, retry once
      // on a fresh session — nothing was delivered yet, so no duplicates.
      if (
        storedSessionId
        && outcome.kind === 'finished'
        && isMissingSessionFailure(outcome)
      ) {
        console.warn(
          `[claude-harness] Session ${storedSessionId} not found on sandbox ${sandboxId}; starting a fresh session for ${sessionId}`,
        );
        outcome = await attemptClaudeTurn({ ...turnArgs, resumeSessionId: undefined });
      }

      // A platform token can die under a RUNNING turn: every agent of one
      // owner runs on the same seat's OAuth grant, and rotating that grant
      // revokes the superseded access token IMMEDIATELY (measured in prod
      // 2026-08-29, note #104) — so a turn that spans a renewal 401s
      // mid-stream while the seat is perfectly healthy and already holds the
      // fresh token. Re-lease, and when the token actually changed, resume
      // the conversation on it instead of failing the user's turn. Once: a
      // retry that comes back with the SAME token means the grant itself is
      // dead, and the normal auth-failure path below owns that.
      if (
        usePlatformCredentials
        && outcome.kind === 'finished'
        && isClaudeAuthFailureText(outcome.turnFailedMessage)
      ) {
        const staleLease = platformLease;
        let release: PlatformUserLease | undefined;
        try {
          release = await deps.platformCredentialPool!.leaseForUser('claude', userId, {
            ...(targetAgent?.orgId ? { orgId: targetAgent.orgId } : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(targetAgent?.seatId ? { seatId: targetAgent.seatId } : {}),
          });
        } catch (error) {
          console.warn(`[claude-harness] Re-lease after a revoked token failed for ${userId}:`, error);
        }
        const freshLease = (release?.kind === 'dedicated' || release?.kind === 'limbo')
          ? release.lease ?? undefined
          : undefined;
        // A fresh turn can compare the token it launched with. A re-attached
        // turn deliberately carries no secret/lease through the restart, so
        // there is nothing safe to compare: retry once on the current lease.
        // If that grant is actually dead, the retry comes back through the
        // ordinary platform auth-failure path below and benches it.
        if (freshLease && (!staleLease || freshLease.token !== staleLease.token)) {
          // The stale lease is not at fault — rotation is the grant's normal
          // life, and benching it would punish the very credential that just
          // healed. Swap leases; the finally releases whichever we hold.
          if (staleLease) {
            await deps.platformCredentialPool!
              .releaseCredential(staleLease.credentialId, { kind: 'error' })
              .catch(() => {});
          }
          platformLease = freshLease;
          platformLeaseKind = release!.kind as 'dedicated' | 'limbo';
          oauthToken = freshLease.token;
          // A conversation that got as far as announcing an id holds the
          // prompt (and any partial answer) — continue it. One that never
          // did left no trace, so the original prompt replays cleanly.
          const capturedId = outcome.claudeSessionId;
          // A re-attached process was already launched with this payload
          // before the backend restarted. Even when it resumed the same
          // stored session id, replaying the original prompt would duplicate
          // the user's request; continue with the platform note instead.
          const conversationHasPrompt = capturedId !== undefined
            && (attachInfo !== undefined || capturedId !== storedSessionId);
          harnessLog(sessionId, 'token rotated mid-turn; retrying on the fresh lease', {
            credentialId: freshLease.credentialId,
            resumed: conversationHasPrompt,
          });
          outcome = await attemptClaudeTurn({
            ...turnArgs,
            oauthToken,
            // The failed attached process has exited. Re-attaching to its
            // completed output would only read the same 401 again; the retry
            // is a new CLI process resuming the native conversation.
            attach: undefined,
            attachProbe: undefined,
            ...(conversationHasPrompt
              ? { prompt: CLAUDE_TOKEN_ROTATED_RESUME_PROMPT, resumeSessionId: capturedId }
              : { resumeSessionId: storedSessionId }),
          });
        } else if (freshLease) {
          // Same token again — nothing new to run on. Hand the duplicate
          // lease straight back and let the failure path judge the original.
          await deps.platformCredentialPool!
            .releaseCredential(freshLease.credentialId, { kind: 'error' })
            .catch(() => {});
        }
      }

      // A usage limit on one seat is not the member's last word while they
      // hold another (note #772). Hand the tripped seat back with its limit —
      // which benches it, or only this model on it when the CLI says the
      // limit is the model's — and lease again: the member's next seat that
      // can serve this model runs the SAME turn now, instead of the member
      // learning about it from a failure and a second message. Bounded: each
      // hop benches the seat it leaves, so the lease runs out of seats.
      for (
        let hop = 0;
        hop < MAX_SEAT_HOPS
          && usePlatformCredentials
          && platformLease
          && platformLeaseKind === 'dedicated'
          && outcome.kind === 'finished'
          && isClaudeUsageLimitText(outcome.turnFailedMessage);
        hop += 1
      ) {
        const tripped = platformLease;
        const trippedOutcome = claudeLimitOutcome(
          outcome.turnFailedMessage,
          outcome.rateLimitResetAt,
          requestedModel,
        );
        await deps.platformCredentialPool!
          .releaseCredential(tripped.credentialId, trippedOutcome)
          .catch((error) => {
            console.warn(`[claude-harness] Failed to release platform credential ${tripped.credentialId}:`, error);
          });
        leaseReleased = true;
        let next: PlatformUserLease | undefined;
        try {
          next = await deps.platformCredentialPool!.leaseForUser('claude', userId, {
            ...(targetAgent?.orgId ? { orgId: targetAgent.orgId } : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(targetAgent?.seatId ? { seatId: targetAgent.seatId } : {}),
          });
        } catch (error) {
          console.warn(`[claude-harness] Re-lease after a usage limit failed for ${userId}:`, error);
        }
        if (next?.kind === 'dedicated_exhausted') exhaustedAfterHop = next;
        const nextLease = next?.kind === 'dedicated' ? next.lease : undefined;
        if (!nextLease || nextLease.credentialId === tripped.credentialId) {
          // Nothing else to run on: the failure path below speaks for the
          // limit, and the tripped lease is already back with its outcome.
          if (nextLease) {
            await deps.platformCredentialPool!
              .releaseCredential(nextLease.credentialId, { kind: 'error' })
              .catch(() => {});
          }
          break;
        }
        harnessLog(sessionId, 'usage limit on one seat; continuing on the next', {
          from: tripped.credentialId,
          to: nextLease.credentialId,
          modelOnly: trippedOutcome.modelOnly === true,
        });
        platformLease = nextLease;
        leaseReleased = false;
        exhaustedAfterHop = undefined;
        oauthToken = nextLease.token;
        const capturedId = outcome.claudeSessionId;
        const conversationHasPrompt = capturedId !== undefined
          && (attachInfo !== undefined || capturedId !== storedSessionId);
        outcome = await attemptClaudeTurn({
          ...turnArgs,
          oauthToken,
          attach: undefined,
          attachProbe: undefined,
          ...(conversationHasPrompt
            ? { prompt: CLAUDE_SEAT_SWITCHED_RESUME_PROMPT, resumeSessionId: capturedId }
            : { resumeSessionId: storedSessionId }),
        });
      }

      if (outcome.kind === 'interrupted') {
        return;
      }
      lastRateLimitResetAt = outcome.rateLimitResetAt;

      const { exitCode, turnFailedMessage, deliveredMessageCount, lastAssistantMessage, transcript } = outcome;
      if (turnFailedMessage || (exitCode !== null && exitCode !== 0 && deliveredMessageCount === 0)) {
        const tail = stripAnsiEscapes(transcript).trim().slice(-ERROR_TAIL_CHARS);
        throw new NonRecoverableAgentError(
          turnFailedMessage
            ? `Claude turn failed: ${turnFailedMessage}`
            : `Claude exited with code ${exitCode}. Output tail:\n${tail}`,
        );
      }

      await deps.sessionStorage.updateSession(userId, sessionId, {
        status: 'completed',
        ...(lastAssistantMessage
          ? { lastAssistantMessage, lastAssistantMessageAt: new Date().toISOString() }
          : {}),
      });
      // How full the window is, on THIS agent's record — the agents of one
      // account share a session document and are told apart by run key, so
      // the session is the one place this must not live.
      //
      // Only when the stream actually reported a size. A turn that never
      // reached the API says nothing about the conversation's size, and
      // writing zero would redraw a nearly-full window as empty.
      if (targetAgent?.id && outcome.contextTokens !== undefined) {
        await deps.userStorage?.updateAgentFields?.(userId, targetAgent.id, {
          contextUsage: {
            tokens: outcome.contextTokens,
            ...(outcome.model ? { model: outcome.model } : {}),
            at: new Date().toISOString(),
          },
        });
      }
      leaseOutcome = { kind: 'ok' };
      emit('agent_complete', {});
    } catch (error) {
      // The runner must see this exact class so it can refuse a replacement
      // turn when the old detached CLI may still be alive.
      if (error instanceof DetachedTurnRestartSafetyError) throw error;
      await acknowledgeTerminalRecovery();
      const message = error instanceof Error ? error.message : String(error);
      const authFailure = isClaudeAuthFailureText(message);
      const billingFailure = isClaudeBillingFailureText(message);
      const usageLimit = isClaudeUsageLimitText(message);

      // Platform-credential turns: an auth death or exhausted limit is the
      // POOL's problem, not the user's sign-in — report it to the pool (the
      // finally below benches the credential) and surface a retry-friendly
      // message instead of triggering per-user auth recovery.
      if (usePlatformCredentials && (authFailure || billingFailure || usageLimit)) {
        // A backend restart re-attaches to the native CLI without persisting
        // its secret-bearing lease. If re-leasing above itself failed, this
        // is still a PLATFORM turn: never fall through to per-user recovery
        // and pause every Claude agent because one old process held a revoked
        // access token.
        if (!platformLease) {
          throw new NonRecoverableAgentError(CLAUDE_PLATFORM_HICCUP_MESSAGE);
        }
        const profile = authFailure || billingFailure
          ? await readClaudeProfileWithProfileToken(platformLease.token, harnessDeps.fetchImpl)
          : undefined;
        const billingStatus = profile?.subscriptionStatus;
        const confirmedBillingStatus = billingStatus !== undefined
          && CLAUDE_PAYMENT_REQUIRED_STATUSES.has(billingStatus)
          ? billingStatus
          : undefined;
        const paymentRequired = confirmedBillingStatus !== undefined;
        // Cool the credential down until its tripped window ACTUALLY resets —
        // the epoch Anthropic glues into the 429 text, else the stream's last
        // rate_limit_event. A model-specific weekly limit (Fable) resets days
        // out; the default 30-minute cooldown would flap the credential
        // against it, burning a user turn every revival.
        const limitOutcome = usageLimit
          ? claudeLimitOutcome(message, lastRateLimitResetAt, requestedModel)
          : undefined;
        const retryAfterSeconds = limitOutcome?.retryAfterSeconds;
        leaseOutcome = paymentRequired
          ? {
            kind: 'payment_required',
            subscriptionStatus: confirmedBillingStatus,
            detail: message.slice(-300),
          }
          : authFailure
          ? { kind: 'auth_failed', detail: message.slice(-300) }
          : billingFailure || !limitOutcome
          ? { kind: 'error' }
          : limitOutcome;
        console.warn(
          `[claude-harness] Platform credential ${platformLease.credentialId} failed turn (${leaseOutcome.kind}`
          + `${retryAfterSeconds !== undefined ? `, cooldown ${retryAfterSeconds}s` : ''}):`,
          redactHarnessSecrets(message, [oauthToken, ...Object.values(secretEnv)]),
        );
        // On a DEDICATED credential a usage limit is the user's own
        // subscription speaking, and "try again" would be a lie — the retry
        // meets the same wall. Say when it lifts instead.
        if (platformLeaseKind === 'dedicated' && usageLimit) {
          // After a hop the pool's answer covers every seat the member holds;
          // without one, this seat's own reset is all there is to say.
          const resetSeconds = claudeUsageLimitResetAtSeconds(message) ?? lastRateLimitResetAt;
          const hopResetMs = exhaustedAfterHop?.resetAt ? Date.parse(exhaustedAfterHop.resetAt) : Number.NaN;
          const resetAt = Number.isFinite(hopResetMs)
            ? new Date(hopResetMs)
            : resetSeconds !== undefined ? new Date(resetSeconds * 1000) : undefined;
          await Promise.resolve(deps.onHarnessUsageLimit?.({
            cli: 'claude',
            ...(resetAt ? { resetAt: resetAt.toISOString() } : {}),
          })).catch(() => {});
          const outOfModel = exhaustedAfterHop
            ? exhaustedAfterHop.model
            : limitOutcome?.modelOnly ? requestedModel : undefined;
          throw new NonRecoverableAgentError(
            outOfModel ? modelLimitMessage(outOfModel, resetAt) : dedicatedLimitMessage(resetAt),
          );
        }
        if (platformLeaseKind === 'dedicated' && paymentRequired) {
          throw new NonRecoverableAgentError(paymentRequiredMessage('Claude'));
        }
        throw new NonRecoverableAgentError(CLAUDE_PLATFORM_HICCUP_MESSAGE);
      }

      // Later turns skip the auth pre-check, so a dead sign-in surfaces here
      // as a runtime failure — classify it and trigger recovery. Recovery
      // owns the user-facing message, so the rethrow is marked userNotified
      // and the runner keeps the raw error out of the chat.
      const authDeath = Boolean(deps.onHarnessAuthFailure) && authFailure;
      if (authDeath) {
        await deps.onHarnessAuthFailure!({ cli: 'claude' }).catch(() => {});
      }
      if (error instanceof NonRecoverableAgentError) {
        if (authDeath && !error.userNotified) {
          throw new NonRecoverableAgentError(error.message, { userNotified: true });
        }
        throw error;
      }
      throw new NonRecoverableAgentError(redactHarnessSecrets(message, [oauthToken, ...Object.values(secretEnv)]), { userNotified: authDeath });
    } finally {
      if (platformLease && !leaseReleased) {
        await deps.platformCredentialPool!
          .releaseCredential(platformLease.credentialId, leaseOutcome)
          .catch((error) => {
            console.warn(`[claude-harness] Failed to release platform credential ${platformLease!.credentialId}:`, error);
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

type ClaudeTurnOutcome =
  | { kind: 'interrupted' }
  | {
    kind: 'finished';
    exitCode: number | null;
    turnFailedMessage?: string;
    /**
     * The native conversation this attempt ran as — the resumed id, or the
     * fresh one the stream announced. A failed attempt's conversation still
     * holds the prompt and everything said, which is what lets a retry resume
     * it instead of replaying the turn.
     */
    claudeSessionId?: string;
    deliveredMessageCount: number;
    lastAssistantMessage?: string;
    transcript: string;
    /** Epoch seconds of the last stream-reported rate-limit reset, if any. */
    rateLimitResetAt?: number;
    /**
     * The CONCRETE model the stream reported running (`claude-fable-5-…`) —
     * stored with the context reading rather than the requested alias: a turn
     * with no explicit model still runs on something.
     */
    model?: string;
    /**
     * How full the context window was on this turn's LAST request, in tokens.
     * Absent when the stream reported nothing usable — a synthetic answer, or
     * a turn that never reached the API — which is not the same as an empty
     * context and must not be stored as zero.
     */
    contextTokens?: number;
  };

function isMissingSessionFailure(outcome: Extract<ClaudeTurnOutcome, { kind: 'finished' }>): boolean {
  // The error can surface on stderr (the PTY transcript) or as an is_error
  // result event in the turn file (turnFailedMessage); check both.
  return outcome.deliveredMessageCount === 0
    && MISSING_SESSION_PATTERN.test(`${stripAnsiEscapes(outcome.transcript)}\n${outcome.turnFailedMessage ?? ''}`);
}

async function attemptClaudeTurn(args: {
  harnessDeps: ClaudeHarnessDeps;
  deps: AgentLoopDeps;
  userId: string;
  sessionId: string;
  sandboxId: string;
  prompt: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  emit: (type: WSMessageType, data: unknown) => void;
  /** Re-attach to a turn that survived a backend restart (see resumePendingTurns). */
  attach?: HarnessTurnAttachInfo;
  /** Authoritative probe already completed before auth/capacity gates. */
  attachProbe?: 'running' | 'finished' | 'unknown';
  oauthToken?: string;
  /** The user's saved secrets, exported into the turn and redacted out of its transcript. */
  secretEnv?: Record<string, string>;
  requestedModel?: string;
  requestedEffort?: string;
  /** The agent this turn is pinned to; conversation writes target it. */
  targetAgentId?: string;
  /** The same agent's record, for the token ledger's credit (owner, workplace, name). */
  tokenAgent?: Pick<AgentRecord, 'id' | 'name' | 'orgId'>;
  initialUsage?: ProviderUsageSnapshot;
  suppressUserUsageCapture?: boolean;
}): Promise<ClaudeTurnOutcome> {
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
    oauthToken,
    secretEnv,
    requestedModel,
    requestedEffort,
    targetAgentId,
    tokenAgent,
    initialUsage,
    suppressUserUsageCapture,
  } = args;
  const { sandboxClient } = harnessDeps;
  const runKey = targetAgentId ? `${sessionId}::agent:${targetAgentId}` : sessionId;
  // Everything that must never reach a transcript, log line, or user-facing
  // error from this turn: the CLI credential plus every secret value exported
  // into it. The CLI can echo a secret back (a curl command it composed, a
  // stack trace), so redaction covers the values, not just the credential.
  const turnSecrets = [oauthToken, ...Object.values(secretEnv ?? {})];

  // Re-attach first: a turn that survived a backend restart is still running
  // (or already finished) on the machine — continue its stream instead of
  // re-running the prompt. A gone process falls through to a fresh launch.
  let attached: HarnessTurnAttachInfo | undefined;
  if (attach) {
    const probed = attachProbe ?? (
      await inspectDetachedTurnUntilKnown(
        sandboxClient, attach.sandboxId, attach.outputPath, HARNESS_SSH_USER, signal,
        (failures) => {
          if (failures === 1) {
            harnessLog(sessionId, 'attach probe unavailable; retrying before any relaunch', {
              outputPath: attach.outputPath,
            });
          }
        },
      )
    ).state;
    if (probed === 'gone') {
      harnessLog(sessionId, 'attach target gone — re-running the turn', { outputPath: attach.outputPath });
    } else {
      attached = attach;
      harnessLog(sessionId, 'RE-ATTACHED to detached turn', {
        pid: attach.pid,
        probed,
        consumedLines: attach.consumedLines,
        delivered: attach.deliveredMessageCount,
      });
    }
  }

  const outputPath = attached?.outputPath ?? buildTurnOutputPath();
  // Fresh turns always receive exactly one positional prompt and own that
  // work until they finish. A message arriving meanwhile stays in the
  // BackgroundRunner queue for the NEXT turn; feeding it into this process
  // can interrupt an in-flight Bash command (the failure behind note #28).
  //
  // `inputPath` survives only for a streamed turn launched by an older
  // backend before a rolling deploy. We re-attach and close that legacy pipe
  // after its result so the turn can finish, but never write new work to it.
  const inputPath = attached?.inputPath;
  const turnStartedAt = attached?.turnStartedAt ?? Date.now();
  let handle: DetachedTurnHandle | undefined = attached ? { outputPath, pid: attached.pid } : undefined;
  if (!handle) {
    // The pre-sleep update may be replacing this very CLI: wait it out rather
    // than start a binary that is not there yet. Before the abort check, so a
    // Stop pressed meanwhile still ends the turn.
    const install = harnessDeps.cliInstallInFlight?.(sandboxId);
    if (install) {
      harnessLog(sessionId, 'CLI install in flight on this machine; the turn starts when it is done', { sandboxId });
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
    const command = buildClaudeExecCommand({ prompt, resumeSessionId, oauthToken, model: requestedModel, effort: requestedEffort });
    harnessLog(sessionId, 'turn start', {
      sandboxId,
      sshUser: HARNESS_SSH_USER,
      cwd: HARNESS_CWD,
      resume: Boolean(resumeSessionId),
      hasToken: Boolean(oauthToken),
      outputPath,
      command: redactHarnessSecrets(redactCommand(command), turnSecrets),
    });
    // Detached launch: the CLI runs under setsid on the MACHINE, decoupled
    // from this backend process — a deploy restart no longer kills the turn.
    // Register the unique output path BEFORE awaiting SSH. If nohup starts but
    // its reply is lost, shutdown persistence still has enough information to
    // recover the PID sidecar instead of launching an overlapping turn.
    registerActiveDetachedTurn(runKey, {
      cli: 'claude',
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
        env: secretEnv,
        signal,
      });
    } catch (error) {
      // A definitive "nothing launched" result is safe to release. An
      // uncertain result is a restart-safety error and must keep the
      // provisional marker quarantined for shutdown/next-message recovery.
      if (!(error instanceof DetachedTurnRestartSafetyError)) {
        clearActiveDetachedTurn(runKey);
      }
      throw error;
    }
    harnessLog(sessionId, 'detached turn started', { pid: handle.pid });
  }
  const activeHandle: DetachedTurnHandle = handle;

  const reader = new TurnOutputReader(
    sandboxClient, sandboxId, outputPath, HARNESS_SSH_USER, attached?.consumedLines ?? 0,
  );
  let transcript = '';
  let claudeSessionId = resumeSessionId;
  let deliveredMessageCount = attached?.deliveredMessageCount ?? 0;
  let currentActivity = attached?.currentActivity;
  registerActiveDetachedTurn(runKey, {
    cli: 'claude',
    sandboxId,
    outputPath,
    pid: activeHandle.pid,
    consumedLines: reader.linesConsumed,
    deliveredMessageCount,
    ...(currentActivity ? { currentActivity } : {}),
    turnStartedAt,
    // Carried into the shutdown checkpoint: after a restart the next boot has
    // to be able to close this pipe, or the re-attached turn never ends.
    ...(inputPath ? { inputPath } : {}),
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
        const inspected = await inspectDetachedTurnUntilKnown(
          sandboxClient,
          sandboxId,
          outputPath,
          HARNESS_SSH_USER,
        );
        if (inspected.state === 'finished' || inspected.state === 'gone') {
          terminationProven = true;
          return;
        }
        if (inspected.state !== 'running' || !inspected.pid) {
          throw new DetachedTurnTerminationError(
            `Claude turn ${outputPath} has no safely recoverable process id.`,
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
  let turnFailedMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  let resolvedModel: string | undefined;
  // The most recent prompt's size — overwritten, never accumulated, because
  // it answers "how full is the window NOW" rather than "how much did this
  // turn cost".
  let contextTokens: number | undefined;
  // What this run spent, for the owner's token ledger (agent/turn-tokens.ts):
  // the conversation's running total in the `result` event, less where it
  // stood after the last credited turn. The base is read fresh here rather
  // than off the turn-start record, because one turn can run this function
  // twice (a retry on a fresh session, or on a renewed token) and the second
  // run must difference against what the first one left. A run with no
  // `result` — stopped, or left running across a backend restart — credits
  // nothing; the next total spans it.
  const turnTokens = new ClaudeTurnTokens();
  const creditTokens = async (): Promise<void> => {
    if (!tokenAgent?.id) return;
    try {
      const record = (await deps.userStorage?.getProfile(userId))?.telegram?.agents?.[tokenAgent.id];
      const settled = turnTokens.settle({
        sessionId: claudeSessionId,
        startedSession: !resumeSessionId,
        ...(record?.claudeTokenBase ? { base: record.claudeTokenBase } : {}),
        model: resolvedModel ?? requestedModel,
      });
      if (!settled) return;
      creditTurnTokens({
        ledger: deps.agentTokenLedger, userId, agent: tokenAgent, provider: 'claude', perModel: settled.perModel,
      });
      if (settled.base) {
        await deps.userStorage?.updateAgentFields?.(userId, tokenAgent.id, { claudeTokenBase: settled.base });
      }
    } catch (error) {
      console.warn(`[claude-harness] Token credit failed for agent ${tokenAgent.id}:`, error);
    }
  };
  let rateLimitResetAt: number | undefined;
  const usageWindows = new Map(Object.entries(initialUsage?.windows ?? {}));

  const persistClaudeSessionId = async (eventSessionId: string | undefined): Promise<void> => {
    if (!eventSessionId || eventSessionId === claudeSessionId) return;
    let failures = 0;
    while (true) {
      try {
        if (deps.userStorage) {
          // Pin the pointer write to this turn's agent so a concurrent turn on
          // another agent can never receive this conversation id.
          await deps.userStorage.updateTelegramHarnessConversation(
            userId,
            { claudeSessionId: eventSessionId },
            targetAgentId ? { agentId: targetAgentId } : undefined,
          );
        } else {
          await deps.sessionStorage.updateSession(userId, sessionId, { claudeSessionId: eventSessionId });
        }
        break;
      } catch (error) {
        failures += 1;
        if (signal?.aborted && !isProcessShutdownAbort(signal)) {
          // Do not let a continuity-storage outage keep the abandoned command
          // running. Once the process is gone it is safe to keep retrying the
          // id write without delaying Steering or Manual Stop.
          await terminateDetachedTurn();
        }
        if (isHarnessShutdownInProgress()) {
          throw new DetachedTurnContinuityError(
            'Claude session id could not be persisted before backend shutdown.',
            { cause: error },
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(failures, 5) * 1_000);
        });
      }
    }
    claudeSessionId = eventSessionId;
    harnessLog(sessionId, 'claude session id captured', { claudeSessionId: eventSessionId });
  };

  const captureContinuityFromLines = async (lines: string[]): Promise<void> => {
    for (const line of lines) {
      const event = parseClaudeStreamEventLine(line);
      if (event) await persistClaudeSessionId(getClaudeSessionId(event));
    }
  };

  // After an interrupted process has ACTUALLY exited, consume only continuity
  // identifiers written since the last poll. Delivering its stale assistant
  // blocks would answer work the user just replaced, but losing a first-turn
  // init id would make the replacement start a different native conversation.
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
            'Claude exited, but its native session id could not be safely captured.',
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
        // The poll already advanced its line offset. Retain native continuity
        // from the unread batch, but never deliver output from the direction
        // the user just replaced.
        await captureContinuityFromLines(lines.slice(index));
        return;
      }
      const line = lines[index]!;
      const event = parseClaudeStreamEventLine(line);
      if (!event) continue;

      resolvedModel = getClaudeModel(event) ?? resolvedModel;
      contextTokens = getClaudeContextTokens(event) ?? contextTokens;
      turnTokens.observe(event);
      // Tracked on every turn (platform AND user): if this turn dies on a
      // usage limit, the last reported reset sizes the credential's cooldown.
      rateLimitResetAt = getClaudeRateLimitResetAt(event) ?? rateLimitResetAt;

      const usageUpdates = suppressUserUsageCapture ? [] : getClaudeUsageWindows(event);
      if (usageUpdates.length > 0) {
        for (const window of usageUpdates) usageWindows.set(window.id, window);
        await deps.userStorage?.updateTelegramProviderUsage?.(userId, 'claude', {
          windows: Object.fromEntries(usageWindows),
          capturedAt: new Date().toISOString(),
          ...(initialUsage?.planType ? { planType: initialUsage.planType } : {}),
          ...(initialUsage?.credits ? { credits: initialUsage.credits } : {}),
        });
      }

      // Live status: the latest tool call is "what the agent is doing".
      const toolSummaries = getToolUseSummaries(event);
      if (toolSummaries.length > 0) {
        currentActivity = redactHarnessSecrets(toolSummaries.at(-1)!, turnSecrets);
      }

      await persistClaudeSessionId(getClaudeSessionId(event));

      // Claude Code 2.1.251 wraps a terminal 401 in a synthetic assistant
      // event before the failed result. It is diagnostic input to recovery,
      // never an assistant reply to deliver to the user.
      const apiErrorMessage = getClaudeApiErrorMessage(event);
      if (apiErrorMessage) {
        turnFailedMessage = apiErrorMessage;
      }

      for (const text of apiErrorMessage ? [] : getAssistantTextBlocks(event)) {
        if (signal?.aborted) {
          await captureContinuityFromLines(lines.slice(index + 1));
          return;
        }
        lastAssistantMessage = text;
        deliveredMessageCount += 1;
        harnessLog(sessionId, 'delivering assistant text', { chars: text.length, index: deliveredMessageCount });
        await deliverAssistantMessage({
          deps,
          userId,
          sessionId,
          content: text,
          emit,
          model: resolvedModel,
          requestedModel,
          outbound: { sandboxClient, sandboxId },
        });
      }

      const resultInfo = getResultInfo(event);
      if (resultInfo) {
        sawLegacyInputResult = true;
        if (resultInfo.isError) {
          turnFailedMessage = resultInfo.text?.trim() || resultInfo.subtype || 'Claude reported an error.';
        } else if (
          deliveredMessageCount === 0
          && resultInfo.text?.trim()
          && !signal?.aborted
        ) {
          // No streamed assistant text this turn; deliver the summary.
          lastAssistantMessage = resultInfo.text.trim();
          deliveredMessageCount += 1;
          await deliverAssistantMessage({
            deps,
            userId,
            sessionId,
            content: lastAssistantMessage,
            emit,
            model: resolvedModel,
            requestedModel,
            outbound: { sandboxClient, sandboxId },
          });
        }
      }
    }
  };

  // Stall clock, not a wall clock: reset on every batch of new stream events.
  // Starts at this attempt's own start even on re-attach — the checkpointed
  // turnStartedAt may be long past, and a surviving turn deserves a full
  // window before it can be called stalled.
  let lastProgressAt = Date.now();
  let exitCode: number | null = null;
  // A pre-deploy streamed-input turn waits on its FIFO after emitting a
  // `result`. Close that legacy pipe once, so rolling deploys do not strand a
  // turn that the previous backend launched. Fresh turns have no inputPath.
  let sawLegacyInputResult = false;
  let stdinClosed = false;
  let running = true;
  let pollCount = 0;
  let lastHeartbeatAt = turnStartedAt;

  try {
    while (running) {
      if (signal?.aborted) {
        if (isProcessShutdownAbort(signal)) {
          // Backend restarting, not a user cancel: leave the CLI running (the
          // checkpoint carries attach info) and keep the turn file + registry
          // entry intact for the re-attach.
          harnessLog(sessionId, 'backend shutting down — leaving detached turn running', {
            pid: activeHandle.pid, linesConsumed: reader.linesConsumed, delivered: deliveredMessageCount,
          });
          leaveRunning = true;
          return { kind: 'interrupted' };
        }
        harnessLog(sessionId, 'turn interrupted (abort signal)', { pollCount, linesConsumed: reader.linesConsumed });
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
        return { kind: 'interrupted' };
      }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        const turnFileTail = await reader.readTailForDiagnostics(DIAGNOSTIC_TAIL_CHARS);
        const stderrTail = await reader.readStderrTail(DIAGNOSTIC_TAIL_CHARS);
        harnessLog(sessionId, 'turn STALLED — dumping diagnostics', {
          elapsedMs: Date.now() - turnStartedAt,
          quietMs: Date.now() - lastProgressAt,
          pollCount,
          exitCode,
          linesConsumed: reader.linesConsumed,
          delivered: deliveredMessageCount,
          stderrTail: redactHarnessSecrets(stripAnsiEscapes(stderrTail), turnSecrets)
            .trim().slice(-ERROR_TAIL_CHARS),
          turnFileTail: redactHarnessSecrets(turnFileTail, turnSecrets)
            .trim().slice(-DIAGNOSTIC_TAIL_CHARS),
        });
        await terminateDetachedTurn();
        throw new Error(CLAUDE_TURN_STALLED_MESSAGE);
      }
      const poll = await reader.readNewLinesWithStatus();
      pollCount += 1;
      running = poll.running;
      exitCode = poll.exitCode ?? exitCode;
      if (poll.lines.length > 0) {
        lastProgressAt = Date.now();
      }
      if (signal?.aborted) {
        await captureContinuityFromLines(poll.lines);
        updateActiveDetachedTurn(runKey, { consumedLines: reader.linesConsumed });
        // Even if this poll also observed a natural exit, pass through the
        // abort branch once so steering gets the same verified boundary and
        // interrupted status.
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

      // Migration cleanup only: an old streamed turn ends when this backend
      // closes its FIFO. Queued user messages are intentionally untouched;
      // BackgroundRunner starts them as ordinary turns after this one exits.
      if (inputPath && running && sawLegacyInputResult && !stdinClosed) {
        stdinClosed = true;
        harnessLog(sessionId, 'closing legacy turn stdin after its reply', {});
        await closeTurnInput(sandboxClient, sandboxId, inputPath, HARNESS_SSH_USER);
      }

      if (running) {
        await sleepUnlessAborted(POLL_TIMEOUT_MS, signal);
      }

      // Periodic breadcrumb so a hung turn is visible in the logs while it
      // hangs, showing whether the CLI has produced any output at all.
      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_LOG_INTERVAL_MS) {
        lastHeartbeatAt = Date.now();
        harnessLog(sessionId, 'still running', {
          elapsedMs: Date.now() - turnStartedAt,
          quietMs: Date.now() - lastProgressAt,
          pollCount,
          linesConsumed: reader.linesConsumed,
          delivered: deliveredMessageCount,
        });
      }
    }
    if (exitCode !== 0 || turnFailedMessage) {
      transcript = await reader.readStderrTail(DIAGNOSTIC_TAIL_CHARS);
    }
    if (
      deliveredMessageCount > 0
      || (!turnFailedMessage && (exitCode === null || exitCode === 0))
    ) {
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
    elapsedMs: Date.now() - turnStartedAt,
    pollCount,
    exitCode,
    delivered: deliveredMessageCount,
    linesConsumed: reader.linesConsumed,
    ...(turnFailedMessage ? { turnFailedMessage } : {}),
  });

  await creditTokens();
  return {
    kind: 'finished',
    exitCode,
    turnFailedMessage,
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
    deliveredMessageCount,
    lastAssistantMessage,
    transcript: redactHarnessSecrets(transcript, turnSecrets),
    ...(rateLimitResetAt !== undefined ? { rateLimitResetAt } : {}),
    ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
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

  // ATTACH: lines → pull the files off the machine, fold failures into the
  // text (visible, never silent), deliver text first, then the files.
  let outboundFiles: OutboundFile[] = [];
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
    model: model ?? requestedModel ?? 'claude',
    source: 'claude-cli',
    ...(requestedModel ? { requestedModel } : {}),
  });
  await deps.notifyAssistantResponse?.({
    userId,
    sessionId,
    content,
    source: 'claude-cli',
    ...(model ? { model } : {}),
    ...(requestedModel ? { requestedModel } : {}),
  });

  for (const file of outboundFiles) {
    try {
      await deps.sendUserFile!(file);
    } catch (error) {
      console.warn(`[claude-harness] Failed to send outbound file ${file.fileName}:`, error);
    }
  }
}

export function buildClaudeExecCommand(args: {
  prompt: string;
  resumeSessionId?: string;
  oauthToken?: string;
  model?: string;
  effort?: string;
}): string {
  const parts = [
    // The setup-token credential authenticates via env var only (it is never
    // written to ~/.claude/.credentials.json), so inject it on the command.
    ...(args.oauthToken ? [`${CLAUDE_OAUTH_TOKEN_ENV}=${quoteShellArg(args.oauthToken)}`] : []),
    'claude',
    '-p',
    quoteShellArg(args.prompt),
    '--output-format stream-json',
    '--verbose',
    '--permission-mode bypassPermissions',
  ];
  if (args.model) {
    parts.push('--model', quoteShellArg(args.model));
  }
  // `--effort` persists across `--resume` (verified against claude 2.1.207).
  if (args.effort) {
    parts.push('--effort', quoteShellArg(args.effort));
  }
  if (args.resumeSessionId) {
    parts.push('--resume', quoteShellArg(args.resumeSessionId));
  }
  return parts.join(' ');
}
