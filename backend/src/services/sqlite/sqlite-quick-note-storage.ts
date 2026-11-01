import { randomUUID } from 'node:crypto';
import type {
  QuickNoteClaim,
  QuickNoteComment,
  QuickNoteDocument,
  StoredQuickNote,
} from '../../types/quick-note.js';
import {
  QUICK_NOTE_CLAIM_LEASE_MS,
  activeQuickNoteClaim,
  normalizeQuickNote,
  quickNoteFingerprint,
  quickNoteIsArchived,
} from '../../types/quick-note.js';
import type {
  QuickNoteClaimant,
  QuickNoteActiveClaim,
  QuickNoteClaimReleaseResult,
  QuickNoteClaimResult,
  QuickNoteStorage,
} from '../quick-note-storage.js';
import { byArchivedRecency, byRecency } from '../quick-note-storage.js';
import {
  QUICK_NOTE_SEARCH_CANDIDATES,
  quickNoteSearchText,
  rankQuickNoteSearch,
} from '../../types/quick-note-search.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';
import type { NumberSeries } from '../workplace-numbers.js';

/**
 * `user_id` + `number` are real columns: the pair is how the CLI and the
 * Workspace both address a note, and UNIQUE across it stops two concurrent
 * `note add` calls minting the same "#3".
 */
export class SqliteQuickNoteStorage implements QuickNoteStorage {
  constructor(private readonly db: SqliteDb) {
    this.repairSearchIndex();
  }

