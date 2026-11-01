import { randomUUID } from 'node:crypto';
import {
  DRIVE_ARCHIVE_MAX_BYTES,
  DRIVE_FILE_MAX_BYTES,
  DRIVE_SINGLE_UPLOAD_MAX_BYTES,
  DRIVE_MAX_ITEMS,
  DRIVE_TEXT_PREVIEW_MAX_BYTES,
  drivePreviewKind,
  type DriveItem,
  type DrivePreview,
} from '../shared/drive.js';
import { writeZip, zipLength, type ZipEntry } from './drive-archive.js';
import type { DriveEntries, DriveEntry, DriveStorage } from './drive-storage.js';
import type { MediaStorage } from './media-storage.js';
import { inferContentType } from './session-attachments.js';
import {
  UPLOAD_PART_BYTES, UPLOAD_STALE_AFTER_MS, uploadPartCount, type PartedUploadPart, type PartedUploadStart,
} from '../shared/uploads.js';

/** "1 GB", the way the refusals say the ceiling. */
export const DRIVE_FILE_MAX_WORDS = 'Files can be up to 1 GB.';
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DriveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface DriveActor { orgId: string; userId: string; agentId?: string; canDeleteForever: boolean }
/** A folder's download, planned: what the reader is told, and what is read. */
export interface DriveArchive {
  fileName: string;
  sizeBytes: number;
  files: number;
  entries: (ZipEntry & { storagePath?: string })[];
}
/** RFC 5987 carries Unicode names; the quoted fallback remains valid ASCII. */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function publicDriveItem(entry: DriveEntry): DriveItem {
  const { storagePath: _path, trashRootId: _root, addedByUserId: _user, addedByAgentId: _agent, ...item } = entry;
  return item;
}
function nameOf(value: unknown): string {
  if (typeof value !== 'string') throw new DriveError(400, 'Give the item a name.');
  const name = value.trim().normalize('NFC');
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new DriveError(400, 'Use a name of up to 255 bytes, without slashes or control characters.');
  }
  return name;
}
function find(entries: DriveEntries, id: string): DriveEntry {
  const entry = entries.get(id);
  if (!entry) throw new DriveError(404, 'No such item in this Drive.');
  return entry;
}
function ancestry(entries: DriveEntries, id: string | null): DriveEntry[] {
  const result: DriveEntry[] = [];
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw new DriveError(409, 'This folder cannot be moved inside itself.');
    seen.add(id);
    const entry = find(entries, id);
    result.unshift(entry);
    id = entry.parentId;
  }
  return result;
}
function liveFolder(entries: DriveEntries, id: string | null): DriveEntry | null {
  if (id === null) return null;
  const folder = find(entries, id);
  if (folder.kind !== 'folder' || ancestry(entries, id).some((entry) => entry.trashedAt)) {
    throw new DriveError(409, 'Choose a folder outside Trash.');
  }
  return folder;
}
function availableName(entries: DriveEntries, name: string, parentId: string | null, except?: string) {
  if ([...entries.values()].some((entry) => entry.id !== except && !entry.trashedAt
    && entry.parentId === parentId && entry.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'))) {
    throw new DriveError(409, 'An item with that name is already in this folder. Choose another name.');
  }
}
function subtree(entries: DriveEntries, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entry of entries.values()) if (entry.parentId) {
    children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry.id]);
  }
  const ids = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const next = pending.pop()!;
    if (ids.has(next)) continue;
    ids.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return ids;
}

