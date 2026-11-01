import { createContext } from 'react';
import type { WorkspaceSignedInSession } from '../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../api/client.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; session: WorkspaceSignedInSession };

export interface SessionContextValue {
  state: SessionState;
  api: WorkspaceApi;
  /** Re-read `auth/session` and settle on signed-in or signed-out. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
