import { randomUUID } from 'node:crypto';
import { RADIO_STATIONS, type RadioGapCut, type RadioRecipe, type RadioStationId } from '../shared/radio.js';
import type { MediaStorage } from './media-storage.js';
import { mp3ToRadioMp3, wavToRadioMp3, type RadioMp3 } from './radio-audio.js';
import { trackStation, type RadioStorage, type RadioTrackEntry, type RadioWanted } from './radio-storage.js';

/**
 * Makes the work radio's tracks (note #712), on a budget. The owner topped
 * fal.ai up by $10 and asked for the cheapest model, so the numbers below ARE
 * the spending policy, and changing one is a reviewed change, not a setting.
 *
 * Lo-fi is made by CassetteAI: at $0.02 per output minute a 90-second track
 * costs about 3 cents. Urban is made by Mureka 9.5 since note #765, at 22.5
 * cents a track of about three minutes (see `RADIO_MAKERS`). Since
 * note #761 a station gets new tracks only when the operator asks for a
 * number of them ("For now, let's generate 5 tracks"): there is no size the
 * library fills to and no making on its own. History: it made two at launch
 * and one a day, then filled to thirty and to eighty at once (2026-10-11),
 * and then stopped for good until the owner lifted the cap with the second
 * station.
 *
 * What keeps a failure from running up a bill: a check stops at the first
 * failed try and waits for the next hourly check, so a model that keeps
 * failing is asked at most once an hour; and no more than 90 tries in any 24
 * hours are ever made, failed or not, whatever was asked for — and no more
 * than 20 of them for urban, whose tries cost seven times lo-fi's.
 *
 * Lo-fi (owner, 2026-10-11, after hearing four samples): the model's warm
 * tape sound is its strength. Every lo-fi track is the sample the owner
 * picked — dusty swung drums, warm bass, vinyl crackle, no vocals — in a
 * mood, a tempo, a key and on a lead of its own, so eighty of them do not
 * sound like one. Each lead was tried in a 30-second sample first and kept a
 * steady beat with no dead air.
 *
 * Urban (owner, 2026-10-15: "hip-hop but not jazz or melancholic or cozy.
 * More urban, rythmic and energetic"): the recipe drafted with him, which
 * keeps every lo-fi word out and never names jazz, because naming it pulls
 * the sound toward it. Asked for faster styles this model breaks into
 * stop-start pieces; in 30-second samples (2026-10-15) trap and electro came
 * out in bursts with holes between them and G-funk dropped to a thin
 * breakdown, until the words that ask for a continuous beat came straight
 * after the style. So they stand there, and every new urban track takes the
 * style its station has fewest of, so the range is heard before any repeats.
 *
 * Urban on Mureka (note #765): the owner heard the same recipes made by
 * CassetteAI, Lyria 3 Pro and Mureka 9.5 (2026-10-16) and picked Mureka,
 * whose takes kept a beat from start to end with no dead air. It ignores a
 * length asked for and makes about three minutes, which the owner heard and
 * kept. Then "No trap" and "More boombap and gfunk": only those two are
 * drawn now (see `URBAN_STYLES`).
 */
/** How one station's tracks are made: the fal endpoint, what it is sent,
 *  whether it answers WAV or MP3, and the most tries a day it may have on
 *  top of the shared daily cap. */
export interface RadioMaker {
  /** Kept on each track it makes, so a track can be traced to its model. */
  name: string;
  endpoint: string;
  body: (prompt: string) => Record<string, unknown>;
  format: 'wav' | 'mp3';
  triesPerDay?: number;
}

/**
 * Who makes each station's tracks, and so what each costs. Lo-fi: CassetteAI
 * at $0.02 an output minute, about 3 cents a 90-second track. Urban (note
 * #765): Mureka 9.5, $0.225 a track whatever its length (about three
 * minutes), so its tries have a cap of their own — 20 a day is at most $4.50,
 * where the shared 90 would have let it spend about $20.
 */
export const RADIO_MAKERS: Record<RadioStationId, RadioMaker> = {
  lofi: {
    name: 'CassetteAI/music-generator', endpoint: 'CassetteAI/music-generator', format: 'wav',
    body: (prompt) => ({ prompt, duration: RADIO_TRACK_SECONDS }),
  },
  urban: {
    name: 'mureka/api/generate/instrumental mureka-9.5', endpoint: 'mureka/api/generate/instrumental', format: 'mp3',
    body: (prompt) => ({ model: 'mureka-9.5', prompt }), triesPerDay: 20,
  },
};
const KEYS = ['F major', 'D minor', 'A minor', 'E-flat major', 'G major', 'C minor', 'B-flat major', 'E minor'];
/** Each lead as the prompt asks for it, and in a word or two for the
 *  operator's page (note #758). */
