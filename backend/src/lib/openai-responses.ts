import OpenAI from 'openai';
import { z } from 'zod';
import {
  MODEL_PRICING,
  calculateCostCents,
} from '../config/pricing.js';
import type {
  DeepSeekGenerateTextOptions,
  DeepSeekTextResult,
  DeepSeekUsage,
} from './deepseek-openai.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REASONING_EFFORT = 'high';

type ToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
type OpenAIResponsesReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface OpenAIResponsesStreamTextOptions {
  model: string;
  system?: string;
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: ToolChoice;
  reasoning_effort?: OpenAIResponsesReasoningEffort;
  abortSignal?: AbortSignal;
}

interface StreamControllerState {
  resolveUsage: (usage: DeepSeekUsage) => void;
  rejectUsage: (error: unknown) => void;
  usage: Promise<DeepSeekUsage>;
}

interface ResponsesFunctionCallAccumulator {
  callId?: string;
  itemId?: string;
  name?: string;
  arguments: string;
  emitted?: boolean;
}

export function isOpenAIResponsesModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.trim().startsWith('openai/gpt-5');
}

export function createOpenAIResponsesClient(): OpenAI {
  return new OpenAI({
    baseURL: OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });
}

function toOpenAIResponsesModel(model: string): string {
  const trimmedModel = model.trim();
  return trimmedModel.startsWith('openai/')
    ? trimmedModel.slice('openai/'.length)
    : trimmedModel;
}

export function buildOpenAIResponsesRequestOptions(
  _model: string,
  reasoningEffort?: OpenAIResponsesReasoningEffort,
): { reasoning: { effort: OpenAIResponsesReasoningEffort } } {
  return {
    reasoning: {
      effort: reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function convertContentParts(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return stringifyContent(content);
  }

  const parts: unknown[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
      continue;
    }

    if (part.type === 'image') {
      const image = part.image instanceof URL ? part.image.toString() : part.image;
      if (typeof image === 'string') {
        parts.push({ type: 'input_image', image_url: image, detail: 'auto' });
      }
    }
  }

  return parts.length > 0 ? parts : stringifyContent(content);
}

function convertToolResultContent(part: Record<string, unknown>): string {
  const output = part.output;
  if (isRecord(output) && Object.prototype.hasOwnProperty.call(output, 'value')) {
    return stringifyContent(output.value);
  }
  if (Object.prototype.hasOwnProperty.call(part, 'result')) {
    return stringifyContent(part.result);
  }
  if (Object.prototype.hasOwnProperty.call(part, 'output')) {
    return stringifyContent(output);
  }
  return stringifyContent(part);
}

function convertToolMessage(message: Record<string, unknown>): unknown[] {
  const topLevelToolCallId = getNonEmptyString(message.toolCallId);

  if (Array.isArray(message.content)) {
    const toolMessages: unknown[] = [];
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool-result') {
        continue;
      }

      const toolCallId = getNonEmptyString(part.toolCallId) ?? topLevelToolCallId;
      if (!toolCallId) {
        continue;
      }

      toolMessages.push({
        type: 'function_call_output',
        call_id: toolCallId,
        output: convertToolResultContent(part),
      });
    }

    if (toolMessages.length > 0) {
      return toolMessages;
    }
  }

  if (!topLevelToolCallId) {
    return [];
  }

  return [{
    type: 'function_call_output',
    call_id: topLevelToolCallId,
    output: stringifyContent(message.content),
  }];
}

function convertAssistantMessage(message: Record<string, unknown>): unknown[] {
  const content = Array.isArray(message.content) ? message.content : undefined;
  const converted: unknown[] = [];
  const functionCalls: unknown[] = [];
  let text = typeof message.content === 'string' ? message.content : '';

  for (const part of content ?? []) {
    if (!isRecord(part)) {
      continue;
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      continue;
    }

    if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
      functionCalls.push({
        type: 'function_call',
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: stringifyContent(part.input ?? {}),
      });
    }
  }

  if (text) {
    converted.push({ role: 'assistant', content: text });
  }
  converted.push(...functionCalls);
  return converted;
}

export function convertModelMessagesToResponsesInput(messages: unknown[] | undefined): unknown[] {
  const converted: unknown[] = [];

  for (const message of messages ?? []) {
    if (!isRecord(message) || typeof message.role !== 'string') {
      continue;
    }

    if (message.role === 'system') {
      converted.push({ role: 'system', content: stringifyContent(message.content) });
      continue;
    }

    if (message.role === 'user') {
      converted.push({ role: 'user', content: convertContentParts(message.content) });
      continue;
    }

    if (message.role === 'tool') {
      converted.push(...convertToolMessage(message));
      continue;
    }

    if (message.role === 'assistant') {
      converted.push(...convertAssistantMessage(message));
    }
  }

  return converted;
}

