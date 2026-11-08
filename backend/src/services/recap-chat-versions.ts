/**
 * What the Chief of Staff's conversation looked like at each version a reader
 * was answered with, so a poll can be answered with only what changed since
 * (note #1071).
 *
 * The conversation is one record, every row of it re-read and re-decorated
 * on every answer: a forwarded proposal's card is read fresh (note #724) and
 * a mail decision's state too, so a row can change on the screen while
 * nothing about it changed in the record. A revision stamped on stored rows
 * would miss exactly those changes. So the version is taken of the ANSWER: a
 * short digest of each row as it would be sent, and a token over the ordered
 * ids and digests. Two answers that would draw the same transcript have the
 * same token; any difference a reader could see changes it.
 *
 * Only a few recent versions of a few conversations are kept, in memory. A
 * token this process does not know — a restart, an eviction, another
 * process, a tab asleep for a day — is not an error: the answer is the whole
 * conversation, once, with a token the next poll can use.
 */

import { createHash } from 'node:crypto';

/** One remembered version: the ids in order and each row's digest. */
interface Version { ids: string[]; digests: string[] }

/** What a delta says: the rows to put in (changed in place or appended at the end, in order) and the ids that left. */
export interface RecapRowsDelta<Row> { rows: Row[]; removed: string[] }

/** How many versions of one conversation are kept: the tabs and phones one person has open, and a little slack. */
export const VERSIONS_PER_CONVERSATION = 6;
/** How many conversations are remembered at all, most recently answered kept. */
export const CONVERSATIONS_REMEMBERED = 64;

const digestOf = (row: unknown): string => createHash('sha1').update(JSON.stringify(row)).digest('base64url').slice(0, 12);

export class RecapChatVersions {
  /** Conversation key → token → version, both in insertion order (oldest first). */
  private readonly conversations = new Map<string, Map<string, Version>>();

  constructor(
    private readonly perConversation = VERSIONS_PER_CONVERSATION,
    private readonly conversationsKept = CONVERSATIONS_REMEMBERED,
  ) {}

  /**
   * Answer a reader: remember the rows as they go out and return their token
   * — the same rows give the same token, so a poll that brings nothing new
   * does not grow the store — and, when the reader named the version it
   * holds, the delta from it. `delta` is null when only the whole
   * conversation will do: no version named, a token unknown here, or rows
   * that moved in a way "keep what you have, change these in place, drop
   * those, append these" cannot say.
   */
  answer<Row extends { id: string }>(key: string, rows: readonly Row[], since?: string): { version: string; delta: RecapRowsDelta<Row> | null } {
    const ids = rows.map((row) => row.id);
    const digests = rows.map(digestOf);
    const held = since ? this.conversations.get(key)?.get(since) : undefined;
    const version = createHash('sha1').update(ids.map((id, at) => `${id}\u0000${digests[at]}`).join('\u0001')).digest('base64url').slice(0, 16);
    let versions = this.conversations.get(key);
    if (versions) this.conversations.delete(key);
    else versions = new Map();
    this.conversations.set(key, versions);
    if (versions.has(version)) versions.delete(version);
    versions.set(version, { ids, digests });
    while (versions.size > this.perConversation) versions.delete(versions.keys().next().value!);
    while (this.conversations.size > this.conversationsKept) this.conversations.delete(this.conversations.keys().next().value!);
    return { version, delta: held ? deltaFrom(held, rows, digests) : null };
  }
}

function deltaFrom<Row extends { id: string }>(held: Version, rows: readonly Row[], digests: readonly string[]): RecapRowsDelta<Row> | null {
  const now = new Set(rows.map((row) => row.id));
  if (now.size !== rows.length) return null;
  const removed = held.ids.filter((id) => !now.has(id));
  const kept = held.ids.filter((id) => now.has(id));
  // What the reader keeps must stand in the same order, at the front.
  for (let at = 0; at < kept.length; at += 1) if (rows[at]?.id !== kept[at]) return null;
  const heldDigest = new Map(held.ids.map((id, at) => [id, held.digests[at]!]));
  return { rows: rows.filter((row, at) => at >= kept.length || heldDigest.get(row.id) !== digests[at]), removed };
}
