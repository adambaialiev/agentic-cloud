/**
 * The wait before a setup screen, in the setup screens' own shape
 * (2026-09-22): the brand head every step wears, a title, a line and one
 * card. It used to be Home's skeleton — tabs, an agent card, a seat strip —
 * which a person being set up has never seen and is not about to: the step
 * then arrived as a different page entirely.
 *
 * Which shape to hold is known for certain once the workspace read answers
 * (the gate draws this one itself). Before that, the address says so on any
 * `/setup…` page, and `setup-hint.ts` remembers it for a bare `/workspace`.
 */

import { SetupHead } from './SetupHead.js';

export function SetupLoadingSkeleton() {
  return (
    <div className="requiredsetup setup-loading" id="setupLoadingSkeleton" aria-busy="true">
      <span className="sr-only" role="status">Loading your workspace…</span>
      <SetupHead />
      <div className="authhero" aria-hidden="true">
        <span className="skel setup-loading-title" />
        <span className="skel setup-loading-line" />
        <span className="skel setup-loading-line short" />
      </div>
      <div className="card setup-loading-card" aria-hidden="true">
        <span className="skel setup-loading-line short" />
        <span className="skel setup-loading-line" />
      </div>
    </div>
  );
}
