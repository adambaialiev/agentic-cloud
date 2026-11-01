import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDriveStorage, type DriveStorage } from '../../services/drive-storage.js';
import { SqliteDriveStorage } from '../../services/sqlite/sqlite-drive-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { DriveService, type DriveActor } from '../../services/drive-service.js';
import type { MediaStorage } from '../../services/media-storage.js';
import { DRIVE_ARCHIVE_MAX_BYTES, DRIVE_FILE_MAX_BYTES, DRIVE_SINGLE_UPLOAD_MAX_BYTES, DRIVE_TEXT_PREVIEW_MAX_BYTES } from '../../shared/drive.js';
import { MemoryMediaStorage } from '../../services/memory-media-storage.js';
import { UPLOAD_PART_BYTES } from '../../shared/uploads.js';
import { readZip } from './zip-reader.js';

const actor: DriveActor = { orgId: 'org-a', userId: 'alice', canDeleteForever: true };
const other = { ...actor, orgId: 'org-b' };
const media = () => ({ uploadObject: vi.fn(async () => {}), deleteObject: vi.fn(async () => {}),
  downloadObject: vi.fn(async () => Buffer.from('preview words')),
  createReadAccess: vi.fn(async () => ({ url: 'https://files.test/signed', expiresAt: 'soon' })) } as unknown as MediaStorage);

