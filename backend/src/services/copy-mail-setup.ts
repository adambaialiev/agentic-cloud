/**
 * Email, set up after the install (note #946).
 *
 * A private copy installs with no mail at all: no provider key, no mail
 * receiver, no mail records (Adam, 1 Nov 2026: "email service is not
 * critical"). People's addresses are on the copy's domain from the first
 * account (MAIL_DOMAIN), and the Workspace works without mail. When an admin
 * wants it, this is what they go through, from the Mail section:
 *
 *   1. the sending provider: a Resend key (the domain is registered there and
 *      its records read back) or any provider over standard SMTP (checked by
 *      signing in to it);
 *   2. the mail receiver: an app `<prefix>-mx` in the copy's own Fly
 *      organization, with the dedicated IPv4 mail needs ($2 a month), a 1 GB
 *      disk for its certificate and the `mx` image of the copy's release
 *      (FLY_MX_IMAGE). It is made with the backend's own Fly token, the
 *      organization token the installer gave it to start agents' machines.
 *      A receiver an older installer made is found and taken over as it is;
 *   3. the records: MX, the receiver's A record, DMARC and the provider's
 *      own, each checked on the domain's own name servers (never a public
 *      resolver, which would remember a name asked too early);
 *   4. mail turns on the moment the records are right (and Resend, when it is
 *      the provider, has verified the domain): sign-in links, recovery mail
 *      and people's own mail go out from then on, with no restart.
 *
 * The receiver's certificate comes afterwards, by itself; until it does,
 * mail still arrives, unencrypted, and the screen says so.
 *
 * Nothing here runs on our own platform: it is built only with PRIVATE_COPY.
 * Keys are kept encrypted with the copy's master key, never shown again, and
 * never in a status answer.
 */
import { Resolver, promises as dnsPromises } from 'node:dns';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import type { FlyClient, FlyMachine } from './fly-client.js';
import type { SecretCipher } from './secret-cipher.js';
import type { SmtpSettings } from './smtp-mail.js';
import type {
  WorkspaceCopyMailProviderInput, WorkspaceCopyMailRecord, WorkspaceCopyMailStatus,
} from '../shared/workspace-api.js';

/** The mail provider as the Workspace sends through it, keys in the clear:
 *  only ever handed to the sender that needs it, never answered. */
export type CopyMailSending =
  | { kind: 'resend'; apiKey: string }
  | { kind: 'smtp'; settings: SmtpSettings };

interface StoredProvider {
  kind: 'resend' | 'smtp';
  /** Resend: the key, encrypted. */
  key?: string;
  domainId?: string;
  records?: WorkspaceCopyMailRecord[];
  /** SMTP. The password is encrypted. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  savedAt: string;
}

interface StoredReceiver {
  app: string;
  ipv4: string;
  machineId?: string;
  /** Made by an installer before note #946, and taken over as it was. */
  adopted?: boolean;
  madeAt: string;
}

export interface CopyMailSetupDoc {
  provider?: StoredProvider;
  receiver?: StoredReceiver;
  turnedOnAt?: string;
  lastCheck?: { at: string; ok: Record<string, boolean>; certificate: boolean | null; providerVerified: boolean | null };
  /** When the receiver's name first answered right, and the restarts it took
   *  to make it ask Let's Encrypt again: at most four, inside Let's Encrypt's
   *  five failures an hour. */
  mxNamedAt?: string;
  restarts?: { count: number; lastAt: string };
}

export interface CopyMailSetupStore {
  get(): CopyMailSetupDoc;
  put(doc: CopyMailSetupDoc): void;
}

export class SqliteCopyMailSetupStore implements CopyMailSetupStore {
  constructor(private readonly db: SqliteDb) {}
  get(): CopyMailSetupDoc {
    const row = this.db.prepare('SELECT doc FROM copy_mail_setup WHERE key = ?').get('setup') as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as CopyMailSetupDoc : {};
  }
  put(doc: CopyMailSetupDoc): void {
    this.db.prepare('INSERT INTO copy_mail_setup (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc')
      .run('setup', JSON.stringify(doc));
  }
}

