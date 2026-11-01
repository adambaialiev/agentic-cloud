import pathPosix from 'node:path/posix';
import type { AttachmentRecord, UploadedFileMediaKind, UploadedFileRenderMode } from '../types/tools.js';

export const SESSION_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** What a file is called when nothing knows what it is: the fallback for an
 *  extension we have no entry for, and the header a raw-bytes upload sends
 *  because it has nothing truer to say. Named because `inferContentType` has
 *  to tell that second case apart from a real claim. */
const GENERIC_BINARY_CONTENT_TYPE = 'application/octet-stream';

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*[a-z0-9_-]+=[^;]+)*$/i.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export function sanitizeStorageSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180);
  return sanitized || fallback;
}

export function inferContentType(fileName: string, override?: string): string {
  const normalizedOverride = normalizeContentType(override);
  // `application/octet-stream` is not a claim about the bytes — it is the
  // ABSENCE of one, and the only honest header a raw-bytes upload can send.
  // Every `agentbuilt … attach` does exactly that (the request body IS the
  // file, so there is nothing else to put there), and taking it as an
  // override meant a screenshot pushed from an agent was stored as a generic
  // blob and could never match the image branch on any screen: Alex's PNG on
  // proposal #167 drew as a grey document row saying "kpage-files.png"
  // (Owner, note #22, with a photo of it). A file picked in the Workspace
  // came through fine, because a browser sends the real type — so the same
  // picture rendered or did not depending only on who attached it.
  //
  // The name is the better witness in that case, and deferring to it costs
  // nothing: a `.png` that is not one still fails to decode and falls back to
  // a row, and every read URL these files are served on carries a save-as
  // disposition, so nothing here decides whether bytes run — only whether a
  // screen is allowed to try drawing them.
  if (normalizedOverride && normalizedOverride !== GENERIC_BINARY_CONTENT_TYPE) {
    return normalizedOverride;
  }

  const extension = pathPosix.extname(fileName).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? GENERIC_BINARY_CONTENT_TYPE;
}

export function resolveAttachmentRenderMode(
  contentType: string,
): { mediaKind: UploadedFileMediaKind; renderAs: Exclude<UploadedFileRenderMode, 'auto'> } {
  if (contentType.startsWith('image/') && contentType !== 'image/svg+xml') {
    return { mediaKind: 'image', renderAs: 'image' };
  }

  if (contentType.startsWith('video/')) {
    return { mediaKind: 'video', renderAs: 'video' };
  }

  if (contentType.startsWith('audio/')) {
    return { mediaKind: 'audio', renderAs: 'audio' };
  }

  return { mediaKind: 'download', renderAs: 'download' };
}

export function buildSessionAttachmentStoragePath(
  userId: string,
  sessionId: string,
  fileId: string,
  fileName: string,
): string {
  const safeUserId = sanitizeStorageSegment(userId, 'user');
  const safeSessionId = sanitizeStorageSegment(sessionId, 'session');
  const safeFileId = sanitizeStorageSegment(fileId, 'file');
  const safeFileName = sanitizeStorageSegment(pathPosix.basename(fileName), 'upload.bin');

  return [
    'users',
    safeUserId,
    'sessions',
    safeSessionId,
    'files',
    safeFileId,
    safeFileName,
  ].join('/');
}
