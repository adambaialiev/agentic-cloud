import pathPosix from 'node:path/posix';
import { SESSION_ATTACHMENT_MAX_BYTES } from './session-attachments.js';
import { getOptionalErrorMessage } from '../utils/error-message.js';
import type { VoicePauseReason } from '../shared/voice.js';
import type { VoiceTranscriber, VoiceTranscriberResult } from './workplace-voice.js';

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

type VoiceTranscriptionErrorCode =
  | 'invalid_audio'
  /** The account behind the workplace's key has no credit left (OpenRouter
   *  402). Configuration, not a passing fault (note #1023). */
  | 'out_of_credit'
  /** The provider refused the key itself (401). Configuration too. */
  | 'key_rejected'
  | 'upstream_error';

export class VoiceTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: VoiceTranscriptionErrorCode,
    readonly statusCode: number,
    /** What the provider answered, when it answered at all: kept for the log
     *  line, never shown to the person recording. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

/** The code a provider's HTTP refusal means for us. 402 and 401 are not worth
 *  a retry and not worth a second recording either. */
function classifyUpstreamStatus(status: number | undefined): VoiceTranscriptionErrorCode {
  if (status === 402) return 'out_of_credit';
  if (status === 401) return 'key_rejected';
  return 'upstream_error';
}

/** A provider's message with anything key-shaped taken out: nothing of a
 *  key belongs in the journal, masked or not. */
export function redactProviderMessage(message: string, apiKey?: string | null): string {
  let clean = message;
  if (apiKey && apiKey.length >= 8) clean = clean.split(apiKey).join('[key]');
  return clean
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_*.-]{4,}/g, '[key]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** What pauses a workplace's voice-to-text (note #1026): a failure no
 *  retry and no second recording can fix. Anything else is a passing fault. */
export function voicePauseReasonFor(error: unknown): VoicePauseReason | null {
  if (!(error instanceof VoiceTranscriptionError)) return null;
  return error.code === 'out_of_credit' ? 'out_of_credit' : error.code === 'key_rejected' ? 'key_rejected' : null;
}

/** One recording, on the workplace's own key and model (note #1026). */
export interface VoiceTranscriptionRequest {
  apiKey: string;
  model: string;
  audio: Buffer;
  contentType: string;
  fileName: string;
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

      const code = classifyUpstreamStatus(response.status);
      throw new VoiceTranscriptionError(
        `OpenRouter transcription request failed: ${message}`,
        code,
        code === 'upstream_error' ? 502 : 503,
        response.status,
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

/**
 * Turns one recording into words through OpenRouter, the only provider
 * (Adam, note #1026 point 6). It holds no key and no model: the workplace's
 * own come with every request (`WorkplaceVoiceService`), so nothing here
 * reads the process environment and no platform account pays for voice.
 */
export class VoiceTranscriptionService implements VoiceTranscriber {
  async transcribe(args: VoiceTranscriptionRequest): Promise<VoiceTranscriberResult> {
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

    let transcript: { text: string; usage: VoiceTranscriptionUsage };
    try {
      transcript = await transcribeWithOpenRouter({
        apiKey: args.apiKey,
        audio: args.audio,
        contentType,
        fileName: args.fileName,
        model: args.model,
      });
    } catch (error) {
      const failure = error instanceof VoiceTranscriptionError
        ? error
        : new VoiceTranscriptionError(
          `OpenRouter transcription request failed: ${getOptionalErrorMessage(error) ?? 'unknown error'}`,
          'upstream_error',
          502,
        );
      // One line per failed recording, whatever the provider said (note
      // #1023): before this the route folded every refusal into a bare 502
      // and the journal stayed silent while every recording failed.
      console.warn(
        `[voice-transcription] transcription failed: provider=openrouter model=${args.model} `
        + `upstream=${failure.upstreamStatus ?? 'no answer'} code=${failure.code} `
        + `message=${JSON.stringify(redactProviderMessage(failure.message, args.apiKey))}`,
      );
      throw failure;
    }

    const usage = transcript.usage;
    return {
      text: transcript.text,
      ...(usage?.type === 'cost' ? { costUsd: usage.cost_usd } : {}),
      ...(usage?.type === 'cost' && usage.seconds !== undefined ? { seconds: usage.seconds } : {}),
      ...(usage?.type === 'duration' ? { seconds: usage.seconds } : {}),
    };
  }
}
