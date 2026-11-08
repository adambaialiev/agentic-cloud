/**
 * Guests' own agents (note #1038; the design is note #1036): a visitor of
 * the home page, signed out, makes a sealed Claude Code agent of their own,
 * talks to it, and deletes it — or it is deleted with its machine after 30
 * quiet minutes, 3 hours, or 40 messages.
 *
 * This service holds everything between the six public routes and the
 * agent layer: the switch, the ceilings and rests, the build from nothing
 * with its timed steps, one turn at a time per agent through the model door,
 * Stop, deletion, the sweeper and its leak guard, and the owner's
 * transcripts.
 *
 * No slots, no line, no spares (note #1055; Adam, 7 Nov 2026): every Make
 * my agent builds that visitor's machine and agent right then, from nothing,
 * however many others are alive, and the status names each real step as it
 * runs. Only the day's 40, the address's 3 and the address's one live agent
 * say no.
 * The seal itself lives on the machine (guest-agent-machine.ts) and in the
 * door (guest-model-door.ts); nothing here relies on the model behaving.
 *
 * Visitors are known by a random key the server makes; only its SHA-256 is
 * stored. Addresses key in-memory limits only and are never written.
 *
 * Knowledge page: sealed-public-agent.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentRecord } from '../types/user.js';
import type { OrgSeatDocument } from '../types/org.js';
import type { PlatformCredentialLeaseOutcome } from '../types/platform-credential.js';
import type { PlatformCredentialPool } from './platform-credential-pool.js';
import type { WorkspaceRuntimeClient } from './sandbox-client.js';
import { SEAT_LEASE_PREFIX } from './org-seat-credentials.js';
import { DEFAULT_DEVELOPMENT_SSH_USER } from './development-root.js';
import { claudeUsageLimitResetAtSeconds, isClaudeUsageLimitText } from '../agent/harness-auth-failure.js';
import { quoteShellArg } from '../utils/shell-quote.js';
import { seatOutOfService } from './public-guide-service.js';
import { guideAnswerLeak } from './public-guide-machine.js';
import { GuestModelDoor } from './guest-model-door.js';
import type { Request, Response } from 'express';
import {
  GUEST_JOB_DEFAULT_TIMEOUT_MS,
  GUEST_JOB_ID_PATTERN,
  GUEST_JOB_STARTS_PER_TURN,
  GUEST_JOBS_ALLOWED,
  buildGuestJobsReadCommand,
  guestJobLabel,
  guestJobReceiptPrompt,
  guestJobTail,
  parseGuestJobsReading,
} from './guest-agent-jobs.js';
import {
  GUEST_TURN_DIR,
  buildGuestClaudeCommand,
  buildGuestReapCommand,
  buildGuestSetupCommand,
  buildGuestWakeCommand,
  buildGuestVisitorPrompt,
  readGuestStream,
  type GuestStreamReading,
} from './guest-agent-machine.js';
import { guestTranscriptCutoffMs, type GuestJobRecord, type GuestAgentRow, type GuestAgentSettings, type GuestAgentStorage } from './guest-agent-storage.js';
import {
  GUEST_AGENT_LIMITS,
  GUEST_AGENT_MACHINE,
  GUEST_BUILD_ESTIMATE_SECONDS,
  GUEST_CREATE_STEP_IDS,
  GUEST_AGENT_MODEL,
  GUEST_DECLINED_MARKER,
  GUEST_DECLINED_TEXT,
  GUEST_TURN_FINAL_STATES,
  GUEST_TURNSTILE_ACTION,
  guestGreeting,
  type GuestActivity,
  type GuestCreateAnswer,
  type GuestCreateStep,
  type GuestCreateStepId,
  type GuestJob,
  type GuestMessage,
  type GuestMessageAnswer,
  type GuestRemovedReason,
  type GuestState,
  type GuestStatus,
  type GuestTranscriptRecord,
  type GuestTurnState,
  type GuestTurnStatus,
  type WorkspaceGuestsAnswer,
} from '../shared/guest-agent.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const KEY_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
/** After its last message is spent, the agent goes after this much quiet (the visitor reads the last answer). */
const MESSAGES_SPENT_GRACE_MS = 5 * MINUTE_MS;
/** A removal that has not finished in this long is tried again (the leak guard). */
const REMOVAL_RETRY_MS = 10 * MINUTE_MS;
/** A build stuck this long is abandoned and its record deleted. */
const STUCK_MS = 15 * MINUTE_MS;
/** The pause before a failed build step is tried once more (note #1073). */
const BUILD_RETRY_MS = 3_000;
/** How long a removed agent's key still answers `removed` (screen 6). */
const REMOVED_KEY_DAYS = 1;

export interface GuestAgentHost {
  /** Reserves a sealed guest record in the owner's workplace; the machine is built behind it. */
  createRecord(userId: string, orgId: string | null): Promise<{ id: string; name: string } | { error: string }>;
  /** The record, only while it is still a sealed guest that is not being deleted. */
  agent(userId: string, agentId: string): Promise<AgentRecord | null>;
  /** Its machine, built if missing, stamped active so it is not put to sleep mid-turn. */
  sandbox(userId: string, agentId: string): Promise<string | null>;
  /** The PUBLIC agentic-cloud repository's anonymous clone, or null. */
  source(userId: string, agent: AgentRecord): Promise<{ cloneUrl: string; branch: string } | null>;
  /** Deletes the agent with its machine, volume and app. */
  deleteAgent(userId: string, agentId: string): Promise<boolean>;
  /** Every sealed guest record the owner has (the orphan sweep). */
  guestAgentIds(userId: string): Promise<string[]>;
}

export interface GuestAgentServiceDeps {
  storage: GuestAgentStorage;
  host: GuestAgentHost;
  door: GuestModelDoor;
  /** The door's public base URL (ANTHROPIC_BASE_URL on the machine), or null when the backend has no public URL. */
  doorUrl: string | null;
  pool?: PlatformCredentialPool;
  seats?: {
    getSeat(seatId: string): Promise<OrgSeatDocument | null>;
    listSeatsByMember(orgId: string, userId: string): Promise<OrgSeatDocument[]>;
  };
  sandboxClient: () => WorkspaceRuntimeClient;
  /** Cloudflare Turnstile; the check is off while null. */
  turnstile?: { secretKey: string; siteKey: string } | null;
  /** The idle reaper's minutes: after this much quiet a machine is taken to be asleep. */
  idleStopMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  limits?: Partial<typeof GUEST_AGENT_LIMITS>;
  /** Off in tests: no timer. */
  sweepEveryMs?: number | null;
  /** How often running background jobs are read (note #1063); off in tests. */
  jobsEveryMs?: number | null;
  /**
   * The pause before a build step that failed is tried once more (note #1073,
   * default 3 s). Every step is idempotent, and one blip — Fly answering 404
   * for a machine that was there a second later — must not cost a visitor
   * their agent.
   */
  buildRetryMs?: number;
}

interface LiveTurn {
  turnId: string;
  agentId: string;
  messageId: string;
  state: GuestTurnState;
  partial: string | null;
  answer: string | null;
  activity: GuestActivity[];
  files: string[];
  startedAtMs: number;
  until?: string | null;
  stopped: boolean;
  /** The finished jobs a job turn answers. */
  jobIds?: string[];
  doorKey?: string;
  sandboxId?: string;
  /** The guest answering finished background jobs, not a visitor's message (note #1063). */
  fromJob?: boolean;
  /** Background jobs this turn started (bounded per turn). */
  jobStarts?: number;
}

/**
 * What a visitor reads when a reply ran out of its minutes (note #1047): never
 * "something went wrong", since nothing did. What it had said so far, the
 * command it was in, and a smaller thing to ask for.
 */
