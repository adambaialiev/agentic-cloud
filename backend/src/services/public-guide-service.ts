/**
 * The public question route's engine (note #1010): one fresh conversation
 * per visit, one answer at a time, the limits, the rest states, and the
 * transcript the founder reads.
 *
 * A visit turn does NOT go through the agent's chat or its run slot. It is
 * its own Claude session (`--session-id` on the first question, `--resume`
 * after) on the guide's machine, launched through the sealed runner as the
 * `guide` user (services/public-guide-machine.ts), so visits never share a
 * conversation with each other or with the owner's own chat with the agent.
 *
 * Knowledge page: sealed-public-agent.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRecord } from '../types/user.js';
import type { OrgSeatDocument } from '../types/org.js';
import type { PlatformCredentialLeaseOutcome } from '../types/platform-credential.js';
import type { PlatformCredentialPool } from './platform-credential-pool.js';
import type { WorkspaceRuntimeClient } from './sandbox-client.js';
import { SEAT_LEASE_PREFIX } from './org-seat-credentials.js';
import { DEFAULT_DEVELOPMENT_SSH_USER } from './development-root.js';
import { claudeUsageLimitResetAtSeconds, isClaudeUsageLimitText } from '../agent/harness-auth-failure.js';
import { CLAUDE_OAUTH_TOKEN_ENV } from '../agent/claude/claude-login.js';
import { quoteShellArg } from '../utils/shell-quote.js';
import {
  PUBLIC_ASK_FINAL_STATES,
  PUBLIC_GUIDE_DECLINED_MARKER,
  PUBLIC_GUIDE_DECLINED_TEXT,
  PUBLIC_GUIDE_KIND,
  PUBLIC_GUIDE_LIMITS,
  PUBLIC_GUIDE_MODEL,
  type PublicAskAnswer,
  type PublicAskState,
  type PublicAskStatus,
  type PublicGuideQuestionRecord,
  type PublicGuideVisitRecord,
  type WorkspacePublicGuideVisitsAnswer,
  isValidVisitId,
} from '../shared/public-guide.js';
import {
  GUIDE_VISIT_STREAM_DIR,
  buildGuideSetupCommand,
  buildSealedClaudeCommand,
  buildVisitorPrompt,
  guideAnswerLeak,
  readGuideStream,
  type GuideSource,
} from './public-guide-machine.js';
import { transcriptCutoffMs, type PublicGuideStorage } from './public-guide-storage.js';

const HOUR_MS = 60 * 60 * 1000;

/** A sealed agent of the public-guide kind, and only a Claude one. */
export function isPublicGuide(agent: Pick<AgentRecord, 'sealed' | 'cli'> | null | undefined): boolean {
  return agent?.sealed === PUBLIC_GUIDE_KIND && agent.cli === 'claude';
}

/**
 * Whether a seat is too full to spend on strangers (note #1010, section 6):
 * benched, or its 5-hour window at {@link PUBLIC_GUIDE_LIMITS.restFiveHourPercent}%,
 * or its week at {@link PUBLIC_GUIDE_LIMITS.restWeekPercent}% — which leaves
 * the last of the plan for the owner's own agents. Answers when it may
 * answer again (null when nobody knows), or null when the seat may serve.
 */
export function seatTooFullForPublic(
  seat: Pick<OrgSeatDocument, 'status' | 'cooldownUntil' | 'usage'> | null | undefined,
  now = Date.now(),
): { until: string | null } | null {
  if (!seat) return { until: null };
  if (seat.status === 'dead' || seat.status === 'disabled') return { until: null };
  const cooldown = seat.cooldownUntil ? Date.parse(seat.cooldownUntil) : Number.NaN;
  if (seat.status === 'cooldown' && (!Number.isFinite(cooldown) || cooldown > now)) {
    return { until: Number.isFinite(cooldown) ? new Date(cooldown).toISOString() : null };
  }
  const windows = seat.usage?.windows ?? {};
  const full = (id: string, percent: number) => {
    const window = Object.values(windows).find((w) => w?.id === id) ?? windows[id];
    if (!window || !(window.usedPercent >= percent)) return null;
    const resets = typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : Number.NaN;
    // A reading whose window already reset says nothing about now.
    if (Number.isFinite(resets) && resets <= now) return null;
    return { until: Number.isFinite(resets) ? new Date(resets).toISOString() : null };
  };
  return full('five_hour', PUBLIC_GUIDE_LIMITS.restFiveHourPercent)
    ?? full('seven_day', PUBLIC_GUIDE_LIMITS.restWeekPercent);
}

