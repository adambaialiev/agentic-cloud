/**
 * The signed words a private copy is given by us (note #811): an UPDATE KEY,
 * which lets one customer copy our releases into their own registry until a
 * date, and (later in stage 3) a LICENCE. Both are one line of text:
 *
 *   acc1.<base64url of the JSON payload>.<base64url of an Ed25519 signature>
 *
 * The signature covers `acc1.<payload>` exactly as written. Only the issuing
 * command holds the private key (the admins-only Secret COPY_SIGNING_KEY,
 * with a copy kept offline, note #810); everything that checks carries the
 * public key, which can verify a signature and never make one. No calls to
 * us, no database: a key checks itself.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const SIGNED_PREFIX = 'acc1';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** A public key from its JWK `x` (43 base64url characters), as committed in
 *  infra/copy-release/signing-key.pub and handed to whatever checks. */
export function publicKeyFrom(x) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(x).trim() }, format: 'jwk' });
}

/** `x` of a public key, for printing beside a freshly made private key. */
export function publicKeyX(key) {
  return createPublicKey(key).export({ format: 'jwk' }).x;
}

export function signPayload(payload, privateKeyPem) {
  const body = `${SIGNED_PREFIX}.${b64u(JSON.stringify(payload))}`;
  const signature = sign(null, Buffer.from(body), createPrivateKey(privateKeyPem));
  return `${body}.${b64u(signature)}`;
}

/** The payload when the words are ours and intact; null for anything else —
 *  a stranger's key, an edited payload, a truncated paste. */
export function verifySigned(text, publicKey) {
  const parts = String(text ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== SIGNED_PREFIX) return null;
  try {
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
