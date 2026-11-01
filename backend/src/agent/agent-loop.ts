import { generateText } from 'ai';
import type { AgentTokenLedger } from '../services/agent-token-ledger.js';
import type { UserSecretViewer } from '../services/user-secrets.js';
import {
  generateDeepSeekText,
  isOpenAICompatModel,
} from '../lib/deepseek-openai.js';
import {
  generateOpenAIResponsesText,
  isOpenAIResponsesModel,
} from '../lib/openai-responses.js';
import { resolveLanguageModel } from '../lib/anthropic-provider.js';
import {
  AgentMessage,
  type AssistantResponseKind,
  UserInputPayload,
  type HarnessTurnAttachInfo,
} from '../types/agent.js';
import type {
  AttachmentRecord,
  AgentMessagePolicySummary,
  AgentContactSummary,
  AgentInboxThreadSummary,
  AgentThreadMessageSummary,
  DeleteAgentMessageResult,
  DeleteAgentThreadResult,
  ReplyAgentThreadDelivery,
  SendAgentMessageDelivery,
  SessionObservation,
} from '../types/tools.js';
import type { AgentLoopFn } from './background-runner.js';
import { AgentEventEmitter } from './agent-event-emitter.js';
import type { SessionStorage } from '../services/session-storage.js';
import { UserStorage } from '../services/user-storage.js';
import type { SecretStorage } from '../services/secret-storage.js';
import type { PlatformCredentialPool } from '../services/platform-credential-pool.js';
import type { SessionRuntimeContext } from '../types/runtime-context.js';
import type { MediaStorage } from '../services/media-storage.js';

type ResolvedAttachmentContent = {
  data: Buffer | Uint8Array | ArrayBuffer;
  filePath?: string;
  contentType?: string;
};