export class InMemoryCopyMailSetupStore implements CopyMailSetupStore {
  private doc: CopyMailSetupDoc = {};
  get(): CopyMailSetupDoc { return structuredClone(this.doc); }
  put(doc: CopyMailSetupDoc): void { this.doc = structuredClone(doc); }
}

/** A refusal in words an admin can act on: a 400 or 409, never a 500. */
export class CopyMailSetupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'CopyMailSetupError';
  }
}

/** The receiver's machine, disk and address, as the installer priced them. */
export const MAIL_MONTHLY_USD = 4.09;
const RECEIVER_GUEST = { cpu_kind: 'shared', cpus: 1, memory_mb: 256 };
const RECEIVER_DISK_GB = 1;
const SETTLE_MS = 60_000;
const RESTART_GAP_MS = 5 * 60_000;
const MAX_RESTARTS = 4;

// ── DNS, asked of the domain's own name servers ──

export interface RecordResolver {
  resolve4(name: string, done: (error: Error | null, answer: string[]) => void): void;
  resolveCname(name: string, done: (error: Error | null, answer: string[]) => void): void;
  resolveMx(name: string, done: (error: Error | null, answer: Array<{ priority: number; exchange: string }>) => void): void;
  resolveTxt(name: string, done: (error: Error | null, answer: string[][]) => void): void;
}

/** The domain's own name servers: a public resolver remembers a name asked
 *  before it exists as missing for up to an hour. */
export async function authoritativeResolver(domain: string): Promise<RecordResolver> {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const zone = labels.slice(i).join('.');
    let servers: string[] = [];
    try { servers = await dnsPromises.resolveNs(zone); } catch { continue; }
    const addresses: string[] = [];
    for (const server of servers) {
      try { addresses.push(...await dnsPromises.resolve4(server)); } catch { /* the next one */ }
    }
    if (!addresses.length) continue;
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(addresses);
    return resolver as unknown as RecordResolver;
  }
  throw new Error(`Could not find the name servers for ${domain}.`);
}

const bareHost = (value: unknown) => String(value ?? '').trim().replace(/\.$/, '').toLowerCase();

/** Whether one record answers as it should. */
export async function recordAnswers(resolver: RecordResolver, record: WorkspaceCopyMailRecord): Promise<boolean> {
  const ask = <T>(fn: keyof RecordResolver, name: string) => new Promise<T[]>((resolve) => {
    (resolver[fn] as (n: string, d: (e: Error | null, a: T[]) => void) => void)(name, (error, answer) => resolve(error ? [] : answer));
  });
  if (record.type === 'A') return (await ask<string>('resolve4', record.name)).includes(record.value);
  if (record.type === 'CNAME') return (await ask<string>('resolveCname', record.name)).map(bareHost).includes(bareHost(record.value));
  if (record.type === 'MX') {
    return (await ask<{ priority: number; exchange: string }>('resolveMx', record.name))
      .some((mx) => mx.priority === record.priority && bareHost(mx.exchange) === bareHost(record.value));
  }
  if (record.type === 'TXT') {
    const answers = (await ask<string[]>('resolveTxt', record.name)).map((chunks) => chunks.join(''));
    // Any DMARC policy the domain's owner prefers will do; ours is a suggestion.
    return record.name.startsWith('_dmarc.') ? answers.some((answer) => answer.startsWith('v=DMARC1')) : answers.includes(record.value);
  }
  return false;
}

// ── The sending provider ──

export interface ResendDomains {
  register(domain: string): Promise<{ id: string; records: WorkspaceCopyMailRecord[] }>;
  /** Asks Resend to check again when it is not verified yet. */
  verified(id: string): Promise<boolean>;
}

/** Resend's domain API with one key: the domain registered (or found), its
 *  records read back whole, and whether it has verified them. */
