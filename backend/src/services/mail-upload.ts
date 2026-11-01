import {
  MAIL_OUT_FILE_MAX_BYTES,
  MAIL_OUT_MAX_FILES,
  MAIL_OUT_TOTAL_MAX_BYTES,
} from '../shared/workspace-mail.js';
import type { MailFileUpload } from './mail-outbox.js';

/**
 * A send, reply or forward as a route receives it (note #509, slice 12).
 *
 * Words only, it is plain JSON, exactly as it always was — so a Workspace tab
 * or an agent CLI older than this slice keeps working. With files, it is the
 * chat composer's envelope under `MAIL_UPLOAD_CONTENT_TYPE`: four big-endian
 * bytes saying how long the UTF-8 JSON manifest is, the manifest (the
 * message's own fields, and `files: [{ fileName, contentType, sizeBytes }]`),
 * then each file's bytes in order. No base64 on the way in.
 *
 * This reads the SHAPE and nothing else. Whether a file may go — its name,
 * its kind, the totals — is the outbox's decision, made once for every door.
 */

/** Words, subject, addresses and the files' descriptions. Twenty thousand
 *  characters of words is at most eighty thousand bytes of UTF-8. */
export const MAIL_UPLOAD_MANIFEST_MAX_BYTES = 256 * 1024;
const PREFIX_BYTES = 4;
/** The most a route should take off the wire for one message. */
export const MAIL_UPLOAD_MAX_BYTES = PREFIX_BYTES + MAIL_UPLOAD_MANIFEST_MAX_BYTES + MAIL_OUT_TOTAL_MAX_BYTES;

export type MailUpload =
  | { fields: Record<string, unknown>; files: MailFileUpload[] }
  | { error: string };

const MALFORMED = 'That upload is malformed.';

export function readMailUpload(body: unknown): MailUpload {
  if (!Buffer.isBuffer(body)) {
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return { fields, files: [] };
  }
  if (body.length < PREFIX_BYTES) return { error: MALFORMED };
  const manifestLength = body.readUInt32BE(0);
  const filesAt = PREFIX_BYTES + manifestLength;
  if (manifestLength <= 0 || manifestLength > MAIL_UPLOAD_MANIFEST_MAX_BYTES || filesAt > body.length) {
    return { error: MALFORMED };
  }
  const manifestBytes = body.subarray(PREFIX_BYTES, filesAt);
  const manifestText = manifestBytes.toString('utf8');
  // Buffer's decoder replaces malformed sequences; round-tripping makes that
  // a refusal instead of silently changing somebody's words.
  if (!Buffer.from(manifestText, 'utf8').equals(manifestBytes)) return { error: 'Those words are not valid UTF-8.' };
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { error: MALFORMED };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { error: MALFORMED };
  const { files: described, ...fields } = manifest as Record<string, unknown>;
  if (!Array.isArray(described)) return { error: MALFORMED };
  if (described.length > MAIL_OUT_MAX_FILES) return { error: `A message carries at most ${MAIL_OUT_MAX_FILES} files.` };
  const files: MailFileUpload[] = [];
  let offset = filesAt;
  for (const value of described) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: MALFORMED };
    const file = value as { fileName?: unknown; contentType?: unknown; sizeBytes?: unknown };
    const size = file.sizeBytes;
    if (typeof file.fileName !== 'string' || !Number.isSafeInteger(size) || (size as number) <= 0
      || (typeof file.contentType === 'string' && file.contentType.length > 200)
      || offset + (size as number) > body.length) {
      return { error: MALFORMED };
    }
    if ((size as number) > MAIL_OUT_FILE_MAX_BYTES) {
      return { error: `${file.fileName.slice(0, 80)} is larger than 10 MB, which is the most one file here can be.` };
    }
    const end = offset + (size as number);
    files.push({
      fileName: file.fileName,
      ...(typeof file.contentType === 'string' && file.contentType.trim() ? { contentType: file.contentType.trim() } : {}),
      data: body.subarray(offset, end),
    });
    offset = end;
  }
  // Every byte must be described: trailing data is not a hidden sixth file,
  // and a short body must not silently cut the last one off.
  if (offset !== body.length) return { error: MALFORMED };
  return { fields, files };
}
