import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { drivePreviewKind, type DriveItem } from '../../../../src/shared/drive.js';
import { bytes, fileIcon } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { stopwatch } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { WITHIN_DRIVE, driveBrowserUrl, folderLink } from './drive-links.js';
import { useRowPlayer, type RowPlayer } from './useRowPlayer.js';

/**
 * A row's mark: a picture is drawn as ITSELF (note #694), a recording is its
 * own play button (note #698), and everything else is the glyph for its
 * kind, all in one square so the names line up.
 *
 * The picture's address is the row's own and never changes, so a list
 * redrawn by its poll hands the <img> the src it already has and nothing is
 * fetched again; `lazy` leaves a long folder's lower rows alone until they
 * are scrolled to. The glyph stands until the pixels land and comes back if
 * they never do — a HEIC the browser cannot decode, a file gone since — and
 * a recording that will not play gets its glyph back the same way.
 */
function DriveMark({ item, orgId, player }: { item: DriveItem; orgId: string; player: RowPlayer }) {
  const kind = item.kind === 'file' ? drivePreviewKind(item) : null;
  const picture = kind === 'image';
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  if (kind === 'audio' && !player.broken.has(item.id)) {
    const playing = player.track?.id === item.id && player.track.playing;
    return <button type="button" className="drivemark play" aria-label={`${playing ? 'Pause' : 'Play'} ${item.name}`}
      onClick={() => player.toggle(item.id, driveBrowserUrl(orgId, `/${encodeURIComponent(item.id)}/audio`))}>
      <Icon name={playing ? 'pause' : 'play'} size={24} className="icon ft ft-media" />
    </button>;
  }
  return <span className={`drivemark${picture && !broken ? ' pic' : ''}`} aria-hidden="true">
    {loaded && !broken ? null : <TypeIcon {...(item.kind === 'folder' ? { glyph: 'folder' as const } : fileIcon(item.name))} />}
    {picture && !broken ? <img alt="" loading="lazy" decoding="async" src={driveBrowserUrl(orgId, `/${encodeURIComponent(item.id)}/image`)}
      onLoad={() => setLoaded(true)} onError={() => setBroken(true)} /> : null}
  </span>;
}

/** A row's second line: a folder's word, a file's size — and, for the
 *  recording on the list's player, how far in it is. */
function rowLine(item: DriveItem, player: RowPlayer, trash: boolean): string {
  if (item.kind === 'folder') return trash ? 'Folder and contents' : 'Folder';
  const size = bytes(item.sizeBytes);
  if (player.broken.has(item.id)) return `${size} · Could not play here`;
  const track = player.track;
  if (track?.id !== item.id) return size;
  return `${size} · ${track.duration ? `${stopwatch(track.at)} / ${stopwatch(track.duration)}` : 'Loading…'}`;
}

/**
 * The list a Drive folder is: one row per item, its mark (a picture as
 * itself, a recording as its play button, anything else as the glyph for
 * its kind), its name, and a folder's word or a file's size, with the
 * manage door at the end of every row.
 *
 * Its own component because it is the part of the screen that is only
 * drawing: DriveScreen reads the listing, uploads into it and opens the
 * forms, and this takes the items it was given. That is what lets the
 * landing show the real rows without the screen's read — a list handed its
 * items paints on the build machine, where an effect never runs.
 */
export function DriveItems({ items, orgId, trash = false, onManage, empty }: {
  items: DriveItem[];
  orgId: string;
  trash?: boolean;
  onManage: (item: DriveItem) => void;
  /** What the card says when there is nothing to list. */
  empty: string;
}) {
  const player = useRowPlayer();
  // A recording whose row has left the list — trashed, moved, searched past —
  // has no button left to pause it with, so it does not play on unseen.
  const playingId = player.track?.id;
  const { stop } = player;
  useEffect(() => {
    if (playingId && !items.some((item) => item.id === playingId)) stop();
  }, [items, playingId, stop]);
  return <div className="card" id="driveItems">{items.map((item) => <div className="crow driverow" key={item.id}>
    <DriveMark item={item} orgId={orgId} player={player} />
    {trash ? <button className="main driveitem" onClick={() => onManage(item)}><span className="name">{item.name}</span><span className="cline">{rowLine(item, player, true)}</span></button>
      : <Link className="main driveitem" {...WITHIN_DRIVE} to={item.kind === 'folder' ? folderLink(orgId, item.id) : toFor({ kind: 'driveFile', orgId, id: item.id })!}>
        <span className="name">{item.name}</span><span className="cline">{rowLine(item, player, false)}</span></Link>}
    <button className="act drivemenu" aria-label={`Manage ${item.name}`} onClick={() => onManage(item)}><Icon name="more" size={18} /></button>
  </div>)}
    {!items.length ? <div className="empty">{empty}</div> : null}
  </div>;
}
