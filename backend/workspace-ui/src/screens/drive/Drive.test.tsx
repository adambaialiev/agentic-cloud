import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { DriveItem, DriveListing } from '../../../../src/shared/drive.js';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

const signedUntil = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const folder: DriveItem = { id: 'folder-1', parentId: null, kind: 'folder', name: 'Brand assets', sizeBytes: 0, contentType: '', createdAt: 't', updatedAt: 't' };
const file: DriveItem = { ...folder, id: 'file-1', parentId: folder.id, kind: 'file', name: 'Brief.pdf', contentType: 'application/pdf', sizeBytes: 1200 };
const list = (items: DriveItem[], overrides: Partial<DriveListing> = {}): DriveListing => ({ items, folder: null, breadcrumbs: [], totalBytes: 1200,
  trashCount: 0, canDeleteForever: true, maxFileBytes: 1024 * 1024 * 1024, ...overrides });
function at(path: string, extra: Record<string, Answer>) {
  const test = scriptedApi({ ...workspaceScript(() => emptyState()), ...extra });
  render(<MemoryRouter initialEntries={[path]}><App api={test.api} /></MemoryRouter>);
  return test;
}

/** The same scripted Drive, entered the way a reader enters it: from the
 *  card on the overview's Workplace half (Home's own until 2026-10-10). */
function fromHome(extra: Record<string, Answer>) {
  const org = { orgId: 'org-1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
  const test = scriptedApi({ ...workspaceScript(() => emptyState({ org, driveAvailable: true })), ...extra });
  render(<MemoryRouter initialEntries={['/overview']}><App api={test.api} /></MemoryRouter>);
  return test;
}

/** Every file handed to the browser to save, instead of the navigation. */
const savedFiles = () => {
  const list: { href: string; download: string }[] = [];
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    list.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  return { list, restore: () => spy.mockRestore() };
};

/** Every list player pressed, instead of sound: jsdom makes none, and the
 *  element's clock is whatever the test sets it to. */
const speakers = () => {
  const played: HTMLMediaElement[] = [];
  const spies = [
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { played.push(this); return Promise.resolve(); }),
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}),
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}),
  ];
  const clock = (player: HTMLMediaElement, at: number, duration?: number) => {
    Object.defineProperty(player, 'currentTime', { value: at, writable: true, configurable: true });
    if (duration !== undefined) {
      Object.defineProperty(player, 'duration', { value: duration, configurable: true });
      fireEvent.durationChange(player);
    }
    fireEvent.timeUpdate(player);
  };
  return { played, pauses: spies[1]!, clock, restore: () => { for (const spy of spies) spy.mockRestore(); } };
};

