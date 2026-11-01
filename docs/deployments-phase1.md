# Historical: production deployments on agentbuilt.app — Phase 1 design

Decided with Owner 2026-08-04. The apps domain **agentbuilt.app** is purchased
and lives in the platform's Cloudflare account.

> **Historical record; do not quote its prices or billing model.** Checkout,
> plan tiers and per-site allowances are retired. Hosting currently has no
> separate price, and the product has no platform fee; customers pay their own
> cloud provider. The lifecycle discussion below is retained for engineering
> history, while README and the live CLI instructions are the current contract.

## The product

An agent builds something and previews it on its own machine (port 8080 — the
existing story, unchanged: it sleeps with the machine). When the user says
"make it production", the agent quotes a monthly price and sends a checkout
link. **Payment creates the machine** — a separate, small, always-on Fly
machine that never sleeps with the agent, at `https://<name>.agentbuilt.app`.
Any number of machines per user; each is a line item on their Paddle bill.

Three machine sizes, chosen by the agent (they are sizes, not prices — see the
banner at the top):

| Preset | Guest | What runs |
|---|---|---|
| `static` | shared-1x, 256 MB | caddy file-server on the synced site dir |
| `service` | shared-1x, 512 MB | the app's own `run.sh` (node etc.) |
| `service-pro` | shared-1x, 1 GB | the same, for a heavier app |

Static machines may autostop/autostart under the hood (invisible: Fly's proxy
wakes them per-request in well under a second). Service machines run always-on
— cron jobs, websockets, background work must not cold-start.

## Why a separate machine, not the agent's

The agent machine's lifecycle is tuned for conversations: idle-stop after
15 min (fly-idle-reaper), free-tier recycle after 3 days. Production hosting
must be bound to *payment*, not activity. A deployment machine is created by
payment, stopped by dunning, destroyed only after a long grace — the reaper
and recycler never touch it.

## Architecture

### Deployment record (new collection `deployments`)

```
{
  id, userId, agentId,
  name,                 // subdomain, validated /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/
  preset: 'static' | 'service',
  flyApp,               // iapp-<hex12> — distinct prefix from agent apps (ia-<hex16>)
  machineId, volumeId,
  status: 'pending-payment' | 'provisioning' | 'live'
        | 'payment-lapsed' | 'stopped' | 'destroyed',
  paddle: { subscriptionId, priceId },
  createdAt, lastDeployAt, lapsedAt?
}
```

`name` uniqueness is enforced by the collection (and defensively by the DNS
record create). The Fly app slug stays opaque; the public name lives only in
DNS.

### Runtime image (`infra/app-runtime-image/`)

A minimal sibling of the agent image, reusing its entrypoint patterns:

- sshd on 2222, backend key only, same nftables rules (2222 from backend peer,
  8080 public, drop other 6PN) — this is what lets the backend sync files.
- Entrypoint: if `/data/site/` exists → caddy `file-server` on 8080;
  else if `/data/app/run.sh` exists → exec it as the app user.
- Volume `iaapp` mounted at `/data` (1 GB static / 3 GB service, auto-extend).
- Built by the existing image workflow pattern, pushed to
  `registry.fly.io/ia-machine-images` under an `app-<sha>` label
  (`FLY_APP_RUNTIME_IMAGE` env, same consumption pattern as `FLY_MACHINE_IMAGE`).

### Provisioning (`deployment-service.ts`, sibling of fly-sandbox-client)

Reuses `FlyClient`: `ensureApp` (slug `iapp-<hex>`) → volume → machine with
`buildPublicHttpsService(8080)` baked in → `ensureSharedIpv4`. Then:

> **Superseded on 2026-10-16 (note #766):** a site has no DNS record of its own
> any more. The zone's one proxied wildcard record sends every `*.agentbuilt.app`
> name to the preview-router Worker (`infra/preview-router`), which asks the
> backend (`GET /api/preview-map/<name>`, answered from the deployment records by
> `PreviewDomainService`) and forwards to `<flyApp>.fly.dev`; a renamed site's old
> name is answered with a 301 the same way. Deploy, rename and delete write no
> record and issue no certificate for `<name>.agentbuilt.app`. The CNAME step
> below is kept as history; `backend/scripts/drop-site-cnames.mjs` moved the
> existing sites over. A customer's own domain still works as in phase 3.

1. **DNS**: Cloudflare API, CNAME `<name>` → `<flyApp>.fly.dev`, **unproxied**
   (grey cloud — Fly must terminate TLS for the cert to issue). Token is a new
   env `CLOUDFLARE_APPS_DNS_TOKEN` scoped to zone:DNS:edit on agentbuilt.app
   only + `CLOUDFLARE_APPS_ZONE_ID`.
2. **TLS**: Fly GraphQL `addCertificate(app, "<name>.agentbuilt.app")` — free
   Let's Encrypt, auto-renewed. (Rate limit 50 new certs/domain/week — fine
   for launch; a wildcard cert is the scale escape hatch later.)
3. **Sync**: the CLI uploads a tarball to the backend, which streams it to
   the deployment machine over its SSH access → `/data/site.new/`, then
   atomic swap and (service preset) restart. Agents keep holding zero cloud
   credentials.

