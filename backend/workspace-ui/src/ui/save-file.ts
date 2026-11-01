/**
 * Hand the browser a file to save (note #552).
 *
 * The URL is one the backend just signed for saving — its response carries
 * the attachment disposition and the file's real name — and the browser is
 * asked to follow it through a real anchor, in THIS tab, not through
 * `window.open`. The difference is the whole fix: the URL is minted by an
 * awaited request, and by the time it exists the tap that asked for it is
 * over as far as Safari is concerned. A new window opened then is a popup,
 * and Safari (Mac and iPhone alike) refuses popups in silence, which is how
 * a tap on an archive an agent sent came to do nothing at all — see the
 * owner's screenshot on the note. An anchor click is a navigation, not a
 * window, and no popup blocker judges it; the attachment disposition is what
 * keeps the page where it is while the bytes go to the download shelf, and
 * `download` names the file for a browser that would otherwise make one up.
 *
 * Drive's file screen has saved this way since it opened; this is that code,
 * shared, so the chat, the Workspace Agent's conversation and Drive save the
 * same way and a fix to one is a fix to all.
 */
export function saveFile(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
