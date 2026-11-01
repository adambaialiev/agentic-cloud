import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  MINIAPP_INIT_DATA_MAX_AGE_MS,
  verifyMiniAppInitData,
} from '../../services/telegram-miniapp-auth.js';

/**
 * The verifier is the only thing standing between "anyone with curl" and a
 * user's secrets list, so the assertions that matter are the refusals: a
 * forged hash, a replayed stale payload, a payload signed by a different bot.
 */

const BOT_TOKEN = '7654321:AAF-test-bot-token';
const NOW = new Date('2026-08-09T12:00:00Z');

/**
 * Signs the way Telegram does — implemented here from the published spec
 * (sorted `key=value` lines, HMAC key = HMAC_SHA256("WebAppData", botToken))
 * rather than by importing the code under test, so a bug in the verifier
 * cannot cancel itself out in the fixture.
 */
function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function freshFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(NOW.getTime() / 1000) - 60),
    query_id: 'AAE_test',
    user: JSON.stringify({ id: 42, first_name: 'Owner', username: 'owner' }),
    ...overrides,
  };
}

describe('verifyMiniAppInitData', () => {
  it('accepts a freshly signed payload and extracts the identity', () => {
    const identity = verifyMiniAppInitData(signInitData(freshFields(), BOT_TOKEN), BOT_TOKEN, NOW);
    expect(identity).toMatchObject({
      telegramUserId: 42,
      firstName: 'Owner',
      username: 'owner',
    });
    expect(identity!.authDate.getTime()).toBe((Math.floor(NOW.getTime() / 1000) - 60) * 1000);
  });

  it('treats the Ed25519 signature field as ordinary signed data, not an exclusion', () => {
    // Bot-token validation excludes only `hash`; a payload whose `signature`
    // was left OUT of the check string must fail, and one signed WITH it in
    // must pass.
    const withSignature = signInitData(freshFields({ signature: 'abc123' }), BOT_TOKEN);
    expect(verifyMiniAppInitData(withSignature, BOT_TOKEN, NOW)).not.toBeNull();

    const signedWithout = signInitData(freshFields(), BOT_TOKEN);
    expect(verifyMiniAppInitData(`${signedWithout}&signature=abc123`, BOT_TOKEN, NOW)).toBeNull();
  });

  it('rejects a payload whose user field was tampered with after signing', () => {
    const params = new URLSearchParams(signInitData(freshFields(), BOT_TOKEN));
    params.set('user', JSON.stringify({ id: 43, first_name: 'Mallory' }));
    expect(verifyMiniAppInitData(params.toString(), BOT_TOKEN, NOW)).toBeNull();
  });

  it('rejects a payload signed by a different bot', () => {
    const initData = signInitData(freshFields(), '1111111:AAF-some-other-bot');
    expect(verifyMiniAppInitData(initData, BOT_TOKEN, NOW)).toBeNull();
  });

  it('rejects missing hash, empty input, and empty token', () => {
    const params = new URLSearchParams(signInitData(freshFields(), BOT_TOKEN));
    params.delete('hash');
    expect(verifyMiniAppInitData(params.toString(), BOT_TOKEN, NOW)).toBeNull();
    expect(verifyMiniAppInitData('', BOT_TOKEN, NOW)).toBeNull();
    expect(verifyMiniAppInitData(signInitData(freshFields(), BOT_TOKEN), '', NOW)).toBeNull();
  });

  it('rejects a stale payload — a leaked initData must not stay a credential', () => {
    const staleSeconds = Math.floor((NOW.getTime() - MINIAPP_INIT_DATA_MAX_AGE_MS) / 1000) - 60;
    const initData = signInitData(freshFields({ auth_date: String(staleSeconds) }), BOT_TOKEN);
    expect(verifyMiniAppInitData(initData, BOT_TOKEN, NOW)).toBeNull();
  });

  it('tolerates small clock skew but rejects a genuinely future-dated payload', () => {
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    const slightlyAhead = signInitData(freshFields({ auth_date: String(nowSeconds + 120) }), BOT_TOKEN);
    expect(verifyMiniAppInitData(slightlyAhead, BOT_TOKEN, NOW)).not.toBeNull();
    const farAhead = signInitData(freshFields({ auth_date: String(nowSeconds + 3600) }), BOT_TOKEN);
    expect(verifyMiniAppInitData(farAhead, BOT_TOKEN, NOW)).toBeNull();
  });

  it('rejects a payload without a usable user id, even when correctly signed', () => {
    const noUser = signInitData({ auth_date: freshFields().auth_date!, query_id: 'x' }, BOT_TOKEN);
    expect(verifyMiniAppInitData(noUser, BOT_TOKEN, NOW)).toBeNull();
    const badId = signInitData(freshFields({ user: JSON.stringify({ id: 'not-a-number' }) }), BOT_TOKEN);
    expect(verifyMiniAppInitData(badId, BOT_TOKEN, NOW)).toBeNull();
  });
});
