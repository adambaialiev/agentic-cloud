import { describe, expect, it } from 'vitest';
import {
  VOICE_WAVE_BARS, VOICE_WAVE_FLOOR, barScale, insertTranscript, levelFromTimeDomain,
  preferredVoiceMimeType, pushLevel, voicePermissionMessage,
} from './voice-input.js';

/** A window of time-domain bytes at a given amplitude around the 128 middle. */
function tone(amplitude: number, count = 256): Uint8Array {
  return Uint8Array.from({ length: count }, (_, index) => (
    Math.round(128 + Math.sin((index / count) * Math.PI * 8) * amplitude * 127)
  ));
}

describe('insertTranscript', () => {
  it('opens a space before the addition, and one after it', () => {
    expect(insertTranscript('Call Ada', 8, 8, 'about the deploy')).toEqual({
      value: 'Call Ada about the deploy',
      caret: 25,
    });
    expect(insertTranscript('Call  tomorrow', 5, 5, 'Ada')).toEqual({
      value: 'Call Ada tomorrow',
      caret: 8,
    });
  });

  it('does not put a space before punctuation that closes a clause', () => {
    expect(insertTranscript('Ready', 5, 5, ', then ship')?.value).toBe('Ready, then ship');
  });

  it('does not put a space after a character that owns the next word', () => {
    expect(insertTranscript('see details', 4, 4, 'docs/')?.value).toBe('see docs/details');
    expect(insertTranscript('see details', 4, 4, 'the')?.value).toBe('see the details');
  });

  it('replaces the selection rather than inserting beside it', () => {
    expect(insertTranscript('the red door', 4, 7, 'blue')).toEqual({ value: 'the blue door', caret: 8 });
  });

  it('stops at the field cap and refuses a field with no room left', () => {
    expect(insertTranscript('ab', 2, 2, 'cdefgh', 6)?.value).toBe('ab cde');
    expect(insertTranscript('abcdef', 6, 6, 'more', 6)).toBeNull();
  });

  it('is nothing at all for a blank transcript', () => {
    expect(insertTranscript('kept', 4, 4, '   ')).toBeNull();
    expect(insertTranscript('kept', 4, 4, '')).toBeNull();
  });

  it('survives a selection that ran past the words it was taken from', () => {
    // A field emptied by its own Send while the recording was still running.
    expect(insertTranscript('', 12, 20, 'hello')).toEqual({ value: 'hello', caret: 5 });
  });
});

describe('levelFromTimeDomain', () => {
  it('reads a silent room as flat and a voice as most of the strip', () => {
    expect(levelFromTimeDomain(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromTimeDomain(tone(0.002))).toBeLessThan(0.1);
    expect(levelFromTimeDomain(tone(0.15))).toBeGreaterThan(0.4);
  });

  it('rises with loudness and never leaves 0…1', () => {
    const quiet = levelFromTimeDomain(tone(0.02));
    const speaking = levelFromTimeDomain(tone(0.12));
    const shouting = levelFromTimeDomain(tone(0.9));
    expect(quiet).toBeLessThan(speaking);
    expect(speaking).toBeLessThan(shouting);
    expect(shouting).toBeLessThanOrEqual(1);
    expect(levelFromTimeDomain(new Uint8Array(0))).toBe(0);
  });
});

describe('the strip', () => {
  it('scrolls: the newest level arrives on the right and the oldest falls off', () => {
    const history = new Float32Array(3);
    pushLevel(history, 0.1);
    pushLevel(history, 0.2);
    pushLevel(history, 0.3);
    expect([...history]).toEqual([0.1, 0.2, 0.3].map((value) => Math.fround(value)));
    pushLevel(history, 0.4);
    expect([...history]).toEqual([0.2, 0.3, 0.4].map((value) => Math.fround(value)));
  });

  it('leaves a visible line for silence and a full bar for a shout', () => {
    expect(barScale(0)).toBe(VOICE_WAVE_FLOOR);
    expect(barScale(1)).toBe(1);
    expect(barScale(-5)).toBe(VOICE_WAVE_FLOOR);
    expect(VOICE_WAVE_BARS).toBeGreaterThan(8);
  });
});

describe('the browser it has to run in', () => {
  it('takes the first container the recorder admits to, and Safari before bare webm', () => {
    expect(preferredVoiceMimeType({ isTypeSupported: (type) => type === 'audio/webm;codecs=opus' }))
      .toBe('audio/webm;codecs=opus');
    expect(preferredVoiceMimeType({ isTypeSupported: (type) => type === 'audio/mp4' || type === 'audio/webm' }))
      .toBe('audio/mp4');
    expect(preferredVoiceMimeType({ isTypeSupported: () => false })).toBe('');
    expect(preferredVoiceMimeType(undefined)).toBe('');
  });

  it('says which of the microphone failures happened', () => {
    expect(voicePermissionMessage({ name: 'NotAllowedError' })).toMatch(/Allow it for this site/);
    expect(voicePermissionMessage({ name: 'SecurityError' })).toMatch(/Allow it for this site/);
    expect(voicePermissionMessage({ name: 'NotFoundError' })).toMatch(/No microphone/);
    expect(voicePermissionMessage(new Error('boom'))).toMatch(/could not start/);
  });
});
