# Removing Firestore Agent-Session Mirroring

Status: historical record. The direction below was recorded July 11, 2026;
steps 1–8 landed that day and step 9 was evaluated then — see "Implementation
Notes". Firestore has since been removed from the codebase entirely; see
"Final State" at the end.

This note records why agent-session transcripts and platform-owned scheduled
work should be removed from Firestore. It distinguishes the current
implementation from the intended design so future changes do not accidentally
preserve obsolete dependencies.

## Decision

For connected Telegram Codex and Claude harnesses, the managed VM should be the
source of truth for conversation state. The platform does not need to mirror the
conversation transcript into Firestore, and it does not need a web UI for those
sessions.

Scheduled work should also run on the user's managed VM, using facilities such
as cron, systemd timers, or a CLI-owned mechanism. A central platform worker
should not scan users' Firestore sessions or schedules to decide what to run.

This is an architectural direction, not a description of code that has already
been removed.

## Current Behavior

Production currently selects `FirestoreSessionStorage` whenever Firebase is
configured. Agent sessions are stored at:

```text
users/{userId}/agent_sessions/{sessionId}
```

Messages are stored separately at:

```text
users/{userId}/agent_sessions/{sessionId}/messages/{messageId}
```

The session document contains platform metadata such as status, runtime
context, model, runner state, title, plan state, relay state, and Telegram CLI
continuity identifiers. The message subcollection contains the user and
assistant transcript plus tool-related message data.

When Firebase is unavailable, the backend uses `InMemorySessionStorage`, which
has the same application-facing interface but does not survive a process
restart.

## What the CLI Harness Actually Needs

The connected Telegram harness does not use the Firestore transcript as model
context:

- Codex owns its native conversation files on the managed VM. The platform
  resumes them with `codexThreadId`.
- Claude owns its native conversation files on the managed VM. The platform
  resumes them with `claudeSessionId`.
- The current user message is sent directly to the selected CLI.
- If a saved native conversation no longer exists after a VM rebuild, the
  harness already detects the missing resume target and retries once as a new
  conversation.

Firestore therefore does not contain a complete copy of the provider-native
session. It mirrors the platform transcript and stores the identifier needed to
find the native session on the VM.

## Why the Transcript Existed

The persisted transcript currently supports platform features rather than CLI
inference:

- Rendering conversation history in the web UI.
- Archiving and clearing Telegram transcripts.
- Continuing the restricted setup-agent flow before a CLI is connected.
- Inspecting sessions and child-agent relays.
- Feeding memory, skills, and other sidecars that read prior messages.
- Debugging, auditing, and reconstructing accepted or delivered messages.
- Some crash-recovery and delivery-repair behavior.

The web UI and transcript mirror are not required product features for the
connected Telegram harness. These consumers must either be removed, narrowed,
or redesigned before deleting the storage paths they read.

## Intended Persistent State

Firestore should retain account-level and routing data that the backend truly
owns, including:

- User identity and Telegram profile.
- Selected and connected harness.
- Managed-server association for each harness.
- Per-harness model preference.
- Credential or secret references.
- `codexThreadId` and `claudeSessionId`, unless a reliable VM-side lookup makes
  even these fields unnecessary.
- Minimal Telegram delivery/idempotency state needed to avoid duplicate or lost
  replies across backend restarts.

The continuity identifiers can live in a small Telegram/harness state record;
they do not require a general-purpose persisted agent-session document or a
message subcollection.

Do not remove the continuity identifiers without first providing another
deterministic way to select the correct native CLI conversation. Otherwise a
backend restart will start a new provider conversation even though the native
conversation still exists on the VM.

## Session Persistence to Remove

For connected Telegram CLI turns, stop persisting:

- Incoming user messages to the session `messages` subcollection.
- CLI assistant messages to the session `messages` subcollection.
- Tool, reasoning, title, plan, and runtime fields that exist only to render or
  reconstruct the mirrored session.
- Transcript archives created only for `/clear` or the New chat action.

`/clear` should instead clear the small continuity state so the next turn starts
a new native CLI conversation. It should not need to archive a platform
transcript.

Do not blindly delete `FirestoreSessionStorage` for the whole application.
Non-Telegram agent flows may still depend on it. First isolate the connected
Telegram harness path, then decide whether the remaining non-Telegram product
still exists.

The restricted setup agent is a separate case. If setup must survive backend
restarts, it needs either a small purpose-built setup-state record or continued
temporary session persistence. That requirement does not justify mirroring all
connected CLI conversations.

