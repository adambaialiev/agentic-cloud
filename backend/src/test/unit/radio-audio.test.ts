import { describe, expect, it } from 'vitest';
import {
  RadioAudioError, closeGaps, closeGapsCounted, encodeMp3, mp3ToRadioMp3, parseMp3, parseWav, shapeForAir, wavToRadioMp3,
} from '../../services/radio-audio.js';

/** A WAV around the given samples (interleaved), the way a model writes one. */
function wav(samples: number[], { channels = 2, sampleRate = 44100, bits = 16, float = false, extensible = false } = {}): Buffer {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((sample, at) => {
    if (float) data.writeFloatLE(sample, at * 4);
    else if (bits === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), at * 2);
    else data.writeIntLE(Math.round(sample * 8388607), at * 3, 3);
  });
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xfffe : float ? 3 : 1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 8);
  fmt.writeUInt16LE(channels * bytes, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) fmt.writeUInt16LE(float ? 3 : 1, 24);
  const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, 'ascii'), Buffer.from(new Uint32Array([body.length]).buffer), body]);
  // A LIST chunk before the audio, as some writers put one there.
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('LIST', Buffer.from('INFOsoft')), chunk('data', data)]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from(new Uint32Array([body.length]).buffer), body]);
}

describe('reading a model WAV', () => {
  it('splits 16-bit stereo into its two channels', () => {
    const audio = parseWav(wav([0.5, -0.5, 0.25, -0.25]));
    expect(audio.sampleRate).toBe(44100);
    expect([...audio.channels[0]!]).toEqual([0.5, 0.25]);
    expect([...audio.channels[1]!]).toEqual([-0.5, -0.25]);
  });

  it('reads 16-bit audio that starts at an odd byte, as a download may', () => {
    const odd = Buffer.concat([Buffer.alloc(1), wav([0.5, -0.5])]).subarray(1);
    expect([...parseWav(odd).channels[0]!]).toEqual([0.5]);
  });

  it('reads 24-bit, 32-bit float, mono and the extensible header', () => {
    expect(parseWav(wav([0.5, -0.5], { bits: 24 })).channels[0]![0]).toBeCloseTo(0.5, 4);
    expect(parseWav(wav([0.75, -0.75], { bits: 32, float: true })).channels[1]![0]).toBeCloseTo(-0.75, 6);
    expect(parseWav(wav([0.5, 0.25], { channels: 1, sampleRate: 48000 })).channels).toHaveLength(1);
    expect(parseWav(wav([0.5, -0.5], { extensible: true })).channels[0]![0]).toBe(0.5);
  });

  it('refuses what is not a WAV it can play', () => {
    expect(() => parseWav(Buffer.from('ID3 not a wav at all'))).toThrow(RadioAudioError);
    expect(() => parseWav(wav([0.5, 0.5, 0.5], { channels: 3 }))).toThrow(/Unsupported WAV/);
  });
});

describe('cutting dead air out of a track', () => {
  const rate = 8000;
  /** Seconds of a 400 Hz tone and of near-silence, in order, as one mono
   *  track. Whole seconds of tone end on a zero crossing, so the track itself
   *  has no jump in it for a splice to be blamed for. */
  const track = (...parts: Array<[number, 'tone' | 'quiet']>) => {
    const samples: number[] = [];
    for (const [seconds, kind] of parts) {
      for (let frame = 0; frame < seconds * rate; frame += 1) {
        samples.push(kind === 'tone' ? 0.3 * Math.sin((2 * Math.PI * 400 * frame) / rate) : 0.0005);
      }
    }
    return { sampleRate: rate, channels: [Float32Array.from(samples)] };
  };
  const seconds = (audio: { channels: Float32Array[] }) => audio.channels[0]!.length / rate;

  it('cuts a four-second breakdown down to a quarter of a second', () => {
    expect(seconds(closeGaps(track([2, 'tone'], [4, 'quiet'], [2, 'tone'])))).toBeCloseTo(4.25, 1);
  });

  it('leaves a short rest alone', () => {
    const audio = track([2, 'tone'], [0.8, 'quiet'], [2, 'tone']);
    expect(closeGaps(audio)).toBe(audio);
  });

  it('trims silence at the start and the end to a quarter of a second', () => {
    expect(seconds(closeGaps(track([1.5, 'quiet'], [3, 'tone'], [2, 'quiet'])))).toBeCloseTo(3.5, 1);
  });

  it('says what it cut from inside a track, and not the trims at its edges (note #761)', () => {
    const { inside } = closeGapsCounted(track([1.5, 'quiet'], [2, 'tone'], [4, 'quiet'], [2, 'tone'], [1.6, 'quiet'], [2, 'tone'], [2, 'quiet']));
    expect(inside).toHaveLength(2);
    // Where each cut falls in the track as it comes out, and how much went.
    expect(inside[0]!.atMs).toBeGreaterThan(2_250);
    expect(inside[0]!.atMs).toBeLessThan(2_500);
    expect(inside[0]!.ms).toBeGreaterThan(3_600);
    expect(inside[0]!.ms).toBeLessThan(3_800);
    expect(inside[1]!.atMs).toBeGreaterThan(4_400);
    expect(inside[1]!.atMs).toBeLessThan(4_700);
    expect(inside[1]!.ms).toBeGreaterThan(1_250);
    expect(inside[1]!.ms).toBeLessThan(1_450);
    expect(closeGapsCounted(track([2, 'tone'], [0.8, 'quiet'], [2, 'tone'])).inside).toEqual([]);
  });

  it('fades either side of the cut, so the splice cannot click', () => {
    const closed = closeGaps(track([2, 'tone'], [4, 'quiet'], [2, 'tone'])).channels[0]!;
    // Every step between neighbouring samples stays as small as the tone's own.
    let biggest = 0;
    for (let at = 1; at < closed.length; at += 1) biggest = Math.max(biggest, Math.abs(closed[at]! - closed[at - 1]!));
    expect(biggest).toBeLessThan(0.1);
  });
});