export class DriveService {
  constructor(private readonly storage: DriveStorage, private readonly media: MediaStorage) {}
  async list(actor: DriveActor, parentId: string | null, trash: boolean, query = '') {
    const entries = await this.storage.read(actor.orgId);
    const folder = trash || query ? null : liveFolder(entries, parentId);
    const all = [...entries.values()];
    const term = query.trim().toLocaleLowerCase('en');
    const items = all.filter((entry) => (trash ? entry.trashRootId === entry.id : !entry.trashedAt)
      && (term ? entry.name.toLocaleLowerCase('en').includes(term) : trash || entry.parentId === parentId));
    items.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      items: items.map(publicDriveItem), folder: folder ? publicDriveItem(folder) : null,
      breadcrumbs: folder ? ancestry(entries, folder.id).map(publicDriveItem) : [],
      totalBytes: all.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      trashCount: all.filter((entry) => entry.trashRootId === entry.id).length,
      canDeleteForever: actor.canDeleteForever, maxFileBytes: DRIVE_FILE_MAX_BYTES,
    };
  }
  async detail(actor: DriveActor, id: string) {
    const entries = await this.storage.read(actor.orgId);
    const entry = find(entries, id);
    return { canDeleteForever: actor.canDeleteForever, item: publicDriveItem(entry), breadcrumbs: ancestry(entries, entry.parentId).map(publicDriveItem) };
  }
  private async insert(actor: DriveActor, entry: DriveEntry) {
    return this.storage.change(actor.orgId, (entries) => {
      liveFolder(entries, entry.parentId);
      availableName(entries, entry.name, entry.parentId);
      if (entries.size >= DRIVE_MAX_ITEMS) throw new DriveError(409, 'This Drive has reached its 10,000 item limit. Clear unneeded items from Trash first.');
      entries.set(entry.id, entry);
      return publicDriveItem(entry);
    });
  }
  private entry(actor: DriveActor, name: unknown, parentId: string | null, kind: 'file' | 'folder'): DriveEntry {
    const now = new Date().toISOString();
    return { id: randomUUID(), name: nameOf(name), parentId, kind, sizeBytes: 0, contentType: '',
      createdAt: now, updatedAt: now, addedByUserId: actor.userId, ...(actor.agentId ? { addedByAgentId: actor.agentId } : {}) };
  }
  async folder(actor: DriveActor, name: unknown, parentId: string | null) {
    return this.insert(actor, this.entry(actor, name, parentId, 'folder'));
  }
  async upload(actor: DriveActor, name: unknown, parentId: string | null, data: Buffer) {
    if (data.length > DRIVE_SINGLE_UPLOAD_MAX_BYTES) throw new DriveError(413, 'Send a file over 50 MB in parts.');
    const entry = this.entry(actor, name, parentId, 'file');
    const entries = await this.storage.read(actor.orgId);
    liveFolder(entries, parentId);
    availableName(entries, entry.name, parentId);
    entry.sizeBytes = data.length;
    entry.contentType = inferContentType(entry.name);
    entry.storagePath = `users/${actor.orgId}/drive/${entry.id}`;
    await this.media.uploadObject({ storagePath: entry.storagePath, contentType: entry.contentType, data });
    try { return await this.insert(actor, entry); }
    catch (error) {
      await this.media.deleteObject?.({ storagePath: entry.storagePath }).catch(() => {});
      throw error;
    }
  }
  // A big file in parts (note #784, `shared/uploads.ts`). Nothing is
  // recorded until `completeUpload`: the parts are invisible in the bucket
  // until stitched, so an upload that never finishes leaves no file — and
  // the next start in this workplace sweeps away any a day old.
  private uploadPath(actor: DriveActor, id: string): string {
    if (!UPLOAD_ID.test(id)) throw new DriveError(404, 'That upload is not here.');
    return `users/${actor.orgId}/drive/${id}`;
  }
  private parted(): Required<Pick<MediaStorage, 'startMultipart' | 'uploadPart' | 'completeMultipart' | 'abortMultipart'>> & Pick<MediaStorage, 'abortStaleMultiparts'> {
    const media = this.media;
    if (!media.startMultipart || !media.uploadPart || !media.completeMultipart || !media.abortMultipart) {
      throw new DriveError(503, 'This Drive cannot take big files yet.');
    }
    return {
      startMultipart: media.startMultipart.bind(media), uploadPart: media.uploadPart.bind(media),
      completeMultipart: media.completeMultipart.bind(media), abortMultipart: media.abortMultipart.bind(media),
      ...(media.abortStaleMultiparts ? { abortStaleMultiparts: media.abortStaleMultiparts.bind(media) } : {}),
    };
  }
  async startUpload(actor: DriveActor, name: unknown, parentId: string | null, sizeBytes: unknown): Promise<PartedUploadStart> {
    const size = Number(sizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0) throw new DriveError(400, 'Say how big the file is.');
    if (size > DRIVE_FILE_MAX_BYTES) throw new DriveError(413, DRIVE_FILE_MAX_WORDS);
    const parted = this.parted();
    const entry = this.entry(actor, name, parentId, 'file');
    const entries = await this.storage.read(actor.orgId);
    liveFolder(entries, parentId);
    availableName(entries, entry.name, parentId);
    const { uploadId } = await parted.startMultipart({ storagePath: this.uploadPath(actor, entry.id), contentType: inferContentType(entry.name) });
    void parted.abortStaleMultiparts?.({
      prefix: `users/${actor.orgId}/drive/`, olderThan: new Date(Date.now() - UPLOAD_STALE_AFTER_MS),
    }).catch(() => 0);
    return { id: entry.id, uploadId, partBytes: UPLOAD_PART_BYTES, parts: uploadPartCount(size) };
  }
  async uploadPart(actor: DriveActor, id: string, uploadId: unknown, partNumber: unknown, data: Buffer): Promise<PartedUploadPart> {
    const number = Number(partNumber);
    if (!Number.isInteger(number) || number < 1 || number > uploadPartCount(DRIVE_FILE_MAX_BYTES)) throw new DriveError(400, 'That part number is not one of this file’s.');
    if (typeof uploadId !== 'string' || !uploadId) throw new DriveError(400, 'Say which upload this part belongs to.');
    if (data.length > UPLOAD_PART_BYTES) throw new DriveError(413, 'A part can be up to 8 MB.');
    const { etag } = await this.parted().uploadPart({ storagePath: this.uploadPath(actor, id), uploadId, partNumber: number, data });
    return { partNumber: number, etag };
  }
  async completeUpload(actor: DriveActor, id: string, body: { uploadId?: unknown; name?: unknown; parentId: string | null; parts?: unknown }) {
    const storagePath = this.uploadPath(actor, id);
    if (typeof body.uploadId !== 'string' || !body.uploadId) throw new DriveError(400, 'Say which upload to finish.');
    const parts = Array.isArray(body.parts) ? body.parts.map((part: { partNumber?: unknown; etag?: unknown }) => ({
      partNumber: Number(part?.partNumber), etag: String(part?.etag ?? ''),
    })) : [];
    if (!parts.length || parts.some((part) => !Number.isInteger(part.partNumber) || !part.etag)) {
      throw new DriveError(400, 'Send the parts this upload was made of.');
    }
    const parted = this.parted();
    const entry = { ...this.entry(actor, body.name, body.parentId, 'file'), id };
    const { sizeBytes } = await parted.completeMultipart({ storagePath, uploadId: body.uploadId, parts });
    if (sizeBytes > DRIVE_FILE_MAX_BYTES) {
      await this.media.deleteObject?.({ storagePath }).catch(() => {});
      throw new DriveError(413, DRIVE_FILE_MAX_WORDS);
    }
    entry.sizeBytes = sizeBytes;
    entry.contentType = inferContentType(entry.name);
    entry.storagePath = storagePath;
    try { return await this.insert(actor, entry); }
    catch (error) {
      await this.media.deleteObject?.({ storagePath }).catch(() => {});
      throw error;
    }
  }
  async abortUpload(actor: DriveActor, id: string, uploadId: unknown): Promise<void> {
    if (typeof uploadId !== 'string' || !uploadId) return;
    await this.parted().abortMultipart({ storagePath: this.uploadPath(actor, id), uploadId }).catch(() => undefined);
  }
  async edit(actor: DriveActor, id: string, update: { name?: unknown; parentId?: string | null }) {
    return this.storage.change(actor.orgId, (entries) => {
      const entry = find(entries, id);
      const name = update.name === undefined ? entry.name : nameOf(update.name);
      const parentId = update.parentId === undefined ? entry.parentId : update.parentId;
      if (entry.trashedAt && entry.trashRootId !== id) throw new DriveError(409, 'Restore the containing folder before renaming this item.');
      if (entry.trashedAt && update.parentId !== undefined) throw new DriveError(409, 'Restore this item before moving it.');
      if (!entry.trashedAt) {
        liveFolder(entries, parentId);
        if (ancestry(entries, parentId).some((parent) => parent.id === id)) {
          throw new DriveError(409, 'A folder cannot be moved inside itself or one of its folders.');
        }
        availableName(entries, name, parentId, id);
      }
      const next = { ...entry, name, parentId, updatedAt: new Date().toISOString() };
      entries.set(id, next);
      return publicDriveItem(next);
    });
  }
  async trash(actor: DriveActor, id: string) {
    return this.storage.change(actor.orgId, (entries) => {
      const entry = find(entries, id);
      if (entry.trashedAt) return publicDriveItem(entry);
      const now = new Date().toISOString();
      for (const childId of subtree(entries, id)) {
        const child = entries.get(childId)!;
        if (!child.trashedAt) entries.set(childId, { ...child, trashedAt: now, trashRootId: id, updatedAt: now });
      }
      return publicDriveItem(entries.get(id)!);
    });
  }
  async restore(actor: DriveActor, id: string) {
    return this.storage.change(actor.orgId, (entries) => {
      const entry = find(entries, id);
      if (!entry.trashedAt) return publicDriveItem(entry);
      if (entry.trashRootId !== id) throw new DriveError(409, 'Restore the folder containing this item first.');
      const parent = entry.parentId ? entries.get(entry.parentId) : null;
      const parentId = parent && !parent.trashedAt ? parent.id : null;
      availableName(entries, entry.name, parentId, id);
      const now = new Date().toISOString();
      for (const child of entries.values()) if (child.trashRootId === id) {
        const { trashedAt: _at, trashRootId: _root, ...live } = child;
        entries.set(child.id, { ...live, parentId: child.id === id ? parentId : child.parentId, updatedAt: now });
      }
      return publicDriveItem(entries.get(id)!);
    });
  }
  async removeForever(actor: DriveActor, id: string) {
    if (!actor.canDeleteForever) throw new DriveError(403, 'Only a workplace admin can delete items forever, from the Workspace.');
    const paths = await this.storage.change(actor.orgId, (entries) => {
      const entry = find(entries, id);
      if (!entry.trashedAt || entry.trashRootId !== id) throw new DriveError(409, 'Move this item to Trash first.');
      const paths: string[] = [];
      for (const childId of subtree(entries, id)) {
        const child = entries.get(childId)!;
        if (child.storagePath) paths.push(child.storagePath);
        entries.delete(childId);
      }
      return paths;
    });
    // Access is revoked before objects are removed, matching note files.
    // A cleanup failure must never put a downloadable record back over missing bytes.
    for (const storagePath of paths) await this.media.deleteObject?.({ storagePath })
      .catch(() => { console.warn('[drive] an unreferenced object could not be cleaned up'); });
  }
  async access(actor: DriveActor, id: string, preview: boolean) {
    const entry = find(await this.storage.read(actor.orgId), id);
    if (entry.kind !== 'file' || !entry.storagePath) throw new DriveError(400, 'Choose a file to download.');
    const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(entry.contentType);
    const access = await this.media.createReadAccess({ storagePath: entry.storagePath, expiresInMs: 15 * 60_000,
      ...(preview && image ? { responseDisposition: 'inline' } : { promptSaveAs: entry.name, responseDisposition: attachmentDisposition(entry.name) }) });
    return { ...access, fileName: entry.name, sizeBytes: entry.sizeBytes };
  }

  /** The bytes a list row shows by itself: a picture its <img> draws (note
   *  #694), a recording its play button plays (note #698). Only a file the
   *  preview would show as that kind, and only ever inline. */
  async rowMedia(actor: DriveActor, id: string, kind: 'image' | 'audio') {
    const entry = find(await this.storage.read(actor.orgId), id);
    if (entry.kind !== 'file' || !entry.storagePath || drivePreviewKind(entry) !== kind) {
      throw new DriveError(404, `No such ${kind === 'image' ? 'picture' : 'recording'} in this Drive.`);
    }
    return this.media.createReadAccess({ storagePath: entry.storagePath, expiresInMs: 15 * 60_000, responseDisposition: 'inline' });
  }

  /**
   * A folder — or the whole Drive, for `null` — planned as one .zip (note
   * #694): the folder itself as the archive's top level, then everything
   * live inside it, folders before files and each by name, as the list
   * draws them. Trash is not part of a folder, so it is not part of its
   * download.
   */
  async archive(actor: DriveActor, id: string | null): Promise<DriveArchive> {
    const entries = await this.storage.read(actor.orgId);
    if (id !== null && find(entries, id).kind !== 'folder') throw new DriveError(400, 'Choose a folder to download.');
    const folder = liveFolder(entries, id);
    const top = folder?.name ?? 'Drive';
    const children = new Map<string | null, DriveEntry[]>();
    for (const entry of entries.values()) if (!entry.trashedAt) {
      children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry]);
    }
    const planned: DriveArchive['entries'] = [{ path: `${top}/`, kind: 'folder', sizeBytes: 0, modifiedAt: folder?.updatedAt ?? new Date().toISOString() }];
    const walk = (parentId: string | null, prefix: string) => {
      const inside = [...(children.get(parentId) ?? [])].sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder')
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      for (const entry of inside) {
        const path = `${prefix}${entry.name}`;
        if (entry.kind === 'folder') {
          planned.push({ path: `${path}/`, kind: 'folder', sizeBytes: 0, modifiedAt: entry.updatedAt });
          walk(entry.id, `${path}/`);
        } else planned.push({ path, kind: 'file', sizeBytes: entry.sizeBytes, modifiedAt: entry.updatedAt, storagePath: entry.storagePath });
      }
    };
    walk(id, `${top}/`);
    const files = planned.filter((entry) => entry.kind === 'file').length;
    if (!files) throw new DriveError(409, `${folder ? 'This folder' : 'Drive'} has no files to download yet.`);
    const sizeBytes = zipLength(planned);
    if (sizeBytes > DRIVE_ARCHIVE_MAX_BYTES) {
      throw new DriveError(413, `${folder ? 'This folder' : 'Drive'} is over 2 GB, which is too large to download in one go. Download the folders inside it one at a time.`);
    }
    return { fileName: `${top}.zip`, sizeBytes, files, entries: planned };
  }

  /** Stream a planned archive, one stored file at a time. */
  async writeArchive(archive: DriveArchive, write: (chunk: Buffer) => Promise<void>) {
    await writeZip(archive.entries, ({ storagePath }) => (storagePath
      ? this.media.downloadObject({ storagePath }) : Promise.resolve(Buffer.alloc(0))), write);
  }

  /** A preview is either inert text rebuilt by the Workspace, or a short-lived
   *  inline URL consumed by an image/media/PDF element. Uploaded HTML is never
   *  returned as a document URL and therefore cannot execute in our page. */
  async preview(actor: DriveActor, id: string): Promise<DrivePreview> {
    const entry = find(await this.storage.read(actor.orgId), id);
    if (entry.kind !== 'file' || !entry.storagePath) throw new DriveError(400, 'Choose a file to preview.');
    const kind = drivePreviewKind(entry);
    if (kind === 'unsupported') return { kind };
    if (kind === 'markdown' || kind === 'text') {
      if (entry.sizeBytes > DRIVE_TEXT_PREVIEW_MAX_BYTES) {
        return { kind: 'too-large', maxBytes: DRIVE_TEXT_PREVIEW_MAX_BYTES };
      }
      const data = await this.media.downloadObject({ storagePath: entry.storagePath });
      if (data.byteLength > DRIVE_TEXT_PREVIEW_MAX_BYTES) {
        return { kind: 'too-large', maxBytes: DRIVE_TEXT_PREVIEW_MAX_BYTES };
      }
      return { kind, content: data.toString('utf8') };
    }
    const access = await this.media.createReadAccess({
      storagePath: entry.storagePath,
      expiresInMs: 15 * 60_000,
      responseDisposition: 'inline',
    });
    return { kind, ...access };
  }
}
