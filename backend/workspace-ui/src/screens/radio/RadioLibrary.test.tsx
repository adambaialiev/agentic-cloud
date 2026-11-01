import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioAnswer, RadioLibraryAnswer, RadioLibraryTrack } from '../../../../src/shared/radio.js';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { gapsLine, librarySub, recipeLine } from './radio-library-words.js';

const org = { orgId: 'org-1', name: 'Nomad Trading', role: 'admin' as const, members: 1, seats: 1, seatProviders: ['claude' as const] };

const LOFI = { id: 'lofi' as const, name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' };
const URBAN = { id: 'urban' as const, name: 'Urban beats', style: 'Urban hip-hop' };

const tracks: RadioLibraryTrack[] = [
  { id: 'brick', title: 'Concrete Bounce', durationMs: 89_400, station: 'urban', createdAt: '2026-10-15T20:41:00.000Z',
    recipe: { style: 'boom-bap', energy: 'gritty', lead: 'brass stabs', bpm: 92, key: 'D minor' }, gapsCut: [] },
  { id: 'neon', title: 'Neon Strut', durationMs: 88_100, station: 'urban', createdAt: '2026-10-15T20:40:00.000Z',
    recipe: { style: 'trap', energy: 'high-energy', lead: 'synth riff', bpm: 98, key: 'C minor' }, gapsCut: [{ atMs: 41_000, ms: 1_700 }] },
  { id: 'rainy', title: 'Rainy Notebook', durationMs: 90_000, station: 'lofi', createdAt: '2026-10-11T09:41:00.000Z',
    recipe: { mood: 'rainy-day', lead: 'vibraphone', bpm: 78, key: 'D minor' } },
  { id: 'amber', title: 'Amber Streetlight', durationMs: 90_000, station: 'lofi', createdAt: '2026-10-11T08:37:00.000Z',
    recipe: { lead: 'felt piano', bpm: 78, key: 'B-flat major' } },
  { id: 'grey', title: 'Grey Kettle', durationMs: 87_500, station: 'lofi', createdAt: '2026-10-11T08:30:00.000Z',
    recipe: { lead: 'Rhodes', bpm: 80, key: 'F major' } },
];

/** The server's side: a library that removes and puts back as asked. */
function operatorServer() {
  const library: RadioLibraryAnswer = {
    stations: [
      { station: LOFI, onAirId: 'amber', nextId: 'rainy', wanted: 0 },
      { station: URBAN, onAirId: 'brick', nextId: 'neon', wanted: 3 },
    ],
    tracks: structuredClone(tracks), triesToday: 2, triesPerDay: 90,
  };
  const change = (removed: boolean) => ({ path }: { path: string }) => {
    const id = path.split('/')[4]!;
    const track = library.tracks.find((entry) => entry.id === id)!;
    if (removed) track.removedAt = '2026-10-15T15:20:00.000Z'; else delete track.removedAt;
    if (removed && library.stations[0]!.nextId === id) library.stations[0]!.nextId = 'grey';
    return structuredClone(library);
  };
  const script: Record<string, Answer> = {
    'GET api/radio/library': () => structuredClone(library),
    'POST api/radio/library/tracks/rainy/remove': change(true),
    'POST api/radio/library/tracks/rainy/restore': change(false),
  };
  return { library, script };
}

const station = (): RadioAnswer => {
  const lofi = {
    station: LOFI,
    now: { track: { id: 'amber', title: 'Amber Streetlight', durationMs: 90_000 }, startsAt: new Date(Date.now() - 5_000).toISOString() },
    next: { track: { id: 'rainy', title: 'Rainy Notebook', durationMs: 90_000 }, startsAt: new Date(Date.now() + 85_000).toISOString() },
  };
  return { ...lofi, stations: [lofi, { station: URBAN, now: null, next: null }], serverNow: new Date().toISOString() };
};

function open(path: string, extra: Record<string, Answer>, operator = true) {
  const test = scriptedApi({
    ...workspaceScript(() => emptyState({ org, radio: true, ...(operator ? { radioLibrary: true as const } : {}) })),
    'GET api/radio': station,
    ...extra,
  });
  render(<MemoryRouter initialEntries={[path]}><App api={test.api} /></MemoryRouter>);
  return test;
}

/** Every element made with `new Audio()`, and the ones asked to play. */
function speakers() {
  const made: HTMLAudioElement[] = [];
  const played: HTMLMediaElement[] = [];
  const Real = window.Audio;
  window.Audio = function Audio() { const element = new Real(); made.push(element); return element; } as unknown as typeof Audio;
  const spies = [
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { played.push(this); return Promise.resolve(); }),
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}),
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}),
  ];
  return { made, played, restore: () => { window.Audio = Real; for (const spy of spies) spy.mockRestore(); } };
}

