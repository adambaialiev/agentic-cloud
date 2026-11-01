import { describe, expect, it } from 'vitest';
import { S3MediaStorage, createS3MediaStorageFromEnv } from '../../services/s3-media-storage.js';

const CONFIG = {
  endpoint: 'https://media.example.com',
  bucket: 'ia-media-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret',
};

describe('S3MediaStorage', () => {
  it('presigns path-style read URLs on the configured endpoint', async () => {
    const storage = new S3MediaStorage(CONFIG);
    const { url, expiresAt } = await storage.createReadAccess({
      storagePath: 'users/u1/sessions/s1/files/f1/photo.jpg',
      expiresInMs: 60_000,
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://media.example.com');
    expect(parsed.pathname).toBe('/ia-media-test/users/u1/sessions/s1/files/f1/photo.jpg');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('clamps read URL expiry to the 7-day SigV4 maximum', async () => {
    const storage = new S3MediaStorage(CONFIG);
    const { url } = await storage.createReadAccess({
      storagePath: 'a/b.bin',
      expiresInMs: 30 * 24 * 60 * 60_000,
    });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe(String(7 * 24 * 60 * 60));
  });

  it('encodes promptSaveAs as a content-disposition override', async () => {
    const storage = new S3MediaStorage(CONFIG);
    const { url } = await storage.createReadAccess({
      storagePath: 'a/b.bin',
      promptSaveAs: 'report "final".pdf',
    });
    const disposition = new URL(url).searchParams.get('response-content-disposition');
    expect(disposition).toBe('attachment; filename="report _final_.pdf"');
  });

  it('can make a signed image response privately cacheable', async () => {
    const storage = new S3MediaStorage(CONFIG);
    const { url } = await storage.createReadAccess({
      storagePath: 'users/u1/profile/avatar-id',
      responseCacheControl: 'private, max-age=840, immutable',
    });
    expect(new URL(url).searchParams.get('response-cache-control'))
      .toBe('private, max-age=840, immutable');
  });

  it('presigns upload targets on the configured endpoint', async () => {
    const storage = new S3MediaStorage(CONFIG);
    const { uploadUrl } = await storage.createUploadTarget({
      storagePath: 'uploads/u1/file.png',
      contentType: 'image/png',
    });
    const parsed = new URL(uploadUrl);
    expect(parsed.pathname).toBe('/ia-media-test/uploads/u1/file.png');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});

describe('createS3MediaStorageFromEnv', () => {
  const fullEnv = {
    MEDIA_S3_ENDPOINT: 'https://media.example.com',
    MEDIA_S3_BUCKET: 'ia-media-test',
    MEDIA_S3_ACCESS_KEY_ID: 'k',
    MEDIA_S3_SECRET_ACCESS_KEY: 's',
  };

  it('builds storage when all four required vars are set', () => {
    expect(createS3MediaStorageFromEnv(fullEnv)).toBeInstanceOf(S3MediaStorage);
  });

  it('returns undefined when unset or partially set', () => {
    expect(createS3MediaStorageFromEnv({})).toBeUndefined();
    expect(createS3MediaStorageFromEnv({ ...fullEnv, MEDIA_S3_BUCKET: undefined })).toBeUndefined();
    expect(createS3MediaStorageFromEnv({ ...fullEnv, MEDIA_S3_ENDPOINT: '  ' })).toBeUndefined();
  });
});
