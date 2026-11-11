import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { OrgSecretsService } from '../../services/org-secrets.js';
import { OpenRouterAccountClient, OpenRouterUnavailableError, type OpenRouterAccount } from '../../services/openrouter-account.js';
import {
  VOICE_KEY_SECRET_NAME,
  VOICE_PAUSE_RECHECK_MS,
  VoiceSettingsError,
  VoiceUnavailableError,
  WorkplaceVoiceService,
  voiceKeyPreview,
  type VoiceTranscriber,
} from '../../services/workplace-voice.js';
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, voicePriceWords } from '../../shared/voice.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';

class Upstream extends Error {
  constructor(readonly status: number) { super(`upstream ${status}`); }
}

async function setup(overrides: Partial<OpenRouterAccount> = {}) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Northwind', createdByUserId: 'u1' });
  const secrets = new InMemorySecretStorage();
  const orgSecrets = new OrgSecretsService(secrets);
  let now = Date.parse('2026-11-06T10:00:00Z');
  const openRouter: OpenRouterAccount = {
    checkKey: vi.fn().mockResolvedValue('ok'),
    creditLeft: vi.fn().mockResolvedValue(4.5),
    transcriptionModels: vi.fn().mockResolvedValue([
      { id: 'openai/whisper-large-v3-turbo', prompt: 0.00000333, completion: 0 },
      { id: 'openai/gpt-4o-mini-transcribe', prompt: 0.00000125, completion: 0.000005 },
      { id: 'nvidia/parakeet-tdt-0.6b-v3', prompt: 0.0000166667, completion: 0 },
    ]),
    ...overrides,
  };
  const transcriber: VoiceTranscriber & { transcribe: ReturnType<typeof vi.fn> } = {
    transcribe: vi.fn().mockResolvedValue({ text: 'hello there', costUsd: 0.0012, seconds: 14 }),
  };
  const service = new WorkplaceVoiceService({
    orgStorage,
    orgSecrets,
    openRouter,
    transcriber,
    pauseReasonFor: (error) => error instanceof Upstream
      ? error.status === 402 ? 'out_of_credit' : error.status === 401 ? 'key_rejected' : null
      : null,
    now: () => now,
  });
  const recording = { audio: Buffer.from('abc'), contentType: 'audio/webm', fileName: 'workspace-recording' };
  return { service, orgStorage, orgSecrets, secrets, openRouter, transcriber, orgId: org.orgId, recording, tick: (ms: number) => { now += ms; } };
}

