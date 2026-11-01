/**
 * A scripted Workspace API for the jsdom tests: every call is answered by
 * name (`GET api/state`), recorded, and refused when unscripted — so a test
 * that forgets a read fails loudly instead of rendering an empty screen.
 * The state fixture is the smallest answer `api/state` can give.
 */

import type {
  WorkspaceAgentProposalsAnswer,
  WorkspaceAgentRow,
  WorkspaceAgentVersionAnswer,
  WorkspaceChatAnswer,
  WorkspaceChatMessage,
  WorkspaceKnowledgePageAnswer,
  WorkspaceKnowledgePageRow,
  WorkspaceRepoRow,
  WorkspaceRepoTreeAnswer,
  WorkspaceNoteRecord,
  WorkspaceNoteRow,
  WorkspaceSessionAnswer,
  WorkspaceStateAnswer,
} from '../../../src/shared/workspace-api.js';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { WorkspaceApiError, type WorkspaceApi, type WorkspaceApiScope } from '../api/client.js';

export type Call = { path: string; init?: RequestInit; scope?: WorkspaceApiScope; scoped: boolean };
export type Answer = (call: Call) => unknown;

/**
 * The one thing a scripted call cannot skip. This fake stands in for the whole
 * client, so nothing here would otherwise notice that a JSON body was sent
 * without saying it is JSON — and `express.json()` on the other side parses
 * only `application/json`. A body posted as the browser's default
 * `text/plain` reaches the route as `{}`, and the route answers as if the
 * person had typed nothing: exactly how the mail reply form shipped unable to
 * send (2026-09-15). Caught here, it is a failing test rather than a screen
 * that refuses the words in front of it.
 *
 * Only string bodies are checked: FormData sets its own multipart boundary
 * and a hand-set Content-Type would break it.
 */
function sentAsJson(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== 'string') return true;
  const type = new Headers(init.headers).get('content-type') ?? '';
  return type.toLowerCase().includes('application/json');
}

export function scriptedApi(script: Record<string, Answer>) {
  const calls: Call[] = [];
  const answer = (call: Call) => {
    calls.push(call);
    const key = `${call.init?.method ?? 'GET'} ${call.path}`;
    if (!sentAsJson(call.init)) {
      throw new Error(`${key} sends a JSON body with no Content-Type: application/json — `
        + 'the server would read it as empty. Use jsonBody() from api/client.');
    }
    const handler = script[key];
    if (!handler) throw new WorkspaceApiError(`unscripted ${key}`, 404, { error: `unscripted ${key}` });
    return handler(call);
  };
  const api: WorkspaceApi = {
    api: async (path, init, scope) => answer({ path, init, scope, scoped: true }) as never,
    authApi: async (path, init, scope) => answer({ path, init, scope, scoped: false }) as never,
    csrfToken: () => '',
  };
  return { api, calls, script };
}

export const signedOut = () => { throw new WorkspaceApiError('authentication required', 401, { authenticated: false }); };

export const signedIn = (username = 'saddam'): WorkspaceSessionAnswer => ({
  authenticated: true,
  username,
  displayName: 'Saddam',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
});

export function emptyState(overrides: Partial<WorkspaceStateAnswer> = {}): WorkspaceStateAnswer {
  return {
    org: null,
    organizations: [],
    canCreateOrg: false,
    user: {
      name: 'Saddam',
      profile: { firstName: 'Saddam', lastName: '', incomplete: false },
      account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } },
    },
    agents: [],
    prs: [],
    knowledgeProposals: [],
    secrets: null,
    repos: null,
    sites: null,
    knowledge: null,
    notes: null,
    notesArchived: 0,
    noteFiles: false,
    ...overrides,
  };
}

export function agent(overrides: Partial<WorkspaceAgentRow> & { id: string; name: string }): WorkspaceAgentRow {
  return { cli: 'claude', status: 'ready', ...overrides };
}

