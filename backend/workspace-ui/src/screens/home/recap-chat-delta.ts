/**
 * Reading only what is new on the Chief of Staff's conversation (note #1071).
 *
 * A read names the version of the transcript this tab holds; the backend
 * answers either the whole conversation or a delta from that version (see
 * `services/recap-chat-versions.ts`). This file is the page's half: when to
 * name a version, and how a delta becomes the whole answer again, so the
 * rest of the screen only ever sees whole answers.
 */

import type { RecapChatAnswer, RecapChatDeltaAnswer, RecapChatRead } from '../../../../src/shared/workspace-recap-chat.js';

/**
 * A tab that has gone this long without a good read asks for the whole
 * conversation once (note #1071): back from a sleep, a lost connection or a
 * run of misses, it starts again from the record rather than from a version
 * the backend may have forgotten — which it would answer whole anyway.
 */
export const RECAP_WHOLE_READ_AFTER_MS = 60_000;

/** When this tab last had a good read of each workplace's conversation. */
const readAt = new Map<string, number>();
export function markRecapChatRead(orgId: string, now = Date.now()): void { readAt.set(orgId, now); }
/** Whether the next read should ask for the whole conversation: never read, or not for a while. */
export function recapChatWantsWhole(orgId: string, now = Date.now()): boolean {
  const at = readAt.get(orgId);
  return at === undefined || now - at > RECAP_WHOLE_READ_AFTER_MS;
}
/** For tests and sign-out: forget every read time. */
export function forgetRecapChatReads(): void { readAt.clear(); }

export const isRecapChatDelta = (value: RecapChatRead): value is RecapChatDeltaAnswer => 'delta' in value && Boolean(value.delta);

/**
 * The path a read of the conversation asks: with `?since=` when the held
 * answer has a version and nothing says to start again.
 */
export function recapChatPath(base: string, held: RecapChatAnswer | null, whole: boolean): string {
  const version = held?.version;
  return !whole && version ? `${base}?since=${encodeURIComponent(version)}` : base;
}

/**
 * The whole answer a read amounts to: a whole answer as it came, or a delta
 * laid over the held one — rows replaced in place by id, rows that left
 * dropped, new rows appended in order. Rows the delta does not name keep
 * their very objects, so nothing that did not change is drawn again.
 *
 * Null when the delta is not from the version held (another read moved this
 * tab on meanwhile): the caller reads whole next time.
 */
export function wholeRecapAnswer(held: RecapChatAnswer | null, read: RecapChatRead): RecapChatAnswer | null {
  if (!isRecapChatDelta(read)) return read;
  const { delta, ...rest } = read;
  if (!held || held.version !== delta.since) return null;
  const gone = new Set(delta.removed);
  const fresh = new Map(delta.rows.map((row) => [row.id, row]));
  const messages = held.messages.filter((row) => !gone.has(row.id)).map((row) => {
    const next = fresh.get(row.id);
    if (next) fresh.delete(row.id);
    return next ?? row;
  });
  messages.push(...fresh.values());
  return { ...rest, messages };
}
