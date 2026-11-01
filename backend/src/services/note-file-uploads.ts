import { randomUUID } from 'node:crypto';
import type { MediaStorage } from './media-storage.js';
import { inferContentType } from './session-attachments.js';
import {
  QUICK_NOTE_ATTACHMENT_MAX_BYTES,
  quickNoteAttachmentPath,
  quickNoteStoragePrefix,
  validateQuickNoteAttachment,
  type QuickNoteAttachment,
  type QuickNoteDocument,
} from '../types/quick-note.js';
import {
  UPLOAD_PART_BYTES, UPLOAD_STALE_AFTER_MS, uploadPartCount, type PartedUploadPart, type PartedUploadStart,
} from '../shared/uploads.js';

/**
 * A note's file in parts (note #784): the same protocol as Drive's
 * (`shared/uploads.ts`), for both doors — the Workspace's and the agent
 * CLI's. Nothing is written onto the note until `complete`, and the file is
 * checked against the note again then: another file may have taken its name
 * or the last of the five places while the parts were on their way.
 */
export class NoteFileUploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Parted = Required<Pick<MediaStorage, 'startMultipart' | 'uploadPart' | 'completeMultipart' | 'abortMultipart'>>;

export class NoteFileUploads {
  constructor(private readonly media: MediaStorage) {}

  private parted(): Parted {
    const media = this.media;
    if (!media.startMultipart || !media.uploadPart || !media.completeMultipart || !media.abortMultipart) {
      throw new NoteFileUploadError(503, 'This backend cannot take big files yet.');
    }
    return media as MediaStorage & Parted;
  }

  /** Where this upload's object goes: the note's own prefix, named. */
  private path(doc: QuickNoteDocument, id: string, fileName: unknown): string {
    if (!UPLOAD_ID.test(id)) throw new NoteFileUploadError(404, 'That upload is not here.');
    const name = typeof fileName === 'string' ? fileName.trim() : '';
    const refusal = validateQuickNoteAttachment({ fileName: name, sizeBytes: 1, existing: [] });
    if (refusal) throw new NoteFileUploadError(400, refusal);
    return quickNoteAttachmentPath(doc.userId, doc.id, id, name);
  }

  async start(doc: QuickNoteDocument, args: { fileName: unknown; sizeBytes: unknown; contentType?: unknown }): Promise<PartedUploadStart> {
    const fileName = typeof args.fileName === 'string' ? args.fileName.trim() : '';
    const sizeBytes = Number(args.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes)) throw new NoteFileUploadError(400, 'Say how big the file is.');
    const refusal = validateQuickNoteAttachment({ fileName, sizeBytes, existing: doc.attachments ?? [] });
    if (refusal) throw new NoteFileUploadError(sizeBytes > QUICK_NOTE_ATTACHMENT_MAX_BYTES ? 413 : 400, refusal);
    const parted = this.parted();
    const id = randomUUID();
    const contentType = inferContentType(fileName, typeof args.contentType === 'string' ? args.contentType : undefined);
    const { uploadId } = await parted.startMultipart({ storagePath: this.path(doc, id, fileName), contentType });
    void this.media.abortStaleMultiparts?.({
      prefix: quickNoteStoragePrefix(doc.userId, doc.id), olderThan: new Date(Date.now() - UPLOAD_STALE_AFTER_MS),
    }).catch(() => 0);
    return { id, uploadId, partBytes: UPLOAD_PART_BYTES, parts: uploadPartCount(sizeBytes) };
  }

  async part(doc: QuickNoteDocument, id: string, args: { uploadId: unknown; fileName: unknown; partNumber: unknown; data: Buffer }): Promise<PartedUploadPart> {
    const storagePath = this.path(doc, id, args.fileName);
    const partNumber = Number(args.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > uploadPartCount(QUICK_NOTE_ATTACHMENT_MAX_BYTES)) {
      throw new NoteFileUploadError(400, 'That part number is not one of this file’s.');
    }
    if (typeof args.uploadId !== 'string' || !args.uploadId) throw new NoteFileUploadError(400, 'Say which upload this part belongs to.');
    if (args.data.length > UPLOAD_PART_BYTES) throw new NoteFileUploadError(413, 'A part can be up to 8 MB.');
    const { etag } = await this.parted().uploadPart({ storagePath, uploadId: args.uploadId, partNumber, data: args.data });
    return { partNumber, etag };
  }

  /** Stitch the parts and answer the note's new file record — the caller
   *  writes it onto the note. A file the note can no longer take is deleted
   *  here, so a refusal leaves nothing behind. */
  async complete(doc: QuickNoteDocument, id: string, args: {
    uploadId: unknown; fileName: unknown; contentType?: unknown; parts: unknown;
    addedBy: Pick<QuickNoteAttachment, 'addedByAgentId' | 'addedByUserId'>;
  }): Promise<QuickNoteAttachment> {
    const storagePath = this.path(doc, id, args.fileName);
    const fileName = String(args.fileName).trim();
    if (typeof args.uploadId !== 'string' || !args.uploadId) throw new NoteFileUploadError(400, 'Say which upload to finish.');
    const parts = Array.isArray(args.parts) ? args.parts.map((part: { partNumber?: unknown; etag?: unknown }) => ({
      partNumber: Number(part?.partNumber), etag: String(part?.etag ?? ''),
    })) : [];
    if (!parts.length || parts.some((part) => !Number.isInteger(part.partNumber) || !part.etag)) {
      throw new NoteFileUploadError(400, 'Send the parts this upload was made of.');
    }
    const { sizeBytes } = await this.parted().completeMultipart({ storagePath, uploadId: args.uploadId, parts });
    const refusal = validateQuickNoteAttachment({ fileName, sizeBytes, existing: doc.attachments ?? [] });
    if (refusal) {
      await this.media.deleteObject?.({ storagePath }).catch(() => undefined);
      throw new NoteFileUploadError(sizeBytes > QUICK_NOTE_ATTACHMENT_MAX_BYTES ? 413 : 400, refusal);
    }
    return {
      id,
      fileName,
      contentType: inferContentType(fileName, typeof args.contentType === 'string' ? args.contentType : undefined),
      sizeBytes,
      storagePath,
      ...args.addedBy,
      addedAt: new Date().toISOString(),
    };
  }

  async abort(doc: QuickNoteDocument, id: string, args: { uploadId: unknown; fileName: unknown }): Promise<void> {
    if (typeof args.uploadId !== 'string' || !args.uploadId) return;
    const storagePath = this.path(doc, id, args.fileName);
    await this.parted().abortMultipart({ storagePath, uploadId: args.uploadId }).catch(() => undefined);
  }

  /** The record failed to land after the bytes did: take the bytes away. */
  async discard(attachment: Pick<QuickNoteAttachment, 'storagePath'>): Promise<void> {
    await this.media.deleteObject?.({ storagePath: attachment.storagePath }).catch(() => undefined);
  }
}
