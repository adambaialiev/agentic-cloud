/**
 * One bucket (`/storage/:name?org=`, note #778): what it is for the people
 * who did not make it — public or private and what that means, where a
 * public one is read from, who made it and when, which secrets hold its
 * keys, and what it holds — and, at the foot, the delete, behind typing its
 * name, with an agent's pending deletion request when there is one. The
 * owner's words (2026-10-19): a Delete standing on the workplace's list was
 * one tap too close. The shape is a site's page (`SiteScreen`).
 *
 * Painted from the state read. What it holds is read on its own, after,
 * because counting it walks the bucket's listing with its keys.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceBucketRow, WorkspaceBucketUsageAnswer } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useSession } from '../../session/useSession.js';
import { AskByTyping } from '../../ui/Ask.js';
import { askedOf } from '../../ui/ask-words.js';
import { FaceDoor } from '../../ui/FaceDoor.js';
import { bytes } from '../../ui/file-kind.js';
import { copyFromTap, errorMessage } from '../../ui/format.js';
import { TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { toFor } from '../../routes.js';
import { bucketHolds, bucketReach, bucketsOf } from './bucket-words.js';

export function BucketScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const bucket: WorkspaceBucketRow | undefined = bucketsOf(state).find((entry) => entry.name === id);
  const org = state?.org ?? null;
  const canManage = !org || org.role === 'admin';
  const named = bucket?.name;
  const [usage, setUsage] = useState<WorkspaceBucketUsageAnswer | 'failed' | null>(null);
  useEffect(() => {
    if (!named) return undefined;
    let alive = true;
    void api.api<WorkspaceBucketUsageAnswer>(`api/storage/${encodeURIComponent(named)}/usage`)
      .then((answer) => { if (alive) setUsage(answer); })
      .catch(() => { if (alive) setUsage('failed'); });
    return () => { alive = false; };
  }, [api, named]);

  if (!bucket) {
    return (
      <div className="screen" id="screenBucket">
        <ScreenTitle titleId="bucketTitle" title={id} />
        <div className="card" id="bucketCard"><div className="empty">{state ? 'This bucket is not in this workplace any more.' : 'Loading…'}</div></div>
      </div>
    );
  }

  const ask = bucket.deleteAsk;
  const holds = usage === null ? 'Counting…' : usage === 'failed' || !usage.usage ? 'Could not be read just now' : bucketHolds(usage.usage, bytes);

  return (
    <div className="screen" id="screenBucket">
      <ScreenTitle titleId="bucketTitle" title={bucket.name} subId="bucketSub" sub={bucketReach(bucket.public)} />
      <div className="card" id="bucketCard">
        {bucket.publicUrl
          ? (
            <button
              className="crow open"
              id="bucketAddress"
              type="button"
              onClick={() => {
                copyFromTap(async () => `${bucket.publicUrl}/`)
                  .then(() => banner.show('Address copied — add a file’s name after the last slash.', true))
                  .catch((error: unknown) => banner.show(errorMessage(error)));
              }}
            >
              <TypeIcon glyph="globe" tint="dir" />
              <div className="main">
                <div className="name plain">{`${bucket.publicUrl.replace(/^https?:\/\//, '')}/…`}</div>
                <div className="cline wrap"><span className="ctext">Its files’ address — a file’s name goes after the slash · tap to copy</span></div>
              </div>
            </button>
          )
          : null}
        {bucket.agentName
          ? (
            <div className="crow" id="bucketMaker">
              {bucket.agentAvatarUrl
                ? (
                  <span className="faces">
                    <FaceDoor agentId={bucket.agentId} agentName={bucket.agentName} avatarUrl={bucket.agentAvatarUrl} />
                  </span>
                )
                : <TypeIcon glyph="user" />}
              <div className="main">
                <div className="name plain">{bucket.agentName}</div>
                <div className="cline">{`Created it${relative(bucket.createdAt) ? ` · ${relative(bucket.createdAt)}` : ''}`}</div>
              </div>
            </div>
          )
          : null}
        <div className="crow" id="bucketHolds">
          <TypeIcon glyph="folder" tint={bucket.public ? 'dir' : ''} />
          <div className="main">
            <div className="name plain">{holds}</div>
            <div className="cline">What it holds</div>
          </div>
        </div>
        {bucket.secretNames?.length
          ? (
            <div className="crow" id="bucketKeys">
              <TypeIcon glyph="key" />
              <div className="main">
                <div className="name plain">{`Its keys: ${bucket.secretNames.length} secrets`}</div>
                <ul className="bucketkeys">
                  {bucket.secretNames.map((name) => <li key={name}><code>{name}</code></li>)}
                </ul>
              </div>
            </div>
          )
          : null}
      </div>
      {canManage || ask
        ? (
          <div id="bucketDanger">
            {ask
              ? <div className="asked">{`${askedOf(ask)} to delete this bucket${ask.at && relative(ask.at) ? ` · ${relative(ask.at)}` : ''}`}</div>
              : null}
            <div className="site-danger-actions">
              {canManage && (!ask || ask.canDecide !== false)
                ? <button className="btn danger bare" id="bucketDelete" type="button" disabled={busy} onClick={() => setAsking(true)}>{busy ? 'Deleting…' : 'Delete this bucket'}</button>
                : null}
              {canManage && ask && ask.canDecide !== false
                ? (
                  <button className="btn ghost bare" type="button" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      await api.api(`api/storage/${encodeURIComponent(bucket.name)}/keep`, { method: 'POST' });
                      banner.show(`Kept ${bucket.name} — the agent has been told.`, true);
                      await reload();
                    } catch (error) { banner.show(errorMessage(error)); }
                    setBusy(false);
                  }}>
                    Keep it
                  </button>
                )
                : null}
            </div>
            {ask && ask.canDecide === false
              ? <div className="hintblock">Only the owner of the agent that made this request can decide it. Destructive workplace actions also require that owner to be an admin.</div>
              : null}
          </div>
        )
        : null}
      {asking
        ? (
          <AskByTyping
            name={bucket.name}
            lines={[
              'Every file in it is deleted, and the four secrets holding its keys are removed from the workplace.',
              bucket.public ? 'Anything on the web that pointed at it stops working.' : 'An app deployed with its keys loses them.',
              'There is no undo: an agent would have to create a new bucket and fill it again.',
            ]}
            verb="Delete"
            onAnswer={async (confirmed) => {
              setAsking(false);
              if (!confirmed) return;
              setBusy(true);
              try {
                await api.api(`api/storage/${encodeURIComponent(bucket.name)}`, { method: 'DELETE' });
                banner.show(`Deleted the bucket ${bucket.name}.`, true);
                navigate(toFor({ kind: 'storage', orgId: state?.org?.orgId })!, { replace: true });
                await reload().catch(() => {});
              } catch (error) { banner.show(errorMessage(error)); setBusy(false); }
            }}
          />
        )
        : null}
    </div>
  );
}
