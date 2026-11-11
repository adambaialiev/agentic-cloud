import { getOptionalErrorMessage } from '../utils/error-message.js';
import { redactProviderMessage, VoiceTranscriptionError } from './voice-transcription-service.js';
import type { VoiceSpeaker, VoiceSpeakArgs, VoiceSpeakerResult } from './workplace-voice.js';

/**
 * Text to speech through OpenRouter (note #1146): the Chief of Staff's recap,
 * read aloud on the workplace's own key. It holds no key and no model: both
 * come with every request from `WorkplaceVoiceService`, like dictation's.
 *
 * Failures are dictation's `VoiceTranscriptionError`, on purpose: the same
 * key and the same account, so a 402 or a 401 here pauses the workplace's
 * voice exactly as a recording's would (`voicePauseReasonFor`).
 */

export const OPENROUTER_SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS = 2;
const TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class VoiceSpeechService implements VoiceSpeaker {
  constructor(private readonly doFetch: typeof fetch = (input, init) => fetch(input, init), private readonly retryDelayMs = 600) {}

  async speak(args: VoiceSpeakArgs): Promise<VoiceSpeakerResult> {
    const body = JSON.stringify({ model: args.model, voice: args.voice, input: args.text, response_format: args.format });
    let failure: VoiceTranscriptionError | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const last = attempt >= ATTEMPTS;
      let response: Response;
      try {
        response = await this.doFetch(OPENROUTER_SPEECH_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        failure = new VoiceTranscriptionError(`OpenRouter speech request failed: ${getOptionalErrorMessage(error) ?? 'network error'}`, 'upstream_error', 502);
        if (last) break;
        await sleep(this.retryDelayMs);
        continue;
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
      if (response.ok && contentType.startsWith('audio/')) {
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.byteLength > 0) return { audio, contentType };
        failure = new VoiceTranscriptionError('OpenRouter speech request failed: empty audio', 'upstream_error', 502, response.status);
        break;
      }
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const payload = await response.json() as { error?: { message?: unknown } };
        if (typeof payload?.error?.message === 'string') message = payload.error.message;
      } catch { /* not JSON */ }
      if (response.ok) {
        failure = new VoiceTranscriptionError(`OpenRouter speech request failed: answered ${contentType || 'nothing'}, not audio`, 'upstream_error', 502, response.status);
        break;
      }
      const code = response.status === 402 ? 'out_of_credit' : response.status === 401 ? 'key_rejected' : 'upstream_error';
      failure = new VoiceTranscriptionError(`OpenRouter speech request failed: ${message}`, code, code === 'upstream_error' ? 502 : 503, response.status);
      if (last || code !== 'upstream_error' || !RETRYABLE.has(response.status)) break;
      await sleep(this.retryDelayMs);
    }
    const error = failure ?? new VoiceTranscriptionError('OpenRouter speech request failed', 'upstream_error', 502);
    // One line per failed recap, as dictation writes one per failed recording
    // (note #1023). Never the key, never the words.
    console.warn(
      `[voice-speech] speech failed: provider=openrouter model=${args.model} voice=${args.voice} `
      + `upstream=${error.upstreamStatus ?? 'no answer'} code=${error.code} `
      + `message=${JSON.stringify(redactProviderMessage(error.message, args.apiKey))}`,
    );
    throw error;
  }
}
