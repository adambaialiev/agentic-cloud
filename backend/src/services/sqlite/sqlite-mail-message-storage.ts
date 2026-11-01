import type {
  MailBlockOutcome,
  MailConversation,
  MailConversationListOptions,
  MailConversationMoveOutcome,
  MailConversationPage,
  MailListOptions,
  MailMessageDocument,
  MailMessagePage,
  MailMessageStorage,
  MailMessageStoreOutcome,
  MailMove,
  MailMoveOutcome,
  MailPlace,
  MailStarOptions,
  MailStarOutcome,
  MailView,
} from '../mail-message-storage.js';
import { mailSearchMatch } from '../mail-search.js';
import { mailSenderKey } from '../mail-pictures.js';
import { deserializeDoc, serializeDoc, type SqliteDb } from './sqlite-db.js';
import { indexMailMessage, MAIL_SEARCH_TABLE } from './sqlite-mail-search.js';
import { ensureMailRepliesFiled, mailRefsColumn, resolveMailThread } from './sqlite-mail-threads.js';

/** A row OF THE LIST: what arrived, and what this person started. A reply is
 *  read under the message it answers and is never one. */
const LIST_ROW = "(direction = 'in' OR (direction = 'sent' AND answers IS NULL))";
const ARCHIVED = "json_extract(doc, '$.archivedAt') IS NOT NULL";
const SPAM = "json_extract(doc, '$.spamAt') IS NOT NULL";
const TRASHED = "json_extract(doc, '$.trashedAt') IS NOT NULL";
const NOT_ARCHIVED = "json_extract(doc, '$.archivedAt') IS NULL";
const NOT_SPAM = "json_extract(doc, '$.spamAt') IS NULL";
const NOT_TRASHED = "json_extract(doc, '$.trashedAt') IS NULL";
const STARRED = "json_extract(doc, '$.starredAt') IS NOT NULL";
const NOT_STARRED = "json_extract(doc, '$.starredAt') IS NULL";

/** Which rows each view holds. `trash` wins over `spam` wins over `archive`:
 *  a message archived and then trashed is in Trash, and Restore puts it back
 *  in the archive it came from. `all` — what a search from the inbox looks
 *  through — leaves out Trash AND Spam (slice 13): a letter nothing vouched
 *  for must not turn up under a word somebody typed looking for a real one.
 *  `sent` is not here — it is not a place, and it picks its rows by which WAY
 *  they went; see `rowsOfView`. */
const IN_VIEW: Record<Exclude<MailView, 'sent' | 'starred'>, string> = {
  inbox: `${NOT_ARCHIVED} AND ${NOT_SPAM} AND ${NOT_TRASHED}`,
  archive: `${ARCHIVED} AND ${NOT_SPAM} AND ${NOT_TRASHED}`,
  spam: `${SPAM} AND ${NOT_TRASHED}`,
  trash: TRASHED,
  all: `${NOT_SPAM} AND ${NOT_TRASHED}`,
};

/**
 * Which rows one view of the list holds (slice 9).
 *
 * Every view but SENT is a place, and a row of it is a row of the list: what
 * arrived, and what this person started. Sent is the other question — what
 * has gone out of this address — so it is every letter that went out, the
 * replies among them, and it is the one list a reply is a row of. It leaves
 * out Trash for the reason a search does: that is what putting a letter
 * there means. A reply is stamped with the letter it answers, so it is in
 * Trash exactly when the letter it belongs under is.
 */
const rowsOfView = (view: MailView): string => (view === 'sent'
  ? `direction = 'sent' AND ${NOT_TRASHED}`
  // Starred (note #666) is a view of letters too, and any letter can be in
  // it — a reply this person sent among them — so long as it is not in Trash
  // or Spam, where a reader who starred it would never look for it.
  : view === 'starred'
    ? `${STARRED} AND ${IN_VIEW.all}`
    : `${LIST_ROW} AND ${IN_VIEW[view]}`);

/** Which place a conversation is listed in, by the place of its liveliest
 *  letter: 1 while any is in the inbox, 2 while any is archived, 3 when all
 *  of it is in Trash. Replies are not counted — they go where it goes. */
