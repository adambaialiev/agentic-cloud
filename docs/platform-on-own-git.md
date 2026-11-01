# The platform repo on our own git host — and the end of lane B

Direction set by Owner 2026-08-13; this doc is the design. It reverses a
decision recorded one day earlier in `agent-git-project-repos.md` ("the
platform monorepo stays on GitHub permanently"), and the reversal is worth a
sentence: the internal host has since grown every feature the platform repo
needs (multi-branch protection, live proposals, required checks, squash
merges, CI on every push, deploy secrets, an admin surface), and a git
product whose own makers keep their code somewhere else is making an argument
against itself. The platform should be its own biggest user.

Companion docs: `ci-two-lane-runner.md` (the two lanes this retires half of),
`agent-git-project-repos.md` (the host features this stands on).

## The fear, in plain words

Our git host checks every clone by asking the backend "is this token real?" —
and when the backend cannot answer, it says no to everyone. That is the right
default for user repos. But if the platform's own code lives behind that
check, then the day the backend is broken is the day nobody can fetch the
code that fixes the backend.

It is a locked house with the only key inside. Nothing else about the
migration is hard; this is the part that has to be designed rather than
hoped about.

The rule every piece below follows: **the path that repairs the backend must
not contain the backend.**

## The circle has three links, and each gets its own answer

"Can we fix prod while the backend is down?" decomposes into exactly three
dependencies. Naming them separately matters, because each has a different
right answer and lumping them together produces either panic or a
false all-clear.

1. **Getting the code** (clone auth). Today: backend call, fail closed.
   Answer: a **recovery token** the git host verifies from its own
   environment — no backend call, scoped to the one platform repo, read-only.
   Every other token keeps failing closed exactly as today. This is a spare
   key that opens one door: taped where the owner can reach it, and useless
   for anything but reading the one repo. Design below.
2. **Running the deploy** (dispatch). Something has to boot lane A machines
   and run release steps, and lane A cannot boot itself — a machine cannot
   create itself; something must hold the Fly token. The answer is already
   in place: the controller (`daemon.mjs` on `ia-ci-runner`) lives OUTSIDE
   the backend. What this design kills is not the controller but its other
   identity — *a box that executes repo code while holding the platform's
   keys*. Stripped of builds (below) it is a queue, a webhook listener, a
   Fly lifecycle, and a hand that moves files. This also settles
   `ci-two-lane-runner.md`'s open question 2 — "move dispatch into the
   backend?" — with a firm **no, permanently**: doing so would put the
   backend inside its own repair path.
3. **The keys** (deploy credentials). Our deploy keys (`deploy_key`,
   `FLY_API_TOKEN`, Cloudflare) stay in the controller's own env
   (`/etc/ia-ci/env`), never fetched from the backend's secret store.
   Already true; now it is a rule instead of an accident. Users' CI secrets
   keep coming from the backend and keep failing closed — a user's deploy
   failing during a backend outage is an inconvenience; ours is an emergency.
   The asymmetry is the design.

## Four layers of a bad day

Most outages are not "the repo is unreachable" — they are "we shipped
something bad", and the fix is going back one step, not forward. Order the
escape routes by how bad the day actually is, and the expensive ones almost
never get used:

| # | The day | The move | Needs git? | Needs backend? |
|---|---|---|---|---|
| 1 | shipped a bad release | **`rollback` — flip `current` to the previous release, restart** | no | no |
| 2 | need a roll-forward fix; backend down | clone with the **recovery token**, build in lane A, release | our host only | no |
| 3 | git host down too | clone the **GitHub read-only mirror** | GitHub | no |
| 4 | everything down | restore from the Storage Box **bundles** (drilled 2026-08-12) | no | no |

Layer 1 is nearly built: `deploy-prod` already keeps the 5 most recent
releases under `/opt/infinite-agents/releases/<sha>` with a `current`
symlink. What is missing is the one command — a `rollback` job on the
controller (and a script on ia-backend itself, for the day the controller is
also sick): pick `releases/` entry N−1, flip the symlink, restart, health
check. It touches neither git nor the backend's own machinery, which is the
whole point. Ship it FIRST, before any migration step, because it makes every
later step safer to take.

## "Retiring lane B" means: the controller stops executing repo code

Lane B today is a list of jobs on the keyed box. Each needs a stated home,
because "retire lane B" done vaguely would retire the wrong half:

| job | what it does today | where it goes |
|---|---|---|
| `checks` | `npm ci` ×2 + tests + build **on the keyed box** | dies — the platform repo's checks run in lane A like every repo's (they already do for agentgit pushes; the GitHub-webhook path is what dies) |
| `deploy-prod` | `npm ci` + build **on the keyed box**, then rsync/restart | **split**: build in a lane A machine → controller pulls the artifact out → verify, rsync, symlink, restart, health check |
| `deploy-site` | `npm ci` + build, then wrangler upload | build in lane A; controller pulls `dist/` and runs a **pinned** wrangler with the Cloudflare token |
| `machine-image` | docker build + push to `registry.fly.io` | stays, as a named exception — see below |
| `deploy-git-host` / `deploy-db-backup` | validate (`node --check`, `bash -n`) + rsync + restart | stay — validation parses, never executes; these are already release-steps-only |
| `self-update` | copy files into `/opt/ia-ci` | stays |

The precise rule at the end: **the controller never runs `npm ci`, `npm
run`, or any package lifecycle script.** It parses, copies, restarts, and
health-checks. The box that holds the prod key becomes a box on which
repo-authored code has no execution path — which was the entire point of the
two-lane split, finally finished.

**The named exception: `machine-image`.** Docker build executes the
Dockerfile's `RUN` steps on the controller. Mitigations that keep it
tolerable: the content is post-review protected-branch code, and docker is a
container boundary the plain `npm ci` never had. The clean fix is Fly's
remote builders (`flyctl deploy --remote-only` ships the build context and
builds on Fly's own builder; the controller keeps only the token). Worth a
try early — if it works, the exception disappears; if it doesn't, the
exception is documented rather than denied.

### The artifact path

The build machine is untrusted by design and holds no credentials — and it
cannot be reached from outside either: a CI machine runs no sshd (its init IS
the job), and the controller is no peer on Fly's private network. (This
paragraph first said the controller "reaches in and takes" the artifact;
implementing it corrected that.) So the machine **pushes the tarball out** to
the controller's `/job-artifact`, signed with the same per-job HMAC its
result report uses — over the artifact's own sha256, so a machine can
deliver exactly its own job's artifact, intact, and nothing else. The deploy
then verifies the `RELEASE_SHA` inside the tarball matches the sha it was
asked to ship before a byte reaches a host. The only credential in play
remains the per-job token, worthless beyond its one job.

A hostile build can still produce a hostile *artifact* — that is true today
too (the code was going to run on prod anyway; that is what review and
required checks are for). What it can no longer do is run anything on the
box that holds the keys.

## The recovery token, precisely

- **Kind**: one static token, high-entropy, held as a **hash** in
  `/etc/agentgit/agentgit.env` (`RECOVERY_TOKEN_SHA256=…`), with its scope
  pinned beside it in env (`RECOVERY_TOKEN_REPO=<owner>/<repo>`), not
  carried by the token.
- **Check**: in `verifyToken`, before the backend call — token hashes to the
  env value → auth is `{ scope: { repo: RECOVERY_TOKEN_REPO, readOnly:
  true } }`, no network. Anything else → backend, fail closed, unchanged.
  The host already enforces exactly this scope shape for `cit1.` clone
  tokens, so enforcement is existing code.
- **Powers**: read one repo. It cannot push, cannot see other repos, cannot
  reach the API. Stolen, it leaks source we were about to mirror to GitHub
  anyway — bad, but not keys, not user data, not lateral movement.
- **Holders**: the Workspace secret store (Owner copies it out from there
  to somewhere of his own that survives our stack being down — the store
  copy alone is not enough, since it sits inside the backend's database) and
  the controller's env (for the drill below). Rotation is: generate, update
  env on ia-media, redistribute — and the drill is what proves a rotation
  took.
- **Provisioning**: via `provision.sh` env like the CI webhook pair, so a
  rebuilt host restores it instead of silently losing it
  (`deploy-git-host` does not re-run provision — the #1106 lesson).

*Host side implemented 2026-08-13: `recoveryAuth` in git-host.mjs, checked
before the cache and before any network. Pinned by a test that boots the real
host against a dead backend port: the agent token fails closed, the recovery
token still clones, and it can neither push nor read a second repo. The
weekly drill and the mirror lane are the follow-up PR.*

## Drive on the escape road

A spare key nobody has turned in years opens nothing. A scheduled job on the
controller (weekly is enough) clones the platform repo **using the recovery
token and nothing else**, checks HEAD resolves and matches the mirror, and
reports through the existing backup-heartbeat/ops-bot path. The break-glass
path then rots on a boring Tuesday — where a red heartbeat fixes it — instead
of during the outage it exists for.

*Implemented 2026-08-13, DAILY rather than weekly: daily needs no backend
change at all — the staleness monitor's 48-hour rule covers a daily job the
same way it covers the nightly backups, and its job list is already env
(`BACKUP_MONITOR_JOBS=git,db,recovery-drill`). The dispatcher checks a stamp
file hourly, shallow-clones with the recovery token under a throwaway HOME
(netrc, never argv), and reports ok/fail; a failure does not refresh the
stamp's meaning to the monitor, so two bad days alert.*

## The mirror inverts

Today: GitHub is the source of truth. After: **our host is the source of
truth; GitHub is a read-only copy outside our own stack.** On every ref move
of the platform repo (the `notifyRefMoved` delivery already fires on all of
them, #1112) the controller runs a `mirror-github` job: `git push --mirror`
with the existing `GH_TOKEN`. Nothing anywhere depends on the mirror — a
failed mirror push alerts and blocks nothing. It exists for layer 3 of the
bad day, for human browsing until our own surfaces mature, and as the
answer to "what if ia-media's disk dies between backups".

*Implemented 2026-08-13, shipped INERT: the `mirror-github` lane exists in
the dispatcher and run-job.sh, gated twice on `PLATFORM_REPO` — the daemon
queues it only for the one repo named in its own env, and the job itself
exits skipped when the env is unset. Step 4's flip is setting that variable.
The mirror FETCHES from our host with the recovery token (read-only, one
repo — so every mirror run also drives the escape road) and pushes heads and
tags to GitHub pruned and forced, the honest shape for a read-only copy.*

## Slice 6 became a blocker

Only agent tokens and CI clone tokens can touch a repo today; a person with
a laptop cannot clone from our host at all. That was tolerable for agent
projects. It is disqualifying for the platform repo: the person who owns the
platform must be able to check its code out with nothing but a laptop and a
credential. So slice 6 (the human credential — a personal token verified by
the normal backend path; the recovery token covers the outage case) moves
from "nice to have" to **prerequisite**, and gets its own slice PR before the
migration step.

## Migration order

Each step is independently useful and independently shippable; nothing below
step 4 commits us to anything.

1. **Rollback command + artifact-build-in-lane-A.** The last `npm ci` leaves
   the keyed box; `rollback` becomes one command. Worth doing even if the
   repo never moves, and it is the step every later one leans on. (Try
   remote builders for `machine-image` here too.)
2. **Slice 6 — the human credential.** Owner clones the platform repo (any
   repo) to a laptop.
3. **Recovery token + mirror job + weekly drill.** The escape road exists
   and is being driven before anyone needs it. (The mirror job can run
   before the migration as a dry loop on a test repo.)
4. **The move.** Create the platform repo in Owner's own namespace like
   every other repo (decided 2026-08-13; the pack is 106 MiB against the
   300 MB per-repo cap and 1 GB user quota, so nothing special is needed),
   push history, protect `main` with `--require-checks`, enable CI, flip the
   controller's trust rule (below), agents repoint `origin`, GitHub becomes
   the mirror target. Lane B's GitHub-webhook jobs retire.

**The controller's trust rule after the move**: today it routes by which
signature header carried the event — GitHub-signed events may queue deploys,
agentgit-signed events only ever queue lane A checks. After the move that
becomes: agentgit events for **the one repo named in the controller's own
env** (`PLATFORM_REPO=…`), on its protected branch, may queue deploy jobs;
every other agentgit event stays checks-only. The payload never decides
trust; the controller's env does — same shape as the recovery token's scope.

## What we give up, honestly

- **GitHub's review UI** for the highest-velocity repo we have, traded for
  Telegram cards + the Mini App diff view. The Mini App diff is good; it is
  not side-by-side-with-comment-threads good. Daily-friction cost, not a
  security one.
- **`gh` muscle memory** → `agentbuilt pr`. Every note, script and habit
  that says `gh pr create` needs updating; agent docs too (that PR bumps
  `TELEGRAM_AGENT_IDENTITY_VERSION`).
- **Actions** — nothing; it froze 2026-07-30 and the pipeline already lives
  on our runner.
- What we do NOT give up: an off-stack copy. The inverted mirror keeps one
  on GitHub, now with an honest job title.

## Decided 2026-08-13 (Owner)

1. **The merge gate stays a manual tap per PR.** The velocity worry was
   misplaced: he approves every PR manually on GitHub today too, so the
   move changes where the button is, not who presses it or how often. No
   auto-merge flag, no trusted-proposer tier — the gate the internal host
   already has IS the workflow.
2. **The repo lives in his personal namespace**, like every other repo (see
   migration step 4 — the quotas fit as-is).
3. **Recovery token custody**: minted into the Workspace store; he copies
   it from there to storage of his own outside our stack.
4. **The human credential is single-user**: one personal token, his,
   verified by the normal backend path. Multi-human comes later if ever.

## Open questions

1. **`machine-image` build location** — remote builders, or documented
   exception (above).
2. **CI history depth** — the Mini App shows the proposal card's checks and
   commit pips; "what did the deploy print at 3am" currently means the
   controller's journal. Fine for us today, worth a surface eventually.
