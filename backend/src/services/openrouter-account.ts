/**
 * The three questions voice-to-text asks OpenRouter besides transcribing
 * (note #1026): is this key good, how much credit does the account behind it
 * have left, and which transcription models exist at what price. All three
 * are free calls. None of them ever logs or returns the key.
 */

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 10_000;

export type OpenRouterKeyCheck = 'ok' | 'rejected';

/** OpenRouter could not be asked (network, timeout, 5xx): say so, do not guess. */
export class OpenRouterUnavailableError extends Error {
  constructor(what: string, readonly status?: number) {
    super(`OpenRouter did not answer ${what}${status ? ` (${status})` : ''}`);
    this.name = 'OpenRouterUnavailableError';
  }
}

export interface OpenRouterTranscriptionModel {
  id: string;
  /** USD per unit as OpenRouter lists it: per second of audio for most
   *  transcription models, per token for the GPT-4o family and Gemini. */
  prompt: number;
  completion: number;
}

export interface OpenRouterAccount {
  checkKey(apiKey: string): Promise<OpenRouterKeyCheck>;
  /** USD left on the account behind the key (and under the key's own limit
   *  when it has one), or null when OpenRouter did not say. */
  creditLeft(apiKey: string): Promise<number | null>;
  transcriptionModels(): Promise<OpenRouterTranscriptionModel[]>;
}

type Fetch = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

export class OpenRouterAccountClient implements OpenRouterAccount {
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  private async get(path: string, what: string, apiKey?: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${OPENROUTER_API}${path}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new OpenRouterUnavailableError(what);
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { status: response.status, body };
  }

  async checkKey(apiKey: string): Promise<OpenRouterKeyCheck> {
    const { status } = await this.get('/key', 'the key check', apiKey);
    // A key OpenRouter does not know answers 401 ("User not found."); a
    // disabled one 403. Either way this key cannot pay for anything.
    if (status === 401 || status === 403) return 'rejected';
    if (status !== 200) throw new OpenRouterUnavailableError('the key check', status);
    return 'ok';
  }

  async creditLeft(apiKey: string): Promise<number | null> {
    const [credits, key] = await Promise.all([
      this.get('/credits', 'the credit check', apiKey).catch(() => null),
      this.get('/key', 'the key check', apiKey).catch(() => null),
    ]);
    const data = isRecord(credits?.body) && isRecord(credits.body.data) ? credits.body.data : null;
    const total = num(data?.total_credits);
    const used = num(data?.total_usage);
    const account = credits?.status === 200 && total !== undefined && used !== undefined ? Math.max(0, total - used) : null;
    const keyData = isRecord(key?.body) && isRecord(key.body.data) ? key.body.data : null;
    const keyLeft = key?.status === 200 ? num(keyData?.limit_remaining) : undefined;
    if (account === null) return keyLeft ?? null;
    return keyLeft === undefined ? account : Math.min(account, Math.max(0, keyLeft));
  }

  async transcriptionModels(): Promise<OpenRouterTranscriptionModel[]> {
    const { status, body } = await this.get('/models?output_modalities=transcription', 'the model list');
    if (status !== 200 || !isRecord(body) || !Array.isArray(body.data)) {
      throw new OpenRouterUnavailableError('the model list', status);
    }
    const models: OpenRouterTranscriptionModel[] = [];
    for (const entry of body.data) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue;
      const pricing = isRecord(entry.pricing) ? entry.pricing : {};
      models.push({ id: entry.id, prompt: num(pricing.prompt) ?? 0, completion: num(pricing.completion) ?? 0 });
    }
    return models;
  }
}
