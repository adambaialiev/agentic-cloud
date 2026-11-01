import { randomBytes } from 'node:crypto';
import type { RouteDeps } from '../../routes/deps.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import type { UserStorage } from '../../services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
  type WorkspaceWebSessionDocument,
} from '../../services/workspace-web-auth.js';
import { hashOpaqueToken } from '../../utils/totp.js';

export const WORKSPACE_TEST_ORIGIN = 'https://workspace.test';

const sessionToken = (identity: number) => `workspace-session-${identity}`;
const csrfToken = (identity: number) => `workspace-csrf-${identity}`;

export function workspaceTestHeaders(identity: number): Record<string, string> {
  return {
    Cookie: `__Host-acc_session=${sessionToken(identity)}; __Host-acc_csrf=${csrfToken(identity)}`,
    Origin: WORKSPACE_TEST_ORIGIN,
    'X-CSRF-Token': csrfToken(identity),
  };
}

function testSession(userId: string, identity: number): WorkspaceWebSessionDocument {
  return {
    sessionId: `workspace-test-${identity}`,
    userId,
    authMethod: 'totp',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    idleExpiresAt: '2099-01-01T00:00:00.000Z',
    absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
  };
}

export async function addWorkspaceTestAuth(
  deps: Partial<RouteDeps>,
  userStorage: UserStorage,
  identities: Record<number, string> = { 42: 'user-1', 43: 'user-2' },
): Promise<void> {
  const storage = new InMemoryWorkspaceWebAuthStorage();
  for (const [identity, userId] of Object.entries(identities)) {
    await storage.createSession(
      hashOpaqueToken(sessionToken(Number(identity))),
      testSession(userId, Number(identity)),
    );
  }
  deps.workspaceWebAuth = new WorkspaceWebAuthService(
    storage,
    userStorage,
    new SecretCipher(randomBytes(32).toString('base64')),
  );
  deps.workspaceWebOrigin = WORKSPACE_TEST_ORIGIN;
}
