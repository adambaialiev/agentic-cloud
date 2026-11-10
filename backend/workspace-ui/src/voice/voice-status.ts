/**
 * Whether this workplace's voice-to-text can take a recording right now
 * (note #1026), known BEFORE anybody talks: every microphone reads it when
 * it appears, so a press on a workplace with no key, or one that is paused,
 * opens the "not set up" screen at once instead of after a minute of speech.
 *
 * One answer for the whole page, read at most once a minute and shared by
 * every microphone on it. It is a hint, not a gate: with no answer yet the
 * microphone records as before, and the transcribe route still refuses with
 * the same code, which then lands here so the next press knows.
 */
import type { VoiceAnswer, VoiceKeySource } from '../../../src/shared/voice.js';
import { VOICE_ERROR_CODES } from '../../../src/shared/voice-transcription.js';

export const VOICE_STATUS_TTL_MS = 60_000;

/** The part of the answer the recorder needs. */
export type VoiceStatus = Pick<VoiceAnswer, 'state' | 'reason' | 'admins' | 'canChange'> & {
  /** For an admin with no key here: other workplaces of theirs that have one (note #1116). */
  copyFrom?: VoiceKeySource[];
};

type Reader = <T>(path: string) => Promise<T>;

let known: { status: VoiceStatus; at: number } | null = null;
let inFlight: Promise<VoiceStatus | null> | null = null;
/** When a read last failed: every microphone on a page asks, and a backend
 *  that cannot answer is not asked again for a minute. */
let failedAt = 0;

/** The recorder's part of an answer from api/voice. */
export function voiceStatusOf(answer: VoiceAnswer): VoiceStatus {
  const copyFrom = answer.state === 'off' && answer.canChange ? answer.admin?.copyFrom ?? [] : [];
  return {
    state: answer.state, reason: answer.reason, admins: answer.admins ?? [], canChange: Boolean(answer.canChange),
    ...(copyFrom.length ? { copyFrom } : {}),
  };
}

/** An admin's change answered with the new settings: every microphone on
 *  the page knows at once, without another read. */
export function rememberVoiceAnswer(answer: VoiceAnswer): void {
  known = { status: voiceStatusOf(answer), at: Date.now() };
  failedAt = 0;
}

/** What is known now, or null when nothing has been read yet. */
export function knownVoiceStatus(now = Date.now()): VoiceStatus | null {
  return known && now - known.at < VOICE_STATUS_TTL_MS * 10 ? known.status : null;
}

/** Read it when the last answer is older than a minute; one read at a time. */
export function refreshVoiceStatus(read: Reader, now = Date.now()): Promise<VoiceStatus | null> {
  if (known && now - known.at < VOICE_STATUS_TTL_MS) return Promise.resolve(known.status);
  if (now - failedAt < VOICE_STATUS_TTL_MS) return Promise.resolve(known?.status ?? null);
  if (inFlight) return inFlight;
  inFlight = read<VoiceAnswer>('api/voice')
    .then((answer) => {
      // Only a real answer decides anything: something that is not one of
      // the three states (an old backend, a proxy's page) records as before.
      if (!answer || !['on', 'off', 'paused'].includes(answer.state)) return known?.status ?? null;
      known = { status: voiceStatusOf(answer), at: Date.now() };
      return known.status;
    })
    .catch(() => { failedAt = Date.now(); return known?.status ?? null; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** A recording came back: refused with one of the settled codes, or in words. */
export function noteVoiceOutcome(code: string | null): void {
  const previous = known?.status ?? { state: 'on' as const, admins: [], canChange: false };
  const at = Date.now();
  if (code === VOICE_ERROR_CODES.notConfigured) known = { status: { ...previous, state: 'off', reason: undefined }, at };
  else if (code === VOICE_ERROR_CODES.outOfCredit) known = { status: { ...previous, state: 'paused', reason: 'out_of_credit' }, at };
  else if (code === VOICE_ERROR_CODES.keyRejected) known = { status: { ...previous, state: 'paused', reason: 'key_rejected' }, at };
  else if (code === null && known) known = { status: { ...previous, state: 'on', reason: undefined }, at };
}

/** An admin changed the settings on this page: everyone reads afresh. */
export function forgetVoiceStatus(): void {
  known = null;
  failedAt = 0;
}
