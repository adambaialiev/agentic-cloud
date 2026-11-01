import { describe, expect, it } from 'vitest';
import {
  RADIO_MAKERS,
  RADIO_MAX_ATTEMPTS_PER_DAY,
  RADIO_MAX_GAPS_INSIDE,
  RADIO_MAX_GAP_MS_INSIDE,
  RADIO_TRACK_SECONDS,
  RadioImportError,
  RadioLibrary,
  RadioStopStartError,
  checkGaps,
  makeDecision,
  radioPrompt,
  radioRecipe,
  trackTitle,
  urbanPrompt,
} from '../../services/radio-library.js';
import type { RadioMp3 } from '../../services/radio-audio.js';
import { InMemoryRadioStorage, RADIO_ATTEMPTS_KEPT, type RadioTrackEntry } from '../../services/radio-storage.js';
import type { MediaStorage } from '../../services/media-storage.js';
import type { RadioGapCut } from '../../shared/radio.js';

const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const urban = (prompt: string, id = prompt): RadioTrackEntry => ({
  id, title: id, durationMs: 90_000, storagePath: `radio/tracks/${id}.mp3`, sizeBytes: 1,
  createdAt: new Date(T0).toISOString(), maker: RADIO_MAKERS.urban.name, prompt, station: 'urban',
});

