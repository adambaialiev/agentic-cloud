export interface TelegramUserRuntimeContext {
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
}

export type ManagedServerRuntimePurpose = 'deployment' | 'general';
export type ManagedServerRuntimeStatus = 'active' | 'deleted' | 'delete_failed' | 'provisioning' | 'error';
export type ManagedServerRuntimeProvider = 'digitalocean' | 'hetzner' | 'fly';
export type ManagedServerRuntimeConnectionMethod = 'websocket_relay';
export type ManagedServerRuntimeTunnelStatus = 'online' | 'offline';

export interface ManagedServerRuntimeSummary {
  recordId?: string;
  serverId: number;
  provider?: ManagedServerRuntimeProvider;
  name: string;
  purpose: ManagedServerRuntimePurpose;
  status: ManagedServerRuntimeStatus;
  connectionMethod?: ManagedServerRuntimeConnectionMethod;
  tunnelStatus?: ManagedServerRuntimeTunnelStatus;
  cloudStatus?: string;
  region?: string;
  size?: string;
  publicAddress?: string;
  updatedAt?: string;
}

export interface ManagedServerRuntimeContext {
  servers: ManagedServerRuntimeSummary[];
}

/**
 * The machine a session has been deliberately bound to (for example a child
 * session spawned against an explicit serverId, or a standard session the user
 * pinned to a machine). When present, file placement targets this machine
 * instead of guessing among the available servers.
 */
export interface SelectedMachineRuntimeContext {
  recordId?: string;
  serverId: number;
}

export interface SessionRuntimeContext {
  timeZone?: string;
  developmentRoot?: string;
  writeProtectedPaths?: string[];
  telegramUser?: TelegramUserRuntimeContext;
  managedServers?: ManagedServerRuntimeContext;
  selectedMachine?: SelectedMachineRuntimeContext;
}
