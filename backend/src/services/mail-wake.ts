/**
 * A letter arrives, and the agent its owner chose hears about it
 * (note #509, slice 11).
 *
 * Note #532 gave a finished managed job the power to start a turn, and the
 * shape of it is reused here for the other event nobody was ever told about.
 * The two differ in one structural way, and every decision below falls out of
 * it: a job receipt is DURABLE ON THE MACHINE and is redelivered until a
 * backend takes it, because nothing else would ever announce it. A letter is
 * already in the inbox, stored, indexed and readable with `agentbuilt mail
 * list` from any turn. So THE WAKE IS A NUDGE, NOT THE LETTER — everything
 * here may be held in memory and dropped by a restart without anything being
 * lost but promptness, and none of it is allowed to slow or fail a delivery.
 *
 * Three rules the request this implements named, and the reasoning for each:
 *
 * COALESCE. A burst of fifty letters is one wake, not fifty. The 3-second
 * window collapses a burst, and — the half a window alone cannot do — an
 * agent that is MID-TURN holds everything until its turn ends, so a long turn
 * with letters trickling into it ends with one block rather than forty. That
 * is the machine-side fan-out collapse of note #532, moved to the only side
 * that can see this event.
 *
 * CEILING. At most `MAIL_WAKES_PER_HOUR` wakes per address per hour. Beyond
 * it the letters keep arriving, keep accumulating, and are listed in the next
 * wake the window allows. Somebody who learns the address must not be able to
 * spend the owner's plan by writing to them.
 *
 * NOTHING FORGED STARTS A TURN. A letter `looksSuspicious` marked — which is
 * mostly a forgery of our own domain, the one shape measured to arrive
 * unmarked by DMARC (see the design page) — never arms a wake. It is counted,
 * and the count rides the next wake a real letter earns. Naming its sender
 * and subject would hand the forger the attention it wrote the forgery for.
 */

import type { MailArrival, MailWakeBlock } from '../types/mail-arrival.js';
import { MAIL_ARRIVALS_HELD_MAX, MAIL_ARRIVALS_LISTED_MAX } from '../types/mail-arrival.js';
import type { MailboxDocument } from './mailbox-storage.js';

/** A burst collapses inside this; the same three seconds the machine's own
 *  job fan-out waits before sending one wake for all of them. */
export const MAIL_WAKE_COALESCE_MS = 3_000;
/** How often a held batch asks again whether the turn it is waiting on has
 *  ended. Cheap: one timer, and only while something is actually waiting. */
export const MAIL_WAKE_BUSY_RECHECK_MS = 5_000;
/** The ceiling, per address. */
export const MAIL_WAKES_PER_HOUR = 12;
export const MAIL_WAKE_WINDOW_MS = 60 * 60_000;
/**
 * Tries at handing one batch over before it is let go. A `failed` answer is
 * almost always a runner shutting down for a deploy, which is over in
 * seconds; past that the letters are still in the inbox, which is the whole
 * reason this is allowed to give up at all.
 */
export const MAIL_WAKE_DELIVERY_ATTEMPTS = 3;

export type MailWakeOutcome =
  /** The turn was started, or the block was queued into a running one. */
  | 'delivered'
  /** The chosen agent is gone, or was never this owner's to choose. */
  | 'no-agent'
  /** It exists but has no machine to resume into. */
  | 'no-machine'
  /** Transient — a runner shutting down. Worth one more try. */
  | 'failed';

