# Database backup (`ia-backend`)

Nightly off-box copy of the platform database, straight from the box it lives
on to the Storage Box.

```
/var/lib/infinite-agents/backend.db  ──snapshot+gzip+verify──▶  <Storage Box>/db/<YYYY-MM-DD>.db.gz
```

## Why this exists

The database used to be backed up — badly, and by accident.

`backend/scripts/sqlite-backup.mjs` uploaded its nightly snapshot **into MinIO**
on ia-media, and a 04:30 object-store job carried the whole store, snapshot
included, to the Storage Box. That chain worked, and it is how the database
survived until this job existed. What was wrong with it:

| | |
|---|---|
| **The most important dataset rode on the least important one.** | Any decision to change, shrink or retire the media backup silently changed the database's backup too. |
| **Restoring meant standing up MinIO.** | Objects on disk are not the file you stored — MinIO writes a 32-byte HighwayHash before each block. Getting one database out meant restoring a whole object-store tree and starting MinIO to read it through the S3 API. |
| **Two hops, two boxes, ~1.5h apart.** | A failure anywhere in the chain, on either box, ended with a database that was not backed up — and the alert, if any, was about the object store. |

Now the database travels on its own, on its own schedule, and a restore is a
download and a `gunzip`.

**Both halves of the old path are gone**, retired once this one had run
unattended and been restore-drilled: `sqlite-backup.mjs` and its cron, and the
object-store backup that carried it. The object store held 12 MB of user
attachments against 13 MB of database snapshots, and backing up user media was
a deliberate decision to drop — so those attachments now have no off-box copy,
and a restored account shows chat history with dead attachment links.
That is a known, accepted trade, not an oversight.

## Files

| | |
|---|---|
| `snapshot-db.sh` | the privileged half: a consistent SQLite snapshot into the spool |
| `backup-db.sh` | the job: fingerprint, compress, verify, upload, prune, report |
| `dbbackup.{service,timer}` | runs it at 03:45 UTC, jittered |
| `dbbackup-failed@.service` | `OnFailure=` handler for a run that died before reporting |
| `provision.sh` | idempotent installer, run as root on the box |

## Shape

**Two steps, two privilege levels — this is the main design decision.** The
unit runs as the unprivileged `dbbackup` user, but its `ExecStartPre` is
prefixed with `+`, so that one step runs as root:

```
ExecStartPre=+/opt/dbbackup/snapshot-db.sh    # root: reads the live database
ExecStart=/opt/dbbackup/backup-db.sh          # dbbackup: holds the Storage Box key
```

Reading a live WAL database needs privileges — a reader has to attach to the
`-shm` file to take a read transaction, and the database directory belongs to
`app`. Running the whole job as root would work and would also hand the backup
SSH key to a process that has no need for it. Running the whole job
unprivileged would *appear* to work, because the backend keeps a valid `-shm`
on disk — right up until the backend is stopped, which is precisely when you
most want a snapshot to be possible. So the split: the step that reads the
database cannot reach the network, and the step that reaches the network cannot
read the database.

