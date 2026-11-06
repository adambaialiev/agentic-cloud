# The control plane moves onto Fly — build record

The design is note #1031 (6 Nov 2026), accepted in full by the owner the same
day, and the build brief is note #1032. In short: the three Hetzner boxes
(`ia-backend`, `ia-media`, `ia-ci-runner`) and the Storage Box go away.
Production's backend, code host and CI lane B move into our Fly organization in
`ams`, shaped like a private copy. Backups leave Fly for Cloudflare R2 and are
watched from Cloudflare. The order is backups, then git host, then CI, then
backend, then teardown, and each stage is reported before the next starts.

This file records what was built and what was measured, stage by stage.

## Stage 0 — prep and rehearsal (6 Nov 2026)

Nothing in production changed in stage 0.

### The R2 bucket

`acc-platform-backups` is in our Cloudflare account, location hint WEUR, and
was made with the `CLOUDFLARE_R2_TOKEN` secret.

- **Lock rule `keep-everything-30-days`**: no object can be deleted or
  overwritten until it is 30 days old, whatever key asks.
- **Lifecycle rules**: `archive/expire-31d/` is deleted at 31 days (point 7:
  pre-deletion database copies kept 30 days under the lock, then gone).
  Multipart uploads are aborted after 7 days.

Writers get their own bucket-scoped keys (point 4). No token we hold can mint
an R2 API token, so the owner creates those keys in the Cloudflare dashboard.

### The database backup, hardened (`backend/src/services/database-bucket-backup.ts`)

This is the code a private copy already used. It now carries what the Hetzner
script (`infra/db-backup`) did:

- A snapshot that will not open, fails `PRAGMA integrity_check`, or holds no
  tables is refused and never uploaded.
- The gzip must decompress byte-identical to the checked snapshot, and the
  bucket must report exactly the size that was sent.
- Retention is 14 dailies plus 8 ISO weeklies, and never the newest archive.
- `DB_BACKUP_LOCK_DAYS` makes the prune leave alone what the bucket lock would
  refuse to delete.
- `DB_BACKUP_MONITOR_JOB` names the heartbeat. Production uses `db-r2` while
  the Storage Box script still reports as `db`.

For production: `DB_BACKUP_INTERVAL_HOURS=6`, `DB_BACKUP_LOCK_DAYS=30`. A
copy's behaviour only gains the checks and the weeklies.

### Repo bundles and media, off Fly

- **`CENTRAL_GIT_BACKUP=on`** — the backend asks the central code host to
  bundle its repos into the backups bucket (`git/<ns>/<repo>/<day>.bundle`),
  every `CENTRAL_GIT_BACKUP_INTERVAL_HOURS` (24). It reports as `git-r2`. The
  host already had the route (`/internal/backup/run`, the org hosts' path);
  nothing called it for the central host.
- **`MEDIA_MIRROR=on`** — a nightly, add-only copy of the platform's media
  bucket into `media/` of the backups bucket
  (`backend/src/services/media-bucket-mirror.ts`). It reports as `media`. Workplaces that keep
  their media in a bucket in their own Fly account are theirs, and are not
  copied.

### The watchdog, off Fly (`infra/backup-watchdog/`)

A Cloudflare Worker with an R2 binding (list only). It runs every 6 hours and
tells the ops chat when the newest `db/` object is older than 8 h or the newest
`git/` object is older than 72 h. It is deployed in stage 1.

### The image

`infra/backend-image/Dockerfile` gains `wireguard-tools` and `iproute2` for the
peers into workplaces' own Fly accounts (`services/org-wireguard.ts`).

### What the stopwatch decided (point 3), and what follows for point 9

The test copy's backend (shared-cpu-2x, `acc-testcopy-backend`) was polled on
`/api/health` every 0.2 s:

| Event | Requests | Failed | Longest wait |
|---|---|---|---|
| `fly machine restart` | 428 | 0 | 7.5 s |
| `fly machine update` (new config, machine replaced) | 488 | 0 | 8.2 s |
| restart under 10 parallel clients | 798 | 0 | 6.7–7.9 s each |

Fly's proxy holds requests while a machine restarts and replays them once it
listens, so a restart drops nothing. The backend itself is up 1.1 s after it
starts (production journal, three restarts on 6 Nov). The socket holder was
meant to turn a restart from "502s" into "a short wait", and Fly's proxy
already does that. **So no socket holder was built.** A deploy is an image and
a machine update, as in a copy, and rollback is updating back to the previous
image. The cost is a wait of about 7–8 s per deploy instead of about 1 s.

The same measurement removes the reason for point 9, a signed repoint endpoint
"so an image build does not restart the backend". A Fly secret change restarts
the backend, and that restart drops nothing, the same as every deploy's.
**Not built either**, pending the owner's word: repointing becomes
`fly secrets set FLY_MACHINE_IMAGE=…` from the CI app.

### WireGuard from a Fly machine (stage 0a)

A Debian machine in the scratch org (shared-cpu-1x, kernel `6.12.115-fly`)
created a `wireguard` link in the kernel. It brought up a peer into a
*different* Fly organization (the bring-your-own-Fly test org) with `wg-quick` and
completed a handshake. It then pinged that org's gateway,
3 out of 3. The `/48` routed over the peer, beside the machine's own 6PN on
`eth0`. The peer and the machine were deleted afterwards.

### Docker on a Fly machine — the builder (stage 0b)

A `performance-4x` machine with a 40 GB volume at `/var/lib/docker` ran
Debian's `docker.io` (20.10, overlay2, cgroup v1). It built
`infra/fly-machine-image` cold with production's CLI pins (claude 2.1.316,
codex 0.166.0, opencode 1.19.5) in **160 s**, producing a 2.6 GB image. Then
`smoke-test.sh` passed in **30 s**: the container ran with `--cap-add
SYS_ADMIN`, it was recreated on the same volume, and the home data, boot hook
and host key all survived. Lane B's builder can therefore keep `run-job.sh`'s
docker steps as they are. Fly's remote builder is not needed as a fallback. The
app was deleted afterwards.

