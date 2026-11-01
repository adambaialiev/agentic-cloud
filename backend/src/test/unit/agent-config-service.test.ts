import { describe, expect, it, vi } from 'vitest';
import type { ConfigDocSource } from '../../services/sqlite/sqlite-config-docs.js';
import { AgentConfigService } from '../../services/agent-config-service.js';
import { DEFAULT_MODEL } from '../../config/models.js';

function createConfigDocMock(initialData: Record<string, unknown>) {
  const data = { ...initialData };
  const get = vi.fn().mockResolvedValue({
    data: () => ({ ...data }),
  });
  const doc = vi.fn().mockReturnValue({ get });
  const collection = vi.fn().mockReturnValue({ doc });

  return {
    configDocs: { collection } as unknown as ConfigDocSource,
    data,
    get,
  };
}

describe('AgentConfigService', () => {
  it('reads the Telegram and sidecar models from config/agent', async () => {
    const { configDocs } = createConfigDocMock({
      telegramModel: 'openai/gpt-5.4',
      telegramSidecarModel: 'openai/gpt-5.4',
    });
    const service = new AgentConfigService(configDocs);

    await expect(service.getTelegramModel()).resolves.toBe('openai/gpt-5.4');
    await expect(service.getTelegramSidecarModel()).resolves.toBe('openai/gpt-5.4');
  });

  it('falls back to the default model for unsupported or missing values', async () => {
    const { configDocs } = createConfigDocMock({ telegramModel: 'not-a-real-model' });
    const service = new AgentConfigService(configDocs);

    await expect(service.getTelegramModel()).resolves.toBe(DEFAULT_MODEL);
    await expect(service.getTelegramSidecarModel()).resolves.toBe(DEFAULT_MODEL);
  });

  it('returns defaults without a config-doc source', async () => {
    const service = new AgentConfigService(null);
    await expect(service.getTelegramModel()).resolves.toBe(DEFAULT_MODEL);
  });

  it('caches reads until clearCache', async () => {
    const { configDocs, get } = createConfigDocMock({});
    const service = new AgentConfigService(configDocs);

    await service.getTelegramModel();
    await service.getTelegramSidecarModel();
    expect(get).toHaveBeenCalledTimes(1);

    service.clearCache();
    await service.getTelegramModel();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
