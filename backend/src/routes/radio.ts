import type { Request, Response, Router } from 'express';
import { radioStationInfo, type RadioAnswer, type RadioLibraryAnswer } from '../shared/radio.js';
import { RadioImportError } from '../services/radio-library.js';
import type { RouteDeps } from './deps.js';

/**
 * The work radio's two doors (note #712), open to every signed-in person —
 * and, on the agent door, to every agent, so one can say what is playing:
 * what is on air, and one track's bytes. Without a station (no media store,
 * or the radio switched off: everywhere since note #842 unless WORK_RADIO=on)
 * every door answers 404 "The radio is off." and the Workspace shows no button.
 *
 * Beside them, the library (note #758): every track of every station,
 * taking one out of the rotation or putting it back, and ordering a number of
 * new tracks for a station (note #761), and putting on a take made outside it
 * (note #765). Those are the platform operator's alone —
 * the account the platform already marks as its admin (`roles.admin`), and on
 * the agent door that account's agents, as with sign-up numbers. Everyone
 * else is refused, signed in or not.
 */
export function registerRadioRoutes<Auth>(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Auth | null>,
  isOperator: (auth: Auth) => Promise<boolean>) {
  router.get(base, async (req, res) => {
    if (!(await authenticate(req, res))) return;
    if (!deps.radio) return res.status(404).json({ error: 'The radio is off.' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await deps.radio.answer() satisfies RadioAnswer);
    } catch {
      console.warn('[radio] the station could not be read');
      return res.status(503).json({ error: 'The radio could not be read. Try again.' });
    }
  });
  // An <audio> follows the redirect with the listener's own session, so play
  // starts inside the tap: there is no link to ask for first, which a phone
  // would not count as the listener pressing play (the Drive row's rule).
  router.get(`${base}/tracks/:id/audio`, async (req, res) => {
    if (!(await authenticate(req, res))) return;
    if (!deps.radio) return res.status(404).json({ error: 'The radio is off.' });
    try {
      const url = await deps.radio.trackUrl(String(req.params.id));
      if (!url) return res.status(404).json({ error: 'No such track.' });
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.redirect(302, url);
    } catch {
      console.warn('[radio] a track address could not be signed');
      return res.status(503).json({ error: 'The track could not be opened. Try again.' });
    }
  });

  /** The station, for the operator only; null once the answer is sent. */
  const operatorStation = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    // Off is the same answer for everyone, operator or not (note #842).
    if (!deps.radio) { res.status(404).json({ error: 'The radio is off.' }); return null; }
    if (!(await isOperator(auth))) {
      res.status(403).json({ error: "The radio library is the platform operator's: only they can open it." });
      return null;
    }
    return deps.radio;
  };
  router.get(`${base}/library`, async (req, res) => {
    const station = await operatorStation(req, res);
    if (!station) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await station.library() satisfies RadioLibraryAnswer);
    } catch {
      console.warn('[radio] the library could not be read');
      return res.status(503).json({ error: 'The radio library could not be read. Try again.' });
    }
  });
  // An order for new tracks: `{ "count": 5 }` more on the station named.
  // Each POST adds to what is owed, so a retried one asks for more; the
  // answer says what is owed now, which is what to read before asking again.
  router.post(`${base}/library/stations/:station/make`, async (req, res) => {
    const station = await operatorStation(req, res);
    if (!station) return;
    const info = radioStationInfo(req.params.station);
    if (!info) return res.status(404).json({ error: 'No such station.' });
    const count = Number((req.body as { count?: unknown } | undefined)?.count);
    try {
      const answer = await station.order(info.id, count);
      console.log(`[radio] ${count} more track${count === 1 ? '' : 's'} asked for on ${info.id}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(answer satisfies RadioLibraryAnswer);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      console.warn('[radio] an order for tracks could not be taken');
      return res.status(503).json({ error: 'The order could not be taken. Try again.' });
    }
  });
  // A take made outside the station put on it (note #765): `{ "url": <fal
  // file address>, "prompt": <what it was asked for> }`. The same take twice
  // is refused, so a retried POST cannot put it on twice.
  router.post(`${base}/library/stations/:station/import`, async (req, res) => {
    const station = await operatorStation(req, res);
    if (!station) return;
    const info = radioStationInfo(req.params.station);
    if (!info) return res.status(404).json({ error: 'No such station.' });
    const body = (req.body ?? {}) as { url?: unknown; prompt?: unknown };
    try {
      const answer = await station.importTake(info.id, { url: String(body.url ?? ''), prompt: typeof body.prompt === 'string' ? body.prompt : '' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(answer satisfies RadioLibraryAnswer);
    } catch (error) {
      if (error instanceof RadioImportError) return res.status(400).json({ error: error.message });
      console.warn(`[radio] a take could not be put on ${info.id}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
      return res.status(503).json({ error: 'The take could not be put on the station. Try again.' });
    }
  });
  // Remove and put back are each one POST naming the track: repeating one
  // changes nothing, so a retried tap is harmless.
  for (const [verb, removed] of [['remove', true], ['restore', false]] as const) {
    router.post(`${base}/library/tracks/:id/${verb}`, async (req, res) => {
      const station = await operatorStation(req, res);
      if (!station) return;
      try {
        const answer = await station.setRemoved(String(req.params.id), removed);
        if (!answer) return res.status(404).json({ error: 'No such track.' });
        const title = answer.tracks.find((track) => track.id === req.params.id)?.title;
        console.log(`[radio] ${removed ? 'removed' : 'put back'} "${title}" (${req.params.id})`);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(answer satisfies RadioLibraryAnswer);
      } catch {
        console.warn(`[radio] a track could not be ${removed ? 'removed' : 'put back'}`);
        return res.status(503).json({ error: 'The track could not be changed. Try again.' });
      }
    });
  }
}
