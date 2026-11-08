import { MailCcField, MailFilesField } from '../../backend/workspace-ui/src/screens/mail/MailOutgoing';
import { Icon } from '../../backend/workspace-ui/src/ui/icons';
import { JobCards } from '../../backend/workspace-ui/src/screens/jobs/BackgroundJobsScreen';
import { NEW_AGENT_CLIS, NEW_AGENT_QUESTION } from '../../backend/workspace-ui/src/screens/home/agent-words';
import type { WorkspaceManagedJob, WorkspaceSettledJob } from '../../backend/src/shared/workspace-api';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { HOUR, MINUTE, ago, useHydrated } from './live/fixture';

/**
 * The forms and small screens the documentation shows beside the words
 * that explain them: writing an email, adding a secret, an agent's
 * background jobs, the New agent chooser.
 *
 * Each screen's title portals into the app's header (ScreenTitle), which a
 * page has none of, so the head's lines are copied above the screen — the
 * same four lines LiveAgent copies.
 *
 * The two forms are COPIES of the screens' markup, in the screens' own
 * classes and ids. MailComposeScreen and AddSecretForm are leaves: they
 * claim the app's Back on mount, and claiming Back scrolls the window to
 * the leaf's top and holds it there (useLeafScroll) — on a page of prose
 * that is a reader who cannot scroll. The Cc and files rows are the app's
 * own components; they claim nothing. The chooser is drawn in the app's
 * `.ask` classes rather than through AskToChoose, whose scrim portals onto
 * the page's body.
 */

const noop = () => {};

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="phead">
      <div className="pname"><h1>{title}</h1>{sub ? <div className="sub">{sub}</div> : null}</div>
    </div>
  );
}

export function LiveMailCompose({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="The New message screen: To, an Add Cc link, Subject, a Message box, Attach files, and the Send message button. The head says it is from james at the mail domain.">
      <LiveWorkspace>
        <div className="screen" id="screenMailCompose">
          <Head title="New message" sub="from james@agents.northstar.com" />
          <div className="mailcompose">
            <label className="drow frow">
              <div className="head"><div className="k">To</div></div>
              <input id="mailToField" type="email" readOnly placeholder="name@example.com" value="dana@harbourfreight.com" />
            </label>
            <MailCcField cc={[]} onChange={noop} />
            <label className="drow frow">
              <div className="head"><div className="k">Subject</div></div>
              <input id="mailSubjectField" className="prose" type="text" readOnly placeholder="What it is about" value="Pilot start: the first forty vans" />
            </label>
            <label className="drow frow">
              <div className="head"><div className="k">Message</div></div>
              <textarea id="mailComposeText" className="prose" readOnly placeholder="Write your message" rows={5} value={'Hi Dana,\n\nWe can start the pilot on Monday the 5th. The dispatch app is live at its own address and the routing service has run the full week of sample stops.\n\nJames'} />
            </label>
            <MailFilesField picked={[]} onPicked={noop} />
            <div className="authactions">
              <button className="formcommit" id="mailComposeSend" type="button">Send message</button>
            </div>
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}

function AudienceRow({ picked, title, body }: { picked: boolean; title: string; body: string }) {
  return (
    <div className={picked ? 'crow' : 'crow open'}>
      <Icon name={picked ? 'check' : 'chev'} size={17} className={picked ? 'icon tick' : 'icon chev'} />
      <div className="main">
        <div className="name plain">{title}</div>
        <div className="desc">{body}</div>
      </div>
    </div>
  );
}

export function LiveAddSecret({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="The Add a secret screen, as an admin sees it: a Name field showing GH_TOKEN, a Value box, the choice of whose agents get it — admins' agents only, or every agent in the workplace — and the Save for the workplace button.">
      <LiveWorkspace>
        <div className="screen" id="screenAdd">
          <Head title="Add a secret" />
          <div className="sub" id="addSub">For the agents of this workplace to use.</div>
          <form id="addForm" autoComplete="off" onSubmit={(event) => event.preventDefault()}>
            <div className="card">
              <label className="drow frow">
                <div className="k">Name</div>
                <input id="secretName" readOnly placeholder="GH_TOKEN" value="GH_TOKEN" />
              </label>
              <label className="drow frow">
                <div className="head"><div className="k">Value</div><div className="count" id="valueCount">40 characters</div></div>
                <textarea id="secretValue" readOnly placeholder="Paste the value" rows={3} value="ghp_••••••••••••••••••••••••••••••••••••" />
              </label>
            </div>
            <div className="card" id="audienceCard">
              <div className="drow"><div className="k">Whose agents get it</div></div>
              <AudienceRow picked title="Admins’ agents only" body="Members see the name and what it is for, but their agents are never handed the value." />
              <AudienceRow picked={false} title="Every agent in the workplace" body="Members’ agents get it too — and a member can ask their agent to show it." />
            </div>
            <button className="formcommit" id="saveBtn" type="submit"><span>Save for the workplace</span></button>
            <div className="formhint" id="formHint">Saved straight over HTTPS — it never appears in your chat history. The agents it reaches pick it up on the next turn and hand it straight to the tool that needs it; the value is stripped out of anything sent back.</div>
          </form>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}

const RUNNING: WorkspaceManagedJob[] = [
  { id: 'j_4f2a9c1e', label: 'bash -lc "cargo bench --bench routes -- --save-baseline monday"', startedAt: ago(4 * MINUTE + 12_000) },
];
const RECENT: WorkspaceSettledJob[] = [
  { id: 'j_b71d03aa', label: 'npm run build:driver-app', startedAt: ago(52 * MINUTE), finishedAt: ago(47 * MINUTE), status: 'succeeded' },
  { id: 'j_09e6c4d2', label: 'node scripts/replay-pings.mjs --day 2026-09-01', startedAt: ago(3 * HOUR), finishedAt: ago(2 * HOUR + 20 * MINUTE), status: 'timed_out' },
];

export function LiveJobs({ className = '' }: { className?: string }) {
  // The elapsed times are clocks, so the cards wait for hydration; the
  // head and the empty frame are in the prerendered page.
  const hydrated = useHydrated();
  return (
    <LivePanel size="wide" className={className} says="Ruby's Background jobs screen: one job running for four minutes, a benchmark, with its status, start time and job ID; and under Recently finished, a build that finished and a replay that timed out.">
      <LiveWorkspace>
        <div className="screen" id="screenAgentJobs">
          <Head title="Background jobs" sub="Ruby" />
          {hydrated ? <JobCards jobs={RUNNING} recent={RECENT} now={Date.now()} /> : null}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}

export function LiveNewAgent({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="wide" className={className} says="The New agent question: it gets a conversation in this Workspace and its own cloud machine, and keeps this choice for life. What should it run? Three choices: Claude Code, which runs on your Claude subscription, Codex, which runs on your ChatGPT subscription, and OpenCode, which runs on your OpenCode Go subscription, then Cancel.">
      <LiveWorkspace>
        <div className="ask" role="dialog">
          <h3>New agent</h3>
          <p>{NEW_AGENT_QUESTION}</p>
          <div className="choices">
            {NEW_AGENT_CLIS.map((option) => (
              <div className="choice" key={option.id}>
                <span className="n">{option.label}</span>
                <span className="d">{option.hint}</span>
              </div>
            ))}
          </div>
          <div className="btns"><button className="btn ghost" type="button">Cancel</button></div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
