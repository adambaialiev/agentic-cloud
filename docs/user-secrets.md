# User secrets

The API keys and tokens a user's agents need to do real work — a GitHub token, an
OpenAI key, a deploy password — stored on the platform and exported into every
CLI turn those agents run.

## Why the platform holds them

An agent machine is not durable. The idle reaper stops it, the free-tier
recycler **destroys** it (volume and app with it) after three idle days, and an
image roll resets everything outside `/home/agent`. A key the user pasted into a
shell once is gone with the first recycle, and they have to go find it again.

Held here, it is re-exported on the next turn of a rebuilt machine with no user
action at all. That durability is the feature; the Workspace is just how it gets
filled.

## User-facing surface

**Adding a secret is the browser Workspace, and only the Workspace** — the
"Add a secret" form on the home screen. The value travels straight over HTTPS
and never lands in a chat message. The Workspace lists masked previews and
lets the owner remove shared keys; an agent uses `agentbuilt secret` for the
workplace's keys and for its private overrides.

`/secret NAME=value` used to save one from a customer chat and is **retired**.
No production customer webhook mounts that compatibility command. Historical
handlers remain fail-closed while the old service and stored schema names are
removed separately; they are not an access path.

A Workspace write is always **shared**. A key private to one agent is still
possible, but only the agent makes one, with
`agentbuilt secret set --this-agent`.

### Keys belong to the workplace (note #783)

"Shared" means shared across the whole **workplace**, like a repository
(Adam, 23 Oct 2026: "secrets should not be per room, it should be global per
workplace, like repositories" — reversing note #88, which had made them per
room). Every store here is still keyed by a git NAMESPACE, and a caller
used to name the namespace of the room it stood in; what changed is one
wrapper, `ShelfMappedSecretStorage`, which maps that namespace to the
workplace's own (`OrgGitService.secretShelfFor`, the same shape as the
knowledge shelf) once the workplace carries `secretShelf.mergedAt`. Until
then a room read its own store, so nothing was ever missing between the
release and the merge.

| Who is asking | Store they resolve to |
| --- | --- |
| an agent, the Workspace, a bucket's four keys, a site's `--secret` | the workplace's one set |
| a repo's CI run | the workplace's one set |
| a personal account, or a workplace the merge has not reached | its own namespace, as before |

The migration (`secret-shelf-backfill.ts`, at boot, idempotent) copies every
room's rows onto the shelf, applies the pinned room limits, stamps the
workplace, then deletes the sources — so a failure before the stamp changes
nothing. A name two rooms held with different values keeps the first value
under the name; the other is saved as `NAME_<ROOM>` with a description saying
why, recorded in `secretShelf.renames` and shown on the key's screen.
Production held no clash (Platform 30 keys, Growth 3).

### Rooms: "only in these rooms" (note #783) — gone

