import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { MPEGDecoder } from 'mpg123-decoder';
import { createMp3Encoder } from 'wasm-media-encoders';
import type { RadioGapCut } from '../shared/radio.js';

/**
 * Turns a model's WAV into the MP3 the station plays (note #712). A three-
 * minute WAV is about 30 MB; the MP3 is about 3 MB, which is what every
 * listener downloads. The backend host has no ffmpeg, so this is plain PCM
 * arithmetic and a WebAssembly LAME, in slices that hand the event loop back
 * between them so a request never waits behind an encode. A model that hands
 * back MP3 instead (Mureka, note #765) is decoded first by a WebAssembly
 * mpg123, so its tracks get the same gap cut, fades and peak as any other.
 */

export interface PcmAudio {
  sampleRate: number;
  /** One Float32Array per channel, -1..1. */
  channels: Float32Array[];
}

export class RadioAudioError extends Error {}

/** PCM 16/24/32-bit and 32-bit float WAV, mono or stereo — what music models hand back. */
export function parseWav(bytes: Buffer): PcmAudio {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new RadioAudioError('Not a WAV file.');
  }
  let format: { code: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let code = body.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE carries the real code in its sub-format GUID.
      if (code === 0xfffe && body.length >= 26) code = body.readUInt16LE(24);
      format = { code, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (!format || !data) throw new RadioAudioError('The WAV has no audio in it.');
  const { code, channels: count, sampleRate, bits } = format;
  const read = code === 3 && bits === 32 ? (at: number) => data.readFloatLE(at)
    : code === 1 && bits === 16 ? (at: number) => data.readInt16LE(at) / 32768
    : code === 1 && bits === 24 ? (at: number) => data.readIntLE(at, 3) / 8388608
    : code === 1 && bits === 32 ? (at: number) => data.readInt32LE(at) / 2147483648
    : null;
  if (!read || count < 1 || count > 2 || sampleRate < 8000) {
    throw new RadioAudioError(`Unsupported WAV (format ${code}, ${bits}-bit, ${count} channels, ${sampleRate} Hz).`);
  }
  const step = (bits / 8) * count;
  const frames = Math.floor(data.length / step);
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  if (code === 1 && bits === 16) {
    // The common case, read as one typed view: a three-minute track is
    // sixteen million samples, and a per-sample Buffer read holds the event
    // loop several times longer. Copied first, because the view needs an
    // even byte offset the download need not have.
    const pcm = new Int16Array(Uint8Array.prototype.slice.call(data, 0, frames * step).buffer);
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < count; channel += 1) channels[channel]![frame] = pcm[frame * count + channel]! / 32768;
    }
    return { sampleRate, channels };
  }
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) channels[channel]![frame] = read(frame * step + channel * (bits / 8));
  }
  return { sampleRate, channels };
}

/** MP3 as music models hand it back, decoded a slice at a time: a three-
 *  minute track is about 6 MB and decodes in under a second in all. */
export async function parseMp3(bytes: Buffer): Promise<PcmAudio> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const pieces: Float32Array[][] = [];
  let sampleRate = 0;
  let frames = 0;
  try {
    const slice = 256 * 1024;
    for (let at = 0; at < bytes.length; at += slice) {
      const decoded = decoder.decode(bytes.subarray(at, at + slice));
      if (decoded.samplesDecoded) {
        sampleRate ||= decoded.sampleRate;
        // Copied out: the decoder may hand back views into its own memory.
        pieces.push(decoded.channelData.map((channel) => channel.slice(0, decoded.samplesDecoded)));
        frames += decoded.samplesDecoded;
      }
      await yieldToLoop();
    }
  } finally {
    decoder.free();
  }
  const count = Math.min(2, pieces[0]?.length ?? 0);
  if (!frames || !count || sampleRate < 8000) throw new RadioAudioError('The MP3 has no audio in it.');
  const channels = Array.from({ length: count }, (_, channel) => {
    const whole = new Float32Array(frames);
    let write = 0;
    for (const piece of pieces) { whole.set(piece[channel] ?? piece[0]!, write); write += piece[0]!.length; }
    return whole;
  });
  return { sampleRate, channels };
}