const LEADS = [
  { words: 'mellow Rhodes electric piano chords', name: 'Rhodes' },
  { words: 'soft felt piano chords', name: 'felt piano' },
  { words: 'muted jazz guitar chords', name: 'jazz guitar' },
  { words: 'soft vibraphone melody', name: 'vibraphone' },
  { words: 'warm synth pad chords', name: 'synth pad' },
  { words: 'mellow flute melody', name: 'flute' },
];
const MOODS = ['rainy-day', 'sunny-morning', 'late-night', 'cozy-afternoon'];
/** Every urban style ever asked for, so an old track's still reads back.
 *  A retired one is no longer drawn (note #765): the owner said "No trap",
 *  then "More boombap and gfunk", and ordered tracks of those two only — so
 *  for now they are the only two drawn. Electro and funk breakbeat come back
 *  by dropping their `retired`. */
const URBAN_STYLES = [
  { words: '90s New York boom-bap', name: 'boom-bap' },
  { words: 'West Coast G-funk bounce', name: 'G-funk' },
  { words: 'modern trap-style beat with rolling hi-hats', name: 'trap', retired: true },
  { words: 'funk breakbeat', name: 'funk breakbeat', retired: true },
  { words: 'old-school 80s electro-rap groove', name: 'electro', retired: true },
];
const URBAN_STYLES_DRAWN = URBAN_STYLES.filter((style) => !style.retired);
const URBAN_LEADS = [
  { words: 'brass stabs', name: 'brass stabs' },
  { words: 'funky synth lead', name: 'synth lead' },
  { words: 'staccato string stabs', name: 'string stabs' },
  { words: 'turntable scratches', name: 'scratches' },
  { words: 'plucky synth riff', name: 'synth riff' },
  { words: 'slap bass riff', name: 'slap bass' },
];
const URBAN_ENERGIES = ['swaggering', 'high-energy', 'bright and bold', 'gritty', 'bouncy'];
const pick = <T,>(items: readonly T[], random: () => number): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;

/** What the model is asked for on lo-fi: the owner's pick, varied in mood, tempo (70–90 BPM), key and lead. */
export function radioPrompt(random: () => number): string {
  const mood = pick(MOODS, random);
  const bpm = 70 + Math.min(20, Math.floor(random() * 21));
  return `Lo-fi hip-hop beat for focus, ${mood} mood, ${bpm} BPM, ${pick(KEYS, random)}, dusty swung drums, ${pick(LEADS, random).words}, `
    + 'warm upright bass, soft vinyl crackle, tape saturation, relaxed and steady, no vocals';
}

/** What the model is asked for on urban (note #761): the recipe drafted with
 *  the owner, in the style its station has fewest tracks of, with an energy,
 *  a tempo (88–100 BPM), a key and a lead of its own. */
export function urbanPrompt(random: () => number, onStation: RadioTrackEntry[]): string {
  const used = new Map(URBAN_STYLES_DRAWN.map((style) => [style.name, 0]));
  for (const track of onStation) {
    const style = radioRecipe(track.prompt).style;
    if (style && used.has(style)) used.set(style, used.get(style)! + 1);
  }
  const fewest = Math.min(...used.values());
  const style = pick(URBAN_STYLES_DRAWN.filter((candidate) => used.get(candidate.name) === fewest), random);
  const energy = pick(URBAN_ENERGIES, random);
  const bpm = 88 + Math.min(12, Math.floor(random() * 13));
  return `Instrumental hip-hop beat, ${style.words}, continuous steady beat from start to finish, drums play the whole time, `
    + `${energy}, ${bpm} BPM, ${pick(KEYS, random)}, hard-hitting punchy kick, crisp cracking snare, tight fast hi-hats, deep heavy bass, `
    + `${pick(URBAN_LEADS, random).words}, head-nodding groove, urban street energy, confident and driving, no vocals`;
}

/** What a stored prompt asked for, read back for the operator's page (note
 *  #758). The first thirty lo-fi tracks were made before moods, so theirs
 *  has none; only urban tracks name a style and an energy. */
