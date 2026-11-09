/**
 * Who is signed in, for the whole tree.
 *
 * The truth comes from `auth/session`, never from "the login call succeeded":
 * a sign-in form finishing and the browser holding a usable session are two
 * facts, and the second is the one every screen depends on. `refresh()` asks
 * again; `signOut()` closes the door on the server and then locally, in that
 * order, and closes it locally even when the server call fails — an expired
 * session is already gone.
 *
 * The session read also settles WHICH WORKPLACE this tab stands in (note
 * #628). It asks with the workplace the tab remembers — the one its address
 * names on a fresh open, else the one this tab stood in before a reload —
 * and the server answers with the workplace it will actually serve: that
 * one while this person still belongs to it, its own marker otherwise. The
 * answer is written back as the tab's standing workplace, and every ordinary
 * call rides it from then on, so another tab's switch never reaches here.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SessionContext, type SessionContextValue, type SessionState } from './context.js';
import type { WorkspaceSessionAnswer } from '../../../src/shared/workspace-api.js';
import { createWorkspaceApi, type WorkspaceApi } from '../api/client.js';
import { forgetDrafts } from '../chrome/draft-memory.js';
import { forgetClouds } from '../cloud/cloud-cache.js';
import { forgetDrives } from '../screens/drive/drive-cache.js';
import { forgetHeldDecisions } from '../screens/chat/decisions-memory.js';
import { forgetDecided } from '../workspace/decided.js';
import { forgetChatFileTexts } from '../screens/chat/chat-file-text.js';
import { forgetRecapChats } from '../screens/home/recap-chat-cache.js';
import { forgetDirectMessages } from '../screens/messages/messages-cache.js';
import { forgetMail } from '../screens/mail/mail-cache.js';
import { forgetNotes } from '../screens/notes/note-cache.js';
import { forgetPeople } from '../screens/org/people-cache.js';
import { forgetOrgDetails } from '../screens/org/org-detail-cache.js';
import { forgetAgents } from '../screens/agent/agent-cache.js';
import { forgetRememberedRuntimes } from '../screens/agent/runtime-memory.js';
import { forgetStandingWorkplace, standInAddressedWorkplace, standInWorkplace, standingWorkplace } from '../workspace/standing-workplace.js';
import { forgetWorkspaceCache } from '../workspace/workspace-cache.js';

export function SessionProvider({ api, children }: { api?: WorkspaceApi; children: ReactNode }) {
  // The address this document opened at names where it stands, before the
  // shelf does: a link to another workplace's note, opened in a new tab,
  // opens a tab standing in THAT workplace. Read once, at mount, and from
  // the document itself rather than the router — it is the tab's fact, and
  // this provider also mounts where no router does. Later addresses are
  // screens moving, not the tab moving.
  useState(() => {
    standInAddressedWorkplace(typeof window === 'undefined' ? '' : window.location.search);
    return null;
  });
  const [defaultApi] = useState(() => api ?? createWorkspaceApi({ standingOrg: standingWorkplace }));
  const client = api ?? defaultApi;
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  /** Ask the server who is signed in. 401 is the ordinary "nobody"; an
   *  unreachable backend reads the same way to the person, and the sign-in
   *  form will say more when they try it. */
  const read = useCallback(async (): Promise<SessionState> => {
    try {
      const answer = await client.authApi<WorkspaceSessionAnswer>('auth/session', undefined, { org: standingWorkplace() });
      // Nobody signed in: the tab stands nowhere, whoever signs in next.
      if (!answer.authenticated) { forgetStandingWorkplace(); return { status: 'signed-out' }; }
      // The server's word on where this tab stands, not the tab's guess.
      standInWorkplace(answer.activeOrgId ?? null);
      return { status: 'signed-in', session: answer };
    } catch {
      return { status: 'signed-out' };
    }
  }, [client]);

  const refresh = useCallback(async () => { setState(await read()); }, [read]);

  const signOut = useCallback(async () => {
    try { await client.authApi('auth/logout', { method: 'POST' }); }
    catch { /* the local door closes below even if the session had already expired */ }
    // Whatever this tab was holding — to open a screen instantly, or to hand
    // a half-typed message back — belongs to the person who just left it. The
    // next one to sign in here starts with none of it.
    forgetNotes();
    forgetMail();
    forgetPeople();
    forgetOrgDetails();
    forgetRecapChats();
    forgetDirectMessages();
    forgetClouds();
    forgetDrives();
    forgetHeldDecisions();
    forgetDecided();
    forgetChatFileTexts();
    forgetAgents();
    forgetRememberedRuntimes();
    forgetDrafts();
    forgetWorkspaceCache(client);
    forgetStandingWorkplace();
    setState({ status: 'signed-out' });
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void read().then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, [read]);

  useEffect(() => {
    // The legacy stylesheet lays the frame out by this class; keep the body
    // honest so the same CSS draws both shells the same way.
    document.body.classList.toggle('browser-authenticated', state.status === 'signed-in');
    return () => { document.body.classList.remove('browser-authenticated'); };
  }, [state.status]);

  const value = useMemo<SessionContextValue>(() => ({ state, api: client, refresh, signOut }), [state, client, refresh, signOut]);
  return <SessionContext value={value}>{children}</SessionContext>;
}
