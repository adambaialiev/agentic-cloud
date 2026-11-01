import { randomUUID } from 'node:crypto';
import type {
  OrgDocument,
  OrgInviteDocument,
  OrgInviteRedemption,
  OrgJoinDecision,
  OrgJoinDecisionOutcome,
  OrgJoinRequestDocument,
  OrgJoinRequestOutcome,
  OrgMembershipDocument,
  OrgRole,
  OrgSeatAssignmentDocument,
  OrgSeatDocument,
} from '../../types/org.js';
import {
  byInviteCreatedAtDesc,
  byJoinedAtAsc,
  byRequestedAtDesc,
  bySeatCreatedAtDesc,
  mintInviteToken,
  stampSeat,
  type OrgMemberTouch,
  type OrgStorage,
} from '../org-storage.js';
import { pickWorkspaceAgentAvatarSlug } from '../telegram-agent-avatars.js';
import type { SecretCipher } from '../secret-cipher.js';
import { openSeatCredentials, sealSeatCredentials } from '../seat-credential-cipher.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';

/**
 * SQLite-backed OrgStorage. Same shapes and rules as the InMemory
 * implementation (org-storage.ts documents them). Active membership,
 * per-org seat assignment/ordering and single-use invites each run inside one
 * transaction, which the single backend process makes sufficient.
 *
 * With a cipher, each seat's secret material is encrypted in the row and
 * decrypted on the way out (seat-credential-cipher.ts) — callers only ever
 * see plaintext. Without one, rows are written as plain JSON.
 */