const PLACE_RANK = `CASE WHEN ${TRASHED} THEN 4 WHEN ${SPAM} THEN 3 WHEN ${ARCHIVED} THEN 2 ELSE 1 END`;
const RANK_OF: Record<MailPlace, number> = { inbox: 1, archive: 2, spam: 3, trash: 4 };

/** A letter as a list reads it: everything but the two bodies, which can be
 *  half a megabyte each and which no row draws. */
const LIGHT_DOC = "json_remove(doc, '$.text', '$.html') AS doc";

/**
 * Each move as ONE guarded update, written straight onto the stored document
 * the way `markRead` is — never read, changed and written back, so two tabs
 * (or a tab and an agent) cannot race each other into a document that lost a
 * field. The guard is what makes a move that changes nothing change nothing.
 */
const MOVES: Record<MailMove, { set: string; when: string }> = {
  archive: {
    set: "json_set(json_remove(doc, '$.archivedBy'), '$.archivedAt', @at)",
    when: `${NOT_TRASHED} AND ${NOT_SPAM} AND ${NOT_ARCHIVED}`,
  },
  unarchive: {
    set: "json_remove(doc, '$.archivedAt', '$.archivedBy')",
    when: `${NOT_TRASHED} AND ${NOT_SPAM} AND ${ARCHIVED}`,
  },
  // Spam (slice 13): marked by its owner or their agent, so `spamWhy` says
  // so; a letter the checks marked or a blocked sender's is stamped on the
  // way in, not through here. Not spam takes every spam stamp off and leaves
  // `notSpam` on, which is what stops the boot pass filing it again.
  spam: {
    set: "json_set(json_remove(doc, '$.spamBy', '$.notSpam'), '$.spamAt', @at, '$.spamWhy', 'marked')",
    when: `${NOT_TRASHED} AND ${NOT_SPAM}`,
  },
  unspam: {
    set: "json_set(json_remove(doc, '$.spamAt', '$.spamWhy', '$.spamBy'), '$.notSpam', json('true'))",
    when: `${NOT_TRASHED} AND ${SPAM}`,
  },
  trash: {
    set: "json_set(json_remove(doc, '$.trashedBy'), '$.trashedAt', @at)",
    when: NOT_TRASHED,
  },
  restore: {
    set: "json_remove(doc, '$.trashedAt', '$.trashedBy')",
    when: TRASHED,
  },
};

/**
 * The inbox behind every address. Ordered by `seq` rather than by the clock:
 * two messages can arrive in the same millisecond, and the cursor a list
 * screen pages with has to be total.
 *
 * Redelivery is the case worth knowing about. A sending server that never
 * saw our answer sends the same message again, and it must land as the same
 * row — hence the unique index on (address, message_id), and an insert that
 * reads the existing row back instead of failing the delivery.
 */
export class SqliteMailMessageStorage implements MailMessageStorage {
  constructor(private readonly db: SqliteDb) {}

