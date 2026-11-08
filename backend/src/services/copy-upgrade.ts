/**
 * Upgrade from inside the Workspace (note #1008, designed on note #1007): the
 * button on a company's own Agentic Cloud. The Workspace never runs a step of
 * the upgrade itself. It checks that an upgrade may start, copies the new
 * release's `upgrader` image into the copy's registry, records who asked,
 * and starts the one-shot upgrader machine in `<prefix>-upgrader`, the very
 * one the engineer's `node install.mjs upgrade` starts. The upgrader keeps
 * its run record in the backup bucket (`upgrades/…`), outside everything it
 * rolls, so this service reads it back after the Workspace itself was
 * restarted, put back, or both.
 *
 * Nothing here is ever answered with a key or logged with one.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  WorkspaceCopyUpgradeRun, WorkspaceCopyUpgradeState, WorkspaceCopyUpgradeStep,
} from '../shared/workspace-api.js';
import type { FlyClient } from './fly-client.js';
import { upgraderAppName } from './copy-upgrader.js';

/** A run whose heartbeat is older than this has no upgrader left. */
export const STALE_HEARTBEAT_MS = 120_000;
/** A --here run's lock (install.mjs HERE_LOCK) older than this no longer holds. */
const HERE_LOCK_STALE_MS = 2 * 3600_000;
/** The disk must keep this much beyond twice the database: the snapshot sits on it. */
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

export class CopyUpgradeRefused extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'CopyUpgradeRefused';
  }
}

/** The run record's home: the copy's backup bucket. */
export interface UpgradeBucket {
  getText(key: string): Promise<string | null>;
  putText(key: string, text: string): Promise<void>;
}

export function s3UpgradeBucket(config: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }): UpgradeBucket {
  const client = new S3Client({
    endpoint: config.endpoint, region: 'auto', forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async getText(key) {
      try {
        const answer = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        return (await answer.Body?.transformToString()) ?? null;
      } catch (error) {
        const code = (error as { name?: string; $metadata?: { httpStatusCode?: number } });
        if (code.name === 'NoSuchKey' || code.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async putText(key, text) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: text, ContentType: 'application/json' }));
    },
  };
}

/** The installer's own registry code, as the backend image carries it (installer/install.mjs). */
export interface InstallerModule {
  updatesSource(opts: { url: string }): { release(version: string): Promise<{ version: string; images: Record<string, { tag: string }> }> };
  flyRegistry(opts: { app: string; token: string }): unknown;
  copyImage(source: unknown, dest: unknown, tag: string, workdir: string): Promise<unknown>;
}

export async function loadInstaller(): Promise<InstallerModule> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.COPY_INSTALLER_PATH,
    path.resolve(here, '../../installer/install.mjs'), // the backend image: current/dist/services → current/installer
    path.resolve(here, '../../../infra/copy-installer/install.mjs'), // a checkout
  ].filter((file): file is string => Boolean(file));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error('the installer is not in this backend image');
  return import(pathToFileURL(file).href) as Promise<InstallerModule>;
}

interface RunRecord {
  id: string;
  requestedBy?: string;
  toVersion?: string;
  drill?: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: 'done' | 'put-back' | 'drill-done' | 'unchanged' | 'failed';
  message?: string | null;
  release?: { version?: string };
  shape?: { prefix?: string; release?: { version?: string } };
  upgrade?: { phase?: string; from?: { version?: string }; toVersion?: string; snapshot?: { at?: string } } | null;
}
interface StepEvent { event: string; title?: string; status?: string; seconds?: number; at?: string; detail?: string }

/** Plain words for one of the upgrade's own step titles (install.mjs upgrade()). */
export function stepLabel(title: string, prefix: string, snapshotAt?: string | null): { key: string; label: string; back: boolean } {
  const apps: Record<string, string> = {
    [`${prefix}-backend`]: 'Workspace', [`${prefix}-git`]: 'Code host', [`${prefix}-router`]: 'Previews and sites', [`${prefix}-mx`]: 'Mail receiver',
  };
  if (/^Copying release /.test(title)) return { key: 'copy', label: 'Release copied into your registry', back: false };
  if (title === 'Snapshotting the database') return { key: 'snapshot', label: 'Database backed up, disks snapshotted', back: false };
  if (title === 'Smoke test') return { key: 'smoke', label: 'Final check', back: false };
  if (title === 'database back to the snapshot') {
    const time = snapshotAt ? new Date(snapshotAt).toISOString().slice(11, 16) : null;
    return { key: 'db-back', label: time ? `Database back to ${time} UTC` : 'Database back as it was', back: true };
  }
  const back = /^(\S+) back to (\S+)$/.exec(title);
  if (back) return { key: `back-${back[1]}`, label: `${apps[back[1]!] ?? back[1]} back to ${back[2]}`, back: true };
  const forward = /^(\S+) to (\S+)( \(made not to start, for the drill\))?$/.exec(title);
  if (forward) return { key: `to-${forward[1]}`, label: `${apps[forward[1]!] ?? forward[1]} → ${forward[2]}${forward[3] ? ' (made not to start)' : ''}`, back: false };
  return { key: title, label: title, back: false };
}

