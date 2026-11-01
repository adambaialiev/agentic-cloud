import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import {
  ORG_MEDIA_CREDS_SECRET,
  OrgMediaError,
  OrgMediaService,
  OrgRoutedMediaStorage,
  orgMediaAddOnName,
} from '../../services/org-media.js';
import type { MediaStorage } from '../../services/media-storage.js';

function fakeStorage(label: string): MediaStorage & { label: string; calls: string[] } {
  const calls: string[] = [];
  return {
    label,
    calls,
    createUploadTarget: vi.fn(async () => { calls.push('createUploadTarget'); return { uploadUrl: `${label}-up`, expiresAt: 'x' }; }),
    uploadObject: vi.fn(async () => { calls.push('uploadObject'); }),
    createReadAccess: vi.fn(async () => { calls.push('createReadAccess'); return { url: `${label}-read`, expiresAt: 'x' }; }),
    downloadObject: vi.fn(async () => { calls.push('downloadObject'); return Buffer.from(label); }),
    setMetadata: vi.fn(async () => { calls.push('setMetadata'); }),
    deleteObject: vi.fn(async () => { calls.push('deleteObject'); }),
    deleteObjectsWithPrefix: vi.fn(async () => { calls.push('deleteObjectsWithPrefix'); }),
  };
}

async function build(args?: {
  flyConnected?: boolean;
  withPointer?: boolean;
  credsLost?: boolean;
  secretWriteFails?: boolean;
  /** The Fly org this org resolves to. `ours` is the platform's own — org #0. */
  flyOrgSlug?: string;
}) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin-1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'member-1', role: 'member' });
  // A workplace with a cloud of its own carries the pointer; one without is
  // HOSTED on ours (note #664) and rides the platform store.
  if (args?.flyConnected !== false) {
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: args?.flyOrgSlug ?? 'acme', tokenSecretName: 'FLY_ORG_TOKEN' },
    });
  }
  if (args?.withPointer) {
    await orgStorage.updateOrg(org.orgId, {
      media: { addOnName: orgMediaAddOnName(org.orgId), bucket: 'pointed-bkt', endpoint: 'https://t3.storage.dev' },
    });
  }
  const secrets = new Map<string, string>();
  if (args?.withPointer && !args.credsLost) {
    secrets.set(`${org.orgId}:${ORG_MEDIA_CREDS_SECRET}`, JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }));
  }
  const platform = fakeStorage('platform');
  const orgBucketStorages: Array<ReturnType<typeof fakeStorage>> = [];
  const fly = {
    resolveOrganizationId: vi.fn(async () => 'org_gql_id'),
    createTigrisBucket: vi.fn(async () => ({
      bucket: 'fresh-bucket', endpoint: 'https://t3.storage.dev', accessKeyId: 'NEWAK', secretAccessKey: 'NEWSK', region: 'auto',
    })),
    deleteAddOn: vi.fn(async () => {}),
  };
  const service = new OrgMediaService({
    orgStorage,
    orgSecrets: {
      setOrgSecret: vi.fn(async (orgId: string, name: string, value: string) => {
        if (args?.secretWriteFails) throw new Error('secret store down');
        secrets.set(`${orgId}:${name}`, value);
      }),
      getOrgSecret: vi.fn(async (orgId: string, name: string) => secrets.get(`${orgId}:${name}`) ?? null),
    } as never,
    orgFly: {
      resolveOrgFlyContext: vi.fn(async () => (args?.flyConnected !== false
        ? { source: 'org' as const, orgSlug: args?.flyOrgSlug ?? 'acme', apiToken: 't' }
        : { source: 'platform-env' as const, orgSlug: 'ours', apiToken: 'seed' })),
    } as never,
    platformStorage: platform,
    platformFlyOrgSlug: 'ours',
    makeFlyClient: () => fly as never,
    makeStorage: (cfg) => {
      const storage = fakeStorage(`org:${cfg.bucket}`);
      orgBucketStorages.push(storage);
      return storage;
    },
  });
  const routed = new OrgRoutedMediaStorage(service, platform);
  return { service, routed, org, orgStorage, platform, fly, secrets, orgBucketStorages };
}

