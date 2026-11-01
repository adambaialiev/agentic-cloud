import type { OrgStorage } from './org-storage.js';
import type { OrgSeatProvider } from '../types/org.js';
import {
  buildClaudeAuthorizeRequest,
  exchangeClaudeAuthorizationCode,
  readClaudeUsageWithProfileToken,
  type ClaudeSeatGrant,
} from '../agent/claude/claude-usage.js';
import {
  buildCodexAuthJson,
  CODEX_DEVICE_VERIFICATION_URL,
  exchangeCodexDeviceAuthorization,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
  type CodexDeviceCode,
} from '../agent/codex/codex-device-login.js';
import { readCodexUsageForAuthJson } from '../agent/codex/codex-usage.js';
import { checkOpenCodeKey, OPENCODE_KEYS_URL, plausibleOpenCodeKey } from '../agent/opencode/opencode-key.js';
import { addMemberSeat } from './org-seat-signin.js';
import type { SeatSignInDocument, SeatSignInStorage } from './seat-signin-storage.js';

/**
 * The Workspace seat sign-in flow (org-layer-design workstream 2, Mini App
 * surface). Two provider ceremonies under one state machine, and since
 * 2026-09-22 neither of them touches a machine — the backend is the OAuth
 * client for both, speaking each provider's own public login:
 *
 *  - **Claude — a link and a paste.** The backend builds the authorize URL
 *    (PKCE held server-side), the member approves on claude.ai and pastes the
 *    code back, and the backend exchanges it for a grant whose access token
 *    is profile-scoped — one credential that runs turns AND reads the full
 *    usage picture. This replaced the `claude setup-token` tmux ceremony
 *    (2026-08-23): the setup-token was inference-only, which is why seats
 *    could never show per-model windows or usage credits.
 *  - **Codex — a one-time code.** The backend asks OpenAI for a device code,
 *    the member types it on OpenAI's page and approves, and the screen's own
 *    poll collects the login (`codex-device-login.ts`). This replaced
 *    `codex login --device-auth` in a tmux pane on one of the member's
 *    machines, which made a first ChatGPT sign-in wait for a machine to be
 *    built, held that machine awake through the idle reaper, and read the
 *    code off a 500-column pane. The requests are the CLI's own.
 *
 *  - **OpenCode — a key and a paste (note #780).** Nothing to mint: the
 *    member makes an API key in the OpenCode console and pastes it, and the
 *    backend checks it against OpenCode before it becomes a seat. The same
 *    `awaiting_code` step as Claude's, with the key as the code.
 *
 * Shared rules: one sign-in per member at a time, keyed by userId — starting
 * a new one replaces the old. Polling IS the engine: nothing runs between
 * the screen's requests.
 *
 * **A Codex ceremony outlives a restart; a Claude mint does not.** The
 * member approves a device code on OpenAI's page, where nothing of ours can
 * see them — so a deploy that forgot the ceremony would spend their approval
 * on nothing, with the screen still saying "this screen notices on its own".
 * That happened (on the machine-run ceremony) on 2026-09-06, 65 seconds after
 * an unrelated deploy. So a pending Codex ceremony is written down
 * (SeatSignInStorage) and picked up again by the next process, under the
 * provider's own 15-minute code lifetime. The Claude mint's paste comes back
 * to us; a restart costs its member one tap, and its PKCE verifier is not
 * something to write down.
 */

/** The ceremony expires with the provider's own code lifetime (codex says 15 minutes). */
const SIGNIN_MAX_AGE_MS = 15 * 60_000;
/** An OpenCode key has no lifetime of its own; making one in the console is the slow part. */
const OPENCODE_SIGNIN_MAX_AGE_MS = 60 * 60_000;

