import { mailSearchFields } from '../mail-search.js';
import type { MailMessageDocument } from '../mail-message-storage.js';
import type { SqliteDb } from './sqlite-db.js';

/**
 * The index a person's mail is searched through (note #509, slice 7).
 *
 * FTS5, so a search is a lookup rather than a walk of everybody's letters.
 * CONTENTLESS (`content=''`): the index holds each word and which row it is
 * in, not a second copy of anybody's mail, so a message's words live in one
 * table and only one. That is also why a row's rowid IS its `seq` — the
 * index answers row numbers, and the mail table, keyed on the reader's own
 * userId, is what turns them into messages. The index knows nothing about
 * whose they are and is never read without that join.
 *
 * `contentless_delete=1` lets a removed message take its words with it; the
 * trigger below is what does that, whatever removed it.
 *
 * `unicode61 remove_diacritics 2` makes `cafe` find `café`, and `prefix`
 * keeps the two- and three-letter beginnings of every word ready, because a
 * search box is read as it is typed.
 */
export const MAIL_SEARCH_TABLE = 'workspace_mail_search';

const CREATE = `CREATE VIRTUAL TABLE ${MAIL_SEARCH_TABLE} USING fts5(
  people, subject, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
)`;

const FORGET = `CREATE TRIGGER IF NOT EXISTS workspace_mail_search_forget
  AFTER DELETE ON workspace_mail_messages
  BEGIN DELETE FROM ${MAIL_SEARCH_TABLE} WHERE rowid = old.seq; END`;

/** How many stored messages the first boot indexes per read. */
const BACKFILL_BATCH = 500;

/** Put one stored message's words in the index, under its `seq`. */
export function indexMailMessage(db: SqliteDb, seq: number | bigint, doc: Pick<MailMessageDocument,
  'direction' | 'from' | 'to' | 'subject' | 'text' | 'html' | 'wrote'>): void {
  const fields = mailSearchFields(doc);
  db.prepare(`INSERT INTO ${MAIL_SEARCH_TABLE} (rowid, people, subject, body) VALUES (?, ?, ?, ?)`)
    .run(seq, fields.people, fields.subject, fields.body);
}

/**
 * Make sure the index exists — and, the one time it does not, fill it from
 * every message already stored, inside the same transaction that creates it.
 * So an installation either has no index or has one that covers all of its
 * mail: there is no half-built state for a crash to leave behind, and every
 * boot after the first finds the table and does nothing.
 */
export function ensureMailSearchIndex(db: SqliteDb): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MAIL_SEARCH_TABLE);
  if (!exists) {
    db.transaction(() => {
      db.exec(CREATE);
      const page = db.prepare('SELECT seq, doc FROM workspace_mail_messages WHERE seq > ? ORDER BY seq LIMIT ?');
      let after = 0;
      for (;;) {
        const rows = page.all(after, BACKFILL_BATCH) as { seq: number; doc: string }[];
        if (!rows.length) break;
        for (const row of rows) indexMailMessage(db, row.seq, JSON.parse(row.doc) as MailMessageDocument);
        after = rows[rows.length - 1]!.seq;
      }
    })();
  }
  db.exec(FORGET);
}
