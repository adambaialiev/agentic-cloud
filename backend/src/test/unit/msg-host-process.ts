import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
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
  stop(): Promise<void>;
  exited: Promise<number | null>;
}

export async function startMsgHost(options: { orgId: string; dbPath?: string; idleMs?: number; secret?: string }): Promise<MsgHostProcess> {
  const port = await freePort();
  const secret = options.secret ?? 'test-secret';
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: String(port), MSG_HOST_SECRET: secret, MSG_HOST_ORG: options.orgId,
      MSG_HOST_DB: options.dbPath ?? ':memory:', MSG_HOST_IDLE_MS: String(options.idleMs ?? 0),
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
  return {
    origin, secret, exited,
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
