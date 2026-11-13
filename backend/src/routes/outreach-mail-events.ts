import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { RESEND_OUTREACH_EVENTS } from '../shared/outreach.js';
import type { OutreachMailEventInput, OutreachService } from '../services/outreach.js';
import type { AppDoors } from '../services/app-doors.js';

/**
 * The mail provider's word on the Outreach letters (note #1112; Adam, 9 Nov
 * 2026: "I should see the state whether email was opened, whether link were
 * followed, etc what can we know").
 *
 * Resend posts here when one of the letters is delivered, delayed, bounced,
 * marked as spam or has its pictures loaded. Resend signs every post the Svix
 * way: `svix-id`, `svix-timestamp` and `svix-signature` headers, an
 * HMAC-SHA256 over `<id>.<timestamp>.<raw body>` keyed with the endpoint's
 * signing secret (`whsec_` + base64). The backend reads that secret from
 * RESEND_WEBHOOK_SECRET. A post that is not signed with it, or is more than
 * five minutes old or early, is refused and changes nothing.
 *
 * The provider sends events for every letter the account sends — anybody's
 * mail on our domain, the sign-in links — and only an Outreach letter is
 * recorded (OutreachService.noteMailEvent). Everything else is answered 200
 * and dropped, so the provider does not retry it; nothing about it is kept or
 * logged but a count. A store that fails answers 500, so the provider retries.
 */
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

/** One Resend event, read: null when it is not one Outreach records or not of its shape. */
export function readResendEvent(json: unknown, eventId: string): OutreachMailEventInput | null {
  if (!json || typeof json !== 'object') return null;
  const doc = json as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  const event = typeof doc.type === 'string' ? RESEND_OUTREACH_EVENTS[doc.type] : undefined;
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
export function outreachMailEventRoutes(deps: {
  outreach: () => Pick<OutreachService, 'noteMailEvent' | 'mailHeard'> | null;
  /** A workplace app's letters (note #1178): the same event goes to its feed when an app sent the letter. */
  apps?: () => Pick<AppDoors, 'noteMailEvent'> | null;
  secret: () => string;
  now?: () => Date;
}): Router {
  const router = Router();
  let unsetSaid = false;
  router.post(RESEND_WEBHOOK_PATH, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = deps.outreach();
    const apps = deps.apps?.() ?? null;
    if (!service && !apps) return res.status(404).json({ error: 'There is no Outreach here.' });
    const secret = deps.secret();
    if (!secret) {
      if (!unsetSaid) { unsetSaid = true; console.warn('[outreach] a Resend event arrived, but RESEND_WEBHOOK_SECRET is not set: nothing is recorded until it is.'); }
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
    if (!event) {
      // Signed, so the wiring works, but not an event Outreach records (a click, a send, a domain change).
      service?.mailHeard();
      return res.status(200).json({ recorded: false });
    }
    try {
      const answer = service ? await service.noteMailEvent(event) : { recorded: false };
      if (answer.recorded) console.log(`[outreach] ${event.event} recorded for an Outreach letter`);
      const forApp = apps ? await apps.noteMailEvent(event) : false;
      if (forApp) console.log(`[apps] ${event.event} recorded for an app's letter`);
      return res.status(200).json({ recorded: answer.recorded || forApp });
    } catch (error) {
      console.warn('[outreach] a Resend event could not be recorded:', error instanceof Error ? error.message : error);
      return res.status(500).json({ error: 'Not recorded. Try again.' });
    }
  });
  return router;
}
