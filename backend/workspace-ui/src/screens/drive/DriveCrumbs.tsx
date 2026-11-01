import { Link } from 'react-router-dom';
import type { DriveItem } from '../../../../src/shared/drive.js';
import { WITHIN_DRIVE, folderLink } from './drive-links.js';

/**
 * The trail above wherever the reader is standing, and the ONLY way up
 * inside Drive (note #521): Back leaves Drive altogether, so every folder
 * between here and the root has to be one tap away on the screen itself.
 * Each segment replaces the entry rather than pushing one — `WITHIN_DRIVE`
 * says why.
 */
export function DriveCrumbs({ orgId, items }: { orgId: string; items: DriveItem[] }) {
  return <nav className="sub crumb drivecrumb" aria-label="Folder path">
    <Link className="seg" {...WITHIN_DRIVE} to={folderLink(orgId, null)}>Drive</Link>
    {items.map((item) => <span key={item.id}><span className="sep">/</span>
      <Link className="seg" {...WITHIN_DRIVE} to={folderLink(orgId, item.id)}>{item.name}</Link></span>)}
  </nav>;
}
