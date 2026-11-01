/**
 * Warm transcripts, one page session long. See `transcript-context.ts` for
 * why they live above the screen rather than in it.
 *
 * A ref, not state: nothing renders from this store directly — the chat reads
 * it once when it opens and writes to it after every read — so a write must
 * not re-render the app.
 */

import { useMemo, useRef, type ReactNode } from 'react';
import { TranscriptContext, type TranscriptStore } from './transcript-context.js';
import type { TranscriptRow } from './transcript.js';

export function TranscriptProvider({ children }: { children: ReactNode }) {
  const held = useRef(new Map<string, TranscriptRow[]>());
  const store = useMemo<TranscriptStore>(() => ({
    read: (agentId) => held.current.get(agentId),
    write: (agentId, rows) => { held.current.set(agentId, rows); },
  }), []);
  return <TranscriptContext value={store}>{children}</TranscriptContext>;
}
