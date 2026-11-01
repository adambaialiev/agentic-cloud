import { vi } from 'vitest';

export interface MockStreamTextCall {
  model: unknown;
  system?: string;
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  extra_body?: unknown;
  reasoning_effort?: unknown;
  reasoning?: unknown;
  transport?: unknown;
}

export interface MockToolCallPart {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  preserveInput?: boolean;
  syntheticReasoning?: boolean;
}

export interface QueuedResponse {
  text?: string;
  reasoning?: string;
  reasoningProviderOptions?: Record<string, Record<string, unknown>>;
  reasoningProviderOnly?: Record<string, Record<string, unknown>>;
  omitResponseMessages?: boolean;
  toolCalls?: MockToolCallPart[];
  skipDecisionSynthesis?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    cachedInputTokens?: number;
  };
  usageError?: Error;
}

interface QueuedError {
  error: Error;
}

const TEST_DEFAULT_SERVER_ID = 505;
const DEVELOPMENT_RUNTIME_TOOL_NAMES = new Set([
  'execute_terminal_session',
  'execute_terminal_session',
  'send-server-files-to-user-telegram',
  'materialize-platform-files-to-server',
  'list_files',
  'search_code',
  'read_files',
  'apply_patch',
  'write_file',
  'create_plan',
  'update_plan',
]);
function withDefaultServerId(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const args = input as Record<string, unknown>;
  const needsServer = DEVELOPMENT_RUNTIME_TOOL_NAMES.has(toolName)
    || (toolName === 'execute_terminal_session' && args.action === 'start' && !args.host);
  if (!needsServer || args.serverId !== undefined || args.serverId !== undefined) {
    return input;
  }

  return {
    ...args,
    serverId: TEST_DEFAULT_SERVER_ID,
  };
}

function buildResponseMessages(response: QueuedResponse): Array<{
  role: 'assistant';
  content: Array<Record<string, unknown>>;
}> {
  const content: Array<Record<string, unknown>> = [];

  if (response.reasoning) {
    content.push({
      type: 'reasoning',
      text: response.reasoning,
      ...(response.reasoningProviderOptions
        ? { providerOptions: response.reasoningProviderOptions }
        : {}),
    });
  }

  if (response.reasoningProviderOnly) {
    content.push({
      type: 'reasoning',
      providerOptions: response.reasoningProviderOnly,
    });
  }

  if (response.text) {
    content.push({
      type: 'text',
      text: response.text,
    });
  }

  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      });
    }
  }

  return content.length > 0
    ? [{ role: 'assistant', content }]
    : [];
}

function enqueueResponse(
  responses: QueuedResponse[],
  response: QueuedResponse,
): void {
  responses.push(response);
}

/**
 * Creates a mock streamText function that yields predefined responses.
 * Supports both text-only responses and tool-call responses.
 */
export function createMockStreamText() {
  const calls: MockStreamTextCall[] = [];
  const responses: QueuedResponse[] = [];
  const errors: (QueuedError | null)[] = [];

  const mockStreamText = vi.fn((options: { model: unknown; system?: string; messages?: unknown[]; tools?: unknown; toolChoice?: unknown; providerOptions?: unknown; extra_body?: unknown; reasoning_effort?: unknown; reasoning?: unknown; transport?: unknown }) => {
    calls.push({
      model: options.model,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      toolChoice: options.toolChoice,
      providerOptions: options.providerOptions,
      extra_body: options.extra_body,
      reasoning_effort: options.reasoning_effort,
      reasoning: options.reasoning,
      transport: options.transport,
    });

    // Check if there's a queued error
    const queuedError = errors.shift();
    if (queuedError) {
      const fullStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'error' as const, error: queuedError.error };
        },
      };
      return {
        fullStream,
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      };
    }

    const response = responses.shift() ?? { text: '' };

    const fullStream = {
      async *[Symbol.asyncIterator]() {
        // Yield reasoning content
        if (response.reasoning) {
          yield { type: 'reasoning-delta' as const, text: response.reasoning };
        }
        // Yield text content
        if (response.text) {
          yield { type: 'text-delta' as const, text: response.text };
        }
        // Yield tool calls
        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            yield {
              type: 'tool-call' as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
              invalid: tc.invalid,
            };
          }
        }
      },
    };

    const usagePayload = response.usage
      ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokenDetails: response.usage.inputTokenDetails,
          cachedInputTokens: response.usage.cachedInputTokens,
        }
      : {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        };

    const usagePromise = response.usageError
      ? Promise.reject(response.usageError)
      : Promise.resolve(usagePayload);

    return {
      fullStream,
      usage: usagePromise,
      response: Promise.resolve({
        id: 'mock-response',
        timestamp: new Date(0),
        modelId: 'mock-model',
        messages: response.omitResponseMessages ? [] : buildResponseMessages(response),
      }),
    };
  });
  globalThis.__deepseekStreamTextMock = mockStreamText as unknown as (options: unknown) => unknown;
  globalThis.__openAIResponsesStreamTextMock = mockStreamText as unknown as (options: unknown) => unknown;

  let toolCallCounter = 0;

  return {
    mockStreamText,

    /**
     * Queue a text-only response (no tool calls).
     */
    queueResponse(text: string): void {
      enqueueResponse(responses, { text });
    },

    /**
     * Queue a response with tool calls.
     */
    queueToolCallResponse(
      toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
      text?: string
    ): void {
      const normalizedToolCalls = toolCalls.map(tc => ({
        toolCallId: `call_${++toolCallCounter}`,
        toolName: tc.toolName,
        input: withDefaultServerId(tc.toolName, tc.args),
      }));
      enqueueResponse(responses, {
        text,
        toolCalls: normalizedToolCalls,
      });
    },

    /**
     * Queue a structured response.
     */
    queueStructuredResponse(response: QueuedResponse): void {
      const normalizedToolCalls = response.toolCalls?.map((toolCall) => ({
        ...toolCall,
        input: withDefaultServerId(toolCall.toolName, toolCall.input),
      }));
      enqueueResponse(responses, {
        ...response,
        toolCalls: normalizedToolCalls,
      });
    },

    queueResponses(newResponses: string[]): void {
      for (const r of newResponses) {
        enqueueResponse(responses, { text: r });
      }
    },

    queueError(error: Error): void {
      errors.push({ error });
    },

    getCalls(): MockStreamTextCall[] {
      return [...calls];
    },

    getCallCount(): number {
      return calls.length;
    },

    getLastCall(): MockStreamTextCall | undefined {
      return calls[calls.length - 1];
    },

    reset(): void {
      calls.length = 0;
      responses.length = 0;
      errors.length = 0;
      toolCallCounter = 0;
      mockStreamText.mockClear();
    },

    getRemainingResponses(): QueuedResponse[] {
      return [...responses];
    },
  };
}

export type MockStreamText = ReturnType<typeof createMockStreamText>;
