import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, ModelMessage } from 'ai';
import { fetchWithDispatcher } from './ai-provider.js';

const ANTHROPIC_MODEL_PREFIX = 'anthropic/';

/**
 * Internal model ids for Anthropic models are namespaced as `anthropic/<id>`
 * (e.g. `anthropic/claude-sonnet-5`). We route these directly to the Anthropic
 * API via the first-party `@ai-sdk/anthropic` provider rather than through the
 * OpenRouter OpenAI-compatible shim.
 */
export function isAnthropicModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.trim().startsWith(ANTHROPIC_MODEL_PREFIX);
}

/** Strip the `anthropic/` namespace to get the native Anthropic model id. */
function toAnthropicModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith(ANTHROPIC_MODEL_PREFIX)
    ? trimmed.slice(ANTHROPIC_MODEL_PREFIX.length)
    : trimmed;
}

let anthropicProvider: ReturnType<typeof createAnthropic> | undefined;

function getAnthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!anthropicProvider) {
    anthropicProvider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Reuse the long-timeout undici dispatcher used for the AI gateway so
      // multi-minute agent turns don't hit the default fetch timeout.
      fetch: fetchWithDispatcher,
    });
  }
  return anthropicProvider;
}

/**
 * Resolve a language model for the AI SDK `streamText`/`generateText` helpers.
 *
 * Anthropic models are bound to the native Anthropic provider so they hit the
 * Anthropic API directly. Every other model id is returned unchanged (a bare
 * string, resolved by the AI SDK the same way as before).
 */
export function resolveLanguageModel(model: string): LanguageModel {
  return isAnthropicModel(model)
    ? getAnthropicProvider()(toAnthropicModelId(model))
    : model;
}

/**
 * Anthropic prompt-caching breakpoint. `providerOptions.anthropic` is only read
 * by the Anthropic provider; every other provider ignores it — so this is inert
 * for non-Anthropic models. We still gate callers on {@link isAnthropicModel} so
 * non-Anthropic requests stay byte-identical.
 */
// Default ephemeral TTL is 5 minutes (write premium 1.25x input).
const ANTHROPIC_CACHE_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: { type: 'ephemeral' as const } },
} as const;

/**
 * Rebuild a `{ system, messages }` payload with Anthropic prompt-cache
 * breakpoints:
 *
 *  1. The system prompt (passed as the leading `system` message) — a breakpoint
 *     here caches the tool schemas + system prompt, which is the largest fixed
 *     cost re-sent on every turn.
 *  2. A rolling breakpoint on the final message, so the growing conversation
 *     prefix is cached across turns.
 *
 * The returned payload sets top-level `system` to `undefined` because the system
 * prompt now travels as a `system`-role message carrying the cache breakpoint.
 * Call this only for Anthropic models.
 */
export function buildAnthropicCachedPrompt(
  system: string | undefined,
  messages: ModelMessage[],
): { system: undefined; messages: ModelMessage[] } {
  const cachedMessages: ModelMessage[] = [];
  if (system) {
    cachedMessages.push({
      role: 'system',
      content: system,
      providerOptions: ANTHROPIC_CACHE_PROVIDER_OPTIONS,
    });
  }
  cachedMessages.push(...messages);

  const lastIndex = cachedMessages.length - 1;
  if (lastIndex >= 0) {
    const lastMessage = cachedMessages[lastIndex]!;
    cachedMessages[lastIndex] = {
      ...lastMessage,
      providerOptions: {
        ...lastMessage.providerOptions,
        ...ANTHROPIC_CACHE_PROVIDER_OPTIONS,
      },
    } as ModelMessage;
  }

  return { system: undefined, messages: cachedMessages };
}
