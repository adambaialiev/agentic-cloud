import { Link } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function Drive() {
  const { state } = useWorkspace();
  if (!state?.driveAvailable || !state.org) return null;
  return <><h2 className="homehead" id="driveHead">Drive</h2><div className="card" id="driveCard">
    <Link className="crow" to={toFor({ kind: 'drive', orgId: state.org.orgId })!}>
      <TypeIcon glyph="drive" /><div className="main"><div className="name">Drive</div>
        <div className="cline">Shared across the workplace</div></div><Icon name="chev" size={18} />
    </Link>
  </div></>;
}
