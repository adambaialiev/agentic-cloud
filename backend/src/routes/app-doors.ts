import type { Request, Response, Router } from 'express';
import { isAdminAccount } from '../config/access.js';
import { APP_MAIL_ALLOWANCE, appCredentialFrom, appReturnTo, appSiteName, type AppCredentialRecord, type AppDoors } from '../services/app-doors.js';
import { MailOutboxError } from '../services/mail-outbox.js';
import { MailSendError } from '../services/mail-sender.js';
import type { UserProfileDocument } from '../types/user.js';
import type { RouteDeps } from './deps.js';

/**
 * A workplace app's doors (note #1178; services/app-doors.ts says what they
 * are and why they stay in the platform). Mounted on the Workspace router at
 * `/api/apps`, so they answer at `/workspace/api/apps/…`.
 *
 * Every door but the pass door takes a pass or a proof in `Authorization:
 * Bearer`, never a cookie: the app's own SERVER calls them, so no browser
 * crosses origins here and there is no CORS to answer.
 */

/**
 * THE switch (Adam, 13 Nov 2026, note #1178): the doors are built for any
 * workplace's app, and open to the platform operator's account only until he
 * says otherwise. Widening them is this one function.
 */
export function appDoorsOpenFor(profile: Pick<UserProfileDocument, 'roles'> | null | undefined): boolean {
  return isAdminAccount(profile);
}

export interface AppSignedIn {
  userId: string;
  profile: UserProfileDocument;
  session: { sessionId: string; absoluteExpiresAt: string };
}

export interface AppDoorsOptions {
  doors: AppDoors;
  /** The hosting's domain: a site answers at `https://<site>.<appsDomain>`. */
  appsDomain: string;
  loginUrl: string;
  signedIn: (req: Request) => Promise<AppSignedIn | null>;
  /** Is the person's own sign-in this pass was given to still live? */
  sessionLive: (userId: string, sessionId: string) => Promise<boolean>;
  /** The Resend webhook is set, so delivery facts arrive. */
  mailFacts: () => boolean;
}

/** Is this a live site of a workplace this person belongs to? */
export async function appSiteIsTheirs(deps: Pick<RouteDeps, 'deploymentStorage' | 'orgStorage'>, userId: string, site: string): Promise<boolean> {
  const doc = await deps.deploymentStorage?.getByName(site).catch(() => null);
  if (!doc || doc.status !== 'live') return false;
  if (doc.userId === userId) return true;
  if (!doc.orgId || !deps.orgStorage) return false;
  const memberships = await deps.orgStorage.listMembershipsByUser(userId).catch(() => []);
  return memberships.some((one) => one.orgId === doc.orgId);
}

const page = (res: Response, status: number, title: string, body: string) => {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 20px"><h1 style="font-size:20px;font-weight:500">${title}</h1>${body}</body>`);
};

