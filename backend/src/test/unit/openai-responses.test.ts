import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResponsesCreate,
  mockOpenAIConstructor,
} = vi.hoisted(() => ({
  mockResponsesCreate: vi.fn(),
  mockOpenAIConstructor: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: mockResponsesCreate,
    };

    constructor(options: unknown) {
      mockOpenAIConstructor(options);
    }
  }

  return {
    default: MockOpenAI,
  };
});

async function loadOpenAIResponses() {
  vi.resetModules();
  vi.doUnmock('../../lib/openai-responses.js');
  return import('../../lib/openai-responses.js');
}

async function* responseStream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

async function drainStream(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

describe('openai-responses adapter', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockOpenAIConstructor.mockReset();
    mockResponsesCreate.mockResolvedValue(responseStream([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 11,
            output_tokens: 3,
            total_tokens: 14,
            input_tokens_details: {
              cached_tokens: 5,
            },
          },
        },
      },
    ]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects OpenAI GPT-5-family Responses models only', async () => {
    const { isOpenAIResponsesModel } = await loadOpenAIResponses();

    expect(isOpenAIResponsesModel('openai/gpt-5')).toBe(true);
    expect(isOpenAIResponsesModel(' openai/gpt-5.4 ')).toBe(true);
    expect(isOpenAIResponsesModel('openai/gpt-5.4-2026-06-01')).toBe(true);
    expect(isOpenAIResponsesModel('openai/example-model')).toBe(false);
    expect(isOpenAIResponsesModel('qwen/qwen3.7-max')).toBe(false);
    expect(isOpenAIResponsesModel(null)).toBe(false);
  });

  it('converts system, messages, tools, tool choice, and reasoning to a Responses request', async () => {
    const { streamOpenAIResponsesText } = await loadOpenAIResponses();

    const result = streamOpenAIResponsesText({
      model: 'openai/gpt-5.4',
      system: 'You are concise.',
      messages: [
        { role: 'system', content: 'Replay system note.' },
        { role: 'user', content: 'Hello.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this.' },
            { type: 'image', image: new URL('https://example.com/image.png') },
          ],
        },
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
      tools: {
        read_files: {
          description: 'Read files',
          inputSchema: {
            toJSONSchema: () => ({
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            }),
          },
        },
      },
      toolChoice: { type: 'tool', toolName: 'read_files' },
    });

    await drainStream(result.fullStream);

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
    });
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    expect(mockResponsesCreate.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'You are concise.',
      reasoning: { effort: 'high' },
      stream: true,
      input: [
        { role: 'system', content: 'Replay system note.' },
        { role: 'user', content: 'Hello.' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look at this.' },
            { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' },
          ],
        },
        { role: 'assistant', content: 'Reading the file.' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_files',
          arguments: '{"path":"src/index.ts"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'export const value = 1;',
        },
      ],
      tools: [{
        type: 'function',
        name: 'read_files',
        description: 'Read files',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      }],
      tool_choice: {
        type: 'function',
        name: 'read_files',
      },
    });
    expect(mockResponsesCreate.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('drops orphan tool results instead of sending invalid function_call_output items', async () => {
    const { streamOpenAIResponsesText } = await loadOpenAIResponses();

    const result = streamOpenAIResponsesText({
      model: 'openai/gpt-5.4',
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

    await drainStream(result.fullStream);

    expect(mockResponsesCreate.mock.calls[0]?.[0]).toMatchObject({
      input: [
        { role: 'user', content: 'Continue.' },
      ],
    });
  });

  it('maps streaming text, function calls by call_id, and completed usage', async () => {
    mockResponsesCreate.mockResolvedValueOnce(responseStream([
      {
        type: 'response.output_text.delta',
        delta: 'Thinking done.',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_responses_123',
          name: 'read_files',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc_123',
        delta: '{"path":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc_123',
        delta: '"src/index.ts"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_responses_123',
          name: 'read_files',
          arguments: '{"path":"src/index.ts"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 20,
            output_tokens: 7,
            total_tokens: 27,
            input_tokens_details: {
              cached_tokens: 9,
            },
          },
        },
      },
    ]));
    const { streamOpenAIResponsesText } = await loadOpenAIResponses();

    const result = streamOpenAIResponsesText({
      model: 'openai/gpt-5.4',
      messages: [{ role: 'user', content: 'Read the file.' }],
      tools: {},
    });

    await expect(drainStream(result.fullStream)).resolves.toEqual([
      { type: 'text-delta', text: 'Thinking done.' },
      {
        type: 'tool-call',
        toolCallId: 'call_responses_123',
        toolName: 'read_files',
        input: { path: 'src/index.ts' },
      },
    ]);
    await expect(result.usage).resolves.toEqual({
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      inputTokenDetails: {
        cacheReadTokens: 9,
        noCacheTokens: 11,
      },
      cachedInputTokens: 9,
    });
  });

  it('maps non-streaming output_text and Responses usage', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      output_text: 'Short title',
      usage: {
        input_tokens: 12,
        output_tokens: 2,
        total_tokens: 14,
        input_tokens_details: {
          cached_tokens: 4,
        },
      },
    });
    const { generateOpenAIResponsesText } = await loadOpenAIResponses();

    const result = await generateOpenAIResponsesText({
      model: 'openai/gpt-5.4',
      prompt: 'Generate a title.',
    });

    expect(result.text).toBe('Short title');
    expect(mockResponsesCreate.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.4',
      input: 'Generate a title.',
      reasoning: { effort: 'high' },
    });
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 2,
      totalTokens: 14,
      cachedInputTokens: 4,
    });
  });

  it('yields error parts and rejects usage when the SDK request fails', async () => {
    const sdkError = new Error('OpenAI request failed');
    mockResponsesCreate.mockRejectedValueOnce(sdkError);
    const { streamOpenAIResponsesText } = await loadOpenAIResponses();

    const result = streamOpenAIResponsesText({
      model: 'openai/gpt-5.4',
      messages: [{ role: 'user', content: 'Hello.' }],
      tools: {},
    });

    await expect(drainStream(result.fullStream)).resolves.toEqual([
      { type: 'error', error: sdkError },
    ]);
    await expect(result.usage).rejects.toThrow('OpenAI request failed');
  });
});