/** What the backend's agent layer lends this service. */
export interface PublicGuideHost {
  /** The agent the pointer names, only while it is still a live sealed guide. */
  guideAgent(userId: string, agentId: string): Promise<AgentRecord | null>;
  /** Its machine, built if missing; stamps activity so it is not put to sleep mid-answer. */
  guideSandbox(userId: string, agentId: string): Promise<string | null>;
  /** Where its public copy comes from — a PUBLIC repository's anonymous clone, or null. */
  guideSource(userId: string, agent: AgentRecord): Promise<GuideSource | null>;
}

export interface PublicGuideServiceDeps {
  storage: PublicGuideStorage;
  host: PublicGuideHost;
  pool?: PlatformCredentialPool;
  seats?: {
    getSeat(seatId: string): Promise<OrgSeatDocument | null>;
    listSeatsByMember(orgId: string, userId: string): Promise<OrgSeatDocument[]>;
  };
  sandboxClient: () => WorkspaceRuntimeClient;
  now?: () => number;
  /** Override for tests. */
  limits?: Partial<typeof PUBLIC_GUIDE_LIMITS>;
}

interface LiveQuestion {
  record: PublicGuideQuestionRecord;
  visitId: string;
  takenAtMs: number;
  /** The visitor-limit keys it was counted under, refunded if it fails. */
  keys: string[];
  until?: string | null;
}

export class PublicGuideService {
  private readonly queue: LiveQuestion[] = [];
  private running: LiveQuestion | null = null;
  private readonly live = new Map<string, LiveQuestion>();
  /** Questions asked per visitor key in the last hour (address, and visit id). In memory only. */
  private readonly visitorAsks = new Map<string, number[]>();
  private restUntilMs = 0;
  private restUntilIso: string | null = null;
  private worker: Promise<void> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly limits: typeof PUBLIC_GUIDE_LIMITS;