  async store(doc: MailMessageDocument): Promise<MailMessageStoreOutcome> {
    const transaction = this.db.transaction((): MailMessageStoreOutcome => {
      // Agent mail approvals carry one stable outbound id through every
      // retry. If the provider call and the request-state write were split by
      // a restart, approving again reaches the provider idempotently and the
      // already-stored sent row is success too — never a second message and
      // never a primary-key error over one that did go.
      const byId = this.db.prepare(
        'SELECT user_id FROM workspace_mail_messages WHERE id = ?',
      ).get(doc.id) as { user_id: string } | undefined;
      if (byId?.user_id === doc.userId) return { stored: 'duplicate', id: doc.id };
      // A reply carries the Message-ID WE minted for it, and two people may
      // answer the same thread; uniqueness is only about a redelivered
      // inbound message, so a sent row never looks for a twin.
      if (doc.messageId && (doc.direction ?? 'in') === 'in') {
        const seen = this.db.prepare(
          'SELECT id FROM workspace_mail_messages WHERE address = ? AND message_id = ?',
        ).get(doc.address, doc.messageId) as { id: string } | undefined;
        if (seen) return { stored: 'duplicate', id: seen.id };
      }
      // Its conversation is decided here, inside the same transaction as the
      // row, from what is stored at this moment — see resolveMailThread.
      const thread = resolveMailThread(this.db, doc);
      const stored: MailMessageDocument = { ...doc, thread };
      const inserted = this.db.prepare(
        `INSERT INTO workspace_mail_messages (id, user_id, address, message_id, received_at, direction, answers, thread, refs, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(doc.id, doc.userId, doc.address, doc.messageId ?? null, doc.receivedAt,
        doc.direction ?? 'in', doc.answers ?? null, thread, mailRefsColumn(doc), serializeDoc(stored));
      // In the same transaction as the row, so a message is never stored
      // without being findable, nor findable without being stored.
      indexMailMessage(this.db, inserted.lastInsertRowid, doc);
      return { stored: 'new', id: doc.id };
    });
    return transaction.immediate();
  }

  async get(userId: string, id: string): Promise<MailMessageDocument | null> {
    const row = this.db.prepare(
      'SELECT doc FROM workspace_mail_messages WHERE id = ? AND user_id = ?',
    ).get(id, userId) as { doc: string } | undefined;
    return row ? deserializeDoc<MailMessageDocument>(row.doc) : null;
  }

  async list(userId: string, opts: MailListOptions = {}): Promise<MailMessagePage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    // A cursor that is not a number is not a cursor. Reading it as "from the
    // top" beats answering an error to a screen that can only have got it
    // from us.
    const before = Number.parseInt(opts.before ?? '', 10);
    const paged = Number.isFinite(before);
    const searching = opts.search !== undefined;
    const match = searching ? mailSearchMatch(opts.search) : null;
    // Words with nothing in them to look for find nothing — never the whole
    // list, which is what a search that quietly dropped its words would show.
    if (searching && !match) return { messages: [] };
    const view: MailView = opts.in ?? (searching ? 'all' : 'inbox');
    const rows = this.db.prepare(
      `SELECT seq, doc FROM workspace_mail_messages
        WHERE user_id = @userId
          AND ${rowsOfView(view)}
          ${match ? `AND seq IN (SELECT rowid FROM ${MAIL_SEARCH_TABLE} WHERE ${MAIL_SEARCH_TABLE} MATCH @match)` : ''}
          ${paged ? 'AND seq < @before' : ''}
        ORDER BY seq DESC LIMIT @limit`,
    ).all({
      userId,
      ...(match ? { match } : {}),
      ...(paged ? { before } : {}),
      limit: limit + 1,
    }) as { seq: number; doc: string }[];
    const page = rows.slice(0, limit);
    return {
      messages: page.map((row) => deserializeDoc<MailMessageDocument>(row.doc)),
      ...(rows.length > limit && page.length ? { nextBefore: String(page[page.length - 1]!.seq) } : {}),
    };
  }

  /** ONE definition of what has gone out (slice 9): the agent's `mail sent`
   *  and its owner's own Sent screen read the same list, so they cannot
   *  disagree about what this address has said. */
  async listSent(userId: string, opts: { limit?: number; before?: string } = {}): Promise<MailMessagePage> {
    return this.list(userId, { ...opts, in: 'sent' });
  }

  async listAnswers(userId: string, messageId: string): Promise<MailMessageDocument[]> {
    const rows = this.db.prepare(
      `SELECT doc FROM workspace_mail_messages
        WHERE user_id = ? AND direction = 'sent' AND answers = ?
        ORDER BY seq ASC`,
    ).all(userId, messageId) as { doc: string }[];
    return rows.map((row) => deserializeDoc<MailMessageDocument>(row.doc));
  }

  /**
   * The owner opened it. Written straight onto the stored document rather
   * than read-modify-written back, so two tabs opening the same message
   * cannot race one another into a doc that lost a field — and the `readAt IS
   * NULL` clause is what keeps the stamp the FIRST read rather than the last.
   *
   * Only a message that ARRIVED can be unread: one this person sent needs no
   * reading, and stamping it would make its row change under them.
   */
  async markRead(userId: string, id: string, atIso: string): Promise<boolean> {
    const result = this.db.prepare(
      `UPDATE workspace_mail_messages
          SET doc = json_set(doc, '$.readAt', @at)
        WHERE id = @id AND user_id = @userId AND direction = 'in'
          AND json_extract(doc, '$.readAt') IS NULL`,
    ).run({ at: atIso, id, userId });
    return result.changes > 0;
  }

  /**
   * One move as an UPDATE over the rows `which` picks — one letter, the
   * replies under it, or every letter of a conversation — with the move's
   * own guard, so a row it does not apply to is left exactly as it was.
   */
  private moveRows(
    move: MailMove,
    which: string,
    params: Record<string, unknown>,
    opts: { atIso: string; by?: { agentId: string; name?: string } },
  ): number {
    const { set, when } = MOVES[move];
    // Who moved it rides along only when an agent did. A person moving their
    // own mail leaves no name, and an agent's name from an earlier move is
    // cleared with the stamp it belonged to (the `json_remove` above).
    const by = opts.by && (move === 'archive' || move === 'spam' || move === 'trash') ? opts.by : undefined;
    const byPath = move === 'archive' ? '$.archivedBy' : move === 'spam' ? '$.spamBy' : '$.trashedBy';
    return this.db.prepare(
      `UPDATE workspace_mail_messages
          SET doc = ${by ? `json_set(${set}, '${byPath}', json(@by))` : set}
        WHERE ${which} AND ${when}`,
    ).run({ ...params, ...(set.includes('@at') ? { at: opts.atIso } : {}), ...(by ? { by: JSON.stringify(by) } : {}) }).changes;
  }

  async move(
    userId: string,
    id: string,
    move: MailMove,
    opts: { atIso: string; by?: { agentId: string; name?: string } },
  ): Promise<MailMoveOutcome> {
    const transaction = this.db.transaction((): MailMoveOutcome => {
      // Only a row of the LIST can be asked to move — a reply is read under
      // the message it answers — and the replies under it are stamped with
      // it, because that is where they are kept. Counted apart, so a letter
      // that was already where it is going still answers `moved: false`.
      const changed = this.moveRows(move, `id = @id AND user_id = @userId AND ${LIST_ROW}`, { id, userId }, opts);
      this.moveRows(move, "answers = @id AND user_id = @userId AND direction = 'sent'", { id, userId }, opts);
      const row = this.db.prepare(
        'SELECT direction, answers, doc FROM workspace_mail_messages WHERE id = ? AND user_id = ?',
      ).get(id, userId) as { direction: string; answers: string | null; doc: string } | undefined;
      if (!row) return { refused: 'no_such_message' };
      const doc = deserializeDoc<MailMessageDocument>(row.doc);
      if (changed > 0) return { moved: true, doc };
      // Nothing changed — so say why, when there is a why.
      if (row.direction === 'sent' && row.answers) return { refused: 'is_reply' };
      if (move !== 'trash' && move !== 'restore' && doc.trashedAt) return { refused: 'in_trash' };
      if ((move === 'archive' || move === 'unarchive') && doc.spamAt) return { refused: 'in_spam' };
      return { moved: false, doc };
    });
    return transaction.immediate();
  }

  async listConversations(userId: string, opts: MailConversationListOptions = {}): Promise<MailConversationPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const before = Number.parseInt(opts.before ?? '', 10);
    const paged = Number.isFinite(before);
    // Grouped on the thread index, which carries every stamp this reads: no
    // letter is opened to decide which conversations are on the page.
    const page = this.db.prepare(
      `SELECT thread, latest FROM (
          SELECT thread, MAX(seq) AS latest, MIN(CASE WHEN ${LIST_ROW} THEN ${PLACE_RANK} END) AS rank
            FROM workspace_mail_messages
           WHERE user_id = @userId
           GROUP BY thread)
        WHERE rank = @rank${paged ? ' AND latest < @before' : ''}
        ORDER BY latest DESC LIMIT @limit`,
    ).all({ userId, rank: RANK_OF[opts.in ?? 'inbox'], ...(paged ? { before } : {}), limit: limit + 1 }) as { thread: string; latest: number }[];
    const shown = page.slice(0, limit);
    if (!shown.length) return { conversations: [] };
    const rows = this.db.prepare(
      `SELECT thread, ${LIGHT_DOC} FROM workspace_mail_messages
        WHERE user_id = ? AND thread IN (SELECT value FROM json_each(?))
        ORDER BY seq`,
    ).all(userId, JSON.stringify(shown.map((row) => row.thread))) as { thread: string; doc: string }[];
    const byThread = new Map<string, MailMessageDocument[]>(shown.map((row) => [row.thread, []]));
    for (const row of rows) byThread.get(row.thread)?.push(deserializeDoc<MailMessageDocument>(row.doc));
    return {
      conversations: shown.map((row) => ({ thread: row.thread, messages: byThread.get(row.thread) ?? [] })),
      ...(page.length > limit ? { nextBefore: String(shown[shown.length - 1]!.latest) } : {}),
    };
  }

  async getConversation(userId: string, messageId: string): Promise<MailConversation | null> {
    const found = this.db.prepare(
      'SELECT thread, doc FROM workspace_mail_messages WHERE id = ? AND user_id = ?',
    ).get(messageId, userId) as { thread: string | null; doc: string } | undefined;
    if (!found) return null;
    // Every row is threaded at boot and on the way in; a row that somehow is
    // not is a conversation of one rather than nothing at all.
    if (!found.thread) return { thread: messageId, messages: [deserializeDoc<MailMessageDocument>(found.doc)] };
    const rows = this.db.prepare(
      'SELECT doc FROM workspace_mail_messages WHERE user_id = ? AND thread = ? ORDER BY seq',
    ).all(userId, found.thread) as { doc: string }[];
    return { thread: found.thread, messages: rows.map((row) => deserializeDoc<MailMessageDocument>(row.doc)) };
  }

  async moveConversation(
    userId: string,
    messageId: string,
    move: MailMove,
    opts: { atIso: string; by?: { agentId: string; name?: string } },
  ): Promise<MailConversationMoveOutcome> {
    const transaction = this.db.transaction((): MailConversationMoveOutcome => {
      const found = this.db.prepare(
        'SELECT thread FROM workspace_mail_messages WHERE id = ? AND user_id = ?',
      ).get(messageId, userId) as { thread: string | null } | undefined;
      if (!found?.thread) return { refused: 'no_such_message' };
      const thread = found.thread;
      // Every letter of it, the replies among them: they go where the
      // conversation goes, and since slice 9 that is a fact Sent reads off
      // each of them rather than one implied by where they are not.
      const changed = this.moveRows(move, 'user_id = @userId AND thread = @thread', { userId, thread }, opts);
      const rows = this.db.prepare(
        `SELECT ${LIGHT_DOC} FROM workspace_mail_messages WHERE user_id = ? AND thread = ? ORDER BY seq`,
      ).all(userId, thread) as { doc: string }[];
      const messages = rows.map((row) => deserializeDoc<MailMessageDocument>(row.doc));
      // Nothing changed — and the reason is worth saying when ALL of it is in
      // Trash: the one way out of Trash is Restore, for a conversation as for
      // a letter.
      const listed = messages.filter((doc) => (doc.direction ?? 'in') === 'in' || !doc.answers);
      if (!changed && move !== 'trash' && move !== 'restore' && listed.every((doc) => doc.trashedAt)) {
        return { refused: 'in_trash' };
      }
      // Likewise Spam: a conversation wholly in Spam is archived only once
      // it has been marked Not spam, so that the way out of Spam is one thing.
      if (!changed && (move === 'archive' || move === 'unarchive') && listed.every((doc) => doc.spamAt || doc.trashedAt)) {
        return { refused: 'in_spam' };
      }
      return { moved: changed > 0, conversation: { thread, messages } };
    });
    return transaction.immediate();
  }

  async markConversationRead(userId: string, thread: string, atIso: string): Promise<number> {
    return this.db.prepare(
      `UPDATE workspace_mail_messages
          SET doc = json_set(doc, '$.readAt', @at)
        WHERE user_id = @userId AND thread = @thread AND direction = 'in'
          AND json_extract(doc, '$.readAt') IS NULL`,
    ).run({ at: atIso, userId, thread }).changes;
  }

  /**
   * A star on, or off (note #666), written straight onto the stored document
   * the way a move is — one guarded update, so a star already there keeps
   * the moment it was first put there, and two tabs cannot race a field out.
   *
   * A star goes on one letter, or — for a conversation's row — on its newest
   * letter that arrived (else its newest), outside Trash and Spam. Taking it
   * off a conversation takes it off every letter in it.
   */
  async star(userId: string, messageId: string, opts: MailStarOptions): Promise<MailStarOutcome> {
    const transaction = this.db.transaction((): MailStarOutcome => {
      const found = this.db.prepare(
        'SELECT thread, doc FROM workspace_mail_messages WHERE id = ? AND user_id = ?',
      ).get(messageId, userId) as { thread: string | null; doc: string } | undefined;
      if (!found) return { refused: 'no_such_message' };
      const thread = found.thread ?? messageId;
      const letters = (): MailMessageDocument[] => (this.db.prepare(
        `SELECT ${LIGHT_DOC} FROM workspace_mail_messages WHERE user_id = ? AND (thread = ? OR id = ?) ORDER BY seq`,
      ).all(userId, thread, messageId) as { doc: string }[]).map((row) => deserializeDoc<MailMessageDocument>(row.doc));
      let target = messageId;
      if (opts.whole && opts.starred) {
        // The newest letter that ARRIVED a star could stand on, else the
        // newest this person sent; when there is none, the one asked about
        // answers why.
        const kept = letters().filter((doc) => !doc.trashedAt && !doc.spamAt);
        const arrived = kept.filter((doc) => (doc.direction ?? 'in') === 'in');
        const pick = arrived.length ? arrived : kept;
        target = pick.length ? pick[pick.length - 1]!.id : messageId;
      }
      let changed = 0;
      if (opts.starred) {
        const doc = target === messageId
          ? deserializeDoc<MailMessageDocument>(found.doc)
          : letters().find((one) => one.id === target)!;
        if (doc.trashedAt) return { refused: 'in_trash' };
        if (doc.spamAt) return { refused: 'in_spam' };
        changed = this.db.prepare(
          `UPDATE workspace_mail_messages
              SET doc = ${opts.by
                ? "json_set(doc, '$.starredAt', @at, '$.starredBy', json(@by))"
                : "json_set(json_remove(doc, '$.starredBy'), '$.starredAt', @at)"}
            WHERE id = @id AND user_id = @userId AND ${NOT_STARRED}`,
        ).run({ id: target, userId, at: opts.atIso, ...(opts.by ? { by: JSON.stringify(opts.by) } : {}) }).changes;
      } else {
        changed = this.db.prepare(
          `UPDATE workspace_mail_messages
              SET doc = json_remove(doc, '$.starredAt', '$.starredBy')
            WHERE user_id = @userId AND ${opts.whole ? '(thread = @thread OR id = @id)' : 'id = @id'} AND ${STARRED}`,
        ).run({ id: messageId, userId, thread }).changes;
      }
      const messages = letters();
      const doc = messages.find((one) => one.id === target) ?? deserializeDoc<MailMessageDocument>(found.doc);
      return { changed: changed > 0, doc, conversation: { thread, messages } };
    });
    return transaction.immediate();
  }

  async countUnread(userId: string): Promise<number> {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM workspace_mail_messages
        WHERE user_id = ? AND direction = 'in' AND json_extract(doc, '$.readAt') IS NULL
          AND ${IN_VIEW.inbox}`,
    ).get(userId) as { total: number };
    return row.total;
  }

  async countSentSince(userId: string, sinceIso: string): Promise<number> {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM workspace_mail_messages
        WHERE user_id = ? AND direction = 'sent' AND received_at >= ?`,
    ).get(userId, sinceIso) as { total: number };
    return row.total;
  }

  async countNewSince(userId: string, sinceIso: string): Promise<number> {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM workspace_mail_messages
        WHERE user_id = ? AND direction = 'sent' AND received_at >= ?
          AND (answers IS NULL OR json_extract(doc, '$.reachesNew') = 1)`,
    ).get(userId, sinceIso) as { total: number };
    return row.total;
  }

  async countForUser(userId: string): Promise<number> {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS total FROM workspace_mail_messages WHERE user_id = ?',
    ).get(userId) as { total: number };
    return row.total;
  }

