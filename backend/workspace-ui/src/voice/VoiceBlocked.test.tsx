import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApiError } from '../api/client.js';
import { BannerProvider } from '../chrome/Banner.js';
import { ChatComposer } from '../screens/chat/ChatComposer.js';
import { SessionProvider } from '../session/SessionProvider.js';
import { scriptedApi, signedIn, type Answer } from '../test/fixtures.js';
import { ImageViewerProvider } from '../ui/ImageViewer.js';
import { VOICE_ERROR_SENTENCES } from '../../../src/shared/voice-transcription.js';
import type { VoiceAnswer } from '../../../src/shared/voice.js';
import { forgetMicrophone, giveMicrophone, openDialogsInJsdom } from './fake-microphone.js';
import { voiceBlockedWords } from './VoiceBlocked.js';
import { forgetVoiceStatus } from './voice-status.js';

/**
 * Note #1026 (Adam, 6 Nov 2026): the microphone is always there. With no
 * key — or a paused one — pressing it opens the recorder's "not set up"
 * screen with where it is fixed, and nothing records.
 */

const voice = (over: Partial<VoiceAnswer>): VoiceAnswer => ({
  state: 'on', model: { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe' },
  admins: ['Dana Rivera'], canChange: false, ...over,
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}{location.hash}</p>;
}

function mount(script: Record<string, Answer>) {
  const scripted = scriptedApi({ 'GET auth/session': () => signedIn(), ...script });
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <SessionProvider api={scripted.api}>
        <BannerProvider>
          <ImageViewerProvider>
            <Routes>
              <Route path="/chat" element={<ChatComposer sending={false} onSend={async () => true} onRefuse={() => {}} />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </ImageViewerProvider>
        </BannerProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
  return scripted;
}

/** The fake microphone's own getUserMedia, to see whether anything asked for it. */
const gum = () => navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>;
const dictate = () => screen.getByRole('button', { name: 'Dictate into Message' });
const asked = (calls: Array<{ path: string }>, path: string) => calls.filter((call) => call.path === path).length;

beforeEach(() => { openDialogsInJsdom(); });
afterEach(() => { forgetMicrophone(); forgetVoiceStatus(); });

describe('the recorder when voice-to-text is not set up (note #1026)', () => {
  it('opens the "not set up" screen with who to ask, and records nothing', async () => {
    giveMicrophone();
    const { calls } = mount({ 'GET api/voice': () => voice({ state: 'off', admins: ['Dana Rivera'] }) });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));

    await act(async () => { fireEvent.click(dictate()); });

    const dialog = screen.getByRole('dialog', { name: 'Voice-to-text' });
    expect(dialog.textContent).toContain('Voice-to-text is not set up yet');
    expect(dialog.textContent).toContain(VOICE_ERROR_SENTENCES.voice_not_configured);
    expect(dialog.textContent).toContain('Ask Dana Rivera.');
    expect(screen.queryByRole('button', { name: 'Set up voice-to-text' })).toBeNull();
    expect(gum()).not.toHaveBeenCalled();
    expect(asked(calls, 'api/transcribe')).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives an admin the door to the Workplace screen’s Voice-to-text section', async () => {
    giveMicrophone();
    const { calls } = mount({ 'GET api/voice': () => voice({ state: 'off', canChange: true }) });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));
    await act(async () => { fireEvent.click(dictate()); });

    expect(screen.getByRole('dialog').textContent).toContain('on the Workplace screen, under Voice-to-text');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up voice-to-text' })); });
    expect(screen.getByTestId('where').textContent).toBe('/workplace#orgVoice');
  });

  // Note #1116: an admin who saved a key in another workplace they run is
  // offered it right here, in one tap, and the next press records.
  it('copies the key from another workplace this admin runs in one tap, then records', async () => {
    giveMicrophone();
    const eldiiar = { orgId: 'org-eldiiar', name: 'Eldiiar' };
    const { calls } = mount({
      'GET api/voice': () => voice({ state: 'off', canChange: true, admin: { key: null, creditLeftUsd: null, month: { month: '2026-11', recordings: 0, seconds: 0, costUsd: 0 }, copyFrom: [eldiiar] } }),
      'POST api/voice/key/copy': () => voice({ state: 'on', canChange: true }),
      'POST api/transcribe': () => ({ text: 'hello' }),
    });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));
    await act(async () => { fireEvent.click(dictate()); });

    const dialog = screen.getByRole('dialog', { name: 'Voice-to-text' });
    expect(dialog.textContent).toContain('You already saved a key in Eldiiar.');
    expect(screen.getByRole('button', { name: 'Use a new key instead' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use the key from Eldiiar' })); });

    const copy = calls.find((call) => call.path === 'api/voice/key/copy');
    expect(JSON.parse(String(copy?.init?.body))).toEqual({ fromOrgId: 'org-eldiiar' });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Voice-to-text is on'));
    expect(screen.getByRole('dialog').textContent).toContain('does not change the other');
    expect(gum()).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Voice-to-text' })).toBeNull();
    await act(async () => { fireEvent.click(dictate()); });
    expect(gum()).toHaveBeenCalled();
  });

  it('keeps the screen open and says why when the copy is refused', async () => {
    giveMicrophone();
    const { calls } = mount({
      'GET api/voice': () => voice({ state: 'off', canChange: true, admin: { key: null, creditLeftUsd: null, month: { month: '2026-11', recordings: 0, seconds: 0, costUsd: 0 }, copyFrom: [{ orgId: 'o2', name: 'Eldiiar' }] } }),
      'POST api/voice/key/copy': () => {
        throw new WorkspaceApiError('OpenRouter no longer accepts the key saved in Eldiiar, so it was not copied. Paste a new key instead.', 400, {});
      },
    });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use the key from Eldiiar' })); });
    expect(screen.getByRole('alert').textContent).toContain('no longer accepts the key saved in Eldiiar');
    expect(screen.getByRole('button', { name: 'Use the key from Eldiiar' })).toBeTruthy();
  });

  it('says a paused workplace is out of credit, in Rosa’s words', async () => {
    giveMicrophone();
    const { calls } = mount({ 'GET api/voice': () => voice({ state: 'paused', reason: 'out_of_credit' }) });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));
    await act(async () => { fireEvent.click(dictate()); });

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Voice-to-text is paused');
    expect(dialog.textContent).toContain(VOICE_ERROR_SENTENCES.voice_out_of_credit);
    expect(gum()).not.toHaveBeenCalled();
  });

  it('records as before when it is on, or when nothing is known yet', async () => {
    giveMicrophone();
    mount({ 'POST api/transcribe': () => ({ text: 'hello' }) });
    await act(async () => { fireEvent.click(dictate()); });
    expect(gum()).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Voice-to-text' })).toBeNull();
  });

  it('records as before when the answer is not one it knows', async () => {
    giveMicrophone();
    const { calls } = mount({ 'GET api/voice': () => ({}), 'POST api/transcribe': () => ({ text: 'hello' }) });
    await waitFor(() => expect(asked(calls, 'api/voice')).toBe(1));
    await act(async () => { fireEvent.click(dictate()); });
    expect(gum()).toHaveBeenCalled();
  });

  it('remembers a refusal, so the next press opens the screen without recording', async () => {
    giveMicrophone();
    mount({
      'POST api/transcribe': () => {
        throw new WorkspaceApiError(VOICE_ERROR_SENTENCES.voice_not_configured, 503, {
          error: VOICE_ERROR_SENTENCES.voice_not_configured, code: 'voice_not_configured',
        });
      },
    });
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop recording' })); });
    await waitFor(() => expect(document.body.textContent).toContain(VOICE_ERROR_SENTENCES.voice_not_configured));
    // Close the review the first recording opened, then press again.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /back/i })); });
    gum().mockClear();

    await act(async () => { fireEvent.click(dictate()); });
    expect(screen.getByRole('dialog', { name: 'Voice-to-text' }).textContent).toContain('not set up yet');
    expect(gum()).not.toHaveBeenCalled();
  });
});

describe('voiceBlockedWords', () => {
  it('names who to ask, and what an admin does', () => {
    expect(voiceBlockedWords({ state: 'off', admins: [], canChange: false }).where).toContain('Ask an admin of this workplace.');
    expect(voiceBlockedWords({ state: 'off', admins: ['A', 'B', 'C'], canChange: false }).where).toContain('Ask A, B or another admin.');
    expect(voiceBlockedWords({ state: 'paused', reason: 'key_rejected', admins: ['A'], canChange: true })).toMatchObject({
      sentence: VOICE_ERROR_SENTENCES.voice_key_rejected,
      action: 'Open voice settings',
    });
  });
});
