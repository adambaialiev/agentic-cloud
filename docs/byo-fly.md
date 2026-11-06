# BYO-Fly — build record

> Status (2026-11-06): build record. Since note #664 (2026-09-25) a new workplace on our platform runs on the platform's Fly account and connects no cloud (section 8); since note #801 only a workplace the platform marks brings its own Fly account. Your own Agentic Cloud, the whole platform in your own Fly organization, is a different thing: `public/own-cloud.md`.

The contract is the account knowledge page **byo-fly-design** (approved
2026-08-23). This file is the code-side record: what each slice changed, the
hard-wired assumptions being unwound, and the operator steps that went with
them. Owner: Ivy.

## The "our one Fly org" assumptions (audit of 2026-08-23)

Every Fly call went through one `FlyClient` built at boot from `FLY_API_TOKEN`,
and every app was created in `FLY_ORG`. The full list, tracked as it is
unwound:

| # | Assumption | Status |
|---|---|---|
| 1 | One `FLY_API_TOKEN` read at boot, closed over by 5 client constructions (`index.ts`) | **closed for machines (slices 4.2–4.3)** — sandbox client, reaper, and image roller all resolve per app/org; deploys remain (slice 5) |
| 2 | One `FLY_ORG` slug on every `createApp`/`listApps` | **closed for machines (slices 4.2–4.3)** — same as 1 |
| 3 | Machine image only pullable from our org (`registry.fly.io/ia-machine-images`) | **closed (slice 3)** — public ghcr ref |
| 4 | App-runtime image, same problem (`:app-v2` tag, same registry app) | **closed (slice 3)** — mirrored to the same ghcr package |
| 5 | Backend's single WireGuard peer routes only our org's 6PN network | open — slice 4 |
| 6 | `machine.private_ip` SSH-reachable from the backend | open — follows 5 |
| 7 | One `BACKEND_PEER_IP` pins every machine's nftables accept | open — follows 5 |
| 8 | Fleet enumeration by `listApps(FLY_ORG)` acts on name evidence | **closed (slice 1)** — record-allowlist; unclaimed apps reported, never touched |
| 9 | One shared backend SSH keypair authorizes every machine | accepted for v1 — the keypair authorizes only us, org-agnostic |
| 10 | One Cloudflare zone (`agentbuilt.app`) for all sites/previews | stays — our address space; custom domains add Fly certs per app (slice 5) |
| 11 | Fly certs issued on apps in our org | open — slice 5 parameterizes the org |
| 12 | Reaper ownership by name prefix could stop a client's own apps | **closed (slice 1)** |
| 13 | One global `FLY_MACHINE_IMAGE` defines "current" | stays — one fleet image is correct; the REF is public now |
| 14 | Prod-vs-dev guard is `FLY_ORG` ending in `-dev` (scripts) | open — revisit when scripts act per-org |

## Slices landed

### 1. Record-allowlist ownership (PR #213, 2026-08-23)
Reaper + `roll-machine-image.mjs` walk only apps a record claims (agent
`serverId` app, `provisioningAppName`, deployment `flyApp`). Unclaimed apps
are reported on change and never walked; the corroborated orphan stop
survives only for a rogue extra machine inside a claimed app; an unreadable
user store skips the whole sweep. First prod sweep flagged `ia-ci-jobs`
(legitimately recordless) and one real leak from 2026-08-07.

### 2. Org secrets + the org→Fly binding (PR #214, 2026-08-23)
`org-secrets.ts` (owner `org:<orgId>`, key `org-env:NAME`, encrypted at rest,
excluded from every turn export by construction) and `org-fly.ts`
(`connectOrgFly` validates the offered slug+token against Fly before
committing, secret first, pointer second; `resolveOrgFlyContext` answers only
the org's own connection and fails loudly when either the pointer or token is
missing — there is no platform-token fallback).
`scripts/connect-org0-fly.mjs` executed on prod 2026-08-23: org #0 resolves
`source=org`.

Strictness correction (2026-08-26): multi-org exposed an old global-admin
exception in the agent-creation gate. A platform admin could create an agent
inside a new, unconnected org; app resolution then fell through to the
boot-time Fly client and put the machine on the platform bill. The exception
and both app-level fallbacks (agent machines and deployments) are removed.
Every org, including one created by a platform admin, now needs its explicit
validated Fly token before any Fly resource can be created or touched.

