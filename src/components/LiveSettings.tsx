import { ConfirmContext } from '../../backend/workspace-ui/src/chrome/confirm-context';
import { ProfileScreen } from '../../backend/workspace-ui/src/screens/profile/ProfileScreen';
import type { WorkspaceMailWakeAnswer } from '../../backend/src/shared/workspace-mail';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FLEET } from './live/fixture';

/**
 * The Settings screen, live: James's name and picture, his own address on
 * the mail domain with the row that picks which agent is woken by mail, and
 * the Access card — password, recovery email, authenticator, this browser.
 *
 * The screen asks the confirm context only when a destructive row is
 * pressed, which the fence never lets happen; it still needs the provider
 * to mount. The address card reads api/mail/wake on mount, answered here
 * with Ruby as the chosen agent. Its title portals into the app's header
 * (ScreenTitle), which the page has none of, so the head is copied.
 */

const WAKE: WorkspaceMailWakeAnswer = {
  agent: { id: FLEET[0]!.id, name: FLEET[0]!.name, cli: 'claude' },
  agents: FLEET.map((agent) => ({ id: agent.id, name: agent.name, cli: agent.cli })),
};

const JAMES = {
  name: 'James',
  profile: { firstName: 'James', lastName: 'Okafor', incomplete: false },
  account: {
    browserLogin: {
      enabled: true as const,
      method: 'email' as const,
      email: 'james@agenticcloudcomputer.com',
      secondFactorEnabled: false,
      verificationStatus: 'verified' as const,
      recoveryEmail: { email: 'james.okafor@gmail.com', status: 'verified' as const },
    },
    mailbox: { address: 'james@agenticcloudcomputer.com' },
  },
};

export default function LiveSettings({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="wide"
      className={className}
      says="The Settings screen: a Name row with Edit, a Picture card, Your address showing james at the mail domain with the row naming which agent is woken when mail arrives, and the Access card with rows for sign-in, password, recovery email, authenticator security and this browser."
    >
      <LiveWorkspace user={JAMES} answers={{ 'api/mail/wake': WAKE }}>
        <ConfirmContext.Provider value={async () => false}>
          <div className="phead">
            <div className="pname"><h1>Settings</h1><div className="sub">James</div></div>
          </div>
          <ProfileScreen />
        </ConfirmContext.Provider>
      </LiveWorkspace>
    </LivePanel>
  );
}
