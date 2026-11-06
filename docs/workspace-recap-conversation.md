# Workspace Recap conversation — note #399

> Status (2026-11-06): history. The Home recap card, its microphone and its Conversation link are gone; this conversation became the Chief of Staff's, which is Home itself (note #715; `backend/workspace-ui/src/screens/home/RecapChatScreen.tsx`). The briefing is drawn on no screen since 31 Oct 2026.

The Home recap has a bottom-right microphone and a Conversation link. The microphone opens the existing full-screen recorder; the person reviews the transcript before sending. The registered workplace-scoped `/workspace/recap?org=…` destination retains the conversation and accepts text or voice follow-ups. It uses the shared chat header, viewport, message styling, composer and microphone.

## Dedicated runtime

The first accepted conversation runs on a dedicated assistant machine, reserved atomically per person and workplace. The internal AgentRecord has `purpose: workspace-recap` and a deterministic, globally distinct ID from `workspaceAssistantId(userId, orgId)`. A record is reserved before any cloud resource. Its provisioning marker lets the existing Fly context resolver place it in the correct workplace's cloud account. Creation/rebuild follows that workplace's configured agent machine size. No machine is provisioned without an available personal subscription and a connected workplace cloud.

Infrastructure walks (Fly app ownership, idle reaper, recycler and membership retirement) include the record. Normal agent rosters, ordinary chat, People counts and agentbuilt identity/token delivery exclude it. The Cloud inventory still names and meters the machine as Workspace Recap. It receives neither project files nor workplace secrets nor a general agentbuilt credential. General task dispatch refuses this purpose.

The runtime uses the recap's selected provider/model/effort and leases that person's subscription assigned to that workplace. It serializes model calls per member/org, so a summary refresh cannot replace credentials during a conversation call. Codex auth is written before use and refreshed auth is synced back only if that lease's credentials were actually written. Claude receives the leased token per invocation. Model calls are bounded to three minutes and release their leases. Setup/wake/think phases reach the conversation. Existing idle and recycle policies own the machine's lifetime; active model runs and SSH work protect it from sleep.

After first use, future overview refreshes use this same machine. The private dialogue also enters that person’s overview sources, and completion requests a fresh overview; it never enters another member’s sources. Before first use, existing overviews continue with their current summarizer path; reading Home alone does not create another machine. The conversation and recap are platform records rather than native CLI session files, so replacing the machine does not lose either. The model picker also accepts a person's connected subscription without requiring an ordinary coding agent.

## Capability boundary

The CLI has no native tools. Claude uses `--tools ''`; Codex disables shell, unified exec, patch, subagents, JS, apps, image reads, web search and project instructions. `scripts/verify-workspace-recap-runtime.mjs` captures actual Codex and Claude requests using local fake providers and asserts zero native tools plus a valid final reply. The real model chooses a single JSON action or final reply; the backend validates and executes only the allowlist.

Available actions: list/read/create/update notes, list/read agent metadata, list/read published knowledge, and message the person's own idle agents. Every action rechecks membership, record scope and current ownership after inference. Knowledge has no write operation. Another member's chats are never read. The roster is an explicit non-secret projection rather than serialized AgentRecords.

A note update requires a prior read with a matching body/margin/file fingerprint, same-person authorship and an available atomic note lease. Other members' words, archived notes and notes held by another agent cannot be rewritten. Safe-HTML validation and note-count limits remain in force. Note verbs leave no row in the conversation (note #623) — the reply says what was done; other action receipts (a message sent, an agent stopped) stay as rows. Each requested turn is capped at twelve actions; prompt size is bounded by shedding older context, with the newest request and result retained.

Agent messaging uses the existing own-agent, idle-only Workspace admission path. Working agents are refused, never queued. The platform persists a delivery intent before calling the agent, then stores its acceptance and cursor. A lost acceptance is reported as unconfirmed and is never resent automatically. The recipient's answer is collected into the recap thread when it finishes or when the conversation is next read; later owner messages delimit that response. Text replies link to the agent conversation, where any files remain available.

## Persistence and failure behavior

`org_members.doc.workspaceRecapChat` holds the private transcript, request receipts and pending reply cursors. It is never included in People or workplace serializers. The browser uses an idempotency key for each draft and reuses it when retrying a failed send. One user request runs per member/org; concurrent new requests receive a busy response. Local transcript updates are serialized independently of model execution.

A backend restart leaves a saved running marker. The next read closes it with an interruption message and does not replay side effects. Recorded notes and accepted messages remain in place. Conversations retain the latest 100 messages and 500 request receipts; no native CLI history is the source of truth. Read failures keep the previous screen and retry, while authorization failures clear its private contents. Leaving the workplace retires the dedicated machine along with the member's other agents; retirement of an actively answering Workspace assistant is refused until its call finishes.

## Verification

Focused tests cover note permissions/claims, private history and membership loss, request deduplication, interrupted turns, own-idle dispatch, durable replies, dedicated machine ownership/reuse, subscription gating, wake phases, native tool controls, shared summary execution, SQLite reservations and cross-member IDs. Browser proof uses the real authenticated router and note storage with a fake model and microphone; it exercises record/review/send, note creation, an agent reply, reload and widths 360–1280px. The CLI probe uses a local fake provider without spending a subscription. No production assistant machine is created by these tests; real cloud provisioning and provider inference still require post-deploy verification.
