import { describe, expect, it, vi } from 'vitest';
import { ObjectStorageError, ObjectStorageService, PUBLIC_CORS_RULES } from '../../services/object-storage.js';
import { InMemoryStorageBucketStorage } from '../../services/storage-bucket-storage.js';
import { bucketSecretNames, validateBucketName } from '../../types/storage-bucket.js';

/**
 * Object storage (note #768): a bucket is minted in the workplace's hosting
 * account, its keys — which Fly hands out exactly once — are saved as room
 * secrets BEFORE anything else is recorded, and a creation that cannot save
 * them deletes the bucket again. Caps apply to hosted workplaces only, public
 * is a flag the record carries, and deleting is an ask until the owner acts.
 */
function build(options: {
  source?: 'platform' | 'org';
  secretFailsOn?: string;
  objects?: { bytes: number; objects: number; truncated: boolean };
  corsFails?: boolean;
  caps?: { hostedBucketLimit: number; hostedBucketGb: number };
} = {}) {
  const calls: string[] = [];
  const saved = new Map<string, { value: string; description: string }>();
  let minted = 0;
  const fly = {
    resolveOrganizationId: vi.fn(async (slug: string) => `org-id-${slug}`),
    createTigrisBucket: vi.fn(async (args: { organizationId: string; name: string; public?: boolean }) => {
      minted += 1;
      calls.push(`create:${args.name}:${args.public ? 'public' : 'private'}`);
      return {
        bucket: `tigris-${minted}`,
        endpoint: 'https://fly.storage.tigris.dev',
        accessKeyId: `AKIA${minted}`,
        secretAccessKey: `SECRET${minted}`,
        region: 'auto',
      };
    }),
    deleteAddOn: vi.fn(async (name: string) => { calls.push(`delete-addon:${name}`); }),
  };
  const storage = new InMemoryStorageBucketStorage();
  const service = new ObjectStorageService({
    storage,
    resolveHostingContext: async () => ({ source: options.source ?? 'platform', orgSlug: 'infinite-agents', apiToken: 'tok' }),
    makeFlyClient: () => fly,
    secrets: {
      save: async (ns, name, value, description) => {
        if (options.secretFailsOn === name) throw new Error('cupboard locked');
        calls.push(`save:${ns}:${name}`);
        saved.set(`${ns}/${name}`, { value, description });
      },
      remove: async (ns, name) => { calls.push(`remove:${ns}:${name}`); saved.delete(`${ns}/${name}`); },
      read: async (ns, name) => saved.get(`${ns}/${name}`)?.value ?? null,
    },
    makeObjects: (args) => ({
      usage: async () => options.objects ?? { bytes: 0, objects: 0, truncated: false },
      empty: async () => { calls.push('empty'); },
      setCors: async (rules) => {
        if (options.corsFails) throw new Error('PutBucketCors refused');
        calls.push(`cors:${args.bucket}:${rules[0]!.AllowedOrigins.join(',')}:${rules[0]!.AllowedMethods.join(',')}`);
      },
    }),
    caps: options.caps ?? { hostedBucketLimit: 3, hostedBucketGb: 10 },
    log: () => undefined,
  });
  const owner = { orgId: 'org-1', userId: 'user-1', roomId: 'room-1', secretsNamespaceId: 'ns-room-1', agentId: 'agent-a', agentName: 'Ben', roomName: 'Platform' };
  return { service, storage, fly, calls, saved, owner };
}

describe('bucket names and secret names', () => {
  it('accepts plain lowercase names and refuses the rest', () => {
    expect(validateBucketName('user-uploads')).toBeNull();
    expect(validateBucketName('abc')).toBeNull();
    for (const bad of ['ab', 'Uploads', '-uploads', 'uploads-', 'a--b', 'has_underscore', 'x'.repeat(33)]) {
      expect(validateBucketName(bad), bad).not.toBeNull();
    }
  });

  it('derives four environment-variable names from the bucket name', () => {
    expect(bucketSecretNames('user-uploads')).toEqual({
      endpoint: 'USER_UPLOADS_S3_ENDPOINT',
      bucket: 'USER_UPLOADS_S3_BUCKET',
      accessKeyId: 'USER_UPLOADS_S3_ACCESS_KEY_ID',
      secretAccessKey: 'USER_UPLOADS_S3_SECRET_ACCESS_KEY',
    });
  });
});

