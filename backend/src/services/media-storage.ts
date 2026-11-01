export interface MediaStorageUploadTarget {
  uploadUrl: string;
  expiresAt: string;
}

export interface MediaStorageReadAccess {
  url: string;
  expiresAt: string;
}

export interface MediaStorage {
  createUploadTarget(args: {
    storagePath: string;
    contentType: string;
    expiresInMs?: number;
  }): Promise<MediaStorageUploadTarget>;
  uploadObject(args: {
    storagePath: string;
    contentType: string;
    data: Buffer | Uint8Array | ArrayBuffer;
  }): Promise<void>;
  createReadAccess(args: {
    storagePath: string;
    expiresInMs?: number;
    promptSaveAs?: string;
    responseDisposition?: string;
    /** Override the response's Cache-Control header without changing object metadata. */
    responseCacheControl?: string;
  }): Promise<MediaStorageReadAccess>;
  downloadObject(args: {
    storagePath: string;
  }): Promise<Buffer>;
  setMetadata(args: {
    storagePath: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<void>;
  deleteObject?(args: {
    storagePath: string;
  }): Promise<void>;
  deleteObjectsWithPrefix?(args: {
    prefix: string;
  }): Promise<void>;
  /**
   * A big file in parts (note #784): a Drive file can be 1 GB and a note's
   * 100 MB, and neither may cross the Workspace's front door in one request
   * (Cloudflare refuses a body over 100 MB) nor sit whole in our memory. So
   * the client sends parts, each goes straight on into one S3 multipart
   * upload, and the object exists only once `completeMultipart` stitches
   * them — an upload abandoned half-way leaves no object behind, only parts
   * `abortMultipart` (or the stale sweep) throws away.
   */
  startMultipart?(args: { storagePath: string; contentType: string }): Promise<{ uploadId: string }>;
  uploadPart?(args: { storagePath: string; uploadId: string; partNumber: number; data: Buffer }): Promise<{ etag: string }>;
  /** Stitch the parts; answers the finished object's real size. */
  completeMultipart?(args: {
    storagePath: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ sizeBytes: number }>;
  abortMultipart?(args: { storagePath: string; uploadId: string }): Promise<void>;
  /** Abort every unfinished multipart upload under `prefix` started before
   *  `olderThan`; answers how many went. */
  abortStaleMultiparts?(args: { prefix: string; olderThan: Date }): Promise<number>;
}

type SignedUrlAction = 'read' | 'write';

type StorageBucketFile = {
  getSignedUrl(options: {
    version: 'v4';
    action: SignedUrlAction;
    expires: Date;
    contentType?: string;
    promptSaveAs?: string;
    responseDisposition?: string;
  }): Promise<[string]>;
  setMetadata(metadata: {
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<unknown>;
  save(
    data: Buffer | Uint8Array | string,
    options?: {
      resumable?: boolean;
      metadata?: {
        contentType?: string;
        metadata?: Record<string, string>;
      };
    },
  ): Promise<unknown>;
  download(): Promise<[Buffer]>;
  delete(): Promise<unknown>;
};

type StorageBucket = {
  file(path: string): StorageBucketFile;
  deleteFiles(options: {
    prefix: string;
    force?: boolean;
  }): Promise<unknown>;
};

const DEFAULT_UPLOAD_URL_TTL_MS = 15 * 60_000;
const DEFAULT_READ_URL_TTL_MS = 6 * 24 * 60 * 60_000;

function expiryFromNow(expiresInMs: number): { expiresAtDate: Date; expiresAt: string } {
  const expiresAtDate = new Date(Date.now() + expiresInMs);
  return {
    expiresAtDate,
    expiresAt: expiresAtDate.toISOString(),
  };
}