export interface MailWakeDeps {
  mailboxes: {
    getByAddress(address: string): Promise<MailboxDocument | null>;
    setWakeAgent(userId: string, agentId: string | null): Promise<unknown>;
  };
  /** Hand one block to that agent's session. Never throws for the caller. */
  wake(args: { userId: string; agentId: string; block: MailWakeBlock }): Promise<MailWakeOutcome>;
  /** Is that agent mid-turn right now? */
  isWorking(userId: string, agentId: string): boolean;
  now?: () => number;
  /** Test seam. Real timers are unref'd so nothing here holds the process. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiting {
  /** Oldest first, as they arrived. The block reverses them. */
  arrivals: MailArrival[];
  /** Letters pushed out of the buffer by its ceiling. Still counted. */
  overflow: number;
  suspicious: number;
  /** Tries spent on the batch currently being handed over. */
  attempts: number;
  timer?: unknown;
  /** When the armed timer fires, so a shorter deadline can replace it. */
  dueAt?: number;
  /**
   * The ceiling is spent until this moment, so nothing may be scheduled
   * before it. Without this, every letter of a flood would bring the
   * deadline forward to the coalescing window, wake nobody, and re-arm —
   * a mailbox read every three seconds for as long as the flood lasted.
   */
  heldUntil?: number;
  /** A flush is running; nothing may arm a second one underneath it. */
  busy?: boolean;
}

export class MailWakeService {
  private readonly waiting = new Map<string, Waiting>();
  /** When each address last woke somebody, for the ceiling. Newest last. */
  private readonly wakes = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: MailWakeDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // A pending wake must never be the reason this process stays up.
      handle.unref?.();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /**
   * A letter was stored. SYNCHRONOUS AND SILENT on purpose: this is called
   * from inside the SMTP transaction Cloudflare's Email Worker holds open, so
   * it may not wait for a database read, and a fault in it may not turn into
   * a bounce for a sender who did nothing wrong. Everything real happens on
   * the timer this arms.
   */
  noteArrival(arrival: MailArrival, opts: { suspicious?: boolean } = {}): void {
    try {
      const address = String(arrival.address || '').trim().toLowerCase();
      if (!address || !arrival.id) return;
      const waiting = this.waiting.get(address) ?? { arrivals: [], overflow: 0, suspicious: 0, attempts: 0 };
      this.waiting.set(address, waiting);
      if (opts.suspicious) {
        waiting.suspicious += 1;
        // Nothing forged arms a wake. The entry is still given a deadline so
        // an address that only ever receives forgeries does not hold a row
        // here forever; flushing an entry with no real letter in it simply
        // forgets the count.
        this.arm(address, MAIL_WAKE_WINDOW_MS);
        return;
      }
      waiting.arrivals.push({ ...arrival, address });
      // The newest are the ones worth naming, so the buffer drops from the
      // front and says how many it dropped.
      while (waiting.arrivals.length > MAIL_ARRIVALS_HELD_MAX) {
        waiting.arrivals.shift();
        waiting.overflow += 1;
      }
      this.arm(address, MAIL_WAKE_COALESCE_MS);
    } catch {
      // A wake is a nudge. Nothing about one is worth failing a delivery for.
    }
  }

  /** What is waiting for an address, for tests and for a shutdown check. */
  pending(address: string): { arrivals: number; suspicious: number } | null {
    const waiting = this.waiting.get(address.trim().toLowerCase());
    return waiting ? { arrivals: waiting.arrivals.length, suspicious: waiting.suspicious } : null;
  }

  /** Arm (or bring forward) this address's deadline. Never pushes one back. */
  private arm(address: string, delayMs: number): void {
    const waiting = this.waiting.get(address);
    if (!waiting || waiting.busy) return;
    const dueAt = Math.max(this.now() + Math.max(0, delayMs), waiting.heldUntil ?? 0);
    if (waiting.timer !== undefined) {
      if (waiting.dueAt !== undefined && waiting.dueAt <= dueAt) return;
      this.clearTimer(waiting.timer);
    }
    waiting.dueAt = dueAt;
    waiting.timer = this.setTimer(() => { void this.flush(address); }, Math.max(0, dueAt - this.now()));
  }

  /** The wakes this address has spent inside the window, oldest first. */
  private recentWakes(address: string): number[] {
    const since = this.now() - MAIL_WAKE_WINDOW_MS;
    const kept = (this.wakes.get(address) ?? []).filter((at) => at > since);
    if (kept.length) this.wakes.set(address, kept); else this.wakes.delete(address);
    return kept;
  }

