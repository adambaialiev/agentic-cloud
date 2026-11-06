#!/usr/bin/env node
/**
 * The offer gate's voice-to-text step (notes #1026, #1030): one real
 * transcription on the standing test copy, through its own transcribe route,
 * with the test copy workplace's own OpenRouter key. The gate fails when no
 * words come back.
 *
 *   node voice-check.mjs --state <dir>/acc-testcopy-copy.json
 *
 * Signs in as the test copy's admin (COPY_TEST_ADMIN_EMAIL,
 * COPY_TEST_ADMIN_PASSWORD), reads the workplace's voice-to-text, and when
 * it is off saves COPY_TEST_VOICE_OPENROUTER_KEY as the workplace's key, the
 * way an admin does on the Workplace screen. Then it sends voice-sample.wav
 * (espeak-ng, 6.5 s, "…the quick brown fox jumps over the lazy dog.") and
 * expects those words back.
 *
 * Never prints the key or the password. A release from before voice-to-text
 * had its own key (no api/voice route) says so and passes: there is nothing
 * of this kind to check in it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE = path.join(HERE, 'voice-sample.wav');
/** Words the sample says that a transcription must carry. */
export const EXPECTED = ['quick', 'brown', 'fox', 'lazy', 'dog'];

const out = (line) => process.stdout.write(`${line}\n`);

class CheckError extends Error {}

/** The address a copy answers at, from its state file (`domain`), or COPY_TEST_URL. */
export function copyUrl(state, env = process.env) {
  if (env.COPY_TEST_URL) return env.COPY_TEST_URL.replace(/\/+$/, '');
  if (!state?.domain) throw new CheckError('the state file names no domain, and COPY_TEST_URL is not set');
  return `https://${state.domain}`;
}

/** Cookie jar for one sign-in: the session and the CSRF cookie. */
function jar() {
  const cookies = new Map();
  return {
    take(response) {
      const set = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of set) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: () => cookies.get('__Host-acc_csrf') ?? cookies.get('acc_csrf') ?? '',
  };
}

const json = async (response) => {
  try { return await response.json(); } catch { return {}; }
};

export async function voiceCheck({ base, email, password, key, sample = readFileSync(SAMPLE), fetchImpl = fetch, log = out }) {
  if (!email || !password) throw new CheckError('COPY_TEST_ADMIN_EMAIL and COPY_TEST_ADMIN_PASSWORD must be set to sign in to the test copy');
  const cookies = jar();
  const call = async (method, route, body, type = 'application/json') => {
    const response = await fetchImpl(`${base}/workspace/${route}`, {
      method,
      headers: {
        Origin: base,
        Cookie: cookies.header(),
        ...(method === 'GET' ? {} : { 'X-CSRF-Token': cookies.csrf() }),
        ...(body === undefined ? {} : { 'Content-Type': type }),
      },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(120_000),
    });
    cookies.take(response);
    return response;
  };

  const login = await call('POST', 'auth/email/login', { email, password });
  if (!login.ok) throw new CheckError(`signing in to the test copy as its admin failed (${login.status})`);

  const read = await call('GET', 'api/voice');
  if (read.status === 404) {
    log('this release has no workplace voice-to-text yet (before note #1026): nothing to check');
    return { skipped: true };
  }
  if (!read.ok) throw new CheckError(`reading voice-to-text failed (${read.status})`);
  let voice = await json(read);

  if (voice.state === 'off') {
    if (!key) throw new CheckError('voice-to-text is off on the test copy and COPY_TEST_VOICE_OPENROUTER_KEY is not set');
    const saved = await call('PUT', 'api/voice/key', { key });
    const answer = await json(saved);
    if (!saved.ok) throw new CheckError(`saving the voice-to-text key was refused (${saved.status}): ${answer.error ?? 'no reason given'}`);
    voice = answer;
    log(`saved the workplace's OpenRouter key (${voice.admin?.key?.preview ?? 'masked'})`);
  }
  if (voice.state === 'paused') {
    throw new CheckError(voice.reason === 'key_rejected'
      ? 'voice-to-text is paused: OpenRouter no longer accepts the test copy\'s key'
      : 'voice-to-text is paused: the OpenRouter account behind the test copy\'s key is out of credit');
  }
  const credit = voice.admin?.creditLeftUsd;
  log(`voice-to-text is ${voice.state}, model ${voice.model?.id ?? 'unknown'}${typeof credit === 'number' ? `, credit left $${credit.toFixed(2)}` : ''}`);

  const started = Date.now();
  const sent = await call('POST', 'api/transcribe', sample, 'audio/wav');
  const answer = await json(sent);
  if (!sent.ok) throw new CheckError(`the transcription failed (${sent.status}${answer.code ? `, ${answer.code}` : ''}): ${answer.error ?? 'no reason given'}`);
  const text = typeof answer.text === 'string' ? answer.text.trim() : '';
  const words = text.toLowerCase();
  const missing = EXPECTED.filter((word) => !words.includes(word));
  if (!text) throw new CheckError('the transcription came back with no words');
  if (missing.length) throw new CheckError(`the transcription missed ${missing.join(', ')}: heard ${JSON.stringify(text)}`);
  log(`heard in ${Date.now() - started} ms: ${JSON.stringify(text)}`);
  return { skipped: false, text };
}

async function main() {
  const at = process.argv.indexOf('--state');
  const statePath = at > 0 ? process.argv[at + 1] : undefined;
  const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  await voiceCheck({
    base: copyUrl(state),
    email: process.env.COPY_TEST_ADMIN_EMAIL,
    password: process.env.COPY_TEST_ADMIN_PASSWORD,
    key: process.env.COPY_TEST_VOICE_OPENROUTER_KEY,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`voice-to-text check FAILED: ${error instanceof CheckError ? error.message : error?.stack ?? error}\n`);
    process.exit(1);
  });
}
