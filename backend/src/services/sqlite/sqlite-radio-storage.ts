import { DEFAULT_RADIO_STATION, type RadioStationId } from '../../shared/radio.js';
import {
  RADIO_AIRINGS_KEPT,
  tidyWanted,
  withAttempt,
  type RadioAiringEntry,
  type RadioMakeAttempt,
  type RadioStorage,
  type RadioTrackEntry,
  type RadioWanted,
} from '../radio-storage.js';
import type { SqliteDb } from './sqlite-db.js';

/** Tracks are rows; each station's recent airings, the make attempts and the
 *  tracks still owed are one small document each in `radio_station`. */
export class SqliteRadioStorage implements RadioStorage {
  constructor(private readonly db: SqliteDb) {}
  private read<T>(docId: string, empty: T): T {
    const row = this.db.prepare('SELECT doc FROM radio_station WHERE doc_id = ?').get(docId) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as T : empty;
  }
  private save(docId: string, doc: unknown): void {
    this.db.prepare('INSERT INTO radio_station (doc_id, doc) VALUES (?, ?) ON CONFLICT (doc_id) DO UPDATE SET doc = excluded.doc')
      .run(docId, JSON.stringify(doc));
  }
  /** Lo-fi keeps the document the one station always had, so its chain runs
   *  on unbroken across the change to stations (note #761). */
  private airingsDoc(station: RadioStationId): string {
    return station === DEFAULT_RADIO_STATION ? 'airings' : `airings:${station}`;
  }
  async tracks(): Promise<RadioTrackEntry[]> {
    const rows = this.db.prepare('SELECT doc FROM radio_tracks').all() as { doc: string }[];
    return rows.map(({ doc }) => JSON.parse(doc) as RadioTrackEntry);
  }
  async addTrack(track: RadioTrackEntry): Promise<void> {
    this.db.prepare('INSERT INTO radio_tracks (track_id, doc) VALUES (?, ?) ON CONFLICT (track_id) DO UPDATE SET doc = excluded.doc')
      .run(track.id, JSON.stringify(track));
  }
  async retireTrack(trackId: string): Promise<void> {
    this.db.prepare('DELETE FROM radio_tracks WHERE track_id = ?').run(trackId);
  }
  async setRemoved(trackId: string, removedAt: string | null): Promise<RadioTrackEntry | null> {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT doc FROM radio_tracks WHERE track_id = ?').get(trackId) as { doc: string } | undefined;
      if (!row) return null;
      const { removedAt: _was, ...rest } = JSON.parse(row.doc) as RadioTrackEntry;
      const next: RadioTrackEntry = removedAt ? { ...rest, removedAt } : rest;
      this.db.prepare('UPDATE radio_tracks SET doc = ? WHERE track_id = ?').run(JSON.stringify(next), trackId);
      return next;
    }).immediate();
  }
  async changeAirings<T>(station: RadioStationId, update: (airings: RadioAiringEntry[]) => T): Promise<T> {
    const docId = this.airingsDoc(station);
    return this.db.transaction(() => {
      const airings = this.read<RadioAiringEntry[]>(docId, []);
      const answer = update(airings);
      this.save(docId, airings.slice(-RADIO_AIRINGS_KEPT));
      return answer;
    }).immediate();
  }
  async attempts(): Promise<RadioMakeAttempt[]> {
    return this.read<RadioMakeAttempt[]>('attempts', []);
  }
  async recordAttempt(attempt: RadioMakeAttempt): Promise<void> {
    this.db.transaction(() => {
      this.save('attempts', withAttempt(this.read<RadioMakeAttempt[]>('attempts', []), attempt));
    }).immediate();
  }
  async wanted(): Promise<RadioWanted> {
    return this.read<RadioWanted>('wanted', {});
  }
  async changeWanted<T>(update: (wanted: RadioWanted) => T): Promise<T> {
    return this.db.transaction(() => {
      const wanted = this.read<RadioWanted>('wanted', {});
      const answer = update(wanted);
      this.save('wanted', tidyWanted(wanted));
      return answer;
    }).immediate();
  }
}