describe('Drive screens', () => {
  it('explains a missing workplace instead of leaving a loading screen', async () => {
    at('/drive', {});
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Open Drive from a workplace in your Workspace.');
  });
  it('opens folders and files through durable workplace URLs and offers a fresh download', async () => {
    const test = at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list([folder]),
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
      'GET api/drive/file-1?org=org-1': () => ({ item: file, breadcrumbs: [folder], canDeleteForever: true }),
      'GET api/drive/file-1/preview?org=org-1': () => ({ kind: 'pdf', url: 'https://files.test/brief.pdf', expiresAt: 'later' }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brand assets/ }));
    expect(await screen.findByRole('heading', { name: 'Brand assets' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: /Brief.pdf/ });
    expect(link.getAttribute('href')).toBe('/drive/files/file-1?org=org-1');
    fireEvent.click(link);
    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
    expect(await screen.findByTitle('Preview of Brief.pdf')).toHaveProperty('tagName', 'IFRAME');
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain('Brand assets');
    // Drive was always the workplace's (note #363); since rooms left the
    // product (note #843) no request carries one at all.
    expect(test.calls.some((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}))).toBe(false);
  });

  it('renders Markdown safely and lets the reader switch to its source', async () => {
    const markdown = { ...file, id: 'notes', name: 'Campaign.md', contentType: 'text/markdown; charset=utf-8', sizeBytes: 48 };
    at('/drive/files/notes?org=org-1', {
      'GET api/drive/notes?org=org-1': () => ({ item: markdown, breadcrumbs: [], canDeleteForever: true }),
      'GET api/drive/notes/preview?org=org-1': () => ({ kind: 'markdown', content: '# Campaign\n\n**Launch** notes.' }),
    });
    expect(await screen.findByRole('heading', { name: 'Campaign' })).toBeTruthy();
    expect(screen.getByText('Launch').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'View raw' }));
    expect(screen.getByRole('button', { name: 'View formatted' })).toBeTruthy();
    expect(document.querySelector('.code .lines')?.textContent).toBe('# Campaign\n\n**Launch** notes.');
  });

  it('shows HTML as source instead of executing it', async () => {
    const html = { ...file, id: 'page', name: 'page.html', contentType: 'text/html; charset=utf-8', sizeBytes: 31 };
    at('/drive/files/page?org=org-1', {
      'GET api/drive/page?org=org-1': () => ({ item: html, breadcrumbs: [], canDeleteForever: true }),
      'GET api/drive/page/preview?org=org-1': () => ({ kind: 'text', content: '<script>window.bad = true</script>' }),
    });
    expect(await screen.findByText('<script>window.bad = true</script>')).toBeTruthy();
    expect(document.querySelector('.code script')).toBeNull();
  });

  it('previews browser media', async () => {
    const video = { ...file, id: 'clip', name: 'clip.mp4', contentType: 'video/mp4', sizeBytes: 31 };
    at('/drive/files/clip?org=org-1', {
      'GET api/drive/clip?org=org-1': () => ({ item: video, breadcrumbs: [], canDeleteForever: true }),
      'GET api/drive/clip/preview?org=org-1': () => ({ kind: 'video', url: 'https://files.test/clip.mp4', expiresAt: 'later' }),
    });
    expect(await screen.findByLabelText('Preview of clip.mp4')).toHaveProperty('tagName', 'VIDEO');
  });

  it('explains files with no safe browser viewer', async () => {
    const archive = { ...file, id: 'archive', name: 'source.zip', contentType: 'application/zip', sizeBytes: 31 };
    at('/drive/files/archive?org=org-1', {
      'GET api/drive/archive?org=org-1': () => ({ item: archive, breadcrumbs: [], canDeleteForever: true }),
      'GET api/drive/archive/preview?org=org-1': () => ({ kind: 'unsupported' }),
    });
    expect(await screen.findByText(/isn’t a safe browser preview/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('moves an open file to Drive root and lands in that destination', async () => {
    at('/drive/files/file-1?org=org-1', {
      'GET api/drive/file-1?org=org-1': () => ({ item: file, breadcrumbs: [folder], canDeleteForever: true }),
      'GET api/drive/file-1/preview?org=org-1': () => ({ kind: 'pdf', url: 'https://files.test/brief.pdf', expiresAt: 'later' }),
      'GET api/drive?org=org-1&parent=': () => list([{ ...file, parentId: null }]),
      'PATCH api/drive/file-1?org=org-1': ({ init }) => {
        expect(JSON.parse(String(init?.body))).toEqual({ parentId: null });
        return { item: { ...file, parentId: null } };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }));
    const move = await screen.findByRole('button', { name: 'Move here' });
    await waitFor(() => expect((move as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(move);
    expect(await screen.findByRole('heading', { name: 'Drive' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
  });

  it('creates a folder, refreshes the list and keeps a server refusal on the form', async () => {
    let made = false;
    const test = at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list(made ? [folder] : []),
      'POST api/drive/folders?org=org-1': ({ init }) => {
        if (JSON.parse(String(init?.body)).name === 'Taken') throw new WorkspaceApiError('That name is taken.', 409, {});
        made = true; return { item: folder };
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That name is taken.');
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Brand assets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    const write = test.calls.filter((call) => call.init?.method === 'POST' && call.path.includes('/folders')).at(-1)!;
    expect(JSON.parse(String(write.init?.body))).toEqual({ name: 'Brand assets', parentId: null });
  });

  it('uploads multiple files as bytes, names failures, and keeps successful uploads visible', async () => {
    const good = { ...file, name: '画面.json', parentId: null };
    let uploaded = false;
    const test = at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list(uploaded ? [good] : []),
      'POST api/drive/files?org=org-1&parent=': ({ init }) => {
        const name = new Headers(init?.headers).get('x-drive-name');
        if (name === 'bad.txt') throw new WorkspaceApiError('Upload failed.', 400, {});
        uploaded = true; return { item: good };
      },
    });
    await screen.findByRole('heading', { name: 'Drive' });
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, { target: { files: [new File(['{}'], '画面.json', { type: 'application/json' }), new File(['bad'], 'bad.txt')] } });
    expect(await screen.findByRole('link', { name: /画面.json/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bad.txt: Upload failed.'));
    const upload = test.calls.find((call) => call.path.includes('/files?'))!;
    expect(new Headers(upload.init?.headers).get('Content-Type')).toBe('application/octet-stream');
    expect(new Headers(upload.init?.headers).get('x-drive-name')).toBe(encodeURIComponent('画面.json'));
    expect(upload.init?.body).toBeInstanceOf(File);
  });

  it('sends a file past one part in parts, and cancels it when a part keeps failing (note #784)', async () => {
    const big = { ...file, id: 'up-1', name: 'clip.mov', parentId: null, sizeBytes: 9 * 1024 * 1024 };
    let uploaded = false;
    const sizes: number[] = [];
    const test = at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list(uploaded ? [big] : []),
      'POST api/drive/uploads?org=org-1': ({ init }) => {
        const body = JSON.parse(String(init?.body));
        return body.name === 'clip.mov'
          ? { id: 'up-1', uploadId: 'u1', partBytes: 8 * 1024 * 1024, parts: 2 }
          : { id: 'up-2', uploadId: 'u2', partBytes: 8 * 1024 * 1024, parts: 2 };
      },
      'PUT api/drive/uploads/up-1/parts/1?org=org-1&upload=u1': ({ init }) => { sizes.push((init?.body as Blob).size); return { partNumber: 1, etag: '"a"' }; },
      'PUT api/drive/uploads/up-1/parts/2?org=org-1&upload=u1': ({ init }) => { sizes.push((init?.body as Blob).size); return { partNumber: 2, etag: '"b"' }; },
      'POST api/drive/uploads/up-1/complete?org=org-1': () => { uploaded = true; return { item: big }; },
      'PUT api/drive/uploads/up-2/parts/1?org=org-1&upload=u2': () => ({ partNumber: 1, etag: '"c"' }),
      'PUT api/drive/uploads/up-2/parts/2?org=org-1&upload=u2': () => { throw new WorkspaceApiError('The file could not be saved just now.', 503, {}); },
      'DELETE api/drive/uploads/up-2?org=org-1&upload=u2': () => ({ ok: true }),
    });
    await screen.findByRole('heading', { name: 'Drive' });
    const input = document.querySelector('input[type=file]')!;
    const nine = () => new Uint8Array(9 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [new File([nine()], 'clip.mov'), new File([nine()], 'lost.mov')] } });
    expect(await screen.findByRole('link', { name: /clip.mov/ }, { timeout: 8000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lost.mov: The file could not be saved just now.'), { timeout: 8000 });
    expect(sizes.sort((a, b) => a - b)).toEqual([1024 * 1024, 8 * 1024 * 1024]);
    const complete = test.calls.find((call) => call.path.startsWith('api/drive/uploads/up-1/complete'))!;
    expect(JSON.parse(String(complete.init?.body))).toEqual({
      uploadId: 'u1', name: 'clip.mov', parentId: null, parts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '"b"' }],
    });
    // The failing part was tried three times, then the upload was cancelled.
    expect(test.calls.filter((call) => call.path.startsWith('api/drive/uploads/up-2/parts/2')).length).toBe(3);
    expect(test.calls.some((call) => call.path.startsWith('api/drive/uploads/up-2?') && call.init?.method === 'DELETE')).toBe(true);
    expect(test.calls.some((call) => call.path.startsWith('api/drive/files'))).toBe(false);
  }, 20_000);

  it('restores Trash and keeps permanent deletion behind a typed confirmation', async () => {
    const trashed = { ...folder, trashedAt: 't' };
    let removed = false;
    const test = at('/drive/trash?org=org-1', {
      'GET api/drive?org=org-1&parent=&trash=1': () => list(removed ? [] : [trashed], { trashCount: removed ? 0 : 1 }),
      'DELETE api/drive/folder-1?org=org-1': () => { removed = true; return { ok: true }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Brand assets' }));
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    const confirm = screen.getByRole('dialog').querySelector('button.danger') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Brand assets to confirm'), { target: { value: 'Brand assets' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText('Trash is empty.')).toBeTruthy();
    expect(test.calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it('draws a picture as itself in the list, and keeps the glyph for anything it cannot draw (note #694)', async () => {
    const photo: DriveItem = { ...file, id: 'photo-1', parentId: null, name: 'Launch party.jpg', contentType: 'image/jpeg' };
    const heic: DriveItem = { ...photo, id: 'photo-2', name: 'IMG_0001.heic', contentType: 'image/heic' };
    at('/drive?org=org-1', { 'GET api/drive?org=org-1&parent=': () => list([folder, { ...file, parentId: null }, heic, photo]) });
    const row = (await screen.findByRole('link', { name: /Launch party\.jpg/ })).closest('.driverow')!;
    const picture = row.querySelector('.drivemark img') as HTMLImageElement;
    // The row's own address, on the reader's session — the same src on every
    // redraw, so a poll never fetches the picture again.
    expect(picture.getAttribute('src')).toBe('/workspace/api/drive/photo-1/image?org=org-1');
    expect(picture.getAttribute('loading')).toBe('lazy');
    expect(row.querySelector('.drivemark .ft')).toBeTruthy();
    fireEvent.load(picture);
    expect(row.querySelector('.drivemark .ft')).toBeNull();
    // A format this browser cannot decode falls back to the glyph, not a broken picture.
    const undecodable = screen.getByRole('link', { name: /IMG_0001\.heic/ }).closest('.driverow')!;
    fireEvent.error(undecodable.querySelector('.drivemark img')!);
    expect(undecodable.querySelector('.drivemark img')).toBeNull();
    expect(undecodable.querySelector('.drivemark .ft')).toBeTruthy();
    for (const name of [/Brand assets/, /Brief\.pdf/]) {
      expect(screen.getByRole('link', { name }).closest('.driverow')!.querySelector('img')).toBeNull();
    }
  });

  it('plays a recording from its own row, one at a time, and says how far in it is (note #698)', async () => {
    const sound = speakers();
    try {
      const track: DriveItem = { ...file, id: 'track-1', parentId: null, name: 'House fest.mp3', contentType: 'audio/mpeg', sizeBytes: 4_300_000 };
      const second: DriveItem = { ...track, id: 'track-2', name: 'Rising forest.wav', contentType: '' };
      at('/drive?org=org-1', {
        'GET api/drive?org=org-1&parent=': () => list([folder, track, second, { ...file, parentId: null }]),
        'GET api/drive?org=org-1&parent=folder-1': () => list([], { folder, breadcrumbs: [folder] }),
      });
      const play = await screen.findByRole('button', { name: 'Play House fest.mp3' });
      const line = () => screen.getByRole('link', { name: /House fest\.mp3/ }).querySelector('.cline')!.textContent;
      expect(line()).toBe('4.1 MB');
      // Only a recording's mark is a button; a document keeps its glyph.
      expect(screen.queryByRole('button', { name: /Play Brief/ })).toBeNull();

      // The press starts the sound on the row's own address — nothing is asked for first.
      fireEvent.click(play);
      expect(sound.played).toHaveLength(1);
      const player = sound.played[0]!;
      expect(player.getAttribute('src')).toBe('/workspace/api/drive/track-1/audio?org=org-1');
      expect(await screen.findByRole('button', { name: 'Pause House fest.mp3' })).toBeTruthy();
      expect(line()).toBe('4.1 MB · Loading…');
      sound.clock(player, 42.6, 195);
      expect(line()).toBe('4.1 MB · 0:42 / 3:15');

      fireEvent.click(screen.getByRole('button', { name: 'Pause House fest.mp3' }));
      expect(sound.pauses).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Play House fest.mp3' })).toBeTruthy();
      expect(line()).toBe('4.1 MB · 0:42 / 3:15');

      // A second row takes over the one player, so the first one stops.
      fireEvent.click(screen.getByRole('button', { name: 'Play Rising forest.wav' }));
      expect(sound.played).toEqual([player, player]);
      expect(player.getAttribute('src')).toBe('/workspace/api/drive/track-2/audio?org=org-1');
      expect(screen.getByRole('button', { name: 'Pause Rising forest.wav' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Play House fest.mp3' })).toBeTruthy();
      expect(line()).toBe('4.1 MB');

      // Its signed bytes ran out mid-way: it asks again and carries on from there.
      sound.clock(player, 300, 600);
      fireEvent.error(player);
      expect(player.getAttribute('src')).toMatch(/^\/workspace\/api\/drive\/track-2\/audio\?org=org-1&again=\d+$/);
      fireEvent.loadedMetadata(player);
      expect(player.currentTime).toBe(300);
      expect(sound.played).toHaveLength(3);
      fireEvent.ended(player);
      expect(screen.getByRole('button', { name: 'Play Rising forest.wav' })).toBeTruthy();

      // One that cannot play at all gets its glyph back and says so.
      fireEvent.click(screen.getByRole('button', { name: 'Play House fest.mp3' }));
      sound.clock(player, 0);
      fireEvent.error(player);
      expect(screen.queryByRole('button', { name: /^(Play|Pause) House fest/ })).toBeNull();
      expect(line()).toBe('4.1 MB · Could not play here');
      expect(screen.getByRole('link', { name: /House fest\.mp3/ }).closest('.driverow')!.querySelector('.drivemark .ft')).toBeTruthy();

      // Leaving the folder lets go of the sound.
      fireEvent.click(screen.getByRole('button', { name: 'Play Rising forest.wav' }));
      fireEvent.click(screen.getByRole('link', { name: /Brand assets/ }));
      await screen.findByText(/This folder is empty/);
      expect(player.hasAttribute('src')).toBe(false);
    } finally { sound.restore(); }
  });

  it('downloads the folder it is in as one .zip, on an address the browser follows itself (note #694)', async () => {
    const saved = savedFiles();
    try {
      const test = at('/drive/folders/folder-1?org=org-1', {
        'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
        'GET api/drive/folder-1/archive?org=org-1&check=1': () => ({ fileName: 'Brand assets.zip', sizeBytes: 1342, files: 1 }),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Download folder' }));
      await waitFor(() => expect(saved.list).toEqual([{ href: '/workspace/api/drive/folder-1/archive?org=org-1', download: 'Brand assets.zip' }]));
      expect(test.calls.filter((call) => String(call.path).includes('/archive'))).toHaveLength(1);
    } finally { saved.restore(); }
  });

  it('says why all of Drive cannot download, and from a folder’s menu saves that folder (note #694)', async () => {
    const saved = savedFiles();
    try {
      at('/drive?org=org-1', {
        'GET api/drive?org=org-1&parent=': () => list([folder]),
        'GET api/drive/root/archive?org=org-1&check=1': () => { throw new WorkspaceApiError('Drive has no files to download yet.', 409, {}); },
        'GET api/drive/folder-1/archive?org=org-1&check=1': () => ({ fileName: 'Brand assets.zip', sizeBytes: 1342, files: 1 }),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Download all' }));
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Drive has no files to download yet.');
      expect(saved.list).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Manage Brand assets' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Download as .zip' }));
      await waitFor(() => expect(saved.list).toEqual([{ href: '/workspace/api/drive/folder-1/archive?org=org-1', download: 'Brand assets.zip' }]));
    } finally { saved.restore(); }
  });

  it('draws a folder walked back into at once, and refreshes it underneath', async () => {
    const test = at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list([folder]),
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brand assets/ }));
    expect(await screen.findByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
    const inside = (): number => test.calls.filter((call) => call.path === 'api/drive?org=org-1&parent=folder-1').length;
    const read = inside();
    fireEvent.click(screen.getByRole('navigation', { name: 'Folder path' }).querySelector('a')!);
    expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    // The tap and the list land in the same tick: nothing is drawn over what
    // this tab already read, so there is no flash to see on the way back in.
    fireEvent.click(screen.getByRole('link', { name: /Brand assets/ }));
    expect(screen.getByRole('heading', { name: 'Brand assets' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
    expect(screen.queryByText('Loading Drive…')).toBeNull();
    // And it is still read again underneath, so a file an agent added while
    // the reader was one folder up appears without them asking.
    await waitFor(() => expect(inside()).toBe(read + 1));
  });

  it('keeps a folder’s name and trail on the screen while its first contents load', async () => {
    let land: (listing: DriveListing) => void = () => {};
    const first = new Promise<DriveListing>((resolve) => { land = resolve; });
    at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list([folder]),
      'GET api/drive?org=org-1&parent=folder-1': () => first,
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brand assets/ }));
    // Never read, so there is no list to draw — but the row that was tapped
    // already said what this folder is called and where it sits.
    expect(screen.getByRole('heading', { name: 'Brand assets' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain('Brand assets');
    land(list([file], { folder, breadcrumbs: [folder] }));
    expect(await screen.findByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
  });

  it('opens a file on what the listing already said and waits only for the preview', async () => {
    const test = at('/drive/folders/folder-1?org=org-1', {
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
      'GET api/drive/file-1?org=org-1': () => ({ item: file, breadcrumbs: [folder], canDeleteForever: true }),
      'GET api/drive/file-1/preview?org=org-1': () => ({ kind: 'pdf', url: 'https://files.test/brief.pdf', expiresAt: signedUntil(15) }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brief.pdf/ }));
    expect(screen.getByRole('heading', { name: 'Brief.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain('Brand assets');
    expect(await screen.findByTitle('Preview of Brief.pdf')).toBeTruthy();
    // Back to the folder, and into the file again: its preview signature is
    // good for another quarter of an hour, so it is not asked for a second
    // time — a fresh signature would reload the frame in front of the reader.
    fireEvent.click(screen.getByRole('navigation', { name: 'Folder path' }).querySelectorAll('a')[1]!);
    fireEvent.click(await screen.findByRole('link', { name: /Brief.pdf/ }));
    expect(screen.getByTitle('Preview of Brief.pdf')).toBeTruthy();
    expect(test.calls.filter((call) => call.path.endsWith('/preview?org=org-1'))).toHaveLength(1);
  });

  it('reads a preview again once its signature has run out', async () => {
    let signature = signedUntil(-1);
    const test = at('/drive/folders/folder-1?org=org-1', {
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
      'GET api/drive/file-1?org=org-1': () => ({ item: file, breadcrumbs: [folder], canDeleteForever: true }),
      'GET api/drive/file-1/preview?org=org-1': () => ({ kind: 'pdf', url: `https://files.test/brief.pdf?sig=${signature}`, expiresAt: signature }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brief.pdf/ }));
    await screen.findByTitle('Preview of Brief.pdf');
    signature = signedUntil(15);
    fireEvent.click(screen.getByRole('navigation', { name: 'Folder path' }).querySelectorAll('a')[1]!);
    fireEvent.click(await screen.findByRole('link', { name: /Brief.pdf/ }));
    // An expired signature is not a stale answer, it is a broken one: it is
    // never put on the screen, and the read that replaces it is made.
    await waitFor(() => expect(screen.getByTitle('Preview of Brief.pdf').getAttribute('src')).toContain(signature));
    expect(test.calls.filter((call) => call.path.endsWith('/preview?org=org-1'))).toHaveLength(2);
  });

  it('absorbs a refresh that fails rather than putting an alert over the list', async () => {
    let reads = 0;
    at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => {
        reads += 1;
        if (reads > 1) throw new WorkspaceApiError('The server did not answer.', 503, {});
        return list([folder]);
      },
    });
    expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    fireEvent.focus(window);
    // One attempt, not the ladder: nobody is waiting on this read, so it is
    // over as soon as it has failed.
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('link', { name: /Brand assets/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('takes a folder off the screen when the server refuses it', async () => {
    let gone = false;
    at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => {
        if (gone) throw new WorkspaceApiError('No such folder.', 404, {});
        gone = true;
        return list([folder]);
      },
    });
    expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    fireEvent.focus(window);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No such folder.Try again');
    expect(screen.queryByRole('link', { name: /Brand assets/ })).toBeNull();
  });

  it('forgets every held listing after a write, without blinking the one it was made from', async () => {
    let made = false;
    at('/drive?org=org-1', {
      'GET api/drive?org=org-1&parent=': () => list(made ? [folder, { ...folder, id: 'folder-2', name: 'Contracts' }] : [folder]),
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
      'POST api/drive/folders?org=org-1': () => { made = true; return { item: folder }; },
    });
    fireEvent.click(await screen.findByRole('link', { name: /Brand assets/ }));
    expect(await screen.findByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('navigation', { name: 'Folder path' }).querySelector('a')!);
    expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Contracts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    // The screen the write was made from keeps drawing its own last answer and
    // refreshes underneath, so nothing blinks where the reader is looking.
    expect(await screen.findByRole('link', { name: /Contracts/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Brand assets/ })).toBeTruthy();
    // But the folder held from before the write is read again rather than
    // drawn from a copy that predates it — its counts alone are now wrong.
    fireEvent.click(screen.getByRole('link', { name: /Brand assets/ }));
    expect(screen.queryByRole('link', { name: /Brief.pdf/ })).toBeNull();
    expect(await screen.findByRole('link', { name: /Brief.pdf/ })).toBeTruthy();
  });

  it('opens from a tap on the Home card however soon after Home is drawn (note #678)', async () => {
    // Home writes its half into its own address. As a passive effect that
    // write ran a frame after the card was on screen, and a tap inside that
    // frame pushed Drive only for the write to replace it with Home again —
    // on a slow CI host, the flake that took main red. Tapped from the very
    // mutation that draws the card, before any passive effect can run.
    let tapped = false;
    const tap = new MutationObserver(() => {
      const link = document.querySelector('#driveCard a');
      if (link && !tapped) { tapped = true; fireEvent.click(link); }
    });
    tap.observe(document.body, { childList: true, subtree: true });
    try {
      fromHome({ 'GET api/drive?org=org-1&parent=': () => list([folder]) });
      await waitFor(() => expect(tapped).toBe(true));
      expect(await screen.findByRole('link', { name: /Brand assets/ })).toBeTruthy();
    } finally {
      tap.disconnect();
    }
  });

  it('is one place in the history: Back leaves it for Home, however deep the walk', async () => {
    fromHome({
      'GET api/drive?org=org-1&parent=': () => list([folder]),
      'GET api/drive?org=org-1&parent=folder-1': () => list([file], { folder, breadcrumbs: [folder] }),
      'GET api/drive/file-1?org=org-1': () => ({ item: file, breadcrumbs: [folder], canDeleteForever: true }),
      'GET api/drive/file-1/preview?org=org-1': () => ({ kind: 'unsupported' }),
    });
    // Home calls it by its name, which is also the word on every screen
    // inside it and on the first segment of every trail. (Its line said
    // "Shared across all rooms" until rooms left the product — note #843.)
    const card = (await screen.findByText('Shared across the workplace')).closest('.card')!;
    expect(card.querySelector('.name')!.textContent).toBe('Drive');
    fireEvent.click(card.querySelector('a')!);
    fireEvent.click(await screen.findByRole('link', { name: /Brand assets/ }));
    fireEvent.click(await screen.findByRole('link', { name: /Brief.pdf/ }));
    expect(await screen.findByRole('heading', { name: 'Brief.pdf' })).toBeTruthy();
    // A folder deep and inside a file, and the way back up is on the screen:
    // the trail, not the header. So Back spends the ONE entry Drive made when
    // it was opened, and the reader is out in a single tap.
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain('Brand assets');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Shared across the workplace')).toBeTruthy();
    expect(document.getElementById('screenDriveFile')).toBeNull();
  });
});