describe('WorkplaceVoiceService', () => {
  it('is off until an admin saves a key, and never calls OpenRouter while off', async () => {
    const t = await setup();
    expect((await t.service.state(t.orgId)).state).toBe('off');
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toMatchObject({ code: 'voice_not_configured' });
    expect(t.transcriber.transcribe).not.toHaveBeenCalled();
  });

  it('checks a key with OpenRouter before keeping it, and keeps it as an org secret', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, `  ${KEY}\n`, 'Dana Rivera');
    expect(t.openRouter.checkKey).toHaveBeenCalledWith(KEY);
    expect(await t.orgSecrets.getOrgSecret(t.orgId, VOICE_KEY_SECRET_NAME)).toBe(KEY);
    // Under the org's synthetic owner, never a person's namespace: the
    // per-turn export reads people's `user-env:` rows only.
    expect((await t.secrets.getUserSecrets(`org:${t.orgId}`)).map((s) => s.key)).toEqual([`org-env:${VOICE_KEY_SECRET_NAME}`]);
    const org = await t.orgStorage.getOrg(t.orgId);
    expect(org?.voice).toMatchObject({ keySavedByName: 'Dana Rivera', keySavedAt: '2026-11-06T10:00:00.000Z' });
    expect(JSON.stringify(org)).not.toContain(KEY);
    expect((await t.service.state(t.orgId)).state).toBe('on');
  });

  // Note #1116: a copy from another workplace is this workplace's own secret
  // from then on, and nothing ties the two afterwards.
  it('copies another workplace\u2019s key once, and keeps the two apart afterwards', async () => {
    const t = await setup();
    const other = await t.orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: 'u1' });
    await t.service.saveKey(other.orgId, KEY, 'Adam');
    expect(await t.service.copySources(t.orgId, [other.orgId, t.orgId, 'gone'])).toEqual([{ orgId: other.orgId, name: 'Eldiiar' }]);

    await t.service.copyKey(t.orgId, other.orgId, 'Adam');
    expect(await t.orgSecrets.getOrgSecret(t.orgId, VOICE_KEY_SECRET_NAME)).toBe(KEY);
    expect((await t.orgStorage.getOrg(t.orgId))?.voice).toMatchObject({ keySavedByName: 'Adam', keyCopiedFromName: 'Eldiiar' });
    const answer = await t.service.answer(t.orgId, { admin: true, admins: ['Adam'], alsoAdminOf: [other.orgId] });
    expect(answer).toMatchObject({ state: 'on', admin: { key: { copiedFromName: 'Eldiiar' } } });
    expect(answer.admin).not.toHaveProperty('copyFrom');

    // Removing the key in the source leaves the copy working; a new key
    // pasted here is no longer "copied".
    await t.service.removeKey(other.orgId);
    expect((await t.service.state(t.orgId)).state).toBe('on');
    const replacement = `${KEY.slice(0, -4)}ffff`;
    await t.service.saveKey(t.orgId, replacement, 'Adam');
    expect((await t.orgStorage.getOrg(t.orgId))?.voice).not.toHaveProperty('keyCopiedFromName');
    expect(await t.orgSecrets.getOrgSecret(other.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();
  });

  it('refuses to copy over a key, from a workplace with none, or a key OpenRouter no longer accepts', async () => {
    const t = await setup();
    const other = await t.orgStorage.createOrg({ name: 'Eldiiar', createdByUserId: 'u1' });
    await expect(t.service.copyKey(t.orgId, other.orgId, 'Adam')).rejects.toMatchObject({ status: 404 });
    await expect(t.service.copyKey(t.orgId, t.orgId, 'Adam')).rejects.toMatchObject({ status: 400 });
    await t.orgSecrets.setOrgSecret(other.orgId, VOICE_KEY_SECRET_NAME, KEY, 'test');
    (t.openRouter.checkKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce('rejected');
    await expect(t.service.copyKey(t.orgId, other.orgId, 'Adam')).rejects.toMatchObject({ status: 400, code: 'voice_key_rejected' });
    expect(await t.orgSecrets.getOrgSecret(t.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    await expect(t.service.copyKey(t.orgId, other.orgId, 'Adam')).rejects.toMatchObject({ status: 409, code: 'voice_key_exists' });
  });

  it('refuses a key OpenRouter rejects, a malformed one, and one it could not check', async () => {
    const rejected = await setup({ checkKey: vi.fn().mockResolvedValue('rejected') });
    await expect(rejected.service.saveKey(rejected.orgId, KEY, 'Dana')).rejects.toMatchObject({ status: 400, code: 'voice_key_rejected' });
    expect(await rejected.orgSecrets.getOrgSecret(rejected.orgId, VOICE_KEY_SECRET_NAME)).toBeNull();

    await expect(rejected.service.saveKey(rejected.orgId, 'sk-or v1 with spaces in it ok', 'Dana')).rejects.toBeInstanceOf(VoiceSettingsError);
    await expect(rejected.service.saveKey(rejected.orgId, '', 'Dana')).rejects.toMatchObject({ status: 400 });

    const down = await setup({ checkKey: vi.fn().mockRejectedValue(new OpenRouterUnavailableError('the key check')) });
    await expect(down.service.saveKey(down.orgId, KEY, 'Dana')).rejects.toMatchObject({ status: 503 });
  });

  it('transcribes on the workplace key and the default model, and counts the month', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    const result = await t.service.transcribe(t.orgId, t.recording);
    expect(result).toEqual({ text: 'hello there', model: DEFAULT_VOICE_MODEL });
    expect(t.transcriber.transcribe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: KEY, model: DEFAULT_VOICE_MODEL }));
    await t.service.transcribe(t.orgId, t.recording);
    const answer = await t.service.answer(t.orgId, { admin: true, admins: ['Dana'] });
    expect(answer.admin?.month).toEqual({ month: '2026-11', recordings: 2, seconds: 28, costUsd: 0.0024 });
    expect(answer.admin?.key?.preview).toBe('sk-or-v1-…89ab');
    expect(answer.admin?.creditLeftUsd).toBe(4.5);
  });

  it('a new month starts from nothing', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    await t.service.transcribe(t.orgId, t.recording);
    t.tick(30 * 24 * 60 * 60_000);
    const answer = await t.service.answer(t.orgId, { admin: true, admins: [] });
    expect(answer.admin?.month).toEqual({ month: '2026-12', recordings: 0, seconds: 0, costUsd: 0 });
  });

  it('pauses on out of credit, refuses at once while paused, and lifts the pause when OpenRouter has credit again', async () => {
    const t = await setup({ creditLeft: vi.fn().mockResolvedValue(0) });
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    t.transcriber.transcribe.mockRejectedValueOnce(new Upstream(402));
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toMatchObject({ code: 'voice_out_of_credit' });
    expect(await t.service.state(t.orgId)).toMatchObject({ state: 'paused', reason: 'out_of_credit' });

    // Within two minutes nobody asks OpenRouter again, and nothing is sent.
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect(t.transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(t.openRouter.creditLeft).toHaveBeenCalledTimes(1); // once, when it paused

    // After two minutes it asks: still empty, still paused.
    t.tick(VOICE_PAUSE_RECHECK_MS + 1);
    expect((await t.service.state(t.orgId)).state).toBe('paused');
    expect(t.openRouter.creditLeft).toHaveBeenCalledTimes(2);

    // Topped up on openrouter.ai: the next look after two minutes lifts it.
    vi.mocked(t.openRouter.creditLeft).mockResolvedValue(10);
    t.tick(VOICE_PAUSE_RECHECK_MS + 1);
    expect((await t.service.state(t.orgId)).state).toBe('on');
    await expect(t.service.transcribe(t.orgId, t.recording)).resolves.toMatchObject({ text: 'hello there' });
  });

  it('stays paused while the credit OpenRouter refused at is unchanged', async () => {
    // Production on 6 Nov: $0.455 left, and still 402 for every recording.
    const t = await setup({ creditLeft: vi.fn().mockResolvedValue(0.4551) });
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    t.transcriber.transcribe.mockRejectedValueOnce(new Upstream(402));
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toMatchObject({ code: 'voice_out_of_credit' });
    expect((await t.orgStorage.getOrg(t.orgId))?.voicePaused?.creditAtPause).toBe(0.4551);
    t.tick(VOICE_PAUSE_RECHECK_MS + 1);
    expect((await t.service.state(t.orgId)).state).toBe('paused');
    vi.mocked(t.openRouter.creditLeft).mockResolvedValue(5.4551);
    t.tick(VOICE_PAUSE_RECHECK_MS + 1);
    expect((await t.service.state(t.orgId)).state).toBe('on');
  });

  it('pauses on a rejected key and saving a new key lifts it', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    t.transcriber.transcribe.mockRejectedValueOnce(new Upstream(401));
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toMatchObject({ code: 'voice_key_rejected' });
    expect((await t.service.state(t.orgId)).reason).toBe('key_rejected');
    await t.service.saveKey(t.orgId, `${KEY}cd`, 'Dana');
    expect((await t.service.state(t.orgId)).state).toBe('on');
  });

  it('lets a passing fault through without pausing', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    t.transcriber.transcribe.mockRejectedValueOnce(new Upstream(503));
    await expect(t.service.transcribe(t.orgId, t.recording)).rejects.toBeInstanceOf(Upstream);
    expect((await t.service.state(t.orgId)).state).toBe('on');
  });

  it('removing the key turns voice off', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    await t.service.removeKey(t.orgId);
    expect((await t.service.state(t.orgId)).state).toBe('off');
    expect((await t.orgStorage.getOrg(t.orgId))?.voice?.keySavedAt).toBeUndefined();
  });

  it('takes a model from the short list, or any transcription model OpenRouter lists', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    await t.service.setModel(t.orgId, 'openai/whisper-large-v3-turbo', 'Dana');
    await t.service.transcribe(t.orgId, t.recording);
    expect(t.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'openai/whisper-large-v3-turbo' }));
    await t.service.setModel(t.orgId, 'nvidia/parakeet-tdt-0.6b-v3', 'Dana');
    expect((await t.orgStorage.getOrg(t.orgId))?.voice?.model).toBe('nvidia/parakeet-tdt-0.6b-v3');
    await expect(t.service.setModel(t.orgId, 'openai/gpt-5', 'Dana')).rejects.toMatchObject({ status: 400 });
    await expect(t.service.setModel(t.orgId, 'not a model', 'Dana')).rejects.toMatchObject({ status: 400 });
    // The key and who saved it survive a model change.
    expect((await t.orgStorage.getOrg(t.orgId))?.voice?.keySavedByName).toBe('Dana');
  });

  it('prices the short list from OpenRouter, keeping estimates for per-token models', async () => {
    const t = await setup();
    const answer = await t.service.models();
    expect(answer.models.map((m) => m.id)).toEqual(VOICE_MODELS.map((m) => m.id));
    const turbo = answer.models.find((m) => m.id === 'openai/whisper-large-v3-turbo')!;
    expect(turbo.live).toBe(true);
    expect(voicePriceWords(turbo)).toBe('$0.0002');
    const mini = answer.models.find((m) => m.id === DEFAULT_VOICE_MODEL)!;
    expect(mini).toMatchObject({ live: false, usdPerMinute: 0.003 });
    expect(voicePriceWords(mini)).toBe('≈ $0.003');
    expect(answer.pricesCheckedAt).toBe('2026-11-06T10:00:00.000Z');
  });

  it('shows members who pays and who can change it, never the key', async () => {
    const t = await setup();
    await t.service.saveKey(t.orgId, KEY, 'Dana');
    const answer = await t.service.answer(t.orgId, { admin: false, admins: ['Dana Rivera'] });
    expect(answer).toEqual({
      state: 'on',
      model: { id: DEFAULT_VOICE_MODEL, name: 'GPT-4o mini Transcribe' },
      admins: ['Dana Rivera'],
      canChange: false,
      // Which voice reads the recaps (note #1151): names only.
      speech: { model: 'elevenlabs/eleven-v4-turbo', modelName: 'ElevenLabs: Eleven v4 Turbo', voice: 'sarah', voiceName: 'Sarah', isDefault: true },
    });
    expect(JSON.stringify(answer)).not.toContain(KEY.slice(-8));
  });

  it('previews a key without giving it away', () => {
    expect(voiceKeyPreview(KEY)).toBe('sk-or-v1-…89ab');
    expect(voiceKeyPreview('short')).toBe('•••••');
  });
});

