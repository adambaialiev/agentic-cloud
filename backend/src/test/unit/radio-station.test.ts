import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRadioStorage, type RadioAiringEntry, type RadioStorage, type RadioTrackEntry } from '../../services/radio-storage.js';
import { RADIO_RESTART_AFTER_MS, RadioStation, extendAirings, pickNext } from '../../services/radio-station.js';
import { SqliteRadioStorage } from '../../services/sqlite/sqlite-radio-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MediaStorage } from '../../services/media-storage.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-10T12:00:00.000Z');

function track(id: string, minutes = 3): RadioTrackEntry {
  return {
    id, title: `Title ${id}`, durationMs: minutes * MINUTE, storagePath: `radio/tracks/${id}.mp3`, sizeBytes: 1,
    createdAt: '2026-10-10T00:00:00.000Z', maker: 'test', prompt: 'test',
  };
}
const library = (...entries: RadioTrackEntry[]) => new Map(entries.map((entry) => [entry.id, entry]));
/** A random source that walks a fixed list, so every pick is known. */
const sequence = (...values: number[]) => { let at = 0; return () => values[at++ % values.length]!; };

describe('the station schedule', () => {
  it('starts a fresh chain at the moment someone first asks, with the next track queued', () => {
    const airings: RadioAiringEntry[] = [];
    extendAirings(airings, library(track('a'), track('b')), T0, sequence(0));
    expect(airings).toEqual([{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }]);
  });

  it('changes nothing while the track on air already has one queued after it', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    extendAirings(airings, library(track('a'), track('b')), T0 + MINUTE, sequence(0));
    expect(airings).toHaveLength(2);
  });

  it('queues the following track once the next one is on air, end to start', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    extendAirings(airings, library(track('a'), track('b')), T0 + 4 * MINUTE, sequence(0));
    expect(airings.at(-1)).toEqual({ trackId: 'a', startsAt: T0 + 6 * MINUTE });
  });

  it('catches up across a short silence without a gap, so late listeners stay on the beat', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    extendAirings(airings, library(track('a'), track('b')), T0 + 10 * MINUTE, sequence(0));
    const starts = airings.map((airing) => airing.startsAt - T0);
    expect(starts).toEqual([0, 3, 6, 9, 12].map((minutes) => minutes * MINUTE));
  });

  it('restarts at the moment of asking after a long silence instead of filling it in', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    const later = T0 + 6 * MINUTE + RADIO_RESTART_AFTER_MS + 1;
    extendAirings(airings, library(track('a'), track('b')), later, sequence(0));
    expect(airings.slice(2).map((airing) => airing.startsAt)).toEqual([later, later + 3 * MINUTE]);
  });

  it('drops airings left in the future by a clock that stepped back', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    extendAirings(airings, library(track('a'), track('b')), T0 - 60 * MINUTE, sequence(0));
    expect(airings[0]!.startsAt).toBe(T0 - 60 * MINUTE);
    expect(airings).toHaveLength(2);
  });

  it('goes round the whole of a small library before anything repeats', () => {
    const tracks = library(track('a'), track('b'), track('c'));
    const airings: RadioAiringEntry[] = [];
    for (let minute = 0; minute < 30; minute += 3) extendAirings(airings, tracks, T0 + minute * MINUTE, Math.random);
    for (let at = 2; at < airings.length; at += 1) {
      expect(new Set(airings.slice(at - 2, at + 1).map((airing) => airing.trackId)).size).toBe(3);
    }
  });

  it('plays the only track again and again when that is all there is', () => {
    expect(pickNext([{ trackId: 'a', startsAt: T0 }], library(track('a')), Math.random)).toBe('a');
  });

  it('forgets an airing whose track the library no longer has', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'gone', startsAt: T0 }];
    extendAirings(airings, library(track('a')), T0 + MINUTE, sequence(0));
    expect(airings.map((airing) => airing.trackId)).toEqual(['a', 'a']);
  });

  it('never picks a track the operator removed (note #758)', () => {
    const tracks = library(track('a'), { ...track('b'), removedAt: '2026-10-15T00:00:00.000Z' }, track('c'));
    const airings: RadioAiringEntry[] = [];
    for (let minute = 0; minute < 300; minute += 3) extendAirings(airings, tracks, T0 + minute * MINUTE, Math.random);
    expect(airings.length).toBeGreaterThan(90);
    expect(airings.map((airing) => airing.trackId)).not.toContain('b');
    for (const value of [0, 0.4, 0.6, 0.999]) expect(pickNext([], tracks, () => value)).not.toBe('b');
  });

  it('replaces a removed track queued next at once, before it ever comes on', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    const removed = library(track('a'), { ...track('b'), removedAt: '2026-10-15T00:00:00.000Z' }, track('c'));
    extendAirings(airings, removed, T0 + MINUTE, sequence(0));
    expect(airings).toEqual([{ trackId: 'a', startsAt: T0 }, { trackId: 'c', startsAt: T0 + 3 * MINUTE }]);
  });

  it('lets a removed track that is on air play to its end, then moves on', () => {
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }];
    const removed = library({ ...track('a'), removedAt: '2026-10-15T00:00:00.000Z' }, track('b'), track('c'));
    extendAirings(airings, removed, T0 + MINUTE, sequence(0));
    expect(airings).toEqual([{ trackId: 'a', startsAt: T0 }, { trackId: 'b', startsAt: T0 + 3 * MINUTE }]);
    extendAirings(airings, removed, T0 + 4 * MINUTE, sequence(0.9));
    expect(airings.at(-1)).toEqual({ trackId: 'c', startsAt: T0 + 6 * MINUTE });
  });

  it('airs nothing new once every track is removed, and lets the one on air finish', () => {
    const removedAt = '2026-10-15T00:00:00.000Z';
    const airings: RadioAiringEntry[] = [{ trackId: 'a', startsAt: T0 }];
    extendAirings(airings, library({ ...track('a'), removedAt }, { ...track('b'), removedAt }), T0 + MINUTE, Math.random);
    expect(airings).toEqual([{ trackId: 'a', startsAt: T0 }]);
    extendAirings(airings, library({ ...track('a'), removedAt }, { ...track('b'), removedAt }), T0 + 4 * MINUTE, Math.random);
    expect(airings).toEqual([{ trackId: 'a', startsAt: T0 }]);
  });

  it('airs nothing from an empty library', () => {
    const airings: RadioAiringEntry[] = [];
    extendAirings(airings, new Map(), T0, Math.random);
    expect(airings).toEqual([]);
  });
});

