import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioAnswer } from '../../../src/shared/radio.js';
import { App } from '../App.js';
import { WorkspaceApiError } from '../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../test/fixtures.js';
import { joinAt, onAirAt, airingAfter } from './radio-sync.js';

const SECOND = 1000;
const org = { orgId: 'org-1', name: 'Nomad Trading', role: 'admin' as const, members: 1, seats: 1, seatProviders: ['claude' as const] };

const LOFI = { id: 'lofi' as const, name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' };
const URBAN = { id: 'urban' as const, name: 'Urban beats', style: 'Urban hip-hop' };

/** The radio `into` seconds into lo-fi's first track of three minutes, as the
 *  server would say it — and, when asked, urban `into` seconds into one of its own. */
function station(into: number, ids: [string, string] = ['grey', 'orbit'], urban = false): RadioAnswer {
  const now = Date.now();
  const start = now - into * SECOND;
  const lofi = {
    station: LOFI,
    now: { track: { id: ids[0], title: 'Dusty Notebook', durationMs: 180 * SECOND }, startsAt: new Date(start).toISOString() },
    next: { track: { id: ids[1], title: 'Rainy Window', durationMs: 180 * SECOND }, startsAt: new Date(start + 180 * SECOND).toISOString() },
  };
  const city = urban
    ? {
      station: URBAN,
      now: { track: { id: 'brick', title: 'Concrete Bounce', durationMs: 90 * SECOND }, startsAt: new Date(start).toISOString() },
      next: { track: { id: 'neon', title: 'Neon Strut', durationMs: 90 * SECOND }, startsAt: new Date(start + 90 * SECOND).toISOString() },
    }
    : { station: URBAN, now: null, next: null };
  return { ...lofi, stations: [lofi, city], serverNow: new Date(now).toISOString() };
}

/** The radio element, caught as it is made: it is never put in the document. */
function speakers() {
  const made: HTMLAudioElement[] = [];
  const played: HTMLMediaElement[] = [];
  const Real = window.Audio;
  const fake = function Audio() { const element = new Real(); made.push(element); return element; } as unknown as typeof Audio;
  window.Audio = fake;
  let refuse: string | null = null;
  const spies = [
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      played.push(this);
      if (refuse) { const name = refuse; refuse = null; return Promise.reject(Object.assign(new Error(name), { name })); }
      return Promise.resolve();
    }),
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}),
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}),
  ];
  return {
    made, played, pauses: spies[1]!,
    refuseNext: (name: string) => { refuse = name; },
    restore: () => { window.Audio = Real; for (const spy of spies) spy.mockRestore(); },
  };
}

function open(path: string, radio: Answer, hasRadio = true) {
  const test = scriptedApi({ ...workspaceScript(() => emptyState({ org, radio: hasRadio })), 'GET api/radio': radio });
  render(<MemoryRouter initialEntries={[path]}><App api={test.api} /></MemoryRouter>);
  return test;
}
const radioReads = (calls: { path: string }[]) => calls.filter((call) => call.path === 'api/radio').length;

