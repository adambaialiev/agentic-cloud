/**
 * Guests' own agents (note #1038; the design is note #1036): a visitor of
 * the home page, signed out, makes a sealed Claude Code agent of their own,
 * talks to it, and deletes it — or it is deleted with its machine after 30
 * quiet minutes, 3 hours, or 40 messages.
 *
 * This service holds everything between the six public routes and the
 * agent layer: the switch, the ceilings and rests, stopped spares, the
 * waiting line, one turn at a time per agent through the model door, Stop,
 * deletion, the sweeper and its leak guard, and the owner's transcripts.
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
import { seatTooFullForPublic } from './public-guide-service.js';
import { guideAnswerLeak } from './public-guide-machine.js';
import { GuestModelDoor } from './guest-model-door.js';
import {
  GUEST_TURN_DIR,
  buildGuestClaudeCommand,
  buildGuestDepsCommand,
  buildGuestReapCommand,
  buildGuestSetupCommand,
  buildGuestVisitorPrompt,
  readGuestStream,
  type GuestStreamReading,
} from './guest-agent-machine.js';
import { guestTranscriptCutoffMs, type GuestAgentRow, type GuestAgentSettings, type GuestAgentStorage } from './guest-agent-storage.js';
import {
  GUEST_AGENT_LIMITS,
  GUEST_AGENT_MACHINE,
  GUEST_AGENT_MODEL,
  GUEST_DECLINED_MARKER,
  GUEST_DECLINED_TEXT,
  GUEST_TURN_FINAL_STATES,
  GUEST_TURNSTILE_ACTION,
  guestGreeting,
  type GuestActivity,
  type GuestCreateAnswer,
  type GuestCreateStep,
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
/** A spare or a creation stuck this long is abandoned and its record deleted. */
const STUCK_MS = 15 * MINUTE_MS;
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
  doorKey?: string;
  sandboxId?: string;
}

interface LineEntry {
  keyHash: string;
  address: string;
  joinedMs: number;
  lastPollMs: number;
}

/**
 * What a visitor reads when a reply ran out of its minutes (note #1047): never
 * "something went wrong", since nothing did. What it had said so far, the
 * command it was in, and a smaller thing to ask for.
 */
