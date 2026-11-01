import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryMediaStorage } from '../../services/memory-media-storage.js';
import { ChatFileUploadError, ChatFileUploads } from '../../services/chat-file-uploads.js';
import {
  AGENT_CHAT_FILE_MAX_BYTES,
  agentChatAttachmentPath,
  agentChatStoragePrefix,
  storeAgentChatUploads,
  validateAgentChatAttachment,
} from '../../services/agent-chat-storage.js';
import { UPLOAD_PART_BYTES } from '../../shared/uploads.js';
import { MATERIALIZE_SANDBOX_REMOTE_FILES_SCRIPT, PATCH_TOOL_PAYLOAD_ENV } from '../../agent/tool-executor.js';
import { stageTimeoutMs } from '../../agent/harness-attachments.js';

/**
 * Note #943: a chat file has no product cap. The owner tried a 38.4 MB file
 * and was told "Chat files are up to 25 MB"; now a big file goes up in parts,
 * the message names it, and the agent's machine streams it to disk.
 */
const place = {
  prefix: agentChatStoragePrefix('org-1', 'agent-a'),
  path: (id: string, name: string) => agentChatAttachmentPath('org-1', 'agent-a', id, name),
};

/** A PNG header that says 640×480, then `size` bytes in all. */
function png(size: number): Buffer {
  const data = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(data, 0);
  data.writeUInt32BE(640, 16);
  data.writeUInt32BE(480, 20);
  return data;
}

async function sendInParts(uploads: ChatFileUploads, fileName: string, data: Buffer) {
  const started = await uploads.start({ fileName, sizeBytes: data.length, contentType: 'image/png' });
  const parts = [];
  for (let n = 1; n <= started.parts; n += 1) {
    parts.push(await uploads.part(started.id, {
      uploadId: started.uploadId, fileName, partNumber: n,
      data: data.subarray((n - 1) * started.partBytes, n * started.partBytes),
    }));
  }
  return uploads.complete(started.id, { uploadId: started.uploadId, fileName, parts });
}

