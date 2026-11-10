/** Private, workplace-scoped human conversations. IDs are ordered cursors. */
/** Whether any door to direct messages is offered (see routes/workspace.ts). */
export const DIRECT_MESSAGES_OFFERED = true;
export const DIRECT_MESSAGE_MAX_LENGTH = 8000;
export const DIRECT_MESSAGE_PAGE_SIZE = 50;
/**
 * Note #1125 (Adam, 10 Nov 2026: "direct messages should support file
 * attachments"). A file rides a message; its bytes live on the workplace's
 * own messaging machine beside the words, and the platform keeps neither.
 */
export interface DirectMessageFile {
  /** `f` + 24 hex, the messaging machine's own id. */
  id: string;
  name: string;
  /** For a picture, what its bytes ARE (sniffed by the backend); otherwise what the sender said. */
  type: string;
  size: number;
  width?: number;
  height?: number;
  /** A small copy the sender's browser made, for the bubble. */
  thumb?: boolean;
}
export interface DirectMessage {
  id: number;
  senderId: string;
  /** May be empty when the message is files alone. */
  text: string;
  createdAt: string;
  clientId: string;
  files?: DirectMessageFile[];
}

/** One file's ceiling. 1 GB volume: ~40 files this size, or ~300 phone photos (note #1125). */
export const DIRECT_MESSAGE_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const DIRECT_MESSAGE_FILES_PER_MESSAGE = 10;
/** A picture's small copy (the browser makes it ~640 px JPEG, well under this). */
export const DIRECT_MESSAGE_THUMB_MAX_BYTES = 512 * 1024;
/** The small copy's longest side, in pixels. */
export const DIRECT_MESSAGE_THUMB_SIDE = 640;
/** A picture with no small copy is drawn from its full bytes only up to this. */
export const DIRECT_MESSAGE_INLINE_FULL_MAX_BYTES = 8 * 1024 * 1024;

/** The pictures drawn inline. SVG is a document that can carry script, never one of them. */
export const DIRECT_MESSAGE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export function isDirectMessageImage(file: Pick<DirectMessageFile, 'type'>): boolean {
  return (DIRECT_MESSAGE_IMAGE_TYPES as readonly string[]).includes(file.type);
}

/** What a picture's first bytes say it is — the only witness trusted for drawing one. */
export function sniffDirectMessageImage(bytes: Uint8Array): (typeof DIRECT_MESSAGE_IMAGE_TYPES)[number] | null {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** A picture's width and height from its header, or null when it cannot be read. */
export function directMessageImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffDirectMessageImage(bytes);
  const u16be = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const u16le = (i: number) => bytes[i]! | (bytes[i + 1]! << 8);
  const u32be = (i: number) => ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!;
  const ok = (width: number, height: number) => (width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : null);
  if (bytes.length < 30) return null;
  if (type === 'image/png') return ok(u32be(16), u32be(20));
  if (type === 'image/gif') return ok(u16le(6), u16le(8));
  if (type === 'image/webp') {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (chunk === 'VP8 ') return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const b = (i: number) => bytes[21 + i]!;
      return ok(1 + (((b(1) & 0x3f) << 8) | b(0)), 1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)));
    }
    if (chunk === 'VP8X') return ok(1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)));
    return null;
  }
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = u16be(i + 2);
      // Start-of-frame markers, not the huffman (c4), JPG (c8) or arithmetic (cc) ones.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

/** "Photo", "3 photos", "report.pdf", "2 files" — what a list says for a message's files. */
export function directMessageFilesLabel(files: DirectMessageFile[] | undefined): string {
  if (!files?.length) return '';
  if (files.every(isDirectMessageImage)) return files.length === 1 ? 'Photo' : `${files.length} photos`;
  return files.length === 1 ? files[0]!.name : `${files.length} files`;
}

/** "2.4 MB", "830 KB", "12 bytes". */
export function directMessageFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
export interface DirectMessagePerson {
  userId: string;
  name: string;
  photoUrl?: string;
  available: boolean;
}
export interface DirectMessageThread {
  person: DirectMessagePerson;
  lastMessage: DirectMessage;
  unread: number;
}
export interface DirectMessageInbox {
  threads: DirectMessageThread[];
  unread: number;
}
export interface DirectMessagePage {
  orgName: string;
  person: DirectMessagePerson;
  viewerId: string;
  messages: DirectMessage[];
  hasMore: boolean;
}

/**
 * Note #1090 (Adam, 9 Nov 2026: "Chief of Staff should be able to send
 * message through agentbuilt cli"). A message the person released from their
 * Chief of Staff's card is an ordinary message of theirs, sent with a request
 * id that starts with this prefix — the ONE mark it carries. The messaging
 * machine already keeps and returns every message's request id, so the mark
 * needs no new column there, works on machines built before it, and the
 * platform stores nothing about it. A browser cannot send it
 * (`crypto.randomUUID()` never starts with a "v", and the browser route
 * refuses the prefix), so only the card's tap writes it.
 */
export const DIRECT_MESSAGE_VIA_PREFIX = 'via-cos-';
export function sentViaChiefOfStaff(message: Pick<DirectMessage, 'clientId'>): boolean {
  return typeof message.clientId === 'string' && message.clientId.startsWith(DIRECT_MESSAGE_VIA_PREFIX);
}

/**
 * The Chief of Staff's draft to one teammate, as the person's card sees it.
 * `text` is there only while it waits for the tap: once it is decided — sent,
 * not sent, or expired — the platform keeps no words of it (note #608's
 * storage rule); the message itself lives only on the messaging machine.
 */
export type DirectMessageApprovalStatus = 'pending' | 'sending' | 'sent' | 'rejected' | 'expired';
export interface DirectMessageApproval {
  id: string;
  /** The teammate it goes to, by id (the card's door) and name. */
  to: { userId: string; name: string };
  text?: string;
  /** Note #1125: the files it carries, while it waits (their bytes wait on the messaging machine). */
  files?: DirectMessageFile[];
  status: DirectMessageApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  error?: string;
}
export interface DirectMessageApprovalAnswer { approval: DirectMessageApproval }
/** A draft nobody answered stops being sendable, and its words go. */
export const DIRECT_MESSAGE_APPROVAL_TTL_MS = 24 * 60 * 60_000;
