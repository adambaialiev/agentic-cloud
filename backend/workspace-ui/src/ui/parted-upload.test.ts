import { describe, expect, it, vi } from 'vitest';
import { sendInParts, uploadPercent } from './parted-upload.js';

/** Note #784: the order of a big upload's calls, its retries, and that a
 *  failure cancels it rather than leaving parts behind. */
describe('sendInParts', () => {
  const started = { id: 'f1', uploadId: 'u1', partBytes: 4, parts: 3 };
  const file = new Blob(['0123456789']);

  it('sends every part, reports progress, and completes with the parts in order', async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    const complete = vi.fn(async (_started: unknown, parts: Array<{ partNumber: number }>) => parts.map((part) => part.partNumber));
    const result = await sendInParts(file, {
      start: async () => started,
      part: async (_s, n, body) => { seen.push(`${n}:${body.size}`); return { partNumber: n, etag: `e${n}` }; },
      complete,
      abort: vi.fn(),
    }, (sent) => progress.push(sent));
    expect(seen.sort()).toEqual(['1:4', '2:4', '3:2']);
    expect(result).toEqual([1, 2, 3]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(10);
  });

  it('retries a failing part, and cancels the upload when it keeps failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let tries = 0;
    const abort = vi.fn(async () => undefined);
    const complete = vi.fn();
    await expect(sendInParts(file, {
      start: async () => started,
      part: async (_s, n) => { if (n === 2) { tries += 1; throw new Error('offline'); } return { partNumber: n, etag: 'e' }; },
      complete,
      abort,
    })).rejects.toThrow('offline');
    vi.useRealTimers();
    expect(tries).toBe(3);
    expect(abort).toHaveBeenCalledWith(started);
    expect(complete).not.toHaveBeenCalled();
  });

  it('says how far it has got', () => {
    expect(uploadPercent(0, 0)).toBe('0%');
    expect(uploadPercent(1, 3)).toBe('33%');
  });
});
