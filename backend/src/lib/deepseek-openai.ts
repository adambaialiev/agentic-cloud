import OpenAI from 'openai';
import { z } from 'zod';
import {
  MODEL_PRICING,
  calculateCostCents,
} from '../config/pricing.js';

const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MINIMAX_M3_MODEL = 'minimax/minimax-m3';
const DEEPSEEK_V4_PRO_MODEL = 'deepseek/deepseek-v4-pro';
// MiniMax expects its own casing for model ids (e.g. "MiniMax-M3").
const MINIMAX_API_MODEL_IDS: Record<string, string> = {
  'minimax-m3': 'MiniMax-M3',
};
const QWEN_3_7_MAX_MODEL = 'qwen/qwen3.7-max';
const HIGH_REASONING_EFFORT = 'high';

type ToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };

export interface DeepSeekStreamTextOptions {
  model: string;
  system?: string;
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: ToolChoice;
  extra_body?: Record<string, unknown>;
  reasoning_effort?: typeof HIGH_REASONING_EFFORT;
  abortSignal?: AbortSignal;
}

export interface DeepSeekGenerateTextOptions {
  model: string;
  prompt?: string;
  system?: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
}

export interface DeepSeekTextResult {
  text: string;
  usage: Promise<DeepSeekUsage>;
}

export interface DeepSeekUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
  cachedInputTokens?: number;
  costUsd?: number;
  costDetails?: Record<string, unknown>;
}

interface StreamControllerState {
  resolveUsage: (usage: DeepSeekUsage) => void;
  rejectUsage: (error: unknown) => void;
  usage: Promise<DeepSeekUsage>;
}

