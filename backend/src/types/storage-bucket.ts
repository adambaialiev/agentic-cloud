/**
 * An object-storage bucket an agent asked for (note #768): one Tigris bucket,
 * S3-compatible, minted in the workplace's Fly account — the platform's own
 * for a hosted workplace (note #664), the workplace's connected one
 * otherwise — exactly the way a workplace's attachment bucket is
 * (services/org-media.ts). Its keys are NOT on this record: they come back
 * exactly once, in Fly's create response, and go straight into the room's
 * secret store under the four names below, which is how they reach the
 * agent's next turn as environment variables and any site via `--secret`.
 *
 * A bucket belongs to the WORKPLACE, like a site and a repository: every
 * room's agents list it. Deleting one is not an agent verb — `deleteAsk` is
 * the request, and the owner decides it in the Workspace.
 */
export interface StorageBucketDocument {
  id: string;
  /** The workplace that owns it; null only on a legacy org-less account. */
  orgId: string | null;
  /** The person whose agent created it. */
  userId: string;
  /** Where the keys are stored (a namespace; the workplace's own since note #843). */
  secretsNamespaceId: string;
  /** The agent that created it, and its name then (a snapshot). */
  createdBy: { agentId: string; agentName?: string };
  /** The name the agent chose: the secrets' prefix, and the address words. */
  name: string;
  /** The Fly add-on name (globally unique on Fly): `iabkt-<hex>`. */
  addOnName: string;
  /** The S3 bucket name Tigris gave it, and where to reach it. */
  bucket: string;
  endpoint: string;
  region: string;
  /** Objects readable by anyone with the URL (`--public`), or keys only. */
  public: boolean;
  /** The four room secrets holding its endpoint, bucket name and keys. */
  secretNames: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /** Where the bucket physically lives: 'platform' (ours) or the workplace's own Fly org. */
  hostedOn: 'platform' | 'org';
  flyOrgSlug: string;
  status: 'live' | 'destroyed';
  createdAt: string;
  destroyedAt?: string;
  /**
   * An agent asked for it to go. Newest wins, one at a time — the same shape
   * as a site's and a repository's ask, read by the same Workspace surface.
   */
  deleteAsk?: { byAgentId: string; byUserId?: string; at: string };
}

/**
 * A bucket name is also the prefix of four environment variables, so it is a
 * DNS-ish label that upper-cases cleanly: lowercase letters, digits and
 * hyphens, 3–32 characters, starting with a letter.
 */
const BUCKET_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function validateBucketName(name: string): string | null {
  if (!BUCKET_NAME_PATTERN.test(name)) {
    return 'A bucket name is 3–32 characters: lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit.';
  }
  if (name.includes('--')) return 'A bucket name cannot contain two hyphens in a row.';
  return null;
}

/** `user-uploads` → `USER_UPLOADS_S3_BUCKET` and its three siblings. */
export function bucketSecretNames(name: string): StorageBucketDocument['secretNames'] {
  const prefix = name.toUpperCase().replace(/-/g, '_');
  return {
    endpoint: `${prefix}_S3_ENDPOINT`,
    bucket: `${prefix}_S3_BUCKET`,
    accessKeyId: `${prefix}_S3_ACCESS_KEY_ID`,
    secretAccessKey: `${prefix}_S3_SECRET_ACCESS_KEY`,
  };
}

export function bucketIsLive(doc: StorageBucketDocument | null | undefined): doc is StorageBucketDocument {
  return Boolean(doc) && doc!.status === 'live';
}

/**
 * Where a PUBLIC bucket's files are read from (note #778): Tigris answers a
 * public bucket at its own host under the endpoint's, so `photo.jpg` in it is
 * `https://<bucket>.fly.storage.tigris.dev/photo.jpg`. Null for a private
 * bucket, which has no address anybody can use without its keys.
 */
export function bucketPublicUrl(doc: Pick<StorageBucketDocument, 'public' | 'bucket' | 'endpoint'>): string | null {
  if (!doc.public) return null;
  try {
    const endpoint = new URL(doc.endpoint);
    return `${endpoint.protocol}//${doc.bucket}.${endpoint.host}`;
  } catch {
    return null;
  }
}
