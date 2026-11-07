import type { CopyPulseStore } from './copy-pulse-storage.js';
import { COPY_ALERT_CONDITIONS, copyConditions, type CopyAlertCondition } from '../shared/copy-pulse.js';
import type { WorkspaceAgentEvent, WorkspaceAgentEventKind } from '../shared/workspace-agent-proactive.js';
import { workspaceRoutePath } from '../shared/workspace-routes.js';

/**
 * Alerts about private copies (note #1058), as rows in the Chief of Staff's
 * chat of whoever runs our platform: a new copy's first pulse, a copy silent
 * for three days, two releases behind, a backup older than two days or a disk
 * under ten percent free, a copy whose admin turned the pulse off.
 *
 * ONE ALERT PER CONDITION PER COPY. A condition is said once while it holds;
 * the ledger (copy_pulse_alerts) forgets it when it clears, so a copy that
 * goes silent again a month later is said again, and a copy that stays silent
 * is not said every day. A condition that cannot be told (no release list)
 * is neither said nor forgotten.
 *
 * The sweep reads every copy hourly and soon after a pulse arrives
 * (`nudge`). Everything new in one sweep goes to each recipient together, as
 * one delivery, so five copies going quiet at once is one look, not five.
 */

export const COPY_ALERT_SWEEP_MS = 60 * 60 * 1000;
export const COPY_ALERT_BOOT_DELAY_MS = 5 * 60 * 1000;
const NUDGE_DEBOUNCE_MS = 30 * 1000;

/** The kind each condition is handed over as. */
export const COPY_ALERT_KIND: Record<CopyAlertCondition, WorkspaceAgentEventKind> = {
  'first-pulse': 'copy-new',
  silent: 'copy-silent',
  behind: 'copy-behind',
  backup: 'copy-trouble',
  disk: 'copy-trouble',
  'opted-out': 'copy-opted-out',
};

export interface CopyAlertRecipient { userId: string; orgId: string }

export interface CopyAlertDeps {
  store: CopyPulseStore;
  /** The releases we offer, oldest first; null when the update service did not answer. */
  offered(): Promise<string[] | null>;
  /** Whose Chief of Staff hears about copies, and in which workplace. */
  recipients(): Promise<CopyAlertRecipient[]>;
  /** Land the rows (and start a turn where the person wants one). Resolves whether they landed. */
  deliver(recipient: CopyAlertRecipient, events: WorkspaceAgentEvent[]): Promise<boolean>;
  now?(): Date;
  log?(line: string): void;
}

export class CopyAlertSweep {
  private timer?: ReturnType<typeof setInterval>;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private nudged?: ReturnType<typeof setTimeout>;
  private running: Promise<number> | null = null;
  constructor(private readonly deps: CopyAlertDeps) {}
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  start(): void {
    if (this.timer) return;
    this.bootTimer = setTimeout(() => { void this.sweep().catch(() => 0); }, COPY_ALERT_BOOT_DELAY_MS);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => { void this.sweep().catch(() => 0); }, COPY_ALERT_SWEEP_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.nudged) clearTimeout(this.nudged);
    this.timer = undefined;
  }
  /** A pulse arrived: look again soon, once for a burst. */
  nudge(): void {
    if (this.nudged) return;
    this.nudged = setTimeout(() => { this.nudged = undefined; void this.sweep().catch(() => 0); }, NUDGE_DEBOUNCE_MS);
    this.nudged.unref?.();
  }

  /** One look at every copy. Resolves how many alerts were said. */
  sweep(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.sweepOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async sweepOnce(): Promise<number> {
    const now = this.now();
    const offered = await this.deps.offered().catch(() => null);
    const copies = await this.deps.store.list();
    const fresh: Array<{ copyId: string; condition: CopyAlertCondition; event: WorkspaceAgentEvent }> = [];
    for (const record of copies) {
      const { holding, unknown } = copyConditions(record, offered, now);
      const said = await this.deps.store.alerts(record.copyId);
      const href = workspaceRoutePath({ kind: 'copy', id: record.copyId }) ?? undefined;
      for (const alert of holding) {
        if (said[alert.condition]) continue;
        fresh.push({
          copyId: record.copyId, condition: alert.condition,
          event: { kind: COPY_ALERT_KIND[alert.condition], key: `copy:${record.copyId}:${alert.condition}:${record.lastSeenAt}`, text: alert.text, at: record.lastSeenAt, ...(href ? { href } : {}) },
        });
      }
      // Cleared: forgotten, so the next time it holds is said again. A new
      // copy stays said for good.
      const holds = new Set(holding.map((alert) => alert.condition));
      for (const condition of COPY_ALERT_CONDITIONS) {
        if (condition === 'first-pulse' || !said[condition] || holds.has(condition) || unknown.includes(condition)) continue;
        await this.deps.store.setAlert(record.copyId, condition, null);
      }
    }
    if (!fresh.length) return 0;
    const recipients = await this.deps.recipients().catch(() => []);
    let landed = false;
    for (const recipient of recipients) {
      const ok = await this.deps.deliver(recipient, fresh.map((item) => item.event)).catch((error) => {
        this.deps.log?.(`[copy-alerts] ${recipient.userId}/${recipient.orgId}: could not deliver: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
      landed ||= ok;
    }
    // Recorded only once somebody has them: with nobody to tell yet, the
    // next sweep tries again.
    if (!landed) return 0;
    for (const item of fresh) await this.deps.store.setAlert(item.copyId, item.condition, now.toISOString());
    this.deps.log?.(`[copy-alerts] said ${fresh.length}: ${fresh.map((item) => `${item.condition}@${item.copyId}`).join(', ')}`);
    return fresh.length;
  }
}
