/**
 * The arithmetic behind the microphone: what a browser can record with, where
 * a transcript lands in the words already in the field, and how loud the room
 * is right now.
 *
 * Everything here is pure and browser-free on purpose. `VoiceField` owns the
 * permission, the recorder and the animation frame; this file owns the parts
 * that are worth testing without a microphone.
 */

/** The cap the legacy page recorded to, kept: past a minute and a half a
 *  recording is a file upload, and the transcriber charges for the silence. */
export const VOICE_RECORDING_MAX_MS = 90_000;

/** In preference order. Opus in WebM is what Chrome and Firefox give; `mp4`
 *  is Safari's, and it has to come before the bare `audio/webm` it will
 *  cheerfully claim to support and then produce nothing for. */
export const VOICE_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

/** How many bars the live wave is drawn with, and the fraction of the strip a
 *  silent room still occupies — a flat line says "listening", nothing at all
 *  says "broken". */
export const VOICE_WAVE_BARS = 28;
export const VOICE_WAVE_FLOOR = 0.07;

/** The wave advances on its own clock rather than the display's: a 28-bar
 *  strip refreshed 60 times a second is a third of a second of history, which
 *  reads as noise. At 25Hz the same strip holds a spoken word. */
export const VOICE_WAVE_STEP_MS = 40;

type Recorder = { isTypeSupported?: (type: string) => boolean };

/** The first container this browser will actually record into, or '' to let
 *  MediaRecorder pick its own default. */
export function preferredVoiceMimeType(recorder: Recorder | undefined = typeof window === 'undefined' ? undefined : (window as { MediaRecorder?: Recorder }).MediaRecorder): string {
  if (!recorder || typeof recorder.isTypeSupported !== 'function') return '';
  return VOICE_MIME_TYPES.find((type) => recorder.isTypeSupported!(type)) ?? '';
}

/** Both halves are needed and they fail separately: iOS Safari in an insecure
 *  context has `mediaDevices` missing, older Safari had MediaRecorder missing
 *  while getUserMedia worked. */
export function voiceInputSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return Boolean(navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof (window as { MediaRecorder?: unknown }).MediaRecorder === 'function');
}

/** What went wrong with the microphone, in the words of somebody who has to
 *  fix it — a browser permission, a missing device, or neither. */
export function voicePermissionMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is off. Allow it for this site, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone is available on this device.';
  return 'The microphone could not start. Please try again.';
}

export interface TranscriptInsertion {
  /** The field's whole new value. */
  value: string;
  /** Where the caret goes: the end of what was just dictated. */
  caret: number;
}

/**
 * Put a transcript into the words that were already there, at the selection
 * the field had when recording started.
 *
 * The spacing rules are the ones a person would apply by hand: a space before
 * the addition unless the text already ends in one or the transcript opens
 * with punctuation that closes a clause, and a space after unless the
 * following text starts with one or the addition ends on a character that
 * must stay glued to the next word — an opening bracket, a hyphen, a slash.
 *
 * Returns null when there is nothing to insert, which includes a field that
 * is already full: the caller says so rather than silently truncating.
 */
export function insertTranscript(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
  maxLength = -1,
): TranscriptInsertion | null {
  const words = String(transcript ?? '').trim();
  if (!words) return null;
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.min(Math.max(selectionEnd, start), value.length);
  const before = value.slice(0, start);
  const after = value.slice(end);

  let addition = words;
  if (before && !/\s$/.test(before) && !/^[,.;:!?)]/.test(addition)) addition = ` ${addition}`;
  const tail = addition.charCodeAt(addition.length - 1);
  // ( - / [ {  — the characters that own the word coming after them.
  if (after && !/^\s/.test(after) && ![40, 45, 47, 91, 123].includes(tail)) addition += ' ';

  const cap = maxLength > 0 ? maxLength : Infinity;
  const room = Math.max(0, cap - before.length - after.length);
  addition = addition.slice(0, room);
  if (!addition) return null;

  return { value: before + addition + after, caret: before.length + addition.length };
}

/**
 * How loud the last few milliseconds were, as 0…1.
 *
 * Time-domain samples arrive as bytes around 128 (silence). The root mean
 * square of their distance from the middle is the honest energy of the
 * window; the curve after it is what makes that energy readable, because
 * speech sits between about 0.02 and 0.2 RMS and a linear bar for that range
 * is a bar that never moves. A quiet room lands near zero, ordinary speech
 * fills most of the strip, and a shout has somewhere left to go.
 */
export function levelFromTimeDomain(samples: ArrayLike<number>): number {
  const count = samples.length;
  if (!count) return 0;
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const centred = ((samples[index] ?? 128) - 128) / 128;
    sum += centred * centred;
  }
  const rms = Math.sqrt(sum / count);
  return Math.max(0, Math.min(1, (rms * 5) ** 0.7));
}

/** The strip, one step older: every bar shifts left and the newest level
 *  arrives on the right, so the wave scrolls the way it was spoken. */
export function pushLevel(history: Float32Array, level: number): void {
  if (!history.length) return;
  history.copyWithin(0, 1);
  history[history.length - 1] = level;
}

/** A level as the bar's vertical scale, floor included. */
export function barScale(level: number): number {
  return VOICE_WAVE_FLOOR + Math.max(0, Math.min(1, level)) * (1 - VOICE_WAVE_FLOOR);
}
