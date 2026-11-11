import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import type { VoiceAnswer, VoiceModelsAnswer } from '../../../../src/shared/voice.js';
import { VOICE_MODELS } from '../../../../src/shared/voice.js';
import type { SpeechModelsAnswer } from '../../../../src/shared/voice-speech.js';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { forgetVoiceStatus } from '../../voice/voice-status.js';
import { voiceAdminsWords, voiceMonthWords, voiceUsdWords } from './voice-words.js';

/**
 * Voice-to-text on the Workplace screen (note #1026): an admin turns it on
 * with the workplace's own OpenRouter key and picks the model; a member reads
 * who pays and who can change it.
 */

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef01234567';

const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Northwind', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Dana Rivera', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

const answer = (over: Partial<VoiceAnswer> = {}): VoiceAnswer => ({
  state: 'off', model: { id: VOICE_MODELS[0]!.id, name: VOICE_MODELS[0]!.name }, admins: ['Dana Rivera'], canChange: true,
  admin: { key: null, creditLeftUsd: null, month: { month: '2026-11', recordings: 0, seconds: 0, costUsd: 0 } },
  ...over,
});

const ON = answer({
  state: 'on',
  admin: {
    key: { preview: 'sk-or-v1-…4567', savedAt: '2026-11-06T10:00:00.000Z', savedByName: 'Dana Rivera' },
    creditLeftUsd: 11.62,
    month: { month: '2026-11', recordings: 412, seconds: 7500, costUsd: 0.38 },
  },
});

const MODELS: VoiceModelsAnswer = { models: VOICE_MODELS.map((model) => ({ ...model, live: true })), pricesCheckedAt: '2026-11-06T10:00:00.000Z' };

async function open(role: 'admin' | 'member', script: Record<string, Answer>) {
  const org = { orgId: 'o1', name: 'Northwind', role, members: 1, seats: 0, seatProviders: [] };
  const state = () => emptyState({
    org, canCreateOrg: true,
    organizations: [{ orgId: 'o1', name: 'Northwind', role, active: true, members: 1, agents: 0 }],
  });
  const scripted = scriptedApi({
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/voice/models': () => MODELS,
    ...script,
  });
  render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scripted.api} /></MemoryRouter>);
  await waitFor(() => expect(document.getElementById('orgVoiceCard')).toBeTruthy());
  return scripted;
}

afterEach(() => { forgetVoiceStatus(); });

