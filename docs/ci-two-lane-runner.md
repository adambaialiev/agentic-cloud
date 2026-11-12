# CI for every user — the two-lane runner

Today CI is one Hetzner box (`ia-ci-runner`, <ci-runner-host>) hard-wired to one
repo: `REPO` is an env constant, the work checkout is singular, the queue is
strictly serial. This doc is the design for making CI serve **any platform
user's repo** — and for a security split that is worth doing even if the
product half never ships.

Companion docs: [`ci-status-miniapp.md`](./ci-status-miniapp.md) (where results
are displayed — this doc is where they are produced),
[`agent-git-phase1.md`](./agent-git-phase1.md) (the git host whose
`post-receive` webhook triggers all of this).

## The forcing fact: the runner is a credential vault that executes strangers' code

What sits on `ia-ci-runner` right now, all readable by the `runner` user that
executes jobs:

| Material | Where | What it reaches |
|---|---|---|
| `deploy_key` | `~/.ssh/` | root-trusted SSH on **both** backend hosts (prod + dev) — `run-job.sh:11` |
| `FLY_API_TOKEN` | `/etc/ia-ci/env` | pushes to `registry.fly.io/ia-machine-images` (`:132,191`) — the image **every user's agent machine boots from** |
| `CLOUDFLARE_API_TOKEN` + account id | `/etc/ia-ci/env` | the public site (`:107`) |
| `GH_TOKEN` | `/etc/ia-ci/env` | the GitHub repo + statuses |
| docker group membership | — | root-equivalent on the box |

And on that same box, the `checks` job runs `npm ci` twice (`run-job.sh:36-37`).
npm lifecycle scripts execute arbitrary code from the dependency tree.

This is safe today for exactly one reason: **every commit the box has ever
built, we wrote.** The moment any other user's repo runs there, one
`postinstall` script away from `/etc/ia-ci/env` is the whole platform: prod,
the public site and the boot image of the entire fleet. There is no
sandboxing story on that box worth writing down — separation has to be
physical.

So the design splits by **trust**, not by load:

```
                       ┌─────────────────────────────────────────────┐
 push / PR ──webhook──▶│ dispatcher (daemon.mjs, evolved)            │
                       └──────┬──────────────────────────┬───────────┘
                              │ untrusted: checks        │ trusted: deploys
                              ▼                          ▼
                     ┌──────────────────┐      ┌──────────────────────┐
                     │ LANE A            │      │ LANE B               │
                     │ Fly machine per   │      │ ia-ci-runner         │
                     │ job, ephemeral,   │      │ (Hetzner, the keys)  │
                     │ ZERO platform     │      │ OUR repo only,       │
                     │ credentials       │      │ never runs npm ci    │
                     └──────────────────┘      └──────────────────────┘
                              │                          │
                              └────────► commit status + log tail ◄───┘
                                    (POST /api/internal/git/statuses)
```

## Lane A — untrusted checks, one Fly machine per job

A CI job is an agent machine with a shorter life. That sentence is most of the
design, because the platform already operates thousands of the long-lived kind:

| Need | Already exists |
|---|---|
| create/destroy machines | `FlySandboxClient` (`fly-sandbox-client.ts`, 1128 lines): `createMachine`, `execSync`, `uploadToSandbox`, `destroySandbox`, wake-on-connect |
| reach them privately | SSH over 6PN on :2222, backend-peer-pinned by the image's nftables rule |
| kill leaks | `FlyIdleReaper` (15-min idle stop) — extended with a hard wall-clock kill for CI machines |
| build/ship images | the `machine-image` job: build → smoke test → `registry.fly.io` → repoint |
| clone the repo under test | the same agentbuilt-token smart-HTTP auth every agent machine uses |

Per-job Firecracker is a *stronger* isolation story than most commercial CI
(shared runners with container isolation). It is the one thing about this
design worth advertising.

### What a job machine is

- **One Fly app for the whole lane** (`ia-ci-jobs`), not app-per-job.
  App-per-agent exists because a public hostname is an app-level resource
  (`fly-sandbox-client.ts:34-46`); a CI job has no hostname, no volume, no
  public IPv4 — so the expensive parts of `createAgentSandbox` fall away and
  creation is one `createMachine` call.
- **No volume.** The rootfs is ephemeral and that is the feature: every job
  starts pristine, nothing a hostile build writes survives the run.