/** Quieter than this, a stretch counts as dead air. */
const QUIET_RMS = 10 ** (-45 / 20);
const QUIET_WINDOW_SECONDS = 0.05;
/** A stretch of dead air longer than this is cut down to `GAP_KEPT_SECONDS`. */
export const RADIO_GAP_MAX_SECONDS = 1;
export const RADIO_GAP_KEPT_SECONDS = 0.25;
const SPLICE_FADE_SECONDS = 0.01;

/**
 * Cuts dead air out of a track. Asked for minutes of music, the model sometimes
 * leaves a breakdown of near-silence in the middle — four seconds of it at
 * 1:12 in the first lo-fi track made (2026-10-11) — which on a radio reads as
 * the stream having dropped. Any stretch quieter than -45 dBFS for over a
 * second, and any at the very start or end, is cut down to a quarter of a
 * second, with a 10 ms fade either side of the cut so the splice cannot click.
 */
export function closeGaps(audio: PcmAudio): PcmAudio {
  return closeGapsCounted(audio).audio;
}

/**
 * `closeGaps`, saying what it cut from INSIDE the track (note #761): where
 * each cut falls in the track as it comes out, and how much went. Trims at
 * the very start and end are not listed — every track has a little air at
 * its edges, and losing it is not a gap anybody would have heard.
 */
export function closeGapsCounted(audio: PcmAudio): { audio: PcmAudio; inside: RadioGapCut[] } {
  const frames = audio.channels[0]?.length ?? 0;
  const window = Math.max(1, Math.round(QUIET_WINDOW_SECONDS * audio.sampleRate));
  const windows = Math.ceil(frames / window);
  const quiet = new Array<boolean>(windows);
  for (let at = 0; at < windows; at += 1) {
    let loudest = 0;
    for (const channel of audio.channels) {
      let sum = 0;
      const end = Math.min(frames, (at + 1) * window);
      for (let frame = at * window; frame < end; frame += 1) sum += channel[frame]! ** 2;
      loudest = Math.max(loudest, Math.sqrt(sum / Math.max(1, end - at * window)));
    }
    quiet[at] = loudest < QUIET_RMS;
  }
  const kept = Math.round(RADIO_GAP_KEPT_SECONDS * audio.sampleRate);
  // Frame ranges to cut, each a run of quiet windows less what is kept of it.
  const cuts: Array<[number, number]> = [];
  for (let at = 0; at < windows;) {
    if (!quiet[at]) { at += 1; continue; }
    let end = at;
    while (end < windows && quiet[end]) end += 1;
    const from = at * window;
    const to = Math.min(frames, end * window);
    const edge = from === 0 || to === frames;
    if (to - from > (edge ? kept : RADIO_GAP_MAX_SECONDS * audio.sampleRate)) {
      // At the edges all of the kept quarter-second sits against the music;
      // inside, half of it stays on either side of the cut.
      if (from === 0) cuts.push([0, to - kept]);
      else if (to === frames) cuts.push([from + kept, frames]);
      else cuts.push([from + Math.floor(kept / 2), to - Math.ceil(kept / 2)]);
    }
    at = end;
  }
  if (!cuts.length) return { audio, inside: [] };
  const inside: RadioGapCut[] = [];
  let before = 0;
  for (const [from, to] of cuts) {
    if (from > 0 && to < frames) {
      inside.push({ atMs: Math.round(((from - before) / audio.sampleRate) * 1000), ms: Math.round(((to - from) / audio.sampleRate) * 1000) });
    }
    before += to - from;
  }
  const removed = cuts.reduce((sum, [from, to]) => sum + (to - from), 0);
  const fade = Math.round(SPLICE_FADE_SECONDS * audio.sampleRate);
  const channels = audio.channels.map((channel) => {
    const closed = new Float32Array(frames - removed);
    let write = 0;
    let read = 0;
    for (const [from, to] of [...cuts, [frames, frames] as [number, number]]) {
      closed.set(channel.subarray(read, from), write);
      const pieceEnd = write + (from - read);
      // Fade out into the cut and back in after it.
      if (from < frames) for (let k = 0; k < fade && pieceEnd - 1 - k >= write; k += 1) closed[pieceEnd - 1 - k]! *= k / fade;
      if (read > 0) for (let k = 0; k < fade && write + k < pieceEnd; k += 1) closed[write + k]! *= k / fade;
      write = pieceEnd;
      read = to;
    }
    return closed;
  });
  return { audio: { sampleRate: audio.sampleRate, channels }, inside };
}

