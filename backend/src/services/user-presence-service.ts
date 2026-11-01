export interface PresenceUpdate {
  active: boolean;
  visible?: boolean;
  pathname?: string;
}

interface ConnectionPresenceState {
  active: boolean;
  visible: boolean;
  pathname?: string;
  updatedAtMs: number;
}

export class UserPresenceService {
  private readonly userConnections = new Map<string, Map<string, ConnectionPresenceState>>();

  constructor(
    private readonly staleThresholdMs = 60_000,
  ) {}

  updateConnection(
    userId: string,
    connectionId: string,
    update: PresenceUpdate,
  ): void {
    if (!userId || !connectionId) {
      return;
    }

    let connections = this.userConnections.get(userId);
    if (!connections) {
      connections = new Map();
      this.userConnections.set(userId, connections);
    }

    const previous = connections.get(connectionId);
    connections.set(connectionId, {
      active: Boolean(update.active),
      visible: update.visible ?? previous?.visible ?? Boolean(update.active),
      pathname: update.pathname ?? previous?.pathname,
      updatedAtMs: Date.now(),
    });
  }

  removeConnection(userId: string, connectionId: string): void {
    const connections = this.userConnections.get(userId);
    if (!connections) {
      return;
    }

    connections.delete(connectionId);
    if (connections.size === 0) {
      this.userConnections.delete(userId);
    }
  }

  isUserActive(
    userId: string,
    nowMs = Date.now(),
    staleThresholdMs = this.staleThresholdMs,
  ): boolean {
    const connections = this.userConnections.get(userId);
    if (!connections) {
      return false;
    }

    for (const [connectionId, state] of connections.entries()) {
      if (nowMs - state.updatedAtMs > staleThresholdMs) {
        connections.delete(connectionId);
        continue;
      }

      if (state.active) {
        return true;
      }
    }

    if (connections.size === 0) {
      this.userConnections.delete(userId);
    }
    return false;
  }
}
