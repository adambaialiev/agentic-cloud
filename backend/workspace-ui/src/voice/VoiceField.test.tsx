import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BannerProvider } from '../chrome/Banner.js';
import { ChatComposer } from '../screens/chat/ChatComposer.js';
import { SessionProvider } from '../session/SessionProvider.js';
import { scriptedApi, signedIn, type Call } from '../test/fixtures.js';
import { ImageViewerProvider } from '../ui/ImageViewer.js';
import {
  barScales, forgetMicrophone, giveMicrophone, openDialogsInJsdom, paint, room, stopTrack,
} from './fake-microphone.js';
import { VOICE_WAVE_BARS, VOICE_WAVE_FLOOR } from './voice-input.js';
import { WorkspaceApiError } from '../api/client.js';
import { VoiceField } from './VoiceField.js';
import { VOICE_ERROR_SENTENCES } from '../../../src/shared/voice-transcription.js';

/**
 * The microphone at a real call site — the chat composer — rather than at a
 * harness invented for the test. What it has to prove is what note #233 asked
 * for: that the bars are the microphone's own signal, so a flat strip means
 * silence rather than a broken meter.
 */

function mount(transcribe: (call: Call) => unknown = () => ({ text: 'ship it on Friday' }), onSend = vi.fn<(text: string, files: File[]) => Promise<boolean>>().mockResolvedValue(true)) {
  const { api, calls } = scriptedApi({
    'GET auth/session': () => signedIn(),
    'POST api/transcribe': transcribe,
  });
  render(
    <SessionProvider api={api}>
      <BannerProvider>
        <ImageViewerProvider>
          <ChatComposer sending={false} onSend={onSend} onRefuse={() => {}} />
        </ImageViewerProvider>
      </BannerProvider>
    </SessionProvider>,
  );
  return { calls, onSend };
}

const box = () => screen.getByPlaceholderText('Message') as HTMLTextAreaElement;
const dictate = () => screen.getByRole('button', { name: 'Dictate into Message' });
const listening = () => screen.getByRole('button', { name: 'Stop recording' });
const reviewBox = () => screen.getByRole('textbox', { name: 'Your message' }) as HTMLTextAreaElement;

beforeEach(() => { openDialogsInJsdom(); });

afterEach(() => { forgetMicrophone(); });

