import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCompletionsCreate,
  mockOpenAIConstructor,
} = vi.hoisted(() => ({
  mockCompletionsCreate: vi.fn(),
  mockOpenAIConstructor: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCompletionsCreate,
      },
    };

    constructor(options: unknown) {
      mockOpenAIConstructor(options);
    }
  }

  return {
    default: MockOpenAI,
  };
});

async function loadDeepSeekOpenAI() {
  vi.resetModules();
  vi.doUnmock('../../lib/deepseek-openai.js');
  return import('../../lib/deepseek-openai.js');
}

async function* emptyChatStream() {
  yield {
    choices: [],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
      prompt_tokens_details: {
        cached_tokens: 5,
      },
    },
  };
}

describe('deepseek-openai adapter', () => {
  beforeEach(() => {
    mockCompletionsCreate.mockReset();
    mockOpenAIConstructor.mockReset();
    mockCompletionsCreate.mockResolvedValue(emptyChatStream());
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts AI SDK tool-result parts to OpenAI tool messages with tool_call_id', async () => {
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'minimax/minimax-m3',
      system: 'You are concise.',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file.' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'read_files',
              input: { path: 'src/index.ts' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'read_files',
            output: { type: 'text', value: 'export const value = 1;' },
          }],
        },
      ],
      tools: {},
    });

    for await (const _part of result.fullStream) {
      // Drain the adapter stream so the OpenAI request is created.
    }

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://api.minimax.io/v1',
      apiKey: process.env.MINIMAX_API_KEY,
    });
    expect(mockCompletionsCreate).toHaveBeenCalledTimes(1);
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: 'MiniMax-M3',
      thinking: { type: 'adaptive' },
      reasoning_split: true,
      service_tier: 'priority',
      messages: [
        { role: 'system', content: 'You are concise.' },
        {
          role: 'assistant',
          content: 'Reading the file.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_files',
              arguments: '{"path":"src/index.ts"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'export const value = 1;',
        },
      ],
    });
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
    // openai-node does not merge extra_body, so it must never appear as a
    // literal request field.
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('extra_body');
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      cachedInputTokens: 5,
    });
    expect(console.log).toHaveBeenCalledWith(
      '[MODEL-TOKENS] model=minimax/minimax-m3 prompt_tokens=11 completion_tokens=3 cached_tokens=5 total_tokens=14 cost_cents=1 cost_usd=0.01',
    );
  });

  it('omits unrecoverable orphan tool messages instead of sending invalid OpenAI payloads', async () => {
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'minimax/minimax-m3',
      messages: [
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolName: 'read_files',
            output: { type: 'text', value: 'orphan result' },
          }],
        },
        { role: 'user', content: 'Continue.' },
      ],
      tools: {},
    });

    for await (const _part of result.fullStream) {
      // Drain the adapter stream so the OpenAI request is created.
    }

    expect(mockCompletionsCreate.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        { role: 'user', content: 'Continue.' },
      ],
    });
  });

  it('logs token usage for non-streaming MiniMax calls', async () => {
    mockCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Short title' } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 2,
        total_tokens: 22,
        prompt_tokens_details: {
          cached_tokens: 8,
        },
      },
    });
    const { generateDeepSeekText } = await loadDeepSeekOpenAI();

    const result = await generateDeepSeekText({
      model: 'minimax/minimax-m3',
      prompt: 'Generate a title.',
    });

    expect(result.text).toBe('Short title');
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: 'MiniMax-M3',
      thinking: { type: 'adaptive' },
      reasoning_split: true,
      service_tier: 'priority',
    });
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('extra_body');
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 20,
      outputTokens: 2,
      totalTokens: 22,
      cachedInputTokens: 8,
    });
    expect(console.log).toHaveBeenCalledWith(
      '[MODEL-TOKENS] model=minimax/minimax-m3 prompt_tokens=20 completion_tokens=2 cached_tokens=8 total_tokens=22 cost_cents=1 cost_usd=0.01',
    );
  });

  it('sends high reasoning effort to Qwen without MiniMax extra_body', async () => {
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'qwen/qwen3.7-max',
      messages: [{ role: 'user', content: 'Solve it.' }],
      tools: {},
    });

    for await (const _part of result.fullStream) {
      // Drain the adapter stream so the OpenAI request is created.
    }

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: 'qwen/qwen3.7-max',
      reasoning_effort: 'high',
    });
    expect(mockCompletionsCreate.mock.calls[0]?.[0]).not.toHaveProperty('extra_body');
  });

  it('preserves reported cost for OpenRouter models', async () => {
    mockCompletionsCreate.mockResolvedValueOnce((async function* () {
      yield {
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 2,
          total_tokens: 22,
          cost: 0.42,
          cost_details: {
            upstream_inference_cost: 0.4,
          },
          prompt_tokens_details: {
            cached_tokens: 8,
            cache_write_tokens: 3,
          },
        },
      };
    })());
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'qwen/qwen3.7-max',
      messages: [{ role: 'user', content: 'Solve it.' }],
      tools: {},
    });

    for await (const _part of result.fullStream) {
      // Drain the adapter stream so usage resolves.
    }

    await expect(result.usage).resolves.toEqual({
      inputTokens: 20,
      outputTokens: 2,
      totalTokens: 22,
      cachedInputTokens: 8,
      inputTokenDetails: {
        cacheReadTokens: 8,
        cacheWriteTokens: 3,
        noCacheTokens: 9,
      },
      costUsd: 0.42,
      costDetails: {
        upstream_inference_cost: 0.4,
      },
    });
    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  });

  it('does not route Anthropic models through the OpenAI-compatible client', async () => {
    const { isOpenAICompatModel, buildOpenAICompatRequestOptions } = await loadDeepSeekOpenAI();

    expect(isOpenAICompatModel('anthropic/claude-sonnet-5')).toBe(false);
    expect(buildOpenAICompatRequestOptions('anthropic/claude-sonnet-5')).toEqual({});
    expect(mockOpenAIConstructor).not.toHaveBeenCalled();
    expect(mockCompletionsCreate).not.toHaveBeenCalled();
  });

  it('excludes OpenAI GPT-5 provider models from Chat Completions routing', async () => {
    const { buildOpenAICompatRequestOptions, isOpenAICompatModel } = await loadDeepSeekOpenAI();

    expect(isOpenAICompatModel('openai/example-model')).toBe(true);
    expect(isOpenAICompatModel('openai/gpt-5')).toBe(false);
    expect(isOpenAICompatModel('openai/gpt-5.4')).toBe(false);
    expect(isOpenAICompatModel('openai/gpt-5.4-mini')).toBe(false);
    expect(buildOpenAICompatRequestOptions('openai/example-model')).toEqual({
      reasoning_effort: 'high',
    });
    expect(buildOpenAICompatRequestOptions('openai/gpt-5')).toEqual({});
    expect(buildOpenAICompatRequestOptions('openai/gpt-5.4')).toEqual({});
    expect(buildOpenAICompatRequestOptions('openai/gpt-5.4-mini')).toEqual({});
    expect(mockCompletionsCreate).not.toHaveBeenCalled();
  });

  it('reroutes inline think tags from MiniMax content deltas to the reasoning channel', async () => {
    mockCompletionsCreate.mockResolvedValueOnce((async function* () {
      // Tags split across chunk boundaries on purpose.
      yield { choices: [{ delta: { content: 'Hello <th' } }] };
      yield { choices: [{ delta: { content: 'ink>secret plan' } }] };
      yield { choices: [{ delta: { content: '</thi' } }] };
      yield { choices: [{ delta: { content: 'nk> world' } }] };
    })());
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'minimax/minimax-m3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
    });

    let text = '';
    let reasoning = '';
    for await (const part of result.fullStream as AsyncIterable<{ type: string; text?: string }>) {
      if (part.type === 'text-delta') text += part.text ?? '';
      if (part.type === 'reasoning-delta') reasoning += part.text ?? '';
    }

    expect(text).toBe('Hello  world');
    expect(reasoning).toBe('secret plan');

    const response = await result.response;
    expect(response.messages).toContainEqual({ role: 'assistant', content: 'Hello  world' });
  });

  it('routes an unterminated think block to reasoning instead of visible text', async () => {
    mockCompletionsCreate.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: '<think>cadence heartbeat, stay silent' } }] };
    })());
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'minimax/minimax-m3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
    });

    let text = '';
    let reasoning = '';
    for await (const part of result.fullStream as AsyncIterable<{ type: string; text?: string }>) {
      if (part.type === 'text-delta') text += part.text ?? '';
      if (part.type === 'reasoning-delta') reasoning += part.text ?? '';
    }

    expect(text).toBe('');
    expect(reasoning).toBe('cadence heartbeat, stay silent');
  });

  it('strips think tags from non-streaming MiniMax text such as titles', async () => {
    mockCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '<think>The user wants a title.</think>\n\nCheckout Fix Session' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const { generateDeepSeekText } = await loadDeepSeekOpenAI();

    const result = await generateDeepSeekText({
      model: 'minimax/minimax-m3',
      prompt: 'Generate a title.',
    });

    expect(result.text).toBe('Checkout Fix Session');
  });

  it('accumulates reasoning_details deltas and replays them on assistant history messages', async () => {
    mockCompletionsCreate.mockResolvedValueOnce((async function* () {
      yield {
        choices: [{
          delta: {
            reasoning_content: 'Check the ',
            reasoning_details: [{ type: 'reasoning.text', id: 'reasoning-text-1', format: 'MiniMax-response-v1', index: 0, text: 'Check the ' }],
          },
        }],
      };
      yield {
        choices: [{
          delta: {
            reasoning_content: 'weather.',
            reasoning_details: [{ type: 'reasoning.text', id: 'reasoning-text-1', format: 'MiniMax-response-v1', index: 0, text: 'weather.' }],
          },
        }],
      };
      yield { choices: [{ delta: { content: 'Sunny.' } }] };
    })());
    const { streamDeepSeekText } = await loadDeepSeekOpenAI();

    const result = streamDeepSeekText({
      model: 'minimax/minimax-m3',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {},
    });

    for await (const _part of result.fullStream) {
      // Drain so the response messages are assembled.
    }

    const response = await result.response;
    const reasoningMessage = response.messages[0] as {
      content: Array<{ providerOptions?: { gateway?: Record<string, unknown> } }>;
    };
    const gateway = reasoningMessage.content[0]?.providerOptions?.gateway;
    expect(gateway?.reasoning_content).toBe('Check the weather.');
    expect(gateway?.reasoning_details).toEqual([{
      type: 'reasoning.text',
      id: 'reasoning-text-1',
      format: 'MiniMax-response-v1',
      index: 0,
      text: 'Check the weather.',
    }]);

    // Replaying that stored part must echo reasoning_details unchanged.
    mockCompletionsCreate.mockResolvedValueOnce(emptyChatStream());
    const { streamDeepSeekText: streamAgain } = await loadDeepSeekOpenAI();
    const replay = streamAgain({
      model: 'minimax/minimax-m3',
      messages: [
        { role: 'user', content: 'weather?' },
        reasoningMessage,
        { role: 'assistant', content: 'Sunny.' },
      ],
      tools: {},
    });
    for await (const _part of replay.fullStream) {
      // Drain so the request is issued.
    }

    const replayedMessages = mockCompletionsCreate.mock.calls.at(-1)?.[0]?.messages as Array<Record<string, unknown>>;
    const replayedAssistant = replayedMessages.find((message) => message.role === 'assistant' && message.reasoning_content);
    expect(replayedAssistant?.reasoning_content).toBe('Check the weather.');
    expect(replayedAssistant?.reasoning_details).toEqual([{
      type: 'reasoning.text',
      id: 'reasoning-text-1',
      format: 'MiniMax-response-v1',
      index: 0,
      text: 'Check the weather.',
    }]);
  });
});
