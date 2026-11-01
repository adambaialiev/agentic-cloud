import type {
  PersistedPlanState,
  PlanStepStatus,
  AgentSessionStatus,
  SessionCurrentActivity,
  SessionProgressState,
  SessionToolCallProgress,
} from './persistence.js';
import type { TerminalSessionResult } from '../services/sandbox-types.js';

// Tool parameter interfaces

export interface ServerTargetParams {
  serverId?: number | string;
}

export interface TerminalSessionEventText {
  type: 'text';
  text: string;
  multiline?: boolean;
}

export interface TerminalSessionEventKey {
  type: 'key';
  key: string;
}

export interface TerminalSessionEventCtrl {
  type: 'ctrl';
  key: string;
}

export interface TerminalSessionEventRaw {
  type: 'raw';
  data: string;
}

export type TerminalSessionEvent =
  | TerminalSessionEventText
  | TerminalSessionEventKey
  | TerminalSessionEventCtrl
  | TerminalSessionEventRaw;

export type TerminalSessionOutputMode = 'screen' | 'raw';
export type TerminalSessionReadMode = 'full' | 'delta';

export interface TerminalSessionDisplayOptions {
  outputMode?: TerminalSessionOutputMode;
  readMode?: TerminalSessionReadMode;
  quietForMs?: number;
  timeoutMs?: number;
  waitForRepaint?: boolean;
  waitForChange?: boolean;
}

export type ExecuteTerminalSessionParams =
  | (TerminalSessionDisplayOptions & {
      action: 'start';
      command: string;
      cwd?: string;
      serverId?: number | string;
      host?: string;
      sshUser?: 'root' | 'agent';
      user?: string;
      port?: number;
      cols?: number;
      rows?: number;
      preserve?: boolean;
    })
  | (TerminalSessionDisplayOptions & {
      action: 'input';
      sessionId: string;
      events: TerminalSessionEvent[];
    })
  | (TerminalSessionDisplayOptions & {
      action: 'read';
      sessionId: string;
    })
  | (TerminalSessionDisplayOptions & {
      action: 'close';
      sessionId: string;
    });

export interface WaitParams {
  seconds: number;
  /** Required by the tool schema; optional here so the executor stays robust to legacy calls. */
  reasoning?: string;
}

export interface CreateSessionParams {
  title?: string;
  message: string;
  serverId?: number | string;
}

export interface ListSessionsParams {
  limit?: number;
}

export interface ObserveSessionParams {
  sessionId: string;
  historyLimit?: number;
}

export interface MessageSessionParams {
  sessionId: string;
  message: string;
}

export interface StopSessionParams {
  sessionId: string;
  reason?: string;
}

export interface SendIntermediaryMessageToUserParams {
  message: string;
}

export interface SendAgentMessageParams extends ServerTargetParams {
  /** Recipient username or saved contact name. */
  recipientUsername: string;
  message?: string;
  files?: SendServerFileToUserTelegramItemParams[];
  confirmed?: boolean;
}

export type BroadcastToAllUsersFileParams =
  | string
  | (Partial<SendPlatformFileToUserTelegramItemParams> & Partial<SendServerFileToUserTelegramItemParams>);

export interface BroadcastToAllUsersParams {
  message: string;
  files?: BroadcastToAllUsersFileParams[];
  confirmed?: boolean;
}

export interface ReplyAgentThreadParams extends ServerTargetParams {
  /** Other participant username or saved contact name. */
  username: string;
  message?: string;
  requireExistingThread?: boolean;
  files?: SendServerFileToUserTelegramItemParams[];
  confirmed?: boolean;
}

export interface DeleteAgentThreadParams {
  /** Other participant username or saved contact name. */
  username: string;
  confirmed?: boolean;
}

export interface DeleteAgentMessageParams {
  /** Other participant username or saved contact name. */
  username: string;
  messageId: string;
  confirmed?: boolean;
}

export interface GetAgentMessagePolicyParams {}

export interface ListAgentContactsParams {}

export interface AddAgentContactParams {
  username: string;
  name?: string;
}

export interface RemoveAgentContactParams {
  usernameOrName: string;
}

export interface UpdateAgentContactNameParams {
  usernameOrName: string;
  name: string;
}

export interface UpdateAgentMessagePolicyParams {
  inboundEnabled?: boolean;
  allowUnknownSenders?: boolean;
  addAllowedUsernames?: string[];
  removeAllowedUsernames?: string[];
  addBlockedUsernames?: string[];
  removeBlockedUsernames?: string[];
}

export interface ListAgentInboxParams {
  limit?: number;
}

export interface ReadAgentThreadParams {
  /** Other participant username or saved contact name. */
  username: string;
  limit?: number;
}

export interface SaveMemoryHtmlParams {
  memory: string;
}

export interface ReadMemoryHtmlParams {}

export interface SaveSkillsHtmlParams {
  skills: string;
}

export interface ReadSkillsHtmlParams {}

export interface ClearTelegramContextParams {}

