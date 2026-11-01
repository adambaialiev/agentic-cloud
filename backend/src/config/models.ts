export const DEFAULT_MODEL = 'minimax/minimax-m3';

export const SUPPORTED_MODELS = [
  'minimax/minimax-m3',
  'deepseek/deepseek-v4-pro',
  'anthropic/claude-sonnet-5',
  'qwen/qwen3.7-max',
  'openai/gpt-5.4',
] as const;

// Retired models resolve to MiniMax M3 so sessions saved before the
// provider migration keep working.
const MODEL_ALIASES: Record<string, typeof SUPPORTED_MODELS[number]> = {
  'deepseek/deepseek-v4-flash': 'minimax/minimax-m3',
};

const SUPPORTED_MODEL_IDS = new Set<string>(SUPPORTED_MODELS);

function resolveFallbackModel(fallbackModel: string): typeof SUPPORTED_MODELS[number] {
  const trimmedFallback = fallbackModel.trim();
  const canonicalFallback = MODEL_ALIASES[trimmedFallback] ?? trimmedFallback;
  return SUPPORTED_MODEL_IDS.has(canonicalFallback)
    ? canonicalFallback as typeof SUPPORTED_MODELS[number]
    : DEFAULT_MODEL;
}

export function isSupportedModel(model: unknown): model is typeof SUPPORTED_MODELS[number] {
  if (typeof model !== 'string') return false;

  const trimmedModel = model.trim();
  if (!trimmedModel) return false;

  const canonicalModel = MODEL_ALIASES[trimmedModel] ?? trimmedModel;
  return SUPPORTED_MODEL_IDS.has(canonicalModel);
}

export function resolveSupportedModel(
  rawModel: string | null | undefined,
  fallbackModel = DEFAULT_MODEL,
): string {
  const supportedFallbackModel = resolveFallbackModel(fallbackModel);

  if (typeof rawModel !== 'string') {
    return supportedFallbackModel;
  }

  const trimmedModel = rawModel.trim();
  if (!trimmedModel) {
    return supportedFallbackModel;
  }

  const canonicalModel = MODEL_ALIASES[trimmedModel] ?? trimmedModel;
  return SUPPORTED_MODEL_IDS.has(canonicalModel) ? canonicalModel : supportedFallbackModel;
}

export function resolveConfiguredModel(rawModel = process.env.AI_MODEL): string {
  if (typeof rawModel !== 'string') {
    return DEFAULT_MODEL;
  }

  const configuredModel = rawModel.trim();
  if (!configuredModel) {
    return DEFAULT_MODEL;
  }

  const canonicalModel = MODEL_ALIASES[configuredModel] ?? configuredModel;
  return SUPPORTED_MODEL_IDS.has(canonicalModel) ? canonicalModel : DEFAULT_MODEL;
}

