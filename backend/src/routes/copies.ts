import type { Request, Response, Router } from 'express';
import { copyDay, copyRow, sortCopies, type WorkspaceCopiesAnswer, type WorkspaceCopyAnswer } from '../shared/copy-pulse.js';
import type { RouteDeps } from './deps.js';

/**
 * The Copies screen's two reads (note #1058): every private copy that has
 * sent us a pulse, one row each, and one copy with its daily history. They
 * are the platform operator's alone — the account the platform marks as its
 * admin (`roles.admin`), and on the agent door that account's agents, as with
 * the radio library and sign-up numbers. Everyone else is refused.
 *
 * Nothing here exists in a private copy itself, which receives no pulses:
 * both doors answer 404 there, and where no store is wired.
 */
export function registerCopiesRoutes<Auth>(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Auth | null>,
  isOperator: (auth: Auth) => Promise<boolean>) {
  const store = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return null;
    if (!deps.copyPulses || deps.privateCopy) { res.status(404).json({ error: 'There are no copies to show here.' }); return null; }
    if (!(await isOperator(auth))) {
      res.status(403).json({ error: "The Copies screen is the platform operator's: only they can open it." });
      return null;
    }
    res.setHeader('Cache-Control', 'no-store');
    return deps.copyPulses;
  };
  const offered = async (): Promise<string[] | null> => (deps.copyReleaseList ? await deps.copyReleaseList().catch(() => null) : null);

  router.get(base, async (req, res) => {
    const copies = await store(req, res);
    if (!copies) return;
    try {
      const [records, releases] = await Promise.all([copies.list(), offered()]);
      const now = new Date();
      return res.json({
        copies: sortCopies(records.map((record) => copyRow(record, releases, now))),
        latestRelease: releases?.at(-1) ?? null,
      } satisfies WorkspaceCopiesAnswer);
    } catch {
      console.warn('[copies] the copies could not be read');
      return res.status(503).json({ error: 'The copies could not be read. Try again.' });
    }
  });

  router.get(`${base}/:copyId`, async (req, res) => {
    const copies = await store(req, res);
    if (!copies) return;
    try {
      const copyId = String(req.params.copyId);
      const record = await copies.get(copyId);
      if (!record) return res.status(404).json({ error: 'No copy by that id has sent a pulse.' });
      const [days, releases] = await Promise.all([copies.days(copyId), offered()]);
      return res.json({
        copy: copyRow(record, releases, new Date()),
        latestRelease: releases?.at(-1) ?? null,
        days: days.map(copyDay),
      } satisfies WorkspaceCopyAnswer);
    } catch {
      console.warn('[copies] a copy could not be read');
      return res.status(503).json({ error: 'The copy could not be read. Try again.' });
    }
  });
}