  private async flush(address: string): Promise<void> {
    const waiting = this.waiting.get(address);
    if (!waiting || waiting.busy) return;
    waiting.timer = undefined;
    waiting.dueAt = undefined;
    // Only forgeries, or nothing at all: there is no wake to make and the
    // count has aged out. Forget the address rather than hold a row for it.
    if (!waiting.arrivals.length) { this.waiting.delete(address); return; }
    waiting.busy = true;
    try {
      const mailbox = await this.deps.mailboxes.getByAddress(address).catch(() => null);
      const agentId = mailbox?.wakeAgentId;
      // NOBODY is the default and stays the default. An address whose owner
      // has chosen no agent buffers for three seconds and forgets.
      if (!mailbox || !agentId) { this.waiting.delete(address); return; }

      const spent = this.recentWakes(address);
      if (spent.length >= MAIL_WAKES_PER_HOUR) {
        // Held, not dropped: these letters ride the next wake the window
        // allows, which is the moment the oldest of the spent ones ages out.
        waiting.heldUntil = (spent[0] ?? this.now()) + MAIL_WAKE_WINDOW_MS;
        waiting.busy = false;
        this.arm(address, MAIL_WAKE_BUSY_RECHECK_MS);
        return;
      }

      // MID-TURN: hold everything. Queuing into the running turn would work
      // and would be delivered at its end — but a second letter five minutes
      // later would queue a second block, and the promise is one block per
      // turn, however long the turn is.
      if (this.deps.isWorking(mailbox.userId, agentId)) {
        waiting.busy = false;
        this.arm(address, MAIL_WAKE_BUSY_RECHECK_MS);
        return;
      }

      // Taken out of the buffer, so letters arriving during the hand-over
      // belong to the next block rather than being cleared with this one.
      const taken = waiting.arrivals.splice(0);
      const overflow = waiting.overflow;
      const suspicious = waiting.suspicious;
      waiting.overflow = 0;
      waiting.suspicious = 0;
      const newestFirst = [...taken].reverse();
      const block: MailWakeBlock = {
        arrivals: newestFirst.slice(0, MAIL_ARRIVALS_LISTED_MAX),
        more: overflow + Math.max(0, newestFirst.length - MAIL_ARRIVALS_LISTED_MAX),
        suspicious,
      };
      const outcome = await this.deps
        .wake({ userId: mailbox.userId, agentId, block })
        .catch((): MailWakeOutcome => 'failed');

      // Anything but a transient failure settles this batch one way or
      // another, so the tries it spent are not owed by the next one.
      if (outcome !== 'failed') waiting.attempts = 0;
      if (outcome === 'delivered') {
        this.wakes.set(address, [...spent, this.now()]);
        waiting.heldUntil = undefined;
        return;
      }
      if (outcome === 'no-agent') {
        // The chosen agent was deleted or moved out of this owner's reach.
        // The setting falls back to nobody SILENTLY — Settings is where that
        // is said, not a turn nobody can receive.
        await this.deps.mailboxes.setWakeAgent(mailbox.userId, null).catch(() => undefined);
        return;
      }
      if (outcome === 'no-machine') return;
      // Transient — a runner shutting down for a deploy. Put the letters back
      // at the front and try again shortly; on the last try let them go, which
      // is what the letters being safely in the inbox buys. Dropping them here
      // rather than keeping them is also what ENDS this: a batch left waiting
      // with no tries left would simply be re-armed by the retry below.
      waiting.attempts += 1;
      if (waiting.attempts < MAIL_WAKE_DELIVERY_ATTEMPTS) {
        waiting.arrivals.unshift(...taken);
        waiting.overflow += overflow;
        waiting.suspicious += suspicious;
        waiting.busy = false;
        this.arm(address, MAIL_WAKE_BUSY_RECHECK_MS);
      } else {
        waiting.attempts = 0;
      }
    } catch {
      // Same contract as `noteArrival`: a wake that cannot be made is a wake
      // nobody gets, never an error anybody hears about.
    } finally {
      const still = this.waiting.get(address);
      if (still) {
        still.busy = false;
        if (still.arrivals.length && still.timer === undefined) this.arm(address, MAIL_WAKE_COALESCE_MS);
        else if (!still.arrivals.length && !still.suspicious && still.timer === undefined) this.waiting.delete(address);
      }
    }
  }
}
