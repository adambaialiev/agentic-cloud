import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApiError } from '../../api/client.js';
import { chatMessage } from '../../test/fixtures.js';
import {
  ChatOutbox, OUTBOX_ANSWERED_GRACE_MS, OUTBOX_UNSURE_GRACE_MS, OUTBOX_UNSURE_REASON,
  definiteRefusal, matchSends, type OutgoingMessage, type ReturnedDraft,
} from './outbox.js';

/**
 * The outbox on its own (note #658): order, refusals, the send whose answer
 * was lost, and the page session ending under a send.
 */

const refusal = (reason: string) => new WorkspaceApiError(reason, 503, { error: reason });

/** An outbox whose every delivery waits for the test to settle it. */
function harness() {
  const calls: Array<{ agentId: string; message: OutgoingMessage; resolve: () => void; reject: (error: unknown) => void }> = [];
  const refused: string[] = [];
  const outbox = new ChatOutbox();
  outbox.connect({
    deliver: (agentId, message) => new Promise<void>((resolve, reject) => { calls.push({ agentId, message, resolve, reject }); }),
    refused: (reason) => { refused.push(reason); },
  });
  const texts = (agentId = 'a') => outbox.list(agentId).map((message) => `${message.text}:${message.state}`);
  return { outbox, calls, refused, texts };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { vi.useRealTimers(); });

