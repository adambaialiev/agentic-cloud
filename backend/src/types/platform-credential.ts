import type { ProviderUsageSnapshot, ProviderUsageWindow } from './user.js';

/**
 * A platform-owned CLI subscription credential. Lives in the top-level
 * `platformCredentials` collection — deliberately OUTSIDE `users/*` so no
 * user-scoped code path can ever read another account's pool token.
 */
export type PlatformCredentialProvider = 'claude' | 'codex' | 'opencode';

export type PlatformCredentialStatus =
  /** Healthy — eligible for leasing. */
  | 'active'
  /** Rate-limited — skipped until `cooldownUntil` passes, then auto-restored. */
  | 'cooldown'
  /**
   * The provider still accepts the OAuth grant, but has paused subscription
   * access over billing. Non-leasable, yet deliberately re-probed so a paid
   * invoice restores the credential without another sign-in.
   */
  | 'payment_required'
  /** Auth is gone (revoked/banned token). Never auto-restored; needs re-provisioning. */
  | 'dead'
  /** Manually taken out of rotation by an operator. */
  | 'disabled';

export interface PlatformCredentialDocument {
  credentialId: string;
  provider: PlatformCredentialProvider;
  /**
   * The secret material, provider-shaped: Claude — the `sk-ant-oat…`
   * setup-token (injected per turn as CLAUDE_CODE_OAUTH_TOKEN); Codex — the
   * full `~/.codex/auth.json` contents (written to the machine before the
   * turn, synced back after, since the CLI refreshes tokens in place).
   */
  token: string;
  /** Operator-facing name, e.g. "max-account-2". */
  label: string;
  /**
   * The user this credential is DEDICATED to. An owned credential serves that
   * user's turns exclusively: it never joins pool scoring for anyone else, and
   * while it is alive its owner's turns run on nothing else — a rate limit
   * means the owner waits for their own window, not a hop to the shared pool.
   * Owners whose credential is dead or disabled fall back to the pool (the
   * "limbo" the pool now exists to serve — see leaseForUser).
   */
  ownerUserId?: string;
  /**
   * Operator routing pin (the ops bot's account switcher, retired 2026-10-03 —
   * nothing sets it now, the field goes with the pool): while true, every
   * turn that CAN run on this credential does. At most one credential per
   * provider carries it — `setRoutingPin` clears the others in the same
   * transaction, so "which account is requests going through" has one answer.
   *
   * A pin steers, it does not strand: when the pinned credential is not
   * leasable (cooldown, dead, a model-scoped cooldown) selection falls back to
   * ordinary scoring rather than failing the turn. An ops pin left on over a
   * weekend must not be able to take the product down.
   */
  routingPin?: boolean;
  status: PlatformCredentialStatus;
  /** ISO — set while `status === 'cooldown'`; lease-time reads treat past values as expired. */
  cooldownUntil?: string;
  /**
   * Model alias (the catalog's 'fable'/'opus'/'sonnet') → ISO expiry of a
   * cooldown scoped to that model alone. Written when a usage-limit trip is
   * attributable to a per-model window (the unified windows say the account
   * isn't exhausted); the credential stays `active` and keeps serving other
   * models. Past entries are dead — lease reads ignore them, the refresh
   * pass prunes them.
   */
  modelCooldowns?: Record<string, string>;
  /**
   * When `modelWindows` was last READ from the account (ISO). Absent means
   * never, or a document written before this field existed — both of which a
   * reader must treat as "do not trust the per-model number".
   *
   * `usageRefreshedAt` is NOT a substitute: the header probe refreshes the
   * unified windows without touching the per-model ones, so on 2026-08-15 the
   * 5h/weekly figures were current to the minute while Fable was 17 hours
   * stale — and nothing in the document said which was which.
   */
  modelWindowsReadAt?: string;
  /** Why the credential was marked dead (auth-failure tail, probe HTTP status). */
  deadReason?: string;
  /** Provider-shaped subscription state that established a billing pause (for example `past_due`). */
  subscriptionStatus?: string;
  /** ISO timestamp of that provider profile reading. */
  subscriptionStatusReadAt?: string;
  /**
   * Turns currently running on this credential. Incremented at lease,
   * decremented at release. Crash-leaked increments are tolerated: selection
   * uses it as a tie-breaker weight, not a hard cap.
   */
  inFlightCount: number;
  /** Consecutive auth failures; reset on any success. Dead at the threshold. */
  authFailureStreak: number;
  /** Unified provider windows from the account endpoint or provider-shaped fallback probe. */
  usage?: ProviderUsageSnapshot;
  usageRefreshedAt?: string;
  /**
   * A SECOND credential for this same account, used only to READ usage: an
   * OAuth token carrying `user:profile`, which the account's setup-token does
   * not (it is `user:inference` only, and gets a 403 on the usage endpoint).
   *
   * Kept separate from `token` on purpose — `token` runs turns and this one
   * cannot, so losing or breaking this one degrades the pool to the header
   * probe rather than stopping it serving. Nothing here is ever used to
   * authenticate a turn.
   */
  usageAuth?: {
    accessToken: string;
    /** Rotates on refresh; persist whatever comes back or the grant strands. */
    refreshToken?: string;
    /** Epoch ms. Access tokens last ~8h, so the refresher renews before this. */
    expiresAt?: number;
    scopes?: string[];
    /** Set when the grant died — stops the retry loop until a human re-signs. */
    failedAt?: string;
    failedReason?: string;
  };
  /**
   * Per-model windows as the ACCOUNT reports them (model alias → window),
   * e.g. `fable` at 100%. Deliberately not merged into `usage.windows`:
   * selection scores unscoped turns on the max of the unified windows, and a
   * full Fable window in that map would bench a credential that has plenty of
   * room for every other model.
   *
   * When present this REPLACES the spend-derived estimate for that model —
   * the account's own number beats anything we can infer.
   */
  modelWindows?: Record<string, ProviderUsageWindow>;
  lastLeasedAt?: string;
  totalLeases: number;
  createdAt: string;
  updatedAt: string;
}

