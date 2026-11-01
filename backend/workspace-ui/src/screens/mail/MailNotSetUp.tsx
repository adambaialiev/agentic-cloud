/**
 * The Mail section of a private copy before anyone set email up (note #946).
 *
 * A copy installs with no mail at all, so the inbox cannot simply look empty:
 * "nothing has arrived yet" would be a promise that letters are on their
 * way. This card says plainly that email is not set up, what it would give
 * everyone here, and — for an admin — the one way to set it up. A member is
 * told who can. The inbox itself stays under it: notices the Workspace writes
 * itself (a workplace about to be deleted) still land there without mail.
 */
import { useNavigate } from 'react-router-dom';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';

export type MailSetupPhase = NonNullable<WorkspaceStateAnswer['mailSetup']>;

export function mailIsOff(setup: WorkspaceStateAnswer['mailSetup'] | undefined): setup is MailSetupPhase {
  return Boolean(setup && setup.state !== 'on');
}

export function MailNotSetUp({ setup, domain }: { setup: MailSetupPhase; domain: string }) {
  const navigate = useNavigate();
  const started = setup.state === 'provider' || setup.state === 'records';
  const where = domain ? <strong>@{domain}</strong> : 'their own address here';
  return <div className="card" id="mailNotSetUp">
    <div className="crow">
      <div className="main">
        <div className="name plain">{started ? 'Email is being set up' : 'Email is not set up yet'}</div>
        <div className="cline wrapline"><span className="ctext">
          {started
            ? 'An admin has started. It turns on by itself once its DNS records are in.'
            : 'This Workspace was installed without email. Everything else works without it.'}
        </span></div>
      </div>
    </div>
    <div className="empty mailnotsetup-what">
      Once it is on, everyone here gets mail at {where}: letters from outside arrive in this inbox, people and their agents can write out (an agent&apos;s letter waits for its person&apos;s yes), and a forgotten password can be reset by email.
      Until then, notices from this Workspace itself still arrive here.
    </div>
    {setup.canSetUp
      ? <button className="addrow" id="mailSetUpDoor" type="button" onClick={() => navigate(toFor({ kind: 'mailSetup' })!)}>{started ? 'Continue setting up email' : 'Set up email'}</button>
      : <div className="empty" id="mailAskAdmin">An admin of this workplace can set it up.</div>}
  </div>;
}
