import type {
  ManagedServerRuntimeContext,
  ManagedServerRuntimeSummary,
  SelectedMachineRuntimeContext,
  SessionRuntimeContext,
  TelegramUserRuntimeContext,
} from '../types/runtime-context.js';
import { FRESH_SERVER_APT_GUIDANCE } from '../agent/coding-cli-install-guidance.js';
import { posix as pathPosix } from 'path';
import { normalizeDevelopmentRoot } from '../services/development-root.js';

function sanitizeInlineString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeTimeZone(value: unknown): string | undefined {
  const trimmed = sanitizeInlineString(value);
  if (!trimmed) return undefined;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return undefined;
  }
}

function sanitizeTelegramUsername(value: unknown): string | undefined {
  const trimmed = sanitizeInlineString(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.replace(/^@+/, '');
  return normalized || undefined;
}

function sanitizeTelegramUser(value: unknown): TelegramUserRuntimeContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const telegramUser: TelegramUserRuntimeContext = {};
  const username = sanitizeTelegramUsername((value as TelegramUserRuntimeContext).username);
  const firstName = sanitizeInlineString((value as TelegramUserRuntimeContext).firstName);
  const lastName = sanitizeInlineString((value as TelegramUserRuntimeContext).lastName);
  const languageCode = sanitizeInlineString((value as TelegramUserRuntimeContext).languageCode);

  if (username) telegramUser.username = username;
  if (firstName) telegramUser.firstName = firstName;
  if (lastName) telegramUser.lastName = lastName;
  if (languageCode) telegramUser.languageCode = languageCode;

  return Object.keys(telegramUser).length > 0 ? telegramUser : undefined;
}

function getMachineIdentifierCandidates(identifier: string): string[] {
  const normalized = identifier.trim();
  if (!normalized) return [];

  const serverScoped = normalized.startsWith('server:')
    ? normalized.slice('server:'.length).trim()
    : '';

  return serverScoped ? [normalized, serverScoped] : [normalized];
}

function machineMatchesIdentifier(machine: ManagedServerRuntimeSummary, identifier: string): boolean {
  const candidates = getMachineIdentifierCandidates(identifier);
  if (candidates.length === 0) return false;

  return candidates.some((candidate) => (
    machine.recordId === candidate
    || String(machine.serverId) === candidate
    || `hcloud-sandbox-${machine.serverId}` === candidate
  ));
}

export function findRuntimeMachineByIdentifier(
  runtimeContext: SessionRuntimeContext | null | undefined,
  machineIdentifier: string | null | undefined,
): ManagedServerRuntimeSummary | null {
  const machines = runtimeContext?.managedServers?.servers ?? [];
  if (machines.length === 0) return null;

  const normalizedIdentifier = machineIdentifier?.trim();
  if (!normalizedIdentifier) return null;

  const notDeleted = machines.filter((machine) => machine.status !== 'deleted');
  const candidates = notDeleted.length > 0 ? notDeleted : machines;
  return candidates.find((machine) => machineMatchesIdentifier(machine, normalizedIdentifier)) ?? null;
}

export function resolveRuntimeMachineName(
  runtimeContext: SessionRuntimeContext | null | undefined,
  machineIdentifier: string | null | undefined,
): string | undefined {
  return sanitizeInlineString(findRuntimeMachineByIdentifier(runtimeContext, machineIdentifier)?.name);
}