/**
 * One run as the admin's screen shows it: every step the upgrader reported,
 * and, while it is still going forward, the ones still to come.
 */
export function runView(run: RunRecord, events: StepEvent[], heartbeatAt: string | null, prefix: string, now: Date, open: boolean): WorkspaceCopyUpgradeRun {
  const from = run.upgrade?.from?.version ?? run.shape?.release?.version ?? null;
  const to = run.toVersion ?? null;
  const steps: WorkspaceCopyUpgradeStep[] = [];
  const byKey = new Map<string, WorkspaceCopyUpgradeStep>();
  let backStarted = false;
  for (const event of events) {
    if (event.event !== 'step' || !event.title) continue;
    const { key, label, back } = stepLabel(event.title, prefix, run.upgrade?.snapshot?.at);
    if (back) backStarted = true;
    let step = byKey.get(key);
    // A restart of the upgrader reports a step again: one row, its latest state.
    if (!step || (back && step.back === false)) {
      step = { key, label, state: 'now', seconds: null, startedAt: null, detail: null, back };
      byKey.set(key, step);
      steps.push(step);
    }
    if (event.status === 'done') {
      step.state = 'done';
      step.seconds = event.seconds ?? null;
      step.detail = null;
    } else if (event.status === 'running') {
      // Each attempt starts its own clock: a restarted upgrader runs the step
      // again, and the duration it reports when done is that attempt's.
      step.state = 'now';
      step.startedAt = event.at ?? null;
      step.detail = null;
    } else {
      step.state = 'now';
      if (event.detail) step.detail = event.detail;
    }
  }
  const heardMs = heartbeatAt ? now.getTime() - new Date(heartbeatAt).getTime() : null;
  const live = open && heardMs !== null && heardMs < STALE_HEARTBEAT_MS;
  // A step left running when the way back began is the one that failed.
  for (const step of steps) {
    if (step.state === 'now' && !step.back && (backStarted || (run.outcome && run.outcome !== 'done'))) step.state = 'fail';
    if (step.state === 'now' && run.outcome) step.state = 'fail';
  }
  if (open && !backStarted && to) {
    const plan = [
      ['copy', 'Release copied into your registry'],
      ['snapshot', 'Database backed up, disks snapshotted'],
      [`to-${prefix}-backend`, `Workspace → ${to}`],
      [`to-${prefix}-git`, `Code host → ${to}`],
      [`to-${prefix}-router`, `Previews and sites → ${to}`],
      ['smoke', 'Final check'],
    ] as const;
    for (const [key, label] of plan) if (!byKey.has(key)) steps.push({ key, label, state: 'wait', seconds: null, startedAt: null, detail: null, back: false });
  }
  if (open && backStarted) {
    for (const [key, label] of [['db-back', 'Database back as it was']] as const) {
      if (!byKey.has(key)) steps.push({ key, label, state: 'wait', seconds: null, startedAt: null, detail: null, back: true });
    }
  }
  const phase: WorkspaceCopyUpgradeRun['phase'] = run.outcome
    ?? (open ? (live ? (backStarted || run.upgrade?.phase === 'rolling-back' ? 'putting-back' : 'running') : 'stopped') : 'failed');
  return {
    id: run.id,
    requestedBy: run.requestedBy ?? null,
    from,
    to,
    drill: run.drill ? (run.drill === 'backend' ? 'backend' : 'rollback') : null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    phase,
    heardSecondsAgo: heardMs === null ? null : Math.round(heardMs / 1000),
    message: run.message ?? null,
    snapshotAt: run.upgrade?.snapshot?.at ?? null,
    steps,
  };
}

