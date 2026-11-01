import { randomUUID } from 'node:crypto';
import type { MediaStorage } from './media-storage.js';
import { inferContentType } from './session-attachments.js';
import {
  AGENT_CHAT_FILE_MAX_BYTES,
  agentChatFileTooBig,
  validateAgentChatAttachment,
} from './agent-chat-storage.js';
import {
  UPLOAD_PART_BYTES, UPLOAD_STALE_AFTER_MS, uploadPartCount, type PartedUploadPart, type PartedUploadStart,
} from '../shared/uploads.js';

/**
 * A chat file in parts (note #943): the protocol Drive and note files speak
 * (`shared/uploads.ts`), for the files a person sends an agent. There is no
 * product cap on a chat file any more; what one request may carry is still
 * bounded by the edge in front of the backend (Cloudflare refuses a body over
 * 100 MB), so a big file goes up as 8 MB parts, each passed straight on into
 * one multipart upload in the workplace's bucket, and this server never holds
 * more of it than one part.
 *
 * Nothing is on the chat until the MESSAGE is sent: `complete` only stitches
 * the object, and the send names it by its id (`upload` in the envelope's
 * manifest), which is when the row is written and the file staged for the
 * turn. An upload whose message never goes is an object under the agent's
 * chat prefix that nothing points at — cleared with the agent's chat files.
 */
export class ChatFileUploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where one conversation's files go: its prefix, and one file's path under it. */
export interface ChatFileUploadPlace {
  prefix: string;
  path: (fileId: string, fileName: string) => string;
}

type Parted = Required<Pick<MediaStorage, 'startMultipart' | 'uploadPart' | 'completeMultipart' | 'abortMultipart'>>;

/** True for a string the parted protocol could have minted as a file id. */
export function isChatUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID.test(value);
}

export class ChatFileUploads {
  constructor(private readonly media: MediaStorage, private readonly place: ChatFileUploadPlace) {}

  private parted(): Parted {
    const media = this.media;
    if (!media.startMultipart || !media.uploadPart || !media.completeMultipart || !media.abortMultipart) {
      throw new ChatFileUploadError(503, 'This backend cannot take big files yet.');
    }
    return media as MediaStorage & Parted;
  }

  private path(id: string, fileName: unknown): string {
    if (!isChatUploadId(id)) throw new ChatFileUploadError(404, 'That upload is not here.');
    const name = typeof fileName === 'string' ? fileName.trim() : '';
    const refusal = validateAgentChatAttachment({ fileName: name, sizeBytes: 1 });
    if (refusal) throw new ChatFileUploadError(400, refusal);
    return this.place.path(id, name);
  }

  async start(args: { fileName: unknown; sizeBytes: unknown; contentType?: unknown }): Promise<PartedUploadStart> {
    const fileName = typeof args.fileName === 'string' ? args.fileName.trim() : '';
    const sizeBytes = Number(args.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes)) throw new ChatFileUploadError(400, 'Say how big the file is.');
    const refusal = validateAgentChatAttachment({ fileName, sizeBytes });
    if (refusal) throw new ChatFileUploadError(sizeBytes > AGENT_CHAT_FILE_MAX_BYTES ? 413 : 400, refusal);
    const id = randomUUID();
    const contentType = inferContentType(fileName, typeof args.contentType === 'string' ? args.contentType : undefined);
    const { uploadId } = await this.parted().startMultipart({ storagePath: this.path(id, fileName), contentType });
    void this.media.abortStaleMultiparts?.({
      prefix: this.place.prefix, olderThan: new Date(Date.now() - UPLOAD_STALE_AFTER_MS),
    }).catch(() => 0);
    return { id, uploadId, partBytes: UPLOAD_PART_BYTES, parts: uploadPartCount(sizeBytes) };
  }

  async part(id: string, args: { uploadId: unknown; fileName: unknown; partNumber: unknown; data: Buffer }): Promise<PartedUploadPart> {
    const storagePath = this.path(id, args.fileName);
    const partNumber = Number(args.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > uploadPartCount(AGENT_CHAT_FILE_MAX_BYTES)) {
      throw new ChatFileUploadError(400, 'That part number is not one of this file’s.');
    }
    if (typeof args.uploadId !== 'string' || !args.uploadId) throw new ChatFileUploadError(400, 'Say which upload this part belongs to.');
    if (args.data.length > UPLOAD_PART_BYTES) throw new ChatFileUploadError(413, 'A part can be up to 8 MB.');
    const { etag } = await this.parted().uploadPart({ storagePath, uploadId: args.uploadId, partNumber, data: args.data });
    return { partNumber, etag };
  }

  /** Stitch the parts. The answer is what the envelope's manifest names. */
  async complete(id: string, args: { uploadId: unknown; fileName: unknown; parts: unknown }): Promise<{ id: string; fileName: string; sizeBytes: number }> {
    const storagePath = this.path(id, args.fileName);
    const fileName = String(args.fileName).trim();
    if (typeof args.uploadId !== 'string' || !args.uploadId) throw new ChatFileUploadError(400, 'Say which upload to finish.');
    const parts = Array.isArray(args.parts) ? args.parts.map((part: { partNumber?: unknown; etag?: unknown }) => ({
      partNumber: Number(part?.partNumber), etag: String(part?.etag ?? ''),
    })) : [];
    if (!parts.length || parts.some((part) => !Number.isInteger(part.partNumber) || !part.etag)) {
      throw new ChatFileUploadError(400, 'Send the parts this upload was made of.');
    }
    const { sizeBytes } = await this.parted().completeMultipart({ storagePath, uploadId: args.uploadId, parts });
    if (sizeBytes > AGENT_CHAT_FILE_MAX_BYTES) {
      await this.media.deleteObject?.({ storagePath }).catch(() => undefined);
      throw new ChatFileUploadError(413, agentChatFileTooBig(sizeBytes));
    }
    return { id, fileName, sizeBytes };
  }

  async abort(id: string, args: { uploadId: unknown; fileName: unknown }): Promise<void> {
    if (typeof args.uploadId !== 'string' || !args.uploadId) return;
    const storagePath = this.path(id, args.fileName);
    await this.parted().abortMultipart({ storagePath, uploadId: args.uploadId }).catch(() => undefined);
  }
}
