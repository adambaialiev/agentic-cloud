import { Timestamp } from './timestamp.js';

export interface SecretDocument {
  secretId: string;
  userId: string;
  key: string;
  value: string;
  /** What this secret is for — user secrets carry one; platform rows may not. */
  description?: string;
  /**
   * Whose agents a SHARED user secret reaches: only workplace admins' agents
   * (the default, and what an absent field means) or every agent in the
   * workplace. Meaningless on agent-private rows and platform credentials.
   */
  audience?: SecretAudience;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** See {@link SecretDocument.audience}. */
export type SecretAudience = 'admins' | 'everyone';

export interface CreateSecretInput {
  key: string;
  value: string;
  description?: string;
  audience?: SecretAudience;
}

export interface UpdateSecretInput {
  key?: string;
  value?: string;
  /** Set to a string to replace; empty string clears. Undefined leaves it. */
  description?: string;
  /** Replaces the audience when set; undefined leaves it. */
  audience?: SecretAudience;
}
