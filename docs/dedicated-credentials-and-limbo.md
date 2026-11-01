# Historical: dedicated credentials and limbo

> **Superseded by member-owned seats.** The platform no longer sells a plan and
> buys an AI subscription for each customer. Members sign in their own Claude
> or ChatGPT subscription, which their agents lease as a seat.
> See `docs/seat-sign-in.md` for the current path; the material below is kept as
> an implementation-history record.

Since 2026-08-19 the platform's answer to "whose Claude subscription does a
user's turn run on" is: **their own — one the operator bought for them** —
with the shared pool kept only as a bridge. This replaces selling measured
fractions of shared subscriptions, and it exists to delete complexity: the
calibrator, the shadow meter and the per-user budget arithmetic all answered
"how much of a shared account did this user consume?", a question a dedicated
subscription makes meaningless.

## The model

A credential in `platformCredentials` with an `ownerUserId` is **dedicated**:
it serves that user's turns exclusively and never joins pool scoring for
anyone else. Everything unowned is the **shared pool**, which serves
**limbo** — a paying user with no live dedicated credential, either because
the operator hasn't bought their subscription yet or because theirs died.

Per-turn resolution is `leaseForUser` (`platform-credential-pool.ts`), one
call with three answers:

- `dedicated` — the user's own credential, leased. No per-user gates: the
  subscription's own windows are the limit.
- `dedicated_exhausted` — their credential (or the requested model's window
  on it) is cooling down. The harness answers "your subscription resets
  within …" and the turn does NOT run. Deliberately never a fall-through to
  the pool: that would put exactly the heaviest users back on the shared
  capacity limbo depends on.
- `limbo` — no live owned credential; lease the healthiest unowned one.

## What limbo means for the user

- Every model except Fable. Fable is refused with "your dedicated
  subscription is being set up — Fable unlocks the moment it's ready"
  (`CLAUDE_LIMBO_FABLE_MESSAGE`), regardless of rung. Admin accounts are
  exempt.
- No per-user usage tracking or budget gates — limbo is hours, and one crude
  protection (no Fable, the pool's own per-credential cooldowns) is enough.
- On a dedicated credential the Fable gate is the rung's `fableAccess`,
  exactly as before.

## The operator loop (ops bot) — retired

> Historical. `/limbo` went on 2026-08-22 with the plans; `/pool`, `/own` and
> `/disown` went on 2026-10-03, because the shared pool is empty in production
> and org seats carry the turns. The bot now answers `/users`, `/fleet` and
> `/help`, read-only. What follows is the loop as it was designed.

1. A plan starts or changes rung → the Paddle webhook pings the ops chat:
   buy that user a subscription.
2. Mint the setup-token, add the credential (however credentials are added
   today), then `/own <label> <user-id>` — exclusive per user; owning a new
   credential for a user releases their old one automatically.
3. `/limbo` lists every paying user still waiting (none attached, or theirs
   died) with the exact `/own` line to type.
4. A user leaves → the webhook pings again; `/disown <label>` returns the
   credential to the pool, where its remaining paid weeks serve as limbo
   stock.

A dedicated credential that dies (revoked/banned) drops its user back into
limbo automatically — recovery and onboarding are the same state and the
same code path. Nothing pings when that happens; `/limbo` and `/pool` are
the places it shows.

## The machinery that went with the shared model

Removed in the follow-up cleanups (2026-08-19): the per-user metering
(hourly buckets on the profile), the measured window budgets
(`window-capacity.ts`), the capacity calibrator, the shadow meter, the pool
exchange rate, the calibration samples, the spend-derived per-model window
estimate, and `platformUsageShare` on the plans. A second pass took the
rest of the cost tracking: per-turn pricing in both harnesses (Claude's
`total_cost_usd` read, Codex's rate table), per-credential spend
attribution (`modelSpend`, `meteredMicrosTotal`), and `capacityUnits`. The
pool is a donor of turns to the admin account and to limbo, so no dollars
are tracked anywhere — pool health, cooldown scoping and routing all run on
the accounts' own probed windows, which is what they always ran on. The
/pool report reads dedicated vs bridge credentials and flags paying users
in limbo.
