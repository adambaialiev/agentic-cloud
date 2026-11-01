import { useNavigate } from 'react-router-dom';
import type { WorkspaceOrgDetail } from '../../../src/shared/workspace-api.js';
import { toFor } from '../routes.js';
import { TypeIcon } from '../ui/icons.js';
import { useCloud } from './useCloud.js';

/** The cloud as the workplace record knows it: only a connected one has a
 *  name and a tunnel, so only a connected one can be drawn. */
export type ConnectedCloud = Extract<WorkspaceOrgDetail['fly'], { connected: true }>;

/**
 * What the card says about the tunnel, per state of the record (note #642).
 *
 * The line used to be "private tunnel up" or "tunnel coming up", and
 * "coming up" was worn by three situations that are not alike: one genuinely
 * mid-setup, one that had failed, and org #0's — whose network the host
 * already routes, so its own peer is rolled back on every attempt and the
 * line promised progress that was never going to arrive. The user asked why
 * his said that; this is the answer put into the product.
 *
 * `unknown` says NOTHING about a tunnel. A workplace nobody has checked
 * since we started keeping outcomes has a cloud, machines and an account
 * name, and that is all the record can stand behind — filling the silence
 * with reassurance is the habit this whole change exists to break.
 */
const TUNNEL_LINE: Record<string, string> = {
  up: 'Your own cloud · private tunnel up',
  // The machines are reachable — that is WHY the peer was rolled back — so
  // this reads as a fact about the route, never as something to fix.
  'routed-elsewhere': 'Your own cloud · already reachable',
  // The line states the fact and the badge marks it, the way a Backups row
  // does ("Backed up 3h ago" + `overdue`). It drops the "Your own cloud"
  // lead the other three carry: the account's name is directly above it, the
  // badge takes the room, and of the four this is the one that must read at
  // a glance rather than ellipsise into its own opposite.
  failed: 'Private tunnel is not up',
  unknown: 'Your own cloud',
};

/**
 * These four are held to ONE LINE on a phone, which is what `.cline` gives
 * them: the first drafts said "already reachable, no separate tunnel needed"
 * and "private tunnel is not up", and both ellipsised mid-word at 420px —
 * the second losing the word "not", which inverts it. jsdom cannot see that,
 * so the widths are measured in Chrome instead (`scripts/`, note #642).
 */

/**
 * The workplace's cloud account: the Fly organization everything here runs
 * in, how many of its machines are awake right now, and the admin's door to
 * the details.
 *
 * It stood on HOME until note #642 — and Home is not where anyone goes to
 * ask about the cloud. The workplace screen is, and it already carried a
 * thinner card saying the same thing under the same heading; two cards for
 * one fact is how they start disagreeing. So there is one card, on the
 * workplace screen, and it keeps everything both of them had.
 *
 * The COUNTS are their own read, because they are their own question. The
 * workplace record says which account this workplace runs in and whether its
 * private tunnel is up; only an inventory of that account says how much of it
 * is awake this second. That read refreshes every fifteen seconds underneath
 * the card, holds what it last read across a trip into the details and back,
 * and absorbs a failure nobody asked for rather than taking the card away to
 * report it (`useCloud`, `cloud-cache.ts`, note #354).
 *
 * A count it cannot state, it does not invent: an inventory that failed says
 * so on the line where the numbers would have been, and the account above it
 * — which is a fact of the record, not of the inventory — stands regardless.
 */
export function CloudCard({ orgId, fly, role }: {
  orgId: string;
  fly: ConnectedCloud;
  role: string;
}) {
  const { data, error } = useCloud(orgId);
  const navigate = useNavigate();
  const machines = data?.machines ?? null;
  return (
    <div className="card" id="orgCloudCard">
      <div className="crow">
        <TypeIcon glyph="globe" />
        <div className="main">
          <div className="name plain">{fly.orgSlug}</div>
          <div className="cline">
            <span className="ctext">{TUNNEL_LINE[fly.peer] ?? TUNNEL_LINE.unknown}</span>
            {/* The one state worth a mark: agents in this account may be out
                of reach, and nothing else on the screen would say so. The
                MARK is an admin's, because it asks for something only an
                admin can do — a member reads the same sentence, unmarked,
                which states the fact without handing them an errand. */}
            {fly.peer === 'failed' && role === 'admin' ? <span className="badge warn">check it</span> : null}
          </div>
        </div>
      </div>
      {/* Fly refuses to build or change anything here until the account's
          billing is sorted (note #801) — the red line, read live, because a
          card can lapse long after it was checked at connect. Everyone sees
          the sentence; the link is where its owner fixes it. */}
      {data?.billing
        ? (
          <p className="cloudbilling bad" id="orgCloudBilling" role="alert">
            {data.billing.problem}{' '}
            <a href={data.billing.fixUrl} target="_blank" rel="noopener noreferrer">Open Fly billing</a>
          </p>
        )
        : null}
      <div className="cloudcounts" role="status">
        {machines
          ? (
            <>
              <span><strong>{machines.active}</strong> active</span>
              <span><strong>{machines.sleeping}</strong> sleeping</span>
            </>
          )
          : <span>{data?.inventoryError || error || 'Reading machine counts…'}</span>}
      </div>
      {role === 'admin'
        ? (
          // Not "See all machines" (note #355): behind it are the machines,
          // their money AND what new agents are built on, so the door names
          // where it goes rather than one thing kept there.
          <button className="addrow" type="button" onClick={() => navigate(toFor({ kind: 'organizationCloud', orgId })!)}>
            See cloud details
          </button>
        )
        : null}
    </div>
  );
}
