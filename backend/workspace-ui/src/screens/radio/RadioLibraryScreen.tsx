/**
 * The work radio's library (note #758): every track of every station, one
 * station at a time (note #761), for the platform operator to hear in full
 * and take off the station when one sounds wrong. Nobody else is offered the
 * page, and the server refuses anyone else who finds the address.
 *
 * Playing here is the reader's own: the rows play on the Drive list's one
 * player (a second track stops the first, leaving the page stops the sound),
 * never on the station's, so the station carries on for everyone else. The
 * reader's own radio pauses when a track starts here, and starting the radio
 * again stops the track, so two sounds never play over each other.
 *
 * Remove takes a track out of the rotation at once: it is never picked again,
 * a removed track queued next is replaced in the same step, and one on air
 * finishes before the station moves on. It waits in Removed, below, until it
 * is put back. Both answer with the library as it now stands, which is what
 * the page draws.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RADIO_STATIONS, type RadioLibraryAnswer, type RadioLibraryStation, type RadioLibraryTrack, type RadioStationId } from '../../../../src/shared/radio.js';
import { WorkspaceApiError } from '../../api/client.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useRadio } from '../../radio/radio-context.js';
import { radioTrackUrl } from '../../radio/radio-sync.js';
import { useSession } from '../../session/useSession.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { stopwatch } from '../../ui/time.js';
import { useRowPlayer, type RowPlayer } from '../drive/useRowPlayer.js';
import { gapsLine, librarySub, madeAt, recipeLine } from './radio-library-words.js';

/** What is on air changes every ninety seconds; the page keeps up this often. */
const LOOK_AGAIN_MS = 30_000;

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** The row's last line: its length, or how far in while it plays, and when it was made or removed. */
function timeLine(track: RadioLibraryTrack, player: RowPlayer): string {
  const length = stopwatch(track.durationMs / 1000);
  const when = track.removedAt ? `removed ${madeAt(track.removedAt)}` : `made ${madeAt(track.createdAt)}`;
  if (player.broken.has(track.id)) return `${length} · Could not play here`;
  const playing = player.track?.id === track.id ? player.track : null;
  const gaps = gapsLine(track);
  const tail = gaps ? `${when} · ${gaps}` : when;
  if (!playing) return `${length} · ${tail}`;
  return `${playing.duration ? `${stopwatch(playing.at)} / ${stopwatch(playing.duration)}` : 'Loading…'} · ${tail}`;
}

