/**
 * Agent harness backed by the Codex CLI running inside the
 * user's sandbox VM, authenticated with the user's own ChatGPT subscription.
 *
 * Implements `AgentLoopFn` so BackgroundRunner plumbing
 * (queueing, error delivery, completion hooks, queued-message restarts) is
 * reused unchanged. Each user message becomes one `codex exec --json` turn:
 * the PTY supervises the process (status, exit code, abort) while the JSONL
 * event stream is redirected to a per-turn file and polled back byte-exact
 * (see harness-turn-output.ts); completed agent messages are delivered
 * through `notifyAssistantResponse`.
 *
 * Usage is billed to the user's ChatGPT plan — deliberately no
 * model-usage billing here.
 */

import type { AgentLoopDeps } from '../agent-loop.js';
import { dedicatedLimitMessage, NO_SEAT_MESSAGE, paymentRequiredMessage } from '../platform-turn-policy.js';
import { NonRecoverableAgentError, type AgentLoopFn } from '../background-runner.js';
import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { UserInputPayload, WSMessage, WSMessageType } from '../../types/agent.js';
import { buildRuntimeChangeNote, resolveEffectiveEffort, resolveEffectiveModel } from '../harness-models.js';
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
import type { HarnessTurnAttachInfo } from '../../types/agent.js';
import {
  getCompletedItem,
  getStartedItemSummary,
  isAgentMessageItem,
  parseCodexExecEventLine,
  stripAnsiEscapes,
} from './codex-exec-events.js';
import { ensureCodexAuth, readCodexAuthFile, writeCodexAuthFile } from './codex-login.js';
import { readCodexProviderUsage } from './codex-usage.js';
import { readCodexContextUsage, type CodexContextReading } from './codex-context.js';
import { buildContextUsageNote } from '../../utils/context-window.js';
import { isCodexAuthFailureText, isCodexUsageLimitText } from '../harness-auth-failure.js';
import type {
  PlatformUserLease,
  PlatformCredentialLease,
  PlatformCredentialLeaseOutcome,
  PlatformCredentialReleaseExtras,
} from '../../types/platform-credential.js';
import {
  extractOutboundAttachments,
  fetchOutboundAttachment,
  getStageableHarnessAttachments,
  stageHarnessAttachments,
} from '../harness-attachments.js';
import { quoteShellArg } from '../../utils/shell-quote.js';
import { codexTurnTokens, creditTurnTokens } from '../turn-tokens.js';

export interface CodexHarnessDeps {
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
}

// Run the CLI as the non-root `agent` user — the same user the setup agent
// signs in as, so ~/.codex (auth + config) is the one it populated. Running as
// root gave a fresh, unauthenticated config on a different home.
const HARNESS_SSH_USER = DEFAULT_DEVELOPMENT_SSH_USER;
const HARNESS_CWD = getDefaultDevelopmentRootForSshUser(HARNESS_SSH_USER);

// A turn is killed for silence, not for length — see the twin constant in
// claude-harness.ts for the full rationale. 15 minutes of no new stream
// events clears the longest single tool call with margin; there is
// deliberately no wall-clock cap.
const STALL_TIMEOUT_MS = 15 * 60_000;
// With stdout redirected to the turn file, the PTY (stderr) is mostly quiet,
// so the waitForChange timeout is the effective pacing for turn-file polls.
const POLL_TIMEOUT_MS = 2_500;
const ERROR_TAIL_CHARS = 600;

function harnessLog(sessionId: string, message: string, extra?: Record<string, unknown>): void {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  console.info(`[codex-harness] [${sessionId}] ${message}${suffix}`);
}

export const CODEX_NOT_CONNECTED_MESSAGE = [
  'The Codex harness is enabled, but no ChatGPT account is connected yet.',
  'Open /harness and tap "Connect ChatGPT" to sign in, or switch back to the default harness.',
].join('\n');

export const CODEX_WORKSPACE_UNAVAILABLE_MESSAGE = [
  "Couldn't start your workspace.",
  'Try again in a moment, or open /harness for options.',
].join('\n');

// Platform-credential turns: same copy as the Claude twins — capacity and
// hiccup are pool conditions, never described to the user as credentials.
export const CODEX_PLATFORM_CAPACITY_MESSAGE =
  'All hands are busy right now — please send that again in a few minutes.';
export const CODEX_PLATFORM_HICCUP_MESSAGE =
  'Hit a brief hiccup on our side. Please send that message again — it should go through now.';

