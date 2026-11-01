import type { SharedV3ProviderOptions as ProviderOptions } from '@ai-sdk/provider';
import type { ProviderReasoningPart } from '../types/agent.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMiniMaxModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith('minimax/');
}

export function isDeepSeekModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith('deepseek/');
}

export function modelUsesNativeProviderReasoning(model: string | null | undefined): boolean {
  return isMiniMaxModel(model) || isDeepSeekModel(model);
}

// MiniMax and DeepSeek replay reasoning to the API via a reasoning_content
// field on assistant messages; make sure every reasoning part carries it.
function ensureNativeReasoningContent(args: {
  text: string;
  providerOptions?: ProviderOptions;
  model?: string;
}): ProviderOptions | undefined {
  const { text, providerOptions, model } = args;

  if (!modelUsesNativeProviderReasoning(model) || text.trim().length === 0) {
    return providerOptions;
  }

  const gatewayOptions = isRecord(providerOptions?.gateway)
    ? providerOptions.gateway
    : undefined;
  const existingReasoningContent = typeof gatewayOptions?.reasoning_content === 'string'
    ? gatewayOptions.reasoning_content
    : undefined;

  if (existingReasoningContent && existingReasoningContent.trim().length > 0) {
    return providerOptions;
  }

  return {
    ...(providerOptions ?? {}),
    gateway: {
      ...(gatewayOptions ?? {}),
      reasoning_content: text,
    },
  };
}

export function enrichProviderReasoningPartForModel(
  part: ProviderReasoningPart,
  model?: string,
): ProviderReasoningPart {
  const providerOptions = ensureNativeReasoningContent({
    text: part.text,
    providerOptions: part.providerOptions,
    model,
  });

  return providerOptions
    ? {
        text: part.text,
        providerOptions,
      }
    : {
        text: part.text,
      };
}

export function enrichProviderReasoningPartsForModel(
  parts: ProviderReasoningPart[],
  model?: string,
): ProviderReasoningPart[] {
  return parts.map((part) => enrichProviderReasoningPartForModel(part, model));
}
