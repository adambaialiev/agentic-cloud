import { randomBytes, randomUUID } from 'node:crypto';
import type {
  OrgDocument,
  OrgInviteDocument,
  OrgInviteRedemption,
  OrgInviteRefusal,
  OrgJoinDecision,
  OrgJoinDecisionOutcome,
  OrgJoinRequestDocument,
  OrgJoinRequestOutcome,
  OrgMembershipDocument,
  OrgRole,
  OrgSeatAssignmentDocument,
  OrgSeatDocument,
} from '../types/org.js';
import { pickWorkspaceAgentAvatarSlug } from './telegram-agent-avatars.js';

// The join-request shapes, re-exported so routes and the shared API import
// them from the storage they call rather than reaching into types/.
export type {
  OrgJoinDecision,
  OrgJoinDecisionOutcome,
  OrgJoinDecisionRefusal,
  OrgJoinRequestDocument,
  OrgJoinRequestOutcome,
  OrgJoinRequestStatus,
} from '../types/org.js';

/**
 * Storage for the org layer (types/org.ts). Rules that live HERE, because
 * every caller must get them for free:
 *
 *  - **Many orgs, one active Workspace context.** Membership is keyed by
 *    (org, user). `setActiveOrg` moves the user's one active marker; agents do
 *    not read it because each agent is permanently pinned to its own org.
 *  - **Private sign-ins, per-org assignments.** A credential belongs to one
 *    human and may be assigned to several orgs at once. The Workspace carries
 *    current sign-ins into a membership on first entry (note #602); selection,
 *    later unassignment and fallback order remain independent per org.
 *  - **An invite is single-use, atomically.** Redemption checks prior
 *    use, creates the membership and burns the token as one step, so
 *    two taps on a forwarded link cannot both land. (Legacy path: the web
 *    Workspace now files join requests instead, below.)
 *  - **A join request is the admitted door (note #1).** Submitting a live link
 *    files ONE pending request per (org, user) — a second link, a reload or
 *    two tabs all land on the same pending row — and burns nothing. Only an
 *    admin's approval, which rechecks that admin's role at decision time,
 *    creates the membership; one request takes exactly one decision, so two
 *    racing decisions cannot both succeed. A member's existing role is never
 *    changed by an approval, and an approval never moves someone's active
 *    Workspace context.
 *  - **A removed member loses only that org's assignments.** Their private
 *    sign-ins and assignments in other orgs survive. Their agents in the org
 *    are the service layer's job (retirement is a product flow, not a row
 *    delete).
 */
export interface OrgStorage {
  createOrg(doc: Omit<OrgDocument, 'orgId' | 'createdAt'>): Promise<OrgDocument>;
  getOrg(orgId: string): Promise<OrgDocument | null>;
  /** Every org, for control-plane sweeps (reaper/roller per-org loops). */
  listOrgs(): Promise<OrgDocument[]>;
  updateOrg(orgId: string, updates: Partial<Omit<OrgDocument, 'orgId' | 'createdAt'>>): Promise<boolean>;
  /**
   * Give a workplace its public handle, once. The claim is the uniqueness:
   * `taken` when another workplace holds the word, `missing` when the
   * workplace is gone, `claimed` for a workplace that already holds this
   * very word. A workplace that already holds a DIFFERENT word keeps it —
   * a handle never changes — and the answer is `taken`. Whether a PERSON
   * holds the word is the handle service's question, asked first.
   */
  claimHandle(orgId: string, handle: string): Promise<'claimed' | 'taken' | 'missing'>;
  /** The workplace at this handle; null if nobody's. */
  getOrgByHandle(handle: string): Promise<OrgDocument | null>;