/** The three reads a signed-in Workspace makes on open, answered quietly. */
export function workspaceScript(state: () => WorkspaceStateAnswer): Record<string, Answer> {
  return {
    'GET auth/session': () => ({
      ...signedIn(),
      ...(state().org?.orgId ? { activeOrgId: state().org!.orgId } : {}),
    }),
    'GET api/state': state,
    'GET api/recap/settings': () => ({ orgId: state().org?.orgId ?? '', settings: null, models: [] }),
    'GET api/recap/agent/settings': () => ({ orgId: state().org?.orgId ?? '', settings: null, models: [] }),
    // Home is the Workspace Agent's conversation since 2026-10-10, and the
    // overview is headed by its details: both reads answer quietly, as an
    // agent nobody has written to yet.
    'GET api/recap/chat': () => ({ orgId: state().org?.orgId ?? '', messages: [], working: false, waiting: [] }),
    'GET api/recap/agent': () => ({ orgId: state().org?.orgId ?? '', agent: { name: 'Workspace Agent', started: false, working: false, waiting: [] }, settings: null }),
    'GET api/recap': () => ({ orgId: state().org?.orgId ?? '', agent: { name: 'Workspace Agent', started: false, working: false, waiting: [] }, summary: null, sources: [], updating: false, stale: false, incomplete: false, since: new Date().toISOString(), checkedAt: new Date().toISOString() }),
    'GET api/org/cloud': () => ({ orgId: state().org?.orgId ?? '', role: state().org?.role ?? 'admin', fly: { connected: true, orgSlug: 'test-cloud', peer: 'up' }, machines: { active: 0, sleeping: 0, checkedAt: new Date().toISOString() } }),
    'GET api/org/cloud?inventory=0': () => ({ orgId: state().org?.orgId ?? '', role: state().org?.role ?? 'admin', fly: { connected: true, orgSlug: 'test-cloud', peer: 'up' }, machines: null }),
    'GET api/agents/live': () => ({ agents: [], recaps: [], sessionLimits: [] }),
    'GET api/notifications': () => ({ notifications: [], unread: 0 }),
    // The decision queue the agents picker reads for itself (note #721).
    'GET api/decisions': () => ({ prs: [], knowledgeProposals: [] }),
  };
}

/** The version card as the record can fill it in — the smallest honest one. */
export function versionAnswer(overrides: Partial<WorkspaceAgentVersionAnswer> = {}): WorkspaceAgentVersionAnswer {
  return {
    cliLabel: 'Claude Code',
    cliUpdateAvailable: false,
    busy: false,
    workedMs: 0,
    turnCount: 0,
    docs: { file: 'CLAUDE.md', version: 4, latest: 4, current: true },
    ...overrides,
  };
}

/** The three reads the agent's own screen makes when it opens — the last of
 *  which answers with both halves of its proposal history. */
export function agentScreenScript(
  agentId: string,
  info: () => WorkspaceAgentVersionAnswer,
  prs: WorkspaceAgentProposalsAnswer['prs'] = [],
  knowledgeProposals: WorkspaceAgentProposalsAnswer['knowledgeProposals'] = [],
): Record<string, Answer> {
  return {
    [`GET api/agents/${agentId}/version`]: info,
    [`GET api/agents/${agentId}/chat/latest`]: () => ({ message: null }),
    [`GET api/agents/${agentId}/prs`]: () => ({ prs, knowledgeProposals }),
  };
}

export function chatMessage(
  overrides: Partial<WorkspaceChatMessage> & { seq: number },
): WorkspaceChatMessage {
  return { role: 'agent', text: '', at: '2026-09-02T10:00:00Z', ...overrides };
}

/** One transcript read, answered whole. The chat asks for `api/agents/<id>/chat`
 *  on open and `…?after=<seq>` on every poll, so both keys are scripted. */
export function chatScript(agentId: string, answer: () => WorkspaceChatAnswer): Record<string, Answer> {
  const reply = () => answer();
  const script: Record<string, Answer> = { [`GET api/agents/${agentId}/chat`]: reply };
  for (let seq = 1; seq <= 40; seq += 1) script[`GET api/agents/${agentId}/chat?after=${seq}`] = reply;
  return script;
}

/** One note as a list draws it — the smallest honest row. */
export function note(
  overrides: Partial<WorkspaceNoteRow> & { number: number; title: string },
): WorkspaceNoteRow {
  return {
    id: `n${overrides.number}`,
    preview: '',
    createdAt: '2026-09-02T09:00:00Z',
    updatedAt: '2026-09-02T09:00:00Z',
    // A note the reader wrote is theirs by definition, and the server sends
    // both flags on one (note #637). Mirrored here so a fixture cannot
    // describe a note the account could never answer with.
    ...(overrides.byUser ? { yours: true as const } : {}),
    ...overrides,
  };
}

/** One page as the state lists it — the smallest honest row. */
export function knowledgePage(
  overrides: Partial<WorkspaceKnowledgePageRow> & { name: string },
): WorkspaceKnowledgePageRow {
  return {
    title: overrides.name,
    description: '',
    sizeBytes: 512,
    sha: 'a'.repeat(40),
    ...overrides,
  };
}

/** The same note as its own screen reads it: the words, the margin whole, and
 *  the files — `attachments` present (empty included) exactly when the backend
 *  can hold them. */
export function noteRecord(
  overrides: Partial<WorkspaceNoteRecord> & { number: number; title: string },
): WorkspaceNoteRecord {
  const { comments, ...row } = overrides;
  return {
    ...note(row as Partial<WorkspaceNoteRow> & { number: number; title: string }),
    html: `<p>${overrides.title}</p>`,
    comments: comments ?? [],
    ...overrides,
  };
}

