import {
  RADIO_STATIONS,
  type RadioAiring,
  type RadioAnswer,
  type RadioLibraryAnswer,
  type RadioStationAnswer,
  type RadioStationId,
} from '../shared/radio.js';
import type { MediaStorage } from './media-storage.js';
import { RADIO_MAX_ATTEMPTS_PER_DAY, RADIO_MAX_ORDER, radioRecipe, triesToday, type RadioImport } from './radio-library.js';
import { trackStation, type RadioAiringEntry, type RadioStorage, type RadioTrackEntry } from './radio-storage.js';

/** A station nobody has asked about for this long starts afresh at the moment
 *  someone does, rather than replaying the hours it was silent. */
export const RADIO_RESTART_AFTER_MS = 30 * 60_000;
/** How many of the latest airings a pick avoids, so a small library still
 *  goes round before anything comes back (never more than the library minus one). */
export const RADIO_NO_REPEAT = 10;
/** Signed track addresses live this long; the hop to them is cached for less. */
const TRACK_URL_TTL_MS = 2 * 60 * 60_000;

const endOf = (airing: RadioAiringEntry, tracks: Map<string, RadioTrackEntry>): number =>
  airing.startsAt + (tracks.get(airing.trackId)?.durationMs ?? 0);

/** A track the station may pick: one the operator has not removed (note #758). */
const inRotation = (track: RadioTrackEntry): boolean => !track.removedAt;

/** The next track: any in the rotation that did not air among the latest
 *  few, at random. */
export function pickNext(airings: RadioAiringEntry[], tracks: Map<string, RadioTrackEntry>, random: () => number): string {
  const ids = [...tracks.values()].filter(inRotation).map((track) => track.id).sort();
  const avoid = new Set(airings.slice(-Math.min(RADIO_NO_REPEAT, ids.length - 1)).map((airing) => airing.trackId));
  const open = ids.filter((id) => !avoid.has(id));
  const pool = open.length ? open : ids;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}

/**
 * Brings the station's airings up to `now`, in place: one track on air now
 * and one queued after it. Consecutive airings touch end to start, so everyone
 * who plays them in order stays on the same beat. Nothing is aired for a
 * station nobody is listening to, so a long silence restarts the chain at
 * `now` instead of filling it in. Calling it again with the same `now`
 * changes nothing.
 */
export function extendAirings(
  airings: RadioAiringEntry[],
  tracks: Map<string, RadioTrackEntry>,
  now: number,
  random: () => number,
): void {
  const end = (airing: RadioAiringEntry) => endOf(airing, tracks);
  const onAir = (airing: RadioAiringEntry) => airing.startsAt <= now && now < end(airing);
  const append = (startsAt: number) => airings.push({ trackId: pickNext(airings, tracks, random), startsAt });
  // A track the library no longer has cannot be played; the chain resumes
  // without it. A removed one (note #758) that has not started yet never
  // will: the slot after the track on air is picked again below. One already
  // on air plays to its end, so nobody listening is cut off mid-track.
  airings.splice(0, airings.length, ...airings.filter((airing) => {
    const track = tracks.get(airing.trackId);
    return track && (inRotation(track) || airing.startsAt <= now);
  }));
  if (![...tracks.values()].some(inRotation)) return;
  if (!airings.some(onAir)) {
    // Airings still ahead with none on air mean the clock stepped back: they
    // never aired, and keeping them would leave a hole before them.
    while (airings.length && airings.at(-1)!.startsAt > now) airings.pop();
    const last = airings.at(-1);
    if (!last || end(last) + RADIO_RESTART_AFTER_MS < now) append(now);
    // Catch up over a short quiet spell, so a listener whose track just
    // ended moves on to the next one exactly where it starts.
    for (let guard = 0; end(airings.at(-1)!) <= now && guard < 10_000; guard += 1) append(end(airings.at(-1)!));
  }
  if (airings.findIndex(onAir) === airings.length - 1) append(end(airings.at(-1)!));
}

export class RadioStation {
  constructor(
    private readonly storage: RadioStorage,
    private readonly media: MediaStorage,
    private readonly random: () => number = Math.random,
    /** Called when the operator orders tracks, so the maker starts on them
     *  now rather than at its next hourly check. */
    private readonly wake: () => void = () => {},
    /** The maker's own take import (note #765); absent where nothing can be
     *  made, and then a take cannot be put on either. */
    private readonly importer?: (station: RadioStationId, take: RadioImport) => Promise<unknown>,
  ) {}