  /**
   * Bring the search index level with the notes, once, at startup.
   *
   * Every account that has notes today got them before this index existed, so
   * SOMETHING has to be the moment they become findable, and a backfill that
   * has to be remembered by whoever wires the storage up is a backfill that
   * will be forgotten in one environment. This runs where the store is built,
   * over a table holding a few hundred rows.
   *
   * It also makes the index self-healing, which is what lets every write below
   * stay simple: a note written while the process was killed between its two
   * statements, or a rowid renumbered underneath us by a VACUUM, is repaired
   * here rather than being a silently unfindable note forever.
   */
  private repairSearchIndex(): void {
    const stale = this.db.prepare(`
      SELECT q.rowid AS rowid, q.doc AS doc
      FROM quick_notes q
      LEFT JOIN quick_note_search s ON s.rowid = q.rowid
      WHERE s.rowid IS NULL OR s.note_id != q.note_id
    `).all() as Array<{ rowid: number; doc: string }>;
    // Rows for notes that no longer exist: a delete that did not finish, or a
    // renumbering that left the index pointing at nothing.
    this.db
      .prepare('DELETE FROM quick_note_search WHERE rowid NOT IN (SELECT rowid FROM quick_notes)')
      .run();
    for (const row of stale) {
      this.indexNote(row.rowid, normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)));
    }
  }

  /**
   * Put this note's words in the index, replacing whatever was there for it.
   *
   * Delete-then-insert rather than an update, because FTS5 has no upsert and
   * this one shape is correct whether or not a row exists yet — which is what
   * lets a create, an edit and a repair all call the same method.
   *
   * The room a note lives in is deliberately NOT indexed: `user_id` is a
   * column on `quick_notes` and every search joins back to it, so moving a
   * note between rooms cannot leave the index believing the old one.
   */
  private indexNote(rowid: number | bigint, doc: QuickNoteDocument): void {
    const text = quickNoteSearchText(doc);
    this.db.prepare('DELETE FROM quick_note_search WHERE rowid = ?').run(rowid);
    this.db
      .prepare('INSERT INTO quick_note_search (rowid, title, body, note_id) VALUES (?, ?, ?, ?)')
      .run(rowid, text.title, text.body, doc.id);
  }

  /** The note's rowid, which is also its row in the search index. */
  private rowidOf(id: string): number | undefined {
    const row = this.db
      .prepare('SELECT rowid AS rowid FROM quick_notes WHERE note_id = ?')
      .get(id) as { rowid: number } | undefined;
    return row?.rowid;
  }

  /**
   * The next number of a series, from a counter that only goes UP — never
   * `MAX(number) + 1`, which would reissue the number of a deleted note (a
   * note leaves no row behind, unlike every other numbered thing here).
   *
   * One transaction, so two concurrent `note add` calls cannot read the same
   * counter. The seed reads the notes themselves AND every room counter of
   * the series' namespaces, which makes it self-healing and safe to turn on
   * over a workplace already full of per-room numbers (note #741): the
   * workplace series starts above every number any of its rooms holds or
   * has ever issued. A personal account's series is its own namespace, and
   * the seed reduces to what it was before.
   *
   * Runs inside the caller's transaction — `create` opens one, `move` is
   * already holding the write lock in its IMMEDIATE one.
   */
  private allocateNumberInsideTransaction(numbering: NumberSeries): number {
    const namespaces = [...new Set([numbering.series, ...numbering.namespaces])];
    const placeholders = namespaces.map(() => '?').join(', ');
    this.db.prepare(`
      INSERT INTO quick_note_numbers (user_id, issued)
      SELECT ?, MAX(
        COALESCE((SELECT MAX(number) FROM quick_notes WHERE user_id IN (${placeholders})), 0),
        COALESCE((SELECT MAX(issued) FROM quick_note_numbers WHERE user_id IN (${placeholders})), 0)
      )
      ON CONFLICT (user_id) DO NOTHING
    `).run(numbering.series, ...namespaces, ...namespaces);
    this.db.prepare('UPDATE quick_note_numbers SET issued = issued + 1 WHERE user_id = ?').run(numbering.series);
    const row = this.db
      .prepare('SELECT issued FROM quick_note_numbers WHERE user_id = ?')
      .get(numbering.series) as { issued: number };
    return row.issued;
  }

  /** The series a note's own namespace is, when the caller named none. */
  private static ownSeries(userId: string): NumberSeries {
    return { series: userId, namespaces: [userId] };
  }

  /** A preserved number may be above a destination counter that already
   *  exists. Teach the counter about it so the next create cannot collide. */
  private observeNumber(userId: string, number: number): void {
    this.db.prepare(`
      INSERT INTO quick_note_numbers (user_id, issued) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET issued = MAX(issued, excluded.issued)
    `).run(userId, number);
  }

  async create(
    doc: Omit<QuickNoteDocument, 'id' | 'number' | 'createdAt' | 'updatedAt'>,
    numbering?: NumberSeries,
  ): Promise<QuickNoteDocument> {
    const now = new Date().toISOString();
    const number = this.db.transaction(() => {
      const issued = this.allocateNumberInsideTransaction(numbering ?? SqliteQuickNoteStorage.ownSeries(doc.userId));
      // The room's own counter learns it too, so a later allocation against
      // the room alone can never hand the same number out again.
      this.observeNumber(doc.userId, issued);
      return issued;
    })();
    const full: QuickNoteDocument = {
      ...doc,
      id: randomUUID(),
      number,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const written = this.db
        .prepare('INSERT INTO quick_notes (note_id, user_id, number, doc) VALUES (?, ?, ?, ?)')
        .run(full.id, full.userId, full.number, serializeDoc(full));
      this.indexNote(written.lastInsertRowid, full);
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new Error('another note was written at the same moment — try again');
      }
      throw error;
    }
    return full;
  }

  async get(id: string): Promise<QuickNoteDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
      .get(id) as { doc: string } | undefined;
    return row ? normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)) : null;
  }

  async getByNumber(userId: string, number: number): Promise<QuickNoteDocument | null> {
    const row = this.db
      .prepare('SELECT doc FROM quick_notes WHERE user_id = ? AND number = ?')
      .get(userId, number) as { doc: string } | undefined;
    return row ? normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)) : null;
  }

  async findByNumber(namespaces: readonly string[], number: number): Promise<QuickNoteDocument[]> {
    if (!namespaces.length) return [];
    const placeholders = namespaces.map(() => '?').join(', ');
    // Earlier addresses live inside the document (`previousLocations`); a
    // link written before a move still has to arrive, so they are searched
    // too — through json_each, which answers nothing for a note that never
    // moved.
    const rows = this.db.prepare(`
      SELECT doc FROM quick_notes
      WHERE (user_id IN (${placeholders}) AND number = ?)
         OR EXISTS (
           SELECT 1 FROM json_each(quick_notes.doc, '$.previousLocations') AS location
           WHERE json_extract(location.value, '$.userId') IN (${placeholders})
             AND json_extract(location.value, '$.number') = ?
         )
    `).all(...namespaces, number, ...namespaces, number) as Array<{ doc: string }>;
    return rows.map((row) => normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)));
  }

  /** Every row this user has, live and archived — both lists read from here.
   *  Archived state lives inside the document (no column, no migration), so
   *  the split is done in JS exactly as the sort already is. */
  private allByUser(userId: string): QuickNoteDocument[] {
    const rows = this.db
      .prepare('SELECT doc FROM quick_notes WHERE user_id = ?')
      .all(userId) as Array<{ doc: string }>;
    return rows.map((row) => normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)));
  }

  async listByUser(userId: string): Promise<QuickNoteDocument[]> {
    // Recency lives in the document rather than a column, so the sort is here
    // rather than in SQL. At a few hundred live notes per workplace (and an
    // archive read beside them) that is still a millisecond.
    return byRecency(this.allByUser(userId).filter((doc) => !quickNoteIsArchived(doc)));
  }

  async listArchivedByUser(userId: string): Promise<QuickNoteDocument[]> {
    return byArchivedRecency(this.allByUser(userId).filter(quickNoteIsArchived));
  }

  async countByUser(userId: string): Promise<number> {
    // Not `COUNT(*)`: the ceiling this feeds counts the notes on the user's
    // desk, and an archived row is one they have already put away.
    return (await this.listByUser(userId)).length;
  }

  async countArchivedByUser(userId: string): Promise<number> {
    return (await this.listArchivedByUser(userId)).length;
  }

  async listActiveClaimsByUsers(userIds: readonly string[], now: Date): Promise<QuickNoteActiveClaim[]> {
    const wanted = [...new Set(userIds)];
    if (!wanted.length) return [];
    const placeholders = wanted.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT doc FROM quick_notes
      WHERE user_id IN (${placeholders})
        AND json_extract(doc, '$.archivedAt') IS NULL
        AND json_extract(doc, '$.claim.expiresAt') > ?
    `).all(...wanted, now.toISOString()) as Array<{ doc: string }>;
    return rows.flatMap((row) => {
      const note = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const claim = activeQuickNoteClaim(note, now);
      return claim ? [{ id: note.id, userId: note.userId, claim }] : [];
    });
  }

  /**
   * The index narrows, `rankQuickNoteSearch` orders (note #242).
   *
   * Every term becomes a quoted prefix query and they are ANDed, which is what
   * a person means by typing two words: the note about the wifi code, not
   * every note mentioning either. Quoted because a term like `and` or `near`
   * is a word to somebody searching and an OPERATOR to FTS5.
   *
   * The join carries `note_id` as well as the rowid the tables share, so an
   * index row that has come adrift is skipped rather than believed — the
   * pairing is repaired at startup, and until then a missing result beats
   * somebody else's note under this note's words.
   */
  async search(
    userId: string,
    terms: readonly string[],
    limit: number,
  ): Promise<QuickNoteDocument[]> {
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term}"*`).join(' AND ');
    const rows = this.db.prepare(`
      SELECT q.doc AS doc
      FROM quick_note_search s
      JOIN quick_notes q ON q.rowid = s.rowid AND q.note_id = s.note_id
      WHERE quick_note_search MATCH ? AND q.user_id = ?
      ORDER BY bm25(quick_note_search, 10.0, 1.0)
      LIMIT ?
    `).all(match, userId, QUICK_NOTE_SEARCH_CANDIDATES) as Array<{ doc: string }>;
    const docs = rows.map((row) => normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc)));
    return rankQuickNoteSearch(docs, terms, limit);
  }

  async update(id: string, updates: Partial<QuickNoteDocument>): Promise<QuickNoteDocument | null> {
    // Partial writers (edit/archive/file metadata) must merge against the
    // document inside one transaction. A read followed by an awaited write
    // can otherwise land a stale copy over a claim acquired between them.
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const current = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const next = { ...current, ...updates };
      this.db
        .prepare('UPDATE quick_notes SET user_id = ?, number = ?, doc = ? WHERE note_id = ?')
        .run(next.userId, next.number, serializeDoc(next), id);
      // Inside the same transaction as the words it describes: an edit that
      // landed and an index that did not is a note whose search result quotes
      // a sentence it no longer contains.
      this.indexNote(this.rowidOf(id)!, next);
      return next;
    }).immediate();
  }

  async move(id: string, userId: string, numbering?: NumberSeries): Promise<QuickNoteDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const current = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      if (current.userId === userId) return current;

      // Preserve the source high-water mark before its highest row leaves.
      // This matters for a legacy namespace whose counter has not been seeded
      // yet: note #7 must not become available merely because #7 moved out.
      this.observeNumber(current.userId, current.number);

      const previous = current.previousLocations ?? [];
      const oldNumber = [...previous].reverse().find((location) => location.userId === userId)?.number;
      const candidates = [oldNumber, current.number]
        .filter((number): number is number => Number.isSafeInteger(number) && Number(number) > 0);
      let number = candidates.find((candidate) => !this.db
        .prepare('SELECT 1 FROM quick_notes WHERE user_id = ? AND number = ? AND note_id != ?')
        .get(userId, candidate, id));
      if (number === undefined) {
        number = this.allocateNumberInsideTransaction(numbering ?? SqliteQuickNoteStorage.ownSeries(userId));
      }
      this.observeNumber(userId, number);

      const location = { userId: current.userId, number: current.number };
      const locations = previous.some((entry) => entry.userId === location.userId && entry.number === location.number)
        ? previous
        : [...previous, location];
      const next = { ...current, userId, number, previousLocations: locations };
      this.db
        .prepare('UPDATE quick_notes SET user_id = ?, number = ?, doc = ? WHERE note_id = ?')
        .run(next.userId, next.number, serializeDoc(next), id);
      // The room is read off the note's own row, not the index — but the
      // NUMBER is indexed, it is how a search finds "#12", and a move is the
      // one thing that changes it.
      this.indexNote(this.rowidOf(id)!, next);
      return next;
    }).immediate();
  }

  /**
   * Appends a remark inside ONE transaction — read, append, write.
   *
   * The two writers are a person tapping Send in the Workspace and an agent
   * mid-turn, so this is the one write here with a real race in it: two plain
   * read-modify-writes land the later array over the earlier one and a comment
   * disappears with nothing to show it ever arrived.
   *
   * `updatedAt` is left alone on purpose: the note's own words did not change,
   * and that field is what every surface prints as "updated …".
   */
  async addComment(id: string, comment: QuickNoteComment): Promise<QuickNoteDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const next = { ...doc, comments: [...(doc.comments ?? []), comment] };
      this.db
        .prepare('UPDATE quick_notes SET doc = ? WHERE note_id = ?')
        .run(serializeDoc(next), id);
      // A remark is searchable text on the note — "the one Ruby said was
      // fixed" is a real way to look for it.
      this.indexNote(this.rowidOf(id)!, next);
      return next;
    })();
  }

  /** Replaces only the chosen remark inside one transaction, so a comment
   *  appended at the same moment survives the edit. */
  async editComment(id: string, commentId: string, text: string, editedAt: string): Promise<QuickNoteDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const at = (doc.comments ?? []).findIndex((comment) => comment.id === commentId);
      if (at < 0) return null;
      const comments = [...(doc.comments ?? [])];
      comments[at] = { ...comments[at]!, text, editedAt };
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE quick_notes SET doc = ? WHERE note_id = ?')
        .run(serializeDoc(next), id);
      this.indexNote(this.rowidOf(id)!, next);
      return next;
    })();
  }

  /** Removes only the chosen remark inside one transaction, so a comment
   *  appended at the same moment survives the delete. */
  async deleteComment(id: string, commentId: string): Promise<QuickNoteDocument | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const doc = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const comments = (doc.comments ?? []).filter((comment) => comment.id !== commentId);
      if (comments.length === (doc.comments ?? []).length) return null;
      const next = { ...doc, comments };
      this.db
        .prepare('UPDATE quick_notes SET doc = ? WHERE note_id = ?')
        .run(serializeDoc(next), id);
      this.indexNote(this.rowidOf(id)!, next);
      return next;
    })();
  }

  async claim(id: string, claimant: QuickNoteClaimant, now: Date): Promise<QuickNoteClaimResult | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const current = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      if (quickNoteIsArchived(current)) return { outcome: 'archived' as const, note: current };
      const held = activeQuickNoteClaim(current, now);
      if (held && held.agentId !== claimant.agentId) {
        return { outcome: 'held' as const, note: current, claim: held };
      }
      const claim: QuickNoteClaim = {
        ...claimant,
        claimedAt: held?.claimedAt ?? now.toISOString(),
        expiresAt: new Date(now.getTime() + QUICK_NOTE_CLAIM_LEASE_MS).toISOString(),
        fingerprint: quickNoteFingerprint(current),
      };
      // The claim answers the handoff and replaces it (notes #234/#258): a
      // handoff left under a lease would resurface as "handed" the moment the
      // agent released the note, saying somebody was on it seconds after that
      // agent said it was not.
      const { handoff: _handoff, ...withoutHandoff } = current;
      const next = { ...withoutHandoff, claim };
      this.db.prepare('UPDATE quick_notes SET doc = ? WHERE note_id = ?')
        .run(serializeDoc(next), id);
      return { outcome: held ? 'renewed' as const : 'claimed' as const, note: next, claim };
    }).immediate();
  }

  async releaseClaim(
    id: string,
    agentId: string,
    now: Date,
  ): Promise<QuickNoteClaimReleaseResult | null> {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT doc FROM quick_notes WHERE note_id = ?')
        .get(id) as { doc: string } | undefined;
      if (!row) return null;
      const current = normalizeQuickNote(deserializeDoc<StoredQuickNote>(row.doc));
      const held = activeQuickNoteClaim(current, now);
      if (held && held.agentId !== agentId) {
        return { outcome: 'held' as const, note: current, claim: held };
      }
      const { claim: _claim, ...withoutClaim } = current;
      this.db.prepare('UPDATE quick_notes SET doc = ? WHERE note_id = ?')
        .run(serializeDoc(withoutClaim), id);
      return { outcome: held ? 'released' as const : 'unclaimed' as const, note: withoutClaim };
    }).immediate();
  }

  async delete(id: string): Promise<boolean> {
    // Really deleted, no tombstone — and no tombstone is NEEDED, because the
    // archive is the recoverable step and this row has already been through
    // it (the routes refuse a delete on a live note). What the repo trash
    // does with a clock and a host directory, an `archivedAt` does here.
    const rowid = this.rowidOf(id);
    const result = this.db.prepare('DELETE FROM quick_notes WHERE note_id = ?').run(id);
    // The words go with the note. An index row outliving its document is the
    // one failure a reader would actually see: a result that opens onto
    // nothing.
    if (rowid !== undefined) this.db.prepare('DELETE FROM quick_note_search WHERE rowid = ?').run(rowid);
    return result.changes > 0;
  }

  async deleteByUser(userId: string): Promise<number> {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT rowid AS rowid FROM quick_notes WHERE user_id = ?')
        .all(userId) as Array<{ rowid: number }>;
      for (const row of rows) {
        this.db.prepare('DELETE FROM quick_note_search WHERE rowid = ?').run(row.rowid);
      }
      const removed = this.db.prepare('DELETE FROM quick_notes WHERE user_id = ?').run(userId).changes;
      this.db.prepare('DELETE FROM quick_note_numbers WHERE user_id = ?').run(userId);
      return removed;
    })();
  }

  async deleteSeries(series: string): Promise<void> {
    this.db.prepare('DELETE FROM quick_note_numbers WHERE user_id = ?').run(series);
  }
}
