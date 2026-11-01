import type { ConfigDocSource } from './sqlite/sqlite-config-docs.js';
import { DEFAULT_MODEL, isSupportedModel } from '../config/models.js';

const AGENT_CONFIG_COLLECTION = 'config';
const AGENT_CONFIG_DOCUMENT = 'agent';
const CACHE_TTL_MS = 60_000;

interface AgentModelValues {
  telegramModel: string;
  telegramSidecarModel: string;
}

/**
 * Per-surface model selections from the config/agent doc. Read-only from the
 * app: the doc is written out-of-band (operator scripts); the admin web UI
 * that mutated it is gone.
 */
export class AgentConfigService {
  private cachedConfig: AgentModelValues | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly configDocs: ConfigDocSource | null) {}

  async getTelegramModel(): Promise<string> {
    return (await this.getModelValues()).telegramModel;
  }

  async getTelegramSidecarModel(): Promise<string> {
    return (await this.getModelValues()).telegramSidecarModel;
  }

  clearCache(): void {
    this.cachedConfig = null;
    this.cacheExpiresAt = 0;
  }

  private async getModelValues(): Promise<AgentModelValues> {
    const now = Date.now();
    if (this.cachedConfig && now < this.cacheExpiresAt) {
      return this.cachedConfig;
    }

    if (!this.configDocs) {
      return this.setCache({
        telegramModel: DEFAULT_MODEL,
        telegramSidecarModel: DEFAULT_MODEL,
      });
    }

    try {
      const snapshot = await this.configDocs
        .collection(AGENT_CONFIG_COLLECTION)
        .doc(AGENT_CONFIG_DOCUMENT)
        .get();
      const data = snapshot.data();
      const telegramModel = isSupportedModel(data?.telegramModel)
        ? data.telegramModel
        : DEFAULT_MODEL;
      const telegramSidecarModel = isSupportedModel(data?.telegramSidecarModel)
        ? data.telegramSidecarModel
        : DEFAULT_MODEL;
      return this.setCache({
        telegramModel,
        telegramSidecarModel,
      });
    } catch (error) {
      console.warn('[agent-config] Failed to read agent model config:', error);
      return this.setCache({
        telegramModel: DEFAULT_MODEL,
        telegramSidecarModel: DEFAULT_MODEL,
      });
    }
  }

  private setCache(config: AgentModelValues): AgentModelValues {
    this.cachedConfig = config;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return config;
  }
}
