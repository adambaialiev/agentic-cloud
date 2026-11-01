import type { FlyMachineGuest } from '../services/fly-client.js';

/**
 * Rough monthly cost of Fly resources, for the org spend view
 * (byo-fly-design: "spend is visible without leaving Telegram — an honest
 * estimate labelled as one, with the Fly dashboard as the authority").
 *
 * ESTIMATES, deliberately: Fly publishes prices but bills per second, by
 * region, with free allowances — chasing exactness here would produce a
 * number that LOOKS authoritative and still disagrees with the invoice.
 * These figures are Fly's published us/eu on-demand prices as of 2026-08
 * and every surface that prints them says "estimate" and points at the Fly
 * dashboard. Update the table when Fly moves prices; nothing else depends
 * on it.
 *
 * The shape that matters most is RUNNING vs STOPPED: compute bills only
 * while a machine runs, so a slept agent machine costs its volume and
 * almost nothing else — which is the honest headline of the whole view.
 */

/** $/month for one CPU core, by kind (30-day month). */
const PERFORMANCE_CORE_MONTHLY_USD = 31.0;
const SHARED_CORE_MONTHLY_USD = 1.94;
/** $/month per GB of RAM beyond the kind's included GB-per-core. */
const EXTRA_RAM_GB_MONTHLY_USD = 5.0;
const PERFORMANCE_INCLUDED_RAM_GB_PER_CORE = 2;
const SHARED_INCLUDED_RAM_GB_PER_CORE = 0.25;
/** Fly's monthly examples use a 30-day (720-hour) month. */
export const ESTIMATE_HOURS_PER_MONTH = 30 * 24;
/** $/month per provisioned volume GB. */
export const VOLUME_GB_MONTHLY_USD = 0.15;

export const COST_ESTIMATE_DISCLAIMER =
  'Estimates from Fly’s published prices — the Fly dashboard is the authority.';

/** What a machine of this shape costs per month IF it ran the whole month. */
export function estimateGuestMonthlyUsd(guest: FlyMachineGuest | undefined): number {
  const cpus = guest?.cpus ?? 1;
  const memoryGb = (guest?.memory_mb ?? 256) / 1024;
  const performance = guest?.cpu_kind === 'performance';
  const coreUsd = performance ? PERFORMANCE_CORE_MONTHLY_USD : SHARED_CORE_MONTHLY_USD;
  const includedGb = cpus * (performance ? PERFORMANCE_INCLUDED_RAM_GB_PER_CORE : SHARED_INCLUDED_RAM_GB_PER_CORE);
  const extraGb = Math.max(0, memoryGb - includedGb);
  return round2(cpus * coreUsd + extraGb * EXTRA_RAM_GB_MONTHLY_USD);
}

/** Hourly compute price for one machine shape; storage is billed separately. */
export function estimateGuestHourlyUsd(guest: FlyMachineGuest | undefined): number {
  return round4(estimateGuestMonthlyUsd(guest) / ESTIMATE_HOURS_PER_MONTH);
}

export function estimateVolumeMonthlyUsd(sizeGb: number): number {
  return round2(sizeGb * VOLUME_GB_MONTHLY_USD);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
