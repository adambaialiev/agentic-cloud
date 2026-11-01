/**
 * Tells someone when a backup has quietly stopped happening.
 *
 * The git and database backup jobs each report to an ops Telegram bot on every
 * run, which is useful right up to the failure that matters: a job that stops
 * running altogether says nothing at all, and a message that never arrives is
 * not something people notice. Three weeks later the backup you reach for is
 * three weeks old.
 *
 * So the jobs POST a heartbeat here on every successful run, and this watches
 * the clock instead of the messages. If a job has not reported success in 48
 * hours, it says so — unprompted, in the same place the green messages go.
 *
 * WHY THIS LIVES IN THE BACKEND and not next to the jobs: a backup job cannot
 * report its own absence. The git bundles run on ia-media; if that box is off,
 * wedged, or its timer got disabled by a stray deploy, nothing on it will ever
 * tell you. The watcher has to be somewhere else, and the backend is the one
 * process that is always up, already has a database to remember in, and is
 * itself monitored by the fact that people are using it.
 *
 * The gap this leaves is honest and worth naming: if the BACKEND is down,
 * nothing here fires either. That failure is loud in every other way (the
 * product stops working), which is exactly why it is an acceptable blind spot
 * and a silently dead backup job is not.
 */

/** One job's record. Stored as a document, keyed by {@link BackupHeartbeat.job}. */
export interface BackupHeartbeat {
  /** Stable id the job reports under: `git`, `db`. */
  job: string;
  /** ISO time of the last run that SUCCEEDED. Absent until one does. */
  lastSuccessAt?: string;
  /** ISO time of the last report of any kind, success or failure. */
  lastReportAt?: string;
  lastStatus?: 'ok' | 'fail';
  /** Whatever the job said about itself — "11 repos, 0 failures". */
  lastDetail?: string;
  /**
   * When this monitor first started expecting to hear from this job. A job
   * that has NEVER reported is measured from here, so adding a new job does
   * not fire an alert on the spot, and a job that never once worked still
   * gets caught 48h later.
   */
  watchingSince: string;
  /** True while we are actively complaining, so recovery can be announced. */
  alerting?: boolean;
  /** ISO time of the last alert sent, to rate-limit the repeats. */
  lastAlertAt?: string;
}

export interface BackupHeartbeatStore {
  get(job: string): BackupHeartbeat | undefined;
  put(heartbeat: BackupHeartbeat): void;
  list(): BackupHeartbeat[];
}

/** In-memory store, for tests and for running without SQLite configured. */
export class InMemoryBackupHeartbeatStore implements BackupHeartbeatStore {
  private readonly rows = new Map<string, BackupHeartbeat>();

  get(job: string): BackupHeartbeat | undefined {
    return this.rows.get(job);
  }

  put(heartbeat: BackupHeartbeat): void {
    this.rows.set(heartbeat.job, heartbeat);
  }

  list(): BackupHeartbeat[] {
    return [...this.rows.values()];
  }
}

const HOUR_MS = 60 * 60_000;

export interface BackupStalenessMonitorDeps {
  store: BackupHeartbeatStore;
  /**
   * The jobs that are SUPPOSED to report. Explicit rather than inferred from
   * what has reported before: a job that has never once checked in is the
   * exact failure this exists to catch, and a list built from arrivals can
   * never contain it.
   */
  jobs: string[];
  /** Delivers one line of text to the ops channel. Must never throw. */
  notify: (text: string) => Promise<void> | void;
  /** How quiet is too quiet. Default 48h: two missed nightly runs, not one. */
  staleAfterMs?: number;
  /** How often to look. Default hourly — the threshold is in days. */
  intervalMs?: number;
  /** How often to repeat an alert while a job stays broken. Default 24h. */
  reAlertEveryMs?: number;
  now?: () => Date;
}