describe('the spending policy', () => {
  it('makes nothing unless the operator asked: there is no size the library fills to (note #761)', () => {
    expect(makeDecision({}, [], T0)).toEqual({ make: false, reason: 'no tracks are asked for' });
    expect(makeDecision({ urban: 0 }, [], T0)).toEqual({ make: false, reason: 'no tracks are asked for' });
  });

  it('makes what was asked for, the first station first', () => {
    expect(makeDecision({ urban: 5 }, [], T0)).toEqual({ make: true, station: 'urban' });
    expect(makeDecision({ urban: 2, lofi: 1 }, [], T0)).toEqual({ make: true, station: 'lofi' });
  });

  it('never more than 90 tries in a day, failures included, whatever was asked for', () => {
    expect(RADIO_MAX_ATTEMPTS_PER_DAY).toBe(90);
    const tries = Array.from({ length: RADIO_MAX_ATTEMPTS_PER_DAY }, (_, at) => ({ at: new Date(T0 - at * 60_000).toISOString() }));
    expect(makeDecision({ urban: 500 }, tries, T0)).toEqual({ make: false, reason: 'today\'s tries are spent' });
    expect(makeDecision({ urban: 500 }, tries, T0 + 25 * HOUR)).toEqual({ make: true, station: 'urban' });
  });

  it('gives urban 20 tries a day of its own, at most $4.50 on Mureka, and lo-fi carries on past them (note #765)', () => {
    expect(RADIO_MAKERS.urban.triesPerDay).toBe(20);
    expect(RADIO_MAKERS.lofi.triesPerDay).toBeUndefined();
    const urbanTries = Array.from({ length: 20 }, (_, at) => ({ at: new Date(T0 - at * 60_000).toISOString(), station: 'urban' as const }));
    expect(makeDecision({ urban: 30 }, urbanTries, T0)).toEqual({ make: false, reason: 'today\'s tries for urban are spent' });
    expect(makeDecision({ urban: 30 }, urbanTries.slice(1), T0)).toEqual({ make: true, station: 'urban' });
    expect(makeDecision({ urban: 30, lofi: 2 }, urbanTries, T0)).toEqual({ make: true, station: 'lofi' });
    // Lo-fi's tries, and tries from before stations, do not use urban's up.
    const others = Array.from({ length: 60 }, (_, at) => ({ at: new Date(T0 - at * 60_000).toISOString(), ...(at % 2 ? { station: 'lofi' as const } : {}) }));
    expect(makeDecision({ urban: 30 }, others, T0)).toEqual({ make: true, station: 'urban' });
    expect(makeDecision({ urban: 30 }, urbanTries, T0 + 25 * HOUR)).toEqual({ make: true, station: 'urban' });
  });

  it('keeps more tries on record than a day allows, so the daily count is never short', () => {
    expect(RADIO_ATTEMPTS_KEPT).toBeGreaterThan(RADIO_MAX_ATTEMPTS_PER_DAY);
  });

  it('asks for the lo-fi hip-hop the owner picked, in a mood, tempo, key and lead of its own, never with vocals', () => {
    expect(radioPrompt(() => 0)).toBe('Lo-fi hip-hop beat for focus, rainy-day mood, 70 BPM, F major, dusty swung drums, '
      + 'mellow Rhodes electric piano chords, warm upright bass, soft vinyl crackle, tape saturation, relaxed and steady, no vocals');
    expect(radioPrompt(() => 0.999)).toMatch(/^Lo-fi hip-hop beat for focus, cozy-afternoon mood, 90 BPM, E minor, .*mellow flute melody, .*no vocals$/);
    const leads = new Set(Array.from({ length: 6 }, (_, at) => radioPrompt(() => at / 6).split(', ')[5]));
    expect([...leads]).toEqual(['mellow Rhodes electric piano chords', 'soft felt piano chords', 'muted jazz guitar chords',
      'soft vibraphone melody', 'warm synth pad chords', 'mellow flute melody']);
  });

  it('asks for the urban recipe drafted with the owner, with a continuous beat right after the style (note #761)', () => {
    expect(urbanPrompt(() => 0, [])).toBe('Instrumental hip-hop beat, 90s New York boom-bap, continuous steady beat from start to finish, '
      + 'drums play the whole time, swaggering, 88 BPM, F major, hard-hitting punchy kick, crisp cracking snare, tight fast hi-hats, '
      + 'deep heavy bass, brass stabs, head-nodding groove, urban street energy, confident and driving, no vocals');
    expect(urbanPrompt(() => 0.999, [])).toContain('100 BPM');
    // Nothing of lo-fi in it, and jazz never named: naming it pulls the sound toward it.
    for (const at of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
      expect(urbanPrompt(() => at, [])).not.toMatch(/dusty|warm|vinyl|crackle|Rhodes|upright|relaxed|cozy|jazz/i);
    }
  });

  it('draws only boom-bap and G-funk, taking the one its station has fewer of (note #765: "No trap", "More boombap and gfunk")', () => {
    const made: RadioTrackEntry[] = [];
    for (let at = 0; at < 7; at += 1) made.push(urban(urbanPrompt(Math.random, made), `u${at}`));
    const styles = made.map((track) => radioRecipe(track.prompt).style);
    // Seven come out four of one and three of the other, never more apart.
    expect([styles.filter((style) => style === 'boom-bap').length, styles.filter((style) => style === 'G-funk').length].sort()).toEqual([3, 4]);
    for (let draw = 0; draw < 200; draw += 1) expect(radioRecipe(urbanPrompt(Math.random, made)).style).toMatch(/^(boom-bap|G-funk)$/);
    // A station full of the retired styles is not offered them to even things up.
    const retired = ['modern trap-style beat with rolling hi-hats', 'funk breakbeat', 'old-school 80s electro-rap groove']
      .map((words, at) => urban(`Instrumental hip-hop beat, ${words}, no vocals`, `r${at}`));
    expect(radioRecipe(urbanPrompt(() => 0.999, retired)).style).toBe('G-funk');
  });

  it('reads a prompt back as the recipe it asked for, for the operator\'s page (note #758)', () => {
    expect(radioRecipe(radioPrompt(() => 0))).toEqual({ mood: 'rainy-day', lead: 'Rhodes', bpm: 70, key: 'F major' });
    expect(radioRecipe(radioPrompt(() => 0.999))).toEqual({ mood: 'cozy-afternoon', lead: 'flute', bpm: 90, key: 'E minor' });
    // One of the first thirty, as production holds it: made before moods.
    expect(radioRecipe('Lo-fi hip-hop beat for focus, 78 BPM, B-flat major, dusty swung drums, soft felt piano chords, '
      + 'warm upright bass, soft vinyl crackle, tape saturation, relaxed and steady, no vocals'))
      .toEqual({ lead: 'felt piano', bpm: 78, key: 'B-flat major' });
    expect(radioRecipe(urbanPrompt(() => 0, []))).toEqual({ style: 'boom-bap', energy: 'swaggering', lead: 'brass stabs', bpm: 88, key: 'F major' });
    expect(radioRecipe(urbanPrompt(() => 0.999, []))).toEqual({ style: 'G-funk', energy: 'bouncy', lead: 'slap bass', bpm: 100, key: 'E minor' });
    expect(radioRecipe('')).toEqual({});
    // A trap track made before trap was retired still reads back as trap.
    expect(radioRecipe('Instrumental hip-hop beat, modern trap-style beat with rolling hi-hats, continuous steady beat from start to finish, '
      + 'drums play the whole time, high-energy, 100 BPM, C minor, staccato string stabs, no vocals').style).toBe('trap');
  });

  it('asks CassetteAI for 90-second lo-fi WAVs, about 3 cents each at $0.02 a minute', () => {
    expect(RADIO_TRACK_SECONDS).toBe(90);
    expect(RADIO_MAKERS.lofi).toMatchObject({ endpoint: 'CassetteAI/music-generator', format: 'wav' });
    expect(RADIO_MAKERS.lofi.body('p')).toEqual({ prompt: 'p', duration: 90 });
  });

  it('asks Mureka 9.5 for urban, which answers MP3 of its own length (note #765)', () => {
    expect(RADIO_MAKERS.urban).toMatchObject({ endpoint: 'mureka/api/generate/instrumental', format: 'mp3' });
    expect(RADIO_MAKERS.urban.body('p')).toEqual({ model: 'mureka-9.5', prompt: 'p' });
  });

  it('names a track in its station\'s own words, with a name the library does not have yet', () => {
    const first = trackTitle(new Set(), () => 0);
    expect(first).toBe('Rainy Window');
    expect(trackTitle(new Set([first]), (() => { let at = 0; return () => [0, 0, 0.5, 0.5][at++ % 4]!; })())).not.toBe(first);
    expect(trackTitle(new Set(), () => 0, 'urban')).toBe('Concrete Bounce');
  });

  it('refuses a track broken into stop-start pieces, and passes the worst lo-fi track made', () => {
    const gaps = (...ms: number[]): RadioGapCut[] => ms.map((each, at) => ({ atMs: at * 10_000, ms: each }));
    expect(() => checkGaps([])).not.toThrow();
    expect(() => checkGaps(gaps(4_400, 1_700))).not.toThrow();
    expect(() => checkGaps(gaps(...Array.from({ length: RADIO_MAX_GAPS_INSIDE + 1 }, () => 900)))).toThrow(RadioStopStartError);
    expect(() => checkGaps(gaps(RADIO_MAX_GAP_MS_INSIDE + 1))).toThrow(/stop-start pieces \(1 gaps, 8\.0 s cut\)/);
  });
});

