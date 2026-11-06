/**
 * What /api/transcribe answers when it cannot turn a recording into words,
 * shared by the route that says it and the recorders that show it (note
 * #1023).
 *
 * Two of these are configuration, not a passing fault: the account that pays
 * for transcription has run out of credit, or its key has been rejected.
 * Recording again cannot help with either, so they answer 503 with a stable
 * code and the recorders offer no "Try recording again" for them. Everything
 * else that goes wrong upstream is one short plain sentence, and recording
 * again may well work.
 */

export const VOICE_ERROR_CODES = {
  outOfCredit: 'voice_out_of_credit',
  keyRejected: 'voice_key_rejected',
  notConfigured: 'voice_not_configured',
  failed: 'voice_failed',
} as const;

export type VoiceErrorCode = typeof VOICE_ERROR_CODES[keyof typeof VOICE_ERROR_CODES];

export const VOICE_ERROR_SENTENCES: Record<VoiceErrorCode, string> = {
  voice_out_of_credit:
    'Voice-to-text is paused because the account that pays for it has run out of credit. '
    + 'Ask the owner or an admin of this workplace to top it up. Typing still works.',
  voice_key_rejected:
    'Voice-to-text is paused because its key no longer works. '
    + 'Ask the owner or an admin of this workplace to replace it. Typing still works.',
  voice_not_configured: 'Voice-to-text is not set up here yet. Typing still works.',
  voice_failed: 'Could not transcribe that recording. Try again.',
};

/** The codes no second recording can fix: a recorder offers no retry for them. */
const SETTLED: ReadonlySet<string> = new Set<VoiceErrorCode>([
  VOICE_ERROR_CODES.outOfCredit,
  VOICE_ERROR_CODES.keyRejected,
  VOICE_ERROR_CODES.notConfigured,
]);

export function voiceErrorIsSettled(code: unknown): boolean {
  return typeof code === 'string' && SETTLED.has(code);
}
