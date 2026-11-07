# Webhook CI/CD (GitHub-Actions-free)

> **Lane A (2026-08-11):** `checks` can now run in a throwaway Fly machine
> instead of on this box — see **Lane A** below and
> [`docs/ci-two-lane-runner.md`](../../docs/ci-two-lane-runner.md). Deploys
> never leave this box, by design.

GitHub freezes the whole Actions service when hosted minutes go unpaid —
including jobs targeting self-hosted runners (verified live 2026-07-30).
Webhooks and the commit-status API stay free, so this directory is a minimal
CI/CD that needs nothing from GitHub but those two:

- `daemon.mjs` — listens on `ia-ci-runner:8787/webhook` for HMAC-signed
  push / pull_request events, serializes jobs, posts commit statuses
  (`ci/checks`, `deploy/prod`, …) that show up on PRs exactly like
  Actions checks did (`gh pr checks` included).
- `run-job.sh` — the job steps, mirroring the frozen workflows one to one:
  `checks` = ci-cd.yml, `deploy-prod` = backend-deploy.yml (backend-paths filter +
  guarded systemd socket migration/restart + public health poll: a disabled
  service stays down — and an ENABLED one that fails to activate or to answer
  `/api/health` within a minute is rolled back by the job itself, with
  `ia-rollback <previous sha>` on the box, before the red pip is posted), `machine-image` =
  fly-machine-image.yml (image-paths filter, boot smoke test, push, repoint),
  `self-update` (reinstalls this directory's own code into /opt/ia-ci).
  Plus the lanes that never had a workflow: `deploy-site` (Cloudflare Pages,
  runs on every main push), and `deploy-git-host` (ia-media) and
  `deploy-db-backup` (ia-backend), each shipping one `infra/` directory to the
  box it runs on and self-skipping when that directory did not change since
  the job last tried.
- `ia-ci-daemon.service` — systemd unit (runs as `runner`).

**Daemon code lives in `/opt/ia-ci`, never in the job checkout.** Jobs
`git checkout --force` the work repo to arbitrary SHAs; if the daemon ran from
there, building a commit that predates `daemon.mjs`/`run-job.sh` deletes them
out from under systemd → crash loop (the 2026-07-31 bug). Stable copies in
`/opt/ia-ci` are immune.

## What it reacts to

| Event | Action |
|---|---|
| PR opened/updated into main | `ci/checks` on the head SHA |
| push to main | `ci/self-update` (skipped when no infra/ci-runner/ changes) + `ci/checks` + `deploy/prod` (skipped when no backend/ changes) + `deploy/site` (Cloudflare Pages) + `deploy/machine-image` (skipped when no infra/fly-machine-image/ changes) |

Two queues, two disciplines. Lane B (deploys, self-update — jobs that touch
this box or the hosts) is strictly serial. Lane A (`checks`, when configured)
runs up to `LANE_A_MAX_CONCURRENT` (default 3) ephemeral machines at once —
those jobs share nothing, so a PR burst no longer queues behind itself and a
deploy never waits out a remote build. A newer commit supersedes a queued run
of the same kind (the stale SHA gets an `error` status); a *running* lane A
duplicate is cancelled and its machine destroyed — lane B never cancels,
because interrupting a deploy is strictly worse than finishing it.

Lane B protects the whole delivery once any one of its jobs starts. The
remaining jobs for that SHA keep their places, and a newer delivery queues
behind them instead of replacing them one by one. Deliveries that are still
entirely waiting may still collapse to their newest SHA; this keeps a rapid
merge burst short without turning a delivery already in progress into a
half-delivery. Checks stay independent in lane A and retain their newer-commit
cancellation rule.

Normal `deploy-prod` jobs also wait for a 30-second quiet window. A newer main
commit resets that deadline and replaces the queued job, so a rapid merge burst
causes one production restart. The surviving job is marked cumulative and runs
forced. Forced dispatch re-runs are intentionally immediate. Set
`DEPLOY_PROD_QUIET_MS` in `/etc/ia-ci/env` to tune the window, or `0` to
disable it.

### The path filter asks "since I last tried", never "in this commit"

Every self-skipping job diffs from the sha it last tried to the sha it was
given (`changed_since` in `run-job.sh`). `deploy-prod` reads its near end off
the prod host — `/opt/infinite-agents/last-attempt`, written just before the
`current` symlink moves, or that symlink's `releases/<sha>` target before the
file exists — and every other job reads `$WORKDIR/attempted/<kind>`, which the
runner writes when the job starts its work or finds an empty range. Tried, not
shipped: a release that fails its health gate is rolled back, and diffing from
what is serving would make every unrelated merge behind it try the same broken
tree again. Until 2026-09-08
the filter diffed one commit against its parent, and because the git host
fast-forwards most merges that commit is the branch's LAST one: a branch ending
in a site, docs or test commit skipped its deploy while the backend commits
under it were never looked at by anything. Coalescing masked it on busy
afternoons, which is why it read as random.

Not knowing — the host unreachable, no `current` symlink, no record, a sha
the clone no longer has — answers "run": a needless deploy costs minutes and is
health-gated with a rollback behind it, a wrong skip is invisible. A rebuilt
runner therefore runs each filtered job once before it has a record. The one
non-path skip: a sha already contained in the near end (a redelivered webhook,
a hand re-run of an old push) is never shipped, because the diff would read the
newer code as "changes" and move production backwards. Force (`IA_FORCE_JOB=1`,
a dispatch) still ships exactly what it was asked for.

### Asking for a job without a push (`POST /dispatch`)

`DISPATCHABLE` in `daemon.mjs` lists what can be asked for without a push:
`machine-image`, `git-host-image`, `msg-host-image`, `deploy-prod`, `deploy-site`. `machine-image`
is the original case, because its input lives OUTSIDE the repo: the CLI pin, in
the backend's config store. A pin bump produces no commit for a webhook to fire
on, and the job's own path filter would skip it — so a bump would silently never
reach a new machine. The deploys are dispatchable so that a deploy which failed
for a reason outside the repo can be re-run without a commit.

Same listener, same secret, same HMAC header as the GitHub webhook, so there is
nothing extra to rotate. It resolves `main`'s head itself (a dispatched build
builds the same code a push would) and runs the job with `IA_FORCE_JOB=1`, which
tells it to skip its path filter — the caller has already decided the build is
wanted.