describe('OrgMediaService + OrgRoutedMediaStorage', () => {
  it('a pre-org owner rides the platform store on every verb — the org #0 shape, byte-identical', async () => {
    const { routed, platform } = await build();
    await routed.uploadObject({ storagePath: 'users/stranger-1/notes/n1/a1/f.png', contentType: 'image/png', data: Buffer.from('x') });
    const read = await routed.createReadAccess({ storagePath: 'users/stranger-1/notes/n1/a1/f.png' });
    expect(read.url).toBe('platform-read');
    await routed.deleteObjectsWithPrefix({ prefix: 'users/stranger-1/notes/n1/' });
    expect(platform.calls).toEqual(['uploadObject', 'createReadAccess', 'deleteObjectsWithPrefix']);
  });

  it('a path outside users/<owner> rides the platform store rather than guessing', async () => {
    const { routed, platform } = await build();
    await routed.downloadObject({ storagePath: 'turn-io/whatever.json' });
    expect(platform.calls).toEqual(['downloadObject']);
  });

  it("a member's first upload provisions the org bucket ONCE — mint-once keys stored, pointer written, then cached", async () => {
    const { routed, org, orgStorage, fly, secrets, orgBucketStorages, platform } = await build();
    await routed.uploadObject({ storagePath: 'users/member-1/sessions/s1/files/f1/a.jpg', contentType: 'image/jpeg', data: Buffer.from('x') });
    // The org-namespaced owner (PR attachments on a stamped org) resolves to the SAME org and reuses the bucket.
    await routed.uploadObject({ storagePath: `users/${org.orgId}/prs/p1/a1/shot.png`, contentType: 'image/png', data: Buffer.from('y') });
    expect(fly.createTigrisBucket).toHaveBeenCalledTimes(1);
    expect(fly.createTigrisBucket).toHaveBeenCalledWith({ organizationId: 'org_gql_id', name: orgMediaAddOnName(org.orgId) });
    expect(JSON.parse(secrets.get(`${org.orgId}:${ORG_MEDIA_CREDS_SECRET}`) ?? '{}')).toEqual({ accessKeyId: 'NEWAK', secretAccessKey: 'NEWSK' });
    expect((await orgStorage.getOrg(org.orgId))?.media?.bucket).toBe('fresh-bucket');
    expect(orgBucketStorages).toHaveLength(1);
    expect(orgBucketStorages[0].calls).toEqual(['uploadObject', 'uploadObject']);
    expect(platform.calls).toEqual([]);
  });

  it('two concurrent first uploads mint ONE bucket, not two', async () => {
    const { routed, fly } = await build();
    await Promise.all([
      routed.uploadObject({ storagePath: 'users/member-1/notes/n1/a1/a.png', contentType: 'image/png', data: Buffer.from('a') }),
      routed.uploadObject({ storagePath: 'users/member-1/notes/n1/a2/b.png', contentType: 'image/png', data: Buffer.from('b') }),
    ]);
    expect(fly.createTigrisBucket).toHaveBeenCalledTimes(1);
  });

  it('a failed secret write DELETES the fresh bucket rather than stranding one nobody can sign for', async () => {
    const { routed, fly, orgStorage, org } = await build({ secretWriteFails: true });
    await expect(routed.uploadObject({
      storagePath: 'users/member-1/notes/n1/a1/a.png', contentType: 'image/png', data: Buffer.from('a'),
    })).rejects.toThrow('secret store down');
    expect(fly.deleteAddOn).toHaveBeenCalledWith(orgMediaAddOnName(org.orgId));
    expect((await orgStorage.getOrg(org.orgId))?.media).toBeUndefined();
  });

  it('an org with a pointer serves reads from ITS bucket, rebuilt from the stored keys — platform untouched', async () => {
    const { routed, platform, orgBucketStorages, fly } = await build({ withPointer: true });
    const read = await routed.createReadAccess({ storagePath: 'users/member-1/notes/n1/a1/f.png' });
    expect(read.url).toBe('org:pointed-bkt-read');
    expect(platform.calls).toEqual([]);
    expect(fly.createTigrisBucket).not.toHaveBeenCalled();
    expect(orgBucketStorages).toHaveLength(1);
  });

  it("an old room's namespace routes to its org's bucket — never the silent platform fallback (notes #85, #843)", async () => {
    const { routed, org, orgStorage, platform, orgBucketStorages } = await build({ withPointer: true });
    // Files saved in a room before the rooms were merged keep the room's old
    // owner prefix; the merge recorded that namespace on the workplace.
    await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['room-math'] } });

    const read = await routed.createReadAccess({ storagePath: 'users/room-math/notes/n1/a1/f.png' });
    expect(read.url).toBe('org:pointed-bkt-read');
    expect(platform.calls).toEqual([]);
    expect(orgBucketStorages).toHaveLength(1);
  });

  it('a pointer whose credentials secret is missing fails LOUDLY — never the platform fallback', async () => {
    const { routed } = await build({ withPointer: true, credsLost: true });
    await expect(routed.createReadAccess({ storagePath: 'users/member-1/notes/n1/a1/f.png' }))
      .rejects.toThrow(OrgMediaError);
  });

  it('an org with no Fly connection of its own rides the platform store, even on writes', async () => {
    const { routed, platform, fly } = await build({ flyConnected: false });
    await routed.uploadObject({ storagePath: 'users/member-1/notes/n1/a1/a.png', contentType: 'image/png', data: Buffer.from('a') });
    expect(fly.createTigrisBucket).not.toHaveBeenCalled();
    expect(platform.calls).toEqual(['uploadObject']);
  });

  // The regression this file was missing. Org #0 has a Fly pointer like any
  // client — at OUR OWN Fly org — so it resolved `source: 'org'` and its first
  // upload minted it a bucket, wrote the pointer, and orphaned every
  // attachment already in MinIO. Reads answered 404 across a fortnight of
  // notes and proposals before anyone noticed.
  it('an org running in OUR OWN Fly org is us, not a client — no bucket, ever', async () => {
    const { routed, platform, fly, org, orgStorage } = await build({ flyOrgSlug: 'ours' });
    await routed.uploadObject({ storagePath: 'users/member-1/notes/n1/a1/a.png', contentType: 'image/png', data: Buffer.from('a') });
    await routed.uploadObject({ storagePath: `users/${org.orgId}/prs/p1/a1/shot.png`, contentType: 'image/png', data: Buffer.from('b') });
    expect(fly.createTigrisBucket).not.toHaveBeenCalled();
    // No pointer written, so nothing can orphan the bytes already in there.
    expect((await orgStorage.getOrg(org.orgId))?.media).toBeUndefined();
    expect(platform.calls).toEqual(['uploadObject', 'uploadObject']);
  });

  it('reads NEVER provision — a connected org with no pointer reads from the platform store', async () => {
    const { routed, platform, fly } = await build();
    await routed.downloadObject({ storagePath: 'users/member-1/sessions/s1/files/f1/a.jpg' });
    expect(fly.createTigrisBucket).not.toHaveBeenCalled();
    expect(platform.calls).toEqual(['downloadObject']);
  });
});
