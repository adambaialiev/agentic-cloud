# Seat sign-in (org-layer workstream 2)

The self-serve flow that turns a member's own Claude or ChatGPT subscription
into a seat their agents run on. Design contract: the `org-layer-design`
knowledge page. Built 2026-08-22.

## The shape

> **Superseded three times since this was written.** The chat ceremony this
> workstream re-aimed is gone: Claude's `claude setup-token` tmux ceremony was
> replaced 2026-08-23 by the backend acting as its own OAuth client, and the
> setup assistant that drove it was retired 2026-09-04 (note #313, PR #616),
> its loop and tools removed in PR #630/#636. On 2026-09-22 Codex followed
> Claude: the backend makes the device-login requests `codex login
> --device-auth` makes, so no sign-in touches a machine any more. The seat
> rules below still hold — only the ceremony's mechanism changed.

- **The ceremony** is `services/org-seat-signin-flow.ts` (`OrgSeatSignInFlow`),
  driven from the Workspace. Claude: the backend builds a PKCE authorize URL,
  the member approves on claude.ai and pastes the code back, and the backend
  exchanges it for a profile-scoped grant — no machine involved. Codex: the
  backend asks OpenAI for a one-time code (the CLI's own public client and
  requests, `agent/codex/codex-device-login.ts`), the member approves it on
  OpenAI's page, and the screen's poll collects the login and stores the
  auth.json the CLI would have written — no machine involved either. A
  pending Codex ceremony is written down (`SeatSignInStorage`) so a deploy
  does not waste an approval the member already gave.
- **The store** is a member-owned seat row (`services/org-seat-signin.ts` →
  `OrgStorage.addSeat`, auto-selected), written by `addMemberSeat`. A fresh sign-in
  sweeps the member's DEAD seats of that provider (re-auth leaves no grave);
  live seats are never touched. Humans in no org keep the pre-org store
  (secret storage) — dev/self-hosted still works. The seat's secret material
  (`token`, `oauth.refreshToken`) and a pending ceremony's `deviceAuthId` are
  encrypted in the row with `SECRETS_MASTER_KEY`, like secret values
  (`services/seat-credential-cipher.ts`, docs/user-secrets.md).
- **Connectedness is the owner's seat state** for members, not machine
  state: an agent whose owner holds a live seat for its provider connects on
  the spot; the machine holds no credential between turns.

## The doors in

1. **Agent creation** (`startManagedAgentSetup`): owner has a live seat for
   the CLI → connect immediately (unchanged experience). Member without one
   → straight into the ceremony. This is the invite landing: invite link →
   first agent → sign in your own subscription → working coworker.
2. **Turn time** (`onHarnessAuthFailure({reason: 'no_seat'})`): a turn that
   leases nothing pauses the owner's agents of that CLI, stamps
   `oauthPendingAt`, and tells them their next message here starts the
   sign-in — same machinery as expired-auth recovery, with copy that invites
   rather than warns (they never had a session to expire). `NO_SEAT_MESSAGE`
   survives only as the hookless fallback.
3. **Re-auth** (self-healing): harness auth failures already stamp
   `oauthPendingAt`; the ceremony now ends by replacing the dead seat.

## What came back with it

Codex is a full creation choice again everywhere (setup tool enum, menu
tap, Mini App): its ceremony can finish a sign-in wherever it runs, so
`codexCreationUnavailableReason` refuses only the one shape that cannot —
pooled, non-member, empty pool.

## The Workspace flow (second slice, 2026-08-22)

> Historical: the tmux-pane mechanism below is gone for both providers
> (Claude 2026-08-23, Codex 2026-09-22). The screen, routes and phases it
> describes are still the ones in use.

The seats screen's "Sign in a subscription" button is the main door now: a
deterministic state machine (`services/org-seat-signin-flow.ts`) runs the
same CLI ceremony in a tmux pane on one of the member's own machines
(`seat-signin` session, 500-col pane — at 80 cols the OAuth URL wraps and
parses broken), and the screen mirrors it over `/api/org/signin` routes.
No model in the loop; the screen's poll IS the engine (each GET advances
the state machine — nothing runs between requests). Claude: link out,
code pasted into the screen, token live-probed, pane killed the moment
the token appears. Codex: link + one-time code shown, CLI finishes
itself, auth.json read off the machine. Both land through the same
`addMemberSeat`. Flow state is in-memory and resumable from the screen
(reopening picks up the running attempt); a backend restart mid-flow
just means starting again. The chat ceremony remains as the recovery
path behind the no-seat refusal and expired-auth re-stamp.

## Workspace-only (third slice, 2026-08-22 — Owner's call)

Sign-in is Mini-App-only for org members now. Every member-facing door
points at the seats screen instead of starting the chat ceremony:

- A seatless member's new agent waits, unconnected and NOT stamped
  `oauthPendingAt` (that stamp is what routes chat into the ceremony);
  one chat message with the Workspace button says where to sign in.
- The no-seat and expired-auth recoveries pause the agents the same way
  and point at the Workspace, no stamp.
- Onboarding creates the machine and points at the Workspace; no
  assistant drives a sign-in terminal.
- The loop closes from the OTHER side: `OrgSeatSignInFlow.onSeatAdded` →
  `connectTelegramAgentsForSeat` marks the member's waiting agents of
  that provider connected the moment the seat lands (which also fires
  the bot-creation offer for a first agent).

The chat ceremony code (signInOnly mode, `set_claude_oauth_token`, the
compact sign-in prompt) is GONE, not dormant: the setup assistant was
retired in PR #616 and its loop, prompts and tools were removed in PR #630.
`OrgSeatSignInFlow` is the only sign-in path now, for members and for the
dev/self-hosted paths alike.

## Not in this slice

Re-auth push when a seat dies between turns rather than during one.