export class BackupStalenessMonitor {
  private readonly store: BackupHeartbeatStore;
  private readonly jobs: string[];
  private readonly notify: (text: string) => Promise<void> | void;
  private readonly staleAfterMs: number;
  private readonly intervalMs: number;
  private readonly reAlertEveryMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: BackupStalenessMonitorDeps) {
    this.store = deps.store;
    this.jobs = deps.jobs;
    this.notify = deps.notify;
    this.staleAfterMs = deps.staleAfterMs ?? 48 * HOUR_MS;
    this.intervalMs = deps.intervalMs ?? HOUR_MS;
    this.reAlertEveryMs = deps.reAlertEveryMs ?? 24 * HOUR_MS;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Record a run. Called by the ingest route; the jobs themselves only ever
   * make an HTTP request that they ignore the result of.
   *
   * A FAILED run is recorded but does not refresh `lastSuccessAt` — the job
   * already shouted about that failure itself, and what this class measures is
   * time-since-a-backup-actually-happened, which a failure does not advance.
   */
  record(job: string, status: 'ok' | 'fail', detail?: string): void {
    const at = this.now().toISOString();
    const existing = this.store.get(job);
    const next: BackupHeartbeat = {
      ...(existing ?? { job, watchingSince: at }),
      job,
      lastReportAt: at,
      lastStatus: status,
      ...(detail ? { lastDetail: detail } : {}),
      ...(status === 'ok' ? { lastSuccessAt: at } : {}),
    };
    this.store.put(next);
  }

  /** The point on the clock a job is judged against. */
  private referenceFor(heartbeat: BackupHeartbeat): number {
    // Never-reported jobs are measured from when we started watching, so a
    // newly added job gets a full grace period instead of an instant alert.
    const reference = heartbeat.lastSuccessAt ?? heartbeat.watchingSince;
    return Date.parse(reference);
  }

  /** One pass. Exposed so tests drive it directly instead of waiting an hour. */
  async sweep(): Promise<void> {
    const now = this.now();
    const nowMs = now.getTime();

    for (const job of this.jobs) {
      let heartbeat = this.store.get(job);
      if (!heartbeat) {
        // First sight of a job we expect: start its clock now rather than
        // treating "no record" as "infinitely stale".
        heartbeat = { job, watchingSince: now.toISOString() };
        this.store.put(heartbeat);
      }

      const ageMs = nowMs - this.referenceFor(heartbeat);
      const stale = ageMs > this.staleAfterMs;

      if (!stale) {
        if (heartbeat.alerting) {
          this.store.put({ ...heartbeat, alerting: false, lastAlertAt: undefined });
          await this.deliver(
            `✅ backup recovered — ${job}\n`
            + `${describeAge(ageMs)} since the last successful run.`,
          );
        }
        continue;
      }

      // Stale. Alert on the way in, then at most once per reAlertEveryMs —
      // an hourly repeat of the same bad news trains people to mute it.
      const lastAlertMs = heartbeat.lastAlertAt ? Date.parse(heartbeat.lastAlertAt) : undefined;
      const due = lastAlertMs === undefined || nowMs - lastAlertMs >= this.reAlertEveryMs;
      if (!due) continue;

      this.store.put({ ...heartbeat, alerting: true, lastAlertAt: now.toISOString() });
      await this.deliver(this.describeStale(job, heartbeat, ageMs));
    }
  }

  private describeStale(job: string, heartbeat: BackupHeartbeat, ageMs: number): string {
    const lines = [`🔴 BACKUP STALE — ${job}`];
    if (heartbeat.lastSuccessAt) {
      lines.push(`No successful run in ${describeAge(ageMs)} (last: ${heartbeat.lastSuccessAt}).`);
    } else {
      // Distinguished on purpose: "never worked" and "stopped working" have
      // completely different first moves, and the message should not make the
      // reader guess which one they are looking at.
      lines.push(`Never reported a successful run since ${heartbeat.watchingSince}.`);
    }
    if (heartbeat.lastStatus === 'fail') {
      lines.push(`Its last report was a FAILURE: ${heartbeat.lastDetail ?? '(no detail)'}`);
    } else if (heartbeat.lastReportAt && heartbeat.lastReportAt !== heartbeat.lastSuccessAt) {
      lines.push(`Last heard from at ${heartbeat.lastReportAt}.`);
    } else if (!heartbeat.lastReportAt) {
      lines.push('It has never checked in at all — the job may not be running.');
    }
    return lines.join('\n');
  }

  /** A notifier that throws must not kill the sweep for every other job. */
  private async deliver(text: string): Promise<void> {
    try {
      await this.notify(text);
    } catch (error) {
      console.warn('[backup-monitor] could not deliver alert:', error);
    }
  }

  start(): void {
    if (this.timer) return;
    // Not on boot: the process has just started, nothing has had a chance to
    // report, and an alert in the first second of uptime would be noise. The
    // first sweep lands one interval in.
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        console.warn('[backup-monitor] sweep failed:', error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(
      `[backup-monitor] watching ${this.jobs.join(', ') || '(nothing)'} —`
      + ` alert after ${Math.round(this.staleAfterMs / HOUR_MS)}h,`
      + ` checked every ${Math.round(this.intervalMs / 60_000)}m`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function describeAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Posts to the ops Telegram bot directly. Backup and fleet monitors share it,
 * so every operational signal lands in one place.
 *
 * Never throws and never blocks for long: an alert that cannot be delivered
 * must not take the sweep down with it.
 */
export function createOpsNotifier(config: {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (text: string) => Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  return async (text: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        // Status only. The token is in the URL, and a thrown fetch error
        // prints the URL it was fetching — which would write the bot token
        // into the logs for good.
        console.warn(`[ops-notifier] Telegram rejected the alert (HTTP ${response.status})`);
      }
    } catch {
      console.warn('[ops-notifier] Telegram was unreachable');
    } finally {
      clearTimeout(timer);
    }
  };
}
