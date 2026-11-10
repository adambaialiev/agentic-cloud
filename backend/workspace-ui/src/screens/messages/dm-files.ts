/**
 * Files in direct messages (note #1125; Adam, 10 Nov 2026: "direct messages
 * should support file attachments").
 *
 * The bytes live on the workplace's own messaging machine, beside the words,
 * and are read through the backend with the reader's own session — the same
 * membership rules as the conversation. Nothing here keeps them: the browser's
 * kept conversation (messages-cache.ts) holds the message rows, whose files
 * are names, sizes and ids.
 *
 * A picture is drawn in the bubble from a small copy THIS browser made when
 * it was picked (`makeDirectMessageThumb`, a 640 px JPEG), so a phone does not
 * pull a 10 MB photo to show a thumbnail; a tap opens the full picture in the
 * shared viewer. One sent with no small copy (the Chief of Staff's, from the
 * command line) is drawn from its full bytes when they are small enough, and
 * named otherwise. Anything else is its name, its size and a download.
 */
import {
  DIRECT_MESSAGE_INLINE_FULL_MAX_BYTES, DIRECT_MESSAGE_THUMB_SIDE, directMessageFilesLabel, isDirectMessageImage, sentViaChiefOfStaff,
  type DirectMessage, type DirectMessageFile,
} from '../../../../src/shared/direct-messages.js';
import { WORKSPACE_API_BASE } from '../../../../src/shared/workspace-routes.js';
import { reportPreview } from '../chat/report-fold.js';

export type DirectMessageFileMode = 'thumb' | 'full' | 'download';

/** Our own address for one file of a conversation, read with the reader's session. */
export function directMessageFileUrl(orgId: string | null | undefined, peerId: string, fileId: string, mode: DirectMessageFileMode): string {
  const query = new URLSearchParams();
  if (orgId) query.set('org', orgId);
  if (mode === 'thumb') query.set('thumb', '1');
  if (mode === 'download') query.set('download', '1');
  return `${WORKSPACE_API_BASE}/api/messages/${encodeURIComponent(peerId)}/files/${encodeURIComponent(fileId)}?${query}`;
}

/** Whether the bubble can draw this file as a picture, and from which bytes. */
export function directMessagePictureSource(file: DirectMessageFile): DirectMessageFileMode | null {
  if (!isDirectMessageImage(file)) return null;
  if (file.thumb) return 'thumb';
  return file.size <= DIRECT_MESSAGE_INLINE_FULL_MAX_BYTES ? 'full' : null;
}

/** The pictures a browser can turn into a small copy. */
const THUMBABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * A small JPEG copy of a picked picture, longest side 640 px, drawn the way
 * the picture is meant to stand (its EXIF turn applied). Null when this
 * browser cannot decode it — the file then goes without one.
 */
export async function makeDirectMessageThumb(file: Blob): Promise<Blob | null> {
  if (!THUMBABLE.has(file.type) || typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, DIRECT_MESSAGE_THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); return null; }
    // A transparent picture gets a white ground rather than JPEG's black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.82); });
  } catch {
    return null;
  }
}

/** The list's one line for a message: its words, or — files alone — "Photo", "3 photos", a file's name. */
export function directMessagePreview(message: DirectMessage): string {
  const words = sentViaChiefOfStaff(message) ? reportPreview(message.text) : message.text;
  if (words.trim()) return words;
  return directMessageFilesLabel(message.files);
}
