import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RADIO_STATION_NAME, RADIO_STATIONS, radioStationInfo, type RadioAiring, type RadioAnswer, type RadioStationId } from '../../../src/shared/radio.js';
import { WorkspaceApiError, type WorkspaceApi } from '../api/client.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { RadioContext, type RadioValue } from './radio-context.js';
import {
  airingAfter, airingEnd, joinAt, onAirAt, radioTrackUrl, rememberStation, rememberedStation, stationNow, stationToPlay, stationView,
} from './radio-sync.js';

interface Held { answer: RadioAnswer; readAt: number }

/** While no station has anything on air yet, how often to look again. */
const EMPTY_LOOK_AGAIN_MS = 10 * 60_000;
/** Read again this long before the track on air ends, so the track after it
 *  is known fresh: one the operator took off the station meanwhile (note
 *  #758) has been replaced by then, and the handover plays the replacement. */
const READ_BEFORE_END_MS = 20_000;
const FAILED_LOOK_AGAIN_MS = 5 * 60_000;

/**
 * The work radio (note #712): stations (note #761), each one the same track
 * at the same moment for everyone tuned to it, played on ONE element that
 * stands above every screen, so the sound carries on while the listener moves
 * about the Workspace. One read says what every station has on air; the
 * listener's choice of station is kept in this browser.
 *
 * Pressing play joins the chosen station where it is, as a radio does: the
 * track on air, from the second it has reached. Choosing a station joins it
 * the same way, inside the same tap. A track that ends hands over to the next
 * one the station already named, on the same element and without asking
 * first — a phone lets an element it has been allowed to start carry on, even
 * with the screen locked, but would not let a fresh one start without a
 * press. Each handover reads the station again, so the one after is known
 * before it is needed. A listener who has fallen behind by a few seconds is
 * brought level when the next track starts; pausing and playing again
 * rejoins the station live rather than resuming where they stopped.
 *
 * The press itself starts the sound: the track's address is its own and
 * redirects to the signed bytes, so `play()` runs inside the tap (the Drive
 * row's rule). The element is made on the first press, never on a render.
 */
