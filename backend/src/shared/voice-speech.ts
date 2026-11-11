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
 * two-sentence recap, and $0.00004 a character on 11 Nov 2026 — under a cent
 * for a recap of 200 characters.
 */
export const RECAP_SPEECH_MODEL = 'elevenlabs/eleven-v4-turbo';
/** "Sarah": ElevenLabs' calm, clear American English voice. */
export const RECAP_SPEECH_VOICE = 'sarah';
/** What the voice is called where a person reads it. */
export const RECAP_SPEECH_VOICE_NAME = 'Sarah';
export const RECAP_SPEECH_FORMAT = 'mp3';
/** USD a character, as OpenRouter listed the model on 11 Nov 2026. */
export const RECAP_SPEECH_USD_PER_CHAR = 0.00004;
/** A recap is two short sentences, 280 characters at most; anything far
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
