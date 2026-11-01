/**
 * The request every way of writing mail sends (note #509, slice 12), kept
 * apart from the components in MailOutgoing.tsx so that file exports only
 * components.
 */

import { MAIL_UPLOAD_CONTENT_TYPE } from '../../../../src/shared/workspace-mail.js';
import { jsonBody, type WorkspaceApi } from '../../api/client.js';
import { safeFileName } from '../../ui/file-kind.js';

/** A file the person picked, with a key that survives removing its neighbour. */
export interface MailPick { key: string; file: File }

/** Send, reply or forward: JSON when there are only words — what the server
 *  has always taken — and the upload envelope when files go too. */
export function mailPost<T>(api: WorkspaceApi, path: string, fields: Record<string, unknown>, files: File[]): Promise<T> {
  if (!files.length) return api.api<T>(path, jsonBody(fields));
  const manifest = new TextEncoder().encode(JSON.stringify({
    ...fields,
    files: files.map((file) => ({
      fileName: safeFileName(file.name),
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    })),
  }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, manifest.byteLength);
  return api.api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': MAIL_UPLOAD_CONTENT_TYPE },
    body: new Blob([prefix, manifest, ...files], { type: MAIL_UPLOAD_CONTENT_TYPE }),
  });
}

/** The boxes as the request carries them: filled ones only. */
export function mailCcAddresses(cc: string[]): string[] {
  return cc.map((box) => box.trim()).filter(Boolean);
}
