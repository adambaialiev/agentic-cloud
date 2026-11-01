export interface ModelPricing {
  inputPerMillion: number;  // USD
  cachedInputPerMillion?: number; // USD, cache-read
  cacheWriteInputPerMillion?: number; // USD
  outputPerMillion: number; // USD
  contextWindow?: number;   // max input tokens
}

export interface ModelPricingAdjustment {
  multiplier: number;
  rule?: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'minimax/minimax-m3': {
    // MiniMax priority service tier (1.5x standard, matching the service_tier
    // sent in buildMiniMaxExtraBody) for requests up to 512K input tokens;
    // above that MiniMax bills 2x, which we do not model yet.
    inputPerMillion: 0.45,
    cachedInputPerMillion: 0.09,
    outputPerMillion: 1.80,
    contextWindow: 1_000_000,
  },
  // Retired models kept so historical usage rows still price correctly.
  'deepseek/deepseek-v4-pro': {
    inputPerMillion: 0.435,
    cachedInputPerMillion: 0.003625,
    outputPerMillion: 0.87,
    contextWindow: 1_000_000,
  },
  'deepseek/deepseek-v4-flash': {
    inputPerMillion: 0.14,
    cachedInputPerMillion: 0.0028,
    outputPerMillion: 0.28,
    contextWindow: 1_000_000,
  },
  'anthropic/claude-sonnet-5': {
    inputPerMillion: 2,
    // Anthropic prompt caching: reads are 0.1x the base input rate and 5-minute
    // cache writes are 1.25x (we use the default 5m TTL). Keep these in sync
    // with inputPerMillion.
    cachedInputPerMillion: 0.2,
    cacheWriteInputPerMillion: 2.5,
    outputPerMillion: 10,
    contextWindow: 1_000_000,
  },
  'qwen/qwen3.7-max': {
    inputPerMillion: 1.25,
    outputPerMillion: 3.75,
    contextWindow: 1_000_000,
  },
  'openai/gpt-5.4': {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    contextWindow: 1_000_000,
  },
};

export function getContextWindow(model: string): number | null {
  return MODEL_PRICING[model]?.contextWindow ?? null;
}

export interface TokenCostInputBreakdown {
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  nonCachedInputTokens?: number;
}

export interface TokenCostCalculationOptions {
  pricedAt?: Date | string | number;
}

const DEEPSEEK_PEAK_PRICING_RULE = 'deepseek_peak_utc';
const DEEPSEEK_PEAK_PRICING_MULTIPLIER = 2;
const DEEPSEEK_PEAK_PRICING_WINDOWS_UTC = [
  { startMinute: 1 * 60, endMinute: 4 * 60 },
  { startMinute: 6 * 60, endMinute: 10 * 60 },
];

function resolveTimestampMs(value: Date | string | number | undefined): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    return Date.parse(value);
  }

  return Date.now();
}

function resolveDeepSeekPeakPricingEffectiveAtMs(): number | null {
  const rawValue = process.env.DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT?.trim();
  if (!rawValue) {
    return null;
  }

  const effectiveAtMs = Date.parse(rawValue);
  return Number.isFinite(effectiveAtMs) ? effectiveAtMs : null;
}

function isDeepSeekPeakPricingWindow(date: Date): boolean {
  const utcMinuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  return DEEPSEEK_PEAK_PRICING_WINDOWS_UTC.some((window) => (
    utcMinuteOfDay >= window.startMinute
    && utcMinuteOfDay < window.endMinute
  ));
}

export function getModelPricingAdjustment(
  model: string,
  pricedAt: Date | string | number = Date.now(),
): ModelPricingAdjustment {
  if (!model.trim().startsWith('deepseek/')) {
    return { multiplier: 1 };
  }

  const pricedAtMs = resolveTimestampMs(pricedAt);
  const effectiveAtMs = resolveDeepSeekPeakPricingEffectiveAtMs();
  if (!Number.isFinite(pricedAtMs) || effectiveAtMs == null || pricedAtMs < effectiveAtMs) {
    return { multiplier: 1 };
  }

  const pricedAtDate = new Date(pricedAtMs);
  if (!isDeepSeekPeakPricingWindow(pricedAtDate)) {
    return { multiplier: 1 };
  }

  return {
    multiplier: DEEPSEEK_PEAK_PRICING_MULTIPLIER,
    rule: DEEPSEEK_PEAK_PRICING_RULE,
  };
}

/**
 * Calculate cost in cents for a given model and token usage.
 * Returns integer cents (rounded up).
 */
export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  breakdown?: TokenCostInputBreakdown,
  options: TokenCostCalculationOptions = {},
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Unknown model — charge nothing rather than crash
    console.warn(`[pricing] Unknown model: ${model}, charging $0`);
    return 0;
  }

  const inputRateCentsPerMillion = pricing.inputPerMillion * 100;
  const cachedInputRateCentsPerMillion = (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) * 100;
  const cacheWriteInputRateCentsPerMillion = (pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion) * 100;
  const outputRateCentsPerMillion = pricing.outputPerMillion * 100;
  const hasDetailedBreakdown = (
    breakdown?.cachedInputTokens != null
    || breakdown?.cacheWriteInputTokens != null
    || breakdown?.nonCachedInputTokens != null
  );
  const cachedInputTokens = Math.max(0, breakdown?.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = Math.max(0, breakdown?.cacheWriteInputTokens ?? 0);
  let standardRateInputTokens = inputTokens;

  if (hasDetailedBreakdown) {
    standardRateInputTokens = Math.max(
      0,
      breakdown?.nonCachedInputTokens ?? 0,
    );
    const detailedTotal = standardRateInputTokens + cachedInputTokens + cacheWriteInputTokens;
    if (inputTokens > detailedTotal) {
      standardRateInputTokens += inputTokens - detailedTotal;
    }
  }

  const inputCostCents = (standardRateInputTokens * inputRateCentsPerMillion) / 1_000_000;
  const cachedInputCostCents = (cachedInputTokens * cachedInputRateCentsPerMillion) / 1_000_000;
  const cacheWriteInputCostCents = (cacheWriteInputTokens * cacheWriteInputRateCentsPerMillion) / 1_000_000;
  const outputCostCents = (outputTokens * outputRateCentsPerMillion) / 1_000_000;
  const totalCostCents = inputCostCents + cachedInputCostCents + cacheWriteInputCostCents + outputCostCents;
  const pricingAdjustment = getModelPricingAdjustment(model, options.pricedAt);

  return Math.ceil(totalCostCents * pricingAdjustment.multiplier);
}