function TrackRow({ track, station, player, busy, onPlay, onChange }: {
  track: RadioLibraryTrack;
  station: RadioLibraryStation;
  player: RowPlayer;
  busy: boolean;
  onPlay: (track: RadioLibraryTrack) => void;
  onChange: (track: RadioLibraryTrack, remove: boolean) => void;
}) {
  const playing = player.track?.id === track.id && player.track.playing;
  const removed = Boolean(track.removedAt);
  const state = track.id === station.onAirId ? 'On air' : track.id === station.nextId ? 'Next' : '';
  return (
    <div className={`crow radiotrack${busy ? ' deleting' : ''}`} data-track={track.id}>
      {player.broken.has(track.id)
        ? <span className="drivemark" aria-hidden="true"><TypeIcon glyph="audio" tint="media" /></span>
        : (
          <button type="button" className="drivemark play" aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`} onClick={() => onPlay(track)}>
            <Icon name={playing ? 'pause' : 'play'} size={24} className="icon ft ft-media" />
          </button>
        )}
      <div className="main">
        <div className="name plain">
          {track.title}
          {state ? <span className={`radiostate${state === 'On air' ? ' onair' : ''}`}>{state}</span> : null}
        </div>
        <div className="cline wrap"><span className="ctext">{recipeLine(track)}</span></div>
        <div className="cline wrap"><span className="ctext">{timeLine(track, player)}</span></div>
      </div>
      <button type="button" className={`btn ${removed ? 'ghost' : 'danger'} radioact`} disabled={busy}
        aria-label={`${removed ? 'Put back' : 'Remove'} ${track.title}`} onClick={() => onChange(track, !removed)}>
        {removed ? 'Put back' : 'Remove'}
      </button>
    </div>
  );
}

export function RadioLibraryScreen() {
  const { api } = useSession();
  const banner = useBanner();
  const radio = useRadio();
  const player = useRowPlayer();
  const [library, setLibrary] = useState<RadioLibraryAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The station on show starts as the one this reader is tuned to.
  const [showing, setShowing] = useState<RadioStationId>(() => radio?.station.id ?? RADIO_STATIONS[0].id);
  const gone = useRef(false);

  const read = useCallback(async () => {
    try {
      const answer = await api.api<RadioLibraryAnswer>('api/radio/library');
      if (gone.current) return;
      setLibrary(answer);
      setError('');
    } catch (failure) {
      if (gone.current) return;
      setError(failure instanceof WorkspaceApiError && failure.status === 403
        ? 'This page is for the platform operator.'
        : messageOf(failure));
    }
  }, [api]);

  useEffect(() => {
    gone.current = false;
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, LOOK_AGAIN_MS);
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      gone.current = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [read]);

  // Starting the radio again stops the track playing here.
  const stationOn = Boolean(radio?.on);
  const { stop } = player;
  useEffect(() => { if (stationOn) stop(); }, [stationOn, stop]);

  const play = (track: RadioLibraryTrack) => {
    // Both inside the press: a phone lets the track start only from a tap.
    if (radio?.on) radio.toggle();
    player.toggle(track.id, radioTrackUrl(track.id));
  };

  const change = async (track: RadioLibraryTrack, remove: boolean) => {
    setBusy(track.id);
    try {
      const verb = remove ? 'remove' : 'restore';
      const answer = await api.api<RadioLibraryAnswer>(`api/radio/library/tracks/${encodeURIComponent(track.id)}/${verb}`, { method: 'POST' });
      if (gone.current) return;
      setLibrary(answer);
      banner.show(remove ? `“${track.title}” is off the station. It waits in Removed.` : `“${track.title}” is back on the station.`, true);
    } catch (failure) {
      banner.show(messageOf(failure));
    } finally {
      if (!gone.current) setBusy(null);
    }
  };

  const station = library?.stations.find((one) => one.station.id === showing) ?? library?.stations[0] ?? null;
  const ofStation = (id: RadioStationId) => library?.tracks.filter((track) => track.station === id) ?? [];
  const on = ofStation(station?.station.id ?? showing).filter((track) => !track.removedAt);
  const removed = ofStation(station?.station.id ?? showing).filter((track) => track.removedAt);
  const rows = (tracks: RadioLibraryTrack[]) => tracks.map((track) => (
    <TrackRow key={track.id} track={track} station={station!} player={player} busy={busy === track.id} onPlay={play} onChange={change} />
  ));

  return (
    <div className="screen" id="screenRadioLibrary" aria-busy={library || error ? undefined : true}>
      <ScreenTitle title="Radio library" sub={library && station ? librarySub(station.station.name, on.length, removed.length) : 'Work radio'} />
      {error && !library
        ? <div className="card"><div className="empty" id="radioLibraryError">{error}</div></div>
        : (
          <>
            {library
              ? (
                <div className="segtabs" id="radioLibraryStations" role="tablist" aria-label="Stations">
                  {library.stations.map((one) => {
                    const selected = one.station.id === station?.station.id;
                    const count = ofStation(one.station.id).filter((track) => !track.removedAt).length;
                    return (
                      <button
                        key={one.station.id} className="segtab" type="button" role="tab" data-station={one.station.id}
                        aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={() => setShowing(one.station.id)}
                      >
                        {one.station.name} · {count}
                      </button>
                    );
                  })}
                </div>
              )
              : null}
            <p className="hintblock" id="radioLibraryAbout">
              Only you can open this page. A track you play here is for your ears alone; the stations play on for everyone else.
              A removed track is never picked again, and one on air finishes first. A station gets new tracks only when you ask for a number of them.
            </p>
            {station?.wanted
              ? <p className="hintblock" id="radioLibraryWanted">{station.wanted} more {station.wanted === 1 ? 'track is' : 'tracks are'} being made for {station.station.name}.</p>
              : null}
            <h2>On the station</h2>
            <div className="card" id="radioLibraryOn">
              {library === null
                ? <div className="empty">Loading…</div>
                : on.length ? rows(on) : <div className="empty">No track is on {station?.station.name ?? 'this station'} yet.</div>}
            </div>
            <h2>Removed</h2>
            <div className="card" id="radioLibraryRemoved">
              {library === null
                ? <div className="empty">Loading…</div>
                : removed.length ? rows(removed) : <div className="empty">Nothing removed. A track you remove waits here until you put it back.</div>}
            </div>
          </>
        )}
    </div>
  );
}
