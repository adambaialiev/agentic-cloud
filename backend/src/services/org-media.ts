import { FlyClient } from './fly-client.js';
import { S3MediaStorage } from './s3-media-storage.js';
import type { MediaStorage, MediaStorageReadAccess, MediaStorageUploadTarget } from './media-storage.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';

/**
 * BYO media (byo-media-design): a client org's attachments — chat media,
 * note files, proposal attachments, knowledge-page images — live in a bucket
 * in the ORG'S OWN Fly account, not in our store. The bucket is provisioned
 * lazily on the org's first upload with the org's own Fly token, exactly the
 * Tigris path byo-git slice 4 proved live: the S3 credentials come back ONCE
 * in the create response, so they go to the org-secret store in the same
 * breath, and a creation whose secret write fails deletes the bucket rather
 * than stranding one nobody can sign for.
 *
 * Org #0 rides the platform's env-configured store (MinIO on ia-media) — the
 * same env-seed pattern as its Fly and git rows — so there is one code path
 * and no migration for us. That is NOT an emergent property of it having no
 * bucket yet, which is how it was first written and what broke: org #0 points
 * at our own Fly org, so it resolved `source === 'org'` like any client, and
 * its first upload after this shipped minted it a bucket, wrote the pointer,
 * and orphaned every attachment already in MinIO — reads went to the new
 * empty bucket and answered 404 for a fortnight of notes and proposals.
 *
 * So the rule is stated outright: an org whose machines run in OUR OWN Fly
 * org is not a client, it is us, and its bytes belong in the env-configured
 * store. Minting it a bucket would put a second store inside the same Fly
 * account and strand everything already in the first. The idle reaper draws
 * the same line for the same reason (`listAdditionalOrgContexts`).
 *
 * The platform store also serves any member of an org that has not connected
 * a Fly org yet: reads must keep working before minute one, and agent
 * machines are refused until the cloud is connected anyway, so real client
 * bytes only ever land after the org's own bucket can exist.
 *
 * The one deliberate hard edge, shared with org-fly: an org WITH a media
 * pointer whose credentials secret has gone missing fails LOUDLY. Falling
 * back to the platform store would silently split an org's files across two
 * accounts — the exact confusion this workstream exists to end.
 */

/** Where an org's bucket keys live in the org-secret namespace. */
export const ORG_MEDIA_CREDS_SECRET = 'MEDIA_BUCKET_CREDS';

export function orgMediaAddOnName(orgId: string): string {
  return `iamedia-${orgId.replace(/-/g, '').slice(0, 12)}`;
}

export class OrgMediaError extends Error {}

export interface OrgMediaServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'listOrgs' | 'updateOrg' | 'listMembershipsByUser' | 'getOrgByNamespace'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext'>;
  /** The env-configured store — org #0's row, and the pre-connect fallback. */
  platformStorage: MediaStorage;
  /**
   * Our OWN Fly org slug (`FLY_ORG`). An org resolving to this one rides
   * `platformStorage` and is never given a bucket — see the module doc.
   * Absent when the platform runs without Fly, where nothing can provision
   * anyway.
   */
  platformFlyOrgSlug?: string;
  makeFlyClient?: (apiToken: string) => Pick<FlyClient, 'resolveOrganizationId' | 'createTigrisBucket' | 'deleteAddOn'>;
  /** Injectable for tests; defaults to a real S3 client on the org's bucket. */
  makeStorage?: (args: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }) => MediaStorage;
  log?: (line: string) => void;
}

export class OrgMediaService {
  /** One S3 client per org, built once per process from the stored pointer. */
  private readonly cache = new Map<string, MediaStorage>();
  /** In-flight provisioning, so two concurrent first uploads mint ONE bucket. */
  private readonly provisioning = new Map<string, Promise<MediaStorage>>();

  constructor(private readonly deps: OrgMediaServiceDeps) {}

  private get log() { return this.deps.log ?? (() => {}); }

