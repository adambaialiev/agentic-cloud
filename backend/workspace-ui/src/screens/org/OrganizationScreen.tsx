/**
 * One workplace (`/workplace?org=`): its people, invites, the cloud
 * account, the code host, admin rename, membership actions and — for every
 * admin — the delete (owner, 2026-09-22). Ported from the legacy `openOrg` /
 * `paintOrgScreen` family.
 */

import { useCallback, useState } from 'react';
import { CloudCard } from '../../cloud/CloudCard.js';
import { CloudConnectForm } from '../../cloud/CloudConnectForm.js';
import { useNavigate } from 'react-router-dom';
import type {
  WorkspaceOrgDetail,
  WorkspaceOrgGitVolumeAnswer,
  WorkspaceOrgInvite,
  WorkspaceOrgInviteCreatedAnswer,
  WorkspaceOrgLeftAnswer,
} from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useOrgApi } from './useOrgApi.js';
import { bytes } from '../../ui/file-kind.js';
import { absolute, copyFromTap, errorMessage } from '../../ui/format.js';
import { Icon, TypeIcon, type IconName } from '../../ui/icons.js';
import { RoomFaces } from '../../ui/RoomFaces.js';
import { relative, useNow } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { standInWorkplace } from '../../workspace/standing-workplace.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { JoinRequestRow } from './JoinRequestRow.js';
import { InviteLinkRow } from './InviteLinkRow.js';
import { workplaceHasTeam } from './org-words.js';
import { peopleSubLine } from './people-words.js';
import { useOrgDetail } from './useOrgDetail.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { WorkplaceNameForm } from './WorkplaceNameForm.js';
import { WorkplaceDeleteScreen } from './WorkplaceDeleteScreen.js';
import { CopyHealthSection } from './CopyHealthSection.js';
import { AutoApproveSection } from './AutoApproveSection.js';
import { PRIVATE_COPY } from '../../../../src/shared/private-copy.js';

/**
 * The door onto the People page (note #328): the members' faces stacked the
 * way a room row stacks its agents', then how many there are and how many
 * are here right now. The people themselves moved off this screen and onto
 * their own, drawn like the fleet; this row is what says where they went.
 */
