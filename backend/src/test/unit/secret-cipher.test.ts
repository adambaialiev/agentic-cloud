import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretCipher,
  SecretCipherError,
  isEncryptedSecretValue,
  secretCipherFromEnv,
} from '../../services/secret-cipher.js';
import { EncryptedSecretStorage } from '../../services/encrypted-secret-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteSecretStorage } from '../../services/sqlite/sqlite-secret-storage.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('SecretCipher', () => {
  const cipher = new SecretCipher(KEY);

  it('round-trips a value, tagged and unreadable at rest', () => {
    const plaintext = 'ghp_averyrealtoken1234';
    const stored = cipher.encrypt(plaintext);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(isEncryptedSecretValue(stored)).toBe(true);
    expect(cipher.decrypt(stored)).toBe(plaintext);
  });

  it('round-trips multi-line and non-ASCII values (SSH keys, certs)', () => {
    const plaintext = '-----BEGIN KEY-----\nAbC/dEf==\n-----END KEY-----\néü✓';
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('uses a fresh nonce per encryption', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('passes legacy plaintext through decrypt unchanged', () => {
    expect(cipher.decrypt('a-plain-api-key')).toBe('a-plain-api-key');
    expect(isEncryptedSecretValue('a-plain-api-key')).toBe(false);
  });

  it('rejects the wrong key rather than returning garbage', () => {
    const stored = cipher.encrypt('secret');
    expect(() => new SecretCipher(OTHER_KEY).decrypt(stored)).toThrow(SecretCipherError);
  });

  it('rejects a tampered ciphertext', () => {
    const stored = cipher.encrypt('secret');
    const blob = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
    blob[14] ^= 0xff;
    expect(() => cipher.decrypt(`enc:v1:${blob.toString('base64')}`)).toThrow(SecretCipherError);
  });

  it('rejects unknown versions and truncated blobs with clear errors', () => {
    expect(() => cipher.decrypt('enc:v9:AAAA')).toThrow(/version/);
    expect(() => cipher.decrypt('enc:v1:AAAA')).toThrow(/truncated/);
  });

  it('refuses a malformed master key', () => {
    expect(() => new SecretCipher('too-short')).toThrow(/32 bytes/);
    expect(() => new SecretCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('secretCipherFromEnv reads SECRETS_MASTER_KEY and tolerates absence', () => {
    expect(secretCipherFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(secretCipherFromEnv({ SECRETS_MASTER_KEY: '  ' } as NodeJS.ProcessEnv)).toBeNull();
    const fromEnv = secretCipherFromEnv({ SECRETS_MASTER_KEY: KEY } as NodeJS.ProcessEnv);
    expect(fromEnv?.decrypt(cipher.encrypt('x'))).toBe('x');
  });
});

describe('EncryptedSecretStorage', () => {
  it('consumers see plaintext; the inner storage only ever sees ciphertext', async () => {
    const inner = new InMemorySecretStorage();
    const storage = new EncryptedSecretStorage(inner, new SecretCipher(KEY));

    const created = await storage.createSecret('user-1', {
      key: 'user-env:GH_TOKEN',
      value: 'ghp_original',
      description: 'GitHub token',
    });
    expect(created.value).toBe('ghp_original');

    const atRest = await inner.getSecret('user-1', created.secretId);
    expect(atRest?.value.startsWith('enc:v1:')).toBe(true);

    expect((await storage.getSecret('user-1', created.secretId))?.value).toBe('ghp_original');
    expect((await storage.getSecretByKey('user-1', 'user-env:GH_TOKEN'))?.value).toBe('ghp_original');
    expect((await storage.getUserSecrets('user-1'))[0]?.value).toBe('ghp_original');

    await storage.updateSecret('user-1', created.secretId, { value: 'ghp_rotated' });
    expect((await inner.getSecret('user-1', created.secretId))?.value.startsWith('enc:v1:')).toBe(true);
    expect((await storage.getSecret('user-1', created.secretId))?.value).toBe('ghp_rotated');
  });

  it('a description-only update leaves the stored ciphertext untouched', async () => {
    const inner = new InMemorySecretStorage();
    const storage = new EncryptedSecretStorage(inner, new SecretCipher(KEY));
    const created = await storage.createSecret('user-1', { key: 'user-env:K', value: 'v' });
    const before = (await inner.getSecret('user-1', created.secretId))?.value;
    await storage.updateSecret('user-1', created.secretId, { description: 'annotated' });
    expect((await inner.getSecret('user-1', created.secretId))?.value).toBe(before);
  });

  it('reads pre-encryption plaintext rows as-is (mixed table during migration)', async () => {
    const inner = new InMemorySecretStorage();
    const legacy = await inner.createSecret('user-1', { key: 'user-env:OLD', value: 'plain-old-key' });
    const storage = new EncryptedSecretStorage(inner, new SecretCipher(KEY));
    expect((await storage.getSecret('user-1', legacy.secretId))?.value).toBe('plain-old-key');
  });
});

describe('EncryptedSecretStorage over SQLite', () => {
  let dir: string;
  let db: SqliteDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-cipher-'));
    db = openSqliteDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the row on disk is ciphertext, and a reopen with the key reads it back', async () => {
    const storage = new EncryptedSecretStorage(new SqliteSecretStorage(db), new SecretCipher(KEY));
    const created = await storage.createSecret('user-1', {
      key: 'user-env:API_KEY',
      value: 'sk-live-12345',
      description: 'test',
    });

    const raw = db.prepare('SELECT doc FROM secrets WHERE user_id = ? AND secret_id = ?')
      .get('user-1', created.secretId) as { doc: string };
    expect(raw.doc).not.toContain('sk-live-12345');
    expect(raw.doc).toContain('enc:v1:');

    const reopened = new EncryptedSecretStorage(new SqliteSecretStorage(db), new SecretCipher(KEY));
    expect((await reopened.getSecretByKey('user-1', 'user-env:API_KEY'))?.value).toBe('sk-live-12345');
  });
});
