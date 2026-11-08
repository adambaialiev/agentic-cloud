import { describe, expect, it } from 'vitest';
import { RecapChatVersions } from '../../services/recap-chat-versions.js';

/** Note #1071: the Chief of Staff's conversation read as a delta from the version a reader holds. */
const row = (id: string, text = `row ${id}`, extra: Record<string, unknown> = {}) => ({ id, text, ...extra });

describe('RecapChatVersions', () => {
  it('answers whole (no delta) when no version is named or the version is unknown, and the same rows give the same token', () => {
    const store = new RecapChatVersions();
    const rows = [row('a'), row('b')];
    const first = store.answer('u/o', rows);
    expect(first.delta).toBeNull();
    expect(first.version).toMatch(/^[\w-]{16}$/);
    expect(store.answer('u/o', rows.map((r) => ({ ...r }))).version).toBe(first.version);
    expect(store.answer('u/o', rows, 'never-answered').delta).toBeNull();
  });

  it('a poll that brings nothing new is an empty delta', () => {
    const store = new RecapChatVersions();
    const { version } = store.answer('u/o', [row('a'), row('b')]);
    expect(store.answer('u/o', [row('a'), row('b')], version)).toEqual({ version, delta: { rows: [], removed: [] } });
  });

  it('carries new rows at the end, rows changed in place (a request\'s status, a card\'s state), and rows that left', () => {
    const store = new RecapChatVersions();
    const { version } = store.answer('u/o', [row('a'), row('b', 'Forwarded PR #1', { forwarded: [{ status: 'open' }] }), row('c'), row('d')]);
    const now = [row('a'), row('b', 'Forwarded PR #1', { forwarded: [{ status: 'merged' }] }), row('d'), row('e'), row('f')];
    const answered = store.answer('u/o', now, version);
    expect(answered.version).not.toBe(version);
    expect(answered.delta).toEqual({ rows: [now[1], now[3], now[4]], removed: ['c'] });
  });

  it('answers whole when kept rows moved or a row was put in among them', () => {
    const store = new RecapChatVersions();
    const { version } = store.answer('u/o', [row('a'), row('b'), row('c')]);
    expect(store.answer('u/o', [row('a'), row('x'), row('b'), row('c')], version).delta).toBeNull();
    expect(store.answer('u/o', [row('b'), row('a'), row('c')], version).delta).toBeNull();
    expect(store.answer('u/o', [row('a'), row('a')], version).delta).toBeNull();
  });

  it('keeps each conversation apart: one person\'s version means nothing on another\'s conversation', () => {
    const store = new RecapChatVersions();
    const { version } = store.answer('alice/o', [row('a')]);
    expect(store.answer('bob/o', [row('a'), row('b')], version).delta).toBeNull();
    expect(store.answer('alice/o', [row('a'), row('b')], version).delta).toEqual({ rows: [row('b')], removed: [] });
  });

  it('forgets the oldest versions of a conversation, and the least recently answered conversations', () => {
    const store = new RecapChatVersions(2, 2);
    const v1 = store.answer('u/o', [row('a')]).version;
    store.answer('u/o', [row('a'), row('b')]);
    store.answer('u/o', [row('a'), row('b'), row('c')]);
    expect(store.answer('u/o', [row('a'), row('b'), row('c'), row('d')], v1).delta).toBeNull();
    const kept = store.answer('x/o', [row('q')]).version;
    store.answer('y/o', [row('q')]);
    store.answer('z/o', [row('q')]);
    expect(store.answer('x/o', [row('q')], kept).delta).toBeNull();
  });
});