function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    if (schema && typeof (schema as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
      return (schema as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema();
    }
    return z.toJSONSchema(schema as z.ZodTypeAny) as Record<string, unknown>;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

export function convertToolsToResponsesTools(tools: unknown): unknown[] | undefined {
  if (!isRecord(tools)) {
    return undefined;
  }

  const converted = Object.entries(tools).map(([name, tool]) => {
    const toolRecord = isRecord(tool) ? tool : {};
    return {
      type: 'function',
      name,
      description: typeof toolRecord.description === 'string' ? toolRecord.description : '',
      parameters: schemaToJsonSchema(toolRecord.inputSchema),
      ...(toolRecord.strict === true ? { strict: true } : {}),
    };
  });

  return converted.length > 0 ? converted : undefined;
}

export function convertToolChoiceToResponsesToolChoice(toolChoice: ToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }
  return {
    type: 'function',
    name: toolChoice.toolName,
  };
}

export function mapOpenAIResponsesUsage(usage: unknown): DeepSeekUsage {
  const record = isRecord(usage) ? usage : {};
  const inputTokens = typeof record.input_tokens === 'number' ? record.input_tokens : 0;
  const outputTokens = typeof record.output_tokens === 'number' ? record.output_tokens : 0;
  const totalTokens = typeof record.total_tokens === 'number'
    ? record.total_tokens
    : inputTokens + outputTokens;
  const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : {};
  const cachedTokens = typeof inputDetails.cached_tokens === 'number' ? inputDetails.cached_tokens : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputTokenDetails: {
      cacheReadTokens: cachedTokens,
      noCacheTokens: Math.max(0, inputTokens - cachedTokens),
    },
    cachedInputTokens: cachedTokens,
  };
}

function logOpenAIResponsesTokenUsage(model: string, usage: DeepSeekUsage): void {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens
    ?? usage.cachedInputTokens
    ?? 0;
  const cacheWriteInputTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const nonCachedInputTokens = usage.inputTokenDetails?.noCacheTokens
    ?? Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens);
  const hasPricing = Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
  const costCents = hasPricing
    ? calculateCostCents(model, inputTokens, outputTokens, {
      cachedInputTokens,
      cacheWriteInputTokens,
      nonCachedInputTokens,
    })
    : null;
  const costUsd = costCents == null ? null : costCents / 100;

  console.log(
    '[OPENAI-RESPONSES-TOKENS]'
    + ` model=${model}`
    + ` input_tokens=${inputTokens}`
    + ` output_tokens=${outputTokens}`
    + ` cached_tokens=${cachedInputTokens}`
    + ` total_tokens=${totalTokens}`
    + ` cost_cents=${costCents ?? 'unknown'}`
    + ` cost_usd=${costUsd == null ? 'unknown' : costUsd.toFixed(2)}`,
  );
}

function createStreamState(): StreamControllerState {
  let resolveUsage!: (usage: DeepSeekUsage) => void;
  let rejectUsage!: (error: unknown) => void;
  const usage = new Promise<DeepSeekUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  return { resolveUsage, rejectUsage, usage };
}

function mergeFunctionCallItem(
  current: ResponsesFunctionCallAccumulator,
  item: Record<string, unknown>,
): ResponsesFunctionCallAccumulator {
  if (typeof item.id === 'string') {
    current.itemId = item.id;
  }
  if (typeof item.call_id === 'string') {
    current.callId = item.call_id;
  }
  if (typeof item.name === 'string') {
    current.name = item.name;
  }
  if (typeof item.arguments === 'string') {
    current.arguments = item.arguments;
  }
  return current;
}

function parseToolCallArguments(argumentsText: string): unknown {
  try {
    return argumentsText ? JSON.parse(argumentsText) : {};
  } catch {
    return argumentsText;
  }
}

function buildToolCallPart(call: ResponsesFunctionCallAccumulator): unknown | null {
  if (!call.callId || !call.name) {
    return null;
  }

  return {
    type: 'tool-call',
    toolCallId: call.callId,
    toolName: call.name,
    input: parseToolCallArguments(call.arguments),
  };
}

function getFunctionCallAccumulator(
  toolCallDeltas: Map<number, ResponsesFunctionCallAccumulator>,
  outputIndex: number,
): ResponsesFunctionCallAccumulator {
  const current = toolCallDeltas.get(outputIndex) ?? { arguments: '' };
  toolCallDeltas.set(outputIndex, current);
  return current;
}

function extractOutputText(response: unknown): string {
  if (!isRecord(response)) {
    return '';
  }
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  let text = '';
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
  }
  return text;
}