describe('shaping a track for air', () => {
  it('fades in and out to silence and brings a clipping peak under -1 dBFS', () => {
    const rate = 8000;
    const frames = rate * 10;
    const loud = new Float32Array(frames).fill(1.2);
    const shaped = shapeForAir({ sampleRate: rate, channels: [loud] }).channels[0]!;
    expect(shaped[0]).toBe(0);
    expect(shaped[frames - 1]).toBe(0);
    expect(shaped[rate / 2]).toBeCloseTo(0.891 / 2, 2);
    expect(Math.max(...shaped)).toBeCloseTo(0.891, 3);
  });

  it('leaves a quieter track at its own level', () => {
    const quiet = new Float32Array(8000 * 10).fill(0.3);
    expect(shapeForAir({ sampleRate: 8000, channels: [quiet] }).channels[0]![8000 * 5]).toBeCloseTo(0.3, 6);
  });
});

describe('the station MP3', () => {
  it('encodes a constant 128 kb/s MP3 and reports the length of what was made', async () => {
    const rate = 44100;
    const seconds = 12;
    const samples: number[] = [];
    for (let frame = 0; frame < rate * seconds; frame += 1) {
      const tone = 0.4 * Math.sin((2 * Math.PI * 220 * frame) / rate);
      samples.push(tone, tone);
    }
    const { mp3, durationMs, gapsCut } = await wavToRadioMp3(wav(samples));
    expect(durationMs).toBe(12_000);
    expect(gapsCut).toEqual([]);
    // An MPEG-1 Layer III frame header: sync, then 128 kb/s at 44.1 kHz.
    const header = mp3.indexOf(Buffer.from([0xff, 0xfb]));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(mp3[header + 2]! >> 4).toBe(0b1001);
    // 128 kb/s is 16 kB a second, give or take the encoder's padding.
    expect(mp3.length).toBeGreaterThan(16_000 * seconds * 0.95);
    expect(mp3.length).toBeLessThan(16_000 * seconds * 1.05);
  });

  it('refuses a track too short to be one, and one that is all silence', async () => {
    await expect(wavToRadioMp3(wav(new Array(44100 * 2 * 2).fill(0.5)))).rejects.toThrow(/only 2000 ms/);
    await expect(wavToRadioMp3(wav(new Array(44100 * 20 * 2).fill(0)))).rejects.toThrow(/only 250 ms/);
  });
});

describe('a model that hands back MP3 (note #765)', () => {
  /** Ten seconds of tone, three of silence, ten of tone: what Mureka hands back, in miniature. */
  async function modelMp3(): Promise<Buffer> {
    const rate = 44100;
    const channel = new Float32Array(rate * 23);
    for (let frame = 0; frame < channel.length; frame += 1) {
      const silent = frame >= rate * 10 && frame < rate * 13;
      channel[frame] = silent ? 0 : 0.4 * Math.sin((2 * Math.PI * 220 * frame) / rate);
    }
    return encodeMp3({ sampleRate: rate, channels: [channel, channel.slice()] });
  }

  it('decodes it to the audio it carries', async () => {
    const audio = await parseMp3(await modelMp3());
    expect(audio.sampleRate).toBe(44100);
    expect(audio.channels).toHaveLength(2);
    // The encoder's own padding adds a few frames' worth at most.
    expect(audio.channels[0]!.length / 44100).toBeGreaterThan(22.9);
    expect(audio.channels[0]!.length / 44100).toBeLessThan(23.2);
    expect(Math.max(...audio.channels[0]!.subarray(44100, 44100 * 2))).toBeGreaterThan(0.3);
  });

  it('gets the same gap cut, shape and station MP3 as a WAV does', async () => {
    const { mp3, durationMs, gapsCut } = await mp3ToRadioMp3(await modelMp3());
    expect(gapsCut).toHaveLength(1);
    expect(gapsCut[0]!.atMs).toBeGreaterThan(9_900);
    expect(gapsCut[0]!.ms).toBeGreaterThan(2_500);
    expect(durationMs).toBeGreaterThan(20_000);
    expect(durationMs).toBeLessThan(20_500);
    const header = mp3.indexOf(Buffer.from([0xff, 0xfb]));
    expect(mp3[header + 2]! >> 4).toBe(0b1001);
  });

  it('refuses what is not an MP3', async () => {
    await expect(parseMp3(Buffer.from('<html>Not found</html>'))).rejects.toThrow(RadioAudioError);
    await expect(parseMp3(Buffer.alloc(0))).rejects.toThrow(/no audio/);
  });
});