const media = {
  createReadAccess: async ({ storagePath }: { storagePath: string }) => ({ url: `https://media.test/${storagePath}?signed`, expiresAt: 'x' }),
} as unknown as MediaStorage;

describe.each([
  ['in memory', () => ({ storage: new InMemoryRadioStorage() as RadioStorage, close: () => {} })],
  ['SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radio-'));
    const db: SqliteDb = openSqliteDb(join(dir, 'radio.db'));
    return { storage: new SqliteRadioStorage(db) as RadioStorage, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
  }],
])('the station answer (%s)', (_name, open) => {
  let held: ReturnType<typeof open>;
  beforeEach(() => { held = open(); });
  afterEach(() => held.close());

  it('says nothing is on while the library is empty', async () => {
    const answer = await new RadioStation(held.storage, media).answer(T0);
    expect(answer).toMatchObject({ now: null, next: null, serverNow: new Date(T0).toISOString(), station: { id: 'lofi', name: 'Cozy lo-fi' } });
    expect(answer.stations.map((one) => [one.station.id, one.now])).toEqual([['lofi', null], ['urban', null]]);
  });

  it('tells two listeners the same track and the same start, and only public fields', async () => {
    await held.storage.addTrack(track('a'));
    await held.storage.addTrack(track('b'));
    const station = new RadioStation(held.storage, media, sequence(0.9, 0.1));
    const first = await station.answer(T0);
    const second = await station.answer(T0 + 30_000);
    expect(second.now).toEqual(first.now);
    expect(second.next).toEqual(first.next);
    expect(first.now).toEqual({ track: { id: 'b', title: 'Title b', durationMs: 3 * MINUTE }, startsAt: new Date(T0).toISOString() });
    expect(first.next?.startsAt).toBe(new Date(T0 + 3 * MINUTE).toISOString());
    expect(JSON.stringify(first)).not.toContain('radio/tracks');
  });

  it('keeps only the recent past', async () => {
    await held.storage.addTrack(track('a', 1));
    const station = new RadioStation(held.storage, media);
    for (let minute = 0; minute < 120; minute += 1) await station.answer(T0 + minute * MINUTE);
    expect(await held.storage.changeAirings('lofi', (airings) => airings.length)).toBeLessThanOrEqual(50);
  });

  it('takes a retired track off the station', async () => {
    await held.storage.addTrack(track('a'));
    await held.storage.addTrack(track('b'));
    await held.storage.retireTrack('a');
    expect((await held.storage.tracks()).map((entry) => entry.id)).toEqual(['b']);
    const answer = await new RadioStation(held.storage, media).answer(T0);
    expect([answer.now?.track.id, answer.next?.track.id]).toEqual(['b', 'b']);
  });

  it('marks a track removed and puts it back, keeping the record, and knows no other', async () => {
    await held.storage.addTrack(track('a'));
    expect(await held.storage.setRemoved('a', '2026-10-15T10:00:00.000Z')).toMatchObject({ id: 'a', removedAt: '2026-10-15T10:00:00.000Z' });
    expect((await held.storage.tracks())[0]!.removedAt).toBe('2026-10-15T10:00:00.000Z');
    const back = await held.storage.setRemoved('a', null);
    expect(back).toEqual(track('a'));
    expect(await held.storage.tracks()).toEqual([track('a')]);
    expect(await held.storage.setRemoved('nope', '2026-10-15T10:00:00.000Z')).toBeNull();
  });

  it('lists the whole library for the operator, newest first, with the recipe and what is on air', async () => {
    const prompt = 'Lo-fi hip-hop beat for focus, late-night mood, 82 BPM, D minor, dusty swung drums, soft vibraphone melody, no vocals';
    await held.storage.addTrack({ ...track('old'), createdAt: '2026-10-11T08:00:00.000Z', prompt });
    await held.storage.addTrack({ ...track('new'), createdAt: '2026-10-11T09:00:00.000Z' });
    const station = new RadioStation(held.storage, media, sequence(0, 0));
    const answer = await station.library(T0);
    expect(answer.tracks.map((entry) => entry.id)).toEqual(['new', 'old']);
    expect(answer.tracks[1]).toEqual({
      id: 'old', title: 'Title old', durationMs: 3 * MINUTE, station: 'lofi', createdAt: '2026-10-11T08:00:00.000Z',
      recipe: { mood: 'late-night', lead: 'vibraphone', bpm: 82, key: 'D minor' },
    });
    expect(answer.stations).toEqual([
      { station: { id: 'lofi', name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' }, onAirId: 'new', nextId: 'old', wanted: 0 },
      { station: { id: 'urban', name: 'Urban beats', style: 'Urban hip-hop' }, onAirId: null, nextId: null, wanted: 0 },
    ]);
    expect(answer).toMatchObject({ triesToday: 0, triesPerDay: 90 });
    expect(JSON.stringify(answer)).not.toContain('radio/tracks');
  });

  it('removes the track queued next at once and puts it back on request, without touching what is on air', async () => {
    for (const id of ['a', 'b', 'c']) await held.storage.addTrack(track(id));
    const station = new RadioStation(held.storage, media, sequence(0, 0.4, 0.9));
    const before = await station.answer(T0);
    expect([before.now?.track.id, before.next?.track.id]).toEqual(['a', 'b']);
    const removed = await station.setRemoved('b', true, T0 + MINUTE);
    expect(removed?.tracks.find((entry) => entry.id === 'b')?.removedAt).toBe(new Date(T0 + MINUTE).toISOString());
    expect([removed?.stations[0]!.onAirId, removed?.stations[0]!.nextId]).toEqual(['a', 'c']);
    const listener = await station.answer(T0 + 2 * MINUTE);
    expect(listener.now).toEqual(before.now);
    expect(listener.next?.track.id).toBe('c');
    // A second remove keeps the first time; a put-back clears it.
    const again = await station.setRemoved('b', true, T0 + 2 * MINUTE);
    expect(again?.tracks.find((entry) => entry.id === 'b')?.removedAt).toBe(new Date(T0 + MINUTE).toISOString());
    const back = await station.setRemoved('b', false, T0 + 2 * MINUTE);
    expect(back?.tracks.find((entry) => entry.id === 'b')).not.toHaveProperty('removedAt');
    expect(await station.setRemoved('nope', true, T0)).toBeNull();
  });

  it('plays each station from its own tracks on its own chain, and every track from before is lo-fi\'s (note #761)', async () => {
    for (const id of ['a', 'b']) await held.storage.addTrack(track(id));
    for (const id of ['x', 'y']) await held.storage.addTrack({ ...track(id, 1.5), station: 'urban' });
    const station = new RadioStation(held.storage, media, Math.random);
    for (let minute = 0; minute < 60; minute += 1) {
      const answer = await station.answer(T0 + minute * MINUTE);
      const [lofi, city] = answer.stations;
      expect([lofi!.now?.track.id, lofi!.next?.track.id].every((id) => id === 'a' || id === 'b')).toBe(true);
      expect([city!.now?.track.id, city!.next?.track.id].every((id) => id === 'x' || id === 'y')).toBe(true);
      // The top level is lo-fi, as the one-station answer was.
      expect(answer.now).toEqual(lofi!.now);
    }
    // Two listeners on the same station hear the same thing at the same moment.
    const one = await station.answer(T0 + 61 * MINUTE);
    const two = await station.answer(T0 + 61 * MINUTE + 20_000);
    expect(two.stations[1]!.now).toEqual(one.stations[1]!.now);
    expect(two.stations[0]!.now).toEqual(one.stations[0]!.now);
    // Each chain keeps its own record: lo-fi's is the one it always had.
    expect(await held.storage.changeAirings('urban', (airings) => airings.every((airing) => ['x', 'y'].includes(airing.trackId)))).toBe(true);
    expect(await held.storage.changeAirings('lofi', (airings) => airings.every((airing) => ['a', 'b'].includes(airing.trackId)))).toBe(true);
  });

  it('plays lo-fi while urban has nothing yet', async () => {
    await held.storage.addTrack(track('a'));
    const answer = await new RadioStation(held.storage, media).answer(T0);
    expect([answer.stations[0]!.now?.track.id, answer.stations[1]!.now]).toEqual(['a', null]);
  });

  it('takes the operator\'s order for tracks, adds it to what is owed and wakes the maker', async () => {
    let woken = 0;
    const station = new RadioStation(held.storage, media, Math.random, () => { woken += 1; });
    expect((await station.order('urban', 5, T0)).stations[1]!.wanted).toBe(5);
    expect((await station.order('urban', 2, T0)).stations[1]!.wanted).toBe(7);
    expect(await held.storage.wanted()).toEqual({ urban: 7 });
    expect(woken).toBe(2);
    for (const count of [0, -1, 1.5, 51, Number.NaN]) await expect(station.order('urban', count, T0)).rejects.toThrow(RangeError);
    expect(woken).toBe(2);
    await held.storage.changeWanted((wanted) => { wanted.urban = 0; });
    expect(await held.storage.wanted()).toEqual({});
  });

  it('still signs an address for a removed track, which may be on air', async () => {
    await held.storage.addTrack({ ...track('a'), removedAt: '2026-10-15T00:00:00.000Z' });
    expect(await new RadioStation(held.storage, media).trackUrl('a')).toBe('https://media.test/radio/tracks/a.mp3?signed');
  });

  it('signs an address for a track it has, and none for one it does not', async () => {
    await held.storage.addTrack(track('a'));
    const station = new RadioStation(held.storage, media);
    expect(await station.trackUrl('a')).toBe('https://media.test/radio/tracks/a.mp3?signed');
    expect(await station.trackUrl('nope')).toBeNull();
  });

  it('keeps make attempts by id, replacing an unfinished one when it ends', async () => {
    await held.storage.recordAttempt({ id: 'x', at: '2026-10-10T00:00:00.000Z', ok: false, error: 'unfinished' });
    await held.storage.recordAttempt({ id: 'x', at: '2026-10-10T00:00:00.000Z', ok: true });
    await held.storage.recordAttempt({ id: 'y', at: '2026-10-10T01:00:00.000Z', ok: false, error: 'locked' });
    expect(await held.storage.attempts()).toEqual([
      { id: 'x', at: '2026-10-10T00:00:00.000Z', ok: true },
      { id: 'y', at: '2026-10-10T01:00:00.000Z', ok: false, error: 'locked' },
    ]);
  });
});
