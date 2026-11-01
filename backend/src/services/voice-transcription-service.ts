import pathPosix from 'node:path/posix';
import { toFile } from 'openai';
import { SESSION_ATTACHMENT_MAX_BYTES } from './session-attachments.js';
import { getOpenAIClient, resolveOpenAIApiKey } from './openai-client.js';
import { getOptionalErrorMessage } from '../utils/error-message.js';

export interface TranscriptionUsageTokens {
  type: 'tokens';
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  input_token_details?: {
    audio_tokens?: number;
    text_tokens?: number;
  };
}

export interface TranscriptionUsageDuration {
  type: 'duration';
  seconds: number;
}

export interface TranscriptionUsageCost {
  type: 'cost';
  cost_usd: number;
  seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export type VoiceTranscriptionUsage =
  | TranscriptionUsageTokens
  | TranscriptionUsageDuration
  | TranscriptionUsageCost
  | null
  | undefined;

const OPENROUTER_TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const DEFAULT_OPENROUTER_VOICE_TRANSCRIPTION_MODEL = 'openai/whisper-large-v3';
const DEFAULT_OPENAI_VOICE_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

const OPENROUTER_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const OPENROUTER_RETRY_MAX_ATTEMPTS = 3;
const OPENROUTER_RETRY_BASE_DELAY_MS = 500;
const OPENROUTER_RETRY_MAX_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryAtMs = Date.parse(trimmed);
  if (Number.isFinite(retryAtMs)) {
    return Math.max(0, retryAtMs - Date.now());
  }

  return undefined;
}

export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = (
  process.env.VOICE_TRANSCRIPTION_MODEL?.trim()
  || DEFAULT_OPENROUTER_VOICE_TRANSCRIPTION_MODEL
);

type VoiceTranscriptionProvider = 'openrouter' | 'openai';

type VoiceTranscriptionErrorCode =
  | 'invalid_audio'
  | 'not_configured'
  | 'upstream_error';

export class VoiceTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: VoiceTranscriptionErrorCode,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

export interface VoiceTranscriptionResult {
  text: string;
  model: string;
  usage: VoiceTranscriptionUsage;
}

export interface VoiceTranscriptionServiceDeps {
  apiKey?: string;
  model?: string;
  provider?: VoiceTranscriptionProvider;
}

export interface VoiceTranscriptionRequest {
  userId: string;
  audio: Buffer;
  contentType: string;
  fileName: string;
  sessionId?: string;
}

const TRANSCRIPTION_FILE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/aac': '.aac',
  'audio/aiff': '.aiff',
  'audio/flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mpga': '.mpga',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/x-wav': '.wav',
};

const OPENROUTER_AUDIO_FORMAT_BY_EXTENSION: Record<string, string> = {
  '.aac': 'aac',
  '.aiff': 'aiff',
  '.flac': 'flac',
  '.m4a': 'm4a',
  '.mp3': 'mp3',
  '.mpga': 'mp3',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.wav': 'wav',
  '.webm': 'webm',
};

function resolveVoiceTranscriptionProvider(
  configuredProvider: string | undefined,
  model: string,
): VoiceTranscriptionProvider {
  const provider = configuredProvider?.trim().toLowerCase();
  if (provider === 'openrouter' || provider === 'openai') {
    return provider;
  }

  if (provider) {
    console.warn(
      `[voice-transcription] Unsupported VOICE_TRANSCRIPTION_PROVIDER=${provider}; inferring provider from model.`,
    );
  }

  return model.includes('/') ? 'openrouter' : 'openai';
}

function resolveOpenRouterApiKey(configuredApiKey?: string): string | null {
  const apiKey = configuredApiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  return apiKey || null;
}

function resolveTranscriptionUploadFileName(fileName: string, contentType: string): string {
  const trimmedFileName = fileName.trim();
  const baseName = pathPosix.basename(trimmedFileName) || 'recording';
  const extension = pathPosix.extname(baseName).toLowerCase();
  if (extension === '.oga') {
    const stem = baseName.slice(0, -extension.length) || 'recording';
    return `${stem}.ogg`;
  }

  if (extension) {
    return baseName;
  }

  const preferredExtension = TRANSCRIPTION_FILE_EXTENSION_BY_CONTENT_TYPE[contentType];
  return preferredExtension ? `${baseName}${preferredExtension}` : baseName;
}