describe('the microphone in a writing field', () => {
  it('shows the live wave while it records, and the bars follow the room', async () => {
    giveMicrophone();
    mount();

    await act(async () => { fireEvent.click(dictate()); });
    const stop = listening();
    expect(stop.className).toContain('recording');
    // The analyser is running, so the ring follows the signal instead of a timer.
    expect(stop.className).toContain('metered');
    expect(document.querySelectorAll('.voicewave > span')).toHaveLength(VOICE_WAVE_BARS);

    room.amplitude = 0.35;
    for (let step = 1; step <= VOICE_WAVE_BARS; step += 1) paint(step * 100);
    const speaking = barScales();
    expect(speaking).toHaveLength(VOICE_WAVE_BARS);
    expect(Math.max(...speaking)).toBeGreaterThan(0.5);

    // The room goes quiet: the same strip settles back to its floor, which is
    // the whole point — a wave that keeps moving is not reading a microphone.
    room.amplitude = 0;
    for (let step = 1; step <= VOICE_WAVE_BARS; step += 1) paint((VOICE_WAVE_BARS + step) * 100);
    expect(Math.max(...barScales())).toBeCloseTo(VOICE_WAVE_FLOOR, 2);
  });

  it('sends the recording and puts what came back into the words', async () => {
    giveMicrophone();
    const { calls, onSend } = mount();

    fireEvent.change(box(), { target: { value: 'Tell Ada' } });
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    await waitFor(() => expect(box().value).toBe('Tell Ada ship it on Friday'));
    const upload = calls.find((call) => call.path === 'api/transcribe');
    expect(upload?.init?.method).toBe('POST');
    expect((upload?.init?.headers as Record<string, string>)['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(upload?.init?.body).toBeInstanceOf(Blob);
    // The wave is gone with the recording, and the physical microphone with it.
    expect(document.querySelector('.voicewave')).toBeNull();
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dictate into Message' })).toBeTruthy();
    expect(reviewBox().value).toBe('Tell Ada ship it on Friday');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(reviewBox(), { target: { value: 'Tell Ada: ship it on Monday.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
    expect(onSend).toHaveBeenCalledWith('Tell Ada: ship it on Monday.', []);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(box().value).toBe('');
  });

  it('says so when nothing was heard, and leaves the words alone', async () => {
    giveMicrophone();
    mount(() => ({ text: '   ' }));

    fireEvent.change(box(), { target: { value: 'kept' } });
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No words were heard'));
    expect(box().value).toBe('kept');
  });

  it('passes the transcriber’s own refusal on rather than a generic one', async () => {
    giveMicrophone();
    mount(() => { throw new WorkspaceApiError('That recording was too quiet.', 400, { error: 'That recording was too quiet.' }); });

    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('too quiet'));
    expect(screen.getByRole('button', { name: 'Try recording again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dictate into Message' })).toBeTruthy();
  });

  // Note #1023: every recording failed with "Request failed (502)" while the
  // account that pays for transcription was out of credit.
  it('says plainly that voice-to-text is out of credit and who can fix it, with no retry', async () => {
    giveMicrophone();
    mount(() => {
      throw new WorkspaceApiError(VOICE_ERROR_SENTENCES.voice_out_of_credit, 503, {
        error: VOICE_ERROR_SENTENCES.voice_out_of_credit, code: 'voice_out_of_credit',
      });
    });

    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(VOICE_ERROR_SENTENCES.voice_out_of_credit);
    expect(alert.textContent).toContain('run out of credit');
    expect(alert.textContent).toContain('owner or an admin of this workplace');
    expect(alert.textContent).not.toMatch(/\b(402|502|503|OpenRouter|API)\b/);
    expect(screen.queryByRole('button', { name: 'Try recording again' })).toBeNull();
  });

  it('says the key no longer works when the provider refuses it, with no retry', async () => {
    giveMicrophone();
    mount(() => {
      throw new WorkspaceApiError(VOICE_ERROR_SENTENCES.voice_key_rejected, 503, {
        error: VOICE_ERROR_SENTENCES.voice_key_rejected, code: 'voice_key_rejected',
      });
    });

    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('key no longer works');
    expect(screen.queryByRole('button', { name: 'Try recording again' })).toBeNull();
  });

  it('says the same out-of-credit sentence from an inline microphone, which has no full-screen recorder', async () => {
    giveMicrophone();
    const { api } = scriptedApi({
      'GET auth/session': () => signedIn(),
      'POST api/transcribe': () => {
        throw new WorkspaceApiError(VOICE_ERROR_SENTENCES.voice_out_of_credit, 503, {
          error: VOICE_ERROR_SENTENCES.voice_out_of_credit, code: 'voice_out_of_credit',
        });
      },
    });
    render(
      <SessionProvider api={api}>
        <BannerProvider>
          <VoiceField onTranscript={() => {}}><input aria-label="Workplace name" defaultValue="" /></VoiceField>
        </BannerProvider>
      </SessionProvider>,
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dictate into Workplace name' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop recording for Workplace name' })); });

    await waitFor(() => expect(document.body.textContent).toContain(VOICE_ERROR_SENTENCES.voice_out_of_credit));
    expect(document.body.textContent).not.toContain('Request failed');
  });

  it('turns an unreadable failure into a plain sentence instead of "Request failed (502)", and keeps retry', async () => {
    giveMicrophone();
    // What the client throws when the answer carried no sentence: an error
    // page from something in between, or an empty body.
    mount(() => { throw new WorkspaceApiError('Request failed (502)', 502, null); });

    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not transcribe that recording. Try again.');
    expect(alert.textContent).not.toContain('Request failed');
    expect(screen.getByRole('button', { name: 'Try recording again' })).toBeTruthy();
  });

  it('says the microphone is off when the browser refuses it', async () => {
    giveMicrophone();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }) },
      configurable: true,
    });
    mount();

    await act(async () => { fireEvent.click(dictate()); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Allow it for this site'));
    expect(screen.getByRole('button', { name: 'Dictate into Message' })).toBeTruthy();
  });

  it('says plainly when the browser has no way to record at all', async () => {
    mount();
    await act(async () => { fireEvent.click(dictate()); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not supported by this browser'));
  });

  it('keeps corrected text and attachments after a refused send, then sends them once on retry', async () => {
    giveMicrophone();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }));
    const onSend = vi.fn<(text: string, files: File[]) => Promise<boolean>>().mockResolvedValue(false);
    mount(undefined, onSend);
    const file = new File(['photo'], 'image.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('agentChatFile')!, { target: { files: [file] } });
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });
    fireEvent.change(reviewBox(), { target: { value: 'Check this photo on Monday.' } });
    expect(document.querySelector('.voicereview .chatdraftitem .name')?.textContent).toBe('image.png');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
    expect(screen.getByRole('alert').textContent).toContain('Your draft is still here');
    expect(reviewBox().value).toBe('Check this photo on Monday.');
    // The pick is still on the draft, and the strip under the box is what
    // says so — there is no longer a count beside Send saying it for them.
    expect(document.querySelector('.voicereview .chatdraftitem .name')?.textContent).toBe('image.png');
    expect(onSend).toHaveBeenLastCalledWith('Check this photo on Monday.', [file]);
    onSend.mockResolvedValue(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.getElementById('agentChatDraft')?.hidden).toBe(true);
  });

  it('adds files from the review and opens a picked picture over that screen', async () => {
    giveMicrophone();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:review-photo'), revokeObjectURL: vi.fn() }));
    const { onSend } = mount();
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });

    const review = document.querySelector<HTMLDialogElement>('.voicereview')!;
    expect(review.querySelector('.voicereview-attach')?.textContent).toContain('Attach files');
    const file = new File(['photo'], 'review.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('voiceReviewFile')!, { target: { files: [file] } });
    await waitFor(() => expect(review.querySelector('.voicereview-draft')?.hasAttribute('hidden')).toBe(false));
    expect(review.querySelector('.chatdraftitem .name')?.textContent).toBe('review.png');

    const preview = review.querySelector<HTMLButtonElement>('[aria-label="Preview review.png full screen"]')!;
    fireEvent.click(preview);
    const viewer = document.getElementById('imageViewer')!;
    expect(viewer).toBeTruthy();
    // A document child cannot rise above a native modal. The shared viewer
    // is portaled into the review, so it genuinely covers the screen.
    expect(viewer.parentElement).toBe(review);
    expect(document.getElementById('imageViewerName')?.textContent).toBe('review.png');
    fireEvent.click(document.getElementById('imageViewerClose')!);
    expect(document.getElementById('imageViewer')).toBeNull();
    expect(review.open).toBe(true);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
    expect(onSend).toHaveBeenCalledWith('ship it on Friday', [file]);
  });

  it('keeps a corrected draft when Back closes the review', async () => {
    giveMicrophone();
    const { onSend } = mount();
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });
    fireEvent.change(reviewBox(), { target: { value: 'Keep this correction.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(box().value).toBe('Keep this correction.');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('cancels a recording without uploading, and leaves the existing draft intact', async () => {
    giveMicrophone();
    const { calls } = mount();
    fireEvent.change(box(), { target: { value: 'Already written.' } });
    await act(async () => { fireEvent.click(dictate()); });
    stopTrack.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(box().value).toBe('Already written.');
    expect(stopTrack).toHaveBeenCalled();
    expect(calls.filter((call) => call.path === 'api/transcribe')).toHaveLength(0);
  });

  it('hands back a microphone granted after the user has already canceled', async () => {
    giveMicrophone();
    let grant!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const { calls } = mount();
    await act(async () => { fireEvent.click(dictate()); });
    expect(screen.getByRole('status').textContent).toContain('Waiting for microphone');
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    stopTrack.mockClear();
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream); });
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((call) => call.path === 'api/transcribe')).toHaveLength(0);
  });

  it('aborts transcription on Escape and ignores a late transcript', async () => {
    giveMicrophone();
    let answer!: (result: { text: string }) => void;
    const { calls } = mount(() => new Promise((resolve) => { answer = resolve; }));
    fireEvent.change(box(), { target: { value: 'Keep me.' } });
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });
    expect(screen.getByRole('status').textContent).toContain('Turning your voice');
    const signal = calls.find((call) => call.path === 'api/transcribe')?.init?.signal;
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(signal?.aborted).toBe(true);
    await act(async () => { answer({ text: 'must not appear' }); });
    expect(box().value).toBe('Keep me.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops at the recording limit and opens the review without sending', async () => {
    giveMicrophone();
    const schedule = window.setTimeout;
    let limit!: () => void;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 90_000) { limit = callback; return 0; }
      return schedule(callback, delay);
    }) as typeof setTimeout);
    const { onSend } = mount();
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { limit(); });
    expect(reviewBox().value).toBe('ship it on Friday');
    expect(onSend).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('keeps a new recording active when an older canceled transcription finishes', async () => {
    giveMicrophone();
    let answer!: (result: { text: string }) => void;
    mount(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { answer({ text: 'old recording' }); });
    expect(listening()).toBeTruthy();
    expect(box().value).toBe('');
    expect(document.querySelectorAll('.voicewave > span')).toHaveLength(VOICE_WAVE_BARS);
  });

  it('prevents duplicate sends and closing while the message is in flight', async () => {
    giveMicrophone();
    let finishSend!: (sent: boolean) => void;
    const onSend = vi.fn<(text: string, files: File[]) => Promise<boolean>>(() => new Promise((resolve) => { finishSend = resolve; }));
    mount(undefined, onSend);
    await act(async () => { fireEvent.click(dictate()); });
    await act(async () => { fireEvent.click(listening()); });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(reviewBox().readOnly).toBe(true);
    expect((screen.getByRole('button', { name: 'Back to chat' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishSend(true); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels recording when the tab is hidden', async () => {
    giveMicrophone();
    const { calls } = mount();
    await act(async () => { fireEvent.click(dictate()); });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((call) => call.path === 'api/transcribe')).toHaveLength(0);
  });

  it('gives the microphone back when the screen goes away mid-recording', async () => {
    giveMicrophone();
    const { unmount } = render(
      <SessionProvider api={scriptedApi({ 'GET auth/session': () => signedIn() }).api}>
        <BannerProvider>
          <ChatComposer sending={false} onSend={async () => true} onRefuse={() => {}} />
        </BannerProvider>
      </SessionProvider>,
    );
    await act(async () => { fireEvent.click(dictate()); });
    stopTrack.mockClear();
    unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
});