describe('the chat outbox', () => {
  it('sends one message at a time, in the order written', async () => {
    const { outbox, calls, texts } = harness();
    outbox.send('a', { text: 'one', files: [], after: 0 });
    outbox.send('a', { text: 'two', files: [], after: 0 });
    expect(texts()).toEqual(['one:sending', 'two:waiting']);
    expect(calls.map((call) => call.message.text)).toEqual(['one']);
    calls[0]!.resolve();
    await flush();
    expect(texts()).toEqual(['one:sent', 'two:sending']);
    expect(calls.map((call) => call.message.text)).toEqual(['one', 'two']);
  });

  it('keeps each conversation its own queue', () => {
    const { outbox, calls } = harness();
    outbox.send('a', { text: 'to a', files: [], after: 0 });
    outbox.send('b', { text: 'to b', files: [], after: 0 });
    expect(calls.map((call) => `${call.agentId}:${call.message.text}`)).toEqual(['a:to a', 'b:to b']);
  });

  it('gives a refused message back with everything queued behind it, and says why once', async () => {
    const { outbox, calls, refused, texts } = harness();
    const taken: ReturnedDraft[] = [];
    outbox.takeReturned('a', (draft) => { taken.push(draft); });
    const photo = new File(['x'], 'x.png');
    outbox.send('a', { text: 'one', files: [], after: 0 });
    outbox.send('a', { text: '', files: [photo], after: 0 });
    outbox.send('a', { text: 'three', files: [], after: 0 });
    calls[0]!.reject(refusal('Felix could not be started. Nothing was sent.'));
    await flush();
    expect(texts()).toEqual([]);
    expect(taken).toEqual([{ text: 'one\n\nthree', files: [photo] }]);
    expect(refused).toEqual(['Felix could not be started. Nothing was sent.']);
    expect(calls).toHaveLength(1);
  });

  it('holds words given back while no composer is there, and hands them to the next one', async () => {
    const { outbox, calls } = harness();
    outbox.send('a', { text: 'one', files: [], after: 0 });
    calls[0]!.reject(refusal('No.'));
    await flush();
    outbox.send('a', { text: 'two', files: [], after: 0 });
    calls[1]!.reject(refusal('No.'));
    await flush();
    const taken: ReturnedDraft[] = [];
    const stop = outbox.takeReturned('a', (draft) => { taken.push(draft); });
    expect(taken).toEqual([{ text: 'one\n\ntwo', files: [] }]);
    // Handed over once, not again to the next composer.
    stop();
    outbox.takeReturned('a', (draft) => { taken.push(draft); });
    expect(taken).toHaveLength(1);
  });

  it('waits to find a send whose answer was lost before handing it back', async () => {
    vi.useFakeTimers();
    const { outbox, calls, refused, texts } = harness();
    const taken: ReturnedDraft[] = [];
    outbox.takeReturned('a', (draft) => { taken.push(draft); });
    outbox.send('a', { text: 'lost', files: [], after: 3 });
    outbox.send('a', { text: 'behind', files: [], after: 3 });
    calls[0]!.reject(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(0);
    // Nothing overtakes it while its fate is open.
    expect(texts()).toEqual(['lost:unsure', 'behind:waiting']);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(OUTBOX_UNSURE_GRACE_MS);
    expect(texts()).toEqual([]);
    expect(taken).toEqual([{ text: 'lost\n\nbehind', files: [] }]);
    expect(refused).toEqual([OUTBOX_UNSURE_REASON]);
  });

  it('keeps waiting for a lost answer while the chat says the machine is still being rebuilt', async () => {
    vi.useFakeTimers();
    const { outbox, calls, refused, texts } = harness();
    outbox.send('a', { text: 'lost', files: [], after: 3 });
    calls[0]!.reject(new WorkspaceApiError('Request failed (524)', 524, null));
    await vi.advanceTimersByTimeAsync(0);
    // A rebuild can outlast the gateway that gave up on the answer.
    for (let read = 0; read < 5; read += 1) {
      outbox.noteRebuilding('a', true);
      await vi.advanceTimersByTimeAsync(OUTBOX_UNSURE_GRACE_MS);
    }
    expect(texts()).toEqual(['lost:unsure']);
    expect(refused).toEqual([]);
    // And a word from a chat that stopped reading does not hold it forever.
    await vi.advanceTimersByTimeAsync(OUTBOX_UNSURE_GRACE_MS * 3);
    expect(texts()).toEqual([]);
    expect(refused).toEqual([OUTBOX_UNSURE_REASON]);
  });

  it('lets the queue go on once a lost answer turns up on the record', async () => {
    const { outbox, calls, refused, texts } = harness();
    outbox.send('a', { text: 'lost', files: [], after: 3 });
    outbox.send('a', { text: 'behind', files: [], after: 3 });
    calls[0]!.reject(new TypeError('Failed to fetch'));
    await flush();
    outbox.claim('a', [chatMessage({ seq: 4, role: 'owner', text: 'lost', at: new Date().toISOString() })]);
    await flush();
    expect(texts()).toEqual(['behind:sending']);
    expect(refused).toEqual([]);
  });

  it('stands an answered send down when no read ever brings its row', async () => {
    vi.useFakeTimers();
    const { outbox, calls, texts } = harness();
    outbox.send('a', { text: 'hi', files: [], after: 0 });
    calls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(['hi:sent']);
    await vi.advanceTimersByTimeAsync(OUTBOX_ANSWERED_GRACE_MS);
    expect(texts()).toEqual([]);
  });

  it('settles only what a read after the answer did not bring', async () => {
    const { outbox, calls, texts } = harness();
    outbox.send('a', { text: 'kept', files: [], after: 0 });
    calls[0]!.resolve();
    await flush();
    outbox.send('a', { text: 'rewritten', files: [], after: 0 });
    calls[1]!.resolve();
    await flush();
    const ids = outbox.list('a').map((message) => message.id);
    // The read brought the first send's row, not the second's.
    outbox.settle('a', ids, [chatMessage({ seq: 1, role: 'owner', text: 'kept', at: new Date().toISOString() })]);
    expect(texts()).toEqual(['kept:sent']);
  });

  it('says nothing into the next session once the page session has ended', async () => {
    const { outbox, calls, refused, texts } = harness();
    const taken: ReturnedDraft[] = [];
    outbox.takeReturned('a', (draft) => { taken.push(draft); });
    outbox.send('a', { text: 'private', files: [], after: 0 });
    outbox.close();
    calls[0]!.reject(refusal('No.'));
    await flush();
    expect(texts()).toEqual([]);
    expect(taken).toEqual([]);
    expect(refused).toEqual([]);
  });
});

describe('which row answers which send', () => {
  const now = Date.parse('2026-09-24T09:53:52Z');
  const message = (over: Partial<OutgoingMessage>): OutgoingMessage => ({
    id: 'm1', text: '?', files: [], sentAt: now, after: 96, state: 'sending', ...over,
  });

  it('is the owner’s own row, newer than the cursor, with the same words and files', () => {
    const row = chatMessage({ seq: 97, role: 'owner', text: '?', at: '2026-09-24T09:53:52.203Z' });
    expect(matchSends([message({})], [row])).toEqual(new Map([[97, 'm1']]));
    expect(matchSends([message({})], [{ ...row, role: 'agent' }]).size).toBe(0);
    expect(matchSends([message({})], [{ ...row, seq: 96 }]).size).toBe(0);
    expect(matchSends([message({})], [{ ...row, text: '??' }]).size).toBe(0);
    expect(matchSends([message({ files: [new File(['x'], 'x.png')] })], [row]).size).toBe(0);
    // The same words from long before — a conversation opened cold, cursor 0.
    expect(matchSends([message({ after: 0 })], [{ ...row, at: '2026-09-23T19:29:28.677Z' }]).size).toBe(0);
  });

  it('takes one row per send, so the same words twice are two messages', () => {
    const first = message({ id: 'm1' });
    const second = message({ id: 'm2' });
    const rows = [
      chatMessage({ seq: 97, role: 'owner', text: '?', at: '2026-09-24T09:53:52.203Z' }),
      chatMessage({ seq: 98, role: 'owner', text: '?', at: '2026-09-24T09:53:52.210Z' }),
    ];
    expect(matchSends([first, second], rows)).toEqual(new Map([[97, 'm1'], [98, 'm2']]));
    expect(matchSends([first, second], rows.slice(0, 1))).toEqual(new Map([[97, 'm1']]));
    // A message still waiting its turn cannot be on the record.
    expect(matchSends([message({ state: 'waiting' })], rows).size).toBe(0);
  });
});

describe('what counts as a refusal', () => {
  it('is only an answer our own server wrote', () => {
    expect(definiteRefusal(refusal('That message is too long.'))).toBe(true);
    expect(definiteRefusal(new WorkspaceApiError('Request failed (502)', 502, null))).toBe(false);
    expect(definiteRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });
});
