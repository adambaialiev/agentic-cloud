# CI status in the Mini App — design

> **Implemented 2026-08-11** (storage + ingest + daemon sender + the pip,
> Checks card / "Approve anyway", and commit-history surfaces). Deviations
> from the below, chosen during the build: stale `pending`s are translated to
> `error` at READ time (`effectiveStatusState`, 30 min) instead of a sweep
> job — same honesty, no scheduler; and the repo-row "prod: N commits behind"
> line is deferred until platform repos have deploy statuses at all. GitHub's
> status API has no `skipped` state, so GitHub receives success-with-honest-
> words while the platform ingest carries the real state.

The Mini App shows repositories and change proposals. It does not show whether
anything **built**, **passed** or **deployed** — the one fact a person needs
before approving a proposal, and the one fact nobody can currently get without
an SSH session.

CI already runs on our own box (`infra/ci-runner/`, since 2026-07-30, when
GitHub froze Actions; where jobs *execute* is evolving separately — see
[`ci-two-lane-runner.md`](./ci-two-lane-runner.md)). Its verdicts go to
exactly one place:
`api.github.com/repos/<REPO>/statuses/<sha>` (`daemon.mjs:63`). This design
gives them a second home — ours — and puts them on screen.

## The thing worth noticing first

**None of this needs the repo to move off GitHub.** The CI daemon is our
process, the webhook already fires, and the statuses are already computed. It
can POST them to our backend *as well as* to GitHub, starting today, while
`<owner>/infinite-agents` stays exactly where it is.