export type SeatSignInPhase =
  | { phase: 'starting' }
  /** Claude: the URL is up; the member opens it and pastes the code back. */
  | { phase: 'awaiting_code'; url: string; note?: string }
  /** Codex: the URL + one-time code are up; the poll notices the approval. */
  | { phase: 'awaiting_approval'; url: string; userCode?: string }
  /** The token is being exchanged and live-verified. */
  | { phase: 'verifying' }
  | { phase: 'done'; seatId: string; label: string; attention?: 'payment_required' }
  | { phase: 'failed'; reason: string };

export interface SeatSignInStatus {
  provider: OrgSeatProvider;
  startedAt: string;
  state: SeatSignInPhase;
}

interface SignInSession {
  userId: string;
  /** Pinned at start so switching Workspace mid-ceremony cannot move the seat. */
  orgId: string;
  provider: OrgSeatProvider;
  startedAt: number;
  state: SeatSignInPhase;
  /** Claude only — the PKCE pair the pasted code will be exchanged against. */
  pkce?: { verifier: string; state: string };
  /** Codex only, until approved — the device login the poll asks OpenAI about. */
  device?: CodexDeviceCode;
  /** Epoch ms; OpenAI names the interval, the screen polls faster than it. */
  nextDevicePollAt?: number;
  /** Serializes the approval check: a second poll while one is out just re-reads state. */
  inFlight?: Promise<void>;
}

export class OrgSeatSignInFlow {
  private sessions = new Map<string, SignInSession>();
  private restoring?: Promise<void>;

  constructor(private readonly deps: {
    orgStorage: OrgStorage;
    /**
     * Where a pending Codex ceremony is written down so it survives a
     * deploy. Absent on backends without durable storage: the flow then
     * lives in memory and is lost on restart.
     */
    seatSignInStorage?: SeatSignInStorage;
    /**
     * A seat just landed: bring the member's waiting agents of that provider
     * online. Sign-in is Mini-App-only, so this hook is what closes the loop
     * — without it a first agent would sit unconnected after a perfect
     * sign-in. Best-effort: the seat is stored either way.
     */
    onSeatAdded?: (userId: string, provider: OrgSeatProvider, orgId: string) => Promise<void>;
    /** Tests only — both providers' login and verify calls. */
    fetchImpl?: typeof fetch;
  }) {}

  /**
   * Bring back the Codex ceremonies that were outstanding when the previous
   * process stopped. Idempotent, and safe to call from anywhere: the first
   * caller starts the read and everyone else rides it. Every public entry
   * point awaits it, so a poll never answers "no sign-in here" for a
   * ceremony that is merely still being read back.
   */
  restore(): Promise<void> {
    this.restoring ??= this.loadOutstanding();
    return this.restoring;
  }

  private async loadOutstanding(): Promise<void> {
    const storage = this.deps.seatSignInStorage;
    if (!storage) return;
    const docs = await storage.listAll().catch((error) => {
      console.error('[seat-signin-flow] could not read outstanding sign-ins;'
        + ' a ceremony spanning this restart is lost:', error);
      return [] as SeatSignInDocument[];
    });
    const now = Date.now();
    for (const doc of docs) {
      // Past the provider's own code lifetime there is nothing left to
      // resume, and a finished ceremony has no business coming back at all.
      // A record without a device login is a machine-run ceremony from
      // before 2026-09-22: its CLI is on a machine this code no longer
      // drives, so the member's screen says to start again.
      if (now - doc.startedAt > SIGNIN_MAX_AGE_MS
        || doc.state.phase !== 'awaiting_approval' || !doc.device) {
        await storage.delete(doc.userId).catch(() => {});
        continue;
      }
      this.sessions.set(doc.userId, {
        userId: doc.userId,
        orgId: doc.orgId,
        provider: doc.provider,
        startedAt: doc.startedAt,
        state: doc.state,
        device: doc.device,
      });
      console.info(`[seat-signin-flow] resumed ${doc.provider} sign-in for ${doc.userId}`);
    }
  }

