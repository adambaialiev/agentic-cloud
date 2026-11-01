import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DriveAccess, DriveDetail, DriveItem, DrivePreview } from '../../../../src/shared/drive.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBanner } from '../../chrome/useBanner.js';
import { Markdown } from '../../render/Markdown.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { bytes, fileExt, fileIcon } from '../../ui/file-kind.js';
import { copyFromTap, errorMessage } from '../../ui/format.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { saveFile } from '../../ui/save-file.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { useWait } from '../../ui/wait.js';
import { toFor } from '../../routes.js';
import { CodeView } from '../repos/CodeView.js';
import { DriveCrumbs } from './DriveCrumbs.js';
import { folderLink } from './drive-links.js';
import { DriveManage } from './DriveForms.js';
import { driveApi, useDriveOrg, useDriveRead } from './drive-api.js';
import { heldDriveItem } from './drive-cache.js';

function PreviewFallback({ item, children }: { item: DriveItem; children: ReactNode }) {
  return <div className="card drivefile"><TypeIcon {...fileIcon(item.name)} /><p>{item.name}</p><div className="sub">{children}</div></div>;
}

function TextPreview({ item, preview }: { item: DriveItem; preview: Extract<DrivePreview, { kind: 'markdown' | 'text' }> }) {
  const banner = useBanner();
  const [raw, setRaw] = useState(false);
  const markdown = preview.kind === 'markdown';
  const formatted = markdown && !raw;
  const ext = fileExt(item.name);
  return <>
    <div className="filebar">
      <div className="kind">{formatted ? 'Markdown' : markdown ? 'Markdown source' : ext ? ext.toUpperCase() : 'Text'}</div>
      {markdown ? <button className="act" type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
        {formatted ? 'View raw' : 'View formatted'}
      </button> : null}
      <button className="act" type="button" onClick={() => {
        void copyFromTap(async () => preview.content)
          .then(() => banner.show(`Copied ${item.name}`, true))
          .catch(() => banner.show('Could not reach the clipboard — try again.'));
      }}><Icon name="copy" size={15} /><span>Copy</span></button>
    </div>
    {formatted ? <Markdown source={preview.content} /> : <CodeView content={preview.content} ext={ext} />}
  </>;
}

/** How much of a signature's life has to be left for a held preview to be
 *  worth showing. A minute is longer than any first paint and shorter than
 *  anything a reader would notice, and it keeps the browser from being handed
 *  a URL that dies between the render and the request for its bytes. */
const PREVIEW_SIGNATURE_MARGIN_MS = 60_000;

/**
 * Whether a preview this tab already holds still describes the file.
 *
 * A file's bytes never change under its own id, so the only thing that can go
 * out of date here is the fifteen-minute signature on an image, PDF or media
 * URL. While one is good the held answer is shown AND not asked for again —
 * re-reading would hand the same picture back behind a new signature, and
 * swapping the `src` of an image already on the glass reloads it in front of
 * the reader. Once it is gone, or was never a stamp we can read, the held copy
 * is worse than nothing: its URL now answers 403.
 */
function previewStillSigned(preview: DrivePreview): boolean {
  if (!('expiresAt' in preview)) return true;
  const expires = Date.parse(preview.expiresAt);
  return Number.isFinite(expires) && expires - Date.now() > PREVIEW_SIGNATURE_MARGIN_MS;
}

