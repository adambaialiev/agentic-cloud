import { describe, expect, it } from 'vitest';
import {
  buildCodexAuthJson,
  codexAccountIdFromIdToken,
  exchangeCodexDeviceAuthorization,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
} from '../../agent/codex/codex-device-login.js';
import { fakeCodexIdToken, fakeOpenAiLogin } from '../helpers/fake-openai-login.js';

function answering(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe('the ChatGPT device login, asked of OpenAI directly', () => {
  it('reads the code and its string interval the way the CLI does', async () => {
    const result = await requestCodexDeviceCode(fakeOpenAiLogin().fetchImpl);
    expect(result).toEqual({
      kind: 'ok',
      device: { deviceAuthId: 'dev-auth-1', userCode: '6LP7-E6DH7', intervalSeconds: 5 },
    });
    // The CLI accepts `usercode` too, and falls back to 5 s with no interval.
    expect(await requestCodexDeviceCode(answering(200, { device_auth_id: 'd', usercode: 'AB12-CD34' }))).toEqual({
      kind: 'ok',
      device: { deviceAuthId: 'd', userCode: 'AB12-CD34', intervalSeconds: 5 },
    });
    expect(await requestCodexDeviceCode(answering(404, {}))).toEqual({ kind: 'failed', reason: 'HTTP 404' });
    expect(await requestCodexDeviceCode(answering(200, { user_code: 'AB12-CD34' }))).toMatchObject({ kind: 'failed' });
  });

  it('treats 403 and 404 as still waiting, other refusals as final, and server trouble as a blip', async () => {
    const device = { deviceAuthId: 'd', userCode: 'c' };
    expect(await pollCodexDeviceCode(device, answering(403, {}))).toEqual({ kind: 'pending' });
    expect(await pollCodexDeviceCode(device, answering(404, {}))).toEqual({ kind: 'pending' });
    expect(await pollCodexDeviceCode(device, answering(400, {}))).toEqual({ kind: 'rejected', status: 400 });
    expect(await pollCodexDeviceCode(device, answering(429, {}))).toEqual({ kind: 'failed', reason: 'HTTP 429' });
    expect(await pollCodexDeviceCode(device, answering(502, {}))).toEqual({ kind: 'failed', reason: 'HTTP 502' });
    expect(await pollCodexDeviceCode(device, answering(200, {
      authorization_code: 'a', code_challenge: 'x', code_verifier: 'v',
    }))).toEqual({ kind: 'approved', authorizationCode: 'a', codeVerifier: 'v' });
  });

  it('exchanges the approval for the whole token set, or says it did not', async () => {
    const openai = fakeOpenAiLogin();
    expect(await exchangeCodexDeviceAuthorization({ authorizationCode: 'a', codeVerifier: 'v' }, openai.fetchImpl)).toEqual({
      kind: 'ok',
      tokens: { idToken: fakeCodexIdToken(), accessToken: 'access-1', refreshToken: 'refresh-1' },
    });
    expect(openai.calls.exchanges[0]).toContain('grant_type=authorization_code');
    expect(await exchangeCodexDeviceAuthorization({ authorizationCode: 'a', codeVerifier: 'v' }, answering(200, { access_token: 'x' })))
      .toMatchObject({ kind: 'failed' });
  });

  it('writes the auth.json the CLI writes: same fields, same order, account read off the id token', () => {
    const json = buildCodexAuthJson(
      { idToken: fakeCodexIdToken('acct-9'), accessToken: 'at', refreshToken: 'rt' },
      new Date('2026-09-22T05:00:00.000Z'),
    );
    expect(json).toBe(JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: fakeCodexIdToken('acct-9'), access_token: 'at', refresh_token: 'rt', account_id: 'acct-9' },
      last_refresh: '2026-09-22T05:00:00.000Z',
    }, null, 2));
    expect(codexAccountIdFromIdToken('not-a-jwt')).toBeNull();
  });
});
