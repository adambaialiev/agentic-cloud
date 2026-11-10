import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgMsgHostRefusal } from '../../services/org-msg-host.js';

/** The REAL messaging-host server (infra/msg-host/msg-host.mjs), as a child
 * process — the same file the image ships, so tests prove the actual bytes. */
const SERVER = fileURLToPath(new URL('../../../../infra/msg-host/msg-host.mjs', import.meta.url));

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

export interface MsgHostProcess {
  origin: string;
  secret: string;
  /** What `OrgMsgHostService.call` does once the machine is up. */
  call<T>(orgId: string, operation: string, body: Record<string, unknown>): Promise<T>;
  /** What `OrgMsgHostService.upload` / `download` do once the machine is up (note #1125). */
  upload<T>(orgId: string, meta: Record<string, unknown>, bytes: Buffer): Promise<T>;
  download(orgId: string, body: Record<string, unknown>): Promise<{ meta: unknown; size: number; body: ReadableStream<Uint8Array> } | null>;
  filesDir: string;
  stop(): Promise<void>;
  exited: Promise<number | null>;
}

export async function startMsgHost(options: { orgId: string; dbPath?: string; idleMs?: number; secret?: string; filesDir?: string; reserveBytes?: number; maxFileBytes?: number }): Promise<MsgHostProcess> {
  const port = await freePort();
  const secret = options.secret ?? 'test-secret';
  const filesDir = options.filesDir ?? mkdtempSync(join(tmpdir(), 'msg-host-files-'));
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: String(port), MSG_HOST_SECRET: secret, MSG_HOST_ORG: options.orgId,
      MSG_HOST_DB: options.dbPath ?? ':memory:', MSG_HOST_IDLE_MS: String(options.idleMs ?? 0), MSG_HOST_FILES: filesDir,
      ...(options.reserveBytes !== undefined ? { MSG_HOST_RESERVE_BYTES: String(options.reserveBytes) } : {}),
      ...(options.maxFileBytes !== undefined ? { MSG_HOST_MAX_FILE_BYTES: String(options.maxFileBytes) } : {}),
    },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error('the messaging host did not start');
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const headers = (orgId: string) => ({ 'x-msg-host-secret': secret, 'x-msg-host-org': orgId });
  return {
    origin, secret, exited, filesDir,
    async upload<T>(orgId: string, meta: Record<string, unknown>, bytes: Buffer): Promise<T> {
      const res = await fetch(`${origin}/v1/upload`, {
        method: 'POST', body: new Blob([new Uint8Array(bytes)]),
        headers: { ...headers(orgId), 'content-type': 'application/octet-stream', 'x-msg-file': encodeURIComponent(JSON.stringify(meta)) },
      });
      const answer = await res.json() as T & { error?: string };
      if (!res.ok) throw new OrgMsgHostRefusal(res.status, answer.error ?? 'refused');
      return answer;
    },
    async download(orgId: string, body: Record<string, unknown>) {
      const res = await fetch(`${origin}/v1/file`, { method: 'POST', headers: { ...headers(orgId), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 404) { await res.body?.cancel(); return null; }
      if (!res.ok || !res.body) throw new OrgMsgHostRefusal(res.status, ((await res.json()) as { error?: string }).error ?? 'refused');
      return { meta: JSON.parse(decodeURIComponent(res.headers.get('x-msg-file') ?? '')), size: Number(res.headers.get('content-length')), body: res.body };
    },
    async call<T>(orgId: string, operation: string, body: Record<string, unknown>): Promise<T> {
      const res = await fetch(`${origin}/v1/${operation}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-msg-host-secret': secret, 'x-msg-host-org': orgId }, body: JSON.stringify(body),
      });
      const answer = await res.json() as T & { error?: string };
      if (!res.ok) throw new OrgMsgHostRefusal(res.status, answer.error ?? 'refused');
      return answer;
    },
    async stop() { child.kill('SIGTERM'); await exited; },
  };
}