/** The one read a knowledge page's screen makes when it opens. */
export function knowledgePageScript(
  name: string,
  page: () => WorkspaceKnowledgePageAnswer['page'],
): Record<string, Answer> {
  return { [`GET api/knowledge/pages/${encodeURIComponent(name)}`]: () => ({ page: page() }) };
}

/** One repository as the state lists it — the smallest honest row. */
export function repo(overrides: Partial<WorkspaceRepoRow> & { name: string }): WorkspaceRepoRow {
  return {
    cloneUrl: `https://git.test/ns/${overrides.name}.git`,
    sizeBytes: 0,
    contributors: [],
    protectedBranch: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The reads a repository's own screen makes when it opens: the tree it was
 *  asked for, and the four root-only sections beside it. */
export function repoScreenScript(
  name: string,
  tree: () => WorkspaceRepoTreeAnswer,
): Record<string, Answer> {
  return {
    [`GET api/repos/${name}/tree`]: tree,
    [`GET api/repos/${name}/commits?limit=20`]: () => ({ branch: 'main', commits: [] }),
    [`GET api/repos/${name}/prs`]: () => ({ prs: [] }),
    [`GET api/repos/${name}/checks`]: () => ({ runs: [] }),
    [`GET api/repos/${name}/contributors`]: () => ({ contributors: [] }),
  };
}

/** Close Home's Workplace window if it stands. */
async function closeHomeWindow(): Promise<void> {
  const close = document.getElementById('homeSheetClose');
  if (!close) return;
  fireEvent.click(close);
  await waitFor(() => { if (document.getElementById('homeSheet')) throw new Error('the window has not closed'); });
}
/** Close the agents picker if it stands. */
async function closePicker(): Promise<void> {
  const close = document.getElementById('agentSwitchClose');
  if (!close) return;
  fireEvent.click(close);
  await waitFor(() => { if (document.getElementById('agentSwitchSheet')) throw new Error('the picker has not closed'); });
}

/** The address of the page standing on top of the agents picker (note
 *  #722): what a row in it opened, inside the picker. Null with no page
 *  open. */
export function pickerPage(): string | null {
  const pages = [...document.querySelectorAll<HTMLElement>('#agentSwitchSheet .windowpage:not([hidden])')];
  return pages.at(-1)?.dataset.address ?? null;
}

/**
 * Home, on the shelf asked for, walked to the way a person does. Since rooms
 * left the product (note #843) the agents are the agents picker by the
 * message box — its stack of faces opens one list of every agent — and
 * everything else, the notes among it, is the Workplace window over Home
 * (the Chief of Staff's conversation), opened by its name in the header. A
 * picker or window already standing on the right thing is used as it is.
 * The heading answered is what proves the shelf is up rather than merely
 * mounted: the picker's own title for the agents, the shelf's for the rest.
 *
 * A personal workspace has no workplace, so no window and no picker of
 * rooms: its `/` is the one combined column it always was
 * (`OverviewScreen`), every shelf in it.
 *
 * (It was `homeRooms`, and walked to a room's tab of the picker, while
 * there were rooms.)
 */
export async function homeShelf(content: 'agents' | 'notes' | 'repositories' | 'knowledge' | 'secrets' | 'sites' = 'agents'): Promise<HTMLElement> {
  await waitFor(() => {
    if (!document.getElementById('agentsSection') && !document.getElementById('homeWorkplaceDoor')) {
      throw new Error('Home has not read its state');
    }
  });
  const labels = {
    agents: 'Agents', notes: 'Notes', repositories: 'Repositories', knowledge: 'Knowledge', secrets: 'Secrets', sites: 'Sites',
  } as const;
  if (document.getElementById('homeWorkplaceDoor')) {
    if (content === 'agents') {
      if (!document.getElementById('agentSwitchSheet')) {
        await closeHomeWindow();
        await waitFor(() => { if (!document.getElementById('agentChatSwitch')) throw new Error('no agents stack yet'); });
        fireEvent.click(document.getElementById('agentChatSwitch')!);
        await waitFor(() => { if (!document.getElementById('agentSwitchGrid')) throw new Error('the picker has not opened'); });
      }
      return screen.findByRole('heading', { name: 'Your agents' });
    }
    if (!document.querySelector('#homeSheet #homeWorkplace')) {
      await closePicker();
      fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
      await waitFor(() => { if (!document.querySelector('#homeSheet #homeWorkplace')) throw new Error('the window has not opened'); });
    }
    return screen.findByRole('heading', { name: new RegExp(`^${labels[content]}`) });
  }
  await waitFor(() => {
    if (!document.getElementById('agentsSection')) throw new Error('the overview has not read its state');
  });
  return screen.findByRole('heading', { name: new RegExp(`^${labels[content]}`) });
}
