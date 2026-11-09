import type { Request, Response } from 'express';
import { parseCopyPulse } from '../shared/copy-pulse.js';
import { COPY_PULSE_KEY_HEADER, COPY_PULSE_SIGNATURE_HEADER, verifyPulseBody } from '../shared/copy-pulse-signing.js';
import type { CopyPulseStore } from '../services/copy-pulse-storage.js';
import type { CopyPulseKeyStore } from '../services/copy-pulse-keys.js';

/**
 * POST /api/copy-pulse — where private copies' daily pulses arrive (note #1057).
 *
 * No sign-in: a copy has no account with us. What a pulse has instead is a
 * signature: Ed25519 over the exact body bytes, by the key the copy made at
 * install, whose public half rides along (copy-pulse-signing.ts). In order:
 *   1. unsigned, or a signature that does not check against the key it came
 *      with → 401, nothing kept;
 *   2. not a pulse of the agreed shape (parseCopyPulse) → 400, nothing kept;
 *   3. a copyId we already know, under a different key → 401, nothing kept
 *      (the first key a copyId arrives with is the one it keeps);
 *   4. otherwise the pulse is stored as the copy's latest and its day's row
 *      (Ada's copy_pulses / copy_pulse_days), and the alert sweep is nudged.
 *
 * The body must reach this handler RAW (index.ts mounts express.raw on this
 * path before express.json): a signature is over bytes, and a re-serialised
 * object is not the same bytes.
 */
export interface CopyPulseRouteDeps {
  store: CopyPulseStore;
  keys: CopyPulseKeyStore;
  now?: () => Date;
  /** Told after a pulse is kept (the Copies alert sweep). */
  onPulse?: (pulse: import('../shared/copy-pulse.js').CopyPulse) => void;
}

export function copyPulseHandler(deps: CopyPulseRouteDeps) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return res.status(400).json({ error: 'A pulse is a signed JSON body.' });
    const publicKey = req.get(COPY_PULSE_KEY_HEADER)?.trim();
    const signature = req.get(COPY_PULSE_SIGNATURE_HEADER)?.trim();
    if (!verifyPulseBody(body, publicKey, signature)) {
      return res.status(401).json({ error: 'The pulse is not signed, or the signature does not match its key.' });
    }
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'A pulse is a JSON object.' });
    }
    const parsed = parseCopyPulse(json);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const receivedAt = (deps.now?.() ?? new Date()).toISOString();
    try {
      const kept = await deps.keys.register(parsed.pulse.copyId, publicKey!, receivedAt);
      if (kept !== publicKey) {
        console.warn(`[copy-pulse] ${parsed.pulse.copyId}: refused, signed by a key other than the one it first came with`);
        return res.status(401).json({ error: 'This copy id belongs to another key.' });
      }
      await deps.store.record(parsed.pulse, receivedAt);
    } catch (error) {
      console.warn('[copy-pulse] could not keep a pulse:', error);
      return res.status(503).json({ error: 'The pulse could not be kept. The copy tries again later.' });
    }
    deps.onPulse?.(parsed.pulse);
    return res.json({ ok: true, receivedAt });
  };
}
