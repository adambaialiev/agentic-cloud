import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verified identity of a Mini App visitor, extracted from Telegram's signed
 * `initData` launch payload. This is the ONLY trusted link between a browser
 * request and a Telegram account: nothing else in the request is
 * authenticated, so every Mini App route must derive its user from here.
 */
export interface MiniAppIdentity {
  telegramUserId: number;
  firstName?: string;
  username?: string;
  authDate: Date;
}

/**
 * How long a launch payload stays valid. Telegram mints a fresh `initData`
 * every time the app is opened, so this only has to cover one sitting; keeping
 * it short bounds the window in which a leaked payload works as a credential
 * for the secrets screen.
 */
export const MINIAPP_INIT_DATA_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Validate a Telegram Mini App `initData` string against the bot token that
 * launched it, per https://core.telegram.org/bots/webapps#validating-data.
 *
 * The scheme: every field except `hash`, sorted by key and joined as
 * `key=value` lines, is HMAC-SHA256'd with a key derived from the bot token
 * (`HMAC_SHA256("WebAppData", botToken)`). The newer Ed25519 `signature`
 * field is NOT excluded — third-party validation strips it, bot-token
 * validation treats it as an ordinary field.
 *
 * Returns null on ANY failure — a caller cannot distinguish "tampered" from
 * "expired" by design, so the route answers 401 either way.
 */
export function verifyMiniAppInitData(
  initData: string,
  botToken: string,
  now: Date,
  maxAgeMs: number = MINIAPP_INIT_DATA_MAX_AGE_MS,
): MiniAppIdentity | null {
  if (!initData || !botToken) {
    return null;
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const providedHash = params.get('hash');
  if (!providedHash) {
    return null;
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const providedBuffer = Buffer.from(providedHash, 'utf8');
  const computedBuffer = Buffer.from(computedHash, 'utf8');
  if (providedBuffer.length !== computedBuffer.length) {
    return null;
  }
  if (!timingSafeEqual(providedBuffer, computedBuffer)) {
    return null;
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) {
    return null;
  }
  const authDate = new Date(authDateSeconds * 1000);
  const ageMs = now.getTime() - authDate.getTime();
  // A future-dated payload is as suspect as a stale one; small negative skew
  // (clock drift between Telegram and this host) is tolerated.
  if (ageMs > maxAgeMs || ageMs < -5 * 60 * 1000) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) {
    return null;
  }
  let user: unknown;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const id = (user as { id?: unknown }).id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return null;
  }

  const firstName = (user as { first_name?: unknown }).first_name;
  const username = (user as { username?: unknown }).username;
  return {
    telegramUserId: id,
    ...(typeof firstName === 'string' && firstName ? { firstName } : {}),
    ...(typeof username === 'string' && username ? { username } : {}),
    authDate,
  };
}
