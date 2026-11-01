import { createHash, randomUUID } from 'node:crypto';
import type { MediaStorage, MediaStorageReadAccess, MediaStorageUploadTarget } from './media-storage.js';

/**
 * A MediaStorage that keeps real bytes in memory, multipart uploads included
 * (note #784) — for tests and browser harnesses that need a file to go in in
 * parts and come back out whole, with S3's rules: every part but the last at
 * least `minPartBytes`, an object that exists only once its parts are
 * stitched, and parts that vanish on abort. `readUrl` decides where a signed
 * read points (a harness serves the bytes from its own route).
 */
export class MemoryMediaStorage implements MediaStorage {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  readonly uploads = new Map<string, { storagePath: string; contentType: string; parts: Map<number, Buffer>; initiated: Date }>();

  constructor(private readonly options: { readUrl?: (storagePath: string) => string; minPartBytes?: number } = {}) {}

  async createUploadTarget(args: { storagePath: string }): Promise<MediaStorageUploadTarget> {
    return { uploadUrl: `memory://${args.storagePath}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async uploadObject(args: { storagePath: string; contentType: string; data: Buffer | Uint8Array | ArrayBuffer }): Promise<void> {
    const data = Buffer.from(args.data instanceof ArrayBuffer ? new Uint8Array(args.data) : args.data);
    this.objects.set(args.storagePath, { data, contentType: args.contentType });
  }
  async createReadAccess(args: { storagePath: string }): Promise<MediaStorageReadAccess> {
    return {
      url: this.options.readUrl?.(args.storagePath) ?? `memory://${args.storagePath}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  async downloadObject(args: { storagePath: string }): Promise<Buffer> {
    const object = this.objects.get(args.storagePath);
    if (!object) throw new Error(`No object at ${args.storagePath}`);
    return object.data;
  }
  async setMetadata(): Promise<void> {}
  async deleteObject(args: { storagePath: string }): Promise<void> {
    this.objects.delete(args.storagePath);
  }
  async deleteObjectsWithPrefix(args: { prefix: string }): Promise<void> {
    for (const key of [...this.objects.keys()]) if (key.startsWith(args.prefix)) this.objects.delete(key);
  }
  async startMultipart(args: { storagePath: string; contentType: string }): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { storagePath: args.storagePath, contentType: args.contentType, parts: new Map(), initiated: new Date() });
    return { uploadId };
  }
  async uploadPart(args: { storagePath: string; uploadId: string; partNumber: number; data: Buffer }): Promise<{ etag: string }> {
    const upload = this.uploads.get(args.uploadId);
    if (!upload || upload.storagePath !== args.storagePath) throw new Error('NoSuchUpload');
    upload.parts.set(args.partNumber, Buffer.from(args.data));
    return { etag: `"${createHash('md5').update(args.data).digest('hex')}"` };
  }
  async completeMultipart(args: { storagePath: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }): Promise<{ sizeBytes: number }> {
    const upload = this.uploads.get(args.uploadId);
    if (!upload || upload.storagePath !== args.storagePath) throw new Error('NoSuchUpload');
    const ordered = [...args.parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks = ordered.map((part, index) => {
      const data = upload.parts.get(part.partNumber);
      if (!data || `"${createHash('md5').update(data).digest('hex')}"` !== part.etag) throw new Error('InvalidPart');
      if (index < ordered.length - 1 && data.length < (this.options.minPartBytes ?? 5 * 1024 * 1024)) throw new Error('EntityTooSmall');
      return data;
    });
    const data = Buffer.concat(chunks);
    this.objects.set(args.storagePath, { data, contentType: upload.contentType });
    this.uploads.delete(args.uploadId);
    return { sizeBytes: data.length };
  }
  async abortMultipart(args: { storagePath: string; uploadId: string }): Promise<void> {
    const upload = this.uploads.get(args.uploadId);
    if (upload && upload.storagePath === args.storagePath) this.uploads.delete(args.uploadId);
  }
  async abortStaleMultiparts(args: { prefix: string; olderThan: Date }): Promise<number> {
    let aborted = 0;
    for (const [id, upload] of [...this.uploads]) {
      if (upload.storagePath.startsWith(args.prefix) && upload.initiated < args.olderThan) { this.uploads.delete(id); aborted += 1; }
    }
    return aborted;
  }
}
