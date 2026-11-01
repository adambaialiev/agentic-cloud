import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUICK_NOTE_SEARCH_MAX_TERMS,
  quickNoteMatchesSearch,
  quickNoteSearchSnippet,
  quickNoteSearchTerms,
  quickNoteSearchText,
  rankQuickNoteSearch,
} from '../../types/quick-note-search.js';
import type { QuickNoteDocument } from '../../types/quick-note.js';
import { newQuickNoteComment } from '../../services/quick-note-storage.js';
import {
  InMemoryQuickNoteStorage,
  type QuickNoteStorage,
} from '../../services/quick-note-storage.js';
import { SqliteQuickNoteStorage } from '../../services/sqlite/sqlite-quick-note-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';

/**
 * Searching notes (note #242).
 *
 * The contract block at the foot runs against BOTH stores, and that is the
 * point of this file: production searches an FTS5 index and every route test
 * in the suite searches a Map, so a guarantee asserted against one of them
 * alone is a guarantee about half of the product. What is asserted is what a
 * caller can see — which notes come back, and in what order — never how either
 * one found them.
 */

const HTML = (title: string, body: string) => `<h2>${title}</h2><p>${body}</p>`;

function doc(over: Partial<QuickNoteDocument> = {}): QuickNoteDocument {
  return {
    id: 'note-1',
    userId: 'u1',
    number: 1,
    html: HTML('Wifi', 'The code is on the router: 4417.'),
    createdByAgentId: 'a1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByAgentId: 'a1',
    ...over,
  };
}

describe('what a search is looking for', () => {
  it('reads a typed query as the words in it, punctuation and all dropped', () => {
    expect(quickNoteSearchTerms('  Wifi code! ')).toEqual(['wifi', 'code']);
    // The number is how every surface addresses a note, so typing it searches.
    expect(quickNoteSearchTerms('#246')).toEqual(['246']);
    // Nothing a user can type reaches the index as syntax.
    expect(quickNoteSearchTerms('"drop" OR NEAR(a b)')).toEqual(['drop', 'or', 'near', 'a', 'b']);
    expect(quickNoteSearchTerms('   ')).toEqual([]);
    // Repeats cost nothing, and one query cannot ask an index for the world.
    expect(quickNoteSearchTerms('note note')).toEqual(['note']);
    expect(quickNoteSearchTerms('a b c d e f g h i j k').length).toBe(QUICK_NOTE_SEARCH_MAX_TERMS);
  });

  it('folds case and accents, the way the index does', () => {
    expect(quickNoteSearchTerms('Café ЗАМЕТКА')).toEqual(['cafe', 'заметка']);
  });

  it('indexes the note’s words, its number, its margin and its files', () => {
    const text = quickNoteSearchText(doc({
      number: 12,
      comments: [newQuickNoteComment('a2', '<p>Fixed, it is in your chat.</p>', 'u1')],
      attachments: [{
        id: 'f1',
        fileName: 'IMG_4179.png',
        contentType: 'image/png',
        sizeBytes: 10,
        storagePath: 'p',
        addedByAgentId: 'a1',
        addedAt: '2026-08-01T00:00:00.000Z',
      }],
    }));
    expect(text.title).toBe('12 Wifi');
    expect(text.body).toContain('The code is on the router: 4417.');
    expect(text.body).toContain('Fixed, it is in your chat.');
    expect(text.body).toContain('IMG_4179.png');
    // Markup is not text a reader ever saw, so it is not text they can match.
    expect(text.body).not.toContain('<p>');
    expect(text.body).not.toContain('h2');
  });

  it('matches a term against the START of a word, every term required', () => {
    const note = doc();
    expect(quickNoteMatchesSearch(note, ['wif'])).toBe(true);
    expect(quickNoteMatchesSearch(note, ['wifi', 'router'])).toBe(true);
    expect(quickNoteMatchesSearch(note, ['wifi', 'plumber'])).toBe(false);
    // Not a substring search: half a word is not the word.
    expect(quickNoteMatchesSearch(note, ['outer'])).toBe(false);
    expect(quickNoteMatchesSearch(note, [])).toBe(false);
  });

  it('shows the part of the note the term is in, not its opening line', () => {
    const note = doc({
      html: HTML('Trip', `${'Nothing to do with it. '.repeat(6)}The plumber comes on Tuesday.`),
    });
    const snippet = quickNoteSearchSnippet(note, ['plumber']);
    expect(snippet).toContain('The plumber comes on Tuesday.');
    expect(snippet.startsWith('…')).toBe(true);
    // Matched by its title alone, there is nothing to quote: the row falls
    // back to the line every other list draws.
    expect(quickNoteSearchSnippet(note, ['trip'])).toBe(quickNoteSearchSnippet(note, ['zzz']));
  });
});

