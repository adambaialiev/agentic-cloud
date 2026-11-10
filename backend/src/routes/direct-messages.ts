import { raw, type Request, type Response, type Router } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  DIRECT_MESSAGE_FILE_MAX_BYTES, DIRECT_MESSAGE_FILES_PER_MESSAGE, DIRECT_MESSAGE_MAX_LENGTH, DIRECT_MESSAGE_PAGE_SIZE,
  DIRECT_MESSAGE_THUMB_MAX_BYTES, DIRECT_MESSAGE_VIA_PREFIX, directMessageFileSize, directMessageImageSize, isDirectMessageImage,
  sniffDirectMessageImage, type DirectMessageApprovalAnswer, type DirectMessageInbox, type DirectMessagePage, type DirectMessagePerson,
} from '../shared/direct-messages.js';
import { visibleDirectMessageApproval } from '../services/direct-message-approval.js';
import { DirectMessageConflict, type DirectMessageUpload } from '../services/direct-message-storage.js';
import { attachmentDisposition } from '../services/drive-service.js';
import { OrgMsgHostOpening, OrgMsgHostRefusal, OrgMsgHostUnavailable } from '../services/org-msg-host.js';
import { RateLimiter } from '../services/rate-limiter.js';
import { personDisplayName } from '../types/user.js';
import type { RouteDeps } from './deps.js';

interface Actor { userId: string; orgId: string }
class MessageError extends Error { constructor(readonly status: number, text: string) { super(text); } }

/** The ids a send names (note #1125): this sender's own uploads, at most ten. */
export function directMessageFileIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > DIRECT_MESSAGE_FILES_PER_MESSAGE
    || value.some((id) => typeof id !== 'string' || !/^f[0-9a-f]{24}$/.test(id)) || new Set(value).size !== value.length) {
    throw new MessageError(400, `A message can carry up to ${DIRECT_MESSAGE_FILES_PER_MESSAGE} files.`);
  }
  return value as string[];
}

/** A name a file may keep: no path, no control characters, at most 255 characters. */
export function directMessageFileName(value: string): string {
  return value.normalize('NFC').replace(/[\x00-\x1f\x7f/\\]/g, '').trim().slice(0, 255) || 'file';
}

/**
 * What the upload is, decided from its bytes (note #1125): a picture only
 * when its first bytes say so, with its size read from its header. Anything
 * else keeps the type its sender claimed — for the list and the icon only:
 * it is never served as anything but a download.
 */
export function describeDirectMessageUpload(bytes: Buffer, name: string, claimed: string | undefined): DirectMessageUpload {
  const sniffed = sniffDirectMessageImage(bytes);
  if (sniffed) return { name, type: sniffed, ...(directMessageImageSize(bytes) ?? {}) };
  const said = String(claimed ?? '').split(';')[0]!.trim().toLowerCase();
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(said) && said.length <= 100 && !isDirectMessageImage({ type: said }) ? said : 'application/octet-stream';
  return { name, type };
}

/** The messaging machine's refusal of an upload or a send, in the person's words. */
export function directMessageFileRefusal(error: unknown): MessageError | null {
  if (!(error instanceof OrgMsgHostRefusal)) return null;
  if (error.status === 507) return new MessageError(507, 'This workplace’s message storage is full, so the file was not sent.');
  if (error.status === 413) return new MessageError(413, `A file can be up to ${directMessageFileSize(DIRECT_MESSAGE_FILE_MAX_BYTES)}.`);
  // A machine still on the server from before files (it moves at its next wake).
  if (error.status === 404 && error.message === 'not found') return new MessageError(503, 'Files are being switched on for these messages. Try again in a minute.');
  if (error.status === 404) return new MessageError(404, 'No such file.');
  if (error.status === 400 && /file/i.test(error.message)) return new MessageError(400, 'A file could not be found. Attach it again.');
  return null;
}