export function createOpenAICompatClient(model: string): OpenAI {
  const trimmedModel = model.trim();
  if (trimmedModel.startsWith('qwen/')) {
    return new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }

  if (trimmedModel.startsWith('openai/')) {
    return new OpenAI({
      baseURL: OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  if (trimmedModel.startsWith('deepseek/')) {
    return new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
  }

  return new OpenAI({
    baseURL: MINIMAX_BASE_URL,
    apiKey: process.env.MINIMAX_API_KEY,
  });
}

function toMiniMaxModel(model: string): string {
  const bareModel = model.startsWith('minimax/') ? model.slice('minimax/'.length) : model;
  return MINIMAX_API_MODEL_IDS[bareModel] ?? bareModel;
}

function toOpenAIModel(model: string): string {
  return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}

function toDeepSeekModel(model: string): string {
  return model.startsWith('deepseek/') ? model.slice('deepseek/'.length) : model;
}

function toOpenAICompatModel(model: string): string {
  const trimmedModel = model.trim();
  if (trimmedModel.startsWith('minimax/')) {
    return toMiniMaxModel(trimmedModel);
  }
  if (trimmedModel.startsWith('deepseek/')) {
    return toDeepSeekModel(trimmedModel);
  }
  if (trimmedModel.startsWith('openai/')) {
    return toOpenAIModel(trimmedModel);
  }
  return trimmedModel;
}

export function buildMiniMaxExtraBody(model: string): Record<string, unknown> | undefined {
  if (model.trim() !== MINIMAX_M3_MODEL) {
    return undefined;
  }

  // M3 only accepts thinking.type adaptive or disabled. reasoning_split keeps
  // thinking out of the visible text: it arrives as reasoning_content deltas
  // instead of inline <think> tags. The priority service tier buys faster
  // admission and fewer failures at 1.5x standard pricing — keep MODEL_PRICING
  // in sync with the tier chosen here. The API silently ignores unknown tier
  // values, so verify via the service_tier echo in responses when changing it.
  return {
    thinking: { type: 'adaptive' },
    reasoning_split: true,
    service_tier: 'priority',
  };
}

export function buildDeepSeekExtraBody(model: string): Record<string, unknown> | undefined {
  if (model.trim() !== DEEPSEEK_V4_PRO_MODEL) {
    return undefined;
  }

  return {
    thinking: { type: 'enabled' },
  };
}

function buildReasoningEffort(model: string): typeof HIGH_REASONING_EFFORT | undefined {
  const trimmedModel = model.trim();
  if (isOpenAIGpt5FamilyModel(trimmedModel)) {
    return undefined;
  }

  // MiniMax does not accept reasoning_effort; its thinking mode is set via
  // extra_body instead.
  return trimmedModel === DEEPSEEK_V4_PRO_MODEL
    || trimmedModel === QWEN_3_7_MAX_MODEL
    || trimmedModel.startsWith('openai/')
    ? HIGH_REASONING_EFFORT
    : undefined;
}

function isOpenAIGpt5FamilyModel(model: string): boolean {
  return model.trim().startsWith('openai/gpt-5');
}

function resolveReasoningEffort(
  model: string,
  reasoningEffort: typeof HIGH_REASONING_EFFORT | undefined,
): typeof HIGH_REASONING_EFFORT | undefined {
  return isOpenAIGpt5FamilyModel(model) ? undefined : reasoningEffort;
}

export function buildOpenAICompatRequestOptions(model: string): {
  extra_body?: Record<string, unknown>;
  reasoning_effort?: typeof HIGH_REASONING_EFFORT;
} {
  const extraBody = buildMiniMaxExtraBody(model) ?? buildDeepSeekExtraBody(model);
  const reasoningEffort = buildReasoningEffort(model);
  return {
    ...(extraBody ? { extra_body: extraBody } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image') {
      const image = part.image instanceof URL ? part.image.toString() : part.image;
      if (typeof image === 'string') {
        parts.push({ type: 'image_url', image_url: { url: image } });
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
        role: 'tool',
        tool_call_id: toolCallId,
        content: convertToolResultContent(part),
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
    role: 'tool',
    tool_call_id: topLevelToolCallId,
    content: stringifyContent(message.content),
  }];
}

function convertModelMessages(system: string | undefined, messages: unknown[] | undefined): unknown[] {
  const converted: unknown[] = [];
  if (system) {
    converted.push({ role: 'system', content: system });
  }

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

    if (message.role !== 'assistant') {
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : undefined;
    const toolCalls: unknown[] = [];
    let text = typeof message.content === 'string' ? message.content : '';
    let reasoningContent: string | undefined;
    const reasoningDetails: unknown[] = [];

    for (const part of content ?? []) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        text += part.text;
      }
      if (part.type === 'reasoning') {
        const providerOptions = isRecord(part.providerOptions) ? part.providerOptions : undefined;
        const gatewayOptions = isRecord(providerOptions?.gateway) ? providerOptions.gateway : undefined;
        const reasoning = typeof part.text === 'string'
          ? part.text
          : typeof gatewayOptions?.reasoning_content === 'string'
            ? gatewayOptions.reasoning_content
            : undefined;
        if (reasoning) {
          reasoningContent = reasoningContent ? `${reasoningContent}\n${reasoning}` : reasoning;
        }
        // MiniMax interleaved thinking asks for reasoning_details to be
        // replayed unchanged in later turns.
        if (Array.isArray(gatewayOptions?.reasoning_details)) {
          reasoningDetails.push(...gatewayOptions.reasoning_details);
        }
      }
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
        toolCalls.push({
          id: part.toolCallId,
          type: 'function',
          function: {
            name: part.toolName,
            arguments: stringifyContent(part.input ?? {}),
          },
        });
      }
    }

    converted.push({
      role: 'assistant',
      content: text || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
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

function convertTools(tools: unknown): unknown[] | undefined {
  if (!isRecord(tools)) {
    return undefined;
  }

  const converted = Object.entries(tools).map(([name, tool]) => {
    const toolRecord = isRecord(tool) ? tool : {};
    return {
      type: 'function',
      function: {
        name,
        description: typeof toolRecord.description === 'string' ? toolRecord.description : '',
        parameters: schemaToJsonSchema(toolRecord.inputSchema),
      },
    };
  });

  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice: ToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }
  return {
    type: 'function',
    function: { name: toolChoice.toolName },
  };
}

function mapUsage(usage: unknown): DeepSeekUsage {
  const record = isRecord(usage) ? usage : {};
  const promptTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0;
  const completionTokens = typeof record.completion_tokens === 'number' ? record.completion_tokens : 0;
  const totalTokens = typeof record.total_tokens === 'number'
    ? record.total_tokens
    : promptTokens + completionTokens;
  const promptDetails = isRecord(record.prompt_tokens_details) ? record.prompt_tokens_details : {};
  const cachedTokens = typeof promptDetails.cached_tokens === 'number'
    ? promptDetails.cached_tokens
    : typeof record.prompt_cache_hit_tokens === 'number'
      ? record.prompt_cache_hit_tokens
      : 0;
  const cacheWriteTokens = typeof promptDetails.cache_write_tokens === 'number' ? promptDetails.cache_write_tokens : 0;
  const cacheMissTokens = typeof record.prompt_cache_miss_tokens === 'number'
    ? record.prompt_cache_miss_tokens
    : Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
  const costUsd = typeof record.cost === 'number' && Number.isFinite(record.cost)
    ? record.cost
    : undefined;
  const costDetails = isRecord(record.cost_details) ? record.cost_details : undefined;

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    inputTokenDetails: {
      cacheReadTokens: cachedTokens,
      cacheWriteTokens,
      noCacheTokens: cacheMissTokens,
    },
    cachedInputTokens: cachedTokens,
    ...(costUsd != null ? { costUsd } : {}),
    ...(costDetails ? { costDetails } : {}),
  };
}

function logTokenUsage(model: string, usage: DeepSeekUsage): void {
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
  const costCents = typeof usage.costUsd === 'number'
    ? Math.ceil(Math.max(0, usage.costUsd) * 100)
    : hasPricing
      ? calculateCostCents(model, inputTokens, outputTokens, {
      cachedInputTokens,
      cacheWriteInputTokens,
      nonCachedInputTokens,
    })
      : null;
  const costUsd = costCents == null ? null : costCents / 100;

  console.log(
    '[MODEL-TOKENS]'
    + ` model=${model}`
    + ` prompt_tokens=${inputTokens}`
    + ` completion_tokens=${outputTokens}`
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

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

interface ThinkTagFilterResult {
  text: string;
  reasoning: string;
}

function longestTagPrefixAtEnd(buffer: string, tag: string): number {
  const maxLength = Math.min(buffer.length, tag.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (buffer.endsWith(tag.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

// MiniMax puts reasoning inside <think>...</think> tags in the visible text
// whenever reasoning_split does not apply (and, defensively, whenever a tag
// slips through). This filter reroutes those segments to the reasoning
// channel, holding back partial tags that span chunk boundaries.
export function createThinkTagFilter(): {
  push(chunk: string): ThinkTagFilterResult;
  flush(): ThinkTagFilterResult;
} {
  let inThink = false;
  let buffer = '';

  function drain(final: boolean): ThinkTagFilterResult {
    let text = '';
    let reasoning = '';

    for (;;) {
      const tag = inThink ? THINK_CLOSE_TAG : THINK_OPEN_TAG;
      const tagIndex = buffer.indexOf(tag);
      if (tagIndex === -1) {
        break;
      }
      const before = buffer.slice(0, tagIndex);
      if (inThink) {
        reasoning += before;
      } else {
        text += before;
      }
      buffer = buffer.slice(tagIndex + tag.length);
      inThink = !inThink;
    }

    const holdback = final
      ? 0
      : longestTagPrefixAtEnd(buffer, inThink ? THINK_CLOSE_TAG : THINK_OPEN_TAG);
    const emitted = buffer.slice(0, buffer.length - holdback);
    buffer = buffer.slice(buffer.length - holdback);
    if (inThink) {
      reasoning += emitted;
    } else {
      text += emitted;
    }
    return { text, reasoning };
  }

  return {
    push(chunk: string): ThinkTagFilterResult {
      buffer += chunk;
      return drain(false);
    },
    flush(): ThinkTagFilterResult {
      return drain(true);
    },
  };
}

export function stripThinkTags(value: string): ThinkTagFilterResult {
  const filter = createThinkTagFilter();
  const pushed = filter.push(value);
  const flushed = filter.flush();
  return {
    text: pushed.text + flushed.text,
    reasoning: pushed.reasoning + flushed.reasoning,
  };
}

// MiniMax interleaved thinking requires reasoning_details to be preserved
// unchanged across turns. Streaming delivers it as per-item text deltas keyed
// by index/id, so concatenate those and keep everything else verbatim.
function mergeReasoningDetailDeltas(
  accumulated: Record<string, unknown>[],
  items: unknown[],
): void {
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const existing = accumulated.find((entry) => (
      entry.index === item.index && entry.id === item.id && entry.type === item.type
    ));
    if (existing && typeof existing.text === 'string' && typeof item.text === 'string') {
      existing.text += item.text;
    } else {
      accumulated.push({ ...item });
    }
  }
}

export function streamDeepSeekText(options: DeepSeekStreamTextOptions): {
  fullStream: AsyncIterable<unknown>;
  usage: Promise<DeepSeekUsage>;
  response: Promise<{ messages: unknown[] }>;
} {
  const client = createOpenAICompatClient(options.model);
  const state = createStreamState();
  const responseMessages: unknown[] = [];

  const fullStream = {
    async *[Symbol.asyncIterator]() {
      const toolCallDeltas = new Map<number, {
        id?: string;
        name?: string;
        arguments: string;
      }>();

      try {
        const requestOptions = buildOpenAICompatRequestOptions(options.model);
        const reasoningEffort = resolveReasoningEffort(
          options.model,
          options.reasoning_effort ?? requestOptions.reasoning_effort,
        );
        const stream = await client.chat.completions.create({
          model: toOpenAICompatModel(options.model),
          messages: convertModelMessages(options.system, options.messages) as never,
          stream: true,
          stream_options: { include_usage: true },
          tools: convertTools(options.tools) as never,
          tool_choice: convertToolChoice(options.toolChoice) as never,
          // openai-node, unlike the Python SDK, does not merge extra_body into
          // the request payload — it would be sent as a literal "extra_body"
          // field the provider ignores. Spread the params at the top level.
          ...(options.extra_body ?? requestOptions.extra_body ?? {}),
          ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
        } as never, {
          signal: options.abortSignal,
        });

        const thinkFilter = isMiniMaxModel(options.model) ? createThinkTagFilter() : null;
        const reasoningDetails: Record<string, unknown>[] = [];
        let assistantText = '';
        let reasoningText = '';
        let loggedUsage = false;

        for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
          if (isRecord(chunk) && chunk.usage) {
            const usage = mapUsage(chunk.usage);
            if (!loggedUsage) {
              logTokenUsage(options.model, usage);
              loggedUsage = true;
            }
            state.resolveUsage(usage);
          }

          const choices = isRecord(chunk) && Array.isArray(chunk.choices) ? chunk.choices : [];
          for (const choice of choices) {
            const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : {};
            const reasoningContent = typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : undefined;
            if (reasoningContent) {
              reasoningText += reasoningContent;
              yield {
                type: 'reasoning-delta',
                text: reasoningContent,
                providerOptions: {
                  gateway: { reasoning_content: reasoningContent },
                },
              };
            }

            if (Array.isArray(delta.reasoning_details)) {
              mergeReasoningDetailDeltas(reasoningDetails, delta.reasoning_details);
            }

            if (typeof delta.content === 'string' && delta.content.length > 0) {
              const filtered = thinkFilter
                ? thinkFilter.push(delta.content)
                : { text: delta.content, reasoning: '' };
              if (filtered.reasoning) {
                reasoningText += filtered.reasoning;
                yield {
                  type: 'reasoning-delta',
                  text: filtered.reasoning,
                  providerOptions: {
                    gateway: { reasoning_content: filtered.reasoning },
                  },
                };
              }
              if (filtered.text) {
                assistantText += filtered.text;
                yield { type: 'text-delta', text: filtered.text };
              }
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const toolCallDelta of delta.tool_calls) {
                if (!isRecord(toolCallDelta) || typeof toolCallDelta.index !== 'number') {
                  continue;
                }
                const current = toolCallDeltas.get(toolCallDelta.index) ?? { arguments: '' };
                if (typeof toolCallDelta.id === 'string') {
                  current.id = toolCallDelta.id;
                }
                if (isRecord(toolCallDelta.function)) {
                  if (typeof toolCallDelta.function.name === 'string') {
                    current.name = toolCallDelta.function.name;
                  }
                  if (typeof toolCallDelta.function.arguments === 'string') {
                    current.arguments += toolCallDelta.function.arguments;
                  }
                }
                toolCallDeltas.set(toolCallDelta.index, current);
              }
            }
          }
        }

        if (thinkFilter) {
          const flushed = thinkFilter.flush();
          if (flushed.reasoning) {
            reasoningText += flushed.reasoning;
            yield {
              type: 'reasoning-delta',
              text: flushed.reasoning,
              providerOptions: {
                gateway: { reasoning_content: flushed.reasoning },
              },
            };
          }
          if (flushed.text) {
            assistantText += flushed.text;
            yield { type: 'text-delta', text: flushed.text };
          }
        }

        if (reasoningText.trim()) {
          responseMessages.push({
            role: 'assistant',
            content: [{
              type: 'reasoning',
              text: reasoningText.trim(),
              providerOptions: {
                gateway: {
                  reasoning_content: reasoningText.trim(),
                  ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
                },
              },
            }],
          });
        }

        if (assistantText.trim()) {
          responseMessages.push({ role: 'assistant', content: assistantText });
        }

        for (const toolCall of [...toolCallDeltas.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
          if (!toolCall.id || !toolCall.name) {
            continue;
          }
          let input: unknown = toolCall.arguments;
          try {
            input = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
          } catch {
            input = toolCall.arguments;
          }
          yield {
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input,
          };
        }

        if (!loggedUsage) {
          const usage = mapUsage(undefined);
          logTokenUsage(options.model, usage);
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

export async function generateDeepSeekText(options: DeepSeekGenerateTextOptions): Promise<DeepSeekTextResult> {
  const client = createOpenAICompatClient(options.model);
  const requestOptions = buildOpenAICompatRequestOptions(options.model);
  const reasoningEffort = resolveReasoningEffort(options.model, requestOptions.reasoning_effort);
  const result = await client.chat.completions.create({
    model: toOpenAICompatModel(options.model),
    messages: convertModelMessages(
      options.system,
      options.messages ?? [{ role: 'user', content: options.prompt ?? '' }],
    ) as never,
    // Spread at the top level: openai-node does not merge extra_body.
    ...(requestOptions.extra_body ?? {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  } as never, {
    signal: options.abortSignal,
  });

  const usage = mapUsage(result.usage);
  logTokenUsage(options.model, usage);

  const rawText = result.choices[0]?.message?.content ?? '';

  return {
    text: isMiniMaxModel(options.model) ? stripThinkTags(rawText).text.trim() : rawText,
    usage: Promise.resolve(usage),
  };
}

export function isMiniMaxModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith('minimax/');
}

export function isOpenAICompatModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') {
    return false;
  }

  const trimmedModel = model.trim();
  return trimmedModel.startsWith('minimax/')
    || trimmedModel.startsWith('deepseek/')
    || trimmedModel.startsWith('qwen/')
    || (trimmedModel.startsWith('openai/') && !isOpenAIGpt5FamilyModel(trimmedModel));
}
