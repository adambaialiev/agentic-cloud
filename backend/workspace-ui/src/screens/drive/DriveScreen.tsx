import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DRIVE_FILE_MAX_BYTES, type DriveItem, type DriveListing } from '../../../../src/shared/drive.js';
import { UPLOAD_PART_BYTES, type PartedUploadPart, type PartedUploadStart } from '../../../../src/shared/uploads.js';
import { sendInParts, uploadPercent } from '../../ui/parted-upload.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { bytes } from '../../ui/file-kind.js';
import { errorMessage } from '../../ui/format.js';
import { Icon } from '../../ui/icons.js';
import { useWait } from '../../ui/wait.js';
import { toFor } from '../../routes.js';
import { DriveCrumbs } from './DriveCrumbs.js';
import { WITHIN_DRIVE, folderLink } from './drive-links.js';
import { DriveItems } from './DriveItems.js';
import { DriveManage, DriveNameForm } from './DriveForms.js';
import { driveApi, saveDriveFolder, useDriveOrg, useDriveRead } from './drive-api.js';
import { forgetDrives, heldDriveItem } from './drive-cache.js';

export function DriveScreen({ trash = false }: { trash?: boolean }) {
  const { id } = useParams();
  const orgId = useDriveOrg();
  const { state: workspace } = useWorkspace();
  const { api } = useSession();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<DriveItem | null>(null);
  const [uploading, setUploading] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const { data, error, reload } = useDriveRead<DriveListing>(orgId ? driveApi(orgId, '', { parent: id ?? '', ...(trash ? { trash: '1' } : {}), ...(search ? { q: search } : {}) }) : null);
  const wait = useWait(!data && !error);
  // The frame of a folder opened for the first time, from the listing its row
  // was tapped in: its name, the trail above it and Drive's own counts were
  // never in doubt, so they are drawn at once and only the contents wait. Not
  // for a search or for Trash — the server answers both with no folder and no
  // breadcrumbs, so an outline would be replaced rather than confirmed.
  const outline = !data && id && !trash && !search ? heldDriveItem(orgId, id) : null;
  const frame: Pick<DriveListing, 'folder' | 'breadcrumbs' | 'trashCount' | 'canDeleteForever'> | null = data
    ?? (outline ? { folder: outline.item, breadcrumbs: [...outline.breadcrumbs, outline.item],
      trashCount: outline.trashCount, canDeleteForever: outline.canDeleteForever } : null);
  const upload = async (files: File[]) => {
    if (busy.current || trash || !orgId) return;
    busy.current = true;
    setDragging(false); setFailures([]);
    const failed: string[] = [];
    for (const file of files) {
      setUploading(file.name);
      try {
        if (file.size > DRIVE_FILE_MAX_BYTES) throw new Error('Files can be up to 1 GB.');
        if (file.size <= UPLOAD_PART_BYTES) {
          await api.api(driveApi(orgId, '/files', { parent: id ?? '' }), { method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'x-drive-name': encodeURIComponent(file.name) }, body: file });
        } else {
          // Bigger than one part: in parts, with progress (note #784).
          await sendInParts(file, {
            start: () => api.api<PartedUploadStart>(driveApi(orgId, '/uploads'), { method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, parentId: id ?? null, sizeBytes: file.size }) }),
            part: (started, number, body) => api.api<PartedUploadPart>(driveApi(orgId, `/uploads/${started.id}/parts/${number}`, { upload: started.uploadId }), {
              method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body }),
            complete: (started, parts) => api.api(driveApi(orgId, `/uploads/${started.id}/complete`), { method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: started.uploadId, name: file.name, parentId: id ?? null, parts }) }),
            abort: (started) => api.api(driveApi(orgId, `/uploads/${started.id}`, { upload: started.uploadId }), { method: 'DELETE' }),
          }, (sent, total) => setUploading(`${file.name}… ${uploadPercent(sent, total)}`));
        }
        forgetDrives();
        setQuery(''); setSearch(''); reload();
      } catch (error) { failed.push(`${file.name}: ${errorMessage(error)}`); }
    }
    setFailures(failed); setUploading(''); busy.current = false;
    reload();
  };
  const downloadFolder = async () => {
    setZipping(true); setZipError('');
    try { await saveDriveFolder(api, orgId, id ?? null); }
    catch (error) { setZipError(errorMessage(error)); }
    finally { setZipping(false); }
  };
  if (workspace && !orgId) return <div className="screen"><ScreenTitle title="Drive" />
    <div className="card authpanel" role="alert">Open Drive from a workplace in your Workspace.</div></div>;
  if (creating) return <DriveNameForm orgId={orgId} parentId={id ?? null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); setQuery(''); setSearch(''); reload(); }} />;
  if (managing) return <DriveManage orgId={orgId} item={managing} canDeleteForever={frame?.canDeleteForever ?? false} onClose={() => setManaging(null)}
    onSaved={(action, item) => { setManaging(null); reload();
      if (managing.id === id && action !== 'rename') navigate(folderLink(orgId, item ? item.parentId : managing.parentId), { replace: true }); }} />;
  return <div className={`screen${dragging ? ' drive-dragging' : ''}`} id="screenDrive"
    onDragOver={(event) => { if (!trash && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { if (!trash) {
      event.preventDefault(); setDragging(false);
      if (Array.from(event.dataTransfer.items).some((entry) => entry.webkitGetAsEntry?.()?.isDirectory)) {
        setFailures(['Create a folder here, then upload the files inside it.']); return;
      }
      void upload(Array.from(event.dataTransfer.files));
    } }}>
    <ScreenTitle title={trash ? 'Trash' : frame?.folder?.name ?? 'Drive'} sub={trash ? 'Items stay here until restored or deleted forever.' : 'Files shared with your workplace.'} />
    {(id || trash || search) ? <DriveCrumbs orgId={orgId} items={frame?.breadcrumbs ?? []} /> : null}
    <div className="drivebar">
      {!trash ? <><button className="act" disabled={Boolean(uploading)} onClick={() => picker.current?.click()}><Icon name="plus" size={18} />Upload files</button>
        <button className="act" onClick={() => setCreating(true)}><Icon name="folder" size={18} />New folder</button></> : null}
      {!trash && !search && data?.items.length ? <button className="act" disabled={zipping} onClick={() => { void downloadFolder(); }}>
        <Icon name="download" size={18} />{zipping ? 'Preparing download…' : id ? 'Download folder' : 'Download all'}</button> : null}
      {frame?.folder ? <button className="act" onClick={() => setManaging(frame.folder)}>Manage folder</button> : null}
      {!trash ? <Link className="act" {...WITHIN_DRIVE} to={toFor({ kind: 'driveTrash', orgId })!}><Icon name="trash" size={18} />Trash{frame?.trashCount ? ` (${frame.trashCount})` : ''}</Link> : null}
    </div>
    <input type="file" multiple hidden ref={picker} aria-label="Upload files" onChange={(event) => {
      const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files);
    }} />
    <form className="drivesearch" role="search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}>
      <input type="search" aria-label="Search Drive" placeholder={trash ? 'Search Trash' : 'Search all files and folders'} value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSearch(''); }} />
      <button className="act" type="submit">Search</button>
    </form>
    {search ? <div className="sub">Results for “{search}” <button className="act" onClick={() => { setQuery(''); setSearch(''); }}>Clear</button></div> : null}
    {uploading ? <div className="card crow" role="status" id="driveUploading"><span className="spinner" /><span className="main">Uploading {uploading.includes('…') ? uploading : `${uploading}…`}</span></div> : null}
    {failures.length ? <div className="card authpanel" role="alert">{failures.map((failure) => <p key={failure}>{failure}</p>)}<p>Choose the failed files again to retry.</p></div> : null}
    {zipError ? <div className="card authpanel" role="alert">{zipError}</div> : null}
    {error ? <div className="card authpanel" role="alert">{error}<button className="btn" onClick={reload}>Try again</button></div> : null}
    {wait === 'drawn' ? <div className="card" aria-busy="true"><div className="empty">Loading Drive…</div></div> : null}
    {data && wait === 'ready' ? <>
      <DriveItems items={data.items} orgId={orgId} trash={trash} onManage={setManaging}
        empty={search ? 'No matching files or folders.' : trash ? 'Trash is empty.' : 'This folder is empty. Upload files or create a folder to get started.'} />
      <div className="formhint">{bytes(data.totalBytes)} stored, including Trash. Files up to 1 GB.</div>
    </> : null}
  </div>;
}
