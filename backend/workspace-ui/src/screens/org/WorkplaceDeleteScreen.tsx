/**
 * Deleting the whole workplace (owner, 2026-09-22): a transient leaf over its
 * detail address, like the rename. It says what goes, what stays, and when —
 * then asks for the name, typed, exactly as deleting a room does.
 *
 * A workplace with nothing in it and nobody else here goes as soon as that is
 * typed. Any other one LOCKS instead: its agents stop, every member is
 * emailed and sees the lock screen, and it is deleted for good three days later
 * unless an admin keeps it. Nothing in the workplace's own Fly account is
 * destroyed, and the screen says so before anyone confirms.
 */

import { useEffect, useState } from 'react';
import type {
  WorkspaceOrgDeletionAnswer,
  WorkspaceOrgDeletionPreview,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { AskByTyping } from '../../ui/Ask.js';
import { absolute, errorMessage } from '../../ui/format.js';
import { useOrgApi } from './useOrgApi.js';

type Holds = WorkspaceOrgDeletionPreview['holds'];

/** The shelves in the order a person thinks of them, each with its one word.
 *  Rooms led them until rooms left the product (note #843); the preview
 *  still counts them, and nothing here says so. */
const GOES: ReadonlyArray<[keyof Holds, string, (n: number) => string]> = [
  ['agents', 'Agents', (n) => String(n)],
  ['repos', 'Repositories', (n) => String(n)],
  ['sites', 'Sites', (n) => `${n} · ${n === 1 ? 'its address becomes' : 'their addresses become'} free`],
  ['notes', 'Notes', (n) => String(n)],
  ['knowledge', 'Knowledge pages', (n) => String(n)],
  ['drive', 'Drive', (n) => (n === 1 ? '1 item' : `${n} items`)],
  ['secrets', 'Keys', (n) => String(n)],
];

export function WorkplaceDeleteScreen({ onClose, onScheduled, onDeleted }: {
  onClose: () => void;
  /** Locked for its three days: the Workspace's next read shows the lock screen. */
  onScheduled: () => Promise<void> | void;
  /** Gone at once (it was empty): leave for whatever is left — the
   *  workplace the server put this person in next, or none. */
  onDeleted: (next: string | null) => Promise<void> | void;
}) {
  const api = useOrgApi();
  const banner = useBanner();
  const [preview, setPreview] = useState<WorkspaceOrgDeletionPreview | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useBackClaim(onClose);

  useEffect(() => {
    let cancelled = false;
    api.api<WorkspaceOrgDeletionPreview>('api/org/deletion')
      .then((answer) => { if (!cancelled) setPreview(answer); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [api]);

  const confirm = (confirmed: boolean) => {
    setAsking(false);
    if (!confirmed || !preview) return;
    setBusy(true);
    void (async () => {
      try {
        const answer = await api.api<WorkspaceOrgDeletionAnswer>('api/org/deletion', jsonBody({ name: preview.name }));
        if ('deleted' in answer) {
          banner.show(`Deleted ${preview.name}.`, true);
          await onDeleted(answer.activeOrgId ?? null);
        } else {
          banner.show(`${preview.name} is locked and will be deleted on ${absolute(answer.deletion.purgeAt)}.`, true);
          await onScheduled();
        }
      } catch (err) {
        banner.show(errorMessage(err));
        setBusy(false);
      }
    })();
  };

  const goes = preview ? GOES.filter(([key]) => preview.holds[key] > 0) : [];
  const others = preview ? preview.holds.people - 1 : 0;

  return (
    <div className="screen" id="screenOrgDelete">
      <ScreenTitle titleId="orgDeleteTitle" title="Delete workplace" sub={preview?.name ?? ''} subId="orgDeleteSub" />
      {!preview
        ? <div className="card"><div className="empty">{error || 'Loading…'}</div></div>
        : (
          <>
            <div className="sub" id="orgDeleteWhen">
              {preview.immediate
                ? 'Nothing is in it and nobody else is here, so it is deleted as soon as you confirm.'
                : `It locks as soon as you confirm: its agents stop, and nothing new can start there. It is deleted for good on ${absolute(preview.purgeAt)}. Until then any admin can keep it.`}
            </div>
            <h2>What goes</h2>
            <div className="card" id="orgDeleteGoes">
              {goes.length
                ? goes.map(([key, label, words]) => (
                  <div className="drow" key={key}><div className="k">{label}</div><div className="v">{words(preview.holds[key])}</div></div>
                ))
                : <div className="empty">Nothing yet — the workplace is empty.</div>}
            </div>
            <h2>What stays</h2>
            <div className="card" id="orgDeleteStays">
              <div className="drow">
                <div className="k">{others > 0 ? 'Everyone’s account' : 'Your account'}</div>
                <div className="v">{others > 0 ? 'Their email, private sign-ins and other workplaces' : 'Your email, private sign-ins and other workplaces'}</div>
              </div>
              {preview.cloud
                ? (
                  <div className="drow">
                    <div className="k">Your Fly account</div>
                    <div className="v">{preview.cloud}: its machines and storage stay there, and keep costing money until you remove them in Fly.</div>
                  </div>
                )
                : null}
            </div>
            {!preview.immediate
              ? (
                <p className="formhint" id="orgDeleteTold">
                  {others > 0
                    ? `Everyone in it — ${preview.holds.people} people — gets an email now, and again when it is gone.`
                    : 'You get an email now, and again when it is gone.'}
                </p>
              )
              : null}
            <div id="orgDanger">
              <div id="orgDangerActions">
                <button className="btn danger bare" id="orgDeleteConfirm" type="button" disabled={busy} onClick={() => setAsking(true)}>
                  {busy ? 'Deleting…' : 'Delete workplace'}
                </button>
              </div>
            </div>
          </>
        )}
      {asking && preview
        ? (
          <AskByTyping
            name={preview.name}
            lines={preview.immediate
              ? ['It is deleted now. This cannot be undone.']
              : [`It locks now and is deleted for good on ${absolute(preview.purgeAt)}.`, 'Until then any admin can keep it.']}
            verb="Delete"
            onAnswer={confirm}
          />
        )
        : null}
    </div>
  );
}