**A SQLite snapshot, not a file copy.** `.backup` is the online backup API: safe
against a database being written underneath it, and it folds the WAL into the
result. This is not a theoretical nicety. On ia-backend the main file is 808 KB
and the WAL is **1.6 MB** — most of the recent data. A `cp` of `backend.db`
would produce a file that opens cleanly, passes every structural check, and is
missing every row written since the last checkpoint. There is a test for
exactly this (`db-backup.test.ts`, "captures committed data still sitting in
the WAL"): it writes 200 rows with checkpointing disabled and asserts the
archive has all 202 while a plain copy taken at the same moment does not.

**It refuses more than it reports.** A snapshot that will not open, will not
pass `integrity_check`, or contains no tables at all is deleted rather than
handed on. An empty-but-valid database is the failure mode that looks like a
green run for weeks, so it is checked for by name.

**It verifies what it is about to send, the way a restore would.** The archive
is decompressed, opened with SQLite and integrity-checked *before* upload —
`gzip -t` alone only proves the envelope survived.

**It only uploads when something changed**, fingerprinting the snapshot's own
bytes rather than the compressed artifact (gzip embeds an mtime, so two
compressions of an identical database differ). In practice a live database
changes every night; the check costs nothing and matters on a quiet one.

**Retention is identical to the git bundles and the object store**: 14 dailies,
then one per ISO week for 8 weeks, and never the newest archive whatever its
age. That last rule is what makes skipping unchanged nights safe.

**The spool is emptied at the end of every run**, success or failure. Between
the two steps it holds a complete copy of the database at mode 0600; leaving it
there would quietly double what a compromise of this box is worth.

## ⚠️ These backups are useless without `SECRETS_MASTER_KEY`

Since #1089 every value in the `secrets` table is AES-256-GCM ciphertext
(`enc:v1:…`), and since 2026-10-08 so is every AI sign-in token on `org_seats`
(docs/user-secrets.md). The archives here contain that ciphertext and nothing
else — the key is **not** in the database and is deliberately not backed up
alongside it. Archives taken before `scripts/encrypt-seats.mjs` ran still hold
the seat tokens in plaintext until the prune ages them out (14 dailies, then 8
weeklies — about ten weeks).

A restore without the key gives you a working platform whose every stored
credential is unreadable. The key lives in `/etc/infinite-agents/backend.env`
on ia-backend, in the shared `agentbuilt` secret store, and offline with the
user. **Losing every copy of it loses every secret**, and no backup in this
directory changes that.

## Restoring

```sh
sftp -P 23 <storage-box-user>@<storage-box-host>:db-backups/db/<date>.db.gz .
gunzip <date>.db.gz
sqlite3 <date>.db 'PRAGMA integrity_check;'      # expect: ok
```

That is the whole procedure — the artifact is an ordinary SQLite file. To put
it back:

```sh
systemctl stop infinite-agents
cp <date>.db /var/lib/infinite-agents/backend.db
rm -f /var/lib/infinite-agents/backend.db-wal /var/lib/infinite-agents/backend.db-shm
chown app:app /var/lib/infinite-agents/backend.db
systemctl start infinite-agents
```

**Delete the `-wal` and `-shm`.** A snapshot is a complete database on its own;
leaving the old WAL next to it means SQLite replays writes that belong to the
database you just replaced.

**Drill it before you need it.** A backup nobody has restored is a hypothesis.
This one has been, in prod on 2026-08-12: the 125,339-byte artifact was pulled
back off the Storage Box, decompressed to 819,200 bytes, opened as
`SQLite format 3`, passed `PRAGMA integrity_check`, and every one of its 13
tables matched the live database's row counts exactly — including all 22
`secrets` rows, still carrying their `enc:v1:` ciphertext.

## Notifications

Every run reports to the same ops Telegram bot as the git and media backups:

```
✅ database backup OK — ia-backend
14 tables · 124K uploaded
target: <storage-box-host>:db-backups
```

ia-backend has no `/opt/agentgit`, so it gets its own copy of the notifier
binary from the same source file in the repo, plus its own bot config at
`/etc/dbbackup/ops-notify.env` and its own delivery marker. Same reasoning as
the object-store job on ia-media: sharing the *binary* is fine, sharing the
*credentials* would mean sharing a great deal more.

The `OnFailure=` handler matters more here than elsewhere: the snapshot runs as
`ExecStartPre`, so a failure in it means the job never reached the code that
reports its own failures.

## Install

Needs the `sqlite3` CLI on the box — `provision.sh` refuses to install without
it. ia-backend has it; the CI machine image did not until it was added for
this job's tests.

```sh
rsync -az infra/db-backup/ \
      infra/git-host/notify.sh infra/git-host/notify-unit-failure.sh \
      infra/git-host/backup-heartbeat.sh \
      root@<backend-host>:/root/db-backup/
ssh root@<backend-host> 'bash /root/db-backup/provision.sh'
```

Then add the printed public key to the Storage Box, set `BACKUP_SSH_TARGET` in
`/etc/dbbackup/backup.env`, fill in `/etc/dbbackup/ops-notify.env`, and
`systemctl start dbbackup`.

Updates deploy themselves: the `deploy-db-backup` job ships this directory on
every main push that touches it, skipping otherwise.