  /** Refuses only a duplicate membership in this same org. */
  addMember(doc: Omit<OrgMembershipDocument, 'joinedAt'>): Promise<OrgMembershipDocument>;
  getMembership(orgId: string, userId: string): Promise<OrgMembershipDocument | null>;
  /** Every membership this human holds, active first then join order. */
  listMembershipsByUser(userId: string): Promise<OrgMembershipDocument[]>;
  /** The active Workspace membership (or deterministic legacy fallback). */
  getMembershipByUser(userId: string): Promise<OrgMembershipDocument | null>;
  /** Makes this membership active and every sibling inactive. */
  setActiveOrg(userId: string, orgId: string): Promise<boolean>;
  listMembers(orgId: string): Promise<OrgMembershipDocument[]>;
  setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<boolean>;
  /**
   * Stamp what the People page reads (note #328): when this member was last
   * seen here and/or the latest thing they drove. Merges over the row; false
   * when there is no such membership. Never throws through to a route — a
   * failed stamp is silence, exactly as a failed agent recap is.
   */
  touchMember(orgId: string, userId: string, touch: OrgMemberTouch): Promise<boolean>;
  /**
   * Give a pre-split Workspace Agent its own runtime exactly once. The first
   * value wins atomically, so a recap change and an agent pick arriving from
   * two tabs can never overwrite one another while the old shared setting is
   * being separated (note #447).
   */
  initializeWorkspaceAgentSettings(
    orgId: string,
    userId: string,
    settings: NonNullable<OrgMembershipDocument['workspaceAgentSettings']>,
  ): Promise<OrgMembershipDocument | null>;
  /** Also removes this org's seat assignments. Private credentials survive. */
  removeMember(orgId: string, userId: string): Promise<boolean>;
  /** Deletes only a truly empty org row; callers prove external emptiness. */
  deleteOrg(orgId: string): Promise<boolean>;

  /** Selects the new seat and deselects the member's other seats of that provider. */
  addSeat(doc: Omit<OrgSeatDocument, 'seatId' | 'selected' | 'createdAt' | 'updatedAt'>): Promise<OrgSeatDocument>;
  getSeat(seatId: string): Promise<OrgSeatDocument | null>;
  /** A member's org assignments in primary/fallback order — the sign-in screen's list. */
  listSeatsByMember(orgId: string, userId: string): Promise<OrgSeatDocument[]>;
  /** The user's private sign-in library, assigned or not. */
  listSeatsByUser(userId: string): Promise<OrgSeatDocument[]>;
  /** Every seat on the platform — the usage refresher's probe walk. */
  listAllSeats(): Promise<OrgSeatDocument[]>;
  updateSeat(seatId: string, updates: Partial<Omit<OrgSeatDocument, 'seatId' | 'orgId' | 'userId' | 'createdAt'>>): Promise<boolean>;
  isSeatAssigned(orgId: string, userId: string, seatId: string): Promise<boolean>;
  /** Assigns an owned sign-in to an org and makes it primary there. */
  assignSeat(orgId: string, userId: string, seatId: string): Promise<OrgSeatAssignmentDocument | null>;
  /** Removes one org link, never the underlying sign-in. */
  unassignSeat(orgId: string, userId: string, seatId: string): Promise<boolean>;
  /** Moves the member's pick for that provider in one org. */
  selectSeat(seatId: string, orgId?: string): Promise<boolean>;
  /** Reorders every assigned seat of one provider; exact-set validation. */
  orderSeats(orgId: string, userId: string, provider: string, seatIds: string[]): Promise<boolean>;
  /** Deletes the private sign-in and all of its assignments. */
  removeSeat(seatId: string): Promise<boolean>;

  /**
   * The workplace a namespace belongs to: its own (`git.namespaceId`), or one
   * of the old rooms' namespaces recorded on it when rooms were merged and
   * dropped (note #843, `roomsMerged.namespaces`). The reverse lookup CI,
   * media routing and git-key verification turn on.
   */
  getOrgByNamespace(namespaceId: string): Promise<OrgDocument | null>;

  createInvite(doc: Omit<OrgInviteDocument, 'token' | 'createdAt'>): Promise<OrgInviteDocument>;
  getInvite(token: string): Promise<OrgInviteDocument | null>;
  /** An org's invites, all states, newest first — the admin screen's list. */
  listInvites(orgId: string): Promise<OrgInviteDocument[]>;
  /**
   * Deletes an unused invite so its link goes dead. A USED invite is history —
   * it names who joined through it — so revoking one is refused, not silently
   * absorbed: the caller is telling a user something and must not say
   * "revoked" about a door someone already walked through.
   */
  revokeInvite(token: string): Promise<'revoked' | 'used' | 'unknown'>;
  /** Single-use, atomic: membership created and token burned as one step. */
  redeemInvite(token: string, userId: string, now?: Date): Promise<OrgInviteRedemption>;

