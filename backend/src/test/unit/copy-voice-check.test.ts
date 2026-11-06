/**
 * The offer gate's voice-to-text step (note #1030): infra/copy-release/voice-check.mjs
 * signs in to the test copy as its admin, saves the workplace's OpenRouter key
 * when voice-to-text is off, sends the bundled recording and wants its words
 * back. Run here against a stand-in copy that records what it was asked.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
// @ts-expect-error plain ESM script without types
import { EXPECTED, SAMPLE, copyUrl, voiceCheck } from '../../../../infra/copy-release/voice-check.mjs';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const BASE = 'https://testcopy.example';

type Route = (body: unknown, headers: Record<string, string>) => { status: number; body?: unknown; cookies?: string[] };

function copy(routes: Record<string, Route>) {
  const asked: string[] = [];
  const seen: Array<{ route: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const route = `${init.method} ${url.replace(`${BASE}/workspace/`, '')}`;
    asked.push(route);
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    seen.push({ route, headers, body });
    const handler = routes[route];
    const answer = handler ? handler(body, headers) : { status: 404, body: { error: 'Not found' } };
    const response = new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
    if (answer.cookies) {
      Object.defineProperty(response.headers, 'getSetCookie', { value: () => answer.cookies });
    }
    return response;
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, asked, seen };
}

const signedIn: Route = () => ({ status: 200, body: { ok: true }, cookies: ['__Host-acc_session=s1; Path=/; Secure', '__Host-acc_csrf=c1; Path=/; Secure'] });
const voiceOn = { state: 'on', model: { id: 'openai/gpt-4o-mini-transcribe' }, admin: { key: { preview: 'sk-or-v1-…cdef' }, creditLeftUsd: 5.45 } };
const heard = () => ({ status: 200, body: { text: 'Testing voice-to-text on the test copy. The quick brown fox jumps over the lazy dog.' } });

describe('the gate\'s voice-to-text check (note #1030)', () => {
  it('saves the key when voice-to-text is off, then hears the sample', async () => {
    const lines: string[] = [];
    const c = copy({
      'POST auth/email/login': signedIn,
      'GET api/voice': () => ({ status: 200, body: { state: 'off' } }),
      'PUT api/voice/key': () => ({ status: 200, body: voiceOn }),
      'POST api/transcribe': heard,
    });
    const result = await voiceCheck({ base: BASE, email: 'ada@testcopy', password: 'pw', key: KEY, sample: Buffer.from('wav'), fetchImpl: c.fetchImpl, log: (line: string) => lines.push(line) });
    expect(result).toMatchObject({ skipped: false });
    expect(c.asked).toEqual(['POST auth/email/login', 'GET api/voice', 'PUT api/voice/key', 'POST api/transcribe']);
    const save = c.seen.find((call) => call.route === 'PUT api/voice/key')!;
    expect(save.body).toEqual({ key: KEY });
    expect(save.headers).toMatchObject({ Origin: BASE, 'X-CSRF-Token': 'c1', Cookie: '__Host-acc_session=s1; __Host-acc_csrf=c1' });
    expect(c.seen.find((call) => call.route === 'POST api/transcribe')!.headers['Content-Type']).toBe('audio/wav');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).toContain('sk-or-v1-…cdef');
    expect(lines.at(-1)).toContain('quick brown fox');
  });

  it('leaves a saved key alone', async () => {
    const c = copy({ 'POST auth/email/login': signedIn, 'GET api/voice': () => ({ status: 200, body: voiceOn }), 'POST api/transcribe': heard });
    await voiceCheck({ base: BASE, email: 'a', password: 'p', key: KEY, sample: Buffer.from('wav'), fetchImpl: c.fetchImpl, log: () => {} });
    expect(c.asked).not.toContain('PUT api/voice/key');
  });

  it('fails when the words do not come back, when the key is refused, and when voice is paused', async () => {
    const run = (routes: Record<string, Route>) => voiceCheck({
      base: BASE, email: 'a', password: 'p', key: KEY, sample: Buffer.from('wav'),
      fetchImpl: copy({ 'POST auth/email/login': signedIn, ...routes }).fetchImpl, log: () => {},
    });
    await expect(run({ 'GET api/voice': () => ({ status: 200, body: voiceOn }), 'POST api/transcribe': () => ({ status: 200, body: { text: '' } }) }))
      .rejects.toThrow('no words');
    await expect(run({ 'GET api/voice': () => ({ status: 200, body: voiceOn }), 'POST api/transcribe': () => ({ status: 200, body: { text: 'hello there' } }) }))
      .rejects.toThrow('missed quick, brown, fox, lazy, dog');
    await expect(run({ 'GET api/voice': () => ({ status: 200, body: voiceOn }), 'POST api/transcribe': () => ({ status: 503, body: { error: 'paused', code: 'voice_out_of_credit' } }) }))
      .rejects.toThrow('503, voice_out_of_credit');
    await expect(run({ 'GET api/voice': () => ({ status: 200, body: { state: 'off' } }), 'PUT api/voice/key': () => ({ status: 400, body: { error: 'OpenRouter did not accept this key.' } }) }))
      .rejects.toThrow('OpenRouter did not accept this key.');
    await expect(run({ 'GET api/voice': () => ({ status: 200, body: { state: 'paused', reason: 'out_of_credit' } }) }))
      .rejects.toThrow('out of credit');
  });

  it('passes a release from before workplace voice-to-text, which has no api/voice', async () => {
    const c = copy({ 'POST auth/email/login': signedIn });
    await expect(voiceCheck({ base: BASE, email: 'a', password: 'p', key: KEY, sample: Buffer.from('wav'), fetchImpl: c.fetchImpl, log: () => {} }))
      .resolves.toEqual({ skipped: true });
    expect(c.asked).not.toContain('POST api/transcribe');
  });

  it('refuses to run without the admin sign-in, and a failed sign-in stops it', async () => {
    await expect(voiceCheck({ base: BASE, email: '', password: '', key: KEY, fetchImpl: copy({}).fetchImpl, log: () => {} })).rejects.toThrow('COPY_TEST_ADMIN_EMAIL');
    await expect(voiceCheck({ base: BASE, email: 'a', password: 'p', key: KEY, sample: Buffer.from('wav'), fetchImpl: copy({ 'POST auth/email/login': () => ({ status: 401 }) }).fetchImpl, log: () => {} }))
      .rejects.toThrow('signing in to the test copy as its admin failed (401)');
  });

  it('reads the address from the state file, and ships a real recording', () => {
    expect(copyUrl({ domain: 'testcopy.agentbuilt.app' }, {})).toBe('https://testcopy.agentbuilt.app');
    expect(copyUrl(null, { COPY_TEST_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
    expect(existsSync(SAMPLE)).toBe(true);
    expect(statSync(SAMPLE).size).toBeGreaterThan(100_000);
    expect(EXPECTED).toContain('fox');
  });
});
