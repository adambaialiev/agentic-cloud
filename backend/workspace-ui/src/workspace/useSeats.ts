import { useContext } from 'react';
import { SeatsContext, type SeatsValue } from './seats-context.js';

export function useSeats(): SeatsValue {
  const value = useContext(SeatsContext);
  if (!value) throw new Error('useSeats() needs a SeatsProvider above it');
  return value;
}
