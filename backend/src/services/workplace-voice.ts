import type { OrgDocument } from '../types/org.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import {
  DEFAULT_VOICE_MODEL,
  VOICE_MODELS,
  VOICE_MODEL_ID_PATTERN,
  voiceErrorCodeFor,
  voiceModelInfo,
  type VoiceAnswer,
  type VoiceModelOption,
  type VoiceModelsAnswer,
  type VoiceMonthUsage,
  type VoicePauseReason,
  type VoiceState,
} from '../shared/voice.js';
import type { VoiceErrorCode } from '../shared/voice-transcription.js';
import { OpenRouterUnavailableError, type OpenRouterAccount, type OpenRouterTranscriptionModel } from './openrouter-account.js';
import { maskSecretPreview } from './user-secrets.js';

/**
 * A workplace's own voice-to-text (notes #1024, #1026). Every recording is
 * paid by the key the workplace's admin saved, with the model they picked:
 * no platform key, no free minutes, no fallback when the key runs dry.
 *
 * The key is an org secret under the synthetic owner `org:<id>` — the shape
 * the per-turn secret export can never read — so no agent is ever handed it.
 * Settings, the pause and this month's usage are three separate fields on the
 * workplace document, so a recording finishing can never undo an admin's
 * change made at the same moment.
 */

export const VOICE_KEY_SECRET_NAME = 'VOICE_OPENROUTER_KEY';
/** How often a paused workplace asks OpenRouter whether it is good again. */
export const VOICE_PAUSE_RECHECK_MS = 2 * 60_000;
/** With no figure from the moment of the pause, lift it at this much credit. */
export const VOICE_PAUSE_LIFT_MIN_USD = 1;
/** How long OpenRouter's model list and prices are kept. */
export const VOICE_MODELS_CACHE_MS = 24 * 60 * 60_000;
/** How long the admin's "credit left" figure is kept. */
export const VOICE_CREDIT_CACHE_MS = 60_000;

const KEY_MIN = 20;
const KEY_MAX = 400;

export interface VoiceTranscribeArgs {
  apiKey: string;
  model: string;
  audio: Buffer;
  contentType: string;
  fileName: string;
}

export interface VoiceTranscriberResult {
  text: string;
  /** What OpenRouter reported, when it did: cost in USD and seconds heard. */
  costUsd?: number;
  seconds?: number;
}

/** The OpenRouter call itself; throws a {@link VoiceUpstreamError} for an
 *  answer that pauses the workplace, anything else for a passing fault. */
export interface VoiceTranscriber {
  transcribe(args: VoiceTranscribeArgs): Promise<VoiceTranscriberResult>;
}

/** Voice cannot run for this workplace right now, and why (no key, paused). */
export class VoiceUnavailableError extends Error {
  constructor(readonly code: VoiceErrorCode) {
    super(code);
    this.name = 'VoiceUnavailableError';
  }
}

/** An admin's change was refused; `message` is the sentence to show. */
export class VoiceSettingsError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'VoiceSettingsError';
  }
}

export interface WorkplaceVoiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg'>;
  orgSecrets: Pick<OrgSecretsService, 'getOrgSecret' | 'setOrgSecret' | 'deleteOrgSecret'>;
  openRouter: OpenRouterAccount;
  transcriber: VoiceTranscriber;
  /** Classify a transcriber failure: a reason that pauses the workplace, or null. */
  pauseReasonFor: (error: unknown) => VoicePauseReason | null;
  now?: () => number;
}

