/**
 * Pool of platform-owned CLI subscription credentials (Claude setup-tokens).
 *
 * Two kinds of credential live here. A credential with an `ownerUserId` is
 * DEDICATED: a subscription the operator bought for that one user, serving
 * their turns exclusively (leaseForUser). Everything else is the shared pool,
 * which now exists to serve LIMBO — the short stretch between a user paying
 * and the operator attaching their dedicated credential (or replacing one
 * that died). Each turn leases the healthiest eligible credential, runs on
 * it, and reports back. Design constraints, in order:
 *
 *  1. A dead credential (revoked/banned) must drop out of rotation instead of
 *     failing user turns — the pool degrades, it doesn't break.
 *  2. A rate-limited credential cools down and auto-restores; utilization
 *     from the header probe spreads load before limits are hit.
 *  3. Selection is cheap and runs on the turn's critical path; usage refresh
 *     is periodic and off it.
 *
 * Tokens live in the top-level `platformCredentials` collection, outside
 * `users/*`, so user-scoped reads can never touch them.
 */

import type {
  PlatformCredentialDocument,
  PlatformCredentialLease,
  PlatformCredentialLeaseOutcome,
  PlatformCredentialProvider,
  PlatformCredentialReleaseExtras,
  PlatformUserLease,
} from '../types/platform-credential.js';
import type { OrgSeatCredentialSource } from './org-seat-credentials.js';
import {
  CLAUDE_PAYMENT_REQUIRED_STATUSES,
  readClaudeProfileWithProfileToken,
  readClaudeUsageForToken,
  readClaudeUsageWithProfileToken,
  refreshClaudeOAuthToken,
  type ClaudeAccountUsage,
  type ClaudeProfileFacts,
  type ClaudePlanFields,
} from '../agent/claude/claude-usage.js';
import { readCodexUsageForAuthJson } from '../agent/codex/codex-usage.js';

export const PLATFORM_CREDENTIALS_COLLECTION = 'platformCredentials';
/** The scheduled probe cadence, and therefore the age at which a Workspace
 *  read may ask for a fresh provider snapshot itself. */
export const PLATFORM_CREDENTIAL_USAGE_REFRESH_MS = 5 * 60_000;

/** Rate-limited with no better signal: the honest retry horizon is half an hour. */
export const DEFAULT_COOLDOWN_SECONDS = 30 * 60;
/** Consecutive auth failures before a credential is declared dead. */
export const AUTH_FAILURE_DEATH_THRESHOLD = 2;
/**
 * Selection weight of one in-flight turn, in utilization points: prefer an
 * idle credential at 65% over one at 50% already running two turns.
 */
const IN_FLIGHT_UTILIZATION_WEIGHT = 10;
/** Utilization assumed for credentials that have never been probed. */
const UNKNOWN_UTILIZATION = 50;
/** Refresh a grant seat's token at lease time when it has less life than this. */
const SEAT_TOKEN_LEASE_MARGIN_MS = 15 * 60_000;

