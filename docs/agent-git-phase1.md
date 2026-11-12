# Agent git hosting — Phase 1 design

Decided with Owner 2026-08-06. Repositories live on the **existing Hetzner
media/voice server** (the MinIO host behind `MEDIA_S3_*`); agents reach them
through the `agentbuilt` CLI they already carry.

## The product

An agent needs somewhere to put code that (a) outlives its own machine and
(b) another agent can read. Today it has neither:

- One agent = one Fly machine + one volume. The recycler destroys that volume
  after `FLY_RECYCLE_IDLE_DAYS` (3) idle days, and everything on it goes.
- Two agents share nothing but chat. The prompt already tells them to use git
  worktrees for parallel work — but only *within* one machine's checkout.

So the only durable home for agent work is the user's own GitHub, which costs
them a credential handover. That handover is not theoretical: on 2026-08-06 a
device-flow login was silently revoked three times in one session before the
user cut a PAT by hand. Phase 1 removes that from the critical path.

After phase 1:

```sh
agentbuilt repo create api          # → https://git.agentbuilt.app/<user>/api.git
git remote add origin "$(agentbuilt repo url api)"
git push -u origin main             # no credential setup, ever
```

GitHub stays fully supported — it just stops being the *only* way for work to
survive the night.

## Where it lives — and what is deliberately NOT in MinIO

Same physical box as media and voice files, as decided. But repositories go on
that machine's **filesystem**, at `/var/lib/agentgit/repos/<userId>/<name>.git`,
*next to* MinIO's data rather than inside it.

Object storage is the wrong shape for git. A push is a negotiation — the server
reads refs, computes what the client lacks, and writes a pack — and MinIO
exposes none of that. Git-on-S3 degrades to the dumb HTTP protocol: every loose
object fetched individually, no delta negotiation, no server-side packing, and
no atomic ref update (so two agents pushing at once can lose a branch). Bare
repos on ext4 are a solved problem; git-on-object-storage is a science project.

Backups were originally planned for a `git-backups` bucket in the MinIO on this
same box. **That was wrong and is not what shipped.** A bucket beside the repos
covers a fat-fingered force-push and nothing else: it dies with the disk it is
on, and it spends the one resource — 38 GB, watermarked at 80% — that every
other decision here is built around. Worse, ia-media already held the only copy
of the SQLite backups too, so one box loss took the database and the repos
together.

What shipped instead is `infra/git-host/backup-repos.sh`: a nightly bundle per
repo, pushed over sftp to a target on a **different machine** (a Hetzner
Storage Box). Bundles, not tarballs of `.git` — a bundle is verifiable and
clone-able on its own. See the README for the setup and the retention rules.

## Names, ownership, and the registry