describe.each(['memory', 'sqlite'])('Drive tree in %s', (kind) => {
  let db: SqliteDb | undefined;
  let storage: DriveStorage;
  let drive: DriveService;
  let files: MediaStorage;
  beforeEach(() => {
    db = kind === 'sqlite' ? openSqliteDb(':memory:') : undefined;
    storage = db ? new SqliteDriveStorage(db) : new InMemoryDriveStorage();
    files = media(); drive = new DriveService(storage, files);
  });
  afterEach(() => db?.close());

  it('shares by workplace and retains stable IDs, names, bytes and ancestry through a move', async () => {
    const folder = await drive.folder(actor, 'Design', null);
    const file = await drive.upload(actor, '画面.png', folder.id, Buffer.from([1, 2, 3]));
    await drive.access(actor, file.id, false);
    expect(files.createReadAccess).toHaveBeenLastCalledWith(expect.objectContaining({ responseDisposition: expect.stringContaining("filename*=UTF-8''%E7%94%BB%E9%9D%A2.png") }));
    const colleague = { ...actor, userId: 'bob', agentId: 'agent-b' };
    expect((await drive.list(colleague, folder.id, false)).items).toEqual([file]);
    expect((await drive.list(other, null, false)).items).toEqual([]);
    await expect(drive.detail(other, file.id)).rejects.toMatchObject({ status: 404 });
    await expect(drive.edit(other, file.id, { name: 'stolen' })).rejects.toMatchObject({ status: 404 });
    await expect(drive.access(other, file.id, false)).rejects.toMatchObject({ status: 404 });
    await drive.edit(actor, file.id, { parentId: null, name: 'Final.png' });
    expect((await drive.detail(actor, file.id)).item).toMatchObject({ id: file.id, name: 'Final.png', sizeBytes: 3, parentId: null });
    expect((await drive.detail(actor, file.id)).item).not.toHaveProperty('storagePath');
    expect(files.uploadObject).toHaveBeenCalledOnce();
    if (db) expect((await new SqliteDriveStorage(db).read(actor.orgId)).get(file.id)?.name).toBe('Final.png');
  });

  it('refuses invalid parents, duplicate names and cycles, even for simultaneous writes', async () => {
    const first = await drive.folder(actor, 'First', null);
    const child = await drive.folder(actor, 'Child', first.id);
    const file = await drive.upload(actor, 'a.txt', null, Buffer.alloc(0));
    await expect(drive.folder(other, 'Other', first.id)).rejects.toMatchObject({ status: 404 });
    await expect(drive.folder(actor, 'inside file', file.id)).rejects.toMatchObject({ status: 409 });
    await expect(drive.edit(actor, first.id, { parentId: child.id })).rejects.toMatchObject({ status: 409 });
    await expect(drive.edit(actor, first.id, { parentId: first.id })).rejects.toMatchObject({ status: 409 });
    const results = await Promise.allSettled([drive.folder(actor, 'same', null), drive.folder(actor, 'SAME', null)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const second = await drive.folder(actor, 'Second', null);
    const moves = await Promise.allSettled([drive.edit(actor, first.id, { parentId: second.id }), drive.edit(actor, second.id, { parentId: first.id })]);
    expect(moves.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const name of ['', '../x', '.', 'a\\b', 'x\ny', 'a'.repeat(256)]) {
      await expect(drive.folder(actor, name, null)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('restores a trashed tree while keeping an earlier independent deletion in Trash', async () => {
    const folder = await drive.folder(actor, 'Work', null);
    const live = await drive.upload(actor, 'keep.txt', folder.id, Buffer.from('keep'));
    const old = await drive.upload(actor, 'old.txt', folder.id, Buffer.from('old'));
    await drive.trash(actor, old.id);
    await drive.trash(actor, folder.id);
    expect((await drive.list(actor, null, false, 'keep')).items).toHaveLength(0);
    expect((await drive.list(actor, null, true)).items.map((item) => item.id).sort()).toEqual([folder.id, old.id].sort());
    await expect(drive.restore(actor, live.id)).rejects.toMatchObject({ status: 409 });
    await expect(drive.folder(actor, 'new', folder.id)).rejects.toMatchObject({ status: 409 });
    await drive.restore(actor, folder.id);
    expect((await drive.list(actor, folder.id, false)).items.map((item) => item.id)).toEqual([live.id]);
    expect((await drive.detail(actor, old.id)).item.trashedAt).toBeTruthy();
    await drive.trash(actor, folder.id);
    await drive.restore(actor, old.id);
    expect((await drive.detail(actor, old.id)).item.parentId).toBeNull();
  });

  it('preserves Trash on a restore collision and permits renaming before another try', async () => {
    const file = await drive.upload(actor, 'budget.csv', null, Buffer.from('one'));
    await drive.trash(actor, file.id);
    await drive.upload(actor, 'budget.csv', null, Buffer.from('two'));
    await expect(drive.restore(actor, file.id)).rejects.toMatchObject({ status: 409 });
    expect((await drive.detail(actor, file.id)).item.trashedAt).toBeTruthy();
    await drive.edit(actor, file.id, { name: 'old-budget.csv' });
    await drive.restore(actor, file.id);
    expect((await drive.list(actor, null, false, 'budget')).items).toHaveLength(2);
  });

  it('commits only uploaded bytes and cleans up when a parent is trashed during upload', async () => {
    const parent = await drive.folder(actor, 'Uploads', null);
    vi.mocked(files.uploadObject).mockRejectedValueOnce(new Error('offline'));
    await expect(drive.upload(actor, 'lost.txt', parent.id, Buffer.from('test'))).rejects.toThrow('offline');
    expect((await drive.list(actor, parent.id, false)).items).toEqual([]);
    vi.mocked(files.uploadObject).mockImplementationOnce(async () => { await drive.trash(actor, parent.id); });
    await expect(drive.upload(actor, 'late.txt', parent.id, Buffer.from('test'))).rejects.toMatchObject({ status: 409 });
    expect(files.deleteObject).toHaveBeenCalledOnce();
    expect((await storage.read(actor.orgId)).size).toBe(1);
    await expect(drive.upload(actor, 'huge', null, Buffer.alloc(DRIVE_SINGLE_UPLOAD_MAX_BYTES + 1))).rejects.toMatchObject({ status: 413 });
  });

  it('restricts permanent deletion and removes the entire tree including earlier trash', async () => {
    const folder = await drive.folder(actor, 'Old', null);
    const file = await drive.upload(actor, 'old.txt', folder.id, Buffer.from('old'));
    await expect(drive.removeForever(actor, folder.id)).rejects.toMatchObject({ status: 409 });
    await drive.trash(actor, file.id); await drive.trash(actor, folder.id);
    await expect(drive.removeForever({ ...actor, canDeleteForever: false }, folder.id)).rejects.toMatchObject({ status: 403 });
    await drive.removeForever(actor, folder.id);
    expect((await storage.read(actor.orgId)).size).toBe(0);
    expect(files.deleteObject).toHaveBeenCalledOnce();
  });

  it('downloads under the current name and shows active document types only as inert source', async () => {
    const file = await drive.upload(actor, 'page.html', null, Buffer.from('<script>bad()</script>'));
    // A rename must not promote known HTML bytes into the inline PDF path.
    await drive.edit(actor, file.id, { name: 'renamed.pdf' });
    await drive.access(actor, file.id, true);
    expect(files.createReadAccess).toHaveBeenLastCalledWith(expect.objectContaining({ promptSaveAs: 'renamed.pdf' }));
    expect(files.createReadAccess).not.toHaveBeenLastCalledWith(expect.objectContaining({ responseDisposition: 'inline' }));
    vi.mocked(files.downloadObject).mockResolvedValueOnce(Buffer.from('<script>bad()</script>'));
    await expect(drive.preview(actor, file.id)).resolves.toEqual({ kind: 'text', content: '<script>bad()</script>' });
  });

  it('zips a folder with its folders, in list order, leaving Trash and other folders out (note #694)', async () => {
    const stored = new Map<string, Buffer>();
    vi.mocked(files.uploadObject).mockImplementation(async ({ storagePath, data }) => { stored.set(storagePath, Buffer.from(data as Uint8Array)); });
    vi.mocked(files.downloadObject).mockImplementation(async ({ storagePath }) => stored.get(storagePath)!);
    const folder = await drive.folder(actor, 'Brand assets', null);
    const logos = await drive.folder(actor, 'Logos', folder.id);
    await drive.folder(actor, 'Empty', folder.id);
    await drive.upload(actor, 'zebra.txt', folder.id, Buffer.from('z'));
    await drive.upload(actor, '画面.png', logos.id, Buffer.from([137, 80, 78, 71, 0, 255]));
    await drive.upload(actor, 'blank.txt', folder.id, Buffer.alloc(0));
    const gone = await drive.upload(actor, 'old.txt', folder.id, Buffer.from('old'));
    await drive.trash(actor, gone.id);
    await drive.upload(actor, 'elsewhere.txt', null, Buffer.from('not in it'));

    const archive = await drive.archive(actor, folder.id);
    expect(archive).toMatchObject({ fileName: 'Brand assets.zip', files: 3 });
    expect(archive.entries.map((entry) => entry.path)).toEqual([
      'Brand assets/', 'Brand assets/Empty/', 'Brand assets/Logos/', 'Brand assets/Logos/画面.png', 'Brand assets/blank.txt', 'Brand assets/zebra.txt',
    ]);
    const chunks: Buffer[] = [];
    await drive.writeArchive(archive, async (chunk) => { chunks.push(chunk); });
    const zip = Buffer.concat(chunks);
    expect(zip.length).toBe(archive.sizeBytes);
    expect(readZip(zip).map(({ path, data }) => [path, data.toString('hex')])).toEqual([
      ['Brand assets/', ''], ['Brand assets/Empty/', ''], ['Brand assets/Logos/', ''],
      ['Brand assets/Logos/画面.png', '89504e4700ff'], ['Brand assets/blank.txt', ''], ['Brand assets/zebra.txt', '7a'],
    ]);
    // All of Drive is a folder too, named for what it is.
    expect((await drive.archive(actor, null)).entries.map((entry) => entry.path)).toContain('Drive/elsewhere.txt');
    expect((await drive.archive(actor, null)).entries.map((entry) => entry.path)).not.toContain('Drive/Brand assets/old.txt');
  });

  it('refuses a file, a trashed folder or one with no files, another workplace and an oversized folder as an archive', async () => {
    await expect(drive.archive(actor, null)).rejects.toMatchObject({ status: 409, message: 'Drive has no files to download yet.' });
    const folder = await drive.folder(actor, 'Work', null);
    await drive.folder(actor, 'Nothing yet', folder.id);
    await expect(drive.archive(actor, folder.id)).rejects.toMatchObject({ status: 409, message: 'This folder has no files to download yet.' });
    const file = await drive.upload(actor, 'a.txt', folder.id, Buffer.from('a'));
    await expect(drive.archive(actor, file.id)).rejects.toMatchObject({ status: 400 });
    await expect(drive.archive(other, folder.id)).rejects.toMatchObject({ status: 404 });
    await storage.change(actor.orgId, (entries) => { entries.set(file.id, { ...entries.get(file.id)!, sizeBytes: DRIVE_ARCHIVE_MAX_BYTES }); });
    await expect(drive.archive(actor, folder.id)).rejects.toMatchObject({ status: 413 });
    await drive.trash(actor, folder.id);
    await expect(drive.archive(actor, folder.id)).rejects.toMatchObject({ status: 409 });
  });

  it('stops an archive whose file is not the size its record says', async () => {
    const folder = await drive.folder(actor, 'Work', null);
    await drive.upload(actor, 'a.txt', folder.id, Buffer.from('four'));
    vi.mocked(files.downloadObject).mockResolvedValueOnce(Buffer.from('five!'));
    await expect(drive.writeArchive(await drive.archive(actor, folder.id), async () => {})).rejects.toThrow('changed size');
  });

  it('signs a picture or a recording inline for a list row and refuses anything else', async () => {
    const photo = await drive.upload(actor, 'photo.jpg', null, Buffer.from('jpeg'));
    await expect(drive.rowMedia(actor, photo.id, 'image')).resolves.toMatchObject({ url: 'https://files.test/signed' });
    expect(files.createReadAccess).toHaveBeenLastCalledWith(expect.objectContaining({ responseDisposition: 'inline' }));
    const track = await drive.upload(actor, 'track.mp3', null, Buffer.from('ID3'));
    await expect(drive.rowMedia(actor, track.id, 'audio')).resolves.toMatchObject({ url: 'https://files.test/signed' });
    expect(files.createReadAccess).toHaveBeenLastCalledWith(expect.objectContaining({ responseDisposition: 'inline' }));
    await expect(drive.rowMedia(actor, track.id, 'image')).rejects.toMatchObject({ status: 404, message: 'No such picture in this Drive.' });
    await expect(drive.rowMedia(actor, photo.id, 'audio')).rejects.toMatchObject({ status: 404, message: 'No such recording in this Drive.' });
    const page = await drive.upload(actor, 'page.html', null, Buffer.from('<p>'));
    await expect(drive.rowMedia(actor, page.id, 'image')).rejects.toMatchObject({ status: 404 });
    const folder = await drive.folder(actor, 'Pictures', null);
    await expect(drive.rowMedia(actor, folder.id, 'image')).rejects.toMatchObject({ status: 404 });
    await expect(drive.rowMedia(other, photo.id, 'image')).rejects.toMatchObject({ status: 404 });
    await expect(drive.rowMedia(other, track.id, 'audio')).rejects.toMatchObject({ status: 404 });
  });

  it('renders Markdown and text, signs passive browser formats inline, and declines unknown binaries', async () => {
    const markdown = await drive.upload(actor, 'readme.markdown', null, Buffer.from('# Hello'));
    vi.mocked(files.downloadObject).mockResolvedValueOnce(Buffer.from('# Hello'));
    await expect(drive.preview(actor, markdown.id)).resolves.toEqual({ kind: 'markdown', content: '# Hello' });

    for (const [name, kind] of [['brief.pdf', 'pdf'], ['recording.mp3', 'audio'], ['demo.mp4', 'video'], ['diagram.svg', 'image']] as const) {
      const file = await drive.upload(actor, name, null, Buffer.from('bytes'));
      await expect(drive.preview(actor, file.id)).resolves.toMatchObject({ kind, url: 'https://files.test/signed' });
      expect(files.createReadAccess).toHaveBeenLastCalledWith(expect.objectContaining({ responseDisposition: 'inline' }));
    }

    const archive = await drive.upload(actor, 'source.zip', null, Buffer.from('binary'));
    await expect(drive.preview(actor, archive.id)).resolves.toEqual({ kind: 'unsupported' });
    const large = await drive.upload(actor, 'events.log', null, Buffer.alloc(DRIVE_TEXT_PREVIEW_MAX_BYTES + 1));
    const reads = vi.mocked(files.downloadObject).mock.calls.length;
    await expect(drive.preview(actor, large.id)).resolves.toEqual({ kind: 'too-large', maxBytes: DRIVE_TEXT_PREVIEW_MAX_BYTES });
    expect(files.downloadObject).toHaveBeenCalledTimes(reads);
  });
});

describe('a big Drive file in parts (note #784)', () => {
  const bytes = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251));

  it('goes in part by part and exists only once completed, whole and in order', async () => {
    const media = new MemoryMediaStorage();
    const drive = new DriveService(new InMemoryDriveStorage(), media);
    const data = Buffer.concat([bytes(UPLOAD_PART_BYTES, 1), bytes(UPLOAD_PART_BYTES, 2), bytes(1234, 3)]);
    const started = await drive.startUpload(actor, 'film.mov', null, data.length);
    expect(started).toMatchObject({ partBytes: UPLOAD_PART_BYTES, parts: 3 });
    const parts = [];
    // Out of order, as parallel parts arrive.
    for (const n of [2, 1, 3]) {
      parts.push(await drive.uploadPart(actor, started.id, started.uploadId, n, data.subarray((n - 1) * UPLOAD_PART_BYTES, n * UPLOAD_PART_BYTES)));
    }
    expect((await drive.list(actor, null, false)).items).toEqual([]);
    expect(media.objects.size).toBe(0);
    const item = await drive.completeUpload(actor, started.id, { uploadId: started.uploadId, name: 'film.mov', parentId: null, parts });
    expect(item).toMatchObject({ id: started.id, name: 'film.mov', sizeBytes: data.length });
    expect(media.objects.get(`users/${actor.orgId}/drive/${started.id}`)!.data.equals(data)).toBe(true);
    expect((await drive.list(actor, null, false)).items.map((entry) => entry.id)).toEqual([started.id]);
  });

  it('refuses over 1 GB before a byte is sent, a part over 8 MB, and another workplace’s upload', async () => {
    const drive = new DriveService(new InMemoryDriveStorage(), new MemoryMediaStorage());
    await expect(drive.startUpload(actor, 'big.iso', null, DRIVE_FILE_MAX_BYTES + 1)).rejects.toMatchObject({ status: 413, message: 'Files can be up to 1 GB.' });
    expect(DRIVE_FILE_MAX_BYTES).toBe(1024 * 1024 * 1024);
    const started = await drive.startUpload(actor, 'ok.bin', null, DRIVE_FILE_MAX_BYTES);
    expect(started.parts).toBe(128);
    await expect(drive.uploadPart(actor, started.id, started.uploadId, 1, Buffer.alloc(UPLOAD_PART_BYTES + 1))).rejects.toMatchObject({ status: 413 });
    await expect(drive.uploadPart(other, started.id, started.uploadId, 1, Buffer.alloc(10))).rejects.toThrow();
    await expect(drive.uploadPart(actor, '../../etc', started.uploadId, 1, Buffer.alloc(10))).rejects.toMatchObject({ status: 404 });
    await expect(drive.uploadPart(actor, started.id, started.uploadId, 0, Buffer.alloc(10))).rejects.toMatchObject({ status: 400 });
  });

  it('a cancelled upload leaves nothing; a name taken meanwhile leaves no object; a day-old one is swept by the next start', async () => {
    const media = new MemoryMediaStorage({ minPartBytes: 1 });
    const storage = new InMemoryDriveStorage();
    const drive = new DriveService(storage, media);
    const first = await drive.startUpload(actor, 'a.bin', null, 20);
    await drive.uploadPart(actor, first.id, first.uploadId, 1, bytes(20, 1));
    await drive.abortUpload(actor, first.id, first.uploadId);
    expect(media.uploads.size).toBe(0);
    expect(media.objects.size).toBe(0);
    expect((await storage.read(actor.orgId)).size).toBe(0);

    const second = await drive.startUpload(actor, 'b.bin', null, 20);
    const part = await drive.uploadPart(actor, second.id, second.uploadId, 1, bytes(20, 2));
    await drive.upload(actor, 'b.bin', null, Buffer.from('got here first'));
    await expect(drive.completeUpload(actor, second.id, { uploadId: second.uploadId, name: 'b.bin', parentId: null, parts: [part] })).rejects.toMatchObject({ status: 409 });
    expect([...media.objects.keys()]).toHaveLength(1);

    const stale = await drive.startUpload(actor, 'c.bin', null, 20);
    media.uploads.get(stale.uploadId)!.initiated = new Date(Date.now() - 25 * 60 * 60_000);
    await drive.startUpload(actor, 'd.bin', null, 20);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(media.uploads.has(stale.uploadId)).toBe(false);
  });
});
