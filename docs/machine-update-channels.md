# How a change reaches an agent's machine

Written 2026-08-08, after a day of getting this wrong in three different ways.

An agent machine is not one thing you can update. It is **three layers with
different durability**, and each has exactly one mechanism that can change it on
a machine that already exists. Pick the wrong layer and your change ships to new
machines only — silently, with every test green.

| Layer | What lives there | Owner | Reaches existing machines? |
|---|---|---|---|
| **Home** (`/home/agent`, on the volume) | `CLAUDE.md` / `AGENTS.md`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.agentbuilt/`, `~/.boot.d/` | The **identity write** | Yes — next turn, when the version moved |
| **CLI version** | which `claude` / `codex` is installed | The **pin** in the config store | Yes — next sleep, or a tap in Telegram |
| **Rootfs** (everything else) | `entrypoint.sh`, sshd config, OS packages, the baked CLIs, the home skeleton | The **machine image** | Yes — rolled while the machine sleeps |

The volume survives everything. The rootfs is replaced wholesale by an image
roll, which is why anything an agent installs itself belongs in `~/.boot.d/*.sh`.

---

## 1. Home — the identity write

`writeTelegramAgentIdentity` (`backend/src/services/agent-service.ts`)
SSHes in and rewrites the agent's home files. It fires at agent creation, on
rename or machine rebuild, and **at turn start whenever the machine's stored
`identityVersion` differs from `TELEGRAM_AGENT_IDENTITY_VERSION`** — one integer
compare on the hot path, SSH only when stale.

It carries:

- `~/CLAUDE.md` and `~/AGENTS.md` — everything below the `MACHINE-FACTS:END`
  marker is replaced. The facts block above it belongs to `entrypoint.sh`, which
  checks it on every boot and rewrites it **only when a fact actually changed**;
  an unchanged boot leaves the file byte-identical, mtime included. The script
  creates both files if they are missing, markers included, so it depends on
  nothing having been seeded first.

  **Writing to these files is never free**, whichever channel does it. They are
  the agent's instruction files: the coding CLI re-reads them every turn and
  compares them against the copy it injected when the conversation started, and
  one changed byte makes it re-send the ENTIRE file into the live conversation
  as *"these differ from their earlier copies"* — ours is ~48 KB, about 12k
  tokens, which then sits in that conversation's context window for good. That
  is the price an identity bump pays on every open conversation, and it is fair
  for docs that really moved; it was pure waste when a boot moved only the facts
  timestamp, which is what the entrypoint rule above fixed (note #475).
- `~/.agentbuilt/config.json` + a `~/.boot.d/` installer, so the CLI survives
  image rolls.
- `~/.claude/settings.json` and `~/.codex/config.toml` — **merged**, not
  overwritten: those files also hold the agent's own permissions, hooks and
  model choice, and only the operator keys are touched.

### The failure mode

**Forgetting to bump `TELEGRAM_AGENT_IDENTITY_VERSION` means the change reaches
nobody who already has a machine.** No error, no warning: the code is correct,
the tests pass, and every existing agent silently keeps the old text. It has
happened twice for real (#979, #980), which is why a test now pins the rendered
template against the version so the two cannot drift apart unnoticed.

The version gates **the write, not just the prose**. v19 shipped no text change
at all — it existed to deliver the CLI settings convergence. If the script does
something new, it needs a bump.

---

## 2. CLI version — the pin

The pinned versions live in one config document (`config/harnessCliVersions`),
written **only** by `npm --prefix backend run cli:versions` — a deliberate human
act, never an automatic follow of npm `latest`. Three readers, and they must all
agree:

- **Existing machines**: `HarnessCliUpdater` compares the installed version
  against the pin just before the idle reaper stops the machine, and
  `npm install -g <pkg>@<pin>` if they differ. Free: the machine is already
  idle and nobody is waiting.
- **The Telegram menu**: the Version view shows the installed version and offers
  an Update button when it differs from the pin.
- **New machines**: the image build asks the backend for the pin
  (`GET /api/harness-cli-versions`) and bakes exactly those versions.

A bump therefore has to move two things, and does:

```
cli:versions bump
  ├─ writes the pin          → existing machines converge at their next sleep
  └─ POST /dispatch to CI    → image rebuilt from the new pin, prod repointed
                               → new machines boot it, fleet rolls while asleep
```

The dispatch exists because **the pin is not in git**. A bump produces no commit
for a webhook to fire on, and the image job's path filter would skip it. See
[`infra/ci-runner/README.md`](../infra/ci-runner/README.md) → `POST /dispatch`.

Until 2026-08-08 the image baked `latest` instead, so every image build was a
version decision made by the npm registry — which the updater then undid at the
next sleep, but only for the one CLI that machine's agent actually uses. The
others drifted quietly. Two owners of one number is the bug to watch for here.

---

## 3. Rootfs — the machine image

Built by the `machine-image` job on the CI runner (**not** GitHub Actions, which
has been frozen since 2026-07-30): build → `smoke-test.sh` → push to
`ghcr.io/<owner>/ia-machine-images:sha-<12>` (the PUBLIC ref the fleet
boots from — client Fly orgs can only pull public images; byo-fly-design) and
`registry.fly.io/ia-machine-images:sha-<12>` (the rollback copy) →
`set-machine-image` repoints `FLY_MACHINE_IMAGE` on the backend host at the
ghcr ref.

Repointing only decides what NEW machines are created from. Existing machines
converge separately: `MachineImageUpdater` writes the new ref onto a machine
**while it is stopped**, so nothing is interrupted and the machine boots the new
rootfs on its next wake.

Two guards worth knowing before you conclude it is broken:

- **The job only runs when a push touched `infra/fly-machine-image/`.** A
  `/dispatch` sets `IA_FORCE_JOB=1` to skip that filter.
- **The reaper stops and rolls NOTHING for the first 15 minutes after a backend
  restart** (`bootGraceMs`, defaulting to `idleMs`). The activity map is in
  memory, so right after a deploy an agent that messaged a minute ago is
  indistinguishable from one idle all week, and it declines to guess. Every roll
  goes through the same `decideStop` gate, so a fresh deploy means a quiet fleet
  for 15 minutes. That is not a fault, and waking a machine does not help — a
  machine cannot roll while it is awake, and a message resets the idle clock.

### The skeleton is not a channel

`infra/fly-machine-image/skel/` seeds a volume **once**, on first boot, behind
`/data/.ia-initialized`. Later boots skip it — image rolls included. Nothing you
put there reaches a machine that already exists. It is a stub on purpose: the
machine-facts markers plus the few lines of physics that never change.

---

## Which channel do I need?

| I want to change… | Channel | What to do |
|---|---|---|
| What the agent is told it can do | Home | Edit `buildTelegramAgentPlatformDocs` / the identity block, **bump `TELEGRAM_AGENT_IDENTITY_VERSION`** |
| A CLI operator default (attribution, autoupdater) | Home | Edit `buildTelegramAgentCliDefaultsScript`, bump the version |
| Which `claude` / `codex` version runs | Pin | `cli:versions bump` (or `set --claude X`) |
| Boot behaviour, sshd, an OS package | Rootfs | Change `infra/fly-machine-image/`, merge — CI builds and repoints |
| What a NEW machine's home starts with | Skeleton | `skel/` — and remember it reaches nobody else |

If a change could be made in two of these, put it in the one that reaches
existing machines, and have the other point at it. Restating it in both is how
they drift.

---

## Verifying, in order of trustworthiness

Read the artifact, not the pipeline. Every one of these has caught something a
log or a green check did not.

```sh
# Which docs version a machine actually holds (run on the machine)
grep platform-docs ~/CLAUDE.md

# Did the identity write really run just now? mtimes, not contents — the
# contents may have been right since first boot.
stat -c '%y %n' ~/CLAUDE.md ~/.claude/settings.json ~/.codex/config.toml

# What CLI versions are baked into an image (override the entrypoint, or you
# get sshd). Needs docker + the Fly token, so: on the CI runner.
sed -n 's/^FLY_API_TOKEN=//p' /etc/ia-ci/env | head -1 | tr -d '"' \
  | docker login registry.fly.io --username x --password-stdin
docker run --rm --entrypoint sh registry.fly.io/ia-machine-images:sha-<12> \
  -c 'claude --version; codex --version'

# What every machine in the fleet is actually running (authoritative; the
# backend log tells you what it TRIED to do)
curl -fsS -H "Authorization: Bearer $FLY_API_TOKEN" \
  "https://api.machines.dev/v1/apps?org_slug=$FLY_ORG"
curl -fsS -H "Authorization: Bearer $FLY_API_TOKEN" \
  "https://api.machines.dev/v1/apps/<app>/machines"   # .[].state, .[].config.image

# The live pin (on the backend host; better-sqlite3 resolves only from current/)
cd /opt/infinite-agents/current && node -e '
  const db = require("better-sqlite3")("/var/lib/infinite-agents/backend.db", { readonly: true });
  console.log(db.prepare("SELECT doc FROM config_docs WHERE doc_id = ?").get("config/harnessCliVersions"));'

# Did CI actually run the job that matters? deploy/prod passing says NOTHING
# about machine-image.
journalctl -u ia-ci-daemon --since '1 hour ago' | grep -E 'start|done'
```

---

## Traps that have actually cost time

- **"CI is green" is per-job.** An infra change is not shipped until the
  `machine-image` job has run — and it self-skips unless the push touched its
  paths (#999 → #1001).
- **`smoke-test.sh` builds the image itself.** Any build-arg contract has to be
  honoured in two places, or the job dies *after* a clean build (#1001).
- **A mechanism pointing at a dead trigger reports success and does nothing.**
  `cli:versions` dispatched a GitHub Actions workflow for nine days after
  Actions froze (#1000). Check the trigger, not just the code.
- **Verify a good-looking result as hard as a bad one.** Correct-looking CLI
  settings on a machine proved nothing — they had been seeded at first boot.
  Only the mtime distinguished "converged just now" from "shipped in July".
- **Reproduce on the box where it fails before theorising about the tool.** A
  three-line build on the runner disproved a confident wrong diagnosis about
  Docker `ARG` semantics in thirty seconds.
