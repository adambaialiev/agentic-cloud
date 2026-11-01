/**
 * Inbound mail for agenticcloudcomputer.com (note #509, slice 2).
 *
 * Every address on the domain belongs to one person, and this is what stands
 * between a stranger's message and their inbox. Cloudflare Email Routing
 * hands the whole message here (the zone's catch-all rule points at this
 * script); the Worker asks the backend whether anybody holds the address,
 * then streams the raw bytes to it. Nothing is parsed here — the backend owns
 * the MIME, so this file stays small enough to be obviously correct.
 *
 * THE RULE THAT SHAPES EVERYTHING: only an explicit answer bounces a sender.
 *
 *   `deliverable: false`     → setReject, a permanent SMTP error. Whoever
 *                              mistyped the name finds out immediately, which
 *                              is the whole reason the catch-all is not a
 *                              silent drop.
 *   anything else wrong      → throw. A backend that is down, redeploying or
 *                              older than this Worker must never turn into a
 *                              bounce: a bounce is forever and an outage is
 *                              not. Failing the delivery leaves the message
 *                              with the sending server, which retries.
 *
 * Deploy (manual, like preview-router — see wrangler.toml).
 */

const ADDRESS_LOOKUP_TIMEOUT_MS = 10_000;
const INGEST_TIMEOUT_MS = 60_000;

/** The reason a sender sees when the name they wrote does not exist. */
const NO_SUCH_ADDRESS = 'This address does not exist at agenticcloudcomputer.com';
const TOO_LARGE = 'The message is larger than this mailbox accepts';

function backend(env, path) {
  const origin = (env.BACKEND_ORIGIN || '').replace(/\/$/, '');
  if (!origin) throw new Error('BACKEND_ORIGIN is not configured on this Worker');
  return `${origin}/api/webhooks/mail${path}`;
}

function authorization(env) {
  if (!env.MAIL_INGEST_SECRET) throw new Error('MAIL_INGEST_SECRET is not configured on this Worker');
  return `Bearer ${env.MAIL_INGEST_SECRET}`;
}

export default {
  async email(message, env) {
    const to = String(message.to || '').toLowerCase();

    // 1. Does anybody hold this address? Asked before the body moves, so a
    //    message for a name nobody has costs the sender one round trip
    //    rather than 25 MiB.
    const lookup = await fetch(`${backend(env, '/address')}?to=${encodeURIComponent(to)}`, {
      headers: { authorization: authorization(env) },
      signal: AbortSignal.timeout(ADDRESS_LOOKUP_TIMEOUT_MS),
    });
    if (!lookup.ok) {
      // Includes 404: that means this backend is older than this Worker, NOT
      // that the address is free. Refusing here would bounce everybody's mail
      // during a bad deploy.
      throw new Error(`address lookup answered ${lookup.status}`);
    }
    const answer = await lookup.json();
    if (answer?.deliverable !== true) {
      console.log(`reject ${to}: nobody holds it`);
      message.setReject(NO_SUCH_ADDRESS);
      return;
    }

    // 2. The message itself, as the bytes the sender sent. Streamed rather
    //    than buffered: the parsing, the size ceiling and the storage all
    //    belong to the backend.
    const delivery = await fetch(backend(env, '/inbound'), {
      method: 'POST',
      headers: {
        authorization: authorization(env),
        'content-type': 'message/rfc822',
        'x-mail-to': to,
        'x-mail-from': String(message.from || ''),
        'x-mail-size': String(message.rawSize || 0),
      },
      body: message.raw,
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });

    if (delivery.ok) {
      console.log(`delivered ${to} (${message.rawSize} bytes)`);
      return;
    }
    if (delivery.status === 404) {
      // The address was taken away between the two calls, or never existed.
      // The backend said so in as many words, so this is a refusal.
      console.log(`reject ${to}: backend refused the address`);
      message.setReject(NO_SUCH_ADDRESS);
      return;
    }
    if (delivery.status === 413) {
      message.setReject(TOO_LARGE);
      return;
    }
    // 500s, 503s, a Worker that lost its secret: ours to fix, and the sending
    // server will try again.
    throw new Error(`ingest answered ${delivery.status}`);
  },
};
