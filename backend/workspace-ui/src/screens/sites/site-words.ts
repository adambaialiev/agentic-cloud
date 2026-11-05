import type { WorkspaceSiteCost, WorkspaceSiteCostsAnswer, WorkspaceSiteDisk, WorkspaceSiteRow } from '../../../../src/shared/workspace-api.js';

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

/**
 * The cost words (note #993). No price lives here: every figure is the
 * backend's (`api/sites/costs`, priced by `config/fly-cost-estimates.ts`, the
 * spend view's table); this only says it.
 */

/** "~$3.64/mo": an estimate, so it wears the tilde the CLI's spend view uses. */
export function perMonth(usd: number): string {
  return `~$${usd.toFixed(2)}/mo`;
}

/** "about $17.60 a month" — the total, said as a sentence. */
export function aboutAMonth(usd: number): string {
  return `about $${usd.toFixed(2)} a month`;
}

/** The product's three presets by their own names; anything else as stored. */
export function presetName(preset: string): string {
  return preset === 'static' || preset === 'service' || preset === 'service-pro' ? preset : preset || 'site';
}

function memory(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
}

/** "1 shared CPU · 512 MB memory" */
export function machineShape(machine: NonNullable<WorkspaceSiteCost['machine']>): string {
  const kind = machine.cpuKind === 'performance' ? 'performance' : 'shared';
  return `${machine.cpus} ${kind} CPU${machine.cpus === 1 ? '' : 's'} · ${memory(machine.memoryMb)} memory`;
}

/** "3 GB", "2 × 3 GB", "3 GB + 1 GB" */
export function disksSize(disks: WorkspaceSiteDisk[]): string {
  if (disks.length === 0) return 'none';
  const sizes = disks.map((disk) => disk.sizeGb);
  if (sizes.every((size) => size === sizes[0])) return disks.length === 1 ? `${sizes[0]} GB` : `${disks.length} × ${sizes[0]} GB`;
  return sizes.map((size) => `${size} GB`).join(' + ');
}

/** "2 spare disks · 6 GB, billed" — on the row, so they are never invisible. */
export function spareDisksLine(spare: WorkspaceSiteDisk[], hosted = false): string {
  const total = spare.reduce((sum, disk) => sum + disk.sizeGb, 0);
  // Hosted: the platform pays, so "billed" would contradict the line above.
  return `${spare.length} spare disk${spare.length === 1 ? '' : 's'} · ${total} GB, ${hosted ? 'in the estimate' : 'billed'}`;
}

/** What the row's right-hand side says under the preset. */
export function rowCost(cost: WorkspaceSiteCost | undefined, loading: boolean): string {
  if (!cost) return loading ? '' : 'cost unread';
  if (!cost.read) return 'cost unread';
  return perMonth(cost.monthlyUsd ?? 0);
}

/** The Sites screen's sub-line: the count, the domain, and what they cost together. */
export function sitesCostSuffix(answer: Pick<WorkspaceSiteCostsAnswer, 'monthlyUsd' | 'unread' | 'sites'> | null): string {
  if (!answer || answer.sites.length === 0) return '';
  if (answer.unread === answer.sites.length) return ' · cost could not be read';
  return ` · est. $${answer.monthlyUsd.toFixed(2)} a month${answer.unread ? ` (${answer.unread} not read)` : ''}`;
}

/** Said once, where a site owner reads it (note #993): a site never sleeps. */
export function alwaysOnWords(hosted: boolean | null): { lead: string; rest: string } {
  if (hosted === null) return { lead: 'Sites never sleep.', rest: 'Each one is always on, so its cost runs whether or not anyone visits.' };
  return hosted
    ? { lead: 'Sites never sleep.', rest: 'Each one is always on, so it costs the same whether or not anyone visits. Your workplace runs on Agentic Cloud, which pays for it; nothing here is billed to you.' }
    : { lead: 'Sites never sleep.', rest: 'Each one is always on, so its cost runs on your cloud bill whether or not anyone visits. Agents are different: they sleep when idle.' };
}

/** The footer under the figures. */
export function estimateFootnote(answer: Pick<WorkspaceSiteCostsAnswer, 'hosted' | 'disclaimer'>): string {
  return answer.hosted
    ? 'Estimates from Fly’s published prices, for a full month: machine plus disks.'
    : `${answer.disclaimer} Each figure is a full month: machine plus disks.`;
}
