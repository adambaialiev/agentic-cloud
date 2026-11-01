import { overviewArrival } from './screens/home/home-sheet.js';
import { useOrgId } from './screens/org/useOrgApi.js';
import { MessagesScreen } from './screens/messages/MessagesScreen.js';
import { DirectMessageScreen } from './screens/messages/DirectMessageScreen.js';
/**
 * The React Workspace: one router over the shared route registry, one
 * session, one door.
 *
 * Signed out, every address shows the gate — `/signup` opens it on account
 * creation and `/invite/<token>` previews the invitation. Signed in, the
 * Workspace state provider sits over every screen (one full read, the live
 * tick, the notification poll), the persistent header stands
 * over every destination but Home and the chat, and the router maps every
 * registered destination to its screen. The route table here is DERIVED from
 * the registry, never written beside it; the exhaustive screen map makes a
 * newly registered destination a compile error until its screen exists.
 *
 * The chat pins its own identity header with its own Back (note #188), so the
 * persistent one steps aside there exactly as the legacy `#pageHead` does.
 */

import type { ComponentType, ReactElement } from 'react';
import { Navigate, Route, Routes, matchPath, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { WORKSPACE_RETIRED_PATTERNS, parseWorkspaceRoute, type WorkspaceRouteKind } from '../../src/shared/workspace-routes.js';
import type { WorkspaceApi } from './api/client.js';
import { AuthGate, EmailVerificationPrompt, EmailVerificationScreen, PasswordResetScreen, RecoveryEmailConfirmScreen } from './auth/AuthGate.js';
import { LEGACY_ROUTER_PATHS, ROUTER_PATHS, canonicalToFor, toFor } from './routes.js';
import { BannerProvider } from './chrome/Banner.js';
import { ConfirmProvider } from './chrome/Confirm.js';
import { ImageViewerProvider } from './ui/ImageViewer.js';
import { PdfViewerProvider } from './ui/PdfViewer.js';
import { BackProvider, PageHead } from './chrome/PageHead.js';
import { DestinationsContext } from './chrome/destinations.js';
import { DocumentTitle } from './chrome/DocumentTitle.js';
import { ScrollMemory } from './chrome/ScrollMemory.js';
import { AgentScreen } from './screens/agent/AgentScreen.js';
import { OtherAgentScreen } from './screens/agent/OtherAgentScreen.js';
import { BackgroundJobsScreen } from './screens/jobs/BackgroundJobsScreen.js';
import { ChatScreen } from './screens/chat/ChatScreen.js';
import { TranscriptProvider } from './screens/chat/TranscriptProvider.js';
import { ChatOutboxProvider } from './screens/chat/ChatOutboxProvider.js';
import { KnowledgeProposalScreen } from './screens/decisions/KnowledgeProposalScreen.js';
import { KnowledgeListScreen } from './screens/knowledge/KnowledgeListScreen.js';
import { RepoCommitScreen } from './screens/repos/RepoCommitScreen.js';
import { RepoContributorsScreen } from './screens/repos/RepoContributorsScreen.js';
import { RepoFileScreen } from './screens/repos/RepoFileScreen.js';
import { RepoHistoryScreen } from './screens/repos/RepoHistoryScreen.js';
import { RepoScreen } from './screens/repos/RepoScreen.js';
import { PublicRepoScreen } from './screens/repos/PublicRepoScreen.js';
import {
  PublicRepoCommitScreen,
  PublicRepoContributorsScreen,
  PublicRepoHistoryScreen,
  PublicRepoProposalScreen,
  PublicRepoProposalsScreen,
} from './screens/repos/PublicRepoPages.js';
import { PublicAddressScreen } from './screens/people/PublicAddressScreen.js';
import { AppsScreen } from './screens/apps/AppsScreen.js';
import { KnowledgePageScreen } from './screens/knowledge/KnowledgePageScreen.js';
import { ProposalScreen } from './screens/decisions/ProposalScreen.js';
import { DriveScreen } from './screens/drive/DriveScreen.js';
import { DriveFileScreen } from './screens/drive/DriveFileScreen.js';
import { HomeScreen } from './screens/home/HomeScreen.js';
import { HomeLoadingSkeleton } from './screens/home/HomeLoadingSkeleton.js';
import { NoteArchiveScreen } from './screens/notes/NoteArchiveScreen.js';
import { NoteDraftProvider } from './screens/notes/NoteDraftProvider.js';
import { NoteScreen } from './screens/notes/NoteScreen.js';
import { NotesScreen } from './screens/notes/NotesScreen.js';
import { InviteRedeemScreen } from './screens/InviteRedeem.js';
import { OrganizationsScreen } from './screens/org/OrganizationsScreen.js';
import { OrganizationScreen } from './screens/org/OrganizationScreen.js';
import { OrgMemberScreen } from './screens/org/OrgMemberScreen.js';
import { InviteScreen } from './screens/org/InviteScreen.js';
import { PeopleScreen } from './screens/org/PeopleScreen.js';
import { OrgCloudScreen } from './screens/org/OrgCloudScreen.js';
import { UnknownScreen } from './screens/Placeholder.js';
import { MailScreen } from './screens/mail/MailScreen.js';
import { MailConversationScreen } from './screens/mail/MailConversationScreen.js';
import { ProfileScreen } from './screens/profile/ProfileScreen.js';
import { SeatScreen } from './screens/seats/SeatScreen.js';
import { SeatSignInScreen } from './screens/seats/SeatSignInScreen.js';
import { SeatsScreen } from './screens/seats/SeatsScreen.js';
import { SecretScreen } from './screens/secrets/SecretScreen.js';
import { SecretsScreen } from './screens/secrets/SecretsScreen.js';
import { SiteScreen } from './screens/sites/SiteScreen.js';
import { BucketScreen } from './screens/storage/BucketScreen.js';
import { SessionProvider } from './session/SessionProvider.js';
import { RadioProvider } from './radio/RadioProvider.js';
import { RadioLibraryScreen } from './screens/radio/RadioLibraryScreen.js';
import { useSession } from './session/useSession.js';
import { FleetProvider } from './workspace/FleetProvider.js';
import { SeatsProvider } from './workspace/SeatsProvider.js';
import { WorkspaceProvider } from './workspace/WorkspaceProvider.js';
import { useWorkspace } from './workspace/useWorkspace.js';
import { RequiredSetup, SetupDone } from './onboarding/RequiredSetup.js';
import { SetupLoadingSkeleton } from './onboarding/SetupLoadingSkeleton.js';
import { setupLikely } from './onboarding/setup-hint.js';

/**
 * Both per-agent screens are keyed by the agent, so moving between two of
 * them REBUILDS rather than reuses: a transcript, a scroll position or a
 * half-finished read belongs to one conversation and must never survive into
 * the next. React Router reuses a component across a parameter change, so the
 * key is what makes that true.
 */
function AgentRoute() {
  const { id } = useParams();
  const { agents } = useWorkspace();
  // WHOSE agent this is decides which screen stands here (note #640): the
  // reader's own opens its control room, a teammate's the read-only card.
  // An unread fleet keeps the control room, which draws its own waiting
  // state and opens warm on what it had held — the screen most links here
  // mean. A teammate's agent swaps in the moment the fleet says it is not
  // one of these, having shown nothing of the control room but that wait.
  return !agents || agents.some((row) => row.id === id)
    ? <AgentScreen key={id} />
    : <OtherAgentScreen key={id} />;
}

function AgentJobsRoute() {
  const { id } = useParams();
  return <BackgroundJobsScreen key={id} />;
}

function ChatRoute() {
  const { id } = useParams();
  return <ChatScreen key={id} />;
}

/** A note is keyed by its number for the same reason: its margin, its files
 *  and its half-finished remark belong to ONE note and must never survive
 *  into the next one the reader opens. */
function NoteRoute() {
  const { id } = useParams();
  return <NoteScreen key={id} />;
}

/** A knowledge page is keyed by its name for the same reason: the fetch, the
 *  reading line and a half-typed handoff all belong to the page that was
 *  open, and none of them may survive into the next one. */
function KnowledgePageRoute() {
  const { id } = useParams();
  return <KnowledgePageScreen key={id} />;
}

/** A repository's own screen and its file view are keyed by the repository
 *  and the path they are showing: a tree read, a scroll position and a
 *  half-loaded README belong to one folder and must not survive into the
 *  next. React Router reuses a component across a parameter change, so the
 *  key is what makes that true. */
function RepoRoute() {
  const { id } = useParams();
  const [search] = useSearchParams();
  return <RepoScreen key={`${id}:${search.get('path') ?? ''}`} />;
}

function RepoFileRoute() {
  const { id } = useParams();
  const [search] = useSearchParams();
  return <RepoFileScreen key={`${id}:${search.get('path') ?? ''}`} />;
}

/** The three read-only repository screens are keyed the same way, for the
 *  same reason: walking from one commit's diff to another's must rebuild
 *  rather than leave the first one's patch standing under the second's sha. */
function RepoHistoryRoute() {
  const { id } = useParams();
  return <RepoHistoryScreen key={id} />;
}

function RepoContributorsRoute() {
  const { id } = useParams();
  return <RepoContributorsScreen key={id} />;
}

function RepoCommitRoute() {
  const { id, sha } = useParams();
  return <RepoCommitScreen key={`${id}:${sha}`} />;
}

/** A public address — a person's page, or a workplace's word that sends
 *  its member on — keyed by the handle: one page's read never survives into
 *  the next one's. Reached before the session gate (below); this is the
 *  registry's screen for it, for the signed-in router's table. */
function PublicAddressRoute() {
  const { handle = '' } = useParams();
  return <PublicAddressScreen key={handle} handle={handle} />;
}

function PublicRepoRoute() {
  const { handle = '', repo = '' } = useParams();
  const location = useLocation();
  return <PublicRepoScreen key={`${handle}/${repo}:${location.search}`} door={{ kind: 'address', handle, repo }} />;
}

/** The pages under a repository's address: its history, one commit, its
 *  proposals, one proposal. Keyed by what they show, like the tree. */
function PublicRepoPageRoute({ page }: { page: 'commits' | 'commit' | 'proposals' | 'proposal' | 'contributors' }) {
  const { handle = '', repo = '', sha = '', number = '' } = useParams();
  const door = { kind: 'address' as const, handle, repo };
  const key = `${handle}/${repo}`;
  switch (page) {
    case 'commits': return <PublicRepoHistoryScreen key={key} door={door} />;
    case 'commit': return <PublicRepoCommitScreen key={`${key}@${sha}`} door={door} sha={sha} />;
    case 'proposals': return <PublicRepoProposalsScreen key={key} door={door} />;
    case 'contributors': return <PublicRepoContributorsScreen key={key} door={door} />;
    default: return <PublicRepoProposalScreen key={`${key}#${number}`} door={door} number={number} />;
  }
}

/** Screens keyed by their record, for the same reason as the agent's. */
function Keyed({ screen: Screen }: { screen: ComponentType }) {
  const { id } = useParams();
  return <Screen key={id} />;
}

/** Every registered destination. `Record` is deliberate: adding a route kind
 *  without its screen fails the build instead of silently drawing a fallback. */
function DriveRoute({ file = false, trash = false }: { file?: boolean; trash?: boolean }) {
  const { id } = useParams();
  const [search] = useSearchParams();
  const key = `${search.get('org') ?? ''}:${id ?? ''}:${trash}`;
  return file ? <DriveFileScreen key={key} /> : <DriveScreen key={key} trash={trash} />;
}

function MessageRoute({ inbox = false }: { inbox?: boolean }) {
  const { id } = useParams();
  const orgId = useOrgId();
  const key = `${orgId ?? ''}:${id ?? ''}`;
  return inbox ? <MessagesScreen key={key} /> : <DirectMessageScreen key={key} />;
}

/** The radio's library page (note #758), where the backend has a radio. With
 *  the radio off (note #842, the default) its address is one like any other
 *  the Workspace does not know, so it draws the same not-found screen. */
function RadioLibraryRoute() {
  const { state } = useWorkspace();
  if (!state) return null;
  return state.radio ? <RadioLibraryScreen /> : <UnknownScreen />;
}

/** An address from before a segment was renamed: the same place, at its
 *  current address, without a history entry for the old one. */
function LegacyPlace() {
  const location = useLocation();
  return <Navigate to={canonicalToFor(location)} replace />;
}

/** The overview's old address, answered with Home and what it names
 *  (`overviewArrival`): the Workplace window, which Home turns into an
 *  entry of its own so Back closes it rather than leaving Home — or the
 *  agents picker. An old link to a room's notes shelf opens the notes, the
 *  workplace's one list since rooms left the product (note #843). */
function OverviewRedirect() {
  const location = useLocation();
  const [search] = useSearchParams();
  const kept = location.state && typeof location.state === 'object' ? location.state as Record<string, unknown> : {};
  const { notes, ...arrival } = overviewArrival(search);
  if (notes) {
    const orgId = search.get('org');
    return <Navigate to={toFor({ kind: 'notes', ...(orgId ? { orgId } : {}) })!} replace />;
  }
  return <Navigate to="/" replace state={{ ...kept, ...arrival }} />;
}

const SCREENS: Record<WorkspaceRouteKind, ReactElement> = {
  agent: <AgentRoute />,
  agentJobs: <AgentJobsRoute />,
  chat: <ChatRoute />,
  pr: <ProposalScreen />,
  knowledge: <KnowledgeProposalScreen />,
  drive: <DriveRoute />,
  driveFolder: <DriveRoute />,
  driveTrash: <DriveRoute trash />,
  driveFile: <DriveRoute file />,
  notes: <NotesScreen />,
  noteArchive: <NoteArchiveScreen />,
  note: <NoteRoute />,
  knowledgeList: <KnowledgeListScreen />,
  knowledgePage: <KnowledgePageRoute />,
  repo: <RepoRoute />,
  repoFile: <RepoFileRoute />,
  repoHistory: <RepoHistoryRoute />,
  repoContributors: <RepoContributorsRoute />,
  repoCommit: <RepoCommitRoute />,
  // Keyed by list: they are one screen drawn four ways, and moving between
  // them must start each from its own list, never the last one's.
  mail: <MailScreen key="inbox" />,
  mailArchive: <MailScreen key="archive" place="archive" />,
  // Spam (slice 13): where a letter nothing vouched for lands, and a
  // blocked sender's. A place like the other two, searched only from inside.
  mailSpam: <MailScreen key="spam" place="spam" />,
  mailTrash: <MailScreen key="trash" place="trash" />,
  // Sent is the fourth (slice 9) and the one that is not a place: what has
  // gone OUT of this address, one row per letter.
  mailSent: <MailScreen key="sent" place="sent" />,
  // Starred (note #666) is the fifth, and a list of letters like Sent: every
  // one its reader starred, wherever it is kept, Trash and Spam apart.
  mailStarred: <MailScreen key="starred" place="starred" />,
  mailMessage: <Keyed screen={MailConversationScreen} />,
  profile: <ProfileScreen />,
  radioLibrary: <RadioLibraryRoute />,
  organizations: <OrganizationsScreen />,
  organization: <OrganizationScreen />,
  organizationCloud: <OrgCloudScreen />,
  organizationPeople: <PeopleScreen />,
  organizationInvite: <InviteScreen />,
  // The conversation is Home since 2026-10-10; its old address only sends
  // the reader there, so links copied before still land.
  recapChat: <Navigate to="/" replace />,
  // The overview became Home's Workplace window and the agents picker (note
  // #715). Its address — every link, button and open tab that still names
  // it — opens Home with the one it names.
  recapAgent: <OverviewRedirect />,
  messages: <MessageRoute inbox />,
  directMessage: <MessageRoute />,
  organizationMember: <Keyed screen={OrgMemberScreen} />,
  seats: <SeatsScreen />,
  seatSignIn: <SeatSignInScreen />,
  seatSignInProvider: <SeatSignInScreen />,
  seat: <Keyed screen={SeatScreen} />,
  site: <Keyed screen={SiteScreen} />,
  bucket: <Keyed screen={BucketScreen} />,
  secrets: <SecretsScreen />,
  secret: <Keyed screen={SecretScreen} />,
  // The setup gate draws these while a workplace is being set up; reached
  // any other time, there is nothing left to set up.
  setup: <SetupDone />,
  setupCloud: <SetupDone />,
  setupSubscription: <SetupDone />,
  setupSubscriptionProvider: <SetupDone />,
  setupTeam: <SetupDone />,
  apps: <AppsScreen />,
  person: <PublicAddressRoute />,
  workplaceRepo: <PublicRepoRoute />,
  workplaceRepoCommits: <PublicRepoPageRoute page="commits" />,
  workplaceRepoCommit: <PublicRepoPageRoute page="commit" />,
  workplaceRepoProposals: <PublicRepoPageRoute page="proposals" />,
  workplaceRepoProposal: <PublicRepoPageRoute page="proposal" />,
  workplaceRepoContributors: <PublicRepoPageRoute page="contributors" />,
};

/** The registered destinations and the addresses they used to answer on —
 *  the router's table less its doors (Home, sign-up, an invitation). A
 *  window with pages of its own draws these under its own location
 *  (`DestinationsContext`); the router below draws the same ones. */
function destinationRoutes() {
  return [
    ...LEGACY_ROUTER_PATHS.map(({ kind, path }) => (
      <Route key={`legacy:${kind}:${path}`} path={path} element={<LegacyPlace />} />
    )),
    ...ROUTER_PATHS.map(({ kind, path }) => (
      <Route key={kind} path={path} element={SCREENS[kind]} />
    )),
    // The rooms list and a room's own screen, retired with the rooms (note
    // #843): an old link to either opens Home, the workplace the room was
    // part of, rather than a screen with nothing left to show.
    ...WORKSPACE_RETIRED_PATTERNS.map((pattern) => {
      const path = pattern.join('/');
      return <Route key={`retired:${path}`} path={path} element={<Navigate to="/" replace />} />;
    }),
    <Route key="*" path="*" element={<UnknownScreen />} />,
  ];
}

const DESTINATIONS = <Routes>{destinationRoutes()}</Routes>;

export function App({ api }: { api?: WorkspaceApi }) {
  return (
    <SessionProvider api={api}>
      {/* Above the sign-in gate as well as the screens: a recovery sign-in
          announces itself on the Home it lands on, so the toast must outlive
          the gate that showed it. */}
      <BannerProvider>
        {/* Every screen's yes/no, for the same reason the toast is here: a
            question outlives the row that asked it, and the card is drawn
            once rather than per screen. */}
        <ConfirmProvider>
          <div id="webFrame">
            <main id="webMain">
              <WorkspaceRoutes />
            </main>
          </div>
        </ConfirmProvider>
      </BannerProvider>
    </SessionProvider>
  );
}

function WorkspaceRoutes() {
  const { state, api } = useSession();
  const location = useLocation();

  // Public repository pages are entry doors, not signed-in Workspace
  // destinations. Resolve them before the session wait/gate so an anonymous
  // visitor sees source immediately and is never asked to create an account.
  const publicRepo = matchPath('/public/repositories/:id', location.pathname);
  if (publicRepo?.params.id) {
    return <PublicRepoScreen key={`${publicRepo.params.id}:${location.search}`} door={{ kind: 'token', id: publicRepo.params.id }} />;
  }
  // The public addresses are doors too (public-addresses, slices 5 and 6):
  // `/adam` reads without an account, and `/acme/site` is the repository at
  // its address; whoever belongs is sent on from them. A workplace's own
  // word is no page (note #748): it only sends a member on.
  const publicPage = parseWorkspaceRoute(location.pathname, location.search);
  // A person's page is a stranger's door only: someone signed in reads it
  // inside the Workspace, under its own header with Back, as the router's
  // table below draws them — never under the visitor's header and its
  // "Open Workspace" (the owner, 2026-10-11). Until the session is read,
  // the visitor's page stands, so a stranger never waits on it.
  const visitor = state.status !== 'signed-in';
  // The app catalogue (note #756) is a door of the same kind.
  if (publicPage?.kind === 'apps' && visitor) return <AppsScreen />;
  if (publicPage?.kind === 'person' && publicPage.handle && visitor) {
    return <PublicAddressScreen key={publicPage.handle} handle={publicPage.handle} />;
  }
  if (publicPage?.kind === 'workplaceRepo' && publicPage.handle && publicPage.repo) {
    return <PublicRepoScreen key={`${publicPage.handle}/${publicPage.repo}:${location.search}`} door={{ kind: 'address', handle: publicPage.handle, repo: publicPage.repo }} />;
  }
  if (publicPage?.handle && publicPage.repo) {
    const door = { kind: 'address' as const, handle: publicPage.handle, repo: publicPage.repo };
    const key = `${door.handle}/${door.repo}`;
    if (publicPage.kind === 'workplaceRepoCommits') return <PublicRepoHistoryScreen key={key} door={door} />;
    if (publicPage.kind === 'workplaceRepoCommit' && publicPage.sha) return <PublicRepoCommitScreen key={`${key}@${publicPage.sha}`} door={door} sha={publicPage.sha} />;
    if (publicPage.kind === 'workplaceRepoProposals') return <PublicRepoProposalsScreen key={key} door={door} />;
    if (publicPage.kind === 'workplaceRepoProposal' && publicPage.number) return <PublicRepoProposalScreen key={`${key}#${publicPage.number}`} door={door} number={publicPage.number} />;
    if (publicPage.kind === 'workplaceRepoContributors') return <PublicRepoContributorsScreen key={key} door={door} />;
  }

  if (state.status === 'loading') {
    // Mid-setup, the first paint already wears the setup screens' shape.
    return setupLikely(location.pathname) ? <SetupLoadingSkeleton /> : <HomeLoadingSkeleton stage="app" />;
  }

  if (location.pathname === '/verify-email') return <EmailVerificationScreen />;
  if (location.pathname === '/reset-password') return <PasswordResetScreen />;
  if (location.pathname === '/confirm-recovery') return <RecoveryEmailConfirmScreen />;

  if (state.status === 'signed-out') {
    const invite = matchPath('/invite/:token', location.pathname)?.params.token;
    return <AuthGate initialPanel={location.pathname === '/signup' ? 'register' : 'login'} inviteToken={invite} />;
  }

  return (
    <>
      {/* Over every screen, because four of them hand it a picture: the
          viewer is chrome, not a screen's own control. Its document twin
          stands beside it for the same reason — a PDF on a chat, a note, a
          proposal or in Drive opens in the one place (note #403). */}
      <ImageViewerProvider>
      <PdfViewerProvider>
      <WorkspaceProvider api={api} sessionId={state.session.session.sessionId} initialOrgId={state.session.activeOrgId}>
        <DocumentTitle />
        {/* The work radio (note #712) stands above every screen, so its one
            player keeps sounding while the listener moves between them. */}
        <RadioProvider api={api}>
        <FleetProvider api={api}>
          <SeatsProvider api={api}>
          <RequiredSetup>
          <TranscriptProvider>
          <ChatOutboxProvider>
            <NoteDraftProvider>
              <BackProvider>
                <DestinationsContext value={DESTINATIONS}>
                <div id="content">
                  {state.session.emailVerification && state.session.emailVerification.status !== 'verified'
                    ? <EmailVerificationPrompt email={state.session.emailVerification.email} status={state.session.emailVerification.status} />
                    : null}
                  {/* The header stands over what it heads: a screen fills its
                      title slot from below, so it has to be inside it. */}
                  <PageHead>
                    <ScrollMemory />
                    <Routes>
                      <Route path="/" element={<HomeScreen />} />
                      {/* An account just made is a workplace to set up: straight to its
          setup, so the wait before the first step wears setup's shape. */}
      <Route path="/signup" element={<Navigate to="/setup" replace />} />
                      {/* The sign-in door, once through it: Home. */}
                      <Route path="/login" element={<Navigate to="/" replace />} />
                      <Route path="/invite/:token" element={<InviteRedeemScreen />} />
                      {destinationRoutes()}
                    </Routes>
                  </PageHead>
                </div>
                </DestinationsContext>
              </BackProvider>
            </NoteDraftProvider>
          </ChatOutboxProvider>
          </TranscriptProvider>
          </RequiredSetup>
          </SeatsProvider>
        </FleetProvider>
        </RadioProvider>
      </WorkspaceProvider>
      </PdfViewerProvider>
      </ImageViewerProvider>
    </>
  );
}