  /**
   * Write a pending Codex ceremony down, or take it off the record. Called
   * wherever its state has settled for now.
   *
   * Never throws: a member's sign-in must not fail over its own bookkeeping.
   * A write that did not land costs the ceremony its restart-survival, which
   * is the Claude mint's behaviour anyway.
   */
  private async remember(session: SignInSession): Promise<void> {
    const storage = this.deps.seatSignInStorage;
    if (!storage || session.provider !== 'codex') return;
    try {
      if (!session.device || session.state.phase !== 'awaiting_approval') {
        await storage.delete(session.userId);
        return;
      }
      await storage.save({
        userId: session.userId,
        orgId: session.orgId,
        provider: session.provider,
        startedAt: session.startedAt,
        state: session.state,
        device: session.device,
      });
    } catch (error) {
      console.warn(`[seat-signin-flow] could not record the ceremony for ${session.userId}:`, error);
    }
  }

  /** Answer, having first written down what we are answering. */
  private async settle(session: SignInSession): Promise<SeatSignInStatus> {
    await this.remember(session);
    return this.describe(session);
  }

  /**
   * Start (or restart) the member's sign-in. Any previous attempt — theirs,
   * finished or abandoned — is forgotten first, so at most one ceremony runs
   * per member. Either provider is awaiting the member before this returns.
   */
  async start(args: {
    userId: string;
    orgId: string;
    provider: OrgSeatProvider;
  }): Promise<SeatSignInStatus> {
    const { userId, orgId, provider } = args;
    // A ceremony restored from the last process is still "theirs": replacing
    // it must not let the restore land it back afterwards.
    await this.restore();
    if (this.sessions.delete(userId)) {
      await this.deps.seatSignInStorage?.delete(userId).catch(() => {});
    }

    if (provider === 'opencode') {
      const session: SignInSession = {
        userId,
        orgId,
        provider,
        startedAt: Date.now(),
        state: { phase: 'awaiting_code', url: OPENCODE_KEYS_URL },
      };
      this.sessions.set(userId, session);
      return this.describe(session);
    }

    if (provider === 'claude') {
      const authorize = buildClaudeAuthorizeRequest();
      const session: SignInSession = {
        userId,
        orgId,
        provider,
        startedAt: Date.now(),
        pkce: { verifier: authorize.verifier, state: authorize.state },
        state: { phase: 'awaiting_code', url: authorize.url },
      };
      this.sessions.set(userId, session);
      return this.describe(session);
    }

    const session: SignInSession = { userId, orgId, provider, startedAt: Date.now(), state: { phase: 'starting' } };
    this.sessions.set(userId, session);
    const requested = await requestCodexDeviceCode(this.deps.fetchImpl);
    // Replaced while OpenAI was answering: the newer attempt owns the member.
    if (this.sessions.get(userId) !== session) return this.describe(session);
    if (requested.kind !== 'ok') {
      console.warn(`[seat-signin-flow] codex device code for ${userId} failed: ${requested.reason}`);
      session.state = { phase: 'failed', reason: 'ChatGPT’s sign-in service didn’t answer — try again in a moment.' };
      return this.settle(session);
    }
    session.device = requested.device;
    session.nextDevicePollAt = Date.now() + requested.device.intervalSeconds * 1000;
    session.state = {
      phase: 'awaiting_approval',
      url: CODEX_DEVICE_VERIFICATION_URL,
      userCode: requested.device.userCode,
    };
    return this.settle(session);
  }