export function guestOutOfTimeAnswer(
  reading: Pick<GuestStreamReading, 'partial' | 'activity'>,
  /** The optional per-reply ceiling (note #1054) when that is what ended it; absent, the agent's own life did. */
  ceilingMs?: number | null,
): string {
  const last = [...reading.activity].reverse().find((item) => item.kind === 'run');
  const where = last ? ` while running \`${last.label.replace(/`/g, "'")}\`` : '';
  const why = ceilingMs
    ? `That took longer than the ${Math.round(ceilingMs / 60_000)} minutes one reply may take, so it was stopped${where}. Ask me for a smaller piece and I will do it within the time.`
    : `I reached the end of my time (${Math.round(GUEST_AGENT_LIMITS.lifetimeMs / 3_600_000)} hours from when I was made), so this was stopped${where}.`;
  return [
    ...(reading.partial?.trim() ? [reading.partial.trim(), ''] : []),
    why,
    'This one did not count against your messages.',
  ].join('\n');
}

/**
 * A build's five steps (note #1055), in order. A row from before (the four
 * old steps, or none) reads as a fresh build whose machine step began when
 * it was claimed.
 */
export function guestBuildSteps(row: Pick<GuestAgentRow, 'steps' | 'claimedAt' | 'preparedAt'>): GuestCreateStep[] {
  const byId = new Map((row.steps ?? []).map((s) => [s.id, s]));
  if (GUEST_CREATE_STEP_IDS.every((id) => byId.has(id))) {
    return GUEST_CREATE_STEP_IDS.map((id) => {
      const s = byId.get(id)!;
      return { id, done: Boolean(s.done), startedAt: s.startedAt ?? null, doneAt: s.doneAt ?? null };
    });
  }
  const began = row.claimedAt ?? row.preparedAt;
  return GUEST_CREATE_STEP_IDS.map((id) => ({ id, done: false, startedAt: id === 'machine' ? began : null, doneAt: null }));
}

/** What a visitor reads when a turn ended with no answer at all: never the refusal line (note #1063). */
export const GUEST_NO_ANSWER_TEXT = 'I stopped without writing an answer. Ask me again, or ask what I did so far, and I will pick up from there. This one did not count against your messages.';

/** A guest's background jobs that are running now, oldest first (note #1063). */
export function runningJobs(row: Pick<GuestAgentRow, 'jobs'>): GuestJobRecord[] {
  return (row.jobs ?? []).filter((job) => job.state === 'running').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function guestJobFailedTurnText(row: GuestAgentRow, ids: readonly string[]): string {
  const jobs = (row.jobs ?? []).filter((job) => ids.includes(job.id));
  const lines = jobs.map((job) => `- \`${job.label.replace(/`/g, "'")}\`: ${job.state.replace('_', ' ')}${job.exitCode !== null ? `, exit ${job.exitCode}` : ''}`);
  return [jobs.length === 1 ? 'A background job finished:' : 'Background jobs finished:', ...lines, '', 'I could not write about it just now. Ask me, and I will read its output.'].join('\n');
}

