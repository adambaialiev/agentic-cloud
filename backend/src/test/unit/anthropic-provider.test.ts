import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { buildAnthropicCachedPrompt, isAnthropicModel } from '../../lib/anthropic-provider.js';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('anthropic-provider', () => {
  it('identifies anthropic-namespaced models', () => {
    expect(isAnthropicModel('anthropic/claude-sonnet-5')).toBe(true);
    expect(isAnthropicModel(' anthropic/claude-sonnet-5 ')).toBe(true);
    expect(isAnthropicModel('deepseek/deepseek-v4-pro')).toBe(false);
    expect(isAnthropicModel('qwen/qwen3.7-max')).toBe(false);
    expect(isAnthropicModel(undefined)).toBe(false);
  });

  it('adds cache breakpoints on the system prompt and the final message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what is the weather?' },
    ];

    const { system, messages: cached } = buildAnthropicCachedPrompt('You are helpful.', messages);

    // System travels as a leading system message carrying the cache breakpoint.
    expect(system).toBeUndefined();
    expect(cached[0]).toEqual({
      role: 'system',
      content: 'You are helpful.',
      providerOptions: EPHEMERAL,
    });
    // Rolling breakpoint on the final message.
    expect(cached[cached.length - 1]?.providerOptions).toEqual(EPHEMERAL);
    // Middle messages are untouched.
    expect(cached[2]?.providerOptions).toBeUndefined();
  });

  it('does not mutate the caller-provided messages', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const snapshot = structuredClone(messages);

    buildAnthropicCachedPrompt('sys', messages);

    expect(messages).toEqual(snapshot);
  });

  it('caches the system prompt even when there are no messages yet', () => {
    const { system, messages: cached } = buildAnthropicCachedPrompt('sys', []);
    expect(system).toBeUndefined();
    expect(cached).toHaveLength(1);
    expect(cached[0]?.providerOptions).toEqual(EPHEMERAL);
  });
});
