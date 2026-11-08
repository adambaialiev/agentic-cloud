/**
 * Two rules for the real-Chrome checks CI runs (scripts/verify-*.mts and
 * simulations/*.mjs, through scripts/run-browser-checks.sh), each of which was
 * a cause of reds that had nothing to do with the change under test
 * (note #1075, 8 Nov 2026). Knowledge page: browser-harnesses, "Writing a
 * check that does not flake".
 *
 * 1. NO NEW PLAIN page.click. This app puts back any scroll it did not make,
 *    so Puppeteer's click on anything at or past the fold scrolls by script,
 *    is undone, and presses empty space — the screen never opens and the check
 *    dies 30 s later on a selector. verify-workspace-handles and
 *    verify-workspace-react-org lost both attempts that way on 10 CI runs in
 *    three days. `tap` in scripts/browser-settle.mjs scrolls with the wheel and
 *    presses a box that has stopped moving. The counts below are what is left
 *    from before the rule: they may only go DOWN. Converting a file? Lower its
 *    number (or delete its line) in the same change.
 *
 * 2. NO QUIET RETRIES. scripts/run-browser-checks.sh gives a second attempt
 *    only to a check named in RETRY_BECAUSE, each with its reason, and prints
 *    a pass on that attempt as RETRIED. A blanket RETRIES knob is how flakes
 *    hid for weeks before; it must not come back.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const PLAIN_CLICK_CEILING = new Map<string, number>([
  ['scripts/verify-account-menu-builder-page.mts', 2],
  ['scripts/verify-agent-schedule.mts', 4],
  ['scripts/verify-agent-subscription.mts', 2],
  ['scripts/verify-cos-chat-keyboard.mts', 4],
  ['scripts/verify-cos-cross-workplace.mts', 1],
  ['scripts/verify-cos-fresh-default.mts', 3],
  ['scripts/verify-first-run-onboarding.mts', 3],
  ['scripts/verify-front-page-redirect.mts', 1],
  ['scripts/verify-home-skeleton-pickers.mts', 3],
  ['scripts/verify-joiner-welcome.mts', 2],
  ['scripts/verify-opencode-harness.mts', 5],
  ['scripts/verify-proposal-back.mts', 6],
  ['scripts/verify-voice-on-a-note.mts', 8],
  ['scripts/verify-waiting-list-after-decision.mts', 12],
  ['scripts/verify-workspace-agent-context.mts', 4],
  ['scripts/verify-workspace-agent-proactive.mts', 4],
  ['scripts/verify-workspace-agent-switch.mts', 11],
  ['scripts/verify-workspace-auto-approve.mts', 6],
  ['scripts/verify-workspace-bucket-page.mts', 4],
  ['scripts/verify-workspace-drive.mts', 11],
  ['scripts/verify-workspace-forwarded-proposals.mts', 2],
  ['scripts/verify-workspace-handoff-create.mts', 2],
  ['scripts/verify-workspace-home-windows.mts', 14],
  ['scripts/verify-workspace-join-steady.mts', 1],
  ['scripts/verify-workspace-picture-frame.mts', 2],
  ['scripts/verify-workspace-proposal-ready-card.mts', 1],
  ['scripts/verify-workspace-react-agent-chat.mts', 34],
  ['scripts/verify-workspace-react-auth.mts', 17],
  ['scripts/verify-workspace-react-decisions.mts', 1],
  ['scripts/verify-workspace-react-home.mts', 5],
  ['scripts/verify-workspace-react-join.mts', 5],
  ['scripts/verify-workspace-react-knowledge.mts', 6],
  ['scripts/verify-workspace-react-notes.mts', 25],
  ['scripts/verify-workspace-react-repos.mts', 13],
  ['scripts/verify-workspace-react-seat.mts', 40],
  ['scripts/verify-workspace-runtime-split.mts', 2],
  ['scripts/verify-workspace-team-people.mts', 4],
  ['scripts/verify-workspace-team-proposals.mts', 1],
  ['scripts/verify-workspace-workplace-page.mts', 6],
  ['scripts/verify-workspace-x-profile-row.mts', 4],
  ['simulations/handoff-and-approval.mjs', 7],
  ['simulations/mail.mjs', 29],
  ['simulations/onboarding.mjs', 3],
  ['simulations/recovery-access.mjs', 6],
  ['simulations/returning-signin.mjs', 2],
  ['simulations/team-join-existing.mjs', 3],
  ['simulations/team-join.mjs', 6],
  ['simulations/workspace-tour.mjs', 4],
]);

const checkFiles = (): string[] => [
  ...readdirSync(`${root}scripts`).filter((name) => /^verify-.*\.mts$/.test(name)).map((name) => `scripts/${name}`),
  ...readdirSync(`${root}simulations`).filter((name) => /^[a-z].*\.mjs$/.test(name) && name !== 'all.mjs').map((name) => `simulations/${name}`),
];

describe('browser checks: the rules that keep them from flaking', () => {
  it('adds no plain page.click — every new press goes through tap()', () => {
    const over: string[] = [];
    for (const file of checkFiles()) {
      const count = (readFileSync(`${root}${file}`, 'utf8').match(/\bpage\$?\.click\(/g) ?? []).length;
      const ceiling = PLAIN_CLICK_CEILING.get(file) ?? 0;
      if (count > ceiling) {
        over.push(`${file}: ${count} plain page.click calls, at most ${ceiling} allowed — use tap(page, selector) from scripts/browser-settle.mjs`);
      }
    }
    expect(over).toEqual([]);
  });

  it('keeps the ceilings honest: a file that clicks less has its number lowered', () => {
    const stale: string[] = [];
    for (const [file, ceiling] of PLAIN_CLICK_CEILING) {
      let count = 0;
      try { count = (readFileSync(`${root}${file}`, 'utf8').match(/\bpage\$?\.click\(/g) ?? []).length; } catch { /* gone */ }
      if (count < ceiling) stale.push(`${file}: ceiling ${ceiling}, now ${count} — lower it to ${count}`);
    }
    expect(stale).toEqual([]);
  });

  it('retries only checks named with a reason, once, and has no blanket retry', () => {
    const runner = readFileSync(`${root}scripts/run-browser-checks.sh`, 'utf8');
    expect(runner).not.toMatch(/^\s*RETRIES=/m);
    const table = runner.match(/declare -A RETRY_BECAUSE=\(\n([\s\S]*?)\n\)/);
    expect(table, 'RETRY_BECAUSE table').not.toBeNull();
    const entries = [...table![1]!.matchAll(/^\s*\[([^\]]+)\]='([^']*)'/gm)].map((m) => ({ name: m[1]!, reason: m[2]! }));
    const files = new Set(checkFiles().map((file) => file.replace(/^(scripts|simulations)\//, '').replace(/\.m[jt]s$/, '')));
    for (const entry of entries) {
      expect(files.has(entry.name), `${entry.name} is a check`).toBe(true);
      expect(entry.reason.length, `${entry.name} says why`).toBeGreaterThan(20);
    }
    // A short list on purpose: each entry is a flake nobody could remove.
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(runner).toMatch(/retries=1/);
    expect(runner).toMatch(/RETRIED \(passed on attempt 2\)/);
  });
});