  /**
   * The screen's poll: advance once if there is anything to ask, answer.
   * Null = nothing running in this Workspace context. The optional org guard
   * matters once a human belongs to several orgs: a ceremony stays resumable
   * where it began, but never appears on another org's seats screen claiming
   * it will land there. Legacy callers without a context still see the
   * user's one session.
   */
  async poll(userId: string, orgId?: string): Promise<SeatSignInStatus | null> {
    await this.restore();
    const session = this.sessions.get(userId);
    if (!session || (orgId && session.orgId !== orgId)) return null;

    if (this.isTerminal(session)) return this.describe(session);
    if (session.provider === 'opencode') {
      if (Date.now() - session.startedAt > OPENCODE_SIGNIN_MAX_AGE_MS) {
        this.fail(session, 'This sign-in waited a long time — start it again and paste your key.');
      }
      return this.describe(session);
    }
    if (Date.now() - session.startedAt > SIGNIN_MAX_AGE_MS) {
      this.fail(session, 'The sign-in expired — codes only live a few minutes. Start it again.');
      return this.settle(session);
    }

    // Only a Codex device login has anything to ask between the member's own
    // actions — and only as often as OpenAI's interval allows.
    if (!session.device) return this.describe(session);
    if (!session.inFlight && Date.now() >= (session.nextDevicePollAt ?? 0)) {
      session.inFlight = this.advanceCodex(session)
        .catch((error) => {
          console.warn(`[seat-signin-flow] poll failed for ${userId}:`, error);
        })
        .finally(() => { session.inFlight = undefined; });
    }
    await session.inFlight;
    return this.settle(session);
  }

  /** Claude only: exchange the member's pasted code for the seat's grant. */
  async submitCode(userId: string, rawCode: string, orgId?: string): Promise<SeatSignInStatus | null> {
    await this.restore();
    const session = this.sessions.get(userId);
    if (!session || (orgId && session.orgId !== orgId)) return null;
    const code = rawCode.trim();
    if (session.provider === 'opencode' && session.state.phase === 'awaiting_code') {
      await this.storeOpenCodeSeat(session, code);
      return this.describe(session);
    }
    if (session.provider !== 'claude' || session.state.phase !== 'awaiting_code' || !code || !session.pkce) {
      return this.describe(session);
    }
    session.state = { phase: 'verifying' };
    const exchanged = await exchangeClaudeAuthorizationCode(code, session.pkce, this.deps.fetchImpl);
    if (exchanged.kind !== 'ok') {
      // The code is single-use either way, so retrying means a FRESH
      // authorize page — same reason the CLI's own retry mints a new URL.
      const authorize = buildClaudeAuthorizeRequest();
      session.pkce = { verifier: authorize.verifier, state: authorize.state };
      session.state = {
        phase: 'awaiting_code',
        url: authorize.url,
        note: exchanged.kind === 'rejected'
          ? 'That code didn\'t work — open the link again and paste the whole code, including the # and everything after it.'
          : 'The sign-in service didn\'t answer — open the link again and paste a fresh code.',
      };
      return this.describe(session);
    }
    await this.storeClaudeSeat(session, exchanged.grant);
    return this.describe(session);
  }