export function radioRecipe(prompt: string): RadioRecipe {
  const parts = prompt.split(', ');
  const named = (list: readonly { words: string; name: string }[]) => list.find((candidate) => parts.includes(candidate.words))?.name;
  const style = named(URBAN_STYLES);
  const mood = parts.find((part) => / mood$/.test(part))?.slice(0, -' mood'.length);
  const energy = URBAN_ENERGIES.find((candidate) => parts.includes(candidate));
  const lead = named(LEADS) ?? named(URBAN_LEADS);
  const bpm = parts.find((part) => /^\d+ BPM$/.test(part));
  const key = KEYS.find((candidate) => parts.includes(candidate));
  return {
    ...(style ? { style } : {}),
    ...(mood ? { mood } : {}),
    ...(energy ? { energy } : {}),
    ...(lead ? { lead } : {}),
    ...(bpm ? { bpm: Number.parseInt(bpm, 10) } : {}),
    ...(key ? { key } : {}),
  };
}

export const RADIO_TRACK_SECONDS = 90;
/** Failures count too: a model that keeps failing, or a backend that keeps
 *  restarting mid-make, can never spend more than this many tries a day. */
export const RADIO_MAX_ATTEMPTS_PER_DAY = 90;
/** The most tracks one order may ask for. A slip of the keyboard should not
 *  become a bill: the daily tries cap what is spent, this caps what is owed. */
export const RADIO_MAX_ORDER = 50;
/**
 * A track this broken up is not saved (note #761): more dead-air gaps cut
 * from inside it than this, or more seconds of them in all. The worst lo-fi
 * track made — two gaps, 6.1 s, the first one (2026-10-11) — passes; the
 * first trap sample, three holes in thirty seconds, would not have.
 */
export const RADIO_MAX_GAPS_INSIDE = 3;
export const RADIO_MAX_GAP_MS_INSIDE = 8_000;
/** Tracks refused as stop-start that one check tries past before it waits
 *  for the next: each is a track paid for, so the second ends the check. */
const STOP_START_PER_CHECK = 2;
const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 60_000;
const POLL_EVERY_MS = 3_000;
const GIVE_UP_AFTER_MS = 10 * 60_000;
const MAX_TAKE_BYTES = 80 * 1024 * 1024;

const TITLE_WORDS: Record<RadioStationId, [string[], string[]]> = {
  lofi: [
    ['Rainy', 'Slow', 'Late', 'Quiet', 'Warm', 'Sunday', 'Dusty', 'Soft', 'Paper', 'Amber', 'Hazy', 'Sleepy',
      'Golden', 'Mellow', 'Faded', 'Little', 'Gentle', 'Cloudy', 'Morning', 'Evening', 'Cozy', 'Lazy', 'Velvet', 'Autumn'],
    ['Window', 'Coffee', 'Notebook', 'Afternoon', 'Library', 'Tram', 'Balcony', 'Lamp', 'Letters', 'Garden',
      'Puddles', 'Pages', 'Tape', 'Sunset', 'Streetlight', 'Kettle', 'Corner', 'Desk', 'Polaroid', 'Blanket', 'Walk', 'Daydream',
      'Sketch', 'Radio'],
  ],
  urban: [
    ['Concrete', 'Neon', 'Downtown', 'Midnight', 'Subway', 'Block', 'Brick', 'Chrome', 'Rooftop', 'Uptown', 'Asphalt', 'Electric',
      'Heavy', 'Loud', 'Metro', 'Boulevard', 'Crosstown', 'Steel', 'Bass', 'Gold', 'Street', 'Highway', 'Ten-Speed', 'Boombox'],
    ['Bounce', 'Cipher', 'Hustle', 'Strut', 'Pulse', 'Avenue', 'Stride', 'Motion', 'Shuffle', 'Swagger', 'Run', 'Knock',
      'Signal', 'Lights', 'Rush', 'Drive', 'Groove', 'Block Party', 'Breaks', 'Kicks', 'Stomp', 'Ride', 'Flex', 'Riot'],
  ],
};

/** A name for the "now playing" line, in the station's own words, that no
 *  track in the whole library has yet. */
export function trackTitle(taken: Set<string>, random: () => number, station: RadioStationId = 'lofi'): string {
  const [first, second] = TITLE_WORDS[station];
  for (let tries = 0; tries < 50; tries += 1) {
    const title = `${first[Math.floor(random() * first.length)]} ${second[Math.floor(random() * second.length)]}`;
    if (!taken.has(title)) return title;
  }
  return `Track ${taken.size + 1}`;
}

/** Whether to make a track right now, for which station, and why not when
 *  not: only what the operator asked for, only within the day's tries, and
 *  for a station with a cap of its own (urban, note #765) within that too. */