## Platform Scheduling to Remove

The backend currently contains platform-owned scheduling through:

- `ReminderScheduler`
- `RecurringScheduler`
- `ScheduleWorker`
- Firestore reminder and recurring-schedule records and queries
- Reminder and recurring-schedule tools, MCP tools, prompts, Telegram controls,
  and administration endpoints

Remove these platform features and their Firestore indexes. Scheduled work
should be installed and executed on the managed VM. The platform should not
poll or scan every user's state to drive work.

Moving schedules to the VM changes ownership: provisioning, listing, editing,
cancellation, timezone handling, and execution logs must all use the VM-side
scheduler. Do not keep a second Firestore schedule as a mirror, because that
reintroduces two competing sources of truth.

## Other Firestore Scanners

Removing reminder and recurring-schedule workers does not eliminate every
agent-session scan. `SessionRecoveryCoordinator` also queries persisted running
sessions and completed Telegram relay state to:

- Recover sessions left marked as running after a process interruption.
- Repair missed Telegram child-session relays.

If general Firestore agent sessions are removed, this coordinator must also be
removed or redesigned. Delivery recovery should use a narrow queue or
idempotency record owned by Telegram delivery, not a scan of all agent-session
documents. Native CLI process recovery, if desired, should be based on explicit
VM-side process state rather than mirrored transcript state.

## Suggested Migration Order

1. Define the minimal persisted Telegram harness and delivery-state schema.
2. Move CLI continuity identifiers out of the general agent-session document.
3. Stop writing connected-harness user and assistant transcript messages.
4. Remove or redesign transcript consumers: web history, archives, sidecars,
   inspection, and debugging scripts.
5. Replace platform reminders and recurring schedules with VM-owned scheduling.
6. Remove schedule workers, tools, endpoints, Firestore queries, and indexes.
7. Replace or remove `SessionRecoveryCoordinator` and relay scans.
8. Delete obsolete Telegram agent-session documents and message
   subcollections with an explicit migration after the new path is deployed.
9. Re-evaluate whether any non-Telegram feature still needs
   `FirestoreSessionStorage`; remove it entirely only if no such consumer
   remains.

## Invariants for the New Design

- The managed VM is the single source of truth for native CLI conversations.
- The managed VM is the single source of truth for scheduled work.
- Firestore contains no mirrored connected-harness transcript.
- Firestore contains no mirrored VM schedule.
- Backend restarts do not duplicate a Telegram reply.
- Backend restarts can still locate the intended native CLI conversation, or
  explicitly and predictably start a new one.
- Setup-state persistence, if retained, is purpose-built and does not grow into
  another general transcript store.

## Implementation Notes (July 11, 2026)

What was implemented, in migration order:

1. **Continuity schema (steps 1–2).** `codexThreadId` / `claudeSessionId` moved
   to `telegram.harnessConversations` on the user profile, written through the
   field-scoped `UserStorage.updateTelegramHarnessConversation` so harness
   turns never clobber the rest of the telegram state map. Harness runners
   read the profile record first and fall back to the legacy session-document
   fields, so conversations started before the deploy keep resuming. `/clear`
   clears both.
2. **Transcript writes (step 3).** The Codex and Claude harness runners no
   longer persist user or assistant messages; the Telegram service skips
   persisting incoming user messages when a connected harness handles the
   turn. `/clear` / New chat clear histories and continuity state without
   archiving (main session and sidecars). Setup-agent (not-connected) turns
   still persist their transcript.
3. **Transcript consumers (step 4).** The delivery/memory sidecar starts were
   already dead code on the connected path; skills/emotion sidecars only fire
   from the delivery-sidecar chokepoint, which connected turns bypass. The
   web UI still renders whatever history exists but connected turns no longer
   produce any. Child-session relays into the Telegram session are still
   recorded (they are delivery/idempotency state, not a CLI transcript).
4. **Platform scheduling (steps 5–6).** `ReminderScheduler`,
   `RecurringScheduler`, `ScheduleWorker`, the schedule tools, MCP schedule
   tools, prompts, the `/schedule` command and menu state, admin endpoints,
   Firestore schedule records/queries, and schedule indexes are removed.
   Legacy schedule/reminder history events keep replay support so old
   transcripts still build valid model input.
5. **Recovery (step 7).** `SessionRecoveryCoordinator` and the
   `getRunningSessions` / `getRecoverableSessions` /
   `getRecentCompletedTelegramRelaySessions` scans are removed, along with
   their composite indexes. Per-session relay delivery idempotency
   (claim/complete/release on the direct notification path) is unchanged.
