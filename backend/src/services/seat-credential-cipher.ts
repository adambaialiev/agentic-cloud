import type { OrgSeatDocument } from '../types/org.js';
import type { SeatSignInDocument } from './seat-signin-storage.js';
import { isEncryptedSecretValue, type SecretCipher } from './secret-cipher.js';

/**
 * Field-level encryption for AI sign-ins at rest — the same SecretCipher
 * (SECRETS_MASTER_KEY, AES-256-GCM) that EncryptedSecretStorage applies to
 * the secrets table, applied to the two tables that took the sign-ins over.
 *
 * Why: the Claude and Codex logins used to live in the secrets table and were
 * encrypted with it (5574f582, 2026-08-12). The org schema (18aec95a,
 * 2026-08-22) moved them onto `org_seats` as plain JSON, so every nightly
 * backup carried live tokens again while the Privacy Policy said they were
 * stored encrypted.
 *
 * Only the secret material is sealed — the rest of the doc stays readable,
 * because storage filters on it (`json_extract(doc, '$.provider')`) and the
 * user roster reads `status`. Sealed on a seat: `token` (Claude's access or
 * setup token; Codex's whole auth.json) and `oauth.refreshToken`. On a
 * pending Codex sign-in: `device.deviceAuthId`, the handle that collects the
 * login once the member approves.
 *
 * A value without the `enc:` tag decrypts as itself (SecretCipher), so rows
 * written before this keep working and scripts/encrypt-seats.mjs converts
 * them afterwards. Sealing is idempotent: an already-sealed value is kept,
 * never wrapped twice.
 */

function seal(cipher: SecretCipher, value: string): string {
  return isEncryptedSecretValue(value) ? value : cipher.encrypt(value);
}

export function sealSeatCredentials(seat: OrgSeatDocument, cipher: SecretCipher | null): OrgSeatDocument {
  if (!cipher) return seat;
  return {
    ...seat,
    token: seal(cipher, seat.token),
    ...(seat.oauth ? { oauth: { ...seat.oauth, refreshToken: seal(cipher, seat.oauth.refreshToken) } } : {}),
  };
}

export function openSeatCredentials(seat: OrgSeatDocument, cipher: SecretCipher | null): OrgSeatDocument {
  if (!cipher) return seat;
  return {
    ...seat,
    token: cipher.decrypt(seat.token),
    ...(seat.oauth ? { oauth: { ...seat.oauth, refreshToken: cipher.decrypt(seat.oauth.refreshToken) } } : {}),
  };
}

export function sealSeatSignIn(doc: SeatSignInDocument, cipher: SecretCipher | null): SeatSignInDocument {
  if (!cipher || !doc.device) return doc;
  return { ...doc, device: { ...doc.device, deviceAuthId: seal(cipher, doc.device.deviceAuthId) } };
}

export function openSeatSignIn(doc: SeatSignInDocument, cipher: SecretCipher | null): SeatSignInDocument {
  if (!cipher || !doc.device) return doc;
  return { ...doc, device: { ...doc.device, deviceAuthId: cipher.decrypt(doc.device.deviceAuthId) } };
}
