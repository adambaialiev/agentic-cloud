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
  type VoiceKeySource,
  type VoiceModelOption,
  type VoiceModelsAnswer,
  type VoiceMonthUsage,
  type VoicePauseReason,
  type VoiceState,
} from '../shared/voice.js';
import type { VoiceErrorCode } from '../shared/voice-transcription.js';
import { createHash } from 'node:crypto';
import {
  RECAP_SPEECH_FORMAT, RECAP_SPEECH_MODEL, RECAP_SPEECH_SAMPLE, RECAP_SPEECH_VOICE,
  speechUsdPerRecap, speechVoiceName,
  type RecapSpeechSetting, type SpeechModelOption, type SpeechModelsAnswer,
} from '../shared/voice-speech.js';
import { OpenRouterUnavailableError, type OpenRouterAccount, type OpenRouterSpeechModel, type OpenRouterTranscriptionModel } from './openrouter-account.js';
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

export interface VoiceSpeakArgs {
  apiKey: string;
  model: string;
  voice: string;
  format: string;
  text: string;
}

export interface VoiceSpeakerResult {
  audio: Buffer;
  contentType: string;
}

/** OpenRouter's text to speech (note #1146); throws as the transcriber does. */
export interface VoiceSpeaker {
  speak(args: VoiceSpeakArgs): Promise<VoiceSpeakerResult>;
}

/** How many spoken recaps are kept, all workplaces together: a replay, or a
 *  second tab, plays the same audio without paying for it again. */
