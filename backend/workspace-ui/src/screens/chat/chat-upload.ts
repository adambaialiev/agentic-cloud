/**
 * A chat message's files on their way (note #943).
 *
 * Small files ride the message's one request, as they always have. A file
 * past one upload part — or one that would take that request past what the
 * edge in front of the server lets through — goes up FIRST, in 8 MB parts, through the chat's own parts doors
 * (`api/agents/<id>/chat/uploads`, the Drive and note protocol), straight
 * into the workplace's bucket. The message's envelope then names it by id
 * instead of carrying it. So there is no size a person can pick that the
 * request refuses, and the server never holds more of a file than one part.
 *
 * The message itself is still ONE request, after every part has landed: the
 * agent is steered or started once, with the whole set, exactly as before.
 */

import type { WorkspaceApi } from '../../api/client.js';
import { safeFileName } from '../../ui/file-kind.js';
import { sendInParts } from '../../ui/parted-upload.js';
import { UPLOAD_PART_BYTES, type PartedUploadPart, type PartedUploadStart } from '../../../../src/shared/uploads.js';

/** What one request may carry inline before the rest goes in parts — well
 *  under the edge's 100 MB, with the server's own 95 MB check behind it. */
export const CHAT_INLINE_MAX_BYTES = 64 * 1024 * 1024;

/** One file of a message, as its envelope describes it. */
export type ChatEnvelopeItem =
  | { file: File; upload?: undefined }
  | { file: File; upload: string };

/** Which of these files go up in parts: past one part each, and whatever
 *  would take the inline total past {@link CHAT_INLINE_MAX_BYTES}. */
export function partedChatFiles(files: readonly File[]): Set<File> {
  const parted = new Set<File>();
  let inline = 0;
  for (const file of files) {
    if (file.size > UPLOAD_PART_BYTES || inline + file.size > CHAT_INLINE_MAX_BYTES) parted.add(file);
    else inline += file.size;
  }
  return parted;
}

/**
 * Four bytes of UTF-8 manifest length, then its JSON, then every INLINE
 * file's raw bytes in the same order. A file that went up in parts is named
 * by its id and carries no bytes here.
 */
export function chatEnvelope(message: string, items: readonly ChatEnvelopeItem[]): Blob {
  const manifest = new TextEncoder().encode(JSON.stringify({
    message,
    files: items.map(({ file, upload }) => ({
      fileName: safeFileName(file.name),
      contentType: file.type || 'application/octet-stream',
      ...(upload ? { upload } : { sizeBytes: file.size }),
    })),
  }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, manifest.byteLength);
  return new Blob(
    [prefix, manifest, ...items.flatMap(({ file, upload }) => (upload ? [] : [file]))],
    { type: 'application/vnd.agentbuilt.chat-attachments' },
  );
}

/** One file up in parts to a chat's doors; answers its id. */
function uploadChatFile(api: WorkspaceApi, agentId: string, file: File, onProgress: (sent: number) => void): Promise<string> {
  const base = `api/agents/${encodeURIComponent(agentId)}/chat/uploads`;
  const fileName = safeFileName(file.name);
  const at = (started: PartedUploadStart, rest: string, query: Record<string, string> = {}) => (
    `${base}/${encodeURIComponent(started.id)}${rest}?${new URLSearchParams({ upload: started.uploadId, name: fileName, ...query })}`
  );
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return sendInParts(file, {
    start: () => api.api<PartedUploadStart>(base, json({ fileName, sizeBytes: file.size, contentType: file.type })),
    part: (started, partNumber, body) => api.api<PartedUploadPart>(at(started, `/parts/${partNumber}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body,
    }),
    complete: async (started, parts) => {
      await api.api(`${base}/${encodeURIComponent(started.id)}/complete`, json({ uploadId: started.uploadId, fileName, parts }));
      return started.id;
    },
    abort: (started) => api.api(at(started, ''), { method: 'DELETE' }),
  }, (sent) => onProgress(sent));
}

/**
 * The body of a message with files: big ones uploaded first, one after
 * another, then the envelope that names them. `onProgress` hears the bytes
 * gone so far out of all the parted ones — only when there are any.
 */
export async function chatFilesBody(
  api: WorkspaceApi,
  agentId: string,
  message: string,
  files: readonly File[],
  onProgress?: (sent: number, total: number) => void,
): Promise<Blob> {
  const parted = partedChatFiles(files);
  const total = files.filter((file) => parted.has(file)).reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  const items: ChatEnvelopeItem[] = [];
  for (const file of files) {
    if (!parted.has(file)) { items.push({ file }); continue; }
    onProgress?.(done, total);
    const upload = await uploadChatFile(api, agentId, file, (sent) => onProgress?.(done + sent, total));
    done += file.size;
    onProgress?.(done, total);
    items.push({ file, upload });
  }
  return chatEnvelope(message, items);
}
