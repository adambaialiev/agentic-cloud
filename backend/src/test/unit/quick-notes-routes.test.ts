import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { MemoryMediaStorage } from '../../services/memory-media-storage.js';
import { UPLOAD_PART_BYTES } from '../../shared/uploads.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import {
  QUICK_NOTE_AUTHOR_USER,
  QUICK_NOTES_MAX_PER_USER,
  QUICK_NOTE_MAX_LENGTH,
  normalizeQuickNote,
  quickNoteEditableText,
  quickNoteCommentPreview,
  quickNotePreview,
  quickNoteTitle,
} from '../../types/quick-note.js';
import { textToSafeHtml } from '../../types/safe-html.js';

/**
 * Quick notes (docs/agent-quick-notes.md): the one store an agent writes
 * DIRECTLY, so the tests that matter most are the ones about what "directly"
 * costs — a wrong number never silently hits another note, an edit replaces
 * exactly what it says it does, and a delete needs no approval but also
 * touches nothing but the note it names.
 *
 * A note is HTML since 2026-08-16, by the same rules a knowledge page follows,
 * so the other thing asserted here is that the format holds at the DOOR: what
 * a note may contain is refused on the way in, with the rule named.
 */

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body: unknown;
}

function createMockResponse(): MockResponse {
  const response: MockResponse = { statusCode: 200, body: undefined };
  response.status = ((code: number) => { response.statusCode = code; return response as Response; }) as Response['status'];
  response.json = ((payload: unknown) => { response.body = payload; return response as Response; }) as Response['json'];
  return response;
}

type Handler = (req: Partial<Request>, res: MockResponse) => Promise<unknown>;
type Method = 'get' | 'post' | 'put' | 'delete';

function routeHandler(deps: Partial<RouteDeps>, path: string, method: Method): Handler {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: Handler }>;
    } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === path && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

