import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { OrgSeatCredentialSource } from '../org-seat-credentials.js';
import {
  applyLeaseOutcome,
  isLeasable,
  leasedUpdates,
  newCredentialDocument,
  refreshPoolUsage,
  resolveSeatLease,
  resolveUserLease,
  selectLeaseCandidate,
  type PlatformCredentialPool,
} from '../platform-credential-pool.js';
import type {
  PlatformCredentialDocument,
  PlatformCredentialLease,
  PlatformCredentialLeaseOutcome,
  PlatformCredentialProvider,
  PlatformCredentialReleaseExtras,
  PlatformUserLease,
} from '../../types/platform-credential.js';

/**
 * SQLite-backed credential pool. All the health/selection logic is the shared
 * pure functions; lease/release run candidate
 * selection and the state write in ONE transaction, so there is no
 * select-outside-transaction race to tolerate.
 */
export class SqlitePlatformCredentialPool implements PlatformCredentialPool {
  /** Timer/UI refreshes share one provider pass; overlapping OAuth rotations are unsafe. */
  private usageRefreshInFlight?: Promise<void>;

  constructor(
    private readonly db: SqliteDb,
    private readonly seatSource?: OrgSeatCredentialSource,
  ) {}

  private loadAll(): PlatformCredentialDocument[] {
    const rows = this.db.prepare('SELECT doc FROM platform_credentials').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<PlatformCredentialDocument>(row.doc));
  }

  private save(doc: PlatformCredentialDocument): void {
    this.db.prepare(
      'INSERT INTO platform_credentials (credential_id, doc) VALUES (?, ?)'
      + ' ON CONFLICT(credential_id) DO UPDATE SET doc = excluded.doc',
    ).run(doc.credentialId, serializeDoc(doc));
  }

  async listCredentials(provider: PlatformCredentialProvider): Promise<PlatformCredentialDocument[]> {
    return this.loadAll().filter((doc) => doc.provider === provider);
  }

  async addCredential(args: {
    provider: PlatformCredentialProvider;
    token: string;
    label: string;
  }): Promise<PlatformCredentialDocument> {
    const doc = newCredentialDocument(args);
    this.save(doc);
    return doc;
  }

  async leaseCredential(
    provider: PlatformCredentialProvider,
    opts?: { preferredCredentialId?: string; model?: string },
  ): Promise<PlatformCredentialLease | null> {
    const tx = this.db.transaction((): PlatformCredentialLease | null => {
      const candidates = this.loadAll().filter((doc) => doc.provider === provider);
      const candidate = selectLeaseCandidate(candidates, undefined, opts?.preferredCredentialId, opts?.model);
      if (!candidate || !isLeasable(candidate, undefined, opts?.model)) return null;
      this.save({ ...candidate, ...leasedUpdates(candidate) });
      return { credentialId: candidate.credentialId, token: candidate.token };
    });
    return tx();
  }

  async leaseForUser(
    provider: PlatformCredentialProvider,
    userId: string,
    opts?: { model?: string; preferredCredentialId?: string; orgId?: string | null; seatId?: string },
  ): Promise<PlatformUserLease> {
    // Seats first, outside the transaction — the seat source has its own
    // transactional storage, and a member's resolution touches no pool row.
    const seatLease = await resolveSeatLease(this.seatSource, provider, userId, opts?.model, undefined, opts?.orgId, opts?.seatId);
    if (seatLease) return seatLease;
    const tx = this.db.transaction((): PlatformUserLease => {
      const candidates = this.loadAll().filter((doc) => doc.provider === provider);
      const resolution = resolveUserLease(candidates, userId, undefined, opts?.model);
      if (resolution.kind === 'dedicated_exhausted' || resolution.kind === 'payment_required') return resolution;
      const doc = resolution.kind === 'limbo' && opts?.preferredCredentialId !== undefined
        ? selectLeaseCandidate(candidates, undefined, opts.preferredCredentialId, opts?.model)
        : resolution.doc;
      if (!doc) return { kind: 'limbo', lease: null };
      this.save({ ...doc, ...leasedUpdates(doc) });
      return {
        kind: resolution.kind,
        lease: { credentialId: doc.credentialId, token: doc.token },
      };
    });
    return tx();
  }

  /**
   * One transaction for the provider, same shape as the routing pin: the
   * owner is exclusive per user, so clearing them elsewhere and setting them
   * here must not be writes a crash can land between.
   */
  async setOwner(
    provider: PlatformCredentialProvider,
    credentialId: string,
    ownerUserId: string | null,
  ): Promise<{ label: string } | null> {
    const tx = this.db.transaction((): { label: string } | null => {
      const docs = this.loadAll().filter((doc) => doc.provider === provider);
      const target = docs.find((doc) => doc.credentialId === credentialId);
      if (!target) return null;
      const now = new Date().toISOString();
      if (ownerUserId !== null) {
        for (const doc of docs) {
          if (doc.credentialId === credentialId) continue;
          if (doc.ownerUserId === ownerUserId) {
            const { ownerUserId: _cleared, ...rest } = doc;
            this.save({ ...rest, updatedAt: now });
          }
        }
        this.save({ ...target, ownerUserId, updatedAt: now });
      } else {
        const { ownerUserId: _cleared, ...rest } = target;
        this.save({ ...rest, updatedAt: now });
      }
      return { label: target.label };
    });
    return tx();
  }

  async releaseCredential(
    credentialId: string,
    outcome: PlatformCredentialLeaseOutcome,
    extras?: PlatformCredentialReleaseExtras,
  ): Promise<void> {
    if (this.seatSource?.owns(credentialId)) {
      return this.seatSource.release(credentialId, outcome, extras);
    }
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT doc FROM platform_credentials WHERE credential_id = ?')
        .get(credentialId) as { doc: string } | undefined;
      if (!row) return;
      const doc = deserializeDoc<PlatformCredentialDocument>(row.doc);
      this.save({ ...doc, ...applyLeaseOutcome(doc, outcome, undefined, extras) });
    });
    tx();
  }

  /**
   * One transaction for the whole provider: the pin is exclusive, so clearing
   * the old one and setting the new one must not be two writes a crash can
   * land between — that leaves either two pinned accounts or none.
   */
  async setRoutingPin(
    provider: PlatformCredentialProvider,
    credentialId: string | null,
  ): Promise<{ label: string } | null> {
    const tx = this.db.transaction((): { label: string } | null => {
      let pinned: PlatformCredentialDocument | null = null;
      for (const doc of this.loadAll()) {
        if (doc.provider !== provider) continue;
        const shouldPin = credentialId !== null && doc.credentialId === credentialId;
        if (shouldPin) pinned = doc;
        if (shouldPin === (doc.routingPin === true)) continue;
        this.save({ ...doc, routingPin: shouldPin, updatedAt: new Date().toISOString() });
      }
      return pinned ? { label: pinned.label } : null;
    });
    return tx();
  }

  async refreshUsage(fetchImpl?: typeof fetch): Promise<void> {
    // Opening Workspace seats/usage and the five-minute timer can all ask at
    // once. A Claude refresh rotates both tokens, so two passes over the same
    // snapshot can revoke each other's result and let the slower write win.
    // Coalesce the whole pass; every caller awaits the same fresh reading.
    if (this.usageRefreshInFlight) return this.usageRefreshInFlight;
    const refresh = (async () => {
      await refreshPoolUsage(this, async (credentialId, updates) => {
        const row = this.db.prepare('SELECT doc FROM platform_credentials WHERE credential_id = ?')
          .get(credentialId) as { doc: string } | undefined;
        if (!row) return;
        const doc = deserializeDoc<PlatformCredentialDocument>(row.doc);
        this.save({ ...doc, ...updates });
      }, fetchImpl);
      if (this.seatSource) {
        const seatSource = this.seatSource;
        await refreshPoolUsage(
          { listCredentials: (provider) => seatSource.listAllForProbe(provider) },
          (credentialId, updates) => seatSource.applyCredentialUpdates(credentialId, updates),
          fetchImpl,
        );
      }
    })();
    this.usageRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.usageRefreshInFlight === refresh) this.usageRefreshInFlight = undefined;
    }
  }
}
