import { describe, expect, it, vi } from 'vitest';
import {
  extractOutboundAttachments,
  fetchOutboundAttachment,
  getStageableHarnessAttachments,
  stageHarnessAttachments,
} from '../../agent/harness-attachments.js';
import type { AttachmentRecord } from '../../types/tools.js';
import type { MediaStorage } from '../../services/media-storage.js';
import {
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
} from '../mocks/fake-workspace-runtime-client.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

function makeRecord(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    fileId: 'file_1_abc',
    url: 'https://storage.example/cached',
    storagePath: 'users/u1/sessions/s1/file_1_abc/report.csv',
    fileName: 'photo_abc.jpg',
    displayName: 'report.csv',
    contentType: 'text/csv',
    mediaKind: 'document',
    renderAs: 'document',
    sizeBytes: 12_800,
    visibility: 'session',
    source: 'user_input',
    use: 'sandbox_input',
    ...overrides,
  } as AttachmentRecord;
}

function makeMediaStorage(url = 'https://storage.example/signed'): MediaStorage {
  return {
    uploadObject: vi.fn(),
    createReadAccess: vi.fn().mockResolvedValue({ url }),
  } as unknown as MediaStorage;
}

/** The staged-files payload the on-machine node script would receive. */
function decodeStagedFiles(command: string): Array<{ path: string; url: string; expectedSizeBytes?: number }> {
  const match = /PATCH_TOOL_PAYLOAD_B64='([^']+)'/.exec(command);
  expect(match).not.toBeNull();
  return JSON.parse(Buffer.from(match![1], 'base64').toString('utf8')).files;
}

describe('getStageableHarnessAttachments', () => {
  it('keeps sandbox_input and legacy model_input; drops voice (user_visible)', () => {
    const records = [
      makeRecord({ use: 'sandbox_input' }),
      makeRecord({ use: 'model_input' }),
      makeRecord({ use: 'user_visible' }),
    ];
    expect(getStageableHarnessAttachments(records)).toHaveLength(2);
    expect(getStageableHarnessAttachments(undefined)).toEqual([]);
  });
});

describe('stageHarnessAttachments', () => {
  it('stages files into ~/inbox/<date> via a fresh signed URL and describes them for the prompt', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const mediaStorage = makeMediaStorage();

    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [makeRecord()],
      mediaStorage,
      now: NOW,
    });

    expect(client.execSyncCalls).toHaveLength(1);
    const call = client.execSyncCalls[0];
    expect(call.sandboxId).toBe('sb-1');
    expect(call.sshUser).toBe('agent');
    const files = decodeStagedFiles(call.command);
    expect(files).toEqual([{
      path: '/home/agent/inbox/2026-07-17/report.csv',
      url: 'https://storage.example/signed',
      expectedSizeBytes: 12_800,
    }]);

    expect(note).toContain('saved on this machine');
    expect(note).toContain('/home/agent/inbox/2026-07-17/report.csv (13 kB)');
    expect(note).not.toContain('could not be delivered');
  });

  it('dedupes same-named files within one batch', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [
        makeRecord({ fileId: 'file_1_a', displayName: 'photo.jpg' }),
        makeRecord({ fileId: 'file_2_b', displayName: 'photo.jpg' }),
      ],
      mediaStorage: makeMediaStorage(),
      now: NOW,
    });

    const files = decodeStagedFiles(client.execSyncCalls[0].command);
    expect(files.map((file) => file.path)).toEqual([
      '/home/agent/inbox/2026-07-17/photo.jpg',
      '/home/agent/inbox/2026-07-17/photo-2.jpg',
    ]);
    expect(note).toContain('photo-2.jpg');
  });

  it('sanitizes hostile display names and falls back to the fileId', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [
        makeRecord({ displayName: '../../../etc/passwd' }),
        makeRecord({ fileId: 'file_9_zz', displayName: '###', fileName: '' }),
      ],
      mediaStorage: makeMediaStorage(),
      now: NOW,
    });

    const files = decodeStagedFiles(client.execSyncCalls[0].command);
    // basename() strips the traversal; leading dots are trimmed.
    expect(files[0].path).toBe('/home/agent/inbox/2026-07-17/passwd');
    expect(files[1].path).toBe('/home/agent/inbox/2026-07-17/file_9_zz.bin');
  });

  it('falls back to the recorded URL when the signed-URL refresh fails', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const mediaStorage = {
      uploadObject: vi.fn(),
      createReadAccess: vi.fn().mockRejectedValue(new Error('storage down')),
    } as unknown as MediaStorage;

    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [makeRecord({ url: 'https://storage.example/cached' })],
      mediaStorage,
      now: NOW,
    });

    expect(decodeStagedFiles(client.execSyncCalls[0].command)[0].url).toBe('https://storage.example/cached');
    expect(note).toContain('saved on this machine');
  });

  it('degrades to a delivery-failure note (no exec) when no URL is available at all', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [makeRecord({ url: '' })],
      now: NOW,
    });

    expect(client.execSyncCalls).toHaveLength(0);
    expect(note).toContain('report.csv');
    expect(note).toContain('could not be delivered');
  });

  it('degrades to a delivery-failure note when the on-machine fetch fails, and never throws', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1, stderr: 'download returned HTTP 403' });

    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [makeRecord()],
      mediaStorage: makeMediaStorage(),
      now: NOW,
    });

    expect(note).toContain('report.csv');
    expect(note).toContain('could not be delivered');
    expect(note).not.toContain('saved on this machine');
  });

  it('stages a large set in batches, so one failed batch loses only its own files (note #672)', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const commands: string[] = [];
    client.execSyncHandler = (command) => {
      commands.push(command);
      return commands.length === 2
        ? makeExecSyncResult({ exitCode: 1, stderr: 'download returned HTTP 500' })
        : makeExecSyncResult({ stdout: 'ok\n' });
    };
    const attachments = Array.from({ length: 45 }, (_, i) => makeRecord({
      fileId: `file_${i + 1}`, displayName: `shot-${i + 1}.png`, storagePath: `users/u1/agent-chats/a1/file_${i + 1}/shot-${i + 1}.png`,
    }));

    const note = await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments,
      mediaStorage: makeMediaStorage(),
      now: NOW,
    });

    expect(commands.map((command) => decodeStagedFiles(command).length)).toEqual([20, 20, 5]);
    const failed = decodeStagedFiles(commands[1]!).map((file) => file.path.split('/').pop());
    expect(note).toContain('saved on this machine');
    expect(note!.split('\n').filter((line) => line.startsWith('- /home/agent/inbox/'))).toHaveLength(25);
    expect(note).toContain(`could not be delivered`);
    for (const name of failed) expect(note).toContain(name);
  });

  it('returns null for an empty list', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    expect(await stageHarnessAttachments({
      sandboxClient: client,
      sandboxId: 'sb-1',
      sshUser: 'agent',
      homeDir: '/home/agent',
      sessionId: 'session-1',
      attachments: [],
      now: NOW,
    })).toBeNull();
  });
});