function mockRequest(args: {
  token: string;
  params?: Record<string, string>;
  body?: unknown;
  /** `?forever=1`, `?archived=1` — the two switches the note routes read. */
  query?: Record<string, string>;
}): Partial<Request> {
  return {
    get: ((name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${args.token}` : undefined)) as Request['get'],
    params: args.params ?? {},
    query: args.query ?? {},
    body: args.body,
  };
}

async function buildDeps() {
  const userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('user-1', { email: 'u@example.com', displayName: 'U' });
  const first = mintAgentbuiltToken('user-1', 'agent-a');
  const second = mintAgentbuiltToken('user-1', 'agent-b');
  await userStorage.updateProfile('user-1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        'agent-a': { id: 'agent-a', name: 'Ben', cli: 'claude', agentbuiltTokenHash: first.tokenHash } as never,
        'agent-b': { id: 'agent-b', name: 'Ada', cli: 'claude', agentbuiltTokenHash: second.tokenHash } as never,
      },
    },
  });
  const quickNoteStorage = new InMemoryQuickNoteStorage();
  return {
    deps: { userStorage, quickNoteStorage } satisfies Partial<RouteDeps>,
    token: first.token,
    otherToken: second.token,
    notes: quickNoteStorage,
    userStorage,
  };
}

async function add(deps: Partial<RouteDeps>, token: string, html: string): Promise<MockResponse> {
  const res = createMockResponse();
  await routeHandler(deps, '/notes', 'post')(mockRequest({ token, body: { html } }), res);
  return res;
}

async function listNotes(deps: Partial<RouteDeps>, token: string) {
  const res = createMockResponse();
  await routeHandler(deps, '/notes', 'get')(mockRequest({ token }), res);
  return (res.body as { notes: Array<{ number: number; title: string; preview: string }> }).notes;
}

/** Put one away. The verb everything destructive now goes through first. */
async function archive(deps: Partial<RouteDeps>, token: string, number: string): Promise<MockResponse> {
  const res = createMockResponse();
  await routeHandler(deps, '/notes/:number/archive', 'post')(mockRequest({ token, params: { number } }), res);
  return res;
}

describe('quick notes: the agent surface', () => {
  it('lists nothing on an account that has never written one', async () => {
    const { deps, token } = await buildDeps();
    expect(await listNotes(deps, token)).toEqual([]);
  });

  it('writes a note immediately — no proposal, no approval', async () => {
    const { deps, token, notes } = await buildDeps();
    const res = await add(deps, token, '<h2>Wifi code</h2><p>It is on the router: 4417.</p>');

    expect(res.statusCode).toBe(200);
    const note = (res.body as { note: { number: number; title: string; html: string } }).note;
    expect(note.number).toBe(1);
    expect(note.title).toBe('Wifi code');
    // The whole difference from a knowledge page: it is readable RIGHT NOW.
    const stored = await notes.getByNumber('user-1', 1);
    expect(stored?.html).toBe('<h2>Wifi code</h2><p>It is on the router: 4417.</p>');
    expect(stored?.createdByAgentId).toBe('agent-a');
  });

  it('titles a note by its heading and previews the rest', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<h2>Shopping</h2><ul><li>milk</li><li>eggs</li></ul>');
    const [row] = await listNotes(deps, token);
    expect(row!.title).toBe('Shopping');
    expect(row!.preview).toBe('milk eggs');
  });

  it('titles a note with no heading by its first block', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<p>Where the invoices go</p><p>Dropbox, Admin, 2026.</p>');
    const [row] = await listNotes(deps, token);
    expect(row!.title).toBe('Where the invoices go');
    expect(row!.preview).toBe('Dropbox, Admin, 2026.');
  });

  it('takes bare prose — the quickest note there is', async () => {
    const { deps, token } = await buildDeps();
    // No tags at all is valid HTML and must stay a perfectly good note: the
    // format changed, the one-argument jotting did not.
    const res = await add(deps, token, 'Call the plumber back on Tuesday');
    expect(res.statusCode).toBe(200);
    const [row] = await listNotes(deps, token);
    expect(row!.title).toBe('Call the plumber back on Tuesday');
    expect(row!.preview).toBe('');
  });

  it('reads one note whole, by number', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<p>First</p>');
    await add(deps, token, '<h3>Second</h3><p>with a body</p>');
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token, params: { number: '2' } }), res);
    expect((res.body as { note: { html: string } }).note.html).toBe('<h3>Second</h3><p>with a body</p>');
  });

  it('refuses script, styling and everything else a note may not carry', async () => {
    const { deps, token, notes } = await buildDeps();
    for (const [html, pattern] of [
      ['<p>hi</p><script>steal()</script>', /JavaScript/i],
      ['<p onclick="steal()">hi</p>', /event handler/i],
      ['<style>p{color:red}</style>', /CSS/i],
      ['<p style="color:red">hi</p>', /dark mode/i],
      ['<iframe src="https://evil.test"></iframe>', /embed/i],
      ['<a href="javascript:steal()">x</a>', /https/i],
    ] as Array<[string, RegExp]>) {
      const res = await add(deps, token, html);
      expect(res.statusCode, html).toBe(400);
      // The refusal names the rule, and says NOTE — an agent told about
      // "knowledge pages" while writing a note learns the wrong lesson.
      const error = String((res.body as { error: string }).error);
      expect(error, html).toMatch(pattern);
      expect(error, html).not.toMatch(/knowledge page/i);
    }
    // Nothing landed: this is a door, not a sanitiser.
    expect(await notes.countByUser('user-1')).toBe(0);
  });

  it('takes the markup a note is actually written in', async () => {
    const { deps, token } = await buildDeps();
    const res = await add(deps, token,
      '<h2>Deploy</h2><ul><li>push</li></ul><table><tr><th>a</th><td>b</td></tr></table>'
      + '<p>See <a href="https://example.com">the runbook</a>.</p>');
    expect(res.statusCode).toBe(200);
  });

  it('lists the most recently changed note first', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, 'Older');
    await add(deps, token, 'Newer');
    // Backdate the second so ordering cannot ride on insertion order alone.
    const newer = await notes.getByNumber('user-1', 2);
    await notes.update(newer!.id, { updatedAt: '2000-01-01T00:00:00.000Z' });
    expect((await listNotes(deps, token)).map((n) => n.number)).toEqual([1, 2]);
  });

  it('lets another agent of the same human replace a note whole, and records who did it', async () => {
    const { deps, token, otherToken, notes } = await buildDeps();
    await add(deps, token, '<h2>Shopping</h2><ul><li>milk</li></ul>');
    const res = createMockResponse();
    // A SECOND agent of the same human edits it. Authorship belongs to that
    // human even though the workplace namespace is shared.
    await routeHandler(deps, '/notes/:number', 'put')(
      mockRequest({
        token: otherToken,
        params: { number: '1' },
        body: { html: '<h2>Shopping</h2><ul><li>milk</li><li>eggs</li></ul>' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const stored = await notes.getByNumber('user-1', 1);
    expect(stored?.html).toBe('<h2>Shopping</h2><ul><li>milk</li><li>eggs</li></ul>');
    expect(stored?.createdByAgentId).toBe('agent-a');
    expect(stored?.createdByUserId).toBe('user-1');
    expect(stored?.updatedByAgentId).toBe('agent-b');
    expect(stored?.updatedByUserId).toBe('user-1');
    // The number is the address and must survive an edit — the user read it
    // yesterday and the Workspace is still linking to it.
    expect(stored?.number).toBe(1);
  });

  it('does not let an agent rewrite a human-authored note', async () => {
    const { deps, token, notes } = await buildDeps();
    await notes.create({
      userId: 'user-1',
      html: '<p>The user\'s own words</p>',
      createdByAgentId: QUICK_NOTE_AUTHOR_USER,
      createdByUserId: 'user-1',
      updatedByAgentId: QUICK_NOTE_AUTHOR_USER,
      updatedByUserId: 'user-1',
    });

    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'put')(
      mockRequest({ token, params: { number: '1' }, body: { html: '<p>Agent rewrite</p>' } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error: string }).error)).toContain('leave a comment');
    expect((await notes.getByNumber('user-1', 1))?.html).toBe('<p>The user\'s own words</p>');
  });

  it('does not let one member’s agent rewrite another member’s agent note', async () => {
    const { deps, token, notes, userStorage } = await buildDeps();
    const memberToken = mintAgentbuiltToken('member-2', 'agent-c');
    await userStorage.createProfile('member-2', { email: 'm@example.com', displayName: 'M' });

    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'member-2', role: 'member' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');

    await userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await userStorage.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    await userStorage.updateProfile('member-2', {
      telegram: {
        chatId: '2', linkedAt: 't', notificationsEnabled: true,
        agents: {
          'agent-c': {
            id: 'agent-c', name: 'Ruby', cli: 'claude', orgId: org.orgId,
            agentbuiltTokenHash: memberToken.tokenHash,
          } as never,
        },
      },
    });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;

    expect((await add(deps, memberToken.token, '<p>Member two wrote this</p>')).statusCode).toBe(200);
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'put')(
      mockRequest({ token, params: { number: '1' }, body: { html: '<p>Member one rewrite</p>' } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error: string }).error)).toContain('Another workplace member');
    const stored = await notes.getByNumber('user-1', 1);
    expect(stored?.html).toBe('<p>Member two wrote this</p>');
    expect(stored?.updatedByUserId).toBe('member-2');
  });

  /**
   * Note #741: a note number is one series for the whole workplace, and an
   * agent finds a note by its number wherever in the workplace it stands.
   * Numbers issued per room before that were kept, and the old rooms'
   * namespaces stay the workplace's as history (note #843, #923): a number
   * held there once is found, the workplace's own copy wins a clash, and
   * only a number held twice with neither copy at the workplace is refused —
   * nothing names which was meant, so the agent is told to ask its user.
   */
  it('finds a note by number across the workplace and its old rooms’ namespaces, and asks about a legacy number held twice (note #741)', async () => {
    const { deps, token, otherToken, notes, userStorage } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // Two old rooms' namespaces, kept on the workplace when rooms went.
    await orgStorage.updateOrg(org.orgId, {
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-growth', 'ns-ops'] },
    });
    await userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await userStorage.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    // Before the series, numbered room by room: #1 at the workplace, #1–#2
    // in Growth, #1–#3 in Ops.
    const jot = (userId: string, html: string) => notes.create({ userId, html, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' });
    await jot('user-1', '<p>Workplace one</p>');
    await jot('ns-growth', '<p>Growth one</p>');
    await jot('ns-growth', '<p>Growth two</p>');
    await jot('ns-ops', '<p>Ops one</p>');
    await jot('ns-ops', '<p>Ops two</p>');
    await jot('ns-ops', '<p>Ops three</p>');

    // Ben writes: the next WORKPLACE number, above every number held.
    const added = await add(deps, token, '<p>Workplace-numbered</p>');
    expect(added.statusCode).toBe(200);
    expect((added.body as { note: { number: number } }).note.number).toBe(4);
    expect((await notes.getByNumber('user-1', 4))?.html).toBe('<p>Workplace-numbered</p>');

    const show = async (who: string, number: string) => {
      const res = createMockResponse();
      await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token: who, params: { number } }), res);
      return res;
    };
    // Ada reads #4: the link names the number and the workplace, and no room.
    const fromAda = await show(otherToken, '4');
    expect(fromAda.statusCode).toBe(200);
    expect((fromAda.body as { note: { title: string } }).note.title).toBe('Workplace-numbered');
    expect((fromAda.body as { note: { href: string } }).note.href).toMatch(/^\/notes\/4\?org=[^&]+$/);
    // A number held once, in an old room's namespace, is found there.
    expect((await show(otherToken, '3')).body).toMatchObject({ note: { title: 'Ops three' } });
    // #1 is held three times: the workplace's own copy wins.
    expect((await show(token, '1')).body).toMatchObject({ note: { title: 'Workplace one' } });
    // #2 is held twice, neither at the workplace: refused, the user asked.
    const shared = await show(otherToken, '2');
    expect(shared.statusCode).toBe(409);
    expect(String((shared.body as { error: string }).error)).toContain('held twice');
    expect(String((shared.body as { error: string }).error)).toContain('Ask your user');
    expect((await show(otherToken, '7')).statusCode).toBe(404);
  });

  /**
   * The stage-1 merge (note #843) moved every old room's notes onto the
   * workplace's namespace. A database that skipped that release still runs
   * it from what is left of its rooms (legacy-rooms.ts, note #923), and the
   * agent surface must then read one set of notes in which a number names
   * one note.
   */
  it('after the room merge, every agent lists the ONE set of notes and a number names one note (note #843)', async () => {
    const { deps, token, otherToken, notes, userStorage } = await buildDeps();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // As production stood on 30 Oct: rooms not merged, Platform's notes at
    // the workplace's own namespace, Growth's beside them, numbers clashing
    // from before the workplace series.
    await orgStorage.updateOrg(org.orgId, { roomsMerged: undefined });
    const { InMemoryLegacyRooms } = await import('../../services/legacy-rooms.js');
    const legacyRooms = new InMemoryLegacyRooms([
      { roomId: 'room-platform', orgId: org.orgId, name: 'Platform', namespaceId: 'ns-platform' },
      { roomId: 'room-growth', orgId: org.orgId, name: 'Growth', namespaceId: 'ns-growth' },
    ]);
    await userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await userStorage.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    const jot = (userId: string, html: string) => notes.create({ userId, html, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' });
    await jot('user-1', '<p>Platform one</p>');
    await jot('ns-growth', '<p>Growth one</p>');
    const growthTwo = await jot('ns-growth', '<p>Growth two</p>');
    await notes.update(growthTwo.id, { archivedAt: '2026-10-29T10:00:00.000Z' });

    const { backfillRoomMerge } = await import('../../services/room-merge-backfill.js');
    const merged = await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes, now: () => new Date('2026-10-30T15:00:00.000Z') });
    expect(merged).toMatchObject({ workplaces: 1, moved: 2, deferred: [] });
    // Growth's #1 clashed with Platform's and took the next number; its #2
    // (archived) kept its own.
    expect(merged.renumbered).toEqual([{ orgId: org.orgId, roomId: 'room-growth', from: 1, to: 3 }]);
    expect((await orgStorage.getOrg(org.orgId))?.roomsMerged).toEqual({
      mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-platform', 'ns-growth'],
    });

    // Both agents now list the same notes…
    const titles = async (who: string) => (await listNotes(deps, who)).map((note) => note.title).sort();
    expect(await titles(token)).toEqual(['Growth one', 'Platform one']);
    expect(await titles(otherToken)).toEqual(['Growth one', 'Platform one']);
    // …a number names one note for either of them, the archived one too…
    const show = async (who: string, number: string) => {
      const res = createMockResponse();
      await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token: who, params: { number } }), res);
      return res;
    };
    expect((await show(otherToken, '1')).body).toMatchObject({ note: { title: 'Platform one' } });
    expect((await show(token, '3')).body).toMatchObject({ note: { title: 'Growth one' } });
    expect((await show(token, '2')).body).toMatchObject({ note: { title: 'Growth two' } });
    // …and a new note lands with the workplace's, above every number.
    const added = await add(deps, otherToken, '<p>Written after</p>');
    expect((added.body as { note: { number: number } }).note.number).toBe(4);
    expect((await notes.getByNumber('user-1', 4))?.html).toBe('<p>Written after</p>');

    // A second boot finds nothing left to move and changes nothing.
    expect(await backfillRoomMerge({ orgStorage, legacyRooms, quickNoteStorage: notes })).toMatchObject({ workplaces: 0, moved: 0, swept: 0, deferred: [] });
  });

  it('refuses an empty note rather than blanking one', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<p>Keep me</p>');
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'put')(
      mockRequest({ token, params: { number: '1' }, body: { html: '   ' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((await notes.getByNumber('user-1', 1))?.html).toBe('<p>Keep me</p>');
  });

  /**
   * CLI 1.8.0 sends `{ text }` and is still on every machine whose agent has
   * not started a turn since notes became HTML. It has to keep working, and
   * what it sends is plain text — escaped, not interpreted.
   */
  it('accepts a pre-HTML CLI, converting what it sends', async () => {
    const { deps, token, notes } = await buildDeps();
    const res = createMockResponse();
    await routeHandler(deps, '/notes', 'post')(
      mockRequest({ token, body: { text: 'Shopping\nmilk & <eggs>' } }), res,
    );
    expect(res.statusCode).toBe(200);
    const stored = await notes.getByNumber('user-1', 1);
    expect(stored?.html).toBe('<p>Shopping<br>milk &amp; &lt;eggs&gt;</p>');
    expect((res.body as { note: { title: string } }).note.title).toBe('Shopping milk & <eggs>');
  });

  it('takes a whole plan: a note right at the ceiling is saved (note #676)', async () => {
    const { deps, token, notes } = await buildDeps();
    // 100,000 characters of real markup, not 'x' — the size a written-out
    // plan reaches, which is why the ceiling moved from 8000.
    const para = `<p>${'plan '.repeat(199)}</p>`;
    let html = '<h2>Game plan</h2>';
    while (html.length + para.length <= QUICK_NOTE_MAX_LENGTH) html += para;
    expect(html.length).toBeGreaterThan(99_000);
    const res = await add(deps, token, html);
    expect(res.statusCode).toBe(200);
    expect((await notes.getByNumber('user-1', 1))?.html.length).toBe(html.length);
  });

  it('refuses a note longer than a note, and points at knowledge pages', async () => {
    const { deps, token } = await buildDeps();
    const res = await add(deps, token, 'x'.repeat(QUICK_NOTE_MAX_LENGTH + 1));
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain('knowledge page');
  });

  it('deletes only the note it names, and never reissues its number', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<p>One</p>');
    await add(deps, token, '<p>Two</p>');
    await archive(deps, token, '1');
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'delete')(
      mockRequest({ token, params: { number: '1' }, query: { forever: '1' } }), res,
    );
    expect(res.statusCode).toBe(200);
    // The title comes back so an agent that deleted the wrong number finds
    // out while it still remembers what the note said.
    expect((res.body as { title: string }).title).toBe('One');
    expect(await notes.getByNumber('user-1', 1)).toBeNull();
    expect((await notes.getByNumber('user-1', 2))?.html).toBe('<p>Two</p>');

    // #3, not #1 again: a number the user read yesterday must not come back
    // meaning something else today.
    const next = await add(deps, token, '<p>Three</p>');
    expect((next.body as { note: { number: number } }).note.number).toBe(3);
  });

  /**
   * The case the test above misses by construction, and the one that was
   * actually broken: deleting the NEWEST note. With `MAX(number) + 1` the
   * survivors are all lower, so the counter walks backwards and the next note
   * written takes the dead one's number.
   */
  it('does not reissue the number of the newest note when that is the one deleted', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<p>One</p>');
    await add(deps, token, '<p>Two</p>');
    await archive(deps, token, '2');
    const gone = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'delete')(
      mockRequest({ token, params: { number: '2' }, query: { forever: '1' } }), gone,
    );

    const next = await add(deps, token, '<p>Three</p>');
    expect((next.body as { note: { number: number } }).note.number).toBe(3);
  });

  /**
   * The same trap one step earlier, and the one the archive introduces: an
   * ARCHIVED note is out of `listByUser`, so a counter seeded from the live
   * list alone hands its number to the next note written — while the note
   * itself is still sitting in the archive under it, one restore away from
   * two notes claiming "#2".
   */
  it('does not reissue the number of a note that is merely archived', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<p>One</p>');
    await add(deps, token, '<p>Two</p>');
    await archive(deps, token, '2');

    const next = await add(deps, token, '<p>Three</p>');
    expect((next.body as { note: { number: number } }).note.number).toBe(3);
    expect((await notes.getByNumber('user-1', 2))?.html).toBe('<p>Two</p>');
  });

  it('keeps numbering above the notes it already has, even from a cold counter', async () => {
    // The self-healing seed: a store whose counter row is missing (or has
    // never existed) must start above the notes that are already there, not
    // collide with them.
    const notes = new InMemoryQuickNoteStorage();
    const first = await notes.create({
      userId: 'user-1', html: '<p>One</p>', createdByAgentId: 'a', updatedByAgentId: 'a',
    });
    expect(first.number).toBe(1);
    const second = await notes.create({
      userId: 'user-1', html: '<p>Two</p>', createdByAgentId: 'a', updatedByAgentId: 'a',
    });
    expect(second.number).toBe(2);
    // Another account numbers from its own 1 — the counter is per user.
    const other = await notes.create({
      userId: 'user-2', html: '<p>Theirs</p>', createdByAgentId: 'a', updatedByAgentId: 'a',
    });
    expect(other.number).toBe(1);
  });

  it('404s a number this account does not have, and 400s one that is not a number', async () => {
    const { deps, token } = await buildDeps();
    const missing = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token, params: { number: '7' } }), missing);
    expect(missing.statusCode).toBe(404);

    const nonsense = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'delete')(mockRequest({ token, params: { number: 'shopping' } }), nonsense);
    expect(nonsense.statusCode).toBe(400);
  });

  it('never reaches another account\'s notes', async () => {
    const { deps, token, notes } = await buildDeps();
    await notes.create({
      userId: 'someone-else',
      html: '<p>Their note</p>',
      createdByAgentId: 'agent-z',
      updatedByAgentId: 'agent-z',
    });
    expect(await listNotes(deps, token)).toEqual([]);
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token, params: { number: '1' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('caps how many notes one account can hold', async () => {
    const { deps, token } = await buildDeps();
    for (let i = 0; i < QUICK_NOTES_MAX_PER_USER; i += 1) {
      expect((await add(deps, token, `<p>Note ${i}</p>`)).statusCode).toBe(200);
    }
    const over = await add(deps, token, '<p>One too many</p>');
    expect(over.statusCode).toBe(400);
    // Pointed at ARCHIVE, not at delete: the way to make room costs nothing,
    // and a refusal that recommends destroying something is bad advice.
    expect(String((over.body as { error: string }).error)).toContain('note archive');

    // And archiving one really is the way through — the ceiling counts the
    // desk, so a note put away leaves room for the next.
    expect((await archive(deps, token, '1')).statusCode).toBe(200);
    expect((await add(deps, token, '<p>Room now</p>')).statusCode).toBe(200);
  });

  /**
   * The archive, agent-side (Owner, note #23: "Notes should not be delete. It
   * should be archived. And only from archive a note can be deleted.").
   */
  describe('archiving, and the delete behind it', () => {
    const del = async (
      deps: Partial<RouteDeps>, token: string, number: string, forever = false,
    ) => {
      const res = createMockResponse();
      await routeHandler(deps, '/notes/:number', 'delete')(
        mockRequest({ token, params: { number }, ...(forever ? { query: { forever: '1' } } : {}) }), res,
      );
      return res;
    };
    const listArchived = async (deps: Partial<RouteDeps>, token: string) => {
      const res = createMockResponse();
      await routeHandler(deps, '/notes', 'get')(mockRequest({ token, query: { archived: '1' } }), res);
      return (res.body as { notes: Array<{ number: number; archivedAt?: string }> }).notes;
    };

    it('takes a note out of the list without losing anything of it', async () => {
      const { deps, token, notes } = await buildDeps();
      await add(deps, token, '<h2>Shopping</h2><p>milk</p>');
      await add(deps, token, '<p>Bin day</p>');

      const res = await archive(deps, token, '1');
      expect(res.statusCode).toBe(200);
      // The message says it is not gone — an agent reads this back to its user.
      expect(String((res.body as { message: string }).message)).toContain('not gone');
      expect((await listNotes(deps, token)).map((n) => n.number)).toEqual([2]);
      const archived = await notes.getByNumber('user-1', 1);
      expect(archived?.html).toBe('<h2>Shopping</h2><p>milk</p>');
      expect(archived?.archivedByAgentId).toBe('agent-a');
    });

    it('says on the live list how many are put away, and lists them apart', async () => {
      const { deps, token } = await buildDeps();
      await add(deps, token, '<p>One</p>');
      await add(deps, token, '<p>Two</p>');
      await archive(deps, token, '1');

      const res = createMockResponse();
      await routeHandler(deps, '/notes', 'get')(mockRequest({ token }), res);
      const body = res.body as { notes: Array<{ number: number }>; archived: number };
      // The count is the only thing pointing at the archive at all — another
      // agent may have put a note away and nothing announces it.
      expect(body.archived).toBe(1);
      expect(body.notes.map((n) => n.number)).toEqual([2]);
      expect((await listArchived(deps, token)).map((n) => n.number)).toEqual([1]);
      // A row from the archive says what it is, so a note opened off a stale
      // list still knows which side of the line it is on.
      expect((await listArchived(deps, token))[0]!.archivedAt).toBeTruthy();
    });

    it('brings one back under the number it never stopped holding', async () => {
      const { deps, token, notes } = await buildDeps();
      await add(deps, token, '<p>One</p>');
      await archive(deps, token, '1');

      const res = createMockResponse();
      await routeHandler(deps, '/notes/:number/archive', 'delete')(
        mockRequest({ token, params: { number: '1' } }), res,
      );
      expect(res.statusCode).toBe(200);
      expect((await notes.getByNumber('user-1', 1))?.archivedAt).toBeUndefined();
      expect((await listNotes(deps, token)).map((n) => n.number)).toEqual([1]);
      expect(await listArchived(deps, token)).toEqual([]);
    });

    it('is not an error to archive what is already archived, or restore what is not', async () => {
      const { deps, token } = await buildDeps();
      await add(deps, token, '<p>One</p>');
      await archive(deps, token, '1');
      // Two agents tidying up at once must not have one of them fail at a job
      // that is already done.
      expect((await archive(deps, token, '1')).statusCode).toBe(200);

      const restore = routeHandler(deps, '/notes/:number/archive', 'delete');
      const first = createMockResponse();
      await restore(mockRequest({ token, params: { number: '1' } }), first);
      const again = createMockResponse();
      await restore(mockRequest({ token, params: { number: '1' } }), again);
      expect(again.statusCode).toBe(200);
    });

    /** The compatibility path: every CLI already on every machine sends this,
     *  and those agents cannot know the rule changed until their identity
     *  block is rewritten under them. It archives, and says so. */
    it('archives on a plain DELETE rather than deleting, and does not claim otherwise', async () => {
      const { deps, token, notes } = await buildDeps();
      const created = await add(deps, token, '<h2>Shopping</h2>');
      const id = (created.body as { note: { id: string } }).note.id;

      const res = await del(deps, token, '1');
      expect(res.statusCode).toBe(200);
      expect((res.body as { archived: boolean }).archived).toBe(true);
      const message = String((res.body as { message: string }).message);
      expect(message).toContain('Archived note #1');
      expect(message).not.toContain('Deleted');
      expect(await notes.get(id)).not.toBeNull();
    });

    it('refuses --forever on a note that has not been archived', async () => {
      const { deps, token, notes } = await buildDeps();
      const created = await add(deps, token, '<p>One</p>');
      const id = (created.body as { note: { id: string } }).note.id;

      const res = await del(deps, token, '1', true);
      expect(res.statusCode).toBe(400);
      expect(String((res.body as { error: string }).error)).toContain('note archive 1');
      expect(await notes.get(id)).not.toBeNull();
    });

    it('deletes for good once it is archived, and only then', async () => {
      const { deps, token, notes } = await buildDeps();
      const created = await add(deps, token, '<p>One</p>');
      const id = (created.body as { note: { id: string } }).note.id;
      await archive(deps, token, '1');

      const res = await del(deps, token, '1', true);
      expect(res.statusCode).toBe(200);
      expect(String((res.body as { message: string }).message)).toContain('for good');
      expect(await notes.get(id)).toBeNull();
    });

    /** A second `note rm` must not be a delete: the two-step rule is about the
     *  STATE a note is in, not about how many times the word was typed. */
    it('does not delete an archived note on a plain DELETE', async () => {
      const { deps, token, notes } = await buildDeps();
      const created = await add(deps, token, '<p>One</p>');
      const id = (created.body as { note: { id: string } }).note.id;
      await del(deps, token, '1');

      const second = await del(deps, token, '1');
      expect(second.statusCode).toBe(200);
      expect(await notes.get(id)).not.toBeNull();
      // And it says how to actually finish the job, for the agent that meant to.
      expect(String((second.body as { message: string }).message)).toContain('--forever');
    });

    it('leaves an archived note read-only, and names the way back', async () => {
      const { deps, token, notes } = await buildDeps();
      const created = await add(deps, token, '<p>One</p>');
      const id = (created.body as { note: { id: string } }).note.id;
      await archive(deps, token, '1');

      const edited = createMockResponse();
      await routeHandler(deps, '/notes/:number', 'put')(
        mockRequest({ token, params: { number: '1' }, body: { html: '<p>Rewritten</p>' } }), edited,
      );
      expect(edited.statusCode).toBe(400);
      expect(String((edited.body as { error: string }).error)).toContain('note unarchive 1');

      const commented = createMockResponse();
      await routeHandler(deps, '/notes/:number/comments', 'post')(
        mockRequest({ token, params: { number: '1' }, body: { text: 'still true?' } }), commented,
      );
      expect(commented.statusCode).toBe(400);

      const doc = await notes.get(id);
      expect(doc?.html).toBe('<p>One</p>');
      expect(doc?.comments ?? []).toEqual([]);
    });

    it('archives beyond the former 100-note ceiling through both agent verbs', async () => {
      const { deps, token, notes } = await buildDeps();
      await add(deps, token, '<p>Explicit archive</p>');
      await add(deps, token, '<p>Compatibility rm</p>');
      // Fill the archive directly: a hundred round trips through the route
      // would be testing the loop rather than the removed ceiling.
      for (let i = 0; i < 100; i += 1) {
        const filler = await notes.create({
          userId: 'user-1', html: `<p>Old ${i}</p>`, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
        });
        await notes.update(filler.id, { archivedAt: '2026-08-01T09:00:00.000Z' });
      }

      expect((await archive(deps, token, '1')).statusCode).toBe(200);
      // Old clients call plain DELETE for `note rm`; it archives too, and must
      // obey the same unbounded-archive rule as the explicit verb.
      expect((await del(deps, token, '2')).statusCode).toBe(200);
      expect(await notes.countArchivedByUser('user-1')).toBe(102);
    });

    it('refuses to restore into a desk that is already full', async () => {
      const { deps, token, notes } = await buildDeps();
      const doc = await notes.create({
        userId: 'user-1', html: '<p>Put away</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
      });
      await notes.update(doc.id, { archivedAt: '2026-08-01T09:00:00.000Z' });
      for (let i = 0; i < QUICK_NOTES_MAX_PER_USER; i += 1) {
        await notes.create({
          userId: 'user-1', html: `<p>Live ${i}</p>`, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
        });
      }

      const res = createMockResponse();
      await routeHandler(deps, '/notes/:number/archive', 'delete')(
        mockRequest({ token, params: { number: String(doc.number) } }), res,
      );
      // The archive is not a way to keep two hundred working notes.
      expect(res.statusCode).toBe(400);
      expect((await notes.get(doc.id))?.archivedAt).toBeTruthy();
    });
  });

  it('503s every verb when the backend has no note storage', async () => {
    const { deps, token } = await buildDeps();
    const without = { userStorage: deps.userStorage } satisfies Partial<RouteDeps>;
    for (const [path, method] of [
      ['/notes', 'get'], ['/notes', 'post'],
      ['/notes/:number', 'get'], ['/notes/:number', 'put'], ['/notes/:number', 'delete'],
      ['/notes/:number/comments', 'post'],
    ] as Array<[string, Method]>) {
      const res = createMockResponse();
      await routeHandler(without, path, method)(mockRequest({ token, params: { number: '1' }, body: { html: '<p>x</p>', text: 'x' } }), res);
      expect(res.statusCode).toBe(503);
    }
  });
});

describe('quick notes: atomic work claims (note #99)', () => {
  const start = async (deps: Partial<RouteDeps>, token: string, number = '1') => {
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/claim', 'post')(
      mockRequest({ token, params: { number } }),
      res,
    );
    return res;
  };

  it('returns the current note while taking one exclusive expiring lease', async () => {
    const { deps, token, otherToken } = await buildDeps();
    await add(deps, token, '<h2>Ship this</h2><p>Current words.</p>');

    const won = await start(deps, token);
    expect(won.statusCode).toBe(200);
    expect(won.body).toMatchObject({
      outcome: 'claimed',
      note: {
        html: '<h2>Ship this</h2><p>Current words.</p>',
        work: { state: 'working', agentName: 'Ben', byYou: true },
      },
    });

    const lost = await start(deps, otherToken);
    expect(lost.statusCode).toBe(409);
    expect((lost.body as { error: string }).error).toContain('Ben');
    expect((lost.body as { error: string }).error).toContain('Do not proceed');
  });

  it('renews for the same agent, expires for another, and releases only by owner', async () => {
    const { deps, token, otherToken, notes } = await buildDeps();
    await add(deps, token, '<p>Do it once</p>');
    expect((await start(deps, token)).body).toMatchObject({ outcome: 'claimed' });
    expect((await start(deps, token)).body).toMatchObject({ outcome: 'renewed' });

    const foreignRelease = createMockResponse();
    await routeHandler(deps, '/notes/:number/claim', 'delete')(
      mockRequest({ token: otherToken, params: { number: '1' } }),
      foreignRelease,
    );
    expect(foreignRelease.statusCode).toBe(409);

    const note = (await notes.getByNumber('user-1', 1))!;
    await notes.update(note.id, {
      claim: { ...note.claim!, expiresAt: '2000-01-01T00:00:00.000Z' },
    });
    const takeover = await start(deps, otherToken);
    expect(takeover.statusCode).toBe(200);
    expect(takeover.body).toMatchObject({
      outcome: 'claimed',
      note: { work: { state: 'working', agentName: 'Ada', byYou: true } },
    });

    const release = createMockResponse();
    await routeHandler(deps, '/notes/:number/claim', 'delete')(
      mockRequest({ token: otherToken, params: { number: '1' } }),
      release,
    );
    expect(release.statusCode).toBe(200);
    expect(release.body).toMatchObject({ note: { work: { state: 'unclaimed' } } });
  });

  it('shows Unclaimed and Working directly in the list', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<p>First</p>');
    await add(deps, token, '<p>Second</p>');
    await start(deps, token, '2');

    const rows = await listNotes(deps, token) as Array<{ number: number; work: { state: string } }>;
    expect(rows.map((row) => [row.number, row.work.state])).toEqual([
      [2, 'working'],
      [1, 'unclaimed'],
    ]);
  });

  /**
   * Handed (notes #234/#258). What an agent needs off this state is not the
   * word but WHO: "your user asked you for this" and "your user asked somebody
   * else for this" are opposite instructions, and the only thing telling them
   * apart is whether the id is its own.
   */
  it('tells the reading agent whether a handed note was handed to IT', async () => {
    const { deps, token, otherToken, notes } = await buildDeps();
    await add(deps, token, '<p>Yours</p>');
    await add(deps, token, '<p>Somebody else\'s</p>');
    const handoff = (agentId: string, agentName: string) => ({
      agentId, agentName, userId: 'user-1',
      handedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await notes.update((await notes.getByNumber('user-1', 1))!.id, {
      handoff: handoff('agent-a', 'Ben'),
    });
    await notes.update((await notes.getByNumber('user-1', 2))!.id, {
      handoff: handoff('agent-b', 'Ada'),
    });

    const mine = await listNotes(deps, token) as Array<{ number: number; work: Record<string, unknown> }>;
    expect(mine.find((row) => row.number === 1)!.work)
      .toMatchObject({ state: 'handed', agentName: 'Ben', byYou: true });
    // No `byYou` at all on the other one — absent, not false, exactly as the
    // claim's own serialization decides it.
    expect(mine.find((row) => row.number === 2)!.work)
      .toEqual({ state: 'handed', agentName: 'Ada', handedAt: expect.any(String), expiresAt: expect.any(String) });

    // And it flips with the reader: Ada's own list calls note #2 hers.
    const theirs = await listNotes(deps, otherToken) as Array<{ number: number; work: Record<string, unknown> }>;
    expect(theirs.find((row) => row.number === 2)!.work).toMatchObject({ byYou: true });
    expect(theirs.find((row) => row.number === 1)!.work.byYou).toBeUndefined();
  });
});

/**
 * Comments (docs/agent-quick-notes.md, "the margin"). The point of them is what
 * they do NOT do: a remark leaves the note's own words exactly where they were,
 * which is what makes it the thing an agent may say about the USER's note —
 * where an edit would put its words in their mouth.
 */
describe('quick notes: the margin', () => {
  async function comment(deps: Partial<RouteDeps>, token: string, number: string, text: unknown) {
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/comments', 'post')(
      mockRequest({ token, params: { number }, body: { text } }),
      res,
    );
    return res;
  }

  async function readNote(deps: Partial<RouteDeps>, token: string, number: string) {
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'get')(mockRequest({ token, params: { number } }), res);
    return (res.body as {
      note: { html: string; comments?: Array<{ by: string; text: string }> };
    }).note;
  }

  it('adds a remark without touching the note or when it was written', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<h2>Wifi</h2><p>4417</p>');
    const before = await notes.getByNumber('user-1', 1);

    const res = await comment(deps, token, '1', 'The router was swapped — I will check the code.');
    expect(res.statusCode).toBe(200);

    const after = await notes.getByNumber('user-1', 1);
    expect(after?.html).toBe('<h2>Wifi</h2><p>4417</p>');
    // The words did not change, so neither does the field every surface prints
    // as "updated …" beside who wrote it.
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.updatedByAgentId).toBe('agent-a');
    expect(after?.comments).toHaveLength(1);
    expect(after?.comments?.[0]?.authorId).toBe('agent-a');
  });

  it('says who said it in words the reader can act on', async () => {
    const { deps, token, otherToken, notes } = await buildDeps();
    await add(deps, token, '<p>Call the plumber</p>');
    await comment(deps, token, '1', 'Left a message.');
    await comment(deps, otherToken, '1', 'They call back Tuesdays.');
    // A remark by an agent this account no longer has: still readable, still
    // attributed to somebody, because the words were said either way.
    const doc = await notes.getByNumber('user-1', 1);
    await notes.addComment(doc!.id, {
      id: 'c-gone', authorId: 'agent-retired', text: 'Their number changed.', createdAt: '2026-08-17T10:00:00.000Z',
    });

    // Read by agent-a: its own remark is "you", the others get their names.
    expect((await readNote(deps, token, '1')).comments?.map((c) => c.by))
      .toEqual(['you', 'Ada', 'another agent']);
    // And by agent-b, where the same three remarks read the other way round.
    expect((await readNote(deps, otherToken, '1')).comments?.map((c) => c.by))
      .toEqual(['Ben', 'you', 'another agent']);
  });

  it('counts them on the list, which is the only place an agent learns they exist', async () => {
    const { deps, token } = await buildDeps();
    await add(deps, token, '<p>One</p>');
    await add(deps, token, '<p>Two</p>');
    await comment(deps, token, '2', 'Still waiting on this.');
    const listed = await listNotes(deps, token) as unknown as Array<{ number: number; comments?: number }>;
    expect(listed.find((n) => n.number === 2)?.comments).toBe(1);
    // Absent, not zero: a note nobody has remarked on says nothing about it.
    expect(listed.find((n) => n.number === 1)).not.toHaveProperty('comments');
  });

  it('refuses an empty, oversized, or unsafe remark and keeps safe markup', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<p>Keep me</p>');
    expect((await comment(deps, token, '1', '   ')).statusCode).toBe(400);
    expect((await comment(deps, token, '1', 'x'.repeat(1001))).statusCode).toBe(400);
    expect((await comment(deps, token, '1', 'use <b>this</b> one')).statusCode).toBe(200);
    expect((await notes.getByNumber('user-1', 1))?.comments?.[0]?.text).toBe('use <b>this</b> one');
    const unsafe = await comment(deps, token, '1', '<script>steal()</script>');
    expect(unsafe.statusCode).toBe(400);
    expect(String((unsafe.body as { error: string }).error)).toContain('no JavaScript');
    expect((await comment(deps, token, '1', 42)).statusCode).toBe(400);
  });

  it('caps the margin, and says what to do instead', async () => {
    const { deps, token, notes } = await buildDeps();
    await add(deps, token, '<p>Busy note</p>');
    const doc = await notes.getByNumber('user-1', 1);
    for (let i = 0; i < 50; i += 1) {
      await notes.addComment(doc!.id, {
        id: `c${i}`, authorId: 'agent-a', text: `remark ${i}`, createdAt: '2026-08-17T10:00:00.000Z',
      });
    }
    const res = await comment(deps, token, '1', 'one more');
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain('50 comments');
  });

  it('404s a note this account does not have', async () => {
    const { deps, token } = await buildDeps();
    expect((await comment(deps, token, '9', 'hello')).statusCode).toBe(404);
  });
});

describe('quick notes: title and preview', () => {
  it('reads the title out of the markup, wherever the heading is', () => {
    expect(quickNoteTitle('<p>intro</p><h3>Real title</h3><p>body</p>')).toBe('Real title');
    expect(quickNoteTitle('<ul><li>milk</li></ul>')).toBe('milk');
    // Entities are decoded: the owner reads the word, not the escape.
    expect(quickNoteTitle('<h2>Bed &amp; breakfast</h2>')).toBe('Bed & breakfast');
  });

  it('cuts a title that would not fit a row, and never wraps it', () => {
    const title = quickNoteTitle(`<p>${'x'.repeat(200)}</p>`);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
  });

  it('collapses the body onto one line for a list', () => {
    expect(quickNotePreview('<h2>Title</h2><ul><li>milk</li><li>eggs</li></ul><p>bread</p>'))
      .toBe('milk eggs bread');
  });

  it('says nothing twice: a note that is only its title has no preview', () => {
    expect(quickNotePreview('<p>Call the plumber back</p>')).toBe('');
  });

  it('puts a remark on one line, however it was typed', () => {
    // Plain text remains valid semantic HTML and may still arrive in
    // paragraphs; on a row those breaks become gaps that read as the end of
    // the sentence.
    expect(quickNoteCommentPreview('Diagnosed and fixed.\n\nProposal #157 is in your chat.'))
      .toBe('Diagnosed and fixed. Proposal #157 is in your chat.');
  });

  it('shows the visible words of comment HTML rather than its source', () => {
    expect(quickNoteCommentPreview(
      '<p><strong>Diagnosed and fixed.</strong></p><p>Proposal #157 is in your chat.</p>',
    )).toBe('Diagnosed and fixed. Proposal #157 is in your chat.');
  });

  it('does not leave tag-boundary spaces before punctuation', () => {
    expect(quickNoteCommentPreview(
      '<p><strong>Fixed</strong>, including <code>main</code>.</p>',
    )).toBe('Fixed, including main.');
  });

  it('cuts a remark at its first full stop — the answer, without the essay', () => {
    // The real shape of an agent's remark: the answer, then three sentences of
    // detail that belong inside the note. Cut by length this ended "…is in
    // your…", which promises an answer and withholds it.
    expect(quickNoteCommentPreview(
      'Diagnosed and fixed — proposal #157 is in your chat. The column read a stamp that only'
      + ' moves in the factory bot’s chat, so your agent chats never counted.',
    )).toBe('Diagnosed and fixed — proposal #157 is in your chat.');
  });

  it('does not mistake a version number for the end of a sentence', () => {
    // The stop has to be followed by a space or the end: "1.14.0" is not a
    // sentence, and neither is the dot in a file name.
    expect(quickNoteCommentPreview('Shipped CLI 1.14.0 with the delete verb. It reaches every machine.'))
      .toBe('Shipped CLI 1.14.0 with the delete verb.');
  });

  it('holds out for something worth showing rather than cutting at “Done.”', () => {
    // Below a sentence's worth of words the cut is not a preview, it is a
    // tease — so it runs on to the next stop instead.
    expect(quickNoteCommentPreview('Done. The runner had to be restarted first.'))
      .toBe('Done. The runner had to be restarted first.');
  });

  it('falls back to the length cap for a remark with no full stop at all', () => {
    const preview = quickNoteCommentPreview('x'.repeat(400));
    expect(preview.length).toBe(160);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('cuts a remark to the length the note’s own preview gets, and no more', () => {
    const preview = quickNoteCommentPreview('x'.repeat(400));
    // The two sit one above the other in the list: a margin allowed to run
    // longer than the note would read as the louder of the two.
    expect(preview.length).toBe(160);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves a remark that already fits exactly as it was written', () => {
    expect(quickNoteCommentPreview('Still true after the CI split.'))
      .toBe('Still true after the CI split.');
  });
});

/**
 * The user edits a note in a text box, so the note has to come back OUT as the
 * text they typed. This is the exact inverse of `textToSafeHtml`, and it is
 * only ever asked for a note that function wrote.
 */
describe('quick notes: a note back in the text it was typed as', () => {
  it('round-trips what the Workspace box produces', () => {
    for (const text of [
      'Bin day is Thursday\n\nGreen bin every other week — next one is the 27th.',
      'Call the plumber back',
      'Shopping\nmilk\neggs',
      'Bed & breakfast <booked>',
    ]) {
      expect(quickNoteEditableText(textToSafeHtml(text))).toBe(text);
    }
  });

  it('gives an agent’s markup back as readable lines rather than tags', () => {
    // Not offered as an edit box anywhere — this is the shape that must not
    // hand back angle brackets if it ever is asked.
    expect(quickNoteEditableText('<h2>Shopping</h2><ul><li>milk</li><li>eggs</li></ul>'))
      .toBe('Shopping\n\nmilk\n\neggs');
  });
});

/**
 * Notes shipped plain-text and became HTML the same day, with real notes
 * already written. Those rows must keep reading — converted, never
 * interpreted, and never migrated in place.
 */
describe('quick notes: the rows written before it was HTML', () => {
  const legacy = (text: string) => normalizeQuickNote({
    id: 'n1', userId: 'user-1', number: 1, text,
    createdByAgentId: 'a', updatedByAgentId: 'a',
    createdAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-16T10:00:00.000Z',
  });

  it('reads a plain-text note as paragraphs, keeping its blocks', () => {
    expect(legacy('Wifi code\nIt is 4417.\n\nThe hall light shares a switch.').html)
      .toBe('<p>Wifi code<br>It is 4417.</p>\n<p>The hall light shares a switch.</p>');
  });

  it('escapes what was only ever text — it was never markup', () => {
    const note = legacy('Careful: <script>alert(1)</script> & <b>bold</b>');
    expect(note.html).toContain('&lt;script&gt;');
    expect(note.html).not.toContain('<script>');
    expect(note.html).not.toContain('<b>');
  });

  it('leaves an HTML note alone', () => {
    const html = '<h2>Already HTML</h2>';
    expect(normalizeQuickNote({
      id: 'n2', userId: 'user-1', number: 2, html,
      createdByAgentId: 'a', updatedByAgentId: 'a',
      createdAt: 'x', updatedAt: 'x',
    }).html).toBe(html);
  });
});

/**
 * Files on notes (docs/agent-quick-notes.md, attachments): the bytes live in
 * media storage under the note's own prefix, the note's row carries only the
 * record, and the note going takes its files with it.
 */
class FakeMediaStorage {
  objects = new Map<string, { contentType: string; size: number }>();
  deletedPrefixes: string[] = [];

  async uploadObject(args: { storagePath: string; contentType: string; data: Buffer }) {
    this.objects.set(args.storagePath, { contentType: args.contentType, size: args.data.length });
  }

  async createReadAccess(args: { storagePath: string }) {
    if (!this.objects.has(args.storagePath)) throw new Error('no such object');
    return { url: `https://signed.example/${args.storagePath}`, expiresAt: 'soon' };
  }

  async createUploadTarget() { return { uploadUrl: 'unused', expiresAt: 'soon' }; }
  async downloadObject() { return Buffer.alloc(0); }
  async setMetadata() {}

  async deleteObject(args: { storagePath: string }) {
    this.objects.delete(args.storagePath);
  }

  async deleteObjectsWithPrefix(args: { prefix: string }) {
    this.deletedPrefixes.push(args.prefix);
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(args.prefix)) this.objects.delete(key);
    }
  }
}