  /**
   * The store this owner's bytes belong in. `owner` is the second segment of
   * every storage path (`users/<owner>/…`) — an orgId on org-namespaced
   * records, a member's userId on personal ones; both resolve to the same
   * org. `provision` is true only on write paths: reads never mint a bucket.
   */
  async storageForOwner(owner: string, opts: { provision: boolean }): Promise<MediaStorage> {
    const orgId = await this.resolveOwnerOrgId(owner);
    if (!orgId) return this.deps.platformStorage;
    const cached = this.cache.get(orgId);
    if (cached) return cached;
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) return this.deps.platformStorage;
    if (org.media) {
      const raw = await this.deps.orgSecrets.getOrgSecret(orgId, org.media.credsSecretName ?? ORG_MEDIA_CREDS_SECRET);
      if (!raw) {
        // Never the platform fallback here — see the module doc's hard edge.
        throw new OrgMediaError(
          `org ${orgId} points at media bucket ${org.media.bucket} but its credentials secret is missing`,
        );
      }
      const creds = JSON.parse(raw) as { accessKeyId: string; secretAccessKey: string };
      const storage = this.makeStorage({
        endpoint: org.media.endpoint,
        bucket: org.media.bucket,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      });
      this.cache.set(orgId, storage);
      return storage;
    }
    // A hosted workplace (note #664) has no account of its own to put a
    // bucket in: its bytes ride the platform store, like org #0's.
    if (!opts.provision || !org.fly) return this.deps.platformStorage;
    const fly = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    // Not a client org, or OUR org wearing an org record: either way its
    // bytes belong in the env-configured store, and minting a bucket would
    // orphan whatever is already there. See the module doc.
    if (fly.source !== 'org' || fly.orgSlug === this.deps.platformFlyOrgSlug) {
      return this.deps.platformStorage;
    }
    const inFlight = this.provisioning.get(orgId);
    if (inFlight) return inFlight;
    const created = this.ensureMediaBucket(orgId, fly).finally(() => this.provisioning.delete(orgId));
    this.provisioning.set(orgId, created);
    return created;
  }

  /** owner is an orgId, an immutable git namespace — an org's or a room's
   *  (note #85) — or (pre-org) neither. */
  private async resolveOwnerOrgId(owner: string): Promise<string | null> {
    if (await this.deps.orgStorage.getOrg(owner)) return owner;
    const namespaceOrg = (await this.deps.orgStorage.listOrgs())
      .find((org) => org.git?.namespaceId === owner);
    if (namespaceOrg) return namespaceOrg.orgId;
    // An old room's namespace (note #843) unknown here would fall through to
    // the personal branch and silently route the file to the platform
    // bucket — the exact hard-edge failure this module exists to prevent.
    const formerRoom = await this.deps.orgStorage.getOrgByNamespace(owner);
    if (formerRoom) return formerRoom.orgId;
    // Legacy namespace with no stamp: before multi-org, this owner could have
    // only one membership. Its oldest membership is therefore historical;
    // the mutable active selection must never reroute old attachment paths.
    const [membership] = (await this.deps.orgStorage.listMembershipsByUser(owner))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId));
    return membership?.orgId ?? null;
  }

  private makeStorage(args: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }): MediaStorage {
    if (this.deps.makeStorage) return this.deps.makeStorage(args);
    return new S3MediaStorage({
      endpoint: args.endpoint,
      bucket: args.bucket,
      accessKeyId: args.accessKeyId,
      secretAccessKey: args.secretAccessKey,
      forcePathStyle: true,
    });
  }

  private async ensureMediaBucket(
    orgId: string,
    fly: { orgSlug: string; apiToken: string },
  ): Promise<MediaStorage> {
    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
    const organizationId = await client.resolveOrganizationId(fly.orgSlug);
    const addOnName = orgMediaAddOnName(orgId);
    const created = await client.createTigrisBucket({ organizationId, name: addOnName });
    try {
      // Secret before pointer, mint-once credentials first of all — the
      // org-git-backup discipline, byte for byte.
      await this.deps.orgSecrets.setOrgSecret(
        orgId,
        ORG_MEDIA_CREDS_SECRET,
        JSON.stringify({ accessKeyId: created.accessKeyId, secretAccessKey: created.secretAccessKey }),
        `S3 keys for this workplace's own attachment bucket (${created.bucket}) — minted once at creation`,
      );
      await this.deps.orgStorage.updateOrg(orgId, {
        media: {
          addOnName,
          bucket: created.bucket,
          endpoint: created.endpoint,
          credsSecretName: ORG_MEDIA_CREDS_SECRET,
        },
      });
    } catch (error) {
      await client.deleteAddOn(addOnName).catch(() => { /* best-effort unwind */ });
      throw error;
    }
    this.log(`created media bucket ${created.bucket} for org ${orgId}`);
    const storage = this.makeStorage(created);
    this.cache.set(orgId, storage);
    return storage;
  }
}