export interface CopyUpgradeOptions {
  prefix: string;
  region: string;
  token: string;
  updatesUrl: string | null;
  bucket: UpgradeBucket | null;
  fly: Pick<FlyClient, 'listMachines' | 'createMachine'>;
  /** The release this copy runs, and the newest one offered. */
  releases: () => Promise<{ running: string | null; latest: string | null; latestDate: string | null }>;
  /** Whether <prefix>-upgrader was made ready at start (copy-upgrader.ts). */
  upgraderReady: () => boolean;
  dataDir?: string;
  dbPath?: string;
  /**
   * The Claude sign-ins open in this process's memory: whose, and since when.
   * An upgrade restarts the Workspace and would cut them (note #1008).
   */
  signInsOpen: () => Array<{ userId: string; startedAt: number }>;
  /**
   * Forget one person's open sign-in (their own Cancel). Since note #1082 the
   * upgrade card offers it to the admin whose own forgotten sign-in holds the
   * button: leaving the sign-in page any way but Cancel left it open 15 min.
   */
  cancelSignIn?: (userId: string) => Promise<void>;
  agentsWorking: () => number;
  /** Roll a mail receiver an installer before note #946 made. */
  rollMx: boolean;
  installer?: () => Promise<InstallerModule>;
  now?: () => Date;
  log?: (line: string) => void;
}

const SIGNIN_MAX_AGE_MS = 15 * 60_000;

/**
 * What the confirmation says about time (note #1082). It said "about 3
 * minutes" while a real upgrade took 9 min 12 s, nearly all of it copying the
 * release into the copy's own registry (7:50 on the acceptance pass, 6:38 on
 * a live copy, 8:44 at an install). So: how long the last finished upgrade
 * on this copy took, rounded up to a whole minute; with none, a range that
 * covers the copy step on every run measured so far.
 */