/** fal's queue as the library sees it: submit, one "in progress", done, the file. */
function fakeFal({ refuse = false } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let polls = 0;
  let endpoint = '';
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://queue.fal.run/')) {
      endpoint = url.slice('https://queue.fal.run/'.length);
      return refuse
        ? json({ detail: 'User is locked. Reason: Exhausted balance.' }, 403)
        : json({ status_url: 'https://queue.test/status', response_url: 'https://queue.test/result' });
    }
    if (url === 'https://queue.test/status') return json({ status: ++polls % 2 === 1 ? 'IN_PROGRESS' : 'COMPLETED' });
    // CassetteAI answers `audio_file` (a WAV), Mureka `audio` (an MP3).
    if (url === 'https://queue.test/result') {
      return json(endpoint === RADIO_MAKERS.urban.endpoint ? { audio: { url: 'https://files.test/track.mp3' } } : { audio_file: { url: 'https://files.test/track.wav' } });
    }
    if (url === 'https://files.test/track.wav' || url === 'https://files.test/track.mp3') return new Response(new Uint8Array([1, 2, 3]));
    if (url === 'https://v3b.fal.media/files/trial-gfunk.mp3') return new Response(new Uint8Array([4, 5, 6, 7]));
    return json({ detail: 'unexpected' }, 500);
  }) as typeof fetch;
  const submits = () => calls.filter((call) => call.url.startsWith('https://queue.fal.run/'));
  const asked = () => submits().map((call) => JSON.parse(String(call.init?.body)) as { prompt: string; duration?: number; model?: string });
  const endpoints = () => submits().map((call) => call.url.slice('https://queue.fal.run/'.length));
  return { fetch, calls, asked, endpoints };
}

