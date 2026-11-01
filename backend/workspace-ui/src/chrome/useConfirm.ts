import { useContext } from 'react';
import { ConfirmContext, type AskToConfirm } from './confirm-context.js';

export function useConfirm(): AskToConfirm {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm() needs a ConfirmProvider above it');
  return ask;
}
