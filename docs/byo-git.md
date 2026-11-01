# BYO git — the build record

The code-side record of the **byo-git-design** knowledge page (workstream 4:
per-client git hosts and backups in the client's own Fly org). The page is the
contract; this file records what each slice actually did and the traps it hit,
the way `byo-fly.md` does for workstream 3.

## Slice 1 — org-scoped repos (the namespace inverts)

A git **namespace** is the first path segment of every clone URL and disk path
— what the host authorizes a token against, what the registry keys names and
quotas on. Pre-org it was simply the userId. This slice makes it resolvable
per org, so members of a stamped org share one shelf, without moving a single
byte on the central host.

### The shape

- **`OrgGitService`** (`backend/src/services/org-git.ts`) — the whole new
  surface. `resolveNamespace(userId)` answers `{ namespaceId, orgId, role }`:
  the org's stamp for members of a stamped org, the caller's own userId for an
  unstamped org or no org at all (the pre-org behavior, byte for byte).
  `adminsForNamespace` names who decides destruction and spend.
  `stampOrgGitNamespace` writes `OrgDocument.git.namespaceId` — once;
  restamping a different value is refused, because every clone URL hangs off
  it.
- **The host needs no change.** `/git/verify` now answers the caller's
  *namespace* in its `userId` field, and the host's one equality check
  (`auth.userId === path segment`) does the rest. Org sharing shipped without
  touching `git-host.mjs`.
- **`GitRepoDocument.userId` is documented as the namespace** and keeps its
  name (sqlite column, host wire shape). New: `orgId` on the record (stamped
  at create, backfilled by the script), `byUserId` on `deleteAsk` /
  `ciSecretsAsk`, `createdByUserId` on proposals — because on shared ground
  the DECIDER may not be the ASKER, and the outcome must wake the asking
  member's agent, not the decider's.
- **Host calls use `repo.userId`** (the record's own namespace), never an
  auth-derived id. Lookups go through `resolveNamespace`; everything after
  trusts the record.
- **Admin verbs.** Repo delete/keep in the Workspace and the CI-secrets grant
  are refused for non-admin members of an org (403 / a toast). The CI-secrets
  ask card goes to the org's admins — on a personal namespace and in org #0
  that is the asker, exactly as before.

### What did NOT move (deliberately)

- **Knowledge pages** stay keyed to the viewer — the org's shared knowledge
  repo is slice 3's ground (it is born on the org's own host).
- **Org #0 is not migrated.** `scripts/stamp-org0-git-namespace.mjs` stamps
  its namespace as the founding admin's userId — naming what is already true
  — and backfills `orgId` onto the existing repo records. Run it on the
  backend host after deploy (dry run first); it verifies by resolving through
  the real path.
- **Identity/CLI docs** still say "your user's agents"; accurate while org #0
  is single-member. The wording moves to "your workplace" with the slice
  that gives a client org its own host (needs an identity-version bump).
- `/git/ci-secrets` still reads the namespace's USER secret env — correct
  while every namespace is a userId; the org-secret store takes over when a
  namespace can be an orgId (slice 2+).

## Slice 2a — the git-host image

The third public image: the ia-media service, packaged for a client org's own
Fly machine. `infra/git-host-image/` holds only the wrapper (Dockerfile,
entrypoint, smoke test) — the CI job (`git-host-image` in
`infra/ci-runner/run-job.sh`) stages `infra/git-host/{git-host.mjs,hooks/}`
into the build context, so the service code exists once and ia-media and the
image ship the same bytes. Tag family `git-host-sha-<12hex>` on the same
public GHCR package as the other two images (visibility inherited, no
by-hand step). Queued on every main push, self-skipping unless
`infra/git-host{,-image}/` changed; dispatchable for forced builds.

- `git-host.mjs` gained a `HOST` bind env (default `127.0.0.1`, unchanged on
  ia-media). The image sets `::` — the backend arrives over the org's
  WireGuard peer and agent machines over 6PN, both IPv6; the Fly proxy's
  IPv4 health checks ride the same dual-stack bind.
- The entrypoint owns `/data/{repos,trash}` as root, then `setpriv`s down to
  `agentgit` — the same privilege split the systemd unit enforces on ia-media.
- `/internal/*` on a client host is gated by the per-org secret ALONE (no
  Caddy IP allowlist exists there); agent machines never hold that secret.
- Smoke test proves: health, control API accepts/refuses the secret, git auth
  FAILS CLOSED against a dead backend, repo lands on the volume owned by
  `agentgit`. Rehearsed by hand on ia-ci-runner 2026-08-23 before the job
  ever ran: build + full smoke pass.
- Provisioning (slice 2b) names the ref it wants via `FLY_GIT_HOST_IMAGE`.
  Until note #809 (27 Oct 2026) nothing repointed it, and production named
  the 23 August image for two months while the code moved on. Since then a
  green build repoints it, after the smoke test and the push, with
  `set-machine-image --git-host <ref>` on the backend host (the same root
  helper the agent image uses; that mode writes only `FLY_GIT_HOST_IMAGE`
  and accepts only `ghcr…:git-host-…` tags). An existing host keeps its own
  image until it is rolled deliberately.

## Slice 2b — provisioning and per-org resolution

`OrgGitHostService` (`backend/src/services/org-git-host.ts`) is the whole
slice: RESOLVE answers which host serves an org (its own `git.host` pointer
with its own per-org secret, else the platform seed — and a pointed org whose
secret is lost FAILS, never falls back, the org-fly rule); ENSURE builds a
client org's host in the client's own Fly account (`iagit-<orghex>` app,
flycast address, `gitdata` volume with 14-day snapshot retention, per-org
`GIT_HOST_SECRET` org secret, one machine from `FLY_GIT_HOST_IMAGE` with
`autostop: 'stop'` — the proxy sees every byte a git host serves, so
traffic-idle genuinely means idle, unlike agent machines).

- **The trigger is the first `repo create`** in an unstamped org
  (`maybeProvisionForOrg`): stamped orgs (org #0 by construction) and orgs
  without their own Fly connection are a quiet no. Provision stamps
  `namespaceId = orgId` BEFORE writing the host pointer, then the route
  re-resolves — the org's first repo is born org-namespaced on its own host.
- **Every host call resolves per repo**: routes and the agent service ask
  `gitHostFor(repo.orgId)`; `requireGit` hands out `hostFor`, not a client.
- **Callbacks from N hosts**: a per-org host names its org
  (`x-git-host-org`, from the machine's `GIT_HOST_ORG` env) and signs with
  its OWN secret; `gitHostCallerOk` selects which secret to compare by that
  header, so a host can only ever authenticate as itself. The central host
  keeps signing with the platform secret, header-free.
- Fly client grew `ensureFlycastIpv6` (idempotent, `private_v6`),
  `snapshotRetentionDays` on volume create, and `autostop` on services.

### Rehearsed live in ia-scratch-client (2026-08-23, same day)

The whole slice-2 contract ran end to end in a real separate Fly org through
the production path: first `repo create` provisioned `iagit-87c99fa526a3`
(flycast `fdaa:bd:1a93:0:1::2`, 10 GB `gitdata` volume, machine on the GHCR
image), stamped the org `namespaceId = orgId`, and created the repo; a clone
and a branch push from ia-backend rode the per-org verify callback
(`x-git-host-org` + the org's own secret); a push to `main` was refused by
pre-receive; the pushed report updated the record's size; a proposal compared
over flycast; and `host.merge` through `OrgGitHostService.clientFor` moved
`main`. The host and its `probe` repo STAY as standing rehearsal ground.

Two live findings, both now in code:

1. **An empty `ports` list leaves the proxy with nothing to bind**, so the
   flycast address answers nothing and autostop never sees traffic. The first
   provision failed its health poll exactly there. `ports: [{ port: 8080 }]`
   is load-bearing, and the direct machine IP answering while flycast is dead
   is the diagnostic signature.
2. The machine's DIRECT 6PN address also serves fine over the WireGuard peer
   — useful for diagnosis, but the stored contact stays flycast: it is the
   address that wakes a stopped host.

## Slice 3 — agents and knowledge follow the org

The audit's best finding did most of this slice's work before it started:
**the CLI never stores a git host.** Every clone URL an agent sees comes from
the backend's own answers — which slice 2b already resolves per org — and the
credential helper registers against whatever origin those answers carry. So
an agent machine in a client org needs ZERO machine-side changes: its
`repo create` answers a flycast URL, git dials it over the org's own private
network (same 6PN, routed by construction), and the helper hands the same
token it always has. Left to do was knowledge, and it got exactly the repo
treatment:

- **Knowledge reads and writes resolve through the namespace on the
  namespace's own host** — `requireKnowledge` (both route files) resolves
  `{ns, service}` per caller, and the approval's `land` commits to the doc's
  namespace via the per-org client. An org's pages are one shared base, the
  org-layer contract's "what one learns, all know" made literal.
- **`KnowledgeProposalDocument` gains `createdByUserId`** (the PR shape): the
  record's `userId` is the namespace, the outcome wakes the proposer's chat.
- The org's `_knowledge.git` is born on ITS host on first use —
  `ensureKnowledgeBase` is host-side and always was.
- NOT verified live yet: an agent machine INSIDE a client org reaching the
  flycast address (the E2E proved it from the backend over WireGuard). Fold
  that check into the next scratch-org rehearsal that boots an agent machine.
- Identity/doc text still says "your user" where an org means "your
  workplace" — deliberately deferred to the workspace slice, where the
  wording changes once, with an identity-version bump.

## Slice 4 — backups that live with the code

Layer 1 shipped with provisioning (volume snapshots, 14-day retention). This
slice is layer 2: verified bundles into a bucket in the ORG'S OWN Fly
account, with the central host's retention discipline ported whole.

- **The de-risk came first and paid for itself.** Tigris provisioning via the
  raw GraphQL `createAddOn` works with nothing but the org token — but the
  S3 credentials come back ONCE, in the create response's `environment`;
  every later read answers an empty map (probed live 2026-08-23, three
  probe buckets created and deleted). So `FlyClient.createTigrisBucket`
  demands them in the response and `OrgGitBackupService.ensureBackupTarget`
  writes them to the org-secret store in the same breath — a creation whose
  secret write fails DELETES the bucket rather than stranding one nobody can
  sign for. A pointed bucket with a lost secret fails loudly, never makes a
  second bucket.
- **The clock is the backend's sweep** (`ORG_GIT_BACKUP_INTERVAL_MS`,
  default 6 h, boot catch-up after 5 min): org hosts sleep between pushes
  and fire no timers. The sweep wakes each host over flycast, hands it the
  bucket and keys for exactly one run (`POST /internal/backup/run` —
  credentials never persist on the machine), and records the summary on the
  backup monitor as job `org-git` — ADD IT to `BACKUP_MONITOR_JOBS` on prod,
  or the staleness watch never covers it.
- **The host-side job is `infra/git-host/backup.mjs`**: zero-dep node —
  git bundles and verifies, curl signs (`--aws-sigv4`, credentials over a
  stdin config, never argv), one bundle on disk at a time, skip-unchanged by
  a refs fingerprint that includes the target. Retention: 14 dailies, one
  per ISO week for 8 weeks, NEVER the newest — `pruneList`/`isoWeekKey` are
  exported and tested in the backend suite, because date math is exactly
  what rots silently on a machine nobody watches.
- The module ships everywhere the server does (deploy-git-host job, the
  image build staging, the Dockerfile) — ia-media carries it inert; its own
  sftp timers are untouched.

### Slice 4 rehearsed live (2026-08-23, same day)

The production sweep ran against the scratch org through the real path:
bucket `iagit-87c99fa526a3-bk` created in the client org (keys stored in the
same breath), the sleeping host woken over flycast (6.5 s cold start — the
autostop/wake story proven live in passing), the probe repo bundled,
verified, uploaded. Then the RESTORE DRILL: the bundle fetched back from the
client's bucket with its own keys, `git bundle verify` complete, cloned, and
the restored HEAD matched the live repo's `main` exactly. Job `org-git` is
in prod's `BACKUP_MONITOR_JOBS`; `FLY_GIT_HOST_IMAGE` repointed to the tag
carrying `backup.mjs` and the scratch host rolled onto it.

## Slice 5 — CI in the client's org

A client repo's `.agentbuilt/ci.sh` executes on a throwaway machine in the
CLIENT'S OWN Fly account (`iaci-<orghex>`, the public agent image, lane A's
guest one size down) — their code never runs on any box of ours, and the
machine bills their card. `OrgCiService` is the whole slice:

- **The webhook** is the org host's own post-receive hook, signing with the
  org's host secret; the payload's owner (the namespace = the orgId) names
  which secret the backend checks — `verifyWebhook` — so a host can only
  ever speak as itself. `ensureOrgGitHost` bakes `CI_WEBHOOK_URL/SECRET`
  into new host machines; hosts provisioned before this slice need a
  machine-env update (the scratch host got one in the rehearsal).
- **Lane A's exact machine contract**, booted by the backend through the
  org Fly context: same runner script (shipped in the release artifact —
  the build copies `infra/ci-runner/runner-agent.sh` to
  `dist/ci-runner-agent.sh`), same per-job HMAC on the single result
  (`POST /api/agent-cli/git/ci-result`), same auto_destroy. Exit 78 keeps
  its "skipped" meaning. Timeout (15 m) writes a failure AND force-deletes
  the machine — an unwatched runaway bills the client.
- **The clone token rides INSIDE the URL** (`x-access-token:<cit1>@[…]`):
  the runner's netrc derivation does not survive a bracketed IPv6 host, and
  the machine holds the token in env either way — 60 min, one repo,
  read-only.
- **Granted org secrets** ride only refs the org's own host says are
  protected right now (statRepo per job, failing closed) — the central
  lane's rule, ported against the ORG secret store.
- One job at a time per org, queue depth 5, statuses on the same
  `ci/checks` context every surface already reads.
- The ia-ci-runner dispatcher is untouched: it keeps the platform repo's
  deploys — the repair-path rule survives where it matters.

### Slice 5 rehearsed live (2026-08-23 evening, same day)

The whole loop ran in the scratch org through the production path: a push to
the probe repo fired the org host's webhook, the backend booted a job machine
in `iaci-87c99fa526a3`, the job cloned the org host over flycast FROM INSIDE
the client org (closing slice 3's one open check), ran `.agentbuilt/ci.sh`,
and the green pip landed with the log tail — ~15 s end to end, machine
auto-destroyed after. The rehearsal surfaced two real bugs, each now in code:

1. **The webhook body was eaten by the global `express.json`** before the
   HMAC could see raw bytes. Fix: scoped `express.raw` mounts for
   `/git/ci-webhook` + `/git/ci-result`, mounted AHEAD of the global parser
   (PR #231).
2. **`createMachine` whitelists config fields**: `init`, `auto_destroy` and
   `restart` passed as extra keys were silently dropped, so the CI machine
   booted its image's default entrypoint (sshd) and hung — found via
   `flyctl machine exec <id> "ps aux"`. Fix: typed args in
   `CreateFlyMachineArgs`, passed through explicitly (PR #232). The 15-minute
   timeout safety was proven live in passing: it wrote the failure status and
   force-deleted the hung machine.

### Traps for the next slice

- `resolveNamespace` is called per request (two storage reads). If the git
  host's verify traffic ever makes that hot, the host already caches positive
  verifies for 60 s — measure before adding a second cache.
- The CI-secrets card is delivered per-admin best-effort via
  `sendDeploymentMessage(recipient, askingAgentId, …)`; a recipient who does
  not own that agent may not be deliverable on some bot setups. Org #0 is
  unaffected (asker == admin). Revisit when a real multi-member org exists.
- An org whose stamp is a userId (org #0) means a hypothetical second member
  shares the ADMIN's user-keyed namespace — including its user-secret env for
  CI. Fine for org #0; client orgs get orgId stamps and org secrets.

## Slice 6 — the Workspace surface

The org screen's **Code block** (`renderOrgGit` in the Workspace page of the time, painted
from `GET /api/org`): repositories with their total size for every org with
git ground, and — for an org with a host of its OWN — the server's health,
its storage, and the last backup, with the custody line under it ("leave
anytime and they stay yours"). Org #0 shows just its repositories: there is
no host of theirs to report on, and the block never claims otherwise.

- **Host health is ONE short probe, never a wait** —
  `OrgGitHostService.describeHost`: 2.5 s against `/health` on the flycast
  address. A timeout answers `waking`, because on flycast the probe ITSELF
  starts a stopped machine (the 6.5 s cold start from the slice-4 rehearsal)
  — the next open answers `ok`. A stopped host is the design, not a fault,
  and the screen says "waking up", never "broken". `/health` also carries
  `diskUsedPercent` (the host has always answered it), which is what makes
  the storage row honest.
- **Last backup is a per-org stamp** (`org.git.backup.last`, written by the
  sweep after every run — ok or failed, overwritten honestly): the backup
  monitor's heartbeat is one row for the whole fleet, which alerts operators
  but cannot answer "when was MY last backup".
- **The grow-the-volume card** (the design's "Cost, guardrails, growth"):
  volume size read live from the Fly API (up regardless of whether the
  machine sleeps), and for an ADMIN a button carrying the price —
  "Grow storage to 20 GB · +$1.50/mo" — a confirm naming the monthly cost
  and that storage never shrinks, then `POST /api/org/git/volume` →
  `growVolume`: +10 GB per tap (`ORG_GIT_VOLUME_GROW_GB`), ceiling 100 GB
  (`ORG_GIT_VOLUME_MAX_GB`), both env-tunable. After an extend that needs a
  restart the machine is STOPPED, not restarted: on an autostop host the
  next request boots it fresh on the grown filesystem. The admin's tap IS
  the spend approval — the workstream-3 pattern.
- **Identity v64**: repos and knowledge are described as ORG-shared now that
  client orgs exist ("shared by your user's whole WORKPLACE", knowledge
  as "what your user's workplace has written down") — the wording slice 1
  deliberately deferred. Notes deliberately keep their user wording: they
  never moved to org ground. CLI bytes unchanged (docs-only bump).

## Slice 7 — the standalone switch

The design's one honest wrinkle in "cancel us tomorrow" was the verify
dependency: the host checks every token against our backend and fails closed
— correct while we operate it, exactly wrong the day the client leaves.
`GIT_HOST_STANDALONE=1` is the answer, and the whole implementation is a
handful of guarded lines in `git-host.mjs` plus one early exit in each hook:

- **Git endpoints stop authenticating**: credentials are accepted and
  IGNORED, so a clone URL that still carries a long-revoked token keeps
  working. Whoever can reach the address clones and pushes — and the ONLY
  people who can reach it are inside the org's own private network: a
  client-org host has a flycast address and no public IP, which is the
  entire safety argument. (On the central host this switch is never set,
  and nothing changes when the env is absent.)
- **The host calls nobody**: no verify, no `/git/pushed` report, and both
  hooks exit up front — `pre-receive` drops the protection and quota gates
  (the approval flow left with the platform), `post-receive` stays silent
  (a dead webhook would otherwise cost every push a 5-second timeout).
- **`/health` answers `"standalone": true`** — the one signal an operator
  (or the client's own monitoring) checks after the flip.
- The control API keeps honoring the shared secret; after off-boarding
  nobody holds it, and that is the point rather than a gap.

Proven three ways: the backend suite runs a REAL standalone host against a
DEAD backend URL (unauthenticated push onto a protected branch with CI
enabled, inside one push timeout); the image smoke test boots the built
image with the flag and does the same over HTTP; and the live scratch-org
rehearsal below.

## The off-boarding runbook

The order matters: flip and VERIFY while our access still exists, then cut
our access, then clean up records. The client's kill switch (revoking the
org token in their Fly dashboard) works at any moment and needs nothing
from us — this runbook is the graceful version of the same ending.

1. **Flip the switch.** Add `GIT_HOST_STANDALONE=1` to the host machine's
   env via `updateMachine` on the org's Fly context (machine config is
   REPLACED whole — read it, add the env key, write it back; the byo-fly
   gotcha that `updateMachine` takes the config as its third argument).
   The machine restarts on the update; on an autostop host it then settles
   to `stopped`, and the next request wakes it. The client can equally run
   `fly machine update --env GIT_HOST_STANDALONE=1` themselves — it is
   their app.
2. **Verify from inside their network** (an agent machine in the org, or
   any box of theirs on 6PN): `curl http://[<flycast>]:8080/health` answers
   `"standalone": true`; a credential-less clone answers; a push lands —
   protected branches included.
3. **Remove our side.** `scripts/ensure-org-wireguard.mjs --org <orgId>
   --remove` (drops the peer registration and the local interface), then
   delete the org secrets: `FLY_ORG_TOKEN`, `GIT_HOST_SECRET`,
   `GIT_BACKUP_CREDS` (`OrgSecretsService.deleteOrgSecret`). Their repos,
   their history, their bucket and its bundles stay in their account.
4. **Records.** Clear `org.fly` and `org.git.host` on the org document so
   the reaper and the backup sweep stop trying to visit ground we can no
   longer reach (both degrade gracefully in the meantime — a failed listing
   logs and moves on). What stops with us: the Workspace, proposals and
   merges, CI dispatch, bundle backups (volume snapshots continue — they
   are Fly's, on the volume). What keeps running: their git server, serving
   their code, next to their backups.
5. **The bucket add-on is theirs to keep or delete** — `deleteAddOn` exists
   if they ask us to clean it up while we still hold the token; after step
   3 it is dashboard-only, like everything else.

### Slice 7 rehearsed live (2026-08-23, same day — workstream complete)

The off-boarding switch ran against the real scratch-org host
(`iagit-87c99fa526a3`) through the runbook's own steps:

1. The host was rolled to the freshly built image
   (`git-host-sha-582fb2551176` — built, smoke-tested standalone section
   included, and published by the pipeline within minutes of the merge), and
   prod's `FLY_GIT_HOST_IMAGE` repointed to the same tag.
2. `GIT_HOST_STANDALONE=1` set via the Machines API (config read, mutated,
   written back whole); the woken host answered
   `{"ok":true,…,"standalone":true}` over flycast.
3. **The proof from inside the client org**: an agent machine provisioned in
   `ia-scratch-client` through the real path cloned
   `http://[flycast]:8080/<org>/probe.git` with NO credentials and pushed a
   commit onto the PROTECTED `main` — landed (`3f6cf06b…`), CI hook silent,
   no backend call anywhere on the path. Machine destroyed after, claims
   cleared.
4. Flip back: env unset, health without the flag, an unauthenticated
   `info/refs` refused with 401 again, and an agent-token `ls-remote` read
   `main` at the rehearsal commit — the push made in standalone survived the
   return to managed mode, exactly as bytes on a disk should.

Deliberately NOT rehearsed: peer removal and secret deletion (runbook steps
3–4) — the scratch org is the standing rehearsal ground for every future
slice, and tearing down its tunnel to prove verbs that already exist
(`ensure-org-wireguard --remove`, `deleteOrgSecret`) would cost more than it
proves. The first real off-boarding runs them for real.

## Addendum — backups on the org screen (2026-08-25, Alex)

Owner's direction: client org admins have no ops bot, so the org screen is
where THEY see backups. The Code block grew from one line to the honest view:

- **Disk snapshots** row — retention read LIVE from the volume
  (`FlyVolume.snapshot_retention` via `describeHost`), never assumed from env.
- **Backups** row — outcome + age, with a `badge warn` when the last run
  failed or when the sweep has gone quiet past 4× its cadence (the route now
  sends `backup.everyHours` so the page can call silence overdue instead of
  printing a stale "last backup" as if fine).
- **Backup vault** row — the bucket's name, labelled in-your-cloud: the
  sovereignty claim made inspectable.
- The custody hint now covers attachments (byo-media) and says plainly that
  chats, notes and proposals are platform records backed up by us.

Deliberately NOT in this slice: a restore button (operator-shaped; a doc line
beats a scary button), backup config knobs (retention is a discipline, not a
preference), and Web Push to admins on persistent failure — that one is real
but needs its Workspace delivery policy thought through, so it is an honest
follow-up rather than a rushed rider. Screenshot harness:
`~/mini-preview/shoot-org.mjs` on Alex's machine (BACKUP=ok|failed|overdue|none).
