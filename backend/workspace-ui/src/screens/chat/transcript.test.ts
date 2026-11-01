import { describe, expect, it } from 'vitest';
import type { WorkspaceChatMessage } from '../../../../src/shared/workspace-api.js';
import {
  CHAT_MESSAGE_CACHE_LIMIT, broughtArrivals, filesOf, mergeTranscript, transcriptCursor,
} from './transcript.js';

const row = (seq: number, over: Partial<WorkspaceChatMessage> = {}): WorkspaceChatMessage => ({
  seq, role: 'agent', text: `m${seq}`, at: '2026-09-02T10:00:00Z', ...over,
});

describe('merging a read into the transcript', () => {
  it('appends what is strictly newer, in one pass', () => {
    const rows = mergeTranscript([row(1), row(2)], [row(3), row(4)], false);
    expect(rows.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  });

  it('is idempotent: the opening read and a poll may overlap', () => {
    // The full-window read and an incremental one can be in flight together
    // on a slow network. A row at or below the cursor is dropped, never drawn
    // twice.
    const rows = mergeTranscript([row(1), row(2), row(3)], [row(2), row(3), row(4)], false);
    expect(rows.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
  });

  it('tolerates an old read landing late without replacing newer rows', () => {
    const held = [row(5, { text: 'newest' })];
    const rows = mergeTranscript(held, [row(1), row(2)], false);
    expect(rows.map((message) => message.seq)).toEqual([1, 2, 5]);
    expect(rows[2]!.text).toBe('newest');
  });

  it('keeps a bounded window', () => {
    const many = Array.from({ length: CHAT_MESSAGE_CACHE_LIMIT + 10 }, (_, index) => row(index + 1));
    const rows = mergeTranscript([], many, false);
    expect(rows).toHaveLength(CHAT_MESSAGE_CACHE_LIMIT);
    expect(rows[0]!.seq).toBe(11);
  });

  it('a read that brought nothing changes nothing', () => {
    const held = [row(1)];
    expect(mergeTranscript(held, [], false)).toBe(held);
  });

  it('marks only a poll’s rows as arriving', () => {
    expect(mergeTranscript([], [row(1)], false)[0]!.arriving).toBeUndefined();
    expect(mergeTranscript([row(1)], [row(2)], true)[1]!.arriving).toBe(true);
  });

  it('drops a row with no sequence rather than losing the cursor to it', () => {
    const rows = mergeTranscript([], [row(1), { ...row(2), seq: NaN }], false);
    expect(rows.map((message) => message.seq)).toEqual([1]);
  });
});

describe('what the cursor and the entrance read', () => {
  it('the cursor is the newest seq held', () => {
    expect(transcriptCursor([])).toBe(0);
    expect(transcriptCursor([row(1), row(7)])).toBe(7);
  });

  it('arrivals are rows above that cursor, and only those', () => {
    expect(broughtArrivals([row(3)], [row(4)])).toBe(true);
    expect(broughtArrivals([row(3)], [row(2), row(3)])).toBe(false);
    expect(broughtArrivals([row(3)], [])).toBe(false);
  });
});

describe('what a row carries', () => {
  it('normalizes the legacy single-file shape', () => {
    const file = { id: 'f', fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 };
    expect(filesOf(row(1, { file }))).toEqual([file]);
    expect(filesOf(row(1, { files: [file] }))).toEqual([file]);
    expect(filesOf(row(1))).toEqual([]);
  });
});
