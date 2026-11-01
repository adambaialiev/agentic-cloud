import { Router, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMiniAppInitData } from '../services/telegram-miniapp-auth.js';
import { agentsMade, lastSeenMs, lastSeenWords, STAGE_LABEL, summarizeRoster } from '../services/ops-bot-service.js';
import { ROSTER_STAGES, type RosterPerson } from '../services/sqlite/sqlite-user-roster.js';
import type { UserProfileDocument } from '../types/user.js';

/**
 * The ops bot's own Mini App: the roster as a real table.
 *
 * WHY IT EXISTS. A Telegram message cannot render a table — a message is text
 * plus a list of ranges (bold from here to here), and the entity list has no
 * table, cell or column in it. `/users` lines characters up in a monospace
 * block, which is as close as a message gets. A Mini App is a web page, so
 * here a table is just a table.
 *
 * WHY IT IS A SEPARATE APP from the Workspace next door. Different bot,
 * different audience, different data: the Workspace shows one account its own
 * agents, and this shows the operator EVERY account. Sharing a page would mean
 * one bug away from showing a customer the platform's roster.
 *
 * WHO CAN OPEN IT. The launch payload has to be signed by the ops bot's token,
 * and the visitor has to be the operator:
 *
 *  - The ops chat is a private chat (a positive id IS that person's user id),
 *    so the check is exact: you are the account the bot reports to.
 *  - If it is ever pointed at a group (a negative id), no single id can be
 *    checked against, so it falls back to requiring the platform admin role.
 *
 * Either way a valid signature alone is not enough — anyone with a bot of
 * their own could sign something; only the operator's id passes.
 */

export interface OpsMiniAppDeps {
  /** The ops bot's token — the only one whose signatures are accepted here. */
  opsBotToken?: string;
  /** The chat the ops bot answers in; a positive id is the operator. */
  opsChatId?: string;
  /** Everyone and how far each got — `readUserRoster`, the same facts /users and list-users.mjs show. */
  roster?: () => Promise<RosterPerson[]>;
  findUserByTelegramUserId?: (telegramUserId: string) => Promise<UserProfileDocument | null>;
  now?: () => Date;
}

const PAGE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'ops-miniapp.html',
);

export function opsMiniAppRoutes(deps: OpsMiniAppDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  // Unauthenticated on purpose, exactly like the Workspace page: the HTML
  // holds no data at all. Every fact on it comes from the call below, which
  // carries the signed launch payload.
  router.get('/', async (_req, res) => {
    try {
      const page = await fs.readFile(PAGE_PATH, 'utf8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(page);
    } catch {
      return res.status(404).json({ error: 'The ops page is not on this backend build' });
    }
  });

  /**
   * Both refusals answer the same way on purpose. "Wrong signature" and "not
   * the operator" are different facts, and which one it was is nobody's
   * business but the operator's.
   */
  const authenticate = async (req: Request, res: Response): Promise<boolean> => {
    if (!deps.opsBotToken || !deps.opsChatId || !deps.roster) {
      res.status(503).json({ error: 'The ops app is not configured on this backend' });
      return false;
    }
    const refuse = () => {
      res.status(401).json({
        error: 'This page only opens from the ops chat button, and only for the operator.',
      });
      return false;
    };

    const initData = (req.get('authorization') ?? '').replace(/^tma\s+/i, '').trim();
    const identity = verifyMiniAppInitData(initData, deps.opsBotToken, now());
    if (!identity) return refuse();

    const chatId = Number(deps.opsChatId);
    if (Number.isFinite(chatId) && chatId > 0) {
      return identity.telegramUserId === chatId ? true : refuse();
    }
    // A group ops chat: no one id to match, so the platform's own admin flag
    // is the gate. No lookup available means no way to check, which is a no.
    const profile = await deps.findUserByTelegramUserId?.(String(identity.telegramUserId));
    return profile?.roles?.admin === true ? true : refuse();
  };

  router.get('/api/roster', async (req, res) => {
    if (!await authenticate(req, res)) return;

    const people = await deps.roster!();
    const summary = summarizeRoster(people);
    // The same roster the text table and list-users.mjs are built from, plus
    // the things a table can do that a monospace block cannot: sort on a real
    // number, open a person's chat, and have room for their email and for the
    // team's own accounts, which the chat leaves out.
    return res.json({
      headline: { total: summary.total, outside: summary.outside },
      tally: summary.standing,
      people: people.map((person) => ({
        userId: person.userId,
        name: person.name,
        ...(person.email ? { email: person.email } : {}),
        ...(person.telegram ? { username: person.telegram.slice(1) } : {}),
        kind: person.kind,
        stage: STAGE_LABEL[person.stage],
        // Funnel order, so sorting the column reads as the funnel does.
        stageRank: ROSTER_STAGES.indexOf(person.stage),
        // Made in all, with the deleted ones said beside it: a person who made
        // six and kept four is not a person who made four.
        agents: agentsMade(person),
        ...(person.agentsDeleted ? { agentsDeleted: person.agentsDeleted } : {}),
        last: lastSeenWords(person, now()),
        lastSeenMs: lastSeenMs(person),
      })),
    });
  });

  return router;
}