describe('the order results are read in', () => {
  const numbered = doc({ id: 'n246', number: 246, html: HTML('Workplaces', 'delete') });
  const titled = doc({ id: 'title', number: 5, html: HTML('Delete an agent', 'nothing else') });
  const bodied = doc({ id: 'body', number: 6, html: HTML('Something else', 'delete it later'), updatedAt: '2026-08-09T00:00:00.000Z' });
  const archived = doc({ id: 'old', number: 7, html: HTML('Delete the old app', 'x'), archivedAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' });

  it('puts the note named by number first, then title matches, then the rest', () => {
    const ranked = rankQuickNoteSearch([bodied, archived, titled, numbered], ['246'], 10);
    expect(ranked[0]!.id).toBe('n246');
  });

  it('ranks a title match over a body match, and a live note over an archived one', () => {
    const ranked = rankQuickNoteSearch([bodied, archived, titled], ['delete'], 10);
    expect(ranked.map((note) => note.id)).toEqual(['title', 'old', 'body']);
  });

  it('cuts to the limit it is given', () => {
    expect(rankQuickNoteSearch([bodied, titled, archived], ['delete'], 2)).toHaveLength(2);
  });
});

/**
 * One contract, both stores. Everything asserted here is something a person
 * using the Workspace would notice.
 */
describe.each([
  ['InMemoryQuickNoteStorage', null],
  ['SqliteQuickNoteStorage', 'sqlite'],
] as const)('searching notes in %s', (_name, kind) => {
  let dir: string | undefined;
  let db: SqliteDb | undefined;
  let notes: QuickNoteStorage;

  beforeEach(() => {
    if (kind === 'sqlite') {
      dir = mkdtempSync(join(tmpdir(), 'note-search-'));
      db = openSqliteDb(join(dir, 'test.db'));
      notes = new SqliteQuickNoteStorage(db);
    } else {
      notes = new InMemoryQuickNoteStorage();
    }
  });

  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    db = undefined;
  });

  const write = (userId: string, html: string) => notes.create({
    userId,
    html,
    createdByAgentId: 'a1',
    updatedByAgentId: 'a1',
  });

  const search = async (query: string) => (
    await notes.search('u1', quickNoteSearchTerms(query), 50)
  ).map((note) => note.number);

  it('finds a note by a word inside it, and by the start of one', async () => {
    const wifi = await write('u1', HTML('Wifi', 'The code is on the router: 4417.'));
    await write('u1', HTML('Plumber', 'Call back on Tuesday.'));
    expect(await search('router')).toEqual([wifi.number]);
    expect(await search('rout')).toEqual([wifi.number]);
    expect(await search('4417')).toEqual([wifi.number]);
    expect(await search('Wifi CODE')).toEqual([wifi.number]);
  });

  it('needs every word, so two terms narrow rather than widen', async () => {
    const wifi = await write('u1', HTML('Wifi', 'The code is on the router.'));
    await write('u1', HTML('Door code', 'Ask the neighbour.'));
    expect(await search('code')).toHaveLength(2);
    expect(await search('code router')).toEqual([wifi.number]);
  });

  it('searches the archive too — a put-away note is still a note', async () => {
    const put = await write('u1', HTML('Old wifi', 'The code was 1111.'));
    await notes.update(put.id, { archivedAt: '2026-08-20T00:00:00.000Z', archivedByAgentId: 'a1' });
    expect(await search('wifi')).toEqual([put.number]);
  });

  it('never reaches into another room', async () => {
    await write('u2', HTML('Wifi', 'Another room entirely.'));
    expect(await search('wifi')).toEqual([]);
  });

  it('finds a note by its number, and puts it first', async () => {
    const first = await write('u1', HTML('One', 'nothing'));
    const second = await write('u1', HTML('Two', `see note ${first.number}`));
    expect((await search(`#${first.number}`))[0]).toBe(first.number);
    expect(await search(`#${first.number}`)).toContain(second.number);
  });

  it('finds a note by what was SAID about it', async () => {
    const note = await write('u1', HTML('Workplaces', 'nothing to see'));
    expect(await search('plumber')).toEqual([]);
    await notes.addComment(note.id, newQuickNoteComment('a2', '<p>Asked the plumber.</p>', 'u1'));
    expect(await search('plumber')).toEqual([note.number]);
  });

  it('follows an edit — the old words stop matching, the new ones start', async () => {
    const note = await write('u1', HTML('Wifi', 'The code is 4417.'));
    await notes.update(note.id, { html: HTML('Wifi', 'The code is 9000.') });
    expect(await search('4417')).toEqual([]);
    expect(await search('9000')).toEqual([note.number]);
  });

  it('forgets a deleted note', async () => {
    const note = await write('u1', HTML('Wifi', 'The code is 4417.'));
    await notes.delete(note.id);
    expect(await search('wifi')).toEqual([]);
  });

  it('ranks a title match above a body-only one', async () => {
    const body = await write('u1', HTML('Shopping', 'ask about the keyboard cable'));
    const title = await write('u1', HTML('Keyboard', 'the top bar'));
    expect(await search('keyboard')).toEqual([title.number, body.number]);
  });

  it('answers an empty query with nothing rather than everything', async () => {
    await write('u1', HTML('Wifi', 'The code is 4417.'));
    expect(await notes.search('u1', [], 50)).toEqual([]);
  });

  it('matches across case and accents', async () => {
    const note = await write('u1', HTML('Café', 'Клавиатура без верхней панели'));
    expect(await search('cafe')).toEqual([note.number]);
    expect(await search('КЛАВ')).toEqual([note.number]);
  });
});

