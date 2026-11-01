import type { WorkspaceRuntimeClient } from '../services/sandbox-client.js';

/**
 * Owns the per-process sandbox client every turn reaches machines through.
 * It used to cache a ToolExecutor per session and per sandbox too; the
 * platform no longer runs tools itself, so the client is all that is left.
 */
export class SessionManager {
  private sandboxClient: WorkspaceRuntimeClient;

  constructor(sandboxClient: WorkspaceRuntimeClient) {
    this.sandboxClient = sandboxClient;
  }

  getSandboxClient(): WorkspaceRuntimeClient {
    return this.sandboxClient;
  }
}
