import { createContext } from 'react';
import type { TranscriptRow } from './transcript.js';

/**
 * What each conversation looked like when it was last open, for as long as
 * this page session lasts.
 *
 * The chat screen unmounts when the reader leaves it, and re-reading a
 * transcript from its first message is what makes a revisit flash empty and
 * then jump. So the rows live one level up: reopening paints them BEFORE the
 * catch-up read, and a read that lands after the reader has moved on still
 * warms the conversation it belongs to.
 *
 * An empty transcript is cached too — absence is an answer, and a revisit can
 * paint that answer while its catch-up read runs.
 */
export interface TranscriptStore {
  read: (agentId: string) => TranscriptRow[] | undefined;
  write: (agentId: string, rows: TranscriptRow[]) => void;
}

export const TranscriptContext = createContext<TranscriptStore | null>(null);