- **Guest size** `shared-2x-2048mb` to start — the same `FlyMachineGuest`
  shape the client already passes (`fly-client.ts:39-41`). Revisit with data.
- **Environment in, artifacts out.** The runner-agent (below) receives job
  parameters via machine env at create; it delivers results by POSTing
  outward. Nothing on the backend ever executes job output; it stores and
  renders it.

### What runs inside

A small **runner-agent** — one file, the in-machine sibling of `run-job.sh`:

1. clone the repo at the sha (over the git host's existing smart HTTP, with a
   short-lived token — see Credentials)
2. run the job script
3. stream/append the log locally; on exit, POST the terminal status + log tail
   (64 KB cap, per the status doc) to the backend
4. exit; the dispatcher destroys the machine

**Job definition, phase by phase.** Phase 1 has no user-authored config: the
only Lane A customer is our own `checks` job, ported verbatim from
`run-job.sh:35-45`. Phase 2 reads a committed `.agentbuilt/ci.sh` from the
repo under test — deliberately a shell script, not a YAML dialect: the
audience is agents, which write shell fluently, and the sandbox is the
security boundary, so there is nothing for a config schema to police.

### Credentials, precisely

The machine receives exactly two, both scoped to be worthless if exfiltrated:

- **A read-only, single-repo, short-TTL git token**, minted by the backend per
  job. This is a new token kind — `/git/verify` (`agent-cli.ts:610`) accepts
  only full agent tokens today, and this gap is already on the migration list.
  The verify response gains a `scope` the git host enforces: this repo,
  read-only, expired after the job's deadline.
- **A status-post token bound to `(repo, sha)`**, so a hostile job can lie
  about *its own* result — which it could do anyway by faking its tests — but
  cannot touch any other commit, repo, or user.