describe('extractOutboundAttachments', () => {
  it('strips line-anchored ATTACH: markers and collects their paths', () => {
    const { text, paths } = extractOutboundAttachments(
      'Here is the report you asked for.\n\nATTACH: /home/agent/report.pdf\nATTACH: ~/site/logo.png\n\nLet me know!',
    );
    expect(paths).toEqual(['/home/agent/report.pdf', '~/site/logo.png']);
    expect(text).toBe('Here is the report you asked for.\n\nLet me know!');
  });

  it('leaves mid-line mentions of ATTACH: alone', () => {
    const input = 'Use the ATTACH: convention like this: put ATTACH: /path on its own line.';
    const { text, paths } = extractOutboundAttachments(input);
    expect(paths).toEqual([]);
    expect(text).toBe(input);
  });
});

describe('fetchOutboundAttachment', () => {
  it('fetches a size-gated file as bytes (tilde expanded to the home dir)', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => {
      if (command.startsWith('wc -c')) {
        expect(command).toContain("'/home/agent/out/report.pdf'");
        return makeExecSyncResult({ stdout: '11\n' });
      }
      expect(command).toContain('base64');
      return makeExecSyncResult({ stdout: Buffer.from('hello bytes').toString('base64') });
    };
    const fetched = await fetchOutboundAttachment(client, 'sb-1', '~/out/report.pdf', { homeDir: '/home/agent' });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.fileName).toBe('report.pdf');
      expect(Buffer.from(fetched.content).toString()).toBe('hello bytes');
    }
  });

  it('rejects oversized and missing files with visible reasons', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: `${100 * 1024 * 1024}\n` });
    const big = await fetchOutboundAttachment(client, 'sb-1', '/home/agent/huge.zip');
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toBe('it is 100.0 MB, and a file sent into the chat can be up to 45.0 MB');

    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1, stderr: 'No such file' });
    const missing = await fetchOutboundAttachment(client, 'sb-1', '/home/agent/gone.txt');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('not found');
  });

  it('sends a big file from the machine straight into storage when it is given somewhere to put it (note #943)', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const commands: string[] = [];
    client.execSyncHandler = (command) => {
      commands.push(command);
      return makeExecSyncResult({ stdout: command.startsWith('wc -c') ? `${300 * 1024 * 1024}\n` : '' });
    };
    const targets: Array<{ fileName: string; contentType: string }> = [];
    const sent = await fetchOutboundAttachment(client, 'sb-1', '~/films/cut.mp4', {
      homeDir: '/home/agent',
      upload: async (args) => { targets.push(args); return { id: 'f-1', uploadUrl: 'https://store.example/put?sig=1' }; },
    });
    expect(sent).toEqual({ ok: true, fileName: 'cut.mp4', sizeBytes: 300 * 1024 * 1024, uploadId: 'f-1' });
    expect(targets).toEqual([{ fileName: 'cut.mp4', contentType: 'video/mp4' }]);
    // Two commands: the size, then the machine's own PUT — never base64 back here.
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe("curl -sS -f -X PUT -H 'Content-Type: video/mp4' --upload-file '/home/agent/films/cut.mp4' 'https://store.example/put?sig=1'");
    expect(commands.join('\n')).not.toContain('base64');

    // A small one still comes back inline, and past 5 GB the reason has the number.
    client.execSyncHandler = (command) => makeExecSyncResult({ stdout: command.startsWith('wc -c') ? '6\n' : Buffer.from('hello\n').toString('base64') });
    const small = await fetchOutboundAttachment(client, 'sb-1', '/home/agent/a.txt', { upload: async () => { throw new Error('not for small files'); } });
    expect(small.ok && small.content && Buffer.from(small.content).toString()).toBe('hello\n');
    client.execSyncHandler = () => makeExecSyncResult({ stdout: `${6 * 1024 ** 3}\n` });
    const huge = await fetchOutboundAttachment(client, 'sb-1', '/home/agent/disk.img', { upload: async () => ({ id: 'x', uploadUrl: 'u' }) });
    expect(huge.ok ? '' : huge.reason).toBe('it is 6.0 GB, and a file sent into the chat can be up to 5.0 GB');
  });
});
