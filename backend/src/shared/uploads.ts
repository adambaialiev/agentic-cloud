/**
 * A big file sent in parts (note #784). The Workspace's front door refuses a
 * request body over 100 MB, and a 1 GB file must never sit whole in anybody's
 * memory, so a client sends a file larger than one part as numbered parts:
 * start (the server opens a multipart upload in the bucket), one request per
 * part (each goes straight on into it), then complete (the bucket stitches
 * them and only now does the file exist). Cancel throws the parts away.
 * Drive and note files speak the same protocol.
 */

/** One part's size. S3 needs at least 5 MiB for every part but the last;
 *  8 MiB keeps a phone's retry of one part cheap and a 1 GB file at 128. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/** How many parts a file of this size is sent in. */
export function uploadPartCount(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_BYTES));
}

/** POST …/uploads answers this: where the parts go, and how big each is. */
export interface PartedUploadStart {
  id: string;
  uploadId: string;
  partBytes: number;
  parts: number;
}

/** PUT …/uploads/:id/parts/:n answers this; complete sends them all back. */
export interface PartedUploadPart {
  partNumber: number;
  etag: string;
}

/** An unfinished upload older than this is thrown away by the next start. */
export const UPLOAD_STALE_AFTER_MS = 24 * 60 * 60_000;