### Restore drill of a real production archive (stage 0, point 12)

Production's archive of 6 Nov 03:58 was fetched off the Storage Box (38.8 MB)
and restored on a throwaway machine in the scratch org:

- `gunzip`, then `SQLite format 3`, 337 MB, `PRAGMA integrity_check` = ok.
- All 70 tables were present: 43 equal to live, 27 grown since 03:58, none
  smaller.
- All 81 `secrets` rows still carried `enc:v1:` ciphertext.
- Restoring took 3 s.

One finding: Debian bookworm's `sqlite3` (3.40) cannot read the FTS5 table
`workspace_mail_search` (`contentless_delete`), so the monthly drill must use
the backend image's SQLite. The machine and every copy of the archive were
deleted the same day.

### Backend cutover rehearsal on the test copy (stage 0, point 12)

The test copy's backend was moved to a new machine and volume with stage 4's
steps (`rehearse.sh`, kept with note #1032):

1. The old machine stops serving.
2. Online `.backup`, `integrity_check` and gzip; the sha256 matched at all
   three hops (`3b4fa7df…`).
3. The old machine is stopped.
4. A new machine starts on a fresh volume running `sleep`, the database goes
   in and is checked, then the machine is switched to the backend.

The copy came back on the new machine with `Persistence: SQLite
(/data/backend.db)`, and its Workspace, sign-in and code host all answered.

User-visible downtime was **81.5 s**, of which **40 s** was creating the new
machine, a step that production does the day before. The old machine and
volume were then deleted, so the copy-release gate finds a single backend.

## Stage 1 — backups to R2 (6 Nov 2026)

The owner made two bucket-scoped R2 keys (admins-only secrets
`BACKUP_R2_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` to read and write,
`BACKUP_R2_READ_*` to read only). Their scopes were checked before use:

- the write key can add objects, but cannot delete one (the lock answers 409)
  and cannot reach any other bucket (403);
- the read key can list and get, and is refused a write (403).

`ia-backend` then got `BACKUP_S3_*` (the write key), `DB_BACKUP_INTERVAL_HOURS=6`,
`DB_BACKUP_LOCK_DAYS=30`, `DB_BACKUP_MONITOR_JOB=db-r2`, `CENTRAL_GIT_BACKUP=on`,
`MEDIA_MIRROR=on`, and `db-r2,git-r2,media` added to `BACKUP_MONITOR_JOBS`. The
Storage Box jobs keep running beside these until the teardown.

**Seeding the repo bundles.** A fresh state uploads every repo, which can take
longer than the backend's HTTP call allows. The first run was made by hand on
the host, through the same route (`POST <GIT_HOST_CONTROL_URL>/internal/backup/run`
with the `x-git-host-secret` header): 24 repos, 784 MB, 98 s, none failed.

**Two fixes the live switch-on showed.** Production restarts on every deploy,
often a dozen times a day.

- The database backup ran 10 minutes after each boot. That made a 38 MB
  archive per deploy, each held for the lock's 30 days. Now **the bucket is
  the clock**: every 30 minutes the backend checks the newest archive and only
  takes one when it is at least the interval old.
- The repo bundles are keyed by day, and the lock refuses to overwrite a
  same-day key. A second run on the same day would therefore fail on every
  repo pushed since the first. Now the run is **at most once per UTC day**,
  recorded in `central-git-backup.last` beside the database and checked
  hourly.

## Stage 2 — the code host (prepared 6 Nov 2026)

`ia-git`, in our Fly organization in `ams`, runs the `git-host` image that
every workplace host and private copy already use, configured by
`infra/git-host-image/fly.central.toml`: always on, shared-cpu-1x with 1 GB
and 1 GB of swap, and a 10 GB volume at `/data`.

**What the Hetzner host had that the image does not**, and where each went:

| On ia-media | On Fly |
|---|---|
| Caddy refusing `/internal/*` to anyone but the backend's address | `CONTROL_PRIVATE_ONLY=1`: the host refuses `/internal/*` on anything that came through Fly's public proxy (it stamps `Fly-Client-IP`). The backend calls it over the private network: from `ia-backend` through its WireGuard peer until stage 4, natively after that. |
| `/etc/agentgit/agentgit.env` | Fly secrets (`GIT_HOST_SECRET`, `CI_WEBHOOK_URL`, `CI_WEBHOOK_SECRET`, `RECOVERY_TOKEN_*`) and `[env]` |
| hooks (`pre-receive` history guard, `post-receive`) | in the image already (`infra/git-host/hooks`) |
| nightly bundles to the Storage Box | the backend's `CENTRAL_GIT_BACKUP` to R2 (stage 1); the image's curl (Ubuntu 24.04, 8.5) signs for R2, as ia-media's did |
| `maintain-repos.sh` (trash purge, gc) weekly | not in the image yet; a later stage schedules it |
| 512 MB request body limit (Caddy) | none at the proxy |

**The cutover, in order:**

1. Copy the repos to the new volume in advance: `rsync` pulled from ia-media by
   the Fly machine, with a temporary key that is removed afterwards.
2. Pre-issue the certificate with a DNS-01 `_acme-challenge` record, and set
   `git.agentbuilt.app` to a short TTL.
3. Just before the window: confirm no CI run is in flight and no agent is
   mid-turn on a repo.
4. Window: stop and mask `agentgit` on ia-media (pushes are refused), run a
   final rsync, compare every repo's refs one by one, then point the backend's
   `GIT_HOST_CONTROL_URL` at the private address. Flip `git.agentbuilt.app` to
   the Fly app, and set ia-media's Caddy to forward to it for resolvers still
   holding the old address.
5. Check: a push, a proposal and its merge, a CI pip, a knowledge read, the
   recovery token's clone, and an R2 bundle run from the new host.

## Stage 2 — the cutover (6 Nov 2026, 18:15 UTC)

Just before the window, the CI queue was empty and no git process was running
on ia-media. Timeline:

1. 18:15:16 — `agentgit` on ia-media is stopped and masked, and pushes are
   refused from here.
2. 18:15:17 — final rsync: 31 files and 310 KB changed since the last pass,
   taking 3 s.
3. 18:15:24 — the refs of all 24 repos are identical on both hosts (a sha256
   of `for-each-ref` per repo).
4. 18:15:35 — the backend's `GIT_HOST_CONTROL_URL` becomes
   `http://ia-git.internal:8080`. Until stage 4, an `/etc/hosts` line on
   ia-backend points that name at the machine's private address, reached
   through ia-backend's WireGuard peer.
5. 18:15:39 — `git.agentbuilt.app` is switched to Fly with A and AAAA records
   at TTL 60. The certificate had been issued beforehand through
   `_acme-challenge`.
6. 18:15:41 — ia-media's Caddy now forwards `git.agentbuilt.app` to
   `ia-git.fly.dev`, for resolvers still holding the old address.
7. 18:15:42 — health answers both through Fly and through the old address.
   `/internal/*` answers 404 to the public on both paths.

Pushes were refused for **26 seconds**. Nothing on ia-media was deleted: the
repos are still there, and so is the old Caddyfile (`Caddyfile.bak-n1032`).
