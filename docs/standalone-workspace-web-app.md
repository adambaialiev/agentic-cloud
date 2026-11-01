# Standalone Workspace web app — flow and security contract

**Status:** browser-only product; Telegram customer flow retired
**Date:** 2026-09-10

The canonical address is `https://agenticcloudcomputer.com/` (since 2026-09-26; every
`/workspace/…` address is a permanent redirect to its root form, knowledge page
`public-addresses`). The Pages Function in `functions/[[path]].js` proxies every
first path segment the Workspace registry owns, plus `/workspace` itself where the API,
auth doors and assets still live, to the stateful
backend. `WORKSPACE_URL` supplies the trusted origin used for links, cookies,
and CSRF checks. Explicit
`WORKSPACE_COMPATIBLE_ORIGINS` may keep an old API-host session working during
a domain move; request `Host` headers never become trust configuration.

This is the existing Workspace and existing platform identity, not a second
product. Workplace, agent, seat, proposal, note, repository, site,
secret, and chat records remain on their existing `userId` subjects. Historical
type and storage names containing `telegram` are schema debt, not an active
identity or delivery channel.

## Identity and session contract

- A person signs up or returns with a canonical lowercase email address and a
  password. Passwords are stored only as salted scrypt hashes; a failed login
  does not reveal whether the email or password was wrong.
- A new registration is `pending` and receives no session. Its 256-bit random
  confirmation bearer is stored only as a SHA-256 hash, is single-use, and
  expires after **30 minutes**. Issuing a replacement invalidates the previous
  link. The bearer rides in the URL fragment, so it is absent from HTTP access
  logs and asset referrers, and the Workspace removes it from browser history
  before the confirming POST.
- Confirmation delivery uses Resend over HTTPS when `RESEND_API_KEY` is set;
  `WORKSPACE_EMAIL_FROM` selects the sender (default
  `Agentic Cloud Computer <workspace@updates.agenticcloudcomputer.com>`). Without the
  delivery key, new registration fails closed while existing sign-in remains
  available.
- An owner may enable authenticator security in Settings. That optional second
  factor is a six-digit, 30-second TOTP plus one-use recovery codes. It is asked
  only after the password has been verified.
- The email identity, optional encrypted TOTP secret, recovery-code hashes,
  enrollment records, and opaque sessions are held by `WorkspaceWebAuthService`.
- Successful authentication creates an `HttpOnly`, `Secure`, `SameSite=Lax`
  session cookie. A separate readable CSRF cookie must match the
  `X-CSRF-Token` header on every unsafe authenticated request.
- Unsafe requests must also carry the canonical or explicitly compatible
  Workspace origin. A valid cookie without both checks is refused.
- Sessions have idle and absolute expiry, can be listed and revoked
  individually, and can all be revoked from Profile.
- Optional TOTP steps are compare-and-set fenced against replay; recovery codes
  are one-use and shown only once.
- Confirmation resend is limited durably per identity to **one per 60 seconds
  and five per one-hour window**, including the first registration email. The
  public confirmation endpoints also allow **eight writes per source IP per
  ten minutes**. Resend and repeated registration return the same accepted
  shape for missing, pending, verified, malformed, or rate-limited addresses;
  duplicate registration sends only when the supplied password matches the
  pending identity. Public login still uses one scrypt operation for known and
  unknown emails and returns the same invalid-credentials response.

No Workspace API accepts Telegram `initData`, a bot token, a chat id, or a bot
query parameter as identity. `/miniapp` is not mounted.

## Browser flows

### Registration

1. Open `/signup`.
2. Enter an email address and a password of at least ten characters.
3. The account remains outside the Workspace while a single confirmation email
   is sent. Registration returns no session or CSRF cookie.
4. Follow the single-use link, then sign in with the password. Only this
   verified login receives session and CSRF cookies.
5. Authenticator security can be enabled later from Settings; only that
   optional path scans a secret and shows recovery codes.

### Returning sign-in and recovery

`/login` asks for email and password. If that account enabled authenticator
security, the next panel asks for TOTP or a
one-use recovery code before issuing a session. Profile shows the email,
optional authenticator state, and active sessions; the current browser can sign
out itself, other sessions, or every session. A signed-in owner can change the
password by confirming the current one; that revokes every other browser
session. Disabling the optional factor requires a current authenticator code
and removes its recovery codes.

