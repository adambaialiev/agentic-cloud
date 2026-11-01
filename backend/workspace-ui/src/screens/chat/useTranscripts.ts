import { useContext } from 'react';
import { TranscriptContext, type TranscriptStore } from './transcript-context.js';

export function useTranscripts(): TranscriptStore {
  const store = useContext(TranscriptContext);
  if (!store) throw new Error('useTranscripts() needs a TranscriptProvider above it');
  return store;
}
