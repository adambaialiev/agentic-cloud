# Internal git host (`ia-media`)

Bare repos served over git's smart HTTP, on the box that already holds media
and voice files. Design: [`docs/agent-git-phase1.md`](../../docs/agent-git-phase1.md).

```
agent machine                    ia-media                      ia-backend
  git push  ──────────────▶  git-host.mjs :3002  ──verify──▶  /api/agent-cli/git/verify
                              │                                (identity + quota)
                              └─▶ git http-backend
                                    └─▶ /var/lib/agentgit/repos/<userId>/<name>.git
```

The service holds no user list, no database and no copy of the quota rules —
one `/git/verify` call answers identity, namespace and quota together. The
backend owns every authorization decision; this process owns bytes on disk.

## Files

| | |
|---|---|
| `git-host.mjs` | the service: control API + the three git endpoints. Zero dependencies |
| `hooks/pre-receive` | copied into every repo at creation: protected branches, tag permanence, quotas |
| `agentgit.service` | systemd unit (`ReadWritePaths=/var/lib/agentgit` — it cannot touch MinIO's data) |
| `backup-repos.sh` | the off-box backup: one git bundle per repo |
| `agentgit-backup.{service,timer}` | the nightly full run, 03:30 UTC, jittered |
| `agentgit-backup-hot.{service,timer}` | three intra-day runs of the same script, quiet unless they fail |
| `maintain-repos.sh` | weekly `git gc` per repo — merges bypass auto-gc, this is the backstop |
| `agentgit-maintenance.{service,timer}` | runs it Sunday 04:30 UTC, jittered |
| `provision.sh` | idempotent installer, run as root on the box |

## Install

```sh
rsync -az infra/git-host/ root@<git-host>:/root/git-host/
ssh root@<git-host> \
  'GIT_HOST_SECRET=<secret> BACKEND_URL=https://<backend-origin> \
   GIT_VHOST=git.agentbuilt.app bash /root/git-host/provision.sh'
```

Then on the backend host, in `/etc/infinite-agents/backend.env`:

```sh
GIT_HOST_BASE_URL=https://git.agentbuilt.app
GIT_HOST_CONTROL_URL=https://git.agentbuilt.app
GIT_HOST_SECRET=<the same secret>
```

and restart it. Until all three are set the backend's repo routes answer 503,
which is deliberate: better a plain "not available" than clone URLs that 404.

## Updating

**Merge to `main` and it deploys itself.** The `deploy-git-host` job
(`infra/ci-runner/run-job.sh`) runs on every main push, skips when the commit
touched nothing under `infra/git-host/`, and otherwise: validates the server and
both hooks, ships `git-host.mjs` **plus `hooks/` and the unit file**, sets
`agentgit:agentgit` / `0755`, restarts, and waits for the host to actually serve
before reporting success — rolling the previous copy back in if it does not.

Before that job existed this was a hand-copied file, and on 2026-08-11 it cost a
~30-second outage: `scp` landed `git-host.mjs` root-owned `0600`, and the service
(which runs as `agentgit`) crash-looped on `EACCES` reading its own entrypoint.
If you ever do deploy by hand, the two traps are:

1. **Ownership and mode.** Finish with `chown agentgit:agentgit` and
   `chmod 755` **before** `systemctl restart agentgit`.
2. **`node --check` needs a `.mjs` name.** Staging as `git-host.mjs.new` fails
   with `ERR_UNKNOWN_FILE_EXTENSION` — a syntax check that never ran.

And check `systemctl is-active` is not enough on its own: the crash-loop reports
`activating` while serving nothing. `curl -s -o /dev/null -w '%{http_code}'
http://127.0.0.1:3002/` must answer `404`.

### The hostname

Production serves **`git.agentbuilt.app`** — an A record in the `agentbuilt.app`
Cloudflare zone pointing straight at ia-media (<git-host>), deliberately
**DNS-only, not proxied**: the orange cloud caps request bodies well below the
512 MB this vhost allows, which would sever a large push.

The Caddy vhost answers to the old `git.<ip>.sslip.io` name as well, so clones
made before the rename keep fetching and pushing. `provision.sh` still derives
the sslip name when `GIT_VHOST` is unset, which is what makes a fresh box work
with no DNS at all — pass `GIT_VHOST` for anything user-facing.

Clone URLs are derived from `GIT_HOST_BASE_URL` on every read, never stored per
repo, and the CLI registers its credential helper against whatever origin the
backend hands back — so moving the hostname needs no migration and no code
change. (Agents keep a helper entry for the old origin too; harmless.)

## Protection

`agentgit.protectedBranch` in the repo's own config — **multi-valued**, one
entry per protected branch, and the FIRST is the default branch a clone lands
on. `repo create` protects `main`; more branches join later with

```sh
agentbuilt repo protect <name> dev release   # → POST /internal/repos/protect
```

Add-only, mirroring the approval gate's shape: nothing an agent can call ever
unprotects anything, and a repo created `--unprotected` stays that way
permanently (the route answers 409 with those words).

A protected repo's **tags are append-only**: creating one is an ordinary
push, but moving or deleting an existing tag is refused by the same
pre-receive rule — a tag another machine resolved yesterday must resolve to
the same commit tomorrow. There is no config for this; having any protected
branch is the switch. Hooks are re-checked on every push, so it covers
protected repos that predate the rule.

### The history guard (note #936)

A repository may name the only root commits its history may have, in
`.agentbuilt/allowed-roots` on its default branch: one 40-hex sha per line,
`#` for comments. When that file is there, `hooks/pre-receive` refuses any
push, to any branch or tag, that brings in a commit whose history starts at
another root. That includes a branch merged with one. The list is read from
the default branch as it stands, never from the push, so only an approved
change widens it. With no file, nothing changes.

It exists for `agentic-cloud`, the platform's public repository, cut on
2026-11-01 as a fresh start from the private `infinite-agents`. A branch
that grew from the private repository reaches its root, so pushing one would
publish the whole private history. Carry such work over as a patch instead.

## Moving a repo between namespaces

A namespace is a ROOM (note #88), so moving a repository between rooms is a
move between these directories:

```sh
# → POST /internal/repos/move  {"userId":"<from>","name":"<repo>","toUserId":"<to>"}
```

The fourth member of the rename family, and the same shape as the other three:
one `rename(2)` inside `REPOS_ROOT`, so the repo is only ever at one end or the
other. Protection, CI config and hooks ride along inside the directory. What
does NOT ride along is the clone URL — it carries the namespace — so every
clone anybody already holds points at the old path until it is re-pointed.
The route refuses a name the destination already uses, and validates
`toUserId` as a path segment: unchecked it is a traversal out of the root.

## Operating it

```sh
systemctl status agentgit
journalctl -u agentgit -f
curl -s localhost:3002/health        # {"ok":true,"diskUsedPercent":6}
du -sh /var/lib/agentgit/repos/*     # per-user usage
```

**Watch the disk.** The box has ~34 GB free and shares it with MinIO. New repos
are refused above `DISK_MAX_USED_PERCENT` (default 80) so the failure mode is
"no new repos" rather than a full disk taking the media store down too. When
that starts biting, attach a Hetzner Volume and move `/var/lib/agentgit/repos`
onto it — nothing in the design assumes the root filesystem.

## Backups

Every repo is bundled nightly and shipped **off this box**:

```
/var/lib/agentgit/repos/<userId>/<name>.git
    -> <target>/git/<userId>/<name>/<YYYY-MM-DD>.bundle
```

`git bundle` rather than a tar of the `.git` directory, because a bundle is a
single file git can verify and clone from — a restore is `git clone
<file>`, and so is a *test* of a restore. Each bundle is verified before it is
uploaded, uploaded under a `.part` name and renamed into place, and deleted
locally the moment it lands: this disk is the constraint the whole host is
designed around, so a run never holds more than one bundle at a time.

Repos whose refs have not moved since the last successful upload are skipped,
which on a normal night is most of them.

The nightly run is the contract; `agentgit-backup-hot.timer` runs the same
script three more times a day (09:30/15:30/21:30 UTC, jittered), so a busy
repo's exposure is hours rather than a day. Same script, same target, same
skip-unchanged fingerprint — an intra-day run on an idle fleet is a handful
of state-file reads. Hot runs succeed **silently** (`BACKUP_QUIET_OK=1`):
the operator's green line stays one per day, from the nightly, while a
failure notifies in full from whichever run hits it. Same-day re-runs
replace that day's bundle atomically, so retention still sees one file per
day and the newest state wins.

## Maintenance

Pushes meet `git gc --auto` inside receive-pack — but approved merges are
built with `merge-tree`/`commit-tree` (no receive-pack anywhere), so the
service runs the same `gc --auto` itself after every real merge, detached,
where it can never delay the merge answer. `maintain-repos.sh` is the weekly
backstop: a full `git gc` per repo, Sunday 04:30 UTC, niced because MinIO
shares the cores. It collects what the threshold check declines — stale
reflogs, old packs, repos that sat just under the auto limit every time.

The same job empties the trash. A deleted repo is not removed: the control API
moves it to `<repos>/../trash/<userId>/<name>.<stamp>.git`, and this run purges
what has been there longer than `TRASH_KEEP_DAYS` (14). Age comes from the
directory's mtime, which `git-host.mjs` stamps as it moves the repo in —
`rename(2)` leaves mtime at the repo's last write, so an idle repo would
otherwise arrive already past the window. Nothing else purges,
so that variable IS the product's "restorable for 14 days" promise
(docs/agent-git-project-repos.md slice 5). A purge that fails is a warning and
some disk, never a reason to skip the gc pass.

A healthy week is a journal line; failures notify with repo names, and the
`OnFailure=` handler covers a run that died without reporting. A timer that
silently stops firing shows up in `/health`'s `diskUsedPercent` long before
it hurts — that number is already the one to watch on this box.

```sh
systemctl start agentgit-maintenance   # run one now
journalctl -u agentgit-maintenance -n 30
```

### Where it goes today

A [Hetzner Storage Box](https://www.hetzner.com/storage/storage-box/) — BX11,
1 TB, €4.00/mo — **in `hel1` (Helsinki)**, because every server we run is in
`fsn1`. A backup in the same datacentre as the thing it is backing up is not
off-box in the sense that matters.

```
box       ia-git-backups (id 631366)
target    <storage-box-user>@<storage-box-host>:git-backups   (sftp, port 23)
auth      /etc/agentgit/backup_key — key only, no password anywhere
snapshots daily 05:00 UTC, 10 kept
```

Snapshots are the part that survives a **compromise** rather than an accident:
the CI runner holds root on ia-media (that is how `deploy-git-host` works), so
anything ia-media's key can delete is inside a compromised runner's blast
radius. Snapshots are not.

A restricted **sub-account** would be the obvious extra layer and does not
work: the API accepts an `ssh_keys` field when you create one and then does not
store it — Storage Box sub-accounts authenticate by password only. Key auth
with the main account beats a password on disk plus an `sshpass` dependency on
a box whose whole design is zero dependencies, so that is what runs.

### Pointing it somewhere else

`provision.sh` installs the job **inactive** and generates a key for it. Until
`BACKUP_SSH_TARGET` is set the run exits 0 having done nothing, so shipping
this before a target exists costs nothing.

1. Create the target, in a location the git host is not in.
2. Give it the public half of the key: `cat /etc/agentgit/backup_key.pub`
3. Set `BACKUP_SSH_TARGET` in `/etc/agentgit/backup.env` (port 23 on a Storage
   Box, 22 on an ordinary host).
4. `systemctl start agentgit-backup` and read `journalctl -u agentgit-backup`.

Changing the target re-uploads everything on the next run rather than reporting
"unchanged" against a destination that has never seen the data — the state key
includes the target for exactly this reason.

**A fresh Storage Box takes a few minutes before its hostname resolves.** Until
it does, the job fails with `Could not resolve hostname`, which looks exactly
like a typo in the target. Wait and re-run before debugging anything else.

### Retention

14 daily bundles, then one per ISO week for 8 weeks — and, whatever those say,
**never a repo's newest bundle**. That last rule is what makes skipping
unchanged repos safe: without it, an idle repo's last copy would age out and
leave it with no backup at all.

Pruning failures are logged and never fail the run. An upload failure does fail
it, because a nightly job that cannot report a problem is not a backup.

### Notifications

Every run reports to an operational Telegram bot — one message per run, not per
repo:

```
✅ git backups OK — ia-media
11 repos · 3 uploaded (1.2 MB) · 8 unchanged
target: <storage-box-host>:git-backups
```

A nightly "all fine" is the point rather than noise. The failure this job
guards against is **silence**, and an operator who sees a green line every
morning notices the morning it stops. Failures name the repos:

```
🔴 git backups FAILED — ia-media
11 repos · 0 uploaded (0 B) · 9 unchanged

2 failed:
user/repo — upload failed
user/other — bundle failed verification
```

`notify.sh` talks to Telegram **directly**, not through the platform backend.
This is the channel that has to be able to say "the backend is down", and one
that routes through the backend cannot. It never fails or blocks its caller:
Telegram being unreachable must not turn a backup that landed into a red unit.

`agentgit-backup-failed@.service` covers what the job cannot report itself —
killed by its own timeout, or exited before reaching its summary. It stays
quiet when the job did manage to send one, so a normal failure is one message
rather than two.

**The token is read out of `/etc/agentgit/ops-notify.env` as data, never
sourced and never loaded into the unit's environment.** It sits in the URL
`curl` fetches, which is why curl's stderr is discarded: a connection error
prints the URL it was fetching, and a token in the journal is a token written
down.

Setting it up:

1. `@BotFather` → `/newbot` → token.
2. Message the bot once, then read the chat id:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9-]*'`
3. Put both in `/etc/agentgit/ops-notify.env` and `systemctl start agentgit-backup`.

Unset means silent, so this ships before the bot exists without failing.

### Restoring

```sh
git clone <target>/git/<userId>/<name>/<date>.bundle <name>
```

That is the whole procedure — the clone comes out checked out on the branch
HEAD pointed at. To put it back on the host, push it into a fresh repo made
with `agentbuilt repo create`.

**Do this before you need it.** A backup nobody has restored is a hypothesis,
and its failure mode is silent for months.

Last drilled **2026-08-12**: fetched a live repo's newest bundle from the
Storage Box, `git bundle verify` said complete, and the clone's HEAD matched
the live repo's tip exactly. Two things the drill taught: run the sftp **as
`agentgit`** (the Storage Box dropped the same command run as root), and
`git bundle verify` needs to run inside any repo — `git init` a scratch one
first, or just clone, which needs nothing.

## Security shape

- Repos live under one unprivileged `agentgit` user; the service never runs as root.
- Exactly three git routes are served. Anything else is a 404, so a repo path
  can never become a file listing.
- `/internal/*` needs the shared secret **and** comes from the backend's IP
  (Caddy drops the rest).
- A token may only touch its own user's namespace — one equality check, tested
  directly (`backend/src/test/unit/git-host.test.ts`).
- Verification failures are never cached and an unreachable backend fails
  **closed**: no pushes rather than unauthenticated ones.

## Telling CI about a push

A repo can notify a CI daemon when refs move, which is how a push here drives
builds the way a GitHub webhook does. It is off unless configured, so ordinary
agent repos pay one `git config` read per push and send nothing.

**Normally you do not do this by hand.** The host holds the one dispatcher
address in its own env (`CI_WEBHOOK_URL` / `CI_WEBHOOK_SECRET`, written by
`provision.sh`), and a repo is switched on through the API:

```sh
agentbuilt repo ci enable <name>      # from any of the user's agents
```

which reaches `POST /internal/repos/ci` with `{"enabled":true}` and nothing
else. **The caller never sends a URL, and that is the point**: this daemon
sits inside the private network, so honouring a caller-supplied webhook
address would make it an SSRF proxy. A boolean cannot express a destination.

The manual form still works, for a host with no dispatcher env or a repo that
must point somewhere unusual:

```sh
repo=/var/lib/agentgit/repos/<userId>/<name>.git
git --git-dir "$repo" config agentgit.webhookUrl    http://<ci-host>:8787/webhook
git --git-dir "$repo" config agentgit.webhookSecret "$(openssl rand -hex 32)"   # = the daemon's WEBHOOK_SECRET
```

The `post-receive` hook then POSTs one signed delivery per updated ref:

```
x-agentgit-event: push
x-agentgit-signature-256: sha256=<HMAC-SHA256 of the body, keyed with the secret>

{"ref":"refs/heads/main","before":"…","after":"…","deleted":false,
 "repository":{"name":"…","owner":"…","full_name":"…/…"},
 "head_commit":{"id":"…","message":"…"}}
```

`infra/ci-runner/daemon.mjs` accepts these headers alongside GitHub's
`x-hub-signature-256` / `x-github-event`, with the same secret and algorithm —
so a repo can move here without a flag day.

**The URL is set with a shell, never through the control API.** This service
sits inside the private network, so a user-supplied webhook URL would make it
an SSRF proxy: it would cheerfully POST wherever it was pointed. Same reasoning
as `agentgit.protectedBranch` living in the repo's config rather than in a
request.

A delivery is best-effort by design: the hook waits 5 seconds, never retries,
and cannot fail a push that has already landed. A CI daemon that is down costs
a missed build, never a broken `git push`.

Hooks are re-checked on every push, so editing `hooks/*` here and redeploying
updates repos that already exist — they used to be copied only at creation,
which meant a fix reached new repos alone.

## Tests

Run from the backend package; they spawn this service and a stub backend as
real processes and drive them with the real `git` binary:

```sh
npm --prefix backend test -- src/test/unit/git-host.test.ts
```