  /**
   * Files a join request through a live link. Refuses exactly what a redeem
   * would (unknown, used, expired, already-member) and otherwise returns the
   * one pending request for this (org, user) — the existing one if there is
   * one, a new one otherwise. Burns no token, creates no membership.
   */
  requestToJoin(token: string, userId: string, now?: Date): Promise<OrgJoinRequestOutcome>;
  getJoinRequest(requestId: string): Promise<OrgJoinRequestDocument | null>;
  /** This person's latest request to this org, any status. */
  getJoinRequestByUser(orgId: string, userId: string): Promise<OrgJoinRequestDocument | null>;
  /** An org's requests, all states, newest first — callers filter pending. */
  listJoinRequests(orgId: string): Promise<OrgJoinRequestDocument[]>;
  /** Every request this person has filed, any workplace, any status, newest first. */
  listJoinRequestsByUser(userId: string): Promise<OrgJoinRequestDocument[]>;
  /**
   * Decides one pending request as one step: rechecks that the decider is an
   * admin of the org NOW, marks the request, and on approval creates the
   * membership (role `member`, unless the person is already a member, whose
   * role stands). Never switches the newcomer's active org away from one
   * they already have.
   */
  decideJoinRequest(
    requestId: string, adminUserId: string, decision: OrgJoinDecision, now?: Date,
  ): Promise<OrgJoinDecisionOutcome>;
}

/** 22 URL-safe chars — fits Telegram's 64-char start payload beside `join-`. */
export function mintInviteToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Oldest first; userId breaks same-millisecond ties so order is stable. */
export function byJoinedAtAsc(a: OrgMembershipDocument, b: OrgMembershipDocument): number {
  return a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId);
}

/** Newest first; seatId breaks same-millisecond ties so order is stable. */
export function bySeatCreatedAtDesc(a: OrgSeatDocument, b: OrgSeatDocument): number {
  return b.createdAt.localeCompare(a.createdAt) || a.seatId.localeCompare(b.seatId);
}

/**
 * Newest first. In a same-millisecond tie the pending one is the newer: a
 * person holds one pending request at a time, so it was filed after any
 * decided one. Callers supply newest insertion first for exact timestamp
 * ties, so stable sorting never picks an older decision by random UUID.
 */
export function byRequestedAtDesc(a: OrgJoinRequestDocument, b: OrgJoinRequestDocument): number {
  return b.requestedAt.localeCompare(a.requestedAt)
    || Number(b.status === 'pending') - Number(a.status === 'pending');
}

/** Newest first; token breaks same-millisecond ties so order is stable. */
export function byInviteCreatedAtDesc(a: OrgInviteDocument, b: OrgInviteDocument): number {
  return b.createdAt.localeCompare(a.createdAt) || a.token.localeCompare(b.token);
}

export function stampSeat(
  doc: Omit<OrgSeatDocument, 'seatId' | 'selected' | 'createdAt' | 'updatedAt'>,
): OrgSeatDocument {
  const now = new Date().toISOString();
  return { ...doc, seatId: randomUUID(), selected: true, createdAt: now, updatedAt: now };
}

/** The fields `touchMember` may write; anything absent is left as it was. */
export type OrgMemberTouch = Partial<Pick<OrgMembershipDocument, 'lastSeenAt' | 'recap' | 'workspaceRecap' | 'workspaceRecapHistory' | 'workspaceRecapSettings' | 'workspaceAgentSettings' | 'workspaceRecapReadAt' | 'workspaceRecapChat' | 'workspaceAgentProactive' | 'workspaceAgentEventLedger' | 'inheritedSeatsAt'>>;

