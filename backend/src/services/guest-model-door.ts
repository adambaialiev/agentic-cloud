/**
 * The model door for guests' agents (note #1038): the reason a guest's agent
 * can have a shell and still have nothing worth taking.
 *
 * A guest turn's Claude Code is started with ANTHROPIC_BASE_URL pointed here
 * and, as its "OAuth token", a per-turn key this door made. The door checks
 * the key, the path and the model, and forwards the request to Anthropic
 * with the REAL seat token, which never leaves this backend. A key works
 * only while its turn is open, only for Sonnet and Haiku (Claude Code uses
 * Haiku for small side requests), and only up to a request budget; a shell
 * that prints it gets a key that dies with the turn.
 *
 * Mounted at /api/guest-model with a raw body parser (index.ts), so the
 * request is passed on byte for byte.
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';

export const GUEST_MODEL_DOOR_PATH = '/api/guest-model';
/** Requests one turn may make: 30 tool rounds plus side requests, with room. */
export const GUEST_DOOR_MAX_REQUESTS_PER_TURN = 150;
const UPSTREAM = 'https://api.anthropic.com';
const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
/** Sonnet and Haiku only, by alias or full id; never Opus or anything newer than this door knows. */
const ALLOWED_MODEL = /^(?:claude-)?(?:sonnet|haiku)\b|^claude-(?:3-[57]-)?(?:sonnet|haiku)-|^claude-(?:sonnet|haiku)-\d/i;
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'authorization', 'x-api-key', 'content-length', 'connection', 'via', 'cookie', 'forwarded',
  'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'accept-encoding',
]);
const PASSED_RESPONSE_HEADERS = /^(?:content-type|request-id|retry-after|x-should-retry|anthropic-.*)$/i;

interface DoorTurn {
  agentId: string;
  seatToken: string;
  expiresAt: number;
  requests: number;
}

export interface GuestModelDoorDeps {
  fetch?: typeof fetch;
  upstream?: string;
  now?: () => number;
}

export class GuestModelDoor {
  private readonly turns = new Map<string, DoorTurn>();
  private readonly fetchImpl: typeof fetch;
  private readonly upstream: string;
  private readonly now: () => number;

  constructor(deps: GuestModelDoorDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.upstream = (deps.upstream ?? UPSTREAM).replace(/\/+$/, '');
    this.now = deps.now ?? Date.now;
  }

  /** Opens a turn's key. It works until {@link close} or `ttlMs`, whichever first. */
  open(agentId: string, seatToken: string, ttlMs: number): string {
    this.sweep();
    const key = `acc-guest-${randomBytes(24).toString('base64url')}`;
    this.turns.set(key, { agentId, seatToken, expiresAt: this.now() + ttlMs, requests: 0 });
    return key;
  }

  close(key: string): void {
    this.turns.delete(key);
  }

  /** Every key of one agent, closed (its turn was stopped, or the agent deleted). */
  closeAgent(agentId: string): void {
    for (const [key, turn] of this.turns) if (turn.agentId === agentId) this.turns.delete(key);
  }

  openKeys(): number {
    this.sweep();
    return this.turns.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, turn] of this.turns) if (turn.expiresAt <= now) this.turns.delete(key);
  }

  private keyOf(req: Request): string {
    const auth = String(req.headers.authorization ?? '');
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    return String(req.headers['x-api-key'] ?? '').trim();
  }

  private refuse(res: Response, status: number, message: string): void {
    res.status(status).json({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'permission_error', message } });
  }

  /** The Express handler (POST only, raw body). */
  readonly handle = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') return this.refuse(res, 405, 'POST only.');
    const path = req.path.replace(/\/+$/, '');
    if (!ALLOWED_PATHS.has(path)) return this.refuse(res, 404, 'Not a model route.');
    const key = this.keyOf(req);
    const turn = key ? this.turns.get(key) : undefined;
    if (!turn || turn.expiresAt <= this.now()) {
      if (turn) this.turns.delete(key);
      return this.refuse(res, 401, 'This key is not open.');
    }
    turn.requests += 1;
    if (turn.requests > GUEST_DOOR_MAX_REQUESTS_PER_TURN) return this.refuse(res, 429, 'This turn has made its requests.');
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    let model = '';
    try { model = String((JSON.parse(raw.toString('utf8')) as { model?: unknown }).model ?? ''); } catch { return this.refuse(res, 400, 'Not JSON.'); }
    if (!ALLOWED_MODEL.test(model)) return this.refuse(res, 403, 'Guests think with Sonnet.');

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')) continue;
      if (value === undefined) continue;
      headers.set(lower, Array.isArray(value) ? value.join(', ') : String(value));
    }
    headers.set('authorization', `Bearer ${turn.seatToken}`);
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let upstream: globalThis.Response;
    try {
      upstream = await this.fetchImpl(`${this.upstream}${path}${query}`, { method: 'POST', headers, body: new Uint8Array(raw), signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) return;
      console.warn(`[guest-door] upstream failed for ${turn.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return this.refuse(res, 502, 'The model could not be reached.');
    }
    res.status(upstream.status);
    upstream.headers.forEach((value, name) => { if (PASSED_RESPONSE_HEADERS.test(name)) res.setHeader(name, value); });
    if (!upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  };
}
