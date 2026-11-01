/**
 * The sends in flight, one page session long (note #658). See `outbox.ts` for
 * the rules; this is where they meet the session's API and the banner.
 *
 * Above the screens, beside the warm transcripts, because a message that has
 * gone must keep going when its screen does not — and so the send itself is
 * made HERE rather than in the chat, from the session as it stands at the
 * moment the message's turn comes.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceChatSendAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody, type WorkspaceApi } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { chatFilesBody } from './chat-upload.js';
import { ChatOutboxContext } from './outbox-context.js';
import { ChatOutbox, type OutgoingMessage } from './outbox.js';

/** One message onto the record. The route answers once the message is
 *  admitted — its row is written before that answer leaves — so resolving
 *  here means the next read brings the row. */
async function deliver(api: WorkspaceApi, agentId: string, message: OutgoingMessage, progress: (sent: number, total: number) => void): Promise<void> {
  const path = `api/agents/${encodeURIComponent(agentId)}/chat`;
  if (message.files.length) {
    // Big files go up in parts first (note #943); the bubble shows how far.
    const body = await chatFilesBody(api, agentId, message.text, message.files, progress);
    await api.api(`${path}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.agentbuilt.chat-attachments' },
      body,
    });
    return;
  }
  await api.api<WorkspaceChatSendAnswer>(path, jsonBody({ message: message.text }));
}

export function ChatOutboxProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const banner = useBanner();
  const [outbox] = useState(() => new ChatOutbox());
  useEffect(() => {
    outbox.open();
    return () => outbox.close();
  }, [outbox]);
  useEffect(() => {
    outbox.connect({
      deliver: (agentId, message, progress) => deliver(api, agentId, message, progress),
      refused: (reason) => banner.show(reason),
    });
  }, [api, banner, outbox]);
  return <ChatOutboxContext value={outbox}>{children}</ChatOutboxContext>;
}
