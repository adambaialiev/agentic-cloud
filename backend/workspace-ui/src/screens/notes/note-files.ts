/**
 * A file onto a note, and a file off one.
 *
 * Raw bytes with the name in a header — the shape the route takes, because
 * multipart parsing buys nothing when the request IS the file. The client
 * merges the CSRF header itself for the same reason the legacy page does: a
 * `headers` of our own REPLACES the one the wrapper would have attached
 * rather than joining it.
 */

import type {
  WorkspaceFileAccessAnswer,
  WorkspaceNoteFilesAnswer,
} from '../../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../../api/client.js';
import { safeFileName } from '../../ui/file-kind.js';
import { sendInParts } from '../../ui/parted-upload.js';
import { UPLOAD_PART_BYTES, type PartedUploadPart, type PartedUploadStart } from '../../../../src/shared/uploads.js';

export function noteFilePath(number: number, id: string): string {
  return `api/notes/${encodeURIComponent(number)}/files/${encodeURIComponent(id)}`;
}

/** One file onto a note that already EXISTS. A file bigger than one upload
 *  part (8 MB) goes in parts, up to 100 MB (note #784), and `onProgress`
 *  hears it move; a smaller one is one request. */
export function putNoteFile(
  api: WorkspaceApi,
  number: number,
  file: File,
  onProgress?: (sent: number, total: number) => void,
): Promise<WorkspaceNoteFilesAnswer> {
  const base = `api/notes/${encodeURIComponent(number)}/files`;
  const fileName = safeFileName(file.name);
  if (file.size > UPLOAD_PART_BYTES) {
    const at = (started: PartedUploadStart, rest: string, query: Record<string, string> = {}) => (
      `${base}/uploads/${encodeURIComponent(started.id)}${rest}?${new URLSearchParams({ upload: started.uploadId, name: fileName, ...query })}`
    );
    const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return sendInParts(file, {
      start: () => api.api<PartedUploadStart>(`${base}/uploads`, json({ fileName, sizeBytes: file.size, contentType: file.type })),
      part: (started, partNumber, body) => api.api<PartedUploadPart>(at(started, `/parts/${partNumber}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body,
      }),
      complete: (started, parts) => api.api<WorkspaceNoteFilesAnswer>(`${base}/uploads/${encodeURIComponent(started.id)}/complete`,
        json({ uploadId: started.uploadId, fileName, contentType: file.type, parts })),
      abort: (started) => api.api(at(started, ''), { method: 'DELETE' }),
    }, onProgress);
  }
  return api.api<WorkspaceNoteFilesAnswer>(base, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      // The server takes only tame names — they are storage path segments and
      // the CLI's handles — so tame it HERE rather than refusing the reader's
      // own photo over its name.
      'x-note-file-name': fileName,
    },
    body: file,
  });
}

/** Take one off. */
export function deleteNoteFile(
  api: WorkspaceApi,
  number: number,
  id: string,
): Promise<WorkspaceNoteFilesAnswer> {
  return api.api<WorkspaceNoteFilesAnswer>(noteFilePath(number, id), { method: 'DELETE' });
}

/**
 * A fresh signed URL for one file, minted at TAP time — one minted when the
 *  screen opened could be dead by the time of the tap.
 *
 * `preview` is the caller saying it is about to DRAW this file rather than
 * hand it to the browser to save: the photograph in a note's files card, or a
 * PDF about to be framed full screen (note #403). The route signs an inline
 * disposition only for the kinds the Workspace actually draws, so asking for
 * it on anything else costs nothing and changes nothing.
 */
export function noteFileAccess(
  api: WorkspaceApi,
  number: number,
  id: string,
  preview = false,
): Promise<WorkspaceFileAccessAnswer> {
  const path = preview ? `${noteFilePath(number, id)}?preview=1` : noteFilePath(number, id);
  return api.api<WorkspaceFileAccessAnswer>(path);
}
