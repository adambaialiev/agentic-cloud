import { DEFAULT_RADIO_STATION, radioStationInfo, type RadioAiring, type RadioAnswer, type RadioStationId } from '../../../src/shared/radio.js';
import { WORKSPACE_API_BASE } from '../../../src/shared/workspace-routes.js';

/** A listener this far behind the station when a track starts is brought
 *  level; closer than that, the track starts from its top. */
export const RADIO_CATCH_UP_SECONDS = 2;

/** A track's own address: a redirect to its signed bytes, so an <audio> can
 *  be pointed at it inside the press (note #712, the Drive row's rule). */
export function radioTrackUrl(trackId: string): string {
  return `${WORKSPACE_API_BASE}/api/radio/tracks/${encodeURIComponent(trackId)}/audio`;
}

export const airingEnd = (airing: RadioAiring): number => Date.parse(airing.startsAt) + airing.track.durationMs;

/** The station's clock: this browser's, corrected by how far the server's
 *  read differed from it when the answer arrived. */
export function stationNow(answer: RadioAnswer, readAt: number, now: number): number {
  return now + (Date.parse(answer.serverNow) - readAt);
}

/** What is on air at `at` among what the answer said, or null when the
 *  answer is too old to know. */
export function onAirAt(answer: RadioAnswer, at: number): RadioAiring | null {
  for (const airing of [answer.now, answer.next]) {
    if (airing && Date.parse(airing.startsAt) <= at && at < airingEnd(airing)) return airing;
  }
  return null;
}

/** The airing after `after` among what the answer said. */
export function airingAfter(answer: RadioAnswer, after: RadioAiring): RadioAiring | null {
  const start = Date.parse(after.startsAt);
  return [answer.now, answer.next].find((airing) => airing && Date.parse(airing.startsAt) > start) ?? null;
}

/** Where in a track a listener joining at `at` should start, in seconds. */
export function joinAt(airing: RadioAiring, at: number): number {
  const behind = (at - Date.parse(airing.startsAt)) / 1000;
  return behind > RADIO_CATCH_UP_SECONDS ? Math.min(behind, airing.track.durationMs / 1000) : 0;
}

/** One station's part of an answer, shaped as a whole answer is, so the
 *  helpers above read it the same way (note #761). Null for a station the
 *  answer does not carry. */
export function stationView(answer: RadioAnswer, id: RadioStationId): RadioAnswer | null {
  const one = (answer.stations ?? [answer]).find((station) => station.station.id === id);
  return one ? { ...answer, ...one } : null;
}

/** The station to play: the one chosen, or — while it has nothing on air —
 *  the first that has. */
export function stationToPlay(answer: RadioAnswer, chosen: RadioStationId): RadioStationId {
  if (stationView(answer, chosen)?.now) return chosen;
  return (answer.stations ?? [answer]).find((station) => station.now)?.station.id ?? chosen;
}

const CHOSEN_KEY = 'workspace.radio.station';

/** The station this browser last chose, kept across visits. */
export function rememberedStation(): RadioStationId {
  try {
    const held = window.localStorage.getItem(CHOSEN_KEY);
    return radioStationInfo(held)?.id ?? DEFAULT_RADIO_STATION;
  } catch {
    return DEFAULT_RADIO_STATION;
  }
}

export function rememberStation(id: RadioStationId): void {
  try { window.localStorage.setItem(CHOSEN_KEY, id); } catch { /* a private window keeps it for the visit only */ }
}