export interface DeliverTelegramMessageParams {
  deliveryId: string;
  reason?: string;
}

export interface DeliverEditedTelegramMessageParams {
  deliveryId: string;
  message: string;
  reason?: string;
}

export interface SuppressTelegramMessageParams {
  deliveryId: string;
  reason?: string;
}


export interface SessionToolSummary {
  sessionId: string;
  title?: string;
  status: AgentSessionStatus;
  updatedAt?: string;
  lastError?: string;
  lastAssistantMessage?: string;
  /** When `lastAssistantMessage` was sent, so the coordinator can see how stale it is. */
  lastAssistantMessageAt?: string;
  progress?: SessionProgressState;
  lastActivity?: SessionToolCallProgress;
  recentToolCalls?: SessionToolCallProgress[];
  totalSteps?: number;
  currentActivity?: SessionCurrentActivity;
}

export interface SessionHistoryToolCallSummary {
  toolName: string;
  parameters?: Record<string, unknown>;
  result?: string;
  isComplete?: boolean;
}

export interface SessionHistoryEntrySummary {
  role: 'user' | 'assistant' | 'tool';
  createdAt?: string;
  content?: string;
  thinking?: string;
  /** For tool-role messages: which tool produced this output. */
  toolName?: string;
  /** For assistant messages: the structured tool calls it made. */
  toolCalls?: SessionHistoryToolCallSummary[];
}

export interface SessionObservation {
  session: SessionToolSummary;
  /** Total history length so the coordinator knows how much precedes the tail. */
  totalHistoryItems: number;
  /** The last few history items, oldest first. */
  history: SessionHistoryEntrySummary[];
}

export interface MessageSessionDelivery {
  sessionId: string;
  title?: string;
  status: AgentSessionStatus;
  delivery: 'queued' | 'started';
}

export interface StopSessionResult {
  sessionId: string;
  title?: string;
  previousStatus: AgentSessionStatus;
  status: AgentSessionStatus;
  stopped: boolean;
  reason?: string;
}

export interface AgentInboxThreadSummary {
  threadId: string;
  username: string;
  contactName?: string;
  updatedAt?: string;
  lastMessagePreview?: string;
  lastMessageBody?: string;
  lastMessageFiles?: AgentMessageFileAttachment[];
  lastMessageDirection: 'incoming' | 'outgoing';
  messageCount?: number;
  incomingThreadCount?: number;
  outgoingThreadCount?: number;
}

export interface AgentThreadMessageSummary {
  messageId: string;
  senderUsername: string;
  recipientUsername: string;
  body: string;
  files?: AgentMessageFileAttachment[];
  createdAt?: string;
  direction: 'incoming' | 'outgoing';
}

export interface AgentContactSummary {
  username: string;
  name?: string;
}

export interface SendAgentMessageDelivery {
  threadId: string;
  messageId: string;
  senderUserId?: string;
  senderUsername?: string;
  recipientUserId?: string;
  recipientUsername: string;
  body?: string;
  createdAt: string;
  delivery: 'telegram_delivered' | 'stored_only';
  fileCount?: number;
  files?: AgentMessageFileAttachment[];
}

export type ReplyAgentThreadDelivery = SendAgentMessageDelivery;

export interface DeleteAgentThreadResult {
  username: string;
  threadIds: string[];
  messageCount: number;
  messages: AgentThreadMessageSummary[];
  deleted: boolean;
  deletedAt?: string;
}

export interface DeleteAgentMessageResult {
  username: string;
  threadId: string;
  messageId: string;
  message: AgentThreadMessageSummary;
  remainingMessageCount: number;
  deletedThread: boolean;
  deleted: boolean;
  deletedAt?: string;
}

export interface AgentMessagePolicySummary {
  inboundEnabled: boolean;
  allowUnknownSenders: boolean;
  contacts: string[];
  contactNames: Record<string, string>;
  allowedUsernames: string[];
  blockedUsernames: string[];
}



export interface ToolTitleParam {
  title?: string;
}


export interface ListFilesParams extends ServerTargetParams {
  path?: string;
  maxDepth?: number;
  includeHidden?: boolean;
}

export interface SearchCodeParams extends ServerTargetParams {
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
}