> Today: a repository belongs to the whole WORKPLACE (note #566), and rooms
> were removed on 30–31 Oct 2026 (note #843). `agentbuilt repo list` shows
> every repository of the workplace, and every agent in it may clone and push
> any of them with no share step; the protected branch and the owner's
> approval are what guard them. The room grants described below are history.

- A repository has one physical **home namespace**: the address its bytes
  were created at — a room's namespace while rooms existed, the workplace's
  own namespace, or a legacy personal namespace. That namespace remains in
  `/<namespaceId>/<name>.git`; it owns the disk path and clone URL, and it is
  only an address: it says nothing about who may use the repository.
- `name` is validated with the deployment-name regex
  (`/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/`). It must not collide anywhere in
  the workplace, so `agentbuilt repo list` stays unambiguous.
- Until note #566, every agent in the home room had full read/write, a
  workplace admin could grant the same access to additional rooms from the
  Workspace, and agents outside those rooms could not list, clone, push, or
  propose against the repository. Removing a repository from one of those
  additional rooms removed only that room's access grant, and a room could
  not be deleted until every live repository had been unlinked, moved or
  deleted (note #498).
- Sharing never copied or moved code and never changed the clone URL.
  `GitPullRequestDocument.roomNamespaceId` recorded the proposing room
  separately from `userId`, which continues to name the repository's
  physical home.

New record, following the deployment-storage pattern (`SqliteGitRepoStorage` +
`InMemoryGitRepoStorage` — both implementations, per the repo convention):

```
{
  id, userId, name,
  sharedWithNamespaceIds, // additional room namespaces (history); userId is always home
  createdByAgentId,
  defaultBranch,        // recorded from the first push, not assumed
  sizeBytes,            // refreshed by the post-receive hook
  createdAt, lastPushAt
}
```

This additive room model shipped for note #108. It deliberately separated
where bytes live from who may use them: a repository shared with three rooms was
still one bare repository, one proposal sequence, and one branch history — the
same separation that let note #566 hand every repository to the whole
workplace without moving a byte.

The registry is the backend's, not the git host's: the git host owns bytes on
disk, the backend owns *who may touch them*, and the CLI only ever talks to the
backend. Keeping those separate is what makes the auth model below one sentence
long.

## The box, as it actually is

Surveyed 2026-08-06 over SSH (`ia-media`, `<git-host>`, Hetzner cx23):

| | |
|---|---|
| Disk | 38 GB total, **34 GB free** — MinIO's `/srv/minio/data` is well under 1 GB today |
| Guest | 2 vCPU, 4 GB RAM |
| Already running | `minio` (127.0.0.1:9000), `caddy`, sshd |
| TLS | Caddy already terminates for `2-28-19-14.sslip.io` → MinIO, auto-certs |
| Firewall | ufw: 22, 80, 443 open |
| `git` | 2.43.0 installed, **`/usr/lib/git-core/git-http-backend` present** |
| `node` | **not installed** |

Two consequences for this design. First, the git service must be a **single
dependency-free file**, like the `agentbuilt` CLI — Node gets installed on this
box for it, and adding an npm dependency tree to a machine whose whole job is
storage is not worth it. Second, the disk is a real constraint to plan around,
not a formality: see Quotas.

## The service on the box (`infra/git-host/`)

- An unprivileged `git` user owns every repo; the service never runs as root.
- A small Node service on `127.0.0.1:3002` that shells out to
  `git http-backend` (CGI) — the same binary GitHub-alikes use, so protocol
  correctness is git's problem, not ours.
- Exactly three routes: `GET /<user>/<repo>.git/info/refs?service=…`,
  `POST …/git-upload-pack`, `POST …/git-receive-pack`. **No dumb HTTP, no file
  listing, no web UI** — anything not on that list is a 404, so a repo path can
  never become a file server.
- `systemd` unit + `provision.sh`, mirroring `infra/backend-host/` conventions
  so the box stays operable the same way.
- Public at **`https://git.agentbuilt.app`** — a second Caddy vhost beside the
  MinIO one. It launched on `git.2-28-19-14.sslip.io`, because sslip.io
  resolves any `<label>.<ip>.sslip.io` and so needed **no DNS change at all**
  to ship. The rename to the branded name landed 2026-08-07 and cost exactly
  what this section predicted: one A record (DNS-only — the Cloudflare proxy
  caps request bodies below what a large push needs) and one Caddyfile line.
  The CLI never hardcodes the host (it comes from the backend in
  `~/.agentbuilt/config.json`), and clone URLs are derived from
  `GIT_HOST_BASE_URL` rather than stored, so nothing but DNS had to change. The
  vhost still answers to the sslip name, so clones predating the rename work.
- Separate vhost rather than a `/git/*` path on the MinIO host, so a routing
  mistake can never expose one service through the other's URL space.

## Authentication — the token every agent already has

HTTP Basic, username ignored, password = the machine's existing `agb1.…`
agentbuilt token. Nothing new is minted, distributed, or rotated.

Only the backend can verify that token (only it holds the SHA-256 on the agent
record), so the git host asks:

```
POST /api/agent-cli/git/verify   { token, repo }   → 200 { userId, agentId, scope? } | 401/403
```

authenticated by a shared secret between the two boxes, not by an agent token.
Positive results cache for 60 seconds; failures are never cached.

The authorization rule is simple: an agent's token opens every namespace of
its OWN workplace (note #566) — the clone URL's namespace is an address, not a
wall — and membership and org pinning are the outer boundary, so no token
crosses a workplace. (Before note #566 the namespace had to equal the agent's
room namespace, and a repository shared from another room was verified grant
by grant, with `scope: { repo }` so that sharing `api` could never open its
neighbor `payroll`.) A scoped answer still opens one repository only, so the
repository name is part of the positive-auth cache key. Path traversal is rejected before authorization by validating both
segments against the name regex.

Verification is a live call rather than an offline-verifiable signed token on
purpose. Agent tokens rotate on every identity rewrite, and a revoked token has
to stop working *now* — an offline JWT would keep opening the door until it
expired. The cost is one ~1 ms box-to-box request per git operation, and a hard
dependency: **backend down → pushes fail with 503.** That is the same failure
domain the agent is already in (it cannot get a turn at all without the
backend), so it adds no new way for the product to be broken.

## The CLI — `agentbuilt repo …`

Extending the existing CLI rather than shipping a second one: `agentbuilt` is
already on every machine, already authenticated, already reinstalled by the
`~/.boot.d` hook after an image roll. A new binary would need all three
mechanisms rebuilt for no user-visible gain.

```
agentbuilt repo create <name>     create and print the clone URL
agentbuilt repo list              this user's repos, size, last push
agentbuilt repo url <name>        the clone URL, for `git remote add`
agentbuilt repo clone <name> [dir]
```

No delete verb in phase 1 — consistent with hosting, where destruction is never
a thing an agent can do on its own.

The piece that makes it feel like nothing: **`agentbuilt git-credential`**, a
git credential helper registered once in `~/.gitconfig` for the git host by
`repo create` / `repo clone`. Git calls it, it prints the token from
`~/.agentbuilt/config.json`. So ordinary `git push` works forever, token
rotation is picked up automatically on the next call, and the token is **never
written into `.git/config` or `~/.git-credentials`** — where it would survive
a `git remote -v` screenshot or an agent's own file read.

Backend routes ride the existing per-agent auth on `/api/agent-cli`:
`POST /repos`, `GET /repos`, plus the host-to-host `POST /git/verify`.

### How an agent finds out it has this

A capability an agent is not told about does not exist. Agents do not read
`agentbuilt --help` unprompted — they answer the message in front of them — so
the CLI's own help text is where a capability is *confirmed*, never where it is
discovered. Two places do the telling, and both are pinned by tests:

- `infra/fly-machine-image/skel/CLAUDE.md` (and its `AGENTS.md` twin) — seeded
  from the machine image on FIRST BOOT ONLY and never rewritten.
- The identity block in `AgentService`, gated on hosting being
  configured — rewritten on the next turn of every machine whenever
  `TELEGRAM_AGENT_IDENTITY_VERSION` moves.

**Which one a change belongs in follows from that asymmetry, and getting it
wrong is how these drift.** Everything the platform maintains lives in the
block, because it is the only surface that reaches a machine which already
exists. The skel is a stub: the machine-facts placeholder, a note that the file
belongs to the platform (`~/SCRATCHPAD.md` is the agent's), and four essentials that
keep a machine safe to work on before its block lands (only `/home/agent` is
durable, 8080 is the public port, ordinary backgrounding dies with the turn,
tmux is only a turn-lifetime fallback, restartable work uses `~/.boot.d`, and
Docker works but stops on sleep — until note #1167 this said it did not run). It names no CLI command and no policy. `machine-skel-docs.test.ts`
fails if maintained text reappears there. Since #995 there is no frozen half to
repair: the identity pass replaces everything below the machine-facts block, and
creates the file itself if the machine somehow has none.

The prize is the ratio. Before this, ~10.5k of a new machine's ~16k of
instructions was frozen at first boot and unreachable forever; now ~11.4k of
~13.4k is rewritten on every version bump. Docs the platform cannot correct are
the expensive kind, and there is almost nothing left of them.

The framing that matters is **why**, not what. An agent that is told the
commands still leaves work on the machine; one that is told the volume is
destroyed after three idle days pushes it. So the docs lead with the recycler
and treat the commands as the remedy — and the same edit corrected the machine
doc, which called `/home/agent` durable without ever mentioning that an idle
free-tier machine is destroyed volume and all.

## Quotas

Enforced at push time by a `pre-receive` hook, because that is the only moment
the platform can still say no:

- per repo: **300 MB**
- per user: **1 GB**
- global watermark: **refuse new repos at 80% disk**, alert the operator at 70%
- no LFS

The 34 GB of free space is the budget those numbers spend. At 1 GB per user it
covers ~30 users at *full* quota, which real usage will not approach — a source
checkout is tens of megabytes — but the watermark exists so the failure mode is
"no new repos" rather than a full disk taking MinIO and every media upload down
with it. **This is the one number that must be watched as the product grows.**

The growth path, when it is needed: attach a Hetzner Cloud Volume (resizable,
~€4/mo per 100 GB) and move `/var/lib/agentgit/repos` onto it. Nothing above
depends on repos being on the root filesystem, so that is a maintenance window,
not a redesign.

All limits are env vars, not constants. The rejection message tells the agent
what actually happened (`repo would exceed 500 MB — the platform does not store build
artifacts or datasets; add them to .gitignore`), because an agent that gets a
bare `remote rejected` will retry the push three times before giving up.

`post-receive` refreshes `sizeBytes` on the record, so `agentbuilt repo list`
can show it and a future quota warning has something to read.

## What this unlocks, and what is deliberately deferred

Phase 1 is durability plus intra-user collaboration. Everything below is a
later slice, listed so the phase-1 shapes don't quietly foreclose them:

- **Telegram `/repos` view** — repos, recent commits, last push per agent.
- **Auto-snapshot before recycling.** The recycler already warns the owner a day
  ahead; that hook is the natural place to commit and push the working tree, so
  durability *happens* instead of merely being *available*. Deferred because it
  needs a policy for dirty trees and untracked junk, and phase 1 must not block
  on that argument.
- **One-way mirror to a user's GitHub**, for users who want their own remote to
  stay canonical.
- **Cross-user sharing**, which needs a real permission model rather than one
  equality check.
- **Pull requests, issues, a web UI.** That is adopting a forge (Gitea/Forgejo)
  — a product decision with its own operational bill, not a phase of this.

## Testing

Following the repo's existing conventions:

- **Unit** (`backend/src/test/unit/`): token → namespace authorization including
  the mismatch case, name validation, quota arithmetic at the boundary,
  credential-helper output shape, CLI argument parsing. Nearest prior art:
  `agentbuilt-token.test.ts` and `deployments.test.ts`.
- **Integration**: a temporary bare repo and a real `git push` against the
  service in-process — the protocol is the thing most worth testing, and it is
  cheap to test honestly.
- Both storage implementations, per the convention that every storage interface
  ships `Sqlite*` and `InMemory*`.

## Open questions

All three of the original ones were answered by surveying the box (see **The
box, as it actually is**): 34 GB free, Caddy already terminating TLS, and
`git.2-28-19-14.sslip.io` needing no DNS work (since renamed to
`git.agentbuilt.app`). What is left is a judgement call rather than a fact:

1. **Does `ia-media` stay a storage box, or become a services box?** This puts
   a second workload (and a Node runtime) on a machine whose current job is to
   hold bytes. It is small — git is idle between pushes — but it is the first
   step of that drift, and the box has 2 vCPU. The alternative is a dedicated
   `ia-git` server (~€4/mo) with a cleaner blast radius. Recommendation: start
   here as decided; revisit if git ever competes with media serving.

## Contributors

Decided 2026-08-16. Who has written a repository, and how much: the faces on
its row in the Workspace, and a list with commits and line counts on its own
screen.

**Where the numbers come from.** The git host answers
`/internal/repos/contributors` with per-author totals from
`git log --no-merges --numstat` on the default branch. Merges are excluded:
a merge's diff is the work of the branch it merged, already counted on those
commits, and counting it again would credit every landing to the one machine
identity that performs merges here — which would top every list in the
product.

**It is incremental, and that is load-bearing.** A full walk is seven seconds
on a repository of a couple of thousand commits. The caller sends the sha it
last counted to; the host answers with what landed after it and says, in
`from`, whether that base was usable. `from: null` means the history was
rewritten (or never counted) and the totals REPLACE what was stored — getting
that backwards would double every number on the first force-push.
`mergeContributorTotals` and `nextContributors` (`backend/src/types/git-repo.ts`)
are named functions with tests for exactly that reason.

**Stored, not computed on read.** The totals live on the repo record, refreshed
by the push report — the one moment the platform learns anything changed.
Counting on read would put a git walk in front of every load of the workspace
home, five repositories at a time. A repository nobody has pushed to since this
shipped has no totals; opening its screen counts them once and backfills the
record, so its row has faces from then on.

**Three surfaces, deliberately different.**

| | the row on home | the repository's screen | the contributors screen |
|---|---|---|---|
| who | agents only, top 3 | a one-line summary | everyone who committed |
| where | beside the branch and time | the BOTTOM, under the files | its own screen |
| shows | overlapping 16px faces | up to 5 marks, the count, the top names | face or person glyph, **email**, commits, +added, −deleted |

The summary sits at the bottom because it started at the top: seventeen rows
of contributors pushed the proposals, the actions and the files off the
screen, and a repository's screen is about the code. It counts EVERYONE,
including people with no picture, who get a person dot in the stack — a stack
that silently skipped them would say five where the list says nine.

The **email** appears on that last screen and nowhere else. It is what
actually identifies a contributor (two people can share a display name; one
person can change theirs), it is the answer to "who is `owner`", and
neither the row nor the summary has room for it.

Authors are matched to agents by the local part of the commit email — agents
commit as `Ruby <ruby@agentbuilt.app>` — falling back to the display name. The
owner's own commits and any human collaborator resolve to nobody, keep their
name, and get the anonymous person glyph. Authors merge by **email**: one
address is one contributor, whatever name they were committing under that
month. The agent's CURRENT name is shown, so renaming an agent renames it in
every list rather than leaving git's memory on screen.

An empty full recount over a list that already has people in it is **not**
stored. It is genuinely possible (rewrite a history down to merges alone) and
much more likely to be the host having a bad day; a stale list beats watching
your contributors vanish.
