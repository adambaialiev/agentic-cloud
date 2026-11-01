# Historical Paddle setup — retired

> **Do not use this runbook.** Platform checkout and subscriptions were removed
> in August 2026. The current offer has no platform fee or platform card on
> file; customers pay their AI and cloud providers directly. This file is kept
> only as an implementation-history record, and none of its prices, environment
> variables or dashboard steps describe the live product.

The code side of billing is env-gated: until all four `PADDLE_*` vars are set,
the product behaves exactly as before (no agent caps, webhook 503s, recycler
treats everyone as free). This runbook is the dashboard side. Doing it in the
sandbox first is free and takes ~15 minutes; the live flow is identical after
Paddle approves the seller account + website (their review, usually days).

## What we sell

Five subscriptions: **Plus $10 / Power $50 / Max $100 / Ultra $200 / Apex
$300 a month** — 2/6/12/20/20 agents (the top two share the ceiling), a usage allowance that scales with the
price, machines never recycled, Fable from Max up. Apex (added 2026-08-16) is
the first rung whose share exceeds one full subscription (1.5), so it is also
the first one whose share (1.5) exceeds a whole subscription's window, so it
is the rung most likely to push the ops bot's ADMISSION line into "add an
account". That line is advice to the operator: nothing refuses a sale for want
of pool capacity, by decision (Owner, 2026-08-16) — capacity is bought when
the revenue arrives. (Pro $20 is still defined so existing
subscriptions resolve, but is not sold.) Plan shape lives in
`backend/src/config/plans.ts`.

Since 2026-08-15 there is **no free plan**: no subscription means no agents and
no turns, so a Paddle product is now the only way in. That makes the sandbox
path below the ONLY way to exercise a working agent as a non-admin — comp
someone with `platformPlan.enabled` if you need one without a card.

## 1. Sandbox account and product

1. Create a sandbox seller account at https://sandbox-login.paddle.com/signup
   (separate namespace from live — sandbox keys only work against
   `sandbox-api.paddle.com`, which the backend picks automatically unless
   `PADDLE_ENVIRONMENT=production`).
2. **Catalog → Products → New product**: name `Plus`, tax category
   `Standard digital goods`.
3. Add a **recurring price**: $10.00 USD, billed monthly. Copy the price id
   (`pri_…`) → this is `PADDLE_PRICE_ID_PLUS`.

## 2. Checkout settings (required for hosted checkout links)

**Checkout → Checkout settings → Default payment link**: set it to
`https://agenticcloudcomputer.com` (any domain of ours works; Paddle appends
`?_ptxn=…`). Without this, transactions are created with `checkout.url: null`
and the backend fails loudly when minting an upgrade link. Add the domain
under **Website approval** too (auto-approved in sandbox).

Two ways to break the overlay from outside the code, both silent — the buyer
sees the landing page and no checkout:

- **Pointing the payment link at a path the site doesn't serve.** Cloudflare
  falls back to the SPA shell, whose catch-all redirect sends the visitor home;
  it carries `?_ptxn` along (`RedirectHome` in `src/App.tsx`, with a test), but
  only the query survives a redirect, not a path Paddle later cares about. The
  apex is the tested case — keep it.
- **Adding a Content-Security-Policy to the site** (a `_headers` file in
  `public/`; there is none today) without `cdn.paddle.com` in `script-src` and
  Paddle's checkout frames in `frame-src`. `src/lib/paddle-checkout.ts` logs a
  console error when the script fails to load, which is the only symptom.

## 3. API key and webhook

1. **Developer tools → Authentication → New API key**: needs read/write on
   **Transactions** (checkout links) and on **Customers** (portal sessions for
   the Billing screen — without it `createCustomerPortalUrl` gets a 403 and
   subscribers lose their only self-serve way to cancel). Copy →
   `PADDLE_API_KEY`.
2. **Developer tools → Notifications → New destination**:
   - URL: `https://api.agenticcloudcomputer.com/api/webhooks/paddle` — the
     `api.` subdomain (the apex is the static landing and 405s POSTs). While
     the env vars are unset it answers 503 "Billing is not configured";
     after they land + restart, an unsigned POST gets 401 — that's the
     "fully armed" signal.
   - Type: webhook; version: latest.
   - Events: the `subscription.*` group is all we consume — at minimum
     `subscription.created`, `subscription.activated`, `subscription.updated`,
     `subscription.resumed`, `subscription.past_due`, `subscription.paused`,
     `subscription.canceled`. (Extra events are ignored harmlessly.)
   - Copy the destination's secret (`ntfset_…`) → `PADDLE_WEBHOOK_SECRET`.

## 4. Backend env

Add to the backend host env (see `infra/backend-host/backend.env.placeholder`):

