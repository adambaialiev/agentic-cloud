import { randomUUID } from 'node:crypto';
import { newMarginComment } from '../types/comment.js';
import type {
  QuickNoteClaim,
  QuickNoteComment,
  QuickNoteDocument,
  StoredQuickNote,
} from '../types/quick-note.js';
import {
  QUICK_NOTE_CLAIM_LEASE_MS,
  activeQuickNoteClaim,
  normalizeQuickNote,
  quickNoteFingerprint,
  quickNoteIsArchived,
} from '../types/quick-note.js';
import {
  quickNoteMatchesSearch,
  rankQuickNoteSearch,
} from '../types/quick-note-search.js';
import { highestNumber, type NumberSeries } from './workplace-numbers.js';

export interface QuickNoteClaimant {
  agentId: string;
  userId: string;
  agentName: string;
}

export type QuickNoteClaimResult =
  | {
    outcome: 'claimed' | 'renewed' | 'held';
    note: QuickNoteDocument;
    claim: QuickNoteClaim;
  }
  | {
    /** The note moved into the archive before the atomic read acquired it. */
    outcome: 'archived';
    note: QuickNoteDocument;
  };

export type QuickNoteClaimReleaseResult = {
  outcome: 'released' | 'unclaimed' | 'held';
  note: QuickNoteDocument;
  claim?: QuickNoteClaim;
};

/** The smallest live view of a claim: enough to repaint "Working by …"
 * without shipping a note's words, margin or files every five seconds. */
export interface QuickNoteActiveClaim {
  id: string;
  userId: string;
  claim: QuickNoteClaim;
}

/**
 * Storage for quick notes (docs/agent-quick-notes.md). `userId` is the owning
 * namespace — the ROOM — and `number` is the note's name. Since note #741 a
 * number is issued from one series for the whole workplace (`NumberSeries`,
 * passed by the route that knows the workplace), so "note #3" names one note
 * in any room; numbers issued per room before that were kept, which is why
 * `findByNumber` answers with every note holding a number and the caller
 * picks (`pickNumbered`). Without a series — a personal account — the
 * namespace is its own series, exactly as before.
 *
 * No git host behind this and nothing to approve — the document IS the note.
 * That is the whole difference between this and knowledge pages, and it is why
 * this interface has an `update` that takes effect immediately.
 *
 * `delete` is the one exception, and it is not enforced here: a note is
 * ARCHIVED first and only deleted out of the archive (Owner, note #23), but
 * that rule is a rule about the two verbs a surface offers, so it lives in the
 * routes with the words that explain it. This stays a store.
 */
