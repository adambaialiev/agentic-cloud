import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AppDoors, AppMailEventInput } from '../services/app-doors.js';

/**
 * The mail provider's word on a letter a workplace app sent (notes #1112,
 * #1178): delivered, delayed, bounced, marked as spam, its pictures loaded,
 * refused before it left, or not sent because the address is on the
 * provider's do-not-send list.
 *
 * Resend posts here for every letter the account sends, and signs every post
 * the Svix way: `svix-id`, `svix-timestamp` and `svix-signature` headers, an
 * HMAC-SHA256 over `<id>.<timestamp>.<raw body>` keyed with the endpoint's
 * signing secret (`whsec_` + base64), read from RESEND_WEBHOOK_SECRET. A post
 * that is not signed with it, or is more than five minutes old or early, is
 * refused and changes nothing.
 *
 * Only a letter an app sent is recorded, on that app's feed
 * (AppDoors.noteMailEvent). Everything else is answered 200 and dropped, so
 * the provider does not retry it. A store that fails answers 500, so the
 * provider retries.
 */
export const MAIL_EVENTS = ['delivered', 'delayed', 'bounced', 'spam', 'opened', 'failed', 'suppressed'] as const;
export type MailEvent = (typeof MAIL_EVENTS)[number];

/** Resend's event names, as its webhook sends them, for the ones the platform records. */
export const RESEND_MAIL_EVENTS: Record<string, MailEvent> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'spam',
  'email.opened': 'opened',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};

export const RESEND_WEBHOOK_PATH = '/api/webhooks/resend';
const TOLERANCE_SECONDS = 5 * 60;

/** Is this post signed with the secret, and fresh? The Svix scheme, without its library. */
export function verifySvixSignature(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: Buffer | string, now = new Date()): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now.getTime() / 1000 - seconds) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest();
  // The header may carry several signatures ("v1,<base64> v1,<base64>") while a secret is being rotated.
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** One Resend event, read: null when it is not one the platform records or not of its shape. */
export function readResendEvent(json: unknown, eventId: string): AppMailEventInput | null {
  if (!json || typeof json !== 'object') return null;
  const doc = json as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  const event = typeof doc.type === 'string' ? RESEND_MAIL_EVENTS[doc.type] : undefined;
  const data = doc.data;
  if (!event || !data || typeof data !== 'object') return null;
  const providerId = typeof data.email_id === 'string' ? data.email_id.trim() : '';
  if (!providerId) return null;
  const when = [doc.created_at, data.created_at].find((value) => typeof value === 'string' && Number.isFinite(Date.parse(value))) as string | undefined;
  const to = (Array.isArray(data.to) ? data.to : [data.to]).filter((one): one is string => typeof one === 'string')
    .map((one) => one.replace(/^.*<([^>]+)>\s*$/, '$1').trim());
  const bounce = (data.bounce && typeof data.bounce === 'object' ? data.bounce : {}) as { message?: unknown; type?: unknown; subType?: unknown };
  const failed = (data.failed && typeof data.failed === 'object' ? data.failed : {}) as { reason?: unknown };
  // The provider's own sentence where it gives one ("The address does not exist."), else its kind of bounce.
  const detail = event === 'bounced'
    ? (typeof bounce.message === 'string' && bounce.message.trim() ? bounce.message.trim() : [bounce.type, bounce.subType].filter((one) => typeof one === 'string' && one).join(', '))
    : event === 'failed' && typeof failed.reason === 'string' ? failed.reason : null;
  return {
    eventId,
    event,
    providerId,
    at: new Date(when ?? Date.now()).toISOString(),
    to,
    subject: typeof data.subject === 'string' ? data.subject : '',
    ...(detail ? { detail } : {}),
    // Resend calls a passing bounce (a full mailbox, a server that said "later") Transient.
    ...(event === 'bounced' && typeof bounce.type === 'string' && /transient|temporary|undetermined/i.test(bounce.type) ? { permanent: false } : {}),
  };
}

/** Mount with `express.raw` on RESEND_WEBHOOK_PATH before the JSON parser: the signature is over the exact bytes. */
export function mailEventRoutes(deps: {
  apps: () => Pick<AppDoors, 'noteMailEvent'> | null;
  secret: () => string;
  now?: () => Date;
}): Router {
  const router = Router();
  let unsetSaid = false;
  router.post(RESEND_WEBHOOK_PATH, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const apps = deps.apps();
    if (!apps) return res.status(404).json({ error: 'Nothing here records mail events.' });
    const secret = deps.secret();
    if (!secret) {
      if (!unsetSaid) { unsetSaid = true; console.warn('[mail-events] a Resend event arrived, but RESEND_WEBHOOK_SECRET is not set: nothing is recorded until it is.'); }
      return res.status(503).json({ error: 'Not set up yet.' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const id = req.get('svix-id') ?? req.get('webhook-id');
    const signed = verifySvixSignature(secret, {
      id,
      timestamp: req.get('svix-timestamp') ?? req.get('webhook-timestamp'),
      signature: req.get('svix-signature') ?? req.get('webhook-signature'),
    }, body, deps.now?.() ?? new Date());
    if (!signed) return res.status(401).json({ error: 'Not signed.' });
    let json: unknown;
    try { json = JSON.parse(body.toString('utf8')); } catch { return res.status(400).json({ error: 'Not JSON.' }); }
    const event = readResendEvent(json, id!);
    // Signed, so the wiring works, but not an event the platform records (a click, a send, a domain change).
    if (!event) return res.status(200).json({ recorded: false });
    try {
      const recorded = await apps.noteMailEvent(event);
      if (recorded) console.log(`[mail-events] ${event.event} recorded for an app's letter`);
      return res.status(200).json({ recorded });
    } catch (error) {
      console.warn('[mail-events] a Resend event could not be recorded:', error instanceof Error ? error.message : error);
      return res.status(500).json({ error: 'Not recorded. Try again.' });
    }
  });
  return router;
}