### The `agentbuilt` CLI (decided 2026-08-04: CLI, not harness tools)

Agents manage production through a CLI exclusive to our machines — baked into
the agent image, documented in skel/CLAUDE.md, runnable and scriptable like
flyctl. This replaces the earlier harness-tool design: one surface that works
identically under Claude Code and Codex, composable in the agent's own
scripts and cron jobs.

```
agentbuilt deploy <dir> --name <name> --preset static|service
agentbuilt list                       # names, URLs, presets, statuses, prices
agentbuilt status <name>
agentbuilt logs <name> [-n 200 | --follow]
agentbuilt restart <name>
```

- `deploy`, first time: the backend creates the `pending-payment` record and
  the CLI prints the price + Paddle checkout link for the agent to relay.
  After the payment webhook fires, the backend provisions and notifies the
  user in the agent's chat — the agent's turn does NOT block on payment.
- `deploy`, existing live name owned by this user: the CLI tars the directory
  and uploads; the backend streams it to the deployment machine, atomic-swaps,
  restarts (service preset). Redeploys are free, instant, unlimited.
- No `destroy` and no `resize` in the CLI on purpose: teardown follows
  cancelled billing only (dunning below), and a bigger machine is a different
  price — a new quote, not a flag.

**Auth: per-agent platform token, zero cloud credentials.** The CLI talks
only to a new backend API (`/api/agent-cli/*`), authenticated by
`AGENTBUILT_TOKEN` — minted per agent machine at provisioning, injected via
the existing `buildMachineEnv()`, stored hashed on the agent record, revoked
on recycle/rebuild. The token maps to `{userId, agentId}` and grants exactly
the five commands above, entitlement-checked per user — never Fly, Cloudflare,
or Paddle access. Worst case under prompt injection is a bad redeploy of the
user's own site, which the next redeploy fixes.

- Package lives in-repo (`cli/agentbuilt/`) as a single zero-dependency file.
  Distribution changed in slice 2b: instead of baking it into the agent image,
  the backend serves the file at `/api/agent-cli/install/agentbuilt` (the
  build copies it into `dist/`), and the identity writer drops a `~/.boot.d`
  hook on each machine that installs it and re-installs after image rolls.
  One distribution path covers new AND existing machines, and the CLI ships
  in lockstep with its API — they deploy together, so no version skew.
- skel/CLAUDE.md + AGENTS.md: replace the "offer to deploy to hosting the
  user owns" guidance with the production story (preview vs production, the
  quote-first flow, redeploys, `agentbuilt --help`).

### Paddle

Two recurring prices: `hosting_static` $5, `hosting_service` $10
(env `PADDLE_PRICE_ID_HOSTING_STATIC|SERVICE`; sandbox created 2026-08-05,
live pending).

**Revised in slice 3 (decided with Owner 2026-08-05): one single-item
subscription PER HOSTED SITE, for every user** — subscriber or not — instead
of the multi-item single-subscription sketch below. Why: the Paddle portal
(our users' only self-serve billing surface) can only cancel a whole
subscription, so under multi-item, cancelling one site would have killed the
plan and every other site, and "which site did quantity 3→2 cancel?" has no
good answer. Per-site subs make portal-cancel kill exactly that site.
Cost: Paddle's $0.50 fixed fee per extra invoice for multi-site users —
accepted.

- Every first deploy returns a **checkout transaction** for the hosting
  price, `custom_data: { kind: 'hosting', userId, deploymentId, preset }`.
  Paddle copies that onto the subscription it mints — the webhook's routing
  key. A checkout never touches the plan subscription.
- Webhook (`paddle-billing-service.ts`): events whose custom_data carries
  `kind: 'hosting'` OR whose items map to a hosting price id are routed to
  hosting fulfilment and NEVER the plan mirror (a $5 site must not grant or
  revoke a plan). Fulfilment: paid status + `pending-payment` → provision in
  the background (staged content included) and notify the user in the
  agent's chat; paid + `payment-lapsed` → resume (+ deliver any staged
  content); canceled/paused/unpaid → stop, data kept. `past_due` stays up,
  like plans. Stale events drop via `paddle.lastEventAt` on the deployment.