export function streamOpenAIResponsesText(options: OpenAIResponsesStreamTextOptions): {
  fullStream: AsyncIterable<unknown>;
  usage: Promise<DeepSeekUsage>;
  response: Promise<{ messages: unknown[] }>;
} {
  const client = createOpenAIResponsesClient();
  const state = createStreamState();
  const responseMessages: unknown[] = [];

  const fullStream = {
    async *[Symbol.asyncIterator]() {
      const toolCallDeltas = new Map<number, ResponsesFunctionCallAccumulator>();
      let assistantText = '';
      let usageSettled = false;

      try {
        const stream = await client.responses.create({
          model: toOpenAIResponsesModel(options.model),
          instructions: options.system,
          input: convertModelMessagesToResponsesInput(options.messages) as never,
          stream: true,
          tools: convertToolsToResponsesTools(options.tools) as never,
          tool_choice: convertToolChoiceToResponsesToolChoice(options.toolChoice) as never,
          ...buildOpenAIResponsesRequestOptions(options.model, options.reasoning_effort),
        } as never, {
          signal: options.abortSignal,
        });

        for await (const event of stream as unknown as AsyncIterable<unknown>) {
          if (!isRecord(event)) {
            continue;
          }

          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            assistantText += event.delta;
            yield { type: 'text-delta', text: event.delta };
            continue;
          }

          if (
            event.type === 'response.output_item.added'
            && typeof event.output_index === 'number'
            && isRecord(event.item)
            && event.item.type === 'function_call'
          ) {
            const current = getFunctionCallAccumulator(toolCallDeltas, event.output_index);
            mergeFunctionCallItem(current, event.item);
            continue;
          }

          if (event.type === 'response.function_call_arguments.delta' && typeof event.output_index === 'number') {
            const current = getFunctionCallAccumulator(toolCallDeltas, event.output_index);
            if (typeof event.item_id === 'string') {
              current.itemId = event.item_id;
            }
            if (typeof event.delta === 'string') {
              current.arguments += event.delta;
            }
            continue;
          }

          if (event.type === 'response.function_call_arguments.done' && typeof event.output_index === 'number') {
            const current = getFunctionCallAccumulator(toolCallDeltas, event.output_index);
            if (isRecord(event.item) && event.item.type === 'function_call') {
              mergeFunctionCallItem(current, event.item);
            }
            if (typeof event.arguments === 'string') {
              current.arguments = event.arguments;
            }
            const toolCallPart = buildToolCallPart(current);
            if (toolCallPart && !current.emitted) {
              current.emitted = true;
              yield toolCallPart;
            }
            continue;
          }

          if (
            event.type === 'response.output_item.done'
            && typeof event.output_index === 'number'
            && isRecord(event.item)
            && event.item.type === 'function_call'
          ) {
            const current = getFunctionCallAccumulator(toolCallDeltas, event.output_index);
            mergeFunctionCallItem(current, event.item);
            const toolCallPart = buildToolCallPart(current);
            if (toolCallPart && !current.emitted) {
              current.emitted = true;
              yield toolCallPart;
            }
            continue;
          }

          if (event.type === 'response.completed' && isRecord(event.response)) {
            const usage = mapOpenAIResponsesUsage(event.response.usage);
            logOpenAIResponsesTokenUsage(options.model, usage);
            usageSettled = true;
            state.resolveUsage(usage);
            continue;
          }

          if (event.type === 'response.failed' && isRecord(event.response)) {
            const error = event.response.error ?? event.response;
            usageSettled = true;
            state.rejectUsage(error);
            yield { type: 'error', error };
            return;
          }

          if (event.type === 'error') {
            const error = event.error ?? event;
            usageSettled = true;
            state.rejectUsage(error);
            yield { type: 'error', error };
            return;
          }
        }

        if (assistantText.trim()) {
          responseMessages.push({ role: 'assistant', content: assistantText });
        }

        for (const [, toolCall] of [...toolCallDeltas.entries()].sort(([left], [right]) => left - right)) {
          const toolCallPart = buildToolCallPart(toolCall);
          if (toolCallPart && !toolCall.emitted) {
            toolCall.emitted = true;
            yield toolCallPart;
          }
        }

        if (!usageSettled) {
          const usage = mapOpenAIResponsesUsage(undefined);
          logOpenAIResponsesTokenUsage(options.model, usage);
          state.resolveUsage(usage);
        }
      } catch (error) {
        state.rejectUsage(error);
        yield { type: 'error', error };
      }
    },
  };

  return {
    fullStream,
    usage: state.usage,
    response: Promise.resolve({ messages: responseMessages }),
  };
}

export async function generateOpenAIResponsesText(
  options: DeepSeekGenerateTextOptions,
): Promise<DeepSeekTextResult> {
  const client = createOpenAIResponsesClient();
  const result = await client.responses.create({
    model: toOpenAIResponsesModel(options.model),
    input: options.messages
      ? convertModelMessagesToResponsesInput([
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        ...options.messages,
      ])
      : options.prompt ?? '',
    ...buildOpenAIResponsesRequestOptions(options.model),
  } as never, {
    signal: options.abortSignal,
  });

  const usage = mapOpenAIResponsesUsage((result as { usage?: unknown }).usage);
  logOpenAIResponsesTokenUsage(options.model, usage);

  return {
    text: extractOutputText(result),
    usage: Promise.resolve(usage),
  };
}