describe('Voice-to-text on the Workplace screen (note #1026)', () => {
  it('lets an admin turn it on with a key OpenRouter accepts', async () => {
    let saved = '';
    const { calls } = await open('admin', {
      'GET api/voice': () => answer(),
      'PUT api/voice/key': (call) => { saved = JSON.parse(String(call.init?.body)).key; return ON; },
    });
    expect(document.getElementById('orgVoiceCard')!.textContent).toContain('Nobody can dictate yet');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on with an OpenRouter key' })); });
    const input = screen.getByLabelText('OpenRouter key') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: KEY } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check and save' })); });

    expect(saved).toBe(KEY);
    expect(calls.find((call) => call.path === 'api/voice/key')?.scope).toMatchObject({ org: 'o1' });
    const card = document.getElementById('orgVoiceCard')!;
    expect(card.textContent).toContain('On for everyone');
    expect(card.textContent).toContain('sk-or-v1-…4567 · saved by Dana Rivera');
    expect(card.textContent).toContain('credit left $11.62');
    expect(card.textContent).toContain('This month: 412 recordings, 2 h 05 min of speech, $0.38');
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('keeps the dialog open with OpenRouter’s refusal in plain words', async () => {
    await open('admin', {
      'GET api/voice': () => answer(),
      'PUT api/voice/key': () => {
        throw new WorkspaceApiError('OpenRouter did not accept this key. Copy it again from openrouter.ai/keys.', 400, {
          error: 'OpenRouter did not accept this key. Copy it again from openrouter.ai/keys.', code: 'voice_key_rejected',
        });
      },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on with an OpenRouter key' })); });
    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'sk-or-v1-nope-nope-nope-nope' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check and save' })); });
    expect(screen.getByRole('alert').textContent).toContain('OpenRouter did not accept this key');
    expect(screen.getByLabelText('OpenRouter key')).toBeTruthy();
  });

  it('shows the seven models with their price a minute, and switches on a tap', async () => {
    let chosen = '';
    await open('admin', {
      'GET api/voice': () => ON,
      'PUT api/voice/model': (call) => {
        chosen = JSON.parse(String(call.init?.body)).model;
        return { ...ON, model: { id: chosen, name: 'Whisper Large V3 Turbo' } };
      },
    });
    await waitFor(() => expect(document.querySelectorAll('#orgVoiceModels [role="radio"]')).toHaveLength(7));
    const models = document.getElementById('orgVoiceModels')!;
    expect(models.querySelector('[aria-checked="true"]')!.textContent).toContain('GPT-4o mini Transcribe');
    expect(models.textContent).toContain('≈ $0.003');
    expect(models.textContent).toContain('$0.0002');
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /Whisper Large V3 Turbo/ })); });
    expect(chosen).toBe('openai/whisper-large-v3-turbo');
    expect(models.querySelector('[aria-checked="true"]')!.textContent).toContain('Whisper Large V3 Turbo');
  });

  it('tells an admin when it is paused, with the way to fix it', async () => {
    await open('admin', { 'GET api/voice': () => ({ ...ON, state: 'paused', reason: 'out_of_credit', admin: { ...ON.admin!, creditLeftUsd: 0 } }) });
    expect(document.querySelector('.voicenotice')!.textContent).toContain('paused for everyone');
    expect(screen.getByRole('link', { name: 'Add credit on OpenRouter' }).getAttribute('href')).toContain('openrouter.ai');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  // Note #1116: an admin who saved a key in another workplace they run.
  it('offers the key from another workplace this admin runs, copies it in one tap, and says the two stay apart', async () => {
    const { calls } = await open('admin', {
      'GET api/voice': () => answer({ admin: { ...answer().admin!, copyFrom: [{ orgId: 'o2', name: 'Eldiiar' }] } }),
      'POST api/voice/key/copy': () => answer({ ...ON, admin: { ...ON.admin!, key: { ...ON.admin!.key!, savedByName: 'Adam', copiedFromName: 'Eldiiar' } } }),
    });
    const section = document.getElementById('orgVoice')!;
    expect(section.textContent).toContain('You already saved a key in Eldiiar.');
    expect(section.textContent).toContain('does not change the other');
    expect(screen.getByRole('button', { name: 'Use a new OpenRouter key instead' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use the key from Eldiiar' })); });

    const copy = calls.find((call) => call.path === 'api/voice/key/copy');
    expect(JSON.parse(String(copy?.init?.body))).toEqual({ fromOrgId: 'o2' });
    expect(copy?.scope).toMatchObject({ org: 'o1' });
    expect(screen.queryByLabelText('OpenRouter key')).toBeNull();
    const card = document.getElementById('orgVoiceCard')!;
    expect(card.textContent).toContain('On for everyone');
    expect(card.textContent).toContain('copied by Adam from Eldiiar on');
    expect(document.getElementById('orgVoice')!.textContent).toContain('Replacing or removing it here does not change Eldiiar');
  });

  it('shows a member who pays and who can change it, and nothing to change', async () => {
    await open('member', {
      'GET api/voice': () => ({ state: 'on', model: { id: VOICE_MODELS[0]!.id, name: 'GPT-4o mini Transcribe' }, admins: ['Dana Rivera'], canChange: false }),
    });
    const section = document.getElementById('orgVoice')!;
    expect(section.textContent).toContain('Paid by the workplace · GPT-4o mini Transcribe');
    expect(section.textContent).toContain('Dana Rivera can change this.');
    expect(screen.queryByRole('button', { name: /key/i })).toBeNull();
    expect(document.getElementById('orgVoiceModels')).toBeNull();
  });
});

describe('voice words', () => {
  it('says who, how much and how long in plain words', () => {
    expect(voiceAdminsWords([])).toBe('An admin');
    expect(voiceAdminsWords(['A', 'B'])).toBe('A or B');
    expect(voiceUsdWords(0.004)).toBe('under 1¢');
    expect(voiceUsdWords(11.624)).toBe('$11.62');
    expect(voiceMonthWords({ month: '2026-11', recordings: 0, seconds: 0, costUsd: 0 })).toBe('No recordings yet this month.');
    expect(voiceMonthWords({ month: '2026-11', recordings: 1, seconds: 20, costUsd: 0.001 })).toBe('This month: 1 recording, under a minute of speech, under 1¢');
  });
});

/** Note #1151: the recap's voice, chosen on the same section. */
describe('the recap voice on the Workplace screen (note #1151)', () => {
  const speech = { model: 'elevenlabs/eleven-v4-turbo', modelName: 'ElevenLabs: Eleven v4 Turbo', voice: 'sarah', voiceName: 'Sarah', isDefault: true };
  const SPEECH_MODELS: SpeechModelsAnswer = {
    checkedAt: '2026-11-11T10:00:00.000Z',
    default: { model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah' },
    models: [
      { id: 'elevenlabs/eleven-v4-turbo', name: 'ElevenLabs: Eleven v4 Turbo', voices: ['george', 'sarah'], usdPerRecap: 0.0096, estimate: false },
      { id: 'google/gemini-3.8-flash-tts', name: 'Google: Gemini 3.8 Flash TTS', voices: ['Kore', 'Puck'], usdPerRecap: 0.0031, estimate: true },
      { id: 'hexgrad/kokoro-82m', name: 'hexgrad: Kokoro 82M', voices: ['af_heart', 'af_bella'], usdPerRecap: 0.0001488, estimate: false },
    ],
  };
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement;

  it('offers what OpenRouter offers with a price a recap, plays a sample, and keeps the choice', async () => {
    const played: string[] = [];
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { played.push(this.src); return Promise.resolve(); });
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:sample';
    let kept: unknown = null;
    const { calls } = await open('admin', {
      'GET api/voice': () => ({ ...ON, speech }),
      'GET api/voice/speech/models': () => SPEECH_MODELS,
      'POST api/voice/speech/sample': () => ({ audio: btoa('mp3'), contentType: 'audio/mpeg', model: 'hexgrad/kokoro-82m', voice: 'af_heart' }),
      'PUT api/voice/speech': (call) => {
        kept = JSON.parse(String(call.init?.body));
        return { ...ON, speech: { model: 'hexgrad/kokoro-82m', modelName: 'hexgrad: Kokoro 82M', voice: 'af_heart', voiceName: 'af_heart', isDefault: false, changedByName: 'Dana Rivera', changedAt: '2026-11-11T10:30:00.000Z' } };
      },
    });
    await waitFor(() => expect(document.getElementById('orgSpeechModel')).toBeTruthy());
    expect(document.getElementById('orgSpeechCurrent')!.textContent).toBe('Sarah · ElevenLabs: Eleven v4 Turbo');
    expect([...select('orgSpeechModel').options].map((o) => o.textContent)).toEqual([
      'Eleven v4 Turbo · ElevenLabs · 0.96¢ a recap · default',
      'Gemini 3.8 Flash TTS · Google · ≈ 0.31¢ a recap',
      'Kokoro 82M · hexgrad · 0.015¢ a recap',
    ]);
    expect(select('orgSpeechVoice').value).toBe('sarah');
    expect((document.getElementById('orgSpeechSave') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { fireEvent.change(select('orgSpeechModel'), { target: { value: 'hexgrad/kokoro-82m' } }); });
    // Sarah is not one of Kokoro's voices: its first voice stands in.
    expect(select('orgSpeechVoice').value).toBe('af_heart');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play sample' })); });
    expect(JSON.parse(String(calls.find((c) => c.path === 'api/voice/speech/sample')!.init!.body))).toEqual({ model: 'hexgrad/kokoro-82m', voice: 'af_heart' });
    await waitFor(() => expect(played.at(-1)).toBe('blob:sample'));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use this voice' })); });
    expect(kept).toEqual({ model: 'hexgrad/kokoro-82m', voice: 'af_heart' });
    await waitFor(() => expect(document.getElementById('orgSpeechCurrent')!.textContent).toBe('af_heart · hexgrad: Kokoro 82M'));
    expect(document.getElementById('orgSpeechCard')!.textContent).toContain('Chosen by Dana Rivera');
    play.mockRestore();
  });

  it('shows a member which voice reads the recaps, without the choosers', async () => {
    await open('member', { 'GET api/voice': () => ({ state: 'on', model: ON.model, admins: ['Dana Rivera'], canChange: false, speech }) });
    await waitFor(() => expect(document.getElementById('orgSpeechCurrent')).toBeTruthy());
    expect(document.getElementById('orgSpeechModel')).toBeNull();
    expect(document.getElementById('orgSpeechSample')).toBeNull();
  });

  it('says when the chosen voice failed and the default read the recap', async () => {
    await open('admin', {
      'GET api/voice': () => ({ ...ON, speech: { ...speech, model: 'hexgrad/kokoro-82m', modelName: 'hexgrad: Kokoro 82M', voice: 'af_heart', voiceName: 'af_heart', isDefault: false, problem: { at: '2026-11-11T10:40:00.000Z', words: 'The workplace’s voice could not read this recap, so the default voice did.' } } }),
      'GET api/voice/speech/models': () => SPEECH_MODELS,
    });
    await waitFor(() => expect(document.getElementById('orgSpeechProblem')).toBeTruthy());
    expect(document.getElementById('orgSpeechProblem')!.textContent).toContain('so the default voice did');
  });
});