```sh
BODY='{"kind":"machine-image","ref":"main"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -fsS -X POST http://<ci-runner-host>:8787/dispatch \
  -H "x-hub-signature-256: $SIG" -H 'content-type: application/json' -d "$BODY"
```

In practice nobody types that: `npm --prefix backend run cli:versions -- bump`
signs and sends it after writing the pins (needs `IA_CI_WEBHOOK_SECRET`).

## Lane A — untrusted jobs in ephemeral Fly machines

Why: this box is a credential vault (deploy key, `FLY_API_TOKEN`, Cloudflare)
and `checks` runs `npm ci` — safe only while every commit it builds is
ours. Lane A moves the code-executing job into a per-job Firecracker VM that
holds **no platform credentials**: only a clone token for the one repo and a
single-use HMAC key for reporting its own result. Full argument:
[`docs/ci-two-lane-runner.md`](../../docs/ci-two-lane-runner.md).

- `lane-a.mjs` — dispatcher side: creates the machine (no volume, no services,
  `auto_destroy`), injects `runner-agent.sh` via a base64 env var (`init.exec`
  decodes and runs it — no CI-specific image build), waits for the signed
  result on `/job-result`, destroys the machine unconditionally. A machine
  that dies silently is caught by a 30 s-grace death watchdog; a hung one by
  the wall clock (`LANE_A_TIMEOUT_MS`, default 30 min).
- `runner-agent.sh` — in-machine: shallow-fetches the one sha
  (actions/checkout shape), runs the same steps as the local `checks`, POSTs
  exit code + per-phase timings + a 64 KB log tail, HMAC-signed with its
  per-job key.

Config, all in `/etc/ia-ci/env` — lane A silently disables itself when any is
missing and `checks` falls back to the local path, so it can be toggled per
deploy:

```sh
FLY_API_TOKEN=...                      # already present for machine-image
LANE_A_APP=ia-ci-jobs                  # fly apps create ia-ci-jobs (once)
LANE_A_REGION=ams
LANE_A_RESULT_URL=http://<ci-runner-host>:8787/job-result
# Optional:
#   LANE_A_GUEST=performance-4x-8192   # job machine shape; see lane-a.mjs
#   LANE_A_MAX_CONCURRENT=3            # simultaneous job machines
#   LANE_A_FALLBACK_REGION=fra         # one create retry when ams declines
#   LANE_A_TIMEOUT_MS=1800000          # hard wall-clock kill (30 min)
#   LANE_A_IMAGE=registry.fly.io/…     # OVERRIDE only — see below
#   DEPLOY_PROD_QUIET_MS=30000         # main deploy debounce; 0 disables
# Mini App statuses (docs/ci-status-miniapp.md) — optional; unset, GitHub
# stays the only reader of CI verdicts:
#   STATUS_INGEST_URL=https://<backend>/api/agent-cli/git/statuses
#   CI_STATUS_SECRET=...               # same value in the backend's env
```