Accounts created before the email switch keep their existing sessions and a
temporary legacy username/TOTP door. Settings lets them attach email while
signed in. Attaching email sends a confirmation without closing that current
session; where a legacy authenticator exists, its old door also remains until
the email is confirmed. The secret then becomes the optional second factor,
and only confirmation closes the standalone legacy door so it cannot bypass
verified email. Password identities that predate ownership verification are
migrated explicitly to `legacy`: their sessions and password login stay valid,
while a nonblocking Workspace prompt asks them to confirm when convenient.

### Workplace invites

Admins mint a single-use, one-week HTTPS link under
`/workspace/invite/<token>`. An unauthenticated visitor sees only whether the
bearer is usable, signs in or registers, then redeems it. Membership and role
come only from platform workplace storage; the link cannot assert them.

### Named navigation

Browser history and refresh-safe routes cover agent chats and decision pages:

- `/workspace/chat/<agentId>`
- `/workspace/agents/<agentId>`
- `/workspace/decisions/pr/<proposalId>`
- `/workspace/decisions/knowledge/<proposalId>`

Every route resolves the record after authentication before rendering it. A
deep link never bypasses ownership, membership, or role checks. (Rooms, and the
room each route resolved, were removed on 30–31 Oct 2026 — note #843; an old
link that still carries `&room=` opens the same record.)

## Notifications and decisions

- Workspace notification records are durable; relevant replies and decisions appear in their
  conversations and decision cards.
- There are no browser (Web Push) notifications: they were retired by note
  #477 after note #331 removed the Profile control. `/workspace/service-worker.js`
  is still served, as a worker that unsubscribes and unregisters the one a
  browser may still hold from before.
- Agent replies, code and knowledge proposals, deployment events, recovery
  failures, and CI-secret requests all write to Workspace-native surfaces.
- Code and knowledge decisions are made in their rendered Workspace screens.
- A CI-secret ask appears on the affected repository screen. It names the
  requested variables but never their values; only the asking agent's owner
  (and, on shared ground, a workplace admin) may allow them or keep them
  private.

## Authorization invariants

1. Platform `userId` owns private agents and sign-ins; an email identity resolves
   to that subject but does not replace it.
2. Platform workplace membership is authoritative. No provider tenant,
   email domain, invite text, or URL grants product access.
3. The active workplace selects context. Record ownership still
   authorizes every read and write.
4. Only the owner of the asking or proposing agent can decide its request.
   Admin status may be additionally required for workplace-wide risk; it
   never permits impersonating another agent's owner.
5. Secret values never ride state payloads, notifications, proposal cards, or
   CI-secret asks.
6. Account data responses are `no-store`; the static application may be
   revalidated by ETag and contains no user data.

## Retired customer paths

The 2026-09-01 cutover removed or disconnected:

- factory-bot and per-agent-bot webhook routes;
- Telegram Mini App signature authentication and the `/miniapp` mount;
- bot menu, webhook synchronization, bot rehydration, and bot creation;
- Telegram account connect, notification, and unlink controls;
- Telegram workplace invite links and agent-chat links;
- Telegram delivery of replies, approval cards, deployment events, recycle
  warnings, and restart notices;
- marketing and legal claims that Telegram is a product access channel.

The internal operations bot at `/api/webhooks/telegram-ops` is deliberately
separate. It is restricted operator tooling for pool status and backup alerts,
uses `TELEGRAM_OPS_*` configuration, and cannot authenticate a customer, open a
Workspace, or route an agent turn.

## Verification checklist

- A new person can register by email, receives no session before confirmation,
  consumes the link once, and then enters without any Telegram account or
  authenticator app.
- A returning person can sign in by email, complete optional authenticator
  security or recovery, list sessions, and revoke them.
- A legacy username/TOTP account can attach email without changing its
  platform `userId`, retains its current access until confirmation, and its
  standalone TOTP can no longer bypass email afterwards.
- Missing, verified, pending, malformed, and rate-limited resend targets have
  the same public response; expired, replaced, and replayed links cannot verify.
- Unsafe API requests without the expected Origin and CSRF token fail closed.
- HTTPS workplace invites survive sign-in and redeem once.
- Agent chat, proposal decisions, CI-secret decisions, and completion alerts
  work entirely in the browser.
- `/miniapp`, `/api/webhooks/telegram`, and
  `/api/webhooks/telegram/<botId>` do not exist.
- No public product CTA points to a bot.