export function makeDecision(wanted: RadioWanted, attempts: { at: string; station?: RadioStationId }[], now: number):
  { make: true; station: RadioStationId } | { make: false; reason: string } {
  const asked = RADIO_STATIONS.filter((candidate) => (wanted[candidate.id] ?? 0) > 0).map((candidate) => candidate.id);
  if (!asked.length) return { make: false, reason: 'no tracks are asked for' };
  if (triesToday(attempts, now) >= RADIO_MAX_ATTEMPTS_PER_DAY) return { make: false, reason: 'today\'s tries are spent' };
  const station = asked.find((candidate) => triesToday(attempts.filter((attempt) => attempt.station === candidate), now)
    < (RADIO_MAKERS[candidate].triesPerDay ?? Infinity));
  if (!station) return { make: false, reason: `today's tries for ${asked.join(' and ')} are spent` };
  return { make: true, station };
}

export const triesToday = (attempts: { at: string }[], now: number): number =>
  attempts.filter((attempt) => now - Date.parse(attempt.at) < 24 * 60 * 60_000).length;

/** A made track too broken up to air (note #761). */
export class RadioStopStartError extends Error {}

/** Refuses a track with too much dead air cut from inside it. */
export function checkGaps(gapsCut: RadioGapCut[]): void {
  const total = gapsCut.reduce((sum, gap) => sum + gap.ms, 0);
  if (gapsCut.length > RADIO_MAX_GAPS_INSIDE || total > RADIO_MAX_GAP_MS_INSIDE) {
    throw new RadioStopStartError(`the track broke into stop-start pieces (${gapsCut.length} gaps, ${(total / 1000).toFixed(1)} s cut)`);
  }
}

export interface RadioLibraryOptions {
  storage: RadioStorage;
  media: MediaStorage;
  falKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  encode?: (made: Buffer, format: RadioMaker['format']) => Promise<RadioMp3>;
  log?: (line: string) => void;
}

interface FalQueued { status_url?: string; response_url?: string }
/** CassetteAI answers `audio_file`, Mureka `audio`. */
interface FalResult { audio_file?: { url?: string }; audio?: { url?: string } }

/** A track the operator already has from the station's own model, made
 *  outside the station — the owner's trial takes (note #765) — and what
 *  it was asked for. Only fal's own file host is fetched from. */
export interface RadioImport {
  url: string;
  prompt: string;
}

/** A take the operator asked to put on air that cannot be (note #765). */
export class RadioImportError extends Error {}