function harness(fal = fakeFal(), gapsCut: () => RadioGapCut[] = () => []) {
  const storage = new InMemoryRadioStorage();
  const uploads: { storagePath: string; contentType: string; bytes: number }[] = [];
  const media = {
    uploadObject: async ({ storagePath, contentType, data }: { storagePath: string; contentType: string; data: Uint8Array }) => {
      uploads.push({ storagePath, contentType, bytes: data.byteLength });
    },
  } as unknown as MediaStorage;
  const lines: string[] = [];
  const formats: string[] = [];
  let now = T0;
  const library = new RadioLibrary({
    storage, media, falKey: 'test-key', fetch: fal.fetch, now: () => now, random: Math.random,
    sleep: async (ms) => { now += ms; },
    encode: async (made, format): Promise<RadioMp3> => {
      formats.push(format);
      return { mp3: Buffer.alloc(made.length * 100), durationMs: 89_400, gapsCut: gapsCut() };
    },
    log: (line) => lines.push(line),
  });
  const order = (count: number, station: 'lofi' | 'urban' = 'urban') => storage.changeWanted((wanted) => { wanted[station] = (wanted[station] ?? 0) + count; });
  return { storage, uploads, lines, formats, library, fal, order, advance: (ms: number) => { now += ms; } };
}