// Thrown on a stall kill; reaches the user via the background runner's error
// notification, so it has to say the conversation survives — the thread id
// is persisted the moment the CLI emits it, and the next message resumes it.
export const CODEX_TURN_STALLED_MESSAGE = 'Codex went quiet — no activity for 15 minutes, so the turn was stopped. The conversation is saved: send a message to pick up where it left off.';

export function createCodexHarnessRunner(harnessDeps: CodexHarnessDeps): AgentLoopFn {
  return async function runCodexHarness(
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
      throw new Error(`Session ${sessionId} not found for Codex harness run.`);
    }
    const profile = await deps.userStorage?.getProfile(userId);
    // The turn is pinned to the agent it was dispatched for (per-agent
    // concurrency); every caller pins.
    const targetAgent = deps.telegramTargetAgentId
      ? profile?.telegram?.agents?.[deps.telegramTargetAgentId]
      : undefined;
    // Run with the EFFECTIVE model/effort — the same concrete values the
    // reply header advertises. Unset overrides resolve to the CLI defaults
    // (gpt-6.1-sol · high); effort resolution is model-aware.
    const requestedModel = targetAgent
      ? resolveEffectiveModel('codex', targetAgent.model)
      : undefined;
    const requestedEffort = targetAgent
      ? resolveEffectiveEffort('codex', targetAgent.model, targetAgent.effort)
      : undefined;
    // Continuity id lives on the agent record. Only callers without an agent
    // record may use the legacy session-document field: falling back to it for
    // an existing agent would resume stale context after that agent's New chat
    // action deliberately removed its conversation pointer.
    let storedThreadId = targetAgent
      ? targetAgent.conversation?.codexThreadId
      : session.codexThreadId;

    const runKey = deps.telegramTargetAgentId
      ? `${sessionId}::agent:${deps.telegramTargetAgentId}`
      : sessionId;
    let attachInfo = payload?.harnessAttach?.cli === 'codex' ? payload.harnessAttach : undefined;
    // A failed steering kill or a steering checkpoint must be quarantined:
    // terminate it, retain a late thread.started id, and only then launch the
    // correction. A normal backend-restart attach is explicitly exempt.
    const abandonedTurn = payload?.harnessTermination
      ?? (attachInfo ? undefined : getActiveDetachedTurn(runKey));
    let runStarted = false;
    const markRunStarted = async (): Promise<void> => {
      if (runStarted) return;
      runStarted = true;
      // The native Codex thread on the VM owns the conversation; the
      // platform does not mirror its transcript into session storage.
      emit('agent_start', { runStartedAt: new Date().toISOString() });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'running' }).catch((error) => {
        console.warn(`[codex-harness] Could not mark ${sessionId} running; continuing turn:`, error);
      });
    };
    const captureRecoveredContinuity = async (lines: string[]): Promise<void> => {
      for (const line of lines) {
        const event = parseCodexExecEventLine(line);
        if (
          event?.type !== 'thread.started'
          || typeof (event as { thread_id?: unknown }).thread_id !== 'string'
        ) continue;
        const recoveredId = (event as { thread_id: string }).thread_id;
        if (recoveredId === storedThreadId) continue;
        if (deps.userStorage) {
          await deps.userStorage.updateTelegramHarnessConversation(
            userId,
            { codexThreadId: recoveredId },
            targetAgent ? { agentId: targetAgent.id } : undefined,
          );
        } else {
          await deps.sessionStorage.updateSession(userId, sessionId, { codexThreadId: recoveredId });
        }
        storedThreadId = recoveredId;
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
      // The durable marker is authoritative even when the agent's current
      // workspace cannot be resolved during boot.
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
      // A surviving process is already authenticated and running. Claim and
      // probe it before any fresh-launch-only gate can fail and release its
      // run slot.
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
        // The durable payload is acknowledged only after the fallback launch
        // owns a provisional/active marker; otherwise a crash in preflight
        // would lose it after proving only that the OLD process is gone.
      } else {
        if (state === 'running' && inspected.pid && inspected.pid !== attachInfo.pid) {
          attachInfo = { ...attachInfo, pid: inspected.pid };
          registerActiveDetachedTurn(runKey, attachInfo);
        } else if (state === 'running' && attachInfo.pid <= 0) {
          if (!inspected.pid) {
            throw new DetachedTurnTerminationError(
              `Codex turn ${attachInfo.outputPath} is running, but its launch PID is unresolved.`,
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

    // A normal re-attach must probe the sandbox recorded with that process;
    // current/default workspace resolution is only for a fresh launch.
    let sandboxId = attachInfo?.sandboxId ?? deps.telegramTargetSandboxId ?? session.sandboxId;
    if (!sandboxId) {
      try {
        sandboxId = (await harnessDeps.resolveDefaultSandboxId(userId)) ?? undefined;
      } catch (error) {
        console.error(`[codex-harness] Failed to provision sandbox for ${userId}:`, error);
        sandboxId = undefined;
      }
    }
    if (!sandboxId) {
      await deliverAssistantMessage({ deps, userId, sessionId, content: CODEX_WORKSPACE_UNAVAILABLE_MESSAGE, emit });
      await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
      emit('agent_complete', {});
      await acknowledgeTerminalRecovery();
      return;
    }
    await markRunStarted();

    // Wherever the pool is wired, every turn runs on the owner's own seats
    // through the lease path; the delivered auth.json IS the auth, so the
    // pre-check is skipped. Whether the owner HAS a seat is the lease's
    // answer (the no-seat refusal below) — exactly as in claude-harness.
    const usePlatformCredentials = Boolean(deps.platformCredentialPool);
    // Only pre-check auth on a session's first Codex turn; later turns rely
    // on runtime failures, sparing an SSH round-trip per message.
    if (!attachInfo && !storedThreadId && !usePlatformCredentials) {
      const authStatus = await ensureCodexAuth({
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
          await deps.onHarnessAuthFailure({ cli: 'codex' }).catch(() => {});
        } else {
          await deliverAssistantMessage({
            deps,
            userId,
            sessionId,
            content: CODEX_NOT_CONNECTED_MESSAGE,
            emit,
          });
        }
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
    }

    // Platform credential delivery. Codex auth is ~/.codex/auth.json, not an
    // env var, and the CLI refreshes its tokens in place — so the write is
    // per-machine state, the pin makes leasing sticky (one credential stays
    // on one machine instead of churning refreshes across the fleet), and the
    // release below syncs the refreshed file back into the pool.
    let platformLease: PlatformCredentialLease | undefined;
    let platformLeaseKind: 'dedicated' | 'limbo' | undefined;
    let leaseOutcome: PlatformCredentialLeaseOutcome = { kind: 'error' };
    if (!attachInfo && usePlatformCredentials) {
      let userLease: PlatformUserLease | undefined;
      try {
        // The user's own seat/dedicated credential first (org-layer-design);
        // the machine pin only matters on the limbo path, where scoring
        // would otherwise churn auth.json refreshes across the fleet.
        userLease = await deps.platformCredentialPool!.leaseForUser('codex', userId, {
          ...(targetAgent?.orgId ? { orgId: targetAgent.orgId } : {}),
          ...(targetAgent?.platformCredentialId
            ? { preferredCredentialId: targetAgent.platformCredentialId }
            : {}),
          ...(targetAgent?.seatId ? { seatId: targetAgent.seatId } : {}),
        });
      } catch (error) {
        console.error(`[codex-harness] Platform credential lease failed for ${userId}:`, error);
      }
      if (userLease?.kind === 'payment_required') {
        await deliverAssistantMessage({
          deps,
          userId,
          sessionId,
          content: paymentRequiredMessage('ChatGPT'),
          emit,
        });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      // Their own subscription out of window: say when it's back, never a
      // quiet hop onto shared capacity — same policy as the Claude harness.
      if (userLease?.kind === 'dedicated_exhausted') {
        const resetMs = userLease.resetAt ? Date.parse(userLease.resetAt) : Number.NaN;
        await Promise.resolve(deps.onHarnessUsageLimit?.({
          cli: 'codex',
          ...(Number.isFinite(resetMs) ? { resetAt: new Date(resetMs).toISOString() } : {}),
        })).catch(() => {});
        const content = dedicatedLimitMessage(Number.isFinite(resetMs) ? new Date(resetMs) : undefined);
        await deliverAssistantMessage({ deps, userId, sessionId, content, emit });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      platformLease = (userLease?.kind === 'dedicated' || userLease?.kind === 'limbo')
        ? userLease.lease ?? undefined
        : undefined;
      platformLeaseKind = platformLease
        ? userLease?.kind as 'dedicated' | 'limbo'
        : undefined;
      if (!platformLease) {
        harnessLog(sessionId, 'no platform credential leasable', { userId });
        // Limbo with nothing to lease means the owner has no seat (the
        // shared pool retired with the org cutover); anything else is a
        // transient lease failure — same reading as the Claude harness.
        const noSeat = userLease?.kind === 'limbo' && !userLease.lease;
        if (noSeat && deps.onHarnessAuthFailure) {
          // The seat sign-in door (workstream 2) — the recovery handler
          // pauses the owner's Codex agents and routes their next message
          // into the sign-in ceremony; same shape as the Claude harness.
          await deps.onHarnessAuthFailure({ cli: 'codex', reason: 'no_seat' }).catch(() => {});
          await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
          emit('agent_complete', {});
          await acknowledgeTerminalRecovery();
          return;
        }
        const content = noSeat ? NO_SEAT_MESSAGE : CODEX_PLATFORM_CAPACITY_MESSAGE;
        await deliverAssistantMessage({ deps, userId, sessionId, content, emit });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      // Always write, even on a pin match: a recycled/reset machine has no
      // auth.json, and the pool copy is the freshest surviving one (synced
      // back after every turn).
      const written = await writeCodexAuthFile({
        sandboxClient: harnessDeps.sandboxClient,
        sandboxId,
        content: platformLease.token,
        sshUser: HARNESS_SSH_USER,
      }).catch((error) => {
        console.error(`[codex-harness] Failed to write platform auth.json on ${sandboxId}:`, error);
        return false;
      });
      if (!written) {
        // A write failure is a machine problem, not the credential's.
        await deps.platformCredentialPool!.releaseCredential(platformLease.credentialId, { kind: 'error' })
          .catch(() => {});
        await deliverAssistantMessage({ deps, userId, sessionId, content: CODEX_WORKSPACE_UNAVAILABLE_MESSAGE, emit });
        await deps.sessionStorage.updateSession(userId, sessionId, { status: 'completed' });
        emit('agent_complete', {});
        await acknowledgeTerminalRecovery();
        return;
      }
      // The pin is limbo machinery (stickiness against pool scoring). A seat
      // lease needs none — the member's seat IS the answer every turn — and
      // pinning a seat id would leave a meaningless preference behind if the
      // user ever fell back to limbo.
      if (targetAgent && userLease?.kind === 'limbo'
        && targetAgent.platformCredentialId !== platformLease.credentialId) {
        await deps.userStorage?.updateAgentFields(userId, targetAgent.id, {
          platformCredentialId: platformLease.credentialId,
        }).catch((error) => {
          console.warn(`[codex-harness] Failed to pin credential for agent ${targetAgent.id}:`, error);
        });
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
    // per-turn number can go — the same sentence, in the same position, that a
    // Claude agent is given, because it is one platform fact and not two
    // harnesses' opinions. Written at the END of the last turn, so it describes
    // where the conversation stood when this agent last spoke.
    //
    // Silent when there is nothing true to say: a fresh chat (the field is
    // cleared on reset), a turn whose rollout could not be read, or a CLI that
    // never stated its window.
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
        secretEnv,
        sessionId,
        sandboxId,
        prompt,
        signal,
        emit,
        requestedModel,
        requestedEffort,
        targetAgentId: deps.telegramTargetAgentId,
      };
      // A resumed payload can carry attach info for a turn that survived the
      // restart; only honor it for this CLI (stale cross-CLI info re-runs).
      let outcome = await attemptCodexTurn({
        ...turnArgs,
        resumeThreadId: storedThreadId,
        attach: attachInfo,
        attachProbe,
      });
      recoveryNeedsTerminalAcknowledgement = false;

      // A sandbox reset wipes ~/.codex/sessions, orphaning the stored thread
      // id. When the resume fails because the rollout file is gone, retry once
      // on a fresh thread — nothing was delivered yet, so no duplicates.
      if (
        storedThreadId
        && outcome.kind === 'finished'
        && isMissingRolloutFailure(outcome)
      ) {
        console.warn(
          `[codex-harness] Thread ${storedThreadId} has no rollout on sandbox ${sandboxId}; starting a fresh thread for session ${sessionId}`,
        );
        outcome = await attemptCodexTurn({ ...turnArgs, resumeThreadId: undefined });
      }

      if (outcome.kind === 'interrupted') {
        return;
      }
      // The window fill, on THIS agent's record — the agents of one account
      // share a session document and are told apart by run key, so the
      // session is the one place this must not live.
      //
      // BEFORE the failure branch below, deliberately: a turn that answered
      // and then failed still says something true about how full the
      // conversation is, and only a turn that measured nothing writes nothing
      // (its previous reading is stale by one turn, never wrong).
      //
      // The window rides along because Codex states it, and states a smaller
      // one than its own catalog, so the percentage is drawn against what the
      // CLI enforces rather than a table here that could go stale.
      if (targetAgent?.id && outcome.context) {
        await deps.userStorage?.updateAgentFields?.(userId, targetAgent.id, {
          contextUsage: {
            tokens: outcome.context.tokens,
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(outcome.context.window ? { window: outcome.context.window } : {}),
            at: new Date().toISOString(),
          },
        });
      }
      // What the turn spent, onto the owner's token ledger — the thread's
      // running total less where it stood after the last credited turn
      // (agent/turn-tokens.ts). Here for the same reason as the fill: a turn
      // that answered and then failed still spent what it spent.
      if (targetAgent?.id && outcome.context?.total && outcome.threadId) {
        const total = outcome.context.total;
        const spent = codexTurnTokens({
          total,
          threadId: outcome.threadId,
          startedThisTurn: outcome.startedThread === true,
          ...(targetAgent.codexTokenBase ? { base: targetAgent.codexTokenBase } : {}),
        });
        if (spent) {
          creditTurnTokens({
            ledger: deps.agentTokenLedger,
            userId,
            agent: targetAgent,
            provider: 'codex',
            perModel: new Map([[requestedModel ?? 'unknown', spent]]),
          });
        }
        await deps.userStorage?.updateAgentFields?.(userId, targetAgent.id, {
          codexTokenBase: { threadId: outcome.threadId, ...total },
        });
      }

      const { exitCode, turnFailedMessage, deliveredMessageCount, lastAssistantMessage, transcript } = outcome;
      if (turnFailedMessage || (exitCode !== null && exitCode !== 0 && deliveredMessageCount === 0)) {
        const tail = stripAnsiEscapes(transcript).trim().slice(-ERROR_TAIL_CHARS);
        throw new NonRecoverableAgentError(
          turnFailedMessage
            ? `Codex turn failed: ${turnFailedMessage}`
            : `Codex exited with code ${exitCode}. Output tail:\n${tail}`,
        );
      }

      await deps.sessionStorage.updateSession(userId, sessionId, {
        status: 'completed',
        ...(lastAssistantMessage
          ? {
            lastAssistantMessage,
            lastAssistantMessageAt: new Date().toISOString(),
          }
          : {}),
      });
      leaseOutcome = { kind: 'ok' };
      emit('agent_complete', {});
    } catch (error) {
      // Preserve the class for BackgroundRunner's fail-closed restart gate.
      if (error instanceof DetachedTurnRestartSafetyError) throw error;
      await acknowledgeTerminalRecovery();
      const message = error instanceof Error ? error.message : String(error);
      const authFailure = isCodexAuthFailureText(message);
      const usageLimit = isCodexUsageLimitText(message);

      // Platform-credential turns: an auth death or exhausted limit is the
      // POOL's problem, not the user's sign-in — report it to the pool (the
      // finally below benches the credential) and surface a retry-friendly
      // message instead of triggering per-user auth recovery.
      if (platformLease && (authFailure || usageLimit)) {
        leaseOutcome = authFailure
          ? { kind: 'auth_failed', detail: message.slice(-300) }
          : { kind: 'rate_limited' };
        console.warn(
          `[codex-harness] Platform credential ${platformLease.credentialId} failed turn (${leaseOutcome.kind}):`,
          redactHarnessSecrets(message, Object.values(secretEnv)),
        );
        if (platformLeaseKind === 'dedicated' && usageLimit) {
          await Promise.resolve(deps.onHarnessUsageLimit?.({ cli: 'codex' })).catch(() => {});
          throw new NonRecoverableAgentError(dedicatedLimitMessage());
        }
        throw new NonRecoverableAgentError(CODEX_PLATFORM_HICCUP_MESSAGE);
      }

      // Later turns skip the auth pre-check, so a dead sign-in surfaces here
      // as a runtime failure — classify it and trigger recovery. Recovery
      // owns the user-facing message, so the rethrow is marked userNotified
      // and the runner keeps the raw error out of the chat.
      const authDeath = Boolean(deps.onHarnessAuthFailure) && authFailure;
      if (authDeath) {
        await deps.onHarnessAuthFailure!({ cli: 'codex' }).catch(() => {});
      }
      if (error instanceof NonRecoverableAgentError) {
        if (authDeath && !error.userNotified) {
          throw new NonRecoverableAgentError(error.message, { userNotified: true });
        }
        throw error;
      }
      throw new NonRecoverableAgentError(redactHarnessSecrets(message, Object.values(secretEnv)), { userNotified: authDeath });
    } finally {
      if (platformLease) {
        // Post-turn sync, both best-effort and off the user's critical path
        // (their reply is already delivered): pull the refreshed auth.json
        // back into the pool, and on healthy turns refresh the credential's
        // usage via the machine's app-server RPC. The periodic/on-open probe
        // reads the same account directly; this post-turn read also captures
        // the just-finished message before the next scheduled pass.
        const extras: PlatformCredentialReleaseExtras = {};
        try {
          const refreshed = await readCodexAuthFile({
            sandboxClient: harnessDeps.sandboxClient,
            sandboxId,
            sshUser: HARNESS_SSH_USER,
          });
          if (refreshed) extras.refreshedToken = refreshed;
        } catch (error) {
          console.warn(`[codex-harness] Failed to read back platform auth.json on ${sandboxId}:`, error);
        }
        if (leaseOutcome.kind === 'ok') {
          try {
            const usage = await readCodexProviderUsage({
              sandboxClient: harnessDeps.sandboxClient,
              sandboxId,
              sshUser: HARNESS_SSH_USER,
            });
            if (usage) extras.usage = usage;
          } catch (error) {
            console.warn(`[codex-harness] Platform usage probe failed on ${sandboxId}:`, error);
          }
        }
        await deps.platformCredentialPool!
          .releaseCredential(platformLease.credentialId, leaseOutcome, extras)
          .catch((error) => {
            console.warn(`[codex-harness] Failed to release platform credential ${platformLease!.credentialId}:`, error);
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

type CodexTurnOutcome =
  | { kind: 'interrupted' }
  | {
    kind: 'finished';
    exitCode: number | null;
    turnFailedMessage?: string;
    deliveredMessageCount: number;
    lastAssistantMessage?: string;
    transcript: string;
    /** The window fill this turn measured, when the rollout could be read. */
    context?: CodexContextReading;
    /** The thread the turn ran on, and whether this turn started it (token ledger). */
    threadId?: string;
    startedThread?: boolean;
  };

const MISSING_ROLLOUT_PATTERN = /no rollout found for thread id|thread\/resume failed/i;

function isMissingRolloutFailure(outcome: Extract<CodexTurnOutcome, { kind: 'finished' }>): boolean {
  // The error can surface on stderr (the PTY transcript) or as an error event
  // in the turn file (turnFailedMessage); check both.
  return outcome.deliveredMessageCount === 0
    && outcome.exitCode !== null
    && outcome.exitCode !== 0
    && MISSING_ROLLOUT_PATTERN.test(`${stripAnsiEscapes(outcome.transcript)}\n${outcome.turnFailedMessage ?? ''}`);
}

async function attemptCodexTurn(args: {
  harnessDeps: CodexHarnessDeps;
  deps: AgentLoopDeps;
  userId: string;
  sessionId: string;
  sandboxId: string;
  prompt: string;
  resumeThreadId?: string;
  signal?: AbortSignal;
  emit: (type: WSMessageType, data: unknown) => void;
  /** Re-attach to a turn that survived a backend restart (see resumePendingTurns). */
  attach?: HarnessTurnAttachInfo;
  /** Authoritative probe already completed before fresh-launch-only gates. */
  attachProbe?: 'running' | 'finished' | 'unknown';
  /** The user's saved secrets, exported into the turn and redacted out of its transcript. */
  secretEnv?: Record<string, string>;
  requestedModel?: string;
  requestedEffort?: string;
  /** The agent this turn is pinned to; conversation writes target it. */
  targetAgentId?: string;
}): Promise<CodexTurnOutcome> {
  const {
    harnessDeps,
    deps,
    userId,
    sessionId,
    sandboxId,
    prompt,
    resumeThreadId,
    signal,
    emit,
    attach,
    attachProbe,
    secretEnv,
    requestedModel,
    requestedEffort,
    targetAgentId,
  } = args;
  const { sandboxClient } = harnessDeps;
  const runKey = targetAgentId ? `${sessionId}::agent:${targetAgentId}` : sessionId;
  // Everything that must never reach a transcript, log line, or user-facing
  // error from this turn. The CLI can echo a secret back (a curl command it
  // composed, a stack trace), so redaction covers every exported value.
  const turnSecrets = Object.values(secretEnv ?? {});

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
      console.warn(`[codex-harness] [${sessionId}] attach target gone — re-running the turn`);
    } else {
      attached = attach;
      console.info(`[codex-harness] [${sessionId}] RE-ATTACHED to detached turn pid=${attach.pid} (${probed})`);
    }
  }

  const outputPath = attached?.outputPath ?? buildTurnOutputPath();
  const turnStartedAt = attached?.turnStartedAt ?? Date.now();
  let handle: DetachedTurnHandle | undefined = attached ? { outputPath, pid: attached.pid } : undefined;
  if (!handle) {
    // The pre-sleep update may be replacing this very CLI: wait it out rather
    // than start a binary that is not there yet. Before the abort check, so a
    // Stop pressed meanwhile still ends the turn.
    const install = harnessDeps.cliInstallInFlight?.(sandboxId);
    if (install) {
      console.info(`[codex-harness] [${sessionId}] CLI install in flight on ${sandboxId}; the turn starts when it is done`);
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
    const command = buildCodexExecCommand({ prompt, resumeThreadId, model: requestedModel, effort: requestedEffort });
    // Detached launch: the CLI runs under setsid on the MACHINE, decoupled
    // from this backend process — a deploy restart no longer kills the turn.
    registerActiveDetachedTurn(runKey, {
      cli: 'codex',
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
      if (!(error instanceof DetachedTurnRestartSafetyError)) {
        clearActiveDetachedTurn(runKey);
      }
      throw error;
    }
    harnessLog(sessionId, 'detached turn started', {
      sandboxId,
      pid: handle.pid,
      resume: Boolean(resumeThreadId),
      outputPath,
    });
  }
  const activeHandle: DetachedTurnHandle = handle;

  const reader = new TurnOutputReader(
    sandboxClient, sandboxId, outputPath, HARNESS_SSH_USER, attached?.consumedLines ?? 0,
  );
  let transcript = '';
  let codexThreadId = resumeThreadId;
  let deliveredMessageCount = attached?.deliveredMessageCount ?? 0;
  let currentActivity = attached?.currentActivity;
  registerActiveDetachedTurn(runKey, {
    cli: 'codex',
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
            `Codex turn ${outputPath} has no safely recoverable process id.`,
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

  const persistCodexThreadId = async (threadId: string | undefined): Promise<void> => {
    if (!threadId || threadId === codexThreadId) return;
    let failures = 0;
    while (true) {
      try {
        if (deps.userStorage) {
          // Pin the pointer write to this turn's agent so a concurrent turn on
          // another agent can never receive this thread id.
          await deps.userStorage.updateTelegramHarnessConversation(
            userId,
            { codexThreadId: threadId },
            targetAgentId ? { agentId: targetAgentId } : undefined,
          );
        } else {
          await deps.sessionStorage.updateSession(userId, sessionId, { codexThreadId: threadId });
        }
        break;
      } catch (error) {
        failures += 1;
        if (signal?.aborted && !isProcessShutdownAbort(signal)) {
          // Persisting the first thread id may be unavailable, but Steering
          // and Stop still get to terminate the superseded command promptly.
          await terminateDetachedTurn();
        }
        if (isHarnessShutdownInProgress()) {
          throw new DetachedTurnContinuityError(
            'Codex thread id could not be persisted before backend shutdown.',
            { cause: error },
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(failures, 5) * 1_000);
        });
      }
    }
    codexThreadId = threadId;
  };

  const captureContinuityFromLines = async (lines: string[]): Promise<void> => {
    for (const line of lines) {
      const event = parseCodexExecEventLine(line);
      if (
        event?.type === 'thread.started'
        && typeof (event as { thread_id?: unknown }).thread_id === 'string'
      ) {
        await persistCodexThreadId((event as { thread_id: string }).thread_id);
      }
    }
  };

  // The last poll before an abort may not have seen a first-turn
  // `thread.started` line yet. After the process is proven gone, retain that
  // one continuity fact without delivering stale assistant output from the
  // direction the user just replaced.
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
            'Codex exited, but its native thread id could not be safely captured.',
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
        // The reader already consumed this batch. Keep only the thread id;
        // assistant items belong to the abandoned direction.
        await captureContinuityFromLines(lines.slice(index));
        return;
      }
      const line = lines[index]!;
      const event = parseCodexExecEventLine(line);
      if (!event) continue;
      // Live status: the latest started item is "what the agent is doing".
      const startedSummary = getStartedItemSummary(event);
      if (startedSummary) {
        currentActivity = redactHarnessSecrets(startedSummary, turnSecrets);
      }
      if (event.type === 'thread.started' && typeof (event as { thread_id?: unknown }).thread_id === 'string') {
        const threadId = (event as { thread_id: string }).thread_id;
        await persistCodexThreadId(threadId);
        continue;
      }
      const completedItem = getCompletedItem(event);
      if (completedItem && isAgentMessageItem(completedItem)) {
        if (signal?.aborted) {
          await captureContinuityFromLines(lines.slice(index + 1));
          return;
        }
        const text = completedItem.text.trim();
        if (!text) continue;
        lastAssistantMessage = text;
        deliveredMessageCount += 1;
        await deliverAssistantMessage({
          deps,
          userId,
          sessionId,
          content: text,
          emit,
          model: requestedModel,
          requestedModel,
          outbound: { sandboxClient, sandboxId },
        });
        continue;
      }
      if (event.type === 'turn.failed') {
        turnFailedMessage = (event as { error?: { message?: string } }).error?.message
          ?? 'Codex turn failed.';
        continue;
      }
      if (event.type === 'error') {
        turnFailedMessage = (event as { message?: string }).message ?? 'Codex reported an error.';
      }
    }
  };

  // Stall clock, not a wall clock: reset on every batch of new stream events.
  let lastProgressAt = Date.now();
  let exitCode: number | null = null;
  let running = true;

  try {
    while (running) {
      if (signal?.aborted) {
        if (isProcessShutdownAbort(signal)) {
          // Backend restarting, not a user cancel: leave the CLI running and
          // keep the turn file + registry entry intact for the re-attach.
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
        return { kind: 'interrupted' };
      }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        harnessLog(sessionId, 'turn STALLED', {
          quietMs: Date.now() - lastProgressAt,
          linesConsumed: reader.linesConsumed,
          delivered: deliveredMessageCount,
        });
        await terminateDetachedTurn();
        throw new Error(CODEX_TURN_STALLED_MESSAGE);
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
    if (exitCode !== 0 || turnFailedMessage) {
      transcript = await reader.readStderrTail(2000);
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

  // Answerable from the journal: how many messages this turn DELIVERED —
  // the difference between "the CLI ended after a teaser message" and "we
  // dropped one" (asked live 2026-07-18 about a promised illustration).
  harnessLog(sessionId, 'turn finished', {
    exitCode,
    delivered: deliveredMessageCount,
    linesConsumed: reader.linesConsumed,
    ...(turnFailedMessage ? { turnFailedMessage } : {}),
  });

  // How full the window is now, off the CLI's own rollout file — the stream
  // has no honest answer (see codex-context.ts). AFTER delivery, so the extra
  // round trip is not in front of the user's reply, and only when the turn
  // reached the model at all: a turn that never ran says nothing about the
  // size of the conversation, and a failed read leaves the previous reading
  // standing rather than overwriting it with a guess.
  let context: CodexContextReading | null = null;
  if (codexThreadId && deliveredMessageCount > 0) {
    context = await readCodexContextUsage({
      sandboxClient,
      sandboxId,
      sshUser: HARNESS_SSH_USER,
      threadId: codexThreadId,
    }).catch((error) => {
      console.warn(`[codex-harness] Context read failed for thread ${codexThreadId} on ${sandboxId}:`, error);
      return null;
    });
  }

  return {
    kind: 'finished',
    exitCode,
    turnFailedMessage,
    deliveredMessageCount,
    lastAssistantMessage,
    transcript: redactHarnessSecrets(transcript, turnSecrets),
    ...(context ? { context } : {}),
    ...(codexThreadId ? { threadId: codexThreadId, startedThread: !resumeThreadId } : {}),
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
  const outboundFiles: Array<{ fileName: string; content: Uint8Array }> = [];
  if (deps.sendUserFile && args.outbound) {
    const { text, paths } = extractOutboundAttachments(content);
    if (paths.length > 0) {
      const notes: string[] = [];
      for (const rawPath of paths) {
        const fetched = await fetchOutboundAttachment(args.outbound.sandboxClient, args.outbound.sandboxId, rawPath, {
          sshUser: HARNESS_SSH_USER,
          homeDir: HARNESS_CWD,
        });
        if (fetched.ok) {
          outboundFiles.push({ fileName: fetched.fileName, content: fetched.content });
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
    model: model ?? 'codex',
    source: 'codex-cli',
    ...(requestedModel ? { requestedModel } : {}),
  });
  await deps.notifyAssistantResponse?.({
    userId,
    sessionId,
    content,
    source: 'codex-cli',
    ...(model ? { model } : {}),
    ...(requestedModel ? { requestedModel } : {}),
  });

  for (const file of outboundFiles) {
    try {
      await deps.sendUserFile!(file);
    } catch (error) {
      console.warn(`[codex-harness] Failed to send outbound file ${file.fileName}:`, error);
    }
  }
}

export function buildCodexExecCommand(args: {
  prompt: string;
  resumeThreadId?: string;
  model?: string;
  effort?: string;
}): string {
  const base = [
    'codex exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox danger-full-access',
    `-C ${HARNESS_CWD}`,
  ];
  if (args.model) {
    base.push('--model', quoteShellArg(args.model));
  }
  // Codex takes effort as a config override (verified against codex-cli 0.144.1),
  // placed among the parent flags before the `resume` subcommand like --model.
  if (args.effort) {
    base.push('-c', quoteShellArg(`model_reasoning_effort=${args.effort}`));
  }
  // Parent flags must precede the `resume` subcommand (clap requirement,
  // verified against codex-cli 0.142.5).
  if (args.resumeThreadId) {
    base.push('resume', quoteShellArg(args.resumeThreadId));
  }
  base.push(quoteShellArg(args.prompt));

  return base.join(' ');
}