function resolveOpenRouterAudioFormat(fileName: string, contentType: string): string {
  const uploadFileName = resolveTranscriptionUploadFileName(fileName, contentType);
  const extension = pathPosix.extname(uploadFileName).toLowerCase();
  const extensionFormat = OPENROUTER_AUDIO_FORMAT_BY_EXTENSION[extension];
  if (extensionFormat) {
    return extensionFormat;
  }

  const contentTypeExtension = TRANSCRIPTION_FILE_EXTENSION_BY_CONTENT_TYPE[contentType];
  if (contentTypeExtension) {
    return OPENROUTER_AUDIO_FORMAT_BY_EXTENSION[contentTypeExtension] ?? contentTypeExtension.slice(1);
  }

  return contentType.replace(/^audio\//, '').split(/[;.+-]/, 1)[0] || 'webm';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapOpenRouterTranscriptionUsage(usage: unknown): VoiceTranscriptionUsage {
  if (!isRecord(usage)) {
    return undefined;
  }

  const costUsd = getFiniteNumber(usage.cost);
  if (costUsd !== undefined) {
    return {
      type: 'cost',
      cost_usd: costUsd,
      seconds: getFiniteNumber(usage.seconds),
      input_tokens: getFiniteNumber(usage.input_tokens),
      output_tokens: getFiniteNumber(usage.output_tokens),
      total_tokens: getFiniteNumber(usage.total_tokens),
    };
  }

  const inputTokens = getFiniteNumber(usage.input_tokens);
  const outputTokens = getFiniteNumber(usage.output_tokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    return {
      type: 'tokens',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: getFiniteNumber(usage.total_tokens),
    };
  }

  const seconds = getFiniteNumber(usage.seconds);
  return seconds === undefined ? undefined : { type: 'duration', seconds };
}

async function parseOpenRouterResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function resolveOpenRouterRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  const exponentialDelayMs = Math.min(
    OPENROUTER_RETRY_MAX_DELAY_MS,
    OPENROUTER_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
  );
  return Math.min(OPENROUTER_RETRY_MAX_DELAY_MS, retryAfterMs ?? exponentialDelayMs);
}

async function transcribeWithOpenRouter(args: {
  apiKey: string;
  audio: Buffer;
  contentType: string;
  fileName: string;
  model: string;
}): Promise<{ text: string; usage: VoiceTranscriptionUsage }> {
  const requestBody = JSON.stringify({
    model: args.model,
    input_audio: {
      data: args.audio.toString('base64'),
      format: resolveOpenRouterAudioFormat(args.fileName, args.contentType),
    },
  });

  for (let attempt = 1; attempt <= OPENROUTER_RETRY_MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt >= OPENROUTER_RETRY_MAX_ATTEMPTS;

    let response: Response;
    try {
      response = await fetch(OPENROUTER_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
      });
    } catch (error) {
      // Network errors are transient; retry until attempts are exhausted.
      if (isLastAttempt) {
        throw new VoiceTranscriptionError(
          `OpenRouter transcription request failed: ${getOptionalErrorMessage(error) ?? 'network error'}`,
          'upstream_error',
          502,
        );
      }
      await sleep(resolveOpenRouterRetryDelayMs(attempt, undefined));
      continue;
    }

    const payload = await parseOpenRouterResponse(response);

    if (!response.ok) {
      const message = getOptionalErrorMessage(payload) ?? `${response.status} ${response.statusText}`.trim();
      if (!isLastAttempt && OPENROUTER_RETRYABLE_STATUS_CODES.has(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs = resolveOpenRouterRetryDelayMs(attempt, retryAfterMs);
        console.warn(
          `[voice-transcription] OpenRouter request failed on attempt ${attempt}/${OPENROUTER_RETRY_MAX_ATTEMPTS} `
          + `(${response.status}); retrying in ${delayMs}ms: ${message}`,
        );
        await sleep(delayMs);
        continue;
      }

      throw new VoiceTranscriptionError(
        `OpenRouter transcription request failed: ${message}`,
        'upstream_error',
        502,
      );
    }

    const text = isRecord(payload) && typeof payload.text === 'string' ? payload.text.trim() : '';
    const usage = isRecord(payload) ? mapOpenRouterTranscriptionUsage(payload.usage) : undefined;
    return { text, usage };
  }

  // Unreachable: the loop either returns a result or throws on the final attempt.
  throw new VoiceTranscriptionError(
    'OpenRouter transcription request failed: retries exhausted',
    'upstream_error',
    502,
  );
}

