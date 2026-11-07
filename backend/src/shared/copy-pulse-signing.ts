import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/**
 * How a private copy signs its daily pulse, and how we check it (note #1057).
 *
 * Ed25519. The copy makes its key pair together with its random copyId, the
 * first time its backend starts (during the install), and keeps the private
 * half in its own database: it never leaves the copy. Every pulse carries the
 * public half and a signature over the exact bytes of the body. We keep the
 * public half the first time a copyId reaches us, and from then on refuse any
 * pulse for that copyId signed by another key, and every unsigned one. We hold
 * no secret of theirs, so nothing we keep can be used to speak as them.
 */

export const COPY_PULSE_KEY_HEADER = 'x-copy-key';
export const COPY_PULSE_SIGNATURE_HEADER = 'x-copy-signature';

/** A copy's identity: its id and its key pair. The private half stays in the copy. */
export interface CopyIdentity {
  copyId: string;
  /** Ed25519 public key, raw 32 bytes, base64url. */
  publicKey: string;
  /** Ed25519 private key, PKCS#8 DER, base64. */
  privateKey: string;
}

/** A new copyId and key pair: 24 random characters, url-safe (fits the pulse's copyId shape). */
export function newCopyIdentity(): CopyIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (!raw) throw new Error('Ed25519 key without a public point');
  return {
    copyId: randomBytes(18).toString('base64url'),
    publicKey: raw,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** The signature header's value for these exact body bytes. */
export function signPulseBody(body: string | Buffer, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, typeof body === 'string' ? Buffer.from(body, 'utf8') : body, key).toString('base64url');
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;

/** Whether `signature` is `publicKey`'s signature over these exact bytes. Never throws. */
export function verifyPulseBody(body: Buffer, publicKey: string | undefined, signature: string | undefined): boolean {
  if (!publicKey || !signature || !BASE64URL_32.test(publicKey) || !BASE64URL_64.test(signature)) return false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return verify(null, body, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
