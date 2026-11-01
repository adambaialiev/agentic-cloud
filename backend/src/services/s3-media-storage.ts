import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  MediaStorage,
  MediaStorageReadAccess,
  MediaStorageUploadTarget,
} from './media-storage.js';

const DEFAULT_UPLOAD_URL_TTL_MS = 15 * 60_000;
const DEFAULT_READ_URL_TTL_MS = 6 * 24 * 60 * 60_000;
/** SigV4 presigned URLs cannot outlive 7 days. */
const MAX_PRESIGN_TTL_MS = 7 * 24 * 60 * 60_000;

export interface S3MediaStorageConfig {
  /** Full endpoint URL, e.g. https://2-28-19-14.sslip.io */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO ignores the region but the SDK requires one. */
  region?: string;
  /** Bucket-in-path addressing; required for MinIO behind a single hostname. */
  forcePathStyle?: boolean;
}

function presignExpiry(expiresInMs: number): { expiresInSeconds: number; expiresAt: string } {
  const clampedMs = Math.max(1_000, Math.min(expiresInMs, MAX_PRESIGN_TTL_MS));
  return {
    expiresInSeconds: Math.floor(clampedMs / 1000),
    expiresAt: new Date(Date.now() + clampedMs).toISOString(),
  };
}

function quoteDispositionFileName(fileName: string): string {
  return `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`;
}

/**
 * MediaStorage backed by any S3-compatible endpoint (MinIO on ia-media in
 * production). The signed-URL contract is the one every caller already
 * expects, so attachments work the same everywhere.
 */
export class S3MediaStorage implements MediaStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3MediaStorageConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  }

  async createUploadTarget(args: {
    storagePath: string;
    contentType: string;
    expiresInMs?: number;
  }): Promise<MediaStorageUploadTarget> {
    const { expiresInSeconds, expiresAt } = presignExpiry(args.expiresInMs ?? DEFAULT_UPLOAD_URL_TTL_MS);
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: args.storagePath,
        ContentType: args.contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { uploadUrl, expiresAt };
  }

  async createReadAccess(args: {
    storagePath: string;
    expiresInMs?: number;
    promptSaveAs?: string;
    responseDisposition?: string;
    responseCacheControl?: string;
  }): Promise<MediaStorageReadAccess> {
    const { expiresInSeconds, expiresAt } = presignExpiry(args.expiresInMs ?? DEFAULT_READ_URL_TTL_MS);
    const disposition = args.responseDisposition
      ?? (args.promptSaveAs ? quoteDispositionFileName(args.promptSaveAs) : undefined);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: args.storagePath,
        ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        ...(args.responseCacheControl ? { ResponseCacheControl: args.responseCacheControl } : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt };
  }

  async uploadObject(args: {
    storagePath: string;
    contentType: string;
    data: Buffer | Uint8Array | ArrayBuffer;
  }): Promise<void> {
    const body = Buffer.from(
      args.data instanceof ArrayBuffer ? new Uint8Array(args.data) : args.data,
    );
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      Body: body,
      ContentType: args.contentType,
    }));
  }

  async downloadObject(args: { storagePath: string }): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
    }));
    if (!response.Body) {
      throw new Error(`Empty response body for ${args.storagePath}`);
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async setMetadata(args: {
    storagePath: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<void> {
    // S3 has no in-place metadata update; a same-key copy with REPLACE is the
    // canonical way.
    const encodedKey = args.storagePath.split('/').map(encodeURIComponent).join('/');
    await this.client.send(new CopyObjectCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      CopySource: `${this.config.bucket}/${encodedKey}`,
      MetadataDirective: 'REPLACE',
      ContentType: args.contentType,
      Metadata: args.metadata,
    }));
  }

  async deleteObject(args: { storagePath: string }): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
    }));
  }

  async startMultipart(args: { storagePath: string; contentType: string }): Promise<{ uploadId: string }> {
    const started = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      ContentType: args.contentType,
    }));
    if (!started.UploadId) throw new Error(`No upload id for ${args.storagePath}`);
    return { uploadId: started.UploadId };
  }

  async uploadPart(args: { storagePath: string; uploadId: string; partNumber: number; data: Buffer }): Promise<{ etag: string }> {
    const sent = await this.client.send(new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      UploadId: args.uploadId,
      PartNumber: args.partNumber,
      Body: args.data,
      ContentLength: args.data.length,
    }));
    if (!sent.ETag) throw new Error(`No ETag for part ${args.partNumber} of ${args.storagePath}`);
    return { etag: sent.ETag };
  }

  async completeMultipart(args: {
    storagePath: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ sizeBytes: number }> {
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      UploadId: args.uploadId,
      MultipartUpload: {
        Parts: [...args.parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }));
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: args.storagePath }));
    return { sizeBytes: Number(head.ContentLength ?? 0) };
  }

  async abortMultipart(args: { storagePath: string; uploadId: string }): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: args.storagePath,
      UploadId: args.uploadId,
    }));
  }

  async abortStaleMultiparts(args: { prefix: string; olderThan: Date }): Promise<number> {
    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.client.send(new ListMultipartUploadsCommand({
        Bucket: this.config.bucket,
        Prefix: args.prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
      }));
      for (const upload of listed.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId || !upload.Initiated || upload.Initiated >= args.olderThan) continue;
        await this.abortMultipart({ storagePath: upload.Key, uploadId: upload.UploadId }).catch(() => undefined);
        aborted += 1;
      }
      if (!listed.IsTruncated) break;
      keyMarker = listed.NextKeyMarker;
      uploadIdMarker = listed.NextUploadIdMarker;
    }
    return aborted;
  }

  async deleteObjectsWithPrefix(args: { prefix: string }): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: args.prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === 'string');
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }));
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

/**
 * Build an S3MediaStorage from MEDIA_S3_* env vars; undefined when they are
 * not (fully) configured, in which case attachments are disabled.
 */
export function createS3MediaStorageFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3MediaStorage | undefined {
  const endpoint = env.MEDIA_S3_ENDPOINT?.trim();
  const bucket = env.MEDIA_S3_BUCKET?.trim();
  const accessKeyId = env.MEDIA_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.MEDIA_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    const configured = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
    if (configured > 0) {
      console.warn('[Storage] Partial MEDIA_S3_* configuration ignored - set MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY together');
    }
    return undefined;
  }
  return new S3MediaStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(env.MEDIA_S3_REGION?.trim() ? { region: env.MEDIA_S3_REGION.trim() } : {}),
    ...(env.MEDIA_S3_FORCE_PATH_STYLE?.trim()
      ? { forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE.trim() !== 'false' }
      : {}),
  });
}