  /**
   * Every station's on air and next, each brought up to date on its own
   * chain (note #761): a station's airings only ever name its own tracks, so
   * everyone tuned to it hears the same track at the same moment, whatever
   * the other station is playing. The top level is the first station's, as
   * the one-station answer was.
   */
  async answer(now = Date.now()): Promise<RadioAnswer> {
    const library = await this.storage.tracks();
    const stations: RadioStationAnswer[] = [];
    for (const station of RADIO_STATIONS) {
      const tracks = new Map(library.filter((track) => trackStation(track) === station.id).map((track) => [track.id, track]));
      const airings = await this.storage.changeAirings(station.id, (held) => {
        extendAirings(held, tracks, now, this.random);
        return [...held];
      });
      const at = airings.findIndex((airing) => airing.startsAt <= now && now < endOf(airing, tracks));
      const airing = (index: number): RadioAiring | null => {
        const entry = index >= 0 ? airings[index] : undefined;
        const track = entry && tracks.get(entry.trackId);
        return entry && track
          ? { track: { id: track.id, title: track.title, durationMs: track.durationMs }, startsAt: new Date(entry.startsAt).toISOString() }
          : null;
      };
      stations.push({
        station: { id: station.id, name: station.name, style: station.style },
        now: airing(at),
        next: at >= 0 ? airing(at + 1) : null,
      });
    }
    return { ...stations[0]!, stations, serverNow: new Date(now).toISOString() };
  }

  /**
   * Every track of every station, for the platform operator's library page
   * (note #758): newest first, each with its station and the recipe it was
   * made to, and each station's on air and next exactly as a listener would
   * be told — the read brings the schedules up to date like any listener's
   * does — and the tracks it still has to make.
   */
  async library(now = Date.now()): Promise<RadioLibraryAnswer> {
    const answer = await this.answer(now);
    const tracks = (await this.storage.tracks())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const wanted = await this.storage.wanted();
    return {
      stations: answer.stations.map(({ station, now: onAir, next }) => ({
        station, onAirId: onAir?.track.id ?? null, nextId: next?.track.id ?? null, wanted: wanted[station.id] ?? 0,
      })),
      tracks: tracks.map((track) => ({
        id: track.id, title: track.title, durationMs: track.durationMs, station: trackStation(track), createdAt: track.createdAt,
        recipe: radioRecipe(track.prompt),
        ...(track.removedAt ? { removedAt: track.removedAt } : {}),
        ...(track.gapsCut ? { gapsCut: track.gapsCut } : {}),
      })),
      triesToday: triesToday(await this.storage.attempts(), now),
      triesPerDay: RADIO_MAX_ATTEMPTS_PER_DAY,
    };
  }

  /**
   * Takes a track out of the rotation, or puts it back (note #758), and
   * answers with the library as it stands afterwards. Reading it brings the
   * schedule up to date in the same step, so a removed track that was queued
   * next is replaced at once; one on air plays to its end. Removing a track
   * twice keeps the first time. Null for a track the library does not have.
   */
  async setRemoved(trackId: string, removed: boolean, now = Date.now()): Promise<RadioLibraryAnswer | null> {
    const held = (await this.storage.tracks()).find((candidate) => candidate.id === trackId);
    if (!held) return null;
    if (Boolean(held.removedAt) !== removed) {
      await this.storage.setRemoved(trackId, removed ? new Date(now).toISOString() : null);
    }
    return this.library(now);
  }

  /**
   * The operator's order for `count` more tracks on a station (note #761):
   * added to what it already owes, never more than `RADIO_MAX_ORDER` at a
   * time, and the maker woken to start on them. The day's tries still bound
   * what is spent. Answers with the library, which says what is owed.
   */
  async order(station: RadioStationId, count: number, now = Date.now()): Promise<RadioLibraryAnswer> {
    if (!Number.isInteger(count) || count < 1 || count > RADIO_MAX_ORDER) {
      throw new RangeError(`Ask for between 1 and ${RADIO_MAX_ORDER} tracks at a time.`);
    }
    await this.storage.changeWanted((wanted) => { wanted[station] = (wanted[station] ?? 0) + count; });
    this.wake();
    return this.library(now);
  }

  /**
   * Puts a take made outside the station on it (note #765) and answers with
   * the library, the new track in it. Throws `RadioImportError` for a take
   * that cannot go on, and a plain error when the station cannot make or
   * fetch anything right now.
   */
  async importTake(station: RadioStationId, take: RadioImport, now = Date.now()): Promise<RadioLibraryAnswer> {
    if (!this.importer) throw new Error('nothing can be made here');
    await this.importer(station, take);
    return this.library(now);
  }

  /** A short-lived address for one track's bytes, or null for a track the
   *  library does not have. A removed track keeps its address: it may still
   *  be on air, and the operator's page plays it to decide on putting it back. */
  async trackUrl(trackId: string): Promise<string | null> {
    const track = (await this.storage.tracks()).find((candidate) => candidate.id === trackId);
    if (!track) return null;
    const access = await this.media.createReadAccess({
      storagePath: track.storagePath,
      expiresInMs: TRACK_URL_TTL_MS,
      responseDisposition: 'inline',
    });
    return access.url;
  }
}
