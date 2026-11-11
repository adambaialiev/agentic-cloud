import type { ReactNode } from 'react';

/**
 * A live panel's own title: the Workspace screen's `<h1>`, drawn here as a
 * plain block that is not a heading (note #1149).
 *
 * In the app each screen is a page and its title is that page's h1. On a
 * marketing or documentation page the same markup put a second, third and
 * eighth h1 into the document: /docs/getting-started had "Chief of Staff"
 * three times, "Ruby" and "Settings" beside its own "Getting started", and a
 * crawler reading headings found a page about Milo (the search report, note
 * #1144). A panel is `inert` and hidden from a screen reader (LivePanel), so
 * its title was never a heading to a person either.
 *
 * The look does not change: vite.config.ts gives `.ws-h1` every rule the
 * Workspace stylesheet writes for `h1`, so nothing in workspace.css is edited
 * for the landing's sake and a new rule there follows by itself.
 */
export function PanelTitle({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return <div id={id} className={className ? `ws-h1 ${className}` : 'ws-h1'}>{children}</div>;
}
