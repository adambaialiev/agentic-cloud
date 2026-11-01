/**
 * Archiving a note from a LIST — home's glimpse and the notes screen both
 * hand their rows this.
 *
 * The server has the final say; once it accepts, the copy already on screen
 * goes immediately and the ordinary state read reconciles behind it. That
 * leaves a truthful list even if the refresh itself is briefly unavailable —
 * and a refresh that fails must never surface as an archive that failed after
 * the POST has already succeeded.
 */

import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import type { WorkspaceNoteRow } from '../../../../src/shared/workspace-api.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useArchiveFromList() {
  const { api } = useSession();
  const { reload } = useWorkspace();
  const banner = useBanner();
  return async (note: WorkspaceNoteRow): Promise<boolean> => {
    try {
      await api.api(`api/notes/${encodeURIComponent(note.number)}/archive`, { method: 'POST' });
    } catch (error) {
      banner.show(errorMessage(error));
      return false;
    }
    void reload().catch(() => { /* the row catches up on the next read */ });
    return true;
  };
}