That ordering matters: the display gets built and proven against real builds
first, and the git migration (which needs a PR webhook and a CI token — see
[the gaps](#relationship-to-the-git-migration)) becomes a separate, smaller
decision. If the migration never happens, this feature still stands alone.

## Data model

One document per `(repo, sha, context)`. Latest wins — a re-run replaces rather
than appends, because no screen has ever wanted a status's history, only its
current answer.

```ts
export interface GitCommitStatusDocument {
  id: string;
  userId: string;
  repoId: string;
  sha: string;                 // 40 hex
  context: string;             // 'ci/checks', 'deploy/prod', 'deploy/site', …
  state: 'pending' | 'success' | 'failure' | 'error' | 'skipped';
  description: string;         // ≤140 chars — the daemon already caps at this
  startedAt: string;
  completedAt?: string;
  /** Tail of the job log, uploaded on completion. Capped; see "Logs". */
  logTail?: string;
  logBytes?: number;
}
```

Keyed on the **sha, not the proposal**. Pushes to `main` produce four statuses
and no PR at all, so a PR-keyed store would drop most of CI on the floor. The
proposal view looks its checks up by `headSha`, which it already pins
(`git-pr.ts` — "pinned at creation and re-verified at merge").

Storage follows the repo convention: `SqliteGitCommitStatusStorage` +
`InMemoryGitCommitStatusStorage`, as every other storage interface ships both.

### `skipped` is a new state, and it is the point

Three jobs `exit 0` when their path filter decides there is nothing to do —
`deploy-prod` (`run-job.sh:52`), `machine-image` (`:129`), `self-update`
(`:216`). The daemon sees exit 0 and posts **`success`**.

So a commit that deployed nothing currently reports `deploy/prod ✓ Passed in
0.1m`. On GitHub that was harmless because nobody read it. On a screen whose
whole job is answering *"is production running this commit?"*, it is a lie —
and the most expensive kind, because it is a green one.

Fix at the source: skipping jobs `exit 78` (the conventional "neutral" code),
`daemon.mjs` maps 78 → `skipped`, and the Mini App renders it grey with
"nothing to deploy" rather than a tick. Cheap, and it makes the existing
GitHub statuses honest too.

## Ingest

```
POST /api/internal/git/statuses
x-ci-status-secret: <shared secret>

{"owner":"<userId>","repo":"infinite-agents","sha":"…","context":"ci/checks",
 "state":"pending","description":"Running on ia-ci-runner → …log"}
```

- **A shared secret, not a user token.** The CI runner is our infrastructure,
  in the same trust tier as the git host — not a user's agent. Reusing the
  agent-token path would mean a build box holding a credential with write
  access to a user's entire namespace. `/internal/*` is already IP-restricted
  at Caddy for the git host; same vhost rule, same reasoning.
- **Its own secret** (`CI_STATUS_SECRET` in `/etc/ia-ci/env`), not
  `WEBHOOK_SECRET` — the webhook secret is a *verification* key the git host
  also holds; this is a *writing* key. Separate blast radius, one extra line
  of config.
- **Repo identity comes from the delivery, not from `REPO`.** The daemon's
  `REPO` env var is a GitHub slug (`daemon.mjs:29`). Every webhook payload
  already carries `repository.owner` and `repository.name`, and our
  `post-receive` sends the same shape. Taking identity from the payload is
  what lets one daemon serve more than one repo, and removes the constant that
  would otherwise have to be rewritten on migration day.

Unknown repos are accepted and dropped silently, matching `/git/pushed`: a
status that cannot be filed must never fail a build.

## Where it shows up

Five surfaces, in descending order of value. All of them read ONE worst-state
rule (`worstCheckState`, in `types/git-commit-status.ts`) — a card calling a sha
green while the row beside it calls the same sha red would be worse than either
being wrong alone.

### 0. The proposal card, in the chat (added 2026-08-17)

Appended to the diffstat line: `3 files, +53 −15 · ✅ checks passed`. This is
earlier than every surface below it — the card is the notification that pulls
the user back to their phone, so it is where "the tests failed" costs them the
least to learn.

A SNAPSHOT, taken when the card is written, and it says so by being brief: the
row in the workspace holds the live pip and updates on its own. `⏳ checks still
running` is worth printing rather than hiding, because the agent instructions
say to wait for checks BEFORE proposing — a card that admits it did not is
itself the finding. A repo with no CI shows nothing at all, exactly as before.

### 1. The proposal row, on the home queue

A single check pip, left of the diffstat: amber and pulsing while running,
green passed, red failed. This is the highest-value pixel in the feature — the
user's entire decision is *approve or not*, and "the tests failed" should reach
them **before** they tap into anything.

### 2. The proposal screen — a Checks card above `prDecide`

One row per context: state glyph, context name, description, elapsed. Tapping
a row opens its log.

**It informs the button; it does not disable it.** The gate exists for the
human, and nothing in this design gets a vote — a failed check re-labels the
action *"Approve anyway"* and tints it, the way a stale head sha already makes
the merge refuse. Surfacing and deciding stay separate, which is the same rule
the rest of the proposal flow follows.

One repo-scoped exception, added 2026-08-12 (docs/agent-git-project-repos.md):
a repo that opted in with `agentbuilt repo protect <name> --require-checks`
gave CI its vote **by the owner's own hand**, and there an approval is
honoured only when every check on the pinned sha is success or skipped — none
at all blocks too, because the unjudged sha is the one the flag exists to
hold. The button says "Checks must pass first" and the decision path enforces
the same rule server-side. The opt-in is one-way, like protection itself.

### 3. Commit history, on the repo screen

Each commit row in `repoHistory` gets its pip. `/api/repos/:name/commits`
already returns the list; decorating each entry with the statuses filed under
its sha is a join, not a new screen.

This is where main-branch work becomes visible at all — `deploy/prod`,
`deploy/site` and `deploy/machine-image` never have a proposal to hang from.

### 3b. A Checks list on the repository screen (added 2026-08-14)

Between Proposals and Files at the repository's root: the last 20 runs the
daemon filed on this repo, newest first, whatever commit each ran against
(`GET /api/repos/:name/checks`, backed by `listRecentByRepo`). Five rows, then
"Show all N runs"; a row with a log tail opens it on tap — closed by default,
unlike the proposal card, because a list of history is not one failure the
reader came for. This is the glanceable answer to "what has CI been doing
here lately" that the per-commit pips (3) make you hunt for.

### 4. "What is live", on the repo row

The last `success` on `deploy/prod` for the default branch, as a line on the
repository row: *"prod: deployed 2h ago"* — or, when the tip has moved past it,
*"prod: 3 commits behind"*.

That second string is the fact that exists nowhere today, in any tool we own,
and it is the one people actually ask for.

## Polling

`load()` already re-runs every 5s, but only while an agent is mid-setup
(the page of the time; now `WorkspaceProvider` in `backend/workspace-ui/`). Extend the condition: **keep polling while any
status on screen is `pending`.** One clause, and a running build becomes live
instead of something you refresh at.

## Logs

The daemon writes `/home/runner/ci-logs/*.log` and puts the filename in the
status description — useful only to someone with SSH.

On completion it uploads the **tail** (cap 64 KB) with the terminal status.
Not a proxy to the CI box: an upload survives that box being down, needs no
inbound path to it, and rides the compression the Mini App router already
applies to text (`compressResponses()`). A failing job's last 64 KB is
essentially always the part you need; a passing job's log nobody opens.

Live tailing during a run (a PATCH every ~10s) is deliberately deferred — it is
a different mechanism for the last 10% of the value.

## Relationship to the git migration

Phase 1 above works on the GitHub-hosted repo. Moving the repo to our own host
additionally needs, from the earlier gap analysis:

- **a `pull_request` delivery** — `post-receive` only ever emits `push`, and
  proposals are created through the backend API, which notifies nothing. So
  `daemon.mjs:214`'s whole PR branch never fires.
- **a CI identity** — `/git/verify` (`agent-cli.ts:610`) accepts agent tokens
  only: no deploy keys, no read-only scope, no per-repo scope.
- **~55 MB of demo `.mp4` blobs out of history** — the repo is 111 MB against a
  300 MB cap, and half the weight is video the quota message explicitly says
  the platform does not store.

Push webhooks, merge, compare and raw-sha fetch are already covered — the
`post-receive` hook was built GitHub-shaped on purpose ("so a repo can move
here without a flag day"), and `daemon.mjs:247,274` already accepts both header
families.

## Testing

Following the repo's conventions:

- **Unit**: status upsert semantics (same `(repo, sha, context)` replaces),
  secret mismatch → 401, unknown repo → accepted-and-dropped, exit-78 →
  `skipped`, and the "N commits behind" arithmetic at its boundaries
  (equal, ahead, unrelated history).
- **Both storage implementations**, per convention.
- **Mini App page test**: a proposal carrying a failed check renders "Approve
  anyway" and not "Approve" — the one rendering rule with a real consequence.