export interface ReadFilesParams extends ServerTargetParams {
  paths?: string[];
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface ApplyPatchParams extends ServerTargetParams {
  patch: string;
}

export interface WriteFileParams extends ServerTargetParams {
  path: string;
  content: string;
}

export type UploadedFileRenderMode = 'auto' | 'image' | 'video' | 'audio' | 'download';
export type UploadedFileMediaKind = 'image' | 'video' | 'audio' | 'download';
export type UploadedFileVisibility = 'session' | 'user';
export type UploadedFilePurpose = 'user_visible' | 'agent_reference';
export type AttachmentSource = 'user_input' | 'agent_generated';
/** 'model_input' is legacy (removed vision path); stored records may still carry it. */
export type AttachmentUse = 'model_input' | 'sandbox_input' | 'user_visible';

export interface UploadedFileMetadata {
  fileId: string;
  url: string;
  expiresAt?: string;
  storagePath: string;
  fileName: string;
  displayName?: string;
  contentType: string;
  mediaKind: UploadedFileMediaKind;
  renderAs: Exclude<UploadedFileRenderMode, 'auto'>;
  sizeBytes: number;
  caption?: string;
  altText?: string;
  visibility: UploadedFileVisibility;
  purpose: UploadedFilePurpose;
  sha256?: string;
}

export interface AttachmentRecord {
  fileId: string;
  url: string;
  expiresAt?: string;
  storagePath: string;
  fileName: string;
  displayName?: string;
  contentType: string;
  mediaKind: UploadedFileMediaKind;
  renderAs: Exclude<UploadedFileRenderMode, 'auto'>;
  sizeBytes: number;
  caption?: string;
  altText?: string;
  // Model-generated image description, persisted at first automatic
  // recognition so replayed history keeps the image's identity readable.
  description?: string;
  visibility: UploadedFileVisibility;
  source: AttachmentSource;
  use: AttachmentUse;
  sha256?: string;
  serverPath?: string;
  serverId?: number | string;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
}

export interface AgentMessageFileAttachment {
  fileId: string;
  fileName: string;
  displayName?: string;
  contentType: string;
  mediaKind: UploadedFileMediaKind;
  renderAs: Exclude<UploadedFileRenderMode, 'auto'>;
  sizeBytes: number;
  caption?: string;
}

export interface SendServerFileToUserTelegramItemParams {
  path: string;
  displayName?: string;
  caption?: string;
  contentType?: string;
  renderAs?: UploadedFileRenderMode;
}

export interface SendServerFilesToUserTelegramParams extends ServerTargetParams {
  files: SendServerFileToUserTelegramItemParams[];
}

export interface SendPlatformFileToUserTelegramItemParams {
  storagePath: string;
  fileName?: string;
  displayName?: string;
  caption?: string;
  contentType?: string;
  renderAs?: UploadedFileRenderMode;
}

export interface SendPlatformFilesToUserTelegramParams {
  files: SendPlatformFileToUserTelegramItemParams[];
}

export interface MaterializePlatformFileToServerItemParams {
  storagePath: string;
  path: string;
  mode?: number;
}


export interface TelegramServerFileUpload {
  fileName: string;
  displayName?: string;
  contentType: string;
  mediaKind: UploadedFileMediaKind;
  renderAs: Exclude<UploadedFileRenderMode, 'auto'>;
  sizeBytes: number;
  caption?: string;
  content: Uint8Array;
  /**
   * Inline keyboard to send WITH the file. The agent bot's control keyboard
   * has to ride on whatever message lands last in the chat, and a turn that
   * ends with an ATTACH: file ends on this one — sending the buttons in the
   * same call keeps them under the newest message with no second round trip
   * and no window where the chat's last message has no controls.
   */
  inlineKeyboard?: { text: string; callback_data?: string; url?: string }[][];
}











export interface PlanStepParams {
  stepId: string;
  text: string;
  status: PlanStepStatus;
}

export interface CreatePlanParams extends ServerTargetParams {
  summary: string;
  steps: PlanStepParams[];
  activeStepId?: string;
}

export interface UpdatePlanParams extends ServerTargetParams {
  summary: string;
  steps: PlanStepParams[];
  activeStepId?: string;
}

export type ToolParams =
  | ExecuteTerminalSessionParams
  | WaitParams
  | CreateSessionParams
  | ListSessionsParams
  | ObserveSessionParams
  | MessageSessionParams
  | StopSessionParams
  | SendIntermediaryMessageToUserParams
  | SendAgentMessageParams
  | ReplyAgentThreadParams
  | DeleteAgentThreadParams
  | DeleteAgentMessageParams
  | ListAgentInboxParams
  | ReadAgentThreadParams
  | ListFilesParams
  | SearchCodeParams
  | ReadFilesParams
  | ApplyPatchParams
  | WriteFileParams
  | SendServerFilesToUserTelegramParams
  | SendPlatformFilesToUserTelegramParams
  | BroadcastToAllUsersParams
  | CreatePlanParams
  | UpdatePlanParams
  | SaveMemoryHtmlParams
  | ReadMemoryHtmlParams
  | SaveSkillsHtmlParams
  | ReadSkillsHtmlParams
  | ClearTelegramContextParams
  | DeliverTelegramMessageParams
  | DeliverEditedTelegramMessageParams
  | SuppressTelegramMessageParams;

export interface ToolResult {
  isTerminal: boolean;
  result: string;
  sessionContextCleared?: boolean;
  terminalResult?: TerminalSessionResult;
  type?: 'message' | 'clarifying_question' | 'plan_state' | 'telegram_files_sent' | 'telegram_broadcast_sent' | 'session_list' | 'intermediary_message_sent';
  content?: string;
  options?: string[];
  plan?: PersistedPlanState;
  planPath?: string;
  files?: UploadedFileMetadata[];
  sessions?: SessionToolSummary[];
}
