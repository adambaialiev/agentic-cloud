import { createContext } from 'react';
import type { ChatOutbox } from './outbox.js';

/**
 * The sends in flight, above every chat screen (note #658) — see `outbox.ts`
 * for why a message outlives the screen it was written on.
 */
export const ChatOutboxContext = createContext<ChatOutbox | null>(null);
