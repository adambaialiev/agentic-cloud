import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryRadioStorage } from '../../services/radio-storage.js';
import { RadioStation } from '../../services/radio-station.js';
import { RadioImportError, type RadioImport } from '../../services/radio-library.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import type { MediaStorage } from '../../services/media-storage.js';
import type { RadioAnswer, RadioLibraryAnswer } from '../../shared/radio.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

describe('the work radio through the Workspace', () => {
  let server: Server;
  let origin: string;
  let storage: InMemoryRadioStorage;
  let token: string;
  /** The maker's take import, as index.ts hands it to the station; absent unless a test sets it. */
  let importer: ((station: 'lofi' | 'urban', take: RadioImport) => Promise<unknown>) | undefined;
  beforeEach(() => { importer = undefined; });

  async function serve(withRadio: boolean, operator = false) {
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    // The platform operator is the account marked as its admin.
    if (operator) await users.updateProfile('alice', { roles: { admin: true } } as never);
    const minted = mintAgentbuiltToken('alice', 'ada'); token = minted.token;
    await users.updateProfile('alice', { telegram: { agents: {
      ada: { id: 'ada', name: 'Ada', cli: 'codex', agentbuiltTokenHash: minted.tokenHash },
    } } as never });
    storage = new InMemoryRadioStorage();
    const media = {
      createReadAccess: async ({ storagePath }: { storagePath: string }) => ({ url: `https://media.test/${storagePath}?signature=1`, expiresAt: 'x' }),
    } as unknown as MediaStorage;
    const deps: Partial<RouteDeps> = { userStorage: users, ...(withRadio ? { radio: new RadioStation(storage, media, Math.random, () => {}, importer) } : {}) };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    app.use('/api/agent-cli', agentCliRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (path: string, signedIn = true) => fetch(`${origin}/workspace/api/${path}`, {
    redirect: 'manual', ...(signedIn ? { headers: workspaceTestHeaders(42) } : {}),
  });

  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  describe('with a station', () => {
    beforeEach(async () => {
      await serve(true);
      await storage.addTrack({
        id: 'track-1', title: 'Rainy Window', durationMs: 180_000, storagePath: 'radio/tracks/track-1.mp3', sizeBytes: 1,
        createdAt: '2026-10-10T00:00:00.000Z', maker: 'm', prompt: 'p',
      });
    });

    it('says what is on air to anyone signed in, fresh every time', async () => {
      const response = await get('radio');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const answer = await response.json() as RadioAnswer;
      expect(answer.station).toEqual({ id: 'lofi', name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' });
      expect(answer.stations.map((one) => [one.station.id, one.now?.track.id ?? null])).toEqual([['lofi', 'track-1'], ['urban', null]]);
      expect(answer.now?.track).toEqual({ id: 'track-1', title: 'Rainy Window', durationMs: 180_000 });
      expect(answer.next?.track.id).toBe('track-1');
      expect(Date.parse(answer.serverNow)).toBeGreaterThan(0);
    });

    it('sends a track\'s audio element on to a signed address', async () => {
      const response = await get('radio/tracks/track-1/audio');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://media.test/radio/tracks/track-1.mp3?signature=1');
      expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    });

    it('says on the state read that there is a radio, so the Workspace asks about it', async () => {
      expect(((await (await get('state')).json()) as { radio?: boolean }).radio).toBe(true);
    });

    it('knows no other track', async () => {
      expect((await get('radio/tracks/elsewhere/audio')).status).toBe(404);
    });

    it('tells an agent what is playing through its own door, and nobody else', async () => {
      const agent = (path: string, auth = true) => fetch(`${origin}/api/agent-cli/${path}`, {
        redirect: 'manual', ...(auth ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      const response = await agent('radio');
      expect(response.status).toBe(200);
      expect(((await response.json()) as RadioAnswer).now?.track.title).toBe('Rainy Window');
      expect((await agent('radio/tracks/track-1/audio')).headers.get('location')).toBe('https://media.test/radio/tracks/track-1.mp3?signature=1');
      expect((await agent('radio', false)).status).toBe(401);
    });

    it('is only for people who are signed in', async () => {
      expect((await get('radio', false)).status).toBe(401);
      expect((await get('radio/tracks/track-1/audio', false)).status).toBe(401);
    });
  });

  describe('the library, for the platform operator alone (note #758)', () => {
    const post = (path: string, signedIn = true) => fetch(`${origin}/workspace/api/${path}`, {
      method: 'POST', ...(signedIn ? { headers: workspaceTestHeaders(42) } : {}),
    });
    const agent = (path: string, method = 'GET') => fetch(`${origin}/api/agent-cli/${path}`, {
      method, headers: { Authorization: `Bearer ${token}` },
    });
    async function stock() {
      for (const [id, title] of [['track-1', 'Rainy Window'], ['track-2', 'Amber Walk']] as const) {
        await storage.addTrack({
          id, title, durationMs: 90_000, storagePath: `radio/tracks/${id}.mp3`, sizeBytes: 1,
          createdAt: `2026-10-1${id.at(-1)}T00:00:00.000Z`, maker: 'm',
          prompt: 'Lo-fi hip-hop beat for focus, rainy-day mood, 80 BPM, F major, dusty swung drums, mellow flute melody, no vocals',
        });
      }
    }

    it('refuses everyone else, on both doors, and does not tell them there is a page', async () => {
      await serve(true);
      await stock();
      expect((await get('radio/library')).status).toBe(403);
      expect((await post('radio/library/tracks/track-1/remove')).status).toBe(403);
      expect((await post('radio/library/tracks/track-1/restore')).status).toBe(403);
      expect((await agent('radio/library')).status).toBe(403);
      expect((await agent('radio/library/tracks/track-1/remove', 'POST')).status).toBe(403);
      expect((await get('radio/library', false)).status).toBe(401);
      expect((await post('radio/library/tracks/track-1/remove', false)).status).toBe(401);
      expect(((await (await get('state')).json()) as { radioLibrary?: true }).radioLibrary).toBeUndefined();
      // Nothing changed for anyone.
      expect((await storage.tracks()).some((track) => track.removedAt)).toBe(false);
    });

    it('lists every track with its recipe, removes one from the rotation and puts it back', async () => {
      await serve(true, true);
      await stock();
      expect(((await (await get('state')).json()) as { radioLibrary?: true }).radioLibrary).toBe(true);
      const listed = await get('radio/library');
      expect(listed.status).toBe(200);
      expect(listed.headers.get('cache-control')).toBe('no-store');
      const library = await listed.json() as RadioLibraryAnswer;
      expect(library.tracks.map((track) => track.title)).toEqual(['Amber Walk', 'Rainy Window']);
      expect(library.tracks[0]!.recipe).toEqual({ mood: 'rainy-day', lead: 'flute', bpm: 80, key: 'F major' });
      expect(library.stations[0]!.onAirId).not.toBeNull();

      const removed = await post('radio/library/tracks/track-1/remove');
      expect(removed.status).toBe(200);
      const after = await removed.json() as RadioLibraryAnswer;
      expect(after.tracks.find((track) => track.id === 'track-1')?.removedAt).toBeTruthy();
      expect(after.stations[0]!.nextId).toBe('track-2');
      // Every listener from here on is told only of the track left.
      for (let read = 0; read < 5; read += 1) {
        const answer = await (await get('radio')).json() as RadioAnswer;
        expect(answer.next?.track.id).toBe('track-2');
      }

      const back = await post('radio/library/tracks/track-1/restore');
      expect(back.status).toBe(200);
      expect((await back.json() as RadioLibraryAnswer).tracks.find((track) => track.id === 'track-1')).not.toHaveProperty('removedAt');
      expect((await post('radio/library/tracks/elsewhere/remove')).status).toBe(404);
    });

    it('takes the operator\'s order for new tracks on a station, and nobody else\'s (note #761)', async () => {
      const make = (path: string, body: unknown, door: 'workspace' | 'agent' = 'workspace') => fetch(
        door === 'workspace' ? `${origin}/workspace/api/${path}` : `${origin}/api/agent-cli/${path}`,
        {
          method: 'POST', body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...(door === 'workspace' ? workspaceTestHeaders(42) : { Authorization: `Bearer ${token}` }) },
        },
      );
      await serve(true);
      expect((await make('radio/library/stations/urban/make', { count: 5 })).status).toBe(403);
      expect((await make('radio/library/stations/urban/make', { count: 5 }, 'agent')).status).toBe(403);
      expect(await storage.wanted()).toEqual({});
      await new Promise<void>((resolve) => server.close(() => resolve()));

      await serve(true, true);
      const ordered = await make('radio/library/stations/urban/make', { count: 5 }, 'agent');
      expect(ordered.status).toBe(200);
      expect(((await ordered.json()) as RadioLibraryAnswer).stations.find((one) => one.station.id === 'urban')?.wanted).toBe(5);
      expect(await storage.wanted()).toEqual({ urban: 5 });
      expect((await make('radio/library/stations/urban/make', { count: 0 })).status).toBe(400);
      expect((await make('radio/library/stations/urban/make', { count: 500 })).status).toBe(400);
      expect((await make('radio/library/stations/urban/make', {})).status).toBe(400);
      expect((await make('radio/library/stations/jazz/make', { count: 1 })).status).toBe(404);
      expect(await storage.wanted()).toEqual({ urban: 5 });
    });

    it('puts a take made outside the station on it for the operator alone, and says why one cannot go on (note #765)', async () => {
      const put = (path: string, body: unknown, door: 'workspace' | 'agent' = 'agent') => fetch(
        door === 'workspace' ? `${origin}/workspace/api/${path}` : `${origin}/api/agent-cli/${path}`,
        {
          method: 'POST', body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...(door === 'workspace' ? workspaceTestHeaders(42) : { Authorization: `Bearer ${token}` }) },
        },
      );
      const asked: Array<[string, RadioImport]> = [];
      importer = async (station, take) => {
        asked.push([station, take]);
        if (take.url.includes('choppy')) throw new Error('the track broke into stop-start pieces');
        if (!take.url.startsWith('https://v3b.fal.media/')) throw new RadioImportError('Only a take on fal\'s own file host can be put on air.');
        await storage.addTrack({
          id: 'take-1', title: 'Chrome Bounce', durationMs: 201_000, storagePath: 'radio/tracks/take-1.mp3', sizeBytes: 1,
          createdAt: '2026-10-16T15:00:00.000Z', maker: 'mureka', prompt: take.prompt, station, source: take.url,
        });
      };
      const take = { url: 'https://v3b.fal.media/files/gfunk.mp3', prompt: 'Instrumental hip-hop beat, West Coast G-funk bounce, 96 BPM, no vocals' };
      await serve(true);
      expect((await put('radio/library/stations/urban/import', take)).status).toBe(403);
      expect((await put('radio/library/stations/urban/import', take, 'workspace')).status).toBe(403);
      expect(asked).toEqual([]);
      await new Promise<void>((resolve) => server.close(() => resolve()));

      await serve(true, true);
      const done = await put('radio/library/stations/urban/import', take);
      expect(done.status).toBe(200);
      const library = await done.json() as RadioLibraryAnswer;
      expect(library.tracks).toEqual([expect.objectContaining({ id: 'take-1', station: 'urban', recipe: expect.objectContaining({ style: 'G-funk', bpm: 96 }) })]);
      expect(library.stations.find((one) => one.station.id === 'urban')?.onAirId).toBe('take-1');
      expect(asked).toEqual([['urban', take]]);
      const refused = await put('radio/library/stations/urban/import', { ...take, url: 'https://elsewhere.test/a.mp3' }, 'workspace');
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'Only a take on fal\'s own file host can be put on air.' });
      expect((await put('radio/library/stations/urban/import', { ...take, url: 'https://v3b.fal.media/choppy.mp3' })).status).toBe(503);
      expect((await put('radio/library/stations/jazz/import', take)).status).toBe(404);
    });

    it('cannot put a take on where nothing can be made (note #765)', async () => {
      await serve(true, true);
      const answer = await fetch(`${origin}/api/agent-cli/radio/library/stations/urban/import`, {
        method: 'POST', body: JSON.stringify({ url: 'https://v3b.fal.media/a.mp3', prompt: 'p' }),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      expect(answer.status).toBe(503);
      expect(await storage.tracks()).toEqual([]);
    });

    it('lets the operator\'s own agents read and change it through the agent door', async () => {
      await serve(true, true);
      await stock();
      expect(((await (await agent('radio/library')).json()) as RadioLibraryAnswer).tracks).toHaveLength(2);
      const removed = await agent('radio/library/tracks/track-2/remove', 'POST');
      expect(((await removed.json()) as RadioLibraryAnswer).tracks.find((track) => track.id === 'track-2')?.removedAt).toBeTruthy();
      const back = await agent('radio/library/tracks/track-2/restore', 'POST');
      expect(((await back.json()) as RadioLibraryAnswer).tracks.every((track) => !track.removedAt)).toBe(true);
    });
  });

  it('says there is no radio where there is no station, and answers 404 if asked anyway', async () => {
    await serve(false);
    expect(((await (await get('state')).json()) as { radio?: boolean }).radio).toBe(false);
    expect((await get('radio')).status).toBe(404);
    expect((await get('radio/tracks/track-1/audio')).status).toBe(404);
  });

  // Switched off (note #842) is the same as no station: every door, the
  // listener's and the operator's, on the Workspace and the agent door alike,
  // says so with a 404 — and the operator is offered no library either.
  it('answers "The radio is off." on every door, to the operator too, when there is no station', async () => {
    await serve(false, true);
    const state = (await (await get('state')).json()) as { radio?: boolean; radioLibrary?: true };
    expect(state.radio).toBe(false);
    expect(state.radioLibrary).toBeUndefined();
    const agentGet = (path: string, method = 'GET') => fetch(`${origin}/api/agent-cli/${path}`, {
      method, redirect: 'manual', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ count: 1 }) } : {}),
    });
    const post = (path: string) => fetch(`${origin}/workspace/api/${path}`, {
      method: 'POST', headers: { ...workspaceTestHeaders(42), 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }),
    });
    const answers = [
      await get('radio'), await get('radio/tracks/track-1/audio'), await get('radio/library'),
      await post('radio/library/stations/urban/make'), await post('radio/library/tracks/track-1/remove'),
      await agentGet('radio'), await agentGet('radio/library'), await agentGet('radio/library/stations/lofi/make', 'POST'),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: 'The radio is off.' });
    }
  });
});