export interface PlatformCredentialPool {
  listCredentials(provider: PlatformCredentialProvider): Promise<PlatformCredentialDocument[]>;
  addCredential(args: {
    provider: PlatformCredentialProvider;
    token: string;
    label: string;
  }): Promise<PlatformCredentialDocument>;
  /**
   * Pick the healthiest credential and mark one turn in flight on it.
   * `null` when the pool has no leasable credential (empty, or everything
   * dead/disabled/cooling down). A leasable `preferredCredentialId` wins over
   * scoring — Codex machines stay pinned to the credential whose auth.json
   * they hold, so in-place token refreshes don't churn across the fleet.
   */
  leaseCredential(
    provider: PlatformCredentialProvider,
    opts?: {
      preferredCredentialId?: string;
      /** Catalog alias the turn will run — skips credentials whose cooldown is scoped to it. */
      model?: string;
    },
  ): Promise<PlatformCredentialLease | null>;
  /**
   * Return a leased credential with the turn's outcome; updates health state.
   * Extras carry fresh usage and refreshed secret material observed after the
   * turn (Codex writes both).
   */
  releaseCredential(
    credentialId: string,
    outcome: PlatformCredentialLeaseOutcome,
    extras?: PlatformCredentialReleaseExtras,
  ): Promise<void>;
  /**
   * The lease for a USER's turn — the pool's whole policy in one call.
   *
   * An org member's SEATS come first (org-layer-design): they resolve
   * exactly like owned credentials — selected seat first, falling back only
   * among the member's own — and a member never rides limbo, whatever the
   * state of their seats. Everyone else:
   *
   * A user with a live owned credential is DEDICATED: they lease exactly that
   * credential, and when it (or the requested model's window on it) is cooling
   * down the answer is `dedicated_exhausted` — the harness tells them when
   * their subscription resets, and never quietly moves them onto shared
   * capacity. A user with no live owned credential is in LIMBO (their
   * dedicated subscription hasn't been bought yet, or theirs died) and leases
   * from the unowned pool like before.
   */
  leaseForUser(
    provider: PlatformCredentialProvider,
    userId: string,
    opts?: {
      model?: string;
      /** Immutable org of the agent taking the turn. */
      orgId?: string | null;
      /** Machine stickiness for the LIMBO path only (Codex auth.json pinning); a member's seats ignore it. */
      preferredCredentialId?: string;
      /** The agent's own seat override (note #129) — that seat leases first, over the org's selection. */
      seatId?: string;
    },
  ): Promise<PlatformUserLease>;
  /**
   * Dedicate a credential to one user, or return it to the pool with `null`.
   * Exclusive per (provider, user) the same way the routing pin is per
   * provider: setting an owner clears that owner from any other credential in
   * the same write, so "which credential is this user's" has one answer.
   *
   * Returns the label of the credential touched, null when it doesn't exist.
   */
  setOwner(
    provider: PlatformCredentialProvider,
    credentialId: string,
    ownerUserId: string | null,
  ): Promise<{ label: string } | null>;
  /**
   * Point routing at one credential, or back at the scorer with `null`.
   * Exclusive by construction: setting a pin clears every other credential's,
   * so there is exactly one answer to "where are requests going".
   *
   * Returns the label pinned (null when cleared), so a caller can say what
   * happened without re-reading the pool.
   */
  setRoutingPin(
    provider: PlatformCredentialProvider,
    credentialId: string | null,
  ): Promise<{ label: string } | null>;
  /** Probe usage for every live credential; also expires stale cooldowns. */
  refreshUsage(fetchImpl?: typeof fetch): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Cooldown counts as expired the moment `cooldownUntil` is in the past. A
 * lease that names its model is additionally blocked by an unexpired
 * model-scoped cooldown for that model; a lease with no model ignores the
 * scoped map (we can't know which model the turn will run).
 */
export function isLeasable(doc: PlatformCredentialDocument, now = nowIso(), model?: string): boolean {
  if (model !== undefined) {
    const scopedUntil = doc.modelCooldowns?.[model];
    if (scopedUntil && scopedUntil > now) return false;
  }
  if (doc.status === 'active') return true;
  if (doc.status === 'cooldown') {
    return !doc.cooldownUntil || doc.cooldownUntil <= now;
  }
  return false;
}

/**
 * Unified-window utilization at/above which a usage-limit trip is treated as
 * account-wide rather than model-scoped. Below this, the unified windows
 * can't explain the trip — a per-model window must have filled first.
 */
export const GLOBAL_EXHAUSTION_PERCENT = 90;

/** Window ids the header probe reports account-wide (no per-model split). */
const UNIFIED_WINDOW_IDS = ['five_hour', 'seven_day'];

/**
 * Whether the last-probed unified windows say the whole account is (close to)
 * exhausted. No snapshot, or no unified windows in it, reads as exhausted —
 * with no evidence of headroom, a model-scoped bench would risk failing more
 * user turns on the same credential.
 */
function unifiedNearExhaustion(doc: PlatformCredentialDocument): boolean {
  const windows = doc.usage?.windows;
  if (!windows) return true;
  const unified = UNIFIED_WINDOW_IDS
    .map((id) => windows[id]?.usedPercent)
    .filter((percent): percent is number => typeof percent === 'number');
  if (unified.length === 0) return true;
  return Math.max(...unified) >= GLOBAL_EXHAUSTION_PERCENT;
}

function maxUtilization(doc: PlatformCredentialDocument): number {
  const windows = doc.usage?.windows;
  if (!windows) return UNKNOWN_UTILIZATION;
  const values = Object.values(windows).map((window) => window.usedPercent);
  return values.length > 0 ? Math.max(...values) : UNKNOWN_UTILIZATION;
}

/**
 * How full a model's own weekly window is: the ACCOUNT's number when we hold
 * a profile token to read it, else 0. The spend-derived ESTIMATE that used
 * to back this went with the shared-pool model — bridge turns never run
 * fable, so there is nothing left for an estimate to protect.
 */
export function modelWindowPercent(
  doc: Pick<PlatformCredentialDocument, 'modelWindows'>,
  model: string,
): number {
  const reported = doc.modelWindows?.[model]?.usedPercent;
  return typeof reported === 'number' && Number.isFinite(reported) ? Math.min(100, reported) : 0;
}

/**
 * Lower is better: fullest usage window plus a weight per in-flight turn.
 * A lease that names its model also counts that model's account-reported
 * window when we can read one. Ties go to the least-recently-leased
 * credential so load rotates.
 */
export function leaseScore(doc: PlatformCredentialDocument, model?: string): number {
  const utilization = model !== undefined
    ? Math.max(maxUtilization(doc), modelWindowPercent(doc, model))
    : maxUtilization(doc);
  return utilization + doc.inFlightCount * IN_FLIGHT_UTILIZATION_WEIGHT;
}

/**
 * Selection precedence, highest first:
 *
 *  1. `preferredCredentialId` — the CALLER's constraint, not a preference:
 *     a Codex machine holds one account's auth.json and cannot run on
 *     another's. It outranks the operator pin because ignoring it produces a
 *     broken turn, while ignoring the pin only produces a differently-routed
 *     one.
 *  2. `routingPin` — the ops bot's account switcher (retired 2026-10-03; no
 *     writer remains). Steers every turn that can run on it.
 *  3. Score — emptiest window, then least-recently-leased.
 *
 * Every level filters to LEASABLE first, so a pinned account on cooldown
 * falls through to scoring instead of stranding the turn.
 */
export function selectLeaseCandidate(
  docs: PlatformCredentialDocument[],
  now = nowIso(),
  preferredCredentialId?: string,
  model?: string,
): PlatformCredentialDocument | null {
  // An owned credential is one user's alone (leaseForUser) — it never joins
  // shared scoring or the routing pin. The explicit preferred id still wins:
  // a Codex machine holds that account's auth.json and can run on no other.
  const leasable = docs.filter((doc) => isLeasable(doc, now, model)
    && (doc.ownerUserId === undefined || doc.credentialId === preferredCredentialId));
  if (leasable.length === 0) return null;
  const preferred = preferredCredentialId
    ? leasable.find((doc) => doc.credentialId === preferredCredentialId)
    : undefined;
  if (preferred) return preferred;
  const pinned = leasable.find((doc) => doc.routingPin === true);
  if (pinned) return pinned;
  leasable.sort((a, b) => {
    const byScore = leaseScore(a, model) - leaseScore(b, model);
    if (byScore !== 0) return byScore;
    return (a.lastLeasedAt ?? '').localeCompare(b.lastLeasedAt ?? '');
  });
  return leasable[0];
}

/**
 * The document mutations of a granted lease — shared by every lease path in
 * both pool implementations, so "what leasing does to a credential" is
 * written once.
 */
export function leasedUpdates(
  doc: PlatformCredentialDocument,
  now = nowIso(),
): Partial<PlatformCredentialDocument> {
  return {
    inFlightCount: doc.inFlightCount + 1,
    totalLeases: doc.totalLeases + 1,
    lastLeasedAt: now,
    updatedAt: now,
    // An expired cooldown is consumed by the lease that revives it.
    ...(doc.status === 'cooldown' ? { status: 'active' as const } : {}),
  };
}

/** What leaseForUser resolved, still holding the doc — pure core shared by both pools. */
export type UserLeaseResolution =
  | { kind: 'dedicated'; doc: PlatformCredentialDocument }
  | { kind: 'dedicated_exhausted'; resetAt?: string; model?: string }
  | { kind: 'payment_required' }
  | { kind: 'limbo'; doc: PlatformCredentialDocument | null };

/**
 * When an ALIVE owned credential could serve this turn again: the latest of
 * whatever currently blocks it — the account-wide cooldown and, when the turn
 * names a model, that model's scoped cooldown. Both must clear to serve.
 */
function ownedCredentialResetAt(
  doc: PlatformCredentialDocument,
  now: string,
  model?: string,
): string | undefined {
  const blockers: string[] = [];
  const scoped = model !== undefined ? doc.modelCooldowns?.[model] : undefined;
  if (scoped && scoped > now) blockers.push(scoped);
  if (doc.status === 'cooldown' && doc.cooldownUntil && doc.cooldownUntil > now) {
    blockers.push(doc.cooldownUntil);
  }
  if (blockers.length === 0) return undefined;
  return blockers.sort()[blockers.length - 1];
}

/**
 * leaseForUser's brain (see the interface doc): the user's live owned
 * credential, exhaustion when it can't serve right now, or a limbo lease
 * scored over the unowned pool. Dead/disabled owned credentials are limbo,
 * not exhaustion — nothing about them resets on its own, and the pool exists
 * precisely to carry a user whose dedicated subscription is missing.
 */
export function resolveUserLease(
  docs: PlatformCredentialDocument[],
  userId: string,
  now = nowIso(),
  model?: string,
): UserLeaseResolution {
  const allOwned = docs.filter((doc) => doc.ownerUserId === userId);
  const owned = allOwned.filter((doc) => doc.status === 'active' || doc.status === 'cooldown');
  if (owned.length > 0) {
    const ready = owned.find((doc) => isLeasable(doc, now, model));
    if (ready) return { kind: 'dedicated', doc: ready };
    // Several owned credentials is an operator accident the exclusivity in
    // setOwner prevents going forward; the earliest relief is still honest.
    const resets = owned
      .map((doc) => ownedCredentialResetAt(doc, now, model))
      .filter((at): at is string => typeof at === 'string')
      .sort();
    // Every credential would run some OTHER model right now: the wall is this
    // model's, and saying "your subscription is out" sends the member to wait
    // for a reset when one tap on another model is the way on (note #772).
    const modelOnly = model !== undefined && owned.some((doc) => isLeasable(doc, now));
    return {
      kind: 'dedicated_exhausted',
      ...(resets[0] ? { resetAt: resets[0] } : {}),
      ...(modelOnly ? { model } : {}),
    };
  }
  if (allOwned.some((doc) => doc.status === 'payment_required')) {
    return { kind: 'payment_required' };
  }
  return { kind: 'limbo', doc: selectLeaseCandidate(docs, now, undefined, model) };
}

/**
 * The seat-first half of leaseForUser, shared by both pools. Null when the
 * user has no seats (not an org member, or none of this provider) — the
 * caller falls through to owned/limbo. A member WITH seats always gets a
 * seat answer: a leasable seat, exhaustion with the earliest reset, or —
 * when every seat is dead/disabled and nothing will heal on its own —
 * `dedicated_exhausted` with no reset, which reads as "re-auth needed"
 * territory (workstream 2 owns making that message self-healing).
 *
 * Seats are single-owner, so the lease writes no in-flight bookkeeping —
 * there is no pool-wide scoring for it to inform.
 */
export async function resolveSeatLease(
  seatSource: OrgSeatCredentialSource | undefined,
  provider: PlatformCredentialProvider,
  userId: string,
  model?: string,
  fetchImpl?: typeof fetch,
  orgId?: string | null,
  seatId?: string,
): Promise<PlatformUserLease | null> {
  if (!seatSource) return null;
  const seatDocs = await seatSource.listForUser(provider, userId, orgId, seatId);
  if (seatDocs.length === 0) {
    return await seatSource.isMember(userId, orgId) ? { kind: 'dedicated_exhausted' } : null;
  }
  const resolution = resolveUserLease(seatDocs, userId, undefined, model);
  if (resolution.kind === 'dedicated') {
    const doc = resolution.doc;
    // A grant seat's token lives ~8h; the periodic refresher keeps it fresh,
    // but a backend that slept past the expiry would otherwise hand a turn a
    // dead token and burn the member's patience on an auth-failure recovery.
    // The margin buys the whole turn: a token that outlives the lease moment
    // by seconds can still die mid-conversation.
    const auth = doc.usageAuth;
    if (
      auth?.refreshToken && !auth.failedAt
      && typeof auth.expiresAt === 'number'
      && auth.expiresAt - Date.now() < SEAT_TOKEN_LEASE_MARGIN_MS
    ) {
      const refreshed = await refreshClaudeOAuthToken(auth.refreshToken, fetchImpl);
      if (refreshed.kind === 'ok') {
        await seatSource.applyCredentialUpdates(doc.credentialId, {
          usageAuth: {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? auth.refreshToken,
            ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
            ...(auth.scopes ? { scopes: auth.scopes } : {}),
          },
        });
        return { kind: 'dedicated', lease: { credentialId: doc.credentialId, token: refreshed.accessToken } };
      }
      // rejected/failed: hand out what we hold — the turn may still land
      // inside the token's life, and its own auth-failure path knows the
      // recovery. Deciding "dead" belongs to the refresher, not the lease.
    }
    return { kind: 'dedicated', lease: { credentialId: doc.credentialId, token: doc.token } };
  }
  if (resolution.kind === 'dedicated_exhausted') return resolution;
  if (resolution.kind === 'payment_required') return resolution;
  // All seats dead/disabled: never limbo for a member.
  return { kind: 'dedicated_exhausted' };
}

/**
 * Health-state transition for a released lease. Pure so the SQLite and
 * in-memory pools (and the tests) share one brain.
 */
export function applyLeaseOutcome(
  doc: PlatformCredentialDocument,
  outcome: PlatformCredentialLeaseOutcome,
  now = nowIso(),
  extras?: PlatformCredentialReleaseExtras,
): Partial<PlatformCredentialDocument> {
  const updates: Partial<PlatformCredentialDocument> = {
    inFlightCount: Math.max(0, doc.inFlightCount - 1),
    updatedAt: now,
  };
  if (extras?.usage) {
    updates.usage = extras.usage;
    updates.usageRefreshedAt = now;
  }
  // Never adopt a refreshed secret off a turn that just failed auth — the
  // machine's copy is the suspect one.
  if (extras?.refreshedToken && outcome.kind !== 'auth_failed') {
    const refreshed = extras.refreshedToken.trim();
    if (refreshed && refreshed !== doc.token) updates.token = refreshed;
  }
  switch (outcome.kind) {
    case 'ok':
      updates.authFailureStreak = 0;
      if (doc.status === 'cooldown') updates.status = 'active';
      break;
    case 'rate_limited': {
      const seconds = outcome.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      const until = new Date(Date.parse(now) + seconds * 1000).toISOString();
      // A trip on a named model while the unified windows read healthy can
      // only be a per-model window (e.g. Fable's own weekly cap): bench that
      // model alone and keep serving the others. So can a trip the CLI itself
      // calls model-only ("Switch to another model", note #772) — a Max seat
      // at 98% of its week still runs Opus. Without a model, or when the
      // account looks exhausted overall, the whole credential cools down.
      if (outcome.model && (outcome.modelOnly || !unifiedNearExhaustion(doc))) {
        updates.modelCooldowns = { ...doc.modelCooldowns, [outcome.model]: until };
      } else {
        updates.status = 'cooldown';
        updates.cooldownUntil = until;
      }
      updates.authFailureStreak = 0;
      break;
    }
    case 'payment_required':
      updates.status = 'payment_required';
      updates.authFailureStreak = 0;
      updates.deadReason = '';
      updates.subscriptionStatus = outcome.subscriptionStatus;
      updates.subscriptionStatusReadAt = now;
      break;
    case 'auth_failed': {
      const streak = doc.authFailureStreak + 1;
      updates.authFailureStreak = streak;
      if (streak >= AUTH_FAILURE_DEATH_THRESHOLD) {
        updates.status = 'dead';
        updates.deadReason = outcome.detail?.slice(0, 500) ?? 'repeated auth failures';
      }
      break;
    }
    case 'error':
      // Not the credential's fault; only the in-flight count moves.
      break;
  }
  return updates;
}

function makeCredentialId(): string {
  return `cred_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function newCredentialDocument(args: {
  provider: PlatformCredentialProvider;
  token: string;
  label: string;
}): PlatformCredentialDocument {
  const now = nowIso();
  return {
    credentialId: makeCredentialId(),
    provider: args.provider,
    token: args.token.trim(),
    label: args.label,
    status: 'active',
    inFlightCount: 0,
    authFailureStreak: 0,
    totalLeases: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Shared refresh pass: probe every live credential and persist its current
 * windows. Claude uses its OAuth/profile or inference-header paths; Codex
 * reads the same account endpoint as its app server, directly from the saved
 * auth.json, so an idle seat no longer waits for another turn to finish.
 * Serial on purpose — the pool is small and this runs off the turn path.
 */
/** Renew an access token this long before it expires, so a read never races the clock. */
const USAGE_TOKEN_RENEW_MARGIN_MS = 10 * 60_000;

/**
 * One deployed version mistook a past-due subscription's 403 for dead OAuth.
 * Those exact rows get one profile-backed path out of `dead`; arbitrary dead
 * grants remain untouched, as the lifecycle contract promises.
 */
function isLegacyClaudeBillingCandidate(doc: PlatformCredentialDocument): boolean {
  return doc.status === 'dead' && Boolean(doc.usageAuth?.accessToken)
    && (doc.usageAuth?.failedReason === 'usage read rejected with HTTP 403'
      || doc.deadReason === 'usage probe rejected with HTTP 403'
      || /OAuth access token has been revoked/i.test(doc.deadReason ?? '')
      || /OAuth authentication is currently not allowed for this organization/i.test(doc.deadReason ?? ''));
}

/** A confirmed-alive grant must forget an earlier diagnostic failure stamp. */
function healthyUsageAuth(
  auth: NonNullable<PlatformCredentialDocument['usageAuth']>,
  accessToken = auth.accessToken,
): NonNullable<PlatformCredentialDocument['usageAuth']> {
  return {
    accessToken,
    ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
    ...(auth.scopes ? { scopes: auth.scopes } : {}),
  };
}

/**
 * Read one credential's windows through its profile-scoped usage token,
 * renewing the token first when it is at/near expiry. Returns the usage plus
 * any `usageAuth` changes to persist (rotated tokens, or the death stamp).
 *
 * `null` usage means "fall back to the header probe" — never "fail the
 * credential". This token cannot run turns, so its death must cost us the
 * per-model window and nothing else.
 */
async function readUsageViaProfileToken(
  doc: PlatformCredentialDocument,
  fetchImpl: typeof fetch | undefined,
  now: string,
): Promise<{
  usage: ClaudeAccountUsage | null;
  authUpdate?: PlatformCredentialDocument['usageAuth'];
  paymentRequired?: { subscriptionStatus: string; plan: ClaudePlanFields };
  profileAccessForbidden?: ClaudeProfileFacts;
  authRejected?: boolean;
  refreshRejected?: boolean;
}> {
  const auth = doc.usageAuth;
  const mayRecheckFailedGrant = doc.status === 'payment_required' || isLegacyClaudeBillingCandidate(doc);
  if (!auth?.accessToken || (auth.failedAt && !mayRecheckFailedGrant)) return { usage: null };
  let accessToken = auth.accessToken;
  let authUpdate: PlatformCredentialDocument['usageAuth'] | undefined;
  let refreshRejected = false;

  const renew = async (): Promise<boolean> => {
    if (!auth.refreshToken) return false;
    const refreshed = await refreshClaudeOAuthToken(auth.refreshToken, fetchImpl);
    if (refreshed.kind === 'ok') {
      accessToken = refreshed.accessToken;
      authUpdate = {
        ...healthyUsageAuth(auth, refreshed.accessToken),
        accessToken: refreshed.accessToken,
        // A rotated refresh token replaces the old one; an absent one means
        // the grant kept the existing token.
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      };
      return true;
    }
    // A dead grant still stops the retry loop; a transient failure still does
    // NOT, so the pool keeps healing itself across a blip. What changes is
    // that neither is silent any more.
    //
    // Silence is what actually cost us: on 2026-08-15 both accounts' usage
    // tokens had been expired for 17 hours with `failedAt` empty and nothing
    // in the log, so the per-model (Fable) window kept serving its last-known
    // value — 0% on an account whose own UI read 17% — and every reader
    // downstream believed it.
    if (refreshed.kind === 'rejected') {
      refreshRejected = true;
      authUpdate = {
        ...auth,
        failedAt: now,
        failedReason: `refresh rejected with HTTP ${refreshed.status}`,
      };
    }
    console.warn(
      `[pool] ${doc.label}: usage-token refresh ${refreshed.kind}`
      // WHY it failed, not just that it did: on 2026-08-16 this line repeated
      // every 5 minutes for 17 hours saying "failed", and the answer it was
      // withholding — HTTP 429 from the token endpoint — was the whole fix.
      + (refreshed.kind === 'failed' ? ` (${refreshed.reason})` : ` with HTTP ${refreshed.status}`)
      + ` — the per-model (fable) window is stale until this is fixed`
      + (refreshed.kind === 'rejected' ? ' (re-attach a usage token)' : ' (will retry next pass)'),
    );
    return false;
  };

  const expiring = typeof auth.expiresAt === 'number'
    && auth.expiresAt - Date.parse(now) < USAGE_TOKEN_RENEW_MARGIN_MS;
  if (expiring && !await renew()) {
    return {
      usage: null,
      ...(authUpdate ? { authUpdate } : {}),
      ...(refreshRejected ? { refreshRejected: true } : {}),
    };
  }

  // The plan this credential already reported rides along: the profile
  // endpoint is only asked again once that reading is old, so the 5-minute
  // pass keeps costing one request per credential rather than two.
  const knownPlan = doc.usage;
  let read = await readClaudeUsageWithProfileToken(accessToken, fetchImpl, knownPlan);
  // An unexpected rejection (revoked early, clock skew) gets exactly one
  // refresh-and-retry before we give up for this pass.
  if (read.kind === 'auth_rejected' && !expiring && await renew()) {
    read = await readClaudeUsageWithProfileToken(accessToken, fetchImpl, knownPlan);
  }
  if (read.kind === 'ok') {
    // A successful account read proves a previously stamped grant is alive.
    if (auth.failedAt && !authUpdate) authUpdate = healthyUsageAuth(auth, accessToken);
    return { usage: read.usage, ...(authUpdate ? { authUpdate } : {}) };
  }
  if (read.kind === 'payment_required') {
    // Billing did not revoke OAuth. Clear the old false-positive failure stamp
    // so the periodic pass keeps asking and can see the invoice recover.
    authUpdate = healthyUsageAuth(authUpdate ?? auth, accessToken);
    return {
      usage: null,
      authUpdate,
      paymentRequired: {
        subscriptionStatus: read.subscriptionStatus,
        plan: read.plan,
      },
    };
  }
  if (read.kind === 'profile_access_forbidden') {
    authUpdate = healthyUsageAuth(authUpdate ?? auth, accessToken);
    return {
      usage: null,
      authUpdate,
      profileAccessForbidden: read.profile,
      ...(refreshRejected ? { refreshRejected: true } : {}),
    };
  }
  // Keep the ROOT cause: when the refresh grant itself was rejected above,
  // that is what an operator needs to read ("re-sign-in"), not the 401 on the
  // access token it left us holding.
  if (read.kind === 'auth_rejected' && !authUpdate?.failedAt) {
    authUpdate = {
      ...(authUpdate ?? auth),
      failedAt: now,
      failedReason: `usage read rejected with HTTP ${read.status}`,
    };
  }
  return {
    usage: null,
    ...(authUpdate ? { authUpdate } : {}),
    ...(read.kind === 'auth_rejected' ? { authRejected: true } : {}),
    ...(refreshRejected ? { refreshRejected: true } : {}),
  };
}

/** Cooldown expiry and stale model-cooldown pruning shared by every provider. */
function usageRefreshBookkeeping(
  doc: PlatformCredentialDocument,
  now: string,
): Partial<PlatformCredentialDocument> {
  const updates: Partial<PlatformCredentialDocument> = { updatedAt: now };
  if (doc.status === 'cooldown' && (!doc.cooldownUntil || doc.cooldownUntil <= now)) {
    updates.status = 'active';
  }
  if (doc.modelCooldowns && Object.values(doc.modelCooldowns).some((until) => until <= now)) {
    updates.modelCooldowns = Object.fromEntries(
      Object.entries(doc.modelCooldowns).filter(([, until]) => until > now),
    );
  }
  return updates;
}

export async function refreshPoolUsage(
  pool: { listCredentials(provider: PlatformCredentialProvider): Promise<PlatformCredentialDocument[]> },
  update: (credentialId: string, updates: Partial<PlatformCredentialDocument>) => Promise<void>,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const codexDocs = await pool.listCredentials('codex');
  for (const doc of codexDocs) {
    if (doc.status === 'dead' || doc.status === 'disabled') continue;
    const now = nowIso();
    const updates = usageRefreshBookkeeping(doc, now);
    try {
      const read = await readCodexUsageForAuthJson(doc.token, fetchImpl);
      if (read.kind === 'ok') {
        updates.usage = read.snapshot;
        updates.usageRefreshedAt = now;
        updates.authFailureStreak = 0;
      }
      // A rejected access token is not proof the full sign-in is dead: Codex
      // may still renew it from the refresh token on the next turn. Keep the
      // last reading without penalizing the seat; a turn-level auth failure
      // remains the authority for health state.
    } catch (error) {
      console.warn(`[credential-pool] Codex usage refresh failed for ${doc.credentialId}:`, error);
    }
    await update(doc.credentialId, updates);
  }

  const docs = await pool.listCredentials('claude');
  for (const doc of docs) {
    const legacyBillingCandidate = isLegacyClaudeBillingCandidate(doc);
    if (doc.status === 'disabled' || (doc.status === 'dead' && !legacyBillingCandidate)) continue;
    const now = nowIso();
    const updates = usageRefreshBookkeeping(doc, now);
    try {
      // Preferred source: the account's own usage endpoint, which is the only
      // one that reports per-model windows. Falls through to the header probe
      // when there is no profile token, or its grant has died.
      const viaProfile = await readUsageViaProfileToken(doc, fetchImpl, now);
      if (viaProfile.authUpdate) updates.usageAuth = viaProfile.authUpdate;
      if (viaProfile.paymentRequired) {
        updates.status = 'payment_required';
        updates.deadReason = '';
        updates.subscriptionStatus = viaProfile.paymentRequired.subscriptionStatus;
        updates.subscriptionStatusReadAt = now;
        updates.authFailureStreak = 0;
        // Keep the last-known windows exactly as they were, but retain a plan
        // learned from the still-readable profile beside them.
        if (doc.usage && viaProfile.paymentRequired.plan.planType) {
          updates.usage = { ...doc.usage, ...viaProfile.paymentRequired.plan };
        }
        await update(doc.credentialId, updates);
        continue;
      }
      const recoveringBilling = doc.status === 'payment_required' || legacyBillingCandidate;
      const storedProfileToken = doc.usageAuth?.accessToken ?? doc.token;
      const profileToken = viaProfile.authUpdate?.accessToken ?? storedProfileToken;
      // Pool rows have separate setup/inference and profile tokens; grant
      // seats use one OAuth token for both, including a renewal in this pass.
      const inferenceToken = doc.token === storedProfileToken ? profileToken : doc.token;
      if (recoveringBilling && viaProfile.profileAccessForbidden) {
        const profile = viaProfile.profileAccessForbidden;
        const subscriptionStatus = profile.subscriptionStatus;
        const profileActive = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
        const inference = profileActive
          ? await readClaudeUsageForToken(inferenceToken, fetchImpl, {
            skipUsageEndpoint: true,
            requireSuccessfulResponse: true,
          })
          : { kind: 'failed' as const };
        updates.subscriptionStatusReadAt = now;
        if (subscriptionStatus) updates.subscriptionStatus = subscriptionStatus;
        if (profileActive && inference.kind === 'ok') {
          updates.status = 'active';
          updates.deadReason = '';
          updates.authFailureStreak = 0;
          // A successful inference response may carry no quota headers. Keep
          // historical windows unless it actually supplied a new reading.
          if (Object.keys(inference.snapshot.windows).length > 0) {
            updates.usage = {
              ...inference.snapshot,
              ...(profile.planType ? { planType: profile.planType, planReadAt: now } : {}),
            };
            updates.usageRefreshedAt = now;
          }
        } else {
          updates.status = 'payment_required';
          updates.deadReason = '';
          updates.authFailureStreak = 0;
        }
        await update(doc.credentialId, updates);
        continue;
      }
      if (viaProfile.usage) {
        if (recoveringBilling) {
          // Do not restore on a cosmetic/profile read alone. A paid account is
          // ready only when the profile is active AND the same token can make
          // an inference request — the operation agents actually need.
          const profile = await readClaudeProfileWithProfileToken(profileToken, fetchImpl);
          const subscriptionStatus = profile?.subscriptionStatus;
          if (subscriptionStatus && CLAUDE_PAYMENT_REQUIRED_STATUSES.has(subscriptionStatus)) {
            updates.status = 'payment_required';
            updates.deadReason = '';
            updates.subscriptionStatus = subscriptionStatus;
            updates.subscriptionStatusReadAt = now;
            updates.authFailureStreak = 0;
            await update(doc.credentialId, updates);
            continue;
          }
          const profileActive = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
          const inference = profileActive
            ? await readClaudeUsageForToken(inferenceToken, fetchImpl, {
              skipUsageEndpoint: true,
              requireSuccessfulResponse: true,
            })
            : { kind: 'failed' as const };
          if (!profileActive || inference.kind !== 'ok') {
            if (profile?.subscriptionStatus) {
              updates.subscriptionStatus = profile.subscriptionStatus;
              updates.subscriptionStatusReadAt = now;
            }
            if (profileActive) {
              // Billing propagation is not atomic across Anthropic's profile,
              // usage and inference surfaces. An active profile alone cannot
              // restore, and an inference rejection here cannot revoke the
              // grant the profile just proved alive.
              updates.status = 'payment_required';
              updates.deadReason = '';
              updates.authFailureStreak = 0;
            }
            await update(doc.credentialId, updates);
            continue;
          }
          updates.status = 'active';
          updates.deadReason = '';
          updates.subscriptionStatus = subscriptionStatus;
          updates.subscriptionStatusReadAt = now;
        }
        updates.usage = viaProfile.usage.snapshot;
        updates.usageRefreshedAt = now;
        // A usage read through the credential's own token IS proof the grant
        // is alive, so the streak resets here exactly as it does on the
        // header-probe path below. Grant seats' successes never reach that
        // branch, and a streak that can only rise would let two unrelated
        // blips, days apart, add up to killing a healthy seat.
        updates.authFailureStreak = 0;
        updates.modelWindows = viaProfile.usage.modelWindows;
        // Stamped only on the profile path: this is the only read that sees
        // per-model windows, so it is the only one that may claim they are
        // current.
        updates.modelWindowsReadAt = now;
        await update(doc.credentialId, updates);
        continue;
      }

      // A known billing pause stays recoverable through transient reads. A
      // refresh grant explicitly rejected twice is different: that is the
      // provider proving the credential itself is now gone.
      if (doc.status === 'payment_required' || legacyBillingCandidate) {
        if (doc.status === 'payment_required' && viaProfile.refreshRejected) {
          const streak = doc.authFailureStreak + 1;
          updates.authFailureStreak = streak;
          if (streak >= AUTH_FAILURE_DEATH_THRESHOLD) {
            updates.status = 'dead';
            updates.deadReason = 'OAuth refresh grant was rejected after the billing pause';
          }
        }
        await update(doc.credentialId, updates);
        continue;
      }

      // Straight to the header probe: every token that reaches this fallback
      // is scope-blind at the endpoint — setup-tokens always, and a grant
      // seat's access token only lands here after the profile path (same
      // token) already failed.
      const read = await readClaudeUsageForToken(doc.token, fetchImpl, { skipUsageEndpoint: true });
      if (read.kind === 'ok') {
        // Headers name no plan. A grant seat lands here when one profile read
        // blipped, and the plan it reported a minute ago is still true — a
        // coarser reading must not also wipe the label (note #692).
        updates.usage = {
          ...read.snapshot,
          ...(doc.usage?.planType ? { planType: doc.usage.planType } : {}),
          ...(doc.usage?.planReadAt ? { planReadAt: doc.usage.planReadAt } : {}),
        };
        updates.usageRefreshedAt = now;
        updates.authFailureStreak = 0;
      } else if (read.kind === 'auth_rejected') {
        const streak = doc.authFailureStreak + 1;
        updates.authFailureStreak = streak;
        if (streak >= AUTH_FAILURE_DEATH_THRESHOLD) {
          updates.status = 'dead';
          updates.deadReason = `usage probe rejected with HTTP ${read.status}`;
        }
      }
      // kind === 'failed' (network/shape): keep the last snapshot, no penalty.
    } catch (error) {
      console.warn(`[credential-pool] Usage refresh failed for ${doc.credentialId}:`, error);
    }
    await update(doc.credentialId, updates);
  }

  // OpenCode keys have no usage a key can read (note #780), so nothing is
  // probed: the pass only lets a seat a limit benched read as itself again
  // once the window it named has reset. A lease already treats it so.
  for (const doc of await pool.listCredentials('opencode')) {
    if (doc.status === 'dead' || doc.status === 'disabled') continue;
    const updates = usageRefreshBookkeeping(doc, nowIso());
    if (updates.status || updates.modelCooldowns) await update(doc.credentialId, updates);
  }
}


export class InMemoryPlatformCredentialPool implements PlatformCredentialPool {
  private docs = new Map<string, PlatformCredentialDocument>();
  /** Timer/UI refreshes share one provider pass; overlapping OAuth rotations are unsafe. */
  private usageRefreshInFlight?: Promise<void>;

  constructor(private readonly seatSource?: OrgSeatCredentialSource) {}

  async listCredentials(provider: PlatformCredentialProvider): Promise<PlatformCredentialDocument[]> {
    return [...this.docs.values()].filter((doc) => doc.provider === provider);
  }

  async addCredential(args: {
    provider: PlatformCredentialProvider;
    token: string;
    label: string;
  }): Promise<PlatformCredentialDocument> {
    const doc = newCredentialDocument(args);
    this.docs.set(doc.credentialId, doc);
    return doc;
  }

  async leaseCredential(
    provider: PlatformCredentialProvider,
    opts?: { preferredCredentialId?: string; model?: string },
  ): Promise<PlatformCredentialLease | null> {
    const candidate = selectLeaseCandidate(
      await this.listCredentials(provider),
      undefined,
      opts?.preferredCredentialId,
      opts?.model,
    );
    if (!candidate) return null;
    Object.assign(candidate, leasedUpdates(candidate));
    return { credentialId: candidate.credentialId, token: candidate.token };
  }

  async leaseForUser(
    provider: PlatformCredentialProvider,
    userId: string,
    opts?: { model?: string; preferredCredentialId?: string; orgId?: string | null; seatId?: string },
  ): Promise<PlatformUserLease> {
    const seatLease = await resolveSeatLease(this.seatSource, provider, userId, opts?.model, undefined, opts?.orgId, opts?.seatId);
    if (seatLease) return seatLease;
    const resolution = resolveUserLease(await this.listCredentials(provider), userId, undefined, opts?.model);
    if (resolution.kind === 'dedicated_exhausted' || resolution.kind === 'payment_required') return resolution;
    if (resolution.kind === 'limbo' && !resolution.doc && opts?.preferredCredentialId === undefined) {
      return { kind: 'limbo', lease: null };
    }
    const doc = resolution.kind === 'limbo' && opts?.preferredCredentialId !== undefined
      ? selectLeaseCandidate(await this.listCredentials(provider), undefined, opts.preferredCredentialId, opts?.model)
      : resolution.doc;
    if (!doc) return { kind: 'limbo', lease: null };
    Object.assign(doc, leasedUpdates(doc));
    return {
      kind: resolution.kind,
      lease: { credentialId: doc.credentialId, token: doc.token },
    };
  }

  async setOwner(
    provider: PlatformCredentialProvider,
    credentialId: string,
    ownerUserId: string | null,
  ): Promise<{ label: string } | null> {
    const target = [...this.docs.values()]
      .find((doc) => doc.provider === provider && doc.credentialId === credentialId);
    if (!target) return null;
    if (ownerUserId !== null) {
      for (const doc of this.docs.values()) {
        if (doc.provider !== provider || doc === target) continue;
        if (doc.ownerUserId === ownerUserId) {
          delete doc.ownerUserId;
          doc.updatedAt = nowIso();
        }
      }
      Object.assign(target, { ownerUserId, updatedAt: nowIso() });
    } else {
      delete target.ownerUserId;
      target.updatedAt = nowIso();
    }
    return { label: target.label };
  }

  async releaseCredential(
    credentialId: string,
    outcome: PlatformCredentialLeaseOutcome,
    extras?: PlatformCredentialReleaseExtras,
  ): Promise<void> {
    if (this.seatSource?.owns(credentialId)) {
      return this.seatSource.release(credentialId, outcome, extras);
    }
    const doc = this.docs.get(credentialId);
    if (!doc) return;
    Object.assign(doc, applyLeaseOutcome(doc, outcome, undefined, extras));
  }

  async setRoutingPin(
    provider: PlatformCredentialProvider,
    credentialId: string | null,
  ): Promise<{ label: string } | null> {
    let pinned: PlatformCredentialDocument | undefined;
    for (const doc of this.docs.values()) {
      if (doc.provider !== provider) continue;
      const shouldPin = credentialId !== null && doc.credentialId === credentialId;
      if (shouldPin) pinned = doc;
      if (shouldPin === (doc.routingPin === true)) continue;
      Object.assign(doc, { routingPin: shouldPin, updatedAt: nowIso() });
    }
    return pinned ? { label: pinned.label } : null;
  }

  async refreshUsage(fetchImpl?: typeof fetch): Promise<void> {
    // Opening Workspace seats/usage and the five-minute timer can all ask at
    // once. A Claude refresh rotates both tokens, so two passes over the same
    // snapshot can revoke each other's result and let the slower write win.
    // Coalesce the whole pass; every caller awaits the same fresh reading.
    if (this.usageRefreshInFlight) return this.usageRefreshInFlight;
    const refresh = (async () => {
      await refreshPoolUsage(this, async (credentialId, updates) => {
        const doc = this.docs.get(credentialId);
        if (doc) Object.assign(doc, updates);
      }, fetchImpl);
      if (this.seatSource) {
        const seatSource = this.seatSource;
        await refreshPoolUsage(
          { listCredentials: (provider) => seatSource.listAllForProbe(provider) },
          (credentialId, updates) => seatSource.applyCredentialUpdates(credentialId, updates),
          fetchImpl,
        );
      }
    })();
    this.usageRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.usageRefreshInFlight === refresh) this.usageRefreshInFlight = undefined;
    }
  }
}

/**
 * Periodic usage refresh, structurally parallel to FlyIdleReaper: start() at
 * boot, one interval, errors logged and swallowed.
 */
export class PlatformCredentialUsageRefresher {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly pool: PlatformCredentialPool,
    private readonly intervalMs = PLATFORM_CREDENTIAL_USAGE_REFRESH_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pool.refreshUsage().catch((error) => {
        console.warn('[credential-pool] Scheduled usage refresh failed:', error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
