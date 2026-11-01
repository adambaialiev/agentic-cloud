/**
 * The words of every Markdown file this tab has read off a chat (note #677).
 *
 * A chat draws a Markdown file as a page — a glimpse of its top on the row,
 * the whole of it full screen at a tap — and both are drawn from its TEXT,
 * which the backend reads out of the media store because the shell may not
 * fetch from there itself (`connect-src 'self'`). That read carries the whole
 * file, so it is worth making once: a file's bytes never change under its id,
 * and a reader who leaves a conversation and comes back, or opens the same
 * report twice, should not pull it through the backend again.
 *
 * Per TAB, like the Drive, note and mail caches, and emptied the same way:
 * by `SessionProvider` on sign-out and by the test setup between tests.
 */

import type { WorkspaceChatFileTextAnswer } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../../api/client.js';

/** A conversation scrolled back through a month of reports holds a few dozen
 *  of these, most of them a few kilobytes; past this they are answers nobody
 *  is coming back to. */
export const CHAT_FILE_TEXTS_KEPT = 24;

const held = new Map<string, WorkspaceChatFileTextAnswer>();
const keyOf = (agentId: string, fileId: string) => `${agentId}\n${fileId}`;

/** Where a chat file's words are read from. */
export const chatFileTextPath = (agentId: string, fileId: string) =>
  `api/agents/${encodeURIComponent(agentId)}/chat/files/${encodeURIComponent(fileId)}/text`;

/** What this tab already read for this file, if anything. */
export function heldChatFileText(agentId: string, fileId: string): WorkspaceChatFileTextAnswer | null {
  return held.get(keyOf(agentId, fileId)) ?? null;
}

export function holdChatFileText(agentId: string, fileId: string, answer: WorkspaceChatFileTextAnswer): void {
  // Re-inserted, so the map's insertion order is least-recently-used first.
  const key = keyOf(agentId, fileId);
  held.delete(key);
  held.set(key, answer);
  while (held.size > CHAT_FILE_TEXTS_KEPT) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

export function forgetChatFileTexts(): void {
  held.clear();
}

/** The file's words: this tab's copy when it has one, else read and held.
 *  An answer that is not an answer (a stub, a proxy's page) is refused
 *  rather than held, so the next look asks again. */
export async function readChatFileText(api: WorkspaceApi, agentId: string, fileId: string): Promise<WorkspaceChatFileTextAnswer> {
  const kept = heldChatFileText(agentId, fileId);
  if (kept) return kept;
  const read = await api.api<WorkspaceChatFileTextAnswer>(chatFileTextPath(agentId, fileId));
  if (!read?.kind) throw new Error('That file could not be read just now.');
  holdChatFileText(agentId, fileId, read);
  return read;
}