  constructor(private readonly deps: PublicGuideServiceDeps) {
    this.limits = { ...PUBLIC_GUIDE_LIMITS, ...(deps.limits ?? {}) };
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Delete transcripts past their 90 days now and every six hours. */
  start(): void {
    void this.prune();
    this.pruneTimer = setInterval(() => { void this.prune(); }, 6 * HOUR_MS);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  async prune(): Promise<number> {
    return this.deps.storage.pruneBefore(transcriptCutoffMs(this.now())).catch(() => 0);
  }

  /** Point the public route at a guide (its creation), or at nobody. */
  async setGuide(userId: string, agentId: string): Promise<void> {
    await this.deps.storage.setGuide({ userId, agentId, setAt: new Date(this.now()).toISOString() });
  }

  async clearGuide(agentId: string): Promise<void> {
    const current = await this.deps.storage.getGuide();
    if (current?.agentId === agentId) await this.deps.storage.setGuide(null);
  }

  private async currentGuide(): Promise<{ userId: string; agent: AgentRecord } | null> {
    const pointer = await this.deps.storage.getGuide().catch(() => null);
    if (!pointer) return null;
    const agent = await this.deps.host.guideAgent(pointer.userId, pointer.agentId).catch(() => null);
    return agent && isPublicGuide(agent) ? { userId: pointer.userId, agent } : null;
  }

  /** The seat the guide's turns run on: its own pin, else its owner's selected Claude seat there. */
  private async guideSeat(userId: string, agent: AgentRecord): Promise<OrgSeatDocument | null> {
    if (!this.deps.seats) return null;
    if (agent.seatId) return this.deps.seats.getSeat(agent.seatId).catch(() => null);
    if (!agent.orgId) return null;
    const seats = (await this.deps.seats.listSeatsByMember(agent.orgId, userId).catch(() => []))
      .filter((seat) => seat.provider === 'claude');
    return seats.find((seat) => seat.selected) ?? seats[0] ?? null;
  }

  private rest(until: string | null): void {
    const untilMs = until ? Date.parse(until) : Number.NaN;
    this.restUntilMs = Number.isFinite(untilMs) ? untilMs : this.now() + HOUR_MS;
    this.restUntilIso = until && Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null;
  }

  /**
   * Resting, and until when — or null when the guide may take a question.
   * `caps` adds the global hour and day limits, which only a NEW question is
   * judged against (one already taken is inside the count).
   */
  private async restingState(caps: boolean): Promise<{ until: string | null } | null> {
    const now = this.now();
    if (this.restUntilMs > now) return { until: this.restUntilIso ?? new Date(this.restUntilMs).toISOString() };
    const guide = await this.currentGuide();
    if (!guide) return { until: null };
    // The seat itself (section 6): a seat this check cannot see is not a reason to rest.
    if (this.deps.seats) {
      const full = seatTooFullForPublic(await this.guideSeat(guide.userId, guide.agent), now);
      if (full) return full;
    }
    if (!caps) return null;
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    if (await this.deps.storage.countQuestionsSince(dayStart.getTime()) >= this.limits.globalPerDay) {
      return { until: new Date(dayStart.getTime() + 24 * HOUR_MS).toISOString() };
    }
    if (await this.deps.storage.countQuestionsSince(now - HOUR_MS) >= this.limits.globalPerHour) {
      return { until: new Date(now + HOUR_MS).toISOString() };
    }
    return null;
  }

  private recentAsks(key: string, now: number): number[] {
    const kept = (this.visitorAsks.get(key) ?? []).filter((at) => now - at < HOUR_MS);
    if (kept.length) this.visitorAsks.set(key, kept); else this.visitorAsks.delete(key);
    return kept;
  }

  private refund(keys: string[], atMs: number): void {
    for (const key of keys) {
      const list = this.visitorAsks.get(key);
      const index = list?.indexOf(atMs) ?? -1;
      if (list && index >= 0) list.splice(index, 1);
    }
  }

  private position(question: LiveQuestion): number {
    const index = this.queue.indexOf(question);
    return index < 0 ? 0 : index + (this.running ? 1 : 0);
  }

  /**
   * POST /api/public/ask. `address` is the visitor's network address: it
   * keys the in-memory hourly limit and is never written anywhere.
   */
  async ask(args: { visitId: unknown; question: unknown; address: string }): Promise<PublicAskAnswer> {
    if (!isValidVisitId(args.visitId)) return { state: 'invalid', error: 'Reload the page and ask again.' };
    const question = typeof args.question === 'string' ? args.question.replace(/\r\n?/g, '\n').trim() : '';
    if (!question) return { state: 'invalid', error: 'Type a question first.' };
    if ([...question].length > this.limits.questionMaxChars) {
      return { state: 'invalid', error: `A question can be ${this.limits.questionMaxChars} characters at most.` };
    }
    const now = this.now();
    const keys = [`address:${args.address}`, `visit:${args.visitId}`];
    const asked = keys.map((key) => this.recentAsks(key, now));
    const fullest = asked.reduce((a, b) => (b.length > a.length ? b : a));
    if (fullest.length >= this.limits.perVisitorPerHour) {
      return { state: 'limited', until: new Date(Math.min(...fullest) + HOUR_MS).toISOString() };
    }
    const resting = await this.restingState(true);
    if (resting) return { state: 'resting', until: resting.until };
    if ([...this.live.values()].some((q) => q.visitId === args.visitId && !PUBLIC_ASK_FINAL_STATES.includes(q.record.state))) {
      return { state: 'busy' };
    }
    if (this.queue.length >= this.limits.queueMax) return { state: 'busy' };
    const guide = await this.currentGuide();
    if (!guide) return { state: 'resting', until: null };

    const record: PublicGuideQuestionRecord = {
      questionId: randomUUID(),
      question,
      askedAt: new Date(now).toISOString(),
      state: 'queued',
    };
    const existing = await this.deps.storage.getVisit(args.visitId);
    const visit: PublicGuideVisitRecord = existing && existing.agentId === guide.agent.id
      ? existing
      : { visitId: args.visitId, agentId: guide.agent.id, startedAt: record.askedAt, questions: [] };
    if (existing && existing.agentId !== guide.agent.id) {
      // A visit id that belonged to an earlier guide starts over; nothing of it is reused.
      return { state: 'invalid', error: 'Reload the page and ask again.' };
    }
    visit.questions.push(record);
    await this.deps.storage.putVisit(visit);
    for (const key of keys) { const list = this.visitorAsks.get(key) ?? []; list.push(now); this.visitorAsks.set(key, list); }
    const live: LiveQuestion = { record, visitId: args.visitId, takenAtMs: now, keys };
    this.live.set(record.questionId, live);
    this.queue.push(live);
    const position = this.position(live);
    this.kick();
    return { state: 'accepted', questionId: record.questionId, position };
  }

  /**
   * GET /api/public/ask/status: who answers and whether it rests, for the page
   * on load. Judged as a new question would be (the global caps included), so
   * a page that says "open" takes the next question unless the visitor's own
   * ten are spent.
   */
  async overview(): Promise<{ state: 'open' | 'resting'; until: string | null; agentName: string | null }> {
    const guide = await this.currentGuide();
    if (!guide) return { state: 'resting', until: null, agentName: null };
    const resting = await this.restingState(true);
    return { state: resting ? 'resting' : 'open', until: resting?.until ?? null, agentName: guide.agent.name ?? null };
  }

  /** GET /api/public/ask/:questionId. */
  async status(questionId: string): Promise<PublicAskStatus | null> {
    if (typeof questionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(questionId)) return null;
    const now = this.now();
    const live = this.live.get(questionId);
    if (live) return this.statusOf(live.record, now - live.takenAtMs, this.position(live), live.until);
    const visitId = await this.deps.storage.visitIdForQuestion(questionId);
    const visit = visitId ? await this.deps.storage.getVisit(visitId) : null;
    const record = visit?.questions.find((q) => q.questionId === questionId);
    if (!record) return null;
    // Stored unfinished but not running here: a restart took it. Said as failed, and never counted.
    if (!PUBLIC_ASK_FINAL_STATES.includes(record.state)) {
      record.state = 'failed';
      await this.deps.storage.putVisit(visit!).catch(() => undefined);
    }
    return this.statusOf(record, now - Date.parse(record.askedAt), 0, undefined);
  }

  private statusOf(record: PublicGuideQuestionRecord, elapsedMs: number, position: number, until: string | null | undefined): PublicAskStatus {
    const answer = record.state === 'answered' ? record.answer ?? ''
      : record.state === 'declined' ? PUBLIC_GUIDE_DECLINED_TEXT
        : null;
    return {
      questionId: record.questionId,
      state: record.state,
      position: record.state === 'queued' ? position : 0,
      files: record.files ?? [],
      answer,
      ...(record.state === 'resting' ? { until: until ?? null } : {}),
      elapsedSeconds: Math.max(0, Math.round(elapsedMs / 1000)),
    };
  }

  private kick(): void {
    if (this.worker) return;
    this.worker = (async () => {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        this.running = next;
        try {
          await this.answer(next);
        } catch (error) {
          console.warn('[public-guide] answer failed:', error);
          await this.finish(next, { state: 'failed' });
        } finally {
          this.running = null;
        }
      }
    })().finally(() => { this.worker = null; if (this.queue.length) this.kick(); });
  }

  /** Waits for the queue to drain. For tests. */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  private async finish(question: LiveQuestion, patch: Partial<PublicGuideQuestionRecord>, until?: string | null): Promise<void> {
    Object.assign(question.record, patch);
    question.record.seconds = Math.round((this.now() - question.takenAtMs) / 1000);
    if (until !== undefined) question.until = until;
    if (question.record.state === 'failed' || question.record.state === 'resting') {
      // Not counted against the visitor (design: "that question was not counted").
      this.refund(question.keys, question.takenAtMs);
    }
    await this.persist(question);
    // Kept a few minutes for the page's last poll; the transcript holds it after that.
    setTimeout(() => this.live.delete(question.record.questionId), 10 * 60_000).unref?.();
  }

  private async persist(question: LiveQuestion): Promise<void> {
    const visit = await this.deps.storage.getVisit(question.visitId);
    if (!visit) return;
    const index = visit.questions.findIndex((q) => q.questionId === question.record.questionId);
    if (index >= 0) visit.questions[index] = { ...question.record };
    else visit.questions.push({ ...question.record });
    await this.deps.storage.putVisit(visit);
  }

  private setState(question: LiveQuestion, state: PublicAskState): void {
    question.record.state = state;
  }

  /** One visit turn, start to finish. Never throws past `kick`. */
  private async answer(question: LiveQuestion): Promise<void> {
    const guide = await this.currentGuide();
    if (!guide) return this.finish(question, { state: 'resting' }, null);
    const resting = await this.restingState(false);
    if (resting) return this.finish(question, { state: 'resting' }, resting.until);
    const { userId, agent } = guide;
    const pool = this.deps.pool;
    if (!pool) return this.finish(question, { state: 'failed' });
    const leased = await pool.leaseForUser('claude', userId, {
      ...(agent.orgId ? { orgId: agent.orgId } : {}),
      model: PUBLIC_GUIDE_MODEL,
      ...(agent.seatId ? { seatId: agent.seatId } : {}),
    }).catch(() => null);
    if (!leased || leased.kind !== 'dedicated') {
      if (leased?.kind === 'dedicated_exhausted') {
        this.rest(leased.resetAt ?? null);
        return this.finish(question, { state: 'resting' }, leased.resetAt ?? null);
      }
      return this.finish(question, { state: 'resting' }, null);
    }
    const lease = leased.lease;
    let outcome: PlatformCredentialLeaseOutcome = { kind: 'error' };
    try {
      if (lease.credentialId.startsWith(SEAT_LEASE_PREFIX) && this.deps.seats) {
        const seat = await this.deps.seats.getSeat(lease.credentialId.slice(SEAT_LEASE_PREFIX.length)).catch(() => null);
        const full = seat ? seatTooFullForPublic(seat, this.now()) : null;
        if (full) {
          outcome = { kind: 'ok' };
          this.rest(full.until);
          return await this.finish(question, { state: 'resting' }, full.until);
        }
      }
      // Waking: the first exec wakes a sleeping machine; say so if it takes a moment.
      const waking = setTimeout(() => { if (question.record.state === 'queued') this.setState(question, 'waking'); }, 2_500);
      let sandboxId: string | null = null;
      let source: GuideSource | null = null;
      const client = this.deps.sandboxClient();
      try {
        sandboxId = await this.deps.host.guideSandbox(userId, agent.id);
        source = sandboxId ? await this.deps.host.guideSource(userId, agent) : null;
        if (!sandboxId || !source) return await this.finish(question, { state: 'failed' });
        const setup = await client.execSync(sandboxId, buildGuideSetupCommand(source), undefined, {
          timeoutMs: 360_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
        });
        if (setup.exitCode !== 0 || setup.timedOut) {
          console.warn(`[public-guide] setup failed on ${sandboxId}: ${setup.stderr?.slice(-300) || `exit ${setup.exitCode}`}`);
          return await this.finish(question, { state: 'failed' });
        }
      } finally {
        clearTimeout(waking);
      }
      this.setState(question, 'reading');
      const visit = await this.deps.storage.getVisit(question.visitId);
      const earlier = (visit?.questions ?? []).filter((q) => q.questionId !== question.record.questionId && (q.state === 'answered' || q.state === 'declined'));
      const sessionId = visit ? visit.claudeSessionId : undefined;
      let run = await this.runTurn(client, sandboxId, question, lease.token, {
        prompt: buildVisitorPrompt(question.record.question),
        ...(sessionId ? { resumeSessionId: sessionId } : { sessionId: randomUUID() }),
      });
      // A conversation the machine lost (a rebuilt root filesystem): start a fresh
      // one carrying the visit's earlier exchange, once.
      if (sessionId && run.missingSession) {
        const context = earlier.map((q) => `Earlier the visitor asked: ${q.question}\nYou answered: ${q.answer ?? PUBLIC_GUIDE_DECLINED_TEXT}`).join('\n\n');
        run = await this.runTurn(client, sandboxId, question, lease.token, {
          prompt: `${context ? `${context}\n\n` : ''}${buildVisitorPrompt(question.record.question)}`,
          sessionId: randomUUID(),
        });
      }
      const { reading } = run;
      if (reading.sessionId && visit) {
        const fresh = await this.deps.storage.getVisit(question.visitId);
        if (fresh) {
          fresh.claudeSessionId = reading.sessionId;
          await this.deps.storage.putVisit(fresh);
        }
      }
      const failure = run.timedOut ? 'timed out' : reading.isError || run.exitCode !== 0 ? (reading.errorText ?? run.stderr ?? 'failed') : null;
      if (failure) {
        if (isClaudeUsageLimitText(failure)) {
          const resetSeconds = claudeUsageLimitResetAtSeconds(failure);
          const until = resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null;
          outcome = { kind: 'rate_limited', model: PUBLIC_GUIDE_MODEL, ...(resetSeconds ? { retryAfterSeconds: Math.max(60, Math.round(resetSeconds - this.now() / 1000)) } : {}) };
          this.rest(until);
          return await this.finish(question, { state: 'resting', files: reading.files }, until);
        }
        console.warn(`[public-guide] turn failed: ${String(failure).slice(0, 300)}`);
        return await this.finish(question, { state: 'failed', files: reading.files });
      }
      outcome = { kind: 'ok' };
      const usage = {
        files: reading.files,
        ...(reading.costUsd !== undefined ? { costUsd: reading.costUsd } : {}),
        ...(reading.tokens ? { tokens: reading.tokens } : {}),
      };
      const answer = (reading.answer ?? '').trim();
      if (!answer || answer.startsWith(PUBLIC_GUIDE_DECLINED_MARKER)) {
        return await this.finish(question, { state: 'declined', answer: PUBLIC_GUIDE_DECLINED_TEXT, ...usage });
      }
      const leak = guideAnswerLeak(answer);
      if (leak) {
        // Kept for the founder to read, never shown to the visitor.
        return await this.finish(question, { state: 'declined', answer, flag: `The outgoing check held this answer back (${leak}).`, ...usage });
      }
      return await this.finish(question, { state: 'answered', answer, ...usage });
    } finally {
      await pool.releaseCredential(lease.credentialId, outcome).catch(() => undefined);
    }
  }

  private async runTurn(
    client: WorkspaceRuntimeClient,
    sandboxId: string,
    question: LiveQuestion,
    token: string,
    turn: { prompt: string; sessionId?: string; resumeSessionId?: string },
  ): Promise<{ reading: ReturnType<typeof readGuideStream>; exitCode: number; timedOut: boolean; stderr?: string; missingSession: boolean }> {
    const stream = `${GUIDE_VISIT_STREAM_DIR}/${question.record.questionId}.jsonl`;
    const credentialFile = `${GUIDE_VISIT_STREAM_DIR}/${question.record.questionId}.credential`;
    // The credential never rides an argument when the client can upload: a
    // 0600 file in the agent's own home, read and removed by the launch.
    const uploaded = client.uploadToSandbox
      ? await client.uploadToSandbox(sandboxId, [{ path: credentialFile, content: Buffer.from(token), mode: 0o600 }], { sshUser: DEFAULT_DEVELOPMENT_SSH_USER }).then(() => true, () => false)
      : false;
    const seconds = Math.round(this.limits.turnTimeoutMs / 1000);
    const launch = buildSealedClaudeCommand({
      prompt: turn.prompt,
      ...(uploaded ? {} : { oauthToken: token }),
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.resumeSessionId ? { resumeSessionId: turn.resumeSessionId } : {}),
    }).replace('sudo -n ', `timeout -k 5 ${seconds} sudo -n `);
    const command = [
      'set -o pipefail',
      ...(uploaded ? [
        `${CLAUDE_OAUTH_TOKEN_ENV}="$(cat ${quoteShellArg(credentialFile)})"`,
        `rm -f ${quoteShellArg(credentialFile)}`,
        `export ${CLAUDE_OAUTH_TOKEN_ENV}`,
      ] : []),
      `${launch} | tee ${quoteShellArg(stream)}`,
      '__status=$?',
      `rm -f ${quoteShellArg(stream)}`,
      'exit $__status',
    ].join('\n');
    // The files arrive in the margin while it reads: the stream file, re-read every two seconds.
    let watching = true;
    let wake: () => void = () => {};
    const watcher = (async () => {
      while (watching) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        if (!watching) break;
        const peek = await client.execSync(sandboxId, `cat ${quoteShellArg(stream)} 2>/dev/null || true`, undefined, {
          timeoutMs: 15_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
        }).catch(() => null);
        if (peek?.stdout && watching) question.record.files = readGuideStream(peek.stdout).files;
      }
    })();
    try {
      const result = await client.execSync(sandboxId, command, undefined, {
        timeoutMs: this.limits.turnTimeoutMs + 20_000, sshUser: DEFAULT_DEVELOPMENT_SSH_USER,
      });
      const reading = readGuideStream(result.stdout ?? '');
      question.record.files = reading.files;
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
  }

  /** The Visits list on the guide's screen (owner only; the route checks). */
  async listVisits(agentId: string): Promise<WorkspacePublicGuideVisitsAnswer> {
    const visits = await this.deps.storage.listVisits(agentId, 500);
    return {
      keptDays: PUBLIC_GUIDE_LIMITS.transcriptDays,
      visits: visits.filter((v) => v.questions.length > 0).map((v) => ({
        visitId: v.visitId,
        startedAt: v.startedAt,
        firstQuestion: v.questions[0]!.question,
        questions: v.questions.length,
        flagged: v.questions.some((q) => Boolean(q.flag)),
      })),
    };
  }

  async getVisit(agentId: string, visitId: string): Promise<PublicGuideVisitRecord | null> {
    const visit = await this.deps.storage.getVisit(visitId);
    if (!visit || visit.agentId !== agentId) return null;
    const { claudeSessionId: _session, ...shown } = visit;
    return shown;
  }
}