export function registerAppDoors(router: Router, base: string, deps: RouteDeps, opts: AppDoorsOptions) {
  const { doors } = opts;
  const originOf = (site: string) => `https://${site}.${opts.appsDomain}`;

  /** The credential on this request, still good, and its person still allowed. */
  const credential = async (req: Request, res: Response, only?: 'person'): Promise<{ cred: AppCredentialRecord; token: string } | null> => {
    res.setHeader('Cache-Control', 'no-store');
    const refused = (status = 401, error = 'Sign in again: this pass has ended.') => {
      res.status(status).json({ error, code: 'app_pass' });
      return null;
    };
    if (deps.privateCopy) { res.status(404).json({ error: 'There are no app doors here.' }); return null; }
    const token = appCredentialFrom(req.get('authorization'));
    const cred = await doors.read(token);
    if (!cred || !token) return refused();
    if (cred.kind === 'person' && !(cred.sessionId && await opts.sessionLive(cred.userId, cred.sessionId))) {
      await doors.end(token).catch(() => undefined);
      return refused();
    }
    const profile = await deps.userStorage?.getProfile(cred.userId).catch(() => null);
    if (!appDoorsOpenFor(profile)) return refused(403, 'These doors are not open to this account.');
    if (only === 'person' && cred.kind !== 'person') return refused(403, 'Only the person, signed in, can do this; an agent cannot.');
    return { cred, token };
  };

  /**
   * The pass door: the site sends the person here with a top-level visit;
   * signed in, they go straight back with a fresh pass in the address's
   * FRAGMENT, which no server, log or Referer sees.
   */
  router.get(`${base}/pass`, async (req, res) => {
    if (deps.privateCopy) return page(res, 404, 'Nothing here', '');
    const site = appSiteName(req.query.site);
    if (!site) return page(res, 400, 'Which site?', '<p>The site sending you here did not say its name.</p>');
    const back = appReturnTo(req.query.return, originOf(site));
    if (!back) return page(res, 400, 'Not that site', '<p>A pass is only ever sent back to the site it is for.</p>');
    const who = await opts.signedIn(req);
    if (!who) {
      return page(res, 401, 'Sign in to Agentic Cloud first',
        `<p>This site uses your Agentic Cloud sign-in. <a href="${opts.loginUrl}">Sign in</a>, then go back to <a href="${originOf(site)}/">${site}</a> and press Sign in again.</p>`);
    }
    if (!appDoorsOpenFor(who.profile) || !(await appSiteIsTheirs(deps, who.userId, site))) {
      return page(res, 403, 'Not yours to open', '<p>Only the people of the workplace that runs this site can sign in to it.</p>');
    }
    try {
      const pass = await doors.mintPass(who.userId, site, who.session);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(303, `${back}#pass=${encodeURIComponent(pass.token)}&until=${encodeURIComponent(pass.expiresAt)}`);
    } catch (error) {
      console.warn('[apps] a pass could not be made:', error instanceof Error ? error.message : error);
      return page(res, 503, 'Try again', '<p>The pass could not be made. Go back and press Sign in again.</p>');
    }
  });

  /** Sign out: this pass ends now. */
  router.post(`${base}/pass/end`, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    await doors.end(appCredentialFrom(req.get('authorization'))).catch(() => undefined);
    return res.status(204).end();
  });

  /** Who this pass or proof is: how a site checks one. */
  router.get(`${base}/me`, async (req, res) => {
    const open = await credential(req, res);
    if (!open) return;
    const { cred } = open;
    const profile = await deps.userStorage?.getProfile(cred.userId).catch(() => null);
    const name = [profile?.person?.firstName, profile?.person?.lastName].filter(Boolean).join(' ').trim();
    return res.json({
      kind: cred.kind, site: cred.site, userId: cred.userId, name,
      agent: cred.kind === 'agent' ? { id: cred.agentId, name: cred.agentName } : null,
      expiresAt: cred.expiresAt,
    });
  });

  const mailFailed = (res: Response, error: unknown) => {
    if (error instanceof MailOutboxError) {
      const status = error.code === 'too_many' ? 429 : error.code === 'no_mailbox' || error.code === 'not_replyable' ? 409 : error.code === 'no_such_message' ? 404 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    if (error instanceof MailSendError) return res.status(502).json({ error: `The mail service refused it: ${error.message}. Nothing was sent.` });
    console.warn('[apps] a send failed:', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'The send failed. Try again.' });
  };
  const sending = new Set<string>();

  /**
   * Send as the person, from their own mailbox, on their press: a pass only.
   * `{ to, subject, text }` starts a letter; `{ followUpOf, text }` writes
   * again in the thread of a letter THIS site sent.
   */
  router.post(`${base}/mail/send`, async (req, res) => {
    const open = await credential(req, res, 'person');
    if (!open) return;
    const { cred } = open;
    const outbox = deps.mailOutbox;
    if (!outbox) return res.status(503).json({ error: 'Sending is not available on this backend yet.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'There are no words to send.' });
    const followUpOf = typeof body.followUpOf === 'string' ? body.followUpOf : null;
    const key = `${cred.userId}\u0000${followUpOf ?? String(body.to ?? '').toLowerCase()}`;
    if (sending.has(key)) return res.status(409).json({ error: 'That letter is already on its way.' });
    sending.add(key);
    try {
      const profile = await deps.userStorage?.getProfile(cred.userId).catch(() => null);
      const senderName = [profile?.person?.firstName, profile?.person?.lastName].filter(Boolean).join(' ').trim() || undefined;
      let mail;
      if (followUpOf) {
        if (!(await doors.mailOf(cred.userId, cred.site, followUpOf))) return res.status(404).json({ error: 'This site sent no such letter.' });
        mail = await outbox.followUp({ userId: cred.userId, messageId: followUpOf, text, allowance: APP_MAIL_ALLOWANCE, withHtml: true, ...(senderName ? { senderName } : {}) });
      } else {
        mail = await outbox.send({ userId: cred.userId, to: body.to, subject: body.subject, text, allowance: APP_MAIL_ALLOWANCE, withHtml: true, ...(senderName ? { senderName } : {}) });
      }
      await doors.sent({ userId: cred.userId, site: cred.site, mailId: mail.id, providerId: mail.providerId ?? null, at: mail.receivedAt });
      return res.json({
        mail: { id: mail.id, to: mail.to?.[0]?.address ?? null, subject: mail.subject, text: mail.wrote ?? text, at: mail.receivedAt, providerId: mail.providerId ?? null },
      });
    } catch (error) {
      return mailFailed(res, error);
    } finally {
      sending.delete(key);
    }
  });

  /** A letter this site sent, as it left: a pass only. */
  router.get(`${base}/mail/:id`, async (req, res) => {
    const open = await credential(req, res, 'person');
    if (!open) return;
    const { cred } = open;
    const id = String(req.params.id ?? '');
    const mine = await doors.mailOf(cred.userId, cred.site, id);
    const row = mine ? await deps.mailMessages?.get(cred.userId, id).catch(() => null) : null;
    if (!row || row.direction !== 'sent') return res.status(404).json({ error: 'This site sent no such letter.' });
    return res.json({
      mail: {
        id: row.id, at: row.receivedAt,
        from: row.from?.address ? { address: row.from.address, name: row.from.name?.trim() || null } : null,
        to: row.to?.[0]?.address ?? null, cc: (row.cc ?? []).map((one) => one.address).filter(Boolean),
        subject: row.subject, text: row.text ?? '', wrote: row.wrote ?? null, providerId: row.providerId ?? null,
      },
    });
  });

  /** What happened since `after`: this site's letters' facts, arrivals, guests; and the copies that report in. */
  router.get(`${base}/feed`, async (req, res) => {
    const open = await credential(req, res);
    if (!open) return;
    const { cred } = open;
    const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)) || 0);
    try {
      const feed = await doors.feed(cred.userId, cred.site, after);
      const copies = deps.copyPulses ? (await deps.copyPulses.list()).map((record) => ({
        copyId: record.pulse.copyId, domain: record.pulse.domain, contactEmail: record.pulse.contactEmail, at: record.pulse.sentAt,
      })) : [];
      return res.json({ ...feed, mailFacts: opts.mailFacts(), copies });
    } catch (error) {
      console.warn('[apps] reading the feed failed:', error instanceof Error ? error.message : error);
      return res.status(503).json({ error: 'Reading what happened failed. Try again.' });
    }
  });
}