### 3. Public image (this slice)
Both image tags move to one public GHCR package,
`ghcr.io/<owner>/ia-machine-images` (`sha-<12>` = machine image,
`app-v2` = deployment runtime). The `machine-image` CI job pushes both
registries and repoints the fleet at the ghcr ref; the Fly-org copy stays as
the rollback path. `set-machine-image` now takes a two-entry registry
allowlist. Operator steps that went with it (2026-08-23): current tags
mirrored with skopeo, package flipped public once in the GitHub UI,
`GHCR_PUSH_TOKEN` added to `/etc/ia-ci/env` on ia-ci-runner,
`set-machine-image` reinstalled on ia-backend, `FLY_MACHINE_IMAGE` +
`FLY_APP_RUNTIME_IMAGE` repointed, fleet rolled.

### 4 (part 1). Per-org WireGuard peer machinery (this slice)
`OrgWireGuardService`: mint (node x25519, cross-checked byte-identical with
`wg pubkey`), register via the org's OWN token (`addWireGuardPeer` — returns
peerip, gateway endpoint, and the GATEWAY's pubkey), persist (key as org
secret, public half on `OrgDocument.fly.wireguard`), render conf, bring up
via argv-exec (`install` 0600 with the conf on stdin → `wg-quick up` →
`systemctl enable`), converge idempotently, tear down whole. Route-conflict
guard: a /48 already routed by another interface (org #0's legacy peer) rolls
the registration back and reports — never two routes fighting over the
network that carries the fleet's SSH. Lifecycle rehearsed live 2026-08-23:
register → conf → up → handshake with `ams1.gateway.6pn.dev` → remove, from
a plain Linux host. Host needs `wireguard-tools` AND `iproute2` (the agent
machine image lacked iproute2). Operator surface:
`scripts/ensure-org-wireguard.mjs --org <id> [--apply|--remove]`.

**Every attempt records its outcome** (note #642, 2026-09-23) on
`OrgDocument.fly.peerCheck` — `up` / `routed-elsewhere` / `failed`, with the
moment and, for the last two, the conflicting route or the error. Written
only when the outcome CHANGES, since provisioning converges on every machine
build; cleared with the peer. Before it, the peer's absence was the only
trace, so the Workspace read all three as "tunnel coming up" — a forecast
that could never come true for org #0, whose registration the route guard
rolls back on every single attempt. The card states the recorded outcome now,
and says nothing at all when there is none.

Two consequences of keeping it, found the same day on org #0's card, which
read "not up" rather than "already reachable": its Fly org held
`ia-backend-8d47d7ff`, a peer one failed roll-back had stranded, so every
registration collided with that name and threw. (It was removed by hand.) So
a `routed-elsewhere` outcome now keeps its `network`, and the next converge
re-checks that ROUTE on the host instead of registering with Fly only to roll
back — the round trip that ran on every machine build and could strand a peer
each time. And a registration that fails with nothing usable recorded removes
any peer holding our own name and tries once more; a second failure is the
real one. A failed roll-back is logged rather than swallowed.

### 4 (part 2). The sandbox client resolves each app's org (this slice)
`FlyAppOrgContextResolver` (app → owner → membership → org → that org's
token/slug/peer, from the same records the allowlist trusts; 5-min cache, one
FlyClient per org) plugs into `FlySandboxClient.resolveAppContext`. Every Fly
API call and the machine-env peer pin now use the owning org's context; the
boot-time context is never substituted once org routing is installed:
unclaimed apps, resolver errors, and unconnected orgs fail closed. Creation
resolves too: `onAppNamed` writes the provisioning marker before the app
exists on Fly. `agent-service` also checks the explicit connection
before reserving a machine so the user sees the useful action instead of a
low-level provisioning failure.

### 4 (part 3). Per-org sweeps (this slice)
`OrgStorage.listOrgs` + the reaper sweeps every connected client org after
the default one — same allowlist, same gates, same unrecorded-app report,
each app remembering which org's client may touch it; a failing client-org
listing degrades to the default sweep, never blocks it. The image roller
resolves its client per app (`resolveFlyClientForApp` → the app→org
resolver), so a client-org machine's config writes ride that org's token.

### 4 (part 4). END-TO-END PROVEN (2026-08-23)
A real agent machine in a real client org, through the production path.
Scratch Fly org `ia-scratch-client` (created by Owner; org-scoped token as
the Workspace secret `FLY_SCRATCH_ORG_TOKEN`), then on the backend host:
`scripts/e2e-byo-fly.mjs setup` (org record + member + agent record,
`connectOrgFly` validated and stored the token) → `ensure-org-wireguard
--apply` (peer `ia-backend-f9f4201f`, interface `iaorg-f9f4201f`, network
`fdaa:bd:1a93::/48`, handshake immediately, enabled across reboots; the
route-conflict guard correctly did NOT fire — different /48) →
`e2e-byo-fly.mjs provision`: the resolver chose the scratch org from the
provisioning marker, the machine was created there with the scratch token,
booted the PUBLIC ghcr image, pinned its firewall to the scratch peer, and
answered `execSync` over the new tunnel. Torn down after; **the scratch org
stays connected as the standing rehearsal ground** (peer up, zero apps), so
every prod sweep now exercises the multi-org path continuously.

Two things the rehearsal caught, both fixed:
- `install -m 600 /dev/stdin` fails with ENXIO when stdin is Node's exec
  pipe (a socketpair) — the conf write is now create-0600-then-`dd`.
- backend.env stores `\n`-encoded SSH keys; `index.ts` normalizes them
  (`decodeMultilineEnv`) and any script constructing a sandbox client from
  raw env must too, or machine auth fails.

### 5 (part 1). Deploys land in the owning org (this slice)
The deployment service resolves each app's org exactly as the sandbox client
does: `flyApp` is persisted on the record BEFORE the first Fly call (the
onAppNamed pattern), so the app→org resolver answers from creation onward;
app, IPs, volume, machine, certificate all ride the owning org's token, in
its slug, with the machine's firewall pinned to that org's peer. The
`<name>.agentbuilt.app` cert + CNAME mechanics are unchanged — Fly validates
per app wherever it lives. Tarball sync and restarts already resolved
per-app via the sandbox client (slice 4.2). Fallback: the boot-time context,
same token-isolation safety argument.

### 5 (part 2). Custom domains as a first-class verb (this slice)
`agentbuilt domain add <site> <hostname>` issues the Fly certificate on the
site's app — in whatever org it lives — and prints the ONE CNAME record the
domain's owner must create (their DNS is theirs; we instruct, never write).
`domain status` reads issuance back from Fly; `domain remove` deletes the
certificate (reversible — re-adding reprints the same instruction, which is
why it may be an agent verb while deleting a site never is). Hostnames on
our own zones and *.fly.dev are refused. Identity v62 documents the verb on
every machine; the CLI help's stale plan-tier text went with it.

### 6. Cost guardrails, v1 (this slice)
**Spend visibility:** `agentbuilt workplace spend` → `GET /org/spend` →
`OrgSpendService` walks the org's whole Fly account (deliberately not
record-scoped — an app we did not create still bills the client, and the
bill-payer's view must not hide it) and prices every machine and volume
from `config/fly-cost-estimates.ts` (published Fly prices as of 2026-08,
labelled estimates, Fly dashboard the authority). Running/stopped split is
the headline: a slept machine costs its volume and almost nothing else.
One exception since note #635: a machine a record gives to ANOTHER workplace
(two workplaces on one Fly account, or a site moved away with its app left
behind) is counted in `machinesElsewhere` and not listed or totalled — it is
that workplace's to read. Anything no record attributes is still listed.
Identity v63 teaches the verb. Agent machines are uncapped: the workplace
owns its cloud bill and controls its roster. `ORG_DEPLOYMENT_LIMIT` (50)
remains env-overridable and enforced org-wide at deploy beside the per-user
backstop, refusing with the honest reason (the org's cloud bill) and the door
(the org admin).

### 7. Connect-your-cloud in the Workspace (this slice — the LAST)
The org screen grows a Cloud-account block: connected → the slug, the
tunnel state, and the spending door, for every member; not connected → the
paste form (slug + org token) for an admin, one honest line for a member —
never a form the backend would refuse. `POST /api/org/fly` (admin-gated)
validates the pair against Fly BEFORE committing, stores via
`connectOrgFly`, then brings the WireGuard tunnel up in the same request —
a tunnel failure leaves the account connected with the peer `pending`,
never a refused connect. `GET /api/org/spend` feeds the Cloud-spending
screen (rows, totals, disclaimer). `OrgWireGuardService` is now wired at
boot with a local argv exec — the backend runs as root on the control-plane
host. **This completes the workstream's build**; what remains is
operational: white-glove the first client through the screen, and set real
guardrail thresholds from the pilot.

### 8. Hosted workplaces — no token required (note #664, 2026-09-25)
The owner reversed the requirement this workstream was built around: "we
should not require fly cloud token. we should run user's cloud on our fly
account", then "we sponsor", limits of "20 agents. 10 sites" per workplace,
and no bring-your-own option. The funnel is why: of the five outside people
who made a workplace between 2026-08-30 and 2026-09-25, none got past the
token step.

- **Hosted = no `OrgDocument.fly`.** Not a stored flag, so it cannot
  disagree with resolution (`services/hosted-workplace.ts`
  `isHostedWorkplace`).
- **Two verbs in `org-fly.ts`.** `resolveHostingContext` (own account, else
  the platform's `FLY_ORG`/`FLY_API_TOKEN` as `source: 'platform'`) is used
  ONLY by the app→org resolver, i.e. agent machines, sites and the image
  roller. `resolveOrgFlyContext` still answers "the workplace's OWN account"
  and still refuses a hosted one, so git host, git backup, media bucket,
  org CI and the spending walk can never be aimed at ours. A connected
  pointer whose token is missing still refuses in both verbs.
- **Peer pin.** The resolver now gives every machine in the platform account
  `FLY_BACKEND_PEER_IP`, hosted workplaces and org #0 alike. Org #0 never had
  a tunnel of its own (its network is the host's), so since slice 4.2 its
  new machines booted with NO `BACKEND_PEER_IP`; the image also lacks
  `iproute2`, so its own-/48 fallback could not read an address and the
  whole nftables firewall was skipped (sshd :2222 open to the org network).
  A machine already built that way is given its pin on its next image roll
  (`machine-image-updater.ts`), which only ever ADDS a missing one.
- **A Fly account shared by several workplaces** (our six internal test
  workplaces all point at `acme-trading`) has ONE tunnel on the host, owned
  by whichever workplace converged first. Every later one records
  `routed-elsewhere` and has no peer of its own, and its machines are reached
  through the sibling's interface, from the sibling's address. The resolver
  now pins them to that sibling peer (same `orgSlug`, never another
  account's). Found by the watch below on its first run: "Jone's workplace"
  (three agents and one bot site) had booted with no pin;
  pinned by hand the same day, the site with a 12-second restart, and the
  unclaimed machine `ia-a7c3688952b2802d` in that account was removed.
  `org-msg-host.ts` picks its pin the old way (own peer, else the platform's).
  It has been on in production since `FLY_MSG_HOST_IMAGE` was set, and a
  green `msg-host-image` build repoints that setting (note #819).
- **The watch** (same day, after the hand fix): the idle reaper audits every
  agent machine it walks and every RECORDED site (read-only) once an hour,
  and alerts through the ops notifier — once a day per machine — when one
  runs with env but no `BACKEND_PEER_IP`. prospect-desk, always on, was the
  one that needed a restart to take its pin.
- **CI machines** replace the image's entrypoint (no sshd, no firewall), so
  `runner-agent.sh` walls them off itself: an nft table dropping everything
  arriving from `fdaa::/16`, loopback and replies untouched, logged in the
  job's own log ("private network walled off").
- **Isolation between hosted workplaces** is that per-machine firewall (drop
  all fdaa::/16 inbound but the public port and exposed ports), not separate
  6PN networks — `FlyClient` can create an app on a custom `network`, but
  each would need its own WireGuard peer and interface on the control plane.
- **Limits.** `HOSTED_AGENT_LIMIT` (20) in the agent-creation gate, counting
  the workplace's agents across all members (not pending reservations, not
  `purpose` helpers); `HOSTED_SITE_LIMIT` (10) at deploy, live + provisioning.
  Workplaces on their own cloud keep `ORG_DEPLOYMENT_LIMIT` and no agent cap.
- **No connecting.** `POST /api/org/fly` refuses a hosted workplace (409);
  only one already connected may rotate or move. Its machines are in OUR
  account, and a pointer moved elsewhere would strand every one of them.
- **Spending.** `/api/org/spend` and `agentbuilt workplace spend` answer a
  hosted workplace with "no bill" and its usage; `api/org/cloud` never walks
  our account for its machine counts. The Workspace draws `HostedCloudCard`.
- **Setup.** The cloud step is gone (`/setup/cloud` still resolves). Founding
  waits only for a subscription; a founder whose subscription is carried in
  (founder door, or switching into their spare) is founded from the state
  read, never while they wait on a join request.
- **Deletion.** A hosted workplace's agent machines and sites are DESTROYED
  with it — nobody else could ever remove them from our account.
- **Media** for a hosted workplace rides the platform store (it used to throw
  on the first write for any unconnected workplace).

## Still ahead
- A deployment-ceiling approval card (tap-to-raise on the admin's org screen)
  once a pilot shows where that guardrail actually binds.
