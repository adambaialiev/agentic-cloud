import type { MailMessageDocument } from '../mail-message-storage.js';
import { mailRefs } from '../mail-threads.js';
import type { SqliteDb } from './sqlite-db.js';

/**
 * Which conversation a message is part of (note #509, slice 8), stored on its
 * row as `thread` — the id of the message that started it — beside `refs`,
 * the messages it says it follows.
 *
 * A message JOINS ONE CONVERSATION, decided once when it is stored, and never
 * moves afterwards. That is a choice, not a shortcut. The headers that say
 * what a letter answers are written by its sender, and a stranger can name
 * any Message-ID they have ever seen; if a letter naming two conversations
 * could merge them, anybody who had written to this person twice could glue
 * those two conversations into one. So a letter goes where the NEAREST message
 * it names already is, and that is all it can do:
 *
 *   1. a reply this person sent goes where the message it answers is, and a
 *      forward where the letter it forwards is (slice 12);
 *   2. otherwise the message it answers (In-Reply-To), then its References
 *      from the nearest back, looked up among THIS person's own letters —
 *      what arrived, and what they sent, whose Message-IDs we minted;
 *   3. otherwise a letter already here that names THIS one — the answer
 *      that arrived before the message it answers, which mail does;
 *   4. otherwise it starts a conversation of its own.
 */
export function resolveMailThread(db: SqliteDb, doc: Pick<MailMessageDocument,
  'id' | 'userId' | 'address' | 'direction' | 'answers' | 'forwards' | 'messageId' | 'inReplyTo' | 'references'>): string {
  const ours = (doc.direction ?? 'in') === 'sent' ? doc.answers ?? doc.forwards : undefined;
  if (ours) {
    const answered = db.prepare(
      'SELECT thread FROM workspace_mail_messages WHERE id = ? AND user_id = ? AND thread IS NOT NULL',
    ).get(ours, doc.userId) as { thread: string } | undefined;
    if (answered) return answered.thread;
  }
  // Keyed on the mailbox's own (address, message_id) index, and on the owner
  // as well: an id another person holds is not a conversation of this one's.
  const byMessageId = db.prepare(
    `SELECT thread FROM workspace_mail_messages
      WHERE address = ? AND message_id = ? AND user_id = ? AND thread IS NOT NULL
      ORDER BY seq LIMIT 1`,
  );
  for (const ref of mailRefs(doc)) {
    const found = byMessageId.get(doc.address, ref, doc.userId) as { thread: string } | undefined;
    if (found) return found.thread;
  }
  if (doc.messageId) {
    const answeredFirst = db.prepare(
      `SELECT thread FROM workspace_mail_messages
        WHERE user_id = ? AND refs IS NOT NULL AND thread IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(refs) WHERE value = ?)
        ORDER BY seq LIMIT 1`,
    ).get(doc.userId, doc.messageId) as { thread: string } | undefined;
    if (answeredFirst) return answeredFirst.thread;
  }
  return doc.id;
}

/** The `refs` column for a message: what it says it follows, or nothing. */
export function mailRefsColumn(doc: Pick<MailMessageDocument, 'messageId' | 'inReplyTo' | 'references'>): string | null {
  const refs = mailRefs(doc);
  return refs.length ? JSON.stringify(refs) : null;
}

/** How many stored messages the first boot threads per read. */
const BACKFILL_BATCH = 500;

/**
 * Make sure every stored message is in a conversation. The first boot with
 * this code adds the two columns and threads the mail already here, oldest
 * first, by exactly the rule a new message is stored by — so what arrived
 * before conversations existed reads the same as what arrives after. Every
 * later boot finds nothing unthreaded and does nothing. One transaction, so a
 * crash half way leaves the mail as it was rather than half threaded.
 *
 * Mail stored before this kept only `inReplyTo`, never References: its
 * conversations are the chains of direct answers, which is nearly all of them.
 */
export function ensureMailThreads(db: SqliteDb): void {
  const columns = db.prepare('PRAGMA table_info(workspace_mail_messages)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'thread')) db.exec('ALTER TABLE workspace_mail_messages ADD COLUMN thread TEXT');
  if (!columns.some((column) => column.name === 'refs')) db.exec('ALTER TABLE workspace_mail_messages ADD COLUMN refs TEXT');
  // The list groups by conversation and asks where each letter is kept; with
  // the place stamps in the index it never has to open a letter to answer.
  // Spam (slice 13) is a third stamp the list reads. An index cannot grow a
  // column, so the slice-8 index is dropped and this one — every stamp the
  // list reads, Spam's included — takes its place under a name of its own.
  db.exec('DROP INDEX IF EXISTS workspace_mail_messages_by_thread');
  db.exec(`CREATE INDEX IF NOT EXISTS workspace_mail_messages_by_thread_place
    ON workspace_mail_messages (user_id, thread, seq, direction, answers,
      json_extract(doc, '$.archivedAt'), json_extract(doc, '$.spamAt'), json_extract(doc, '$.trashedAt'))`);
  const pending = db.prepare(
    'SELECT seq, doc FROM workspace_mail_messages WHERE thread IS NULL AND seq > ? ORDER BY seq LIMIT ?',
  );
  if (!pending.get(0, 1)) return;
  const write = db.prepare(
    "UPDATE workspace_mail_messages SET thread = ?, refs = ?, doc = json_set(doc, '$.thread', ?) WHERE seq = ?",
  );
  db.transaction(() => {
    let after = 0;
    for (;;) {
      const rows = pending.all(after, BACKFILL_BATCH) as { seq: number; doc: string }[];
      if (!rows.length) break;
      for (const row of rows) {
        const doc = JSON.parse(row.doc) as MailMessageDocument;
        const thread = resolveMailThread(db, doc);
        write.run(thread, mailRefsColumn(doc), thread, row.seq);
      }
      after = rows[rows.length - 1]!.seq;
    }
  })();
}

/**
 * A REPLY IS FILED WHERE THE LETTER IT ANSWERS IS (slice 9).
 *
 * That has been true since slice 7 — a reply is read under the message it
 * answers and goes wherever that message goes — but it was true by omission:
 * a reply is no row of any list, so nothing ever asked where it was kept.
 * Sent asks. It is the one list a reply IS a row of, and a reply left
 * unstamped would stand in Sent while the letter it belongs under sat in
 * Trash.
 *
 * Moves have stamped replies since this slice. This is the mail already
 * here: every reply given the archive and Trash stamps of the letter it
 * answers. One statement, run at every boot rather than once — it is the
 * cheap repair of a fact that should always hold, and on a mailbox already
 * filed it matches no row and does nothing. `json_patch` with a null MEMBER
 * REMOVES it, which is exactly right: a reply of a letter in neither place
 * ends up in neither place.
 */
export function ensureMailRepliesFiled(db: SqliteDb): void {
  const stampsOf = (column: string) => `json_object(
    'archivedAt', json_extract(${column}, '$.archivedAt'),
    'spamAt', json_extract(${column}, '$.spamAt'),
    'trashedAt', json_extract(${column}, '$.trashedAt'))`;
  const answered = `SELECT answered.doc FROM workspace_mail_messages AS answered
     WHERE answered.id = workspace_mail_messages.answers
       AND answered.user_id = workspace_mail_messages.user_id`;
  db.prepare(
    `UPDATE workspace_mail_messages
        SET doc = json_patch(doc, ${stampsOf(`(${answered})`)})
      WHERE direction = 'sent' AND answers IS NOT NULL
        AND ${stampsOf('doc')} IS NOT ${stampsOf(`(${answered})`)}`,
  ).run();
}