export function guestOutOfTimeAnswer(reading: Pick<GuestStreamReading, 'partial' | 'activity'>): string {
  const minutes = Math.round(GUEST_AGENT_LIMITS.turnTimeoutMs / 60_000);
  const last = [...reading.activity].reverse().find((item) => item.kind === 'run');
  return [
    ...(reading.partial?.trim() ? [reading.partial.trim(), ''] : []),
    `That took longer than the ${minutes} minutes I have for one reply, so it was stopped${last ? ` while running \`${last.label.replace(/`/g, "'")}\`` : ''}.`,
    'Ask me for a smaller piece (one test file instead of the whole suite, say) and I will do it within the time. This one did not count against your messages.',
  ].join('\n');
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
  private readonly line: LineEntry[] = [];
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
  private preparing = false;
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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Background work (a claim finishing, a turn, a spare) — tracked so tests and shutdown can wait for it. */
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
    if (this.deps.seats) {
      const full = seatTooFullForPublic(await this.ownerSeat(settings), now, {
        fiveHourPercent: this.limits.restFiveHourPercent, weekPercent: this.limits.restWeekPercent,
      });
      if (full) return full;
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

  private async occupied(): Promise<number> {
    return (await this.deps.storage.listByPhase(['creating', 'live'])).length;
  }

  // ── What the visitor sees ───────────────────────────────────────────────

  private blankStatus(state: GuestState, extra: Partial<GuestStatus> = {}): GuestStatus {
    return {
      state,
      agent: null,
      machine: null,
      messages: [],
      turn: null,
      steps: null,
      estimateSeconds: null,
      createdAt: null,
      quietUntil: null,
      endsAt: null,
      messagesLeft: null,
      linePosition: null,
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
      const visible: GuestMessage = { id: m.id, role: m.role, text: m.flag ? GUEST_DECLINED_TEXT : m.text, at: m.at };
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
      return this.blankStatus('creating', { agent, steps: row.steps ?? null, estimateSeconds: row.fromSpare ? 15 : 120, createdAt: row.claimedAt, machine: { ...GUEST_AGENT_MACHINE, awake: true } });
    }
    const now = this.now();
    const turnId = this.runningByAgent.get(row.agentId) ?? null;
    const last = Date.parse(row.lastActiveAt ?? row.claimedAt ?? row.preparedAt);
    const idle = this.deps.idleStopMs ?? 3 * MINUTE_MS;
    const awake = Boolean(turnId) || now - last < idle;
    const state: GuestState = turnId ? 'working' : awake ? 'ready' : 'asleep';
    const endsAtMs = Date.parse(row.claimedAt ?? row.preparedAt) + this.limits.lifetimeMs;
    return this.blankStatus(state, {
      agent,
      machine: { ...GUEST_AGENT_MACHINE, awake },
      messages: this.visitorMessages(row),
      turn: turnId ? { turnId } : null,
      quietUntil: turnId ? null : new Date(Math.min(last + this.limits.quietMs, endsAtMs)).toISOString(),
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
      const waiting = this.line.findIndex((entry) => entry.keyHash === keyHash);
      if (waiting >= 0) {
        this.line[waiting]!.lastPollMs = now;
        return this.blankStatus('waiting', { linePosition: waiting + 1 });
      }
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
      if (['creating', 'ready', 'working', 'asleep', 'waiting'].includes(current.state)) return { httpStatus: 200, answer: { status: current } };
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
      if (this.line.some((entry) => entry.address === args.address)) {
        return { httpStatus: 200, answer: { status: this.blankStatus('limited', { until: null }) } };
      }
      const key = randomBytes(32).toString('base64url');
      const keyHash = hashGuestKey(key);
      if (this.line.length === 0 && await this.occupied() < this.limits.liveMax) {
        const row = await this.claim(settings, keyHash, args.address);
        if (!row) {
          this.failedKeys.set(keyHash, now);
          return { httpStatus: 200, answer: { status: this.blankStatus('failed') } };
        }
        return { httpStatus: 201, answer: { key, status: this.statusOfRow(row) } };
      }
      if (this.line.length >= this.limits.lineMax) {
        return { httpStatus: 200, answer: { status: this.blankStatus('resting', { until: null }) } };
      }
      this.line.push({ keyHash, address: args.address, joinedMs: now, lastPollMs: now });
      return { httpStatus: 201, answer: { key, status: this.blankStatus('waiting', { linePosition: this.line.length }) } };
    });
  }

  private newTranscript(agentId: string, name: string): GuestTranscriptRecord {
    return { agentId, name, avatarUrl: null, createdAt: new Date(this.now()).toISOString(), removedAt: null, removedReason: null, messages: [] };
  }

  /**
   * Gives the visitor an agent: a ready spare when there is one (seconds),
   * else a new one built from nothing (a minute or two). Caller holds the lock.
   */
  private async claim(settings: GuestAgentSettings, keyHash: string, address: string): Promise<GuestAgentRow | null> {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const spare = (await this.deps.storage.listByPhase(['spare']))[0];
    let row: GuestAgentRow;
    if (spare) {
      row = {
        ...spare,
        phase: 'creating',
        keyHash,
        claimedAt: nowIso,
        fromSpare: true,
        lastActiveAt: nowIso,
        steps: [{ id: 'computer', done: true }, { id: 'code', done: true }, { id: 'claude', done: false }, { id: 'hello', done: false }],
        transcript: { ...spare.transcript, createdAt: nowIso },
      };
    } else {
      const made = await this.deps.host.createRecord(settings.userId, settings.orgId).catch((error) => ({ error: String(error) }));
      if ('error' in made) {
        console.warn(`[guest] could not make an agent: ${made.error}`);
        return null;
      }
      row = {
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
        steps: [{ id: 'computer', done: false }, { id: 'code', done: false }, { id: 'claude', done: false }, { id: 'hello', done: false }],
        removedAt: null,
        removedReason: null,
        transcript: this.newTranscript(made.id, made.name),
      };
    }
    await this.deps.storage.put(row);
    this.addressMade.set(address, [...this.madeToday(address, now), now]);
    const live = this.addressLive.get(address) ?? new Set<string>();
    live.add(row.agentId);
    this.addressLive.set(address, live);
    this.agentAddress.set(row.agentId, address);
    this.track(this.finishClaim(row.agentId));
    return row;
  }

  private async step(agentId: string, id: GuestCreateStep['id']): Promise<void> {
    const row = await this.deps.storage.get(agentId);
    if (!row?.steps) return;
    row.steps = row.steps.map((s) => (s.id === id ? { ...s, done: true } : s));
    await this.deps.storage.put(row);
  }

  /** Waits for a record's machine to exist (the build runs behind the reservation). */
  private async waitForMachine(userId: string, agentId: string, timeoutMs = 8 * MINUTE_MS): Promise<AgentRecord | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const agent = await this.deps.host.agent(userId, agentId).catch(() => null);
      if (!agent) return null;
      if (agent.serverId) return agent;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return null;
  }

  /** Runs the machine's setup (users, lock, proxy, copy, runner); true when it is ready for a turn. */
  private async setupMachine(row: GuestAgentRow): Promise<string | null> {
    const agent = await this.waitForMachine(row.userId, row.agentId);
    if (!agent) return null;
    const sandboxId = await this.deps.host.sandbox(row.userId, row.agentId).catch(() => null);
    const source = sandboxId ? await this.deps.host.source(row.userId, agent).catch(() => null) : null;
    if (!sandboxId || !source || !this.deps.doorUrl) return null;
    const setup = await this.deps.sandboxClient().execSync(sandboxId, buildGuestSetupCommand({ ...source, doorUrl: this.deps.doorUrl, agentName: row.transcript.name }), undefined, {
      timeoutMs: 420_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
    }).catch((error) => ({ exitCode: 1, stderr: String(error), timedOut: false, stdout: '' }));
    if (setup.exitCode !== 0 || setup.timedOut) {
      console.warn(`[guest] setup failed on ${sandboxId}: ${String(setup.stderr ?? '').slice(-300) || `exit ${setup.exitCode}`}`);
      return null;
    }
    return sandboxId;
  }

  private async finishClaim(agentId: string): Promise<void> {
    if (this.busy.has(agentId)) return;
    this.busy.add(agentId);
    try {
      const row = await this.deps.storage.get(agentId);
      if (!row || row.phase !== 'creating') return;
      const agent = await this.waitForMachine(row.userId, agentId);
      if (agent) await this.step(agentId, 'computer');
      const sandboxId = agent ? await this.setupMachine(row) : null;
      if (!sandboxId) {
        if (row.keyHash) this.failedKeys.set(row.keyHash, this.now());
        await this.remove(agentId, 'quiet', { failed: true });
        return;
      }
      await this.step(agentId, 'code');
      await this.step(agentId, 'claude');
      const ready = await this.deps.storage.get(agentId);
      if (!ready || ready.phase !== 'creating') return;
      const nowIso = new Date(this.now()).toISOString();
      ready.steps = (ready.steps ?? []).map((s) => ({ ...s, done: true }));
      ready.phase = 'live';
      ready.lastActiveAt = nowIso;
      ready.transcript.messages = [{ id: randomUUID(), role: 'agent', text: guestGreeting(ready.transcript.name), at: nowIso, state: 'answered' }];
      await this.deps.storage.put(ready);
      console.log(`[guest] ${ready.transcript.name} (${agentId}) is live`);
    } finally {
      this.busy.delete(agentId);
    }
    this.track(this.tick());
  }

  /** One stopped spare, made ahead so a visitor waits seconds. */
  private async prepareSpare(settings: GuestAgentSettings): Promise<void> {
    if (this.preparing) return;
    this.preparing = true;
    try {
      const made = await this.deps.host.createRecord(settings.userId, settings.orgId).catch((error) => ({ error: String(error) }));
      if ('error' in made) { console.warn(`[guest] could not make a spare: ${made.error}`); return; }
      const nowIso = new Date(this.now()).toISOString();
      const row: GuestAgentRow = {
        agentId: made.id, userId: settings.userId, orgId: settings.orgId, phase: 'preparing', keyHash: null,
        preparedAt: nowIso, claimedAt: null, lastActiveAt: null, messagesUsed: 0, claudeSessionId: null, steps: null,
        removedAt: null, removedReason: null, transcript: this.newTranscript(made.id, made.name),
      };
      await this.deps.storage.put(row);
      const sandboxId = await this.setupMachine(row);
      const after = await this.deps.storage.get(made.id);
      if (!after || after.phase !== 'preparing') return;
      if (!sandboxId) {
        await this.remove(made.id, 'quiet', { failed: true });
        return;
      }
      // Packages, once, so a visitor's "run that test" takes seconds (note #1047). Best effort.
      const deps = await this.deps.sandboxClient().execSync(sandboxId, buildGuestDepsCommand(), undefined, {
        timeoutMs: 660_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
      }).catch((error) => ({ exitCode: 1, stderr: String(error), timedOut: false, stdout: '' }));
      if (deps.exitCode !== 0) console.warn(`[guest] spare ${made.name}: packages not installed (${String(deps.stderr ?? '').slice(-200) || `exit ${deps.exitCode}`}); it stays a spare`);
      const ready = await this.deps.storage.get(made.id);
      if (!ready || ready.phase !== 'preparing') return;
      ready.phase = 'spare';
      await this.deps.storage.put(ready);
      console.log(`[guest] spare ${made.name} (${made.id}) is ready`);
    } finally {
      this.preparing = false;
    }
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
        const full = seat ? seatTooFullForPublic(seat, this.now(), { fiveHourPercent: this.limits.restFiveHourPercent, weekPercent: this.limits.restWeekPercent }) : null;
        if (full) {
          outcome = { kind: 'ok' };
          this.rest(full.until);
          return await this.endTurn(turn, { state: 'resting', until: full.until });
        }
      }
      const client = this.deps.sandboxClient();
      const sandboxId = await this.setupMachine(row);
      if (!sandboxId) return await this.endTurn(turn, { state: 'failed' });
      if (turn.stopped) { outcome = { kind: 'ok' }; return await this.endTurn(turn, { state: 'stopped' }); }
      turn.sandboxId = sandboxId;
      turn.state = 'working';
      if (!client.uploadToSandbox) return await this.endTurn(turn, { state: 'failed' });
      const timeoutSeconds = Math.round(this.limits.turnTimeoutMs / 1000);
      let run = await this.launch(client, sandboxId, turn, lease.token, timeoutSeconds, {
        prompt: buildGuestVisitorPrompt(text),
        ...(row.claudeSessionId ? { resumeSessionId: row.claudeSessionId } : { sessionId: randomUUID() }),
      });
      // A conversation the machine lost: start a fresh one carrying the exchange so far, once.
      if (row.claudeSessionId && run.missingSession && !turn.stopped) {
        const earlier = row.transcript.messages.filter((m) => m.id !== turn.messageId)
          .map((m) => `${m.role === 'visitor' ? 'The visitor wrote' : 'You answered'}: ${m.text}`).join('\n\n');
        run = await this.launch(client, sandboxId, turn, lease.token, timeoutSeconds, {
          prompt: `${earlier ? `${earlier}\n\n` : ''}${buildGuestVisitorPrompt(text)}`,
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
        if (run.timedOut) return await this.endTurn(turn, { state: 'answered', reading, answer: guestOutOfTimeAnswer(reading), refund: true });
        return await this.endTurn(turn, { state: 'failed', reading });
      }
      const answer = (reading.answer ?? '').trim();
      if (!answer || answer.startsWith(GUEST_DECLINED_MARKER)) {
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
      if (end.state === 'failed' || end.state === 'resting' || end.refund) row.messagesUsed = Math.max(0, row.messagesUsed - 1);
      if (end.state !== 'resting' || end.reading) {
        row.transcript.messages.push({
          id: randomUUID(),
          role: 'agent',
          text: end.answer ?? (end.state === 'failed' ? 'Something went wrong on our side. Try that again.' : end.state === 'stopped' ? (end.reading?.partial ?? 'Stopped.') : ''),
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
  }

  // ── Deleting ────────────────────────────────────────────────────────────

  /** DELETE /api/public/guest — the visitor's Delete. */
  async deleteByVisitor(key: unknown): Promise<GuestStatus> {
    if (!this.validKey(key)) return this.blankStatus('none');
    const keyHash = hashGuestKey(key);
    const waiting = this.line.findIndex((entry) => entry.keyHash === keyHash);
    if (waiting >= 0) { this.line.splice(waiting, 1); return this.blankStatus('none'); }
    const row = await this.deps.storage.byKeyHash(keyHash);
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
    // A spare that never met a visitor has no key to answer to.
    if (!wasClaimed) after.keyHash = null;
    await this.deps.storage.put(after);
    console.log(`[guest] ${after.transcript.name} (${agentId}) removed: ${reason}${options.failed ? ' (failed)' : ''}`);
  }

  // ── The sweeper ─────────────────────────────────────────────────────────

  /** Every minute: the 30-minute rule, the life cap, the leak guard, the line, the spares. */
  async tick(): Promise<void> {
    const now = this.now();
    const settings = await this.settings();
    for (const row of await this.deps.storage.listByPhase(['live'])) {
      if (this.runningByAgent.has(row.agentId)) {
        if (row.claimedAt && now - Date.parse(row.claimedAt) >= this.limits.lifetimeMs + this.limits.turnTimeoutMs) await this.remove(row.agentId, 'lifetime');
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
    for (const row of await this.deps.storage.listByPhase(['creating', 'preparing'])) {
      const since = Date.parse(row.claimedAt ?? row.preparedAt);
      if (now - since >= STUCK_MS && !this.busy.has(row.agentId)) {
        if (row.keyHash) this.failedKeys.set(row.keyHash, now);
        await this.remove(row.agentId, 'quiet', { failed: true });
      } else if (row.phase === 'creating' && !this.busy.has(row.agentId)) {
        this.track(this.finishClaim(row.agentId)); // a restart interrupted it
      }
    }
    // The line: places kept only while the page polls; the head gets the next free slot.
    for (let i = this.line.length - 1; i >= 0; i--) if (now - this.line[i]!.lastPollMs > this.limits.linePollGraceMs) this.line.splice(i, 1);
    if (settings?.enabled && this.line.length) {
      await this.withLock(async () => {
        while (this.line.length && await this.occupied() < this.limits.liveMax && !await this.restingState(settings, true)) {
          const head = this.line.shift()!;
          const row = await this.claim(settings, head.keyHash, head.address);
          if (!row) this.failedKeys.set(head.keyHash, now);
        }
      });
    }
    // Spares: kept at the target while guests are on, inside the machine ceiling.
    if (settings?.enabled && this.deps.doorUrl && !this.preparing) {
      const spares = (await this.deps.storage.listByPhase(['spare', 'preparing'])).length;
      const machines = spares + await this.occupied();
      if (spares < this.limits.sparesTarget && machines < this.limits.liveMax + this.limits.sparesTarget) {
        this.track(this.prepareSpare(settings));
      }
    } else if (settings && !settings.enabled) {
      for (const row of await this.deps.storage.listByPhase(['spare'])) await this.remove(row.agentId, 'owner');
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
      limits: { liveMax: this.limits.liveMax, sparesTarget: this.limits.sparesTarget, globalPerDay: this.limits.globalPerDay },
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
