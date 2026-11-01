# `mail-inbound` — the Email Worker behind every address

Note #509, slice 2. Mail addressed to anybody on `agenticcloudcomputer.com`
arrives at Cloudflare Email Routing, which hands the whole message to this
Worker; the Worker asks the backend whether anybody holds the address and
streams the raw bytes to it. The backend parses the MIME, stores the message
and puts the attachments in media storage.

```
sender ──SMTP──▶ Cloudflare Email Routing ──▶ mail-inbound (Worker)
                                                   │  GET  /api/webhooks/mail/address?to=…
                                                   └▶ POST /api/webhooks/mail/inbound
                                                          api.agenticcloudcomputer.com
```

## What a sender actually sees — measured, not assumed

Email Routing runs the Worker **inside the SMTP transaction**, so what this
Worker does is what the sending server is told, immediately (verified against
the live zone on 2026-09-14 with a staging copy of this Worker):

| The Worker | The sending server gets |
|---|---|
| `message.setReject("…")` | `555 5.7.1 <our reason>` — a permanent refusal, at DATA |
| throws | `421 4.3.0 Upstream error` — **temporary**, so the message stays with the sender and is retried |
| returns normally | `250 Ok` |

That table is the whole reason `worker.js` is written the way it is: only an
explicit `deliverable: false` (or a 404 from the ingest route) refuses a
sender. A backend that is down, redeploying, or older than this Worker throws
instead — a bounce is forever, and an outage is not.

## Deploying it

The Worker is deployed by hand, like `preview-router` and the machine images.

```bash
cd infra/mail-inbound
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN npx wrangler@latest deploy
printf '%s' "$SECRET" | CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN \
  npx wrangler@latest secret put MAIL_INGEST_SECRET
```

`MAIL_INGEST_SECRET` is one shared secret with two homes: this Worker, and
`MAIL_INGEST_SECRET=` in `/etc/infinite-agents/backend.env` on `ia-backend`.
The backend accepts exactly one value, so a rotation is: set the new value on
the backend and restart it, then `secret put` the same value here. Deploying
the script alone changes nothing — an Email Worker has no URL and runs only
because a routing rule names it.

**Order matters on the first deploy.** The backend must already be serving
`/api/webhooks/mail/*` before the catch-all is pointed here; otherwise every
lookup 404s, the Worker throws, and every message to the domain is deferred
with a 421 until it is fixed.

## Pointing the zone at it

```bash
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-email-routing.mjs        # show
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-email-routing.mjs --on   # catch-all → this Worker
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-email-routing.mjs --off  # back to disabled + drop
```

`--off` is the rollback, and it is complete: with no catch-all, Email Routing
itself refuses an address that has no rule, which is exactly how the zone
behaved before this existed. The individual address rules are never touched —
`hello@` keeps forwarding to its human — and the script refuses to change
anything if that rule has disappeared, because a zone somebody has been
editing by hand is a zone worth reading before writing to.

## What the rest of the internet does with a forgery

```bash
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-dmarc-policy.mjs              # show
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-dmarc-policy.mjs --quarantine # forgeries → spam
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN node apply-dmarc-policy.mjs --none       # rollback
```

One TXT record, `_dmarc`, and it governs every sender on the domain at once —
the replies (root) and the sign-in links (`updates.`) included. Which is why
tightening runs a preflight first: DMARC passes when SPF **or** DKIM passes
*and aligns with the From domain*, so each sender needs its DKIM key and its
envelope SPF published on this zone. Both Resend senders do. Forwarding
(`hello@` → a human's Gmail) breaks SPF by design and keeps DKIM, which is
enough, so a forwarded address is not in the preflight's list. Loosening is
always safe and is never blocked; only tightening can send our own mail to
spam.

Live on `p=quarantine` since 2026-09-15, with the round trip re-run after the
flip: a reply through the live API and a message from the sign-in sender both
landed `dkim=pass dmarc=pass`.

**It changes nothing about what we receive.** A forgery of our own domain,
sent from an unauthorised machine fifteen minutes after the record changed,
was still accepted by Email Routing and still stamped `dmarc=none` — twice.
The policy is an instruction to *other* receivers; our own inbox is defended
by `looksSuspicious` in `mail-ingest.ts`, which asks whether DKIM signed a
From on our domain and never consults the DMARC verdict.

## Watching it

```bash
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_MAIL_TOKEN npx wrangler@latest tail mail-inbound --format pretty
```

One line per message: `delivered <address> (<bytes>)` or
`reject <address>: …`. The backend's own side is `[MailInbound]` in the
backend log on `ia-backend`.

A Worker version takes a few tens of seconds to reach the email pipeline
after `deploy` — long enough that a message sent immediately afterwards can
still run the previous version. Wait before testing a change.

## Testing it without touching anybody's mail

The end-to-end rehearsal that proved this slice, and the one to repeat when
changing it: deploy a `mail-inbound-staging` copy whose `BACKEND_ORIGIN` is a
development backend, point ONE address rule (not the catch-all) at it, and
send real SMTP to that address — port 25 to `route1.mx.cloudflare.net` is
open from an agent machine, so `smtplib` is enough to be a real sender. Delete
the rule and the staging Worker afterwards; `apply-email-routing.mjs` with no
flag prints the zone so you can see that you did.