Rooms were removed on 30–31 Oct 2026 (note #843), and this limit with them
(Adam, 30 Oct 2026: the Platform-only keys go workplace-wide, no per-agent
limits). A limit still stored on a row limits nothing and is never shown;
`agentbuilt secret rooms` answers "Rooms are gone", and members, admins-only
and this-agent are the only things that scope a key now. What follows is how
it worked.

A shared row could carry `rooms`, a list of room ids. Absent meant every room;
present meant a turn was handed the key only when its agent stood in one of
them (`UserSecretViewer.roomId`), and a turn with no room — a legacy agent, a
CI grant from before rooms were recorded — was not. The platform workplace's
infrastructure keys (root SSH to the Hetzner fleet, `SECRETS_MASTER_KEY`, the
live Paddle keys, `FLY_API_TOKEN` and the like; the list is
`PLATFORM_SECRET_ROOM_LIMITS`) were limited to the Platform room by the
migration. An admin, from the key's screen, or an admin-owned agent
(`agentbuilt secret rooms NAME --only "Platform, Growth" | --everywhere`)
changed a limit. Deleting a room never deleted a key; a key limited only to a
room that was gone reached nobody until the limit was changed, and the listing
marked such a row `offRoom` for the asking agent.

### Scope comes from the workplace or the agent

A human adds a shared key from the Workplace window of the Workspace. An
agent sees the shared keys plus any private keys it saved with
`agentbuilt secret set --this-agent`. An agent-scoped secret **shadows** a
shared one of the same name for that agent only, which is what "this agent uses
a different key" has to mean.

Deletion is scope-specific on purpose: `agentbuilt secret set --this-agent`
creates the private copy, and `agentbuilt secret rm NAME --this-agent` removes
that copy without silently falling back to deleting the shared one.

Deleting an agent drops the secrets scoped to it — its machine and Workspace
identity are gone, so nothing can read them again, and left behind they would
count against the workplace's ceiling forever. Shared secrets survive.

### Audience: whose agents a shared key reaches (note #655)

A key on an agent's machine is a key that agent's OWNER can read — they drive
the machine through chat, and `printenv NAME` is one message away. So "members
see names and descriptions but never values" can only be true of the keys a
member's agents are never handed. Every shared row therefore carries an
**audience**:

| Audience | Reaches |
| --- | --- |
| `admins` (default; also what a row from before audiences means) | agents owned by workplace admins |
| `everyone` | every agent working in the workplace |

Agent-private rows have no audience — they reach one agent by construction.
A personal namespace with no workplace has one human, its admin, so everything
reaches there.

The gate is applied where it matters, in `getSecretEnv`: the harness passes a
`UserSecretViewer` resolved from the owner's org membership record (never from
the agent or its machine), and a member's turn simply never receives an
admins-only value. The listing still shows members the row — name, masked
preview, description, and `reaches`, the names of the agents in the workplace
that actually get it — so the fact that a key is out of reach is visible rather
than mysterious.

Who sets it: an admin, from the Workspace (a switch on the secret's screen, and
a choice on the add form) or an admin-owned agent (`agentbuilt secret share
NAME --members | --admins-only`, or `secret set ... --members` on create).
Rotating a value keeps the audience — a new value never widens who gets it.
A change takes effect at each agent's next turn.

The same change lets a MEMBER save a private key for one of their own agents
from the Workspace (`POST /api/secrets?agent=<id>`), which until now had no
safe path at all: the add form was hidden from them and pasting into chat is
the thing the whole feature exists to avoid.

### The agent's own surface: `agentbuilt secret`

The same cupboard is reachable from the machine, so an agent can check what it
has and save a key it is already holding without a round trip through the user:

| Command | Does |
| --- | --- |
| `agentbuilt secret list` | Names, descriptions, masked previews, scope, last changed — for what THIS agent can see (its own plus the shared ones). |
| `agentbuilt secret set NAME=value --description "..." [--this-agent]` | Saves or rotates one. |
| `agentbuilt secret set NAME --from-file <path> --description "..." [--this-agent]` | Same, for a key already on disk. |
| `agentbuilt secret describe NAME "..." [--this-agent]` | Replaces the description without touching the value. |
| `agentbuilt secret share NAME --members` / `--admins-only` | Whose agents a shared key reaches (admin-owned agents only). |
| `agentbuilt secret rm NAME [--this-agent]` | Removes one. |

### Every secret has a description

A description is one sentence on why the secret exists and what it is for —
"Cloudflare token for deploying the user's site workers". It is what the user
reads in the Workspace, and what every OTHER agent reads in
`secret list`, to know what a key does without anyone re-deriving it from a
masked value and a name.

The requirement is enforced where agents write: the CLI **refuses to create** a
secret without `--description` (and the machine docs say so), while rotating an
existing key keeps the description it already has — rotating a value does not
change what it is for. `describe` exists for the two honest gaps: rows from
before descriptions existed, and descriptions that went stale when a key's
purpose shifted. A description-only edit deliberately does **not** bump the
last-changed time — that stamp answers "is this the new key or the rotated
one?", and annotating a row rotates nothing.

The API keeps `description` optional (old CLIs still call it, and the Workspace
add form deliberately never asks — nobody writes prose while pasting a token),
bounded at 200 characters, collapsed to one line. `secret list` marks rows that
lack one so agents fill them in as they touch them.