6. **Data deletion (step 8).** `backend/scripts/purge-mirrored-telegram-state.mjs`
   (dry-run by default, `--apply` to delete) removes all platform schedule
   records, deletes mirrored Telegram transcripts for connected-harness users,
   and migrates any legacy continuity ids from session documents into the
   profile record. Run it only after this backend is deployed.

**Step 9 evaluation (updated same day):** all sessions now run through the
connected Claude/Codex CLIs; the platform loop remains only for the
restricted Telegram setup agent. Following that product decision, the web
session product was removed as well: the frontend chat UI, public session
sharing (`/sessions/:publicShareId` and the `public_agent_sessions` index),
the WebSocket agent-session layer, `/api/sessions`, session archives
(storage, the memory-sidecar "dream" archives, admin endpoints and pages),
and the admin session-transcript views. `FirestoreSessionStorage` itself
stays: the setup agent still persists its transcript, child/spawned sessions
and relay idempotency state still live there, and the Telegram session
document still carries status/sandbox/runtime metadata. (As of PR #720 the web
surface is landing-only — the login/admin/monitoring pages have since been
removed.)

**Child sessions and relays (follow-up, same day):** with the web product gone,
the setup agent restricted to server/CLI-setup tools, and the harness exposed
to the CLIs only through the curated MCP tool, nothing could create a
child/spawned session anymore. The child-session machinery was removed:
`createAndStartSpawnedSession`, the session bridge and its five tools
(create/list/observe/message/stop-session), the Telegram relay pipeline
(`maybeRelayAssistantNotification`, relay delivery claims on session
documents, relay repair content builders), and the child-session model
setting. `TelegramRelayState` remains only as a read-only legacy field so
historical session documents still deserialize, and session-relay replay in
model-messages still renders legacy relay events in old transcripts.

**Full-Telegram loop layer (follow-up, same day):** the platform now runs
exactly two Telegram paths — connected users on the CLI harness, unconnected
users on the restricted setup agent. Everything that only served the removed
full-Telegram loop was cut: the `getTelegramTools` inventory (agent
messaging, broadcasts, user search, Telegram file delivery, image
recognition), all four sidecars (delivery, memory, skills, emotion) with
their prompts, tools, and loop modes, the Telegram memory/skills services and
their prompt injection, and the live agent-loop eval harness that exercised
that loop. The platform MCP server was subsequently removed
entirely (it was disabled behind `PLATFORM_MCP_ENABLED` and its only
remaining tool was `set_user_timezone`): the `/mcp` endpoint, registry,
per-turn token minting in both harness runners, and the timezone tool chain
are gone; the CLIs run purely with their native tools. `AgentMessagingService`
remains only for admin user-deletion cleanup of legacy threads, and the
admin memory viewer still displays memory documents users accumulated before
removal.

## Final State (August 9, 2026)

Firestore and Firebase are gone from the repository. The backend persists
everything in one SQLite file on the backend host (`SQLITE_DB_PATH`), media
lives in an S3-compatible store (`MEDIA_S3_*`), and the `firebase-admin`
dependency has been dropped.

Concretely, beyond what the notes above describe:

- Every `Firestore*` storage class was deleted. The remaining implementations
  are `Sqlite*` (the deployment) and `InMemory*` (tests and local dev); with
  `SQLITE_DB_PATH` unset the backend now logs that it is in-memory only.
- `FirestoreSessionStorage` — which step 9 deliberately kept — went with them.
  Its remaining consumers (the setup agent's transcript, relay idempotency
  state, the Telegram session document) are all served by
  `SqliteSessionStorage`.
- `FirebaseMediaStorage` was deleted; `MEDIA_S3_*` is the only media backend,
  and attachments are disabled when it is unconfigured.
- The Firestore `Timestamp` used by persisted documents was replaced by a
  local class (`backend/src/types/timestamp.ts`) with identical semantics, so
  the on-disk encoding is unchanged.
- Firestore-only operator scripts were deleted; the ones still in use
  (`list-users`, `platform-credentials`, `usage-calibration`,
  `machine-usage-report`, `read-agent-conversation`, `harness-cli-versions`)
  now read SQLite and require `SQLITE_DB_PATH`.
- `firebase.json`, `.firebaserc`, `firestore.indexes.json`, the CI
  index-deploy job, and the `pin-cli-versions` workflow (which existed only to
  run a script with Firebase credentials it can no longer use) were removed.