describe('the library making tracks', () => {
  it('makes nothing on its own, however small the library (note #761)', async () => {
    const { library, fal, advance } = harness();
    for (let day = 0; day < 3; day += 1) { await library.check(); advance(24 * HOUR); }
    expect(fal.calls).toEqual([]);
  });

  it('makes exactly the five asked for on urban with Mureka, boom-bap and G-funk, stores each MP3 and records each try, then stops', async () => {
    const { storage, uploads, library, fal, order, advance, lines, formats } = harness();
    await order(5);
    await library.check();
    const tracks = await storage.tracks();
    expect(tracks).toHaveLength(5);
    expect(tracks.every((track) => track.station === 'urban' && track.durationMs === 89_400 && track.maker === RADIO_MAKERS.urban.name)).toBe(true);
    expect(new Set(tracks.map((track) => radioRecipe(track.prompt).style))).toEqual(new Set(['G-funk', 'boom-bap']));
    expect(fal.endpoints().every((endpoint) => endpoint === 'mureka/api/generate/instrumental')).toBe(true);
    expect(formats).toEqual(tracks.map(() => 'mp3'));
    expect(tracks.every((track) => /^radio\/tracks\/[0-9a-f-]{36}\.mp3$/.test(track.storagePath))).toBe(true);
    expect(uploads).toEqual(tracks.map((track) => ({ storagePath: track.storagePath, contentType: 'audio/mpeg', bytes: 300 })));
    expect((await storage.attempts()).map((attempt) => [attempt.ok, attempt.station])).toEqual(tracks.map(() => [true, 'urban']));
    expect(await storage.wanted()).toEqual({});
    // The recipe that made a track is kept on it, and every one asked Mureka 9.5, with no length: it makes its own.
    expect(fal.asked().map((asked) => asked.prompt).sort()).toEqual(tracks.map((track) => track.prompt).sort());
    expect(fal.asked().every((asked) => asked.model === 'mureka-9.5' && asked.duration === undefined)).toBe(true);
    const submit = fal.calls.find((call) => call.url.startsWith('https://queue.fal.run/'))!;
    expect(new Headers(submit.init?.headers).get('authorization')).toBe('Key test-key');
    // The key goes to fal's queue and nowhere else — not to the file host.
    expect(fal.calls.filter((call) => call.url.startsWith('https://files.test/'))
      .every((call) => !new Headers(call.init?.headers).has('authorization'))).toBe(true);
    expect(lines.join('\n')).not.toContain('test-key');
    expect(lines[0]).toMatch(/^made ".+" for urban \(89 s, 300 bytes\)$/);
    const asked = fal.calls.length;
    advance(24 * HOUR);
    await library.check();
    expect(fal.calls).toHaveLength(asked);
  });

  it('keeps on each track the gaps it cut, even none', async () => {
    let take = 0;
    const { storage, library, order, lines } = harness(fakeFal(), () => (take++ === 0 ? [{ atMs: 41_000, ms: 1_700 }] : []));
    await order(2);
    await library.check();
    const tracks = await storage.tracks();
    expect(tracks.map((track) => track.gapsCut)).toEqual([[{ atMs: 41_000, ms: 1_700 }], []]);
    expect(lines[0]).toContain(', 1 gap cut)');
  });

  it('refuses a stop-start take before storing it, tries once more at once, then waits for the next check', async () => {
    const choppy = () => Array.from({ length: RADIO_MAX_GAPS_INSIDE + 1 }, (_, at) => ({ atMs: at * 9_000, ms: 1_100 }));
    const { storage, uploads, library, fal, order, advance } = harness(fakeFal(), choppy);
    await order(5);
    await library.check();
    expect(await storage.tracks()).toEqual([]);
    expect(uploads).toEqual([]);
    expect((await storage.attempts()).map((attempt) => attempt.error)).toEqual([
      expect.stringContaining('stop-start pieces'), expect.stringContaining('stop-start pieces'),
    ]);
    expect(await storage.wanted()).toEqual({ urban: 5 });
    expect(fal.asked()).toHaveLength(2);
    advance(HOUR);
    await library.check();
    expect(fal.asked()).toHaveLength(4);
  });

  it('carries on past one bad take', async () => {
    let take = 0;
    const { storage, library, order } = harness(fakeFal(), () => (take++ === 1 ? Array.from({ length: 6 }, () => ({ atMs: 1, ms: 2_000 })) : []));
    await order(3);
    await library.check();
    expect(await storage.tracks()).toHaveLength(3);
    expect((await storage.attempts()).map((attempt) => attempt.ok)).toEqual([true, false, true, true]);
  });

  it('never goes past the day\'s tries: what is left waits until older tries are a day old', async () => {
    const { storage, library, order, advance } = harness();
    for (let at = 0; at < RADIO_MAX_ATTEMPTS_PER_DAY - 2; at += 1) {
      await storage.recordAttempt({ id: `earlier-${at}`, at: new Date(T0 - HOUR).toISOString(), ok: false, error: 'refused' });
    }
    await order(5);
    await library.check();
    expect(await storage.tracks()).toHaveLength(2);
    expect(await storage.wanted()).toEqual({ urban: 3 });
    advance(24 * HOUR);
    await library.check();
    expect(await storage.tracks()).toHaveLength(5);
  });

  it('stops at the first refusal, keeps the reason, and asks again only at the next hourly check', async () => {
    const { storage, library, lines, fal, order, advance } = harness(fakeFal({ refuse: true }));
    await order(5);
    await library.check();
    expect(await storage.tracks()).toEqual([]);
    expect(await storage.attempts()).toEqual([expect.objectContaining({ ok: false, station: 'urban', error: expect.stringContaining('Exhausted balance') })]);
    expect(lines.at(-1)).toContain('could not make a track for urban');
    for (let check = 0; check < 10; check += 1) { advance(HOUR); await library.check(); }
    // One try per check: a model that keeps refusing is asked once an hour.
    expect(fal.calls).toHaveLength(11);
  });

  it('counts a make that never finished, so a backend dying mid-make cannot spend again and again', async () => {
    const { storage, library, order } = harness();
    for (let at = 0; at < RADIO_MAX_ATTEMPTS_PER_DAY; at += 1) {
      await storage.recordAttempt({ id: `crash-${at}`, at: new Date(T0 - at * 60_000).toISOString(), ok: false, error: 'unfinished' });
    }
    await order(5);
    await library.check();
    expect(await storage.tracks()).toEqual([]);
  });

  it('shares one check between callers who overlap, and sees an order that lands mid-check', async () => {
    const { storage, library, order, fal } = harness();
    await order(1, 'lofi');
    const first = library.check();
    await order(2);
    await Promise.all([first, library.check()]);
    const tracks = await storage.tracks();
    expect(tracks.map((track) => track.station).sort()).toEqual(['lofi', 'urban', 'urban']);
    const lofi = tracks.find((track) => track.station === 'lofi')!;
    expect(radioRecipe(lofi.prompt).mood).toBeTruthy();
    // Lo-fi is still CassetteAI's, a 90-second WAV.
    expect(lofi.maker).toBe('CassetteAI/music-generator');
    expect(fal.endpoints().filter((endpoint) => endpoint === 'CassetteAI/music-generator')).toHaveLength(1);
    expect(fal.asked().find((asked) => asked.duration)).toEqual({ prompt: lofi.prompt, duration: RADIO_TRACK_SECONDS });
  });

  it('stops urban at its 20 tries a day while lo-fi carries on (note #765)', async () => {
    const { storage, library, order, advance } = harness();
    for (let at = 0; at < 18; at += 1) {
      await storage.recordAttempt({ id: `earlier-${at}`, at: new Date(T0 - HOUR).toISOString(), ok: true, station: 'urban' });
    }
    await order(5);
    await order(3, 'lofi');
    await library.check();
    const made = await storage.tracks();
    expect(made.filter((track) => track.station === 'urban')).toHaveLength(2);
    expect(made.filter((track) => track.station === 'lofi')).toHaveLength(3);
    expect(await storage.wanted()).toEqual({ urban: 3 });
    advance(24 * HOUR);
    await library.check();
    expect((await storage.tracks()).filter((track) => track.station === 'urban')).toHaveLength(5);
  });
});