```
PADDLE_API_KEY=pdl_sdbx_…
PADDLE_ENVIRONMENT=sandbox          # or: production
PADDLE_WEBHOOK_SECRET=ntfset_…
PADDLE_PRICE_ID_PLUS=pri_…
```

One `PADDLE_PRICE_ID_<RUNG>` per purchasable rung — `PLUS`, `POWER`, `MAX`,
`ULTRA`, `APEX` (and `PRO`, kept only so legacy $20 webhooks still map). The
rule is uniform and it is what makes adding a rung safe: a rung whose price id
is unset is not purchasable, so `availablePlans` hides it and the upgrade
keyboard never offers it. The **live** Apex price was created 2026-08-16 and
its id is already on the production host; a fresh sandbox needs its own.

Restart the backend and check the boot log line:
`[config] PADDLE_BILLING=enabled (sandbox)`.

## 4b. Frontend env — the fifth key

The overlay needs Paddle's **client-side** token, which lives with the
frontend, not the backend. It is public by design (it ships in the page
source), but it decides which Paddle environment the buyer's browser talks to,
so it has to agree with `PADDLE_ENVIRONMENT` — `src/lib/paddle-checkout.ts`
derives the environment from the token's `test_` prefix precisely so the two
cannot be configured apart.

- **GitHub secret `PADDLE_CLIENT_TOKEN`** → the production deploy
  (`deploy-cloudflare.yml`), which **fails the build if it is unset** rather
  than shipping a site whose checkout cannot open.
- **GitHub secret `PADDLE_SANDBOX_CLIENT_TOKEN`** → PR previews
  (`preview-deploy.yml`). A separate secret on purpose: a preview URL carrying
  the live token could take real money.

Find both under **Developer tools → Authentication → Client-side tokens** in
the matching dashboard. Changing the production token means re-running the
deploy workflow — it is baked into the bundle at build time, not read at
runtime.

## 5. End-to-end sandbox test

### Automated, no human in the loop

Both need sandbox credentials in the environment and are skipped without them,
so the ordinary suites are unaffected. Neither one can touch live money: they
talk to `sandbox-api.paddle.com` and refuse a token that isn't `test_…`.

```bash
export PADDLE_SANDBOX_API_KEY=pdl_sdbx_apikey_…
export PADDLE_SANDBOX_PRICE_ID=pri_…
export PADDLE_SANDBOX_CLIENT_TOKEN=test_…

# 1. The API contract: does Paddle still accept what we send and return what
#    we read? (checkout URL, custom_data round-trip, $10/month price)
npm --prefix backend test -- src/test/live

# 2. The browser: does a real transaction open a real overlay on the real
#    production build? Builds, serves dist/, drives Chrome. ~1 minute.
npm run test:paddle-sandbox
```

`npm run test:paddle-sandbox -- --pay` goes further: a visible browser, stopped
at the overlay for you to pay with the sandbox card `4242 4242 4242 4242` (any
future expiry, any CVC). It waits for Paddle to complete the transaction and
prints the subscription id. Feed that back as `PADDLE_SANDBOX_SUBSCRIPTION_ID`
and re-run (1) to check our webhook reader against Paddle's real subscription
entity rather than fixtures we wrote.

Reading the overlay's contents, not just finding its iframe, is deliberate: a
bad token or an unknown transaction still renders a frame, with "Something went
wrong" inside it. A selector-only assertion passes for a checkout nobody can
complete.

What automation still doesn't cover, by design: filling Paddle's card fields
(their DOM, their release schedule — a test that breaks when their UI ships is
worse than one you run before a release), and webhook *delivery* to our URL,
which is dashboard config. What a delivered webhook does on arrival is
unit-tested in `paddle-billing-service.test.ts`.

### The whole path, by hand

1. In the Workspace (the factory bot's Workspace button — its chat itself says
   nothing any more), as a user with no subscription, tap **New agent** → the
   refusal carries the cap message, and Plan & billing carries the checkout
   link. The link is for the cheapest rung that clears the cap, which with no
   plan at all (cap 0) is the bottom of the ladder, Plus.
2. Open the link; pay with Paddle's sandbox card `4242 4242 4242 4242`, any
   future expiry, any CVC.
3. Within seconds the webhook fires (boot log:
   `[Paddle] subscription.activated applied for <userId>`) and the factory bot
   says Plus is active, with the Workspace button under it. That notice is the
   deliberate exception to launcher-only silence — the bot says nothing else,
   but an entitlement someone paid for is not a courtesy message. The
   Workspace's Plan & billing screen shows the new rung on its next load.
4. **New agent** now provisions agents 2 through 6; a 7th is refused with the
   "bigger plan doesn't exist yet" message.
