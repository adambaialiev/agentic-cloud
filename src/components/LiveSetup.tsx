import { Fragment, useState, type ReactNode } from 'react';
import type { WorkspaceChatMessage } from '../../backend/src/shared/workspace-api';
import { WORKSPACE_AGENT_CHAT_ID } from '../../backend/src/shared/workspace-recap-chat';
import {
  FIRST_RUN_SIGNIN_ASK,
  agentBroughtInReceipt,
  firstRunGreeting,
  firstRunSeatReceipt,
} from '../../backend/src/shared/first-run';
import type { HomeAgent } from '../../backend/workspace-ui/src/workspace/live';
import { AuthShell, EmailPanel } from '../../backend/workspace-ui/src/auth/AuthGate';
import { chatDayLabel } from '../../backend/workspace-ui/src/screens/chat/chat-notice';
import { ChatMessageRow } from '../../backend/workspace-ui/src/screens/chat/ChatMessageRow';
import { FirstRunSignIn, FirstRunStarters, TeamArrivingCard } from '../../backend/workspace-ui/src/screens/home/FirstRun';
import { useSession } from '../../backend/workspace-ui/src/session/useSession';
import { AgentFace } from '../../backend/workspace-ui/src/ui/AgentFace';
import { CHIEF_OF_STAFF } from '../../backend/workspace-ui/src/ui/chief-of-staff';
import { ContextRing } from '../../backend/workspace-ui/src/ui/ContextRing';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FLEET, MINUTE, ORG, ago, useHydrated } from './live/fixture';

/**
 * The screens a person meets first — sign-up, sign-in, and the first run
 * in the Chief of Staff's chat — drawn for the documentation with the app's
 * own components.
 *
 * Until note #726 (the owner, 2026-10-11) a gate stood between the sign-up
 * form and Home: "Sign in a subscription", then "Your team is arriving"
 * with four agents and Continue. There is no gate now. A
 * new account lands on Home, the Chief of Staff's conversation, and the
 * first run happens there in three moments this file draws: the greeting
 * with its three starter answers, the sign-in ask with the two-row card,
 * and the plan with the progress card while the team's computers are built.
 * (Before that, note #664 removed a "Connect your Fly cloud" step: every new
 * workplace runs on the cloud with nothing to connect.)
 *
 * The rows are the chat's own `ChatMessageRow`, and the starters, the card
 * and the progress card are the app's `FirstRun` pieces. The fixed lines
 * come from `shared/first-run.ts`, so the panel cannot drift from the words
 * the product says. As in LiveChat, rows are drawn only after hydration: a
 * bubble carries a clock time, and a clock is local.
 *
 * Claude's sign-in page is the one copy: SeatSignInScreen starts the sign-in
 * ceremony with the server the moment a provider's page opens, so its two
 * steps are drawn here in the screen's own classes (#seatSignInBody,
 * .signinstep, .signinfoot) instead.
 */

const noop = () => {};
const never = async () => {};

/** The sign-up and sign-in forms take the app's API from the session. */
function SignUpForm({ creating }: { creating: boolean }) {
  const { api } = useSession();
  return (
    <AuthShell title={creating ? 'Create your Workspace.' : 'Your Workspace, anywhere.'}>
      <EmailPanel
        api={api}
        email=""
        creating={creating}
        onEmail={noop}
        onSignedIn={never}
        onVerificationRequired={noop}
        onSecondFactor={noop}
        onMode={noop}
        onForgot={noop}
        invited={false}
      />
    </AuthShell>
  );
}

export function LiveSignUp({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="The sign-up page: Create your Workspace, with fields for first name, last name, your email address, password and confirm password, the Create account button, and beside it the box listing what comes after: sign in Codex or Claude, and nothing else, because the agents’ computers run on the cloud.">
      <LiveWorkspace><SignUpForm creating /></LiveWorkspace>
    </LivePanel>
  );
}

export function LiveSignIn({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="The sign-in page: Your Workspace, anywhere, with an Email field, a Password field, a Forgot your password link and the Sign in button.">
      <LiveWorkspace><SignUpForm creating={false} /></LiveWorkspace>
    </LivePanel>
  );
}

