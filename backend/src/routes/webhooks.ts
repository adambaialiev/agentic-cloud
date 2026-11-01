import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { RouteDeps } from './deps.js';
import { MailIngestError } from '../services/mail-ingest.js';

/** Constant-time bearer check: the secret is compared, never logged. */
function bearerMatches(header: string | undefined, secret: string): boolean {
  const offered = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export function webhookRoutes(deps: RouteDeps): Router {
  const router = Router();

  // The ops bot's inbound half (@ACCOps_bot). Separate from the routes above
  // on purpose: it is internal operator tooling, not a user product channel.
  // It answers a few read-only commands for one chat and nothing else. Always 200 on
  // an ignored update, so a stranger probing the endpoint learns nothing and
  // Telegram does not retry.
  router.post('/telegram-ops', async (req, res) => {
    const ops = deps.opsBotService;
    if (!ops) {
      return res.status(503).json({ error: 'Ops bot is not configured' });
    }
    const secret = deps.opsBotWebhookSecret;
    if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
      return res.status(401).json({ error: 'Unauthorized webhook request' });
    }
    try {
      const outcome = await ops.handleUpdate(req.body);
      return res.json({ ok: true, outcome });
    } catch (error) {
      console.error('[OpsBotWebhook] Failed to process update:', error);
      return res.status(500).json({ error: 'Failed to process ops bot update' });
    }
  });

  // ── Inbound mail (note #509, slice 2) ────────────────────────────────────
  // The two doors Cloudflare's `mail-inbound` Email Worker knocks on, both
  // held by one shared secret. They are the only routes here that decide
  // whether a stranger's message bounces, so the shapes below are load
  // bearing: an explicit answer is a bounce, and every other outcome is an
  // error the Worker turns into a retry rather than a refusal.
  const mailGate = (req: Request, res: Response): boolean => {
    if (!deps.mailIngest || !deps.mailIngestSecret) {
      res.status(503).json({ error: 'Inbound mail is not configured on this backend.' });
      return false;
    }
    if (!bearerMatches(req.get('authorization'), deps.mailIngestSecret)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  /**
   * Does anybody hold this address? Asked before the Worker streams a
   * message, so a stranger who mistyped a name is refused at the door
   * instead of after 25 MiB.
   *
   * `deliverable: false` is the ONLY answer that bounces. A 404 here means
   * this backend is older than the Worker, not that the address is free.
   */
  router.get('/mail/address', async (req, res) => {
    if (!mailGate(req, res)) return;
    try {
      return res.json(await deps.mailIngest!.deliverable(req.query.to));
    } catch (error) {
      console.error('[MailInbound] address lookup failed:', error);
      return res.status(503).json({ error: 'Address lookup failed' });
    }
  });

  /**
   * One message, as the bytes the sender sent. The envelope rides in headers
   * because the body is the message itself: `x-mail-to` is the RCPT TO whose
   * mailbox this lands in, and `x-mail-from` the MAIL FROM a bounce would go
   * back to — neither is the From header, which is the sender's own claim.
   */
  router.post('/mail/inbound', async (req, res) => {
    if (!mailGate(req, res)) return;
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (!raw) {
      // The raw body parser is mounted in index.ts; anything else here means
      // the request never reached it. Not the sender's fault.
      console.error('[MailInbound] request body was not raw bytes');
      return res.status(503).json({ error: 'Inbound mail is not configured on this backend.' });
    }
    try {
      const result = await deps.mailIngest!.accept({
        to: req.get('x-mail-to'),
        from: req.get('x-mail-from'),
        raw,
      });
      console.log(`[MailInbound] ${result.duplicate ? 'already had' : 'stored'} ${result.id} for ${result.address}`
        + `${result.parseError ? ' (unparsed, raw kept)' : ''}`);
      return res.status(202).json({ stored: true, id: result.id, duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof MailIngestError) {
        const status = error.code === 'unknown_address' ? 404 : error.code === 'too_large' ? 413 : 400;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      // Storage down, media storage down, anything unexpected: this is ours,
      // not the sender's. A 5xx makes the Worker fail the delivery so the
      // sending server tries again later.
      console.error('[MailInbound] delivery failed:', error);
      return res.status(500).json({ error: 'Could not store the message' });
    }
  });

  return router;
}
