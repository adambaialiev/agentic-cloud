/**
 * Handing a NOTE over — the one thing a note's Send does that a knowledge
 * page's does not.
 *
 * A note goes through its own door, which records the handoff in the same
 * request that admits the turn (notes #234/#258), so there is no window in
 * which the reader has dealt this note out and the page still calls it
 * Unclaimed. Everything else about the send is shared (`ui/handoff.ts`),
 * including the one refusal it is safe to hold a tap through and how long to
 * hold it — those numbers are read from there rather than written twice.
 */

import type {
  WorkspaceNoteHandoffAnswer,
  WorkspaceNoteHandoffRequest,
} from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError, jsonBody, type WorkspaceApi } from '../../api/client.js';
import { HANDOFF_RESTART_RETRIES, HANDOFF_RESTART_WAIT_MS } from '../../ui/handoff.js';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function sendNoteHandoff(
  api: WorkspaceApi,
  number: number,
  body: WorkspaceNoteHandoffRequest,
): Promise<WorkspaceNoteHandoffAnswer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.api<WorkspaceNoteHandoffAnswer>(
        `api/notes/${encodeURIComponent(number)}/handoff`, jsonBody(body),
      );
    } catch (error) {
      // `restarting` names the one safe boundary: the server promises nothing
      // was sent, so the tap may be held and the next process tried. A bare
      // 502 is deliberately NOT retried — once admission is unknown, replaying
      // a side effect would risk starting the turn twice.
      const restarting = error instanceof WorkspaceApiError && error.code === 'restarting';
      if (!restarting || attempt >= HANDOFF_RESTART_RETRIES) throw error;
      await sleep(HANDOFF_RESTART_WAIT_MS);
    }
  }
}