/** The Chief of Staff's face on Home: the fixture's workplace dog. */
const CHIEF_FACE = '/agent-avatars/kai.jpg';

/**
 * The Chief of Staff's conversation, as Home draws it: the head with its
 * face and name, the log, whatever stands under the rows (the starters, the
 * sign-in card, the progress card), and the typing bubble while a turn runs.
 */
function ChiefOfStaffChat({ rows: build, runtime, under, activity, agents = FLEET, says, className }: {
  rows: () => WorkspaceChatMessage[];
  runtime: string;
  under?: ReactNode;
  activity?: string;
  agents?: HomeAgent[];
  says: string;
  className: string;
}) {
  const hydrated = useHydrated();
  const [rows] = useState(build);
  let lastDay = '';
  return (
    <LivePanel size="compact" className={className} says={says}>
      <LiveWorkspace agents={agents}>
        <div className="screen" id="screenHome">
          <div className="chathead">
            <span className="chatface chatagent" id="recapChatFace" aria-hidden="true">
              <ContextRing context={undefined}><AgentFace agent={{ avatarUrl: CHIEF_FACE }} /></ContextRing>
            </span>
            <div className="chatwho">
              <h1 id="recapChatTitle">{CHIEF_OF_STAFF}</h1>
              <div className="sub chatruntime" id="recapChatRuntime"><span>{runtime}</span></div>
            </div>
          </div>
          <div className="chatpane" id="recapChatScroll">
            <div id="recapChatLog" className="chatlog">
              {hydrated
                ? rows.map((row) => {
                  const day = new Date(row.at).toDateString();
                  const divider = day !== lastDay ? chatDayLabel(row.at) : '';
                  lastDay = day;
                  return (
                    <Fragment key={row.seq}>
                      {divider ? <div className="chatday">{divider}</div> : null}
                      <ChatMessageRow
                        row={row}
                        agentId={WORKSPACE_AGENT_CHAT_ID}
                        workspaceLinks
                        onOpenProposal={() => {}}
                        onOpenFile={() => {}}
                        onPictureLoaded={() => {}}
                      />
                    </Fragment>
                  );
                })
                : null}
              {under}
            </div>
            {activity ? (
              <div className="chatlive" id="recapChatLive">
                <div className="chatmsg agent">
                  <span className="tdots"><i /><i /><i /></span>
                  <span className="activity" id="recapChatActivity">{activity}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}

/** The person's first message: typed, not tapped, so the plan is about their own idea. */
const FIRST_ASK = 'Put a waitlist page live for my meal planner idea.';

const GREETING_ROWS = (): WorkspaceChatMessage[] => [
  { seq: 0, role: 'agent', at: ago(MINUTE), text: firstRunGreeting('James') },
];

/** Home, the first time: the greeting and the three starter answers. */
export function LiveFirstGreeting({ className = '' }: { className?: string }) {
  return (
    <ChiefOfStaffChat
      rows={GREETING_ROWS}
      runtime="Model & effort"
      under={<FirstRunStarters onPick={noop} />}
      agents={[]}
      className={className}
      says="Home on a new workplace: the Chief of Staff’s greeting, Hi James, I’m your Chief of Staff, tell me what you’re working on, and I’ll put a team of agents on it, with three starter answers to tap under it: put a waitlist page live for my idea, look at my website and tell me what to fix first, set up a team for my startup."
    />
  );
}

const SIGN_IN_ROWS = (): WorkspaceChatMessage[] => [
  ...GREETING_ROWS(),
  { seq: 1, role: 'owner', at: ago(30_000), text: FIRST_ASK },
  { seq: 2, role: 'agent', at: ago(29_000), text: FIRST_RUN_SIGNIN_ASK },
];

/** The sign-in ask under the person's first message, with the two-row card. */
export function LiveFirstSignIn({ className = '' }: { className?: string }) {
  return (
    <ChiefOfStaffChat
      rows={SIGN_IN_ROWS}
      runtime="Model & effort"
      under={<FirstRunSignIn orgId={ORG.orgId} />}
      agents={[]}
      className={className}
      says="The same conversation after the first message, Put a waitlist page live for my meal planner idea: the Chief of Staff answers Got it, your agents and I run on your own Claude or ChatGPT plan, sign it in below, and I’ll start. Under it, a card with two rows, Claude for a Claude Pro or Max subscription and Codex for a ChatGPT Plus or Pro subscription, and the line that you sign in on Claude’s or OpenAI’s own page, and your password never touches us."
    />
  );
}

/** The team the Chief of Staff brought in, mid-arrival: Juno's computer
 *  being built and Ivy starting. */
const JUNO: HomeAgent = {
  ...FLEET[0]!,
  id: 'agent_juno',
  name: 'Juno',
  avatarUrl: '/agent-avatars/juno.jpg',
  status: 'setting-up',
  working: false,
  now: undefined,
  activity: undefined,
  recap: undefined,
  context: undefined,
};
const IVY: HomeAgent = {
  ...JUNO,
  id: 'agent_ivy',
  name: 'Ivy',
  avatarUrl: '/agent-avatars/iris.jpg',
  status: 'planned',
};
const TEAM = [JUNO, IVY];

const PLAN_ROWS = (): WorkspaceChatMessage[] => [
  ...SIGN_IN_ROWS(),
  { seq: 3, role: 'platform', at: ago(20_000), text: firstRunSeatReceipt('claude') },
  { seq: 4, role: 'platform', at: ago(7_000), text: agentBroughtInReceipt(JUNO.name) },
  { seq: 5, role: 'platform', at: ago(6_000), text: agentBroughtInReceipt(IVY.name) },
  {
    seq: 6,
    role: 'agent',
    at: ago(5_000),
    text: `Here’s the plan.\n\n- **Juno** builds the waitlist page and puts it live.\n- **Ivy** writes the page’s words and the welcome email.\n\nThey’re starting now. I’ll tell you when the page is up.`,
  },
];

/** The plan, and the progress card while the team's computers are built. */
export function LiveFirstPlan({ className = '' }: { className?: string }) {
  return (
    <ChiefOfStaffChat
      rows={PLAN_ROWS}
      runtime="Claude Code · opus · high"
      under={<TeamArrivingCard agents={TEAM} />}
      agents={TEAM}
      className={className}
      says="The plan, once the plan is signed in: the rows Your Claude plan is signed in, Brought in Juno and Brought in Ivy, then the Chief of Staff’s reply, Here’s the plan, with one line per agent and They’re starting now, I’ll tell you when the page is up. Under the chat, the Arriving card: Juno, Computer being built, and Ivy, Starting."
    />
  );
}

/** Claude's sign-in page, opened from the card: open and approve, then paste the code. */
export function LiveClaudeSignIn({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="Claude's sign-in page: step one, Open and approve, with the Open the Claude sign-in button, a copyable link and a line saying you sign in on Anthropic's own page; step two, Paste the code it gives you, with the code field; then Cancel and Finish sign-in.">
      <LiveWorkspace>
        <div className="screen" id="screenSeatSignIn">
          <div className="phead"><div className="pname"><h1 id="seatSignInTitle">Sign in to Claude</h1></div></div>
          <div className="card">
            <div id="seatSignInBody">
              <div className="signinstep">
                <div className="stepk"><span className="stepn"><span>1</span></span><span>Open and approve</span></div>
                <button className="btn primary" type="button">Open the Claude sign-in</button>
                <div className="signinlink"><input aria-label="Sign-in link" readOnly value="https://claude.ai/oauth/authorize?code=true&client_id=…" /></div>
                <div className="fieldhint">You sign in on Anthropic’s own page, and your password never touches us.</div>
              </div>
              <div className="signinstep">
                <div className="stepk"><span className="stepn"><span>2</span></span><span>Paste the code it gives you</span></div>
                <input type="text" readOnly aria-label="Paste the sign-in code" placeholder="xxxxxxxx#xxxxxxxx" value="" />
                <div className="fieldhint">It is two long strings joined by a # — copy it whole, # and all.</div>
              </div>
              <div className="signinfoot">
                <button className="btn bare" type="button">Cancel</button>
                <button className="formcommit" type="button" disabled>Finish sign-in</button>
              </div>
            </div>
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
