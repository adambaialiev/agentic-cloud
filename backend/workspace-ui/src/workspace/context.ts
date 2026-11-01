import { createContext } from 'react';
import type {
  WorkspaceNotificationRow,
  WorkspaceNoteLiveClaim,
  WorkspaceStateAnswer,
} from '../../../src/shared/workspace-api.js';
import type { WorkspaceRecapAnswer, WorkspaceRecapSettingsAnswer } from '../../../src/shared/workspace-recap.js';
import type { HomeAgent } from './live.js';

export interface WorkspaceHomeOverview {
  status: 'idle' | 'loading' | 'ready';
  /** The app opened on Home (or changed workplace there), so Home's one
   *  opening skeleton owns this batch. False for an in-app return to Home. */
  blockHome: boolean;
  orgId: string | null;
  recap: WorkspaceRecapAnswer | null;
  recapSettings: WorkspaceRecapSettingsAnswer | null;
}

export interface WorkspaceValue {
  /** `loading` until a first state read answers or a cached workplace copy is
   *  restored; `error` when it failed and nothing has been painted yet. A
   *  later failure keeps the last state. */
  status: 'loading' | 'ready' | 'error';
  error: string;
  /** The last full read, as the server sent it. */
  state: WorkspaceStateAnswer | null;
  /** The fleet, with the live tick folded in. Null until the first read. */
  agents: HomeAgent[] | null;
  /** Active note leases from the live tick. Undefined until a backend that
   *  supports them has answered; an empty array is the answer "none". */
  noteClaims?: WorkspaceNoteLiveClaim[];
  // No rooms, no viewed room and no room switch (note #843): rooms left the
  // product, and every read here is the whole workplace's. The state still
  // CARRIES `rooms` and `room` until the API drops them (stage 3); nothing
  // in the Workspace reads them.
  notifications: WorkspaceNotificationRow[];
  /** Home's three overview reads, started beside the full workspace read so
   *  its card never mounts in a second, half-known loading phase. */
  homeOverview: WorkspaceHomeOverview;
  /** Refresh those three reads together, keeping any already-painted answer
   *  in place until the new batch lands. */
  refreshHomeOverview: (orgId?: string) => Promise<void>;
  /** The server has accepted a workplace switch. Put that workplace's last
   *  good copy back on screen immediately, then refresh it underneath. */
  switchWorkplace: (orgId: string) => Promise<boolean>;
  /** Re-read the whole state now. */
  reload: () => Promise<boolean>;
  /** Home's own re-read: the one an arrival on Home and a focus return to it
   *  make, single-flight with them. Null when none was started — off Home,
   *  or with the page hidden. */
  refreshHome: () => Promise<boolean> | null;
  /** Put a runtime change the server has just confirmed onto the agent's row,
   *  so every painted copy of it stops saying the old model while the full
   *  read that follows is still in flight (note #296). */
  patchAgentRuntime: (agentId: string, runtime: { model: string; effort: string }) => void;
  /** True the first time a key is claimed in this page session — for the
   *  walks that happen once (the founder door), never on every poll. */
  claimOnce: (key: string) => boolean;
  /**
   * Reading a conversation is the receipt for its completion notifications.
   * Refreshes first, because a notification can be committed just after the
   * chat poll that carried its reply: the durable record stays, but it is
   * already read. False when there was nothing to acknowledge, or the receipt
   * failed — reading the conversation is the primary action, and a failed
   * receipt is retried by the next poll rather than breaking the chat.
   */
  markAgentNotificationsRead: (agentId: string) => Promise<boolean>;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);
