/**
 * A read that cannot be waited on forever.
 *
 * `fetch` has no timeout of its own. A request whose answer never comes —
 * because the connection was accepted and then abandoned, which is exactly
 * what happens to a read caught by a backend restart — leaves its promise
 * pending for as long as the page is open. A screen that draws the word
 * "Loading…" while a promise is pending then draws it forever: no answer to
 * show, no failure to report, and nothing the reader can do but leave.
 *
 * That is note #308, in the user's own words — "Note wasn't able to fetch",
 * over a screenshot of a note screen holding "Loading…", taken to the minute
 * while the backend was swapping releases underneath it.
 *
 * So a read here is bounded, and it tries again. Three rules:
 *
 *   BOUNDED   an attempt that has not answered inside `READ_LIMIT_MS` is over,
 *             and its request is aborted rather than left holding a socket.
 *   AGAIN     a failure another attempt could plausibly do better on is
 *             retried, because the common one — a release going out — heals
 *             itself in about half a minute, and the reader should not have to
 *             know that.
 *   SAID      a read that runs out of attempts ends in a FAILURE, which the
 *             screen can put on the page beside a way to try once more. It
 *             never ends in silence.
 *
 * `onAgain` is how a screen stops being quiet about it. The first attempt gets
 * the benefit of the doubt — an ordinary read answers in tens of milliseconds
 * — but once one has timed out the reader is plainly waiting on something, and
 * "Loading…" has stopped being an honest description of it.
 */

import { WorkspaceApiError } from '../api/client.js';

/** How long one attempt is given. Generous for an answer measured in
 *  kilobytes, and short enough that a reader is not left guessing: past this
 *  the screen stops implying the answer is on its way and says it is not. */
export const READ_LIMIT_MS = 8_000;

/** The pause before each further attempt. Two of them, so a read makes three
 *  attempts in all and spends a little under thirty seconds before it gives up
 *  — which is the width of the gap a backend release leaves behind it.
 *
 *  `again` on the read below overrides it, and there is one reason to: a
 *  refresh going out UNDERNEATH an answer already on the screen. The ladder
 *  exists so a reader staring at "Loading…" is carried across a release; a
 *  reader who can already see the thing is not waiting on anything, the next
 *  poll is fifteen seconds away in any case, and thirty seconds of attempts
 *  would only swallow the two polls after it. Such a read passes `again: []`:
 *  still bounded, still abandoned at `READ_LIMIT_MS`, but one attempt and
 *  then quietly nothing. */
export const READ_AGAIN_MS: readonly number[] = [1_500, 4_000];

/** What an attempt that never answered ends in. Its sentence is written to be
 *  read on the page: this is the one failure with no server-side words of its
 *  own, so it has to supply them. */
export class ReadTimedOut extends Error {
  constructor() {
    super('The server did not answer.');
    this.name = 'ReadTimedOut';
  }
}

/**
 * Whether another attempt could plausibly do better.
 *
 * A refusal is not a fault: "No such note." is the same answer however many
 * times it is asked for, and asking again only makes the reader wait longer to
 * be told what the first attempt already knew. Anything that did not come back
 * as a considered answer — a timeout, a dropped connection, a 5xx from a
 * server that is halfway through starting — is worth asking again.
 */
export function worthAskingAgain(failure: unknown): boolean {
  if (failure instanceof ReadTimedOut) return true;
  if (failure instanceof WorkspaceApiError) return failure.status >= 500 || failure.status === 0;
  // A `TypeError` out of fetch is the network, not the answer.
  return failure instanceof TypeError;
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * One attempt, bounded.
 *
 * The bound is a race rather than a bare `AbortSignal`, deliberately: the
 * abort releases the request, but nothing guarantees the transport turns it
 * into a rejection promptly — and the whole point of this file is a wait that
 * ends. The race ends it; the abort is the tidying up afterwards.
 */
async function attempt<T>(call: (init: RequestInit) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut()), READ_LIMIT_MS);
  });
  // The loser of a race is never awaited. Claim its rejection here so a read
  // that answers in time cannot be reported as an unhandled one.
  limit.catch(() => { /* the race has it, or nobody needs it */ });
  try {
    return await Promise.race([call({ signal: stop.signal }), limit]);
  } finally {
    clearTimeout(timer);
    // Harmless on a call that already answered — `api` has read the whole body
    // by the time it resolves — and the point of the exercise on one that did
    // not, which is otherwise left holding a connection until the tab closes.
    stop.abort();
  }
}

/**
 * The whole read: attempts until one answers, or until there are none left —
 * and then it throws, so the caller has something to say.
 */
export async function readOrSayWhy<T>(
  call: (init: RequestInit) => Promise<T>,
  options: { onAgain?: () => void; again?: readonly number[] } = {},
): Promise<T> {
  const again = options.again ?? READ_AGAIN_MS;
  let last: unknown = new ReadTimedOut();
  for (let go = 0; go <= again.length; go += 1) {
    if (go > 0) {
      // Said BEFORE the pause, not after it: the reader is already waiting,
      // and a line that appears only once the next attempt starts leaves the
      // gap between them looking exactly like the hang it exists to explain.
      options.onAgain?.();
      await pause(again[go - 1]!);
    }
    try {
      return await attempt(call);
    } catch (failure) {
      if (!worthAskingAgain(failure)) throw failure;
      last = failure;
    }
  }
  throw last;
}
