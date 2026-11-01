/**
 * Home's Storage card (note #768): the object-storage buckets the agents keep
 * files in. Each row opens the bucket's own page (note #778), the ONE surface
 * in the product that removes one: an agent can only ask, and the owner
 * decides there, by typing the bucket's name. Public
 * buckets are marked, because those are readable by strangers under the
 * platform's account and must never be hosted unseen. Hidden on a workplace
 * with none. Keys never reach this screen.
 */

import { useNavigate } from 'react-router-dom';
import type { WorkspaceBucketRow } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { askedOf } from '../../ui/ask-words.js';
import { TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { RowFace } from '../../ui/FaceDoor.js';
import { PressableRow } from './PressableRow.js';
import { bucketsOf } from '../storage/bucket-words.js';

/** One bucket as the card lists it: a door onto its own page (note #778),
 *  where the delete is — never a delete on the list itself. A pending
 *  request to delete it still shows here, so it is seen without opening. */
function BucketRow({ bucket }: { bucket: WorkspaceBucketRow }) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  const ask = bucket.deleteAsk;
  return (
    <PressableRow
      className="crow open"
      data-bucket={bucket.name}
      onPress={() => navigate(toFor({ kind: 'bucket', id: bucket.name, orgId: org?.orgId })!)}
    >
      <TypeIcon glyph="folder" tint={bucket.public ? 'dir' : ''} />
      <div className="main">
        <div className="name">{bucket.name}</div>
        <div className="cline wrap">
          {bucket.agentAvatarUrl && bucket.agentId ? <RowFace agentId={bucket.agentId} avatarUrl={bucket.agentAvatarUrl} /> : null}
          {bucket.agentName ? <span className="ctext">{bucket.agentName}</span> : null}
          {relative(bucket.createdAt) ? <span className="cwhen">{bucket.agentName ? ' · ' : ''}created {relative(bucket.createdAt)}</span> : null}
          {ask
            ? <span className="asked">{` · ${askedOf(ask)} to delete it${ask.at && relative(ask.at) ? ` · ${relative(ask.at)}` : ''}`}</span>
            : null}
        </div>
      </div>
      <div className="cside">{bucket.public ? 'public' : 'private'}</div>
    </PressableRow>
  );
}

export function Storage() {
  const { state } = useWorkspace();
  const buckets = bucketsOf(state);
  if (buckets.length === 0) return null;
  const publicCount = buckets.filter((b) => b.public).length;
  return (
    <>
      <h2 className="homehead" id="storageHead">Storage</h2>
      <div className="card" id="storageCard">
        <div id="storage">
          {buckets.map((bucket) => <BucketRow key={bucket.name} bucket={bucket} />)}
          <div className="quota">{`${buckets.length} bucket${buckets.length === 1 ? '' : 's'}${publicCount ? ` · ${publicCount} public, readable by anyone with a link` : ' · all private'}`}</div>
        </div>
      </div>
    </>
  );
}