5. Cancel the subscription from Paddle's dashboard (or its customer portal)
   → on the effective date the user drops to free and the recycler resumes
   judging their idle machines.

## 6. Going live

Same steps in the live dashboard (https://login.paddle.com) after seller +
website approval. Nothing in code changes; five values move, in this order:

There is no ordering that avoids a mismatch window, and an earlier version of
this runbook wrongly claimed otherwise. The frontend token and
`PADDLE_ENVIRONMENT` must agree: a live client with a sandbox-minted `_ptxn`
fails to find the transaction, and so does the reverse. Between the two
changes, whichever goes first, an upgrade link opened in that gap does not
work. So the goal is a SHORT window, not a safe order — do the slow half
first:

1. Update the **`PADDLE_CLIENT_TOKEN`** GitHub secret to the live client-side
   token and re-run "Deploy to Cloudflare Pages". This is the slow half —
   build plus deploy plus edge propagation, several minutes — and it cannot be
   shortened, so it goes first and the near-instant backend flip follows.
2. Flip the four backend vars on the host (`PADDLE_API_KEY`,
   `PADDLE_ENVIRONMENT=production`, `PADDLE_WEBHOOK_SECRET`,
   `PADDLE_PRICE_ID_PLUS` — all four are new values; sandbox and live are
   separate namespaces) and `systemctl restart infinite-agents-backend`. Note
   that a Paddle webhook secret can contain `/`, so edit the env file directly
   rather than through `sed`.
3. Confirm the boot line reads `[config] PADDLE_BILLING=enabled (production)`,
   then buy Plus once with a real card and refund yourself.
4. Disable the sandbox notification destination afterwards. It keeps firing
   against the same URL, and every event now fails signature verification —
   401s that look like a problem and are not.

### What the website review checks, and where it lives

Paddle reviews `agenticcloudcomputer.com` before approving the account. Each
item they require has a fixed home; if any of this moves, verification breaks.

| Requirement | Where |
| --- | --- |
| What is sold, and for how much | `/pricing` (its own page, the link to hand a reviewer) and `/#pricing` — Free (2 agents), then Plus $10 / Pro $20 / Power $50 / Max $100 a month (2/3/6/12 agents) |
| Currency and tax treatment | `/pricing`, the landing's pricing footnote, Terms §2: USD, tax added by Paddle at checkout |
| Refund policy, labelled and linked | `/refunds`, linked from every footer; 30 days, full refund |
| Cancellation, and how to do it | `/refunds` §4 + Terms §2: manage-subscription link in the Paddle receipt, or email |
| Seller identity | Owner Example, trading as Agentic Cloud Computer — `/pricing` § "Who you are buying from", Terms §1, Privacy §1, and the footer of every legal page. Deliberately **not** in the landing footer: a marketing surface is the wrong place for it, and every route a reviewer takes from that footer passes it |
| Trading location | `ContactLines` in `src/pages/LegalLayout.tsx` — city and country, on every legal page. **Not** a street address: the one published at launch was a home address, and as merchant of record Paddle is the seller to the customer, so publishing a trading address is Paddle's duty, not ours. Paddle holds the full address from account verification. If a reviewer ever demands one on the site, rent a business address rather than restoring that line |
| Contact email | `hello@agenticcloudcomputer.com` — must actually receive mail; Paddle writes to it |
| Terms and Privacy | `/terms`, `/privacy` |
| Merchant-of-record disclosure | pricing footnote, Terms §2, Privacy §2 and §4 |
| Acceptable use (no mining, malware, resale of machines) | Terms §4 — the paragraph a compute-adjacent seller gets asked about |

The one thing a reviewer cannot do unaided is **reach a checkout**: there is no
buy button on the site, because subscribing happens in Telegram (the bot mints
a per-user transaction and Paddle's payment link opens the overlay on the
landing page — `src/lib/paddle-checkout.ts`). Say so in the submission notes
and give them the path: open @AgenticCloudComputerBot → create an agent → ask
for a second one → the cap message carries the checkout link. Without that
note the review stalls on "we could not find how to purchase".

## Cautions

- The webhook signature covers the raw body; anything that rewrites request
  bodies in front of the backend (proxy buffering is fine, mutation is not)
  will 401 every event.
- `custom_data.userId` set at checkout is how events find the user. Links are
  minted per user by the backend — never hand out a bare product link, it
  would create a subscription we cannot attribute.
- Webhook events can arrive out of order; the handler drops events older than
  the stored state, so replays/retries are safe to let run.
- There is no self-serve cancellation in the product: the site tells users to
  cancel from the link in their Paddle receipt or by email, and the second
  route is a human (you) doing it in the dashboard. If Plus gets any volume,
  surface Paddle's customer portal in the bot instead.
