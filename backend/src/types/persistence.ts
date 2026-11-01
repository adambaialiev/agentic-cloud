import { Timestamp } from './timestamp.js';
import type {
  AgentMessage,
  AssistantResponseKind,
  SessionRelayMetadata,
  ToolCall,
} from './agent.js';
import type { ErrorData } from './agent.js';
import type { AttachmentRecord, SessionToolSummary, UploadedFileMetadata } from './tools.js';
import type { SessionRuntimeContext } from './runtime-context.js';

interface PersistedTokenUsageState {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  nonCachedInputTokens?: number;
  lastCachedInputTokens?: number;
  lastCacheWriteInputTokens?: number;
  lastNonCachedInputTokens?: number;
  cachedInputHitRatePct?: number;
  lastCachedInputHitRatePct?: number;
  lastModelStepId?: string;
}

export type AgentSessionStatus = 'idle' | 'running' | 'awaiting_input' | 'completed' | 'paused' | 'interrupted' | 'error';
export type AgentType = 'reactive' | 'autonomous';
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type SessionCurrentActivity = 'waiting_for_tool' | 'executing' | 'idle';
export type SessionToolCallProgressStatus = 'success' | 'failure';

export interface SessionToolCallProgress {
  toolName: string;
  timestamp: string;
  status: SessionToolCallProgressStatus;
  toolCallId?: string;
}

/**
 * Where the session last touched a terminal: which server and working
 * directory. Captured from `execute_terminal_session` parameters so
 * coordinators can tell WHERE a session's uncommitted state lives — a session
 * summary that says "edits in the working tree" is useless without it.
 */
export interface SessionTerminalContext {
  serverId?: string;
  cwd?: string;
  timestamp: string;
}

export interface SessionProgressState {
  lastActivity?: SessionToolCallProgress;
  recentToolCalls?: SessionToolCallProgress[];
  totalSteps?: number;
  currentActivity?: SessionCurrentActivity;
  lastTerminalContext?: SessionTerminalContext;
}

export interface AutonomousState {
  isActive: boolean;
  cycleCount: number;
  lastCycleAt?: string;
}

export interface ClarifyingQuestionState {
  question: string;
  options: string[];
}

/**
 * Legacy: relay state written by the removed child-session product. Kept as a
 * read-only field so historical session documents still deserialize; no code
 * writes it anymore.
 */
export interface TelegramRelayState {
  telegramSessionId: string;
  enabledAt: string;
  lastDeliveredKey?: string;
  lastDeliveredAt?: string;
  lastDeliveredMessageCount?: number;
  deliveryClaimKey?: string;
  deliveryClaimOwnerId?: string;
  deliveryClaimExpiresAt?: string;
}

export interface TelegramReplyDirective {
  kind: AssistantResponseKind;
  remainingTurns: number;
  createdAt: string;
}

export interface SessionRunnerLeaseState {
  ownerId: string;
  runId: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface PersistedPlanStep {
  stepId: string;
  text: string;
  status: PlanStepStatus;
}

export interface PersistedPlanState {
  summary: string;
  steps: PersistedPlanStep[];
  activeStepId?: string;
}

export interface PersistedBlockerState {
  reason: string;
  needsUserInput: boolean;
}

export interface HistoryMessageDocument {
  seq: number;
  role: string;
  content: string;
  attachments?: AttachmentRecord[];
  plan?: PersistedPlanState;
  // Legacy field kept for storage compatibility; native provider reasoning replay uses providerReasoningParts.
  reasoning?: string;
  thinking?: string;
  providerReasoningParts?: AgentMessage['providerReasoningParts'];
  model?: string;
  source?: AgentMessage['source'];
  requestedModel?: string;
  replayThinking?: string;
  replayContent?: string;
  // Structured tool call fields (new format)
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  title?: string;
  files?: UploadedFileMetadata[];
  sessions?: SessionToolSummary[];
  terminalResult?: AgentMessage['terminalResult'];
  relay?: SessionRelayMetadata;
  createdAt: Timestamp;
}

export interface AgentSessionDocument {
  sessionId: string;
  userId: string;
  sandboxId?: string;
  machineName?: string;
  status: AgentSessionStatus;
  agentType?: AgentType;
  model?: string;
  runtimeContext?: SessionRuntimeContext;
  plan?: PersistedPlanState;
  observations?: string[];
  activeHypothesis?: string;
  touchedFiles?: string[];
  blocker?: PersistedBlockerState;
  progress?: SessionProgressState;
  history: AgentMessage[];
  messageCount: number;
  title?: string;
  pendingClarification: boolean;
  clarifyingQuestion?: ClarifyingQuestionState;
  lastError?: string;
  lastErrorType?: ErrorData['errorType'];
  lastAssistantMessage?: string;
  /** When `lastAssistantMessage` was sent. Lets a coordinator see how stale the last reply is. */
  lastAssistantMessageAt?: string;
  telegramRelay?: TelegramRelayState;
  telegramReplyDirective?: TelegramReplyDirective;
  tokenUsage?: PersistedTokenUsageState;
  isAutonomous?: boolean;
  autonomousState?: AutonomousState;
  mission?: string;
  thinkingTime?: {
    totalSeconds: number;
    runStartedAt?: string;
  };
  runner?: SessionRunnerLeaseState;
  shutdownCheckpointAt?: string;
  /**
   * Codex CLI thread id for sessions running on the alternative Codex
   * harness; set on the first turn and used to `codex exec resume` later
   * turns of the same session.
   */
  codexThreadId?: string;
  /**
   * Claude Code session id for sessions running on the alternative Claude
   * harness; set on the first turn and used with `claude -p --resume` on
   * later turns of the same session.
   */
  claudeSessionId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// For API responses (with serialized dates)
export interface AgentSessionResponse {
  sessionId: string;
  userId: string;
  sandboxId?: string;
  machineName?: string;
  status: AgentSessionStatus;
  agentType?: AgentType;
  model?: string;
  runtimeContext?: SessionRuntimeContext;
  plan?: PersistedPlanState;
  observations?: string[];
  activeHypothesis?: string;
  progress?: SessionProgressState;
  history: AgentMessage[];
  messageCount?: number;
  title?: string;
  pendingClarification: boolean;
  clarifyingQuestion?: ClarifyingQuestionState;
  lastError?: string;
  lastErrorType?: ErrorData['errorType'];
  lastAssistantMessage?: string;
  telegramRelay?: TelegramRelayState;
  tokenUsage?: PersistedTokenUsageState;
  isAutonomous?: boolean;
  autonomousState?: AutonomousState;
  mission?: string;
  thinkingTime?: {
    totalSeconds: number;
    runStartedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}
