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

// Note #1023: every recording failed for days while OpenRouter answered 402
// and the journal said nothing.
describe('VoiceTranscriptionService provider refusals', () => {
  const OUT_OF_CREDIT = {
    error: {
      message: "This request's maximum cost exceeds your available credits. Add credits.",
      code: 402,
      metadata: { reason: 'weight_exceeds_budget', limit_source: 'openrouter_credits' },
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function logged(warn: ReturnType<typeof vi.spyOn>): string {
    return warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('calls a 402 out of credit, answers 503, does not retry, and logs what the provider said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(OUT_OF_CREDIT, { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createService().transcribe(REQUEST)).rejects.toMatchObject({
      code: 'out_of_credit',
      statusCode: 503,
      upstreamStatus: 402,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const lines = logged(warn);
    expect(lines).toContain('[voice-transcription]');
    expect(lines).toContain('provider=openrouter');
    expect(lines).toContain('model=openai/whisper-large-v3');
    expect(lines).toContain('upstream=402');
    expect(lines).toContain('code=out_of_credit');
    expect(lines).toContain('maximum cost exceeds your available credits');
    expect(lines).not.toContain('test-openrouter-key');
  });

  it('calls a 401 a rejected key, answers 503, does not retry, and never logs the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { error: { message: 'No auth credentials found for key test-openrouter-key sk-or-v1-abcdef123456', code: 401 } },
      { status: 401 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createService().transcribe(REQUEST)).rejects.toMatchObject({
      code: 'key_rejected',
      statusCode: 503,
      upstreamStatus: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const lines = logged(warn);
    expect(lines).toContain('upstream=401');
    expect(lines).toContain('code=key_rejected');
    expect(lines).not.toContain('test-openrouter-key');
    expect(lines).not.toContain('sk-or-v1-abcdef');
  });

  it('keeps a repeated 5xx a retryable upstream error and logs the final answer', async () => {
    vi.stubGlobal('setTimeout', ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: 'Provider returned error', code: 503 } }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createService().transcribe(REQUEST)).rejects.toMatchObject({
      code: 'upstream_error',
      statusCode: 502,
      upstreamStatus: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const lines = logged(warn);
    expect(lines).toContain('transcription failed: provider=openrouter');
    expect(lines).toContain('upstream=503 code=upstream_error');
  });

  it('logs a request that never got an answer as no answer', async () => {
    vi.stubGlobal('setTimeout', ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')));

    await expect(createService().transcribe(REQUEST)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(logged(warn)).toContain('upstream=no answer code=upstream_error');
  });

  it('calls OpenAI insufficient_quota out of credit too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new VoiceTranscriptionService({ ...createDeps(), provider: 'openai', model: 'gpt-4o-mini-transcribe', apiKey: 'sk-proj-secretsecret' });
    vi.spyOn(service as unknown as { transcribeWithOpenAI: () => Promise<never> }, 'transcribeWithOpenAI')
      .mockRejectedValue(Object.assign(new Error('429 You exceeded your current quota. Key sk-proj-****cret'), { status: 429, code: 'insufficient_quota' }));

    await expect(service.transcribe(REQUEST)).rejects.toMatchObject({ code: 'out_of_credit', statusCode: 503, upstreamStatus: 429 });
    const lines = logged(warn);
    expect(lines).toContain('provider=openai');
    expect(lines).not.toContain('sk-proj');
  });
});
