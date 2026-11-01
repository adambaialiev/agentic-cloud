import type { WorkspaceSiteRow } from '../../../../src/shared/workspace-api.js';

export const SITE_STATE: Record<string, { label: string; warn?: true; line: string }> = {
  'pending-payment': { label: 'not built yet', warn: true, line: 'Reserved, not built yet. Your agent finishes this on its next deploy.' },
  provisioning: { label: 'setting up', line: 'Being built. It goes live on its own in a minute or two.' },
  'payment-lapsed': { label: 'paused', warn: true, line: 'Paused. Its files are kept.' },
  stopped: { label: 'stopped', warn: true, line: 'Stopped by support.' },
};

export function siteIsLive(site: Pick<WorkspaceSiteRow, 'status' | 'url'>): boolean {
  return site.status === 'live' && Boolean(site.url);
}

export function sitesOf(state: { sites?: unknown[] | null } | null): WorkspaceSiteRow[] {
  return Array.isArray(state?.sites) ? (state!.sites as WorkspaceSiteRow[]) : [];
}
