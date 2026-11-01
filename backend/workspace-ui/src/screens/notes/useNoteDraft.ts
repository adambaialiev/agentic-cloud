import { useContext } from 'react';
import { NoteDraftContext, type NoteDraftValue } from './draft-context.js';

export function useNoteDraft(): NoteDraftValue {
  const value = useContext(NoteDraftContext);
  if (!value) throw new Error('useNoteDraft() needs a NoteDraftProvider above it');
  return value;
}