export type PlatformCredentialLeaseOutcome =
  | { kind: 'ok' }
  /** Provider profile confirms billing paused an otherwise valid grant. */
  | { kind: 'payment_required'; subscriptionStatus: string; detail?: string }
  /** The turn failed with the CLI's own auth-failure phrasing → credential problem. */
  | { kind: 'auth_failed'; detail?: string }
  /**
   * The turn hit the subscription's usage/rate limit. `model` is the catalog
   * alias the turn ran with — it lets the pool scope the cooldown to a
   * per-model window when the unified windows say the account isn't
   * exhausted (see applyLeaseOutcome). `modelOnly` is the CLI itself saying
   * the trip is that model's alone ("Switch to another model to continue",
   * note #772): the bench is then scoped whatever the unified windows read,
   * since the account still serves every other model.
   */
  | { kind: 'rate_limited'; retryAfterSeconds?: number; model?: string; modelOnly?: boolean }
  /** The turn failed for reasons unrelated to the credential. */
  | { kind: 'error' };

export interface PlatformCredentialLease {
  credentialId: string;
  token: string;
}

/**
 * What leaseForUser resolved for a user's turn. Three shapes because the
 * harness answers each differently:
 *
 *  - `dedicated` — the user's own credential, leased. Their turns are limited
 *    only by what that subscription itself allows.
 *  - `dedicated_exhausted` — they HAVE a live credential but it (or the
 *    requested model's window on it) is cooling down. The honest answer is
 *    "your subscription resets at …", never a quiet hop onto shared capacity.
 *  - `limbo` — no live owned credential: either just-subscribed (the operator
 *    hasn't bought their subscription yet) or theirs died. Served from the
 *    unowned pool, `lease` null when that pool has nothing leasable.
 */
export type PlatformUserLease =
  | { kind: 'dedicated'; lease: PlatformCredentialLease }
  /**
   * `model` is set when every live credential would serve the turn but for
   * that model's own scoped cooldown — the answer is then "this model is out,
   * another one runs now", not "your subscription is out" (note #772).
   */
  | { kind: 'dedicated_exhausted'; resetAt?: string; model?: string }
  /** A valid provider grant whose subscription is paused until billing is fixed. */
  | { kind: 'payment_required' }
  | { kind: 'limbo'; lease: PlatformCredentialLease | null };

/** Optional facts a release can carry back beyond the outcome itself. */
export interface PlatformCredentialReleaseExtras {
  /** Fresh utilization observed during/after the turn (Codex: the app-server RPC). */
  usage?: ProviderUsageSnapshot;
  /**
   * Post-turn secret material when the CLI refreshed it in place (Codex:
   * auth.json read back off the machine). Last-writer-wins by design — the
   * pinned-machine stickiness keeps concurrent writers rare.
   */
  refreshedToken?: string;
}