describe('ObjectStorageService.create', () => {
  it('saves the keys as four described room secrets before the record exists, and the record names them', async () => {
    const { service, calls, saved, owner } = build();
    const doc = await service.create({ ...owner, name: 'user-uploads', public: false });

    expect(doc.status).toBe('live');
    expect(doc.public).toBe(false);
    expect(doc.bucket).toBe('tigris-1');
    expect(doc.hostedOn).toBe('platform');
    expect(doc.addOnName).toMatch(/^iabkt-[0-9a-f]{12}$/);
    expect(doc.secretNames).toEqual(bucketSecretNames('user-uploads'));
    // The keys are exactly what Fly handed out, and every secret has a sentence.
    expect(saved.get('ns-room-1/USER_UPLOADS_S3_ACCESS_KEY_ID')?.value).toBe('AKIA1');
    expect(saved.get('ns-room-1/USER_UPLOADS_S3_SECRET_ACCESS_KEY')?.value).toBe('SECRET1');
    expect(saved.get('ns-room-1/USER_UPLOADS_S3_BUCKET')?.value).toBe('tigris-1');
    expect(saved.get('ns-room-1/USER_UPLOADS_S3_ENDPOINT')?.value).toBe('https://fly.storage.tigris.dev');
    for (const entry of saved.values()) expect(entry.description).toMatch(/user-uploads/);
    // Order: mint, then the four saves; the record is not in this list because
    // it is written last.
    expect(calls[0]).toMatch(/^create:iabkt-/);
    expect(calls.slice(1)).toEqual([
      'save:ns-room-1:USER_UPLOADS_S3_ENDPOINT',
      'save:ns-room-1:USER_UPLOADS_S3_BUCKET',
      'save:ns-room-1:USER_UPLOADS_S3_ACCESS_KEY_ID',
      'save:ns-room-1:USER_UPLOADS_S3_SECRET_ACCESS_KEY',
    ]);
    // Nothing on the record holds a key.
    expect(JSON.stringify(doc)).not.toContain('AKIA1');
    expect(JSON.stringify(doc)).not.toContain('SECRET1');
  });

  it('a failed secret write deletes the bucket, forgets what was saved, and records nothing', async () => {
    const { service, storage, calls, saved, owner } = build({ secretFailsOn: 'USER_UPLOADS_S3_ACCESS_KEY_ID' });
    await expect(service.create({ ...owner, name: 'user-uploads', public: false })).rejects.toThrow('cupboard locked');

    expect(calls.filter((c) => c.startsWith('delete-addon:'))).toHaveLength(1);
    expect(saved.size).toBe(0);
    expect(await storage.listAll()).toEqual([]);
  });

  it('public is a flag Fly is told about and the record carries', async () => {
    const { service, fly, owner } = build();
    const doc = await service.create({ ...owner, name: 'photos', public: true });
    expect(doc.public).toBe(true);
    expect(fly.createTigrisBucket).toHaveBeenCalledWith(expect.objectContaining({ public: true }));
    const quiet = await service.create({ ...owner, name: 'drafts', public: false });
    expect(fly.createTigrisBucket).toHaveBeenLastCalledWith(expect.objectContaining({ public: false }));
    expect(quiet.public).toBe(false);
  });

  it('a public bucket gets its CORS rule at creation — every origin, GET and HEAD — and a private one does not (note #770)', async () => {
    const { service, calls, owner } = build();
    const open = await service.create({ ...owner, name: 'photos', public: true });
    expect(calls).toContain(`cors:${open.bucket}:*:GET,HEAD`);
    // The rule is stored with the keys Fly handed out, before the record.
    expect(calls.indexOf(`cors:${open.bucket}:*:GET,HEAD`)).toBeGreaterThan(calls.indexOf('save:ns-room-1:PHOTOS_S3_SECRET_ACCESS_KEY'));
    expect(PUBLIC_CORS_RULES[0]!.MaxAgeSeconds).toBeGreaterThan(0); // Tigris refuses a rule without it
    calls.length = 0;
    await service.create({ ...owner, name: 'drafts', public: false });
    expect(calls.some((c) => c.startsWith('cors:'))).toBe(false);
  });

  it('a public bucket whose rule cannot be stored is not created: add-on and secrets unwound', async () => {
    const { service, storage, calls, saved, owner } = build({ corsFails: true });
    await expect(service.create({ ...owner, name: 'photos', public: true })).rejects.toThrow('PutBucketCors refused');
    expect(calls.filter((c) => c.startsWith('delete-addon:'))).toHaveLength(1);
    expect(saved.size).toBe(0);
    expect(await storage.listAll()).toEqual([]);
  });

  it('ensurePublicCors re-applies the rule to a public bucket and refuses a private one', async () => {
    const { service, calls, owner } = build();
    const open = await service.create({ ...owner, name: 'photos', public: true });
    const closed = await service.create({ ...owner, name: 'drafts', public: false });
    calls.length = 0;
    await service.ensurePublicCors(open);
    expect(calls).toEqual([`cors:${open.bucket}:*:GET,HEAD`]);
    await expect(service.ensurePublicCors(closed)).rejects.toThrow(/private/);
  });

  it('refuses past the hosted ceiling in plain words, and never mints', async () => {
    const { service, fly, owner } = build({ caps: { hostedBucketLimit: 2, hostedBucketGb: 10 } });
    await service.create({ ...owner, name: 'one', public: false });
    await service.create({ ...owner, name: 'two', public: false });
    const error = await service.create({ ...owner, name: 'three', public: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ObjectStorageError);
    expect((error as ObjectStorageError).status).toBe(403);
    expect((error as Error).message).toMatch(/2 of 2 buckets/);
    expect(fly.createTigrisBucket).toHaveBeenCalledTimes(2);
  });

  it('a workplace whose connected Fly org is the platform\'s own counts as hosted: capped, and marked so', async () => {
    const { service, owner } = build({ source: 'org', caps: { hostedBucketLimit: 1, hostedBucketGb: 10 } });
    // build() resolves to orgSlug 'infinite-agents'; the platform's slug is the same.
    const platformService = new ObjectStorageService({
      ...(service as unknown as { deps: ConstructorParameters<typeof ObjectStorageService>[0] }).deps,
      platform: { orgSlug: 'infinite-agents', apiToken: 'tok' },
    });
    const doc = await platformService.create({ ...owner, name: 'one', public: false });
    expect(doc.hostedOn).toBe('platform');
    await expect(platformService.create({ ...owner, name: 'two', public: false })).rejects.toThrow(/1 of 1 buckets/);
  });

  it('a workplace on its own cloud has no ceiling', async () => {
    const { service, owner } = build({ source: 'org', caps: { hostedBucketLimit: 1, hostedBucketGb: 10 } });
    await service.create({ ...owner, name: 'one', public: false });
    const second = await service.create({ ...owner, name: 'two', public: false });
    expect(second.hostedOn).toBe('org');
  });

  it('refuses a bad name, a name already in use, and a name whose secrets already exist', async () => {
    const { service, owner, saved } = build();
    await expect(service.create({ ...owner, name: 'Bad Name', public: false })).rejects.toThrow(/3–32 characters/);
    await service.create({ ...owner, name: 'taken', public: false });
    await expect(service.create({ ...owner, name: 'taken', public: false })).rejects.toThrow(/already a bucket/);
    saved.set('ns-room-1/OTHER_S3_BUCKET', { value: 'x', description: 'someone else’s' });
    await expect(service.create({ ...owner, name: 'other', public: false })).rejects.toThrow(/OTHER_S3_BUCKET already exists/);
  });
});

describe('ObjectStorageService: delete asks, the owner destroys', () => {
  it('askDelete records the request and destroys nothing', async () => {
    const { service, storage, calls, owner } = build();
    const doc = await service.create({ ...owner, name: 'user-uploads', public: false });
    const asked = await service.askDelete(doc.id, { agentId: 'agent-a', userId: 'user-1' });
    expect(asked.deleteAsk).toMatchObject({ byAgentId: 'agent-a', byUserId: 'user-1' });
    expect(asked.status).toBe('live');
    expect(calls.some((c) => c.startsWith('delete-addon:') || c === 'empty')).toBe(false);
    expect((await storage.get(doc.id))!.status).toBe('live');
    await service.keep(doc.id);
    expect((await storage.get(doc.id))!.deleteAsk).toBeUndefined();
  });

  it('destroy empties the bucket, removes the add-on and the four secrets, and keeps a tombstone', async () => {
    const { service, storage, calls, saved, owner } = build();
    const doc = await service.create({ ...owner, name: 'user-uploads', public: false });
    calls.length = 0;
    await service.destroy(doc.id);

    expect(calls[0]).toBe('empty');
    expect(calls[1]).toBe(`delete-addon:${doc.addOnName}`);
    expect(calls.filter((c) => c.startsWith('remove:'))).toHaveLength(4);
    expect(saved.size).toBe(0);
    const after = (await storage.get(doc.id))!;
    expect(after.status).toBe('destroyed');
    expect(await service.getLive({ orgId: 'org-1', userId: 'user-1' }, 'user-uploads')).toBeNull();
    // The name is free again.
    await expect(service.create({ ...owner, name: 'user-uploads', public: false })).resolves.toMatchObject({ status: 'live' });
  });

  it('usage reads with the bucket’s own keys, and says when it stopped early', async () => {
    const { service, owner } = build({ objects: { bytes: 2048, objects: 2, truncated: true } });
    const doc = await service.create({ ...owner, name: 'user-uploads', public: false });
    expect(await service.usage(doc)).toEqual({ bytes: 2048, objects: 2, truncated: true });
  });

  it('releaseAll (a deleted workplace) removes hosted buckets, leaves own-cloud ones, forgets every record', async () => {
    const hosted = build();
    const doc = await hosted.service.create({ ...hosted.owner, name: 'ours', public: false });
    // One in the workplace's own cloud: same storage, different context.
    await hosted.storage.create({ ...doc, name: 'theirs', addOnName: 'iabkt-theirs', hostedOn: 'org', flyOrgSlug: 'acme' } as never);
    const result = await hosted.service.releaseAll('org-1');
    expect(result).toEqual({ destroyed: ['ours'], left: ['theirs'] });
    expect(await hosted.storage.listAll()).toEqual([]);
    expect(hosted.calls).toContain(`delete-addon:${doc.addOnName}`);
    expect(hosted.calls).not.toContain('delete-addon:iabkt-theirs');
  });
});
