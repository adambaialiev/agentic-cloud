import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_SPEECH_URL, pcmToWav, VoiceSpeechService } from '../../services/voice-speech-service.js';
import { voicePauseReasonFor } from '../../services/voice-transcription-service.js';

/** Note #1146: OpenRouter's text to speech, on the workplace's own key. */
const KEY = 'sk-or-v1-feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface0001';
const ARGS = { apiKey: KEY, model: 'elevenlabs/eleven-v4-turbo', voice: 'sarah', format: 'mp3', text: 'I proposed the pricing page.' };

const audio = (bytes = 'mp3') => new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
const refusal = (status: number, message: string) => new Response(JSON.stringify({ error: { message, code: status } }), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('VoiceSpeechService', () => {
  it('asks OpenRouter for the words with the key in the header only, and hands back the audio', async () => {
    const doFetch = vi.fn().mockResolvedValue(audio('mp3-bytes'));
    const result = await new VoiceSpeechService(doFetch as never, 0).speak(ARGS);
    expect(result).toEqual({ audio: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_SPEECH_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ model: ARGS.model, voice: 'sarah', input: ARGS.text, response_format: 'mp3' });
  });

  it('tries a passing fault once more, and says nothing of the key when it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flaky = vi.fn().mockResolvedValueOnce(refusal(503, 'busy')).mockResolvedValueOnce(audio());
    await expect(new VoiceSpeechService(flaky as never, 0).speak(ARGS)).resolves.toMatchObject({ contentType: 'audio/mpeg' });
    expect(flaky).toHaveBeenCalledTimes(2);

    const down = vi.fn().mockResolvedValue(refusal(500, `upstream broke for ${KEY}`));
    await expect(new VoiceSpeechService(down as never, 0).speak(ARGS)).rejects.toMatchObject({ code: 'upstream_error', upstreamStatus: 500 });
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('[voice-speech] speech failed');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(ARGS.text);
  });

  it('treats 402 and 401 as configuration: no retry, and they pause voice like a recording would', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const [status, code] of [[402, 'out_of_credit'], [401, 'key_rejected']] as const) {
      const doFetch = vi.fn().mockResolvedValue(refusal(status, 'no'));
      const error = await new VoiceSpeechService(doFetch as never, 0).speak(ARGS).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code });
      expect(voicePauseReasonFor(error)).toBe(code);
      expect(doFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses an answer that is not audio, and a network that never answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const html = vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(new VoiceSpeechService(html as never, 0).speak(ARGS)).rejects.toMatchObject({ code: 'upstream_error' });
    const offline = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new VoiceSpeechService(offline as never, 0).speak(ARGS)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(offline).toHaveBeenCalledTimes(2);
  });
});

describe('pcmToWav (note #1151)', () => {
  it('wraps Gemini’s raw PCM as a WAV a browser can play, at the rate OpenRouter names', async () => {
    const pcm = Buffer.alloc(4800);
    const doFetch = vi.fn().mockResolvedValue(new Response(pcm, { status: 200, headers: { 'Content-Type': 'audio/pcm;rate=24000;channels=1' } }));
    const result = await new VoiceSpeechService(doFetch as never, 0).speak({ ...ARGS, model: 'google/gemini-3.8-flash-tts', voice: 'Kore', format: 'pcm' });
    expect(result.contentType).toBe('audio/wav');
    expect(result.audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(result.audio.readUInt32LE(24)).toBe(24000);
    expect(result.audio.readUInt32LE(40)).toBe(4800);
    expect(pcmToWav(pcm, 'audio/pcm').length).toBe(4844);
  });
});
