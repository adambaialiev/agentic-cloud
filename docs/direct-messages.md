# Direct messages between people (note #383)

> **On again since 29 Oct 2026** (Adam: "Let's bring back direct messages between people"), after being switched off on 2026-09-22 (note #583) while effort went into mail. `DIRECT_MESSAGES_OFFERED = true` in `backend/src/shared/direct-messages.ts` (since note #1090; read by `routes/workspace.ts`), and the state offers Messages only where there can be someone to write to — the team view's rule: invites open (a workplace we mark, or any workplace in a private copy) or a second person already in. The doors: Home's Workplace window, its Messages card (Direct messages beside Mail) under the team; a send mark on each teammate's plate there and on the People page (`ROW_DOOR_ATTR`, read by the row like an agent's face); and the Message button on a teammate's own page. Setting the constant to `false` hides every door again.

One-to-one text conversations live in the Workspace under `/messages?org=…` and `/messages/:userId?org=…`. Home has a workplace-level Messages door, with a live unread count. A teammate's profile has a Message button. The inbox can also start a conversation by choosing a current teammate.

A conversation belongs to one workplace and exactly two humans. The same people in another workplace have a separate history. Every request authenticates a browser session and current workplace membership. A pair is constructed from the authenticated user and the requested peer; there is no caller-supplied sender or thread owner. Administrators have no override, and agents have no API/CLI access to read or send — the one exception (note #1090) is the Chief of Staff's write-only draft, which only the person's own tap sends; see below. Message text never enters shared notes, person recaps, or agent chats.

Messages are plain text (up to 8,000 characters). React renders them as text, preserving newlines without parsing HTML. This version includes no groups, attachments, editing/deletion, typing indicators, or browser push alerts. New replies arrive while the conversation is open; Home and the inbox show unread messages.

## Where the messages live (note #608)

**On one machine per workplace that exists for nothing else, in the cloud account the workplace's machines live in — and nowhere else.** That is its own account when it connected one, otherwise the account that hosts it: ours on the hosted service, the company's own in a private copy (29 Oct 2026; before that a workplace with no account of its own got no Messages). The platform database holds no message text, no senders and no pairs. The owner's rule, 2026-09-21: *a separate machine just for messaging between humans; data stored on that machine only; the Workspace Agent has no access to it.*

- App `iamsg-<orgid12>`, one 256 MB machine (`msg-host`), one 1 GB volume (`msgdata` at `/data`), one SQLite file `/data/messages/messages.db` (mode 0700 directory, unprivileged `msghost` user). Server: `infra/msg-host/msg-host.mjs` (zero dependencies, `node:sqlite`). Image: `infra/msg-host-image/`, built by the `msg-host-image` CI job as `ghcr.io/<owner>/ia-machine-images:msg-host-sha-<12>`; the backend provisions from `FLY_MSG_HOST_IMAGE`, which that job repoints after its smoke test and push with `set-machine-image --msg-host` (note #819). An existing machine is only ever woken on its own image, never rebuilt, so a repoint reaches new workplaces only.
- `OrgMsgHostService` (`backend/src/services/org-msg-host.ts`) builds it lazily the first time anybody opens Messages, in the git host's order: app → volume → secret → machine → healthy → pointer (`org.messages.host`). The account is `OrgFlyService.resolveHostingContext`'s answer; the firewall's one caller is the workplace's own WireGuard peer when it has one, else `FLY_BACKEND_PEER_IP` (our backend's address on our network; in a copy, the backend machine's own address, which the installer sets). A hosted workplace's machine counts in `hostedFootprint` (connecting an own account would strand it) and is destroyed with the workplace (`releaseHostedMachine`, from the deletion purge); one in the workplace's own cloud is left there like its other machines.
- `RemoteDirectMessageStorage` is production's `DirectMessageStorage`. `SqliteDirectMessageStorage` remains for development and tests only, on a throwaway in-memory database.
- The old `direct_messages` / `direct_message_threads` tables were empty in production on 2026-09-21. On boot they are dropped **only while empty**; tables holding anything are left alone and logged.
- **No backups, by the owner's decision.** The platform's nightly database backup no longer contains messages, and nothing of ours copies the volume anywhere (it keeps whatever automatic volume snapshots the cloud provider applies by default, inside the workplace's own account — we neither configure nor read them). Treat a lost volume as lost conversations. `scripts/teardown-org.mjs` destroys the app with the workplace — that IS deleting the messages.

### Who can reach the machine

The backend, and nobody else — not a member's browser, not a member's agent, not the Workspace Agent.

1. **Nothing is published.** No public address, no SSH, and no Fly proxy service either, so there is no flycast address. A proxied port would be dialable by every machine in the workplace's private network (agent machines share it) and would hide the caller's address from the firewall.
2. **Firewall.** The entrypoint's nftables rule accepts the port from `BACKEND_PEER_IP` only — the backend's WireGuard peer in that workplace's network (`org.fly.wireguard.peerIp`; the platform peer for a workplace living in the platform's own Fly org) — and drops every other private-network packet. It **refuses to boot** on a private network without that address, and the service refuses to build a machine it has no peer address for.
3. **Secret.** Every request carries `x-msg-host-secret`, a per-workplace value kept in the ORG secret store (`MSG_HOST_SECRET`), which no agent turn's environment is ever built from (`org-secrets.ts`), plus `x-msg-host-org`, so a secret that leaked across workplaces still opens nothing.
4. **No agent door.** There is no CLI verb and no agent route; `/api/messages` authenticates a browser session and current membership, and builds the pair from the authenticated human. The Chief of Staff's `member message` (note #1090) does not change this: it reaches no part of this machine — the person's tap, a browser request, sends through the same storage as their own Send.

What an agent with root on its own machine can do: nothing — it cannot connect (2), has no secret (3) and holds no cloud token. What a workplace ADMIN with the cloud account's own credentials can do is outside this boundary: it is their account.

### Sleeping and waking

Nothing sits in front of the port, so nothing can stop an idle machine for us: the server exits cleanly after ten minutes without an authorized request (`MSG_HOST_IDLE_MS`), and with restart policy `no` that exit is the machine stopping. Health checks and unauthorized requests do not keep it awake.

`OrgMsgHostService.call` dials straight in while the machine is known warm; otherwise it asks Fly for the state, starts it, waits for `/health`. A request waits up to 8 s for that, then answers `503 { code: 'opening' }` while the wake (or the first build, which pulls the image) carries on in the background, shared by every caller. The screens show a quiet “Opening messages…” status and their three-second poll asks again. Every operation is idempotent — a send carries its client identifier — so the one dial that finds the machine just stopped is repeated safely after the wake.

**Home's unread badge never wakes it.** The one thing the platform keeps is `direct_message_unread (org_id, user_id, unread)`: a bare number per person. The messaging host is the authority — a send answers with the recipient's new total, a receipt with the reader's, the inbox heals both — and the backend only writes the number down. `unread` and `count` (the "does this workplace hold conversations" check) are answered from that table alone. An open conversation polls every three seconds, so the machine stays awake exactly while somebody is looking.

The idle reaper skips `iamsg-*` apps entirely (no SSH to probe; it sleeps by itself), and they are not reported as unclaimed.

## Persistence and delivery

On the messaging host, `messages` stores ordered message IDs, the canonical pair, authenticated sender, text, timestamp, and a client send identifier; `threads` stores the last message and a monotonic read cursor for each participant. There is no workplace column: the machine IS the workplace.

A unique constraint on (pair, sender, client identifier) makes a lost-response retry return the original message. Reusing an identifier with different text is a conflict. The UI keeps the identifier and draft after failure. A confirmed send does not advance the polling cursor: a concurrent incoming message before that send must still be collected.

Reads return 50 messages at a time. Initial/older reads are descending queries reversed for display; `after` reads are ascending, so a backlog is drained without skipping the middle. The transcript polls every three seconds, one request at a time, and pauses while hidden. Older messages preserve scroll position. New arrivals do not move a reader who scrolled up.

GET does not mark messages read. A separate CSRF-protected POST acknowledges a committed visible transcript while the reader is at the bottom. A receipt can only name an existing message in that pair, never a future or foreign cursor. Home's five-second badge reads only the platform's number.

## Membership lifecycle

A removed member immediately loses API access; an open screen drops private rows on the next refused poll. The remaining member can read their old conversation, but cannot send to the departed person. The departed person's current profile is not fetched: the row says Former member. Rejoining with the same account restores access to that workplace's own history. A last-member workplace holding conversations is not considered empty and cannot be deleted through the empty-workplace shortcut.

## The Chief of Staff's draft (note #1090)

Adam, 9 Nov 2026: *"Chief of Staff should be able to send message through agentbuilt cli."* `agentbuilt member message "<name>" "<message>"` (Workspace Agent only; refused in a workplace of one, for a non-member, in an event turn) records a draft in `workspace_message_approvals` (`services/direct-message-approval.ts`) and places a DIRECT MESSAGE card in the person's Chief of Staff conversation. Only the card's *Send message* (`POST /workspace/api/message-approvals/:id/decision`, keyed on the person and the workplace) calls `directMessageStorage.send` — as the person, under a request id starting `via-cos-` (`DIRECT_MESSAGE_VIA_PREFIX`), which the machine already stores and returns, so the "via their Chief of Staff" mark needs no new column or image. The browser's own Send refuses that prefix. Every decision (sent, not sent, expired after 24 h) rewrites the row without the words. The agent's `member message --status <id>` answers a word — waiting, sent, declined, expired, not sent — and nothing reads a conversation. Tests: `direct-message-approval.test.ts`; browser: `scripts/verify-workspace-member-message.mts`.

## Code and verification

- Shared payloads: `backend/src/shared/direct-messages.ts`; both routes are in the existing Workspace route registry.
- Backend endpoints: `backend/src/routes/direct-messages.ts`; wired only by `workspace.ts`.
- Storage: `backend/src/services/remote-direct-message-storage.ts` over `org-msg-host.ts`; the server is `infra/msg-host/msg-host.mjs`. The platform's only table is `direct_message_unread` in `sqlite-db.ts`.
- Screens: `backend/workspace-ui/src/screens/messages/`; Home door: `screens/home/HumanMessages.tsx`.
- The inbox uses the existing conversation rows, plain person names, unread dots, and add row. Its teammate picker reuses People plates and the normal Back control. Messages reuse the agent chat's bubble colors, grouping, day labels, inline clocks, expanding pill input, round Send button, keyboard rules, and newest-message control. There is no separate DM bubble or composer stylesheet.
- Mobile layout shares the agent chat's viewport hook and shell. The hook accepts a composer selector and watches its textarea, preserving the existing browser keyboard behavior.
- `direct-messages.test.ts` runs the router and the remote storage against the REAL `msg-host.mjs` as a child process, one per workplace: authenticated HTTP requests, CSRF, outsider/admin isolation, separate workplaces, receipt boundaries, removal, validation, pagination, a real restart of the host, the secret and workplace refusals, the idle self-stop, that the platform database holds a number and no text, and the empty-only table retirement.
- `org-msg-host.test.ts` covers the build order, the closed machine config (no services, restart `no`, peer-pinned), waking, the shared “opening” state, and the refusals to build without a peer, a cloud or an image.
- `infra/msg-host-image/smoke-test.sh` gates the image in CI.
- `Messages.test.tsx` covers sending/retry, concurrent arrivals, hidden tabs, revoked access, departing peers, workplace changes with a pending response, and the teammate picker.
- `scripts/verify-workspace-direct-messages.mts` drives two independent real browser sessions against the router and SQLite, and records phone/desktop screenshots. Run after building the Workspace UI; output defaults to `/home/agent/dm-proof`.
