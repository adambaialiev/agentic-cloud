import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApiError } from '../api/client.js';
import {
  READ_AGAIN_MS, READ_LIMIT_MS, ReadTimedOut, readOrSayWhy, worthAskingAgain,
} from './read.js';

/**
 * Note #308 in five tests: a read that answers costs nothing, a read that
 * never answers ENDS, a read that ends is worth retrying through a release
 * going out, a read nobody is waiting on makes one attempt and no more (note
 * #520), and a refusal is taken at its word.
 */

afterEach(() => { vi.useRealTimers(); });

/** A call that never answers — the shape of a request whose connection was
 *  accepted and then abandoned, which is what a backend restart leaves behind. */
const silence = () => new Promise<never>(() => { /* deliberately never settles */ });

const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

describe('a bounded read', () => {
  it('answers straight through, with no second attempt and no waiting', async () => {
    const call = vi.fn(async () => ({ note: 'here' }));
    await expect(readOrSayWhy(call)).resolves.toEqual({ note: 'here' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('ends a read that would otherwise be waited on forever', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const read = readOrSayWhy(silence).catch(failed);
    // The whole span of the attempt, and it is still out: this is exactly the
    // state the screenshot on note #308 was taken in.
    await tick(READ_LIMIT_MS - 100);
    expect(failed).not.toHaveBeenCalled();
    // Every attempt, every pause between them, and then it is over — with a
    // failure the screen can put on the page rather than silence.
    await tick(READ_LIMIT_MS * 3 + READ_AGAIN_MS.reduce((a, b) => a + b, 0));
    await read;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0]).toBeInstanceOf(ReadTimedOut);
    expect((failed.mock.calls[0]![0] as Error).message).toBe('The server did not answer.');
  });

  it('carries a read through a backend that is restarting under it', async () => {
    vi.useFakeTimers();
    // Silent while the old process is going away, then the new one answers —
    // the reader never learns any of it happened.
    let up = false;
    const call = vi.fn(() => (up ? Promise.resolve({ note: 'here' }) : silence()));
    const again = vi.fn(() => { up = true; });
    const read = readOrSayWhy(call, { onAgain: again });
    await tick(READ_LIMIT_MS + READ_AGAIN_MS[0]! + 10);
    await expect(read).resolves.toEqual({ note: 'here' });
    expect(call).toHaveBeenCalledTimes(2);
    // Said BEFORE the pause: the reader is already waiting by then.
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('makes one attempt when the caller has said not to try again', async () => {
    vi.useFakeTimers();
    // A refresh going out underneath an answer already on the screen: still
    // bounded, still abandoned rather than left holding a socket — and then
    // over, rather than swallowing the next two polls.
    const failed = vi.fn();
    const read = readOrSayWhy(silence, { again: [] }).catch(failed);
    await tick(READ_LIMIT_MS + 10);
    await read;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0]).toBeInstanceOf(ReadTimedOut);
  });

  it('takes a refusal at its word instead of asking three times', async () => {
    const call = vi.fn(async () => { throw new WorkspaceApiError('No such note.', 404, {}); });
    await expect(readOrSayWhy(call)).rejects.toThrow('No such note.');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('knows which failures another attempt could do something about', () => {
    expect(worthAskingAgain(new ReadTimedOut())).toBe(true);
    expect(worthAskingAgain(new WorkspaceApiError('bad gateway', 502, {}))).toBe(true);
    expect(worthAskingAgain(new TypeError('Load failed'))).toBe(true);
    expect(worthAskingAgain(new WorkspaceApiError('No such note.', 404, {}))).toBe(false);
    expect(worthAskingAgain(new WorkspaceApiError('Not yours.', 403, {}))).toBe(false);
  });
});
