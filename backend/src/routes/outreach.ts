import type { Request, Response, Router } from 'express';
import { MailOutboxError } from '../services/mail-outbox.js';
import { MailSendError } from '../services/mail-sender.js';
import { OutreachError } from '../services/outreach.js';
import { parseOutreachSeed, type OutreachImportAnswer, type OutreachSendAnswer } from '../shared/outreach.js';
import type { RouteDeps } from './deps.js';

/**
 * Outreach (note #1089): the owner's own screen for cold outreach. Every door
 * here is the platform operator's alone — the account the platform marks as
 * its admin (`roles.admin`), the same gate as the Copies screen. A member of
 * any workplace is refused, and there is no agent door at all: an agent can
 * neither read the targets nor press Send.
 *
 * Nothing here exists in a private copy, and where no store is wired: every
 * door answers 404.
 *
 * The seed is read from a file on a note the owner can open (the import
 * names the note and the file), so the target list — real companies and
 * addresses — lives in the workplace, never in this public repository.
 */
export interface OutreachAuth { userId: string }

export function registerOutreachRoutes<Auth extends OutreachAuth>(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Auth | null>,
  isOperator: (auth: Auth) => Promise<boolean>,
  readNoteFile: (auth: Auth, req: Request, res: Response, note: string, fileName: string) => Promise<Buffer | null>) {
  const gate = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!deps.outreach || deps.privateCopy) { res.status(404).json({ error: 'There is no Outreach here.' }); return null; }
    if (!(await isOperator(auth))) {
      res.status(403).json({ error: "Outreach is the owner's own screen: only he can open it." });
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

  /** Bring the companies and the words in from the seed file on a note (once, and again when note #799 changes). */
  router.post(`${base}/import`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    const note = String(req.body?.note ?? '').replace(/^#/, '').trim();
    const fileName = String(req.body?.file ?? '').trim();
    if (!/^\d{1,9}$/.test(note) || !fileName) return res.status(400).json({ error: 'Name the note and the file on it.' });
    try {
      const bytes = await readNoteFile(open.auth, req, res, note, fileName);
      if (!bytes) return;
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        return res.status(400).json({ error: `${fileName} is not JSON.` });
      }
      const parsed = parseOutreachSeed(json);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      return res.json(await open.outreach.import(open.auth.userId, parsed.seed) satisfies OutreachImportAnswer);
    } catch (error) {
      return failed(res, error, 'The import');
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

  router.post(`${base}/targets/:id/state`, async (req, res) => {
    const open = await gate(req, res);
    if (!open) return;
    try {
      await open.outreach.setState(open.auth.userId, String(req.params.id), req.body?.state);
      return res.json(await open.outreach.detail(open.auth.userId, String(req.params.id)));
    } catch (error) {
      return failed(res, error, 'Changing the state');
    }
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