describe('the SQLite index keeps up with the notes', () => {
  let dir: string;
  let path: string;
  let db: SqliteDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note-index-'));
    path = join(dir, 'test.db');
    db = openSqliteDb(path);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const terms = quickNoteSearchTerms('wifi');

  it('indexes the notes an older database already had', async () => {
    const before = new SqliteQuickNoteStorage(db);
    const note = await before.create({
      userId: 'u1', html: HTML('Wifi', 'The code is 4417.'), createdByAgentId: 'a1', updatedByAgentId: 'a1',
    });
    // Exactly the state a database written before this index existed is in.
    db.prepare('DELETE FROM quick_note_search').run();
    expect(await before.search('u1', terms, 10)).toEqual([]);

    const after = new SqliteQuickNoteStorage(db);
    expect((await after.search('u1', terms, 10)).map((doc) => doc.id)).toEqual([note.id]);
  });

  it('rebuilds a row whose note it no longer describes', async () => {
    const storage = new SqliteQuickNoteStorage(db);
    const note = await storage.create({
      userId: 'u1', html: HTML('Wifi', 'The code is 4417.'), createdByAgentId: 'a1', updatedByAgentId: 'a1',
    });
    // What a VACUUM can do to a table keyed by anything but an INTEGER
    // primary key: the rowids move and the index points at the wrong note.
    db.prepare('UPDATE quick_note_search SET note_id = ?').run('somebody-elses-note');
    expect(await storage.search('u1', terms, 10)).toEqual([]);

    const repaired = new SqliteQuickNoteStorage(db);
    expect((await repaired.search('u1', terms, 10)).map((doc) => doc.id)).toEqual([note.id]);
  });

  it('drops index rows left behind by a note that is gone', async () => {
    const storage = new SqliteQuickNoteStorage(db);
    const note = await storage.create({
      userId: 'u1', html: HTML('Wifi', 'The code is 4417.'), createdByAgentId: 'a1', updatedByAgentId: 'a1',
    });
    // A delete that lost its second statement to a restart.
    db.prepare('DELETE FROM quick_notes WHERE note_id = ?').run(note.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM quick_note_search').get()).toEqual({ n: 1 });

    new SqliteQuickNoteStorage(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM quick_note_search').get()).toEqual({ n: 0 });
  });
});
