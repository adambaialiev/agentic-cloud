import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceSeatRecord, WorkspaceSeatsAnswer } from '../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../api/client.js';
import { SeatsContext, type SeatsValue } from './seats-context.js';

export function SeatsProvider({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  const [seats, setSeats] = useState<WorkspaceSeatRecord[] | null>(null);
  const [available, setAvailable] = useState<WorkspaceSeatRecord[]>([]);
  const inFlight = useRef<Promise<WorkspaceSeatRecord[]> | null>(null);
  const generation = useRef(0);
  const held = useRef<WorkspaceSeatRecord[] | null>(null);

  const fetch = useCallback((options?: { force?: boolean }): Promise<WorkspaceSeatRecord[]> => {
    if (!options?.force && held.current && !inFlight.current) return Promise.resolve(held.current);
    if (!inFlight.current) {
      const gen = generation.current;
      inFlight.current = api.api<WorkspaceSeatsAnswer>('api/org/seats').then((answer) => {
        // A mutation while this read was out makes its answer stale.
        if (gen !== generation.current) return [];
        held.current = answer.seats ?? [];
        setSeats(answer.seats ?? []);
        setAvailable(answer.available ?? []);
        return answer.seats ?? [];
      }).finally(() => {
        if (gen === generation.current) inFlight.current = null;
      });
    }
    return inFlight.current;
  }, [api]);

  const invalidate = useCallback(() => {
    generation.current += 1;
    inFlight.current = null;
    held.current = null;
    setSeats(null);
    setAvailable([]);
  }, []);

  const replace = useCallback((seat: WorkspaceSeatRecord) => {
    generation.current += 1;
    inFlight.current = null;
    held.current = (held.current ?? []).map((entry) => (entry.seatId === seat.seatId ? seat : entry));
    setSeats(held.current);
  }, []);

  const value = useMemo<SeatsValue>(() => ({ seats, available, fetch, invalidate, replace }), [seats, available, fetch, invalidate, replace]);
  return <SeatsContext value={value}>{children}</SeatsContext>;
}
