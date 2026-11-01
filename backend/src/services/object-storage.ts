import { randomBytes } from 'node:crypto';
import { DeleteObjectsCommand, ListObjectsV2Command, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { FlyClient } from './fly-client.js';
import type { StorageBucketStorage } from './storage-bucket-storage.js';
import {
  bucketIsLive,
  bucketSecretNames,
  validateBucketName,
  type StorageBucketDocument,
} from '../types/storage-bucket.js';

/**
 * Object storage for agents and sites (note #768): `agentbuilt storage
 * create <name>` mints one Tigris bucket, S3-compatible, in the workplace's
 * Fly account — the platform's own for a hosted workplace (note #664), the
 * connected one otherwise — the same path the workplace's attachment bucket
 * takes (org-media.ts), with its one trap kept: the S3 keys come back exactly
 * once, in Fly's create response, so they are written to the workplace's secret
 * store before anything else is recorded, and a creation whose secret write
 * fails deletes the bucket rather than stranding keys nobody holds.
 *
 * The keys reach the agent's next turn as environment variables, like every
 * workplace secret (note #783), and any site via `agentbuilt deploy --secret NAME`. They are
 * never in a reply, a record or a log.
 *
 * Private by default: a bucket answers its keys only. `public` makes its
 * objects readable by anyone with the URL (what an app serving user uploads
 * wants), which is said plainly in the reply and shown on the Workspace.
 *
 * Deleting is not an agent verb: `askDelete` records the request, and the
 * owner decides it on the Workspace, where `destroy` empties the bucket and
 * removes the add-on and the four secrets.
 */

/** The S3 side of a bucket, narrowed to what this service needs. */
export interface BucketObjects {
  /** Bytes and objects in it; `truncated` when the walk stopped early. */
  usage(): Promise<{ bytes: number; objects: number; truncated: boolean }>;
  /** Delete every object, so the add-on can go. */
  empty(): Promise<void>;
  /** Store the bucket's CORS rules (PutBucketCors). */
  setCors(rules: typeof PUBLIC_CORS_RULES): Promise<void>;
}

/**
 * What a PUBLIC bucket answers a page with (note #770): any origin may GET
 * and HEAD, with the headers a browser needs to read a response. Tigris
 * honours `*` and REQUIRES `MaxAgeSeconds` above zero (a rule without it is
 * refused with "Max-age must be greater than zero"), and a stored rule takes
 * minutes to reach every edge — which is why the first report read as "the
 * rule is stored but GET sends nothing". Set at creation so no agent has to
 * know any of this; `ensurePublicCors` re-applies it to an older bucket.
 */
export const PUBLIC_CORS_RULES = [{
  AllowedOrigins: ['*'],
  AllowedMethods: ['GET', 'HEAD'],
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges', 'Last-Modified'],
  MaxAgeSeconds: 86400,
}];

export interface ObjectStorageCaps {
  /** Live buckets a hosted workplace may hold. */
  hostedBucketLimit: number;
  /** What each may grow to, in GB — reported against, not enforced. */
  hostedBucketGb: number;
}

export interface ObjectStorageDeps {
  storage: StorageBucketStorage;
  /** Where this workplace's infrastructure is built (OrgFlyService.resolveHostingContext). */
  resolveHostingContext: (orgId: string) => Promise<{ source: 'platform' | 'org'; orgSlug: string; apiToken: string }>;
  /**
   * The platform's own account: where a legacy org-less account's bucket
   * goes, and the slug that marks a workplace as OURS even when its record
   * names a connected Fly org — the owner's own workplace does (org-media.ts
   * learned this the hard way), and its buckets are hosted ones with the
   * hosted caps, not a customer's. Absent → an org-less account is refused.
   */
  platform?: { orgSlug: string; apiToken: string };
  makeFlyClient?: (apiToken: string) => Pick<FlyClient, 'resolveOrganizationId' | 'createTigrisBucket' | 'deleteAddOn'>;
  /** The workplace's secret store (named by a namespace, mapped by the store to the workplace's): save with a one-sentence description; remove. */
  secrets: {
    save: (namespaceId: string, name: string, value: string, description: string) => Promise<void>;
    remove: (namespaceId: string, name: string) => Promise<void>;
    read: (namespaceId: string, name: string) => Promise<string | null>;
  };
  /** Injectable for tests; defaults to a real S3 client on the bucket. */
  makeObjects?: (args: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) => BucketObjects;
  caps: ObjectStorageCaps;
  log?: (message: string) => void;
}

export interface CreateBucketArgs {
  orgId: string | null;
  userId: string;
  secretsNamespaceId: string;
  agentId: string;
  agentName?: string;
  name: string;
  public: boolean;
}

export class ObjectStorageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ObjectStorageError';
  }
}