CLI writes default to **shared** — the key an agent is handed is almost always
a general-purpose credential (a GitHub token, an API key) that the user would
otherwise have to paste again for every other agent. `--this-agent` is the
explicit opt-in to a private key, for "this agent uses a different key".
(`--shared` is still accepted and now names the default; the API's legacy
`shared` flag is likewise harmless.) The Workspace agrees: a user's add is
always shared. `--this-agent` is where a private key comes from, and since
`/secret` retired it is the ONLY place one comes from.

**No route returns plaintext.** Not as a barrier — in-scope values are already
in the machine's environment, and `printenv` is the documented way to read one —
but because a value returned over HTTP lands in the agent's transcript, which is
the durability problem the whole feature exists to avoid. `list` answers "what
is configured?"; the environment answers "what is the value?". `--from-file`
exists for the same reason: it saves a key without it passing through the
agent's conversation history.

Handing a key *to* an agent is the Workspace add form, and the machine docs say
so: that path never lets the value reach the agent's context, or the chat, at
all.

This does widen what a prompt-injected agent can do — it could rotate a
`--shared` key out from under the user's other agents. It cannot exfiltrate
anything it could not already read from its own environment, the damage is
confined to the user's own account, and the Workspace shows a last-changed
time that makes an unexpected write visible.

The current removal surfaces are the Workspace for shared keys and
`agentbuilt secret rm` for agents. The production backend mounts no customer
chat command menu or webhook.

## Storage

User secrets share `SecretStorage` with the platform's own credentials (the
Codex/Claude auth blobs, managed bot tokens), which are keyed by bare names
like `claude-oauth-token`. User secrets are therefore stored under a reserved
prefix, in one of two shapes:

```
user-env:NAME             shared by all agents
user-env@<agentId>:NAME   only that agent's turns
```

The shared form is unchanged from before scoping existed, so rows written then
keep working and keep meaning "all agents" — no migration. Agent ids are UUIDs
and so never contain `:`, which is what makes the scoped key unambiguous to
parse.

**This prefix is load-bearing.** Without it, a user who names a secret
`claude-oauth-token` overwrites the credential their own harness authenticates
with. `backend/src/test/unit/user-secrets.test.ts` pins that case.

Names are validated on the way in *and* on the way out (`getSecretEnv`
re-validates), because a name is interpolated bare into `export NAME=...` — an
unchecked one is shell injection into the user's own turn. Names matching the
agent runtime's own variables (`PATH`, `HOME`, `LD_PRELOAD`, `NODE_OPTIONS`, the
CLI credential envs) are refused at write time, so the user finds out when they
set it rather than when a turn mysteriously fails.