export interface QuickNoteStorage {
  /** `numbering` names the workplace series the number comes from and every
   *  namespace it must start above; absent, the note's own namespace is the
   *  series. */
  create(
    doc: Omit<QuickNoteDocument, 'id' | 'number' | 'createdAt' | 'updatedAt'>,
    numbering?: NumberSeries,
  ): Promise<QuickNoteDocument>;
  get(id: string): Promise<QuickNoteDocument | null>;
  /** By number, ARCHIVED OR NOT — the number is the note's name for its whole
   *  life, and an archived note is still addressed by it (to read it, to bring
   *  it back, to delete it). Callers that care ask `quickNoteIsArchived`. */
  getByNumber(userId: string, number: number): Promise<QuickNoteDocument | null>;
  /**
   * Every note in these namespaces that holds the number NOW or held it at an
   * earlier address (`previousLocations`), archived or not (note #741). The
   * caller decides which was meant with `pickNumbered`; this only finds.
   */
  findByNumber(namespaces: readonly string[], number: number): Promise<QuickNoteDocument[]>;
  /**
   * LIVE notes, most recently changed first — a notes list is read newest-down.
   *
   * Live-only here and in {@link countByUser}, so that every surface which has
   * ever asked for "the notes" keeps meaning the same thing after the archive
   * exists (the repo storage draws the same line for tombstones). The archive
   * is asked for by name.
   */
  listByUser(userId: string): Promise<QuickNoteDocument[]>;
  /** The archive, most recently PUT AWAY first: what you just archived is at
   *  the top, which is not what `updatedAt` would say — archiving does not
   *  touch a note's words, so it does not touch that clock either. */
  listArchivedByUser(userId: string): Promise<QuickNoteDocument[]>;
  /** Live notes only — this is what the per-account ceiling counts. */
  countByUser(userId: string): Promise<number>;
  countArchivedByUser(userId: string): Promise<number>;
  /** Active work leases across the namespaces this viewer may read. The live
   *  Workspace tick uses one narrow query rather than re-reading every note. */
  listActiveClaimsByUsers(userIds: readonly string[], now: Date): Promise<QuickNoteActiveClaim[]>;
  /**
   * The notes of this namespace whose words match every term, ranked by
   * `rankQuickNoteSearch` and cut to `limit` (note #242).
   *
   * LIVE AND ARCHIVED, which is the one thing about this method worth arguing
   * over. Every other reader here is one list or the other, on purpose. A
   * person searching is not: the note they half-remember is as likely to have
   * been put away as not, and a search that quietly skipped the archive would
   * answer "there is no such note" about a note that is right there.
   *
   * `terms` arrive already parsed (`quickNoteSearchTerms`) so that what an
   * implementation hands its index is never a raw string a user typed.
   */
  search(
    userId: string,
    terms: readonly string[],
    limit: number,
  ): Promise<QuickNoteDocument[]>;
  update(id: string, updates: Partial<QuickNoteDocument>): Promise<QuickNoteDocument | null>;
  /**
   * Atomically move one note to another room namespace (note #111). The note
   * keeps its number when that address is free, otherwise the destination's
   * monotonic allocator gives it a new one. Words, margin, files and identity
   * stay on the same document.
   */
  move(id: string, userId: string, numbering?: NumberSeries): Promise<QuickNoteDocument | null>;
  /**
   * Appends a remark. Its own method rather than an `update` with a rebuilt
   * array, because the two writers here are a person tapping Send and an agent
   * mid-turn: a read-modify-write from each would quietly drop one of them.
   * Implementations do the whole append atomically.
   */
  addComment(id: string, comment: QuickNoteComment): Promise<QuickNoteDocument | null>;
  /** Replaces one remark in place. The caller has already proved authorship;
   *  implementations make the replacement atomic with concurrent appends. */
  editComment(id: string, commentId: string, text: string, editedAt: string): Promise<QuickNoteDocument | null>;
  /** Takes one remark out of the thread, for the person who wrote it. Nothing
   *  is left behind: a margin is a set of remarks, not a history of them, and
   *  a tombstone would keep saying what the author withdrew. Atomic with
   *  concurrent appends, like the edit beside it. */
  deleteComment(id: string, commentId: string): Promise<QuickNoteDocument | null>;
  /**
   * Atomically take (or renew) the note's expiring work lease. A different
   * active claimant wins whole; no read-then-write race is exposed to routes.
   */
  claim(id: string, claimant: QuickNoteClaimant, now: Date): Promise<QuickNoteClaimResult | null>;
  /** Release only this claimant's lease; another agent's lease is untouched. */
  releaseClaim(id: string, agentId: string, now: Date): Promise<QuickNoteClaimReleaseResult | null>;
  delete(id: string): Promise<boolean>;
  /** Permanently remove one room's notes and its never-reuse number counter. */
  deleteByUser(userId: string): Promise<number>;
  /** Forget a workplace's number series — for the purge that deletes the
   *  workplace itself, after every room's notes have gone. */
  deleteSeries(series: string): Promise<void>;
}

/** A new remark, ready to append — the shared factory, under the name this
 *  store has always exported. `userId` is the human driving the authoring
 *  agent (or the person, behind the sentinel), stamped so the signature
 *  survives the agent's retirement. */
export const newQuickNoteComment = newMarginComment;

/**
 * The highest number this user's notes have ever reached, as far as the notes
 * themselves can say. Seeds a counter; it is NOT the allocator.
 *
 * Max-of-what-exists + 1 is what every other numbered thing here does, and it
 * is wrong for notes alone: a PR or a proposal keeps its row forever once
 * decided, while a deleted note leaves nothing behind — so deleting the newest
 * note would hand its number straight to the next one written, and "#3" would
 * mean something the user did not read yesterday. Hence a counter that only
 * ever goes up, seeded from this when it does not exist yet.
 *
 * Feed it EVERY note, archived ones included. An archived note is not gone —
 * it is one `note unarchive` from being back under the number it still holds,
 * and a seed that skipped it would reissue that number to something else.
 */
export function quickNoteHighWater(existing: QuickNoteDocument[]): number {
  return existing.reduce((max, doc) => Math.max(max, doc.number), 0);
}

/** The one order every surface reads notes in: last touched, first shown. */
export function byRecency(docs: QuickNoteDocument[]): QuickNoteDocument[] {
  return [...docs].sort((a, b) => (
    b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number
  ));
}

/** The archive's own order: last put away, first shown. A note that has sat
 *  there for a month has nothing new to say about itself, and the one the
 *  reader is looking for is almost always the one they just archived. */
export function byArchivedRecency(docs: QuickNoteDocument[]): QuickNoteDocument[] {
  return [...docs].sort((a, b) => (
    (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '') || b.number - a.number
  ));
}

export class InMemoryQuickNoteStorage implements QuickNoteStorage {
  private docs = new Map<string, StoredQuickNote>();
  /** Highest number ever handed out per user — kept past a delete on purpose. */
  private issued = new Map<string, number>();

