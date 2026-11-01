/**
 * The workplace THIS TAB stands in (note #628).
 *
 * The server keeps one "active" workplace per person — the marker
 * `POST api/org/active` moves — and used to answer every unscoped Workspace
 * read from it. Two tabs open on two workplaces therefore shared one fact:
 * the moment one tab switched, the other tab's next state read, live tick or
 * notification poll came back from the workplace it had never chosen, and it
 * quietly became a second copy of the first.
 *
 * The workplace a document stands in is a fact of THAT DOCUMENT, so it lives
 * here, per tab: in memory for the page's lifetime and in `sessionStorage`
 * so a reload lands where it left off. `sessionStorage` is the right shelf
 * precisely because it is per tab — a second tab starts with none of it and
 * asks the server, exactly as a fresh open should — while a duplicated tab
 * inherits its copy, which is what "duplicate" ought to mean. The API client
 * rides it as `?org=` on every ordinary call that names no workplace of its
 * own, and the server never substitutes its global marker for a workplace
 * the request named (routes/workspace.ts, `authenticate`).
 *
 * The server's marker still exists and still moves on a switch: it is where
 * a NEW tab, and Telegram, start. It is no longer where an open one follows.
 *
 * Nothing here decides membership. The session read (`auth/session?org=`)
 * hands back the workplace it will actually stand in — the remembered one
 * when this person still belongs to it, the server's marker otherwise — and
 * that answer is what is written back here.
 */

const STANDING_WORKPLACE_KEY = 'acc.standingWorkplace';

let remembered: string | null | undefined;

const shelf = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
};

/** The workplace this tab stands in, or null when it stands in none yet. */
export function standingWorkplace(): string | null {
  if (remembered === undefined) {
    let kept: string | null = null;
    try { kept = shelf()?.getItem(STANDING_WORKPLACE_KEY) ?? null; } catch { kept = null; }
    remembered = kept?.trim() || null;
  }
  return remembered;
}

/** Stand this tab in a workplace — before the first read that should carry it. */
export function standInWorkplace(orgId: string | null): void {
  remembered = orgId?.trim() || null;
  try {
    if (remembered) shelf()?.setItem(STANDING_WORKPLACE_KEY, remembered);
    else shelf()?.removeItem(STANDING_WORKPLACE_KEY);
  } catch { /* private mode: the tab still stands here until it is closed */ }
}

/** A fresh document stands where its address says (`?org=`), before the
 *  shelf does: a link to another workplace's note, opened in a new tab,
 *  opens a tab standing in THAT workplace. An address naming none leaves
 *  the tab where it stood. Called once, at open. */
export function standInAddressedWorkplace(search: string): void {
  const addressed = (new URLSearchParams(search).get('org') ?? '').trim();
  if (addressed) standInWorkplace(addressed);
}

/** Sign-out: the next person in this tab starts where the server says. */
export function forgetStandingWorkplace(): void {
  standInWorkplace(null);
}