Ceilings: 96 secrets per workplace (32 per room before note #783), 8 KB per value, 64 characters per name, 200
characters per description. The count is enforced on create only, so rotating a
key still works at the cap.

### Encryption at rest

When `SECRETS_MASTER_KEY` is set in backend.env, secret **values** are
encrypted before they reach the table: `EncryptedSecretStorage` wraps the real
storage and encrypts on write / decrypts on read (AES-256-GCM, fresh nonce per
value, stored as `enc:v1:<base64>`). Consumers keep reading `secret.value` as
plaintext and never know; the SQLite file — and every nightly S3 snapshot of
it — holds only ciphertext. This covers the platform's own credentials too,
since they share the table.

What this buys: a copied `backend.db` or a leaked backup bucket is no longer a
credential dump — file and key are separate artifacts. What it does **not**
buy: a compromised backend host holds both, and values still reach agent
machines in plaintext per turn. Names and descriptions stay plaintext (lookups
and `/secrets` need them).

A value without the `enc:` tag is treated as legacy plaintext and returned
as-is, so the rollout is order-safe: deploy → set the key + restart (new
writes encrypted, old rows still readable) → `node
backend/scripts/encrypt-secrets.mjs --apply` converts the rest. The same
script's `--decrypt --apply` restores plaintext, which must happen **before**
rolling back to a pre-encryption build. Losing the key loses every stored
secret — it must survive host rebuilds with the rest of backend.env.

Wrong key or corrupted row fails loudly (`SecretCipherError`), never returns
garbage — GCM authenticates before it decrypts.

**AI sign-ins use the same key.** Members' Claude and ChatGPT sign-ins live on
`org_seats` (docs/seat-sign-in.md), not in this table; the org schema moved
them there on 2026-08-22 without the cipher, so they sat in plain JSON until
2026-10-08. Now `SqliteOrgStorage` seals each seat's `token` and
`oauth.refreshToken`, and `SqliteSeatSignInStorage` a pending ceremony's
`deviceAuthId` (`services/seat-credential-cipher.ts`) — the rest of the doc
stays readable for the queries that filter on it. Legacy rows read as
themselves; `node backend/scripts/encrypt-seats.mjs --apply` converts them
and VACUUMs, because a rewritten row's old bytes otherwise stay in free pages
that `.backup` copies.

## How a secret reaches the CLI

`startDetachedTurn` takes an `env` map and emits `export NAME='value'` lines at
the top of the per-turn launch script:

```sh
umask 077
cat > '/tmp/…turn.sh' <<'HARNESS_TURN_<random>'
export GH_TOKEN='ghp_…'
{ claude -p '…'; } > '/tmp/…turn.jsonl' < /dev/null 2> '…stderr'
echo $? > '…exit'
HARNESS_TURN_<random>
nohup setsid bash '/tmp/…turn.sh' …
```

Three properties matter, and each has a test:

- **In the script body, not the launch line.** Values on the command line would
  be visible in `ps` to anything else on the machine.
- **The heredoc delimiter is quoted**, so the shell performs no expansion while
  *writing* the script — a value containing `$(...)` or backticks lands verbatim.
- **Values are single-quoted**, with embedded quotes closed and reopened
  (`'a'"'"'b'`), so they cannot execute when the script *runs*.

The script is written under `umask 077` and removed when the turn ends.

## Redaction

Every harness adds the exported values to `redactHarnessSecrets(...)` for
anything derived from the turn: the transcript, the activity line, stderr and
turn-file tails in diagnostics, and the error message on a failed turn.

This matters because the CLI itself can echo a secret back — a `curl` command it
composed, a stack trace, an env dump. `secretEnv` is resolved **outside** the
harness `try` block specifically so the `catch` can redact the same values out
of a failure message.

Redaction is exact-substring. A secret the CLI transforms before printing
(base64-encoding it, splitting it across lines) will not be caught, so this is a
strong mitigation rather than a guarantee.

## Threat model

What this protects against:

- A credential outliving its usefulness in a chat transcript.
- Losing keys when a machine is recycled or rebuilt.
- Secrets leaking back through agent replies, logs, and diagnostics.
- One user's secret reaching another user's turn (storage is per-user).
- One agent's private secret reaching another agent's turn (see the scope
  tests — this is the assertion that makes scoping mean anything).
- A user overwriting a platform credential, or injecting shell through a name.
- A copied database file or leaked DB backup exposing values (encryption at
  rest, above — provided `SECRETS_MASTER_KEY` did not leak with it).

What it does **not** protect against, by design: the agent has a full shell on
the machine and the secrets are in its environment, so an agent can read them.
That is the point — they exist so it can use them. The machine is the user's
own, and it is the only thing running there.

## Adding a new consumer

If you add another CLI harness, it needs all three of:

1. `const secretEnv = await resolveUserSecretEnv(deps.secretStorage, userId, targetAgent?.id);`
   declared **outside** the `try`, so the `catch` can redact with it. Passing the
   agent id is what keeps another agent's private keys out of this turn; omit it
   and the harness silently falls back to shared-only.
2. `env: secretEnv` passed to `startDetachedTurn`.
3. Every value in the harness's `redactHarnessSecrets(...)` calls.

Missing (3) is the dangerous one: the turn works, and the leak only shows up in
a transcript someone reads later.

## Why there is no "last used" timestamp

`/secrets` shows when each secret last **changed**, not when it was last used.
That is deliberate, not a gap:

- Every in-scope secret is exported into every turn, so a "last used" stamp
  would be the same value for all of them — the time of the last turn.
- Whether the CLI actually *read* a variable is not observable from here. A
  stamp implying otherwise would be a claim the system cannot support.

"Last changed" is the question a user can act on: *is this the new key, or the
one I rotated away from?*
