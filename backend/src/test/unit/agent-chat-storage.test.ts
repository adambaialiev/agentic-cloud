import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import {
  AGENT_CHAT_LATEST_SCAN,
  AGENT_CHAT_MESSAGE_CAP,
  AGENT_CHAT_MESSAGE_MAX_BYTES,
  agentChatFileSetRefusal,
  InMemoryAgentChatStorage,
  settleAgentChatUploads,
  SqliteAgentChatStorage,
  type AgentChatStorage,
} from '../../services/agent-chat-storage.js';

let dir: string;
let db: SqliteDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-chat-'));
  db = openSqliteDb(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Both implementations answer to one contract; the suite runs against each.
const implementations: Array<{ name: string; make: () => AgentChatStorage }> = [
  { name: 'SqliteAgentChatStorage', make: () => new SqliteAgentChatStorage(db) },
  { name: 'InMemoryAgentChatStorage', make: () => new InMemoryAgentChatStorage() },
];

for (const { name, make } of implementations) {
  describe(name, () => {
    it('appends with monotonic seq and reads after a cursor', async () => {
      const storage = make();
      const first = await storage.append('u1', 'a1', { role: 'owner', text: 'hello', at: '2026-08-29T10:00:00.000Z' });
      const second = await storage.append('u1', 'a1', { role: 'agent', text: 'hi back', at: '2026-08-29T10:00:05.000Z' });
      expect(first).toEqual({ seq: 1, trimmed: [] });
      expect(second).toEqual({ seq: 2, trimmed: [] });

      const all = await storage.getAfter('u1', 'a1', 0);
      expect(all.map((m) => [m.seq, m.role, m.text])).toEqual([
        [1, 'owner', 'hello'],
        [2, 'agent', 'hi back'],
      ]);

      const incremental = await storage.getAfter('u1', 'a1', first.seq);
      expect(incremental).toHaveLength(1);
      expect(incremental[0].text).toBe('hi back');
    });

    it('round-trips a file row whole', async () => {
      const storage = make();
      const file = {
        id: 'f-1', fileName: 'report.pdf', contentType: 'application/pdf',
        sizeBytes: 12345, storagePath: 'users/u1/agent-chats/a1/f-1/report.pdf',
      };
      await storage.append('u1', 'a1', { role: 'agent', text: '', at: '2026-08-29T10:00:00.000Z', file });
      const rows = await storage.getAfter('u1', 'a1', 0);
      expect(rows[0].file).toEqual(file);
    });

    it('keeps agents and users apart', async () => {
      const storage = make();
      await storage.append('u1', 'a1', { role: 'owner', text: 'for a1', at: '2026-08-29T10:00:00.000Z' });
      await storage.append('u1', 'a2', { role: 'owner', text: 'for a2', at: '2026-08-29T10:00:00.000Z' });
      await storage.append('u2', 'a1', { role: 'owner', text: 'other user', at: '2026-08-29T10:00:00.000Z' });

      const a1 = await storage.getAfter('u1', 'a1', 0);
      expect(a1).toHaveLength(1);
      expect(a1[0].text).toBe('for a1');
    });

    it('reads the newest non-empty text from one role without mistaking later rows for it', async () => {
      const storage = make();
      await storage.append('u1', 'a1', { role: 'agent', text: 'the exact reply', at: '2026-08-29T10:00:00.000Z' });
      await storage.append('u1', 'a1', { role: 'owner', text: 'one more question', at: '2026-08-29T10:00:01.000Z' });
      await storage.append('u1', 'a1', {
        role: 'agent', text: '', at: '2026-08-29T10:00:02.000Z',
        file: { id: 'f1', fileName: 'proof.png', contentType: 'image/png', sizeBytes: 10 },
      });
      await storage.append('u1', 'a1', { role: 'platform', text: 'Turn finished.', at: '2026-08-29T10:00:03.000Z' });

      await expect(storage.getLatestTextByRole('u1', 'a1', 'agent')).resolves.toMatchObject({
        seq: 1,
        role: 'agent',
        text: 'the exact reply',
        at: '2026-08-29T10:00:00.000Z',
      });
      await expect(storage.getLatestTextByRole('u1', 'a2', 'agent')).resolves.toBeNull();
    });

    it('looks a bounded way back, so seeding the fleet never drags whole windows', async () => {
      const storage = make();
      await storage.append('u1', 'a1', { role: 'agent', text: 'ancient words', at: '2026-08-29T10:00:00.000Z' });
      for (let i = 0; i < AGENT_CHAT_LATEST_SCAN; i++) {
        await storage.append('u1', 'a1', { role: 'owner', text: `q${i}`, at: '2026-08-29T10:00:01.000Z' });
      }
      // Buried past the peek: null is the honest answer, and every reader
      // already treats it as "nothing to show" rather than as a failure.
      await expect(storage.getLatestTextByRole('u1', 'a1', 'agent')).resolves.toBeNull();

      // One reply back inside the window and it is found again.
      await storage.append('u1', 'a1', { role: 'agent', text: 'still here', at: '2026-08-29T10:00:02.000Z' });
      await expect(storage.getLatestTextByRole('u1', 'a1', 'agent'))
        .resolves.toMatchObject({ text: 'still here' });
    });

    it('peeks the newest MESSAGE, over receipts and never past a fresh-chat divider (note #553)', async () => {
      const storage = make();
      const file = { id: 'f1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 10, storagePath: 'p/shot.png' };
      await storage.append('u1', 'a1', { role: 'owner', text: 'look', at: '2026-08-29T10:00:00.000Z', files: [file] });
      // A receipt after the picture does not make it any less the last thing said.
      await storage.append('u1', 'a1', { role: 'platform', text: 'Turn finished.', at: '2026-08-29T10:00:01.000Z' });
      await expect(storage.getLatestMessage('u1', 'a1')).resolves.toMatchObject({ seq: 1, role: 'owner', files: [file] });

      // The agent's own file-only row is a message too, text or no text.
      await storage.append('u1', 'a1', { role: 'agent', text: '', at: '2026-08-29T10:00:02.000Z', file: { ...file, id: 'f2' } });
      await expect(storage.getLatestMessage('u1', 'a1')).resolves.toMatchObject({ seq: 3, role: 'agent' });

      // A reset draws a line: what was said before it is not this chat's last message.
      await storage.append('u1', 'a1', { role: 'platform', kind: 'new-chat-divider', text: 'New chat', at: '2026-08-29T10:00:03.000Z' });
      await expect(storage.getLatestMessage('u1', 'a1')).resolves.toBeNull();
      await expect(storage.getLatestMessage('u1', 'nobody')).resolves.toBeNull();

      // Bounded like the reply peek: buried past the scan is null.
      const fresh = make();
      await fresh.append('u1', 'a2', { role: 'agent', text: 'ancient', at: '2026-08-29T10:00:00.000Z' });
      for (let i = 0; i < AGENT_CHAT_LATEST_SCAN; i++) {
        await fresh.append('u1', 'a2', { role: 'platform', text: `r${i}`, at: '2026-08-29T10:00:01.000Z' });
      }
      await expect(fresh.getLatestMessage('u1', 'a2')).resolves.toBeNull();
    });

    it('trims to the cap, oldest first, without restarting seq — and hands back what it trimmed', async () => {
      const storage = make();
      const total = AGENT_CHAT_MESSAGE_CAP + 3;
      const trimmedSeen: number[] = [];
      for (let i = 1; i <= total; i++) {
        const result = await storage.append('u1', 'a1', { role: 'owner', text: `m${i}`, at: '2026-08-29T10:00:00.000Z' });
        trimmedSeen.push(...result.trimmed.map((m) => m.seq));
      }
      const rows = await storage.getAfter('u1', 'a1', 0);
      expect(rows).toHaveLength(AGENT_CHAT_MESSAGE_CAP);
      // The window slides: the oldest rows are gone, the newest survive, and
      // seq keeps counting so an open screen's cursor stays valid.
      expect(rows[0].text).toBe('m4');
      expect(rows[rows.length - 1].text).toBe(`m${total}`);
      expect(rows[rows.length - 1].seq).toBe(total);
      // Every trimmed row was reported exactly once — the caller's only
      // chance to release a file the row carried.
      expect(trimmedSeen).toEqual([1, 2, 3]);
    });

    it('rewrites one row in place, keeping its seq, and ignores a seq outside the window', async () => {
      const storage = make();
      const file = { id: 'f-1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 10, storagePath: 'p' };
      await storage.append('u1', 'a1', { role: 'owner', text: 'look', at: '2026-08-29T10:00:00.000Z', files: [file] });
      await storage.append('u1', 'a1', { role: 'agent', text: 'seen', at: '2026-08-29T10:00:01.000Z' });
      await storage.replace('u1', 'a1', 1, {
        role: 'owner', text: 'look', at: '2026-08-29T10:00:00.000Z', files: [{ ...file, width: 4, height: 3 }],
      });
      await storage.replace('u1', 'a1', 9, { role: 'owner', text: 'ghost', at: '2026-08-29T10:00:02.000Z' });
      const rows = await storage.getAfter('u1', 'a1', 0);
      expect(rows.map((row) => [row.seq, row.text])).toEqual([[1, 'look'], [2, 'seen']]);
      expect(rows[0]!.files![0]).toMatchObject({ id: 'f-1', width: 4, height: 3, storagePath: 'p' });
    });

    it('deletes an agent chat whole', async () => {
      const storage = make();
      await storage.append('u1', 'a1', { role: 'owner', text: 'hello', at: '2026-08-29T10:00:00.000Z' });
      await storage.append('u1', 'a2', { role: 'owner', text: 'stays', at: '2026-08-29T10:00:00.000Z' });
      await storage.deleteForAgent('u1', 'a1');
      expect(await storage.getAfter('u1', 'a1', 0)).toEqual([]);
      expect(await storage.getAfter('u1', 'a2', 0)).toHaveLength(1);
    });
  });
}

describe('SqliteAgentChatStorage persistence', () => {
  it('survives a reopen', async () => {
    const path = join(dir, 'persist.db');
    const first = openSqliteDb(path);
    await new SqliteAgentChatStorage(first).append('u1', 'a1', {
      role: 'agent', text: 'durable', at: '2026-08-29T10:00:00.000Z',
    });
    first.close();
    const second = openSqliteDb(path);
    try {
      const rows = await new SqliteAgentChatStorage(second).getAfter('u1', 'a1', 0);
      expect(rows.map((m) => m.text)).toEqual(['durable']);
    } finally {
      second.close();
    }
  });
});

/**
 * One unreadable row used to cost the whole conversation: `getAfter` parsed
 * straight into a `map`, so a single bad document answered the Workspace chat
 * screen a 500 for that agent — every read, forever, with a blank pane and no
 * way back (note #301). These rows are a rendering surface; the CLI's own
 * transcript is the history.
 */
describe('SqliteAgentChatStorage tolerance for a row it cannot read', () => {
  const corrupt = (seq: number) => db.prepare(
    'INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)',
  ).run('u1', 'a1', seq, '{not json');

  it('reads the conversation around it rather than failing whole', async () => {
    const storage = new SqliteAgentChatStorage(db);
    await storage.append('u1', 'a1', { role: 'owner', text: 'before', at: '2026-08-29T10:00:00.000Z' });
    corrupt(2);
    await storage.append('u1', 'a1', { role: 'agent', text: 'after', at: '2026-08-29T10:00:10.000Z' });

    const rows = await storage.getAfter('u1', 'a1', 0);
    expect(rows.map((m) => m.text)).toEqual(['before', 'after']);
    // The seq of a skipped row is not reused, so the screen's cursor still
    // moves past it and the poll does not re-ask for it forever.
    expect(rows.map((m) => m.seq)).toEqual([1, 3]);
  });

  it('looks past it for the newest words of one voice', async () => {
    const storage = new SqliteAgentChatStorage(db);
    await storage.append('u1', 'a1', { role: 'agent', text: 'the real reply', at: '2026-08-29T10:00:00.000Z' });
    corrupt(2);

    expect((await storage.getLatestTextByRole('u1', 'a1', 'agent'))?.text).toBe('the real reply');
  });
});

describe('a chat message\'s files (note #672)', () => {
  it('are held to their bytes together, never to a count', () => {
    expect(agentChatFileSetRefusal(Array.from({ length: 200 }, () => 400_000))).toBeNull();
    expect(agentChatFileSetRefusal([AGENT_CHAT_MESSAGE_MAX_BYTES])).toBeNull();
    expect(agentChatFileSetRefusal([AGENT_CHAT_MESSAGE_MAX_BYTES, 1])).toContain('up to 95 MB of files');
    expect(agentChatFileSetRefusal([])).toBe('Attach at least one file.');
  });

  it('are stored a few at a time, every one settled, in order', async () => {
    let running = 0;
    let widest = 0;
    const results = await settleAgentChatUploads(Array.from({ length: 30 }, (_, i) => i), async (n) => {
      running++; widest = Math.max(widest, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      if (n === 7) throw new Error('store refused');
      return n * 2;
    });
    expect(widest).toBeLessThanOrEqual(6);
    expect(results).toHaveLength(30);
    expect(results[7]).toMatchObject({ status: 'rejected' });
    expect(results[29]).toEqual({ status: 'fulfilled', value: 58 });
  });
});
