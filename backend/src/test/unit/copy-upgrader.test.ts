import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureCopyUpgrader, UPGRADER_SECRET_NAMES, upgraderAppName } from '../../services/copy-upgrader.js';
import { FlyApiError, FlyClient } from '../../services/fly-client.js';

const ENV = {
  FLY_API_TOKEN: 'FlyV1 org-token',
  BACKUP_S3_ENDPOINT: 'https://fly.storage.tigris.dev',
  BACKUP_S3_BUCKET: 'theirco-backups',
  BACKUP_S3_ACCESS_KEY_ID: 'tid_x',
  BACKUP_S3_SECRET_ACCESS_KEY: 'tsec_x',
};

function fakeFly({ exists = false } = {}) {
  const apps = new Set<string>(exists ? ['theirco-upgrader'] : []);
  const secrets: Record<string, string> = {};
  return {
    apps,
    secrets,
    fly: {
      getApp: async (name: string) => {
        if (!apps.has(name)) throw new FlyApiError('Fly API error (404): app not found', 404);
        return { name } as never;
      },
      createApp: async ({ appName }: { appName: string }) => { apps.add(appName); },
      setAppSecret: async (_app: string, name: string, value: string) => { secrets[name] = value; },
    },
  };
}

describe('the upgrader app of a company\'s own Agentic Cloud (note #1008)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is named from the copy\'s prefix', () => {
    expect(upgraderAppName('theirco')).toBe('theirco-upgrader');
  });

  it('is made when missing and given the token and the backup bucket\'s keys', async () => {
    const f = fakeFly();
    const lines: string[] = [];
    const result = await ensureCopyUpgrader({ prefix: 'theirco', org: 'theirco-org', env: ENV, fly: f.fly, log: (line) => lines.push(line) });
    expect(result).toEqual({ ok: true, app: 'theirco-upgrader', created: true });
    expect(f.apps.has('theirco-upgrader')).toBe(true);
    expect(Object.keys(f.secrets).sort()).toEqual([...UPGRADER_SECRET_NAMES].sort());
    expect(f.secrets.BACKUP_S3_BUCKET).toBe('theirco-backups');
    // The log names the app and how many, never a value.
    expect(lines.join('\n')).not.toContain('org-token');
    expect(lines.join('\n')).not.toContain('tsec_x');
  });

  it('keeps an app that exists and sets the secrets again, so a rotated key arrives', async () => {
    const f = fakeFly({ exists: true });
    const result = await ensureCopyUpgrader({ prefix: 'theirco', org: 'theirco-org', env: { ...ENV, FLY_API_TOKEN: 'FlyV1 rotated' }, fly: f.fly, log: () => {} });
    expect(result).toEqual({ ok: true, app: 'theirco-upgrader', created: false });
    expect(f.secrets.FLY_API_TOKEN).toBe('FlyV1 rotated');
  });

  it('makes nothing when the backup bucket is not set up, and says which settings are missing', async () => {
    const f = fakeFly();
    const lines: string[] = [];
    const result = await ensureCopyUpgrader({ prefix: 'theirco', org: 'theirco-org', env: { FLY_API_TOKEN: 'FlyV1 x' }, fly: f.fly, log: (line) => lines.push(line) });
    expect(result.ok).toBe(false);
    expect(f.apps.size).toBe(0);
    expect(lines[0]).toContain('BACKUP_S3_ENDPOINT');
  });

  it('sets a secret without reading Fly\'s answer, which echoes the value back', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ name: 'FLY_API_TOKEN', value: 'FlyV1 org-token' }), { status: 201 });
    });
    await new FlyClient('FlyV1 org-token', 'https://api.machines.test/v1').setAppSecret('theirco-upgrader', 'FLY_API_TOKEN', 'FlyV1 org-token');
    expect(calls[0].url).toBe('https://api.machines.test/v1/apps/theirco-upgrader/secrets/FLY_API_TOKEN');
    expect(JSON.parse(calls[0].body)).toEqual({ value: 'FlyV1 org-token' });
  });

  it('says only the status when Fly refuses, never the value', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"nope","value":"FlyV1 org-token"}', { status: 403 }));
    const refused = new FlyClient('FlyV1 org-token', 'https://api.machines.test/v1').setAppSecret('theirco-upgrader', 'FLY_API_TOKEN', 'FlyV1 org-token');
    await expect(refused).rejects.toThrow('Fly API error (403) setting secret FLY_API_TOKEN on theirco-upgrader');
    await refused.catch((error: Error) => expect(error.message).not.toContain('org-token'));
  });
});