describe('chat files in parts (note #943)', () => {
  it('has no 25 MB rule any more: the only ceiling is the parts protocol’s, said with its number', () => {
    expect(validateAgentChatAttachment({ fileName: 'film.mp4', sizeBytes: 40_265_318 })).toBeNull();
    expect(validateAgentChatAttachment({ fileName: 'film.mp4', sizeBytes: 5 * 1024 ** 3 })).toBeNull();
    expect(AGENT_CHAT_FILE_MAX_BYTES).toBe(UPLOAD_PART_BYTES * 10_000);
    expect(validateAgentChatAttachment({ fileName: 'disk.img', sizeBytes: 80 * 1024 ** 3 }))
      .toBe('A chat file can be up to 78 GB — this one is 80 GB.');
  });

  it('takes a 30 MB file in 8 MB parts, and a message names it: real size and picture size from the store', async () => {
    const media = new MemoryMediaStorage();
    const uploads = new ChatFileUploads(media, place);
    const data = png(30 * 1024 * 1024);
    const done = await sendInParts(uploads, 'board.png', data);
    expect(done).toMatchObject({ fileName: 'board.png', sizeBytes: data.length });
    expect(media.objects.get(place.path(done.id, 'board.png'))!.data.equals(data)).toBe(true);

    const [stored] = await storeAgentChatUploads(media, [{ fileName: 'board.png', contentType: 'image/png', uploadId: done.id }], place.path);
    expect(stored!.file).toEqual({
      id: done.id, fileName: 'board.png', contentType: 'image/png', sizeBytes: data.length,
      width: 640, height: 480, storagePath: place.path(done.id, 'board.png'),
    });
    // Only bytes this server saw whole carry a digest; the machine checks a
    // parted file by its size.
    expect(stored!.sha256).toBeUndefined();
  });

  it('refuses a message naming a file that never finished, and takes away only what that request wrote', async () => {
    const media = new MemoryMediaStorage();
    const earlier = place.path('11111111-1111-4111-8111-111111111111', 'old.txt');
    await media.uploadObject({ storagePath: earlier, contentType: 'text/plain', data: Buffer.from('kept') });
    await expect(storeAgentChatUploads(media, [
      { fileName: 'note.txt', data: Buffer.from('inline') },
      { fileName: 'film.mp4', uploadId: '22222222-2222-4222-8222-222222222222' },
    ], place.path)).rejects.toThrow('One of those files did not finish uploading. Nothing was sent — send it again.');
    // The inline file is gone again; a file an earlier row shows is not touched.
    expect([...media.objects.keys()]).toEqual([earlier]);
  });

  it('keeps every upload under its own conversation and refuses what the protocol cannot carry', async () => {
    const media = new MemoryMediaStorage();
    const uploads = new ChatFileUploads(media, place);
    await expect(uploads.start({ fileName: 'a b.png', sizeBytes: 10 })).rejects.toBeInstanceOf(ChatFileUploadError);
    await expect(uploads.start({ fileName: 'disk.img', sizeBytes: 80 * 1024 ** 3 })).rejects.toMatchObject({ status: 413 });
    await expect(uploads.part('../../etc', { uploadId: 'x', fileName: 'a.png', partNumber: 1, data: Buffer.alloc(1) }))
      .rejects.toMatchObject({ status: 404 });
    const started = await uploads.start({ fileName: 'a.bin', sizeBytes: 3 * UPLOAD_PART_BYTES });
    await expect(uploads.part(started.id, { uploadId: started.uploadId, fileName: 'a.bin', partNumber: 1, data: Buffer.alloc(UPLOAD_PART_BYTES + 1) }))
      .rejects.toMatchObject({ status: 413 });
    await uploads.abort(started.id, { uploadId: started.uploadId, fileName: 'a.bin' });
    expect(media.uploads.size).toBe(0);
  });
});

describe('the agent machine receives a big file by streaming it to disk (note #943)', () => {
  const run = (payload: unknown) => execFileSync(process.execPath, ['--input-type=module', '-e', MATERIALIZE_SANDBOX_REMOTE_FILES_SCRIPT], {
    env: { ...process.env, [PATCH_TOOL_PAYLOAD_ENV]: Buffer.from(JSON.stringify(payload)).toString('base64') },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  it('writes it whole, checks size and digest, and says plainly when the disk has no room', () => {
    const dir = mkdtempSync(join(tmpdir(), 'materialize-'));
    try {
      const source = join(dir, 'source.bin');
      const data = Buffer.alloc(20 * 1024 * 1024, 3);
      writeFileSync(source, data);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const url = pathToFileURL(source).href;
      expect(run({ files: [{ path: join(dir, 'inbox', 'a.bin'), url, expectedSizeBytes: data.length, sha256 }], successMessage: 'ok\n' })).toBe('ok\n');
      expect(readFileSync(join(dir, 'inbox', 'a.bin')).equals(data)).toBe(true);

      expect(() => run({ files: [{ path: join(dir, 'inbox', 'b.bin'), url, expectedSizeBytes: data.length, sha256: '00' }] }))
        .toThrow(/sha256 mismatch/);
      expect(() => run({ files: [{ path: join(dir, 'inbox', 'c.bin'), url, expectedSizeBytes: 900 * 1024 ** 4 }] }))
        .toThrow(/no room on this machine: the file is 921600\.0 GB and the disk has [\d.]+ GB free/);
      // Nothing half-written is left behind.
      expect(readdirSync(join(dir, 'inbox'))).toEqual(['a.bin']);
      expect(existsSync(join(dir, 'inbox', 'b.bin'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a big batch time for its bytes, past the two-minute floor', () => {
    expect(stageTimeoutMs(0)).toBe(120_000);
    expect(stageTimeoutMs(1024 ** 3)).toBe(120_000 + 256_000);
  });
});
