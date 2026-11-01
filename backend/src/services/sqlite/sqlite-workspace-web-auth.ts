import {
  adoptedIdentity,
  type WorkspaceAuthLinkConsumption,
  type WorkspaceAuthLinkDocument,
  type WorkspaceAuthLinkPurpose,
} from '../workspace-web-auth.js';
import type {
  WorkspaceEmailIdentityDocument,
  WorkspaceEmailVerificationConsumption,
  WorkspaceEmailVerificationDocument,
  WorkspaceSecondFactorChallengeDocument,
  WorkspaceTotpEnrollmentDocument,
  WorkspaceTotpIdentityDocument,
  WorkspaceWebAuthStorage,
  WorkspaceWebSessionDocument,
} from '../workspace-web-auth.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/** Durable browser-identity and session storage. Security-sensitive mutations
 * are compare-and-set transactions, so two login requests cannot accept the
 * same TOTP step or spend one recovery code twice. */
export class SqliteWorkspaceWebAuthStorage implements WorkspaceWebAuthStorage {
  constructor(private readonly db: SqliteDb) {}

  async getEmailIdentityByUserId(userId: string): Promise<WorkspaceEmailIdentityDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
    ).get(userId) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc) : null;
  }

  async getEmailIdentityByEmail(emailCanonical: string): Promise<WorkspaceEmailIdentityDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_email_identities WHERE email_canonical = ?',
    ).get(emailCanonical) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc) : null;
  }

  async createEmailIdentity(
    doc: WorkspaceEmailIdentityDocument,
  ): Promise<'created' | 'email_taken' | 'user_has_identity'> {
    const transaction = this.db.transaction(() => {
      const user = this.db.prepare(
        'SELECT 1 FROM workspace_email_identities WHERE user_id = ?',
      ).get(doc.userId);
      if (user) return 'user_has_identity' as const;
      const email = this.db.prepare(
        'SELECT 1 FROM workspace_email_identities WHERE email_canonical = ?',
      ).get(doc.emailCanonical);
      if (email) return 'email_taken' as const;
      this.db.prepare(
        'INSERT INTO workspace_email_identities (user_id, email_canonical, doc) VALUES (?, ?, ?)',
      ).run(doc.userId, doc.emailCanonical, serializeDoc(doc));
      return 'created' as const;
    });
    return transaction();
  }

  async updateEmailPassword(userId: string, passwordHash: string): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      identity.passwordHash = passwordHash;
      identity.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async adoptSignInAddress(userId: string, address: string, nowIso: string): Promise<'adopted' | 'unchanged' | 'address_taken' | 'missing'> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return 'missing' as const;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      if (identity.emailCanonical === address) return 'unchanged' as const;
      const holder = this.db.prepare(
        'SELECT user_id FROM workspace_email_identities WHERE email_canonical = ?',
      ).get(address) as { user_id: string } | undefined;
      if (holder && holder.user_id !== userId) return 'address_taken' as const;
      this.db.prepare('UPDATE workspace_email_identities SET email_canonical = ?, doc = ? WHERE user_id = ?')
        .run(address, serializeDoc(adoptedIdentity(identity, address, nowIso)), userId);
      return 'adopted' as const;
    });
    return transaction();
  }

  async updateRecoveryEmail(
    userId: string,
    recovery: Pick<WorkspaceEmailIdentityDocument, 'recoveryEmail' | 'recoveryEmailVerifiedAt'>,
    nowIso: string,
  ): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      if (recovery.recoveryEmail) identity.recoveryEmail = recovery.recoveryEmail; else delete identity.recoveryEmail;
      if (recovery.recoveryEmailVerifiedAt) identity.recoveryEmailVerifiedAt = recovery.recoveryEmailVerifiedAt;
      else delete identity.recoveryEmailVerifiedAt;
      identity.updatedAt = nowIso;
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async saveAuthLink(doc: WorkspaceAuthLinkDocument, cooldownMs: number): Promise<'created' | 'rate_limited'> {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_auth_links WHERE expires_at <= ?').run(doc.createdAt);
      const previous = this.db.prepare(
        'SELECT doc FROM workspace_auth_links WHERE user_id = ? AND purpose = ?',
      ).get(doc.userId, doc.purpose) as { doc: string } | undefined;
      if (previous) {
        const last = deserializeDoc<WorkspaceAuthLinkDocument>(previous.doc);
        if (Date.parse(doc.createdAt) - Date.parse(last.createdAt) < cooldownMs) return 'rate_limited' as const;
        this.db.prepare('DELETE FROM workspace_auth_links WHERE user_id = ? AND purpose = ?').run(doc.userId, doc.purpose);
      }
      this.db.prepare(
        'INSERT INTO workspace_auth_links (token_hash, user_id, purpose, expires_at, doc) VALUES (?, ?, ?, ?, ?)',
      ).run(doc.tokenHash, doc.userId, doc.purpose, doc.expiresAt, serializeDoc(doc));
      return 'created' as const;
    });
    return transaction();
  }

  async consumeAuthLink(tokenHash: string, purpose: WorkspaceAuthLinkPurpose, nowIso: string): Promise<WorkspaceAuthLinkConsumption> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_auth_links WHERE token_hash = ? AND purpose = ?',
      ).get(tokenHash, purpose) as { doc: string } | undefined;
      if (!row) return { outcome: 'invalid' } as const;
      // Consumed on sight, whichever way it goes: a link is one use.
      this.db.prepare('DELETE FROM workspace_auth_links WHERE token_hash = ?').run(tokenHash);
      const link = deserializeDoc<WorkspaceAuthLinkDocument>(row.doc);
      if (Date.parse(link.expiresAt) <= Date.parse(nowIso)) return { outcome: 'expired' } as const;
      return { outcome: 'consumed', link } as const;
    });
    return transaction();
  }

  async updateEmailSecondFactor(
    userId: string,
    factor: Pick<WorkspaceEmailIdentityDocument, 'encryptedTotpSecret' | 'lastAcceptedStep' | 'recoveryCodeHashes'>,
  ): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      Object.assign(identity, factor, { updatedAt: new Date().toISOString() });
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async acceptEmailTotpStep(userId: string, step: number): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      if (step <= (identity.lastAcceptedStep ?? -1)) return false;
      identity.lastAcceptedStep = step;
      identity.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async consumeEmailRecoveryCode(userId: string, encodedHash: string): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      if (!identity.recoveryCodeHashes?.includes(encodedHash)) return false;
      identity.recoveryCodeHashes = identity.recoveryCodeHashes.filter((hash) => hash !== encodedHash);
      identity.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async beginEmailVerification(
    doc: WorkspaceEmailVerificationDocument,
    limits: { cooldownMs: number; windowMs: number; maxPerWindow: number },
  ): Promise<'created' | 'rate_limited' | 'already_verified' | 'identity_changed'> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(doc.userId) as { doc: string } | undefined;
      if (!row) return 'identity_changed' as const;
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(row.doc);
      if (identity.emailCanonical !== doc.emailCanonical) return 'identity_changed' as const;
      if (identity.verificationStatus === 'verified' || identity.emailVerifiedAt) {
        return 'already_verified' as const;
      }

      const nowMs = Date.parse(doc.createdAt);
      const lastSentMs = Date.parse(identity.verificationLastSentAt ?? '');
      if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < limits.cooldownMs) {
        return 'rate_limited' as const;
      }
      let windowStartedAt = identity.verificationWindowStartedAt;
      let sendsInWindow = identity.verificationSendsInWindow ?? 0;
      const windowMs = Date.parse(windowStartedAt ?? '');
      if (!Number.isFinite(windowMs) || nowMs - windowMs >= limits.windowMs) {
        windowStartedAt = doc.createdAt;
        sendsInWindow = 0;
      }
      if (sendsInWindow >= limits.maxPerWindow) return 'rate_limited' as const;

      identity.verificationLastSentAt = doc.createdAt;
      identity.verificationWindowStartedAt = windowStartedAt;
      identity.verificationSendsInWindow = sendsInWindow + 1;
      identity.updatedAt = doc.createdAt;
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), doc.userId);
      this.db.prepare('DELETE FROM workspace_email_verifications WHERE user_id = ?').run(doc.userId);
      this.db.prepare(
        'DELETE FROM workspace_email_verifications WHERE expires_at <= ?',
      ).run(doc.createdAt);
      this.db.prepare(
        'INSERT INTO workspace_email_verifications '
        + '(token_hash, user_id, email_canonical, expires_at, doc) VALUES (?, ?, ?, ?, ?)',
      ).run(doc.tokenHash, doc.userId, doc.emailCanonical, doc.expiresAt, serializeDoc(doc));
      return 'created' as const;
    });
    return transaction();
  }

  async consumeEmailVerification(
    tokenHash: string,
    nowIso: string,
  ): Promise<WorkspaceEmailVerificationConsumption> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_email_verifications WHERE token_hash = ?',
      ).get(tokenHash) as { doc: string } | undefined;
      if (!row) return { outcome: 'invalid' } as const;
      const verification = deserializeDoc<WorkspaceEmailVerificationDocument>(row.doc);
      if (Date.parse(verification.expiresAt) <= Date.parse(nowIso)) {
        this.db.prepare('DELETE FROM workspace_email_verifications WHERE token_hash = ?').run(tokenHash);
        return { outcome: 'expired' } as const;
      }
      const identityRow = this.db.prepare(
        'SELECT doc FROM workspace_email_identities WHERE user_id = ?',
      ).get(verification.userId) as { doc: string } | undefined;
      if (!identityRow) {
        this.db.prepare('DELETE FROM workspace_email_verifications WHERE token_hash = ?').run(tokenHash);
        return { outcome: 'invalid' } as const;
      }
      const identity = deserializeDoc<WorkspaceEmailIdentityDocument>(identityRow.doc);
      if (identity.emailCanonical !== verification.emailCanonical
        || identity.verificationStatus === 'verified' || identity.emailVerifiedAt) {
        this.db.prepare('DELETE FROM workspace_email_verifications WHERE token_hash = ?').run(tokenHash);
        return { outcome: 'invalid' } as const;
      }
      identity.verificationStatus = 'verified';
      identity.emailVerifiedAt = nowIso;
      identity.preserveLegacyLoginUntilVerified = undefined;
      identity.updatedAt = nowIso;
      this.db.prepare('UPDATE workspace_email_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), identity.userId);
      this.db.prepare('DELETE FROM workspace_email_verifications WHERE user_id = ?').run(identity.userId);
      return { outcome: 'verified', userId: identity.userId } as const;
    });
    return transaction();
  }

  async saveSecondFactorChallenge(doc: WorkspaceSecondFactorChallengeDocument): Promise<void> {
    this.db.prepare(
      "DELETE FROM workspace_second_factor_challenges WHERE json_extract(doc, '$.expiresAt') <= ?",
    ).run(doc.createdAt);
    this.db.prepare(
      'INSERT INTO workspace_second_factor_challenges (token_hash, doc) VALUES (?, ?) '
      + 'ON CONFLICT(token_hash) DO UPDATE SET doc = excluded.doc',
    ).run(doc.tokenHash, serializeDoc(doc));
  }

  async getSecondFactorChallenge(tokenHash: string, nowIso: string): Promise<WorkspaceSecondFactorChallengeDocument | null> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_second_factor_challenges WHERE token_hash = ?',
      ).get(tokenHash) as { doc: string } | undefined;
      if (!row) return null;
      const challenge = deserializeDoc<WorkspaceSecondFactorChallengeDocument>(row.doc);
      if (Date.parse(challenge.expiresAt) <= Date.parse(nowIso)) {
        this.db.prepare('DELETE FROM workspace_second_factor_challenges WHERE token_hash = ?').run(tokenHash);
        return null;
      }
      return challenge;
    });
    return transaction();
  }

  async deleteSecondFactorChallenge(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM workspace_second_factor_challenges WHERE token_hash = ?').run(tokenHash);
  }

  async saveEnrollment(doc: WorkspaceTotpEnrollmentDocument): Promise<void> {
    this.db.prepare(
      'INSERT INTO workspace_totp_enrollments (token_hash, doc) VALUES (?, ?) '
      + 'ON CONFLICT(token_hash) DO UPDATE SET doc = excluded.doc',
    ).run(doc.tokenHash, serializeDoc(doc));
  }

  async getEnrollment(tokenHash: string): Promise<WorkspaceTotpEnrollmentDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_totp_enrollments WHERE token_hash = ?',
    ).get(tokenHash) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceTotpEnrollmentDocument>(row.doc) : null;
  }

  async deleteEnrollment(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM workspace_totp_enrollments WHERE token_hash = ?').run(tokenHash);
  }

  async getIdentityByUserId(userId: string): Promise<WorkspaceTotpIdentityDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_totp_identities WHERE user_id = ?',
    ).get(userId) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceTotpIdentityDocument>(row.doc) : null;
  }

  async getIdentityByUsername(usernameCanonical: string): Promise<WorkspaceTotpIdentityDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_totp_identities WHERE username_canonical = ?',
    ).get(usernameCanonical) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceTotpIdentityDocument>(row.doc) : null;
  }

  async createIdentity(
    doc: WorkspaceTotpIdentityDocument,
  ): Promise<'created' | 'username_taken' | 'user_has_identity'> {
    const transaction = this.db.transaction(() => {
      const user = this.db.prepare(
        'SELECT 1 FROM workspace_totp_identities WHERE user_id = ?',
      ).get(doc.userId);
      if (user) return 'user_has_identity' as const;
      const username = this.db.prepare(
        'SELECT 1 FROM workspace_totp_identities WHERE username_canonical = ?',
      ).get(doc.usernameCanonical);
      if (username) return 'username_taken' as const;
      this.db.prepare(
        'INSERT INTO workspace_totp_identities (user_id, username_canonical, doc) VALUES (?, ?, ?)',
      ).run(doc.userId, doc.usernameCanonical, serializeDoc(doc));
      return 'created' as const;
    });
    return transaction();
  }

  async deleteIdentity(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM workspace_totp_identities WHERE user_id = ?').run(userId);
  }

  async acceptTotpStep(userId: string, step: number): Promise<boolean> {
    const transaction = this.db.transaction((): boolean => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_totp_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceTotpIdentityDocument>(row.doc);
      if (step <= identity.lastAcceptedStep) return false;
      identity.lastAcceptedStep = step;
      identity.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workspace_totp_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async consumeRecoveryCode(userId: string, encodedHash: string): Promise<boolean> {
    const transaction = this.db.transaction((): boolean => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_totp_identities WHERE user_id = ?',
      ).get(userId) as { doc: string } | undefined;
      if (!row) return false;
      const identity = deserializeDoc<WorkspaceTotpIdentityDocument>(row.doc);
      const index = identity.recoveryCodeHashes.indexOf(encodedHash);
      if (index < 0) return false;
      identity.recoveryCodeHashes.splice(index, 1);
      identity.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workspace_totp_identities SET doc = ? WHERE user_id = ?')
        .run(serializeDoc(identity), userId);
      return true;
    });
    return transaction();
  }

  async createSession(tokenHash: string, doc: WorkspaceWebSessionDocument): Promise<void> {
    this.db.prepare(
      'INSERT INTO workspace_web_sessions (session_hash, session_id, user_id, doc) VALUES (?, ?, ?, ?)',
    ).run(tokenHash, doc.sessionId, doc.userId, serializeDoc(doc));
  }

  async getSession(tokenHash: string): Promise<WorkspaceWebSessionDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_web_sessions WHERE session_hash = ?',
    ).get(tokenHash) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceWebSessionDocument>(row.doc) : null;
  }

  async getSessionById(userId: string, sessionId: string): Promise<WorkspaceWebSessionDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_web_sessions WHERE user_id = ? AND session_id = ?',
    ).get(userId, sessionId) as { doc: string } | undefined;
    return row ? deserializeDoc<WorkspaceWebSessionDocument>(row.doc) : null;
  }

  async touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT doc FROM workspace_web_sessions WHERE session_hash = ?',
      ).get(tokenHash) as { doc: string } | undefined;
      if (!row) return;
      const session = deserializeDoc<WorkspaceWebSessionDocument>(row.doc);
      if (session.revokedAt) return;
      session.lastSeenAt = lastSeenAt;
      session.idleExpiresAt = idleExpiresAt;
      this.db.prepare('UPDATE workspace_web_sessions SET doc = ? WHERE session_hash = ?')
        .run(serializeDoc(session), tokenHash);
    });
    transaction();
  }

  async revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    const transaction = this.db.transaction((): boolean => {
      const row = this.db.prepare(
        'SELECT session_hash, doc FROM workspace_web_sessions WHERE user_id = ? AND session_id = ?',
      ).get(userId, sessionId) as { session_hash: string; doc: string } | undefined;
      if (!row) return false;
      const session = deserializeDoc<WorkspaceWebSessionDocument>(row.doc);
      if (session.revokedAt) return false;
      session.revokedAt = revokedAt;
      this.db.prepare('UPDATE workspace_web_sessions SET doc = ? WHERE session_hash = ?')
        .run(serializeDoc(session), row.session_hash);
      return true;
    });
    return transaction();
  }

  async revokeAllSessions(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number> {
    const transaction = this.db.transaction((): number => {
      const rows = this.db.prepare(
        'SELECT session_hash, doc FROM workspace_web_sessions WHERE user_id = ?',
      ).all(userId) as Array<{ session_hash: string; doc: string }>;
      const update = this.db.prepare('UPDATE workspace_web_sessions SET doc = ? WHERE session_hash = ?');
      let count = 0;
      for (const row of rows) {
        const session = deserializeDoc<WorkspaceWebSessionDocument>(row.doc);
        if (session.revokedAt || session.sessionId === exceptSessionId) continue;
        session.revokedAt = revokedAt;
        update.run(serializeDoc(session), row.session_hash);
        count += 1;
      }
      return count;
    });
    return transaction();
  }

  async listSessions(userId: string): Promise<WorkspaceWebSessionDocument[]> {
    const rows = this.db.prepare(
      'SELECT doc FROM workspace_web_sessions WHERE user_id = ?',
    ).all(userId) as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<WorkspaceWebSessionDocument>(row.doc))
      .filter((doc) => !doc.revokedAt)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}
