# Historical: percent is the unit

> **Superseded usage model.** This plan-era design measured shares of
> platform-owned subscriptions. The current product uses member-owned Claude
> or ChatGPT seats and has no platform fee or platform usage allowance. Retain
> this page only as the record of the retired design.

**Status:** design approved 2026-08-14 (PR #25). **Rollout step 1 is built** —
`services/platform-pool-rate.ts` + `services/platform-shadow-meter.ts`, read-only.
Steps 2–4 are unbuilt and step 2 is blocked on the K measurement step 1 produces.

A design for user-facing usage windows denominated in the same unit the
subscriptions themselves report, so that "how much capacity do we have" and
"how much has this user spent" stop being two different questions joined by a
calibration.

---

## The problem

Today a turn is gated like this:

```
real window percent
  → calibrate dollars-per-percent          (platform-capacity-calibrator.ts)
  → capacity in USD per unit               (config/window-capacity.ts)
  → × share × 0.85                         (config/plans.ts)
  → user budget in micro-dollars
  → meter the turn in total_cost_usd       (agent/platform-usage-metering.ts)
  → compare
```

The middle three steps were built when we could not read an account's own
windows. Since PR #22 we can (`usageAuth` + `GET /api/oauth/usage`). So the
chain now converts a number we have into a number we don't, in order to compare
it against a third number derived from the first.

That costs us three things:

1. **The margin is a measurement, not a decision.** `PLATFORM_MARGIN = 0.15`,
   but measured weekly capacity came in ~25% above its seed, so the real margin
   drifted to ~36% without anyone choosing it. A calibration error silently
   moves the business.
2. **A downward revision can block a paying user mid-window.** Not
   hypothetical: revising weekly capacity from $835 to $1,255/unit cut a paying
   user's weekly allowance from $850 to $709.75, mid-window.
3. **Two guessed constants remain.** `capacityUnits` is hand-set (max-1 = 2,
   max-2-100 = 1) while the tiers advertise 5x and 20x, i.e. 4:1. And Fable's
   $460/unit is measured on the $200 account only and *assumed* to scale.

---

## The design

### 1. One unit, everywhere

> **1 unit-percent = 1% of one $100 subscription's window.**

The pool holds 300 unit-percent per window (max-1 = 2 units, max-2-100 = 1). A
Max user's weekly allowance is 100 of them. Anthropic's own counter, the pool's
routing signal and the user's progress bar become the same unit, top to bottom.

### 2. What a plan buys — the price *is* the share

| plan  | price | share | weekly allowance |
|-------|-------|-------|------------------|
| Free  | $0    | 0.05  | 5 unit-%         |
| Plus  | $10   | 0.10  | 10               |
| Pro   | $20   | 0.20  | 20               |
| Power | $50   | 0.50  | 50               |
| Max   | $100  | 1.00  | 100              |

These are exactly today's `platformUsageShare` values — `share = price / 100`.

One change: **the 15% margin moves out of the allowance and into admission.**
Today every user silently receives 85% of what they bought. Instead they get
exactly what the price says, and we keep headroom by not selling the last 15%
of the pool. The margin then lives in one place instead of in every window, and
it becomes explicable on a pricing page: *"$100 buys one subscription's worth."*

### 3. The only thing still measured: the rate

Per-turn attribution cannot be deleted. The window percent is a *shared*
counter, so something has to say "this turn was 3× that one", and the only
per-turn signals we have are tokens and `total_cost_usd`. Dollars stay — but
demoted from **measured capacity** to **relative weight**.

Per window, read live off the pool every 5 minutes:

```
rate_w = Σ_accounts( units_i × percent_i,w )
         ────────────────────────────────────────
         Σ_accounts( dollars metered against account i, window w )
```

in unit-percent per dollar. A user's meter is then `their dollars in the window
× rate_w`.

Why this is not the calibrator wearing a hat:

- **It is an allocator, not a constant.** By construction, Σ(all user charges)
  equals the pool's actual observed movement. It cannot over- or under-sell.
- **No seed, no clamp, no staleness, no minimum sample count.** It is a
  division of two numbers we already collect. `MIN_PAIRS_TO_TRUST = 50`,
  `MIN_READINGS_TO_TRUST_DIRECT`, `CLAMP_MIN_FACTOR`/`MAX`,
  `MEASUREMENT_STALE_AFTER_MS` all exist because the old number set an
  *absolute* allowance. This one divides a *known total*.
- **Its error is uniform, and harmless to fairness.** A rate 20% high makes
  every user's meter read 20% high: relative fairness untouched, margin
  untouched, we simply leave some pool unused. Today a 20% error means we
  handed out 20% more real capacity than we sold.
- **It kills two guessed constants for free.** `dollars_i / percent_i` per
  account *is* the unit ratio, so it settles 2:1 vs 4:1 from data already on
  disk. And Fable's rate is read from the account's own Fable percentage, so
  the $460/unit assumption goes with it.

Storage is unchanged: keep micro-dollars in `platformUsage.buckets` and convert
at read time. **No data migration**, and applying the current rate across the
whole window is the correct semantics — the allocation is cycle-level, not
per-turn.

### 4. The gate does not change

This is what makes the change cheap. `evaluatePlatformBudget` and
`buildPlatformUsageWindows` already work in percent internally —
`windowUse(used, budgetMicros).usedPercent`. The micros are only a numerator
and a denominator. Swap what fills the denominator and all of this survives
untouched:

- the 5-hour / weekly / Fable window shapes
- `windowResetsAt` and its bucket-ageing math
- `USAGE_WARN_THRESHOLD` at 80%
- the rule that a lane is a sub-window, not a parallel budget
- the usage screen, which already renders percentages

### 5. Dynamic: pressure, not shrinking windows

The ask was windows that move with capacity. I want to argue the other way and
give the moving version as a switch.

**Against moving windows:** they are unprintable on a pricing page, and they
are the ratchet problem — allowed at 10am, blocked at 11am, nothing changed on
the user's side. That already cost one paying user their allowance once.

**Instead: static windows, dynamic admission.** One number:

```
pressure = max over windows of  Σ(units_i × percent_i) / Σ(units_i)
```

| pressure | who runs                |
|----------|-------------------------|
| < 60%    | everyone                |
| 60–80%   | Free waits behind paid  |
| 80–92%   | Free + Plus wait        |
| ≥ 92%    | Power + Max only        |

"Waits", not "refused": turns are async in Telegram, and the pool already has
leases and `inFlightCount`. A queue is strictly better than today's failure
mode, where a rate-limited turn is simply lost
(`CLAUDE_PLATFORM_HICCUP_MESSAGE`, no in-turn failover). About twenty lines:
`admissionFloor(pressure) → minimum plan rank`.

It is invisible whenever we have 40% headroom, which is nearly always, and it
degrades in the order people pay.

**If you want the windows themselves to breathe**, it is one factor:

```
stretch = units × K / Σ(sold shares)
budget  = share × stretch × 100
```

Add a fourth account and everyone's window grows that hour with no deploy. One
rule keeps it safe: **stretch may rise mid-window, never fall.** A cut lands at
the user's next window reset.

### 6. Sell only what we own

The rule missing entirely today — nothing checks Σ(sold shares) ≤ owned units:

```
Σ(paid shares)  ≤  units × K
```

`K` is the oversubscription factor. Start at 1.0; raise it as observed peak
utilization allows. When accepting a subscription would break the inequality we
don't sell — we buy another account.

> **Amended 2026-08-15 (Owner):** this inequality was first written
> `units × 0.85 × K`, carrying a fixed 15% haircut *and* K. Only the product
> `0.85K` ever reaches the pool, so the haircut was a discount on K that could
> not respond to measurement — and with two numbers, neither one answered "how
> much may we sell". `PLATFORM_MARGIN` is deleted; the buffer is now the
> distance between the K we set and the `supportable K` the shadow meter
> measures. Implemented as `poolAdmission()` in `config/plans.ts`, reported
> every pass by the shadow meter (`admission:` line) rather than checked by
> hand.

---

## The numbers on our actual $300

> **Superseded 2026-08-15.** The table below is the arithmetic under the
> ladder as it stood when this was written (`share = price / 100`, minus a 15%
> margin). Both halves of it changed: the ladder is now `price / 200` and the
> margin is gone. **As shipped: three units, $300/month, three whole shares
> sellable at K = 1 — $600/month of shares on $300 of credentials.** The
> ladder is profitable with zero overselling, and every point of K above 1 is
> another $600 against the same cost. The argument that follows is kept
> because it is *why* the shares were halved, not because the figures are
> current.

Three units, $300/month, 2.55 units sellable at K = 1.

| K    | plans sellable | revenue | vs $300 cost      |
|------|----------------|---------|-------------------|
| 1.0  | 2.55 units     | $255    | **−$45**          |
| 1.18 | 3.0            | $300    | break-even        |
| 2.0  | 5.1            | $510    | +70%              |
| 2.35 | 6.0            | $600    | 50% gross margin  |

Because `share = price / 100`, **we sell a unit for exactly what a unit costs
us.** At K = 1 the ladder loses money by construction. The business is not in
the metering — it is entirely in K, and K is justified by the gap between a cap
and actual use (a $10 user probably uses ~2% of a unit, not 10%). K = 2.35
needs average utilization below 43% of cap, which is unremarkable for a usage
cap.

**So the ladder is the decision and the plumbing is not.** Two levers: raise K
(sell more against the same pool) or cut shares (sell less allowance per
dollar).

**And we cannot yet measure K.** ~99% of pool spend is Owner's own admin
account; two other users together spent under $30 in seven days. That is the
one input this design needs and does not have — see rollout step 1, which
produces it.

Free is the exception to the inequality: free users don't pay, so they must not
count against paid admission. They get what is left of the unsold headroom, and
they get it last under pressure.

> **Correction to what I said in chat this morning:** I called the Fable window
> separate capacity. It is not — the lane is a sub-window *nested inside* the
> weekly one (PR #21), so a Fable turn spends the account's weekly window too.
> Routing free users to Fable still helps, because a Fable turn buys the same
> work for fewer dollars and therefore burns less window. But it is not free
> capacity and the design must not be sized as though it were.

---

## What this deletes

| file | lines | fate |
|---|---|---|
| `config/window-capacity.ts` | 149 | all of it |
| `services/platform-capacity-calibrator.ts` | 260 | all of it |
| `test/unit/platform-capacity.test.ts` | — | all of it |
| `modelWeeklyCapacityUsd` + estimated-window fallback in the pool | ~40 | account reports Fable percent directly |
| the calibration sample table + its hourly job | — | gone |
| hand-set `capacityUnits` | — | becomes derived |

And with them the entire "is this measurement trustworthy" surface: seeds,
0.5×–2× clamps, the 50-pair minimum, 14-day staleness, direct-vs-pairwise
method selection.

Net: **roughly 450 lines out, 120 in** — the rate reader, the pressure ladder,
the admission rule.

---

## Rollout

The gate reaches customers' wallets, so it goes in four independently
mergeable steps.

1. **Shadow.** ✅ *Built.* Compute the percent verdict alongside the dollar
   verdict for one full weekly cycle. Log both. Nothing user-visible. This
   proves we cut nobody's allowance — and it is also how we measure K.

   `PlatformShadowMeter` runs hourly off the critical path and logs one block:
   the live rate per window against today's constant, the measured unit ratio
   per credential (the 2:1-vs-4:1 answer), how many users would change verdict,
   and `utilization → supportable K`. Admins are excluded from K — their budget
   is `MAX_SAFE_INTEGER`, and one admin account carries ~99% of pool spend, so
   including it would peg utilization at 100% and K at 1 forever. A user whose
   weekly window has no rate is excluded from *both* sides of the ratio: counted
   as sold against null usage, they would report 0% utilization and recommend
   unlimited overselling at exactly the moment nothing is measurable.
2. **Flip the gate.** Buckets stay in micro-dollars, so there is no migration
   and rollback is a revert.
3. **Delete** the calibrator and `window-capacity.ts` once a clean cycle has
   passed.
4. **Pressure ladder + admission rule.** Independent of 1–3.

Step 1 is safe to merge today and answers the question the rest depends on.

---

## What I need from you

1. **K, or permission to measure it** (rollout step 1). Nothing else here is
   blocked.
2. **Margin out of the allowance and into admission?** I think yes: it is the
   difference between an explicable pricing page and a fudge factor.
3. **Static windows + pressure, or windows that move?** I would take static.
4. **Do free users get a share at all**, or Fable-only and last under pressure?

## Decisions — Owner, 2026-08-15

Questions 2 and 4 are answered; the repricing shipped with them:

- **The ladder is $10 / $50 / $100 / $200 / $300** (Plus, Power, Max, Ultra,
  Apex — the last added 2026-08-16), with **share = price / 200** — the
  "halve the shares, keep K at 1" option. Apex's 1.5 is the first share above
  one whole subscription: at K = 1 one Apex customer books 1.5 of the pool's
  `units` shares, so selling the rung widely means buying accounts. The
  $20 rung (Pro) is no longer sold; existing Pro subscriptions keep resolving.
- **Free had no platform usage at all**, retiring the
  51-free-users-consume-the-pool arithmetic — and then, later the same day,
  **the free rung was removed outright** along with the bring-your-own sign-in
  it depended on. Nobody was connecting a subscription of their own, which left
  free as a tier that sold nothing and cost a machine each. `resolveUserPlan`
  now returns null for a user with no live subscription: no agents, no turns.
  Everything below about "free users" is therefore history, not behaviour.
- **Fable rides the $100+ rungs only** (`fableAccess` on the plan). Below Max
  the gate refuses a fable turn with an upsell naming the entry rung — a
  distinct `model_not_in_plan` verdict, not a window message, because there is
  no reset to wait for.
- **The margin moved out of allowances into admission** (question 2: yes). A
  rung's budget is its full share.
- **Then the margin was deleted outright** (2026-08-15, later the same day):
  `PLATFORM_MARGIN` is gone and the sell side is `Σ(sold shares) ≤ units × K`
  with nothing else in it. One knob, not two. `poolAdmission()` in
  `config/plans.ts` evaluates it and the shadow meter logs it hourly —
  including the two things the inequality cannot see on its own (admins and
  comped testers, who spend the pool without selling a share).
- Still open: question 3 (static windows + pressure ladder vs moving windows —
  nothing built either way yet), the value of K once the shadow meter has
  measured it, and enforcement — nothing yet refuses a purchase that breaks
  the inequality; the log reports it.

Economics as shipped: 2.55 sellable units × $200/unit = **$510/month against
$300 cost at K = 1** — the ladder is profitable with zero overselling, which
was the point.

---

## Appendix: file by file

| file | change |
|---|---|
| `config/plans.ts` | `PlatformUsageBudget` in unit-percent; drop `budgetForShare`'s capacity lookup; `POOL_OVERSUBSCRIPTION_K` + `poolAdmission()` replace `PLATFORM_MARGIN` |
| `config/window-capacity.ts` | deleted |
| `services/platform-capacity-calibrator.ts` | deleted |
| `services/platform-credential-pool.ts` | expose `poolRate(window)` and `poolPressure()`; drop `modelWeeklyCapacityUsd`; derive `capacityUnits` |
| `agent/platform-usage-metering.ts` | one conversion at read time (`micros × rate`); gate shape unchanged |
| `agent/claude/claude-harness.ts`, `agent/codex/codex-harness.ts` | call sites unchanged in shape; add the admission wait |
| `services/agent-service.ts` | usage screen unchanged; plan copy reflects 100%-of-what-you-bought |
| `types/user.ts` | `platformUsage.buckets` unchanged — still micro-dollars |