function Preview({ orgId, item }: { orgId: string; item: DriveItem }) {
  const { data, error } = useDriveRead<DrivePreview>(driveApi(orgId, `/${item.id}/preview`), { poll: false, stillTrue: previewStillSigned });
  const [broken, setBroken] = useState(false);
  const viewer = useImageViewer();
  const wait = useWait(!data && !error);
  if (broken || error) return <PreviewFallback item={item}>This preview could not be loaded. Download the file to open it.</PreviewFallback>;
  if (!data) return wait === 'drawn' ? <div className="card drivepreviewwait" aria-busy="true">Loading preview…</div> : null;
  if (data.kind === 'unsupported') return <PreviewFallback item={item}>There isn’t a safe browser preview for this file type. Download it to open it.</PreviewFallback>;
  if (data.kind === 'too-large') return <PreviewFallback item={item}>Text files over {bytes(data.maxBytes)} are too large to preview here. Download it to open the whole file.</PreviewFallback>;
  if (data.kind === 'markdown' || data.kind === 'text') return <TextPreview item={item} preview={data} />;
  if (data.kind === 'image') return <button className="drivepreview" aria-label={`View ${item.name} full screen`} onClick={() => viewer([{ name: item.name, url: data.url }], 0)}>
    <img src={data.url} alt={item.name} onError={() => setBroken(true)} /></button>;
  // Browser PDF viewers are already isolated from the parent page. A sandbox
  // attribute here makes Chromium block its own viewer entirely, leaving a
  // convincing but unreadable grey frame.
  if (data.kind === 'pdf') return <iframe className="drivepdf" src={data.url} title={`Preview of ${item.name}`} />;
  if (data.kind === 'video') return <div className="drivemedia"><video src={data.url} aria-label={`Preview of ${item.name}`} controls preload="metadata" onError={() => setBroken(true)} /></div>;
  return <div className="drivemedia"><audio src={data.url} aria-label={`Preview of ${item.name}`} controls preload="metadata" onError={() => setBroken(true)} /></div>;
}
export function DriveFileScreen() {
  const { id = '' } = useParams();
  const orgId = useDriveOrg();
  const { state: workspace } = useWorkspace();
  const { api } = useSession();
  const navigate = useNavigate();
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, error: readError, reload } = useDriveRead<DriveDetail>(orgId ? driveApi(orgId, `/${id}`) : null);
  // A file opened for the first time needs no read to draw its own heading:
  // the row that was tapped carried its name, its size and the trail of
  // folders above it, so everything but the preview is already known.
  const outline = !data ? heldDriveItem(orgId, id) : null;
  const detail: DriveDetail | null = data
    ?? (outline ? { canDeleteForever: outline.canDeleteForever, item: outline.item, breadcrumbs: outline.breadcrumbs } : null);
  const item = detail?.item;
  const wait = useWait(!detail && !readError);
  if (workspace && !orgId) return <div className="screen"><ScreenTitle title="Drive" />
    <div className="card authpanel" role="alert">Open Drive from a workplace in your Workspace.</div></div>;
  if (managing && item) return <DriveManage orgId={orgId} item={item} canDeleteForever={detail?.canDeleteForever ?? false} onClose={() => setManaging(false)}
    onSaved={(action, updated) => { setManaging(false); reload();
      if (action === 'delete') navigate(toFor({ kind: 'driveTrash', orgId })!, { replace: true });
      else if (action !== 'rename') navigate(folderLink(orgId, updated ? updated.parentId : item.parentId), { replace: true }); }} />;
  const download = async () => {
    setBusy(true); setError('');
    try {
      const access = await api.api<DriveAccess>(driveApi(orgId, `/${id}/access`));
      saveFile(access.url, access.fileName);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="screen" id="screenDriveFile">
    <ScreenTitle title={item?.name ?? 'File'} sub={item ? `${bytes(item.sizeBytes)}${item.trashedAt ? ' · In Trash' : ''}` : undefined} />
    {detail ? <DriveCrumbs orgId={orgId} items={detail.breadcrumbs.filter((entry) => !entry.trashedAt)} /> : null}
    {readError || error ? <div className="card authpanel" role="alert">{readError || error}<button className="btn" onClick={reload}>Try again</button></div> : null}
    {wait === 'drawn' ? <div className="empty">Loading file…</div> : null}
    {item ? <>
      <div className="drivebar"><button className="act" disabled={busy} onClick={() => { void download(); }}>{busy ? 'Preparing download…' : 'Download'}</button>
        <button className="act" onClick={() => setManaging(true)}>Manage file</button></div>
      <Preview orgId={orgId} item={item} />
    </> : null}
  </div>;
}