  /**
   * Verify the grant actually reads usage (which also proves it
   * authenticates at all), then land the seat WITH its first usage snapshot
   * — the seats screen shows real meters from the first paint.
   */
  private async storeClaudeSeat(session: SignInSession, grant: ClaudeSeatGrant): Promise<void> {
    const read = await readClaudeUsageWithProfileToken(grant.accessToken, this.deps.fetchImpl);
    if (read.kind === 'auth_rejected') {
      this.fail(session, 'The sign-in finished but the credential failed its live check — start again.');
      return;
    }
    const stored = await addMemberSeat({
      orgStorage: this.deps.orgStorage,
      userId: session.userId,
      orgId: session.orgId,
      provider: 'claude',
      token: grant.accessToken,
      oauth: {
        refreshToken: grant.refreshToken,
        ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        ...(grant.scopes ? { scopes: grant.scopes } : {}),
      },
      ...(read.kind === 'payment_required'
        ? {
          status: 'payment_required' as const,
          subscriptionStatus: read.subscriptionStatus,
          subscriptionStatusReadAt: new Date().toISOString(),
          ...(read.plan.planType
            ? {
              usage: {
                windows: {},
                capturedAt: read.plan.planReadAt ?? new Date().toISOString(),
                ...read.plan,
              },
            }
            : {}),
        }
        : {}),
      // A transient usage failure must not fail a sign-in that already
      // minted a working grant — the 5-minute refresher fills this in.
      ...(read.kind === 'ok'
        ? {
          usage: read.usage.snapshot,
          modelWindows: read.usage.modelWindows,
        }
        : {}),
    }).catch(() => null);
    if (!stored || stored.outcome !== 'added') {
      this.fail(session, 'The sign-in completed but could not be saved — try again.');
      return;
    }
    console.info(`[seat-signin-flow] claude seat ${stored.seat.seatId} added for ${session.userId} via Workspace (grant mint)`
      + (stored.replacedDeadSeats ? ` (replaced ${stored.replacedDeadSeats} dead)` : ''));
    // The grant is saved either way, but a billing-paused seat cannot wake an
    // agent. The next confirmed active+inference probe is the recovery edge.
    if (read.kind !== 'payment_required') {
      await this.deps.onSeatAdded?.(session.userId, 'claude', session.orgId).catch((error) => {
        console.error(`[seat-signin-flow] onSeatAdded failed for ${session.userId}:`, error);
      });
    }
    session.state = {
      phase: 'done',
      seatId: stored.seat.seatId,
      label: stored.seat.label,
      ...(read.kind === 'payment_required' ? { attention: 'payment_required' as const } : {}),
    };
  }

  /**
   * OpenCode: the pasted key IS the credential. Checked live first, so a key
   * mistyped or deleted in the console never becomes a seat; a check OpenCode
   * did not answer leaves the paste box up with a note rather than storing a
   * key nobody verified.
   */
  private async storeOpenCodeSeat(session: SignInSession, raw: string): Promise<void> {
    const key = plausibleOpenCodeKey(raw);
    if (!key) {
      session.state = {
        phase: 'awaiting_code',
        url: OPENCODE_KEYS_URL,
        note: 'That doesn\'t look like an OpenCode key — copy the whole key from the OpenCode console and paste it again.',
      };
      return;
    }
    session.state = { phase: 'verifying' };
    const checked = await checkOpenCodeKey(key, this.deps.fetchImpl);
    if (checked.kind !== 'ok') {
      if (checked.kind === 'unavailable') {
        console.warn(`[seat-signin-flow] opencode key check for ${session.userId} did not answer: ${checked.reason}`);
      }
      session.state = {
        phase: 'awaiting_code',
        url: OPENCODE_KEYS_URL,
        note: checked.kind === 'rejected'
          ? 'OpenCode didn\'t accept that key — check it in the OpenCode console, or make a new one, and paste it again.'
          : 'OpenCode didn\'t answer just now — paste the key again in a moment.',
      };
      return;
    }
    const stored = await addMemberSeat({
      orgStorage: this.deps.orgStorage,
      userId: session.userId,
      orgId: session.orgId,
      provider: 'opencode',
      token: key,
    }).catch(() => null);
    if (!stored || stored.outcome !== 'added') {
      this.fail(session, 'The key worked but could not be saved — try again.');
      return;
    }
    console.info(`[seat-signin-flow] opencode seat ${stored.seat.seatId} added for ${session.userId} via Workspace (key)`
      + (stored.replacedDeadSeats ? ` (replaced ${stored.replacedDeadSeats} dead)` : ''));
    await this.deps.onSeatAdded?.(session.userId, 'opencode', session.orgId).catch((error) => {
      console.error(`[seat-signin-flow] onSeatAdded failed for ${session.userId}:`, error);
    });
    session.state = { phase: 'done', seatId: stored.seat.seatId, label: stored.seat.label };
  }

