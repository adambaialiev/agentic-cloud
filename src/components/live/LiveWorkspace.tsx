import { useState, type ReactNode } from 'react';
import type {
  WorkspaceKnowledgePageRow,
  WorkspaceKnowledgeProposalRow,
  WorkspaceNoteRow,
  WorkspaceProposalRow,
  WorkspaceRepoRow,
  WorkspaceSeatUsage,
  WorkspaceBucketRow,
  WorkspaceSecretRow,
  WorkspaceSiteRow,
  WorkspaceStateAnswer,
} from '../../../backend/src/shared/workspace-api';
import type { WorkspaceApi } from '../../../backend/workspace-ui/src/api/client';
import { BannerContext, type BannerValue } from '../../../backend/workspace-ui/src/chrome/banner-context';
import { SessionContext, type SessionContextValue } from '../../../backend/workspace-ui/src/session/context';
import { WorkspaceContext, type WorkspaceValue } from '../../../backend/workspace-ui/src/workspace/context';
import { FleetContext, type FleetValue } from '../../../backend/workspace-ui/src/workspace/fleet-context';
import type { HomeAgent } from '../../../backend/workspace-ui/src/workspace/live';
import { FLEET, ORG } from './fixture';
import '../../../backend/workspace-ui/src/workspace.css';

/** The providers a Workspace component expects, filled from fixture.ts —
 *  see that file for the whole idea. */
const never = async () => false;
/** The fixture's API: a component that reads on mount gets the answer named
 *  for its path, and anything else is refused — loudly, so a panel that
 *  quietly needed more of the backend than it was given cannot look fine. */
function answering(answers: Record<string, unknown>): WorkspaceApi {
  const refuse = (path: string) => Promise.reject(new Error(`The landing fixture has no answer for ${path}`));
  return {
    api: (path) => (path in answers ? Promise.resolve(answers[path] as never) : refuse(path)),
    authApi: (path) => refuse(path),
    csrfToken: () => '',
  };
}

export function LiveWorkspace({
  agents = FLEET, notes = null, prs = [], knowledgeProposals = [], knowledge = null, repos = null, sites = null, secrets = null,
  buckets, quota, seatUsage, answers = {}, user, children,
}: {
  agents?: HomeAgent[];
  notes?: WorkspaceNoteRow[] | null;
  prs?: WorkspaceProposalRow[];
  knowledgeProposals?: WorkspaceKnowledgeProposalRow[];
  knowledge?: WorkspaceKnowledgePageRow[] | null;
  repos?: WorkspaceRepoRow[] | null;
  sites?: WorkspaceSiteRow[] | null;
  secrets?: WorkspaceSecretRow[] | null;
  buckets?: WorkspaceBucketRow[];
  quota?: WorkspaceStateAnswer['quota'];
  seatUsage?: WorkspaceSeatUsage[];
  /** What the fixture API answers, by path — for a component that reads on mount. */
  answers?: Record<string, unknown>;
  /** The signed-in person, when a screen draws their account (Settings). */
  user?: WorkspaceStateAnswer['user'];
  children: ReactNode;
}) {
  const [api] = useState(() => answering(answers));
  const [state] = useState<WorkspaceStateAnswer>(() => ({
    org: { ...ORG, ...(seatUsage ? { seatUsage } : {}) },
    organizations: [{ orgId: ORG.orgId, name: ORG.name, role: ORG.role, active: true, members: ORG.members, agents: agents.length }],
    canCreateOrg: false,
    user: user ?? {
      name: 'James',
      profile: { firstName: 'James', lastName: '', incomplete: false },
      account: { browserLogin: { enabled: true, method: 'email', email: 'james@example.com', secondFactorEnabled: false, verificationStatus: 'verified' } },
    },
    agents,
    prs,
    knowledgeProposals,
    secrets,
    repos,
    sites,
    knowledge,
    ...(buckets ? { buckets } : {}),
    notes,
    notesArchived: 0,
    noteFiles: false,
    ...(quota ? { quota } : {}),
  }));
  const workspace: WorkspaceValue = {
    status: 'ready',
    error: '',
    state: { ...state, agents, notes, prs, knowledgeProposals },
    agents,
    notifications: [],
    homeOverview: {
      status: 'ready', blockHome: false, orgId: ORG.orgId,
      recap: null, recapSettings: null,
    },
    refreshHomeOverview: async () => {},
    switchWorkplace: never,
    reload: never,
    refreshHome: () => null,
    patchAgentRuntime: () => {},
    claimOnce: () => false,
    markAgentNotificationsRead: never,
  };
  const fleet: FleetValue = {
    departing: new Map(),
    departingRows: new Map(),
    removed: new Set(),
    pendingCreates: 0,
    createAgent: never,
    deleteAgent: async (agent) => ({ ok: false, name: agent.name }),
  };
  const session: SessionContextValue = {
    state: {
      status: 'signed-in',
      session: {
        authenticated: true,
        username: 'james',
        displayName: 'James',
        session: { sessionId: 'landing', createdAt: '2026-09-06T08:00:00.000Z', lastSeenAt: '2026-09-06T08:00:00.000Z', absoluteExpiresAt: '2026-09-13T08:00:00.000Z' },
      },
    },
    api,
    refresh: async () => {},
    signOut: async () => {},
  };
  const banner: BannerValue = { show: () => {}, hide: () => {} };
  return (
    <SessionContext.Provider value={session}>
      <BannerContext.Provider value={banner}>
        <WorkspaceContext.Provider value={workspace}>
          <FleetContext.Provider value={fleet}>{children}</FleetContext.Provider>
        </WorkspaceContext.Provider>
      </BannerContext.Provider>
    </SessionContext.Provider>
  );
}

/**
 * The fence a live panel stands in. `inert`: a row that opened an agent
 * screen would open nothing here, so it takes no tap and no focus, and the
 * sentence before it says what a screen reader would otherwise get as a
 * column of buttons. `size` is the zoom: a poster for the hero, a tile in a
 * grid cell, or a compact reading surface for the chat-heavy examples — the
 * same pixels at a different scale, not a bitmap resized after rendering.
 */
export function LivePanel({ says, size = 'poster', className = '', children }: {
  says: string;
  size?: 'poster' | 'tile' | 'compact' | 'face' | 'wide' | 'phone';
  className?: string;
  children: ReactNode;
}) {
  return (
    /* min-w-0: a grid cell sizes to its content's minimum, and a row of nowrap
       text or a sideways strip has a wide one — without this a panel pushed
       its column past a 390px phone and the page's overflow clip hid the rest. */
    <div className={`min-w-0 max-w-full ${className}`}>
      <p className="sr-only">{says}</p>
      <div className={`ws-live ws-${size}${size === 'phone' ? ' flex min-h-0 flex-1 flex-col' : ''}`} inert aria-hidden="true">
        {children}
      </div>
    </div>
  );
}