export function resendDomains(apiKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.resend.com'): ResendDomains {
  const call = async (method: string, pathname: string, body?: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed = await answer.json().catch(() => ({})) as Record<string, unknown>;
    if (answer.status === 401 || answer.status === 403) {
      throw new CopyMailSetupError(`Resend did not accept this key for managing domains (${String(parsed.message ?? answer.status)}). Use a key with full access: a sending-only key cannot register the domain.`);
    }
    if (!answer.ok) throw new CopyMailSetupError(`Resend answered ${answer.status}${parsed.message ? `: ${String(parsed.message)}` : ''}.`, 502);
    return parsed;
  };
  const records = (domain: string, list: unknown): WorkspaceCopyMailRecord[] => (Array.isArray(list) ? list : []).map((raw) => {
    const record = raw as { name?: string; type?: string; value?: string; priority?: number; record?: string };
    const name = record.name && !record.name.endsWith(domain) ? `${record.name}.${domain}` : (record.name || domain);
    return {
      name,
      type: String(record.type ?? 'TXT').toUpperCase() as WorkspaceCopyMailRecord['type'],
      value: String(record.value ?? ''),
      ...(typeof record.priority === 'number' ? { priority: record.priority } : {}),
      why: `mail out through Resend (${record.record ?? 'sending'})`,
    };
  });
  return {
    async register(domain) {
      const listed = await call('GET', '/domains');
      const existing = (Array.isArray(listed.data) ? listed.data : []).find((entry: { name?: string }) => entry.name === domain) as { id?: string } | undefined;
      const made = existing?.id ? await call('GET', `/domains/${existing.id}`) : await call('POST', '/domains', { name: domain });
      const id = String(made.id ?? existing?.id ?? '');
      const list = made.records ?? (await call('GET', `/domains/${id}`)).records;
      return { id, records: records(domain, list) };
    },
    async verified(id) {
      const found = await call('GET', `/domains/${id}`);
      if (found.status === 'verified') return true;
      await call('POST', `/domains/${id}/verify`).catch(() => {});
      return false;
    },
  };
}

// ── The service ──