describe('OpenRouterAccountClient', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('sends the key to the key check and reads 401 as rejected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, { data: {} }))
      .mockResolvedValueOnce(json(401, { error: { message: 'User not found.', code: 401 } }))
      .mockResolvedValueOnce(json(500, {}));
    const client = new OpenRouterAccountClient(fetchImpl as unknown as typeof fetch);
    await expect(client.checkKey(KEY)).resolves.toBe('ok');
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual({ Authorization: `Bearer ${KEY}` });
    await expect(client.checkKey(KEY)).resolves.toBe('rejected');
    await expect(client.checkKey(KEY)).rejects.toBeInstanceOf(OpenRouterUnavailableError);
  });

  it('reads credit left from the account, capped by the key’s own limit', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/credits')
      ? json(200, { data: { total_credits: 15, total_usage: 14.5 } })
      : json(200, { data: { limit_remaining: 0.2 } }));
    const client = new OpenRouterAccountClient(fetchImpl as unknown as typeof fetch);
    expect(await client.creditLeft(KEY)).toBeCloseTo(0.2);
    const noLimit = new OpenRouterAccountClient((async (url: string) => url.endsWith('/credits')
      ? json(200, { data: { total_credits: 15, total_usage: 14.5 } })
      : json(200, { data: { limit_remaining: null } })) as unknown as typeof fetch);
    expect(await noLimit.creditLeft(KEY)).toBeCloseTo(0.5);
  });

  it('lists transcription models with their prices', async () => {
    const client = new OpenRouterAccountClient((async () => json(200, { data: [
      { id: 'openai/whisper-large-v3', pricing: { prompt: '0.0000075', completion: '0' } },
      { nonsense: true },
    ] })) as unknown as typeof fetch);
    expect(await client.transcriptionModels()).toEqual([{ id: 'openai/whisper-large-v3', prompt: 0.0000075, completion: 0 }]);
  });
});