/** How far a usage walk goes before it says "at least": 20 pages of 1,000 keys. */
const USAGE_MAX_PAGES = 20;

export class ObjectStorageService {
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ObjectStorageDeps) {
    this.log = deps.log ?? ((m) => console.log(`[storage] ${m}`));
  }

  get caps(): ObjectStorageCaps {
    return this.deps.caps;
  }

  /** The workplace's buckets (org-less: the user's), live first, newest first. */
  async list(owner: { orgId: string | null; userId: string }): Promise<StorageBucketDocument[]> {
    const docs = owner.orgId
      ? await this.deps.storage.listByOrg(owner.orgId)
      : await this.deps.storage.listByUser(owner.userId);
    return docs
      .filter(bucketIsLive)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getLive(owner: { orgId: string | null; userId: string }, name: string): Promise<StorageBucketDocument | null> {
    return this.deps.storage.getLiveByName(owner, name);
  }

  /**
   * Mint the bucket: name checked, cap checked, add-on created, the four
   * secrets written, THEN the record. Anything failing after the add-on
   * exists removes it again.
   */
  async create(args: CreateBucketArgs): Promise<StorageBucketDocument> {
    const nameError = validateBucketName(args.name);
    if (nameError) throw new ObjectStorageError(nameError);
    const owner = { orgId: args.orgId, userId: args.userId };
    if (await this.deps.storage.getLiveByName(owner, args.name)) {
      throw new ObjectStorageError(`"${args.name}" is already a bucket here. \`agentbuilt storage show ${args.name}\` says what it holds.`);
    }
    const context = await this.hostingContext(args.orgId);
    if (context.source === 'platform') {
      const live = (await this.list(owner)).length;
      if (live >= this.deps.caps.hostedBucketLimit) {
        throw new ObjectStorageError(
          `This workplace already has ${live} of ${this.deps.caps.hostedBucketLimit} buckets, which is the ceiling for a workplace `
          + 'on the platform\'s cloud. Reuse one of them (a folder prefix inside a bucket is free), or ask your user to have one deleted first.',
          403,
        );
      }
    }
    const secretNames = bucketSecretNames(args.name);
    for (const secretName of Object.values(secretNames)) {
      if (await this.deps.secrets.read(args.secretsNamespaceId, secretName)) {
        throw new ObjectStorageError(
          `A secret named ${secretName} already exists in this workplace, and this bucket's keys would be saved under that name. Choose another bucket name, or remove that secret first.`,
          409,
        );
      }
    }

    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(context.apiToken);
    const organizationId = await client.resolveOrganizationId(context.orgSlug);
    const addOnName = `iabkt-${randomBytes(6).toString('hex')}`;
    const created = await client.createTigrisBucket({ organizationId, name: addOnName, public: args.public });
    const visibility = args.public ? 'public: objects are readable by anyone with the URL' : 'private: keys only';
    try {
      // Secrets first — the keys exist nowhere else — then the record.
      const descriptions: Record<keyof typeof secretNames, string> = {
        endpoint: `S3 endpoint of the ${args.name} bucket (${visibility}), minted by agentbuilt storage create.`,
        bucket: `S3 bucket name of the ${args.name} bucket (${visibility}), minted by agentbuilt storage create.`,
        accessKeyId: `S3 access key id for the ${args.name} bucket (${visibility}); its keys are handed out once at creation.`,
        secretAccessKey: `S3 secret access key for the ${args.name} bucket (${visibility}); its keys are handed out once at creation.`,
      };
      const values: Record<keyof typeof secretNames, string> = {
        endpoint: created.endpoint,
        bucket: created.bucket,
        accessKeyId: created.accessKeyId,
        secretAccessKey: created.secretAccessKey,
      };
      for (const key of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
        await this.deps.secrets.save(args.secretsNamespaceId, secretNames[key], values[key], descriptions[key]);
      }
      // A public bucket exists to be read from pages: its CORS rule is part
      // of creating it, and a bucket that cannot take one is not created.
      if (args.public) {
        await (this.deps.makeObjects ?? s3BucketObjects)({
          endpoint: created.endpoint,
          region: created.region,
          bucket: created.bucket,
          accessKeyId: created.accessKeyId,
          secretAccessKey: created.secretAccessKey,
        }).setCors(PUBLIC_CORS_RULES);
      }
      const doc = await this.deps.storage.create({
        orgId: args.orgId,
        userId: args.userId,
        secretsNamespaceId: args.secretsNamespaceId,
        createdBy: {
          agentId: args.agentId,
          ...(args.agentName ? { agentName: args.agentName } : {}),
        },
        name: args.name,
        addOnName,
        bucket: created.bucket,
        endpoint: created.endpoint,
        region: created.region,
        public: args.public,
        secretNames,
        hostedOn: context.source,
        flyOrgSlug: context.orgSlug,
        status: 'live',
      });
      this.log(`created ${args.public ? 'public' : 'private'} bucket ${created.bucket} (${args.name}) for ${args.orgId ?? args.userId} in ${context.orgSlug}`);
      return doc;
    } catch (error) {
      // Unwind both halves best-effort: nothing may be left that the record
      // does not know about.
      await client.deleteAddOn(addOnName).catch(() => undefined);
      for (const secretName of Object.values(secretNames)) {
        await this.deps.secrets.remove(args.secretsNamespaceId, secretName).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * (Re)apply the public rule to a bucket made before creation set it, or
   * whose rule somebody replaced. Refused for a private bucket: a browser
   * cannot read one anyway, and the rule would only mislead.
   */
  async ensurePublicCors(doc: StorageBucketDocument): Promise<void> {
    if (!doc.public) throw new ObjectStorageError(`"${doc.name}" is private: a page cannot read it, so there is no CORS rule to set. Create a public bucket for what a page fetches.`);
    const objects = await this.objectsOf(doc);
    if (!objects) throw new ObjectStorageError(`The keys of "${doc.name}" are no longer in the workplace's secrets, so its rule cannot be set from here.`, 409);
    await objects.setCors(PUBLIC_CORS_RULES);
    this.log(`public CORS rule applied to ${doc.bucket} (${doc.name})`);
  }

  /** What the bucket holds, read with its own keys; null when the keys are gone. */
  async usage(doc: StorageBucketDocument): Promise<{ bytes: number; objects: number; truncated: boolean } | null> {
    const objects = await this.objectsOf(doc);
    if (!objects) return null;
    return objects.usage();
  }

  /** Record the ask; newest wins. Nothing is destroyed here. */
  async askDelete(id: string, by: { agentId: string; userId: string }): Promise<StorageBucketDocument> {
    const doc = await this.deps.storage.get(id);
    if (!doc || !bucketIsLive(doc)) throw new ObjectStorageError('No such bucket.', 404);
    await this.deps.storage.update(id, {
      deleteAsk: { byAgentId: by.agentId, byUserId: by.userId, at: new Date().toISOString() },
    });
    return (await this.deps.storage.get(id))!;
  }

  async keep(id: string): Promise<void> {
    await this.deps.storage.update(id, { deleteAsk: undefined });
  }

  /**
   * The owner's decision: empty the bucket, remove the add-on, forget the
   * four secrets, keep the record as a tombstone. Emptying first is what
   * makes the add-on delete succeed on a bucket with objects in it; a bucket
   * whose keys are already gone is removed as it stands.
   */
  async destroy(id: string): Promise<void> {
    const doc = await this.deps.storage.get(id);
    if (!doc || !bucketIsLive(doc)) return;
    const objects = await this.objectsOf(doc);
    if (objects) {
      await objects.empty().catch((error: Error) => this.log(`emptying ${doc.bucket} failed (${error.message}); deleting the add-on anyway`));
    }
    const context = await this.hostingContext(doc.orgId).catch(() => null);
    if (context) {
      const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(context.apiToken);
      await client.deleteAddOn(doc.addOnName);
    } else {
      this.log(`add-on ${doc.addOnName} left: its account cannot be reached`);
    }
    for (const secretName of Object.values(doc.secretNames)) {
      await this.deps.secrets.remove(doc.secretsNamespaceId, secretName).catch(() => undefined);
    }
    await this.deps.storage.update(id, { status: 'destroyed', destroyedAt: new Date().toISOString(), deleteAsk: undefined });
    this.log(`destroyed bucket ${doc.bucket} (${doc.name})`);
  }

  /**
   * A deleted workplace (note #768 closes what deleting-a-client-org left
   * open for these): every bucket of its goes — emptied and removed when it
   * lives in OUR account, left in place when it is in the workplace's own
   * (their bytes, their bill, their call) — and every record with it.
   */
  async releaseAll(orgId: string): Promise<{ destroyed: string[]; left: string[] }> {
    const destroyed: string[] = [];
    const left: string[] = [];
    for (const doc of await this.deps.storage.listByOrg(orgId)) {
      if (bucketIsLive(doc)) {
        if (doc.hostedOn === 'platform') {
          await this.destroy(doc.id);
          destroyed.push(doc.name);
        } else {
          left.push(doc.name);
        }
      }
      await this.deps.storage.delete(doc.id);
    }
    return { destroyed, left };
  }

  private async hostingContext(orgId: string | null): Promise<{ source: 'platform' | 'org'; orgSlug: string; apiToken: string }> {
    if (orgId) {
      const context = await this.deps.resolveHostingContext(orgId);
      // A connected org that IS the platform's own is ours: hosted, capped.
      return context.orgSlug === this.deps.platform?.orgSlug ? { ...context, source: 'platform' } : context;
    }
    if (!this.deps.platform) throw new ObjectStorageError('This account is not in a workplace, and this backend has no cloud account to put a bucket in.', 503);
    return { source: 'platform', ...this.deps.platform };
  }

  private async objectsOf(doc: StorageBucketDocument): Promise<BucketObjects | null> {
    const [accessKeyId, secretAccessKey] = await Promise.all([
      this.deps.secrets.read(doc.secretsNamespaceId, doc.secretNames.accessKeyId),
      this.deps.secrets.read(doc.secretsNamespaceId, doc.secretNames.secretAccessKey),
    ]);
    if (!accessKeyId || !secretAccessKey) return null;
    return (this.deps.makeObjects ?? s3BucketObjects)({
      endpoint: doc.endpoint,
      region: doc.region,
      bucket: doc.bucket,
      accessKeyId,
      secretAccessKey,
    });
  }
}

/** The real S3 client, built lazily so tests never touch the SDK. */
export function s3BucketObjects(args: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }): BucketObjects {
  const client = new S3Client({
    endpoint: args.endpoint,
    region: args.region || 'auto',
    credentials: { accessKeyId: args.accessKeyId, secretAccessKey: args.secretAccessKey },
    forcePathStyle: false,
  });
  return {
    async usage() {
      let bytes = 0;
      let objects = 0;
      let continuationToken: string | undefined;
      for (let page = 0; ; page += 1) {
        const listed = await client.send(new ListObjectsV2Command({
          Bucket: args.bucket,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }));
        for (const object of listed.Contents ?? []) {
          bytes += object.Size ?? 0;
          objects += 1;
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        if (!continuationToken) return { bytes, objects, truncated: false };
        if (page + 1 >= USAGE_MAX_PAGES) return { bytes, objects, truncated: true };
      }
    },
    async empty() {
      for (;;) {
        const listed = await client.send(new ListObjectsV2Command({ Bucket: args.bucket }));
        const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
        if (keys.length === 0) return;
        await client.send(new DeleteObjectsCommand({ Bucket: args.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      }
    },
    async setCors(rules) {
      await client.send(new PutBucketCorsCommand({ Bucket: args.bucket, CORSConfiguration: { CORSRules: rules } }));
    },
  };
}