export class InMemoryOrgStorage implements OrgStorage {
  private orgs = new Map<string, OrgDocument>();
  private members = new Map<string, OrgMembershipDocument>(); // `${orgId}/${userId}`
  private seats = new Map<string, OrgSeatDocument>();
  private seatAssignments = new Map<string, OrgSeatAssignmentDocument>(); // `${orgId}/${userId}/${seatId}`
  private invites = new Map<string, OrgInviteDocument>();
  private joinRequests = new Map<string, OrgJoinRequestDocument>();

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
    this.orgs.set(org.orgId, org);
    return org;
  }

  async getOrg(orgId: string): Promise<OrgDocument | null> {
    return this.orgs.get(orgId) ?? null;
  }

  async listOrgs(): Promise<OrgDocument[]> {
    return [...this.orgs.values()];
  }

  async updateOrg(orgId: string, updates: Partial<Omit<OrgDocument, 'orgId' | 'createdAt'>>): Promise<boolean> {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    this.orgs.set(orgId, { ...org, ...updates, orgId: org.orgId, createdAt: org.createdAt });
    return true;
  }

  async claimHandle(orgId: string, handle: string): Promise<'claimed' | 'taken' | 'missing'> {
    const org = this.orgs.get(orgId);
    if (!org) return 'missing';
    if (org.handle === handle) return 'claimed';
    if (org.handle) return 'taken';
    if (await this.getOrgByHandle(handle)) return 'taken';
    this.orgs.set(orgId, { ...org, handle });
    return 'claimed';
  }

  async getOrgByHandle(handle: string): Promise<OrgDocument | null> {
    for (const org of this.orgs.values()) {
      if (org.handle === handle) return org;
    }
    return null;
  }

  async addMember(doc: Omit<OrgMembershipDocument, 'joinedAt'>): Promise<OrgMembershipDocument> {
    const key = `${doc.orgId}/${doc.userId}`;
    if (this.members.has(key)) {
      throw new Error(`user ${doc.userId} is already a member of org ${doc.orgId}`);
    }
    const first = (await this.listMembershipsByUser(doc.userId)).length === 0;
    const membership: OrgMembershipDocument = {
      ...doc, active: first || undefined, joinedAt: new Date().toISOString(),
    };
    this.members.set(key, membership);
    return membership;
  }

  async getMembership(orgId: string, userId: string): Promise<OrgMembershipDocument | null> {
    return this.members.get(`${orgId}/${userId}`) ?? null;
  }

  async listMembershipsByUser(userId: string): Promise<OrgMembershipDocument[]> {
    return [...this.members.values()]
      .filter((membership) => membership.userId === userId)
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active))
        || a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId));
  }

  async getMembershipByUser(userId: string): Promise<OrgMembershipDocument | null> {
    return (await this.listMembershipsByUser(userId))[0] ?? null;
  }

  async setActiveOrg(userId: string, orgId: string): Promise<boolean> {
    if (!this.members.has(`${orgId}/${userId}`)) return false;
    for (const [key, membership] of this.members) {
      if (membership.userId !== userId) continue;
      this.members.set(key, { ...membership, active: membership.orgId === orgId || undefined });
    }
    return true;
  }

  async listMembers(orgId: string): Promise<OrgMembershipDocument[]> {
    return [...this.members.values()]
      .filter((m) => m.orgId === orgId)
      .sort(byJoinedAtAsc);
  }

  async setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<boolean> {
    const key = `${orgId}/${userId}`;
    const membership = this.members.get(key);
    if (!membership) return false;
    this.members.set(key, { ...membership, role });
    return true;
  }

  async touchMember(orgId: string, userId: string, touch: OrgMemberTouch): Promise<boolean> {
    const key = `${orgId}/${userId}`;
    const membership = this.members.get(key);
    if (!membership) return false;
    this.members.set(key, { ...membership, ...touch });
    return true;
  }

  async initializeWorkspaceAgentSettings(
    orgId: string,
    userId: string,
    settings: NonNullable<OrgMembershipDocument['workspaceAgentSettings']>,
  ): Promise<OrgMembershipDocument | null> {
    const key = `${orgId}/${userId}`;
    const membership = this.members.get(key);
    if (!membership) return null;
    const initialized = membership.workspaceAgentSettings
      ? membership
      : { ...membership, workspaceAgentSettings: settings };
    this.members.set(key, initialized);
    return initialized;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const key = `${orgId}/${userId}`;
    const wasActive = Boolean(this.members.get(key)?.active);
    const removed = this.members.delete(key);
    if (removed) {
      for (const [assignmentKey, assignment] of this.seatAssignments) {
        if (assignment.orgId === orgId && assignment.userId === userId) {
          this.seatAssignments.delete(assignmentKey);
        }
      }
      if (wasActive) {
        const [next] = await this.listMembershipsByUser(userId);
        if (next) await this.setActiveOrg(userId, next.orgId);
      }
    }
    return removed;
  }

  async deleteOrg(orgId: string): Promise<boolean> {
    if ((await this.listMembers(orgId)).length > 0) return false;
    const removed = this.orgs.delete(orgId);
    if (!removed) return false;
    for (const [token, invite] of this.invites) {
      if (invite.orgId === orgId) this.invites.delete(token);
    }
    for (const [requestId, request] of this.joinRequests) {
      if (request.orgId === orgId) this.joinRequests.delete(requestId);
    }
    for (const [key, assignment] of this.seatAssignments) {
      if (assignment.orgId === orgId) this.seatAssignments.delete(key);
    }
    return true;
  }

  async getOrgByNamespace(namespaceId: string): Promise<OrgDocument | null> {
    const orgs = [...this.orgs.values()];
    return orgs.find((org) => org.git?.namespaceId === namespaceId)
      ?? orgs.find((org) => org.roomsMerged?.namespaces?.includes(namespaceId))
      ?? null;
  }

  async addSeat(doc: Omit<OrgSeatDocument, 'seatId' | 'selected' | 'createdAt' | 'updatedAt'>): Promise<OrgSeatDocument> {
    if (!await this.getMembership(doc.orgId, doc.userId)) {
      throw new Error(`user ${doc.userId} is not a member of org ${doc.orgId}`);
    }
    const seat = stampSeat(doc);
    this.seats.set(seat.seatId, seat);
    // Membership was proven above, so this cannot strand an unassigned
    // credential the way a best-effort call after insertion could.
    const assignment = await this.assignSeat(seat.orgId, seat.userId, seat.seatId);
    return { ...seat, selected: true, assignmentPriority: assignment!.priority };
  }

  async getSeat(seatId: string): Promise<OrgSeatDocument | null> {
    return this.seats.get(seatId) ?? null;
  }

  async listSeatsByMember(orgId: string, userId: string): Promise<OrgSeatDocument[]> {
    const seats: OrgSeatDocument[] = [];
    for (const assignment of this.seatAssignments.values()) {
      if (assignment.orgId !== orgId || assignment.userId !== userId) continue;
      const seat = this.seats.get(assignment.seatId);
      if (!seat) continue;
      seats.push({
        ...seat,
        orgId,
        selected: assignment.selected,
        assignmentPriority: assignment.priority,
      });
    }
    return seats.sort(
      (a, b) => (a.assignmentPriority ?? 0) - (b.assignmentPriority ?? 0) || bySeatCreatedAtDesc(a, b),
    );
  }

  async listSeatsByUser(userId: string): Promise<OrgSeatDocument[]> {
    return [...this.seats.values()].filter((seat) => seat.userId === userId).sort(bySeatCreatedAtDesc);
  }

  async listAllSeats(): Promise<OrgSeatDocument[]> {
    return [...this.seats.values()].sort(bySeatCreatedAtDesc);
  }

  async updateSeat(
    seatId: string,
    updates: Partial<Omit<OrgSeatDocument, 'seatId' | 'orgId' | 'userId' | 'createdAt'>>,
  ): Promise<boolean> {
    const seat = this.seats.get(seatId);
    if (!seat) return false;
    this.seats.set(seatId, {
      ...seat, ...updates,
      seatId: seat.seatId, orgId: seat.orgId, userId: seat.userId, createdAt: seat.createdAt,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async isSeatAssigned(orgId: string, userId: string, seatId: string): Promise<boolean> {
    return this.seatAssignments.has(`${orgId}/${userId}/${seatId}`);
  }

  async assignSeat(
    orgId: string,
    userId: string,
    seatId: string,
  ): Promise<OrgSeatAssignmentDocument | null> {
    const seat = this.seats.get(seatId);
    if (!seat || seat.userId !== userId || !await this.getMembership(orgId, userId)) return null;
    const now = new Date().toISOString();
    const current = await this.listSeatsByMember(orgId, userId);
    for (const [key, assignment] of this.seatAssignments) {
      const other = this.seats.get(assignment.seatId);
      if (assignment.orgId === orgId && assignment.userId === userId && other?.provider === seat.provider) {
        this.seatAssignments.set(key, { ...assignment, selected: false });
      }
    }
    const existing = this.seatAssignments.get(`${orgId}/${userId}/${seatId}`);
    const assignment: OrgSeatAssignmentDocument = existing
      ? { ...existing, selected: true }
      : {
        orgId, userId, seatId, selected: true,
        priority: current.filter((other) => other.provider === seat.provider).length,
        assignedAt: now,
      };
    this.seatAssignments.set(`${orgId}/${userId}/${seatId}`, assignment);
    return assignment;
  }

  async unassignSeat(orgId: string, userId: string, seatId: string): Promise<boolean> {
    const key = `${orgId}/${userId}/${seatId}`;
    const existing = this.seatAssignments.get(key);
    if (!existing) return false;
    const seat = this.seats.get(seatId);
    this.seatAssignments.delete(key);
    if (seat) await this.normalizeAssignments(orgId, userId, seat.provider, existing.selected);
    return true;
  }

  async selectSeat(seatId: string, orgId?: string): Promise<boolean> {
    const seat = this.seats.get(seatId);
    const targetOrgId = orgId ?? seat?.orgId;
    if (!seat || !targetOrgId || !await this.isSeatAssigned(targetOrgId, seat.userId, seatId)) return false;
    for (const [key, assignment] of this.seatAssignments) {
      const other = this.seats.get(assignment.seatId);
      if (assignment.orgId === targetOrgId && assignment.userId === seat.userId && other?.provider === seat.provider) {
        this.seatAssignments.set(key, { ...assignment, selected: assignment.seatId === seatId });
      }
    }
    return true;
  }

  async orderSeats(orgId: string, userId: string, provider: string, seatIds: string[]): Promise<boolean> {
    const current = (await this.listSeatsByMember(orgId, userId)).filter((seat) => seat.provider === provider);
    if (current.length !== seatIds.length || new Set(seatIds).size !== seatIds.length
      || current.some((seat) => !seatIds.includes(seat.seatId))) return false;
    seatIds.forEach((seatId, priority) => {
      const key = `${orgId}/${userId}/${seatId}`;
      const assignment = this.seatAssignments.get(key)!;
      this.seatAssignments.set(key, { ...assignment, priority });
    });
    return true;
  }

  private async normalizeAssignments(
    orgId: string,
    userId: string,
    provider: string,
    needsPrimary: boolean,
  ): Promise<void> {
    const remaining = (await this.listSeatsByMember(orgId, userId)).filter((seat) => seat.provider === provider);
    remaining.forEach((seat, priority) => {
      const key = `${orgId}/${userId}/${seat.seatId}`;
      const assignment = this.seatAssignments.get(key)!;
      this.seatAssignments.set(key, {
        ...assignment,
        priority,
        selected: needsPrimary && priority === 0 ? true : assignment.selected,
      });
    });
  }

  async removeSeat(seatId: string): Promise<boolean> {
    const seat = this.seats.get(seatId);
    if (!seat) return false;
    const affected = [...this.seatAssignments.values()].filter((assignment) => assignment.seatId === seatId);
    this.seats.delete(seatId);
    for (const assignment of affected) {
      this.seatAssignments.delete(`${assignment.orgId}/${assignment.userId}/${assignment.seatId}`);
      await this.normalizeAssignments(assignment.orgId, assignment.userId, seat.provider, assignment.selected);
    }
    return true;
  }

  async createInvite(doc: Omit<OrgInviteDocument, 'token' | 'createdAt'>): Promise<OrgInviteDocument> {
    const invite: OrgInviteDocument = { ...doc, token: mintInviteToken(), createdAt: new Date().toISOString() };
    this.invites.set(invite.token, invite);
    return invite;
  }

  async getInvite(token: string): Promise<OrgInviteDocument | null> {
    return this.invites.get(token) ?? null;
  }

  async listInvites(orgId: string): Promise<OrgInviteDocument[]> {
    return [...this.invites.values()]
      .filter((invite) => invite.orgId === orgId)
      .sort(byInviteCreatedAtDesc);
  }

  async revokeInvite(token: string): Promise<'revoked' | 'used' | 'unknown'> {
    const invite = this.invites.get(token);
    if (!invite) return 'unknown';
    if (invite.usedAt) return 'used';
    this.invites.delete(token);
    return 'revoked';
  }

  /**
   * Synchronous on purpose: an `await` between the check and the write is
   * where two concurrent taps both got through. In-memory storage has no
   * transaction, so a whole step runs without yielding instead.
   */
  private insertMember(doc: Omit<OrgMembershipDocument, 'joinedAt'>, now: Date): OrgMembershipDocument {
    const first = ![...this.members.values()].some((m) => m.userId === doc.userId);
    const membership: OrgMembershipDocument = { ...doc, active: first || undefined, joinedAt: now.toISOString() };
    this.members.set(`${doc.orgId}/${doc.userId}`, membership);
    return membership;
  }

  private checkLiveInvite(token: string, userId: string):
    { ok: true; invite: OrgInviteDocument; org: OrgDocument } | { ok: false; reason: OrgInviteRefusal } {
    const invite = this.invites.get(token);
    const org = invite ? this.orgs.get(invite.orgId) : undefined;
    if (!invite || !org) return { ok: false, reason: 'unknown' };
    if (invite.usedAt) return { ok: false, reason: 'used' };
    if (this.members.has(`${invite.orgId}/${userId}`)) return { ok: false, reason: 'already-member' };
    return { ok: true, invite, org };
  }

  async redeemInvite(token: string, userId: string, now: Date = new Date()): Promise<OrgInviteRedemption> {
    const live = this.checkLiveInvite(token, userId);
    if (!live.ok) return live;
    const { invite, org } = live;
    const membership = this.insertMember({
      orgId: invite.orgId, userId, role: 'member', invitedByUserId: invite.createdByUserId,
    }, now);
    for (const [key, sibling] of this.members) {
      if (sibling.userId !== userId) continue;
      this.members.set(key, { ...sibling, active: sibling.orgId === invite.orgId || undefined });
    }
    this.invites.set(token, { ...invite, usedAt: now.toISOString(), usedByUserId: userId });
    return { ok: true, membership: this.members.get(`${invite.orgId}/${userId}`) ?? membership, org };
  }

  async requestToJoin(token: string, userId: string, now: Date = new Date()): Promise<OrgJoinRequestOutcome> {
    const live = this.checkLiveInvite(token, userId);
    if (!live.ok) return live;
    const { invite, org } = live;
    const pending = [...this.joinRequests.values()]
      .find((r) => r.orgId === invite.orgId && r.userId === userId && r.status === 'pending');
    if (pending) return { ok: true, request: pending, org };
    const request: OrgJoinRequestDocument = {
      requestId: randomUUID(), orgId: invite.orgId, userId, inviteToken: token,
      requestedAt: now.toISOString(), status: 'pending',
    };
    this.joinRequests.set(request.requestId, request);
    return { ok: true, request, org };
  }

  async getJoinRequest(requestId: string): Promise<OrgJoinRequestDocument | null> {
    return this.joinRequests.get(requestId) ?? null;
  }

  async getJoinRequestByUser(orgId: string, userId: string): Promise<OrgJoinRequestDocument | null> {
    return [...this.joinRequests.values()].reverse()
      .filter((r) => r.orgId === orgId && r.userId === userId)
      .sort(byRequestedAtDesc)[0] ?? null;
  }

  async listJoinRequests(orgId: string): Promise<OrgJoinRequestDocument[]> {
    return [...this.joinRequests.values()].reverse().filter((r) => r.orgId === orgId).sort(byRequestedAtDesc);
  }

  async listJoinRequestsByUser(userId: string): Promise<OrgJoinRequestDocument[]> {
    return [...this.joinRequests.values()].reverse().filter((r) => r.userId === userId).sort(byRequestedAtDesc);
  }

  async decideJoinRequest(
    requestId: string, adminUserId: string, decision: OrgJoinDecision, now: Date = new Date(),
  ): Promise<OrgJoinDecisionOutcome> {
    const request = this.joinRequests.get(requestId);
    if (!request || !this.orgs.has(request.orgId)) return { ok: false, reason: 'unknown' };
    const admin = this.members.get(`${request.orgId}/${adminUserId}`);
    if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
    if (request.status !== 'pending') return { ok: false, reason: 'resolved' };
    const decided: OrgJoinRequestDocument = {
      ...request, status: decision === 'approve' ? 'approved' : 'rejected',
      decidedAt: now.toISOString(), decidedByUserId: adminUserId,
    };
    this.joinRequests.set(requestId, decided);
    // Already a member (added another way meanwhile): their role stands.
    if (decision === 'approve' && !this.members.has(`${request.orgId}/${request.userId}`)) {
      this.insertMember({ orgId: request.orgId, userId: request.userId, role: 'member', invitedByUserId: adminUserId }, now);
    }
    return { ok: true, request: decided };
  }
}
