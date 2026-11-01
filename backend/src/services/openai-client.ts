import OpenAI from 'openai';

const clientsByApiKey = new Map<string, OpenAI>();

export function resolveOpenAIApiKey(configuredApiKey?: string): string | null {
  const apiKey = configuredApiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  return apiKey || null;
}

export function getOpenAIClient(configuredApiKey?: string): OpenAI {
  const apiKey = resolveOpenAIApiKey(configuredApiKey);
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const cachedClient = clientsByApiKey.get(apiKey);
  if (cachedClient) {
    return cachedClient;
  }

  const client = new OpenAI({ apiKey });
  clientsByApiKey.set(apiKey, client);
  return client;
}
