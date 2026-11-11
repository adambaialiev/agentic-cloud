/**
 * The Chief of Staff's recap, read aloud (note #1146). Adam, 11 Nov 2026:
 * "chief of staff recap I want them be text to voice. In header there should
 * be button to toggles between voice output mode on/off. if customer provided
 * openrouter key, this key should be used to generate voice based on recap
 * text."
 *
 * Shared by the route that speaks and the page that plays, so the sentences
 * and the codes cannot drift apart. The codes are dictation's own (note
 * #1023): it is the same key and the same account, so "out of credit" means
 * the same thing for both, and a refusal here pauses dictation too.
 */

import { VOICE_ERROR_CODES, type VoiceErrorCode } from './voice-transcription.js';

/**
 * ElevenLabs' low-latency v4 through OpenRouter: about a second for a
 * two-sentence recap, and $0.00004 a character on 11 Nov 2026: a recap is
 * written to at most 240 characters, so at most about a cent (a 224-character
 * recap of Adam's, read in production on 11 Nov, was 0.9 cents).
 */
export const RECAP_SPEECH_MODEL = 'elevenlabs/eleven-v4-turbo';
/** "Sarah": ElevenLabs' calm, clear American English voice. */
export const RECAP_SPEECH_VOICE = 'sarah';
/** What the voice is called where a person reads it. */
export const RECAP_SPEECH_VOICE_NAME = 'Sarah';
export const RECAP_SPEECH_FORMAT = 'mp3';
/** USD a character, as OpenRouter listed the model on 11 Nov 2026. */
export const RECAP_SPEECH_USD_PER_CHAR = 0.00004;
/** A recap is two short sentences, 240 characters at most; anything far
 *  longer is not a recap, and is never sent to be spoken. */
export const RECAP_SPEECH_MAX_CHARS = 600;

/** The recap the page asked about is no longer the one on record: a newer
 *  summary replaced it. Nothing to show; the next read brings the new one. */
export const RECAP_SPEECH_CHANGED = 'recap_changed';

/** POST api/recap/speech answers this. */
export interface RecapSpeechAnswer {
  /** The audio itself, base64: one ordinary JSON call, same session and CSRF. */
  audio: string;
  contentType: string;
  model: string;
  voice: string;
  /**
   * The workplace's chosen model or voice could not read it, so the default
   * did (note #1151): the one plain line the page shows under the recap.
   */
  fallback?: string;
}

/* ---------------------------------------------------------------------------
 * The workplace's choice of model and voice (note #1151). Adam, 11 Nov 2026:
 * "What voice model is used and I think I need to be able to switch voice
 * models in workspace settings."
 * ------------------------------------------------------------------------- */

/** The price shown beside each model is for a recap this long: the
 *  summarizer's own limit (TELEGRAM_AGENT_RECAP_MAX_LENGTH). */
export const RECAP_SPEECH_PRICE_CHARS = 240;

/** What a Play sample button says, on the workplace's key. */
export const RECAP_SPEECH_SAMPLE = 'Hi, I\'m your Chief of Staff. This is how your recaps will sound when I read them to you.';

/** One text-to-speech model OpenRouter offers, as the chooser shows it. */
export interface SpeechModelOption {
  id: string;
  /** OpenRouter's own name, "ElevenLabs: Eleven v4 Turbo". */
  name: string;
  /** The voice ids OpenRouter lists for it, in its order. */
  voices: string[];
  /** USD for a recap of RECAP_SPEECH_PRICE_CHARS characters; null when
   *  OpenRouter gives no price we can turn into one. */
  usdPerRecap: number | null;
  /** True for a model billed by audio tokens: the price is an estimate. */
  estimate: boolean;
}

/** GET api/voice/speech/models. */
export interface SpeechModelsAnswer {
  models: SpeechModelOption[];
  /** When OpenRouter's list was read (ISO); null when it never answered. */
  checkedAt: string | null;
  default: { model: string; voice: string };
}

/** The workplace's recap voice, in GET api/voice for every member. */
export interface RecapSpeechSetting {
  model: string;
  /** OpenRouter's name when known, else the id. */
  modelName: string;
  voice: string;
  voiceName: string;
  isDefault: boolean;
  changedByName?: string;
  changedAt?: string;
  /** The last time the chosen model or voice failed and the default read
   *  the recap instead: what happened, in one sentence, and when. */
  problem?: { at: string; words: string };
}

/** A voice id as a person reads it: "sarah" → "Sarah"; anything with
 *  marks in it ("aura-2-thalia-en", "en-US-Harper:MAI-Voice-2") as it is. */
export function speechVoiceName(id: string): string {
  return /^[a-z]+$/.test(id) ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/** Words for a price a recap: "0.96¢", "≈ 0.31¢", "0.015¢". */
export function speechRecapPriceWords(model: Pick<SpeechModelOption, 'usdPerRecap' | 'estimate'>): string {
  if (model.usdPerRecap === null) return 'price not listed';
  const cents = model.usdPerRecap * 100;
  const text = cents === 0 ? '0' : cents >= 1 ? cents.toFixed(1).replace(/\.0$/, '') : Number(cents.toPrecision(2)).toString();
  return `${model.estimate ? '≈ ' : ''}${text}¢`;
}

/**
 * The price of one recap from OpenRouter's listing. Most speech models are
 * priced per CHARACTER of input (`prompt`, checked against OpenRouter's own
 * generation records on 11 Nov 2026: Kokoro, Voxtral, Deepgram, ElevenLabs,
 * Grok all billed exactly characters × prompt). Gemini's are priced per
 * token, mostly per AUDIO token out: measured at about a quarter of a prompt
 * token and 1.41 audio tokens a character, so that price is an estimate.
 */
export function speechUsdPerRecap(prompt: number, completion: number, chars = RECAP_SPEECH_PRICE_CHARS): { usd: number | null; estimate: boolean } {
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return { usd: null, estimate: false };
  if (completion === 0) return { usd: prompt * chars, estimate: false };
  return { usd: chars * (prompt / 4 + completion * 1.41), estimate: true };
}

export const RECAP_SPEECH_SENTENCES: Record<VoiceErrorCode, string> = {
  voice_out_of_credit:
    'The recap can\'t be read aloud: the OpenRouter account that pays for voice has run out of credit. '
    + 'Ask an admin of this workplace to top it up.',
  voice_key_rejected:
    'The recap can\'t be read aloud: this workplace\'s OpenRouter key no longer works. '
    + 'Ask an admin of this workplace to replace it.',
  voice_not_configured: 'Reading aloud isn\'t set up here: this workplace has no OpenRouter key.',
  voice_failed: 'Could not read this recap aloud. Tap play to try again.',
};

export { VOICE_ERROR_CODES };
