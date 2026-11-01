import { createContext } from 'react';
import type { WorkspaceSeatRecord } from '../../../src/shared/workspace-api.js';

/**
 * The seats cache (legacy `seatsState` / `availableSeatsState` / `fetchSeats`
 * / `seatsChanged`): read once per workplace and kept, single-flight,
 * and dropped by any mutation BEFORE the screen that shows the list is
 * returned to — or the list walks back one seat short.
 */
export interface SeatsValue {
  seats: WorkspaceSeatRecord[] | null;
  available: WorkspaceSeatRecord[];
  /** Read what is held, reading from the server when nothing is — or always,
   *  with `force`, which is what opening the list does so usage is fresh.
   *  Concurrent callers share one request. */
  fetch: (options?: { force?: boolean }) => Promise<WorkspaceSeatRecord[]>;
  /** Forget what is held; the next `fetch` reads again. */
  invalidate: () => void;
  /** Replace one row in place after a check, without a re-read. */
  replace: (seat: WorkspaceSeatRecord) => void;
}

export const SeatsContext = createContext<SeatsValue | null>(null);
