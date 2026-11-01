import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, isSupportedModel, resolveConfiguredModel, resolveSupportedModel, SUPPORTED_MODELS } from '../../config/models.js';

describe('models config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('supports the configured model roster', () => {
    expect(SUPPORTED_MODELS).toEqual([
      'minimax/minimax-m3',
      'deepseek/deepseek-v4-pro',
      'anthropic/claude-sonnet-5',
      'qwen/qwen3.7-max',
      'openai/gpt-5.4',
    ]);
    expect(isSupportedModel('minimax/minimax-m3')).toBe(true);
    expect(isSupportedModel('anthropic/claude-sonnet-5')).toBe(true);
    expect(isSupportedModel('qwen/qwen3.7-max')).toBe(true);
    expect(isSupportedModel('openai/gpt-5.4')).toBe(true);
    expect(isSupportedModel('alibaba/qwen3.6-plus')).toBe(false);
    expect(isSupportedModel('openai/gpt-5.4-mini')).toBe(false);
    expect(isSupportedModel('openai/gpt-5.3-codex')).toBe(false);
    expect(isSupportedModel('xai/grok-4.1-fast-reasoning')).toBe(false);
  });

  it('supports DeepSeek V4 Pro and aliases retired Flash to MiniMax M3', () => {
    expect(isSupportedModel('deepseek/deepseek-v4-pro')).toBe(true);
    expect(isSupportedModel('deepseek/deepseek-v4-flash')).toBe(true);
    expect(resolveSupportedModel('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
    expect(resolveSupportedModel('deepseek/deepseek-v4-flash')).toBe('minimax/minimax-m3');
    expect(resolveConfiguredModel('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
    expect(resolveConfiguredModel('deepseek/deepseek-v4-flash')).toBe('minimax/minimax-m3');
  });

  it('does not support removed model ids', () => {
    const removedModelIds = [
      'provider/model-removed',
      'vendor/deprecated-fast',
      'legacy/model-x',
      'deepseek/deepseek-v3.2-thinking',
      'anthropic/claude-haiku-4.5',
      'google/gemma-4-31b-it',
    ];

    for (const modelId of removedModelIds) {
      expect(SUPPORTED_MODELS).not.toContain(modelId);
      expect(isSupportedModel(modelId)).toBe(false);
      expect(resolveSupportedModel(modelId)).toBe(DEFAULT_MODEL);
      expect(resolveSupportedModel(modelId, modelId)).toBe(DEFAULT_MODEL);
    }
  });

  it('resolves AI_MODEL with the default model as the fallback', () => {
    expect(resolveConfiguredModel('minimax/minimax-m3')).toBe('minimax/minimax-m3');
    expect(resolveConfiguredModel('  minimax/minimax-m3  ')).toBe('minimax/minimax-m3');
    expect(resolveConfiguredModel('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(resolveConfiguredModel('qwen/qwen3.7-max')).toBe('qwen/qwen3.7-max');
    expect(resolveConfiguredModel('openai/gpt-5.4')).toBe('openai/gpt-5.4');
    vi.stubEnv('AI_MODEL', 'minimax/minimax-m3');
    expect(resolveConfiguredModel()).toBe('minimax/minimax-m3');
    expect(resolveConfiguredModel('deepseek/deepseek-v3.2-thinking')).toBe(DEFAULT_MODEL);
    expect(resolveConfiguredModel('')).toBe(DEFAULT_MODEL);
    vi.stubEnv('AI_MODEL', '');
    expect(resolveConfiguredModel()).toBe(DEFAULT_MODEL);
  });
});