describe('putting a take made outside the station on it (note #765)', () => {
  const take = { url: 'https://v3b.fal.media/files/trial-gfunk.mp3', prompt: 'Instrumental hip-hop beat, West Coast G-funk bounce, 96 BPM, no vocals' };

  it('stores it like a made track, as Mureka\'s MP3, spending no try and owing nothing', async () => {
    const { storage, uploads, library, fal, formats } = harness();
    await storage.changeWanted((wanted) => { wanted.urban = 2; });
    const track = await library.importTrack('urban', take);
    expect(track).toMatchObject({ station: 'urban', maker: RADIO_MAKERS.urban.name, prompt: take.prompt, source: take.url, durationMs: 89_400 });
    expect(radioRecipe(track.prompt).style).toBe('G-funk');
    expect(await storage.tracks()).toEqual([track]);
    expect(uploads).toEqual([{ storagePath: track.storagePath, contentType: 'audio/mpeg', bytes: 400 }]);
    expect(formats).toEqual(['mp3']);
    expect(await storage.attempts()).toEqual([]);
    expect(await storage.wanted()).toEqual({ urban: 2 });
    // Fetched from fal's file host without the key, and nothing asked of fal's queue.
    expect(fal.calls.map((call) => call.url)).toEqual([take.url]);
    expect(new Headers(fal.calls[0]!.init?.headers).has('authorization')).toBe(false);
  });

  it('never puts the same take on twice', async () => {
    const { storage, library } = harness();
    await library.importTrack('urban', take);
    await expect(library.importTrack('urban', take)).rejects.toThrow(RadioImportError);
    expect(await storage.tracks()).toHaveLength(1);
  });

  it('fetches only from fal\'s own file host, and wants the recipe the take was made to', async () => {
    const { storage, library, fal } = harness();
    for (const url of ['http://v3b.fal.media/files/a.mp3', 'https://fal.media.evil.test/a.mp3', 'https://files.test/track.mp3', 'not a url', 'https://169.254.169.254/latest']) {
      await expect(library.importTrack('urban', { ...take, url })).rejects.toThrow(/fal's own file host/);
    }
    await expect(library.importTrack('urban', { ...take, prompt: '  ' })).rejects.toThrow(/what the take was asked for/);
    await expect(library.importTrack('urban', { ...take, prompt: 'x'.repeat(1025) })).rejects.toThrow(RadioImportError);
    expect(fal.calls).toEqual([]);
    expect(await storage.tracks()).toEqual([]);
  });

  it('refuses a stop-start take before storing it', async () => {
    const choppy = () => Array.from({ length: RADIO_MAX_GAPS_INSIDE + 1 }, (_, at) => ({ atMs: at * 9_000, ms: 1_100 }));
    const { storage, uploads, library } = harness(fakeFal(), choppy);
    await expect(library.importTrack('urban', take)).rejects.toThrow(RadioStopStartError);
    expect(await storage.tracks()).toEqual([]);
    expect(uploads).toEqual([]);
  });
});