Every verdict (pending / success / failure / error / **skipped** — exit 78
from a path-filtered job) is POSTed to the ingest as well as GitHub, with the
repo identity taken from the webhook delivery, so platform-hosted repos file
under their owner automatically. The backend silently drops repos it does not
host. Failed jobs carry a 64 KB log tail for the Mini App's Checks card.

The image comes from `/opt/ia-ci/lane-a-image`, which the `machine-image` job
rewrites every time it repoints the fleet — CI machines follow agents' machines
automatically, read per job so no restart is needed. Setting `LANE_A_IMAGE`
pins past that (rollback lever); unset it to resume following. First install
on a new box: seed the file by hand with the current fleet ref.

Measured on `shared-2x-2048mb` (2026-08-11, phase 0 — full numbers in the
design doc): create→SSH-ready 31 s, clone 6 s, `npm ci` 112 s + 16 s, frontend
tests 19 s, build 16 s. Cold installs dominated then.

Re-measured 2026-09-05 on a quiet 4-core VM, step by step as `.agentbuilt/
ci.sh` ran them in sequence: installs 22 s + 8 s, frontend tests 6 s, lint
16 s, frontend build 14 s, backend build 19 s, backend tests 94 s — 179 s,
of which the backend suite is over half and both installs together a sixth.
A deps-baked image is now worth ~30 s a job, not minutes. What dominates
instead is HOST VARIANCE: the same job passes in ~5 min on a quiet host and
took 13.6 min on a busy one (2026-09-04), then was killed at the 15-minute
wall on the next push with nothing red. Two answers, both in that day's
change: the wall clock default is 30 min, and `ci.sh` runs the frontend and
backend as two lanes after one install pass (~2 min quiet — the backend suite
leaves two cores idle, and the frontend lane fits there). That pass also
installs the backend ONCE: the root package.json's postinstall hook already
ran `npm --prefix backend install`, so the old second `npm ci` in backend/
threw the tree away and rebuilt it. If `/etc/ia-ci/env` pins
`LANE_A_TIMEOUT_MS`, the code default does not apply until that line changes
too.

## Not covered (still needs Actions or a manual run)

- PR preview site deploys (`preview-deploy.yml`) — only the production site
  (`deploy-site`, since 2026-07-31) is wired; its secrets in `/etc/ia-ci/env`
  are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Each can move here later by placing its secret in `/etc/ia-ci/env` and adding
a case to `run-job.sh`.

## The `machine-image` job (moved here 2026-08-07)

Fly machine images used to be in the "not covered" list above, and the cost of
that was invisible: `fly-machine-image.yml` runs on `ubuntu-latest`, so it
froze with the rest of Actions on 2026-07-30. Image changes kept merging, and
every new agent machine kept booting the image built on **2026-07-28** — nine
days and four merged changes with nothing to show for it. Nobody sees a job
that does not run.

The job builds the image, runs `smoke-test.sh` (boots it, SSHes in, checks the
CLIs, installs a `~/.boot.d` hook, then recreates the container on the same
volume and verifies the home data and hook survived), pushes to
`ghcr.io/<owner>/ia-machine-images:sha-<12>-c<claude>-x<codex>-o<opencode>` (public — what the fleet
boots from, client orgs included) and `registry.fly.io/ia-machine-images:` the same tag
(the rollback copy), and finally calls `set-machine-image` on the backend host
with the ghcr ref so new machines actually boot it. Needs `GHCR_PUSH_TOKEN`
(a classic PAT with `write:packages`) and `GHCR_OWNER` (the ghcr.io account
that owns the package, and the docker-login user for it) in `/etc/ia-ci/env`
beside `FLY_API_TOKEN`. The backend host needs the same account in
`/etc/infinite-agents/ghcr-owner`, which is what `set-machine-image` allows
the repoint against — neither name lives in this repository.

