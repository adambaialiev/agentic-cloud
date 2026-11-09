import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { MailOutboxError } from '../services/mail-outbox.js';
import { MailSendError } from '../services/mail-sender.js';
import { OutreachError } from '../services/outreach.js';
import { parseOutreachWrite, type OutreachSendAnswer, type OutreachWriteAnswer } from '../shared/outreach.js';
import { outreachPassFrom, outreachReturnTo } from '../services/outreach-pass.js';
import type { RouteDeps } from './deps.js';

/**
 * Outreach (notes #1089, #1093): the routes behind the owner's Outreach SITE.
 * Outreach is not a Workspace screen (Adam, 9 Nov 2026: "Outreach should be
 * site. Not part of workplace."); it is its own site on our hosting, and it
 * reaches these routes from its own origin with a PASS (services/outreach-
 * pass.ts) in `Authorization: Bearer` — never a cookie, so there is no CSRF
 * to forge and the Workspace session cannot reach them either.
 *
 * The pass is the platform operator's alone (`roles.admin`), minted by the
 * pass door below for his live sign-in and only towards the site's origin.
 * No agent can press Send or read a reply, nobody sets a state (it is read
 * off what happened, note #1112), and no secret anywhere can send a letter
 * as him.
 *
 * The words reach the store from his own agents through a separate door
 * (`registerOutreachAgentRoutes`, note #1103) that can write drafts and facts
 * and nothing else. The site reads the store live: there is no import.
 *
 * Nothing here exists in a private copy, and where no store is wired: every
 * door answers 404. The target list — real companies and addresses — lives
 * in the platform's database, never in this public repository.
 */
export interface OutreachAuth { userId: string }

export function registerOutreachRoutes<Auth extends OutreachAuth>(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Auth | null>,
  isOperator: (auth: Auth) => Promise<boolean>) {
  const gate = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!deps.outreach || deps.privateCopy) { res.status(404).json({ error: 'There is no Outreach here.' }); return null; }
    if (!(await isOperator(auth))) {
      res.status(403).json({ error: "Outreach is the owner's own: only he can open it." });
      return null;
    }
    res.setHeader('Cache-Control', 'no-store');
    return { auth, outreach: deps.outreach };
  };
  const failed = (res: Response, error: unknown, what: string) => {
    if (error instanceof OutreachError) return res.status(error.status).json({ error: error.message });
    if (error instanceof MailOutboxError) {
      const status = error.code === 'too_many' ? 429 : error.code === 'no_mailbox' || error.code === 'not_replyable' ? 409 : error.code === 'no_such_message' ? 404 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    if (error instanceof MailSendError) return res.status(502).json({ error: `The mail service refused it: ${error.message}. Nothing was sent.` });
    console.warn(`[outreach] ${what} failed:`, error instanceof Error ? error.message : error);
    return res.status(503).json({ error: `${what} failed. Try again.` });
  };

  router.get(base, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      return res.json(await open.outreach.list(open.auth.userId));
    } catch (error) {
      return failed(res, error, 'Reading Outreach');
    }
  });

  router.get(`${base}/targets/:id`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      const answer = await open.outreach.detail(open.auth.userId, String(req.params.id));
      if (!answer) return res.status(404).json({ error: 'No such company in Outreach.' });
      return res.json(answer);
    } catch (error) {
      return failed(res, error, 'Reading the company');
    }
  });

  router.patch(`${base}/targets/:id`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      await open.outreach.edit(open.auth.userId, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      return res.json(await open.outreach.detail(open.auth.userId, String(req.params.id)));
    } catch (error) {
      return failed(res, error, 'Saving');
    }
  });

  /**
   * There is no door that sets a state any more (note #1112): a state is what
   * happened. A site tab loaded before that change still knows this address,
   * so it hears why rather than a bare 404.
   */
  router.post(`${base}/targets/:id/state`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    return res.status(410).json({ error: 'A state follows what happened now: nothing sets one by hand. Reload the page.' });
  });

  router.post(`${base}/targets/:id/notes`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      await open.outreach.addNote(open.auth.userId, String(req.params.id), req.body?.text);
      return res.status(201).json(await open.outreach.detail(open.auth.userId, String(req.params.id)));
    } catch (error) {
      return failed(res, error, 'Saving the note');
    }
  });

  /** His own first letter: saved as he types (`save`), set aside for the agents' (`take`), kept over an agent's newer draft (`keep`). */
  router.post(`${base}/targets/:id/letter`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      await open.outreach.letter(open.auth.userId, String(req.params.id), { action: req.body?.action, subject: req.body?.subject, text: req.body?.text });
      return res.json(await open.outreach.detail(open.auth.userId, String(req.params.id)));
    } catch (error) {
      return failed(res, error, 'Saving the letter');
    }
  });

  /** The owner's press. The one way a letter leaves from here. */
  router.post(`${base}/targets/:id/send`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      const sent = await open.outreach.send(open.auth.userId, String(req.params.id), {
        step: req.body?.step, subject: req.body?.subject, text: req.body?.text,
      });
      return res.status(201).json(sent satisfies OutreachSendAnswer);
    } catch (error) {
      return failed(res, error, 'Sending');
    }
  });
}