/** `sk-or-v1-…a3f9`: enough to tell two keys apart, nothing to use. */
export function voiceKeyPreview(key: string): string {
  const match = /^(sk-or-v\d+-)/.exec(key);
  return match && key.length > match[1]!.length + 8 ? `${match[1]}…${key.slice(-4)}` : maskSecretPreview(key);
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export class WorkplaceVoiceService {
  private readonly now: () => number;
  private modelsCache: { at: number; models: OpenRouterTranscriptionModel[] } | null = null;
  private modelsInFlight: Promise<OpenRouterTranscriptionModel[] | null> | null = null;
  private readonly creditCache = new Map<string, { at: number; usd: number | null }>();
  private readonly rechecks = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorkplaceVoiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async org(orgId: string): Promise<OrgDocument> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) throw new VoiceSettingsError('This workplace could not be found.', 404);
    return org;
  }

  private key(orgId: string): Promise<string | null> {
    return this.deps.orgSecrets.getOrgSecret(orgId, VOICE_KEY_SECRET_NAME);
  }

  /**
   * On, off or paused, after asking OpenRouter again when a pause is older
   * than {@link VOICE_PAUSE_RECHECK_MS}: credit topped up on openrouter.ai
   * brings voice back without anyone touching the Workspace.
   */
  async state(orgId: string): Promise<{ state: VoiceState; reason?: VoicePauseReason; pausedAt?: string; org: OrgDocument; key: string | null }> {
    let org = await this.org(orgId);
    const key = await this.key(orgId);
    if (!key) return { state: 'off', org, key };
    if (org.voicePaused) {
      await this.recheck(orgId, org, key);
      org = await this.org(orgId);
    }
    const paused = org.voicePaused;
    return paused
      ? { state: 'paused', reason: paused.reason, pausedAt: paused.at, org, key }
      : { state: 'on', org, key };
  }

  private recheck(orgId: string, org: OrgDocument, key: string): Promise<void> {
    const paused = org.voicePaused!;
    const last = Date.parse(paused.checkedAt ?? paused.at);
    if (Number.isFinite(last) && this.now() - last < VOICE_PAUSE_RECHECK_MS) return Promise.resolve();
    const running = this.rechecks.get(orgId);
    if (running) return running;
    const work = (async () => {
      let good = false;
      try {
        if (paused.reason === 'key_rejected') {
          good = (await this.deps.openRouter.checkKey(key)) === 'ok';
        } else {
          // Some credit can be left while OpenRouter still refuses (it holds
          // back the request's maximum cost): good means somebody added more.
          const left = await this.deps.openRouter.creditLeft(key);
          const before = paused.creditAtPause;
          good = left !== null && (before !== undefined ? left > before + 0.005 : left >= VOICE_PAUSE_LIFT_MIN_USD);
        }
      } catch {
        good = false;
      }
      const current = await this.deps.orgStorage.getOrg(orgId);
      // Only touch the pause this check was about: an admin's new key in the
      // meantime cleared it already, a newer pause is newer news.
      if (!current?.voicePaused || current.voicePaused.at !== paused.at) return;
      await this.deps.orgStorage.updateOrg(orgId, {
        voicePaused: good ? undefined : { ...current.voicePaused, checkedAt: new Date(this.now()).toISOString() },
      });
      if (good) console.log(`[voice-transcription] ${orgId}: OpenRouter answers again; the pause (${paused.reason}) is lifted`);
    })().finally(() => this.rechecks.delete(orgId));
    this.rechecks.set(orgId, work);
    return work;
  }

  modelOf(org: OrgDocument): string {
    return org.voice?.model || DEFAULT_VOICE_MODEL;
  }

  /** The answer for GET api/voice; the admin part only for admins. */
  async answer(orgId: string, viewer: { admin: boolean; admins: string[] }): Promise<VoiceAnswer> {
    const { state, reason, pausedAt, org, key } = await this.state(orgId);
    const modelId = this.modelOf(org);
    const answer: VoiceAnswer = {
      state,
      ...(reason ? { reason } : {}),
      ...(pausedAt ? { pausedAt } : {}),
      model: { id: modelId, name: voiceModelInfo(modelId)?.name ?? modelId },
      admins: viewer.admins,
      canChange: viewer.admin,
    };
    if (viewer.admin) {
      answer.admin = {
        key: key ? {
          preview: voiceKeyPreview(key),
          savedAt: org.voice?.keySavedAt ?? '',
          savedByName: org.voice?.keySavedByName ?? '',
        } : null,
        creditLeftUsd: key ? await this.creditLeft(orgId, key) : null,
        month: this.month(org),
      };
    }
    return answer;
  }

  private async creditLeft(orgId: string, key: string): Promise<number | null> {
    const cached = this.creditCache.get(orgId);
    if (cached && this.now() - cached.at < VOICE_CREDIT_CACHE_MS) return cached.usd;
    const usd = await this.deps.openRouter.creditLeft(key).catch(() => null);
    this.creditCache.set(orgId, { at: this.now(), usd });
    return usd;
  }

  private month(org: OrgDocument): VoiceMonthUsage {
    const month = monthOf(this.now());
    const usage = org.voiceUsage;
    return usage?.month === month
      ? { month, recordings: usage.recordings, seconds: usage.seconds, costUsd: usage.costUsd }
      : { month, recordings: 0, seconds: 0, costUsd: 0 };
  }

  /** Check the key with OpenRouter, then keep it. A re-save is a rotation. */
  async saveKey(orgId: string, rawKey: unknown, byName: string): Promise<void> {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) throw new VoiceSettingsError('Paste the OpenRouter key.', 400);
    if (key.length < KEY_MIN || key.length > KEY_MAX || /\s/.test(key)) {
      throw new VoiceSettingsError('That does not look like an OpenRouter key. It starts with sk-or- and has no spaces.', 400);
    }
    await this.org(orgId);
    let check;
    try {
      check = await this.deps.openRouter.checkKey(key);
    } catch (error) {
      if (error instanceof OpenRouterUnavailableError) {
        throw new VoiceSettingsError('OpenRouter could not be reached to check the key. Try again in a minute.', 503);
      }
      throw error;
    }
    if (check === 'rejected') {
      throw new VoiceSettingsError('OpenRouter did not accept this key. Copy it again from openrouter.ai/keys.', 400, 'voice_key_rejected');
    }
    await this.deps.orgSecrets.setOrgSecret(orgId, VOICE_KEY_SECRET_NAME, key, 'The workplace’s OpenRouter key for voice-to-text, saved by an admin on the Workplace screen.');
    const org = await this.org(orgId);
    await this.deps.orgStorage.updateOrg(orgId, {
      voice: { ...org.voice, keySavedAt: new Date(this.now()).toISOString(), keySavedByName: byName },
      voicePaused: undefined,
    });
    this.creditCache.delete(orgId);
  }

  async removeKey(orgId: string): Promise<void> {
    await this.deps.orgSecrets.deleteOrgSecret(orgId, VOICE_KEY_SECRET_NAME);
    const org = await this.org(orgId);
    const { keySavedAt: _at, keySavedByName: _by, ...rest } = org.voice ?? {};
    await this.deps.orgStorage.updateOrg(orgId, { voice: rest, voicePaused: undefined });
    this.creditCache.delete(orgId);
  }

  async setModel(orgId: string, rawModel: unknown, byName: string): Promise<void> {
    const model = typeof rawModel === 'string' ? rawModel.trim().toLowerCase() : '';
    if (!model) throw new VoiceSettingsError('Choose a model.', 400);
    if (!voiceModelInfo(model)) {
      if (!VOICE_MODEL_ID_PATTERN.test(model)) {
        throw new VoiceSettingsError('An OpenRouter model id looks like maker/model, for example openai/whisper-large-v3.', 400);
      }
      const live = await this.liveModels();
      if (!live) throw new VoiceSettingsError('OpenRouter could not be reached to check that model. Try again in a minute.', 503);
      if (!live.some((entry) => entry.id === model)) {
        throw new VoiceSettingsError(`OpenRouter has no transcription model called ${model}.`, 400);
      }
    }
    const org = await this.org(orgId);
    await this.deps.orgStorage.updateOrg(orgId, {
      voice: { ...org.voice, model, modelChangedAt: new Date(this.now()).toISOString(), modelChangedByName: byName },
    });
  }

  private liveModels(): Promise<OpenRouterTranscriptionModel[] | null> {
    if (this.modelsCache && this.now() - this.modelsCache.at < VOICE_MODELS_CACHE_MS) {
      return Promise.resolve(this.modelsCache.models);
    }
    if (this.modelsInFlight) return this.modelsInFlight;
    this.modelsInFlight = this.deps.openRouter.transcriptionModels()
      .then((models) => {
        this.modelsCache = { at: this.now(), models };
        return models;
      })
      .catch(() => this.modelsCache?.models ?? null)
      .finally(() => { this.modelsInFlight = null; });
    return this.modelsInFlight;
  }

  /** The short list, priced from OpenRouter's live list when it answers. */
  async models(): Promise<VoiceModelsAnswer> {
    const live = await this.liveModels();
    const byId = new Map((live ?? []).map((entry) => [entry.id, entry]));
    const models: VoiceModelOption[] = VOICE_MODELS.map((model) => {
      const entry = byId.get(model.id);
      // Per-second prices convert exactly; a per-token price has no honest
      // per-minute figure, so it keeps the maker's own estimate.
      if (entry && model.billing === 'second' && entry.completion === 0 && entry.prompt > 0) {
        return { ...model, usdPerMinute: entry.prompt * 60, live: true };
      }
      return { ...model, live: false };
    });
    return {
      models,
      pricesCheckedAt: this.modelsCache ? new Date(this.modelsCache.at).toISOString() : null,
    };
  }

  /**
   * One recording, on the workplace's key and model. Throws
   * {@link VoiceUnavailableError} without calling OpenRouter when there is no
   * key or the workplace is paused; pauses it when OpenRouter's answer says
   * no retry can help; lets a passing fault through unchanged.
   */
  async transcribe(orgId: string, recording: Omit<VoiceTranscribeArgs, 'apiKey' | 'model'>): Promise<{ text: string; model: string }> {
    const { state, reason, org, key } = await this.state(orgId);
    if (state !== 'on' || !key) throw new VoiceUnavailableError(voiceErrorCodeFor(state === 'on' ? 'off' : state, reason));
    const model = this.modelOf(org);
    let result: VoiceTranscriberResult;
    try {
      result = await this.deps.transcriber.transcribe({ ...recording, apiKey: key, model });
    } catch (error) {
      const pause = this.deps.pauseReasonFor(error);
      if (pause) {
        const left = pause === 'out_of_credit' ? await this.deps.openRouter.creditLeft(key).catch(() => null) : null;
        await this.deps.orgStorage.updateOrg(orgId, {
          voicePaused: { reason: pause, at: new Date(this.now()).toISOString(), ...(left !== null ? { creditAtPause: left } : {}) },
        });
        this.creditCache.delete(orgId);
        throw new VoiceUnavailableError(voiceErrorCodeFor('paused', pause));
      }
      throw error;
    }
    await this.count(orgId, result).catch(() => undefined);
    return { text: result.text, model };
  }

  private async count(orgId: string, result: VoiceTranscriberResult): Promise<void> {
    const org = await this.org(orgId);
    const month = this.month(org);
    await this.deps.orgStorage.updateOrg(orgId, {
      voiceUsage: {
        month: month.month,
        recordings: month.recordings + 1,
        seconds: month.seconds + (result.seconds ?? 0),
        costUsd: month.costUsd + (result.costUsd ?? 0),
      },
    });
  }
}