export interface AgentLoopDeps {
  sessionStorage: SessionStorage;
  eventEmitter: AgentEventEmitter;
  backgroundRunner?: {
    isRunning: (sessionId: string) => boolean;
    startAgent?: (
      sessionId: string,
      userId: string,
      message: string | UserInputPayload | null,
      deps: AgentLoopDeps,
      loopFn: AgentLoopFn,
    ) => { status: 'started' } | { status: 'already_running' };
    /**
     * Put a drained message back. The harness drains the queue to hand
     * messages to a running CLI; anything the CLI will not take has to go
     * back, or a message the user watched land disappears.
     */
    queueMessage?: (
      runKey: string,
      message: string | UserInputPayload,
    ) => { status: 'queued'; queuePosition: number } | { status: 'not_running'; queuePosition: 0 };
    completeHarnessTerminationRecovery?: (runKey: string) => void;
    /** The detached CLI finished and all of its output has been delivered. */
    completeCurrentPayload?: (runKey: string) => void;
  };
  aiModel: string;
  secretStorage?: SecretStorage;
  /**
   * Pool of platform-owned subscription credentials. Harnesses lease from it
   * for users whose profile enables platform credentials (platformPlan).
   */
  platformCredentialPool?: PlatformCredentialPool;
  /**
   * Where each agent turn's tokens are credited (agent-token-ledger.ts).
   * Absent → nothing is recorded.
   */
  agentTokenLedger?: AgentTokenLedger;
  userStorage?: UserStorage;
  mediaStorage?: MediaStorage;
  resolveAttachmentContent?: (
    attachment: AttachmentRecord,
  ) => Promise<ResolvedAttachmentContent | null | undefined>;
  notifyAssistantResponse?: (args: {
    userId: string;
    sessionId: string;
    sessionTitle?: string;
    content: string;
    model?: string;
    source?: AgentMessage['source'];
    requestedModel?: string;
    responseKind?: AssistantResponseKind;
  }) => Promise<void> | void;
  /**
   * A CLI turn reached the owner's subscription window. Telegram uses this
   * structured signal to mark the one affected agent; generic error text is
   * deliberately not parsed outside the harness.
   */
  onHarnessUsageLimit?: (args: {
    cli: 'claude' | 'codex' | 'opencode';
    /** ISO timestamp when a known provider window/cooldown lifts. */
    resetAt?: string;
  }) => Promise<void> | void;
  onAgentRunComplete?: (args: {
    userId: string;
    sessionId: string;
    /** Epoch ms the run slot was claimed — the turn's start, for its working time (note #644). */
    startedAtMs?: number;
    /**
     * The slot settled because the backend is restarting, not because the
     * turn ended (note #734): the turn lives on — re-attached or replayed by
     * the next process, whose completion is its real end. Only this process's
     * share of the working time belongs to it.
     */
    processShutdown?: boolean;
  }) => Promise<void> | void;
  initialUserInputAlreadyPersisted?: boolean;
  runtimeContext?: SessionRuntimeContext;
  resolveRuntimeContext?: () => Promise<SessionRuntimeContext | undefined>;
  drainQueuedMessages?: () => UserInputPayload[];
  suppressQueuedMessageRestart?: () => void;
  /**
   * Re-resolve the loop (fn + deps) to use when the background runner restarts
   * this session to process queued messages. Lets a queued message run on
   * whichever route is correct at restart time — e.g. Telegram re-resolves the
   * active agent so a message queued behind another agent's turn runs on the
   * agent the user actually selected, instead of the loop that happened to be
   * running. Absent → the runner restarts with the original loop fn + deps.
   */
  resolveRestartLoop?: (
    nextMessage: UserInputPayload | string | null,
  ) => Promise<{ loopFn: AgentLoopFn; loopDeps: AgentLoopDeps }>;
  /**
   * Read the current detached-turn marker synchronously at the shutdown
   * snapshot boundary. The returned value is frozen with the user payload so
   * a poll completing after the process-shutdown abort cannot advance the
   * persisted delivery offset past assistant output that was never emitted.
   */
  captureActiveDetachedTurn?: () => HarnessTurnAttachInfo | undefined;
  /**
   * Persist this session's in-flight + queued user messages when the PROCESS is
   * shutting down (deploy/restart), so the next boot can resume the turn
   * instead of silently dropping it. Called by the graceful-shutdown handler
   * with the interrupted turn's payloads; providers (Telegram) write them to
   * pending-turn storage and `resumePendingTurns()` replays them at boot.
   * Absent → the session's turns do not survive a restart.
   */
  persistShutdownTurn?: (
    payloads: UserInputPayload[],
    options?: {
      /** False when an interrupted old CLI must be terminated, not re-attached. */
      includeActiveTurn?: boolean;
      /** Kill an interrupted CLI after restart without replaying any payload. */
      terminateOnly?: boolean;
      /**
       * Detached turn metadata already carried by the current recovery
       * payload. This remains durable even before the harness has had a
       * chance to register that turn in the process-local active map.
       */
      knownDetachedTurn?: HarnessTurnAttachInfo;
    },
  ) => Promise<void>;
  /**
   * Boot recovery calls this only after the harness has crossed a safe
   * boundary: an attached turn is registered again, or an abandoned turn is
   * proven dead. Until then its pending-turn document remains durable.
   */
  acknowledgeHarnessRecovery?: (
    signal?: AbortSignal,
    detachedTurnAlreadyGone?: boolean,
  ) => Promise<boolean>;
  /**
   * Telegram harness runs: the agent this turn is pinned to. With per-agent
   * concurrency two agents can run at once, so the harness must read its
   * model/effort/conversation from (and write its continuity pointers back to)
   * THIS agent — never "the active agent at run time", which may have changed.
   * Absent → fall back to the active agent (legacy single-slot behavior).
   */
  telegramTargetAgentId?: string;
  /** Org-scoped owner key for shared and agent-private user secrets. */
  userSecretOwnerId?: string;
  /**
   * Whose turn this is, for the audience line on shared secrets (note #655):
   * a member's agent is handed only the keys an admin opened to everyone.
   * Absent means the personal namespace, whose one human is its admin.
   */
  userSecretViewer?: UserSecretViewer;
  /**
   * Telegram harness runs: the sandbox (machine) this turn runs on, derived
   * from the pinned agent's serverId at dispatch. Takes precedence over the
   * session document's `sandboxId` slot, which is shared across the session
   * and racy once two agents run concurrently.
   */
  telegramTargetSandboxId?: string;
  /**
   * Telegram harness turns: the CLI has no credential to run on — its sign-in
   * is dead (expired or revoked), or, `reason: 'no_seat'`, the owner holds no
   * live seat for it. The service clears the affected agents' connected state
   * and tells the user how to sign in; when present, the harness leaves the
   * user-facing recovery message to it.
   */
  onHarnessAuthFailure?: (args: { cli: 'claude' | 'codex' | 'opencode'; reason?: 'no_seat' }) => Promise<void>;
  /**
   * Deliver a file from the agent's machine into the user's chat (the
   * harness ATTACH: convention). Wired for Telegram harness runs.
   */
  sendUserFile?: (file: { fileName: string; content: Uint8Array }) => Promise<void>;
  includePlanTools?: boolean;
}