describe('the work radio in the Workspace', () => {
  let sound: ReturnType<typeof speakers>;
  beforeEach(() => { sound = speakers(); });
  // Unmounted first: the radio pauses its element as it goes.
  afterEach(() => { cleanup(); sound.restore(); window.localStorage.clear(); });

  it('never asks about a station on a backend that has none, so nothing can fail', async () => {
    const none = open('/notes', () => station(5), false);
    await screen.findByText('Notes', { selector: 'h1' });
    await waitFor(() => expect(none.calls.some((call) => call.path === 'api/state')).toBe(true));
    expect(radioReads(none.calls)).toBe(0);
    expect(screen.queryByRole('button', { name: /work radio/ })).toBeNull();
  });

  it('shows no button when the station cannot be read', async () => {
    const gone = open('/notes', () => { throw new WorkspaceApiError('There is no radio here.', 404, {}); });
    await waitFor(() => expect(radioReads(gone.calls)).toBe(1));
    await screen.findByText('Notes', { selector: 'h1' });
    expect(screen.queryByRole('button', { name: /work radio/ })).toBeNull();
  });

  it('stays away while the library is still empty', async () => {
    const empty = open('/notes', () => {
      const answer = station(0);
      return { ...answer, now: null, next: null, stations: answer.stations.map((one) => ({ ...one, now: null, next: null })) };
    });
    await waitFor(() => expect(radioReads(empty.calls)).toBe(1));
    await screen.findByText('Notes', { selector: 'h1' });
    expect(screen.queryByRole('button', { name: /work radio/ })).toBeNull();
  });

  it('joins the station live on the press, and the press itself starts the sound', async () => {
    open('/notes', () => station(47));
    const play = await screen.findByRole('button', { name: 'Play work radio' });
    expect(play.textContent).toBe('Radio');
    expect(play.getAttribute('aria-pressed')).toBe('false');
    expect(play.getAttribute('title')).toBe('Work radio · Cozy lo-fi');
    // One station with something on air: no station picker.
    expect(screen.queryByRole('button', { name: /Choose a station/ })).toBeNull();

    fireEvent.click(play);
    // Nothing is asked for between the press and play(): a phone would not
    // count a play after an await as the listener pressing.
    expect(sound.played).toHaveLength(1);
    const player = sound.made[0]!;
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/grey/audio');
    const pause = screen.getByRole('button', { name: 'Pause work radio' });
    expect(pause.textContent).toBe('Dusty Notebook');
    expect(pause.getAttribute('aria-pressed')).toBe('true');
    expect(pause.getAttribute('aria-busy')).toBe('true');

    // Once the element knows the track, it is moved to where the station is.
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBeGreaterThanOrEqual(47);
    expect(player.currentTime).toBeLessThan(49);
    fireEvent.playing(player);
    expect(pause.getAttribute('aria-busy')).toBeNull();
  });

  it('hands over to the next track on the same element and reads the station again', async () => {
    const test = open('/notes', () => station(5));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    const player = sound.made[0]!;
    await waitFor(() => expect(radioReads(test.calls)).toBe(1));
    fireEvent.ended(player);
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/orbit/audio');
    expect(sound.played).toEqual([player, player]);
    expect(screen.getByRole('button', { name: 'Pause work radio' }).textContent).toBe('Rainy Window');
    await waitFor(() => expect(radioReads(test.calls)).toBe(2));
  });

  it('follows the station when the track it was about to play was taken off it (note #758)', async () => {
    const first = station(5);
    const lofi = {
      station: first.station,
      now: { track: { id: 'amber', title: 'Amber Walk', durationMs: 180 * SECOND }, startsAt: first.next!.startsAt },
      next: null,
    };
    const replaced: RadioAnswer = { ...lofi, stations: [lofi, first.stations[1]!], serverNow: first.next!.startsAt };
    let reads = 0;
    const test = open('/notes', () => (reads++ === 0 ? first : replaced));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    const player = sound.made[0]!;
    await waitFor(() => expect(radioReads(test.calls)).toBe(1));
    fireEvent.ended(player);
    // The handover itself never waits on the server…
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/orbit/audio');
    // …and the read right after it puts the station's own choice on.
    await waitFor(() => expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/amber/audio'));
    expect(sound.made).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Pause work radio' }).textContent).toBe('Amber Walk');
  });

  it('lets a listener pick the station, plays it from that tap, and remembers the choice (note #761)', async () => {
    open('/notes', () => station(30, ['grey', 'orbit'], true));
    const pick = await screen.findByRole('button', { name: 'Choose a station: Cozy lo-fi' });
    expect(pick.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(pick);
    const menu = await screen.findByRole('menu', { name: 'Radio stations' });
    const rows = within(menu).getAllByRole('menuitemradio');
    expect(rows.map((row) => row.querySelector('.orgmenuname')!.textContent)).toEqual(['Cozy lo-fi', 'Urban beats']);
    expect(rows.map((row) => row.querySelector('.orgmenufacts')!.textContent)).toEqual(['Dusty Notebook', 'Concrete Bounce']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    fireEvent.click(rows[1]!);
    // The tap that chose it starts it, with nothing asked of the server first.
    expect(sound.played).toHaveLength(1);
    const player = sound.made[0]!;
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/brick/audio');
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBeGreaterThanOrEqual(30);
    expect(screen.getByRole('button', { name: 'Pause work radio' }).textContent).toBe('Concrete Bounce');
    expect(screen.getByRole('button', { name: 'Choose a station: Urban beats' })).toBeTruthy();
    expect(window.localStorage.getItem('workspace.radio.station')).toBe('urban');

    // Its handover stays on its own station.
    fireEvent.ended(player);
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/neon/audio');

    // Back to lo-fi, playing at once on the same element.
    fireEvent.click(screen.getByRole('button', { name: 'Choose a station: Urban beats' }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Radio stations' })).getByRole('menuitemradio', { name: /Cozy lo-fi/ }));
    expect(player.getAttribute('src')).toBe('/workspace/api/radio/tracks/grey/audio');
    expect(sound.made).toHaveLength(1);
  });

  it('starts on the station this browser chose last time', async () => {
    window.localStorage.setItem('workspace.radio.station', 'urban');
    open('/notes', () => station(5, ['grey', 'orbit'], true));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    expect(sound.made[0]!.getAttribute('src')).toBe('/workspace/api/radio/tracks/brick/audio');
  });

  it('plays lo-fi when the chosen station has nothing on air yet', async () => {
    window.localStorage.setItem('workspace.radio.station', 'urban');
    open('/notes', () => station(5));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    expect(sound.made[0]!.getAttribute('src')).toBe('/workspace/api/radio/tracks/grey/audio');
  });

  it('is the same sound on every screen: Home carries the button too', async () => {
    open('/', () => station(5));
    const play = await screen.findByRole('button', { name: 'Play work radio' });
    expect(play.closest('.chathead')).not.toBeNull();
  });

  it('pauses on the second press, and a pause from outside turns it off too', async () => {
    open('/notes', () => station(5));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause work radio' }));
    expect(sound.pauses).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Play work radio' }).textContent).toBe('Radio');

    fireEvent.click(screen.getByRole('button', { name: 'Play work radio' }));
    fireEvent.pause(sound.made[0]!);
    expect(screen.getByRole('button', { name: 'Play work radio' })).toBeTruthy();
  });

  it('puts the button back when the browser refuses to play', async () => {
    open('/notes', () => station(5));
    sound.refuseNext('NotAllowedError');
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    expect(await screen.findByRole('button', { name: 'Play work radio' })).toBeTruthy();
  });

  it('rejoins once on a fresh address when the track fails, then gives up', async () => {
    open('/notes', () => station(5));
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    const player = sound.made[0]!;
    await act(async () => { fireEvent.error(player); });
    expect(player.getAttribute('src')).toMatch(/^\/workspace\/api\/radio\/tracks\/grey\/audio\?again=\d+$/);
    expect(screen.getByRole('button', { name: 'Pause work radio' })).toBeTruthy();
    fireEvent.error(player);
    expect(screen.getByRole('button', { name: 'Play work radio' })).toBeTruthy();
  });
});

describe('keeping time with the station', () => {
  const answer = station(0);
  const start = Date.parse(answer.now!.startsAt);
  it('starts a listener who is a moment behind from the top, and one further behind where the station is', () => {
    expect(joinAt(answer.now!, start + 1.5 * SECOND)).toBe(0);
    expect(joinAt(answer.now!, start + 30 * SECOND)).toBe(30);
    expect(joinAt(answer.now!, start + 999 * SECOND)).toBe(180);
  });
  it('knows what is on and what follows from one read', () => {
    expect(onAirAt(answer, start + 10 * SECOND)?.track.id).toBe('grey');
    expect(onAirAt(answer, start + 200 * SECOND)?.track.id).toBe('orbit');
    expect(onAirAt(answer, start + 400 * SECOND)).toBeNull();
    expect(airingAfter(answer, answer.now!)?.track.id).toBe('orbit');
    expect(airingAfter(answer, answer.next!)).toBeNull();
  });
});
