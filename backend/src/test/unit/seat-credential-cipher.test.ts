import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretCipher, SecretCipherError, isEncryptedSecretValue } from '../../services/secret-cipher.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteOrgStorage } from '../../services/sqlite/sqlite-org-storage.js';
import { SqliteSeatSignInStorage } from '../../services/sqlite/sqlite-seat-signin-storage.js';
import { OrgSeatSignInFlow } from '../../services/org-seat-signin-flow.js';
import { addMemberSeat } from '../../services/org-seat-signin.js';
import { OrgSeatCredentialSource, SEAT_LEASE_PREFIX } from '../../services/org-seat-credentials.js';
import { fakeCodexIdToken, fakeOpenAiLogin } from '../helpers/fake-openai-login.js';

/**
 * AI sign-ins are encrypted at rest, like secret values.
 *
 * The Privacy Policy says sign-in tokens are stored encrypted. From the org
 * schema (2026-08-22) until this fix they were not: `org_seats` held every
 * Claude and ChatGPT token as plain JSON, and the nightly backup carried them
 * off the box. These tests read the database FILE itself, so a token that
 * reached disk in plaintext by any path fails them.
 */

const KEY = randomBytes(32).toString('base64');

let dir: string | undefined;
let db: SqliteDb | undefined;

function openDb(): { db: SqliteDb; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'seat-cipher-'));
  const path = join(dir, 'test.db');
  db = openSqliteDb(path);
  return { db, path };
}