/** An agent, as the agent CLI knows it: whose it is, which it is, and its name. */
export interface OutreachAgentAuth { userId: string; agentId: string; agents: Record<string, { name?: string }> }

/**
 * The agents' door (note #1103): `agentbuilt outreach list | show | set`.
 * Only the platform operator's own agents pass it — the same rule as his
 * other platform verbs (sign-ups, copies, the radio library) — and they write
 * into HIS Outreach, the one his site reads. Anybody else's agent, in any
 * workplace, hears it is not theirs; a private copy has none.
 *
 * What it can do is the whole point: write a company's facts, profile and
 * first letter, and the shared template and follow-ups, signed with the
 * agent's name and the time. It has no route that sends, sets a state, adds
 * a note, edits the owner's own fields or letter, or reads a reply, a note
 * or a sent letter — those exist only behind the owner's pass above.
 */
export function registerOutreachAgentRoutes<Auth extends OutreachAgentAuth>(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Auth | null>,
  isOperator: (auth: Auth) => Promise<boolean>) {
  const gate = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!deps.outreach || deps.privateCopy) { res.status(404).json({ error: 'There is no Outreach here.' }); return null; }
    if (!(await isOperator(auth))) {
      res.status(403).json({ error: "Outreach is the platform operator's own: only his agents can read or write it." });
      return null;
    }
    return { auth, outreach: deps.outreach };
  };
  const failed = (res: Response, error: unknown, what: string) => {
    if (error instanceof OutreachError) return res.status(error.status).json({ error: error.message });
    console.warn(`[outreach] ${what} failed:`, error instanceof Error ? error.message : error);
    return res.status(503).json({ error: `${what} failed. Try again.` });
  };

  router.get(base, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      return res.json({ targets: await open.outreach.agentList(open.auth.userId) });
    } catch (error) {
      return failed(res, error, 'Reading Outreach');
    }
  });

  router.get(`${base}/targets/:id`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      const target = await open.outreach.agentShow(open.auth.userId, String(req.params.id));
      if (!target) return res.status(404).json({ error: `There is no ${String(req.params.id)} in Outreach. \`agentbuilt outreach list\` names every company.` });
      return res.json({ target });
    } catch (error) {
      return failed(res, error, 'Reading the company');
    }
  });

  /** One company, or a batch with the template and follow-ups: the file's JSON is the body. */
  router.post(base, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    const parsed = parseOutreachWrite(req.body);
    if (!parsed.ok) return res.status(400).json({ error: `Nothing was written: ${parsed.error}` });
    const by = { agentId: open.auth.agentId, name: open.auth.agents[open.auth.agentId]?.name?.trim() || 'An agent' };
    try {
      const answer = await open.outreach.write(open.auth.userId, by, parsed.write);
      console.log(`[outreach] ${by.name} (${by.agentId}) wrote: ${answer.added.length} added, ${answer.updated.length} updated, ${answer.unchanged.length} unchanged, ${answer.refused.length} refused, words ${answer.words ?? 'not in it'}`);
      return res.json(answer satisfies OutreachWriteAnswer);
    } catch (error) {
      return failed(res, error, 'The write');
    }
  });
}