- **Revival** of a lapsed site is a fresh checkout bound to the same
  deploymentId (canceled Paddle subs can't reactivate) — `agentbuilt deploy`
  to a lapsed name returns that link with the new content staged.
- `UserBillingState` gains nothing; deployment state lives on the
  deployment records.

### Lifecycle & dunning

- `past_due` keeps machines live (matches `PLAN_GRANTING_STATUSES`).
- Canceled/unpaid hosting item → **stop** machine immediately, 7-day grace
  (URL shows nothing; data intact), then **destroy** at 30 days. Before
  destroy, the agent is told and offers the user a tarball of the app.
- fly-idle-reaper + fly-agent-recycler skip all `iapp-` apps by prefix
  (belt: reaper's `skipAppNames`; suspenders: prefix check in `decideStop`).
- Runtime metering: reuse `machine-runtime-meter` with per-deployment keys so
  `machine-usage-report.mjs` shows hosting cost vs revenue.

### Abuse guardrails (launch-minimum)

Deployments require a *paid* checkout by design (no free production machines).
Names pass a denylist (login, wallet, bank, verify, support, admin, and the
platform's own brand names). The kill switch is `destroySandbox` on the
deployment app + DNS record delete — one operator script:
`backend/scripts/deployments.mjs list|stop|destroy`.

## Out of scope for Phase 1

Custom domains (phase 3: `fly certs add` + a bot conversation for DNS),
always-on tier upsell for static, egress metering (watch the usage report
first), databases/managed Postgres, multi-machine apps, previews on the
production URL.

## Needed from Owner

1. **Cloudflare DNS token** scoped to agentbuilt.app zone only (Zone → DNS →
   Edit) + the zone id — goes into backend env as
   `CLOUDFLARE_APPS_DNS_TOKEN` / `CLOUDFLARE_APPS_ZONE_ID`.
2. **Paddle prices**: sandbox first (existing sandbox key may create them if
   it has catalog perms — verify), then the two live prices (the live runtime
   key lacks catalog perms; same one-off path as the plan prices).

## Build order (one PR per slice)

1. `infra/app-runtime-image/` + image workflow label.
2. `deployment-service.ts` (provision/sync/destroy) + `deployments` storage +
   `/api/agent-cli/*` routes + per-agent token minting + `cli/agentbuilt/`
   package (+ agent-image install) +
   reaper/recycler skips + operator script. Testable end-to-end on dev with a
   hand-created record before any billing exists.
3. Paddle prices + webhook reconciliation + checkout flow.
4. Agent tools + skel guidance + concierge billing-screen rows.
5. Site copy: pricing page "+ $5/mo per hosted site" note (Pricing.test.tsx
   number-agreement applies), landing mention if wanted.

## Unit economics (Fly prices fetched 2026-08-04, ams; Paddle 5% + $0.50)

| | static $5/mo | service $10/mo |
|---|---|---|
| Net after Paddle | $4.25 | $9.00 |
| Compute | ~$0.17 (autostop; $2.02 if awake 24/7) | $3.32 (512 MB, always-on) |
| Storage (rootfs + volume) | ~$0.25 | ~$0.45 |
| Egress (typical) | ~$0.04 | ~$0.10 |
| **Profit / margin** | **≈ $3.80 / ~75%** (worst ≈ $1.90 / 38%) | **≈ $5.15 / ~52%** |

- Egress is $0.02/GB → break-even at ~190 GB/mo on static (~2M page views).
  Fair-use line in ToS at 100 GB/mo; watch via machine-usage-report before
  building enforcement.
- 1 GB RAM costs $5.92/mo → NOT a quiet upgrade on the $10 tier; it is a
  future $15–20 tier.
- Paddle's $0.50 fixed fee is 15% of a $5 charge — annual prepay later cuts
  fees to ~6%.
- Shared IPv4, certs, and inbound transfer are free; dedicated IPv4 ($2/mo)
  is not needed.


## Hosting joins the plan (2026-08-16)

The per-site subscription is gone. What replaced it, file by file:

- `config/plans.ts` — `PlanSpec.siteLimits` (`{ static, service }`, `Infinity`
  for unlimited) plus `siteCapacity()` and `nextPlanForSites()`. Counted per
  KIND so a website can never eat the app slot the user is waiting on, and a
  `service-pro` counts as a `service` (a bigger machine is not another site).
- `services/hosting-fulfilment.ts` — NEW, and the reason this is more than a
  copy edit. Building a site and announcing it used to live inside
  PaddleBillingService, because a machine was only ever built when a payment
  webhook said so. It now stands alone: `startBringUp` / `startResize` /
  `resumePending`, driven by the deploy route, so a backend with no Paddle
  configured at all (every dev machine) can take a site live.
- `routes/agent-cli.ts` — the deploy route checks the allowance and starts the
  build; the refusal names the rung that would fit and says whose move it is.
  `upgrade` resizes directly (it used to put a priced confirmation card in the
  user's chat). Both list and deploy answer with the allowance, so an agent
  can see there is room before it packs a tarball.
- `services/paddle-billing-service.ts` — two jobs left. A legacy per-site
  subscription being CANCELLED must not take the site down while the owner has
  a plan (the operator is cancelling all of them; each arrives here as an
  event that used to mean "stop"). And the PLAN's edges are now the sites'
  edges: a subscription ending pauses them, starting one restores what the
  rung has room for, oldest first. Moving between rungs never touches a
  running site — allowances block the next site, they never take back one that
  exists.
- Copy: the identity block (v47), the CLI's help, the Workspace's Sites rows,
  /pricing and the landing page. The rule everywhere is the same — never quote
  a price for a site, because there isn't one.

Grandfathering, deliberately identical to `agentCapacity`'s: an account over
its allowance keeps every site it has, and only the NEXT one is refused.

Still open, and worth doing: there is no self-serve way to REMOVE a site, so a
slot on the $10 rung is freed by `rename` + redeploy or by an operator. That
gap did not matter when a site was a subscription you could cancel.
