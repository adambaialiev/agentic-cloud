import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceTranscriptionError,
  VoiceTranscriptionService,
  type VoiceTranscriptionServiceDeps,
} from '../../services/voice-transcription-service.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function createDeps(): VoiceTranscriptionServiceDeps {
  return {
    userStorage: {
      deductBalance: vi.fn().mockResolvedValue(true),
      getBalance: vi.fn().mockResolvedValue(1000),
      getProfile: vi.fn().mockResolvedValue(undefined),
    } as unknown as VoiceTranscriptionServiceDeps['userStorage'],
    usageService: {
      checkSpendAllowance: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as VoiceTranscriptionServiceDeps['usageService'],
    eventEmitter: {
      emit: vi.fn(),
    } as unknown as VoiceTranscriptionServiceDeps['eventEmitter'],
    apiKey: 'test-openrouter-key',
    model: 'openai/whisper-large-v3',
    provider: 'openrouter',
  };
}

function createService(): VoiceTranscriptionService {
  return new VoiceTranscriptionService(createDeps());
}

const REQUEST = {
  userId: 'user-1',
  audio: Buffer.from('fake-audio-bytes'),
  contentType: 'audio/ogg',
  fileName: 'recording.ogg',
};

describe('VoiceTranscriptionService OpenRouter retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retries a 429 response and succeeds on a later attempt', async () => {
    // Skip real backoff delays.
    vi.stubGlobal('setTimeout', ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'Provider returned 429' }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ text: 'hello world' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createService().transcribe(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('hello world');
  });

  it('gives up after exhausting retries on repeated 429s', async () => {
    vi.stubGlobal('setTimeout', ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'Provider returned 429' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createService().transcribe(REQUEST)).rejects.toMatchObject({
      code: 'upstream_error',
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable 400 response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'bad audio' }, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createService().transcribe(REQUEST)).rejects.toBeInstanceOf(VoiceTranscriptionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
