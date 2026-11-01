import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { ObjectStorageService } from '../../services/object-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryStorageBucketStorage } from '../../services/storage-bucket-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { bucketPublicUrl, bucketSecretNames } from '../../types/storage-bucket.js';
import type { WorkspaceBucketRow, WorkspaceBucketUsageAnswer, WorkspaceStateAnswer } from '../../shared/workspace-api.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * A bucket's own page (note #778) reads two things the list did not carry:
 * where a public bucket's files are read from and which secrets hold its
 * keys (names only), on the state read; and what it holds, on demand.
 */
describe('bucketPublicUrl', () => {
  it('is the bucket’s own host under the endpoint’s, for a public bucket only', () => {
    expect(bucketPublicUrl({ public: true, bucket: 'iabkt-547027dcc674', endpoint: 'https://fly.storage.tigris.dev' }))
      .toBe('https://iabkt-547027dcc674.fly.storage.tigris.dev');
    expect(bucketPublicUrl({ public: false, bucket: 'iabkt-1', endpoint: 'https://fly.storage.tigris.dev' })).toBeNull();
    expect(bucketPublicUrl({ public: true, bucket: 'iabkt-1', endpoint: 'not a url' })).toBeNull();
  });
});

describe('a bucket on the Workspace’s reads (note #778)', () => {
  let server: Server;
  let origin: string;
  const secrets = new Map<string, string>();
  const headers = workspaceTestHeaders(42);
  const read = <T>(path: string) => fetch(`${origin}/workspace/api/${path}`, { headers }).then(async (res) => ({ status: res.status, body: await res.json() as T }));

  beforeEach(async () => {
    const users = new InMemoryUserStorage();
    const orgs = new InMemoryOrgStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    const orgId = (await orgs.createOrg({ name: 'Demonstrations', createdByUserId: 'alice' })).orgId;
    await orgs.addMember({ orgId, userId: 'alice', role: 'admin' });
    await orgs.setActiveOrg('alice', orgId);
    const storage = new InMemoryStorageBucketStorage();
    const objectStorage = new ObjectStorageService({
      storage,
      resolveHostingContext: async () => ({ source: 'platform', orgSlug: 'p', apiToken: 't' }),
      makeFlyClient: () => ({}) as never,
      secrets: {
        save: async (ns, name, value) => { secrets.set(`${ns}/${name}`, value); },
        remove: async (ns, name) => { secrets.delete(`${ns}/${name}`); },
        read: async (ns, name) => secrets.get(`${ns}/${name}`) ?? null,
      },
      makeObjects: () => ({ usage: async () => ({ bytes: 2048, objects: 3, truncated: false }), empty: async () => undefined, setCors: async () => undefined }),
      caps: { hostedBucketLimit: 3, hostedBucketGb: 10 },
      log: () => undefined,
    });
    for (const [name, isPublic] of [['bishkek-3d-tiles', true], ['demo-files', false]] as const) {
      const secretNames = bucketSecretNames(name);
      for (const secret of Object.values(secretNames)) secrets.set(`ns-workplace/${secret}`, `value-of-${secret}`);
      await storage.create({
        orgId, userId: 'alice', secretsNamespaceId: 'ns-workplace',
        createdBy: { agentId: 'caleb', agentName: 'Caleb' },
        name, addOnName: `addon-${name}`, bucket: `iabkt-${name}`, endpoint: 'https://fly.storage.tigris.dev',
        region: 'auto', public: isPublic, secretNames, hostedOn: 'platform', flyOrgSlug: 'p', status: 'live',
      });
    }
    // The private bucket's keys are gone: its count cannot be read.
    for (const secret of Object.values(bucketSecretNames('demo-files'))) secrets.delete(`ns-workplace/${secret}`);
    const deps: Partial<RouteDeps> = { userStorage: users, orgStorage: orgs, objectStorage };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice' });
    const app = express(); app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    secrets.clear();
  });

  it('the state read names a public bucket’s address and its four secrets — and never a value', async () => {
    const { body } = await read<WorkspaceStateAnswer>('state');
    const rows = new Map((body.buckets ?? []).map((row: WorkspaceBucketRow) => [row.name, row]));
    expect(rows.get('bishkek-3d-tiles')).toMatchObject({
      public: true,
      publicUrl: 'https://iabkt-bishkek-3d-tiles.fly.storage.tigris.dev',
      secretNames: ['BISHKEK_3D_TILES_S3_ENDPOINT', 'BISHKEK_3D_TILES_S3_BUCKET', 'BISHKEK_3D_TILES_S3_ACCESS_KEY_ID', 'BISHKEK_3D_TILES_S3_SECRET_ACCESS_KEY'],
    });
    expect(rows.get('demo-files')!.publicUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('value-of-');
  });

  it('usage answers what a bucket holds, nothing when its keys are gone, and 404 for a stranger’s name', async () => {
    expect(await read<WorkspaceBucketUsageAnswer>('storage/bishkek-3d-tiles/usage')).toEqual({ status: 200, body: { usage: { bytes: 2048, objects: 3, truncated: false } } });
    expect(await read<WorkspaceBucketUsageAnswer>('storage/demo-files/usage')).toEqual({ status: 200, body: {} });
    expect((await read('storage/nope/usage')).status).toBe(404);
  });
});
