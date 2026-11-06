# Backup watchdog (off Fly)

A Cloudflare Worker that checks, every 6 hours, that the platform's backups in
the R2 bucket `acc-platform-backups` are fresh, and tells the ops Telegram chat
when they are not (note #1032).

## Why it is on Cloudflare

Once the control plane is on Fly (note #1031), everything that makes and
watches backups runs there too: the backend's database backup, the code
host's bundles, the media mirror and the backend's own backup monitor. If Fly
stops, none of those can say so. The copies themselves are in R2, so the only
thing that can notice that they stopped arriving has to run beside them, not on
Fly. This Worker reads the bucket through its R2 binding (list only), holds no
Fly key, and writes nothing.

## What it checks

| Prefix | Limit | Why |
|---|---|---|
| `db/` | 8 h (`DB_MAX_AGE_HOURS`) | the database is backed up every 6 h |
| `git/` | 72 h (`GIT_MAX_AGE_HOURS`) | a bundle is only written for a repo that changed, and the platform's own repo changes daily |
| `media/` | off (`MEDIA_MAX_AGE_HOURS=0`) | media is mirrored only when there is new media, so age says nothing |

A stale prefix, or one with nothing in it, sends one message per run. The
first run of each Monday (UTC) sends a short "all fresh" line, so the
watchdog's own silence is noticeable.

## Deploy

```sh
cd infra/backup-watchdog
CLOUDFLARE_API_TOKEN=<Account:Workers Scripts:Edit> npx wrangler@latest deploy
# Worker secrets, set once:
#   TELEGRAM_OPS_BOT_TOKEN, TELEGRAM_OPS_CHAT_ID  (the ops bot the backup jobs already use)
#   WATCHDOG_KEY  (any random string; only for the hand check below)
```

## Hand check

```sh
curl -H "x-watchdog-key: $WATCHDOG_KEY" https://backup-watchdog.<account>.workers.dev/
# add ?notify=1 to also send the verdict to the ops chat
```

Without the key it answers 404.

## Tests

```sh
node --test infra/backup-watchdog/worker.test.mjs
```
