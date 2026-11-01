import { raw, type Request, type Response, type Router } from 'express';
import { DRIVE_SINGLE_UPLOAD_MAX_BYTES, type DriveArchiveSummary, type DriveDetail, type DriveListing, type DriveAccess, type DrivePreview } from '../shared/drive.js';
import { DriveError, DriveService, attachmentDisposition, type DriveActor } from '../services/drive-service.js';
import { UPLOAD_PART_BYTES } from '../shared/uploads.js';
import type { RouteDeps } from './deps.js';

/** One chunk onto the wire, waiting for the socket to take it — and failing,
 *  rather than waiting forever, once the reader has gone away. */
function send(res: Response, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) { reject(new Error('The download was closed.')); return; }
    if (res.write(chunk)) { resolve(); return; }
    const done = (error?: Error) => {
      res.off('drain', drained); res.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const drained = () => done();
    const closed = () => done(new Error('The download was closed.'));
    res.once('drain', drained); res.once('close', closed);
  });
}

/** Both doors use the same operations; only their authentication differs. */
export function registerDriveRoutes(router: Router, base: string, deps: RouteDeps,
  authenticate: (req: Request, res: Response) => Promise<DriveActor | null>,
  { allowPermanentDelete = false }: { allowPermanentDelete?: boolean } = {}) {
  type Handler = (req: Request, res: Response, actor: DriveActor, drive: DriveService) => Promise<unknown>;
  const route = (handler: Handler) => async (req: Request, res: Response) => {
    try {
      const actor = await authenticate(req, res);
      if (!actor) return;
      if (!deps.driveStorage || !deps.mediaStorage) return res.status(503).json({ error: 'Drive storage is not available.' });
      return await handler(req, res, actor, new DriveService(deps.driveStorage, deps.mediaStorage));
    } catch (error) {
      if (error instanceof DriveError) return res.status(error.status).json({ error: error.message });
      console.warn('[drive] operation failed');
      return res.status(503).json({ error: 'Drive could not finish that request. Try again.' });
    }
  };
  const parent = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '' || value === 'root') return null;
    if (typeof value !== 'string') throw new DriveError(400, 'Choose a folder.');
    return value;
  };
  router.get(base, route(async (req, res, actor, drive) => {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 255) : '';
    res.json(await drive.list(actor, parent(req.query.parent), req.query.trash === '1', query) satisfies DriveListing);
  }));
  router.post(`${base}/folders`, route(async (req, res, actor, drive) => {
    res.status(201).json({ item: await drive.folder(actor, req.body?.name, parent(req.body?.parentId)) });
  }));
  router.post(`${base}/files`,
    // Run identity/CSRF checks before buffering a potentially large file.
    (req: Request, res: Response, next: (error?: unknown) => void) => { void authenticate(req, res).then((actor) => {
      if (actor) next();
    }).catch(next); },
    raw({ type: 'application/octet-stream', limit: DRIVE_SINGLE_UPLOAD_MAX_BYTES }),
    route(async (req, res, actor, drive) => {
      if (!Buffer.isBuffer(req.body)) throw new DriveError(415, 'Upload the file as application/octet-stream.');
      let name: string;
      try { name = decodeURIComponent(req.get('x-drive-name') ?? ''); }
      catch { throw new DriveError(400, 'The file name could not be read.'); }
      res.status(201).json({ item: await drive.upload(actor, name, parent(req.query.parent), req.body) });
    }),
    (error: { type?: string }, _req: Request, res: Response, next: (error: unknown) => void) => {
      if (error.type === 'entity.too.large') res.status(413).json({ error: 'Send a file over 50 MB in parts.' });
      else next(error);
    });
  // A big file in parts (note #784, `shared/uploads.ts`): start, one request
  // per part, complete — or cancel. Each part is at most 8 MB, which is all
  // this server ever holds of it.
  router.post(`${base}/uploads`, route(async (req, res, actor, drive) => {
    res.status(201).json(await drive.startUpload(actor, req.body?.name, parent(req.body?.parentId), req.body?.sizeBytes));
  }));
  router.put(`${base}/uploads/:id/parts/:part`,
    (req: Request, res: Response, next: (error?: unknown) => void) => { void authenticate(req, res).then((actor) => {
      if (actor) next();
    }).catch(next); },
    raw({ type: () => true, limit: UPLOAD_PART_BYTES }),
    route(async (req, res, actor, drive) => {
      if (!Buffer.isBuffer(req.body)) throw new DriveError(415, 'Send the part as application/octet-stream.');
      res.json(await drive.uploadPart(actor, String(req.params.id), req.query.upload, req.params.part, req.body));
    }),
    (error: { type?: string }, _req: Request, res: Response, next: (error: unknown) => void) => {
      if (error.type === 'entity.too.large') res.status(413).json({ error: 'A part can be up to 8 MB.' });
      else next(error);
    });
  router.post(`${base}/uploads/:id/complete`, route(async (req, res, actor, drive) => {
    res.status(201).json({ item: await drive.completeUpload(actor, String(req.params.id), {
      uploadId: req.body?.uploadId, name: req.body?.name, parentId: parent(req.body?.parentId), parts: req.body?.parts,
    }) });
  }));
  router.delete(`${base}/uploads/:id`, route(async (req, res, actor, drive) => {
    await drive.abortUpload(actor, String(req.params.id), req.query.upload);
    res.json({ ok: true });
  }));
  router.get(`${base}/:id`, route(async (req, res, actor, drive) => {
    res.json(await drive.detail(actor, String(req.params.id)) satisfies DriveDetail);
  }));
  router.get(`${base}/:id/access`, route(async (req, res, actor, drive) => {
    res.json(await drive.access(actor, String(req.params.id), req.query.preview === '1') satisfies DriveAccess);
  }));
  router.get(`${base}/:id/preview`, route(async (req, res, actor, drive) => {
    res.json(await drive.preview(actor, String(req.params.id)) satisfies DrivePreview);
  }));
  // A list row's picture (note #694) and recording (note #698). An <img> or
  // an <audio> follows the redirect with the reader's own session, and the
  // row keeps one address however often the list is redrawn, so the browser
  // may keep the hop for a few minutes. The address being the row's own is
  // also what lets a play start inside the tap: there is no link to ask for
  // first, which a phone would not count as the reader pressing play.
  for (const kind of ['image', 'audio'] as const) router.get(`${base}/:id/${kind}`, route(async (req, res, actor, drive) => {
    const access = await drive.rowMedia(actor, String(req.params.id), kind);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.redirect(302, access.url);
  }));
  // A whole folder as one .zip (note #694); `root` is all of Drive. With
  // `check=1` it answers what the download will be, so a refusal is said on
  // the screen before the browser is sent for the bytes.
  router.get(`${base}/:id/archive`, route(async (req, res, actor, drive) => {
    const id = String(req.params.id);
    const archive = await drive.archive(actor, id === 'root' ? null : id);
    if (req.query.check === '1') {
      return res.json({ fileName: archive.fileName, sizeBytes: archive.sizeBytes, files: archive.files } satisfies DriveArchiveSummary);
    }
    res.status(200).set({ 'Content-Type': 'application/zip', 'Content-Length': String(archive.sizeBytes),
      'Content-Disposition': attachmentDisposition(archive.fileName) });
    if (req.method === 'HEAD') return res.end();
    try {
      await drive.writeArchive(archive, (chunk) => send(res, chunk));
      res.end();
    } catch {
      // The status line is already sent: cutting the connection is the only
      // way left to tell the browser this download did not finish.
      console.warn('[drive] a folder download stopped part-way');
      res.destroy();
    }
  }));
  router.patch(`${base}/:id`, route(async (req, res, actor, drive) => {
    const update = { ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body?.parentId !== undefined ? { parentId: parent(req.body.parentId) } : {}) };
    res.json({ item: await drive.edit(actor, String(req.params.id), update) });
  }));
  router.post(`${base}/:id/trash`, route(async (req, res, actor, drive) => {
    res.json({ item: await drive.trash(actor, String(req.params.id)) });
  }));
  router.post(`${base}/:id/restore`, route(async (req, res, actor, drive) => {
    res.json({ item: await drive.restore(actor, String(req.params.id)) });
  }));
  if (allowPermanentDelete) router.delete(`${base}/:id`, route(async (req, res, actor, drive) => {
    await drive.removeForever(actor, String(req.params.id));
    res.json({ ok: true });
  }));
}
