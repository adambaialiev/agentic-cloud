import { useContext } from 'react';
import { WorkspaceContext, type WorkspaceValue } from './context.js';

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace() needs a WorkspaceProvider above it');
  return value;
}

/**
 * The workplace a workplace-scoped address carries, read off the state the
 * screen is standing in.
 *
 * Spread into `toFor({ kind: 'knowledgePage', id: name, ...scope })`: the
 * registry writes `?org=` from exactly this, and a tap must write the
 * address a copied link would carry. Absent while a workspace is still
 * loading, and `workspaceRoutePath` simply leaves out what it is not given.
 * It carried the viewed room too until rooms left the product (note #843).
 */
export function useOrgScope(): { orgId?: string } {
  const { state } = useWorkspace();
  const orgId = state?.org?.orgId;
  return orgId ? { orgId } : {};
}
