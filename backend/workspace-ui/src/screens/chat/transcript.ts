/**
 * The pure half of the chat's data: how one read's rows join the transcript
 * already on screen, and which of them are NEWS.
 *
 * Ported from the legacy `rememberAgentChatMessages` / `appendChatMessages`
 * pair, with the same two properties and nothing mutated:
 *
 *  - IDEMPOTENT. The full-window opening read and a poll's incremental read
 *    can overlap on a slow network, so a row at or below the cursor is
 *    dropped rather than drawn twice.
 *  - TOLERANT OF AN OLD READ LANDING LATE. The usual poll is the cheap path
 *    (strictly newer rows, one append); an out-of-order arrival falls back to
 *    a merge by seq so a slow opening read cannot replace newer rows.
 */

import type { WorkspaceChatFile, WorkspaceChatMessage } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceForwardedProposal } from '../../../../src/shared/workspace-recap-chat.js';

/** How many rows one conversation keeps warm between opens. */
export const CHAT_MESSAGE_CACHE_LIMIT = 500;

/** A row as the transcript holds it: what the server said, plus the one thing
 *  the page knows that the server does not — whether it landed while this
 *  reader was watching, which is what earns the entrance animation. */
export interface TranscriptRow extends WorkspaceChatMessage {
  arriving?: boolean;
  /** A Workspace screen this receipt opens, as a router path — the door a
   *  Workspace Agent action carries (note #423), where a room agent's
   *  receipt names a proposal in `open` instead. */
  href?: string;
  /** The proposals the Chief of Staff forwarded on this row (note #724), as
   *  they stand now — read fresh on every answer. */
  forwarded?: WorkspaceForwardedProposal[];
}

const ordered = (previous: TranscriptRow[], incoming: WorkspaceChatMessage[]): boolean => {
  let cursor = previous.length ? previous[previous.length - 1]!.seq : -Infinity;
  for (const message of incoming) {
    if (message.seq <= cursor) return false;
    cursor = message.seq;
  }
  return true;
};

/**
 * Merge what one read brought into the rows already held. `arriving` marks
 * the new ones when this read is a poll rather than the opening read: rows
 * after the open are news landing in a watched conversation.
 *
 * Except the rows in `settled` (note #658): the reader's own sends, whose
 * bubbles have been standing at the end of the conversation since Send was
 * pressed. Those are not news — the row takes the bubble's place, and rising
 * into it would read as the message being sent a second time.
 */
export function mergeTranscript(
  previous: TranscriptRow[],
  incoming: WorkspaceChatMessage[],
  arriving: boolean,
  settled: ReadonlySet<number> = new Set(),
): TranscriptRow[] {
  const rows = (incoming ?? []).filter((message) => message && Number.isFinite(message.seq));
  if (!rows.length) return previous;
  const marked: TranscriptRow[] = rows.map((message) => (
    arriving && !settled.has(message.seq) ? { ...message, arriving: true } : message
  ));
  const merged = ordered(previous, rows)
    ? previous.concat(marked)
    : [...new Map(previous.concat(marked).map((message) => [message.seq, message])).values()]
      .sort((a, b) => a.seq - b.seq);
  return merged.slice(-CHAT_MESSAGE_CACHE_LIMIT);
}

/** The newest seq held, which is the cursor the next read asks from. */
export function transcriptCursor(rows: TranscriptRow[]): number {
  return rows.length ? rows[rows.length - 1]!.seq : 0;
}

/** Whether this read brought anything that is still rising — the one thing
 *  the live row's entrance needs to know. */
export function broughtArrivals(previous: TranscriptRow[], incoming: WorkspaceChatMessage[]): boolean {
  const cursor = transcriptCursor(previous);
  return (incoming ?? []).some((message) => Number.isFinite(message.seq) && message.seq > cursor);
}

/** Every file a row carries. Stored one-file rows still arrive through the
 *  legacy `file` field; normalize here so one renderer serves both. */
export function filesOf(message: WorkspaceChatMessage): WorkspaceChatFile[] {
  if (Array.isArray(message.files) && message.files.length) return message.files;
  return message.file ? [message.file] : [];
}

/**
 * Four bytes of UTF-8 manifest length, then its JSON, then every file's raw
 * bytes in the same order. This is the browser half of the route's envelope:
 * no base64 expansion, and no second request that could race into a
 * different turn.
 */
export function attachmentsEnvelope(
  message: string,
  files: File[],
  nameOf: (file: File) => string,
): Blob {
  const manifest = new TextEncoder().encode(JSON.stringify({
    message,
    files: files.map((file) => ({
      fileName: nameOf(file),
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    })),
  }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, manifest.byteLength);
  return new Blob([prefix, manifest, ...files], { type: 'application/vnd.agentbuilt.chat-attachments' });
}