export const SPOKEN_CACHE_ENTRIES = 48;

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
  /** Reads the Chief of Staff's recap aloud (note #1146); absent → no speech. */
  speaker?: VoiceSpeaker;
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
  /** Spoken recaps by workplace, model, voice and words, newest last. */
  private readonly spoken = new Map<string, VoiceSpeakerResult>();
  private speechCache: { at: number; models: SpeechModelOption[] } | null = null;
  private speechInFlight: Promise<SpeechModelOption[] | null> | null = null;

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
  async answer(orgId: string, viewer: { admin: boolean; admins: string[]; alsoAdminOf?: readonly string[] }): Promise<VoiceAnswer> {
    const { state, reason, pausedAt, org, key } = await this.state(orgId);
    const modelId = this.modelOf(org);
    const answer: VoiceAnswer = {
      state,
      ...(reason ? { reason } : {}),
      ...(pausedAt ? { pausedAt } : {}),
      model: { id: modelId, name: voiceModelInfo(modelId)?.name ?? modelId },
      admins: viewer.admins,
      canChange: viewer.admin,
      ...(key ? { speech: await this.speechSetting(org) } : {}),
    };
    if (viewer.admin) {
      answer.admin = {
        key: key ? {
          preview: voiceKeyPreview(key),
          savedAt: org.voice?.keySavedAt ?? '',
          savedByName: org.voice?.keySavedByName ?? '',
          ...(org.voice?.keyCopiedFromName ? { copiedFromName: org.voice.keyCopiedFromName } : {}),
        } : null,
        creditLeftUsd: key ? await this.creditLeft(orgId, key) : null,
        month: this.month(org),
      };
      if (!key && viewer.alsoAdminOf?.length) {
        const copyFrom = await this.copySources(orgId, viewer.alsoAdminOf);
        if (copyFrom.length) answer.admin.copyFrom = copyFrom;
      }
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
    await this.check(key, 'OpenRouter did not accept this key. Copy it again from openrouter.ai/keys.');
    await this.keep(orgId, key, byName);
  }

  /**
   * Of the other workplaces this admin also runs, those holding a key, by
   * name (note #1116). The caller decides who is an admin where; this only
   * looks for keys, and never returns one.
   */
  async copySources(orgId: string, otherOrgIds: readonly string[]): Promise<VoiceKeySource[]> {
    const found = await Promise.all([...new Set(otherOrgIds)]
      .filter((other) => other && other !== orgId)
      .map(async (other): Promise<VoiceKeySource | null> => {
        const [org, key] = await Promise.all([
          this.deps.orgStorage.getOrg(other).catch(() => null),
          this.key(other).catch(() => null),
        ]);
        return org && key ? { orgId: other, name: org.name } : null;
      }));
    return found.filter((source): source is VoiceKeySource => source !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Copy another workplace's key into this one, server side, once (note
   * #1116, Adam: "if I am admin for both of course" — the route checks
   * both). The value is read and re-stored here and never sent anywhere but
   * OpenRouter's key check; the copy is this workplace's own secret from
   * then on, and nothing ties the two together afterwards.
   */
  async copyKey(orgId: string, fromOrgId: string, byName: string): Promise<void> {
    if (!fromOrgId || fromOrgId === orgId) throw new VoiceSettingsError('Choose another workplace to copy the key from.', 400);
    await this.org(orgId);
    if (await this.key(orgId)) {
      throw new VoiceSettingsError('This workplace already has a key. Replace it here instead.', 409, 'voice_key_exists');
    }
    const from = await this.deps.orgStorage.getOrg(fromOrgId);
    const key = from ? await this.key(fromOrgId) : null;
    if (!from || !key) throw new VoiceSettingsError('That workplace has no voice-to-text key to copy.', 404);
    await this.check(key, `OpenRouter no longer accepts the key saved in ${from.name}, so it was not copied. Paste a new key instead.`);
    await this.keep(orgId, key, byName, from.name);
  }

  private async check(key: string, rejected: string): Promise<void> {
    let check;
    try {
      check = await this.deps.openRouter.checkKey(key);
    } catch (error) {
      if (error instanceof OpenRouterUnavailableError) {
        throw new VoiceSettingsError('OpenRouter could not be reached to check the key. Try again in a minute.', 503);
      }
      throw error;
    }
    if (check === 'rejected') throw new VoiceSettingsError(rejected, 400, 'voice_key_rejected');
  }

  private async keep(orgId: string, key: string, byName: string, copiedFromName?: string): Promise<void> {
    await this.deps.orgSecrets.setOrgSecret(orgId, VOICE_KEY_SECRET_NAME, key, 'The workplace’s OpenRouter key for voice-to-text, saved by an admin on the Workplace screen.');
    const org = await this.org(orgId);
    const { keyCopiedFromName: _from, ...voice } = org.voice ?? {};
    await this.deps.orgStorage.updateOrg(orgId, {
      voice: {
        ...voice,
        keySavedAt: new Date(this.now()).toISOString(),
        keySavedByName: byName,
        ...(copiedFromName ? { keyCopiedFromName: copiedFromName } : {}),
      },
      voicePaused: undefined,
    });
    this.creditCache.delete(orgId);
  }

  async removeKey(orgId: string): Promise<void> {
    await this.deps.orgSecrets.deleteOrgSecret(orgId, VOICE_KEY_SECRET_NAME);
    const org = await this.org(orgId);
    const { keySavedAt: _at, keySavedByName: _by, keyCopiedFromName: _from, ...rest } = org.voice ?? {};
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

  /** The model and voice this workplace reads recaps with (note #1151). */
  speechOf(org: OrgDocument): { model: string; voice: string } {
    const model = org.voice?.speechModel, voice = org.voice?.speechVoice;
    return model && voice ? { model, voice } : { model: RECAP_SPEECH_MODEL, voice: RECAP_SPEECH_VOICE };
  }

  private async speechSetting(org: OrgDocument): Promise<RecapSpeechSetting> {
    const { model, voice } = this.speechOf(org);
    const known = model === RECAP_SPEECH_MODEL ? undefined : (await this.liveSpeechModels())?.find((entry) => entry.id === model);
    return {
      model, voice,
      modelName: known?.name ?? (model === RECAP_SPEECH_MODEL ? 'ElevenLabs: Eleven v4 Turbo' : model),
      voiceName: speechVoiceName(voice),
      isDefault: model === RECAP_SPEECH_MODEL && voice === RECAP_SPEECH_VOICE,
      ...(org.voice?.speechChangedByName ? { changedByName: org.voice.speechChangedByName } : {}),
      ...(org.voice?.speechChangedAt ? { changedAt: org.voice.speechChangedAt } : {}),
      ...(org.voiceSpeechProblem ? { problem: org.voiceSpeechProblem } : {}),
    };
  }

  /**
   * What OpenRouter offers for speech, as the chooser shows it: every model
   * that names its voices and has a price, the free variants left out (they
   * are rate-limited copies). Kept a day; null when OpenRouter never answered.
   */
  private liveSpeechModels(): Promise<SpeechModelOption[] | null> {
    if (this.speechCache && this.now() - this.speechCache.at < VOICE_MODELS_CACHE_MS) return Promise.resolve(this.speechCache.models);
    if (!this.deps.openRouter.speechModels) return Promise.resolve(null);
    if (this.speechInFlight) return this.speechInFlight;
    this.speechInFlight = this.deps.openRouter.speechModels()
      .then((list) => {
        const models = list
          .filter((entry: OpenRouterSpeechModel) => entry.voices.length > 0 && !entry.id.endsWith(':free'))
          .map((entry): SpeechModelOption => {
            const price = speechUsdPerRecap(entry.prompt, entry.completion);
            return { id: entry.id, name: entry.name, voices: entry.voices, usdPerRecap: price.usd, estimate: price.estimate };
          })
          .filter((entry) => entry.usdPerRecap !== null && entry.usdPerRecap > 0)
          .sort((a, b) => (a.id === RECAP_SPEECH_MODEL ? -1 : b.id === RECAP_SPEECH_MODEL ? 1 : a.name.localeCompare(b.name)));
        this.speechCache = { at: this.now(), models };
        return models;
      })
      .catch(() => this.speechCache?.models ?? null)
      .finally(() => { this.speechInFlight = null; });
    return this.speechInFlight;
  }

  async speechModels(): Promise<SpeechModelsAnswer> {
    const models = await this.liveSpeechModels();
    return {
      models: models ?? [],
      checkedAt: this.speechCache ? new Date(this.speechCache.at).toISOString() : null,
      default: { model: RECAP_SPEECH_MODEL, voice: RECAP_SPEECH_VOICE },
    };
  }

  /** A model and voice OpenRouter offers now, or a sentence why not. */
  private async offered(rawModel: unknown, rawVoice: unknown): Promise<{ model: SpeechModelOption; voice: string }> {
    const id = typeof rawModel === 'string' ? rawModel.trim() : '';
    const voice = typeof rawVoice === 'string' ? rawVoice.trim() : '';
    if (!id || !voice) throw new VoiceSettingsError('Choose a model and a voice.', 400);
    const live = await this.liveSpeechModels();
    if (!live) throw new VoiceSettingsError('OpenRouter could not be reached to check that model. Try again in a minute.', 503);
    const model = live.find((entry) => entry.id === id);
    if (!model) throw new VoiceSettingsError(`OpenRouter does not offer a speech model called ${id}.`, 400);
    if (!model.voices.includes(voice)) throw new VoiceSettingsError(`${model.name} has no voice called ${voice}.`, 400);
    return { model, voice };
  }

  /** An admin's choice of model and voice for reading recaps aloud. */
  async setSpeech(orgId: string, rawModel: unknown, rawVoice: unknown, byName: string): Promise<void> {
    const { model, voice } = await this.offered(rawModel, rawVoice);
    const org = await this.org(orgId);
    await this.deps.orgStorage.updateOrg(orgId, {
      voice: { ...org.voice, speechModel: model.id, speechVoice: voice, speechChangedAt: new Date(this.now()).toISOString(), speechChangedByName: byName },
      voiceSpeechProblem: undefined,
    });
  }

  /** One sentence in a model and voice an admin is trying, on the key. */
  async sample(orgId: string, rawModel: unknown, rawVoice: unknown): Promise<VoiceSpeakerResult & { model: string; voice: string }> {
    const { model, voice } = await this.offered(rawModel, rawVoice);
    const { key } = await this.ready(orgId);
    const result = await this.spoken1(orgId, key, model.id, voice, RECAP_SPEECH_SAMPLE);
    return { ...result, model: model.id, voice };
  }

  private async ready(orgId: string): Promise<{ org: OrgDocument; key: string }> {
    if (!this.deps.speaker) throw new VoiceUnavailableError(voiceErrorCodeFor('off'));
    const { state, reason, org, key } = await this.state(orgId);
    if (state !== 'on' || !key) throw new VoiceUnavailableError(voiceErrorCodeFor(state === 'on' ? 'off' : state, reason));
    return { org, key };
  }

  /** One spoken text, cached; a 402 or 401 pauses the workplace. */
  private async spoken1(orgId: string, key: string, model: string, voice: string, text: string): Promise<VoiceSpeakerResult> {
    const cacheKey = createHash('sha256').update(JSON.stringify([orgId, model, voice, text])).digest('hex');
    const cached = this.spoken.get(cacheKey);
    if (cached) {
      this.spoken.delete(cacheKey);
      this.spoken.set(cacheKey, cached);
      return cached;
    }
    let result: VoiceSpeakerResult;
    try {
      // Gemini's voices answer raw PCM only; the speaker wraps it as WAV.
      result = await this.deps.speaker!.speak({ apiKey: key, model, voice, format: model.startsWith('google/') ? 'pcm' : RECAP_SPEECH_FORMAT, text });
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
    this.spoken.set(cacheKey, result);
    while (this.spoken.size > SPOKEN_CACHE_ENTRIES) this.spoken.delete(this.spoken.keys().next().value!);
    return result;
  }

  /**
   * Words read aloud on the workplace's key (note #1146), in the model and
   * voice an admin chose (note #1151). Throws {@link VoiceUnavailableError}
   * without calling OpenRouter when there is no key or voice is paused. When
   * the chosen model or voice is gone from OpenRouter, or fails, the default
   * reads it instead and `fallback` says so in one sentence — never silence.
   */
  async speak(orgId: string, text: string): Promise<VoiceSpeakerResult & { model: string; voice: string; fallback?: string }> {
    const { org, key } = await this.ready(orgId);
    const chosen = this.speechOf(org);
    const fallbackTo = { model: RECAP_SPEECH_MODEL, voice: RECAP_SPEECH_VOICE };
    const isDefault = chosen.model === fallbackTo.model && chosen.voice === fallbackTo.voice;
    let fallback: string | undefined;
    let use = chosen;
    if (!isDefault) {
      const live = await this.liveSpeechModels();
      const entry = live?.find((model) => model.id === chosen.model);
      const named = `${entry?.name ?? chosen.model} · ${speechVoiceName(chosen.voice)}`;
      if (live && !entry) fallback = `OpenRouter no longer offers the workplace's voice (${named}), so the default voice read this.`;
      else if (entry && !entry.voices.includes(chosen.voice)) fallback = `The workplace's voice (${named}) is no longer offered, so the default voice read this.`;
      if (fallback) use = fallbackTo;
    }
    let result: VoiceSpeakerResult;
    try {
      result = await this.spoken1(orgId, key, use.model, use.voice, text);
    } catch (error) {
      if (error instanceof VoiceUnavailableError || use === fallbackTo || isDefault) throw error;
      const name = this.speechCache?.models.find((model) => model.id === chosen.model)?.name ?? chosen.model;
      fallback = `The workplace's voice (${name} · ${speechVoiceName(chosen.voice)}) could not read this recap, so the default voice did.`;
      use = fallbackTo;
      result = await this.spoken1(orgId, key, use.model, use.voice, text);
    }
    if (fallback) {
      await this.deps.orgStorage.updateOrg(orgId, { voiceSpeechProblem: { at: new Date(this.now()).toISOString(), words: fallback } }).catch(() => undefined);
    } else if (!isDefault && org.voiceSpeechProblem) {
      await this.deps.orgStorage.updateOrg(orgId, { voiceSpeechProblem: undefined }).catch(() => undefined);
    }
    return { ...result, model: use.model, voice: use.voice, ...(fallback ? { fallback } : {}) };
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
