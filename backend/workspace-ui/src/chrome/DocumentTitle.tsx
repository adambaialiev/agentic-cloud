/**
 * The browser tab wears the name of the workplace being looked at (note
 * #621), so two workplaces open side by side are told apart at a glance.
 * Until the workplace is read, and again after signing out, the tab keeps the
 * shell's own "Your workspace".
 */

import { useEffect } from 'react';
import { useWorkspace } from '../workspace/useWorkspace.js';

export const DEFAULT_DOCUMENT_TITLE = 'Your workspace';

export function DocumentTitle() {
  const name = useWorkspace().state?.org?.name?.trim();
  useEffect(() => {
    document.title = name || DEFAULT_DOCUMENT_TITLE;
  }, [name]);
  useEffect(() => () => { document.title = DEFAULT_DOCUMENT_TITLE; }, []);
  return null;
}
