import { useContext } from 'react';
import { FleetContext, type FleetValue } from './fleet-context.js';

export function useFleet(): FleetValue {
  const value = useContext(FleetContext);
  if (!value) throw new Error('useFleet() needs a FleetProvider above it');
  return value;
}