/** Every byte SQLite has put on disk for this database, WAL included. */
function bytesOnDisk(path: string): string {
  return [path, `${path}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString('latin1'))
    .join('');
}

afterEach(() => {
  vi.useRealTimers();
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  db = undefined; dir = undefined;
});

async function orgWithMember(orgStorage: SqliteOrgStorage) {
  const org = await orgStorage.createOrg({ name: 'Growth', createdByUserId: 'ruby-owner' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'ruby-owner', role: 'admin' });
  return org.orgId;
}

describe('AI sign-ins are encrypted at rest', () => {
  it('a ChatGPT sign-in, pending and then landed, never reaches the file in plaintext', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { db, path } = openDb();
    const cipher = new SecretCipher(KEY);
    const orgStorage = new SqliteOrgStorage(db, cipher);
    const seatSignInStorage = new SqliteSeatSignInStorage(db, cipher);
    const orgId = await orgWithMember(orgStorage);
    const openai = fakeOpenAiLogin();

    // The device login waits for the member — written down, sealed.
    const before = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: openai.fetchImpl });
    await before.start({ userId: 'ruby-owner', orgId, provider: 'codex' });
    const pending = db.prepare('SELECT doc FROM seat_signins').get() as { doc: string };
    expect(pending.doc).toContain('6LP7-E6DH7');
    expect(pending.doc).not.toContain('dev-auth-1');

    // A restart reads it back and collects the approval with it.
    const after = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: openai.fetchImpl });
    await after.restore();
    openai.state.approved = true;
    vi.setSystemTime(Date.now() + 6_000);
    expect((await after.poll('ruby-owner'))?.state.phase).toBe('done');
    expect(openai.calls.polls.at(-1)).toMatchObject({ device_auth_id: 'dev-auth-1' });

    const [seat] = await orgStorage.listSeatsByMember(orgId, 'ruby-owner');
    expect(seat.token).toContain('access-1');
    expect(seat.token).toContain('refresh-1');
    const raw = db.prepare('SELECT doc FROM org_seats').get() as { doc: string };
    expect(isEncryptedSecretValue(JSON.parse(raw.doc).token)).toBe(true);

    const disk = bytesOnDisk(path);
    for (const secret of ['dev-auth-1', 'access-1', 'refresh-1', fakeCodexIdToken()]) {
      expect(disk).not.toContain(secret);
    }
  });

  it('a Claude grant and its refresh never reach the file in plaintext', async () => {
    const { db, path } = openDb();
    const orgStorage = new SqliteOrgStorage(db, new SecretCipher(KEY));
    const orgId = await orgWithMember(orgStorage);

    const added = await addMemberSeat({
      orgStorage, userId: 'ruby-owner', orgId, provider: 'claude',
      token: 'sk-ant-oat01-first-access', oauth: { refreshToken: 'sk-ant-ort01-first-refresh', expiresAt: 1 },
    });
    if (added.outcome !== 'added') throw new Error(added.outcome);

    // The refresher's renewal: a fresh access token and a rotated refresh token.
    const seats = new OrgSeatCredentialSource(orgStorage);
    await seats.applyCredentialUpdates(`${SEAT_LEASE_PREFIX}${added.seat.seatId}`, {
      usageAuth: { accessToken: 'sk-ant-oat01-second-access', refreshToken: 'sk-ant-ort01-second-refresh', expiresAt: 2 },
    });
    // A health write that carries no secret keeps the sealed material sealed.
    await orgStorage.updateSeat(added.seat.seatId, { authFailureStreak: 1 });

    const [credential] = await seats.listForUser('claude', 'ruby-owner', orgId);
    expect(credential.token).toBe('sk-ant-oat01-second-access');
    expect(credential.usageAuth).toMatchObject({ refreshToken: 'sk-ant-ort01-second-refresh', expiresAt: 2 });

    const disk = bytesOnDisk(path);
    for (const secret of ['first-access', 'first-refresh', 'second-access', 'second-refresh']) {
      expect(disk).not.toContain(secret);
    }
  });

  it('reads a row from before encryption as itself, and seals it at its next write', async () => {
    const { db } = openDb();
    const orgStorage = new SqliteOrgStorage(db, new SecretCipher(KEY));
    const orgId = await orgWithMember(orgStorage);
    // Written by the previous build: no cipher.
    const legacy = await new SqliteOrgStorage(db).addSeat({
      orgId, userId: 'ruby-owner', provider: 'claude', token: 'sk-ant-oat01-legacy',
      label: 'Old', status: 'active', oauth: { refreshToken: 'sk-ant-ort01-legacy' },
    });
    const rowToken = () => JSON.parse(
      (db.prepare('SELECT doc FROM org_seats WHERE seat_id = ?').get(legacy.seatId) as { doc: string }).doc,
    ) as { token: string; oauth: { refreshToken: string } };
    expect(rowToken().token).toBe('sk-ant-oat01-legacy');

    expect(await orgStorage.getSeat(legacy.seatId))
      .toMatchObject({ token: 'sk-ant-oat01-legacy', oauth: { refreshToken: 'sk-ant-ort01-legacy' } });

    await orgStorage.updateSeat(legacy.seatId, { status: 'cooldown' });
    expect(isEncryptedSecretValue(rowToken().token)).toBe(true);
    expect(isEncryptedSecretValue(rowToken().oauth.refreshToken)).toBe(true);
    expect(await orgStorage.getSeat(legacy.seatId))
      .toMatchObject({ token: 'sk-ant-oat01-legacy', status: 'cooldown', oauth: { refreshToken: 'sk-ant-ort01-legacy' } });
  });

  it('refuses to hand out garbage under the wrong key', async () => {
    const { db } = openDb();
    const orgStorage = new SqliteOrgStorage(db, new SecretCipher(KEY));
    const orgId = await orgWithMember(orgStorage);
    const seat = await orgStorage.addSeat({
      orgId, userId: 'ruby-owner', provider: 'claude', token: 'sk-ant-oat01-x', label: 'Mine', status: 'active',
    });
    const wrongKey = new SqliteOrgStorage(db, new SecretCipher(randomBytes(32).toString('base64')));
    await expect(wrongKey.getSeat(seat.seatId)).rejects.toThrow(SecretCipherError);
  });
});
