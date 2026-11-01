/**
 * A microphone jsdom does not have: a stream, a recorder, an analyser that
 * reports a room of a chosen loudness, and a frame loop the test drains by
 * hand.
 *
 * Shared because the microphone has more than one call site now (note #365) —
 * chat, a note and the margin all open the same recorder, and a fake copied
 * per test file is a fake that drifts. What each test still owns is the screen
 * it mounts and what it expects to see.
 */

import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** How loud the fake room is, as 0…1. The analyser reads this. */
export const room = { amplitude: 0 };

let frames: FrameRequestCallback[] = [];

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  connect() { /* nothing downstream */ }
  disconnect() { /* nothing downstream */ }
  getByteTimeDomainData(array: Uint8Array) {
    for (let index = 0; index < array.length; index += 1) {
      array[index] = Math.round(128 + Math.sin((index / array.length) * Math.PI * 8) * room.amplitude * 127);
    }
  }
}

class FakeAudioContext {
  state = 'running';
  closed = false;
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}

class FakeRecorder {
  static supported = ['audio/webm;codecs=opus'];
  static isTypeSupported(type: string) { return FakeRecorder.supported.includes(type); }
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['pretend audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

export const stopTrack = vi.fn();

export function giveMicrophone() {
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream) },
    configurable: true,
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => { /* the queue is drained by hand */ });
}

/** Run whatever the loop asked for, at a clock far enough on that the wave's
 *  own step has elapsed. */
export function paint(now: number) {
  const queued = frames;
  frames = [];
  act(() => { for (const callback of queued) callback(now); });
}

export const barScales = () => [...document.querySelectorAll<HTMLSpanElement>('.voicewave > span')]
  .map((bar) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1] ?? NaN));

/** jsdom has no top layer; real Chrome checks modality, focus and layout. */
export function openDialogsInJsdom() {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
}

/** Put the room, the frame queue and the microphone back as they were. */
export function forgetMicrophone() {
  room.amplitude = 0;
  frames = [];
  Reflect.deleteProperty(navigator, 'mediaDevices');
}
