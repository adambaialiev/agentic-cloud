import { createContext, useContext } from 'react';
import type { RadioStationId, RadioStationInfo } from '../../../src/shared/radio.js';

/** The work radio as a button sees it (note #712). */
export interface RadioValue {
  /** Some station has something on air. */
  available: boolean;
  /** The listener pressed play and has not paused. */
  on: boolean;
  /** On, and the sound has not started yet. */
  starting: boolean;
  /** What is playing, or what would play on a press. */
  title: string | null;
  /** The station a press plays (note #761). */
  station: RadioStationInfo;
  /** Every station with something on air, and what that is. */
  stations: { station: RadioStationInfo; title: string }[];
  /** Tunes to a station and plays it, inside the tap. */
  choose: (id: RadioStationId) => void;
  /** Reads every station again, so a menu opening shows what is on now. */
  refresh: () => void;
  toggle: () => void;
}

export const RadioContext = createContext<RadioValue | null>(null);

/** Null outside a `RadioProvider`, so a screen drawn on its own simply has no
 *  radio button rather than an error. */
export function useRadio(): RadioValue | null {
  return useContext(RadioContext);
}
