import { DEFAULT_RADIO_STATION, type RadioGapCut, type RadioStationId, type RadioTrack } from '../shared/radio.js';

/** A track as the platform keeps it: the public record plus where its bytes
 *  live and how it was made. Only `RadioTrack`'s fields ever leave the backend. */
export interface RadioTrackEntry extends RadioTrack {
  /** The station it plays on (note #761). Absent on every track made before
   *  there were stations: those are lo-fi's. */
  station?: RadioStationId;
  storagePath: string;
  sizeBytes: number;
  createdAt: string;
  /** The model that made it and what it was asked for, so a track that sounds
   *  wrong can be traced to its recipe. */
  maker: string;
  prompt: string;
  /** Dead air cut from inside it before it was saved (note #761). Absent on
   *  tracks made before that was counted. */
  gapsCut?: RadioGapCut[];
  /** Taken off the station by the platform operator (note #758), ISO. The
   *  record and its bytes stay, so it can be put back; it is never picked
   *  while this is set. */
  removedAt?: string;
  /** Where a take made outside the station came from, when the operator put
   *  one on it (note #765): the same take is never put on twice. */
  source?: string;
}

/** The station a track plays on. */
export const trackStation = (track: Pick<RadioTrackEntry, 'station'>): RadioStationId => track.station ?? DEFAULT_RADIO_STATION;

/** One slot on the station: this track, from this moment (epoch ms). */
export interface RadioAiringEntry {
  trackId: string;
  startsAt: number;
}

/** Every request to make a track, kept so a backend that restarts in a loop
 *  cannot keep paying for new tracks: the daily cap counts these, not memory. */
export interface RadioMakeAttempt {
  id: string;
  at: string;
  ok: boolean;
  /** The station it was for (note #761); absent on tries from before. */
  station?: RadioStationId;
  error?: string;
}

/** Tracks the operator asked for and the library has not made yet, by
 *  station (note #761). A station absent here wants none. */
export type RadioWanted = Partial<Record<RadioStationId, number>>;

export interface RadioStorage {
  tracks(): Promise<RadioTrackEntry[]>;
  addTrack(track: RadioTrackEntry): Promise<void>;
  /** Deletes a track's record. Its bytes are not touched. */
  retireTrack(trackId: string): Promise<void>;
  /** Marks a track removed from the rotation at `removedAt`, or puts it back
   *  with null. The changed record, or null for a track the library does
   *  not have. */
  setRemoved(trackId: string, removedAt: string | null): Promise<RadioTrackEntry | null>;
  /** One station's airings. The callback is synchronous and commits
   *  atomically, so two listeners arriving together cannot each append a
   *  different next track. */
  changeAirings<T>(station: RadioStationId, update: (airings: RadioAiringEntry[]) => T): Promise<T>;
  attempts(): Promise<RadioMakeAttempt[]>;
  /** Adds the attempt, or replaces the one with its id: an attempt is written
   *  when it starts and again when it ends. */
  recordAttempt(attempt: RadioMakeAttempt): Promise<void>;
  wanted(): Promise<RadioWanted>;
  /** Synchronous and atomic, like `changeAirings`: an order and a finished
   *  track landing together both count. */
  changeWanted<T>(update: (wanted: RadioWanted) => T): Promise<T>;
}

export function withAttempt(attempts: RadioMakeAttempt[], attempt: RadioMakeAttempt): RadioMakeAttempt[] {
  const index = attempts.findIndex((held) => held.id === attempt.id);
  const next = index < 0 ? [...attempts, attempt] : attempts.map((held, at) => (at === index ? attempt : held));
  return next.slice(-RADIO_ATTEMPTS_KEPT);
}

/** Drops the stations that want nothing, so the record says only what is owed. */
export function tidyWanted(wanted: RadioWanted): RadioWanted {
  return Object.fromEntries(Object.entries(wanted).filter(([, count]) => (count ?? 0) > 0)) as RadioWanted;
}

/** The station only ever needs its recent past: what is on, what is next and
 *  what aired lately enough not to repeat. */
export const RADIO_AIRINGS_KEPT = 50;
export const RADIO_ATTEMPTS_KEPT = 100;

export class InMemoryRadioStorage implements RadioStorage {
  private readonly library = new Map<string, RadioTrackEntry>();
  private readonly airings = new Map<RadioStationId, RadioAiringEntry[]>();
  private tried: RadioMakeAttempt[] = [];
  private owed: RadioWanted = {};
  async tracks(): Promise<RadioTrackEntry[]> {
    return structuredClone([...this.library.values()]);
  }
  async addTrack(track: RadioTrackEntry): Promise<void> {
    this.library.set(track.id, structuredClone(track));
  }
  async retireTrack(trackId: string): Promise<void> {
    this.library.delete(trackId);
  }
  async setRemoved(trackId: string, removedAt: string | null): Promise<RadioTrackEntry | null> {
    const held = this.library.get(trackId);
    if (!held) return null;
    const { removedAt: _was, ...rest } = held;
    const next: RadioTrackEntry = removedAt ? { ...rest, removedAt } : rest;
    this.library.set(trackId, next);
    return structuredClone(next);
  }
  async changeAirings<T>(station: RadioStationId, update: (airings: RadioAiringEntry[]) => T): Promise<T> {
    const airings = structuredClone(this.airings.get(station) ?? []);
    const answer = update(airings);
    this.airings.set(station, structuredClone(airings.slice(-RADIO_AIRINGS_KEPT)));
    return answer;
  }
  async attempts(): Promise<RadioMakeAttempt[]> {
    return structuredClone(this.tried);
  }
  async recordAttempt(attempt: RadioMakeAttempt): Promise<void> {
    this.tried = withAttempt(this.tried, structuredClone(attempt));
  }
  async wanted(): Promise<RadioWanted> {
    return structuredClone(this.owed);
  }
  async changeWanted<T>(update: (wanted: RadioWanted) => T): Promise<T> {
    const wanted = structuredClone(this.owed);
    const answer = update(wanted);
    this.owed = tidyWanted(wanted);
    return answer;
  }
}
