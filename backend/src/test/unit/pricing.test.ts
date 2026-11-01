import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateCostCents,
  getContextWindow,
  getModelPricingAdjustment,
} from '../../config/pricing.js';

describe('pricing config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns DeepSeek V4 Pro context window and pricing-derived cost', () => {
    expect(getContextWindow('deepseek/deepseek-v4-pro')).toBe(1_000_000);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 1_000_000, 1_000_000)).toBe(131);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 1_000_000, 0, {
      cachedInputTokens: 1_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    })).toBe(1);
  });

  it('returns DeepSeek V4 Flash context window and pricing-derived cost', () => {
    expect(getContextWindow('deepseek/deepseek-v4-flash')).toBe(1_000_000);
    expect(calculateCostCents('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000)).toBe(43);
    expect(calculateCostCents('deepseek/deepseek-v4-flash', 1_000_000, 0, {
      cachedInputTokens: 1_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    })).toBe(1);
  });

  it('uses the cached-input rate for deepseek models when cache-read tokens are provided', () => {
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 1_000_000, 0, {
      cachedInputTokens: 1_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    })).toBe(1);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    })).toBe(37);
  });

  it('applies Anthropic cache read/write discounts for Sonnet 5', () => {
    // Full-rate input+output: 1M in @ $2 + 1M out @ $10 = $12.00
    expect(calculateCostCents('anthropic/claude-sonnet-5', 1_000_000, 1_000_000)).toBe(1200);
    // Cache reads bill at 0.1x input ($0.20/M), not the full input rate.
    expect(calculateCostCents('anthropic/claude-sonnet-5', 1_000_000, 0, {
      cachedInputTokens: 1_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    })).toBe(20);
    // 5-minute cache writes bill at 1.25x input ($2.50/M).
    expect(calculateCostCents('anthropic/claude-sonnet-5', 1_000_000, 0, {
      cachedInputTokens: 0,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 1_000_000,
    })).toBe(250);
  });

  it('applies DeepSeek peak pricing only after the configured effective date and inside UTC peak windows', () => {
    vi.stubEnv('DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT', '2026-07-15T00:00:00.000Z');

    expect(getModelPricingAdjustment(
      'deepseek/deepseek-v4-pro',
      '2026-07-15T01:30:00.000Z',
    )).toEqual({
      multiplier: 2,
      rule: 'deepseek_peak_utc',
    });
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }, { pricedAt: '2026-07-15T01:30:00.000Z' })).toBe(73);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }, { pricedAt: '2026-07-15T06:00:00.000Z' })).toBe(73);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }, { pricedAt: '2026-07-15T04:00:00.000Z' })).toBe(37);
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }, { pricedAt: '2026-07-14T01:30:00.000Z' })).toBe(37);
  });

  it('does not apply DeepSeek peak pricing when no effective date is configured', () => {
    expect(getModelPricingAdjustment(
      'deepseek/deepseek-v4-pro',
      '2026-07-15T01:30:00.000Z',
    )).toEqual({ multiplier: 1 });
    expect(calculateCostCents('deepseek/deepseek-v4-pro', 100_000_000, 0, {
      cachedInputTokens: 100_000_000,
      nonCachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }, { pricedAt: '2026-07-15T01:30:00.000Z' })).toBe(37);
  });

  it('returns GPT-5.4 context window and pricing-derived cost', () => {
    expect(getContextWindow('openai/gpt-5.4')).toBe(1_000_000);
    expect(calculateCostCents('openai/gpt-5.4', 1_000_000, 1_000_000)).toBe(1125);
  });

  it('returns Claude Sonnet 5 fallback context window and pricing-derived cost', () => {
    expect(getContextWindow('anthropic/claude-sonnet-5')).toBe(1_000_000);
    expect(calculateCostCents('anthropic/claude-sonnet-5', 1_000_000, 1_000_000)).toBe(1200);
  });

  it('returns null context and zero cost for removed model ids', () => {
    const removedModelIds = [
      'provider/model-removed',
      'vendor/deprecated-fast',
      'legacy/model-x',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-v3.2-thinking',
      'anthropic/claude-haiku-4.5',
      'google/gemma-4-31b-it',
      'xai/grok-4.20-reasoning',
    ];

    for (const modelId of removedModelIds) {
      expect(getContextWindow(modelId)).toBeNull();
      expect(calculateCostCents(modelId, 1_000_000, 1_000_000)).toBe(0);
    }
  });
});