export class RadioLibrary {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly encode: (made: Buffer, format: RadioMaker['format']) => Promise<RadioMp3>;
  private readonly log: (line: string) => void;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RadioLibraryOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.encode = options.encode ?? ((made, format) => (format === 'mp3' ? mp3ToRadioMp3(made) : wavToRadioMp3(made)));
    this.log = options.log ?? ((line) => console.log(`[radio] ${line}`));
  }

  /** Checks a minute after boot, then hourly, and whenever an order comes
   *  in. Each check makes tracks one after another until nothing more is
   *  asked for, a try fails, or the day's tries are spent. */
  start(): void {
    const tick = () => { void this.check(); };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, CHECK_EVERY_MS);
      this.timer.unref();
    }, FIRST_CHECK_AFTER_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One check; a call while one runs is folded into it, and an order that
   *  lands mid-check is seen before the check ends. */
  check(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.makeWhileWanted(); } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async makeWhileWanted(): Promise<void> {
    let stopStart = 0;
    for (;;) {
      const decision = makeDecision(await this.options.storage.wanted(), await this.options.storage.attempts(), this.now());
      if (!decision.make) return;
      const { station } = decision;
      // Written BEFORE the money is spent: a backend that dies mid-make has
      // still used up one of the day's tries.
      const attempt = { id: randomUUID(), at: new Date(this.now()).toISOString(), station };
      await this.options.storage.recordAttempt({ ...attempt, ok: false, error: 'unfinished' });
      try {
        const track = await this.makeOne(station);
        await this.options.storage.changeWanted((wanted) => { wanted[station] = Math.max(0, (wanted[station] ?? 0) - 1); });
        await this.options.storage.recordAttempt({ ...attempt, ok: true });
        const gaps = track.gapsCut?.length ? `, ${track.gapsCut.length} gap${track.gapsCut.length === 1 ? '' : 's'} cut` : '';
        this.log(`made "${track.title}" for ${station} (${Math.round(track.durationMs / 1000)} s, ${track.sizeBytes} bytes${gaps})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.storage.recordAttempt({ ...attempt, ok: false, error: message.slice(0, 300) });
        this.log(`could not make a track for ${station}: ${message.slice(0, 300)}`);
        // A stop-start track is the model having an off take, not the model
        // being down: try once more straight away, then wait like any failure.
        if (error instanceof RadioStopStartError && (stopStart += 1) < STOP_START_PER_CHECK) continue;
        return;
      }
    }
  }

  private async makeOne(station: RadioStationId): Promise<RadioTrackEntry> {
    const maker = RADIO_MAKERS[station];
    const headers = { Authorization: `Key ${this.options.falKey}`, 'Content-Type': 'application/json' };
    const library = await this.options.storage.tracks();
    const prompt = station === 'urban'
      ? urbanPrompt(this.random, library.filter((track) => trackStation(track) === station))
      : radioPrompt(this.random);
    const submitted = await this.fetch(`https://queue.fal.run/${maker.endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(maker.body(prompt)),
    });
    const queued = await submitted.json().catch(() => ({})) as FalQueued & { detail?: unknown };
    if (!submitted.ok || !queued.status_url || !queued.response_url) {
      throw new Error(`fal refused the request (${submitted.status}): ${JSON.stringify(queued.detail ?? queued).slice(0, 200)}`);
    }
    const deadline = this.now() + GIVE_UP_AFTER_MS;
    for (;;) {
      await this.sleep(POLL_EVERY_MS);
      const status = await (await this.fetch(queued.status_url, { headers })).json().catch(() => ({})) as { status?: string };
      if (status.status === 'COMPLETED') break;
      if (this.now() > deadline) throw new Error('fal did not finish the track within ten minutes');
    }
    const answered = await this.fetch(queued.response_url, { headers });
    const result = await answered.json().catch(() => ({})) as FalResult & { detail?: unknown };
    const url = result.audio_file?.url ?? result.audio?.url;
    if (!answered.ok || !url) throw new Error(`fal could not make the track (${answered.status}): ${JSON.stringify(result.detail ?? result).slice(0, 200)}`);
    return this.keep(station, url, prompt);
  }

  /**
   * Puts a take made outside the station on it (note #765): the owner's
   * trial tracks were made by the station's own model and recipe, and are
   * not paid for twice. Same path as a made track — fetched, gaps cut and
   * checked, shaped, stored — but no try is spent and no order is owed.
   */
  async importTrack(station: RadioStationId, take: RadioImport): Promise<RadioTrackEntry> {
    let host = '';
    try {
      const url = new URL(take.url);
      if (url.protocol === 'https:') host = url.hostname;
    } catch { /* not an address */ }
    if (host !== 'fal.media' && !host.endsWith('.fal.media')) throw new RadioImportError('Only a take on fal\'s own file host can be put on air.');
    if (typeof take.prompt !== 'string' || !take.prompt.trim() || take.prompt.length > 1024) {
      throw new RadioImportError('Say what the take was asked for (up to 1,024 characters).');
    }
    if ((await this.options.storage.tracks()).some((track) => track.source === take.url)) {
      throw new RadioImportError('That take is on the station already.');
    }
    const track = await this.keep(station, take.url, take.prompt.trim(), take.url);
    this.log(`put "${track.title}" on ${station} from a take made outside the station (${Math.round(track.durationMs / 1000)} s)`);
    return track;
  }

  /** Fetches a made take, makes the station's MP3 of it and stores it. */
  private async keep(station: RadioStationId, url: string, prompt: string, source?: string): Promise<RadioTrackEntry> {
    const maker = RADIO_MAKERS[station];
    const download = await this.fetch(url);
    if (!download.ok) throw new Error(`the track could not be downloaded (${download.status})`);
    const made = Buffer.from(await download.arrayBuffer());
    if (made.length > MAX_TAKE_BYTES) throw new Error(`the track is ${made.length} bytes, more than a track should be`);
    const { mp3, durationMs, gapsCut } = await this.encode(made, maker.format);
    // Checked before anything is stored: a refused track leaves nothing behind.
    checkGaps(gapsCut);
    const id = randomUUID();
    const storagePath = `radio/tracks/${id}.mp3`;
    await this.options.media.uploadObject({ storagePath, contentType: 'audio/mpeg', data: mp3 });
    const taken = new Set((await this.options.storage.tracks()).map((track) => track.title));
    const track: RadioTrackEntry = {
      id, title: trackTitle(taken, this.random, station), durationMs, storagePath, sizeBytes: mp3.length,
      createdAt: new Date(this.now()).toISOString(), maker: maker.name, prompt, station, gapsCut,
      ...(source ? { source } : {}),
    };
    await this.options.storage.addTrack(track);
    return track;
  }
}
