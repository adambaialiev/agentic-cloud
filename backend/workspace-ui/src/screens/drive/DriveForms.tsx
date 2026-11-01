import { useState } from 'react';
import type { DriveItem, DriveListing } from '../../../../src/shared/drive.js';
import { jsonBody } from '../../api/client.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useSession } from '../../session/useSession.js';
import { AskByTyping, AskToConfirm } from '../../ui/Ask.js';
import { errorMessage } from '../../ui/format.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { bytes } from '../../ui/file-kind.js';
import { driveApi, saveDriveFolder, useDriveRead } from './drive-api.js';
import { forgetDrives } from './drive-cache.js';

export function DriveNameForm({ orgId, parentId, onClose, onSaved }: {
  orgId: string; parentId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const { api } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useBackClaim(onClose);
  return <div className="screen"><ScreenTitle title="New folder" />
    <form onSubmit={(event) => { event.preventDefault(); setBusy(true); setError('');
      void api.api(driveApi(orgId, '/folders'), jsonBody({ name, parentId }))
        .then(() => { forgetDrives(); onSaved(); })
        .catch((error) => setError(errorMessage(error))).finally(() => setBusy(false)); }}>
      <div className="card"><label className="drow frow"><span className="k">Folder name</span>
        <input aria-label="Folder name" required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label></div>
      {error ? <p role="alert">{error}</p> : null}
      <button className="formcommit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create folder'}</button>
    </form>
  </div>;
}

function MovePicker({ orgId, item, busy, onMove }: { orgId: string; item: DriveItem; busy: boolean; onMove: (id: string | null) => void }) {
  const [parent, setParent] = useState<string | null>(null);
  const { data, error, reload } = useDriveRead<DriveListing>(driveApi(orgId, '', { parent: parent ?? '' }));
  const folders = data?.items.filter((entry) => entry.kind === 'folder' && entry.id !== item.id) ?? [];
  return <>
    <div className="sub">Choose a destination for {item.name}.</div>
    <div className="drivebar"><span>{data?.folder?.name ?? 'Drive'}</span>
      {parent && data ? <button className="act" onClick={() => setParent(data.folder?.parentId ?? null)}>Up one folder</button> : null}</div>
    {error ? <p role="alert">{error} <button className="act" onClick={reload}>Try again</button></p> : null}
    <div className="card">{folders.map((folder) => <button className="crow drivepick" key={folder.id} onClick={() => setParent(folder.id)}>
      <TypeIcon glyph="folder" /><span className="main"><span className="name">{folder.name}</span></span><Icon name="chev" size={18} /></button>)}
      {data && !folders.length ? <div className="empty">No folders here.</div> : null}</div>
    <button className="formcommit" disabled={!data || busy || parent === item.parentId} onClick={() => onMove(parent)}>{busy ? 'Moving…' : 'Move here'}</button>
  </>;
}

export function DriveManage({ orgId, item, canDeleteForever, onClose, onSaved }: {
  orgId: string; item: DriveItem; canDeleteForever: boolean; onClose: () => void;
  onSaved: (action: 'rename' | 'move' | 'trash' | 'restore' | 'delete', item?: DriveItem) => void;
}) {
  const { api } = useSession();
  const [name, setName] = useState(item.name);
  const [moving, setMoving] = useState(false);
  const [asking, setAsking] = useState<'trash' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackClaim(() => { if (moving) setMoving(false); else onClose(); });
  const download = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await saveDriveFolder(api, orgId, item.id); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const write = async (action: 'rename' | 'move' | 'trash' | 'restore' | 'delete', parentId?: string | null) => {
    if (busy) return;
    setBusy(true); setError('');
    const suffix = ['trash', 'restore'].includes(action) ? `/${action}` : '';
    const body = action === 'rename' ? jsonBody({ name }, 'PATCH') : action === 'move' ? jsonBody({ parentId }, 'PATCH')
      : { method: action === 'delete' ? 'DELETE' : 'POST' };
    try {
      const answer = await api.api<{ item?: DriveItem }>(driveApi(orgId, `/${item.id}${suffix}`), body);
      // Every copy this tab holds, not just this folder's: a move empties one
      // listing and fills another, a rename changes a row in every search that
      // matched it, and trash, restore and permanent deletion all move counts
      // that are drawn on every listing there is.
      forgetDrives();
      onSaved(action, answer.item);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="screen" id="screenDriveManage">
    <ScreenTitle title={moving ? 'Move item' : item.name} sub={item.kind === 'folder' ? 'Folder' : bytes(item.sizeBytes)} />
    {error ? <p role="alert">{error}</p> : null}
    {moving ? <MovePicker orgId={orgId} item={item} busy={busy} onMove={(parentId) => { void write('move', parentId); }} /> : <>
      <form onSubmit={(event) => { event.preventDefault(); void write('rename'); }}>
        <div className="card"><label className="drow frow"><span className="k">Name</span>
          <input aria-label="Item name" required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label></div>
        <button className="formcommit" disabled={busy || !name.trim() || name.trim() === item.name}>{busy ? 'Saving…' : 'Save name'}</button>
      </form>
      <div className="card driveactions">
        {item.trashedAt ? <>
          <button className="crow drivepick" disabled={busy} onClick={() => { void write('restore'); }}><Icon name="back" size={18} /><span>Restore</span></button>
          {canDeleteForever ? <button className="crow drivepick danger" disabled={busy} onClick={() => setAsking('delete')}><Icon name="trash" size={18} /><span>Delete forever</span></button> : null}
        </> : <>
          {item.kind === 'folder' ? <button className="crow drivepick" disabled={busy} onClick={() => { void download(); }}><Icon name="download" size={18} /><span>Download as .zip</span></button> : null}
          <button className="crow drivepick" disabled={busy} onClick={() => setMoving(true)}><Icon name="folder" size={18} /><span>Move to folder</span></button>
          <button className="crow drivepick" disabled={busy} onClick={() => setAsking('trash')}><Icon name="trash" size={18} /><span>Move to Trash</span></button>
        </>}
      </div>
      <p className="formhint">{item.trashedAt ? 'Restore returns this item to its folder, or to Drive if that folder is unavailable. Rename it here if that name is already taken.' : 'Everyone in the workplace shares these files. Items in Trash can be restored.'}</p>
    </>}
    {asking === 'trash' ? <AskToConfirm title={`Move ${item.name} to Trash?`} message={item.kind === 'folder' ? 'The folder and its contents can be restored from Trash.' : 'You can restore this file from Trash.'} verb="Move to Trash" onAnswer={(yes) => { setAsking(null); if (yes) void write('trash'); }} /> : null}
    {asking === 'delete' ? <AskByTyping name={item.name} lines={['This permanently deletes the item and everything inside it for everyone in the workplace. It cannot be restored.']} verb="Delete forever" onAnswer={(yes) => { setAsking(null); if (yes) void write('delete'); }} /> : null}
  </div>;
}