/**
 * Note #1151: the recap's voice is the workplace's choice, from what
 * OpenRouter offers, and the default reads the recap whenever the choice
 * cannot — saying so, never silently.
 */
describe('WorkplaceVoiceService — the recap voice (note #1151)', () => {
  const offered = [
    { id: 'elevenlabs/eleven-v4-turbo', name: 'ElevenLabs: Eleven v4 Turbo', prompt: 0.00004, completion: 0, voices: ['george', 'sarah'] },
    { id: 'hexgrad/kokoro-82m', name: 'hexgrad: Kokoro 82M', prompt: 0.00000062, completion: 0, voices: ['af_heart', 'af_bella'] },
    { id: 'google/gemini-3.8-flash-tts', name: 'Google: Gemini 3.8 Flash TTS', prompt: 0.0000005, completion: 0.000009, voices: ['Kore'] },
    { id: 'fish-audio/s1', name: 'Fish Audio: S1', prompt: 0.000015, completion: 0, voices: [] },
    { id: 'heygen/heygen-voice-1-turbo:free', name: 'HeyGen (free)', prompt: 0, completion: 0, voices: ['nadine'] },
  ];
  async function speechSetup(speak = vi.fn().mockResolvedValue({ audio: Buffer.from('mp3'), contentType: 'audio/mpeg' }), list: typeof offered | Error = offered) {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Northwind', createdByUserId: 'u1' });
    const orgSecrets = new OrgSecretsService(new InMemorySecretStorage());
    await orgSecrets.setOrgSecret(org.orgId, VOICE_KEY_SECRET_NAME, KEY, 'test');
    const speechModels = list instanceof Error ? vi.fn().mockRejectedValue(list) : vi.fn().mockResolvedValue(list);
    const service = new WorkplaceVoiceService({
      orgStorage, orgSecrets,
      openRouter: { checkKey: vi.fn().mockResolvedValue('ok'), creditLeft: vi.fn().mockResolvedValue(3), transcriptionModels: vi.fn().mockResolvedValue([]), speechModels },
      transcriber: { transcribe: vi.fn() }, speaker: { speak },
      pauseReasonFor: (error) => error instanceof Upstream && error.status === 402 ? 'out_of_credit' : null,
    });
    return { service, orgStorage, orgId: org.orgId, speak, speechModels };
  }

  it('lists what OpenRouter offers, priced per 240-character recap, the default first; no voiceless or free models', async () => {
    const t = await speechSetup();
    const answer = await t.service.speechModels();
    expect(answer.models.map((m) => m.id)).toEqual(['elevenlabs/eleven-v4-turbo', 'google/gemini-3.8-flash-tts', 'hexgrad/kokoro-82m']);
    expect(answer.models[0]).toMatchObject({ usdPerRecap: 0.00004 * 240, estimate: false, voices: ['george', 'sarah'] });
    expect(answer.models[1]!.estimate).toBe(true);
    expect(answer.default).toEqual({ model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah' });
  });

  it('defaults to Eleven v4 Turbo and Sarah, keeps an offered choice, and refuses one OpenRouter does not offer', async () => {
    const t = await speechSetup();
    expect((await t.service.answer(t.orgId, { admin: true, admins: [] })).speech).toMatchObject({ model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah', voiceName: 'Sarah', isDefault: true });
    await expect(t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'nobody', 'Dana')).rejects.toMatchObject({ status: 400 });
    await expect(t.service.setSpeech(t.orgId, 'made/up', 'x', 'Dana')).rejects.toMatchObject({ status: 400 });
    await t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'af_bella', 'Dana');
    expect((await t.service.answer(t.orgId, { admin: false, admins: [] })).speech).toMatchObject({ model: 'hexgrad/kokoro-82m', modelName: 'hexgrad: Kokoro 82M', voice: 'af_bella', isDefault: false, changedByName: 'Dana' });
    await t.service.speak(t.orgId, 'I shipped it.');
    expect(t.speak).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'hexgrad/kokoro-82m', voice: 'af_bella', format: 'mp3', text: 'I shipped it.' }));
  });

  it('says it cannot check a choice while OpenRouter does not answer', async () => {
    const t = await speechSetup(undefined, new Error('down'));
    await expect(t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'af_bella', 'Dana')).rejects.toMatchObject({ status: 503 });
  });

  it('asks Gemini for PCM, the only format it speaks', async () => {
    const t = await speechSetup();
    await t.service.sample(t.orgId, 'google/gemini-3.8-flash-tts', 'Kore');
    expect(t.speak).toHaveBeenCalledWith(expect.objectContaining({ model: 'google/gemini-3.8-flash-tts', voice: 'Kore', format: 'pcm' }));
  });

  it('falls back to the default, and says so, when the chosen voice fails; works again once it does', async () => {
    const speak = vi.fn(async (args: { model: string }) => {
      if (args.model === 'hexgrad/kokoro-82m' && speak.mock.calls.length < 3) throw new Error('provider 500');
      return { audio: Buffer.from(args.model), contentType: 'audio/mpeg' };
    });
    const t = await speechSetup(speak as never);
    await t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'af_heart', 'Dana');
    const first = await t.service.speak(t.orgId, 'Recap one.');
    expect(first).toMatchObject({ model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah' });
    expect(first.fallback).toContain('could not read this recap, so the default voice did');
    expect((await t.orgStorage.getOrg(t.orgId))?.voiceSpeechProblem?.words).toBe(first.fallback);
    const second = await t.service.speak(t.orgId, 'Recap two.');
    expect(second).toMatchObject({ model: 'hexgrad/kokoro-82m' });
    expect(second.fallback).toBeUndefined();
    expect((await t.orgStorage.getOrg(t.orgId))?.voiceSpeechProblem).toBeUndefined();
  });

  it('reads with the default when OpenRouter no longer offers the chosen model', async () => {
    const t = await speechSetup();
    await t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'af_heart', 'Dana');
    // A day later the list no longer has it.
    (t.service as unknown as { speechCache: unknown }).speechCache = null;
    t.speechModels.mockResolvedValue(offered.filter((m) => m.id !== 'hexgrad/kokoro-82m'));
    const spoken = await t.service.speak(t.orgId, 'Recap.');
    expect(spoken).toMatchObject({ model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah' });
    expect(spoken.fallback).toContain('no longer offers');
    expect(t.speak).toHaveBeenCalledTimes(1);
  });

  it('never falls back over a paused account: out of credit is out of credit for every voice', async () => {
    const speak = vi.fn().mockRejectedValue(new Upstream(402));
    const t = await speechSetup(speak);
    await t.service.setSpeech(t.orgId, 'hexgrad/kokoro-82m', 'af_heart', 'Dana');
    await expect(t.service.speak(t.orgId, 'Recap.')).rejects.toMatchObject({ code: 'voice_out_of_credit' });
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