export class VoiceTranscriptionService {
  private readonly configuredApiKey?: string;
  private readonly model: string;
  private readonly provider: VoiceTranscriptionProvider;

  constructor(private readonly deps: VoiceTranscriptionServiceDeps) {
    this.configuredApiKey = deps.apiKey?.trim() || undefined;
    const configuredModel = deps.model?.trim() || process.env.VOICE_TRANSCRIPTION_MODEL?.trim();
    this.provider = resolveVoiceTranscriptionProvider(
      deps.provider ?? process.env.VOICE_TRANSCRIPTION_PROVIDER,
      configuredModel || DEFAULT_VOICE_TRANSCRIPTION_MODEL,
    );
    this.model = configuredModel || (
      this.provider === 'openai'
        ? DEFAULT_OPENAI_VOICE_TRANSCRIPTION_MODEL
        : DEFAULT_OPENROUTER_VOICE_TRANSCRIPTION_MODEL
    );
  }

  getAvailabilityError(): string | null {
    return this.getApiKey()
      ? null
      : `Voice transcription is unavailable because the server ${this.getApiKeyDisplayName()} is not configured.`;
  }

  async transcribe(args: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    if (args.audio.byteLength <= 0) {
      throw new VoiceTranscriptionError('Audio body is required.', 'invalid_audio', 400);
    }

    if (args.audio.byteLength > SESSION_ATTACHMENT_MAX_BYTES) {
      throw new VoiceTranscriptionError(
        `Audio recordings larger than ${SESSION_ATTACHMENT_MAX_BYTES} bytes are not supported.`,
        'invalid_audio',
        400,
      );
    }

    const contentType = args.contentType.trim().toLowerCase();
    if (!contentType.startsWith('audio/')) {
      throw new VoiceTranscriptionError(
        'Voice transcription expects an audio recording.',
        'invalid_audio',
        400,
      );
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new VoiceTranscriptionError(
        `Voice transcription is unavailable because the server ${this.getApiKeyDisplayName()} is not configured.`,
        'not_configured',
        503,
      );
    }

    const { text, usage } = this.provider === 'openrouter'
      ? await transcribeWithOpenRouter({
        apiKey,
        audio: args.audio,
        contentType,
        fileName: args.fileName,
        model: this.model,
      })
      : await this.transcribeWithOpenAI(apiKey, args.audio, contentType, args.fileName);

    return {
      text,
      model: this.model,
      usage,
    };
  }

  private getApiKey(): string | null {
    return this.provider === 'openrouter'
      ? resolveOpenRouterApiKey(this.configuredApiKey)
      : resolveOpenAIApiKey(this.configuredApiKey);
  }

  private getApiKeyDisplayName(): string {
    return this.provider === 'openrouter' ? 'OpenRouter API key' : 'OpenAI API key';
  }

  private async transcribeWithOpenAI(
    apiKey: string,
    audio: Buffer,
    contentType: string,
    fileName: string,
  ): Promise<{ text: string; usage: VoiceTranscriptionUsage }> {
    const openai = getOpenAIClient(apiKey);
    const file = await toFile(
      audio,
      resolveTranscriptionUploadFileName(fileName, contentType),
      { type: contentType },
    );
    const transcript = await openai.audio.transcriptions.create({
      file,
      model: this.model || DEFAULT_OPENAI_VOICE_TRANSCRIPTION_MODEL,
    });
    return {
      text: typeof transcript.text === 'string' ? transcript.text.trim() : '',
      usage: transcript.usage as VoiceTranscriptionUsage,
    };
  }
}
