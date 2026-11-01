/**
 * Send a big file in parts (note #784, `shared/uploads.ts`): start, the parts
 * — a few at a time, each retried before the whole upload gives up — then
 * complete. Any failure cancels the upload, so nothing half-sent is kept.
 * `onProgress` hears the bytes the server has taken, part by part, which is
 * what a phone on a slow link needs to see moving.
 *
 * The caller says how to reach its own routes (Drive's, a note's); this only
 * knows the order of the calls and what to do when one fails.
 */

import type { PartedUploadPart, PartedUploadStart } from '../../../src/shared/uploads.js';

export interface PartedUploadDoors<T> {
  start: () => Promise<PartedUploadStart>;
  part: (started: PartedUploadStart, partNumber: number, body: Blob) => Promise<PartedUploadPart>;
  complete: (started: PartedUploadStart, parts: PartedUploadPart[]) => Promise<T>;
  abort: (started: PartedUploadStart) => Promise<unknown>;
}

const PARTS_AT_ONCE = 3;
const TRIES_PER_PART = 3;

export async function sendInParts<T>(file: Blob, doors: PartedUploadDoors<T>, onProgress?: (sent: number, total: number) => void): Promise<T> {
  const started = await doors.start();
  const done: PartedUploadPart[] = [];
  let sent = 0;
  let next = 1;
  onProgress?.(0, file.size);
  const lane = async () => {
    while (next <= started.parts) {
      const number = next;
      next += 1;
      const body = file.slice((number - 1) * started.partBytes, number * started.partBytes);
      let lastError: unknown;
      for (let attempt = 1; attempt <= TRIES_PER_PART; attempt += 1) {
        try {
          done.push(await doors.part(started, number, body));
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < TRIES_PER_PART) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
      if (lastError) throw lastError;
      sent += body.size;
      onProgress?.(sent, file.size);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARTS_AT_ONCE, started.parts) }, lane));
    return await doors.complete(started, done.sort((a, b) => a.partNumber - b.partNumber));
  } catch (error) {
    next = started.parts + 1;
    try { await doors.abort(started); } catch { /* the upload is gone either way */ }
    throw error;
  }
}

/** "34%", for a status line under a big upload. */
export function uploadPercent(sent: number, total: number): string {
  return `${total ? Math.floor((sent / total) * 100) : 0}%`;
}