  /**
   * THE SENDERS THIS PERSON LOADS PICTURES FROM (slice 10). One small table,
   * keyed on the pair, so putting an address on it twice is not an error and
   * taking one off is exact. Every one of the three answers the list as it
   * now stands: the screen draws what the server says, never what it asked
   * for.
   */
  async imageSenders(userId: string): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT address FROM workspace_mail_image_senders WHERE user_id = ? ORDER BY address',
    ).all(userId) as { address: string }[];
    return rows.map((row) => row.address);
  }

  async allowImagesFrom(userId: string, address: string, atIso: string): Promise<string[]> {
    this.db.prepare(
      `INSERT INTO workspace_mail_image_senders (user_id, address, added_at)
       VALUES (@userId, @address, @at)
       ON CONFLICT (user_id, address) DO NOTHING`,
    ).run({ userId, address: mailSenderKey(address), at: atIso });
    return this.imageSenders(userId);
  }

  async stopImagesFrom(userId: string, address: string): Promise<string[]> {
    this.db.prepare(
      'DELETE FROM workspace_mail_image_senders WHERE user_id = ? AND address = ?',
    ).run(userId, mailSenderKey(address));
    return this.imageSenders(userId);
  }

  /**
   * THE SENDERS THIS PERSON HAS BLOCKED (slice 13). The same small shape as
   * the picture list, and for the same reason: one person's decision about one
   * address, holding nothing a stranger wrote.
   */
  async blockedSenders(userId: string): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT address FROM workspace_mail_blocked_senders WHERE user_id = ? ORDER BY address',
    ).all(userId) as { address: string }[];
    return rows.map((row) => row.address);
  }

  async blockSender(
    userId: string,
    address: string,
    opts: { atIso: string; by?: { agentId: string; name?: string } },
  ): Promise<MailBlockOutcome> {
    const key = mailSenderKey(address);
    const transaction = this.db.transaction((): MailBlockOutcome => {
      this.db.prepare(
        `INSERT INTO workspace_mail_blocked_senders (user_id, address, added_at, added_by)
         VALUES (@userId, @address, @at, @by)
         ON CONFLICT (user_id, address) DO NOTHING`,
      ).run({ userId, address: key, at: opts.atIso, by: opts.by ? JSON.stringify(opts.by) : null });
      // Everything of theirs that is still in front of this person leaves for
      // Spam with them — the inbox and the archive; Trash is left alone, and
      // so is what is already in Spam. `notSpam` does not shield a letter from
      // this: blocking is a later decision about the SENDER.
      const moved = this.db.prepare(
        `UPDATE workspace_mail_messages
            SET doc = json_set(json_remove(doc, '$.spamBy', '$.notSpam'), '$.spamAt', @at, '$.spamWhy', 'blocked'${opts.by ? ", '$.spamBy', json(@by)" : ''})
          WHERE user_id = @userId AND direction = 'in'
            AND lower(json_extract(doc, '$.from.address')) = @address
            AND ${NOT_SPAM} AND ${NOT_TRASHED}`,
      ).run({ userId, address: key, at: opts.atIso, ...(opts.by ? { by: JSON.stringify(opts.by) } : {}) }).changes;
      // And the replies under each of those go where it went (slice 9).
      if (moved) ensureMailRepliesFiled(this.db);
      return { addresses: [], moved };
    });
    const outcome = transaction.immediate();
    return { ...outcome, addresses: await this.blockedSenders(userId) };
  }

  async unblockSender(userId: string, address: string): Promise<string[]> {
    this.db.prepare(
      'DELETE FROM workspace_mail_blocked_senders WHERE user_id = ? AND address = ?',
    ).run(userId, mailSenderKey(address));
    return this.blockedSenders(userId);
  }
}