  /**
   * The next number of a series, from a counter that only goes up, seeded
   * from EVERY note in the series' namespaces, archived included —
   * `listByUser` is live-only, and seeding off that would hand #7's number to
   * the next note the moment #7 was archived, while #7 is still sitting in
   * the archive under it. A workplace series also starts above each room's
   * own counter: a room that deleted its newest note must not see that
   * number come back from the workplace.
   */
  private allocate(numbering: NumberSeries): number {
    const next = Math.max(
      this.issued.get(numbering.series) ?? 0,
      ...numbering.namespaces.map((namespace) => this.issued.get(namespace) ?? 0),
      ...numbering.namespaces.map((namespace) => highestNumber(this.allByUser(namespace))),
    ) + 1;
    this.issued.set(numbering.series, next);
    return next;
  }

  async create(
    doc: Omit<QuickNoteDocument, 'id' | 'number' | 'createdAt' | 'updatedAt'>,
    numbering?: NumberSeries,
  ): Promise<QuickNoteDocument> {
    const now = new Date().toISOString();
    const next = this.allocate(numbering ?? { series: doc.userId, namespaces: [doc.userId] });
    // The room's own counter learns the number too, so a later per-room
    // allocation (a personal path, a test) cannot hand it out again.
    this.issued.set(doc.userId, Math.max(this.issued.get(doc.userId) ?? 0, next));
    const full: QuickNoteDocument = {
      ...doc,
      id: randomUUID(),
      number: next,
      createdAt: now,
      updatedAt: now,
    };
    this.docs.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<QuickNoteDocument | null> {
    const doc = this.docs.get(id);
    return doc ? normalizeQuickNote(doc) : null;
  }

  async getByNumber(userId: string, number: number): Promise<QuickNoteDocument | null> {
    for (const doc of this.docs.values()) {
      if (doc.userId === userId && doc.number === number) return normalizeQuickNote(doc);
    }
    return null;
  }

  async findByNumber(namespaces: readonly string[], number: number): Promise<QuickNoteDocument[]> {
    const wanted = new Set(namespaces);
    return [...this.docs.values()].map(normalizeQuickNote).filter((doc) => (
      (wanted.has(doc.userId) && doc.number === number)
      || (doc.previousLocations ?? []).some((location) => wanted.has(location.userId) && location.number === number)
    ));
  }

  /** Every note this user has, in no particular order — live and archived.
   *  Only the number allocator wants this; every reader wants one or the
   *  other, and getting them mixed is the bug this method exists to avoid. */
  private allByUser(userId: string): QuickNoteDocument[] {
    return [...this.docs.values()].filter((doc) => doc.userId === userId).map(normalizeQuickNote);
  }

  async listByUser(userId: string): Promise<QuickNoteDocument[]> {
    return byRecency(this.allByUser(userId).filter((doc) => !quickNoteIsArchived(doc)));
  }

  async listArchivedByUser(userId: string): Promise<QuickNoteDocument[]> {
    return byArchivedRecency(this.allByUser(userId).filter(quickNoteIsArchived));
  }

  async countByUser(userId: string): Promise<number> {
    return (await this.listByUser(userId)).length;
  }

  async countArchivedByUser(userId: string): Promise<number> {
    return (await this.listArchivedByUser(userId)).length;
  }

  async listActiveClaimsByUsers(userIds: readonly string[], now: Date): Promise<QuickNoteActiveClaim[]> {
    const wanted = new Set(userIds);
    if (!wanted.size) return [];
    return [...this.docs.values()].flatMap((stored) => {
      const note = normalizeQuickNote(stored);
      if (!wanted.has(note.userId) || quickNoteIsArchived(note)) return [];
      const claim = activeQuickNoteClaim(note, now);
      return claim ? [{ id: note.id, userId: note.userId, claim }] : [];
    });
  }

  /**
   * No index and none wanted: this store holds one process's notes in a Map,
   * so the walk IS the lookup. What it shares with the indexed store is
   * everything a caller can observe — which notes match and what order they
   * come back in — because both answers come out of the same two functions.
   */
  async search(
    userId: string,
    terms: readonly string[],
    limit: number,
  ): Promise<QuickNoteDocument[]> {
    if (!terms.length) return [];
    const matched = this.allByUser(userId).filter((doc) => quickNoteMatchesSearch(doc, terms));
    return rankQuickNoteSearch(matched, terms, limit);
  }

  async update(id: string, updates: Partial<QuickNoteDocument>): Promise<QuickNoteDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    // Normalized BEFORE the merge, so editing a legacy row drops its `text`
    // rather than leaving both fields on the document disagreeing.
    const next = { ...normalizeQuickNote(doc), ...updates };
    this.docs.set(id, next);
    return next;
  }