  /** The screen's Cancel (or leaving a failed attempt): forget the session. */
  async cancel(userId: string, orgId?: string): Promise<void> {
    await this.restore();
    const session = this.sessions.get(userId);
    if (!session || (orgId && session.orgId !== orgId)) return;
    this.sessions.delete(userId);
    await this.deps.seatSignInStorage?.delete(userId).catch(() => {});
  }

  /** Ask OpenAI once whether the member has approved; land the seat if so. */
  private async advanceCodex(session: SignInSession): Promise<void> {
    const device = session.device;
    if (!device) return;
    session.nextDevicePollAt = Date.now() + device.intervalSeconds * 1000;
    const polled = await pollCodexDeviceCode(device, this.deps.fetchImpl);
    if (polled.kind === 'pending') return;
    if (polled.kind === 'failed') {
      // A blip on OpenAI's side or ours; the next poll asks again.
      console.warn(`[seat-signin-flow] codex approval check for ${session.userId} failed: ${polled.reason}`);
      return;
    }
    if (polled.kind === 'rejected') {
      console.warn(`[seat-signin-flow] codex device login for ${session.userId} refused: HTTP ${polled.status}`);
      this.fail(session, 'ChatGPT didn’t accept this sign-in — start it again for a fresh code.');
      return;
    }

    // Approved. The code is single-use: take it off the record before
    // spending it, so a restart mid-exchange cannot ask OpenAI a second time.
    session.device = undefined;
    session.state = { phase: 'verifying' };
    await this.remember(session);
    const exchanged = await exchangeCodexDeviceAuthorization(polled, this.deps.fetchImpl);
    if (exchanged.kind !== 'ok') {
      console.warn(`[seat-signin-flow] codex token exchange for ${session.userId} failed: ${exchanged.reason}`);
      this.fail(session, 'ChatGPT approved the sign-in but didn’t hand it over — start it again.');
      return;
    }
    await this.storeCodexSeat(session, buildCodexAuthJson(exchanged.tokens));
  }

  /**
   * Verify the login reads usage (which proves it authenticates, as the
   * Claude mint's check does), then land the seat with that first reading.
   */
  private async storeCodexSeat(session: SignInSession, authJson: string): Promise<void> {
    const read = await readCodexUsageForAuthJson(authJson, this.deps.fetchImpl);
    if (read.kind === 'auth_rejected') {
      this.fail(session, 'The sign-in finished but the credential failed its live check — start again.');
      return;
    }
    const stored = await addMemberSeat({
      orgStorage: this.deps.orgStorage,
      userId: session.userId,
      orgId: session.orgId,
      provider: 'codex',
      token: authJson,
      // A transient usage failure must not fail a working login — the
      // refresher fills the meters in.
      ...(read.kind === 'ok' ? { usage: read.snapshot } : {}),
    }).catch(() => null);
    if (!stored || stored.outcome !== 'added') {
      this.fail(session, 'The sign-in completed but could not be saved — try again.');
      return;
    }
    console.info(`[seat-signin-flow] codex seat ${stored.seat.seatId} added for ${session.userId} via Workspace (device mint)`
      + (stored.replacedDeadSeats ? ` (replaced ${stored.replacedDeadSeats} dead)` : ''));
    await this.deps.onSeatAdded?.(session.userId, 'codex', session.orgId).catch((error) => {
      console.error(`[seat-signin-flow] onSeatAdded failed for ${session.userId}:`, error);
    });
    session.state = { phase: 'done', seatId: stored.seat.seatId, label: stored.seat.label };
  }

  private fail(session: SignInSession, reason: string): void {
    session.device = undefined;
    session.state = { phase: 'failed', reason };
  }

  private isTerminal(session: SignInSession): boolean {
    return session.state.phase === 'done' || session.state.phase === 'failed';
  }

  private describe(session: SignInSession): SeatSignInStatus {
    return {
      provider: session.provider,
      startedAt: new Date(session.startedAt).toISOString(),
      state: session.state,
    };
  }
}
