import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryDriveStorage } from '../../services/drive-storage.js';
import { MemoryMediaStorage } from '../../services/memory-media-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { createHash } from 'node:crypto';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';
import { readZip } from './zip-reader.js';

describe('Drive through the browser and agent doors', () => {
  let server: Server;
  let origin: string;
  let orgId: string;
  let otherOrgId: string;
  let token: string;
  let orgs: InMemoryOrgStorage;
  let files: Map<string, Buffer>;
  let parted: MemoryMediaStorage;
  let temp: string;
  const cli = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
  const headers = workspaceTestHeaders(42);
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${origin}/workspace/api/${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const agent = (path: string, method = 'GET', body?: unknown) => fetch(`${origin}/api/agent-cli/drive${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const runCli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...(args[0] === 'note' ? args : ['drive', ...args])], {
      env: { ...process.env, AGENTBUILT_API_URL: origin, AGENTBUILT_TOKEN: token }, cwd: temp,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  beforeEach(async () => {
    temp = mkdtempSync(`${tmpdir()}/drive-cli-`);
    const users = new InMemoryUserStorage();
    orgs = new InMemoryOrgStorage(); files = new Map(); parted = new MemoryMediaStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    orgId = (await orgs.createOrg({ name: 'A', createdByUserId: 'alice' })).orgId;
    otherOrgId = (await orgs.createOrg({ name: 'B', createdByUserId: 'bob' })).orgId;
    await orgs.addMember({ orgId, userId: 'alice', role: 'admin' });
    await orgs.addMember({ orgId: otherOrgId, userId: 'bob', role: 'admin' });
    const minted = mintAgentbuiltToken('alice', 'ada'); token = minted.token;
    await users.updateProfile('alice', { telegram: { agents: {
      ada: { id: 'ada', name: 'Ada', cli: 'codex', orgId, agentbuiltTokenHash: minted.tokenHash },
    } } as never });
    const deps: Partial<RouteDeps> = { userStorage: users, orgStorage: orgs, driveStorage: new InMemoryDriveStorage(), mediaStorage: {
      uploadObject: async ({ storagePath, data }) => { files.set(storagePath, Buffer.from(data as Uint8Array)); },
      createReadAccess: async ({ storagePath, promptSaveAs, responseDisposition }) => ({
        url: `${origin}/objects/${encodeURIComponent(storagePath)}?name=${encodeURIComponent(promptSaveAs ?? '')}&disposition=${responseDisposition ?? ''}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      downloadObject: async ({ storagePath }) => files.get(storagePath)!,
      deleteObject: async ({ storagePath }) => { files.delete(storagePath); },
      // Big files in parts (note #784): the parts held apart until stitched,
      // then the whole object served from the same map as the rest.
      startMultipart: (args) => parted.startMultipart(args),
      uploadPart: (args) => parted.uploadPart(args),
      completeMultipart: async (args) => {
        const done = await parted.completeMultipart(args);
        files.set(args.storagePath, parted.objects.get(args.storagePath)!.data);
        return done;
      },
      abortMultipart: (args) => parted.abortMultipart(args),
    } as RouteDeps['mediaStorage'], quickNoteStorage: new InMemoryQuickNoteStorage() };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express(); app.use(express.json());
    app.get('/objects/:key', (req, res) => res.end(files.get(req.params.key)));
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    app.use('/api/agent-cli', agentCliRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  });

  it('requires session and CSRF, hides other workplaces and pins agents despite query parameters', async () => {
    expect((await fetch(`${origin}/workspace/api/drive`)).status).toBe(401);
    expect((await request(`drive/folders?org=${orgId}`, 'POST', { name: 'No CSRF' }, { 'X-CSRF-Token': '' })).status).toBe(403);
    // The shared Workspace guard now rejects an explicit foreign org before
    // Drive resolves an item. Unknown and foreign orgs give the same refusal.
    const foreign = await request(`drive?org=${otherOrgId}`);
    const unknown = await request('drive?org=missing-organization');
    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(await foreign.json());
    const made = await agent('/folders', 'POST', { name: 'Shared' });
    const { item } = await made.json();
    expect(made.status).toBe(201);
    expect((await (await request(`drive?org=${orgId}`)).json()).items[0].id).toBe(item.id);
    expect((await (await agent(`?org=${otherOrgId}`)).json()).items[0].id).toBe(item.id);
    const bob = await fetch(`${origin}/workspace/api/drive/${item.id}?org=${otherOrgId}`, { headers: workspaceTestHeaders(43) });
    expect(bob.status).toBe(404);
    await orgs.removeMember(orgId, 'alice');
    expect((await agent('')).status).toBe(403);
  });

  it('sends a 20 MB file in parts and fetches it back byte for byte, to Drive and onto a note, through the actual CLI (note #784)', async () => {
    const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    const big = Buffer.alloc(20 * 1024 * 1024 + 321);
    for (let index = 0; index < big.length; index += 4096) big[index] = (index / 4096) % 256;
    writeFileSync(`${temp}/clip.mov`, big);

    const upload = await runCli(['upload', 'clip.mov']);
    expect(upload.code, upload.stderr).toBe(0);
    const fileId = upload.stdout.split(' ')[0]!;
    // In parts: only a stitched multipart upload lands in `parted.objects`.
    expect([...parted.objects.keys()]).toEqual([`users/${orgId}/drive/${fileId}`]);
    expect(parted.uploads.size).toBe(0);
    expect((await runCli(['fetch', fileId, '-o', 'clip-back.mov'])).code).toBe(0);
    expect(sha(readFileSync(`${temp}/clip-back.mov`))).toBe(sha(big));

    const note = await runCli(['note', 'add', '<p>The demo clip.</p>']);
    expect(note.code, note.stderr).toBe(0);
    const number = /#(\d+)/.exec(note.stdout)![1]!;
    const attach = await runCli(['note', 'attach', number, 'clip.mov']);
    expect(attach.code, attach.stderr).toBe(0);
    expect(attach.stdout).toContain(`Attached clip.mov to note #${number}`);
    expect((await runCli(['note', 'fetch', number, 'clip.mov', '-o', 'note-back.mov'])).code).toBe(0);
    expect(sha(readFileSync(`${temp}/note-back.mov`))).toBe(sha(big));

    writeFileSync(`${temp}/too-big.bin`, '');
    const { truncateSync } = await import('node:fs');
    truncateSync(`${temp}/too-big.bin`, 100 * 1024 * 1024 + 1);
    const refused = await runCli(['note', 'attach', number, 'too-big.bin']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('up to 100 MB');
  });

  it('takes a big file in parts through the Workspace door too, and cancels cleanly (note #784)', async () => {
    const data = Buffer.alloc(9 * 1024 * 1024, 3);
    const start = await request(`drive/uploads?org=${orgId}`, 'POST', { name: 'big.bin', parentId: null, sizeBytes: data.length });
    expect(start.status).toBe(201);
    const upload = await start.json() as { id: string; uploadId: string; partBytes: number; parts: number };
    expect(upload.parts).toBe(2);
    const parts = [];
    for (let n = 1; n <= upload.parts; n += 1) {
      const part = await fetch(`${origin}/workspace/api/drive/uploads/${upload.id}/parts/${n}?org=${orgId}&upload=${upload.uploadId}`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: data.subarray((n - 1) * upload.partBytes, n * upload.partBytes),
      });
      expect(part.status).toBe(200);
      parts.push(await part.json());
    }
    const done = await request(`drive/uploads/${upload.id}/complete?org=${orgId}`, 'POST', { uploadId: upload.uploadId, name: 'big.bin', parentId: null, parts });
    expect(done.status).toBe(201);
    expect((await done.json()).item).toMatchObject({ id: upload.id, name: 'big.bin', sizeBytes: data.length });
    expect(files.get(`users/${orgId}/drive/${upload.id}`)!.equals(data)).toBe(true);

    const refused = await request(`drive/uploads?org=${orgId}`, 'POST', { name: 'huge.iso', parentId: null, sizeBytes: 1024 * 1024 * 1024 + 1 });
    expect(refused.status).toBe(413);
    expect((await refused.json()).error).toBe('Files can be up to 1 GB.');
    const second = await (await request(`drive/uploads?org=${orgId}`, 'POST', { name: 'gone.bin', parentId: null, sizeBytes: data.length })).json();
    const cancelled = await fetch(`${origin}/workspace/api/drive/uploads/${second.id}?org=${orgId}&upload=${second.uploadId}`, { method: 'DELETE', headers });
    expect(cancelled.status).toBe(200);
    expect(parted.uploads.size).toBe(0);
  });

  it('round-trips Unicode, JSON, binary and empty files through the actual CLI', async () => {
    const mkdir = await runCli(['mkdir', 'Brand assets']);
    expect(mkdir.code, mkdir.stderr).toBe(0);
    const folderId = mkdir.stdout.split(' ')[0]!;
    const payload = Buffer.from([0, 1, 2, 255, 128]);
    writeFileSync(`${temp}/画面.json`, payload);
    const upload = await runCli(['upload', '画面.json', '--in', folderId]);
    expect(upload.code, upload.stderr).toBe(0);
    const fileId = upload.stdout.split(' ')[0]!;
    const listing = await runCli(['list', folderId, '--json']);
    expect(JSON.parse(listing.stdout).items[0]).toMatchObject({ name: '画面.json', sizeBytes: 5 });
    expect(JSON.parse(listing.stdout).items[0]).not.toHaveProperty('storagePath');
    const source = await request(`drive/${fileId}/preview?org=${orgId}`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ kind: 'text' });
    expect((await runCli(['fetch', fileId, '-o', 'saved.bin'])).code).toBe(0);
    expect(readFileSync(`${temp}/saved.bin`)).toEqual(payload);
    expect((await runCli(['fetch', fileId, '-o', 'saved.bin'])).code).toBe(1);
    expect((await runCli(['rename', fileId, 'Final.json'])).code).toBe(0);
    expect((await runCli(['move', fileId, 'root'])).code).toBe(0);
    expect((await runCli(['trash', fileId])).code).toBe(0);
    expect(JSON.parse((await runCli(['list', '--trash', '--json'])).stdout).items[0].name).toBe('Final.json');
    expect((await runCli(['restore', fileId])).code).toBe(0);
    writeFileSync(`${temp}/empty.txt`, '');
    const empty = await runCli(['upload', 'empty.txt']);
    expect(empty.code, empty.stderr).toBe(0);
    writeFileSync(`${temp}/brief.pdf`, '%PDF-1.4\n');
    const pdf = await runCli(['upload', 'brief.pdf']);
    expect(pdf.code, pdf.stderr).toBe(0);
    const pdfId = pdf.stdout.split(' ')[0]!;
    const pdfPreview = await request(`drive/${pdfId}/preview?org=${orgId}`);
    expect(pdfPreview.status).toBe(200);
    const pdfAnswer = await pdfPreview.json();
    expect(pdfAnswer.kind).toBe('pdf');
    expect(new URL(pdfAnswer.url).searchParams.get('disposition')).toBe('inline');
  });

  it('downloads a folder as one zip on the reader’s session, draws only pictures and plays only recordings (notes #694, #698)', async () => {
    const upload = async (name: string, data: Buffer, parent: string) => (await (await fetch(`${origin}/workspace/api/drive/files?org=${orgId}&parent=${parent}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-drive-name': encodeURIComponent(name) }, body: data,
    })).json()).item;
    const { item: folder } = await (await request(`drive/folders?org=${orgId}`, 'POST', { name: 'Brand assets' })).json();
    const photo = await upload('画面.png', Buffer.from([137, 80, 78, 71]), folder.id);
    const brief = await upload('brief.txt', Buffer.from('hello'), folder.id);

    const check = await request(`drive/${folder.id}/archive?org=${orgId}&check=1`);
    const summary = await check.json();
    expect(summary).toEqual({ fileName: 'Brand assets.zip', sizeBytes: expect.any(Number), files: 2 });
    // A plain GET with the session cookie and no CSRF header: what an anchor sends.
    const zip = await fetch(`${origin}/workspace/api/drive/${folder.id}/archive?org=${orgId}`, { headers: { Cookie: headers.Cookie! } });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe(`attachment; filename="Brand assets.zip"; filename*=UTF-8''Brand%20assets.zip`);
    expect(zip.headers.get('content-length')).toBe(String(summary.sizeBytes));
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.length).toBe(summary.sizeBytes);
    expect(readZip(bytes).map(({ path, data }) => [path, data.toString('hex')])).toEqual([
      ['Brand assets/', ''], ['Brand assets/brief.txt', '68656c6c6f'], ['Brand assets/画面.png', '89504e47'],
    ]);
    expect((await (await request(`drive/root/archive?org=${orgId}&check=1`)).json()).fileName).toBe('Drive.zip');
    expect((await request(`drive/${photo.id}/archive?org=${orgId}&check=1`)).status).toBe(400);
    expect((await fetch(`${origin}/workspace/api/drive/${folder.id}/archive?org=${orgId}`)).status).toBe(401);
    expect((await fetch(`${origin}/workspace/api/drive/${folder.id}/archive?org=${otherOrgId}`, { headers: workspaceTestHeaders(43) })).status).toBe(404);

    const picture = await fetch(`${origin}/workspace/api/drive/${photo.id}/image?org=${orgId}`, { headers: { Cookie: headers.Cookie! }, redirect: 'manual' });
    expect(picture.status).toBe(302);
    expect(picture.headers.get('cache-control')).toBe('private, max-age=300');
    expect(new URL(picture.headers.get('location')!).searchParams.get('disposition')).toBe('inline');
    expect((await request(`drive/${brief.id}/image?org=${orgId}`)).status).toBe(404);

    const track = await upload('demo.mp3', Buffer.from('ID3'), 'root');
    const sound = await fetch(`${origin}/workspace/api/drive/${track.id}/audio?org=${orgId}`, { headers: { Cookie: headers.Cookie! }, redirect: 'manual' });
    expect(sound.status).toBe(302);
    expect(sound.headers.get('cache-control')).toBe('private, max-age=300');
    expect(new URL(sound.headers.get('location')!).searchParams.get('disposition')).toBe('inline');
    expect((await request(`drive/${photo.id}/audio?org=${orgId}`)).status).toBe(404);
    expect((await fetch(`${origin}/workspace/api/drive/${track.id}/audio?org=${otherOrgId}`, { headers: workspaceTestHeaders(43) })).status).toBe(404);
  });

  it('allows permanent deletion only through an admin browser and protects nonempty workplaces', async () => {
    const { item } = await (await agent('/folders', 'POST', { name: 'Keep' })).json();
    const removal = await request('org', 'DELETE');
    expect(removal.status).toBe(409);
    expect((await removal.json()).error).toContain('Drive');
    await agent(`/${item.id}/trash`, 'POST');
    expect((await agent(`/${item.id}`, 'DELETE')).status).toBe(404);
    await orgs.addMember({ orgId, userId: 'bob', role: 'member' });
    const memberDelete = await fetch(`${origin}/workspace/api/drive/${item.id}?org=${orgId}`, { method: 'DELETE', headers: workspaceTestHeaders(43) });
    expect(memberDelete.status).toBe(403);
    expect((await request(`drive/${item.id}?org=${orgId}`, 'DELETE')).status).toBe(200);
    expect((await request(`drive/${item.id}?org=${orgId}`)).status).toBe(404);
  });
});