export interface CopyMailSetupOptions {
  store: CopyMailSetupStore;
  cipher: SecretCipher | null;
  /** MAIL_DOMAIN: the domain people's addresses are on. */
  domain: string;
  /** The copy's Fly organization and region, and its app prefix. */
  org: string;
  region: string;
  prefix: string | null;
  /** FLY_MX_IMAGE: the receiver's image, from the copy's own registry. */
  mxImage: string | null;
  /** The secret the receiver presents on every message it hands in. */
  ingestSecret: string | null;
  /** Where the receiver reaches the backend inside the organization. */
  backendUrl: string;
  fly: FlyClient | null;
  /** Mail set up by an installer before note #946 (keys in the backend's
   *  environment): on from the start, and said so. */
  fromInstall: CopyMailSending | null;
  /** Called whenever what mail goes out through changes: the Workspace
   *  rebuilds its senders from it, with no restart. */
  onSendingChanged: (sending: CopyMailSending | null) => void;
  resend?: (apiKey: string) => ResendDomains;
  verifySmtp?: (settings: SmtpSettings) => Promise<void>;
  resolver?: (domain: string) => Promise<RecordResolver>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export class CopyMailSetup {
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<WorkspaceCopyMailStatus> | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly options: CopyMailSetupOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.log(`[copy-mail] ${line}`));
  }

  /** What mail goes out through right now, or null while it is off. */
  sending(): CopyMailSending | null {
    if (this.options.fromInstall) return this.options.fromInstall;
    const doc = this.options.store.get();
    if (!doc.turnedOnAt || !doc.provider) return null;
    return this.decrypted(doc.provider);
  }

  /** Whether email is on in this copy: the Mail section, the CLI and every
   *  notice that goes by mail read this one answer. */
  isOn(): boolean {
    return Boolean(this.options.fromInstall) || Boolean(this.options.store.get().turnedOnAt);
  }

  /** Where it stands, in a word, for every member (state read). */
  phase(): WorkspaceCopyMailStatus['state'] {
    if (this.isOn()) return 'on';
    const doc = this.options.store.get();
    if (doc.receiver) return 'records';
    if (doc.provider) return 'provider';
    return 'off';
  }

  /** The receiver's health address, once there is one. */
  receiverHealthUrl(): string | null {
    const doc = this.options.store.get();
    const app = doc.receiver?.app ?? (this.options.fromInstall && this.options.prefix ? `${this.options.prefix}-mx` : null);
    return app ? `http://${app}.internal:8080/health` : null;
  }

  /** What an admin's setup screen shows. No key is ever in it. */
  status(): WorkspaceCopyMailStatus {
    const doc = this.options.store.get();
    const records = this.records(doc).map((record) => ({
      ...record,
      ok: record.checked === false ? null : (doc.lastCheck?.ok[recordKey(record)] ?? false),
    }));
    const provider = this.options.fromInstall
      ? { kind: this.options.fromInstall.kind, line: this.options.fromInstall.kind === 'resend' ? 'Resend, set up by the installer' : `${this.options.fromInstall.settings.host}, set up by the installer` }
      : doc.provider ? { kind: doc.provider.kind, line: providerLine(doc.provider) } : undefined;
    const blocker = this.blocker();
    return {
      state: this.phase(),
      domain: this.options.domain,
      ...(this.options.fromInstall ? { fromInstall: true } : {}),
      ...(provider ? { provider } : {}),
      ...(doc.receiver ? { receiver: { app: doc.receiver.app, ipv4: doc.receiver.ipv4, ...(doc.receiver.adopted ? { adopted: true } : {}) } } : {}),
      records: records.map(({ checked: _checked, ...record }) => record),
      ...(doc.provider?.kind === 'smtp' ? { providerRecordsNote: `Also add the SPF and DKIM records ${doc.provider.host} gives you for ${this.options.domain}. Only that provider knows them, so they are not checked here; without them mail out lands in spam.` } : {}),
      certificate: doc.lastCheck?.certificate === true ? 'issued' : doc.lastCheck ? 'pending' : 'unknown',
      ...(doc.provider?.kind === 'resend' ? { providerVerified: doc.lastCheck?.providerVerified ?? null } : {}),
      ...(doc.lastCheck ? { checkedAt: doc.lastCheck.at } : {}),
      ...(doc.turnedOnAt ? { turnedOnAt: doc.turnedOnAt } : {}),
      monthlyUsd: MAIL_MONTHLY_USD,
      ...(blocker ? { unavailable: blocker } : {}),
    };
  }

  /** Why the receiver cannot be made here, if it cannot. */
  private blocker(): string | null {
    if (this.options.fromInstall) return null;
    if (!this.options.cipher) return 'This Workspace has no master key (SECRETS_MASTER_KEY), so it cannot keep the provider\'s key.';
    if (!this.options.fly || !this.options.org) return 'This Workspace has no Fly token for its organization, so it cannot make the mail receiver.';
    if (!this.options.prefix) return 'This Workspace does not know its app prefix (FLY_APP_NAME), so it cannot name the mail receiver.';
    if (!this.options.ingestSecret) return 'This Workspace has no MAIL_INGEST_SECRET, so a mail receiver could not hand it mail.';
    if (!this.options.mxImage && !this.options.store.get().receiver) {
      return 'This Workspace does not know which image its mail receiver runs (FLY_MX_IMAGE). Upgrade it with the installer first: the upgrade sets it.';
    }
    return null;
  }

  /** Step 1: the provider. Checked before it is kept, so a wrong key is a
   *  sentence on the form rather than mail that silently never leaves. */
  async setProvider(input: WorkspaceCopyMailProviderInput): Promise<WorkspaceCopyMailStatus> {
    if (this.options.fromInstall) throw new CopyMailSetupError('Mail here was set up by the installer, from its settings. Change it there.', 409);
    const blocker = this.blocker();
    if (blocker) throw new CopyMailSetupError(blocker, 409);
    const cipher = this.options.cipher!;
    const savedAt = this.now().toISOString();
    let provider: StoredProvider;
    if (input?.kind === 'resend') {
      const apiKey = String(input.apiKey ?? '').trim();
      if (!/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new CopyMailSetupError('That does not look like a Resend key (they start with re_).');
      const { id, records } = await (this.options.resend ?? ((key: string) => resendDomains(key, this.options.fetchImpl)))(apiKey).register(this.options.domain);
      provider = { kind: 'resend', key: cipher.encrypt(apiKey), domainId: id, records, savedAt };
    } else if (input?.kind === 'smtp') {
      const host = String(input.host ?? '').trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) throw new CopyMailSetupError('The SMTP host is a name like smtp.postmarkapp.com.');
      const port = Number(input.port ?? 587);
      if (port !== 465 && port !== 587 && port !== 2525) throw new CopyMailSetupError('The SMTP port is 587 or 465 (2525 where the provider offers it).');
      const user = String(input.user ?? '').trim();
      const password = String(input.password ?? '');
      if (user && !password) throw new CopyMailSetupError('A user needs its password.');
      const settings: SmtpSettings = { host, port, ...(user ? { user, password } : {}) };
      try {
        await (this.options.verifySmtp ?? defaultVerifySmtp)(settings);
      } catch (error) {
        throw new CopyMailSetupError(`Could not sign in to ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
      }
      provider = { kind: 'smtp', host, port, ...(user ? { user, password: cipher.encrypt(password) } : {}), savedAt };
    } else {
      throw new CopyMailSetupError('Choose Resend or SMTP.');
    }
    const doc = this.options.store.get();
    doc.provider = provider;
    // The provider's own records are checked afresh.
    delete doc.lastCheck;
    this.options.store.put(doc);
    this.log(`provider set: ${provider.kind}${provider.host ? ` ${provider.host}:${provider.port}` : ''}`);
    // Mail already on goes out through the new provider at once.
    if (doc.turnedOnAt) this.options.onSendingChanged(this.sending());
    return this.status();
  }

  /** Step 2: the mail receiver, in the copy's own organization. Safe to ask
   *  again: whatever is already there is kept. */
  async createReceiver(): Promise<WorkspaceCopyMailStatus> {
    if (this.options.fromInstall) throw new CopyMailSetupError('Mail here was set up by the installer, receiver and all.', 409);
    const blocker = this.blocker();
    if (blocker) throw new CopyMailSetupError(blocker, 409);
    const doc = this.options.store.get();
    if (!doc.provider) throw new CopyMailSetupError('Set the mail provider first.', 409);
    const fly = this.options.fly!;
    const app = `${this.options.prefix}-mx`;
    const apps = (await fly.listApps(this.options.org)).map((entry) => entry.name);
    const existed = apps.includes(app);
    if (!existed) {
      try {
        await fly.createApp({ appName: app, orgSlug: this.options.org });
      } catch (error) {
        throw new CopyMailSetupError(`Fly would not create the app ${app}: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
    }
    const ipv4 = await fly.ensureDedicatedIpv4(app);
    if (!ipv4) throw new CopyMailSetupError('Fly did not give the mail receiver its address yet. Try again in a minute.', 502);
    const machines = (await fly.listMachines(app)).filter((machine) => machine.state !== 'destroyed');
    let machine: FlyMachine | undefined = machines[0];
    if (!machine) {
      if (!this.options.mxImage) throw new CopyMailSetupError('This Workspace does not know which image its mail receiver runs (FLY_MX_IMAGE).', 409);
      const volumes = await fly.listVolumes(app);
      const volume = volumes.find((entry) => entry.name === 'mx_data' && !entry.attached_machine_id)
        ?? await fly.createVolume(app, { name: 'mx_data', region: this.options.region, sizeGb: RECEIVER_DISK_GB });
      machine = await fly.createMachine(app, {
        name: 'mail-receiver',
        region: this.options.region,
        image: this.options.mxImage,
        guest: RECEIVER_GUEST,
        env: this.receiverEnv(),
        mounts: [{ volume: volume.id, path: '/data' }],
        restart: { policy: 'always' },
        services: [
          {
            protocol: 'tcp',
            internal_port: 2525,
            // Fly's proxy tells the receiver who is really sending (SPF needs it).
            ports: [{ port: 25, handlers: ['proxy_proto'], proxy_proto_options: { version: 'v1' } }],
            autostart: true,
            autostop: 'off',
          },
          {
            // Port 80 on its own address: Let's Encrypt's HTTP-01 check.
            protocol: 'tcp',
            internal_port: 8080,
            ports: [{ port: 80, handlers: ['http'] }],
            autostart: true,
            autostop: 'off',
          },
        ],
      });
    }
    doc.receiver = {
      app, ipv4, machineId: machine.id, madeAt: this.now().toISOString(),
      // An older installer's receiver, found running: taken over as it is.
      ...(existed && machines.length ? { adopted: true } : {}),
    };
    this.options.store.put(doc);
    this.log(`receiver ${existed && machines.length ? 'taken over' : 'made'}: ${app} at ${ipv4}`);
    this.start();
    return this.status();
  }

  /** Step 3, and every minute while it waits: the records on the domain's own
   *  name servers, the receiver's certificate, Resend's verdict. Turns mail
   *  on the moment it can. One check at a time. */
  async check(): Promise<WorkspaceCopyMailStatus> {
    if (!this.checking) {
      this.checking = this.runCheck().finally(() => { this.checking = null; });
    }
    return this.checking;
  }

  private async runCheck(): Promise<WorkspaceCopyMailStatus> {
    const doc = this.options.store.get();
    if (!doc.receiver && !this.options.fromInstall) return this.status();
    const records = this.records(doc).filter((record) => record.checked !== false);
    const ok: Record<string, boolean> = {};
    try {
      const resolver = await (this.options.resolver ?? authoritativeResolver)(this.options.domain);
      for (const record of records) ok[recordKey(record)] = await recordAnswers(resolver, record).catch(() => false);
    } catch (error) {
      this.log(`records not checked: ${error instanceof Error ? error.message : String(error)}`);
      for (const record of records) ok[recordKey(record)] = false;
    }
    let certificate: boolean | null = null;
    const healthUrl = this.receiverHealthUrl();
    if (healthUrl) {
      try {
        const answer = await (this.options.fetchImpl ?? fetch)(healthUrl, { signal: AbortSignal.timeout(5000) });
        certificate = Boolean(((await answer.json()) as { starttls?: boolean }).starttls);
      } catch {
        certificate = false;
      }
    }
    const allRight = records.every((record) => ok[recordKey(record)]);
    let providerVerified: boolean | null = null;
    if (doc.provider?.kind === 'resend' && doc.provider.domainId) {
      providerVerified = allRight
        ? await (this.options.resend ?? ((key: string) => resendDomains(key, this.options.fetchImpl)))(this.options.cipher!.decrypt(doc.provider.key!))
          .verified(doc.provider.domainId).catch(() => false)
        : false;
    }
    // The receiver asks Let's Encrypt when it starts and twice a day; once its
    // name answers, a restart makes it ask now. Not the second the name
    // appears (the installer's proof: Let's Encrypt still saw the old answer),
    // and at most four times.
    const nameKey = doc.receiver ? recordKey({ name: `mx.${this.options.domain}`, type: 'A', value: doc.receiver.ipv4 }) : '';
    if (nameKey && ok[nameKey]) doc.mxNamedAt = doc.mxNamedAt ?? this.now().toISOString();
    else delete doc.mxNamedAt;
    const restarts = doc.restarts ?? { count: 0, lastAt: new Date(0).toISOString() };
    const nowMs = this.now().getTime();
    if (doc.receiver?.machineId && this.options.fly && certificate === false && doc.mxNamedAt
      && nowMs - new Date(doc.mxNamedAt).getTime() >= SETTLE_MS
      && restarts.count < MAX_RESTARTS && nowMs - new Date(restarts.lastAt).getTime() > RESTART_GAP_MS) {
      await this.options.fly.restartMachine(doc.receiver.app, doc.receiver.machineId)
        .then(() => {
          doc.restarts = { count: restarts.count + 1, lastAt: this.now().toISOString() };
          this.log(`receiver restarted to ask Let's Encrypt again (${restarts.count + 1} of ${MAX_RESTARTS})`);
        })
        .catch((error) => this.log(`receiver restart failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    doc.lastCheck = { at: this.now().toISOString(), ok, certificate, providerVerified };
    const turnOn = !this.options.fromInstall && !doc.turnedOnAt && doc.provider && allRight && (doc.provider.kind !== 'resend' || providerVerified === true);
    if (turnOn) {
      doc.turnedOnAt = this.now().toISOString();
      this.log(`mail on for ${this.options.domain}`);
    }
    this.options.store.put(doc);
    if (turnOn) this.options.onSendingChanged(this.sending());
    if (this.done(doc)) this.stop();
    return this.status();
  }

  /** Nothing left to wait for: on, every record right, certificate in. */
  private done(doc: CopyMailSetupDoc): boolean {
    if (!doc.turnedOnAt || !doc.lastCheck) return false;
    return doc.lastCheck.certificate === true && Object.values(doc.lastCheck.ok).every(Boolean);
  }

  /** At boot: senders from what was kept, and the wait carried on. */
  boot(): void {
    if (this.options.fromInstall) return;
    const doc = this.options.store.get();
    if (doc.turnedOnAt) this.options.onSendingChanged(this.sending());
    if (doc.receiver && !this.done(doc)) this.start();
    void this.keepReceiverOnRelease(doc).catch((error) => this.log(`receiver image not checked: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A receiver the Workspace made runs the copy's own release: an upgrade
   *  gives the backend a new FLY_MX_IMAGE, and the receiver follows it here.
   *  The installer rolls only a receiver it made itself. */
  private async keepReceiverOnRelease(doc: CopyMailSetupDoc): Promise<void> {
    const receiver = doc.receiver;
    const fly = this.options.fly;
    if (!receiver?.machineId || receiver.adopted || !fly || !this.options.mxImage) return;
    const machine = await fly.getMachine(receiver.app, receiver.machineId);
    const config = machine.config ?? {};
    const env = { ...(config.env ?? {}), ...this.receiverEnv() };
    if (config.image === this.options.mxImage && JSON.stringify(config.env ?? {}) === JSON.stringify(env)) return;
    await fly.updateMachine(receiver.app, receiver.machineId, { ...config, image: this.options.mxImage, env });
    this.log(`receiver moved to ${this.options.mxImage}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.check().catch(() => {}); }, 60_000);
    this.timer.unref?.();
    void this.check().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private receiverEnv(): Record<string, string> {
    return {
      MAIL_DOMAIN: this.options.domain,
      MX_HOSTNAME: `mx.${this.options.domain}`,
      BACKEND_URL: this.options.backendUrl,
      MAIL_INGEST_SECRET: this.options.ingestSecret ?? '',
      PORT: '2525',
      CERT_DIR: '/data/tls',
      HTTP_PORT: '8080',
    };
  }

  /** Every record mail needs here. `checked: false` marks a reminder the
   *  Workspace cannot check (an SMTP provider's own). */
  private records(doc: CopyMailSetupDoc): Array<WorkspaceCopyMailRecord & { checked?: boolean }> {
    const domain = this.options.domain;
    const ipv4 = doc.receiver?.ipv4;
    if (!ipv4) return [];
    return [
      { name: domain, type: 'MX', value: `mx.${domain}`, priority: 10, why: 'mail in' },
      { name: `mx.${domain}`, type: 'A', value: ipv4, why: 'the mail receiver' },
      { name: `_dmarc.${domain}`, type: 'TXT', value: 'v=DMARC1; p=quarantine', why: 'mail that is not yours goes to spam' },
      ...(doc.provider?.kind === 'resend' ? doc.provider.records ?? [] : []),
    ];
  }

  private decrypted(provider: StoredProvider): CopyMailSending {
    const cipher = this.options.cipher!;
    if (provider.kind === 'resend') return { kind: 'resend', apiKey: cipher.decrypt(provider.key!) };
    return {
      kind: 'smtp',
      settings: {
        host: provider.host!, port: provider.port ?? 587,
        ...(provider.user ? { user: provider.user, password: provider.password ? cipher.decrypt(provider.password) : '' } : {}),
      },
    };
  }
}

const recordKey = (record: Pick<WorkspaceCopyMailRecord, 'name' | 'type' | 'value'>) => `${record.type} ${record.name} ${record.value}`;

function providerLine(provider: StoredProvider): string {
  if (provider.kind === 'resend') return 'Resend';
  return `${provider.host}:${provider.port}${provider.user ? ` as ${provider.user}` : ''}`;
}

async function defaultVerifySmtp(settings: SmtpSettings): Promise<void> {
  const nodemailer = (await import('nodemailer')).default;
  const implicitTls = settings.port === 465;
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
