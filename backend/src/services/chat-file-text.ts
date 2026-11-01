/**
 * A Markdown file on a chat row, read as WORDS (note #677).
 *
 * Every other file a chat draws — a picture, a PDF, an HTML page — is drawn
 * by the browser from a signed media-host URL. Markdown cannot be: the shell's
 * policy is `connect-src 'self'`, so it could not fetch the bytes from that
 * host even if it wanted to, and a browser shown raw Markdown shows the
 * asterisks. So the backend reads the object and hands its text over as data,
 * which the Workspace's own renderer rebuilds — the path Drive's preview has
 * taken since note #298, under the same cap.
 *
 * Shared by the room chat and the Workspace Agent's conversation, which store
 * their rows differently and find a file the same way from then on.
 */

import { isMarkdownFile } from '../shared/inline-files.js';
import { CHAT_FILE_TEXT_MAX_BYTES, type WorkspaceChatFileTextAnswer } from '../shared/workspace-api.js';
import type { MediaStorage } from './media-storage.js';

export async function readChatFileText(
  media: Pick<MediaStorage, 'downloadObject'>,
  file: { fileName: string; contentType: string; sizeBytes: number; storagePath: string },
): Promise<WorkspaceChatFileTextAnswer> {
  const { fileName } = file;
  if (!isMarkdownFile(file.contentType, fileName)) return { kind: 'unsupported', fileName };
  const tooLarge = { kind: 'too-large', fileName, maxBytes: CHAT_FILE_TEXT_MAX_BYTES } as const;
  // The recorded size first, so a huge file is refused without being pulled
  // through the backend; the bytes second, because a record is only a claim.
  if (file.sizeBytes > CHAT_FILE_TEXT_MAX_BYTES) return tooLarge;
  const data = await media.downloadObject({ storagePath: file.storagePath });
  if (data.byteLength > CHAT_FILE_TEXT_MAX_BYTES) return tooLarge;
  return { kind: 'markdown', fileName, content: data.toString('utf8') };
}