function fileRequest(args: {
  token: string;
  params?: Record<string, string>;
  body?: Buffer;
  fileName?: string;
  contentType?: string;
}): Partial<Request> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${args.token}`,
    ...(args.fileName ? { 'x-note-file-name': args.fileName } : {}),
    ...(args.contentType ? { 'content-type': args.contentType } : {}),
  };
  return {
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {},
    query: {},
    body: args.body,
  };
}

describe('quick notes: files', () => {
  async function buildWithFiles() {
    const built = await buildDeps();
    const media = new FakeMediaStorage();
    (built.deps as Partial<RouteDeps>).mediaStorage = media as never;
    const res = await add(built.deps, built.token, '<h2>Menu</h2><p>The autumn one.</p>');
    const number = String((res.body as { note: { number: number } }).note.number);
    return { ...built, media, number };
  }

  it('attach stores the bytes and the note starts carrying the record', async () => {
    const { deps, token, media, number } = await buildWithFiles();

    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token, params: { number }, body: Buffer.from('pdf-bytes'), fileName: 'menu.pdf',
    }), res);

    expect(res.statusCode).toBe(200);
    const note = (res.body as { note: { attachments: Array<Record<string, unknown>>; files: number } }).note;
    expect(note.files).toBe(1);
    expect(note.attachments).toEqual([
      expect.objectContaining({ fileName: 'menu.pdf', contentType: 'application/pdf', sizeBytes: 9 }),
    ]);
    // The bytes landed under the note's own prefix, typed by extension.
    const [path] = [...media.objects.keys()];
    expect(path).toMatch(/^users\/user-1\/notes\/.+\/menu\.pdf$/);
    // And the list marks the note without carrying the file records.
    const listed = await listNotes(deps, token);
    expect(listed[0]).toMatchObject({ files: 1 });
  });

  it('files an attachment under the note’s own namespace — an old room’s, for a note still standing there — and deletes it from there (note #741, Rosa’s review)', async () => {
    const { deps, token, otherToken, media, notes, userStorage } = await buildWithFiles();
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-1' });
    await orgStorage.addMember({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const orgGit = new OrgGitService({ orgStorage });
    await orgGit.stampOrgGitNamespace(org.orgId, 'user-1');
    // An old room's namespace, kept on the workplace when rooms went (note #843).
    await orgStorage.updateOrg(org.orgId, {
      roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['ns-platform'] },
    });
    await userStorage.updateAgentFields('user-1', 'agent-a', { orgId: org.orgId });
    await userStorage.updateAgentFields('user-1', 'agent-b', { orgId: org.orgId });
    deps.orgStorage = orgStorage;
    deps.orgGit = orgGit;
    const note = await notes.create(
      { userId: 'ns-platform', html: '<p>Platform note</p>', createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' },
      { series: `org:${org.orgId}`, namespaces: ['user-1', 'ns-platform'] },
    );
    expect(note.number).toBe(2);

    // Ada attaches to it: the bytes go under the NOTE's namespace, not the
    // workplace's she stands in.
    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token: otherToken, params: { number: String(note.number) }, body: Buffer.from('pdf-bytes'), fileName: 'menu.pdf',
    }), res);
    expect(res.statusCode).toBe(200);
    const paths = [...media.objects.keys()].filter((path) => path.includes(note.id));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^users\/ns-platform\/notes\//);
    expect((await notes.get(note.id))?.attachments?.[0]?.storagePath).toBe(paths[0]);

    // And a delete sweeps that same prefix, so nothing is stranded.
    await routeHandler(deps, '/notes/:number/archive', 'post')(mockRequest({ token, params: { number: String(note.number) } }), createMockResponse());
    const gone = createMockResponse();
    await routeHandler(deps, '/notes/:number', 'delete')(mockRequest({ token: otherToken, params: { number: String(note.number) }, query: { forever: '1' } }), gone);
    expect(gone.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...media.objects.keys()].filter((path) => path.includes(note.id))).toEqual([]);
  });

  it('refuses what it must, each with the reason: name, size-zero, duplicate, a sixth file', async () => {
    const { deps, token, number } = await buildWithFiles();
    const attach = routeHandler(deps, '/notes/:number/files', 'post');
    const tryAttach = async (fileName: string, body = Buffer.from('x')) => {
      const res = createMockResponse();
      await attach(fileRequest({ token, params: { number }, body, fileName }), res);
      return res;
    };

    expect((await tryAttach('менюшка.pdf')).statusCode).toBe(400);
    expect((await tryAttach('menu.pdf', Buffer.alloc(0))).statusCode).toBe(400);

    for (let i = 0; i < 5; i += 1) expect((await tryAttach(`f${i}.txt`)).statusCode).toBe(200);
    const sixth = await tryAttach('f5.txt');
    expect(sixth.statusCode).toBe(400);
    expect((sixth.body as { error: string }).error).toContain('at most 5');

    const duplicate = createMockResponse();
    await attach(fileRequest({ token, params: { number }, body: Buffer.from('x'), fileName: 'f0.txt' }), duplicate);
    expect(duplicate.statusCode).toBe(400);
    expect((duplicate.body as { error: string }).error).toContain('already has a file named f0.txt');
  });

  it('a backend with no media store says so instead of pretending', async () => {
    const { deps, token } = await buildDeps();
    const res = await add(deps, token, '<p>Words only.</p>');
    const number = String((res.body as { note: { number: number } }).note.number);

    const attach = createMockResponse();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token, params: { number }, body: Buffer.from('x'), fileName: 'a.txt',
    }), attach);
    expect(attach.statusCode).toBe(503);
  });

  it('fetch answers a signed URL by file name, and names what IS there when asked for what is not', async () => {
    const { deps, token, number } = await buildWithFiles();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token, params: { number }, body: Buffer.from('bytes'), fileName: 'menu.pdf',
    }), createMockResponse());

    const found = createMockResponse();
    await routeHandler(deps, '/notes/:number/files/:name', 'get')(fileRequest({
      token, params: { number, name: 'menu.pdf' },
    }), found);
    expect(found.statusCode).toBe(200);
    expect((found.body as { url: string }).url).toContain('https://signed.example/');

    const missing = createMockResponse();
    await routeHandler(deps, '/notes/:number/files/:name', 'get')(fileRequest({
      token, params: { number, name: 'nope.pdf' },
    }), missing);
    expect(missing.statusCode).toBe(404);
    // The refusal lists what the note has — the answer to the question the
    // agent was actually asking.
    expect((missing.body as { error: string }).error).toContain('menu.pdf');
  });

  it('detach drops the record and the bytes; deleting the note clears its whole prefix', async () => {
    const { deps, token, media, number } = await buildWithFiles();
    const attach = routeHandler(deps, '/notes/:number/files', 'post');
    await attach(fileRequest({ token, params: { number }, body: Buffer.from('a'), fileName: 'a.txt' }), createMockResponse());
    await attach(fileRequest({ token, params: { number }, body: Buffer.from('b'), fileName: 'b.txt' }), createMockResponse());
    expect(media.objects.size).toBe(2);

    const detach = createMockResponse();
    await routeHandler(deps, '/notes/:number/files/:name', 'delete')(fileRequest({
      token, params: { number, name: 'a.txt' },
    }), detach);
    expect(detach.statusCode).toBe(200);
    // Best-effort delete runs detached; give it the microtask it needs.
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.objects.size).toBe(1);

    // A note's files ride the ARCHIVE with it: an archive that strips the
    // photo off a note is a delete wearing a softer word.
    await archive(deps, token, number);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.deletedPrefixes).toHaveLength(0);
    expect(media.objects.size).toBe(1);

    await routeHandler(deps, '/notes/:number', 'delete')(
      mockRequest({ token, params: { number }, query: { forever: '1' } }), createMockResponse(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.deletedPrefixes).toHaveLength(1);
    expect(media.objects.size).toBe(0);
  });

  it('refuses to attach to an archived note, and names the way back', async () => {
    const { deps, token, number } = await buildWithFiles();
    await archive(deps, token, number);

    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token, params: { number }, body: Buffer.from('x'), fileName: 'late.txt',
    }), res);
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain('note unarchive');
  });

  it('any agent may attach to any note — attaching is not editing', async () => {
    const { deps, otherToken, number } = await buildWithFiles();

    const res = createMockResponse();
    await routeHandler(deps, '/notes/:number/files', 'post')(fileRequest({
      token: otherToken, params: { number }, body: Buffer.from('x'), fileName: 'from-ada.txt',
    }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('quick notes: a file in parts (note #784)', () => {
  const call = async (deps: Partial<RouteDeps>, path: string, method: Method, req: { token: string; params: Record<string, string>; query?: Record<string, string>; body?: unknown }) => {
    const res = createMockResponse();
    await routeHandler(deps, path, method)({
      get: ((name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${req.token}` : undefined)) as Request['get'],
      params: req.params, query: req.query ?? {}, body: req.body,
    } as Partial<Request>, res);
    return res;
  };

  it('goes start, parts, complete — and the note carries it only once complete, whole', async () => {
    const built = await buildDeps();
    const media = new MemoryMediaStorage();
    (built.deps as Partial<RouteDeps>).mediaStorage = media;
    const added = await add(built.deps, built.token, '<h2>Demo</h2><p>The screen recording.</p>');
    const number = String((added.body as { note: { number: number } }).note.number);
    const data = Buffer.concat([Buffer.alloc(UPLOAD_PART_BYTES, 7), Buffer.from('the tail')]);
    const started = await call(built.deps, '/notes/:number/files/uploads', 'post', { token: built.token, params: { number }, body: { fileName: 'demo.mov', sizeBytes: data.length } });
    expect(started.statusCode).toBe(201);
    const upload = started.body as { id: string; uploadId: string; parts: number; partBytes: number };
    expect(upload.parts).toBe(2);
    const parts = [];
    for (const n of [1, 2]) {
      const part = await call(built.deps, '/notes/:number/files/uploads/:id/parts/:part', 'put', {
        token: built.token, params: { number, id: upload.id, part: String(n) }, query: { upload: upload.uploadId, name: 'demo.mov' },
        body: data.subarray((n - 1) * UPLOAD_PART_BYTES, n * UPLOAD_PART_BYTES),
      });
      expect(part.statusCode).toBe(200);
      parts.push(part.body);
    }
    expect((await listNotes(built.deps, built.token))[0]?.files ?? 0).toBe(0);
    const done = await call(built.deps, '/notes/:number/files/uploads/:id/complete', 'post', {
      token: built.token, params: { number, id: upload.id }, body: { uploadId: upload.uploadId, fileName: 'demo.mov', parts },
    });
    expect(done.statusCode).toBe(200);
    const note = (done.body as { note: { attachments: Array<{ fileName: string; sizeBytes: number }> } }).note;
    expect(note.attachments).toEqual([expect.objectContaining({ fileName: 'demo.mov', sizeBytes: data.length })]);
    const [path] = [...media.objects.keys()];
    expect(path).toMatch(new RegExp(`^users/user-1/notes/.+/${upload.id}/demo\\.mov$`));
    expect(media.objects.get(path!)!.data.equals(data)).toBe(true);
  });

  it('refuses over 100 MB before a byte is sent, and a cancelled one leaves nothing', async () => {
    const built = await buildDeps();
    const media = new MemoryMediaStorage();
    (built.deps as Partial<RouteDeps>).mediaStorage = media;
    const added = await add(built.deps, built.token, '<p>Big things.</p>');
    const number = String((added.body as { note: { number: number } }).note.number);
    const tooBig = await call(built.deps, '/notes/:number/files/uploads', 'post', { token: built.token, params: { number }, body: { fileName: 'huge.mov', sizeBytes: 100 * 1024 * 1024 + 1 } });
    expect(tooBig.statusCode).toBe(413);
    expect((tooBig.body as { error: string }).error).toContain('up to 100 MB');
    const fits = await call(built.deps, '/notes/:number/files/uploads', 'post', { token: built.token, params: { number }, body: { fileName: 'fits.mov', sizeBytes: 100 * 1024 * 1024 } });
    expect(fits.statusCode).toBe(201);
    const upload = fits.body as { id: string; uploadId: string };
    await call(built.deps, '/notes/:number/files/uploads/:id/parts/:part', 'put', {
      token: built.token, params: { number, id: upload.id, part: '1' }, query: { upload: upload.uploadId, name: 'fits.mov' }, body: Buffer.alloc(10),
    });
    const cancelled = await call(built.deps, '/notes/:number/files/uploads/:id', 'delete', {
      token: built.token, params: { number, id: upload.id }, query: { upload: upload.uploadId, name: 'fits.mov' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(media.uploads.size).toBe(0);
    expect(media.objects.size).toBe(0);
  });
});