- **Existing machines are untouched by the build itself.** Repointing only
  changes what new machines are created from, which is why it is safe to
  automate once the smoke test has passed. They converge separately, and
  without an operator: the backend's `MachineImageUpdater` rolls each machine
  onto this ref the next time it is found asleep, so the fleet catches up
  within a sleep cycle. `backend/scripts/roll-machine-image.mjs` is still there
  to force the rest immediately.
- **No flyctl needed:** the Fly registry accepts the API token as a docker
  password, so `docker login registry.fly.io -u x` is the whole auth step.
- **The tag names everything the image is built from** (note #1052): the
  commit AND the three pinned CLIs, for example
  `sha-0477944f1b34-c2.1.316-x0.166.0-o1.19.5` (`+` in a version is written
  `_`). Until then it was `sha-<12>` alone, so a pin bump rebuilt at an
  unchanged commit pushed new bytes under the old tag, and the image roller —
  which compares tags — read every machine on the old bytes as current. Now a
  bump is a new tag. And **a published tag is never pushed over**: before
  building, the job asks ghcr whether the tag exists; if it does (same commit,
  same pins), it only repoints. One tag is one set of bytes. If ghcr gives no
  clear answer the job fails rather than guess. The bash `machine_image_label`
  mirrors `machineImageTag()` in `backend/src/services/machine-image-tag.ts`;
  `machine-image-tag.test.ts` runs both. The GitHub workflow's `sha-<12>` label
  no longer matches — it has been frozen since 2026-07-30; leave it frozen.
- **CLI versions come from the fleet pin, never npm latest** (since 2026-08-08).
  The job reads `GET /api/harness-cli-versions` off the backend host and passes
  the exact versions as build args; a missing or invalid pin fails the build
  rather than letting the registry choose. See
  [how a change reaches a machine](../../docs/machine-update-channels.md).

### The copy-release gate (note #1008)

`copy-release` builds a release for companies (`infra/copy-release/build.sh`),
then runs `infra/copy-release/gate.sh`: the standing test copy (a real
Agentic Cloud in our scratch Fly organization) takes the release's
`--drill backend`, `--drill` and the upgrade itself. Only when all pass does
`offer.mjs` push `offered-<version>`, and the update service names the
release latest. A red `deploy/copy-release` after a green build means *built,
not offered*. `copy-release-gate` (dispatchable) runs the gate alone again.
Its settings, in `/etc/ia-ci/env`:

```sh
COPY_TEST_FLY_TOKEN="FlyV1 ..."                    # the scratch organization's token
COPY_TEST_STATE_DIR=/home/runner/ci-work/copy-test # holds acc-testcopy-copy.json (names only)
```

The gate fetches its own pinned flyctl into `$COPY_TEST_STATE_DIR`. The test
copy, who may touch it and how to rebuild it: knowledge page private-copy,
"The standing test copy".

### Box requirements for this job

```sh
apt-get install -y docker.io          # smoke test needs --cap-add SYS_ADMIN
usermod -aG docker runner             # then restart ia-ci-daemon
printf 'FLY_API_TOKEN=...\n' >> /etc/ia-ci/env
```

And once, on the backend host (`ia-backend`), so the repoint has something to
call — `infra/backend-host/provision.sh` installs it and is idempotent:

```sh
./infra/backend-host/provision.sh     # installs /usr/local/bin/set-machine-image
```

Until both are in place the job fails loudly on its preflight (`docker is not
installed…`, `FLY_API_TOKEN unset…`) rather than half-building something.

## The `git-host-image` job

Same shape, for the image a workplace's own code host starts from
(byo-git-design). It builds `infra/git-host-image/` around the same
`infra/git-host/` files `deploy-git-host` ships to the central host, runs
`infra/git-host-image/smoke-test.sh`, pushes
`ghcr.io/<owner>/ia-machine-images:git-host-sha-<12>`, and then calls
`set-machine-image --git-host <that ref>` on the backend host, so production's
`FLY_GIT_HOST_IMAGE` always names the newest green build. Before note #809
(27 Oct 2026) it stopped at the push, and production named the 23 August image
for two months. Self-skips unless `infra/git-host{,-image}/` changed; dispatch
it to rebuild and repoint without a commit. A red build leaves the setting on
the last good image. Code hosts that already exist are not rolled by it.

## The `msg-host-image` job

The same for the image a workplace's messaging machine starts from (note
#608). It builds `infra/msg-host-image/` around `infra/msg-host/msg-host.mjs`,
runs `infra/msg-host-image/smoke-test.sh`, pushes
`ghcr.io/<owner>/ia-machine-images:msg-host-sha-<12>`, and calls
`set-machine-image --msg-host <that ref>` on the backend host. Until note #819
(28 Oct 2026) it stopped at the push and production was repointed by hand.
Self-skips unless `infra/msg-host{,-image}/` changed; dispatch it to rebuild
and repoint without a commit. Messaging machines that already exist keep
their own image: the backend only ever wakes one, it never rebuilds it.

## Box setup (already done on ia-ci-runner, <ci-runner-host>)

```sh
apt-get install -y git rsync curl build-essential   # + Node 22 (nodesource)
useradd -m runner
sudo -u runner git clone https://x-access-token:<GH_TOKEN>@github.com/<owner>/infinite-agents \
  /home/runner/ci-work/repo
install -m 600 <hetzner-cloud private key> /home/runner/.ssh/deploy_key   # owner: runner
printf 'GH_TOKEN=...\nWEBHOOK_SECRET=...\nREPO=<owner>/infinite-agents\n' > /etc/ia-ci/env
chmod 600 /etc/ia-ci/env
# Stable daemon code — NOT run from the mutable work checkout:
install -d -o runner /opt/ia-ci
install -o runner -m 755 /home/runner/ci-work/repo/infra/ci-runner/{daemon.mjs,lane-a.mjs,run-job.sh,runner-agent.sh} /opt/ia-ci/
cp /home/runner/ci-work/repo/infra/ci-runner/ia-ci-daemon.service /etc/systemd/system/
systemctl enable --now ia-ci-daemon
```

## Updating the daemon after changing this directory

**Automatic since 2026-08-07** — the `self-update` job does it. It is queued
first on every main push and skips unless the commit touched
`infra/ci-runner/`, so a fix to this directory takes effect on the very push
that merged it.

How it avoids the two ways this goes wrong:

- **It validates before replacing.** `node --check` on `daemon.mjs`, `bash -n`
  on `run-job.sh`. A daemon that will not parse would crash-loop with no CI
  left to fix it with, so a bad commit is refused with `/opt/ia-ci` untouched.
- **It installs by atomic rename, never a write in place.** `run-job.sh` is
  replacing *itself* while bash is still reading it. An in-place write makes
  the running shell resume at its old byte offset inside the new file and
  execute whatever lands there — measured, not theoretical: a test script
  rewritten in place printed three lines from its replacement instead of
  finishing its own. `cp` to a temp then `mv` swaps the directory entry, and
  the running process keeps its original inode.
- **The restart needs no sudo.** `run-job.sh` is spawned fresh per job, so the
  next job already runs the new copy. `daemon.mjs` is long-lived, so the job
  drops `/opt/ia-ci/.restart-requested`; the daemon consumes it once the queue
  is idle and exits cleanly, and `Restart=always` brings it back on the new
  code three seconds later. Nothing runs as root, and no job is dropped.

The previous copies are kept as `daemon.mjs.previous` / `run-job.sh.previous`
for a manual rollback.

Still needed by hand for the FIRST install on a new box, or to recover from a
daemon that will not start:

```sh
sudo -u runner git -C /home/runner/ci-work/repo fetch -q origin
sudo -u runner git -C /home/runner/ci-work/repo checkout -qf origin/main   # or dev
install -o runner -m 755 /home/runner/ci-work/repo/infra/ci-runner/{daemon.mjs,lane-a.mjs,run-job.sh,runner-agent.sh} /opt/ia-ci/
systemctl restart ia-ci-daemon
```

Repo webhook (Settings → Webhooks, or API): `http://<ci-runner-host>:8787/webhook`,
content type JSON, secret = `WEBHOOK_SECRET`, events: push + pull requests.
Payloads are HMAC-SHA256-verified; the endpoint is plain HTTP — fine for
integrity (signature), and no secrets ride in the payloads.

## Operating it

- Statuses on PRs / `gh pr checks` — same as before.
- `curl http://<ci-runner-host>:8787/health` → `{ok, queued, running}`.
- Logs: `journalctl -u ia-ci-daemon -f` (daemon), `/home/runner/ci-logs/*.log`
  (one file per job, referenced from the commit status description).
- Updating daemon/run-job code: see "Updating the daemon" above (re-install to
  /opt/ia-ci; the work checkout alone is not what runs).