/** The site's origin by default; OUTREACH_SITE_ORIGIN overrides it (a test, a rename). */
export const OUTREACH_SITE_ORIGIN_DEFAULT = 'https://outreach.agentbuilt.app';

/**
 * Cross-origin reads and writes from the Outreach site, and from nowhere
 * else: its origin gets the CORS answer (no credentials — the pass travels in
 * a header, never a cookie), and its preflight is answered here, before the
 * platform's own CORS layer, which knows nothing of this origin.
 */
export function outreachSiteCors(siteOrigin: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.origin !== siteOrigin) return next();
    res.setHeader('Access-Control-Allow-Origin', siteOrigin);
    res.setHeader('Vary', 'Origin');
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  };
}

export interface OutreachSignedIn { userId: string; isOperator: boolean; session: { sessionId: string; absoluteExpiresAt: string } }

/**
 * The pass door (note #1093). The site sends the owner here with a top-level
 * navigation; his platform sign-in rides along as it always does. Signed in
 * as the operator, he is sent straight back to the site with a fresh pass in
 * the address's FRAGMENT — which no server, log or Referer ever sees — and
 * the site keeps it in that browser tab's storage. Signed out, he is told to
 * sign in first. Anybody else, and any return address that is not the site,
 * is refused and sent nothing.
 */
export function registerOutreachPassDoor(router: Router, deps: RouteDeps, opts: {
  siteOrigin: string;
  signedIn: (req: Request) => Promise<OutreachSignedIn | null>;
  loginUrl: string;
}) {
  const page = (res: Response, status: number, title: string, body: string) => {
    res.status(status).setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
      + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 20px"><h1 style="font-size:20px;font-weight:500">${title}</h1>${body}</body>`);
  };
  router.get('/api/outreach/pass', async (req, res) => {
    if (!deps.outreach || !deps.outreachPasses || deps.privateCopy) return page(res, 404, 'There is no Outreach here', '');
    const back = outreachReturnTo(req.query.return, opts.siteOrigin);
    if (!back) return page(res, 400, 'Not the Outreach site', '<p>A pass is only ever sent back to the Outreach site.</p>');
    const who = await opts.signedIn(req);
    if (!who) {
      return page(res, 401, 'Sign in to Agentic Cloud first',
        `<p>Outreach uses your Agentic Cloud sign-in. <a href="${opts.loginUrl}">Sign in</a>, then go back to <a href="${opts.siteOrigin}/">Outreach</a> and press Sign in again.</p>`);
    }
    if (!who.isOperator) return page(res, 403, 'Outreach is not yours to open', '<p>Only its owner can open it.</p>');
    try {
      const pass = await deps.outreachPasses.mint(who.userId, who.session);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(303, `${back}#pass=${encodeURIComponent(pass.token)}&until=${encodeURIComponent(pass.expiresAt)}`);
    } catch (error) {
      console.warn('[outreach] a pass could not be made:', error instanceof Error ? error.message : error);
      return page(res, 503, 'Try again', '<p>The pass could not be made. Go back and press Sign in again.</p>');
    }
  });

  /** The site's Sign out: this pass ends now. */
  router.post('/api/outreach/pass/end', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    await deps.outreachPasses?.end(outreachPassFrom(req.get('authorization'))).catch(() => undefined);
    return res.status(204).end();
  });
}