/** Browser sessions only. No agent/CLI door and no admin override — the
 * Chief of Staff's draft (note #1090) is RELEASED here, by the person's own
 * tap on its card, and the agent never reads anything back. */
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
      const refusal = directMessageFileRefusal(err);
      if (refusal) return res.status(refusal.status).json({ error: refusal.message });
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
  // Note #1104: Home drew the Messages card. Start the machine and answer at
  // once — no wait, nothing read, a failure is the next read's to meet.
  // Declared before `/api/messages/:userId`, or "wake" would be a person.
  router.post('/api/messages/wake', route(async (_req, res, actor) => {
    void Promise.resolve(deps.directMessageStorage!.wake?.(actor.orgId)).catch(() => {});
    return res.status(202).json({ ok: true });
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
    const files = directMessageFileIds(req.body?.files);
    if (files.length && !deps.directMessageStorage!.files) throw new MessageError(503, 'Files cannot be sent here.');
    if ((!text && !files.length) || text.length > DIRECT_MESSAGE_MAX_LENGTH) throw new MessageError(400, `Write a message of up to ${DIRECT_MESSAGE_MAX_LENGTH.toLocaleString('en-US')} characters.`);
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) throw new MessageError(400, 'This send needs a valid message identifier.');
    // The Chief of Staff's mark (note #1090) is written by its card's tap alone.
    if (clientId.startsWith(DIRECT_MESSAGE_VIA_PREFIX)) throw new MessageError(400, 'This send needs a valid message identifier.');
    if (!limiter.check(`${actor.orgId}:${actor.userId}`)) { res.setHeader('Retry-After', '60'); throw new MessageError(429, 'You are sending quickly. Wait a minute and try again.'); }
    const result = await deps.directMessageStorage!.send(actor.orgId, actor.userId, peerId, text, clientId, files);
    return res.status(result.created ? 201 : 200).json({ message: result.message });
  }));
  /**
   * Note #1125: one file onto the workplace's messaging machine, unsent —
   * its uploader's alone until a send names it. `?thumbOf=<id>` is a
   * picture's small copy, made by the sender's browser. Identity and the
   * teammate are checked BEFORE the bytes are read.
   */
  const fileLimiter = new RateLimiter(120, 60_000);
  router.post('/api/messages/:userId/files',
    (req: Request, res: Response, next: (error?: unknown) => void) => {
      void route(async (inner, answer, actor) => {
        const peerId = peer(inner, actor);
        if (!deps.directMessageStorage!.files) throw new MessageError(503, 'Files cannot be sent here.');
        if (!await deps.orgStorage!.getMembership(actor.orgId, peerId)) throw new MessageError(404, 'This person is no longer in this workplace.');
        if (!fileLimiter.check(`${actor.orgId}:${actor.userId}`)) { answer.setHeader('Retry-After', '60'); throw new MessageError(429, 'You are sending quickly. Wait a minute and try again.'); }
        (inner as Request & { dmActor?: Actor }).dmActor = actor;
        next();
      })(req, res);
    },
    raw({ type: () => true, limit: DIRECT_MESSAGE_FILE_MAX_BYTES }),
    route(async (req, res) => {
      const actor = (req as Request & { dmActor?: Actor }).dmActor!;
      const peerId = peer(req, actor);
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new MessageError(400, 'That file is empty.');
      const thumbOf = typeof req.query.thumbOf === 'string' ? req.query.thumbOf : undefined;
      let meta: DirectMessageUpload;
      if (thumbOf !== undefined) {
        if (!/^f[0-9a-f]{24}$/.test(thumbOf)) throw new MessageError(400, 'That is not a file of yours.');
        // Always a JPEG, so it is served as one whatever its picture was.
        if (sniffDirectMessageImage(bytes) !== 'image/jpeg' || bytes.length > DIRECT_MESSAGE_THUMB_MAX_BYTES) throw new MessageError(415, 'A small copy is a JPEG picture.');
        meta = { name: 'thumb', type: 'image/jpeg', thumbOf, ...(directMessageImageSize(bytes) ?? {}) };
      } else {
        let name: string;
        try { name = directMessageFileName(decodeURIComponent(req.get('x-file-name') ?? '')); }
        catch { throw new MessageError(400, 'The file name could not be read.'); }
        meta = describeDirectMessageUpload(bytes, name, req.get('x-file-type') ?? req.get('content-type'));
      }
      const file = await deps.directMessageStorage!.files!.upload(actor.orgId, actor.userId, peerId, meta, bytes);
      return res.status(201).json({ file });
    }),
    (error: { type?: string }, _req: Request, res: Response, next: (error: unknown) => void) => {
      if (error.type === 'entity.too.large') res.status(413).json({ error: `A file can be up to ${directMessageFileSize(DIRECT_MESSAGE_FILE_MAX_BYTES)}.` });
      else next(error);
    });
  /**
   * Note #1125: a file's bytes, to either of the pair once sent and to its
   * uploader before. A picture is drawn inline; anything else — and a
   * picture with `?download=1` — is a download, never a page this origin
   * renders. `?thumb=1` is the picture's small copy.
   */
  router.get('/api/messages/:userId/files/:fileId', route(async (req, res, actor) => {
    const peerId = peer(req, actor);
    if (!deps.directMessageStorage!.files) throw new MessageError(404, 'No such file.');
    const fileId = String(req.params.fileId ?? '');
    if (!/^f[0-9a-f]{24}$/.test(fileId)) throw new MessageError(404, 'No such file.');
    const got = await deps.directMessageStorage!.files.read(actor.orgId, actor.userId, peerId, fileId, req.query.thumb === '1');
    if (!got) throw new MessageError(404, 'No such file.');
    const picture = isDirectMessageImage(got.file) && req.query.download !== '1';
    const thumb = req.query.thumb === '1';
    res.status(200);
    res.setHeader('Content-Type', picture ? (thumb ? 'image/jpeg' : got.file.type) : 'application/octet-stream');
    if (got.size) res.setHeader('Content-Length', String(got.size));
    res.setHeader('Content-Disposition', picture ? 'inline' : attachmentDisposition(got.file.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // This browser may keep it a few minutes, as mail's pictures; nothing in front of it may.
    res.setHeader('Cache-Control', 'private, max-age=300');
    const stream = Readable.fromWeb(got.body as unknown as NodeReadableStream<Uint8Array>);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }));
  router.post('/api/messages/:userId/read', route(async (req, res, actor) => {
    const peerId = peer(req, actor);
    const through = cursor(req.body?.through);
    if (!through) throw new MessageError(400, 'Choose the last message you read.');
    await deps.directMessageStorage!.readThrough(actor.orgId, actor.userId, peerId, through);
    return res.json({ ok: true });
  }));
  /**
   * Note #1090: the card in the person's Chief of Staff conversation. A data
   * endpoint for that card, not a screen — and keyed on the person and the
   * workplace the tap comes from, so nobody else's card answers.
   */
  const approvals = () => {
    if (!deps.directMessageApprovals) throw new MessageError(503, 'Messages are not available right now.');
    return deps.directMessageApprovals;
  };
  router.get('/api/message-approvals/:id', route(async (req, res, actor) => {
    const doc = await approvals().get(actor.userId, String(req.params.id ?? ''));
    if (!doc || doc.orgId !== actor.orgId) throw new MessageError(404, 'No such message to approve.');
    return res.json({ approval: visibleDirectMessageApproval(doc) } satisfies DirectMessageApprovalAnswer);
  }));
  router.post('/api/message-approvals/:id/decision', route(async (req, res, actor) => {
    const decision = String((req.body as { decision?: unknown } | undefined)?.decision ?? '');
    if (decision !== 'approve' && decision !== 'reject') throw new MessageError(400, 'Choose Send message or Don’t send.');
    const approval = await approvals().decide({ userId: actor.userId, orgId: actor.orgId, id: String(req.params.id ?? ''), decision });
    if (!approval) throw new MessageError(404, 'No such message to approve.');
    return res.json({ approval } satisfies DirectMessageApprovalAnswer);
  }));
}