`agentbuilt secret` values are **absent in phase 1**. Injecting user secrets
into a machine that runs code from a pushed branch re-opens the exfiltration
hole one tier down (any collaborator-pushed branch reads the owner's keys).
When secrets become necessary (phase 3), they are opt-in per repo per secret,
and only for jobs on the protected branch — the branch pushes can't reach
without the owner's approval.

### The cache question — decide with a stopwatch, not taste

Cold `npm ci` on every job is the difference between a 2-minute check and an
8-minute one, and it decides whether Lane A feels usable. Options, cheapest
first:

1. **Bake our deps into a CI image variant** — solves our repo only, but our
   repo is the only phase-1 customer. A weekly rebuild keeps it near-fresh;
   `npm ci` against a warm `node_modules` is a delta install.
2. **Registry proxy** (`verdaccio` on the 6PN) — helps every tenant, no
   cross-tenant state, but only cuts network time, not install CPU.
3. **Per-user cache volume** — the classic answer and the classic mistake:
   volumes attach to one machine at a time (serializes a user's jobs), and a
   cache written by a hostile build poisons the next run. **Not in this
   design.** If cache-across-jobs is ever wanted, it is copy-in/copy-out of a
   tarball via object storage, never a shared writable mount.

Phase 0 measures a real cold job (the only recorded timing, `TEST_TIMING.md`,
is from 2026-04 and predates today's test suite); phase 1 ships with (1) and
observed numbers decide whether (2) is worth a box.

### The image

Reuse `ia-machine-images` at first: it already has node, git, build tooling,
and Fly caches image pulls per host, so a popular image is a warm boot. It
also carries the claude/codex CLIs, which CI never runs — dead weight,
but weight that is already paid for. Split a lean `ia-ci-image` out of the
same Dockerfile only when boot time measurably says so. (The nftables
SSH-pinning and entrypoint contract come along for free, which matters more
than the wasted megabytes.)

Since 2026-09-20 it also carries a **pinned Chrome**, its shared libraries and
Liberation. The browser stage was fetching ~500 MB on every job — about a
minute of every check, 1,300 times a month, to arrive at the same bytes. That
is the image-reuse bet paying a second time: one place to bake it serves CI
and every agent machine, whose Chrome libraries used to vanish on each roll.
`.agentbuilt/ci.sh` still installs when the image has none, so an older image
mid-roll and a workbench both keep working, and the pin means the browser
changes when somebody edits the Dockerfile rather than on whichever Tuesday
`chrome@stable` moved.

Since note #1167 (12 Nov 2026) it also carries **Docker**, so a repository's
`ci.sh` can run `docker compose up -d --wait && <tests>`. Lane A overrides
the entrypoint, so nothing starts the daemon at boot; the first `docker`
command does (`infra/fly-machine-image/docker/`). A job machine has no
volume and Docker cannot run on the overlay root, so its data goes on a
sparse ext4 file loop-mounted at `/var/lib/docker` — about 5.7 GB on a
performance-4x. Measured on a lane-A machine: daemon up in about a second,
Postgres + nginx pulled, started and healthy in 20 s. Docker Hub pulls go
through `mirror.gcr.io` (Docker Hub allows 100 anonymous pulls an hour per
address). Every run pulls again; a pull-through registry in our org would save
part of those 20 s per run and is not built — decide it with the stopwatch,
like the cache question above, once real repositories use it.

### Abuse — the price of "any platform user"

Free ephemeral VMs triggered by `git push` are a cryptominer's API. Lane A is
not public until all four exist; the first three are phase-1 requirements
anyway, and they are dispatcher-side, not in-machine (a hostile job can't
negotiate with a wall clock it doesn't host):

- **Hard wall-clock kill** per job (default 30 min; 15 until 2026-09-05, when
  our own checks took 13.6 min on a busy host and the next push was killed
  with nothing red) — enforced by the dispatcher destroying the machine, with
  the reaper as backstop.
- **Concurrency cap per user** (1–2 jobs) and a queue depth cap.
- **No network egress allowance beyond what a build needs** — phase 1
  inherits the image's nftables posture; a real egress policy (registry +
  git host + status endpoint, default-deny) is listed as an open question
  because it constrains legitimate builds too.
- **Plan gating**: CI runs for paid users, or a small monthly minute budget on
  free tier. A product decision, listed here so the phase plan can't quietly
  skip it.

## Lane B — trusted deploys, unchanged box, shrunken attack surface

`deploy-prod`, `deploy-site`, `machine-image`, `self-update`
stay on `ia-ci-runner` with the keys. Two rules, newly explicit:

1. **Lane B never builds another user's repo.** Structurally: the dispatcher
   routes by `(repo, jobKind)`, and Lane B accepts only our repo's deploys.
2. **Lane B stops running `npm ci` on unreviewed code.** Its jobs today run
   installs (`run-job.sh:59` for the artifact build); the artifact-build step
   moves to a Lane A machine, which hands back a tarball, and Lane B's job
   shrinks to: verify, rsync, restart, health-check. The box that holds the
   prod key becomes a box that never executes package lifecycle scripts at
   all — which was the point of the whole split.

The dispatcher itself (today's `daemon.mjs`) stays on the Hetzner box,
evolved: it keeps its queue, self-update, and webhook listener, gains the
route table and the Fly machine lifecycle for Lane A. Its `REPO` constant is
already dead per the status doc (identity from the delivery payload); killing
it is what makes the dispatcher multi-repo.

## What this looks like per user

The user story that makes this a product and not plumbing:

1. An agent pushes a branch to the user's platform repo and opens a proposal.
2. `post-receive` fires (existing), the dispatcher routes to Lane A, a
   Firecracker VM boots, clones, runs `.agentbuilt/ci.sh`.
3. The verdict lands as a commit status; the Mini App proposal card shows the
   pip, a failed check re-labels the button "Approve anyway", the log tail is
   one tap away. (All of this is the companion doc — nothing new needed.)
4. The machine is destroyed. Total platform exposure: one short-lived VM that
   held two worthless-if-stolen tokens.
5. The user approves, and the host merges server-side. Because the host moves
   the ref itself, receive-pack never runs and `post-receive` never fires — so
   the merge path sends the same signed push delivery the hook would have
   (`notifyRefMoved` in git-host.mjs), and the new tip gets its own run.
   **Every path that moves the base does this**, fast-forward included; only
   base-already-equals-head stays silent, because nothing moved.

   Fast-forwards were exempt at first, on the reasoning that the branch lands
   on a sha CI already judged. That held while CI only produced checks, and
   broke the moment protected-branch jobs started receiving secrets: the
   earlier verdict came from a run on the source branch, which is unprotected
   and gets none, so the deploy never ran — silently, since the branch moved
   and the sha was green. Found by rehearsing the secrets path end to end
   (2026-08-13), and most PRs fast-forward, so it was the common case. The
   fix costs one duplicate checks run per fast-forward merge, which is the
   right trade: a duplicate run is visible and cheap; a deploy that does not
   happen is neither.

## Phases

- **Phase 0 — measure.** One hand-driven Fly machine, our repo, cold `checks`.
  Numbers for boot, clone, install, test. An afternoon; kills or confirms the
  cache plan and the image-reuse bet.

  **Done 2026-08-11.** Cold `checks` on the current agent image
  (`sha-4d62e8729973`), `shared-2x-2048mb`, ams:

  | phase | seconds |
  |---|---|
  | machine create → sshd reachable | 31 |
  | clone (depth 50) | 6 |
  | `npm ci` (frontend) | 112 |
  | `npm ci` (backend) | 16 |
  | frontend tests + coverage | 19 |
  | frontend build | 16 |
  | backend tests (`test:core`) | 191 |
  | **total** | **~6.0 min** |

  What the numbers decided:
  - **The image-reuse bet holds.** Boot is 31 s of a 6-minute job; a lean CI
    image is not worth building yet.
  - **`shared-2x` is below the floor.** The suite *failed* on speed alone —
    `miniapp-delivery.test.ts` hit its 5 s timeout brotli-compressing the Mini
    App page, and backend tests ran 191 s against ~48 s on real cores. Lane A
    defaulted to `shared-4x-4096` (`LANE_A_GUEST`); production runs
    `performance-4x-8192`. Dedicated cores have no stolen CPU, which is what
    phase 0 actually measured, so halving the machine looked free — it was
    tried on 2026-09-14 (note #511) and measured the same afternoon:
    `ci_script` 164/165/167 s at 4x against 358/365/453/454/483 s at 2x. That
    is 2.2x to 2.9x the wall clock for MORE core-seconds, and Fly bills per
    core-second, so the halved hourly rate is handed straight back — the two
    shapes cost within about 20% of each other per run, the smaller one worse
    at the median. Four cores went back the same day: same money, ~2.5x less
    waiting. Shrinking the job machine is not a cost lever; fewer
    core-seconds is (the deps-baked image, below). Full numbers and the memory
    floor are on `GUEST` in `lane-a.mjs`.
  - **Installs are ~35% of wall clock** (128 s) — the deps-baked image variant
    stays the phase-2 lever, worth roughly 2 minutes per job.
  - `TEST_TIMING.md` (2026-04) is stale in both directions: frontend tests are
    5× faster than recorded, backend tests 4× slower.
- **Phase 1 — our own checks move to Lane A.** Ephemeral-machine path in the
  dispatcher, runner-agent, scoped git token kind, wall-clock kill,
  status-POST (shared with the status doc's ingest). GitHub statuses keep
  flowing unchanged. **The security payoff lands here**, with one repo and
  zero product surface.

  **Implemented and enabled in production 2026-08-11** (`infra/ci-runner/
  lane-a.mjs` + `runner-agent.sh`; `ia-ci-jobs` app created, `LANE_A_*` set in
  `/etc/ia-ci/env`). Enablement caught one deployment hazard worth recording:
  the self-update that shipped lane A ran under the *old* installer, which
  copied only the two files it knew — the daemon would have crash-looped on
  `import './lane-a.mjs'` at its next restart had the new files not been
  installed by hand in the gap. A self-update that ADDS a file always needs
  that one manual install; the now-current installer handles all four.
  Implemented minus the scoped git token: phase 1 injects the same
  repo-scoped `GH_TOKEN` the box already used, which is trust-neutral while
  lane A builds only our own commits — the scoped kind gates phase 2, not
  this. End-to-end verified against a live Fly machine: webhook → machine →
  full `checks` → signed result → machine destroyed, **exit 0 in 2.4 min** on
  `shared-4x-4096` (fetch 9 s, installs 49 s, frontend tests 8 s, build 19 s,
  backend tests 31 s). The phase-0 `shared-2x` test-timeout failure did not
  reproduce at 4x.
- **Phase 2 — any platform repo, allow-listed.** `.agentbuilt/ci.sh`,
  per-user caps, plan gating decision. First external tenant: dogfooders.

  **First slice implemented 2026-08-11**, enough for a platform repo to run
  checks end to end:
  - The scoped token exists as designed: `cit1.…`, minted per job by
    `POST /git/ci-clone-token` (same secret as the status ingest; HMAC
    subkey, stateless, ≤1 h), answered by `/git/verify` with
    `scope: {repo, readOnly}` and enforced by the host before git spawns.
  - The dispatcher routes on which signature header carried the event: an
    `x-agentgit-*` push queues exactly one lane A `ci-script` job for ANY
    branch — which is what puts a pip on a proposal, since the push that
    creates the branch precedes the proposal; the planned pull_request
    delivery from the backend turned out not to be needed. Platform events
    can never reach lane B.
  - `runner-agent.sh` runs the repo's committed `.agentbuilt/ci.sh`; an
    absent script exits 78 = `skipped` (grey, not red), and lane A now
    carries 78 through to the ingest the way lane B always did.
  - Opt-in was per-repo `agentgit.webhookUrl` config, set by an operator on
    the git host box — that WAS the allow-list. **Self-serve since
    2026-08-12** (below). Per-user caps and plan gating remain open product
    decisions before any announcement.
  - Deployment note: **the git host does deploy itself** — the
    `deploy-git-host` job (2026-08-11) rsyncs and restarts on a merge to
    main. What it does NOT do is re-run `provision.sh`, so a change that
    adds an ENV VAR still needs a hand step on ia-media; the code does not.
    (This bullet said "no pipeline, installed by hand" until 2026-08-13,
    which was true when written and cost a wrong deploy plan afterwards.)

  **Self-serve opt-in, 2026-08-12.** `agentbuilt repo ci enable|disable
  <name>` — no shell on ia-media, and the SSRF reasoning that put it there
  is preserved rather than traded away. The hazard was always a
  *caller-supplied URL*: this host sits inside the private network and would
  POST wherever it was pointed. But a repo's owner has no reason to name a
  destination — there is exactly one legitimate value. So the API carries a
  **boolean**, `/internal/repos/ci` writes `agentgit.webhookUrl` and
  `webhookSecret` from the host's OWN `CI_WEBHOOK_URL`/`CI_WEBHOOK_SECRET`
  env (set by `provision.sh`, so a rebuild restores it instead of losing
  it), and `stat` reports `ci: true|false` without ever naming the URL.
  Unset env → the route refuses and every repo stays silent, exactly as
  before. Unlike protection this is reversible in both directions: CI grants
  no authority and moves no branch — enabling it only means a push runs the
  repo's own committed script on a throwaway machine.
- **Phase 3 — product.** Secrets (protected-branch-only), Mini App CI history
  beyond the proposal card, minute budgets, then Lane B artifact-build
  migration to close the last `npm ci` on the trusted box.

  **Artifact-build migration implemented 2026-08-13** (first step of
  `platform-on-own-git.md`): `deploy-dev`/`deploy-prod`/`deploy-site` no
  longer build on the keyed box. `run-job.sh` asks the daemon — localhost
  `POST /build`, this box is the only caller — for a `build-backend` or
  `build-site` job; a lane A machine clones, builds, and PUSHES the tarball
  to `/job-artifact` (per-job HMAC over the artifact's sha256 — the machine
  cannot be reached from outside, so delivery is outbound like the result
  report), and the deploy extracts it, checks `RELEASE_SHA` matches, and
  releases. A failed BUILD fails the deploy without a local retry; an
  unavailable build path (old daemon, lane A unconfigured) initially fell
  back to a loudly-labeled local build so deploys survived the transition.
  **Fallback removed 2026-08-13**, after dev, site and prod had each carried
  a remote-built deploy: an unavailable build path now fails the deploy, and
  `IA_LOCAL_BUILD=1` on a by-hand run is the operator break-glass for a Fly
  outage — a human decision, never a silent degradation. Builds bypass the lane A queue (lane B is blocked inside the very
  job that is asking) under their own two-slot cap. The wrangler UPLOAD and
  the docker `machine-image` build still run on the box — the remaining
  exceptions, named in platform-on-own-git.md.

  **Secrets slice implemented 2026-08-12**, exactly the shape sketched under
  Credentials: opt-in per repo per secret, protected-branch jobs only.
  - The grant was the OWNER's: `agentbuilt repo ci-secrets <name> NAME…`
    recorded an ask and only the owner's tap (a chat card, later the
    repository's Workspace screen) wrote the repo's `ciSecrets` list.
    **Since 2026-10-11 (note #739) an admin's agent writes the grant at
    once** and the owner is told by a line in the chat: the names only ever
    reach protected-branch runs, which carry nothing the owner has not
    approved through the merge gate, so the owner dropped the second tap.
    The repository's screen shows the standing grant ("Keys for checks").
    Any agent may remove a name on its own (narrowing). Names
    must be saved SHARED secrets — an agent-private key is one agent's own,
    not CI material — and `CI_*` names are refused (the runner's contract).
  - Per job, the dispatcher asks `POST /git/ci-secrets` (the clone-token
    mint's sibling, same secret) with `{owner, repo, ref}`. The backend
    holds the whole rule: repo opted in AND the ref is protected — asked
    fresh from the git host each time, failing closed when the host cannot
    answer. Everything else gets `{}`, and the dispatcher degrades to `{}`
    on any fetch failure: a deploy missing its env fails legibly in its own
    log; a lane that refuses to run does not.
  - Values ride the machine env under their own names (that is the product:
    `.agentbuilt/ci.sh` reads `$CF_API_TOKEN`), and `CI_SECRET_NAMES` tells
    the runner-agent which values to mask out of the 64 KB log tail before
    it reports — masked over a 128 KB window first, so a value straddling
    the cut cannot leak (values cap at 8 KB).
- **Publishing on approval (`agentbuilt repo publish`, 2026-10-01).** Secrets
  could deploy anywhere EXCEPT our own hosting: the only key `/deploy`
  accepted was an agent's own `agb1.` token, re-minted on every identity
  write, so a copy granted to CI died within hours and agents published every
  merge by hand. Now:
  - The link is `publishTo` on the repo record — the site's id (a rename keeps
    it) and the agent that made it. An admin's agent ASKED and the owner
    allowed it on the repository's Workspace screen; since 2026-10-11 (note
    #739) the admin's agent writes the link at once and the owner is told in
    the chat that approving now publishes. Any agent may take it off.
  - `/git/ci-secrets` (now sent the job's `sha`) answers a protected-branch
    run of a linked repo with `publish: {token, site, apiUrl}` — a stateless
    `cdt1.` key (`services/ci-deploy-token.ts`) for that repo, site and
    commit, dead within the hour.
  - `runner-agent.sh` unsets the key before anything from the repo runs, and
    after `.agentbuilt/ci.sh` exits 0 runs `.agentbuilt/deploy.sh` with it as
    `AGENTBUILT_TOKEN`, the CLI fetched from the backend onto PATH. Its log is
    separate and masked; its exit rides the same report as `publish`.
  - The daemon files `deploy/<site>` pending at job start and its verdict
    BEFORE `ci/checks`, so a `repo checks --wait` after a merge waits for the
    publish too. Failed checks → `skipped` (the site still serves the last
    approved change); no deploy.sh → `skipped`; a newer merge → `superseded`.
  - `/deploy` takes the key for ONE thing: redeploying that live site, as the
    linking agent (a service reads its saved keys from its deployer), with
    the keys it already runs with — no create, no revive, no preset or secret
    change, and no `--replace` fence (the owner's Allow was that word). The
    link is re-checked on use, and a refusal never touches an agent record.
  - Not wired into the dormant org-CI path (`org-ci.ts`): its repos get no key.

Phases 0–1 are roughly a week of work and independently worth it. Phases 2–3
are a product line — queueing, quotas, log retention, billing — and should be
decided as one, on purpose, with phase-1 experience in hand.

## Open questions

1. **Egress policy for job machines.** Default-deny with a registry/git/status
   allow-list is the right end state and a real constraint on legitimate
   builds (a test that pulls a docker image, a build that hits an API). Phase
   1 ships permissive-but-monitored; the decision needs real tenant jobs to
   look at.
2. **Where the dispatcher ends up.** It is the last single point of failure on
   a box whose other job (Lane B) argues for staying small. Moving dispatch
   into the backend proper (which already owns Fly clients, storage, and the
   status store) is plausible in phase 2+; kept out of scope here because the
   daemon works and the split shouldn't wait on a rewrite.
   **Answered 2026-08-13: no, permanently** — the dispatcher must be able to
   deploy the backend while the backend is down, so it can never live inside
   it. See [`platform-on-own-git.md`](./platform-on-own-git.md).
3. **Fly capacity behaviour under burst.** The sandbox client already retries
   region-declined starts (`fra` fallback); CI bursts (one push → several
   jobs) may want a small warm pool. Buy that only when a queue-time graph
   says to.
