/**
 * Work radio (note #712): stations every signed-in person can tune to, each
 * one playing the same track at the same moment to everyone on it, drawn from
 * that station's library of AI-made instrumental tracks. The owner's answers:
 * for every customer, no vocals, a library on endless shuffle rather than
 * music made live, a small play button, just music. It began as one station,
 * minimal techno at 128 BPM, became lo-fi hip-hop once the owner had heard
 * what the model does best, and gained an urban station beside it (note #761).
 *
 * Public records carry no object-store path and nothing about how a track was
 * made; the browser needs a name, a length and when it airs. Only the
 * platform operator's library page (note #758) is told the recipe.
 */

export const RADIO_STATION_NAME = 'Work radio';

/**
 * The stations (note #761), in the order a listener is offered them; the
 * first is where a listener starts. The list is code, so adding one is a
 * reviewed change. Every track made before stations existed is lo-fi's.
 */
export const RADIO_STATIONS = [
  { id: 'lofi', name: 'Cozy lo-fi', style: 'Lo-fi hip-hop' },
  { id: 'urban', name: 'Urban beats', style: 'Urban hip-hop' },
] as const;

export type RadioStationId = (typeof RADIO_STATIONS)[number]['id'];

export interface RadioStationInfo {
  id: RadioStationId;
  name: string;
  style: string;
}

export const DEFAULT_RADIO_STATION: RadioStationId = RADIO_STATIONS[0].id;

/** The station with this id, or null for a word that names none. */
export function radioStationInfo(id: unknown): RadioStationInfo | null {
  return RADIO_STATIONS.find((station) => station.id === id) ?? null;
}

export interface RadioTrack {
  id: string;
  title: string;
  durationMs: number;
}

export interface RadioAiring {
  track: RadioTrack;
  /** When this track starts on the station, ISO. */
  startsAt: string;
}

/** One station as a listener is told it: what is on air and what follows.
 *  `now` is null while that station's library is still empty. */
export interface RadioStationAnswer {
  station: RadioStationInfo;
  now: RadioAiring | null;
  next: RadioAiring | null;
}

/**
 * `GET /workspace/api/radio`: every station, in `stations`. The top level is
 * the first station, as the one-station answer was, so a Workspace still
 * holding the page from before stations keeps playing lo-fi. The button
 * stays away until some station has something to play.
 */
export interface RadioAnswer extends RadioStationAnswer {
  stations: RadioStationAnswer[];
  /** The server's clock when it answered, so a listener whose own clock is off
   *  still joins at the right moment. */
  serverNow: string;
}

/** What a track was made to, read back from the prompt that made it. A part
 *  the prompt did not name is absent: the first thirty lo-fi tracks had no
 *  mood, and only urban tracks have a style and an energy. */
export interface RadioRecipe {
  /** The urban style, in a word or two ("boom-bap", "G-funk"). */
  style?: string;
  mood?: string;
  energy?: string;
  /** The lead instrument, in a word or two ("Rhodes", "brass stabs"). */
  lead?: string;
  bpm?: number;
  key?: string;
}

/** Dead air cut out of a track before it was saved: where, in the track as
 *  saved, and how much. */
export interface RadioGapCut {
  atMs: number;
  ms: number;
}

/** One track as the operator's library page lists it (note #758). */
export interface RadioLibraryTrack extends RadioTrack {
  station: RadioStationId;
  createdAt: string;
  recipe: RadioRecipe;
  /** Taken off the station by the operator, ISO. Absent on a track in the rotation. */
  removedAt?: string;
  /** Gaps cut from inside the track. Absent on a track made before they
   *  were counted (note #761); an empty list means none had to be. */
  gapsCut?: RadioGapCut[];
}

/** A station as the library page shows it. */
export interface RadioLibraryStation {
  station: RadioStationInfo;
  onAirId: string | null;
  nextId: string | null;
  /** Tracks the operator asked for that are not made yet. */
  wanted: number;
}

/** `GET /workspace/api/radio/library`, the platform operator's alone: every
 *  track of every station, newest first, and each station's on air, next and
 *  tracks still to make. A remove, a put-back or an order for new tracks
 *  answers with the same, as it stands afterwards. */
export interface RadioLibraryAnswer {
  stations: RadioLibraryStation[];
  tracks: RadioLibraryTrack[];
  /** The spending guard: tries in the last 24 hours, and the most allowed. */
  triesToday: number;
  triesPerDay: number;
}
