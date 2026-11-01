/** The workplace's buckets, and a bucket's page in words (note #778). */

import type { WorkspaceBucketRow } from '../../../../src/shared/workspace-api.js';

export function bucketsOf(state: { buckets?: WorkspaceBucketRow[] } | null | undefined): WorkspaceBucketRow[] {
  return state?.buckets ?? [];
}

/** What public or private MEANS, said once under the name. */
export function bucketReach(isPublic: boolean): string {
  return isPublic
    ? 'Public: anyone with a file’s address can read it. Only agents holding its keys can add or change files.'
    : 'Private: only agents and apps holding its keys can read or change its files.';
}

/** "3 files · 12.4 MB", or a floor when the count stopped early. */
export function bucketHolds(usage: { bytes: number; objects: number; truncated: boolean }, size: (n: number) => string): string {
  if (!usage.objects) return 'Empty';
  const files = `${usage.objects.toLocaleString('en-US')} file${usage.objects === 1 ? '' : 's'}`;
  return usage.truncated ? `More than ${files} · over ${size(usage.bytes)}` : `${files} · ${size(usage.bytes)}`;
}