export const UPGRADE_MINUTES_RANGE = { from: 5, to: 15 } as const;
export function lastUpgradeMinutes(run: WorkspaceCopyUpgradeRun | null): number | null {
  if (!run || run.phase !== 'done' || run.drill || !run.startedAt || !run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 60_000)) : null;
}
const hhmmUtc = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export function createCopyUpgrade(options: CopyUpgradeOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const app = upgraderAppName(options.prefix);
  const images = `${options.prefix}-images`;

  const json = async <T>(key: string): Promise<T | null> => {
    const text = await options.bucket!.getText(key);
    if (!text) return null;
    try { return JSON.parse(text) as T; } catch { return null; }
  };
  const readRun = async (id: string, open: boolean): Promise<WorkspaceCopyUpgradeRun | null> => {
    const run = await json<RunRecord>(`upgrades/${id}/run.json`);
    if (!run) return null;
    const events = ((await options.bucket!.getText(`upgrades/${id}/events.jsonl`)) ?? '')
      .split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as StepEvent]; } catch { return []; } });
    const beat = await json<{ at?: string }>(`upgrades/${id}/heartbeat.json`);
    return runView(run, events, beat?.at ?? null, options.prefix, now(), open && !run.outcome);
  };

  /** The open run (whoever started it), else the last one this Workspace started. */
  async function currentRun(): Promise<WorkspaceCopyUpgradeRun | null> {
    if (!options.bucket) return null;
    const current = await json<{ id?: string }>('upgrades/current.json');
    if (current?.id) {
      const run = await readRun(current.id, true);
      if (run) return run;
      // Started, not yet recorded by the upgrader: it is booting.
      const asked = await json<{ id?: string; by?: string; at?: string; version?: string; drill?: string }>('upgrades/last-started.json');
      if (asked?.id === current.id) return startingView(asked);
    }
    const asked = await json<{ id?: string; by?: string; at?: string; version?: string; drill?: string }>('upgrades/last-started.json');
    if (!asked?.id) return null;
    const run = await readRun(asked.id, true);
    if (run) return run;
    // The machine was started moments ago and has not written yet.
    if (asked.at && now().getTime() - new Date(asked.at).getTime() < STALE_HEARTBEAT_MS) return startingView(asked);
    return null;
  }
  const startingView = (asked: { id?: string; by?: string; at?: string; version?: string; drill?: string }): WorkspaceCopyUpgradeRun => ({
    id: asked.id!, requestedBy: asked.by ?? null, from: null, to: asked.version ?? null,
    drill: asked.drill ? (asked.drill === 'backend' ? 'backend' : 'rollback') : null,
    startedAt: asked.at ?? null, finishedAt: null, phase: 'starting', heardSecondsAgo: null, message: null, snapshotAt: null,
    steps: [{ key: 'start', label: 'Starting the upgrader', state: 'now', seconds: null, startedAt: asked.at ?? null, detail: null, back: false }],
  });

  /** Why an upgrade cannot start now, in the words the admin reads; null when it can. */
  /** The Claude sign-ins still open, oldest first, minus finished and expired ones (the flow drops those). */
  const openSignIns = () => options.signInsOpen()
    .filter((open) => now().getTime() - open.startedAt < SIGNIN_MAX_AGE_MS)
    .sort((a, b) => a.startedAt - b.startedAt);

  async function refusal(target: string | null, run: WorkspaceCopyUpgradeRun | null, asker: string | null = null): Promise<string | null> {
    if (!options.bucket) return 'This Agentic Cloud has no backup bucket, so an upgrade has nowhere to keep its record. Your engineer can upgrade with node install.mjs upgrade.';
    if (!options.upgraderReady()) return 'The upgrader is not set up here yet. Your engineer runs node install.mjs upgrade once; after that the button works.';
    if (!options.updatesUrl) return 'Update checks are off here, so there is nothing to upgrade to.';
    if (!target) return 'There is no newer release to upgrade to.';
    if (run && (run.phase === 'running' || run.phase === 'putting-back' || run.phase === 'starting')) return 'An upgrade is already running.';
    if (run && run.phase === 'stopped') return 'An upgrade stopped part-way. Carry it on before starting another.';
    const machines = (await options.fly.listMachines(app).catch(() => []))
      .filter((machine) => machine.state !== 'destroyed')
      .filter((machine) => !(String(machine.name ?? '').startsWith('here-lock')
        && now().getTime() - new Date(String((machine as { created_at?: string }).created_at ?? 0)).getTime() > HERE_LOCK_STALE_MS));
    if (machines.length) return 'An upgrade is already running (started from the command line).';
    for (const [name, words] of [[`${options.prefix}-backend`, 'The Workspace'], [`${options.prefix}-git`, 'The code host'], [`${options.prefix}-router`, 'The router']] as const) {
      const busy = (await options.fly.listMachines(name).catch(() => [])).find((machine) => !['started', 'stopped', 'suspended', 'destroyed'].includes(String(machine.state)));
      if (busy) return `${words} is being changed right now (${busy.state}). Try again in a few minutes.`;
    }
    if (options.dataDir) {
      const s = await statfs(options.dataDir).catch(() => null);
      const db = options.dbPath ? await stat(options.dbPath).then((x) => x.size).catch(() => 0) : 0;
      if (s && s.bavail * s.bsize < 2 * db + DISK_MARGIN_BYTES) return 'The Workspace\'s disk is too full to keep the database\'s backup beside it. Free some space first.';
    }
    const open = openSignIns();
    if (open.length) {
      // Freed when the last of them expires, unless they finish or cancel first.
      const newest = Math.max(...open.map((s) => s.startedAt));
      const minutes = Math.max(1, Math.ceil((SIGNIN_MAX_AGE_MS - (now().getTime() - newest)) / 60_000));
      const others = open.filter((s) => s.userId !== asker).length;
      if (asker && others === 0) {
        return `Your own Claude sign-in is still open, from ${hhmmUtc(open[0]!.startedAt)} UTC. It lives in the Workspace's memory, so an upgrade now would cut it. Cancel it here, or finish it, and the button comes back.`;
      }
      return `${others === 1 ? 'Someone' : `${others} people`} ${others === 1 ? 'is' : 'are'} signing in to Claude, and that sign-in lives in the Workspace's memory: an upgrade now would cut it. Try again in ${minutes} min.`;
    }
    return null;
  }

  async function state(asker: string | null = null): Promise<WorkspaceCopyUpgradeState> {
    const { running, latest, latestDate } = await options.releases();
    const behind = Boolean(running && latest && compareVersions(latest, running) > 0);
    const run = await currentRun().catch((error: unknown) => {
      log(`[copy-upgrade] the run record could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const why = behind ? await refusal(latest, run, asker) : null;
    const open = behind && why && asker && options.cancelSignIn ? openSignIns() : [];
    return {
      running,
      latest,
      behind,
      offer: behind && !why && latest ? {
        version: latest, date: latestDate, agentsWorking: options.agentsWorking(),
        lastMinutes: lastUpgradeMinutes(run), minutes: UPGRADE_MINUTES_RANGE,
      } : null,
      refusal: behind ? why : null,
      // Only the asker's own sign-in, and only when it alone holds the button.
      cancelSignIn: open.length > 0 && open.every((s) => s.userId === asker),
      run,
    };
  }

  /**
   * Start the upgrader. The button's version must be the newest offered; a
   * drill (API only, for the gate's own rehearsal) may also name the running one.
   */
  async function start(input: { version: string; drill?: 'rollback' | 'backend' | null; by: string; userId?: string }) {
    const { running, latest } = await options.releases();
    const allowed = input.drill ? [latest, running] : [latest];
    if (!input.version || !allowed.includes(input.version)) throw new CopyUpgradeRefused(`Release ${input.version || '(none)'} is not the one to upgrade to here${latest ? `: the newest is ${latest}` : ''}.`, 400);
    if (!input.drill && (!running || !latest || compareVersions(latest, running) <= 0)) throw new CopyUpgradeRefused('This Agentic Cloud already runs the newest release.');
    const why = await refusal(input.version, await currentRun().catch(() => null), input.userId ?? null);
    if (why) throw new CopyUpgradeRefused(why);
    const installer = await (options.installer ?? loadInstaller)();
    const source = installer.updatesSource({ url: options.updatesUrl! });
    const release = await source.release(input.version);
    const image = release.images?.upgrader;
    if (!image) throw new CopyUpgradeRefused(`Release ${input.version} cannot be upgraded to from the Workspace: it has no upgrader. Your engineer runs node install.mjs upgrade once.`);
    const workdir = mkdtempSync(path.join(tmpdir(), 'acc-upgrader-'));
    try {
      await installer.copyImage(source, installer.flyRegistry({ app: images, token: options.token }), image.tag, workdir);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    const id = `${now().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
    await options.bucket!.putText('upgrades/last-started.json', JSON.stringify({
      id, by: input.by, at: now().toISOString(), version: input.version, ...(input.drill ? { drill: input.drill } : {}),
    }));
    const machine = await options.fly.createMachine(app, {
      region: options.region,
      image: `registry.fly.io/${images}:${image.tag}`,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
      env: {
        ACC_PREFIX: options.prefix,
        ACC_RUN_ID: id,
        ACC_RELEASE: input.version,
        ACC_DRILL: input.drill ?? '',
        ACC_MX: options.rollMx ? 'roll' : 'keep',
        ACC_REQUESTED_BY: input.by,
        ACC_UPDATES_URL: options.updatesUrl!,
      },
      autoDestroy: true,
      restart: { policy: 'on-failure' },
    });
    log(`[copy-upgrade] ${input.by} started run ${id}: ${running} to ${input.version}${input.drill ? ` (drill ${input.drill})` : ''}, upgrader ${machine.id}`);
    return { id, machine: machine.id };
  }

  /** Carry on a run whose upgrader went quiet: a new upgrader picks the open run up. */
  async function carryOn(by: string) {
    const run = await currentRun();
    if (!run || run.phase !== 'stopped') throw new CopyUpgradeRefused('There is no stopped upgrade to carry on.');
    const tag = `upgrader-${run.to}`;
    const machine = await options.fly.createMachine(app, {
      region: options.region,
      image: `registry.fly.io/${images}:${tag}`,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
      env: { ACC_PREFIX: options.prefix, ACC_RUN_ID: run.id, ACC_RELEASE: run.to ?? '', ACC_MX: options.rollMx ? 'roll' : 'keep', ACC_REQUESTED_BY: by, ACC_UPDATES_URL: options.updatesUrl ?? '' },
      autoDestroy: true,
      restart: { policy: 'on-failure' },
    });
    log(`[copy-upgrade] ${by} carried on run ${run.id} with upgrader ${machine.id}`);
    return { id: run.id, machine: machine.id };
  }

  /** The asker's own open sign-in, forgotten (note #1082); then the state as they now see it. */
  async function cancelSignIn(userId: string) {
    if (!options.cancelSignIn) throw new CopyUpgradeRefused('A sign-in cannot be cancelled from here.');
    await options.cancelSignIn(userId);
    return state(userId);
  }

  return { state, start, carryOn, cancelSignIn };
}

export type CopyUpgrade = ReturnType<typeof createCopyUpgrade>;
