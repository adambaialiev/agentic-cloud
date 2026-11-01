/**
 * The screen's answer to "where does note #284 live?" — handed to a renderer
 * so the mentions inside its words become doors.
 *
 * The address is written by the ONE registry, from the workplace and room
 * the screen is standing in, exactly as a tap on a note row writes it: a
 * mention and a row must lead to the same place, and a hand-written path
 * would be a second route table.
 *
 * Memoized, because `KnowledgeHtml` rebuilds its tree when its options change
 * — a fresh object every paint would rebuild the page under the reader's
 * finger.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { workspaceRoutePath } from '../../../src/shared/workspace-routes.js';
import { toFor } from '../routes.js';
import type { NoteRefs } from './note-refs.js';
import { useOrgScope } from '../workspace/useWorkspace.js';

export function useNoteRefs(): NoteRefs {
  const navigate = useNavigate();
  const { orgId } = useOrgScope();
  return useMemo<NoteRefs>(() => {
    const link = (number: number) => {
      // Exactly the scope a tap on a note ROW writes, and no stricter: a
      // workspace still loading has no workplace, and the registry simply
      // leaves out what it is not given. (It wrote the viewed room too,
      // while notes were a room's — note #843.)
      const route = {
        kind: 'note' as const,
        id: String(number),
        ...(orgId ? { orgId } : {}),
      };
      const href = workspaceRoutePath(route);
      const to = toFor(route);
      return href && to ? { href, to } : null;
    };
    return {
      link,
      open: (number) => {
        const at = link(number);
        if (at) navigate(at.to);
      },
    };
  }, [navigate, orgId]);
}