export class SqliteOrgStorage implements OrgStorage {
  constructor(private readonly db: SqliteDb, private readonly cipher: SecretCipher | null = null) {
    // Idempotent cutover: every pre-multi-org seat starts assigned to the org
    // its row used to belong to. The credential row stays put; all new routing
    // reads the assignment table.
    const rows = this.db.prepare('SELECT seat_id, org_id, user_id, doc FROM org_seats').all() as
      Array<{ seat_id: string; org_id: string; user_id: string; doc: string }>;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO org_seat_assignments '
      + '(org_id, user_id, seat_id, selected, priority, assigned_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const migrate = this.db.transaction(() => {
      const groups = new Map<string, Array<{ row: typeof rows[number]; seat: OrgSeatDocument }>>();
      for (const row of rows) {
        const seat = deserializeDoc<OrgSeatDocument>(row.doc);
        const key = `${row.org_id}/${row.user_id}/${seat.provider}`;
        const group = groups.get(key) ?? [];
        group.push({ row, seat });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => bySeatCreatedAtDesc(a.seat, b.seat));
        group.forEach(({ row, seat }, priority) => {
          insert.run(row.org_id, row.user_id, row.seat_id, seat.selected ? 1 : 0, priority, seat.createdAt);
        });
      }
    });
    migrate();
  }

  private membershipRow(orgId: string, userId: string): OrgMembershipDocument | null {
    const row = this.db.prepare('SELECT doc FROM org_members WHERE org_id = ? AND user_id = ?')
      .get(orgId, userId) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgMembershipDocument>(row.doc) : null;
  }

  async createOrg(doc: Omit<OrgDocument, 'orgId' | 'createdAt'>): Promise<OrgDocument> {
    const createdAt = new Date().toISOString();
    // Born with ONE knowledge shelf (note #566): a new workplace has no
    // per-room bases to merge, so it never reads the pre-merge shape.
    const org: OrgDocument = {
      ...doc,
      knowledgeShelf: doc.knowledgeShelf ?? { mergedAt: createdAt },
      // One set of secrets per workplace from birth (note #783): nothing to merge.
      secretShelf: doc.secretShelf ?? { mergedAt: createdAt },
      // And with no rooms to keep apart (note #843): every room it is given
      // resolves to the workplace's own namespace from the first note on.
      roomsMerged: doc.roomsMerged ?? { mergedAt: createdAt },
      workspaceAgentAvatarSlug: doc.workspaceAgentAvatarSlug ?? pickWorkspaceAgentAvatarSlug(),
      orgId: randomUUID(),
      createdAt,
    };
    this.db.prepare('INSERT INTO orgs (org_id, doc) VALUES (?, ?)').run(org.orgId, serializeDoc(org));
    return org;
  }

  async getOrg(orgId: string): Promise<OrgDocument | null> {
    const row = this.db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(orgId) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgDocument>(row.doc) : null;
  }

  async listOrgs(): Promise<OrgDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM orgs').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<OrgDocument>(row.doc));
  }

  async updateOrg(orgId: string, updates: Partial<Omit<OrgDocument, 'orgId' | 'createdAt'>>): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(orgId) as { doc: string } | undefined;
      if (!row) return false;
      const org = deserializeDoc<OrgDocument>(row.doc);
      const next: OrgDocument = { ...org, ...updates, orgId: org.orgId, createdAt: org.createdAt };
      this.db.prepare('UPDATE orgs SET doc = ? WHERE org_id = ?').run(serializeDoc(next), orgId);
      return true;
    });
    return tx();
  }

  /**
   * `org_handles` is the uniqueness: one row per word given out, pointing
   * at the workplace it belongs to. The document carries the same fact for
   * reading; the table is what refuses a second taker, inside the one
   * transaction that also rewrites the document.
   */
  async claimHandle(orgId: string, handle: string): Promise<'claimed' | 'taken' | 'missing'> {
    const tx = this.db.transaction((): 'claimed' | 'taken' | 'missing' => {
      const row = this.db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(orgId) as { doc: string } | undefined;
      if (!row) return 'missing';
      const org = deserializeDoc<OrgDocument>(row.doc);
      if (org.handle === handle) return 'claimed';
      if (org.handle) return 'taken';
      const held = this.db.prepare('SELECT org_id FROM org_handles WHERE handle = ?').get(handle) as { org_id: string } | undefined;
      if (held) return 'taken';
      this.db.prepare('INSERT INTO org_handles (handle, org_id) VALUES (?, ?)').run(handle, orgId);
      this.db.prepare('UPDATE orgs SET doc = ? WHERE org_id = ?').run(serializeDoc({ ...org, handle }), orgId);
      return 'claimed';
    });
    return tx();
  }

  async getOrgByHandle(handle: string): Promise<OrgDocument | null> {
    const row = this.db.prepare('SELECT o.doc AS doc FROM org_handles h JOIN orgs o ON o.org_id = h.org_id WHERE h.handle = ?')
      .get(handle) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgDocument>(row.doc) : null;
  }

  async addMember(doc: Omit<OrgMembershipDocument, 'joinedAt'>): Promise<OrgMembershipDocument> {
    const tx = this.db.transaction((): OrgMembershipDocument => {
      if (this.membershipRow(doc.orgId, doc.userId)) {
        throw new Error(`user ${doc.userId} is already a member of org ${doc.orgId}`);
      }
      const first = (this.db.prepare('SELECT 1 FROM org_members WHERE user_id = ? LIMIT 1')
        .get(doc.userId) as { 1: number } | undefined) === undefined;
      const membership: OrgMembershipDocument = {
        ...doc, active: first || undefined, joinedAt: new Date().toISOString(),
      };
      this.db.prepare('INSERT INTO org_members (org_id, user_id, doc) VALUES (?, ?, ?)')
        .run(membership.orgId, membership.userId, serializeDoc(membership));
      return membership;
    });
    return tx();
  }

  async getMembership(orgId: string, userId: string): Promise<OrgMembershipDocument | null> {
    return this.membershipRow(orgId, userId);
  }

  async listMembershipsByUser(userId: string): Promise<OrgMembershipDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_members WHERE user_id = ?').all(userId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<OrgMembershipDocument>(row.doc))
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active))
        || a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId));
  }

  async getMembershipByUser(userId: string): Promise<OrgMembershipDocument | null> {
    return (await this.listMembershipsByUser(userId))[0] ?? null;
  }

  async setActiveOrg(userId: string, orgId: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      if (!this.membershipRow(orgId, userId)) return false;
      const rows = this.db.prepare('SELECT org_id, doc FROM org_members WHERE user_id = ?').all(userId) as
        Array<{ org_id: string; doc: string }>;
      const update = this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?');
      for (const row of rows) {
        const membership = deserializeDoc<OrgMembershipDocument>(row.doc);
        const next = { ...membership, active: row.org_id === orgId || undefined };
        update.run(serializeDoc(next), row.org_id, userId);
      }
      return true;
    });
    return tx();
  }

  async listMembers(orgId: string): Promise<OrgMembershipDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_members WHERE org_id = ?').all(orgId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<OrgMembershipDocument>(r.doc))
      .sort(byJoinedAtAsc);
  }

  async setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM org_members WHERE org_id = ? AND user_id = ?')
        .get(orgId, userId) as { doc: string } | undefined;
      if (!row) return false;
      const membership = { ...deserializeDoc<OrgMembershipDocument>(row.doc), role };
      this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?')
        .run(serializeDoc(membership), orgId, userId);
      return true;
    });
    return tx();
  }

  async touchMember(orgId: string, userId: string, touch: OrgMemberTouch): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM org_members WHERE org_id = ? AND user_id = ?')
        .get(orgId, userId) as { doc: string } | undefined;
      if (!row) return false;
      const membership = { ...deserializeDoc<OrgMembershipDocument>(row.doc), ...touch };
      this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?')
        .run(serializeDoc(membership), orgId, userId);
      return true;
    });
    return tx();
  }

  async initializeWorkspaceAgentSettings(
    orgId: string,
    userId: string,
    settings: NonNullable<OrgMembershipDocument['workspaceAgentSettings']>,
  ): Promise<OrgMembershipDocument | null> {
    const tx = this.db.transaction((): OrgMembershipDocument | null => {
      const row = this.db.prepare('SELECT doc FROM org_members WHERE org_id = ? AND user_id = ?')
        .get(orgId, userId) as { doc: string } | undefined;
      if (!row) return null;
      const membership = deserializeDoc<OrgMembershipDocument>(row.doc);
      if (membership.workspaceAgentSettings) return membership;
      const initialized = { ...membership, workspaceAgentSettings: settings };
      this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?')
        .run(serializeDoc(initialized), orgId, userId);
      return initialized;
    });
    return tx();
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const existing = this.membershipRow(orgId, userId);
      const removed = this.db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?')
        .run(orgId, userId).changes > 0;
      if (removed) {
        this.db.prepare('DELETE FROM org_seat_assignments WHERE org_id = ? AND user_id = ?').run(orgId, userId);
        if (existing?.active) {
          const row = this.db.prepare('SELECT org_id, doc FROM org_members WHERE user_id = ? ORDER BY rowid LIMIT 1')
            .get(userId) as { org_id: string; doc: string } | undefined;
          if (row) {
            const membership = deserializeDoc<OrgMembershipDocument>(row.doc);
            this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?')
              .run(serializeDoc({ ...membership, active: true }), row.org_id, userId);
          }
        }
      }
      return removed;
    });
    return tx();
  }

  async deleteOrg(orgId: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const member = this.db.prepare('SELECT 1 FROM org_members WHERE org_id = ? LIMIT 1').get(orgId);
      if (member) return false;
      this.db.prepare('DELETE FROM org_invites WHERE org_id = ?').run(orgId);
      this.db.prepare('DELETE FROM org_join_requests WHERE org_id = ?').run(orgId);
      this.db.prepare('DELETE FROM org_seat_assignments WHERE org_id = ?').run(orgId);
      // A deleted workplace frees its words, exactly as it frees its site
      // names (deleting-a-workplace): nothing of it is left to arrive at.
      this.db.prepare('DELETE FROM org_handles WHERE org_id = ?').run(orgId);
      return this.db.prepare('DELETE FROM orgs WHERE org_id = ?').run(orgId).changes > 0;
    });
    return tx();
  }

  async getOrgByNamespace(namespaceId: string): Promise<OrgDocument | null> {
    // The workplace's own namespace first — where everything new stands —
    // then the old rooms' namespaces recorded on it (note #843).
    const own = this.db.prepare("SELECT doc FROM orgs WHERE json_extract(doc, '$.git.namespaceId') = ? LIMIT 1")
      .get(namespaceId) as { doc: string } | undefined;
    const row = own ?? this.db.prepare(
      "SELECT doc FROM orgs WHERE EXISTS (SELECT 1 FROM json_each(orgs.doc, '$.roomsMerged.namespaces') WHERE value = ?) LIMIT 1",
    ).get(namespaceId) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgDocument>(row.doc) : null;
  }

  async addSeat(doc: Omit<OrgSeatDocument, 'seatId' | 'selected' | 'createdAt' | 'updatedAt'>): Promise<OrgSeatDocument> {
    const tx = this.db.transaction((): OrgSeatDocument => {
      const seat = stampSeat(doc);
      this.db.prepare('INSERT INTO org_seats (seat_id, org_id, user_id, doc) VALUES (?, ?, ?, ?)')
        .run(seat.seatId, seat.orgId, seat.userId, serializeDoc(sealSeatCredentials(seat, this.cipher)));
      const assignment = this.assignSeatSync(seat.orgId, seat.userId, seat.seatId);
      if (!assignment) throw new Error(`user ${seat.userId} is not a member of org ${seat.orgId}`);
      return { ...seat, selected: true, assignmentPriority: assignment.priority };
    });
    return tx();
  }

  async getSeat(seatId: string): Promise<OrgSeatDocument | null> {
    const row = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(seatId) as { doc: string } | undefined;
    return row ? this.readSeat(row.doc) : null;
  }

  /** A seat row as callers see it: secret material decrypted. */
  private readSeat(doc: string): OrgSeatDocument {
    return openSeatCredentials(deserializeDoc<OrgSeatDocument>(doc), this.cipher);
  }

  async listSeatsByMember(orgId: string, userId: string): Promise<OrgSeatDocument[]> {
    const rows = this.db.prepare(
      'SELECT s.doc, a.selected, a.priority FROM org_seat_assignments a '
      + 'JOIN org_seats s ON s.seat_id = a.seat_id '
      + 'WHERE a.org_id = ? AND a.user_id = ? ORDER BY a.priority, a.assigned_at',
    ).all(orgId, userId) as Array<{ doc: string; selected: number; priority: number }>;
    return rows.map((row) => ({
      ...this.readSeat(row.doc),
      orgId,
      selected: row.selected === 1,
      assignmentPriority: row.priority,
    }));
  }

  async listSeatsByUser(userId: string): Promise<OrgSeatDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_seats WHERE user_id = ?').all(userId) as Array<{ doc: string }>;
    return rows.map((row) => this.readSeat(row.doc)).sort(bySeatCreatedAtDesc);
  }

  async listAllSeats(): Promise<OrgSeatDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_seats').all() as Array<{ doc: string }>;
    return rows.map((r) => this.readSeat(r.doc)).sort(bySeatCreatedAtDesc);
  }

  async updateSeat(
    seatId: string,
    updates: Partial<Omit<OrgSeatDocument, 'seatId' | 'orgId' | 'userId' | 'createdAt'>>,
  ): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(seatId) as { doc: string } | undefined;
      if (!row) return false;
      // Sealing skips what is already sealed, so a row's untouched ciphertext
      // is carried over as is and only new material is encrypted.
      const seat = deserializeDoc<OrgSeatDocument>(row.doc);
      const next: OrgSeatDocument = {
        ...seat, ...updates,
        seatId: seat.seatId, orgId: seat.orgId, userId: seat.userId, createdAt: seat.createdAt,
        updatedAt: new Date().toISOString(),
      };
      this.db.prepare('UPDATE org_seats SET doc = ? WHERE seat_id = ?')
        .run(serializeDoc(sealSeatCredentials(next, this.cipher)), seatId);
      return true;
    });
    return tx();
  }

  async isSeatAssigned(orgId: string, userId: string, seatId: string): Promise<boolean> {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM org_seat_assignments WHERE org_id = ? AND user_id = ? AND seat_id = ?',
    ).get(orgId, userId, seatId));
  }

  private assignSeatSync(orgId: string, userId: string, seatId: string): OrgSeatAssignmentDocument | null {
    if (!this.membershipRow(orgId, userId)) return null;
    const row = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ? AND user_id = ?')
      .get(seatId, userId) as { doc: string } | undefined;
    if (!row) return null;
    const seat = deserializeDoc<OrgSeatDocument>(row.doc);
    const sameProvider = this.db.prepare(
      'SELECT a.seat_id FROM org_seat_assignments a JOIN org_seats s ON s.seat_id = a.seat_id '
      + "WHERE a.org_id = ? AND a.user_id = ? AND json_extract(s.doc, '$.provider') = ? ORDER BY a.priority",
    ).all(orgId, userId, seat.provider) as Array<{ seat_id: string }>;
    this.db.prepare(
      'UPDATE org_seat_assignments SET selected = 0 WHERE org_id = ? AND user_id = ? AND seat_id IN '
      + `(SELECT seat_id FROM org_seats WHERE json_extract(doc, '$.provider') = ?)`,
    ).run(orgId, userId, seat.provider);
    const existing = this.db.prepare(
      'SELECT selected, priority, assigned_at FROM org_seat_assignments WHERE org_id = ? AND user_id = ? AND seat_id = ?',
    ).get(orgId, userId, seatId) as { selected: number; priority: number; assigned_at: string } | undefined;
    const assignedAt = existing?.assigned_at ?? new Date().toISOString();
    const priority = existing?.priority ?? sameProvider.length;
    this.db.prepare(
      'INSERT INTO org_seat_assignments (org_id, user_id, seat_id, selected, priority, assigned_at) '
      + 'VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(org_id, user_id, seat_id) DO UPDATE SET selected = 1',
    ).run(orgId, userId, seatId, priority, assignedAt);
    return { orgId, userId, seatId, selected: true, priority, assignedAt };
  }

  async assignSeat(orgId: string, userId: string, seatId: string): Promise<OrgSeatAssignmentDocument | null> {
    const tx = this.db.transaction((): boolean => {
      return Boolean(this.assignSeatSync(orgId, userId, seatId));
    });
    return tx() ? this.assignment(orgId, userId, seatId) : null;
  }

  private assignment(orgId: string, userId: string, seatId: string): OrgSeatAssignmentDocument | null {
    const row = this.db.prepare(
      'SELECT selected, priority, assigned_at FROM org_seat_assignments WHERE org_id = ? AND user_id = ? AND seat_id = ?',
    ).get(orgId, userId, seatId) as { selected: number; priority: number; assigned_at: string } | undefined;
    return row ? {
      orgId, userId, seatId, selected: row.selected === 1, priority: row.priority, assignedAt: row.assigned_at,
    } : null;
  }

  async unassignSeat(orgId: string, userId: string, seatId: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const assignment = this.assignment(orgId, userId, seatId);
      const seat = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(seatId) as { doc: string } | undefined;
      if (!assignment || !seat) return false;
      this.db.prepare('DELETE FROM org_seat_assignments WHERE org_id = ? AND user_id = ? AND seat_id = ?')
        .run(orgId, userId, seatId);
      this.normalizeAssignmentsSync(
        orgId, userId, deserializeDoc<OrgSeatDocument>(seat.doc).provider, assignment.selected,
      );
      return true;
    });
    return tx();
  }

  async selectSeat(seatId: string, orgId?: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(seatId) as { doc: string } | undefined;
      if (!row) return false;
      const seat = deserializeDoc<OrgSeatDocument>(row.doc);
      const targetOrg = orgId ?? seat.orgId;
      if (!this.assignment(targetOrg, seat.userId, seatId)) return false;
      this.db.prepare(
        'UPDATE org_seat_assignments SET selected = CASE WHEN seat_id = ? THEN 1 ELSE 0 END '
        + 'WHERE org_id = ? AND user_id = ? AND seat_id IN '
        + `(SELECT seat_id FROM org_seats WHERE json_extract(doc, '$.provider') = ?)`,
      ).run(seatId, targetOrg, seat.userId, seat.provider);
      return true;
    });
    return tx();
  }

  async orderSeats(orgId: string, userId: string, provider: string, seatIds: string[]): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const current = this.db.prepare(
        'SELECT a.seat_id FROM org_seat_assignments a JOIN org_seats s ON s.seat_id = a.seat_id '
        + "WHERE a.org_id = ? AND a.user_id = ? AND json_extract(s.doc, '$.provider') = ?",
      ).all(orgId, userId, provider) as Array<{ seat_id: string }>;
      if (current.length !== seatIds.length || new Set(seatIds).size !== seatIds.length
        || current.some((row) => !seatIds.includes(row.seat_id))) return false;
      const update = this.db.prepare(
        'UPDATE org_seat_assignments SET priority = ? WHERE org_id = ? AND user_id = ? AND seat_id = ?',
      );
      seatIds.forEach((id, priority) => update.run(priority, orgId, userId, id));
      return true;
    });
    return tx();
  }

  private normalizeAssignmentsSync(orgId: string, userId: string, provider: string, needsPrimary: boolean): void {
    const rows = this.db.prepare(
      'SELECT a.seat_id, a.selected FROM org_seat_assignments a JOIN org_seats s ON s.seat_id = a.seat_id '
      + "WHERE a.org_id = ? AND a.user_id = ? AND json_extract(s.doc, '$.provider') = ? "
      + 'ORDER BY a.priority, a.assigned_at',
    ).all(orgId, userId, provider) as Array<{ seat_id: string; selected: number }>;
    const update = this.db.prepare(
      'UPDATE org_seat_assignments SET priority = ?, selected = ? WHERE org_id = ? AND user_id = ? AND seat_id = ?',
    );
    rows.forEach((row, priority) => update.run(
      priority,
      needsPrimary && priority === 0 ? 1 : row.selected,
      orgId,
      userId,
      row.seat_id,
    ));
  }

  async removeSeat(seatId: string): Promise<boolean> {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(seatId) as { doc: string } | undefined;
      if (!row) return false;
      const seat = deserializeDoc<OrgSeatDocument>(row.doc);
      const assignments = this.db.prepare(
        'SELECT org_id, user_id, selected FROM org_seat_assignments WHERE seat_id = ?',
      ).all(seatId) as Array<{ org_id: string; user_id: string; selected: number }>;
      this.db.prepare('DELETE FROM org_seat_assignments WHERE seat_id = ?').run(seatId);
      this.db.prepare('DELETE FROM org_seats WHERE seat_id = ?').run(seatId);
      for (const assignment of assignments) {
        this.normalizeAssignmentsSync(
          assignment.org_id, assignment.user_id, seat.provider, assignment.selected === 1,
        );
      }
      return true;
    });
    return tx();
  }

  async createInvite(doc: Omit<OrgInviteDocument, 'token' | 'createdAt'>): Promise<OrgInviteDocument> {
    const invite: OrgInviteDocument = { ...doc, token: mintInviteToken(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO org_invites (token, org_id, doc) VALUES (?, ?, ?)')
      .run(invite.token, invite.orgId, serializeDoc(invite));
    return invite;
  }

  async getInvite(token: string): Promise<OrgInviteDocument | null> {
    const row = this.db.prepare('SELECT doc FROM org_invites WHERE token = ?').get(token) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgInviteDocument>(row.doc) : null;
  }

  async listInvites(orgId: string): Promise<OrgInviteDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_invites WHERE org_id = ?').all(orgId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<OrgInviteDocument>(r.doc)).sort(byInviteCreatedAtDesc);
  }

  async revokeInvite(token: string): Promise<'revoked' | 'used' | 'unknown'> {
    const tx = this.db.transaction((): 'revoked' | 'used' | 'unknown' => {
      const row = this.db.prepare('SELECT doc FROM org_invites WHERE token = ?').get(token) as { doc: string } | undefined;
      if (!row) return 'unknown';
      if (deserializeDoc<OrgInviteDocument>(row.doc).usedAt) return 'used';
      this.db.prepare('DELETE FROM org_invites WHERE token = ?').run(token);
      return 'revoked';
    });
    return tx();
  }

  async redeemInvite(token: string, userId: string, now: Date = new Date()): Promise<OrgInviteRedemption> {
    const tx = this.db.transaction((): OrgInviteRedemption => {
      const row = this.db.prepare('SELECT doc FROM org_invites WHERE token = ?').get(token) as { doc: string } | undefined;
      const invite = row ? deserializeDoc<OrgInviteDocument>(row.doc) : null;
      const orgRow = invite
        ? this.db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(invite.orgId) as { doc: string } | undefined
        : undefined;
      if (!invite || !orgRow) return { ok: false, reason: 'unknown' };
      if (invite.usedAt) return { ok: false, reason: 'used' };
      if (this.membershipRow(invite.orgId, userId)) return { ok: false, reason: 'already-member' };
      const siblings = this.db.prepare('SELECT org_id, doc FROM org_members WHERE user_id = ?').all(userId) as
        Array<{ org_id: string; doc: string }>;
      const updateMember = this.db.prepare('UPDATE org_members SET doc = ? WHERE org_id = ? AND user_id = ?');
      for (const sibling of siblings) {
        const stored = deserializeDoc<OrgMembershipDocument>(sibling.doc);
        updateMember.run(serializeDoc({ ...stored, active: undefined }), sibling.org_id, userId);
      }
      const membership: OrgMembershipDocument = {
        orgId: invite.orgId, userId, role: 'member',
        invitedByUserId: invite.createdByUserId, joinedAt: now.toISOString(), active: true,
      };
      this.db.prepare('INSERT INTO org_members (org_id, user_id, doc) VALUES (?, ?, ?)')
        .run(membership.orgId, membership.userId, serializeDoc(membership));
      const used: OrgInviteDocument = { ...invite, usedAt: now.toISOString(), usedByUserId: userId };
      this.db.prepare('UPDATE org_invites SET doc = ? WHERE token = ?').run(serializeDoc(used), token);
      return { ok: true, membership, org: deserializeDoc<OrgDocument>(orgRow.doc) };
    });
    return tx();
  }

  private joinRequestRow(requestId: string): OrgJoinRequestDocument | null {
    const row = this.db.prepare('SELECT doc FROM org_join_requests WHERE request_id = ?')
      .get(requestId) as { doc: string } | undefined;
    return row ? deserializeDoc<OrgJoinRequestDocument>(row.doc) : null;
  }

  private writeJoinRequest(request: OrgJoinRequestDocument, insert: boolean): void {
    if (insert) {
      this.db.prepare('INSERT INTO org_join_requests (request_id, org_id, user_id, status, doc) VALUES (?, ?, ?, ?, ?)')
        .run(request.requestId, request.orgId, request.userId, request.status, serializeDoc(request));
    } else {
      this.db.prepare('UPDATE org_join_requests SET status = ?, doc = ? WHERE request_id = ?')
        .run(request.status, serializeDoc(request), request.requestId);
    }
  }

  async requestToJoin(token: string, userId: string, now: Date = new Date()): Promise<OrgJoinRequestOutcome> {
    const tx = this.db.transaction((): OrgJoinRequestOutcome => {
      const row = this.db.prepare('SELECT doc FROM org_invites WHERE token = ?').get(token) as { doc: string } | undefined;
      const invite = row ? deserializeDoc<OrgInviteDocument>(row.doc) : null;
      const orgRow = invite
        ? this.db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(invite.orgId) as { doc: string } | undefined
        : undefined;
      if (!invite || !orgRow) return { ok: false, reason: 'unknown' };
      if (invite.usedAt) return { ok: false, reason: 'used' };
      if (this.membershipRow(invite.orgId, userId)) return { ok: false, reason: 'already-member' };
      const org = deserializeDoc<OrgDocument>(orgRow.doc);
      const pendingRow = this.db.prepare(
        'SELECT doc FROM org_join_requests WHERE org_id = ? AND user_id = ? AND status = ? LIMIT 1',
      ).get(invite.orgId, userId, 'pending') as { doc: string } | undefined;
      if (pendingRow) return { ok: true, request: deserializeDoc<OrgJoinRequestDocument>(pendingRow.doc), org };
      const request: OrgJoinRequestDocument = {
        requestId: randomUUID(), orgId: invite.orgId, userId, inviteToken: token,
        requestedAt: now.toISOString(), status: 'pending',
      };
      this.writeJoinRequest(request, true);
      return { ok: true, request, org };
    });
    return tx();
  }

  async getJoinRequest(requestId: string): Promise<OrgJoinRequestDocument | null> {
    return this.joinRequestRow(requestId);
  }

  async getJoinRequestByUser(orgId: string, userId: string): Promise<OrgJoinRequestDocument | null> {
    const rows = this.db.prepare('SELECT doc FROM org_join_requests WHERE org_id = ? AND user_id = ? ORDER BY rowid DESC')
      .all(orgId, userId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<OrgJoinRequestDocument>(r.doc)).sort(byRequestedAtDesc)[0] ?? null;
  }

  async listJoinRequests(orgId: string): Promise<OrgJoinRequestDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_join_requests WHERE org_id = ? ORDER BY rowid DESC').all(orgId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<OrgJoinRequestDocument>(r.doc)).sort(byRequestedAtDesc);
  }

  async listJoinRequestsByUser(userId: string): Promise<OrgJoinRequestDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM org_join_requests WHERE user_id = ? ORDER BY rowid DESC').all(userId) as Array<{ doc: string }>;
    return rows.map((r) => deserializeDoc<OrgJoinRequestDocument>(r.doc)).sort(byRequestedAtDesc);
  }

  async decideJoinRequest(
    requestId: string, adminUserId: string, decision: OrgJoinDecision, now: Date = new Date(),
  ): Promise<OrgJoinDecisionOutcome> {
    const tx = this.db.transaction((): OrgJoinDecisionOutcome => {
      const request = this.joinRequestRow(requestId);
      const orgExists = request
        ? this.db.prepare('SELECT 1 FROM orgs WHERE org_id = ?').get(request.orgId) !== undefined
        : false;
      if (!request || !orgExists) return { ok: false, reason: 'unknown' };
      const admin = this.membershipRow(request.orgId, adminUserId);
      if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
      if (request.status !== 'pending') return { ok: false, reason: 'resolved' };
      const decided: OrgJoinRequestDocument = {
        ...request, status: decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: now.toISOString(), decidedByUserId: adminUserId,
      };
      this.writeJoinRequest(decided, false);
      // Already a member (added another way meanwhile): their role stands.
      if (decision === 'approve' && !this.membershipRow(request.orgId, request.userId)) {
        // Active only when this is their first org: an approval never moves
        // someone's current Workspace context.
        const first = this.db.prepare('SELECT 1 FROM org_members WHERE user_id = ? LIMIT 1').get(request.userId) === undefined;
        const membership: OrgMembershipDocument = {
          orgId: request.orgId, userId: request.userId, role: 'member',
          invitedByUserId: adminUserId, joinedAt: now.toISOString(), active: first || undefined,
        };
        this.db.prepare('INSERT INTO org_members (org_id, user_id, doc) VALUES (?, ?, ?)')
          .run(membership.orgId, membership.userId, serializeDoc(membership));
      }
      return { ok: true, request: decided };
    });
    return tx();
  }
}