function PeopleDoor({ members, onOpen }: { members: WorkspaceOrgDetail['members']; onOpen: () => void }) {
  return (
    <button className="crow open" id="orgPeopleDoor" type="button" onClick={onOpen}>
      <RoomFaces agents={members.map((member) => ({ id: member.userId, name: member.name, avatarUrl: member.photoUrl }))} />
      <div className="main">
        <div className="name plain">People</div>
        <div className="cline"><span className="ctext">{peopleSubLine(members)}</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

function GitRow({ glyph, name, line, badge }: { glyph: IconName; name: string; line: string; badge?: string }) {
  return (
    <div className="crow">
      <TypeIcon glyph={glyph} />
      <div className="main">
        <div className="name plain">{name}</div>
        <div className="cline"><span className="ctext">{line}</span>{badge ? <span className="badge warn">{badge}</span> : null}</div>
      </div>
    </div>
  );
}

function CodeSection({ org, refresh }: { org: WorkspaceOrgDetail; refresh: () => Promise<unknown> }) {
  const api = useOrgApi();
  const banner = useBanner();
  const ask = useConfirm();
  const [growing, setGrowing] = useState(false);
  const git = org.git;
  if (!git) return null;
  const host = git.host;
  const nextGb = host?.volumeSizeGb && host.growByGb ? host.volumeSizeGb + host.growByGb : 0;
  const growUsd = host ? (+host.growMonthlyUsd).toFixed(2) : '0';
  return (
    <div id="orgGit">
      <h2>Code</h2>
      <div className="card" id="orgGitCard">
        <GitRow glyph="git" name="Repositories" line={`${git.repoCount === 1 ? '1 repository' : `${git.repoCount} repositories`} · ${bytes(git.totalSizeBytes || 0)}`} />
        {host
          ? (
            <>
              <GitRow glyph="drive" name="Git server" line={`In your cloud · ${host.health === 'ok' ? 'answering' : host.health === 'waking' ? 'waking up — look again in a moment' : 'not answering'}`} />
              {host.volumeSizeGb
                ? <GitRow glyph="database" name="Storage" line={`${host.volumeSizeGb} GB volume${host.repoMaxBytes ? ` · ${bytes(host.repoMaxBytes)} for code` : ''}${typeof host.diskUsedPercent === 'number' ? ` · ${host.diskUsedPercent}% used` : ''}`} />
                : null}
              {org.role === 'admin' && nextGb
                ? (
                  <button
                    className="addrow"
                    type="button"
                    disabled={growing}
                    onClick={async () => {
                      const sure = await ask({
                        title: `Grow the code storage to ${nextGb} GB?`,
                        message: `${host.repoMaxBytesAfterGrow ? `Your repositories can then use up to ${bytes(host.repoMaxBytesAfterGrow)}. ` : ''}About $${growUsd} more per month on your cloud bill, and storage never shrinks back.`,
                        verb: 'Grow storage',
                      });
                      if (!sure) return;
                      setGrowing(true);
                      try {
                        const answer = await api.api<WorkspaceOrgGitVolumeAnswer>('api/org/git/volume', { method: 'POST' });
                        banner.show(`Storage grown to ${answer.sizeGb} GB.`, true);
                        void refresh();
                      } catch (error) { banner.show(errorMessage(error)); }
                      setGrowing(false);
                    }}
                  >
                    Grow storage to {nextGb} GB · +${growUsd}/mo
                  </button>
                )
                : null}
            </>
          )
          : null}
      </div>
    </div>
  );
}

/** The monitor's own patience: two missed nightly runs, not one. */
const PLATFORM_BACKUP_STALE_MS = 48 * 3600000;

/**
 * What is keeping a copy of this workplace, and when it last worked
 * (note #357).
 *
 * The facts existed before this — two rows squeezed into the Code block — but
 * only for an org with a git host of its OWN. Every org still on the platform's
 * host, which is most of them, was shown nothing at all and had no way to tell
 * an untouched backup from a missing one. So the block asks the question for
 * both halves of an org, and answers each from whoever actually holds it: the
 * org's own bucket for code it hosts itself, the platform's nightly jobs for
 * code and for the chats, notes and proposals that live here regardless.
 *
 * A row states a time or says plainly that there is nothing to report. It never
 * fills a silence with reassurance — an unanswered backup is the one this block
 * exists to show.
 */
function BackupsSection({ org }: { org: WorkspaceOrgDetail }) {
  const now = useNow(false);
  const git = org.git;
  const host = git?.host;
  const vault = git?.backup;
  const own = vault?.last;
  const platform = org.platformBackup;
  // The org's own sweep runs on its own clock, so its patience follows that
  // cadence rather than the nightly jobs' 48 hours.
  const everyMs = (vault?.everyHours || 6) * 3600000;
  const stale = (at: string, limitMs: number) => now - new Date(at).getTime() > limitMs;
  const runBadge = (run: { at: string; ok: boolean }, limitMs: number) =>
    (!run.ok ? 'failed' : stale(run.at, limitMs) ? 'overdue' : undefined);

  const codeRow = host
    ? own
      ? (
        <GitRow
          glyph="archive"
          name="Your code"
          line={`${own.ok ? 'Backed up ' : 'Last backup failed '}${relative(own.at)} · every ${vault?.everyHours ?? 6} hours`}
          badge={runBadge(own, 4 * everyMs)}
        />
      )
      // A host with a bucket but no run yet is genuinely waiting for its first
      // sweep. A host without one is not, and must not say it is.
      : vault
        ? <GitRow glyph="archive" name="Your code" line="First backup runs within a few hours" />
        : <GitRow glyph="archive" name="Your code" line="No backups yet — the first one sets up your vault" />
    : platform?.code
      ? <GitRow glyph="archive" name="Your code" line={`Backed up ${relative(platform.code.at)} · nightly, by the platform`} badge={runBadge(platform.code, PLATFORM_BACKUP_STALE_MS)} />
      : null;

  const workspaceRow = platform?.workspace
    ? <GitRow glyph="note" name="Chats, notes and proposals" line={`Backed up ${relative(platform.workspace.at)} · nightly, by the platform`} badge={runBadge(platform.workspace, PLATFORM_BACKUP_STALE_MS)} />
    : null;

  const vaultRow = vault?.bucket ? <GitRow glyph="box" name="Backup vault" line={`${vault.bucket} · in your cloud`} /> : null;
  const snapshotRow = host?.snapshotRetentionDays
    ? <GitRow glyph="database" name="Disk snapshots" line={`Daily, kept ${host.snapshotRetentionDays} days`} />
    : null;

  // Nothing known is nothing shown: a Backups heading over an empty card would
  // read as "none", which is a different and much worse claim.
  if (!codeRow && !workspaceRow && !vaultRow && !snapshotRow) return null;

  return (
    <div id="orgBackups">
      <h2>Backups</h2>
      <div className="card" id="orgBackupsCard">
        {codeRow}
        {workspaceRow}
        {vaultRow}
        {snapshotRow}
      </div>
    </div>
  );
}

/**
 * A workplace's own cloud account, which is where this question is asked
 * (note #642).
 *
 * The same card stood on Home as well until then, with the machine counts
 * this one lacked. It is one card now, and it is here: the counts came with
 * it (`CloudCard`), and Home no longer says anything about the cloud at all.
 * Hosted workplaces have no account to inspect or manage, so their allowance
 * is not a settings section (note #668).
 */
function CloudSection({ org, onConnected }: { org: WorkspaceOrgDetail; onConnected: () => void }) {
  const { state } = useWorkspace();
  const fly = org.fly;
  const orgId = org.orgId ?? state?.org?.orgId ?? '';
  // A hosted workplace the platform marked to bring its own Fly account
  // (note #801): its admin gets the first-connect form, standing open the way
  // it did before note #664 because pasting is the only thing to do here.
  // Members see nothing — connecting is the admin's errand, and the bill is.
  if (!fly.connected) {
    if (!fly.ownCloudAllowed || org.role !== 'admin') return null;
    return (
      <div id="orgCloud">
        <h2>Cloud account</h2>
        <div id="orgCloudConnect">
          <CloudConnectForm idPrefix="orgCloudConnect" orgId={orgId} onConnected={onConnected} />
        </div>
      </div>
    );
  }
  return (
    <div id="orgCloud">
      <h2>Cloud account</h2>
      <CloudCard orgId={orgId} fly={fly} role={org.role} />
    </div>
  );
}

export function OrganizationScreen() {
  const api = useOrgApi();
  const { state, switchWorkplace, reload } = useWorkspace();
  /** A workplace of one nobody can join (note #205, workplaceHasTeam): no
   *  head count, role or People door. */
  const peopleHidden = !workplaceHasTeam(state?.org, state?.invitesClosed);
  const seats = useSeats();
  const banner = useBanner();
  const ask = useConfirm();
  const navigate = useNavigate();
  const { org, error, refresh } = useOrgDetail();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const closeDelete = useCallback(() => setDeleting(false), []);
  const [busy, setBusy] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ orgId: string; invite: WorkspaceOrgInvite } | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);
  const orgId = org?.orgId ?? state?.org?.orgId ?? '';
  const lastInvite = lastCreated?.orgId === orgId ? lastCreated.invite : null;
  // What the invites card is actually showing: the read's links, plus one just
  // made that the next read has not carried back yet.
  const shownInvites = [
    ...org?.invites ?? [],
    ...lastInvite && !org?.invites?.some((invite) => invite.token === lastInvite.token) ? [lastInvite] : [],
  ];
  const title = org?.name ?? state?.org?.name ?? 'Workplace';

  const admins = org?.members.filter((member) => member.role === 'admin') ?? [];
  const you = org?.members.find((member) => member.you);
  const soleAdmin = Boolean(org && org.members.length === 1 && you?.role === 'admin');

  /** After leaving or deleting: this tab stands in whatever the server put
   *  this person in next (note #628) — a read as the workplace just left
   *  would be refused, not redirected. */
  const leaveHome = async (next: string | null) => {
    seats.invalidate();
    if (next) {
      const refresh = switchWorkplace(next);
      navigate('/', { replace: true });
      await refresh;
      return;
    }
    standInWorkplace(null);
    navigate('/', { replace: true });
    await reload();
  };

  const createInviteLink = async () => {
    setCreatingLink(true);
    setBusy(true);
    const result: { invite?: WorkspaceOrgInvite } = {};
    try {
      await copyFromTap(() => api.api<WorkspaceOrgInviteCreatedAnswer>('api/org/invites', { method: 'POST' }, { org: orgId }).then((r) => {
        result.invite = r.invite;
        setLastCreated({ orgId, invite: r.invite });
        return r.invite.link ?? '';
      }));
      banner.show('Invite link copied. It works until you revoke it; each request needs admin approval.', true);
    } catch (err) {
      banner.show(result.invite ? 'Link created. Copy it from the field below.' : errorMessage(err));
    } finally {
      if (result.invite) {
        const updated = await refresh();
        if (updated) setLastCreated(null);
      }
      setBusy(false);
      setCreatingLink(false);
    }
  };

  if (deleting && org) {
    return (
      <WorkplaceDeleteScreen
        onClose={closeDelete}
        // The lock screen is the Workspace's next read: it stands in front of
        // everything until an admin keeps the workplace or its week is up.
        onScheduled={async () => { await Promise.all([refresh(), reload()]); setDeleting(false); }}
        onDeleted={leaveHome}
      />
    );
  }

  if (renaming && org) {
    return (
      <WorkplaceNameForm
        current={org.name}
        onClose={() => setRenaming(false)}
        onWritten={async () => {
          // The detail title and every workplace switch both carry the name.
          // Keep the transient form standing until both reads have the server's
          // answer, so closing it never flashes the old name back at the user.
          await Promise.all([refresh(), reload()]);
          setRenaming(false);
        }}
      />
    );
  }

  return (
    <div className="screen" id="screenOrg">
      <ScreenTitle
        titleId="orgTitle"
        title={title}
        subId="orgSub"
        // No head count and no role while inviting is switched off (note
        // #205), and never a public address: a workplace has none (note #748).
        sub={org && !peopleHidden
          ? `${org.members.length === 1 ? 'One person' : `${org.members.length} people`}${org.role === 'admin' ? ' · you’re an admin' : ''}`
          : ''}
      />
      {org?.deletion
        ? (
          // Reached from a deletion email while another workplace is the one
          // open (2026-09-22): the lock screen stands only in front of the
          // active workplace, so this page says it, and keeps it, itself.
          <div className="card" id="orgDeletionNotice">
            <div className="empty">
              {org.deletion.requestedByName} asked to delete {org.name}. It will be deleted for good on {absolute(org.deletion.purgeAt)}.
            </div>
            {org.deletion.canKeep
              ? (
                <button
                  className="addrow" id="orgDeletionKeep" type="button" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.api('api/org/deletion', { method: 'DELETE' });
                      banner.show(`${org.name} will not be deleted.`, true);
                      await Promise.all([refresh(), reload()]);
                    } catch (err) { banner.show(errorMessage(err)); }
                    setBusy(false);
                  }}
                >
                  Keep this workplace
                </button>
              )
              : null}
          </div>
        )
        : null}
      {/* The door onto the People page, gone while inviting is switched off
          (note #205). The page still loads: the card below stands in for
          the loading line it used to carry. */}
      {peopleHidden
        ? !org ? <div className="card"><div className="empty">{error || 'Loading…'}</div></div> : null
        : (
          <div className="card" id="orgPeopleCard">
            {!org
              ? <div className="empty">{error || 'Loading…'}</div>
              : <PeopleDoor members={org.members} onOpen={() => navigate(toFor({ kind: 'organizationPeople', orgId })!)} />}
          </div>
        )}
      {org?.joinRequests ? (
        <section id="orgJoinRequests" aria-labelledby="orgJoinRequestsTitle">
          <h2 id="orgJoinRequestsTitle">Join requests</h2>
          <div className="card">
            {org.joinRequests.length === 0 ? (
              <EmptyState glyph="check" title="No pending requests." body="People who use an invite link appear here." />
            ) : org.joinRequests.map((request) => <JoinRequestRow key={request.requestId} request={request} orgId={orgId} refresh={refresh} />)}
          </div>
        </section>
      ) : null}
      {org?.invites ? (
        <section id="orgInvites" aria-labelledby="orgInviteLinksTitle">
          {/* One link per workplace, so the heading is singular and the create
              row only stands where there is nothing to create beside. A
              workplace that already held several keeps them, listed and each
              revocable — hence the plural, which a workplace made today will
              never see. */}
          <h2 id="orgInviteLinksTitle">{shownInvites.length > 1 ? 'Invite links' : 'Invite link'}</h2>
          <div className="card" id="orgInvitesList">
            {shownInvites.length === 0 ? (
              <EmptyState glyph="link" title="No invite link yet." body="Create one to invite someone." />
            ) : null}
            {org.invites.map((invite) => <InviteLinkRow key={invite.token} invite={invite} orgId={orgId} onChanged={refresh} />)}
            {lastInvite && !org.invites.some((invite) => invite.token === lastInvite.token)
              ? <InviteLinkRow invite={lastInvite} orgId={orgId} onChanged={async () => { setLastCreated(null); await refresh(); }} /> : null}
            {shownInvites.length === 0 ? (
              <button className="addrow" id="orgInviteBtn" type="button" disabled={busy} aria-label="Create invite link" onClick={() => void createInviteLink()}>
                {creatingLink ? <span className="spinner" /> : null}
                {creatingLink ? 'Creating invite link…' : 'Create invite link'}
              </button>
            ) : null}
          </div>
          <p className="formhint">Your workplace has one link. It works until you revoke it, and you approve everyone who asks to join.</p>
        </section>
      ) : null}
      {org ? <CloudSection org={org} onConnected={() => { void refresh(); }} /> : null}
      {org ? <CodeSection org={org} refresh={refresh} /> : null}
      {/* Auto-approve mode (note #944): what happens to every proposal here. */}
      {org ? <AutoApproveSection key={orgId} /> : null}
      {org ? <BackupsSection org={org} /> : null}
      {/* A private copy's health and diagnostics, for its admins (note #813). */}
      {org && PRIVATE_COPY && org.role === 'admin' ? <CopyHealthSection /> : null}
      {org && !soleAdmin
        ? (
          <>
            <h2>Membership</h2>
            <div className="card" id="orgActions">
              {you?.role === 'admin' && admins.length === 1
                ? <div className="empty">Promote another member before the last admin can leave.</div>
                : (
                  <button
                    className="addrow"
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const ownAgents = Number(you?.agents) || 0;
                      const sure = await ask({
                        title: `Leave ${org.name}?`,
                        message: `${ownAgents ? `${ownAgents} agent${ownAgents === 1 ? '' : 's'} you own here will be permanently retired. ` : ''}Your private sign-ins stay yours, and work shared with the workplace stays there.`,
                        verb: 'Leave',
                        danger: true,
                      });
                      if (!sure) return;
                      setBusy(true);
                      try {
                        const left = await api.api<WorkspaceOrgLeftAnswer>('api/org/membership', { method: 'DELETE' }, { org: orgId });
                        await leaveHome(left.activeOrgId ?? null);
                        banner.show(`You left ${org.name}.`, true);
                      } catch (err) { banner.show(errorMessage(err)); setBusy(false); }
                    }}
                  >
                    Leave {org.name}
                  </button>
                )}
            </div>
          </>
        )
        : null}
      {org?.role === 'admin'
        ? (
          // The workplace's own two actions, at the page's trailing edge:
          // Rename as a secondary action, Delete right under it (owner,
          // 2026-09-22). Neither is the page's primary move.
          <div className="actions" id="orgNameActions">
            <button className="btn ghost" id="orgRenameBtn" type="button" disabled={busy} onClick={() => setRenaming(true)}>Rename this workplace</button>
            {org.canDelete
              ? <button className="btn danger bare" id="orgDeleteDoor" type="button" disabled={busy} onClick={() => setDeleting(true)}>Delete this workplace</button>
              : null}
          </div>
        )
        : null}
    </div>
  );
}