function sanitizeManagedServerSummary(value: unknown): ManagedServerRuntimeSummary | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as ManagedServerRuntimeSummary;
  const serverId = Number(raw.serverId);
  const recordId = sanitizeInlineString(raw.recordId);
  const provider = raw.provider === 'hetzner'
      ? 'hetzner'
      : raw.provider === 'fly'
        ? 'fly'
        : undefined;
  const name = sanitizeInlineString(raw.name);
  // Legacy records may still carry the retired `default_sandbox` purpose; treat it as a general server.
  const rawPurpose = (raw.purpose as string) === 'default_sandbox' ? 'general' : raw.purpose;
  const purpose = rawPurpose === 'deployment' || rawPurpose === 'general'
    ? rawPurpose
    : undefined;
  const status = raw.status === 'active'
    || raw.status === 'deleted'
    || raw.status === 'delete_failed'
    || raw.status === 'provisioning'
    || raw.status === 'error'
    ? raw.status
    : undefined;

  if (!Number.isFinite(serverId) || serverId < 1 || !name || !purpose || !status) {
    return undefined;
  }

  const normalized: ManagedServerRuntimeSummary = {
    serverId: Math.floor(serverId),
    name,
    purpose,
    status,
  };

  if (recordId) normalized.recordId = recordId;
  if (provider) normalized.provider = provider;
  if (raw.connectionMethod === 'websocket_relay') {
    normalized.connectionMethod = raw.connectionMethod;
  }
  if (raw.tunnelStatus === 'online' || raw.tunnelStatus === 'offline') {
    normalized.tunnelStatus = raw.tunnelStatus;
  }
  const cloudStatus = sanitizeInlineString(raw.cloudStatus);
  const region = sanitizeInlineString(raw.region);
  const size = sanitizeInlineString(raw.size);
  const publicAddress = sanitizeInlineString(raw.publicAddress);
  const updatedAt = sanitizeInlineString(raw.updatedAt);

  if (cloudStatus) normalized.cloudStatus = cloudStatus;
  if (region) normalized.region = region;
  if (size) normalized.size = size;
  if (publicAddress) normalized.publicAddress = publicAddress;
  if (updatedAt) normalized.updatedAt = updatedAt;

  return normalized;
}

function getManagedServerRuntimeKey(server: ManagedServerRuntimeSummary): string {
  if (server.recordId) {
    return server.recordId;
  }

  return `${server.provider ?? 'hetzner'}:${server.serverId}`;
}

function sanitizeManagedServers(value: unknown): ManagedServerRuntimeContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as ManagedServerRuntimeContext;
  if (!Array.isArray(raw.servers)) {
    return undefined;
  }

  const seenServerKeys = new Set<string>();
  const servers = raw.servers
    .map((server) => sanitizeManagedServerSummary(server))
    .filter((server): server is ManagedServerRuntimeSummary => {
      if (!server) {
        return false;
      }

      const key = getManagedServerRuntimeKey(server);
      if (seenServerKeys.has(key)) {
        return false;
      }
      seenServerKeys.add(key);
      return true;
    });

  if (servers.length === 0 && raw.servers.length > 0) {
    return undefined;
  }

  const normalized: ManagedServerRuntimeContext = { servers };
  return normalized;
}

function sanitizeSelectedMachine(value: unknown): SelectedMachineRuntimeContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as SelectedMachineRuntimeContext;
  const serverId = Number(raw.serverId);
  if (!Number.isFinite(serverId) || serverId < 1) {
    return undefined;
  }

  const normalized: SelectedMachineRuntimeContext = { serverId: Math.floor(serverId) };
  const recordId = sanitizeInlineString(raw.recordId);
  if (recordId) {
    normalized.recordId = recordId;
  }
  return normalized;
}

function sanitizeWriteProtectedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const trimmed = candidate.trim();
    if (!trimmed.startsWith('/')) {
      continue;
    }

    const normalizedPath = pathPosix.normalize(trimmed);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    normalized.push(normalizedPath);
  }

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeRuntimeContext(
  value: SessionRuntimeContext | null | undefined,
): SessionRuntimeContext | undefined {
  if (!value) return undefined;

  const normalized: SessionRuntimeContext = {};
  const timeZone = sanitizeTimeZone(value.timeZone);
  const developmentRoot = normalizeDevelopmentRoot(value.developmentRoot);
  const writeProtectedPaths = sanitizeWriteProtectedPaths(value.writeProtectedPaths);
  const telegramUser = sanitizeTelegramUser(value.telegramUser);
  const managedServers = sanitizeManagedServers(value.managedServers);
  const selectedMachine = sanitizeSelectedMachine(value.selectedMachine);

  if (timeZone) normalized.timeZone = timeZone;
  if (developmentRoot) normalized.developmentRoot = developmentRoot;
  if (writeProtectedPaths) normalized.writeProtectedPaths = writeProtectedPaths;
  if (telegramUser) normalized.telegramUser = telegramUser;
  if (managedServers) normalized.managedServers = managedServers;
  if (selectedMachine) normalized.selectedMachine = selectedMachine;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeRuntimeContext(
  ...contexts: Array<SessionRuntimeContext | null | undefined>
): SessionRuntimeContext | undefined {
  const merged: SessionRuntimeContext = {};

  for (const context of contexts) {
    const normalized = normalizeRuntimeContext(context);
    if (!normalized) continue;
    if (normalized.timeZone) merged.timeZone = normalized.timeZone;
    if (normalized.developmentRoot) merged.developmentRoot = normalized.developmentRoot;
    if (normalized.writeProtectedPaths?.length) {
      merged.writeProtectedPaths = [
        ...(merged.writeProtectedPaths ?? []),
        ...normalized.writeProtectedPaths.filter((path) => !(merged.writeProtectedPaths ?? []).includes(path)),
      ];
    }
    if (normalized.telegramUser) {
      merged.telegramUser = {
        ...(merged.telegramUser ?? {}),
        ...normalized.telegramUser,
      };
    }
    if (normalized.managedServers) {
      merged.managedServers = normalized.managedServers;
    }
    if (normalized.selectedMachine) {
      merged.selectedMachine = normalized.selectedMachine;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function areRuntimeContextsEqual(
  left: SessionRuntimeContext | null | undefined,
  right: SessionRuntimeContext | null | undefined,
): boolean {
  const normalizedLeft = normalizeRuntimeContext(left);
  const normalizedRight = normalizeRuntimeContext(right);
  const leftPaths = normalizedLeft?.writeProtectedPaths ?? [];
  const rightPaths = normalizedRight?.writeProtectedPaths ?? [];
  const leftTelegramUser = normalizedLeft?.telegramUser;
  const rightTelegramUser = normalizedRight?.telegramUser;
  const leftManagedServers = normalizedLeft?.managedServers;
  const rightManagedServers = normalizedRight?.managedServers;
  const leftManagedServersJson = leftManagedServers ? JSON.stringify(leftManagedServers) : '';
  const rightManagedServersJson = rightManagedServers ? JSON.stringify(rightManagedServers) : '';
  const leftSelectedMachine = normalizedLeft?.selectedMachine;
  const rightSelectedMachine = normalizedRight?.selectedMachine;

  return normalizedLeft?.timeZone === normalizedRight?.timeZone
    && normalizedLeft?.developmentRoot === normalizedRight?.developmentRoot
    && leftPaths.length === rightPaths.length
    && leftPaths.every((path, index) => path === rightPaths[index])
    && leftTelegramUser?.username === rightTelegramUser?.username
    && leftTelegramUser?.firstName === rightTelegramUser?.firstName
    && leftTelegramUser?.lastName === rightTelegramUser?.lastName
    && leftTelegramUser?.languageCode === rightTelegramUser?.languageCode
    && leftManagedServersJson === rightManagedServersJson
    && leftSelectedMachine?.recordId === rightSelectedMachine?.recordId
    && leftSelectedMachine?.serverId === rightSelectedMachine?.serverId;
}

function formatCurrentDateTime(now: Date, timeZone?: string): string {
  if (!timeZone) {
    return `${now.toISOString()} (UTC)`;
  }

  return `${new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).format(now)} (${timeZone})`;
}

function buildTelegramIdentityLines(telegramUser: TelegramUserRuntimeContext): string[] {
  return [
    `- Telegram username: ${telegramUser.username ? `@${telegramUser.username}` : 'unavailable'}`,
    `- Telegram first name: ${telegramUser.firstName ?? 'unavailable'}`,
    `- Telegram last name: ${telegramUser.lastName ?? 'unavailable'}`,
    `- Telegram language code: ${telegramUser.languageCode ?? 'unavailable'}`,
  ];
}

function buildManagedServerLines(managedServers: ManagedServerRuntimeContext): string[] {
  const lines = [
    `- Tracked managed servers: ${managedServers.servers.length}`,
  ];
  if (managedServers.servers.length === 0) {
    lines.push('- No managed development server exists yet. Development work that needs a server should create or select one before using development-runtime tools.');
    return lines;
  }

  lines.push('- Managed server state (pick the most suitable active server for the task; if several are equally suitable, ask the user which one to use):');
  for (const server of managedServers.servers) {
    const parts = [
      `${server.name} (#${server.serverId})`,
      `provider=${server.provider ?? 'hetzner'}`,
      `purpose=${server.purpose}`,
      `status=${server.status}`,
    ];
    if (server.recordId) {
      parts.push(`record_id=${server.recordId}`);
    }
    if (server.connectionMethod) {
      parts.push(`connection=${server.connectionMethod}`);
    }
    if (server.tunnelStatus) {
      parts.push(`link=${server.tunnelStatus}`);
    }
    if (server.size) {
      parts.push(`size=${server.size}`);
    }
    if (server.region) {
      parts.push(`region=${server.region}`);
    }
    if (server.publicAddress) {
      parts.push(`public_ip=${server.publicAddress}`);
    }
    lines.push(`  - ${parts.join(' | ')}`);
  }

  lines.push('- The minimum expected baseline for a development server is `rg`, `git`, `gh`, `curl`, `jq`, `unzip`, and other task-required CLI tooling.');
  lines.push(`- Fresh-server apt safety: ${FRESH_SERVER_APT_GUIDANCE}`);

  return lines;
}


export function buildTelegramIdentityPromptSection(
  value: SessionRuntimeContext | null | undefined,
  heading = '## User Identity',
): string {
  const runtimeContext = normalizeRuntimeContext(value);
  const telegramUser = runtimeContext?.telegramUser;
  if (!telegramUser) {
    return '';
  }

  return [
    heading,
    '',
    ...buildTelegramIdentityLines(telegramUser),
    '',
    'Use these profile details as lightweight identity context for greetings, language choice, and follow-up routing. Do not over-assume anything not present here.',
  ].join('\n');
}

export function buildRuntimeContextPromptSection(
  value: SessionRuntimeContext | null | undefined,
): string {
  const runtimeContext = normalizeRuntimeContext(value);
  const timeZone = runtimeContext?.timeZone;
  const writeProtectedPaths = runtimeContext?.writeProtectedPaths ?? [];
  const telegramUser = runtimeContext?.telegramUser;
  const managedServers = runtimeContext?.managedServers;
  const lines = [
    '## Runtime Context',
    '',
    `- User timezone: ${timeZone ?? 'unavailable'}`,
  ];

  if (runtimeContext?.developmentRoot && managedServers?.servers.length) {
    lines.push(`- Development server root: ${runtimeContext.developmentRoot}`);
  }

  if (telegramUser) {
    lines.push(...buildTelegramIdentityLines(telegramUser));
    lines.push('- Treat these Telegram fields as optional identity hints, not verified profile preferences.');
  }

  if (writeProtectedPaths.length > 0) {
    lines.push('- Protected write paths:');
    for (const path of writeProtectedPaths) {
      lines.push(`  - ${path}`);
    }
    lines.push('- Do not edit, replace, or patch protected runtime files. If a protected test or scaffold appears wrong, fix the implementation instead.');
  }

  if (managedServers) {
    lines.push(...buildManagedServerLines(managedServers));
  } else {
    lines.push('- Tracked managed servers: 0');
    lines.push('- No managed development server exists yet. Development work that needs a server should create or select one before using development-runtime tools.');
  }

  lines.push('');
  lines.push('Use this timezone, together with the separately supplied current datetime, when interpreting relative dates/times like "today", "tomorrow", and "tonight".');

  return lines.join('\n');
}

export function buildCurrentDateTimePromptSection(
  value: SessionRuntimeContext | null | undefined,
  now = new Date(),
): string {
  const runtimeContext = normalizeRuntimeContext(value);
  const currentDateTime = formatCurrentDateTime(now, runtimeContext?.timeZone);

  return [
    '## Current Time',
    '',
    `- Current datetime: ${currentDateTime}`,
    '',
    'Treat this timestamp as the authoritative reference for relative dates/times in this response.',
  ].join('\n');
}
