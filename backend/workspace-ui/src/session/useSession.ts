import { useContext } from 'react';
import { SessionContext, type SessionContextValue } from './context.js';

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() needs a <SessionProvider> above it');
  return value;
}
