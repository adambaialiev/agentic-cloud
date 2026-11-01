import type { Request, Response, Router } from 'express';
import { DIRECT_MESSAGE_MAX_LENGTH, DIRECT_MESSAGE_PAGE_SIZE, type DirectMessageInbox, type DirectMessagePage, type DirectMessagePerson } from '../shared/direct-messages.js';
import { DirectMessageConflict } from '../services/direct-message-storage.js';
import { OrgMsgHostOpening, OrgMsgHostUnavailable } from '../services/org-msg-host.js';
import { RateLimiter } from '../services/rate-limiter.js';
import { personDisplayName } from '../types/user.js';
import type { RouteDeps } from './deps.js';

interface Actor { userId: string; orgId: string }
class MessageError extends Error { constructor(readonly status: number, text: string) { super(text); } }

/** Browser sessions only. No agent/CLI door and no admin override. */
export function registerDirectMessageRoutes(router: Router, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<Actor | null>,
  pictureUrl: (path: string | undefined) => Promise<string | undefined>,
) {
  const limiter = new RateLimiter(60, 60_000);
  const person = async (orgId: string, userId: string): Promise<DirectMessagePerson> => {
    const available = Boolean(await deps.orgStorage!.getMembership(orgId, userId));
    // A departed member's current profile is outside this workplace's scope.
    const profile = available ? await deps.userStorage!.getProfile(userId) : null;
    const photoUrl = profile ? await pictureUrl(profile.person?.photo?.storagePath) : null;
    return { userId, name: available ? personDisplayName(profile) : 'Former member', available, ...(photoUrl ? { photoUrl } : {}) };
  };
  const cursor = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
      throw new MessageError(400, 'That message position is not valid.');
    }
    return Number(value);
  };
  type Handler = (req: Request, res: Response, actor: Actor) => Promise<unknown>;
  const route = (fn: Handler) => async (req: Request, res: Response) => {
    try {
      const actor = await authenticate(req, res);
      if (!actor) return;
      if (!deps.directMessageStorage || !deps.orgStorage || !deps.userStorage) return res.status(503).json({ error: 'Messages are not available right now.' });
      return await fn(req, res, actor);
    } catch (err) {
      if (err instanceof MessageError || err instanceof DirectMessageConflict) return res.status(err instanceof MessageError ? err.status : 409).json({ error: err.message });
      // The workplace's messaging machine sleeps when nobody is writing; the
      // first open wakes it (or, once, builds it). Not a fault: the screen
      // says it is opening and asks again.
      if (err instanceof OrgMsgHostOpening) { res.setHeader('Retry-After', '3'); return res.status(503).json({ error: 'Opening messages…', code: 'opening' }); }
      if (err instanceof OrgMsgHostUnavailable) return res.status(503).json({ error: err.message });
      // Never log the request body or an error which might contain private text.
      console.warn('[direct-messages] request failed');
      return res.status(503).json({ error: 'Messages could not be reached. Try again.' });
    }
  };
  const peer = (req: Request, actor: Actor) => {
    const id = String(req.params.userId ?? '');
    if (!id || id === actor.userId) throw new MessageError(404, 'No such conversation.');
    return id;
  };
  router.get('/api/messages', route(async (_req, res, actor) => {
    const rows = await deps.directMessageStorage!.inbox(actor.orgId, actor.userId);
    const threads = await Promise.all(rows.map(async row => ({ person: await person(actor.orgId, row.peerId), lastMessage: row.lastMessage, unread: row.unread })));
    return res.json({ threads, unread: threads.reduce((n, row) => n + row.unread, 0) } satisfies DirectMessageInbox);
  }));
  // The Home badge needs counts, not a periodic read of everyone's private text.
  router.get('/api/messages/unread', route(async (_req, res, actor) => {
    return res.json({ unread: await deps.directMessageStorage!.unread(actor.orgId, actor.userId) });
  }));
  router.get('/api/messages/:userId', route(async (req, res, actor) => {
    const peerId = peer(req, actor);
    const before = cursor(req.query.before), after = cursor(req.query.after);
    if (before && after) throw new MessageError(400, 'Choose one message position.');
    const target = await person(actor.orgId, peerId);
    const org = await deps.orgStorage!.getOrg(actor.orgId);
    if (!org) throw new MessageError(404, 'This workplace no longer exists.');
    if (!target.available && !(await deps.directMessageStorage!.page(actor.orgId, actor.userId, peerId, 1)).messages.length) throw new MessageError(404, 'No such conversation.');
    const page = await deps.directMessageStorage!.page(actor.orgId, actor.userId, peerId, DIRECT_MESSAGE_PAGE_SIZE, before, after);
    return res.json({ orgName: org.name, person: target, viewerId: actor.userId, ...page } satisfies DirectMessagePage);
  }));
  router.post('/api/messages/:userId', route(async (req, res, actor) => {
    const peerId = peer(req, actor);
    if (!await deps.orgStorage!.getMembership(actor.orgId, peerId)) throw new MessageError(404, 'This person is no longer in this workplace.');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const clientId = req.body?.clientId;
    if (!text || text.length > DIRECT_MESSAGE_MAX_LENGTH) throw new MessageError(400, `Write a message of up to ${DIRECT_MESSAGE_MAX_LENGTH.toLocaleString('en-US')} characters.`);
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) throw new MessageError(400, 'This send needs a valid message identifier.');
    if (!limiter.check(`${actor.orgId}:${actor.userId}`)) { res.setHeader('Retry-After', '60'); throw new MessageError(429, 'You are sending quickly. Wait a minute and try again.'); }
    const result = await deps.directMessageStorage!.send(actor.orgId, actor.userId, peerId, text, clientId);
    return res.status(result.created ? 201 : 200).json({ message: result.message });
  }));
  router.post('/api/messages/:userId/read', route(async (req, res, actor) => {
    const peerId = peer(req, actor);
    const through = cursor(req.body?.through);
    if (!through) throw new MessageError(400, 'Choose the last message you read.');
    await deps.directMessageStorage!.readThrough(actor.orgId, actor.userId, peerId, through);
    return res.json({ ok: true });
  }));
}
