/**
 * Said once on the join screen ("Set up my own workplace instead"); kept for
 * the tab, so the join detour in `RequiredSetup` stops stepping in for the
 * request the person is waiting on.
 */
const OWN_WORKPLACE_KEY = 'acc.ownWorkplace';
export function ownWorkplaceChosen(): boolean {
  try { return window.sessionStorage.getItem(OWN_WORKPLACE_KEY) === '1'; } catch { return false; }
}
export function chooseOwnWorkplace(): void {
  try { window.sessionStorage.setItem(OWN_WORKPLACE_KEY, '1'); } catch { /* private mode: the detour simply keeps stepping in */ }
}
