import { useContext } from 'react';
import { ChatOutboxContext } from './outbox-context.js';
import type { ChatOutbox } from './outbox.js';

export function useChatOutbox(): ChatOutbox {
  const outbox = useContext(ChatOutboxContext);
  if (!outbox) throw new Error('useChatOutbox() needs a ChatOutboxProvider above it');
  return outbox;
}
