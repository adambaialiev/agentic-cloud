import { vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var __deepseekStreamTextMock: ((options: unknown) => unknown) | undefined;
  // eslint-disable-next-line no-var
  var __deepseekGenerateTextMock: ((options: unknown) => Promise<unknown> | unknown) | undefined;
  // eslint-disable-next-line no-var
  var __openAIResponsesStreamTextMock: ((options: unknown) => unknown) | undefined;
  // eslint-disable-next-line no-var
  var __openAIResponsesGenerateTextMock: ((options: unknown) => Promise<unknown> | unknown) | undefined;
}


vi.mock('../lib/deepseek-openai.js', () => ({
  isMiniMaxModel: (model: string | null | undefined) => (
    typeof model === 'string' && model.startsWith('minimax/')
  ),
  isOpenAICompatModel: (model: string | null | undefined) => (
    typeof model === 'string'
    && (
      model.trim().startsWith('minimax/')
      || model.trim().startsWith('qwen/')
      || (model.trim().startsWith('openai/') && !model.trim().startsWith('openai/gpt-5'))
    )
  ),
  buildMiniMaxExtraBody: (model: string | null | undefined) => (
    model === 'minimax/minimax-m3'
      ? {
          thinking: { type: 'adaptive' },
          reasoning_split: true,
          service_tier: 'priority',
        }
      : undefined
  ),
  buildOpenAICompatRequestOptions: (model: string | null | undefined) => {
    const trimmedModel = typeof model === 'string' ? model.trim() : '';
    return {
      ...(trimmedModel === 'minimax/minimax-m3'
        ? { extra_body: { thinking: { type: 'adaptive' }, reasoning_split: true, service_tier: 'priority' } }
        : {}),
      ...(
        trimmedModel === 'qwen/qwen3.7-max'
          || (trimmedModel.startsWith('openai/') && !trimmedModel.startsWith('openai/gpt-5'))
          ? { reasoning_effort: 'high' }
          : {}
      ),
    };
  },
  streamDeepSeekText: (options: unknown) => {
    if (!globalThis.__deepseekStreamTextMock) {
      throw new Error('DeepSeek OpenAI stream mock was not configured for this test');
    }
    return globalThis.__deepseekStreamTextMock({
      ...(options && typeof options === 'object' ? options : {}),
      transport: 'openai-compat',
    });
  },
  generateDeepSeekText: async (options: unknown) => {
    if (globalThis.__deepseekGenerateTextMock) {
      return globalThis.__deepseekGenerateTextMock(options);
    }
    return {
      text: 'Generated title',
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    };
  },
}));

vi.mock('../lib/openai-responses.js', () => ({
  isOpenAIResponsesModel: (model: string | null | undefined) => (
    typeof model === 'string' && model.trim().startsWith('openai/gpt-5')
  ),
  buildOpenAIResponsesRequestOptions: (
    _model: string | null | undefined,
    reasoningEffort?: string,
  ) => ({
    reasoning: { effort: reasoningEffort ?? 'high' },
  }),
  streamOpenAIResponsesText: (options: unknown) => {
    if (!globalThis.__openAIResponsesStreamTextMock) {
      throw new Error('OpenAI Responses stream mock was not configured for this test');
    }
    const optionsRecord = options && typeof options === 'object'
      ? options as Record<string, unknown>
      : {};
    return globalThis.__openAIResponsesStreamTextMock({
      ...optionsRecord,
      reasoning: { effort: optionsRecord.reasoning_effort ?? 'high' },
      transport: 'openai-responses',
    });
  },
  generateOpenAIResponsesText: async (options: unknown) => {
    if (globalThis.__openAIResponsesGenerateTextMock) {
      return globalThis.__openAIResponsesGenerateTextMock(options);
    }
    return {
      text: 'Generated title',
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    };
  },
}));
