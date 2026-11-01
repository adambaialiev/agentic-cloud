// Core agent types for tool execution
import type { SharedV3ProviderOptions as ProviderOptions } from '@ai-sdk/provider';
import type { AgentSessionResponse } from './persistence.js';
import type { SessionRuntimeContext } from './runtime-context.js';
import type {
  PersistedPlanState,
  PersistedBlockerState,
  PersistedPlanStep,
} from './persistence.js';
import type {
  AgentMessageFileAttachment,
  AttachmentRecord,
  SessionToolSummary,
  UploadedFileMetadata,
} from './tools.js';
import type { TerminalSessionResult } from '../services/sandbox-types.js';

export interface SessionRelayMetadata {
  sourceSessionId: string;
  sourceSessionTitle?: string;
}

export interface InternalAgentMessageMetadata {
  threadId: string;
  messageId: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string;
  recipientUsername: string;
  body: string;
  createdAt: string;
  files?: AgentMessageFileAttachment[];
}

export interface IntuitionEventMetadata {
  kind: 'intuition';
  text: string;
}

export type AgentSyntheticEventMetadata = IntuitionEventMetadata;

export type AssistantResponseKind = 'telegram_budget_notice';

export interface ProviderReasoningPart {
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ToolCall {
  toolCallId: string;
  tool_name: string;
  parameters: Record<string, unknown>;
  createdAt?: string;
  completedAt?: string;
  replayParameters?: Record<string, unknown>;
  title?: string;
  result?: string;
  files?: UploadedFileMetadata[];
  isComplete?: boolean;
}

export interface AgentMessage {
  seq?: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt?: string;
  attachments?: AttachmentRecord[];
  plan?: PersistedPlanState;
  // Legacy field kept for storage compatibility; native provider reasoning replay uses providerReasoningParts.
  reasoning?: string;
  thinking?: string;
  providerReasoningParts?: ProviderReasoningPart[];
  model?: string;
  /** Runtime that produced the message; primarily distinguishes subscription CLI harnesses. */
  source?: 'platform' | 'codex-cli' | 'claude-cli' | 'opencode-cli';
  /** User-selected model or alias when it differs from the resolved concrete model. */
  requestedModel?: string;
  replayThinking?: string;
  replayContent?: string;
  // On assistant messages: structured tool calls made by the LLM
  toolCalls?: ToolCall[];
  // On tool messages: reference back to the tool call
  toolCallId?: string;
  toolName?: string;
  title?: string;
  files?: UploadedFileMetadata[];
  sessions?: SessionToolSummary[];
  terminalResult?: TerminalSessionResult;
  relay?: SessionRelayMetadata;
  internalAgentMessage?: InternalAgentMessageMetadata;
  syntheticEvent?: AgentSyntheticEventMetadata;
}

export type WSMessageType =
  | 'session_snapshot'
  | 'history_page'
  | 'agent_start'
  | 'agent_reasoning'
  | 'assistant_message'
  | 'invalid_tool_call'
  | 'tool_call_start'
  | 'relay_command_log'
  | 'tool_call_result'
  | 'assistant_response'
  | 'agent_complete'
  | 'agent_paused'
  | 'completion_judge'
  | 'token_usage'
  | 'agent_interrupted'
  | 'clarifying_question'
  | 'user_message_queued'
  | 'user_message_injected'
  | 'title_update'
  | 'blocker_set'
  | 'blocker_cleared'
  | 'plan_updated'
  | 'workspace_snapshot'
  | 'workspace_session_upsert'
  | 'workspace_session_remove'
  | 'heartbeat'
  | 'error';

export interface WSMessage {
  type: WSMessageType;
  sessionId?: string;
  data: unknown;
  timestamp: string;
}

export interface ToolCallStartData {
  toolCallId: string;
  tool_name: string;
  parameters: Record<string, unknown>;
  title?: string;
  model?: string;
}

export interface RelayCommandLogData {
  toolCallId?: string;
  recordId: string;
  requestId: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
  startedAt: string;
}

export interface AgentReasoningData {
  text: string;
  model: string;
}

export interface AssistantMessageData {
  content: string;
  model?: string;
}

export interface InvalidToolCallData {
  toolCallId: string;
  requestedToolName: string;
  rawInput: unknown;
  normalizedInput: Record<string, unknown>;
  invalidReason: string;
  batchDiscarded: boolean;
  retryAttempt: number;
}

export interface ToolCallResultData {
  toolCallId: string;
  tool_name: string;
  result: string;
  isTerminal: boolean;
  files?: UploadedFileMetadata[];
  sessions?: SessionToolSummary[];
  terminalResult?: TerminalSessionResult;
}

export interface AssistantResponseData {
  content: string;
}

export interface ClarifyingQuestionData {
  question: string;
  options: string[];
}

export interface ErrorData {
  message: string;
  errorType?: 'rate_limit' | 'generic';
}

export interface UserMessageQueuedData {
  message: string;
  queuePosition: number;
  attachments?: AttachmentRecord[];
}

export interface UserMessageInjectedData {
  message: string;
  attachments?: AttachmentRecord[];
}

export interface AgentPausedData {
  reason: string;
  totalThinkingSeconds: number;
}

export interface CompletionJudgeData {
  kind: 'text_only_completion';
  status: 'completed' | 'invalid_json' | 'failed';
  model: string;
  done: boolean;
  reason: string;
  candidatePreview: string;
  candidateChars: number;
}

export interface TitleUpdateData {
  title: string;
}

export interface BlockerSetData extends PersistedBlockerState {}

export interface BlockerClearedData {
  previousReason?: string;
}

export interface PlanUpdatedData {
  summary: string;
  steps: PersistedPlanStep[];
  activeStepId?: string;
}

export interface TokenUsageData {
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

/**
 * Everything needed to RE-ATTACH to a detached harness turn after a backend
 * restart, instead of re-running it: the turn file + sidecars (derived from
 * outputPath), the remote process group, and how much of the stream was
 * already consumed/delivered before the restart.
 */
export interface HarnessTurnAttachInfo {
  cli: 'claude' | 'codex' | 'opencode';
  sandboxId: string;
  outputPath: string;
  /**
   * Detached process-group id. `0` is a durable provisional-launch sentinel:
   * recover and identity-check the real PID from outputPath's sidecars before
   * attaching or signaling; pid=0 itself must never reach a kill command.
   */
  pid: number;
  consumedLines: number;
  deliveredMessageCount: number;
  /** Live one-liner of what the CLI is doing (latest tool/command), for status UI. */
  currentActivity?: string;
  /** Epoch ms the turn ORIGINALLY started (survives re-attach for elapsed display). */
  turnStartedAt?: number;
  /**
   * A legacy turn's input FIFO, when it was launched by a pre-retirement
   * streamed-input backend. Carried through a rolling restart because that
   * already-running turn cannot end until the new backend closes the pipe.
   */
  inputPath?: string;
}

export interface UserInputPayload {
  content: string;
  /**
   * This payload came from the owner's direct Workspace chat. If Manual Stop
   * catches it in the steering queue before a harness turn starts, the
   * service holds it for the owner's next send instead of making a visible
   * chat bubble that the agent never receives.
   *
   * Internal admission metadata only; prompt builders ignore it.
   */
  preserveAfterUserStop?: boolean;
  /** Present on a resumed payload whose turn is still running remotely. */
  harnessAttach?: HarnessTurnAttachInfo;
  /**
   * Present on a steering replay when the prior backend could not finish
   * proving the abandoned turn dead before it restarted. The harness must
   * terminate this process and capture its continuity id before launching the
   * payload; it must never attach and continue the abandoned work.
   */
  harnessTermination?: HarnessTurnAttachInfo;
  attachments?: AttachmentRecord[];
  relay?: SessionRelayMetadata;
  syntheticEvent?: AgentSyntheticEventMetadata;
  historyAlreadyPersisted?: boolean;
  persistedMessage?: AgentMessage;
}

export interface SessionHistoryWindowData {
  oldestLoadedSeq: number | null;
  hasMoreHistory: boolean;
}

export interface SessionSnapshotData {
  session: AgentSessionResponse;
  historyWindow?: SessionHistoryWindowData;
}

export interface SessionHistoryPageData {
  messages: AgentMessage[];
  oldestLoadedSeq: number | null;
  hasMoreHistory: boolean;
}

export interface WorkspaceSnapshotData {
  sessions: AgentSessionResponse[];
}

export interface WorkspaceSessionUpsertData {
  session: AgentSessionResponse;
}

export interface WorkspaceSessionRemoveData {
  sessionId: string;
}