export { buildMessages, buildMessagesWithStats } from './model-messages.js';

const MINI_SUMMARIZER_MODEL = 'minimax/minimax-m3';
const TITLE_GENERATION_MODEL = MINI_SUMMARIZER_MODEL;
const NON_AUTHORED_TITLE_USER_MESSAGE_PREFIXES = [
  '[AGENT_PAUSED]',
];

/**
 * Generate a short descriptive title for the conversation based on recent messages.
 */
export async function generateTitle(
  history: AgentMessage[],
): Promise<string | null> {
  return (await generateTitleResult(history)).title;
}

async function generateTitleResult(
  history: AgentMessage[],
): Promise<{ title: string | null; usage: unknown }> {
  const recentMessages = history.filter((msg) => {
    if (msg.plan) {
      return false;
    }

    const content = msg.content.trim();
    if (!content) {
      return false;
    }

    if (msg.role === 'user') {
      return !NON_AUTHORED_TITLE_USER_MESSAGE_PREFIXES.some((prefix) => content.startsWith(prefix));
    }

    if (msg.role === 'assistant') {
      return true;
    }

    return false;
  }).slice(-6);
  if (recentMessages.length === 0) {
    return { title: null, usage: null };
  }

  let conversationSnippet = '';
  for (const msg of recentMessages) {
    const roleLabel = msg.role === 'user' ? 'USER' : msg.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
    const content = msg.content.length > 500
      ? msg.content.substring(0, 500) + '...'
      : msg.content;
    conversationSnippet += `[${roleLabel}] ${content}\n`;
  }

  const titlePrompt = `Generate a short descriptive title (3-8 words) for this conversation. Return plain text only as a single line title. Do not use JSON, markdown, labels, or quotes.\n\n${conversationSnippet}`;
  const result = isOpenAIResponsesModel(TITLE_GENERATION_MODEL)
    ? await generateOpenAIResponsesText({
        model: TITLE_GENERATION_MODEL,
        prompt: titlePrompt,
      })
    : isOpenAICompatModel(TITLE_GENERATION_MODEL)
      ? await generateDeepSeekText({
          model: TITLE_GENERATION_MODEL,
          prompt: titlePrompt,
        })
      : await generateText({
          model: resolveLanguageModel(TITLE_GENERATION_MODEL),
          prompt: titlePrompt,
        });
  const usage = await Promise.resolve((result as { usage?: unknown }).usage).catch(() => null);

  const rawTitle = result.text.trim();
  if (!rawTitle) {
    return { title: null, usage };
  }

  const extractStructuredTitle = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = extractStructuredTitle(item);
        if (candidate) {
          return candidate;
        }
      }
      return null;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of ['title', 'text', 'summary', 'headline']) {
      const candidate = extractStructuredTitle(record[key]);
      if (candidate) {
        return candidate;
      }
    }

    return null;
  };

  let title = rawTitle
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/u, '')
    .trim();
  const looksStructured = (
    (title.startsWith('{') && title.endsWith('}'))
    || (title.startsWith('[') && title.endsWith(']'))
    || (title.startsWith('"') && title.endsWith('"'))
  );

  if (looksStructured) {
    try {
      const parsed = JSON.parse(title);
      const extracted = extractStructuredTitle(parsed);
      if (!extracted) {
        return { title: null, usage };
      }
      title = extracted;
    } catch {
      return { title: null, usage };
    }
  }

  title = title
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  title = title.replace(/^title\s*:\s*/iu, '');
  title = title.replace(/^["'`]+|["'`]+$/gu, '').trim();
  title = title.replace(/\s+/gu, ' ').trim();
  title = title.replace(/[.?!,:;]+$/u, '').trim();

  if (!title || /[{}\[\]]/u.test(title)) {
    return { title: null, usage };
  }

  return { title, usage };
}
