# Legacy Telegram harness routing

> **Retired customer flow (2026-09-01, note 212):** coworkers converse in
> one shared Workspace and run against member-owned Claude or ChatGPT seats.
> Browser access uses the name of your address and a password (since
> 2026-09-14; an authenticator code is an optional second factor). The factory bot,
> per-agent bots, customer webhook routes, signed Mini App launches and
> customer Telegram notifications are no longer mounted. Passages below are
> implementation and migration history, not the current customer contract. See
> `docs/seat-sign-in.md` for current sign-in.

> **The setup assistant is gone (2026-09-04, note #313).** PR #616 retired it,
> and PR #630 removed its loop (`runAgentLoop`), its prompts and its whole tool
> set — `create_agent_machine`, `list_agent_machines`, `expose_port`,
> `unexpose_port`, `rename_agent`, `delete_agent`, `set_claude_oauth_token`,
> `harness_status` and the `set_*_harness_server` pair no longer exist. Every
> turn now runs on the Claude or Codex harness. Passages below that describe
> those tools in the present tense are history; agent deletion lives in the
> Workspace (`agentLifecycle.deleteAgent`), and there is no port-exposure or
> agent-rename door.

> **Kimi was REMOVED from the codebase on 2026-08-25** — harness, login,
> model catalog, CLI install and version pin are all gone. What remains is the
> retired-agent path: an agent whose STORED cli is not one this product runs
> is shown as retired, is never handed to a harness or given a machine boot,
> and answers with the retirement message so its owner can delete it.
> `backend/scripts/retire-legacy-clis.mjs` migrates the unconnected ones.
>
> Codex was retired alongside Kimi on 2026-08-09 (the credential pool went
> Claude-only) and returned 2026-08-19 as a creation-time choice — the
> Workspace's "New agent" flow and the roster's CLI pick offer Claude Code or
> Codex, and the pick is permanent for that agent — but ONLY pool-backed:
> creation is refused unless the user is on the platform plan and the pool
> holds a live `codex` credential (the interactive `codex login` ceremony did
> not return, and `create_agent_machine` still accepts `claude` alone).
> The Codex harness has missed part of the Claude-only improvement window
> (model-scoped cooldowns) — parity work is tracked separately. Context-usage
> capture landed 2026-08-19; see "Context Usage"
> below, and note that it does NOT come from the turn stream.

> Architecture note: the platform transcript mirror and platform-owned
> scheduling described here have been removed, along with Firestore itself.
> See [Removing Firestore Agent-Session Mirroring](firestore-agent-session-removal.md)
> for the reasoning and the final state.

This document describes how a connected Telegram user turn reaches Codex,
or Claude Code, how authentication and conversation continuity
work, and how to debug the production path.

The important architectural fact is that these harnesses do not call OpenAI,
Anthropic, or Moonshot model APIs from the backend. They start the user's subscription-backed
CLI on the user's managed server over SSH. The backend routes messages, supervises
the process, parses its JSONL event stream, persists conversation state, and
delivers assistant text to Telegram.

## High-Level Flow

```text
Telegram message
  -> AgentService loads the user's harness selection
  -> BackgroundRunner starts the selected harness loop
  -> harness opens an SSH terminal on the recorded server as `agent`
  -> Codex or Claude runs in headless JSONL mode under /home/agent
  -> stdout is written to a private per-turn file under /tmp
  -> backend polls and parses new complete JSONL lines
  -> assistant text is persisted and sent directly to Telegram
```

The built-in Telegram model loop is only used by the restricted setup agent.
Once a real user message is routed to a connected harness, the CLI itself
produces the assistant response. Telegram has no autonomous controller route.

## Persisted Routing State

The user profile stores the selected and connected harnesses:

```ts
telegram: {
  harness: 'default' | 'codex' | 'claude';
  connectedHarnesses?: {
    codex?: string;   // connection timestamp
    claude?: string;  // connection timestamp
  };
  harnessServers?: {
    codex?: string;   // managed-server record id, for example hcloud_123
    claude?: string;
  };
  harnessModels?: {
    codex?: string;   // explicit Codex model; missing uses the account default
    claude?: string;  // Claude alias/model; missing uses the account default
  };
}
```

A CLI is considered connected only when `telegram.harness` selects it and the
matching `connectedHarnesses` entry exists. `harnessServers` pins the CLI to the
same server on which setup installed and authenticated it.

The Telegram session stores CLI conversation continuity separately:

```ts
codexThreadId?: string;
claudeSessionId?: string;
```

These identifiers belong to files on the VM. If the sandbox is rebuilt and the
saved conversation no longer exists, the harness detects the missing resume
target and retries the current message once as a fresh conversation.

Telegram owns the `/clear` command instead of forwarding it to either CLI.
`/clear` (manager chat) asks for confirmation; confirming archives and clears
the Telegram transcript and removes the CLI conversation identifiers, so the
next turn cannot resume provider-side context from the old chat. Saved memory,
schedules, harness, model, connection, and server settings remain unchanged.

An agent chat has no reset button: the AGENT decides when its conversation is
spent (`agentbuilt chat new`, 2026-08-16). The backend applies the reset when
the calling turn ends — the finishing harness writes its session id back, so
an immediate null would be overwritten — then drops a divider in the chat and,
when the agent left a handoff, opens the fresh conversation with it as a
`[Platform]` turn.

## Setup and Authentication

An unconnected real user message runs the restricted Telegram setup agent. The
setup agent can provision a server, install a CLI, drive its login, and record
the server through setup-only tools.

### Claude

1. The setup agent runs `claude setup-token` as the non-root `agent` user.
2. The user opens the displayed OAuth URL and returns the complete verification
   code, including any `#state` suffix.
3. Claude prints a long-lived `sk-ant-oat...` token.
4. `set_claude_oauth_token` performs a live `claude -p` probe and stores the
   token in backend secret storage under `claude-oauth-token`.
5. `harness_status` verifies the credential and records Claude as connected.

`setup-token` does not reliably create `~/.claude/.credentials.json`. The stored
OAuth token is therefore the primary credential and is injected into every turn
as `CLAUDE_CODE_OAUTH_TOKEN`. A credentials file remains a fallback for users
who authenticated interactively.

### Codex

Codex signs in through its ChatGPT device-code flow. Its `~/.codex/auth.json` is
backed up to backend secret storage and restored when necessary. Normal Codex
turns use that file; the credential is not placed directly in the command line.


## Telegram Routing and Handoff

`AgentService` resolves the desired harness before queueing a message.
It passes the selected CLI runner as the fifth argument to
`BackgroundRunner.startAgent`.

`BackgroundRunner` records the exact loop function for each running session.
This matters during setup handoff: `harness_status` may mark Claude or Codex
connected while the setup loop is still finishing. If the next message arrives
at that point, Telegram detects that the running loop does not match the newly
selected harness, preserves already accepted messages, interrupts the setup
loop, and restarts the messages in arrival order on the CLI harness.

Without this route comparison, queued messages restart with the old setup loop
and users receive controller-model responses after being told the CLI is
connected.

### Turn boundaries and user steering

Every fresh Claude and Codex process receives exactly one positional user
payload and starts with closed stdin. A direct user message that arrives while
that agent is working does not enter the live CLI. Instead,
`BackgroundRunner.steerAgent` atomically preserves the message before aborting
the turn, waits until the detached process group has actually exited, folds in
every later user message and attachment that arrived during shutdown, and
starts exactly one replacement turn in the same native conversation. The
replacement prompt begins with a trusted note that the previous turn was
interrupted and that partially completed work must be inspected. Telegram says
`Changing direction…` once when that steering cycle begins.

The interruption modes are deliberately separate:

- **Steer:** preserve and merge the new user payloads, kill the current CLI,
  and resume once.
- **Manual Stop:** discard queued steering payloads, kill the current CLI, and
  remain stopped. Stop overrides steering even if the abort signal already
  fired.
- **Backend shutdown:** leave an ordinary detached turn alive and checkpoint
  its attach information for the next process. A steering checkpoint contains
  the merged correction, interruption notice, and kill-only metadata for the
  abandoned CLI. A stopped turn may retain the same metadata only for cleanup;
  its discarded work is never replayed.

Platform notes, setup handoffs, and other internal messages retain their
ordinary queue semantics and do not preempt user work. Claude briefly used
held-open `--input-format stream-json` stdin, but a later message could make it
abandon an in-flight tool wait. Fresh turns therefore keep stdin closed even if
an old deployment still sets `HARNESS_STREAM_INPUT=1`. Re-attach retains only a
rolling-deploy bridge: a legacy turn that was already running may carry an
`inputPath`, which the new backend closes after its result, but no new payload
is written to it.

Agent-to-agent messages use the same boundary, with a queue behind it (note
#267). The service checks the recipient's live per-agent run key: idle → it
prepares the route and calls `BackgroundRunner.startAgent` for the atomic final
claim; working → `BackgroundRunner.queueMessage` holds the message behind the
running turn, and the runner's completion path delivers everything queued as
ONE restart turn (its ordinary merge of plain payloads), which also checkpoints
the queue across a backend restart. If a turn wins the slot during route
preparation the message queues rather than fails, and the sender is always
told which of the two happened. The service keeps the bookkeeping the runner
does not: one waiting message per sender per recipient, five per recipient in
all, a one-hour expiry that pulls the payload back out and reports on both
chats, `agentbuilt agent pending` / `agent cancel <id>` for the sender, and a
loop guard of three queued messages per sender→recipient per hour. Stop drops
the runner's queue, so the senders of anything held behind a stopped turn are
told too.

The Workspace Agent may end a running turn itself (note #462): `agentbuilt
agent stop "<name-or-id>" ["<why>"]` is `POST /agents/stop`, which the route
refuses any credential but the Workspace Agent's before resolving a name — the owner asked
for that fence explicitly. Behind it is the same `stopAgentTurnFromWorkspace`
the chat screen's Stop calls, with `stoppedBy: 'workspace-agent'`, so the
owner's already-sent words are held for the next Send and queued peer messages
are settled exactly as under the button. Two things differ: the chat row on
the stopped agent reads `Turn stopped by Workspace Agent` (with the reason
after a colon), which the screen renders as its own quiet line, and the call
waits up to `STOP_UNWIND_WAIT_MS` for the interrupted exec to unwind, answering
`idle: true|false` so the caller knows whether a message can reach the agent
at once. The Workspace Agent conversation records the stop as a receipt and
closes any wait it held for that agent's reply.

The sender can coordinate across its whole workplace without crossing a
workplace or owner boundary (note #106). `agentbuilt agent list` returns ONE
list of the owner's live agents in the sender's immutable workplace, the
sender first. (It grouped them under the workplace's rooms, an empty room
still shown, until rooms were removed on 30–31 Oct 2026 — note #843.)

Each row carries three live facts about its agent: whether it is working or
idle, how long the running turn has been going (`activitySince`, present only
while working), and a one-line recap of its latest work. All three are read at
request time — the state and the clock from the in-memory run registry that the
Workspace's own running clock reads, never from a stored "last active" stamp
that would keep counting after its turn ended. A working turn the registry has
no start stamp for sends no clock rather than a zero, and the CLI then prints
the bare state (note #171).

It also carries the runtime that agent's NEXT turn will run on: `model` and
`effort`, resolved through `resolveEffectiveModel` / `resolveEffectiveEffort` —
the same helpers as harness launch, and the same pair the Workspace row has
shown beside the harness since note #107. Resolved, never echoed: an absent
override is each CLI's real default, a retired model (`sonnet`) has already
fallen back, and an effort the chosen model does not offer resolves to that
model's default. An agent stored against a retired harness sends neither half,
since there is no model this product would run for it, and the CLI drops any
half it does not receive rather than printing an empty column — which is also
what keeps a machine on an older CLI rendering the row (note #338).
When an agent hands work over it reads the recipient's context fill off the
roster by `HANDOFF_CONTEXT_WARN_PERCENT` / `HANDOFF_CONTEXT_HOT_PERCENT`
(40/60, `backend/src/shared/context-heat.ts`), a deliberately lower pair than
the ring's 67/90 — and only as a safety net: a recipient whose previous work is
finished, given an unrelated task, is asked to "reset your chat first" at any
fill. The sibling message framing (`buildTelegramAgentPeerMessagePrompt`) tells
the recipient to honour that with `agentbuilt chat new "<handoff>"` carrying the
request, because a bare `chat new` resets after the turn and leaves the fresh
chat waiting for the user, with the request gone. The handoff leaves the reset
instruction out, and `buildTelegramAgentChatHandoffPrompt` says the chat is
already fresh, so a carried instruction cannot loop. The Workspace Agent never
asks for reset-first: its reply wait closes when the reset turn ends, so it
tells the person to reset the agent from its screen instead.

`agentbuilt agent message` resolves that same owner's agents anywhere in the
workplace, while an agent belonging to another workplace is indistinguishable
from one that does not exist. Notes, code, knowledge, sites and secrets belong
to the whole workplace too; the wall is the workplace, and work that must be
kept apart goes in a separate workplace.

## CLI Commands

Both harnesses execute as SSH user `agent` in `/home/agent`.

### Claude command

First turn:

```sh
CLAUDE_CODE_OAUTH_TOKEN='<stored token>' \
claude -p '<user message>' \
  --model '<selected model or alias>' \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions
```

Later turns append:

```sh
--resume '<claudeSessionId>'
```

Claude events are handled as follows:

- `system/init`: capture and persist the Claude session id.
- `assistant` content blocks: persist and deliver each text block.
- `result`: record errors, or deliver its text if no assistant block was seen.

### Codex command

First turn:

```sh
codex exec \
  --model '<selected model>' \
  --json \
  --skip-git-repo-check \
  --sandbox danger-full-access \
  -C /home/agent \
  '<user message>'
```

Later turns insert the resume subcommand before the prompt:

```sh
codex exec <parent flags> resume '<codexThreadId>' '<user message>'
```

Codex events are handled as follows:

- `thread.started`: capture and persist the thread id.
- completed `agent_message` items: persist and deliver their text.
- `turn.failed` or `error`: surface a failed harness turn.

The Telegram **Agent & model** keyboard stores model preferences
independently for Codex and Claude. The selected model is passed on every
first and resumed turn. Omitting the selection uses the CLI account default.
For Codex, opening the keyboard reads `codex debug models` on the connected VM,
filters the visible catalog, and caches it briefly. If no live or cached catalog
is available, the keyboard offers only the account default.
Claude offers exactly the `fable` and `opus` aliases (Haiku and Sonnet are
deliberately not offered); they follow the versions available to the user's
account. When Claude reports a concrete model in JSONL, that model is
persisted on the assistant message alongside the requested alias. A model
withdrawn from a catalog is listed in `RETIRED_MODELS`
(`backend/src/agent/harness-models.ts`), so agents still storing it fall back
to the CLI default rather than running an unoffered model forever.

### OpenCode command (note #780)

OpenCode is the third harness, on the member's own OpenCode Go subscription:
one API key from the OpenCode console, pasted on the Subscriptions screen and
checked live (`GET https://opencode.ai/inference/go/v1/models` with the key as
a bearer answers 200, or 401 "Invalid credential"). The seat's `token` IS the
key; a turn leases it and hands it over as `OPENCODE_API_KEY` in the turn's
environment (the script body, never argv). Go models are `opencode-go/<id>`;
the catalog stores the bare id and `opencodeModelRef` adds the provider.

```sh
{ mkdir -p "$HOME/.config/opencode/plugins" && printf '%s' '<plugin, base64>' | base64 -d > "$HOME/.config/opencode/plugins/agentbuilt-limit-stop.js"; } 2>/dev/null; \
opencode run --format json --auto --model 'opencode-go/<id>' [--variant '<effort>'] \
  --title '<agent name>' | --session '<opencodeSessionId>' \
  -- '<prompt' 'split' 'on' 'single' 'spaces>'
```

Measured against opencode 1.19.3 with a stub provider (2026-10-20; the kit
is `~/ocprobe-kit/stub.mjs` on Ada's machine, the method is the knowledge page
probing-a-cli-harness), and re-run against 1.19.5 on 2026-10-31 (note #929)
through this command builder, plugin and event parser, with the same events,
tokens, resume and limit stop:

- **The prompt is split on single spaces.** `opencode run` re-joins its message
  arguments and wraps any argument holding a space in double quotes (inner
  quotes backslashed), so one long argument reaches the model quoted. No piece
  of a space-split prompt holds a space, and the join gives it back byte for
  byte (tabs, newlines, double spaces, quotes, a leading dash after `--`).
- **`--title` on a first turn**, or OpenCode spends a second model request on
  writing the session a title. A resumed turn passes `--session` and no title.
- **Events:** `step_start`; `tool_use` (only once a tool has FINISHED);
  `step_finish` with `part.tokens {input, output, reasoning, cache{read,write}}`;
  `text` (whole, once its part ended); `error` (`error.data.{message,
  statusCode, responseBody}`). Every line carries `sessionID` (`ses_…`), which
  the harness persists as `conversation.opencodeSessionId`.
- **Tokens are per request.** A step is one model request and its figures are
  that request's alone, within a turn and across `--session` resumes. `input`
  leaves the cache reads out; `output` leaves reasoning out. The ledger credits
  the sum of a turn's steps with reasoning added back into output
  (`OpenCodeTurnTokens`); there is no base to keep. A helper agent's requests
  (the `task` tool) run in a child session `opencode run` does not print.
- **Context:** the last step's input + cache read + cache write, against the
  catalog's `contextWindow` (OpenCode never states one).
- **Sessions** live in `~/.local/share/opencode/opencode.db` in the durable
  home. A missing one prints `Error: Session not found` on stderr with exit 1
  and no events; the harness retries once on a fresh session.
- **At a usage limit OpenCode waits, in silence.** A Go window answers 429
  `GoUsageLimitError` with `retry-after` in seconds, and OpenCode sleeps the
  whole of it (the cap is 2^31 ms) while the JSON stream prints nothing. The
  platform plugin above watches `session.status`; on a retry whose
  `action.reason` is `account_rate_limit` (a Go window) or `free_tier_limit`,
  or any wait longer than five minutes, it writes one `platform_limit` line
  (`message`, `retryAt`) into the same stdout and aborts the session. The turn
  ends at once with OpenCode's own sentence; a Go window benches that MODEL on
  the seat (Go's limits are per model), the free tier the whole seat, until
  `retryAt`. The plugin acts only when `AGENTBUILT_OPENCODE_TURN=1`.
- **Environment:** `OPENCODE_DISABLE_AUTOUPDATE=1` (the fleet pins the
  version), `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, and
  `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` (OpenCode otherwise reads
  `~/.claude/CLAUDE.md`). It reads `AGENTS.md` from the working directory —
  the same platform text Codex agents get.
- **Effort is `--variant`.** An unknown variant is silently ignored, and a
  model with none runs without the flag (`resolveEffectiveEffort` answers ''
  for a catalog model with no levels — Kimi K3, MiMo V2.6 Pro).
- **Usage cannot be read.** Go and Zen show usage only in the OpenCode
  console; no endpoint answers a key with it. The seat says so
  (`OPENCODE_USAGE_NOTICE`), and a limit is reported when a turn meets it.

The recap summarizer runs `opencode run` on `glm-5.3-flash` at `high` with
`OPENCODE_PERMISSION='{"*":"deny"}'` (no tools reach the request), reads the
answer from the `text` lines, and deletes the session it had to open. The Chief
of Staff does not run on OpenCode: an OpenCode key powers the workplace's
other agents.

## Tools

The CLIs run with their own built-in tools only: the shell, files and editing
that Claude Code, Codex and OpenCode ship with. The platform adds no tool server
of its own to a turn; its former MCP server has been removed.

## JSONL Transport and Process Supervision

Machine-readable stdout is not parsed from the PTY. PTYs can add ANSI codes,
wrap long JSON lines, and expose destructive delta-read behavior. Instead, each
turn writes stdout to a private file such as:

```text
/tmp/infinite-agents-harness-turn-<uuid>.jsonl
```

The launch wrapper is equivalent to:

```sh
umask 077
{ claude-or-codex ...; } > '<turn-file>' < /dev/null
status=$?
exit "$status"
```

These details are invariants:

- Use a unique file directly under `/tmp`. Do not restore the shared
  `/tmp/harness-turns` directory; an old root-owned directory prevented the
  `agent` user from opening its output file.
- Close stdin with `/dev/null`. Headless CLIs must receive EOF rather than wait
  on the interactive SSH PTY.
- Exit the supervising shell with the CLI status. Otherwise the interactive
  shell stays alive after the CLI completes and the turn appears to run until
  its timeout.
- Create files with `umask 077` and remove them after the turn.

`TurnOutputReader` polls with `tail -n +<line>`. It advances only across complete
lines, retries transient SSH read failures without advancing its offset, and
performs a final drain after the process exits. Stderr remains on the PTY and is
used only for bounded diagnostics.

## Delivery

When a harness extracts assistant text it:

1. Adds an assistant message to session history.
   Harness messages include their CLI source, requested model, and concrete
   model when the CLI exposes it.
2. Emits an `assistant_message` event with the concrete/selected model when
   known and the CLI source (`claude-cli` or `codex-cli`).
3. Calls `notifyAssistantResponse` from the Telegram loop dependencies.
4. Sends sanitized Telegram HTML directly to the user's chat.

The session is then marked `completed` and receives `agent_complete`.

## Context Usage

Both CLI harnesses record how full the conversation's context window is on the
AGENT record (`telegram.agents[id].contextUsage`), and both append the same
one-line `[Platform] Context window: …` note to the next turn's prompt. The
Mini App's context ring and the agent's own sentence are two renderings of that
one field (`resolveContextUsage`, `backend/src/utils/context-window.ts`), and
both stay silent rather than draw a percentage they had to invent.

When the agent detail screen has a reading above 0%, the context row also
offers **Ask agent to reset chat**. It sends the literal `reset chat` through
the same idle-only Workspace message route used by note handoffs, rather than
clearing state behind the agent's back: the agent gets a turn to preserve
durable state, resets itself, and answers in its own chat. The action is absent
at 0% or with no reading, and is visible but locked while the agent is working.

The fleet on Home has the same ask for many agents at once (note #707; it
stood on each room's Agents tab until rooms were removed, note #843):
**Reset N finished agents**, under the plates, present only while at least one
agent there is safe to reset. "Safe" is one rule in `shared/fresh-chats.ts`,
read by the page and again by `POST api/agents/fresh-chats` at the press: ready,
idle, a reading above 0%, the recap summarizer's FINISHED verdict, and nothing
on the records that comes back to it — no open proposal (drafts included), no
running background job, no session-limit stop, no live note claim. The verdict
is the summarizer's `"finished"` key, a literal `true` only, stored as
`workFinishedAt`; it counts only while newer than `lastTurnEndedAt`, so a summary
that failed never lets the previous turn's verdict speak for the next. A
mid-turn checkpoint never writes it, and a turn that cleared the chat clears it.
Each agent still safe is sent the same literal `reset chat`; the rest come back
by name with the reason and are sent nothing.

Claude reports the size of each prompt in its `assistant` events, so the number
is free: the harness keeps the last one. **Codex does not** — and its
`turn.completed.usage` must not be used for this. That `usage` is a RUNNING
TOTAL for the whole thread, not for the turn and not for the request. Measured
against codex-cli 0.148.0 with a stub model provider (2026-08-19):

| turn | model requests, prompt tokens | `turn.completed.usage.input_tokens` |
| --- | --- | --- |
| 1 | 1,000 then 2,000 | 3,000 |
| 2 (resume) | 1,000 | 4,000 |

So the fill comes from the CLI's own rollout file instead
(`backend/src/agent/codex/codex-context.ts`). Codex writes a `token_count`
event per model request into
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<thread-id>.jsonl`, carrying
`last_token_usage` (that one request), `total_token_usage` (the running total
above) and `model_context_window`. The harness reads the LAST such line over
SSH after the reply has been delivered, so the round trip is off the path the
user waits on and any failure costs a measurement rather than a turn. A resumed
thread appends to the same rollout file, so the last line is always the latest
turn.

The window is stored alongside the tokens because Codex states one and it is
SMALLER than its own catalog says — 258,400 against gpt-5.6-terra's 272,000,
the CLI holding back room for the reply. A stated window beats a table here
that would go stale the moment OpenAI ships a model, so Codex readings need no
entry in `HARNESS_CONTEXT_WINDOWS`; a reading with no stated window falls back
to the model lookup, which is how Claude's continue to resolve.

A double-count this shape used to live here: `turn.completed.usage` is
thread-cumulative, and the pool's spend attribution billed credentials from
it, re-billing a long thread's whole history every turn. It was fixed on
2026-08-19 by billing the difference against a stored per-agent thread total
(`codexTurnUsageSince`), and made moot the same day: the pool tracks no cost
at all, so the pricing and the stored totals went together (see
docs/dedicated-credentials-and-limbo.md).

## Current Limitations

- Harness turns currently pass only `UserInputPayload.content` to the CLI.
  Telegram attachment metadata is persisted, but images and files are not yet
  materialized into the CLI prompt or workspace by these harness runners.
- Telegram does not run autonomous intuition, cadence, reminder, or sidecar
  model turns. Child-session completion notifications are delivered directly.
- A single CLI attempt has a 30-minute deadline. A missing local resume target
  can cause one additional fresh attempt for the same message.
- The user's Codex or Claude subscription pays for CLI inference. The platform
  itself is free and does not meter or bill usage. A connected harness turn
  should not consume built-in model tokens.

## Errors, Recovery, and Security

Harness execution failures use `NonRecoverableAgentError`. BackgroundRunner
persists the error without `lastErrorType: generic`, so the generic session
recovery coordinator does not restart the failed Telegram session with the
default model. The user can send a fresh message to retry the selected harness.

Known runtime secrets, including Claude OAuth tokens, must be
removed from PTY transcripts before logging error tails or timeout diagnostics.
The SSH shell echoes the full command, so redacting only the structured "turn
start" log is insufficient.

If a raw token ever appears in logs, session history, a copied transcript, or a
chat message, treat it as compromised: revoke it, create a replacement, and
reconnect the harness. Redaction prevents future disclosure; it does not make an
already exposed token safe.

## Reading Production Logs

A normal Claude start resembles:

```text
turn start ... hasToken=true outputPath=/tmp/infinite-agents-harness-turn-...
terminal started ... status=running
claude session id captured ...
delivering assistant text ...
turn finished ... exitCode=0 delivered=1 linesConsumed=3
```

Use these signals:

| Signal | Interpretation |
| --- | --- |
| `linesConsumed: 0` for a long time | CLI is blocked before its first JSONL event, output redirection failed, or the wrong file/user is being read |
| `Permission denied` opening the JSONL path | Output path ownership/permissions problem; Claude or Codex did not start |
| `hasToken: false` on first Claude turn | No stored OAuth token; check connection state or credentials-file fallback |
| `resume: true`, followed by missing conversation | VM lost the stored CLI conversation; harness should retry once fresh |
| `delivered > 0` but terminal remains running | Supervising shell did not exit or the CLI still has work/open handles |
| Controller-model token logs after a harness error | Incorrect generic recovery or routing fallback; harness errors must remain non-recoverable |

## Debugging Checklist

1. Confirm the profile selects the CLI and has a matching
   `connectedHarnesses` timestamp and `harnessServers` record.
2. Confirm the Telegram session's `sandboxId` matches that recorded server.
3. Confirm logs show `sshUser: "agent"`, `cwd: "/home/agent"`, and for Claude
   `hasToken: true` unless credentials-file auth is intentionally used.
4. Confirm the output path is directly under `/tmp` with the
   `infinite-agents-harness-turn-` prefix.
5. If `linesConsumed` remains zero, inspect the bounded stderr tail and the
   output file size. The CLI has not produced a parseable event yet.
6. If events exist but no Telegram message arrives, inspect event parsing,
   session history, and `notifyAssistantResponse` rather than authentication.
7. Check `claudeSessionId` or `codexThreadId`. A null id after repeated attempts
   means no successful initial event was parsed.
8. Never paste raw credentials into an issue, PR, log excerpt, or session
   reconstruction.

## Key Files

| File | Responsibility |
| --- | --- |
| `backend/src/services/agent-service.ts` | Harness selection, setup handoff, server pinning, direct Telegram delivery |
| `backend/src/agent/background-runner.ts` | Loop execution, queueing, interruption, loop identity, error persistence |
| `backend/src/agent/claude/claude-harness.ts` | Claude command, auth injection, JSONL parsing, resume behavior |
| `backend/src/agent/claude/claude-login.ts` | Claude token validation, storage, credentials fallback |
| `backend/src/agent/codex/codex-harness.ts` | Codex command, JSONL parsing, resume behavior |
| `backend/src/agent/codex/codex-login.ts` | Codex login status, auth backup and restore |
| `backend/src/agent/codex/codex-context.ts` | Context-window fill, read from the CLI's rollout file |
| `backend/src/agent/opencode/opencode-harness.ts` | OpenCode turn: seat key lease, JSONL parsing, limits, session resume |
| `backend/src/agent/opencode/opencode-command.ts` | OpenCode command, its environment, and the limit plugin |
| `backend/src/agent/opencode/opencode-key.ts` | OpenCode key's live check at sign-in |
| `backend/src/agent/harness-turn-output.ts` | Per-turn file path, headless wrapper, polling, cleanup, secret redaction |
| `backend/src/agent/telegram-setup-system-prompt.ts` | Setup-agent connection procedure |

Focused tests live in:

- `backend/src/test/unit/claude-harness.test.ts`
- `backend/src/test/unit/codex-harness.test.ts`
- `backend/src/test/unit/codex-context.test.ts`
- `backend/src/test/unit/harness-turn-output.test.ts`
- `backend/src/test/unit/background-runner-loopfn.test.ts`
- `backend/src/test/unit/agent-service.test.ts`