export function RadioProvider({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  // The state read says whether this backend has a radio at all; without
  // one nothing is ever asked, so a Workspace with no radio makes no request
  // that could fail.
  const enabled = Boolean(useWorkspace().state?.radio);
  const [held, setHeld] = useState<Held | null>(null);
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [playingTitle, setPlayingTitle] = useState<string | null>(null);
  const [chosen, setChosen] = useState<RadioStationId>(rememberedStation);
  // Reads that failed for a reason another read could fix; each one asks again later.
  const [missed, setMissed] = useState(0);
  // The element's listeners outlive any one render, so they read these.
  const heldRef = useRef<Held | null>(null);
  const chosenRef = useRef(chosen);
  const onRef = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const airing = useRef<RadioAiring | null>(null);
  const seekTo = useRef(0);
  const retried = useRef<string | null>(null);
  const toggleRef = useRef<() => void>(() => {});
  const gone = useRef(false);

  const read = useCallback(async (): Promise<Held | null> => {
    try {
      const answer = await api.api<RadioAnswer>('api/radio');
      if (gone.current) return null;
      const next = { answer, readAt: Date.now() };
      heldRef.current = next;
      setHeld(next);
      return next;
    } catch (error) {
      // No radio here at all: there is nothing to look for again.
      if (error instanceof WorkspaceApiError && error.status === 404) return null;
      if (!gone.current) setMissed((count) => count + 1);
      return null;
    }
  }, [api]);

  const setPlaying = useCallback((value: boolean) => {
    onRef.current = value;
    setOn(value);
    if (!value) setStarting(false);
  }, []);

  /** What was read, seen from the station being played. */
  const tuned = useCallback((from: Held): RadioAnswer | null => stationView(from.answer, stationToPlay(from.answer, chosenRef.current)), []);

  const start = useCallback((player: HTMLAudioElement, next: RadioAiring, at: number, again = false) => {
    airing.current = next;
    seekTo.current = joinAt(next, at);
    player.src = again ? `${radioTrackUrl(next.track.id)}?again=${Date.now()}` : radioTrackUrl(next.track.id);
    setPlayingTitle(next.track.title);
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      const from = heldRef.current;
      const station = from ? tuned(from)?.station : null;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: next.track.title, artist: RADIO_STATION_NAME, album: station?.name ?? RADIO_STATIONS[0].name,
      });
    }
    // Refused — a browser that did not count this as a press — puts the
    // button back. Cut short by the next track (an AbortError) is not a refusal.
    void player.play()?.catch((error: { name?: string }) => {
      if (error?.name === 'NotAllowedError' && airing.current === next) setPlaying(false);
    });
  }, [setPlaying, tuned]);

  /** The live point of the station being played, from what was last read:
   *  the airing on air and the station's clock. A read too old to know what
   *  is on gives the latest airing it named, from its top, until the next
   *  read brings it level. */
  const live = useCallback((from: Held): { airing: RadioAiring | null; at: number } => {
    const at = stationNow(from.answer, from.readAt, Date.now());
    const station = tuned(from);
    if (!station) return { airing: null, at };
    const now = onAirAt(station, at);
    if (now) return { airing: now, at };
    const latest = station.next ?? station.now;
    return { airing: latest, at: latest ? Date.parse(latest.startsAt) : at };
  }, [tuned]);

  const element = useCallback((): HTMLAudioElement => {
    if (audio.current) return audio.current;
    const player = new Audio();
    player.preload = 'auto';
    player.addEventListener('loadedmetadata', () => {
      if (seekTo.current > 0) player.currentTime = seekTo.current;
      seekTo.current = 0;
    });
    player.addEventListener('playing', () => { setStarting(false); retried.current = null; });
    // The element pauses itself at the end of every track; only a pause
    // from outside (a headset unplugged, the system) turns the radio off.
    player.addEventListener('pause', () => { if (!player.ended && onRef.current) setPlaying(false); });
    player.addEventListener('ended', () => {
      if (!onRef.current) return;
      const was = airing.current;
      const from = heldRef.current;
      const station = from ? tuned(from) : null;
      const next = was && station ? airingAfter(station, was) : null;
      if (next && from) {
        start(player, next, stationNow(from.answer, from.readAt, Date.now()));
        // The station may have replaced that track since it was read — it
        // was taken off the station (note #758). Follow the station then,
        // on the same element, a moment into the slot.
        void read().then((fresh) => {
          if (!fresh || !onRef.current || airing.current !== next) return;
          const { airing: now, at } = live(fresh);
          if (now && now.startsAt === next.startsAt && now.track.id !== next.track.id) start(player, now, at);
        });
        return;
      }
      // What was read is too old to know what follows: ask, then carry on.
      void read().then((fresh) => {
        if (!fresh || !onRef.current) return;
        const { airing: now, at } = live(fresh);
        if (now) start(player, now, at);
      });
    });
    // A dropped connection or a stale signature: rejoin live once, on a fresh
    // address, before giving up and putting the button back.
    player.addEventListener('error', () => {
      const was = airing.current;
      const from = heldRef.current;
      if (!onRef.current || !was || !from) return;
      if (retried.current !== was.startsAt) {
        retried.current = was.startsAt;
        const { airing: now, at } = live(from);
        if (now) { start(player, now, at, true); return; }
      }
      setPlaying(false);
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => { if (!onRef.current) toggleRef.current(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (onRef.current) toggleRef.current(); });
    }
    audio.current = player;
    return player;
  }, [live, read, setPlaying, start, tuned]);

  const toggle = useCallback(() => {
    if (onRef.current) {
      setPlaying(false);
      audio.current?.pause();
      return;
    }
    const from = heldRef.current;
    if (!from) return;
    const { airing: now, at } = live(from);
    if (!now) return;
    setPlaying(true);
    setStarting(true);
    start(element(), now, at);
  }, [element, live, setPlaying, start]);
  // The system's own play and pause keys reach the newest toggle through this.
  useEffect(() => { toggleRef.current = toggle; }, [toggle]);

  /** Tunes to a station and plays it, inside the tap that chose it. The one
   *  already playing just keeps playing. */
  const choose = useCallback((id: RadioStationId) => {
    const from = heldRef.current;
    const was = from ? stationToPlay(from.answer, chosenRef.current) : chosenRef.current;
    chosenRef.current = id;
    setChosen(id);
    rememberStation(id);
    if (!from || (onRef.current && was === stationToPlay(from.answer, id))) return;
    const { airing: now, at } = live(from);
    if (!now) return;
    setPlaying(true);
    setStarting(true);
    start(element(), now, at);
  }, [element, live, setPlaying, start]);

  // Read on arrival, shortly before the track on air ends and again when it
  // has — so the handover knows the track after it, and a press always finds
  // the live point — and again on coming back to a tab the browser may have
  // been sparing with timers in.
  useEffect(() => {
    if (!enabled) return;
    gone.current = false;
    void Promise.resolve().then(read);
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      gone.current = true;
      document.removeEventListener('visibilitychange', visible);
      const player = audio.current;
      if (player) { player.pause(); player.removeAttribute('src'); }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      }
    };
  }, [enabled, read]);
  useEffect(() => {
    if (!missed) return;
    const timer = window.setTimeout(() => { void read(); }, FAILED_LOOK_AGAIN_MS);
    return () => window.clearTimeout(timer);
  }, [missed, read]);
  useEffect(() => {
    if (!held) return;
    const now = stationView(held.answer, stationToPlay(held.answer, chosen))?.now;
    const left = now ? airingEnd(now) - stationNow(held.answer, held.readAt, Date.now()) : 0;
    const wait = !now ? EMPTY_LOOK_AGAIN_MS
      : left > READ_BEFORE_END_MS + 5_000 ? left - READ_BEFORE_END_MS
        : Math.max(5_000, left + 500);
    const timer = window.setTimeout(() => { void read(); }, wait);
    return () => window.clearTimeout(timer);
  }, [held, chosen, read]);

  const value = useMemo<RadioValue>(() => {
    const playing = held ? stationToPlay(held.answer, chosen) : chosen;
    const station = held ? stationView(held.answer, playing) : null;
    const stations = held ? (held.answer.stations ?? [held.answer]) : [];
    return {
      available: stations.some((one) => one.now),
      on,
      starting: on && starting,
      title: on ? playingTitle : (station?.now?.track.title ?? null),
      // Before the first read, the station this browser chose.
      station: station?.station ?? radioStationInfo(chosen) ?? RADIO_STATIONS[0],
      stations: stations.filter((one) => one.now).map((one) => ({ station: one.station, title: one.now!.track.title })),
      choose,
      refresh: () => { void read(); },
      toggle,
    };
  }, [held, chosen, on, starting, playingTitle, choose, read, toggle]);
  return <RadioContext value={value}>{children}</RadioContext>;
}
