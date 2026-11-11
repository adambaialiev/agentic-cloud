/**
 * Voice-to-text, per workplace (notes #1024 design, #1026 build; Adam,
 * 6 Nov 2026). Every workplace brings its own OpenRouter key: there is no
 * platform key behind it and no free minutes, on agenticcloudcomputer.com
 * and in an own cloud alike. An admin saves the key and picks the model on
 * the Workplace screen; agents can do neither.
 *
 * Shared by the backend (routes, service) and the Workspace (the Voice-to-text
 * section and the recorder's not-set-up / paused screens).
 */
import { VOICE_ERROR_CODES, type VoiceErrorCode } from './voice-transcription.js';

/** What a workplace's voice-to-text is doing right now. */
export type VoiceState = 'on' | 'off' | 'paused';

/** Why it is paused. The transcribe route answers each with Rosa's codes
 *  (note #1023, shared/voice-transcription.ts): voice_out_of_credit,
 *  voice_key_rejected — and voice_not_configured when no key is saved. */
export type VoicePauseReason = 'out_of_credit' | 'key_rejected';

export const voiceErrorCodeFor = (state: Exclude<VoiceState, 'on'>, reason?: VoicePauseReason): VoiceErrorCode =>
  state === 'off' ? VOICE_ERROR_CODES.notConfigured
    : reason === 'key_rejected' ? VOICE_ERROR_CODES.keyRejected
      : VOICE_ERROR_CODES.outOfCredit;

/** The model a workplace uses until an admin picks another (Adam, #1026 point 2). */
export const DEFAULT_VOICE_MODEL = 'openai/gpt-4o-mini-transcribe';

export interface VoiceModelInfo {
  id: string;
  name: string;
  /** One line for the picker: who makes it and what it is good at. */
  line: string;
  /** Per-second models are billed by the length of the recording; per-token
   *  models by the audio and text tokens, so their price a minute is an
   *  estimate (shown with ≈). */
  billing: 'second' | 'token';
  /** USD a minute, read from OpenRouter on 6 Nov 2026. The live price
   *  replaces it for per-second models whenever OpenRouter answers. For
   *  per-token models this is OpenAI's own per-minute estimate. */
  usdPerMinute: number;
}

/**
 * The short list (Adam, #1026 point 5): each model was tried with a real
 * Workspace recording before it went in. Order is the picker's order; the
 * first is the default. Anything else OpenRouter lists as a transcription
 * model can still be chosen by id ("another OpenRouter model").
 */
export const VOICE_MODELS: readonly VoiceModelInfo[] = [
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', line: 'OpenAI · good punctuation, many languages', billing: 'token', usdPerMinute: 0.003 },
  { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo', line: 'OpenAI open model · fastest and cheapest, plainer punctuation', billing: 'second', usdPerMinute: 0.0002 },
  { id: 'openai/whisper-large-v3', name: 'Whisper Large V3', line: 'OpenAI open model · a little more careful than Turbo', billing: 'second', usdPerMinute: 0.00045 },
  { id: 'mistralai/voxtral-mini-transcribe-3-0', name: 'Voxtral Mini Transcribe 3', line: 'Mistral · strong on European languages', billing: 'second', usdPerMinute: 0.0035 },
  { id: 'elevenlabs/scribe-v2', name: 'ElevenLabs Scribe v2', line: 'ElevenLabs · 90+ languages, names and numbers', billing: 'second', usdPerMinute: 0.0037 },
  { id: 'openai/gpt-transcribe', name: 'GPT Transcribe', line: 'OpenAI · newest, most accurate on hard audio', billing: 'second', usdPerMinute: 0.0045 },
  { id: 'openai/gpt-4o-transcribe', name: 'GPT-4o Transcribe', line: 'OpenAI · careful, slower', billing: 'token', usdPerMinute: 0.006 },
];

export const voiceModelInfo = (id: string): VoiceModelInfo | undefined => VOICE_MODELS.find((model) => model.id === id);

/** OpenRouter model ids: `maker/model`, lower-case letters, digits and a few marks. */
export const VOICE_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

/** One row of the picker. `live` says the price was read from OpenRouter
 *  today rather than the one shipped with the release. */
export interface VoiceModelOption extends VoiceModelInfo {
  live: boolean;
}

export interface VoiceModelsAnswer {
  models: VoiceModelOption[];
  /** When OpenRouter's list was last read (ISO), or null when it never answered. */
  pricesCheckedAt: string | null;
}

/** GET api/voice — every member. The admin-only part is absent for members. */
export interface VoiceAnswer {
  state: VoiceState;
  reason?: VoicePauseReason;
  /** When it paused (ISO). */
  pausedAt?: string;
  model: { id: string; name: string };
  /** The workplace's admins, by name, so a member knows who can fix it. */
  admins: string[];
  /** True when the reader is an admin and may change this. */
  canChange: boolean;
  /** The model and voice the Chief of Staff's recap is read aloud with
   *  (note #1151); present once the workplace has a key. */
  speech?: import('./voice-speech.js').RecapSpeechSetting;
  admin?: {
    key: { preview: string; savedAt: string; savedByName: string; copiedFromName?: string } | null;
    /**
     * With no key here: the OTHER workplaces this admin also runs that hold
     * one, so the key can be copied across in one tap (note #1116). Names
     * only; the value never leaves the server.
     */
    copyFrom?: VoiceKeySource[];
    /** OpenRouter's own figure for the account behind the key, in USD; null when it did not answer. */
    creditLeftUsd: number | null;
    month: VoiceMonthUsage;
  };
}

/** Another workplace whose voice-to-text key this admin may copy (note #1116). */
export interface VoiceKeySource {
  orgId: string;
  name: string;
}

export interface VoiceMonthUsage {
  /** `2026-11` — the calendar month (UTC) these figures are for. */
  month: string;
  recordings: number;
  seconds: number;
  /** What OpenRouter said the recordings cost, summed. */
  costUsd: number;
}

/** Words for a price a minute: `$0.0002`, `≈ $0.003`. */
export function voicePriceWords(model: Pick<VoiceModelInfo, 'billing' | 'usdPerMinute'>): string {
  const n = model.usdPerMinute;
  const digits = n >= 0.01 ? 2 : n >= 0.001 ? 4 : 5;
  const text = `$${n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '.0')}`;
  return model.billing === 'token' ? `≈ ${text}` : text;
}
