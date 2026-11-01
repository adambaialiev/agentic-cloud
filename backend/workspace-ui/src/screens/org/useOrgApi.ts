import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WorkspaceApi } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

/** WHICH workplace a page is about: the one its address names, else the
 *  one the reader is standing in. Pulled out of `useOrgApi` so that a screen
 *  keeping an answer per workplace (`cloud/cloud-cache.ts`) keys it by
 *  exactly the workplace the read was scoped to. */
export function useOrgId(): string | null {
  const { state } = useWorkspace();
  const [search] = useSearchParams();
  return search.get('org') || state?.org?.orgId || null;
}

/** Reads and actions on a workplace page must target the same workplace. */
export function useOrgApi(): WorkspaceApi {
  const { api } = useSession();
  const org = useOrgId();
  return useMemo(() => ({ ...api, api: (path, init, scope) => api.api(path, init, { org, ...scope }) }), [api, org]);
}