export const RADIO_FADE_IN_SECONDS = 1;
export const RADIO_FADE_OUT_SECONDS = 3;
/** -1 dBFS: models hand back mixes that touch or pass full scale. */
const PEAK_CEILING = 0.891;

/** Short fades so one track hands over to the next without a click, and the
 *  peak brought under the ceiling. Quieter tracks are left as made. */
export function shapeForAir(audio: PcmAudio): PcmAudio {
  const frames = audio.channels[0]?.length ?? 0;
  let peak = 0;
  for (const channel of audio.channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > PEAK_CEILING ? PEAK_CEILING / peak : 1;
  const fadeIn = Math.min(frames, Math.round(RADIO_FADE_IN_SECONDS * audio.sampleRate));
  const fadeOut = Math.min(frames, Math.round(RADIO_FADE_OUT_SECONDS * audio.sampleRate));
  const channels = audio.channels.map((channel) => {
    const shaped = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const into = frame < fadeIn ? frame / fadeIn : 1;
      const out = frames - frame <= fadeOut ? (frames - frame - 1) / fadeOut : 1;
      shaped[frame] = channel[frame]! * gain * Math.max(0, Math.min(into, out));
    }
    return shaped;
  });
  return { sampleRate: audio.sampleRate, channels };
}

/** Constant 128 kb/s: about 1 MB a minute, and a constant rate is what lets a
 *  listener who joins halfway land on the right second when the player seeks. */
export async function encodeMp3(audio: PcmAudio): Promise<Buffer> {
  const encoder = await createMp3Encoder();
  const stereo = audio.channels.length === 2;
  encoder.configure({ sampleRate: audio.sampleRate, channels: stereo ? 2 : 1, bitrate: 128 });
  const frames = audio.channels[0]?.length ?? 0;
  const slice = 1152 * 64;
  const parts: Buffer[] = [];
  for (let at = 0; at < frames; at += slice) {
    // The encoder's output is a view into its own memory: copy it out before
    // the next call reuses that memory.
    parts.push(Buffer.from(encoder.encode(audio.channels.map((channel) => channel.subarray(at, at + slice)))));
    await yieldToLoop();
  }
  parts.push(Buffer.from(encoder.finalize()));
  return Buffer.concat(parts);
}

/** What the station keeps of one made track. */
export interface RadioMp3 {
  mp3: Buffer;
  durationMs: number;
  /** Dead air cut from inside it, for the operator to see (note #761). */
  gapsCut: RadioGapCut[];
}

/** The whole step: model WAV in, dead air out, the station's MP3, its length
 *  and what was cut out. */
export async function wavToRadioMp3(wav: Buffer): Promise<RadioMp3> {
  return pcmToRadioMp3(parseWav(wav));
}

/** The same step for a model that hands back MP3 (note #765). */
export async function mp3ToRadioMp3(mp3: Buffer): Promise<RadioMp3> {
  return pcmToRadioMp3(await parseMp3(mp3));
}

async function pcmToRadioMp3(made: PcmAudio): Promise<RadioMp3> {
  const { audio, inside } = closeGapsCounted(made);
  const frames = audio.channels[0]!.length;
  const durationMs = Math.round((frames / audio.sampleRate) * 1000);
  if (durationMs < 10_000) throw new RadioAudioError(`The track is only ${durationMs} ms long.`);
  return { mp3: await encodeMp3(shapeForAir(audio)), durationMs, gapsCut: inside };
}