export function hashGuestKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function utcDayStart(now: number): number {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

export class GuestAgentService {
  private readonly limits: typeof GUEST_AGENT_LIMITS;
  private readonly now: () => number;
  private readonly turns = new Map<string, LiveTurn>();
  private readonly runningByAgent = new Map<string, string>();
  /** address → live agent ids, and address → claim times today. In memory only. */
  private readonly addressLive = new Map<string, Set<string>>();
  private readonly addressMade = new Map<string, number[]>();
  private readonly agentAddress = new Map<string, string>();
  /** Keys whose creation failed recently (screen: failed). */
  private readonly failedKeys = new Map<string, number>();
  private readonly busy = new Set<string>();
  private restUntilMs = 0;
  private restUntilIso: string | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHourly = 0;
  private jobsTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed reads of an agent's jobs; past a few, its running jobs are interrupted. */
  private readonly jobReadFailures = new Map<string, number>();
  private pollingJobs = false;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: GuestAgentServiceDeps) {
    this.limits = { ...GUEST_AGENT_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const every = this.deps.sweepEveryMs === undefined ? MINUTE_MS : this.deps.sweepEveryMs;
    if (!every || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch((error) => console.warn('[guest] sweep failed:', error)); }, every);
    this.timer.unref?.();
    const jobsEvery = this.deps.jobsEveryMs === undefined ? 15_000 : this.deps.jobsEveryMs;
    if (jobsEvery) {
      this.jobsTimer = setInterval(() => { void this.pollJobs().catch((error) => console.warn('[guest] jobs read failed:', error)); }, jobsEvery);
      this.jobsTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.jobsTimer) clearInterval(this.jobsTimer);
    this.timer = null;
    this.jobsTimer = null;
  }

  /** Background work (a build, a turn) — tracked so tests and shutdown can wait for it. */
  private track(work: Promise<unknown>): void {
    const guarded = work.catch((error) => console.warn('[guest] background work failed:', error));
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  /** Resolves once no background work is left (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ── The switch ──────────────────────────────────────────────────────────

  async settings(): Promise<GuestAgentSettings | null> {
    return this.deps.storage.getSettings().catch(() => null);
  }

  /** Guests on or off, in this owner's workplace (the CLI's `agentbuilt guests on|off`). */
  async setEnabled(userId: string, orgId: string | null, enabled: boolean): Promise<GuestAgentSettings> {
    const settings: GuestAgentSettings = { enabled, userId, orgId, changedAt: new Date(this.now()).toISOString() };
    await this.deps.storage.setSettings(settings);
    if (enabled) void this.tick().catch(() => undefined);
    return settings;
  }

  // ── Rests and ceilings ──────────────────────────────────────────────────

  private rest(until: string | null): void {
    const untilMs = until ? Date.parse(until) : Number.NaN;
    this.restUntilMs = Number.isFinite(untilMs) ? untilMs : this.now() + HOUR_MS;
    this.restUntilIso = until && Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null;
  }

  private async ownerSeat(settings: GuestAgentSettings): Promise<OrgSeatDocument | null> {
    if (!this.deps.seats || !settings.orgId) return null;
    const seats = (await this.deps.seats.listSeatsByMember(settings.orgId, settings.userId).catch(() => []))
      .filter((seat) => seat.provider === 'claude');
    return seats.find((seat) => seat.selected) ?? seats[0] ?? null;
  }

  /** Resting, and until when — or null when guests may be made and may talk. */
  private async restingState(settings: GuestAgentSettings | null, forNewAgent: boolean): Promise<{ until: string | null } | null> {
    const now = this.now();
    if (!settings?.enabled || !this.deps.doorUrl) return { until: null };
    if (this.restUntilMs > now) return { until: this.restUntilIso ?? new Date(this.restUntilMs).toISOString() };
    // The seat out of service rests guests; its share of the window or week does not (note #1048).
    if (this.deps.seats) {
      const out = seatOutOfService(await this.ownerSeat(settings), now);
      if (out) return out;
    }
    if (forNewAgent && await this.deps.storage.countClaimedSince(utcDayStart(now)) >= this.limits.globalPerDay) {
      return { until: new Date(utcDayStart(now) + DAY_MS).toISOString() };
    }
    return null;
  }

  private madeToday(address: string, now: number): number[] {
    const kept = (this.addressMade.get(address) ?? []).filter((at) => at >= utcDayStart(now));
    if (kept.length) this.addressMade.set(address, kept); else this.addressMade.delete(address);
    return kept;
  }

  // ── What the visitor sees ───────────────────────────────────────────────

  private blankStatus(state: GuestState, extra: Partial<GuestStatus> = {}): GuestStatus {
    return {
      state,
      agent: null,
      machine: null,
      messages: [],
      turn: null,
      jobs: [],
      steps: null,
      step: null,
      estimateSeconds: null,
      createdAt: null,
      quietUntil: null,
      endsAt: null,
      messagesLeft: null,
      until: null,
      removedReason: null,
      turnstileSiteKey: this.deps.turnstile?.siteKey ?? null,
      limits: {
        messageMaxChars: this.limits.messageMaxChars,
        quietMinutes: Math.round(this.limits.quietMs / MINUTE_MS),
        lifetimeHours: Math.round(this.limits.lifetimeMs / HOUR_MS),
        messagesMax: this.limits.messagesMax,
      },
      ...extra,
    };
  }

  /** The conversation as the visitor may see it: no costs, no flags; a held answer is the declined sentence. */
  private visitorMessages(row: GuestAgentRow): GuestMessage[] {
    return row.transcript.messages.map((m) => {
      const visible: GuestMessage = { id: m.id, role: m.role, text: m.flag ? GUEST_DECLINED_TEXT : m.text, at: m.at, ...(m.fromJob ? { fromJob: true } : {}) };
      if (m.state) visible.state = m.flag ? 'declined' : m.state;
      if (m.activity) visible.activity = m.activity;
      return visible;
    });
  }

  private statusOfRow(row: GuestAgentRow): GuestStatus {
    const agent = { name: row.transcript.name, avatarUrl: row.transcript.avatarUrl };
    if (row.phase === 'removed' || row.phase === 'removing') {
      return this.blankStatus('removed', { agent, removedReason: row.removedReason ?? 'quiet' });
    }
    if (row.phase === 'creating') {
      const steps = guestBuildSteps(row);
      return this.blankStatus('creating', {
        agent,
        steps,
        step: steps.find((s) => !s.done)?.id ?? null,
        estimateSeconds: GUEST_BUILD_ESTIMATE_SECONDS,
        createdAt: row.claimedAt,
        machine: { ...GUEST_AGENT_MACHINE, awake: true },
      });
    }
    const now = this.now();
    const turnId = this.runningByAgent.get(row.agentId) ?? null;
    const last = Date.parse(row.lastActiveAt ?? row.claimedAt ?? row.preparedAt);
    const idle = this.deps.idleStopMs ?? 3 * MINUTE_MS;
    // A running background job keeps the machine awake (note #1063).
    const jobs = runningJobs(row);
    const awake = Boolean(turnId) || jobs.length > 0 || now - last < idle;
    const state: GuestState = turnId ? 'working' : awake ? 'ready' : 'asleep';
    const fromJob = turnId ? Boolean(this.turns.get(turnId)?.fromJob) : false;
    const endsAtMs = Date.parse(row.claimedAt ?? row.preparedAt) + this.limits.lifetimeMs;
    return this.blankStatus(state, {
      agent,
      machine: { ...GUEST_AGENT_MACHINE, awake },
      messages: this.visitorMessages(row),
      turn: turnId ? { turnId, ...(fromJob ? { fromJob: true } : {}) } : null,
      jobs: jobs.slice(0, this.limits.jobsMax).map((job): GuestJob => ({ id: job.id, label: job.label, startedAt: job.startedAt })),
      quietUntil: turnId || jobs.length ? null : new Date(Math.min(last + this.limits.quietMs, endsAtMs)).toISOString(),
      endsAt: new Date(endsAtMs).toISOString(),
      messagesLeft: Math.max(0, this.limits.messagesMax - row.messagesUsed),
      createdAt: row.claimedAt,
    });
  }

  private validKey(key: unknown): key is string {
    return typeof key === 'string' && KEY_PATTERN.test(key);
  }

  /** GET /api/public/guest. */
  async status(key: unknown): Promise<GuestStatus> {
    const now = this.now();
    if (this.validKey(key)) {
      const keyHash = hashGuestKey(key);
      const failedAt = this.failedKeys.get(keyHash);
      if (failedAt && now - failedAt < HOUR_MS) return this.blankStatus('failed');
      const row = await this.deps.storage.byKeyHash(keyHash);
      if (row && (row.phase !== 'removed' || (row.removedAt && now - Date.parse(row.removedAt) < REMOVED_KEY_DAYS * DAY_MS))) {
        return this.statusOfRow(row);
      }
    }
    const resting = await this.restingState(await this.settings(), true);
    return resting ? this.blankStatus('resting', { until: resting.until }) : this.blankStatus('none');
  }

  private async liveRowForKey(key: unknown): Promise<GuestAgentRow | null> {
    if (!this.validKey(key)) return null;
    const row = await this.deps.storage.byKeyHash(hashGuestKey(key));
    return row && row.phase === 'live' ? row : null;
  }

  // ── Making one ──────────────────────────────────────────────────────────

  private async verifyTurnstile(token: unknown, address: string): Promise<boolean> {
    const turnstile = this.deps.turnstile;
    if (!turnstile) return true;
    if (typeof token !== 'string' || !token || token.length > 4096) return false;
    try {
      const body = new URLSearchParams({ secret: turnstile.secretKey, response: token });
      if (address && address !== 'unknown') body.set('remoteip', address);
      const res = await (this.deps.fetch ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
      const answer = await res.json() as { success?: boolean; action?: string };
      return answer.success === true && (!answer.action || answer.action === GUEST_TURNSTILE_ACTION);
    } catch (error) {
      console.warn('[guest] turnstile check failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  /** POST /api/public/guest — Make my agent. */
  async create(args: { key?: unknown; turnstileToken?: unknown; address: string }): Promise<{ httpStatus: number; answer: GuestCreateAnswer | { state: 'invalid'; error: string } }> {
    if (this.validKey(args.key)) {
      const current = await this.status(args.key);
      if (['creating', 'ready', 'working', 'asleep'].includes(current.state)) return { httpStatus: 200, answer: { status: current } };
    }
    if (!await this.verifyTurnstile(args.turnstileToken, args.address)) {
      return { httpStatus: 400, answer: { state: 'invalid', error: 'challenge' } };
    }
    return this.withLock(async () => {
      const now = this.now();
      const settings = await this.settings();
      const resting = await this.restingState(settings, true);
      if (resting || !settings) return { httpStatus: 200, answer: { status: this.blankStatus('resting', { until: resting?.until ?? null }) } };
      const live = this.addressLive.get(args.address);
      if (live && live.size >= this.limits.perAddressLive) {
        return { httpStatus: 200, answer: { status: this.blankStatus('limited', { until: null }) } };
      }
      if (this.madeToday(args.address, now).length >= this.limits.perAddressPerDay) {
        return { httpStatus: 200, answer: { status: this.blankStatus('limited', { until: new Date(utcDayStart(now) + DAY_MS).toISOString() }) } };
      }
      // No ceiling on how many are alive and no line (note #1055): built now, from nothing.
      const key = randomBytes(32).toString('base64url');
      const keyHash = hashGuestKey(key);
      const row = await this.claim(settings, keyHash, args.address);
      if (!row) {
        this.failedKeys.set(keyHash, now);
        return { httpStatus: 200, answer: { status: this.blankStatus('failed') } };
      }
      return { httpStatus: 201, answer: { key, status: this.statusOfRow(row) } };
    });
  }

  private newTranscript(agentId: string, name: string): GuestTranscriptRecord {
    return { agentId, name, avatarUrl: null, createdAt: new Date(this.now()).toISOString(), removedAt: null, removedReason: null, messages: [] };
  }

  /**
   * Gives the visitor an agent, built from nothing (note #1055): the record
   * is reserved (its name) and its machine starts being made behind it; the
   * rest of the build runs in finishClaim. Caller holds the lock. Holding it
   * only spans the reservation, so builds run side by side.
   */
  private async claim(settings: GuestAgentSettings, keyHash: string, address: string): Promise<GuestAgentRow | null> {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const made = await this.deps.host.createRecord(settings.userId, settings.orgId).catch((error) => ({ error: String(error) }));
    if ('error' in made) {
      console.warn(`[guest] could not make an agent: ${made.error}`);
      return null;
    }
    const row: GuestAgentRow = {
      agentId: made.id,
      userId: settings.userId,
      orgId: settings.orgId,
      phase: 'creating',
      keyHash,
      preparedAt: nowIso,
      claimedAt: nowIso,
      lastActiveAt: nowIso,
      messagesUsed: 0,
      claudeSessionId: null,
      // The machine is being made from the moment the record is reserved.
      steps: GUEST_CREATE_STEP_IDS.map((id) => ({ id, done: false, startedAt: id === 'machine' ? nowIso : null, doneAt: null })),
      removedAt: null,
      removedReason: null,
      transcript: this.newTranscript(made.id, made.name),
    };
    await this.deps.storage.put(row);
    console.log(`[guest] building ${made.name} (${made.id}) from nothing`);
    this.addressMade.set(address, [...this.madeToday(address, now), now]);
    const live = this.addressLive.get(address) ?? new Set<string>();
    live.add(row.agentId);
    this.addressLive.set(address, live);
    this.agentAddress.set(row.agentId, address);
    this.track(this.finishClaim(row.agentId));
    return row;
  }

  /** One step done, and the next one started, at the same moment (note #1055). */
  private async step(agentId: string, id: GuestCreateStepId): Promise<void> {
    const row = await this.deps.storage.get(agentId);
    if (!row || row.phase !== 'creating') return;
    const at = new Date(this.now()).toISOString();
    const index = GUEST_CREATE_STEP_IDS.indexOf(id);
    const next = GUEST_CREATE_STEP_IDS[index + 1];
    row.steps = guestBuildSteps(row).map((s) => {
      if (s.id === id) return { ...s, done: true, startedAt: s.startedAt ?? at, doneAt: s.doneAt ?? at };
      if (s.id === next && !s.startedAt) return { ...s, startedAt: at };
      return s;
    });
    await this.deps.storage.put(row);
  }

  /** Waits for a record's machine to exist (the build runs behind the reservation). */
  private async waitForMachine(userId: string, agentId: string, timeoutMs = 8 * MINUTE_MS): Promise<AgentRecord | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const agent = await this.deps.host.agent(userId, agentId).catch(() => null);
      if (!agent) return null;
      if (agent.serverId) return agent;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return null;
  }

  /**
   * Runs the machine's setup (users, lock, proxy, runner, and the copy unless
   * `copy` is false); its sandbox id when it is ready, else null. Before every
   * turn it runs whole; a build runs it twice, without the copy and then with
   * it, so the visitor sees the two steps apart (note #1055).
   */
  private async setupMachine(row: GuestAgentRow, options: { copy?: boolean } = {}): Promise<string | null> {
    const agent = await this.waitForMachine(row.userId, row.agentId);
    if (!agent) return null;
    const sandboxId = await this.deps.host.sandbox(row.userId, row.agentId).catch(() => null);
    const source = sandboxId ? await this.deps.host.source(row.userId, agent).catch(() => null) : null;
    if (!sandboxId || !source || !this.deps.doorUrl) return null;
    const setup = await this.deps.sandboxClient().execSync(sandboxId, buildGuestSetupCommand({ ...source, doorUrl: this.deps.doorUrl, agentName: row.transcript.name }, { copy: options.copy ?? true }), undefined, {
      timeoutMs: 420_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
    }).catch((error) => ({ exitCode: 1, stderr: String(error), timedOut: false, stdout: '' }));
    if (setup.exitCode !== 0 || setup.timedOut) {
      console.warn(`[guest] setup failed on ${sandboxId}: ${String(setup.stderr ?? '').slice(-300) || `exit ${setup.exitCode}`}`);
      return null;
    }
    return sandboxId;
  }

  /**
   * The build, from nothing, each step a real event (note #1055): the machine
   * exists and has started; the sealed agent is set up on it; the public copy
   * is cloned; Claude Code runs once as the agent's user; the greeting.
   * A restart resumes it from the top (each part is idempotent).
   */
  private async finishClaim(agentId: string): Promise<void> {
    if (this.busy.has(agentId)) return;
    this.busy.add(agentId);
    const startedMs = this.now();
    try {
      const row = await this.deps.storage.get(agentId);
      if (!row || row.phase !== 'creating') return;
      const fail = async (where: GuestCreateStepId) => {
        console.warn(`[guest] building ${row.transcript.name} (${agentId}) failed at ${where}`);
        if (row.keyHash) this.failedKeys.set(row.keyHash, this.now());
        await this.remove(agentId, 'quiet', { failed: true });
      };
      const agent = await this.waitForMachine(row.userId, agentId);
      if (!agent) return await fail('machine');
      await this.step(agentId, 'machine');
      if (!await this.stillBuilding(agentId)) return;
      // Each machine step gets one more try after a short pause (note #1073):
      // all of them are idempotent, and on 8 Nov 2026 a single Fly 404 for a
      // machine that still existed failed a whole build at its last step.
      const twice = async <T>(where: GuestCreateStepId, attempt: () => Promise<T | null>): Promise<T | null> => {
        const first = await attempt();
        if (first !== null) return first;
        if (!await this.stillBuilding(agentId)) return null;
        console.warn(`[guest] building ${row.transcript.name} (${agentId}): ${where} failed once; trying it again`);
        await new Promise((resolve) => setTimeout(resolve, this.deps.buildRetryMs ?? BUILD_RETRY_MS));
        if (!await this.stillBuilding(agentId)) return null;
        return attempt();
      };
      if (!await twice('agent', () => this.setupMachine(row, { copy: false }))) return await fail('agent');
      await this.step(agentId, 'agent');
      if (!await this.stillBuilding(agentId)) return;
      const sandboxId = await twice('code', () => this.setupMachine(row));
      if (!sandboxId) return await fail('code');
      await this.step(agentId, 'code');
      if (!await this.stillBuilding(agentId)) return;
      const woke = await twice('waking', async () => {
        const result = await this.deps.sandboxClient().execSync(sandboxId, buildGuestWakeCommand(), undefined, {
          timeoutMs: 60_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
        }).catch((error) => ({ exitCode: 1, stderr: String(error), timedOut: false, stdout: '' }));
        if (result.exitCode === 0 && !result.timedOut) return true;
        console.warn(`[guest] Claude Code did not start on ${sandboxId}: ${String(result.stderr ?? '').slice(-300) || `exit ${result.exitCode}`}`);
        return null;
      });
      if (!woke) return await fail('waking');
      await this.step(agentId, 'waking');
      const ready = await this.deps.storage.get(agentId);
      if (!ready || ready.phase !== 'creating') return;
      const nowIso = new Date(this.now()).toISOString();
      ready.steps = guestBuildSteps(ready).map((s) => ({ ...s, done: true, startedAt: s.startedAt ?? nowIso, doneAt: s.doneAt ?? nowIso }));
      ready.phase = 'live';
      ready.lastActiveAt = nowIso;
      ready.transcript.messages = [{ id: randomUUID(), role: 'agent', text: guestGreeting(ready.transcript.name), at: nowIso, state: 'answered' }];
      await this.deps.storage.put(ready);
      const took = (step: GuestCreateStep) => (step.startedAt && step.doneAt ? `${step.id} ${((Date.parse(step.doneAt) - Date.parse(step.startedAt)) / 1000).toFixed(1)}s` : step.id);
      console.log(`[guest] ${ready.transcript.name} (${agentId}) is live, built from nothing in ${((Date.parse(nowIso) - Date.parse(ready.claimedAt ?? nowIso)) / 1000).toFixed(1)}s (${guestBuildSteps(ready).map(took).join(', ')}; this run ${((this.now() - startedMs) / 1000).toFixed(1)}s)`);
    } finally {
      this.busy.delete(agentId);
    }
  }

  /** A visitor may delete the agent mid-build; the build then stops where it is. */
  private async stillBuilding(agentId: string): Promise<boolean> {
    return (await this.deps.storage.get(agentId))?.phase === 'creating';
  }

  // ── Talking ─────────────────────────────────────────────────────────────

  /** POST /api/public/guest/messages. */
  async message(key: unknown, text: unknown): Promise<{ httpStatus: number; answer: GuestMessageAnswer }> {
    if (!this.validKey(key)) return { httpStatus: 401, answer: { state: 'unknown' } };
    const row = await this.deps.storage.byKeyHash(hashGuestKey(key));
    if (!row) return { httpStatus: 401, answer: { state: 'unknown' } };
    if (row.phase !== 'live') return { httpStatus: 200, answer: { state: 'status', status: await this.status(key) } };
    if (typeof text !== 'string' || !text.trim()) return { httpStatus: 400, answer: { state: 'invalid', error: 'Write something first.' } };
    if (text.length > this.limits.messageMaxChars) return { httpStatus: 400, answer: { state: 'invalid', error: `At most ${this.limits.messageMaxChars} characters.` } };
    const running = this.runningByAgent.get(row.agentId);
    if (running) return { httpStatus: 409, answer: { state: 'busy', turnId: running } };
    if (row.messagesUsed >= this.limits.messagesMax) {
      return { httpStatus: 200, answer: { state: 'status', status: { ...this.statusOfRow(row), state: 'limited' } } };
    }
    const resting = await this.restingState(await this.settings(), false);
    if (resting) return { httpStatus: 200, answer: { state: 'status', status: this.blankStatus('resting', { until: resting.until }) } };
    const nowIso = new Date(this.now()).toISOString();
    const messageId = randomUUID();
    row.transcript.messages.push({ id: messageId, role: 'visitor', text: text.trim(), at: nowIso });
    row.messagesUsed += 1;
    row.lastActiveAt = nowIso;
    await this.deps.storage.put(row);
    const turn: LiveTurn = {
      turnId: randomUUID(), agentId: row.agentId, messageId, state: 'waking', partial: null, answer: null,
      activity: [], files: [], startedAtMs: this.now(), stopped: false,
    };
    this.turns.set(turn.turnId, turn);
    this.runningByAgent.set(row.agentId, turn.turnId);
    this.track(this.runTurn(turn, text.trim()).catch((error) => {
      console.warn(`[guest] turn ${turn.turnId} failed:`, error);
      return this.endTurn(turn, { state: 'failed' });
    }));
    return { httpStatus: 202, answer: { state: 'accepted', turnId: turn.turnId, messageId } };
  }

  /** GET /api/public/guest/turns/:turnId (only the key's own agent's turns). */
  async turnStatus(key: unknown, turnId: string): Promise<GuestTurnStatus | null> {
    const row = await this.liveRowForKey(key) ?? (this.validKey(key) ? await this.deps.storage.byKeyHash(hashGuestKey(key)) : null);
    const turn = this.turns.get(turnId);
    if (!row || !turn || turn.agentId !== row.agentId) return null;
    return {
      turnId,
      state: turn.state,
      partial: GUEST_TURN_FINAL_STATES.includes(turn.state) ? null : turn.partial,
      answer: turn.answer,
      activity: turn.activity,
      files: turn.files,
      elapsedSeconds: Math.max(0, Math.round((this.now() - turn.startedAtMs) / 1000)),
      ...(turn.until !== undefined ? { until: turn.until } : {}),
    };
  }

  /** POST /api/public/guest/turns/:turnId/stop. */
  async stopTurn(key: unknown, turnId: string): Promise<GuestTurnState | null> {
    const row = await this.liveRowForKey(key);
    const turn = this.turns.get(turnId);
    if (!row || !turn || turn.agentId !== row.agentId) return null;
    if (GUEST_TURN_FINAL_STATES.includes(turn.state)) return turn.state;
    await this.interrupt(turn);
    return 'stopped';
  }

  private async interrupt(turn: LiveTurn): Promise<void> {
    turn.stopped = true;
    if (turn.doorKey) this.deps.door.close(turn.doorKey);
    if (turn.sandboxId) {
      await this.deps.sandboxClient().execSync(turn.sandboxId, buildGuestReapCommand('TERM'), undefined, {
        timeoutMs: 15_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
      }).catch(() => undefined);
    }
  }

  /**
   * How long a turn may run on the machine (note #1054): the optional ceiling
   * when one is set, else what is left of the agent's 3-hour life, plus a
   * minute so the sweeper, not the wall, is what ends a life.
   */
  private turnWallSeconds(row: GuestAgentRow): number {
    if (this.limits.turnCeilingMs) return Math.round(this.limits.turnCeilingMs / 1000);
    const left = Date.parse(row.claimedAt ?? row.preparedAt) + this.limits.lifetimeMs - this.now();
    return Math.max(60, Math.round(left / 1000) + 60);
  }

  private async runTurn(turn: LiveTurn, text: string): Promise<void> {
    const row = await this.deps.storage.get(turn.agentId);
    if (!row) return this.endTurn(turn, { state: 'failed' });
    const pool = this.deps.pool;
    if (!pool) return this.endTurn(turn, { state: 'failed' });
    const leased = await pool.leaseForUser('claude', row.userId, {
      ...(row.orgId ? { orgId: row.orgId } : {}),
      model: GUEST_AGENT_MODEL,
    }).catch(() => null);
    if (!leased || leased.kind !== 'dedicated') {
      const until = leased?.kind === 'dedicated_exhausted' ? leased.resetAt ?? null : null;
      if (leased?.kind === 'dedicated_exhausted') this.rest(until);
      return this.endTurn(turn, { state: 'resting', until });
    }
    const lease = leased.lease;
    let outcome: PlatformCredentialLeaseOutcome = { kind: 'error' };
    try {
      if (lease.credentialId.startsWith(SEAT_LEASE_PREFIX) && this.deps.seats) {
        const seat = await this.deps.seats.getSeat(lease.credentialId.slice(SEAT_LEASE_PREFIX.length)).catch(() => null);
        const out = seat ? seatOutOfService(seat, this.now()) : null;
        if (out) {
          outcome = { kind: 'ok' };
          this.rest(out.until);
          return await this.endTurn(turn, { state: 'resting', until: out.until });
        }
      }
      const client = this.deps.sandboxClient();
      const sandboxId = await this.setupMachine(row);
      if (!sandboxId) return await this.endTurn(turn, { state: 'failed' });
      if (turn.stopped) { outcome = { kind: 'ok' }; return await this.endTurn(turn, { state: 'stopped' }); }
      turn.sandboxId = sandboxId;
      turn.state = 'working';
      if (!client.uploadToSandbox) return await this.endTurn(turn, { state: 'failed' });
      // No ceiling unless one is set (note #1054): the wall is the agent's own life.
      const timeoutSeconds = this.turnWallSeconds(row);
      let run = await this.launch(client, sandboxId, turn, lease.token, timeoutSeconds, {
        prompt: turn.fromJob ? text : buildGuestVisitorPrompt(text),
        ...(row.claudeSessionId ? { resumeSessionId: row.claudeSessionId } : { sessionId: randomUUID() }),
      });
      // A conversation the machine lost: start a fresh one carrying the exchange so far, once.
      if (row.claudeSessionId && run.missingSession && !turn.stopped) {
        const earlier = row.transcript.messages.filter((m) => m.id !== turn.messageId)
          .map((m) => `${m.role === 'visitor' ? 'The visitor wrote' : 'You answered'}: ${m.text}`).join('\n\n');
        run = await this.launch(client, sandboxId, turn, lease.token, timeoutSeconds, {
          prompt: `${earlier ? `${earlier}\n\n` : ''}${turn.fromJob ? text : buildGuestVisitorPrompt(text)}`,
          sessionId: randomUUID(),
        });
      }
      const { reading } = run;
      if (reading.sessionId) {
        const fresh = await this.deps.storage.get(turn.agentId);
        if (fresh) { fresh.claudeSessionId = reading.sessionId; await this.deps.storage.put(fresh); }
      }
      outcome = { kind: 'ok' };
      if (turn.stopped) return await this.endTurn(turn, { state: 'stopped', reading });
      const failure = run.timedOut ? 'timed out' : reading.isError || run.exitCode !== 0 ? (reading.errorText ?? run.stderr ?? 'failed') : null;
      if (failure) {
        if (isClaudeUsageLimitText(failure)) {
          const resetSeconds = claudeUsageLimitResetAtSeconds(failure);
          const until = resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null;
          outcome = { kind: 'rate_limited', model: GUEST_AGENT_MODEL, ...(resetSeconds ? { retryAfterSeconds: Math.max(60, Math.round(resetSeconds - this.now() / 1000)) } : {}) };
          this.rest(until);
          return await this.endTurn(turn, { state: 'resting', until, reading });
        }
        console.warn(`[guest] turn failed on ${sandboxId}: ${String(failure).slice(0, 300)}`);
        // Out of time is not our failure, and the visitor should hear what happened (note #1047):
        // the agent's own words so far, what it was running, and what to ask instead. Not counted.
        if (run.timedOut) return await this.endTurn(turn, { state: 'answered', reading, answer: guestOutOfTimeAnswer(reading, this.limits.turnCeilingMs), refund: true });
        return await this.endTurn(turn, { state: 'failed', reading });
      }
      const answer = (reading.answer ?? '').trim();
      // No answer at all is not a refusal (note #1063: Oscar's coverage run read as declined): say so, not counted.
      if (!answer) {
        return await this.endTurn(turn, { state: 'answered', reading, answer: GUEST_NO_ANSWER_TEXT, refund: true });
      }
      if (answer.startsWith(GUEST_DECLINED_MARKER)) {
        const offered = answer.slice(GUEST_DECLINED_MARKER.length).trim();
        return await this.endTurn(turn, { state: 'declined', reading, answer: offered || GUEST_DECLINED_TEXT });
      }
      const leak = guideAnswerLeak(answer);
      if (leak) return await this.endTurn(turn, { state: 'declined', reading, answer, flag: `The outgoing check held this answer back (${leak}).` });
      return await this.endTurn(turn, { state: 'answered', reading, answer });
    } finally {
      await pool.releaseCredential(lease.credentialId, outcome).catch(() => undefined);
    }
  }

  private async launch(
    client: WorkspaceRuntimeClient,
    sandboxId: string,
    turn: LiveTurn,
    seatToken: string,
    timeoutSeconds: number,
    args: { prompt: string; sessionId?: string; resumeSessionId?: string },
  ): Promise<{ reading: GuestStreamReading; exitCode: number; timedOut: boolean; stderr?: string; missingSession: boolean }> {
    const doorKey = this.deps.door.open(turn.agentId, seatToken, (timeoutSeconds + 60) * 1000);
    turn.doorKey = doorKey;
    const base = `${GUEST_TURN_DIR}/${turn.turnId}-${randomBytes(4).toString('hex')}`;
    const keyFile = `${base}.key`;
    const streamFile = `${base}.jsonl`;
    try {
      await client.uploadToSandbox!(sandboxId, [{ path: keyFile, content: Buffer.from(doorKey), mode: 0o600 }], { sshUser: DEFAULT_DEVELOPMENT_SSH_USER });
      let watching = true;
      let wake: () => void = () => {};
      const watcher = (async () => {
        while (watching) {
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); wake = () => { clearTimeout(timer); resolve(); }; });
          if (!watching) break;
          const peek = await client.execSync(sandboxId, `cat ${quoteShellArg(streamFile)} 2>/dev/null || true`, undefined, {
            timeoutMs: 15_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
          }).catch(() => null);
          if (peek?.stdout && watching) {
            const reading = readGuestStream(peek.stdout);
            turn.partial = reading.partial;
            turn.activity = reading.activity;
            turn.files = reading.files;
          }
        }
      })();
      try {
        const result = await client.execSync(sandboxId, buildGuestClaudeCommand({ ...args, keyFile, streamFile, timeoutSeconds }), undefined, {
          timeoutMs: (timeoutSeconds + 30) * 1000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
        });
        const reading = readGuestStream(result.stdout ?? '');
        turn.activity = reading.activity;
        turn.files = reading.files;
        const text = `${result.stderr ?? ''}\n${reading.errorText ?? ''}`;
        return {
          reading,
          exitCode: result.exitCode,
          timedOut: Boolean(result.timedOut) || result.exitCode === 124,
          ...(result.stderr ? { stderr: result.stderr.slice(-500) } : {}),
          missingSession: /no conversation found with session id/i.test(text),
        };
      } finally {
        watching = false;
        wake();
        await watcher.catch(() => undefined);
      }
    } finally {
      this.deps.door.close(doorKey);
      turn.doorKey = undefined;
    }
  }

  private async endTurn(
    turn: LiveTurn,
    end: { state: GuestTurnState; until?: string | null; reading?: GuestStreamReading; answer?: string; flag?: string; refund?: boolean },
  ): Promise<void> {
    turn.state = end.state;
    if (end.until !== undefined) turn.until = end.until;
    if (end.reading) { turn.activity = end.reading.activity; turn.files = end.reading.files; }
    turn.answer = end.flag ? GUEST_DECLINED_TEXT : end.answer ?? (end.state === 'stopped' ? end.reading?.partial ?? null : null);
    turn.partial = null;
    this.runningByAgent.delete(turn.agentId);
    const row = await this.deps.storage.get(turn.agentId);
    if (row) {
      const nowIso = new Date(this.now()).toISOString();
      row.lastActiveAt = nowIso;
      // Our failures and rests are not the visitor's: the message is given back.
      // A Stop is the visitor's own call on a reply they did not get whole: not counted either (note #1054).
      // A finished job's turn took none of the visitor's messages (note #1063), so gives none back.
      if (!turn.fromJob && (end.state === 'failed' || end.state === 'resting' || end.state === 'stopped' || end.refund)) row.messagesUsed = Math.max(0, row.messagesUsed - 1);
      // A job turn that could not run leaves its receipts owed, for the next read.
      if (turn.fromJob && end.state === 'resting' && !end.reading) for (const job of row.jobs ?? []) if (turn.jobIds?.includes(job.id)) job.announced = false;
      if (end.state !== 'resting' || end.reading) {
        row.transcript.messages.push({
          id: randomUUID(),
          role: 'agent',
          text: end.answer ?? (end.state === 'failed'
            ? (turn.fromJob ? guestJobFailedTurnText(row, turn.jobIds ?? []) : 'Something went wrong on our side. Try that again.')
            : end.state === 'stopped' ? (end.reading?.partial ?? 'Stopped.') : ''),
          ...(turn.fromJob ? { fromJob: true } : {}),
          at: nowIso,
          state: end.state === 'resting' ? 'failed' : end.state as 'answered' | 'declined' | 'failed' | 'stopped',
          ...(turn.activity.length ? { activity: turn.activity } : {}),
          seconds: Math.round((this.now() - turn.startedAtMs) / 1000),
          ...(end.reading?.costUsd !== undefined ? { costUsd: end.reading.costUsd } : {}),
          ...(end.reading?.tokens ? { tokens: end.reading.tokens } : {}),
          ...(end.flag ? { flag: end.flag } : {}),
        });
      }
      await this.deps.storage.put(row);
    }
    // Finished turns are kept a while for the page's last poll, then forgotten.
    setTimeout(() => this.turns.delete(turn.turnId), 10 * MINUTE_MS).unref?.();
    // Receipts that finished while this turn ran are delivered now, as one turn (note #1063).
    this.track(this.deliverOwedJobs(turn.agentId));
  }

  // ── Background jobs (note #1063) ───────────────────────────────────────

  /**
   * The jobs door: `POST <model door>/jobs/start`, from the guest's own
   * `agentbuilt job start`, carrying the running turn's per-turn key. Mounted
   * with a JSON parser in index.ts, before the model door.
   */
  readonly handleJobsDoor = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST' || req.path.replace(/\/+$/, '') !== '/start') { res.status(404).json({ error: 'Not a jobs route.' }); return; }
    const agentId = this.deps.door.agentOf(GuestModelDoor.keyOf(req));
    if (!agentId) { res.status(401).json({ error: 'A background job can be started only from inside a reply.' }); return; }
    const body = (req.body ?? {}) as { id?: unknown; argv?: unknown; quiet?: unknown; timeoutSeconds?: unknown };
    const answer = await this.registerJob(agentId, body);
    res.status(answer.httpStatus).json(answer.body);
  };

  /** Records a job the guest is starting, bounded, and tells the machine's reaper to spare it. */
  async registerJob(agentId: string, body: { id?: unknown; argv?: unknown; quiet?: unknown; timeoutSeconds?: unknown }): Promise<{ httpStatus: number; body: { label?: string; timeoutSeconds?: number; error?: string } }> {
    const id = typeof body.id === 'string' ? body.id : '';
    const argv = Array.isArray(body.argv) ? body.argv.filter((part): part is string => typeof part === 'string').slice(0, 64) : [];
    if (!GUEST_JOB_ID_PATTERN.test(id) || !argv.length) return { httpStatus: 400, body: { error: 'A job needs an id and a command.' } };
    return this.withLock(async () => {
      const turnId = this.runningByAgent.get(agentId);
      const turn = turnId ? this.turns.get(turnId) : undefined;
      const row = await this.deps.storage.get(agentId);
      if (!row || row.phase !== 'live' || !turn?.sandboxId || turn.stopped) return { httpStatus: 409, body: { error: 'A background job can be started only from inside a reply.' } };
      if ((turn.jobStarts ?? 0) >= GUEST_JOB_STARTS_PER_TURN) return { httpStatus: 429, body: { error: `One reply may start at most ${GUEST_JOB_STARTS_PER_TURN} background jobs.` } };
      const running = runningJobs(row);
      if (running.length >= this.limits.jobsMax) return { httpStatus: 429, body: { error: `${this.limits.jobsMax} background jobs are running already. Wait for one, or stop one.` } };
      if ((row.jobs ?? []).some((job) => job.id === id)) return { httpStatus: 409, body: { error: 'That job id is taken.' } };
      const now = this.now();
      const lifeLeftMs = Date.parse(row.claimedAt ?? row.preparedAt) + this.limits.lifetimeMs - now;
      const askedMs = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 ? body.timeoutSeconds * 1000 : GUEST_JOB_DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.max(10_000, Math.min(askedMs, lifeLeftMs));
      const job: GuestJobRecord = {
        id, label: guestJobLabel(argv), startedAt: new Date(now).toISOString(), timeoutMs, quiet: body.quiet === true,
        state: 'running', exitCode: null, finishedAt: null,
      };
      row.jobs = [...(row.jobs ?? []), job].slice(-50);
      row.lastActiveAt = job.startedAt;
      if (!await this.writeAllowedJobs(turn.sandboxId, row)) return { httpStatus: 503, body: { error: 'The job could not be registered on this computer. Run it inside the reply instead.' } };
      await this.deps.storage.put(row);
      turn.jobStarts = (turn.jobStarts ?? 0) + 1;
      console.log(`[guest] ${row.transcript.name} (${agentId}) started job ${id}: ${job.label}`);
      return { httpStatus: 200, body: { label: job.label, timeoutSeconds: Math.round(timeoutMs / 1000) } };
    });
  }

  /** The ids the machine's reaper spares: only the agent user can write the file, never the guide. */
  private async writeAllowedJobs(sandboxId: string, row: GuestAgentRow): Promise<boolean> {
    const client = this.deps.sandboxClient();
    if (!client.uploadToSandbox) return false;
    const ids = runningJobs(row).map((job) => job.id);
    return client.uploadToSandbox(sandboxId, [{ path: GUEST_JOBS_ALLOWED, content: Buffer.from(ids.length ? `${ids.join('\n')}\n` : ''), mode: 0o600 }], { sshUser: DEFAULT_DEVELOPMENT_SSH_USER })
      .then(() => true, (error) => { console.warn(`[guest] could not write the job list on ${sandboxId}:`, error instanceof Error ? error.message : error); return false; });
  }

  /**
   * Every few seconds: each guest with a running job has its jobs read on its
   * machine. Reading goes through `host.sandbox`, which stamps the machine
   * active, so a running job keeps it awake. A finished job is recorded and
   * its receipt delivered as a quiet turn.
   */
  async pollJobs(): Promise<void> {
    if (this.pollingJobs) return;
    this.pollingJobs = true;
    try {
      for (const row of await this.deps.storage.listByPhase(['live'])) {
        const running = runningJobs(row);
        if (running.length) await this.readJobs(row, running).catch((error) => console.warn(`[guest] reading ${row.agentId}'s jobs failed:`, error));
        else if ((row.jobs ?? []).some((job) => job.state !== 'running' && !job.announced)) this.track(this.deliverOwedJobs(row.agentId));
      }
    } finally {
      this.pollingJobs = false;
    }
  }

  private async readJobs(row: GuestAgentRow, running: GuestJobRecord[]): Promise<void> {
    const now = this.now();
    const sandboxId = await this.deps.host.sandbox(row.userId, row.agentId).catch(() => null);
    const result = sandboxId
      ? await this.deps.sandboxClient().execSync(sandboxId, buildGuestJobsReadCommand(running.map((job) => job.id)), undefined, { timeoutMs: 30_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER }).catch(() => null)
      : null;
    const readings = result && result.exitCode === 0 ? parseGuestJobsReading(result.stdout ?? '') : null;
    const fresh = await this.deps.storage.get(row.agentId);
    if (!fresh || fresh.phase !== 'live') return;
    let changed = false;
    if (!readings) {
      const failures = (this.jobReadFailures.get(row.agentId) ?? 0) + 1;
      this.jobReadFailures.set(row.agentId, failures);
      if (failures < 5) return;
      // Its machine has not answered for about a minute: what ran there is gone.
      for (const job of fresh.jobs ?? []) if (job.state === 'running') { job.state = 'interrupted'; job.finishedAt = new Date(now).toISOString(); changed = true; }
    } else {
      this.jobReadFailures.delete(row.agentId);
      const finalStates = new Set(['succeeded', 'failed', 'timed_out', 'stopped']);
      for (const job of fresh.jobs ?? []) {
        if (job.state !== 'running') continue;
        const reading = readings.find((r) => r.id === job.id);
        const resultState = reading?.result && finalStates.has(reading.result.state) ? reading.result.state as GuestJobRecord['state'] : null;
        const young = now - Date.parse(job.startedAt) < 15_000;
        const state = resultState ?? (reading?.stopped && !reading.alive ? 'stopped' : reading?.alive || young ? null : 'interrupted');
        if (!state) continue;
        job.state = state;
        job.exitCode = typeof reading?.result?.exitCode === 'number' ? reading.result.exitCode : null;
        job.finishedAt = reading?.result?.finishedAt && Number.isFinite(Date.parse(reading.result.finishedAt)) ? new Date(reading.result.finishedAt).toISOString() : new Date(now).toISOString();
        job.tail = guestJobTail(reading?.tail ?? '');
        // A job the guest stopped itself, or a quiet one, never starts a turn (as for a regular agent).
        if (state === 'stopped' || job.quiet) job.announced = true;
        changed = true;
        console.log(`[guest] ${fresh.transcript.name} (${fresh.agentId}) job ${job.id} ${state}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}`);
      }
    }
    if (!changed) return;
    fresh.lastActiveAt = new Date(now).toISOString();
    await this.deps.storage.put(fresh);
    if (sandboxId) await this.writeAllowedJobs(sandboxId, fresh);
    this.track(this.deliverOwedJobs(fresh.agentId));
  }

  /** Finished jobs whose receipt is owed become one quiet turn, once no other turn runs. */
  private async deliverOwedJobs(agentId: string): Promise<void> {
    await this.withLock(async () => {
      if (this.runningByAgent.has(agentId)) return; // delivered when that turn ends
      const row = await this.deps.storage.get(agentId);
      if (!row || row.phase !== 'live') return;
      const owed = (row.jobs ?? []).filter((job) => job.state !== 'running' && !job.announced);
      if (!owed.length) return;
      for (const job of owed) job.announced = true;
      row.lastActiveAt = new Date(this.now()).toISOString();
      await this.deps.storage.put(row);
      const prompt = guestJobReceiptPrompt(owed.map((job) => ({
        id: job.id, label: job.label, state: job.state, exitCode: job.exitCode, startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? new Date(this.now()).toISOString(), tail: job.tail ?? '',
      })));
      const turn: LiveTurn = {
        turnId: randomUUID(), agentId, messageId: '', state: 'waking', partial: null, answer: null,
        activity: [], files: [], startedAtMs: this.now(), stopped: false, fromJob: true, jobIds: owed.map((job) => job.id),
      };
      this.turns.set(turn.turnId, turn);
      this.runningByAgent.set(agentId, turn.turnId);
      console.log(`[guest] ${row.transcript.name} (${agentId}) answers ${owed.length} finished job${owed.length === 1 ? '' : 's'}`);
      this.track(this.runTurn(turn, prompt).catch((error) => {
        console.warn(`[guest] job turn ${turn.turnId} failed:`, error);
        return this.endTurn(turn, { state: 'failed' });
      }));
    });
  }

  // ── Deleting ────────────────────────────────────────────────────────────

  /** DELETE /api/public/guest — the visitor's Delete. */
  async deleteByVisitor(key: unknown): Promise<GuestStatus> {
    if (!this.validKey(key)) return this.blankStatus('none');
    const row = await this.deps.storage.byKeyHash(hashGuestKey(key));
    if (!row) return this.blankStatus('none');
    if (row.phase === 'live' || row.phase === 'creating') await this.remove(row.agentId, 'visitor');
    const after = await this.deps.storage.get(row.agentId);
    return after ? this.statusOfRow(after) : this.blankStatus('removed', { removedReason: 'visitor' });
  }

  /** The owner's Delete on the Guests screen. */
  async deleteByOwner(agentId: string): Promise<boolean> {
    const row = await this.deps.storage.get(agentId);
    if (!row || row.phase === 'removed') return false;
    await this.remove(agentId, 'owner');
    return true;
  }

  /**
   * The one way an agent goes: any running turn ended, the agent deleted
   * with its machine, volume and app, the transcript closed. A deletion that
   * fails leaves the row `removing`, and the sweeper tries again.
   */
  private async remove(agentId: string, reason: GuestRemovedReason, options: { failed?: boolean } = {}): Promise<void> {
    const row = await this.deps.storage.get(agentId);
    if (!row || row.phase === 'removed') return;
    const nowIso = new Date(this.now()).toISOString();
    const wasClaimed = Boolean(row.claimedAt);
    if (row.phase !== 'removing') {
      row.phase = 'removing';
      row.removedAt = nowIso;
      row.removedReason = reason;
      await this.deps.storage.put(row);
    }
    const running = this.runningByAgent.get(agentId);
    const turn = running ? this.turns.get(running) : undefined;
    if (turn) await this.interrupt(turn);
    this.deps.door.closeAgent(agentId);
    this.jobReadFailures.delete(agentId);
    const address = this.agentAddress.get(agentId);
    if (address) {
      this.addressLive.get(address)?.delete(agentId);
      if (!this.addressLive.get(address)?.size) this.addressLive.delete(address);
      this.agentAddress.delete(agentId);
    }
    const deleted = await this.deps.host.deleteAgent(row.userId, agentId).catch((error) => {
      console.warn(`[guest] deleting ${agentId} failed (the sweeper will try again):`, error);
      return false;
    });
    if (!deleted) return;
    const after = await this.deps.storage.get(agentId);
    if (!after) return;
    after.phase = 'removed';
    after.removedAt = after.removedAt ?? nowIso;
    after.transcript.removedAt = after.removedAt;
    after.transcript.removedReason = after.removedReason;
    // Its jobs went with its machine; nothing is owed to a visitor who is gone.
    for (const job of after.jobs ?? []) if (job.state === 'running') { job.state = 'interrupted'; job.finishedAt = after.removedAt; job.announced = true; }
    // A spare (before note #1055) that never met a visitor has no key to answer to.
    if (!wasClaimed) after.keyHash = null;
    await this.deps.storage.put(after);
    console.log(`[guest] ${after.transcript.name} (${agentId}) removed: ${reason}${options.failed ? ' (failed)' : ''}`);
  }

  // ── The sweeper ─────────────────────────────────────────────────────────

  /** Every minute: the 30-minute rule, the life cap, the leak guard, and the last spares retired. */
  async tick(): Promise<void> {
    const now = this.now();
    const settings = await this.settings();
    for (const row of await this.deps.storage.listByPhase(['live'])) {
      if (this.runningByAgent.has(row.agentId) || runningJobs(row).length) {
        // A running turn is activity: never removed as quiet mid-turn (note #1054), only at the end of its life.
        // So is a running background job (note #1063).
        if (row.claimedAt && now - Date.parse(row.claimedAt) >= this.limits.lifetimeMs) await this.remove(row.agentId, 'lifetime');
        continue;
      }
      const last = Date.parse(row.lastActiveAt ?? row.claimedAt ?? row.preparedAt);
      if (row.claimedAt && now - Date.parse(row.claimedAt) >= this.limits.lifetimeMs) await this.remove(row.agentId, 'lifetime');
      else if (now - last >= this.limits.quietMs) await this.remove(row.agentId, 'quiet');
      else if (row.messagesUsed >= this.limits.messagesMax && now - last >= MESSAGES_SPENT_GRACE_MS) await this.remove(row.agentId, 'messages');
    }
    for (const row of await this.deps.storage.listByPhase(['removing'])) {
      if (now - Date.parse(row.removedAt ?? row.preparedAt) >= REMOVAL_RETRY_MS) await this.remove(row.agentId, row.removedReason ?? 'quiet');
    }
    // No spares any more (note #1055): one left from before is deleted with its machine.
    for (const row of await this.deps.storage.listByPhase(['spare', 'preparing'])) {
      if (!this.busy.has(row.agentId)) await this.remove(row.agentId, 'owner');
    }
    for (const row of await this.deps.storage.listByPhase(['creating'])) {
      const since = Date.parse(row.claimedAt ?? row.preparedAt);
      if (now - since >= STUCK_MS && !this.busy.has(row.agentId)) {
        if (row.keyHash) this.failedKeys.set(row.keyHash, now);
        await this.remove(row.agentId, 'quiet', { failed: true });
      } else if (!this.busy.has(row.agentId)) {
        this.track(this.finishClaim(row.agentId)); // a restart interrupted it
      }
    }
    for (const [keyHash, at] of this.failedKeys) if (now - at > HOUR_MS) this.failedKeys.delete(keyHash);
    if (now - this.lastHourly >= HOUR_MS) {
      this.lastHourly = now;
      await this.hourly(settings).catch((error) => console.warn('[guest] hourly sweep failed:', error));
    }
  }

  /** Transcripts past 90 days, keys past a day, and guest records nobody here knows (orphans). */
  private async hourly(settings: GuestAgentSettings | null): Promise<void> {
    const now = this.now();
    await this.deps.storage.prune(now - REMOVED_KEY_DAYS * DAY_MS, guestTranscriptCutoffMs(now));
    if (!settings) return;
    const ids = await this.deps.host.guestAgentIds(settings.userId).catch(() => [] as string[]);
    for (const agentId of ids) {
      const row = await this.deps.storage.get(agentId);
      if (row && row.phase !== 'removed') continue;
      if (this.busy.has(agentId)) continue;
      console.warn(`[guest] orphan guest record ${agentId}: deleting it with its machine`);
      await this.deps.host.deleteAgent(settings.userId, agentId).catch(() => false);
    }
  }

  // ── The owner's Guests screen ───────────────────────────────────────────

  async listForOwner(): Promise<WorkspaceGuestsAnswer> {
    const now = this.now();
    const live = await this.deps.storage.listByPhase(['creating', 'live']);
    const past = await this.deps.storage.listRemoved(200);
    return {
      live: live.map((row) => {
        const status = this.statusOfRow(row);
        return {
          agentId: row.agentId, name: row.transcript.name, avatarUrl: row.transcript.avatarUrl, createdAt: row.claimedAt ?? row.preparedAt,
          messages: row.transcript.messages.filter((m) => m.role === 'visitor').length, state: status.state, quietUntil: status.quietUntil,
        };
      }),
      past: past.filter((row) => row.claimedAt).map((row) => ({
        agentId: row.agentId, name: row.transcript.name, avatarUrl: row.transcript.avatarUrl, createdAt: row.claimedAt ?? row.preparedAt,
        removedAt: row.removedAt, removedReason: row.removedReason,
        messages: row.transcript.messages.filter((m) => m.role === 'visitor').length,
        costUsd: Math.round(row.transcript.messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) * 10_000) / 10_000,
      })),
      limits: { globalPerDay: this.limits.globalPerDay, perAddressPerDay: this.limits.perAddressPerDay },
      madeToday: await this.deps.storage.countClaimedSince(utcDayStart(now)),
    };
  }

  /** One transcript, with the running turn's text so far while it works. */
  async transcriptForOwner(agentId: string): Promise<(GuestTranscriptRecord & { state: GuestState; partial: string | null }) | null> {
    const row = await this.deps.storage.get(agentId);
    if (!row || (!row.claimedAt && row.phase !== 'removed')) return null;
    const running = this.runningByAgent.get(agentId);
    const turn = running ? this.turns.get(running) : undefined;
    return { ...row.transcript, state: this.statusOfRow(row).state, partial: turn?.partial ?? null };
  }

  /** Whether an agent id is a guest's (the harness and `agent message` refuse them). */
  async isGuestAgent(agentId: string): Promise<boolean> {
    return Boolean(await this.deps.storage.get(agentId));
  }
}