  async move(id: string, userId: string, numbering?: NumberSeries): Promise<QuickNoteDocument | null> {
    const stored = this.docs.get(id);
    if (!stored) return null;
    const current = normalizeQuickNote(stored);
    if (current.userId === userId) return current;

    // Moving the highest legacy note out must not make its old number look
    // unused when the source next allocates one.
    this.issued.set(current.userId, Math.max(this.issued.get(current.userId) ?? 0, current.number));

    const previous = current.previousLocations ?? [];
    const oldNumber = [...previous].reverse().find((location) => location.userId === userId)?.number;
    const candidates = [oldNumber, current.number]
      .filter((number): number is number => Number.isSafeInteger(number) && Number(number) > 0);
    let number = candidates.find((candidate) => ![...this.docs.values()].some((doc) => {
      const normalized = normalizeQuickNote(doc);
      return normalized.id !== id && normalized.userId === userId && normalized.number === candidate;
    }));
    if (number === undefined) {
      number = this.allocate(numbering ?? { series: userId, namespaces: [userId] });
    }
    this.issued.set(userId, Math.max(this.issued.get(userId) ?? 0, number));
    const location = { userId: current.userId, number: current.number };
    const locations = previous.some((entry) => entry.userId === location.userId && entry.number === location.number)
      ? previous
      : [...previous, location];
    const next = { ...current, userId, number, previousLocations: locations };
    this.docs.set(id, next);
    return next;
  }

  /** `updatedAt` deliberately does not move: the note's own words did not
   *  change, and every surface reads that field as "when this was rewritten". */
  async addComment(id: string, comment: QuickNoteComment): Promise<QuickNoteDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const current = normalizeQuickNote(doc);
    const next = { ...current, comments: [...(current.comments ?? []), comment] };
    this.docs.set(id, next);
    return next;
  }

  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<QuickNoteDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const current = normalizeQuickNote(doc);
    const at = (current.comments ?? []).findIndex((comment) => comment.id === commentId);
    if (at < 0) return null;
    const comments = [...(current.comments ?? [])];
    comments[at] = { ...comments[at]!, text, editedAt };
    const next = { ...current, comments };
    this.docs.set(id, next);
    return next;
  }

  async deleteComment(id: string, commentId: string): Promise<QuickNoteDocument | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const current = normalizeQuickNote(doc);
    const comments = (current.comments ?? []).filter((comment) => comment.id !== commentId);
    if (comments.length === (current.comments ?? []).length) return null;
    const next = { ...current, comments };
    this.docs.set(id, next);
    return next;
  }

  async claim(id: string, claimant: QuickNoteClaimant, now: Date): Promise<QuickNoteClaimResult | null> {
    const stored = this.docs.get(id);
    if (!stored) return null;
    const current = normalizeQuickNote(stored);
    if (quickNoteIsArchived(current)) return { outcome: 'archived', note: current };
    const held = activeQuickNoteClaim(current, now);
    if (held && held.agentId !== claimant.agentId) {
      return { outcome: 'held', note: current, claim: held };
    }
    const claim: QuickNoteClaim = {
      ...claimant,
      claimedAt: held?.claimedAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + QUICK_NOTE_CLAIM_LEASE_MS).toISOString(),
      fingerprint: quickNoteFingerprint(current),
    };
    // The claim answers the handoff and replaces it: one note carries one
    // statement about who has it, and a handoff left underneath a lease would
    // resurface as "handed" the moment the agent released the note — telling
    // the reader somebody was on it seconds after that agent said it was not.
    const { handoff: _handoff, ...withoutHandoff } = current;
    const next = { ...withoutHandoff, claim };
    this.docs.set(id, next);
    return { outcome: held ? 'renewed' : 'claimed', note: next, claim };
  }

  async releaseClaim(
    id: string,
    agentId: string,
    now: Date,
  ): Promise<QuickNoteClaimReleaseResult | null> {
    const stored = this.docs.get(id);
    if (!stored) return null;
    const current = normalizeQuickNote(stored);
    const held = activeQuickNoteClaim(current, now);
    if (held && held.agentId !== agentId) {
      return { outcome: 'held', note: current, claim: held };
    }
    const { claim: _claim, ...withoutClaim } = current;
    this.docs.set(id, withoutClaim);
    return { outcome: held ? 'released' : 'unclaimed', note: withoutClaim };
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async deleteByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [id, doc] of this.docs) {
      if (doc.userId !== userId) continue;
      this.docs.delete(id);
      removed += 1;
    }
    this.issued.delete(userId);
    return removed;
  }

  async deleteSeries(series: string): Promise<void> {
    this.issued.delete(series);
  }
}
