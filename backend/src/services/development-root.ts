import { posix as pathPosix } from 'path';
import type { SessionRuntimeContext } from '../types/runtime-context.js';

export const DEFAULT_DEVELOPMENT_ROOT = '/root';
export const DEFAULT_DEVELOPMENT_SSH_USER = 'agent';

export function getDefaultDevelopmentRootForSshUser(username?: string): string {
  const trimmed = username?.trim();
  if (!trimmed || trimmed === 'root') {
    return '/root';
  }

  return pathPosix.join('/home', trimmed);
}

export function normalizeDevelopmentRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  return pathPosix.normalize(trimmed);
}

export function getRuntimeDevelopmentRoot(
  runtimeContext: SessionRuntimeContext | null | undefined,
): string | undefined {
  if (!runtimeContext?.managedServers?.servers?.length) {
    return undefined;
  }

  return normalizeDevelopmentRoot(runtimeContext.developmentRoot);
}

export function getEffectiveDevelopmentRoot(
  runtimeContext: SessionRuntimeContext | null | undefined,
  fallback = DEFAULT_DEVELOPMENT_ROOT,
): string {
  return getRuntimeDevelopmentRoot(runtimeContext) ?? fallback;
}