/** The `users/<owner>/…` shape every path builder produces. */
function ownerFromStoragePath(storagePath: string): string | null {
  const segments = storagePath.split('/');
  return segments[0] === 'users' && segments[1] ? segments[1] : null;
}

/**
 * The MediaStorage every consumer holds: routes each call to the owning
 * org's bucket by the path's owner segment, so the twelve consumer files
 * keep their exact shape and org #0 behaves byte-identically. Write verbs
 * may provision; read and delete verbs never do.
 */
export class OrgRoutedMediaStorage implements MediaStorage {
  constructor(private readonly orgMedia: OrgMediaService, private readonly platformStorage: MediaStorage) {}

  private route(storagePath: string, opts: { provision: boolean }): Promise<MediaStorage> {
    const owner = ownerFromStoragePath(storagePath);
    if (!owner) return Promise.resolve(this.platformStorage);
    return this.orgMedia.storageForOwner(owner, opts);
  }

  async createUploadTarget(args: { storagePath: string; contentType: string; expiresInMs?: number }): Promise<MediaStorageUploadTarget> {
    return (await this.route(args.storagePath, { provision: true })).createUploadTarget(args);
  }

  async uploadObject(args: { storagePath: string; contentType: string; data: Buffer | Uint8Array | ArrayBuffer }): Promise<void> {
    return (await this.route(args.storagePath, { provision: true })).uploadObject(args);
  }

  async createReadAccess(args: {
    storagePath: string;
    expiresInMs?: number;
    promptSaveAs?: string;
    responseDisposition?: string;
    responseCacheControl?: string;
  }): Promise<MediaStorageReadAccess> {
    return (await this.route(args.storagePath, { provision: false })).createReadAccess(args);
  }

  async downloadObject(args: { storagePath: string }): Promise<Buffer> {
    return (await this.route(args.storagePath, { provision: false })).downloadObject(args);
  }

  async setMetadata(args: { storagePath: string; contentType: string; metadata: Record<string, string> }): Promise<void> {
    return (await this.route(args.storagePath, { provision: true })).setMetadata(args);
  }

  async deleteObject(args: { storagePath: string }): Promise<void> {
    const storage = await this.route(args.storagePath, { provision: false });
    if (storage.deleteObject) await storage.deleteObject(args);
  }

  async deleteObjectsWithPrefix(args: { prefix: string }): Promise<void> {
    const storage = await this.route(args.prefix, { provision: false });
    if (storage.deleteObjectsWithPrefix) await storage.deleteObjectsWithPrefix(args);
  }

  // Big files in parts (note #784). Starting one is a write, so it may
  // provision; every later step names an upload that already exists.
  async startMultipart(args: { storagePath: string; contentType: string }): Promise<{ uploadId: string }> {
    const storage = await this.route(args.storagePath, { provision: true });
    if (!storage.startMultipart) throw new Error('This store cannot take a file in parts.');
    return storage.startMultipart(args);
  }

  async uploadPart(args: { storagePath: string; uploadId: string; partNumber: number; data: Buffer }): Promise<{ etag: string }> {
    const storage = await this.route(args.storagePath, { provision: false });
    if (!storage.uploadPart) throw new Error('This store cannot take a file in parts.');
    return storage.uploadPart(args);
  }

  async completeMultipart(args: {
    storagePath: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ sizeBytes: number }> {
    const storage = await this.route(args.storagePath, { provision: false });
    if (!storage.completeMultipart) throw new Error('This store cannot take a file in parts.');
    return storage.completeMultipart(args);
  }

  async abortMultipart(args: { storagePath: string; uploadId: string }): Promise<void> {
    const storage = await this.route(args.storagePath, { provision: false });
    if (storage.abortMultipart) await storage.abortMultipart(args);
  }

  async peekObject(args: { storagePath: string; bytes: number }): Promise<{ sizeBytes: number; head: Buffer } | null> {
    const storage = await this.route(args.storagePath, { provision: false });
    if (!storage.peekObject) throw new Error('This store cannot read part of a file.');
    return storage.peekObject(args);
  }

  async abortStaleMultiparts(args: { prefix: string; olderThan: Date }): Promise<number> {
    const storage = await this.route(args.prefix, { provision: false });
    return storage.abortStaleMultiparts ? storage.abortStaleMultiparts(args) : 0;
  }
}