const row = (title: string) => screen.getByText(title).closest('.crow') as HTMLElement;

describe('the radio library (note #758)', () => {
  let sound: ReturnType<typeof speakers>;
  beforeEach(() => { sound = speakers(); });
  afterEach(() => { cleanup(); sound.restore(); });

  it('lists every track with its recipe, its length, when it was made and what is on air', async () => {
    const { script } = operatorServer();
    open('/radio', script);
    expect(await screen.findByRole('heading', { name: 'Radio library' })).toBeTruthy();
    await screen.findByText('Rainy Notebook');
    expect(screen.getByText('Cozy lo-fi: 3 tracks')).toBeTruthy();
    const on = document.getElementById('radioLibraryOn')!;
    expect([...on.querySelectorAll('.crow .name')].map((name) => name.firstChild!.textContent)).toEqual(['Rainy Notebook', 'Amber Streetlight', 'Grey Kettle']);
    expect(within(row('Rainy Notebook')).getByText('vibraphone · 78 BPM · D minor · rainy day')).toBeTruthy();
    expect(within(row('Rainy Notebook')).getByText(/^1:30 · made 11 Oct, \d\d:\d\d$/)).toBeTruthy();
    expect(within(row('Grey Kettle')).getByText(/^1:27 · made/)).toBeTruthy();
    expect(within(row('Amber Streetlight')).getByText('On air').className).toBe('radiostate onair');
    expect(within(row('Rainy Notebook')).getByText('Next').className).toBe('radiostate');
    expect(document.getElementById('radioLibraryRemoved')!.textContent).toContain('Nothing removed.');
  });

  it('shows one station at a time, each with its own tracks, on air and tracks still being made (note #761)', async () => {
    const { script } = operatorServer();
    open('/radio', script);
    await screen.findByText('Rainy Notebook');
    const tabs = within(document.getElementById('radioLibraryStations')!).getAllByRole('tab');
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Cozy lo-fi · 3', 'true'], ['Urban beats · 2', 'false']]);
    expect(screen.queryByText('Concrete Bounce')).toBeNull();
    expect(document.getElementById('radioLibraryWanted')).toBeNull();

    fireEvent.click(tabs[1]!);
    await screen.findByText('Concrete Bounce');
    expect(screen.queryByText('Rainy Notebook')).toBeNull();
    expect(screen.getByText('Urban beats: 2 tracks')).toBeTruthy();
    expect(within(row('Concrete Bounce')).getByText('boom-bap · brass stabs · 92 BPM · D minor · gritty')).toBeTruthy();
    expect(within(row('Concrete Bounce')).getByText('On air')).toBeTruthy();
    expect(within(row('Neon Strut')).getByText('Next')).toBeTruthy();
    expect(within(row('Neon Strut')).getByText(/^1:28 · made 15 Oct, \d\d:\d\d · 1 gap cut, 1\.7 s$/)).toBeTruthy();
    expect(within(row('Concrete Bounce')).getByText(/^1:29 · made 15 Oct, \d\d:\d\d$/)).toBeTruthy();
    expect(document.getElementById('radioLibraryWanted')!.textContent).toBe('3 more tracks are being made for Urban beats.');
  });

  it('plays a track in full on its own player, from the press, and pauses the station for this reader only', async () => {
    const { script } = operatorServer();
    const test = open('/radio', script);
    await screen.findByText('Rainy Notebook');
    // The reader's own radio is playing.
    fireEvent.click(await screen.findByRole('button', { name: 'Play work radio' }));
    const radio = sound.made[0]!;
    expect(radio.getAttribute('src')).toBe('/workspace/api/radio/tracks/amber/audio');

    fireEvent.click(screen.getByRole('button', { name: 'Play Grey Kettle' }));
    const preview = sound.made[1]!;
    expect(preview).not.toBe(radio);
    expect(preview.getAttribute('src')).toBe('/workspace/api/radio/tracks/grey/audio');
    // Played inside the press, with nothing asked of the server first.
    expect(sound.played.at(-1)).toBe(preview);
    expect(screen.getByRole('button', { name: 'Play work radio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause Grey Kettle' })).toBeTruthy();
    // Nothing about playing it here goes to the station.
    expect(test.calls.some((call) => (call.init?.method ?? 'GET') !== 'GET')).toBe(false);

    // Turning the radio back on stops the track.
    fireEvent.click(screen.getByRole('button', { name: 'Play work radio' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play Grey Kettle' })).toBeTruthy());
    expect(preview.hasAttribute('src')).toBe(false);
  });

  it('removes a track into Removed, and puts it back', async () => {
    const { script } = operatorServer();
    const test = open('/radio', script);
    await screen.findByText('Rainy Notebook');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Rainy Notebook' }));
    await waitFor(() => expect(document.getElementById('radioLibraryRemoved')!.textContent).toContain('Rainy Notebook'));
    expect(test.calls.filter((call) => call.init?.method === 'POST').map((call) => call.path)).toEqual(['api/radio/library/tracks/rainy/remove']);
    expect(document.getElementById('radioLibraryOn')!.textContent).not.toContain('Rainy Notebook');
    expect(screen.getByText('Cozy lo-fi: 2 tracks · 1 removed')).toBeTruthy();
    expect(within(row('Rainy Notebook')).getByText(/^1:30 · removed 15 Oct, \d\d:\d\d$/)).toBeTruthy();
    expect(await screen.findByText('“Rainy Notebook” is off the station. It waits in Removed.')).toBeTruthy();
    // The station queued another track next in the same step.
    expect(within(row('Grey Kettle')).getByText('Next')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Put back Rainy Notebook' }));
    await waitFor(() => expect(document.getElementById('radioLibraryOn')!.textContent).toContain('Rainy Notebook'));
    expect(document.getElementById('radioLibraryRemoved')!.textContent).toContain('Nothing removed.');
    expect(test.calls.filter((call) => call.init?.method === 'POST').at(-1)!.path).toBe('api/radio/library/tracks/rainy/restore');
  });

  it('says so, and lists nothing, to anyone the server refuses', async () => {
    open('/radio', {
      'GET api/radio/library': () => { throw new WorkspaceApiError("The radio library is the platform operator's: only they can open it.", 403, {}); },
    }, false);
    expect(await screen.findByText('This page is for the platform operator.')).toBeTruthy();
    expect(document.querySelector('.radiotrack')).toBeNull();
  });

  it('is offered in the account menu to the operator alone', async () => {
    open('/', operatorServer().script);
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Radio library/ }));
    expect(await screen.findByRole('heading', { name: 'Radio library' })).toBeTruthy();
    cleanup();

    open('/', operatorServer().script, false);
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const theirs = await screen.findByRole('menu', { name: 'Your account' });
    expect(within(theirs).queryByRole('menuitem', { name: /Radio library/ })).toBeNull();
  });

  // Switched off (note #842): the state read says no radio, even to the
  // operator, so there is no button, no menu row, and the page's address is
  // the not-found screen — asked nothing of the radio's doors on the way.
  it('is nowhere with the radio off: no button, no menu row, and /radio is not found', async () => {
    const test = scriptedApi(workspaceScript(() => emptyState({ org })));
    render(<MemoryRouter initialEntries={['/radio']}><App api={test.api} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Nothing at this address' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Radio library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play work radio' })).toBeNull();
    cleanup();

    const home = scriptedApi(workspaceScript(() => emptyState({ org })));
    render(<MemoryRouter initialEntries={['/']}><App api={home.api} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(within(menu).queryByRole('menuitem', { name: /Radio library/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play work radio' })).toBeNull();
    expect([...test.calls, ...home.calls].some((call) => call.path.startsWith('api/radio'))).toBe(false);
  });
});

describe('the library page’s words', () => {
  it('reads a recipe in the order it is heard, and says what a track without one is', () => {
    // Each part's words are held together by no-break spaces.
    const plain = (text: string) => text.replace(/\u00a0/g, ' ');
    expect(recipeLine(tracks[2]!)).toContain('D\u00a0minor');
    expect(plain(recipeLine(tracks[2]!))).toBe('vibraphone · 78 BPM · D minor · rainy day');
    expect(plain(recipeLine(tracks[0]!))).toBe('boom-bap · brass stabs · 92 BPM · D minor · gritty');
    expect(recipeLine({ ...tracks[2]!, recipe: {} })).toBe('No recipe kept');
    expect(gapsLine(tracks[0]!)).toBe('');
    expect(gapsLine(tracks[1]!)).toBe('1 gap cut, 1.7 s');
    expect(gapsLine(tracks[2]!)).toBe('');
    expect(librarySub('Urban beats', 1, 0)).toBe('Urban beats: 1 track');
    expect(librarySub('Cozy lo-fi', 78, 2)).toBe('Cozy lo-fi: 78 tracks · 2 removed');
  });
});
