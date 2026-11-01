/**
 * Searching the notes (note #242): every note in the workplace whose words match,
 * live and archived together.
 *
 * Its own fetch and not a filter over what the page already holds, for the two
 * reasons a filter cannot cover — the archive is never loaded into the page at
 * all, and the lists it does hold carry a title and a glimpse rather than the
 * words, so a client-side filter would answer "no such note" about a note
 * whose second paragraph says exactly what was typed.
 *
 * Token-guarded like every fetch here: the answer to "wif" must not land on
 * top of the answer to "wifi". Emptying the field is answered at once from
 * what is already in hand — the reader who cleared it is looking at their
 * list and there is nothing to wait for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceNoteListAnswer, WorkspaceNoteRow } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';

export const SEARCH_DEBOUNCE_MS = 250;

export interface NoteSearch {
  query: string;
  /** Null while the answer is still out; the rows once it lands. */
  results: WorkspaceNoteRow[] | null;
  error: string;
  /** A search is standing in for the list. */
  active: boolean;
  type: (value: string) => void;
}

export function useNoteSearch(): NoteSearch {
  const { api } = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceNoteRow[] | null>(null);
  const [error, setError] = useState('');
  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(async (wanted: string) => {
    const mine = ++token.current;
    try {
      const answer = await api.api<WorkspaceNoteListAnswer>(
        `api/notes/search?q=${encodeURIComponent(wanted)}`,
      );
      if (mine !== token.current) return;
      setError('');
      setResults(answer.notes ?? []);
    } catch (failure) {
      if (mine !== token.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setResults(null);
    }
  }, [api]);

  const type = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(timer.current);
    if (!value.trim()) {
      // Invalidate any answer still in flight for the old words: it must not
      // arrive late and paint results over a list nobody is searching.
      token.current += 1;
      setResults(null);
      setError('');
      return;
    }
    timer.current = setTimeout(() => { void run(value.trim()); }, SEARCH_DEBOUNCE_MS);
  }, [run]);

  return { query, results, error, active: query.trim().length > 0, type };
}
